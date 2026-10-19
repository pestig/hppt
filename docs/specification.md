# HPPT v0.1 — megvalósítási specifikáció

## Viewer-architektúra

A HPPT alkalmazás nyitott ablakában fut a WebTorrent/WebRTC engine. Minden csomag külön originen és külön böngészőlapon jelenik meg: fejlesztésben `http://<infoHash>.hppt.localhost:5173/<path>`, a vezérlő címe `http://app.hppt.localhost:5173`.

A két frontend buildet egyetlen Vite preview folyamat, ugyanazon a porton szolgálja ki hosztnév szerint. A vezérlő és a viewer külön Service Workert és precache-listát tart meg. Az alkalmazás és a viewer konfigurált originje eltérő hosztnevű, azonos sémájú és portú legyen. A viewer hoston a generált precache-lista engedélyezi a bootstrapfájlokat, vezérlő SPA-fallback nincs.

Az oldal Service Workere az eredeti HTML/CSS/JS/kép fájlokat cache-ből vagy dedikált MessagePorton az alkalmazástól olvassa, teljes integritásellenőrzés után `Response`-ként adja vissza. A böngésző natívan kezeli az oldalt. A vezérlő rejtett, oldalankénti helper iframe-je a workerrel való kapcsolatot tartja fenn; a tartalom nincs iframe-be ágyazva. A helper és a top-level oldal azonos tárhelypartíciójához a külön originek azonos schemeful site-on legyenek.

A tartalom saját storage-ot használhat, ezért az offline manifestet az infoHash-hez kötött torrentbizonyítékkal kell hitelesíteni: az eredeti `info` bytes SHA-1 hash-e, a manifestet tartalmazó darabok SHA-1 ellenőrzése, utána a fájlok manifest szerinti SHA-256 ellenőrzése. Új worker ezt a bizonyítékot újra hitelesíti. A `/__hppt/` a megbízható bootstrap/SW fenntartott útvonala; a szerver más útvonalon nem szolgálhat ki csomagtartalmat.

## A dokumentum célja és státusza

Ez a dokumentum a HPPT MVP követelményeit rögzíti. A tényleges futtatási parancsokat a README, a lefuttatott ellenőrzéseket a megvalósítási jegyzőkönyv tartalmazza.

**Feladat:** készíts működő, böngészős P2P statikusweboldal-publikálót és -böngészőt TypeScriptben. Egy felhasználó kiválaszt egy HTML/CSS/JS/kép fájlokat tartalmazó könyvtárat, publikálja, és megoszt egy HPPT-linket. Egy másik böngésző a tartalmat WebRTC-n, WebTorrent segítségével tölti le, megjeleníti, és tovább is osztja.

A böngészőben fut a tartalom publikálása, letöltése, ellenőrzése és megjelenítése. Az indítóalkalmazás kiszolgálásához és a peerek találkozásához infrastruktúra kell. TURN-relé esetén a tartalom titkosított WebRTC-forgalma is szerveren halad át. Ne nevezd ezt teljesen szervermentes rendszernek.

## Kötelező műszaki korlátok

- Tetszőleges `hppt://` séma nem telepíthető egy közönséges weboldallal natív böngészőprotokollként. A böngészős MVP sémája **`web+hppt://`**; legyen mellette másolható HTTPS-es belépési link is. A támogatást feature detectionnel ellenőrizd. A séma regisztrációja külön, felhasználó által indított művelet legyen.
- A handler HTTPS-es alkalmazásra navigál. Nem marad natív `hppt://` cím a címsorban, és a `fetch('hppt://…')` nem válik támogatottá.
- A Service Worker a saját originje/scope-ja alatti HTTP-kérésekre adhat választ. Nem nyit TCP/HTTP listening portot, és nem helyettesít általános HTTP-szervert.
- Ne alapozz folyamatos seedelést Service Workerre vagy a bezárt böngészőre. A P2P engine az élő alkalmazásablakban fusson. Háttérbe tett lapot a böngésző felfüggeszthet.
- A WebRTC-kapcsolatot ne próbáld közvetlenül a Service Workerbe tenni. A worker üzenetben kérje a fájlt az alkalmazásoldaltól.
- Böngészős WebTorrent-peerek WebRTC-képes társakat igényelnek; hagyományos BitTorrent TCP/UDP peer nem elég. A böngésző nem futtat hagyományos UDP-s DHT-t.
- A P2P-n kapott HTML/JavaScript nem megbízható. Több publikáló nem futhat a vezérlőalkalmazás originjének jogosultságaival.
- Az MVP statikus oldalakra készül. PHP/Node backend, szerveroldali SSR, adatbázis, tetszőleges HTTP POST és minden létező SPA teljes kompatibilitása nincs benne.

## Elvárt stack és repository

Használj npm workspaces monorepót, TypeScript strict módot, ESM-et, Vite-ot, egyszerű böngészős UI-t, Vitestet és Playwrightot. Az MVP-hez nem szükséges Angular. Node 24 LTS legyen a kiindulás; az implementáláskor ellenőrizd a függőségek kompatibilitását. Válassz ellenőrzött verziókat, commitold a lockfile-t, és pineld a Docker image-eket verzióra vagy digestre. Ne maradjon `latest` az átadott konfigurációban.

```text
apps/
  web/                  # vezérlő UI + WebTorrent engine, app.hppt.localhost:5173
  viewer/               # oldalankénti viewer host, <hash>.hppt.localhost:5173
  tracker/              # bittorrent-tracker WebSocket szerver, :8000
  ice-api/              # ICE konfiguráció / rövid életű TURN credential, :3001
packages/
  protocol/             # URL parser, útvonalak, manifest, validálás
  p2p/                  # WebTorrent adapter, seed/download, diagnosztika
  viewer-bridge/        # MessageChannel/Service Worker bridge
infra/
  coturn/turnserver.dev.conf
  coturn/turnserver.production.conf.example
  Dockerfile.tracker
  Dockerfile.ice-api
fixtures/
  hello-site/           # index.html, css, kép, aloldal
  hostile-site/         # izolációtesztek, külső kérés, traversal kísérlet
scripts/
  setup-dev.mjs
  doctor.mjs
  dev.mjs
  test-relay.mjs
compose.yaml
.env.example
package.json
package-lock.json
README.md
```

A felsorolt struktúra célállapot: az agent hozzon létre minden szükséges entrypointot, Dockerfile-t és scriptet. Az el nem készült funkciót ne dokumentálja működőként.

## Architektúra

| Komponens | Feladat | Tárolhat/kezelhet weboldalpayloadot? |
|---|---|---|
| Web UI | Könyvtár import, linkek, seed/download, állapot | Igen, a böngészőben |
| Viewer host | Viewer bootstrap és Service Worker fájljai | A szerver csak bootstrapot szolgál ki |
| WebSocket tracker | WebTorrent peer discovery és offer/answer signaling | Nem weboldalfájl-szerver |
| ICE API | STUN/TURN lista, időkorlátos credential | Nem |
| coturn | STUN és szükség esetén TURN relay | Titkosított adatforgalmat továbbít |
| Service Worker | Virtuális fájl-URL-ek kiszolgálása, cache | Igen, a böngészőben |

WebTorrent tracker esetén nem kell külön saját SDP-signaling protokollt írni. Ne keverd a tracker URL-jét a TURN címével: `ws(s)://…` a tracker, `stun:…`, `turn:…` és opcionálisan `turns:…` az ICE szolgáltatás.

### Tartalom megnyitása

1. A handler validálja a HPPT-címet és a hash-t.
2. A UI először ellenőrzi a helyben tárolt csomagot. A teljesen cache-elt tartalom megjelenítése ne várjon trackerre, ICE API-ra vagy hitelesítésre. P2P-letöltéshez betölti az ICE konfigurációt, és elindítja a WebTorrent klienst a kijelölt trackerrel.
3. A manifestet és a szükséges fájlokat a tartós tárolóból, hiányuk esetén a torrent metadata lekérése után P2P-n olvassa be. Üres URI-útvonalnál a manifest `entrypoint` mezőjét oldja fel; explicit útvonalnál kizárólag az adott fájlt keresi.
4. A viewer host megbízható bootstrapja regisztrálja a saját Service Workerét; várjon a worker általi tényleges vezérlésre is, ne csak a regisztrációra.
5. A vezérlő UI átad egy dedikált MessagePortot a viewer bootstrapnak, amely összeköti azt a workerrel.
6. Az oldal originen futó worker a `/<path>` kéréseket cache-ből vagy ezen a bridge-en keresztül teljesíti.
7. A UI külön böngészőlapot nyit a csomag saját originjének tényleges fájlútvonalán. A böngésző az eredeti HTML/CSS/JS bytes tartalmat jeleníti meg, kezeli a relatív hivatkozásokat, queryt és fragmentet.
8. A letöltött torrent élő kliens mellett továbbosztható.

A protokollkezelő és a másolható `/open?uri=…` link könnyű indítóoldalt tölt be: a belépési lap maga navigál a csomag tényleges viewer-címére. Teljes helyi csomagnál WebRTC és külön vezérlőlap nélkül ellenőrzi a csomagot és a viewer tartós tárolását. Letöltendő csomagnál az alkalmazás originjén működő BroadcastChannelen kiválaszt egy már nyitott vezérlőlapot, amely előkészíti a viewert és fenntartja a P2P bridge-et. Vezérlő hiányában külön alkalmazáslap indul; blokkolt ablaknyitáskor felhasználó által kattintható indítógomb kell. Több vezérlő esetén kérésazonosító és kiválasztott vezérlőazonosító biztosítsa, hogy egy kérést egy vezérlő dolgozzon fel. A query, fragment, entrypoint-feloldás és explicit 404 szabályai ezen az útvonalon is érvényesek.

A csomag saját HTTP(S)-URL-jének friss profilban történő közvetlen megnyitása is indítsa el ezt az előkészítést. Telepített Service Worker hiányában a viewer host kizárólag a `GET`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` kérésre adjon nem cache-elhető 302-es átirányítást az alkalmazás `/open?uri=…&source=viewer` belépési pontjára. A hash-t a validált hostnévből, az útvonalat/queryt az eredeti kérésből vegye; tetszőleges visszatérési URL-t ne fogadjon. A HTTP-ben nem küldött fragmentet a böngésző átirányítási öröklése őrizze meg, a launcher a `source=viewer` jelölésnél adja hozzá a belső URI-hoz. A kiszolgáló ekkor sem ad vissza csomagfájlt; fetch-, iframe- és erőforráskérésre megmarad az 503-as, payload nélküli válasz.

A workerből soha ne legyen automatikus HTTP fallback a csomagfájlok útvonalaira. Peerhiány esetén értelmes hiba és újrapróbálás kell, nem SPA `index.html` 200-as válasz.

## Protokoll v0.1

### Címzés

```text
web+hppt://<40-character-lowercase-hex-btih>
web+hppt://<40-character-lowercase-hex-btih>/index.html
https://app.example/open?uri=<URL-encoded-web+hppt-URI>
```

A v0.1 torrent v1 `infoHash`-t használ, nem önkényesen előállított SHA-256 site hash-t. Ellenőrizd a választott WebTorrent verzió torrentformátumát. A fájlokhoz külön SHA-256 ellenőrzés tartozik. A v1 torrenthash nem publikálói aláírás; ne állíts róla ilyet.

- A tracker címét a kliens konfiguráció adja; a v0.1 link ne fogadjon tetszőleges tracker/ICE URL-t.
- A `web+hppt://<hash>` és `web+hppt://<hash>/` cím a manifest `entrypoint` fájlját nyitja meg. Az `index.html` nem kötelező.
- Explicit útvonal, például `/about.html`, pontosan az adott fájlt jelenti; hiányakor 404 jár, nincs entrypoint fallback.
- Feloldás után a külön viewer ablak a tényleges csomagbeli fájlútvonalra navigáljon. A `pages/home.html` erőforrásait a böngésző ezen valós URL-hez képest oldja fel. A query és fragment maradjon meg.
- A hash új verziónál változik. Nincs mutable névfeloldás, DNS vagy automatikus frissítés a v0.1-ben.
- Az URL query és fragment megőrzendő a megjelenítéshez, de nem része a fájl kulcsának. A letöltés a pathname alapján történik.
- Normalizálj és validálj minden útvonalat. Tiltsd a `..`, NUL, backslash, kódolt elválasztó és többszörös dekódolásból eredő kikerüléseket. Legyen explicit szabály a kis/nagybetűkre, Unicode-ra és ismételt útvonalakra.
- A torrent gyökérkönyvtárát egyetlen adapter képezze le a weboldal relatív útvonalaira. Ne szórd szét a prefixeltávolítást a kódban.

### Manifest

A torrent tartalmazzon egy `htppt-manifest.json` fájlt, például:

```json
{
  "protocol": "htppt/0.1",
  "entrypoint": "index.html",
  "files": [
    {
      "path": "index.html",
      "mime": "text/html; charset=utf-8",
      "size": 512,
      "sha256": "<64 lowercase hex characters>"
    }
  ]
}
```

A példabeli hash és méret helykitöltő. Publikáláskor tényleges értékeket generálj. A manifest nem tartalmazza a saját hash-ét és nem tartalmazza a torrent infoHash-ét: ez elkerüli a körkörös függőséget. Kötelező manifest schema-validáció, engedélyezett MIME-típusok, fájlszám- és méretkorlát, valamint manifest/torrent méret- és útvonal-egyezés. Az alapértelmezett MVP-limit legyen konfigurálható: 1000 fájl, összesen 50 MiB, fájlonként 10 MiB.

Az `entrypoint` kötelező, normalizált, csomagon belüli relatív fájlútvonal. A hivatkozott fájlnak a manifest fájllistájában és a torrentben is léteznie kell, és HTML-típusúnak kell lennie (`text/html`, opcionális charset paraméterrel). Hibás vagy hiányzó entrypoint esetén a csomag érvénytelen. Publikáláskor az UI ajánlja fel az `index.html`-t, ha létezik; egyébként kérjen kezdőfájl-választást. A kiválasztott HTML-fájl kerüljön az `entrypoint` mezőbe.

Egy fájlt csak a teljes SHA-256 ellenőrzés után jeleníts meg és cache-elj. Ezért a v0.1 ne ígérjen nagy fájlokra streaming megjelenítést. A WebTorrent saját darabellenőrzése maradjon bekapcsolva. `skipVerify` nem használható ellenőrizetlen adathoz.

### Böngészős protokollregisztráció

```ts
// Felhasználó által megnyomott gomb eseményében, támogatott környezetben.
navigator.registerProtocolHandler(
  'web+hppt',
  `${location.origin}/open?uri=%s`
);
```

HTTPS-en ellenőrizd a tényleges regisztrációt. A localhost fejlesztői kivételeire ne építs hordozható ígéretet. Legyen mindig működő URI beillesztés és HTTPS-link. A natív `hppt://` integráció külön, későbbi projekt.

## Viewer és biztonsági modell

A vezérlő és minden csomag külön origin. A külön ablak önmagában nem izoláció. Egy csomag csak a saját hash-éhez kötött fájlokat kérheti; a hash a viewer hostname része. A tartalom storage-a megosztott az oldal saját workerével, ezért a worker minden cache-válaszát hitelesített manifesttel ellenőrizze.

A worker az eredeti fájlokat adja vissza, HTML/CSS átírás nélkül. A tartalomtól független HTTP-fejlécek:

```text
default-src 'none';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'self';
worker-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'self';
form-action 'none';
frame-ancestors 'none'
```

Kötelező a `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin` és `Origin-Agent-Cluster: ?1`. A tartalom saját helyi storage-ot használhat, az alkalmazás és más csomagok storage-át nem érheti el. A külső erőforráskérések, worker-regisztráció és beágyazott frame blokkolt. Külső felső szintű navigáció lehetséges, ezért a megoldás nem exfiltrációvédelmi vagy anonimitási rendszer.

A trusted helper a `/__hppt/` útvonalon fusson; csak innen származó, helyes nonce/session/hash értékű worker-init fogadható el. A UI az üzenet originjét, source-át és protokollverzióját is ellenőrizze, majd hash-re korlátozott dedikált MessageChannelen szolgáljon ki fájlokat. Rossz source/origin/nonce/session/hash ne cserélhesse le a bridge-et.

A viewer HTTP-host csak a bootstrap és worker indítófájljait szolgálhatja ki. A csomagfájlokra szerveroldali 503/404 jár. A worker scripthez `Service-Worker-Allowed: /` kell. A `/__hppt` útvonaltér csomagbeli fájlnévként tiltott. A production wildcard hostokhoz DNS/TLS és azonos schemeful site szükséges.

## P2P adapter és Service Worker bridge

Az adapter publikus műveletei: `publish(files, { entrypoint })`, `open(infoHash)`, `readFile(infoHash, path)`, `pin(infoHash)`, `unpin(infoHash)`, `stop(infoHash)`, `getStats()`.

A kiválasztott WebTorrent/tracker verzió dokumentált API-ján keresztül juttasd el az `iceServers` és az `iceTransportPolicy` értékét az összes tényleges `RTCPeerConnection`-höz, publikáló és letöltő oldalon is. Ne elégedj meg egy UI-kapcsolóval: a relay teszt bizonyítsa, hogy ténylegesen átjutott a konfiguráció. A pontos beállítási útvonalat az implementáló agent ellenőrizze; ne találjon ki verziófüggetlen konstruktort.

A bridge üzenete legyen verziózott, schema-validált, request ID-val és session ID-val. Legyen maximum pending kérés, timeout, abort és cleanup. Kliens nélkül 503, ismeretlen fájlnál 404, hibás útvonalnál 400, integritáshibánál ellenőrzött hiba legyen. A klienshiányt ne cache-eld sikeres fájlként. A v0.1 csak GET és HEAD kérést támogat; más metódus 405. Range kérésnél vagy helyes 206/416 implementáció, vagy dokumentált, teljes 200-as válasz; ne adj hibás 206-ot.

Cache-kulcs: protokollverzió + infoHash + normalizált path. Csak ellenőrzött bytes kerülhetnek bele. Legyen cache-törlés, kvóta-/eviction-hibakezelés és offline cache-visszaolvasás. A cache-ben meglévő fájl önmagában nem jelenti, hogy a torrent újra seedel: a pin/reseed során állítsd helyre a darabtárat, a metadata-t és ellenőrizd az adatokat.

### Offline indulás — kötelező MVP-funkció

A korábban betöltött alkalmazás a böngésző bezárása után, internet nélkül is induljon el a saját HTTPS-/localhost-címéről, és nyissa meg a teljesen cache-elt oldalt.

- A vezérlő UI saját Service Workere cache-elje az alkalmazás indításához szükséges HTML-, JS- és CSS-fájlokat, valamint az offline induláshoz szükséges publikus konfigurációt. A támogatott belépési útvonalak, köztük az `/open?uri=…`, hálózat nélkül is indítsák el az alkalmazást.
- A külön originű viewer saját Service Workere cache-elje a megbízható bootstrapot és annak indítási függőségeit is. A bootstrap offline kiszolgálása ne vezessen HTTP fallbackhez a csomagfájlok útvonalain. A teljesen mentett oldal a vezérlőablak nélkül is induljon a saját címén.
- Csak a teljesen letöltött, ellenőrzött és tartósan tárolt csomag kapjon „Offline elérhető” jelölést. A manifestet és a helyi megnyitáshoz szükséges adatokat is tárold; részleges letöltés vagy sikertelen tárolás nem elég. Újraindításkor ellenőrizd a helyi adatok meglétét, és hiány esetén vond vissza a jelölést.
- Offline induláskor a helyi tartalom megjelenítése ne várjon trackerre, ICE API-ra vagy hitelesítésre. A session és a bridge helyben is felépüljön, az origin-/hash-izoláció és a tartalomellenőrzés megőrzésével.
- Első használatkor kell internet. Az offline működés a böngésző által megőrzött adatokra támaszkodik; törölt vagy kiürített tárhely után nem garantálható. A PWA telepítése opcionális.

## Helyi futtatási szerződés

Előfeltétel: Node 24 LTS, npm, Docker Engine vagy Docker Desktop Compose v2 pluginnal, aktuális Chromium. A dokumentált alapparancsok az implementáció után:

```bash
npm ci
npm run setup:dev
npm run infra:up
npm run dev
```

A `setup:dev` idempotens legyen, ne írjon felül meglévő titkot. Hozzon létre `.env`-et és a csak helyi coturn configot véletlen credentiallel; ezek legyenek gitignore-ban. Alapértelmezett TURN host egygépes teszthez `127.0.0.1`; paraméterezhető legyen, például:

```bash
npm run setup:dev -- --turn-host 192.168.1.50
```

A `dev` indítsa a web UI-t és viewer hostot párhuzamosan, kezelje a leállítást, és jelenítse meg:

```text
Web UI:      http://app.hppt.localhost:5173
Viewer host: http://hppt.localhost:5173
Tracker:     ws://localhost:8000
ICE API:     http://localhost:3001
```

A `localhost` secure-context kivétel miatt alkalmas helyi Service Worker fejlesztésre. A `http://192.168.x.x` cím már nem ugyanez: LAN/mobil teszthez megbízható HTTPS kell a UI és viewer host számára, valamint WSS tracker. `localhost` a mobilon magát a mobilt jelenti. A Vite hostengedélyeket konkrétan konfiguráld.

A böngészőnek elérhető hostneveket add át; a Compose belső `tracker`, `ice-api`, `coturn` szolgáltatásnevei nem használhatók a host böngészőjében.

### Elvárt környezeti változók

```dotenv
APP_ORIGIN=http://app.hppt.localhost:5173
VIEWER_ORIGIN=http://hppt.localhost:5173
TRACKER_URL=ws://localhost:8000
ICE_API_URL=http://localhost:3001/ice
TURN_HOST=127.0.0.1
TURN_PORT=3478
ICE_TRANSPORT_POLICY=all
```

Csak publikus érték kerülhet a frontend runtime configba. A statikus TURN credential fejlesztői kivétel; a production shared secret soha nem kerülhet `VITE_*` változóba vagy bundle-be. A relay mód runtime beállítás legyen, ne igényeljen új frontend buildet.

## Docker Compose és coturn

A fejlesztői coturnhoz elegendő a hivatalos `coturn/coturn` image. A tracker és ICE API saját, kicsi Node szolgáltatás legyen; ne használj elhagyott, véletlenszerű tracker image-et. A következő mintában a `COTURN_IMAGE` kötelező, ellenőrzött verzió/digest; ezt a setup script állítsa be.

```yaml
services:
  tracker:
    build:
      context: .
      dockerfile: infra/Dockerfile.tracker
    ports:
      - "127.0.0.1:8000:8000"
    environment:
      PORT: "8000"
    restart: unless-stopped

  ice-api:
    build:
      context: .
      dockerfile: infra/Dockerfile.ice-api
    ports:
      - "127.0.0.1:3001:3001"
    env_file: .env
    environment:
      PORT: "3001"
    restart: unless-stopped

  coturn:
    image: ${COTURN_IMAGE:?Set a verified coturn image tag or digest}
    command: ["-c", "/etc/coturn/turnserver.conf"]
    volumes:
      - ./infra/coturn/turnserver.dev.conf:/etc/coturn/turnserver.conf:ro
    ports:
      - "3478:3478/udp"
      - "3478:3478/tcp"
      - "49160-49200:49160-49200/udp"
    restart: unless-stopped
```

Az agent ellenőrizze az image ENTRYPOINT-ját és a `command` összhangját. Az ICE API és tracker containerben `0.0.0.0` címen figyeljen. A TURN-portok nem loopbackre bindoltak, mert a hirdetett relay címnek elérhetőnek kell lennie; fejlesztésben host firewallal korlátozd a hozzáférést a szükséges gépekre. A példabeli relay tartomány kis tesztkörnyezethez való.

Példa a setup által generált, **csak fejlesztéshez** használt `turnserver.dev.conf` tartalmára:

```ini
listening-port=3478
listening-ip=0.0.0.0
min-port=49160
max-port=49200
fingerprint
lt-cred-mech
realm=htppt.local
user=htppt-dev:REPLACE_WITH_GENERATED_RANDOM_PASSWORD
external-ip=127.0.0.1
no-tls
no-dtls
no-cli
no-multicast-peers
no-tcp-relay
log-file=stdout
simple-log
```

A `no-tcp-relay` a peer oldali TCP relay allocationt tiltja; a kliens továbbra is kapcsolódhat TCP-n a TURN listenerhez. WebRTC-hez a relay oldali UDP-porttartomány szükséges.

**A `127.0.0.1` csak ugyanazon gépen futó böngészős teszthez való.** LAN-tesztnél a host LAN IP-je, internetes telepítésnél a publikus IP szükséges. Docker bridge mögött a hirdetett relay cím és a NAT mapping külön figyelmet igényel. Ha kell, `external-ip=PUBLIC_IP/PRIVATE_RELAY_IP` formát használj; a PRIVATE_RELAY_IP a tényleges relay interfész címe legyen. A relay-portok kívül és belül ugyanarra a portra legyenek mapelve.

Docker Desktop/WSL NAT esetén a TURN diagnosztika kötelező. Ha a hirdetett candidate nem érhető el, ne gyengítsd a tesztet: használj Linux hostot vagy publikus TURN VPS-t. Linux VPS-en host networking is használható, ilyenkor töröld a `ports` blokkot, és a host tűzfalát konfiguráld. A host networking viselkedését ne feltételezd azonosnak minden OS-en.

A statikus dev credentialt az ICE API olvashatja egy gitignore-olt env változóból, és csak dev módban adhatja vissza. Ne használj `no-auth` szervert.

### Production TURN

- Publikus Linux VPS és DNS, például `turn.example.com`.
- UDP/TCP 3478; opcionálisan TLS/TCP 5349, megfelelő tanúsítvánnyal. A relay UDP-tartományt is nyisd meg cloud és host firewallban.
- A router/cloud NAT ugyanazon relay-portokat továbbítsa. Egy HTTPS reverse proxy önmagában nem továbbít TURN UDP-t.
- TLS-es TURN beállításnál a cert/key és listener beállításait is add meg, ne csak `turns:` URL-t írj az ICE listába.
- `use-auth-secret` + erős `static-auth-secret` + stabil realm; productionban ne maradjon a dev `user=` bejegyzés.
- A credential API rövid életű TURN REST credentialt adjon ki. A titkot csak ez az API és a coturn ismeri.
- Credential endpoint: hitelesítés/hozzáférési policy, rate limit, szűk CORS, kiadási kvóta. A böngészőbe kerülő rövid életű credential továbbadható; ez nem titkos tárolás.
- Az MVP-hez nem kell teljes felhasználókezelést készíteni. A production konfiguráció feltételezhet külső hitelesítést; dokumentáld annak integrációját és a hitelesített felhasználó azonosítójának megbízható átadását az ICE API számára. A credential endpoint hozzáférési védelme így is kötelező.
- Az allokáció/frissítés viselkedését credentiallejárat mellett teszteld. Új kapcsolat előtt friss credential kell; ne szakíts működő kapcsolatot minden tokenfrissítésnél.
- Tiltsd a nem szükséges belső/loopback peer-céltartományokat a telepítési topológiához igazítva; a nyilvános TURN ne szolgáljon belső hálózat elérésére.
- Kövesd az adatforgalmat és állíts be kvótát: relé esetén a sávszélesség költsége a szervert terheli.

REST credential generálásának vázlata Node.js-ben:

```ts
import { createHmac } from 'node:crypto';

const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const username = `${expiresAt}:${authenticatedUserId}`;
const credential = createHmac('sha1', sharedSecret)
  .update(username)
  .digest('base64');
```

A TURN REST HMAC-SHA1 itt a coturn hitelesítési mechanizmus része; nem a weboldalfájlok integritáshash-e.

Az ICE API válaszformája:

```json
{
  "iceServers": [
    { "urls": ["stun:turn.example.com:3478"] },
    {
      "urls": [
        "turn:turn.example.com:3478?transport=udp",
        "turn:turn.example.com:3478?transport=tcp",
        "turns:turn.example.com:5349?transport=tcp"
      ],
      "username": "<expiry>:<user-id>",
      "credential": "<temporary-hmac-credential>"
    }
  ],
  "expiresAt": 1900000000
}
```

Csak ténylegesen konfigurált listenerhez adj vissza URL-t. A CORS engedélyezett originje a vezérlő UI legyen, ne `*` credentiales API mellett. `Cache-Control: no-store`. A TTL-t és credentialt ne logold.

## Manuális kipróbálás

1. Indítsd a szolgáltatásokat a fenti négy paranccsal.
2. Nyisd meg a UI-t két egymástól elkülönített böngészőprofilban (A és B). Két azonos profilú lap nem megfelelő cache-izolációteszt.
3. A profilban publikáld a `fixtures/hello-site` könyvtárat.
4. Másold át a kapott HPPT-címet B profilba a beillesztő mezőbe.
5. Ellenőrizd a HTML-t, CSS-t, képet, klasszikus JS-t és relatív aloldalt. A B profil letöltését és az A profil feltöltését is látnod kell.
6. A szerverek nem szolgálhatják ki HTTP-n a fixture fájlokat. Ellenőrizd a hálózati naplót és az átvitt WebRTC byte-okat.
7. B-ben töltsd le és pineld a teljes csomagot. Várd meg a tényleges ellenőrzött teljes állapotot.
8. Zárd be A-t, nyiss tiszta C profilt. C B-től is töltse le a tartalmat.
9. Állítsd mindkét aktív peer `iceTransportPolicy` értékét `relay`-re, hozz létre új kapcsolatokat, és ismételd meg a letöltést.
10. B-ben várd meg az „Offline elérhető” jelölést. Zárd be az összes alkalmazáslapot és a böngészőt, állítsd le a helyi szervereket, majd internet nélkül, ugyanazzal a megőrzött böngészőprofillal nyisd újra az alkalmazás HTTPS-/localhost-címét. A UI, a viewer bootstrap és a teljesen cache-elt oldal is töltődjön be, tracker, ICE API és hitelesítés nélkül. Ez külön eset a P2P-újraletöltéstől.

A relay tesztnél a kiválasztott ICE candidate pairben relay candidate-et és ténylegesen növekvő datachannel-adatforgalmat kell igazolni. Egy összegyűjtött, de nem kiválasztott relay candidate nem bizonyíték. Diagnosztika: alkalmazás stats, Chromium `chrome://webrtc-internals`, Firefox `about:webrtc`, coturn log.

## Automatizált tesztek és CLI-szerződés

Az agent implementálja:

```bash
npm run lint
npm run typecheck
npm run test:unit
npx playwright install chromium
npm run test:e2e
npm run test:relay
npm run doctor
npm run build
npm run infra:logs
npm run infra:down
```

A `test:e2e` indítsa vagy ellenőrizze a szükséges szolgáltatásokat, és külön browser context/profile-okkal dolgozzon. A P2P teszt ne mockolt transportot használjon. A relay teszt hálózati előfeltételeit világosan jelezd; a CI-ben hiányzó TURN nem eredményezhet hamis sikeres relay minősítést. Linux CI-ben készíts külön relay jobot elérhető TURN-nel. A `doctor` ellenőrizzen HTTP/WS elérhetőséget és konfigurációt, de jelezze, hogy a teljes WebRTC relay útvonalat csak böngészős allokáció + adatátvitel igazolja.

Kötelező tesztesetek:

| Teszt | Elfogadási feltétel |
|---|---|
| Publikálás és megnyitás | A → B teljes HTML/CSS/kép/JS működik HTTP payload fallback nélkül |
| Kezdőoldal feloldása | Hash önmagában és záró `/`-rel is a manifest entrypointjára navigál; `index.html` nélküli, például `pages/home.html` kezdőoldal relatív erőforrásai működnek, a query és fragment megmarad |
| Explicit útvonal | A kért fájl nyílik meg; hiányzó fájlnál 404, nincs entrypoint fallback |
| Entrypoint validálása és kiválasztása | Hiányzó, érvénytelen útvonalú, nem létező vagy nem HTML entrypoint elutasítva; az UI felajánlja az `index.html`-t, ennek hiányában kezdőfájl-választást kér |
| Továbbosztás | A leállítása után friss C a teljes csomagot B-től kapja |
| Kényszerített TURN | Mindkét peer relay módban, selected pair + tényleges adatátvitel igazolva |
| Hibás TURN credential | Friss relay-only kapcsolat hibázik, nincs direkt fallback |
| TURN leállítás | Új relay-only kapcsolat nem működik; meglévő kapcsolat megszakadása kezelt |
| Tracker leállítás | Friss discovery hibát jelez; meglévő kapcsolatot nem kötelező bontani |
| Nincs seeder | Véges timeout és újrapróbálási lehetőség |
| Offline újraindítás | Az összes alkalmazáslap és a böngésző bezárása, a helyi szerverek leállítása után, internet nélkül, megőrzött böngészőprofillal újranyitott HTTPS-/localhost-címen a UI, a viewer bootstrap és a teljesen cache-elt oldal elérhető; nem vár trackerre, ICE API-ra vagy hitelesítésre |
| Offline állapotjelzés | Csak teljes, ellenőrzött és tartósan tárolt csomag kap „Offline elérhető” jelölést; részleges, sérült vagy hiányzó helyi adat esetén nincs jelölés |
| Pin és reload | Tartós adatból valóban újraindul a seedelés |
| Integritáshiba | Sérült fájl nem renderelődik és nem kerül sikeres cache-be |
| Útvonalvédelem | Traversal és double-encoding nem ad hozzáférést más fájlhoz |
| Site izoláció | Tartalom nem éri el a UI storage-át, nem regisztrálhat saját workert, és nem fér hozzá a leválasztott vezérlőablakhoz |
| Bridge izoláció | Rossz source/origin/nonce/session/hash elutasítva |
| Külső erőforrás | Nem engedélyezett fetch/script/image CSP szerint blokkolva |
| SW lifecycle | Első telepítés, controller-váltás, reload és cache-verzióváltás kezelve |
| Kvóta és abort | Cache-kvótahiba, megszakítás és bezárt engine nem akasztja a UI-t |

A hibás adat/credential negatív teszt tesztfixture legyen, ne a produkciós ellenőrzés kikapcsolása. Minden teszthez determinisztikus timeout és cleanup tartozzon.

## Diagnosztika és hibakeresés

| Tünet | Vizsgálat |
|---|---|
| Nincsenek peerek | Nyitva van-e A; azonos infoHash/tracker; WS/WSS működik-e |
| Van signaling, nincs adat | ICE konfiguráció, NAT, TURN credential, relay portok |
| Relay candidate van, nem működik | A hirdetett IP és port tényleges elérhetősége, NAT mapping |
| Localhoston jó, telefonon nem | HTTPS trust, WSS, LAN hostnevek, tűzfal, localhost helytelen használata |
| HTTPS mellett blokkolt WS | Tracker WSS-re váltása és reverse proxy upgrade |
| Üres viewer | Worker vezérlés, bridge handshake, CSP és fájlútvonal-leképezés |
| CSS/kép helyett HTML jön | Hibás SPA fallback a csomagfájlok útvonalán |
| JS modul nem fut | Modulfájl útvonala, MIME, worker-vezérlés és CSP; az eredeti ES-moduloknak működniük kell |
| Cache megvan, de nincs seed | A WebTorrent metadata/darabstore nem állt helyre |
| Friss profilban nincs tartalom a seeder bezárása után | Nincs élő seeder; a Service Worker nem állandó seed daemon |
| Korábbi profil offline nem indul | UI és viewer bootstrap cache-e, SW scope/vezérlés, megőrzött tárhely és a teljes ellenőrzött csomag megléte |

A UI mutassa a peer countot, ellenőrzött byte-okat, feltöltést/letöltést, cache hit/miss állapotot, discovery/ICE hibát és relay/direct kapcsolatot, ha ez a használt API-ból megbízhatóan megállapítható. Titkos credential ne szerepeljen a diagnosztikában.

## Megvalósítási sorrend az agent számára

1. Hozd létre a workspaces vázat, script-szerződést, lockfile-t és fixture-öket.
2. Indíts helyi trackert és coturnt; építs minimális browser → browser seed/download tesztet.
3. Bizonyítsd a valódi relay-only adatátvitelt még a viewer elkészítése előtt. Ellenőrizd a WebTorrent ICE konfigurációjának pontos API-ját.
4. Implementáld a HPPT URL-t, csomagolást, manifestet, útvonalakat és integritásellenőrzést.
5. Implementáld a külön originű viewer bootstrappot, a dedikált bridge-et és a Service Workert.
6. Add hozzá az origin-elkülönítést, a CSP védelmet és a hostile fixture teszteket.
7. Készíts cache/pin/reseed működést, mindkét origin offline bootstrapját, háromprofilos továbbosztási tesztet és megőrzött profillal, leállított szerverek mellett végzett offline újraindítási tesztet.
8. Készíts protokollregisztrációt, HTTPS-link fallbacket és diagnosztikai UI-t.
9. Futtasd a teljes tesztmátrixot, majd írd át a README-t a ténylegesen működő parancsokra és verziókra.

Az agent ne álljon meg egy mock UI-nál. Készítsen valódi P2P átvitelt és reprodukálható helyi környezetet. Ha egy library API eltér, készítsen kis kompatibilitási próbát, javítsa az adaptert, és dokumentálja a döntést. Késznek csak lefuttatott ellenőrzés alapján jelölje a munkát; a nem futtatott külső hálózati teszt maradjon külön, egyértelműen jelzett korlát.

## Definition of Done

- Tiszta checkout után a dokumentált parancsokkal elindul a projekt.
- Két izolált böngészőprofil között valódi WebRTC-n átmegy a statikus oldal.
- Egy harmadik profil az eredeti publikáló nélkül is le tudja tölteni B-től.
- Bizonyított a coturn relay-only útvonal és a hibás credential negatív esete.
- A Service Worker a P2P-adatból ad megfelelő MIME-típusú válaszokat.
- Üres URI-útvonalnál a manifest kötelező, validált HTML-entrypointja nyílik meg; explicit hiányzó útvonal 404-et ad. A tényleges dokumentumútvonalra navigálás megőrzi a queryt, fragmentet és a relatív erőforrások helyes feloldását.
- A teljesen ellenőrzött és tartósan tárolt csomag „Offline elérhető”. Bezárt böngésző és leállított helyi szerverek után, megőrzött profillal, internet nélkül újraindul a UI és a viewer, és megjelenik a helyi oldal, hálózati szolgáltatásra vagy hitelesítésre várakozás nélkül.
- A nem megbízható tartalom nem kapja meg a vezérlő UI originjének jogait.
- A README külön kezeli a localhost, LAN és publikus telepítés beállításait.
- Nincsenek beégetett titkok, nyílt TURN relay vagy rejtett HTTP webseed fallback.
- Az átadás felsorolja a ténylegesen futtatott teszteket, verziókat és ismert kompatibilitási korlátokat.

## Későbbi bővítések

Publikálói kulcsok és aláírt mutable névfeloldás; több független tracker; folyamatos WebRTC-képes seeder; nagy fájlok streaming/range kiszolgálása; site-onként erősebb origin elkülönítés; szélesebb SPA/modul kompatibilitás; böngészőkiegészítő/natív helper a pontos `hppt://` sémához. Ezek külön specifikációt igényelnek.

## Elsődleges műszaki források

Az implementáló agent a választott verziókhoz ismét ellenőrizze az API-kat. A dokumentumhoz ellenőrzött kiinduló források (2026-10-19):

- HTML szabvány, custom protocol handlers: https://html.spec.whatwg.org/multipage/system-state.html#custom-handlers
- WebTorrent API: https://webtorrent.io/docs
- WebTorrent browser korlátok: https://webtorrent.io/faq
- WebTorrent tracker és szerver API: https://github.com/webtorrent/bittorrent-tracker
- Coturn Docker dokumentáció: https://github.com/coturn/coturn/blob/master/docker/coturn/README.md
- Coturn konfiguráció és TURN REST auth: https://github.com/coturn/coturn/wiki/turnserver
- WebRTC peer connections és ICE: https://webrtc.org/getting-started/peer-connections
- Service Worker specifikáció: https://www.w3.org/TR/service-workers/
