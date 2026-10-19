# Megvalósítási jegyzőkönyv

Az oldalankénti originre és külön böngészőablakokra épülő HPPT viewer megvalósult; az eredeti fájlokat a saját Service Worker szolgálja ki. A végső regresszióellenőrzések eredménye alább szerepel. Dátum: 2026-10-19. Publikus production telepítés és távoli CI-futtatás nem történt.

## Ellenőrzött működés

Valódi WebRTC adatátvitel működik két elkülönített Chromium-profil között; az eredeti publikáló bezárása után tiszta harmadik profil B-től tölt le. A pinelt csomag újratöltés után valóban újra seedel, újraépített darabtárral és infoHash-ellenőrzéssel. A HTTP-hostok nem szolgálják ki a fixture payloadot.

Minden csomag külön `<infoHash>.hppt.localhost:5174` originen, önálló böngészőlapon fut. A saját worker változatlan fájlbytes tartalmat ad vissza, a böngésző natívan tölti be a relatív erőforrásokat. A WebRTC a nyitott HPPT alkalmazásban marad; rejtett, oldalankénti helper és dedikált MessagePort köti össze a workerrel. Megjelenítő iframe, HTML/CSS-átírás és data URL-es csomagolás nincs. A tartalom saját originjének storage-át használhatja. A CSP külső erőforrást, workert, frame-et és űrlapot tilt; a COOP leválasztja az opener kapcsolatot, az Origin-Agent-Cluster megakadályozza a document.domain alapú összevonást.

A protokollkezelő `/open?uri=…` belépési lapja saját magát navigálja a viewer-címre. A launcher külön betöltött modul; helyi csomaghoz nem példányosít P2P engine-t, SHA-256- és torrentbizonyíték-ellenőrzéssel előkészíti a teljes tartós viewer-cache-t. Letöltéskor az alkalmazás originjén futó BroadcastChannelen kér előkészítést egy már nyitott vezérlőtől, vagy külön alkalmazáslapot indít. Blokkolt ablaknyitásnál kézzel kattintható indítógomb jelenik meg. A válasz azonosított kéréshez és kiválasztott vezérlőhöz kötött; a launcher ellenőrzi a hash-t, az explicit útvonalat, queryt és fragmentet, és csak a konfigurált viewer origint állítja elő. A vezérlő UI hagyományos megnyitógombja továbbra is külön viewer-lapot nyit.

A közvetlen viewer-link első megnyitása friss profilban navigációs 302-vel ugyanezt a launchert indítja, majd visszatér az eredeti viewer-címre. Korábban ez az útvonal 503-at adott akkor is, ha az alkalmazás már nyitva volt. Három új, valódi P2P-s böngészőteszt ellenőrzi az elkülönített profilban nyitott alkalmazás megtalálását, az eredeti query/fragment megőrzését, a gyökérútvonal entrypoint-feloldását és az explicit hiányzó fájl elutasítását. A hálózati naplóban az első válasz 302, a HTML 200-as válasza már Service Workerből jön. A közönséges HTTP fájlkérés továbbra is 503.

Működik a nem `index.html` kezdőoldal, a relatív CSS/kép/script, a CSS import és háttérkép, a relatív aloldal, az ES-modul és import, a body/html attribútumok, a valós window.location és az ugyanazon originre mutató fetch. A query és fragment a viewer valódi URL-jében marad meg. Explicit hiányzó útvonalra 404 jár. Sok erőforrás betöltése legfeljebb hat egyidejű olvasással történik, a bridge 32-es pending korlátja alatt.

A UI saját SW-je és a viewer saját SW-je is cache-eli az indításhoz szükséges fájlokat. Az offline teszt nem csupán hálózatot kapcsol: bezárja az egész tartós Chromium-profilt, leállítja mind a négy alkalmazásszervert, megnyitja ugyanazt a megőrzött profilt, letiltja a hálózatot és újranyitja az alkalmazás címét. Először közvetlenül a csomag saját címét nyitja meg, vezérlőablak nélkül: a HTML/CSS/kép/JS/aloldal működik. Utána a belépési link ugyanazon lapon történő átirányítását, végül a UI-ból történő offline megnyitást is ellenőrzi. Nincs tracker-, ICE API- vagy hitelesítésvárakozás a helyi tartalom előtt. A viewer shell előkészítése az „Offline elérhető” állapot előfeltétele.

Cache-törléskor a vezérlő tartós példánya és az adott csomag originjének fájljai/bizonyítéka törlődik; a bootstrap cache megmarad. A sérült fájl nem renderelődik. A manifestet az eredeti torrent infoHash-hez és a manifestet tartalmazó torrentdarabokhoz kötött bizonyíték hitelesíti. A site saját Cache Storage-ából származó hamisított fájl és újraindulás után a hamisított manifestbizonyíték is elutasításra kerül. UI- és viewer-kvótahiba nem eredményez offline állapotot; a viewer tartós fájljait könyvtárfrissítéskor újra ellenőrizzük. Az alkalmazás bridge-ének leválasztása megszakítja a pending olvasást. Worker-újraindulás után egy hiányzó fájl ismét a nyitott alkalmazástól kérhető.

## Tesztek és eredmények

| Parancs | Eredmény |
|---|---|
| `npm ci` | Sikeres, lockfile alapján |
| `npm run lint` | Sikeres |
| `npm run typecheck` | Sikeres, strict TypeScript |
| `npm run test:unit` | 29 sikeres protokoll-, torrentbizonyíték-, origin-, bridge- és valódi ICE API-teszt |
| `npm run build` | Mindkét alkalmazás sikeresen buildel |
| `npm run test:e2e` | 35 sikeres; 4 relay eset külön jobban, 0 hibás; kilépési kód 0 |
| `npm run test:relay` | Korábbi viewer-átalakításkor 4 sikeres, saját coturnnal és valódi WebRTC-vel; a protokollkezelő-változtatáskor nem ismételve |
| Docker tracker / ICE API | A meglévő tracker működik; az új origin-normalizáló modullal az ICE API újraépítése és indítása sikeres |
| `setup:dev`, `infra:up`, `infra:logs`, `infra:down` | Sikeres; az ismételt setup megőrizte a meglévő konfigurációt és credentialt |
| `npm run doctor` | Node 24, mindkét HTTP-origin, origin-elkülönítés, ICE API és tracker WS sikeres |

A teljes normál e2e suite 35 esetet futtat, köztük nyolc protokoll- és közvetlen viewer-belépési tesztet: helyi csomag vezérlő és hálózati kliens nélkül, élő vezérlő újrahasználata valódi P2P-letöltéssel, blokkolt ablaknyitás kézi indítása, automatikus vezérlőindítás, hibás cím és explicit hiányzó fájl, valamint közvetlen viewer-link friss profilban, gyökérútvonal és közvetlen hiányzó fájl. A tényleges 5173/5174 portokon a `fixtures/sample-site` publikálása és külön profilból közvetlen megnyitása is sikeres volt; a HTML/CSS/JS működött, az eredeti URL megmaradt, az alkalmazás és a viewer két külön lapon maradt. A 4 relay eset külön jobba tartozik. A relay kihagyása a normál suite-ban nem relay-minősítés. A relay saját szervert indít és tényleges átvitel hiányakor hibázik; hiányzó környezetből nem lesz hamis siker.

A relay tesztek feltételei:

- Mindkét peer `iceTransportPolicy: relay`, kiválasztott relay/relay candidate pair és tényleges datachannel byte-ok.
- Hibás TURN credential mellett friss kapcsolat elbukik, direkt fallback nincs.
- TURN leállításakor az élő kapcsolat megszakadása kezelhető, új relay-only kapcsolat nem működik, a helyben mentett csomag továbbra is elérhető.
- Rövid életű, valós TURN REST credential lejáratakor új peer nem tud allokálni. Friss credentialdel ismét működik a kapcsolat; a korábban működő PC-t a kliens credentialfrissítése nem bontja szándékosan.

A credentialteszt valós coturn REST authot használ. A rövid TTL és a hibás credential kizárólag tesztfixture: a production ellenőrzés nincs kikapcsolva. A hitelesítő gatewayt a böngészős tesztek hálózati fixture-je modellezi, az ICE API production hitelesítését és HMAC-képzését valódi API-kérések ellenőrzik. Többórás TURN allocation-élettartamot, éles TLS-t és globális internetes NAT-topológiákat ez nem minősít.

A böngészős tesztek saját portjai: UI 5273, viewer 5274, tracker 8100, ICE API 3101. A relay TURN listener 3488, a relay UDP-tartomány 49500–49620. Minden teszthez véges timeout tartozik, a saját folyamatok és ideiglenes credentialfájlok takarítása megtörténik. A Playwright trace kikapcsolt, mert a hálózati választestek TURN credentialt is rögzítenének.

## Környezet és reprodukálás

Node 24.19.0, npm 11.17.0, Docker Desktop 29.8.2 / Compose 5.6.0 alatt történt a munka. A Docker Desktop portmapping mellett relay candidate létrejött, működő UDP-adatút nem; a Desktop virtuális gép host hálózata sem azonos a böngésző Linux hálózatával. A sikeres TURN tesztek a hivatalos coturn 4.7.0 képből kiemelt binárissal, saját natív Linux-folyamattal futottak. Ez nem bizonyítja a Docker Desktop TURN-adatút működését.

Az `infra:up` valódi Linux Engine-nél automatikusan a `compose.linux.yaml` kiegészítést választja; explicit `COMPOSE_FILE` felülírhatja ezt. A coturn csak olvasható, 0600 jogosultságú saját dev-konfigurációt kap, a helyi UID/GID alatt fut, és olvashatatlan config mellett nem indul tovább alapértelmezett beállítással. A localhostos dev-config loopback peer-kivételét productionban nem szabad átvenni.

A környezetben hiányzó Chromium-rendszerkönyvtárakat a hivatalos Playwright-képből másoltuk `/tmp` alá, hálózat és projektcsatolás nélküli konténerből. A normál telepítéshez `npx playwright install --with-deps chromium` használható. Ebben a munkamenetben:

```sh
LD_LIBRARY_PATH=/tmp/htppt-browser-runtime npm run test:e2e
LD_LIBRARY_PATH=/tmp/htppt-browser-runtime \
  TURNSERVER_BIN=/tmp/htppt-turnserver \
  TURNSERVER_LIBRARY_PATH=/tmp/htppt-coturn-runtime \
  npm run test:relay
```

A `/tmp`-fájlok nem projektfüggőségek. Telepített natív coturn esetén elegendő `TURNSERVER_BIN=/usr/bin/turnserver npm run test:relay`. Linux Docker Engine esetén a relay suite saját, pinelt coturn-konténert használ, csak a saját ideiglenes konfigurációját csatolja. A CI workflow a normál teszteket és a valódi relay suite-ot külön jobban futtatja.

## Verziók és API-döntések

| Összetevő | Verzió |
|---|---|
| Node / npm | 24.19.0 / 11.17.0 |
| TypeScript | 5.9.3 |
| Vite / Vitest | 8.3.4 / 5.0.5 |
| Playwright / Chromium | 1.64.1 / 156.0.8078.4 |
| WebTorrent | 3.0.21, hivatalos böngészős ESM build |
| bittorrent-tracker | 11.2.3 |
| coturn | 4.7.0 |

A [WebTorrent dokumentáció](https://webtorrent.io/docs) és telepített forrás szerint az ICE-konfiguráció útja: `new WebTorrent({ tracker: { rtcConfig: { iceServers, iceTransportPolicy } } })` → discovery → tracker → simple-peer → `RTCPeerConnection`. A tracker callback legfeljebb két spekulatív offert kér; ez korlátozza az üres TURN allokációk számát a kis fejlesztői tartományban.

A diagnosztika a rögzített WebTorrent `_peers` Map-jén és a simple-peer `_pc` mezőjén éri el a PC-t; a selected pair és datachannel számlálók a szabványos `getStats()`-ból származnak. A hálózati letöltési mutató a `received`, nem a helyi darabteljességet mérő `downloaded`. Ezeket verzióváltáskor újra tesztelni kell.

A reseed előtt minden tartós fájlt SHA-256-tal ellenőrzünk, újraépítjük a darabtárat, és az új infoHash-nek egyeznie kell az eredetivel. A letöltött darabok ellenőrzését nem kapcsoljuk ki. A WebTorrent saját `seed()` optimalizációja csak a már ellenőrzött, saját inputra vonatkozik.

A korábbi HTML/CSS renderer és közvetlen PostCSS/value-parser függőségek eltávolítva. A worker az eredeti fájlbytes tartalmat válaszolja meg, ezt P2P-forrás és HTTP-válasz közvetlen byte-összehasonlítása ellenőrzi. A manifest bizalmi horgonya a hostnévben szereplő v1 torrent infoHash: az eredeti bencode `info` bytes SHA-1 hash-ét és a manifestet lefedő darabokat ellenőrizzük; a fájlok ezt követően SHA-256-tal hitelesíthetők.

A külön ablakos modellnél azonos schemeful site, de külön originek szükségesek. A Playwright 1.64.1 alapból kikapcsolja a ThirdPartyStoragePartitioning funkciót; a tesztkonfiguráció ezt visszakapcsolja, és egy külön cross-site cache-próba bizonyítja az elkülönítést. A normál Chrome-beállítások mellett az `app.hppt.localhost` és `<hash>.hppt.localhost` helper/top-level worker és cache azonos partícióba kerül. A korábbi puszta `localhost` és `<hash>.localhost` felépítés erre nem alkalmas.

A `scripts/origins.ts` a régi localhost-alapkonfigurációt egységesen normalizálja a UI, a Vite host, a dev script és az ICE API számára. Az ICE Docker image ezt a modult is tartalmazza. A korábbi UI-origin IndexedDB-je nem törlődik, de az új origin nem fér hozzá automatikusan; a mintamappát újra lehet publikálni.

## Ismert korlátok

Statikus HTML/CSS/kép/klasszikus JS, ES-modul, valós relatív útvonalak és azonos originű GET/fetch támogatott. Backend, POST, worker, beágyazott frame és űrlap nincs; explicit hiányzó útvonal 404, általános SPA-fallback nincs. A viewer normál felső szintű oldal, külső linkre és más címre navigálhat: a CSP nem teljes exfiltrációs vagy anonimitási határ. Új P2P-letöltéshez/továbbosztáshoz nyitott HPPT alkalmazás kell. Teljes offline mentés után a saját viewer URL a vezérlőablak nélkül is használható. Új lap blokkolásakor az alkalmazás kézzel kattintható megnyitási linket ad.

Publikus HTTPS/WSS és TLS TURN telepítés, HTTPS-es protokollregisztráció, LAN/mobil/Firefox/Safari kompatibilitás és többórás credential/allocation futtatás nem történt. Az azonos schemeful site-on belüli cookie-mentes viewer wildcard domain, reverse proxy, tanúsítványok és hitelesítő gateway a telepítő feladata; a README és a production coturn példa jelzi a szükséges beállításokat.

A `npm audit` 4 high jelzést ad az `ip` tranzitív függőségén keresztül. A [GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp) az `isPublic` hibás osztályozását írja le; javított upstream verzió nincs. A tracker az `ip` csomagot az itt kikapcsolt UDP-parserben importálja, a projekt nem használja az `isPublic` függvényt biztonsági döntéshez. A jelzés megmarad és frissítéskor újra értékelendő.
