# HPPT — HyperText Peer To Peer Transfer Protocol

TypeScript böngészős MVP statikus weboldalak publikálására, megnyitására és továbbosztására. A weboldalfájlok valódi WebTorrent/WebRTC kapcsolaton érkeznek. A tracker discoveryt/signalingot végez, az ICE API TURN credentialt ad; HTTP payload/webseed fallback nincs.

## Helyi indítás

Node 24 LTS, npm, Docker Compose 2.24.4+ és aktuális Chromium szükséges.

```sh
npm ci
npm run setup:dev
npm run infra:up
npm run dev
```

| Szolgáltatás | Cím |
|---|---|
| Vezérlő UI | http://app.hppt.localhost:5173 |
| Külön originű viewer | http://hppt.localhost:5173 |
| WebSocket tracker | ws://localhost:8000 |
| ICE API | http://localhost:3001/ice |

A vezérlő UI-t az `APP_ORIGIN` címén nyisd meg (alapból `http://app.hppt.localhost:5173`). A `localhost:5173` és `127.0.0.1:5173` fejlesztői belépési címek az új címre irányítanak. A különböző hostnevek külön originek: a CORS, a viewer és a böngészős tárhely pontos címegyezést igényel. Más címen megnyitva a UI indításkor átirányít az `APP_ORIGIN` címre, megőrizve az útvonalat, queryt és fragmentet. Az offline mentések a konfigurált originhez tartoznak. Az új helyi origin nem látja automatikusan a korábbi `localhost:5173` könyvtárát; a régi adatokat nem töröljük, a mintamappa újrapublikálható. A régi localhost-alapértékeket a konfiguráció és az ICE API az új hostnevekre normalizálja.

Új build telepítésekor a Service Worker előbb cache-eli az új indítófájlokat, majd egyszer újratölti a nyitott vezérlőfelületeket. A tartósan mentett csomagok megmaradnak. Ha egy régi verzió még beragadt, a `http://app.hppt.localhost:5173/refresh` cím a régi indítóoldal-cache megkerülésével tölti be a friss alkalmazást; tárhelytörlés nem szükséges.

A `setup:dev` idempotens: megőrzi a credentialt, `.env`-et és helyi coturn-konfigurációt készít. Mindkettő gitignore-olt. A `dev` elkészíti a két célzott buildet, majd egyetlen Vite preview szerverrel, azonos porton szolgálja ki őket a hosztnév alapján. A vezérlő és a viewer saját indítófájlokat, Service Workert és precache-listát kap; módosítás után újraindítandó. Kész buildhez `npm run serve` használható.

Az `infra:up` valódi Linux Docker Engine alatt a coturnhoz host hálózatot választ. Docker Desktop alatt az alap portmappinget használja; a TURN UDP-relay útvonal itt külön ellenőrzendő. Ebben a fejlesztői környezetben a Docker Desktop relay candidate-et adott, de működő adatátvitelhez natív coturn kellett:

```sh
docker compose up -d --build tracker ice-api
npm run turn:native
npm run dev
```

A `turn:native` telepített `turnserver` programot igényel; más helyen lévő binárishoz `TURNSERVER_BIN` adható meg. A `npm run services` Docker nélkül indítja a Node trackert és ICE API-t. A TURN továbbra is külön folyamat. A teljes relay teszt nem minősíti sikeresnek a puszta candidate-gyűjtést.

## Kipróbálás

A `fixtures/sample-site` mappa egy kész, publikálható tesztoldal: helyi CSS, SVG-kép, kattintható JS-gomb és relatív aloldal található benne. Válaszd ki az egész mappát a publikálóban; az ajánlott kezdőfájl az `index.html`. Más kezdőfájl teszteléséhez a `pages/about.html` is kiválasztható.

1. Két elkülönített böngészőprofilban nyisd meg a vezérlő UI-t.
2. A-ban válaszd a `fixtures/hello-site` mappát, és publikáld. A fájlok helyben kapnak manifestet és integritáshash-t.
3. A kapott `web+hppt://…` címet illeszd B-be. Az oldal külön böngészőlapon, saját originen nyílik meg. Ellenőrizd a CSS-t, képet, JS-gombot és relatív aloldalt. Ha a böngésző blokkolja az új lapot, használd az alkalmazásban megjelenő megnyitási linket.
4. B-ben válaszd a „Mentés offline + pin” gombot. A teljes csomag letöltése, ellenőrzése és tartós tárolása után jelenik meg az „Offline elérhető” állapot.
5. Zárd be A-t. Tiszta C profil B-től is le tudja tölteni a csomagot. B-t a továbbosztáshoz tartsd nyitva.
6. B böngészőjét bezárva, majd ugyanazzal a megőrzött profillal, leállított szerverek és internet nélkül is megnyitható a korábban betöltött alkalmazás és a teljesen mentett oldal.

Az `index.html` nem kötelező. A `fixtures/nested-site` demónál válaszd a `pages/home.html` kezdőfájlt. Üres URI-útvonalnál a manifest `entrypoint` mezője dönt; explicit hiányzó útvonalnál 404 jár, kezdőoldal-fallback nincs. Relatív hivatkozások, CSS importok és CSS-képek támogatottak; a query/fragment a logikai címmel és a megosztható linkkel együtt megmarad.

A protokollkezelő regisztrációja külön gombbal történik, támogatott böngészőben. Mindig használható a beillesztés és a belépési link. A hordozható böngészős séma `web+hppt://`, a natív `hppt://` nem része az MVP-nek.

A protokollkezelő és az `/open?uri=…` belépési link ugyanazon a lapon navigál a saját viewer-címre, például `http://<hash>.hppt.localhost:5173/pages/home.html?mode=1#details`. Teljes helyi csomagnál ellenőrzi és előkészíti a tartós viewer-cache-t, majd átirányít; nem indít WebTorrent/WebRTC klienst vagy külön alkalmazáslapot. Letöltéshez az azonos böngészőprofilban már nyitott HPPT alkalmazást használja, ennek hiányában külön alkalmazáslapot indít. Ha a böngésző ezt blokkolja, a belépési oldalon megjelenik a „HPPT alkalmazás indítása” gomb. A letöltéshez és továbbosztáshoz az alkalmazáslap maradjon nyitva. Az alkalmazás beillesztőmezője és könyvtára továbbra is külön viewer-lapot nyit.

A közvetlen `http://<hash>.hppt.localhost:5173/<path>` viewer-link friss, például inkognitó profilban is megnyitható. Ha ott még nincs az oldalhoz Service Worker, a viewer host a felső szintű oldalmegnyitást a belépési linkre irányítja; az előkészítés után ugyanaz a lap visszatér a viewer-címre, megőrizve a queryt és fragmentet. Az inkognitó saját HPPT alkalmazását használja, a normál profilban nyitott publikáló pedig peer marad: a letöltéshez azt is nyitva kell tartani. Közönséges fetch- és erőforráskérések továbbra sem kapnak csomagfájlt HTTP-n. Más statikus host/reverse proxy telepítésénél ezt a navigációs átirányítási szabályt is biztosítani kell.

A korábbi helyi viewer `5174` portját a konfiguráció automatikusan az alkalmazás portjára normalizálja; a `setup:dev` ezt a `.env`-ben is frissíti, a titkok megőrzésével. Az új viewer-címek `5173`-at használnak. A vezérlő originje és helyi csomagtára megmarad: a könyvtár frissítése az új viewer-originen is előkészíti a mentett csomagokat. A régi viewer-origin saját cache-e nem költözik át automatikusan.

## Offline működés és tárolás

A UI és minden oldal saját originjén külön Service Worker cache-eli az indítófájlokat. A UI a saját tartós csomagpéldányán kívül az oldal originjén tárolt összes fájlt és torrentbizonyítékot is ellenőrzi az offline jelölés előtt. A teljesen mentett oldal a saját HTTP(S)-címén, bezárt HPPT alkalmazás mellett is újranyitható offline. A UI-ból történő offline megnyitás is működik; egyik út sem vár trackerre, ICE API-ra vagy hitelesítésre.

A pinelt csomag online újraindításkor visszaállítható seedelésre; ehhez a darabtár újraépül, az SHA-256 ellenőrzés és az eredeti infoHash összevetése megtörténik. Az unpin kikapcsolja az automatikus reseedet, a törlés mindkét origin tartalomcache-ét üríti. A bootstrap cache megmarad.

Első használatkor hálózati hozzáférés kell. Tárhelytörlés, böngészős eviction vagy privát profil elvesztése után nincs offline garancia. A PWA telepítése opcionális. A Service Worker és a bezárt böngésző nem folyamatos seeder.

## Viewer és kompatibilitás

A HPPT alkalmazásban marad a WebTorrent/WebRTC engine. Minden csomag külön originen, normál böngészőlapon jelenik meg, például:

```text
http://<infoHash>.hppt.localhost:5173/pages/home.html?mode=1#details
```

Az oldal saját Service Workere az eredeti fájlbytes tartalmat adja vissza. Cache-hiánykor dedikált MessagePorton kéri a fájlt a nyitott HPPT alkalmazástól. A natív böngésző kezeli a HTML-t, CSS importokat, képeket, ES-modulokat, relatív navigációt, queryt és fragmentet. Nincs HTML/CSS-átírás, data URL-es csomagolás vagy megjelenítő iframe. A vezérlő UI rejtett, oldalankénti `__hppt` helper frame-je kizárólag a worker és az alkalmazás közötti üzenetkapcsolatot tartja fenn, és worker-újraindulás után újraköti azt.

A külön originek azonos schemeful site-on belül legyenek. Ez szükséges ahhoz, hogy a helper iframe-ben előkészített worker/cache a külön megnyitott oldalon is ugyanahhoz a tárhelyhez tartozzon. Fejlesztésben az `app.hppt.localhost` és `<hash>.hppt.localhost` ezt biztosítja. A Playwright tesztekben a tárhely-particionálás bekapcsolva marad, ezt külön negatív teszt ellenőrzi.

A tartalom a saját originjének storage-át használhatja, ezért a cache nem bizalmi határ. A worker az eredeti torrent `info` részének SHA-1 hash-ét a hostnévben szereplő infoHash-hez ellenőrzi, majd a manifestet tartalmazó torrentdarabokat hitelesíti. Ebből kapja a manifest SHA-256 fájlhash-eit. Minden cache-elt fájlt újra ellenőriz kiszolgáláskor; worker-újraindulás után a tárolt manifestbizonyítékot is újra hitelesíti. A `__hppt` útvonaltér fenntartott, csomag nem tartalmazhat ilyen fájlt.

A CSP engedi a csomag saját scriptjeit, stílusait, képeit, moduljait és az ugyanazon originre mutató GET/fetch kéréseket; blokkolja a külső erőforrásokat, az új workert, a frame-et és az űrlapbeküldést. A `Cross-Origin-Opener-Policy: same-origin` leválasztja a viewer ablakot a vezérlőről. Az `Origin-Agent-Cluster: ?1` megakadályozza a `document.domain` alapú origin-összevonást. A bridge origin/source/nonce/session/verzió/hash szerint ellenőrzött és kérésenként időkorlátos.

Backend és tetszőleges POST nincs; explicit hiányzó fájl 404-et ad, SPA-fallback nincs. Külső linkre vagy más címre navigálni normál böngészőablakban lehet: ez nem exfiltrációvédelmi vagy anonimitási rendszer. A peer, tracker és TURN hálózati metaadatokat láthat. Csak nyilvános demótartalommal tesztelj.

## Konfiguráció, LAN és production

A publikus beállításokat a `.env.example` sorolja fel. Az ICE policy a UI-ban, új build nélkül váltható; az új kapcsolatokhoz új kliens indul. Az alap limitek konfigurálhatók: 1000 fájl, összesen 50 MiB, fájlonként 10 MiB. Fájl csak teljes SHA-256 ellenőrzés után jeleníthető meg/cache-elhető. Range-kérésre teljes, ellenőrzött 200-as válasz jár; nagyfájl-streaming nincs.

```sh
npm run setup:dev -- --turn-host 192.168.1.50
```

LAN/mobil teszthez a `http://192.168.x.x` nem localhost secure context. Mindkét originhez megbízható HTTPS, a trackerhez WSS, elérhető TURN IP és megfelelő tűzfal/NAT szükséges. A telefon `localhost` címe a telefont jelenti. A Vite kiszolgáló loopbacken figyel; LAN/publikus eléréshez HTTPS reverse proxy vagy külön statikus host kell. A frontend hostnevek legyenek a böngészőből elérhetők, ne Compose szolgáltatásnevek.

Az `APP_ORIGIN` és `VIEWER_ORIGIN` külön hosztnevet, de azonos sémát és portot használjon. Productionban például `APP_ORIGIN=https://app.example.com` és `VIEWER_ORIGIN=https://sites.example.com` használható; mindkettő HTTPS 443. A `<hash>.sites.example.com` hostokhoz wildcard DNS és megbízható wildcard TLS-tanúsítvány kell; a viewer originjei legyenek cookie-mentesek, az alkalmazás hitelesítése host-only cookie-t használjon. A helper és a külön megnyitott oldal tárhelyének megosztásához azonos schemeful site szükséges.

Az egyetlen frontend-szerver a vezérlő hosztnevén az `apps/web/dist`, a viewer és `<hash>` hosztnevein az `apps/viewer/dist` fájljait szolgálja ki. A viewer host kizárólag a `/__hppt/` útvonaltérben, a generált precache-listában szereplő megbízható indítófájlokat adhatja vissza; a prefixet a viewer build könyvtárára kell képezni. A workerhez `Service-Worker-Allowed: /` fejléc kell. A közvetlen felső szintű oldalmegnyitás 302-vel indul a launcher felé; más csomagfájl-kérés szerveroldalon 503/404, HTTP payload- és SPA-fallback nélkül. A CSP-, nosniff- és origin-fejléceket a [Vite host-konfiguráció](scripts/vite-shared.ts) szerint állítsd be. A UI `/runtime-config.json`, illetve a viewer `/__hppt/runtime-config.json` végpontja csak publikus beállításokat tartalmazhat.

Saját felhasználókezelés nincs. A production ICE API külső hitelesítő gatewayt feltételez, szerveroldali `TURN_SECRET` és `AUTH_PROXY_TOKEN` beállítással. A gateway levágja a bejövő `X-Authenticated-User`/`X-HTPPT-Gateway-Token` fejléceket, majd a hitelesített azonosítót és saját titkos gateway-tokenjét állítja be. Az ICE API csak a gateway felől legyen elérhető. A gateway-token és TURN shared secret sosem kerülhet frontendbe. A credential endpoint szűk CORS-t, no-store-t, rate limitet és kiadási kvótát használ.

A [production coturn példa](infra/coturn/turnserver.production.conf.example) REST authot, TLS-cert/key helyeket, peer-céltartomány-tiltást és kvótákat mutat. `turns:` csak ténylegesen konfigurált TLS listener esetén szerepelhet az API válaszában. Publikus HTTPS/WSS/TLS TURN telepítés nem történt ebben a munkamenetben.

## Ellenőrzések

```sh
npm run lint
npm run typecheck
npm run test:unit
npx playwright install --with-deps chromium
npm run test:e2e
npm run test:relay
npm run doctor
npm run build
npm run infra:logs
npm run infra:down
```

A P2P e2e tesztek valódi Chromium-kontextusok között futnak, saját 5273/8100/3101 portokon. A relay külön kötelező CI-job; a sima e2e-ben való kihagyása nem relay-minősítés. A relay suite saját coturnt indít a 3488-as porton, hitelesített REST credentialökkel. Linux Docker Engine kell hozzá, vagy natív `TURNSERVER_BIN`. Külső elérhetetlenség hibát eredményez, nem hamis sikert. A tesztek saját folyamataikat leállítják.

A pontos futtatási eredmények, verziók és környezeti korlátok a [megvalósítási jegyzőkönyvben](docs/implementation.md), a részletes követelmények a [specifikációban](docs/specification.md) találhatók. A lockfile és a Docker image-ek rögzítettek; tranzitív `ip` függőséghez jelenleg upstream audit-jelzés tartozik, részletek a jegyzőkönyvben.
