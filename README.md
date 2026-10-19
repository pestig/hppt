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
| Vezérlő UI | http://localhost:5173 |
| Külön originű viewer | http://localhost:5174 |
| WebSocket tracker | ws://localhost:8000 |
| ICE API | http://localhost:3001/ice |

A vezérlő UI-t az `APP_ORIGIN` címén nyisd meg (alapból `http://localhost:5173`). A `127.0.0.1` és a `localhost` külön origin: a CORS, a viewer és a böngészős tárhely pontos címegyezést igényel. Más címen megnyitva a UI indításkor átirányít az `APP_ORIGIN` címre, megőrizve az útvonalat, queryt és fragmentet. Az offline mentések a konfigurált originhez tartoznak.

Új build telepítésekor a Service Worker előbb cache-eli az új indítófájlokat, majd egyszer újratölti a nyitott vezérlőfelületeket. A tartósan mentett csomagok megmaradnak. Ha egy régi verzió még beragadt, a `http://localhost:5173/refresh` cím a régi indítóoldal-cache megkerülésével tölti be a friss alkalmazást; tárhelytörlés nem szükséges.

A `setup:dev` idempotens: megőrzi a credentialt, `.env`-et és helyi coturn-konfigurációt készít. Mindkettő gitignore-olt. A `dev` buildeli és párhuzamosan kiszolgálja a két alkalmazást a Service Worker precache-listáival; módosítás után újraindítandó. Kész buildhez `npm run serve` használható.

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
3. A kapott `web+hppt://…` címet illeszd B-be. Ellenőrizd a CSS-t, képet, JS-gombot és relatív aloldalt.
4. B-ben válaszd a „Mentés offline + pin” gombot. A teljes csomag letöltése, ellenőrzése és tartós tárolása után jelenik meg az „Offline elérhető” állapot.
5. Zárd be A-t. Tiszta C profil B-től is le tudja tölteni a csomagot. B-t a továbbosztáshoz tartsd nyitva.
6. B böngészőjét bezárva, majd ugyanazzal a megőrzött profillal, leállított szerverek és internet nélkül is megnyitható a korábban betöltött alkalmazás és a teljesen mentett oldal.

Az `index.html` nem kötelező. A `fixtures/nested-site` demónál válaszd a `pages/home.html` kezdőfájlt. Üres URI-útvonalnál a manifest `entrypoint` mezője dönt; explicit hiányzó útvonalnál 404 jár, kezdőoldal-fallback nincs. Relatív hivatkozások, CSS importok és CSS-képek támogatottak; a query/fragment a logikai címmel és a megosztható linkkel együtt megmarad.

A protokollkezelő regisztrációja külön gombbal történik, támogatott böngészőben. Mindig használható a beillesztés és a belépési link. A hordozható böngészős séma `web+hppt://`, a natív `hppt://` nem része az MVP-nek.

## Offline működés és tárolás

A UI és a viewer saját originjükön külön Service Workerrel cache-elik az indító HTML/JS/CSS fájlokat és a publikus konfigurációt. A UI előkészíti a viewer offline indítását is. Az offline jelöléshez a teljes csomag ellenőrzött, tartós példánya és az előkészített viewer szükséges. Offline induláskor a helyi megjelenítés nem vár trackerre, ICE API-ra vagy hitelesítésre.

A pinelt csomag online újraindításkor visszaállítható seedelésre; ehhez a darabtár újraépül, az SHA-256 ellenőrzés és az eredeti infoHash összevetése megtörténik. Az unpin kikapcsolja az automatikus reseedet, a törlés mindkét origin tartalomcache-ét üríti. A bootstrap cache megmarad.

Első használatkor hálózati hozzáférés kell. Tárhelytörlés, böngészős eviction vagy privát profil elvesztése után nincs offline garancia. A PWA telepítése opcionális. A Service Worker és a bezárt böngésző nem folyamatos seeder.

## Viewer és kompatibilitás

A megbízható viewer bootstrap lekéri és ellenőrzi a fájlokat, majd `srcdoc` dokumentumban, beágyazott data URL-es erőforrásokkal jeleníti meg őket:

```html
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
```

Ez a felhasználó által jóváhagyott architektúra: az opaque iframe közvetlen navigációját a Chromium nem adja át a Service Workernek. A szülőből létrehozott blob URL-ek sem hordozhatók megbízhatóan ebbe a környezetbe. A nyers `/content/<hash>/<path>` fájlokat csak a sessionhöz kötött, megbízható bootstrap kéri le; a belső oldal címe `about:srcdoc`.

A szigorú CSP blokkolja a külső fetch/script/image/CSS kéréseket, a workert, beágyazott frame-et és űrlapot. A tartalom nem kap `allow-same-origin`, popup, top-navigation, form vagy download jogot. A bridge ellenőrzi az origint, source-ot, nonce-t, sessiont, verziót és hash-t; dedikált portokat és véges kérésszámot/timeoutot használ. Worker-újrainduláskor újrakapcsolódik.

A támogatott demó statikus HTML, CSS, képek, klasszikus JS és relatív HTML-aloldalak. ES modul, storage, fetch-alapú alkalmazás, backend, általános SPA és az eredeti `window.location`-re épülő router nincs garantálva. A `srcset` és a beágyazott frame-ek nem támogatottak. A külső linkre kattintás blokkolt; az iframe programozott saját navigációja miatt ez nem teljes exfiltrációvédelem. A protokoll anonimitást sem ad: a peer, tracker és TURN hálózati metaadatokat láthat. Csak nyilvános demótartalommal tesztelj.

## Konfiguráció, LAN és production

A publikus beállításokat a `.env.example` sorolja fel. Az ICE policy a UI-ban, új build nélkül váltható; az új kapcsolatokhoz új kliens indul. Az alap limitek konfigurálhatók: 1000 fájl, összesen 50 MiB, fájlonként 10 MiB. Fájl csak teljes SHA-256 ellenőrzés után jeleníthető meg/cache-elhető. Range-kérésre teljes, ellenőrzött 200-as válasz jár; nagyfájl-streaming nincs.

```sh
npm run setup:dev -- --turn-host 192.168.1.50
```

LAN/mobil teszthez a `http://192.168.x.x` nem localhost secure context. Mindkét originhez megbízható HTTPS, a trackerhez WSS, elérhető TURN IP és megfelelő tűzfal/NAT szükséges. A telefon `localhost` címe a telefont jelenti. A Vite kiszolgáló loopbacken figyel; LAN/publikus eléréshez HTTPS reverse proxy vagy külön statikus host kell. A frontend hostnevek legyenek a böngészőből elérhetők, ne Compose szolgáltatásnevek.

Productionban a két frontend statikus buildjét külön, lehetőleg cookie-mentes viewer domainen szolgáld ki. A megfelelő `APP_ORIGIN`, `VIEWER_ORIGIN`, `TRACKER_URL` és `ICE_API_URL` értékekkel buildelj; a `/runtime-config.json` csak publikus adatokat tartalmazzon. A viewer `/content/` útvonala szerveroldalon mindig 503/404 legyen, HTTP payload vagy SPA fallback nélkül. A viewer CSP-fejléceit a [Vite host-konfiguráció](scripts/vite-shared.ts) szerint állítsd be a statikus hoston is.

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

A P2P e2e tesztek valódi Chromium-kontextusok között futnak, saját 5273/5274/8100/3101 portokon. A relay külön kötelező CI-job; a sima e2e-ben való kihagyása nem relay-minősítés. A relay suite saját coturnt indít a 3488-as porton, hitelesített REST credentialökkel. Linux Docker Engine kell hozzá, vagy natív `TURNSERVER_BIN`. Külső elérhetetlenség hibát eredményez, nem hamis sikert. A tesztek saját folyamataikat leállítják.

A pontos futtatási eredmények, verziók és környezeti korlátok a [megvalósítási jegyzőkönyvben](docs/implementation.md), a részletes követelmények a [specifikációban](docs/specification.md) találhatók. A lockfile és a Docker image-ek rögzítettek; tranzitív `ip` függőséghez jelenleg upstream audit-jelzés tartozik, részletek a jegyzőkönyvben.
