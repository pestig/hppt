# HPPT v0.1 — implementation specification

## Viewer architecture

The WebTorrent/WebRTC engine runs in the open HPPT app window. Each package opens on a separate origin in a separate browser tab: in development, `http://<infoHash>.hppt.localhost:5173/<path>`, with the controller at `http://app.hppt.localhost:5173`.

A single Vite preview process serves both frontend builds on the same port, routing by hostname. The controller and viewer retain separate Service Workers and precache lists. Their configured origins must have different hostnames with the same scheme and port. On viewer hosts, the generated precache list allowlists bootstrap files; there is no controller SPA fallback.

The site’s Service Worker reads original HTML/CSS/JS/image files from cache or from the app through a dedicated MessagePort, returning a `Response` after full integrity verification. The browser handles the site natively. The controller’s hidden helper iframe for each site maintains the worker connection; content is not embedded in an iframe. Separate origins must belong to the same schemeful site so the helper and top-level page share a storage partition.

Content can use its own storage, so the offline manifest must be authenticated through a torrent proof bound to the infoHash: verify the SHA-1 hash of the original `info` bytes, verify the SHA-1 hashes of pieces containing the manifest, then verify files against the manifest’s SHA-256 hashes. A new worker authenticates this proof again. `/__hppt/` is reserved for the trusted bootstrap/SW; the server must not serve package content on other paths.

## Document purpose and status

This document records the HPPT MVP requirements. The README contains actual startup commands; the implementation report records completed checks.

**Task:** build a working browser-based P2P static-site publisher and browser in TypeScript. A user selects a directory containing HTML/CSS/JS/image files, publishes it, and shares an HPPT link. Another browser downloads the content over WebRTC using WebTorrent, displays it, and can seed it onward.

Publishing, downloading, verifying, and displaying content happen in the browser. Infrastructure is required to serve the startup app and connect peers. With TURN relay, encrypted WebRTC content traffic also passes through a server. Do not describe this as a completely serverless system.

## Mandatory technical constraints

- An ordinary website cannot install an arbitrary `hppt://` scheme as a native browser protocol. The browser MVP uses **`web+hppt://`**, alongside a copyable HTTPS launch link. Check support with feature detection. Scheme registration must be a separate action initiated by the user.
- The handler navigates to an HTTPS app. A native `hppt://` address does not remain in the address bar, and `fetch('hppt://…')` does not become supported.
- A Service Worker can respond to HTTP requests under its own origin/scope. It does not open a TCP/HTTP listening port or replace a general HTTP server.
- Do not rely on a Service Worker or closed browser for continuous seeding. Run the P2P engine in a live app window. The browser may suspend background tabs.
- Do not attempt to put WebRTC connections directly in the Service Worker. The worker must request files from the app page through messages.
- Browser WebTorrent peers require WebRTC-capable peers; traditional BitTorrent TCP/UDP peers are insufficient. The browser does not run a traditional UDP DHT.
- HTML/JavaScript received over P2P is untrusted. Multiple publishers must not run with the controller app origin’s privileges.
- The MVP targets static sites. PHP/Node backends, server-side rendering, databases, arbitrary HTTP POST, and full compatibility with every SPA are outside its scope.

## Required stack and repository

Use an npm workspaces monorepo, strict TypeScript, ESM, Vite, a simple browser UI, Vitest, and Playwright. Angular is unnecessary for the MVP. Start with Node 24 LTS and verify dependency compatibility during implementation. Choose verified versions, commit the lockfile, and pin Docker images to versions or digests. Do not leave `latest` in the delivered configuration.

```text
apps/
  web/                  # controller UI + WebTorrent engine, app.hppt.localhost:5173
  viewer/               # per-site viewer host, <hash>.hppt.localhost:5173
  tracker/              # bittorrent-tracker WebSocket server, :8000
  ice-api/              # ICE configuration / short-lived TURN credentials, :3001
packages/
  protocol/             # URL parser, paths, manifest, validation
  p2p/                  # WebTorrent adapter, seed/download, diagnostics
  viewer-bridge/        # MessageChannel/Service Worker bridge
infra/
  coturn/turnserver.dev.conf
  coturn/turnserver.production.conf.example
  Dockerfile.tracker
  Dockerfile.ice-api
fixtures/
  hello-site/           # index.html, CSS, image, subpage
  hostile-site/         # isolation tests, external requests, traversal attempts
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

This structure is the target state: the implementing agent must create every required entry point, Dockerfile, and script. Do not document unfinished features as working.

## Architecture

| Component | Responsibility | Can store/handle website payloads? |
|---|---|---|
| Web UI | Directory import, links, seed/download, status | Yes, in the browser |
| Viewer host | Viewer bootstrap and Service Worker files | Server serves bootstrap files only |
| WebSocket tracker | WebTorrent peer discovery and offer/answer signaling | Not a website-file server |
| ICE API | STUN/TURN list, temporary credentials | No |
| coturn | STUN and TURN relay when needed | Forwards encrypted traffic |
| Service Worker | Serving virtual file URLs, caching | Yes, in the browser |

A WebTorrent tracker removes the need for a separate custom SDP signaling protocol. Keep tracker URLs distinct from TURN addresses: `ws(s)://…` is the tracker; `stun:…`, `turn:…`, and optionally `turns:…` are ICE services.

### Opening content

1. The handler validates the HPPT address and hash.
2. The UI checks the locally stored package first. Displaying fully cached content must not wait for the tracker, ICE API, or authentication. For P2P downloads, it loads ICE configuration and starts a WebTorrent client with the configured tracker.
3. Read the manifest and required files from persistent storage, or over P2P after retrieving torrent metadata if unavailable locally. An empty URI path resolves through the manifest’s `entrypoint`; an explicit path requests only that file.
4. The viewer host’s trusted bootstrap registers its own Service Worker. Wait for actual worker control, not just registration.
5. The controller UI transfers a dedicated MessagePort to the viewer bootstrap, which connects it to the worker.
6. The worker on the site’s origin fulfills `/<path>` requests from cache or through this bridge.
7. The UI opens a separate browser tab at the actual file path on the package’s own origin. The browser displays original HTML/CSS/JS bytes and handles relative links, query, and fragment.
8. The downloaded torrent can seed onward while the client remains alive.

The protocol handler and copyable `/open?uri=…` link load a lightweight launcher that navigates its own tab to the package’s actual viewer address. For a complete local package, it verifies the package and persistent viewer storage without WebRTC or a separate controller tab. For downloads, a BroadcastChannel on the app origin selects an already open controller tab to prepare the viewer and maintain the P2P bridge. If no controller exists, start a separate app tab; when popup blocking prevents this, provide a user-clickable start button. With multiple controllers, request IDs and the selected controller ID must ensure that exactly one controller handles a request. Query, fragment, entrypoint resolution, and explicit 404 rules apply to this route too.

Opening a package’s own HTTP(S) URL directly in a fresh profile must also trigger this preparation. Without an installed Service Worker, the viewer host must return a non-cacheable 302 redirect to the app’s `/open?uri=…&source=viewer` entry point only for requests with `GET`, `Sec-Fetch-Mode: navigate`, and `Sec-Fetch-Dest: document`. Derive the hash from the validated hostname and the path/query from the original request; never accept an arbitrary return URL. The browser’s redirect inheritance preserves the fragment, which HTTP does not send; when `source=viewer` is present, the launcher adds it to the inner URI. The server still returns no package file; fetch, iframe, and resource requests retain a payload-free 503 response.

The worker must never automatically fall back to HTTP for package-file paths. Missing peers require a meaningful error and retry option, rather than an SPA `index.html` response with status 200.

## Protocol v0.1

### Addressing

```text
web+hppt://<40-character-lowercase-hex-btih>
web+hppt://<40-character-lowercase-hex-btih>/index.html
https://app.example/open?uri=<URL-encoded-web+hppt-URI>
```

Version 0.1 uses a torrent v1 `infoHash`, rather than an arbitrarily generated SHA-256 site hash. Verify the torrent format used by the chosen WebTorrent version. Files have separate SHA-256 verification. A v1 torrent hash is not a publisher signature; do not claim otherwise.

- Client configuration supplies the tracker address; v0.1 links must not accept arbitrary tracker/ICE URLs.
- `web+hppt://<hash>` and `web+hppt://<hash>/` open the manifest’s `entrypoint` file. `index.html` is optional.
- An explicit path such as `/about.html` means exactly that file. If missing, return 404 without an entrypoint fallback.
- After resolution, navigate the separate viewer window to the actual file path within the package. The browser resolves resources for `pages/home.html` relative to this real URL. Preserve query and fragment.
- A new version changes the hash. Version 0.1 has no mutable name resolution, DNS, or automatic updates.
- Preserve URL query and fragment for display, but exclude them from the file key. Downloads use the pathname.
- Normalize and validate every path. Reject `..`, NUL, backslashes, encoded separators, and bypasses caused by multiple decoding. Define explicit rules for case sensitivity, Unicode, and duplicate paths.
- Map the torrent root directory to relative website paths in a single adapter. Do not scatter prefix removal throughout the code.

### Manifest

The torrent must contain `htppt-manifest.json`, for example:

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

The example hash and size are placeholders. Generate actual values when publishing. The manifest contains neither its own hash nor the torrent infoHash, avoiding a circular dependency. Require manifest schema validation, allowed MIME types, file-count and size limits, and matching manifest/torrent sizes and paths. Configurable default MVP limits: 1,000 files, 50 MiB total, and 10 MiB per file.

`entrypoint` is a required, normalized relative file path within the package. The referenced file must exist in both the manifest file list and torrent, and must have an HTML MIME type (`text/html`, with an optional charset parameter). Missing or invalid entrypoints invalidate the package. When publishing, suggest `index.html` if present; otherwise require entry-file selection. Store the selected HTML file in `entrypoint`.

Display and cache a file only after full SHA-256 verification. Version 0.1 must therefore not promise streaming display of large files. Keep WebTorrent’s own piece verification enabled. Never use `skipVerify` with unverified data.

### Browser protocol registration

```ts
// Inside a user-clicked button handler, in a supported environment.
navigator.registerProtocolHandler(
  'web+hppt',
  `${location.origin}/open?uri=%s`
);
```

Verify actual registration over HTTPS. Do not base portability promises on localhost development exceptions. Always support working URI pasting and HTTPS links. Native `hppt://` integration is a separate future project.

## Viewer and security model

The controller and every package use separate origins. A separate window alone does not provide isolation. A package can request only files bound to its own hash, which is part of the viewer hostname. Content shares storage with its site’s worker, so the worker must verify every cached response against an authenticated manifest.

The worker returns original files without HTML/CSS rewriting. Content-independent HTTP headers:

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

Require `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, and `Origin-Agent-Cluster: ?1`. Content can use its own local storage but must not access storage belonging to the app or other packages. Block external resource requests, worker registration, and embedded frames. External top-level navigation remains possible, so this is not an exfiltration-prevention or anonymity system.

Run the trusted helper under `/__hppt/`; accept worker-init only from that location with valid nonce/session/hash values. The UI must also validate message origin, source, and protocol version before serving files through a dedicated MessageChannel restricted to that hash. An incorrect source/origin/nonce/session/hash must not replace the bridge.

The viewer HTTP host may serve only bootstrap and worker startup files. Package-file requests receive server-side 503/404 responses. The worker script requires `Service-Worker-Allowed: /`. The `/__hppt` namespace is forbidden in package filenames. Production wildcard hosts require DNS/TLS and the same schemeful site.

## P2P adapter and Service Worker bridge

Public adapter operations: `publish(files, { entrypoint })`, `open(infoHash)`, `readFile(infoHash, path)`, `pin(infoHash)`, `unpin(infoHash)`, `stop(infoHash)`, `getStats()`.

Use the documented API of the chosen WebTorrent/tracker version to pass `iceServers` and `iceTransportPolicy` to every actual `RTCPeerConnection`, for both publishers and downloaders. A UI toggle alone is insufficient: relay tests must prove that configuration reached the connections. The implementing agent must verify the exact configuration path rather than inventing a version-independent constructor.

Bridge messages must be versioned and schema-validated, with request and session IDs. Require a maximum pending-request count, timeouts, abort, and cleanup. Return 503 without a client, 404 for an unknown file, 400 for an invalid path, and a controlled error for integrity failures. Never cache a missing-client response as a successful file. Version 0.1 supports GET and HEAD only; other methods return 405. For Range requests, either implement correct 206/416 responses or document complete 200 responses; never return an invalid 206.

Cache key: protocol version + infoHash + normalized path. Store verified bytes only. Support cache clearing, quota/eviction error handling, and offline cache reads. Cached files alone do not mean a torrent resumes seeding: pin/reseed must restore the piece store and metadata and verify the data.

### Offline startup — mandatory MVP feature

After the browser closes, the previously loaded app must start from its own HTTPS/localhost address without internet access and open the fully cached site.

- The controller UI’s own Service Worker must cache the HTML, JS, and CSS required for startup, plus public configuration needed offline. Supported entry routes, including `/open?uri=…`, must start the app without networking.
- The separate-origin viewer’s own Service Worker must also cache the trusted bootstrap and its startup dependencies. Serving the bootstrap offline must not introduce HTTP fallback for package-file paths. A fully saved site must start at its own address without a controller window.
- Only a completely downloaded, verified, and persistently stored package receives “Available offline” status. Store the manifest and data needed for local opening too; a partial download or failed write is insufficient. On restart, check local data and remove the status if anything is missing.
- Displaying local content during offline startup must not wait for the tracker, ICE API, or authentication. Establish the session and bridge locally, preserving origin/hash isolation and content verification.
- The first visit requires internet access. Offline operation relies on browser-retained data and is not guaranteed after storage deletion or eviction. Installing a PWA is optional.

## Local runtime contract

Prerequisites: Node 24 LTS, npm, Docker Engine or Docker Desktop with the Compose v2 plugin, and current Chromium. Documented basic commands after implementation:

```bash
npm ci
npm run setup:dev
npm run infra:up
npm run dev
```

`setup:dev` must be idempotent and never overwrite existing secrets. Create `.env` and a local-only coturn configuration with random credentials; gitignore both. The default TURN host for single-machine tests is `127.0.0.1`; make it configurable, for example:

```bash
npm run setup:dev -- --turn-host 192.168.1.50
```

`dev` must serve the web UI and viewer host together, handle shutdown, and display:

```text
Web UI:      http://app.hppt.localhost:5173
Viewer host: http://hppt.localhost:5173
Tracker:     ws://localhost:8000
ICE API:     http://localhost:3001
```

The `localhost` secure-context exception supports local Service Worker development. `http://192.168.x.x` does not have the same exception: LAN/mobile testing requires trusted HTTPS for the UI and viewer host, plus a WSS tracker. On mobile, `localhost` means the mobile device itself. Configure Vite host permissions explicitly.

Supply hostnames reachable by the browser; internal Compose service names such as `tracker`, `ice-api`, and `coturn` cannot be used by the host browser.

### Required environment variables

```dotenv
APP_ORIGIN=http://app.hppt.localhost:5173
VIEWER_ORIGIN=http://hppt.localhost:5173
TRACKER_URL=ws://localhost:8000
ICE_API_URL=http://localhost:3001/ice
TURN_HOST=127.0.0.1
TURN_PORT=3478
ICE_TRANSPORT_POLICY=all
```

Frontend runtime configuration may contain public values only. Static TURN credentials are a development exception; the production shared secret must never appear in `VITE_*` variables or bundles. Relay mode must be a runtime setting that requires no new frontend build.

## Docker Compose and coturn

The official `coturn/coturn` image is sufficient for development coturn. Implement the tracker and ICE API as small custom Node services; do not use an arbitrary abandoned tracker image. In the following example, `COTURN_IMAGE` must be a verified version/digest set by the setup script.

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

The agent must check that the image ENTRYPOINT and `command` agree. Inside containers, the ICE API and tracker must listen on `0.0.0.0`. TURN ports are not bound to loopback because the advertised relay address must be reachable; in development, restrict access to required machines with the host firewall. The example relay range suits a small test environment.

Example `turnserver.dev.conf` generated by setup, for **development only**:

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

`no-tcp-relay` disables peer-side TCP relay allocations; clients can still connect to the TURN listener over TCP. WebRTC requires the relay-side UDP port range.

**`127.0.0.1` is suitable only for browser tests on the same machine.** LAN tests require the host’s LAN IP; internet deployments require a public IP. Behind a Docker bridge, the advertised relay address and NAT mapping need particular attention. If necessary, use `external-ip=PUBLIC_IP/PRIVATE_RELAY_IP`, where PRIVATE_RELAY_IP is the actual relay-interface address. Map relay ports to the same port numbers externally and internally.

TURN diagnostics are mandatory with Docker Desktop/WSL NAT. If the advertised candidate is unreachable, do not weaken the test: use a Linux host or public TURN VPS. Linux VPS deployments can use host networking; remove the `ports` block and configure the host firewall in that case. Do not assume identical host-networking behavior across operating systems.

The ICE API may read static development credentials from gitignored environment variables and return them only in development mode. Never use a `no-auth` server.

### Production TURN

- Use a public Linux VPS and DNS, such as `turn.example.com`.
- Expose UDP/TCP 3478 and optionally TLS/TCP 5349 with a valid certificate. Open the relay UDP range in both cloud and host firewalls too.
- Router/cloud NAT must forward the same relay ports. An HTTPS reverse proxy alone does not forward TURN UDP.
- For TLS TURN, configure certificate/key and listener settings rather than merely adding a `turns:` URL to the ICE list.
- Use `use-auth-secret`, a strong `static-auth-secret`, and a stable realm; remove the development `user=` entry in production.
- The credential API must issue short-lived TURN REST credentials. Only that API and coturn know the secret.
- Credential endpoint: authentication/access policy, rate limiting, restricted CORS, and issuance quotas. Short-lived credentials sent to the browser can be shared onward; this is not secret storage.
- Full user management is unnecessary for the MVP. Production configuration may assume external authentication; document its integration and trusted delivery of the authenticated user ID to the ICE API. Access protection for the credential endpoint remains mandatory.
- Test allocation/refresh behavior as credentials expire. Obtain fresh credentials before new connections; do not interrupt working connections on every token refresh.
- Deny unnecessary internal/loopback peer destination ranges according to the deployment topology; public TURN must not provide access to internal networks.
- Monitor traffic and set quotas: relay bandwidth costs fall on the server.

Outline of REST credential generation in Node.js:

```ts
import { createHmac } from 'node:crypto';

const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const username = `${expiresAt}:${authenticatedUserId}`;
const credential = createHmac('sha1', sharedSecret)
  .update(username)
  .digest('base64');
```

TURN REST HMAC-SHA1 here is part of coturn authentication, rather than the integrity hash of website files.

ICE API response format:

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

Return URLs only for actually configured listeners. Allow the controller UI origin in CORS, rather than `*` for a credentialed API. Use `Cache-Control: no-store`. Do not log TTLs or credentials.

## Manual testing

1. Start services with the four commands above.
2. Open the UI in two isolated browser profiles (A and B). Two tabs sharing a profile are insufficient for cache-isolation testing.
3. Publish `fixtures/hello-site` in A.
4. Copy the resulting HPPT address into B’s address field.
5. Check HTML, CSS, images, classic JavaScript, and the relative subpage. Both B’s download and A’s upload must be visible.
6. Servers must not serve fixture files over HTTP. Check network logs and transferred WebRTC bytes.
7. Download and pin the complete package in B. Wait for genuinely verified completion.
8. Close A and open a fresh profile C. C must download the content from B.
9. Set `iceTransportPolicy` to `relay` on both active peers, create new connections, and repeat the download.
10. Wait for “Available offline” in B. Close every app tab and the browser, stop local servers, disconnect from the internet, and reopen the app’s HTTPS/localhost address using the same retained browser profile. The UI, viewer bootstrap, and fully cached site must load without the tracker, ICE API, or authentication. This is a separate case from a new P2P download.

Relay tests must prove a relay candidate in the selected ICE candidate pair and genuinely increasing datachannel traffic. A gathered but unselected relay candidate is insufficient. Diagnostics: app stats, Chromium `chrome://webrtc-internals`, Firefox `about:webrtc`, and coturn logs.

## Automated tests and CLI contract

The agent must implement:

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

`test:e2e` must start or check required services and use separate browser contexts/profiles. P2P tests must not mock the transport. Clearly state relay test network prerequisites; missing TURN in CI must not yield a false relay pass. Create a separate Linux CI relay job with reachable TURN. `doctor` must check HTTP/WS reachability and configuration while explaining that only browser allocation plus data transfer verifies the complete WebRTC relay path.

Required test cases:

| Test | Acceptance criterion |
|---|---|
| Publish and open | A → B: full HTML/CSS/images/JS work without HTTP payload fallback |
| Entry-page resolution | A bare hash and a trailing `/` navigate to the manifest entrypoint; relative resources work for an entry such as `pages/home.html` without `index.html`, preserving query and fragment |
| Explicit path | Opens the requested file; missing files return 404 without entrypoint fallback |
| Entrypoint validation and selection | Reject missing, invalid-path, nonexistent, or non-HTML entrypoints; UI suggests `index.html` if present, otherwise requires entry-file selection |
| Redistribution | After A stops, a fresh C receives the full package from B |
| Forced TURN | Both peers use relay mode; selected pair and actual transfer are verified |
| Invalid TURN credentials | A fresh relay-only connection fails without direct fallback |
| TURN shutdown | New relay-only connections fail; interruption of an existing connection is handled |
| Tracker shutdown | Fresh discovery reports an error; existing connections need not close |
| No seeder | Finite timeout and retry option |
| Offline restart | After all app tabs and the browser close and local servers stop, reopening the HTTPS/localhost address without internet using a retained profile loads the UI, viewer bootstrap, and fully cached site without waiting for the tracker, ICE API, or authentication |
| Offline status | Only complete, verified, persistently stored packages receive “Available offline”; partial, corrupt, or missing local data never does |
| Pin and reload | Seeding genuinely restarts from persistent data |
| Integrity failure | Corrupt files never render or enter the successful cache |
| Path protection | Traversal and double encoding cannot expose other files |
| Site isolation | Content cannot access UI storage, register its own worker, or access the detached controller window |
| Bridge isolation | Reject incorrect source/origin/nonce/session/hash |
| External resources | CSP blocks unauthorized fetch/script/image requests |
| SW lifecycle | Handle first installation, controller changes, reload, and cache-version changes |
| Quota and abort | Cache quota errors, cancellation, and a closed engine do not hang the UI |

Invalid-data/credential negative tests must use fixtures rather than disabling production verification. Every test requires a deterministic timeout and cleanup.

## Diagnostics and troubleshooting

| Symptom | Check |
|---|---|
| No peers | Is A open; do infoHash/tracker match; does WS/WSS work? |
| Signaling works, no data | ICE configuration, NAT, TURN credentials, relay ports |
| Relay candidate exists but fails | Actual reachability of advertised IP/port, NAT mapping |
| Works on localhost, fails on phone | HTTPS trust, WSS, LAN hostnames, firewall, incorrect localhost use |
| WS blocked under HTTPS | Switch tracker to WSS and configure reverse-proxy upgrade |
| Empty viewer | Worker control, bridge handshake, CSP, file-path mapping |
| HTML returned instead of CSS/image | Incorrect SPA fallback on package-file paths |
| JavaScript module fails | Module path, MIME, worker control, CSP; original ES modules must work |
| Cache exists but no seeding | WebTorrent metadata/piece store was not restored |
| Fresh profile has no content after seeder closes | No live seeder; a Service Worker is not a permanent seed daemon |
| Previous profile fails to start offline | UI/viewer bootstrap caches, SW scope/control, retained storage, complete verified package |

The UI must show peer count, verified bytes, upload/download, cache hits/misses, discovery/ICE errors, and relay/direct connections where the API can reliably determine them. Never expose secret credentials in diagnostics.

## Implementation order for the agent

1. Create the workspace skeleton, script contract, lockfile, and fixtures.
2. Start a local tracker and coturn; build a minimal browser → browser seed/download test.
3. Prove real relay-only transfer before building the viewer. Verify the exact WebTorrent ICE configuration API.
4. Implement HPPT URLs, packaging, manifest, paths, and integrity checks.
5. Implement the separate-origin viewer bootstrap, dedicated bridge, and Service Worker.
6. Add origin isolation, CSP protection, and hostile-fixture tests.
7. Implement cache/pin/reseed, offline bootstraps for both origins, a three-profile redistribution test, and an offline restart test with a retained profile and stopped servers.
8. Add protocol registration, HTTPS-link fallback, and diagnostic UI.
9. Run the full test matrix, then update the README with commands and versions that actually work.

The agent must go beyond a mock UI, delivering real P2P transfer and a reproducible local environment. If a library API differs, create a small compatibility probe, fix the adapter, and document the decision. Mark work complete only on the basis of executed checks; unrun external-network tests must remain a separate, clearly stated limitation.

## Definition of Done

- The project starts from a clean checkout using documented commands.
- Static sites transfer over real WebRTC between two isolated browser profiles.
- A third profile can download from B without the original publisher.
- The coturn relay-only route and invalid-credential negative case are proven.
- The Service Worker returns P2P data with correct MIME types.
- An empty URI path opens the manifest’s required, validated HTML entrypoint; explicit missing paths return 404. Navigation to the actual document path preserves query, fragment, and correct relative-resource resolution.
- Fully verified and persistently stored packages are “Available offline”. After the browser closes and local servers stop, a retained profile can restart the UI/viewer and display the local site without internet or waiting for network services or authentication.
- Untrusted content never receives the controller UI origin’s privileges.
- The README distinguishes localhost, LAN, and public deployment settings.
- No hardcoded secrets, open TURN relay, or hidden HTTP webseed fallback.
- The handoff lists tests actually executed, versions, and known compatibility limitations.

## Future extensions

Publisher keys and signed mutable name resolution; multiple independent trackers; continuous WebRTC-capable seeders; streaming/range serving for large files; stronger per-site origin isolation; broader SPA/module compatibility; browser extension/native helper for the exact `hppt://` scheme. These require separate specifications.

## Primary technical references

The implementing agent must recheck APIs for the chosen versions. Starting references checked for this document (2026-10-19):

- HTML standard, custom protocol handlers: https://html.spec.whatwg.org/multipage/system-state.html#custom-handlers
- WebTorrent API: https://webtorrent.io/docs
- WebTorrent browser limitations: https://webtorrent.io/faq
- WebTorrent tracker and server API: https://github.com/webtorrent/bittorrent-tracker
- Coturn Docker documentation: https://github.com/coturn/coturn/blob/master/docker/coturn/README.md
- Coturn configuration and TURN REST authentication: https://github.com/coturn/coturn/wiki/turnserver
- WebRTC peer connections and ICE: https://webrtc.org/getting-started/peer-connections
- Service Worker specification: https://www.w3.org/TR/service-workers/
