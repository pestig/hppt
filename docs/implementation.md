# Implementation report

The HPPT viewer now uses a separate origin and browser window for each site, with original files served by the site’s own Service Worker. Final regression results are recorded below. Date: 2026-10-19. No public production deployment or remote CI run was performed.

Frontend serving now uses a single Vite preview process on port 5173. Two focused builds remain; hostname routing selects either the controller or a viewer handler that serves only allowlisted bootstrap files. Configuration normalizes the old local viewer port to the app port. The UI origin and IndexedDB are retained; refreshing the library prepares offline caches on the new viewer origins.

## Verified behavior

Real WebRTC transfer works between two isolated Chromium profiles. After the original publisher closes, a fresh third profile downloads from B. Pinned packages genuinely resume seeding after reload, with a rebuilt piece store and infoHash verification. HTTP hosts do not serve fixture payloads.

Each package runs on its own `<infoHash>.hppt.localhost:5173` origin in a separate browser tab. Its worker returns unchanged file bytes, and the browser loads relative resources natively. WebRTC stays in the open HPPT app; a hidden helper for each site and a dedicated MessagePort connect it to the worker. There is no display iframe, HTML/CSS rewriting, or data URL packaging. Content can use storage on its own origin. CSP blocks external resources, workers, frames, and forms; COOP detaches the opener connection, and Origin-Agent-Cluster prevents origins from being merged through document.domain.

The protocol handler’s `/open?uri=…` entry page navigates itself to the viewer address. The launcher is loaded as a separate module. For local packages it creates no P2P engine, preparing the complete persistent viewer cache with SHA-256 and torrent-proof verification. Downloads request preparation from an already open controller through a BroadcastChannel on the app origin, or start a separate app tab. If popup blocking prevents this, a clickable start button appears. Responses are bound to a request ID and selected controller; the launcher checks the hash, explicit path, query, and fragment, generating only the configured viewer origin. The controller UI’s regular opening button still opens a separate viewer tab.

Opening a direct viewer link for the first time in a fresh profile starts the same launcher through a navigation-only 302 redirect, then returns to the original viewer address. Previously this route returned 503 even when the app was already open. Three new browser tests using real P2P check discovery of the app in an isolated profile, preservation of the original query/fragment, entrypoint resolution for a root path, and rejection of an explicit missing file. In the network log, the first response is 302; the HTML’s 200 response then comes from the Service Worker. Ordinary HTTP file requests still return 503.

Supported features include entry files other than `index.html`, relative CSS/images/scripts, CSS imports and background images, relative subpages, ES modules and imports, body/html attributes, real window.location, and same-origin fetch. Query and fragment remain in the viewer’s actual URL. Explicit missing paths return 404. Loading many resources uses at most six concurrent reads, below the bridge’s limit of 32 pending requests.

Both the UI and viewer Service Workers cache the files needed for startup. The offline test goes beyond disabling the network: it closes the entire persistent Chromium profile, stops all three application servers, reopens the same retained profile, disables networking, and reopens the app address. It first opens the package’s own address directly, without a controller window: HTML/CSS/images/JS/subpages work. It then checks the launch link’s same-tab redirect and, finally, offline opening from the UI. Local content does not wait for the tracker, ICE API, or authentication. Preparing the viewer shell is a prerequisite for the “Available offline” status.

Clearing the cache removes the controller’s persistent copy and the files/proof on that package’s origin, while retaining the bootstrap cache. Corrupt files do not render. The manifest is authenticated by a proof bound to the original torrent infoHash and the torrent pieces containing the manifest. Forged files from the site’s own Cache Storage are rejected, as are forged manifest proofs after a worker restart. UI or viewer quota errors never produce an offline status; persistent viewer files are verified again when the library refreshes. Disconnecting the app bridge aborts pending reads. After a worker restart, a missing file can once again be requested from the open app.

## Tests and results

| Command | Result |
|---|---|
| `npm ci` | Passed, using the lockfile |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed, strict TypeScript |
| `npm run test:unit` | 32 passed: protocol, torrent proof, origins, bridge, and real ICE API tests |
| `npm run build` | Both apps build successfully |
| `npm run test:e2e` | 36 passed; 4 relay cases belong to a separate job; 0 failures in the final run; exit code 0 |
| `npm run test:relay` | 4 passed during the earlier viewer refactor, using a dedicated coturn and real WebRTC; not repeated for the protocol-handler or single-port frontend changes |
| Docker tracker / ICE API | Existing tracker works; ICE API rebuilt and started successfully with the new origin-normalization module |
| `setup:dev`, `infra:up`, `infra:logs`, `infra:down` | Passed; repeated setup preserved existing configuration and credentials |
| `npm run doctor` | Passed: Node 24, both HTTP origins, shared frontend port, origin isolation, ICE API, and tracker WebSocket |

The full normal end-to-end suite runs 36 cases, including hostname routing on the shared port and eight protocol-handler/direct-viewer entry tests: a local package without a controller or network client; reuse of a live controller for a real P2P download; manual launch after popup blocking; automatic controller launch; invalid addresses and explicit missing files; and direct viewer links in fresh profiles, root paths, and direct missing files. Publishing `fixtures/sample-site` and opening its direct link from a separate profile also passed on the actual frontend port 5173. HTML/CSS/JS worked, the original URL was preserved, and the app and viewer remained in separate tabs. There were no requests to port 5174, and no listener remained there. The four relay cases belong to a separate job. Skipping relay in the normal suite does not validate it. Relay tests start their own server and fail without actual transfer; a missing environment cannot produce a false pass.

During the first full run of the single-port change, the P2P retry after a missing seeder timed out once. The same case passed in two separate repetitions and in the final full run. Neither transport code nor timeout expectations were changed.

Relay test requirements:

- Both peers use `iceTransportPolicy: relay`, with a selected relay/relay candidate pair and actual datachannel bytes.
- An invalid TURN credential causes a fresh connection to fail without direct fallback.
- Stopping TURN handles the live connection’s interruption; new relay-only connections fail, while locally saved packages remain available.
- After a short-lived, real TURN REST credential expires, a new peer cannot allocate. Fresh credentials restore connectivity; client credential refresh does not intentionally close an already working peer connection.

Credential tests use real coturn REST authentication. Short TTLs and invalid credentials are test fixtures only; production verification stays enabled. Browser tests model the authentication gateway through a network fixture, while real API requests verify production ICE API authentication and HMAC generation. These tests do not validate multi-hour TURN allocations, live TLS, or global internet NAT topologies.

Browser tests use their own ports: frontend 5273 (UI and viewer), tracker 8100, and ICE API 3101. The relay TURN listener uses 3488, with relay UDP ports 49500–49620. Every test has a finite timeout, and test processes and temporary credential files are cleaned up. Playwright tracing is disabled because network response bodies would also record TURN credentials.

## Environment and reproduction

Development used Node 24.19.0, npm 11.17.0, and Docker Desktop 29.8.2 / Compose 5.6.0. Docker Desktop port mapping produced relay candidates but no working UDP data path; the Desktop VM’s host network also differs from the browser’s Linux network. Successful TURN tests used a binary extracted from the official coturn 4.7.0 image, running as a dedicated native Linux process. This does not demonstrate a working Docker Desktop TURN data path.

With a native Linux Engine, `infra:up` automatically selects the `compose.linux.yaml` override; explicit `COMPOSE_FILE` can override this. Coturn receives its own read-only development configuration with mode 0600, runs as the local UID/GID, and refuses to continue with defaults if the configuration is unreadable. The localhost development configuration’s loopback-peer exception must not be copied into production.

Missing Chromium system libraries were copied into `/tmp` from the official Playwright image, using a container without networking or a project mount. For a normal installation, use `npx playwright install --with-deps chromium`. In this session:

```sh
LD_LIBRARY_PATH=/tmp/htppt-browser-runtime npm run test:e2e
LD_LIBRARY_PATH=/tmp/htppt-browser-runtime \
  TURNSERVER_BIN=/tmp/htppt-turnserver \
  TURNSERVER_LIBRARY_PATH=/tmp/htppt-coturn-runtime \
  npm run test:relay
```

The `/tmp` files are not project dependencies. With native coturn installed, `TURNSERVER_BIN=/usr/bin/turnserver npm run test:relay` is sufficient. On Linux Docker Engine, the relay suite uses its own pinned coturn container, mounting only its temporary configuration. The CI workflow runs normal tests and the real relay suite in separate jobs.

## Versions and API decisions

| Component | Version |
|---|---|
| Node / npm | 24.19.0 / 11.17.0 |
| TypeScript | 5.9.3 |
| Vite / Vitest | 8.3.4 / 5.0.5 |
| Playwright / Chromium | 1.64.1 / 156.0.8078.4 |
| WebTorrent | 3.0.21, official browser ESM build |
| bittorrent-tracker | 11.2.3 |
| coturn | 4.7.0 |

According to the [WebTorrent documentation](https://webtorrent.io/docs) and installed source, ICE configuration follows this path: `new WebTorrent({ tracker: { rtcConfig: { iceServers, iceTransportPolicy } } })` → discovery → tracker → simple-peer → `RTCPeerConnection`. The tracker callback requests at most two speculative offers, limiting empty TURN allocations within the small development port range.

Diagnostics access peer connections through the pinned WebTorrent version’s `_peers` Map and simple-peer’s `_pc` field; selected-pair and datachannel counters come from standard `getStats()`. The network download metric uses `received`, rather than `downloaded`, which measures local piece completion. These integrations require retesting when versions change.

Before reseeding, every persistent file is verified with SHA-256, the piece store is rebuilt, and the new infoHash must match the original. Downloaded-piece verification remains enabled. WebTorrent’s own `seed()` optimization applies only to already verified local input.

The previous HTML/CSS renderer and direct PostCSS/value-parser dependencies were removed. The worker returns original file bytes, verified by direct byte comparison between P2P source and HTTP response. The manifest’s trust anchor is the v1 torrent infoHash in the hostname: the original bencoded `info` bytes’ SHA-1 hash and pieces covering the manifest are checked, after which files can be authenticated with SHA-256.

The separate-window model requires distinct origins within the same schemeful site. Playwright 1.64.1 disables ThirdPartyStoragePartitioning by default; the test configuration enables it again, and a dedicated cross-site cache probe demonstrates partitioning. With normal Chrome settings, helper/top-level workers and caches on `app.hppt.localhost` and `<hash>.hppt.localhost` share a partition. The old plain `localhost` and `<hash>.localhost` arrangement does not support this.

`scripts/origins.ts` consistently normalizes legacy localhost defaults for the UI, Vite host, development script, and ICE API. The ICE Docker image includes this module. IndexedDB on the old UI origin is retained, but the new origin cannot access it automatically; the sample folder can be published again.

## Known limitations

Static HTML/CSS/images/classic JavaScript, ES modules, real relative paths, and same-origin GET/fetch are supported. Backends, POST, workers, embedded frames, and forms are unsupported; explicit missing paths return 404 without a general SPA fallback. The viewer is a normal top-level page and can navigate to external links and other addresses: CSP is not a complete exfiltration or anonymity boundary. New P2P downloads and seeding require an open HPPT app. After a complete offline save, the site’s viewer URL works without the controller window. When new tabs are blocked, the app provides a clickable opening link.

Public HTTPS/WSS and TLS TURN deployment, HTTPS protocol registration, LAN/mobile/Firefox/Safari compatibility, and multi-hour credential/allocation runs were not tested. Cookie-free viewer wildcard domains within the same schemeful site, reverse proxies, certificates, and the authentication gateway are the deployer’s responsibility. The README and production coturn example describe the required settings.

`npm audit` reports four high-severity findings through the transitive `ip` dependency. [GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp) describes incorrect `isPublic` classification; no patched upstream version is available. The tracker imports `ip` in the UDP parser, which is disabled here, and the project does not use `isPublic` for security decisions. The advisory remains and should be reassessed during updates.
