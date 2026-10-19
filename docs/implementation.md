# Megvalósítási jegyzőkönyv

A jóváhagyott, `srcdoc` alapú böngészős MVP megvalósult. A végső regresszióellenőrzések eredménye alább szerepel. Dátum: 2026-10-19. Publikus production telepítés és távoli CI-futtatás nem történt.

## Ellenőrzött működés

Valódi WebRTC adatátvitel működik két elkülönített Chromium-profil között; az eredeti publikáló bezárása után tiszta harmadik profil B-től tölt le. A pinelt csomag újratöltés után valóban újra seedel, újraépített darabtárral és infoHash-ellenőrzéssel. A HTTP-hostok nem szolgálják ki a fixture payloadot.

A viewer a saját Service Workerétől kéri le a manifest szerinti fájlokat. A worker és a renderer is ellenőrzi az integritást. Az inert template-ben feldolgozott HTML a bootstrap élő DOM-jába nem kerülhet. A megjelenített belső iframe opaque originű, csak scriptjogot kap; a tartalom nem éri el a UI vagy bootstrap storage-át, nem regisztrálhat SW-t és nem navigálhatja a top ablakot. A CSP az ellenőrzött, beágyazott erőforrásokon kívüli hálózati erőforrásokat tiltja.

Működik a nem `index.html` kezdőoldal, a relatív CSS/kép/script, a CSS import és háttérkép, a relatív aloldal, valamint a query/fragment megőrzése a logikai címmel és megosztási linkkel együtt. Explicit hiányzó útvonalra 404 jár. Sok erőforrás betöltése legfeljebb hat egyidejű olvasással történik, a bridge 32-es pending korlátja alatt.

A UI saját SW-je és a viewer saját SW-je is cache-eli az indításhoz szükséges fájlokat. Az offline teszt nem csupán hálózatot kapcsol: bezárja az egész tartós Chromium-profilt, leállítja mind a négy alkalmazásszervert, megnyitja ugyanazt a megőrzött profilt, letiltja a hálózatot és újranyitja az alkalmazás címét. A UI, a viewer és a HTML/CSS/kép/JS/aloldal működik. Nincs tracker-, ICE API- vagy hitelesítésvárakozás a helyi tartalom előtt. A viewer shell előkészítése az „Offline elérhető” állapot előfeltétele.

Cache-törléskor a két origin tartalomadatai törlődnek, a shell cache megmarad. A sérült fájl nem jut sem iframe-be, sem sikeres viewer cache-be. Kvótahiba nem eredményez offline állapotot. A viewer bezárása megszakítja a pending bridge-olvasást. SW-újraindulás, bootstrap-reload és új worker-/shell-cache-verzió dedikált újrakapcsolódással működik.

## Tesztek és eredmények

| Parancs | Eredmény |
|---|---|
| `npm ci` | Sikeres, lockfile alapján |
| `npm run lint` | Sikeres |
| `npm run typecheck` | Sikeres, strict TypeScript |
| `npm run test:unit` | 33 sikeres protokoll-, renderer-resolver-, bridge- és valódi ICE API-teszt |
| `npm run build` | Mindkét alkalmazás sikeresen buildel |
| `npm run test:e2e` | 18 sikeres; 4 relay eset külön jobban, 0 hibás; kilépési kód 0 |
| `npm run test:relay` | 4 sikeres, saját coturnnal és valódi WebRTC-vel |
| Docker tracker / ICE API | Mindkét image buildje és a szolgáltatások indítása sikeres |
| `setup:dev`, `infra:up`, `infra:logs`, `infra:down` | Sikeres; az ismételt setup megőrizte a meglévő konfigurációt és credentialt |
| `npm run doctor` | Node 24, mindkét HTTP-origin, origin-elkülönítés, ICE API és tracker WS sikeres |

A teljes normál e2e suite 18 esetet futtat; a 4 relay eset külön jobba tartozik. A relay kihagyása a normál suite-ban nem relay-minősítés. A relay saját szervert indít és tényleges átvitel hiányakor hibázik; hiányzó környezetből nem lesz hamis siker.

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
| PostCSS / value parser | 8.5.31 / 4.2.0 |

A [WebTorrent dokumentáció](https://webtorrent.io/docs) és telepített forrás szerint az ICE-konfiguráció útja: `new WebTorrent({ tracker: { rtcConfig: { iceServers, iceTransportPolicy } } })` → discovery → tracker → simple-peer → `RTCPeerConnection`. A tracker callback legfeljebb két spekulatív offert kér; ez korlátozza az üres TURN allokációk számát a kis fejlesztői tartományban.

A diagnosztika a rögzített WebTorrent `_peers` Map-jén és a simple-peer `_pc` mezőjén éri el a PC-t; a selected pair és datachannel számlálók a szabványos `getStats()`-ból származnak. A hálózati letöltési mutató a `received`, nem a helyi darabteljességet mérő `downloaded`. Ezeket verzióváltáskor újra tesztelni kell.

A reseed előtt minden tartós fájlt SHA-256-tal ellenőrzünk, újraépítjük a darabtárat, és az új infoHash-nek egyeznie kell az eredetivel. A letöltött darabok ellenőrzését nem kapcsoljuk ki. A WebTorrent saját `seed()` optimalizációja csak a már ellenőrzött, saját inputra vonatkozik.

A [Service Worker munkacsoport egyeztetése](https://github.com/w3c/ServiceWorker/issues/648) és a valódi Chromium-próba indokolta a jóváhagyott `srcdoc` renderert. Az erőforrások adatait a bootstrap ellenőrzi és beágyazza, így az opaque iframe-nek sem SW-hozzáférésre, sem origin-jogokra nincs szüksége. A CSS importokat és URL-eket a [PostCSS](https://github.com/postcss/postcss) és [value parser](https://github.com/postcss/postcss-value-parser) dolgozza fel; ciklus elutasítva.

## Ismert korlátok

A statikus demo támogatott; ES modul, általános SPA, `location`-alapú router, storage és hálózati fetch nem garantált. A logikai dokumentumcím és query/fragment a viewerben és megosztható URI-ban él, a belső iframe `about:srcdoc`. A `srcset`, beágyazott frame és a teljes tetszőleges HTML-kompatibilitás nincs benne. A CSP nem tökéletes hálózati anonimizálás: az iframe programozott saját navigációja ismert korlát.

Publikus HTTPS/WSS és TLS TURN telepítés, HTTPS-es protokollregisztráció, LAN/mobil/Firefox/Safari kompatibilitás és többórás credential/allocation futtatás nem történt. A cookie-mentes viewer domain, reverse proxy, tanúsítványok és hitelesítő gateway a telepítő feladata; a README és a production coturn példa jelzi a szükséges beállításokat.

A `npm audit` 4 high jelzést ad az `ip` tranzitív függőségén keresztül. A [GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp) az `isPublic` hibás osztályozását írja le; javított upstream verzió nincs. A tracker az `ip` csomagot az itt kikapcsolt UDP-parserben importálja, a projekt nem használja az `isPublic` függvényt biztonsági döntéshez. A jelzés megmarad és frissítéskor újra értékelendő.
