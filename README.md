# HPPT — HyperText Peer To Peer Transfer Protocol

A TypeScript browser MVP for publishing, opening, and sharing static websites. Website files travel over real WebTorrent/WebRTC connections. The tracker handles discovery and signaling; the ICE API provides TURN credentials. There is no HTTP payload or webseed fallback.

## Local development

Requires Node 24 LTS, npm, Docker Compose 2.24.4+, and a current Chromium browser.

```sh
npm ci
npm run setup:dev
npm run infra:up
npm run dev
```

| Service | Address |
|---|---|
| Controller UI | http://app.hppt.localhost:5173 |
| Separate-origin viewer | http://hppt.localhost:5173 |
| WebSocket tracker | ws://localhost:8000 |
| ICE API | http://localhost:3001/ice |

Open the controller UI at `APP_ORIGIN` (default: `http://app.hppt.localhost:5173`). The development entry addresses `localhost:5173` and `127.0.0.1:5173` redirect there. Different hostnames are separate origins: CORS, the viewer, and browser storage require exact origin matches. When opened at another address, the UI redirects to `APP_ORIGIN` on startup, preserving the path, query, and fragment. Offline saves belong to the configured origin. The new local origin cannot automatically access the old `localhost:5173` library; existing data is retained, and the sample folder can be published again. Configuration and the ICE API normalize legacy localhost defaults to the new hostnames.

When a new build is deployed, the Service Worker caches its startup files before reloading open controller pages once. Persistently saved packages are retained. If an old version is stuck, `http://app.hppt.localhost:5173/refresh` loads the latest app while bypassing the old startup-page cache. Clearing storage is unnecessary.

`setup:dev` is idempotent: it preserves existing credentials and creates `.env` and a local coturn configuration. Both are gitignored. `dev` creates two focused builds and serves them through a single Vite preview server on the same port, routing by hostname. The controller and viewer each have their own startup files, Service Worker, and precache list. Restart after changes. Use `npm run serve` to serve an existing build.

On a native Linux Docker Engine, `infra:up` selects host networking for coturn. Docker Desktop uses the default port mapping; its TURN UDP relay path must be verified separately. In this development environment, Docker Desktop produced a relay candidate, but successful data transfer required native coturn:

```sh
docker compose up -d --build tracker ice-api
npm run turn:native
npm run dev
```

`turn:native` requires an installed `turnserver` executable; set `TURNSERVER_BIN` if it is elsewhere. `npm run services` starts the Node tracker and ICE API without Docker. TURN remains a separate process. The full relay test requires actual data transfer, not just candidate gathering.

## Try it out

`fixtures/sample-site` is a ready-to-publish test website with local CSS, an SVG image, an interactive JavaScript button, and a relative subpage. Select the entire folder in the publisher. The suggested entry file is `index.html`; select `pages/about.html` to test an alternative entry file.

1. Open the controller UI in two isolated browser profiles.
2. In profile A, select `fixtures/hello-site` and publish it. The manifest and integrity hashes are generated locally.
3. Paste the resulting `web+hppt://…` address into profile B. The site opens in a separate tab on its own origin. Check the CSS, image, JavaScript button, and relative subpage. If the browser blocks the new tab, use the opening link displayed in the app.
4. In B, choose “Save offline + pin”. The “Available offline” status appears after the complete package has been downloaded, verified, and stored persistently.
5. Close A. A fresh profile C can download the package from B. Keep B open to seed it.
6. Close B’s browser, stop the servers, and disconnect from the internet. Reopen the previously loaded app and fully saved site using the same retained browser profile.

`index.html` is optional. For `fixtures/nested-site`, select `pages/home.html` as the entry file. An empty URI path resolves to the manifest’s `entrypoint`; an explicit missing path returns 404 without an entrypoint fallback. Relative links, CSS imports, and CSS images are supported. Query and fragment are preserved in the logical address and shareable link.

Protocol-handler registration has a separate button in supported browsers. Pasting an address and using a launch link always remain available. The portable browser scheme is `web+hppt://`; native `hppt://` support is outside the MVP.

The protocol handler and `/open?uri=…` launch link navigate the current tab to the site’s viewer address, such as `http://<hash>.hppt.localhost:5173/pages/home.html?mode=1#details`. For a complete local package, the launcher verifies and prepares persistent viewer storage before redirecting, without starting a WebTorrent/WebRTC client or another app tab. Downloads use an HPPT app already open in the same browser profile, or open a separate app tab if needed. If the browser blocks it, the launcher displays a “Start HPPT app” button. Keep the app tab open for downloads and seeding. The app’s address field and library still open a separate viewer tab.

A direct `http://<hash>.hppt.localhost:5173/<path>` viewer link also works in a fresh profile, including incognito. If the site has no Service Worker there yet, the viewer host redirects top-level navigation to the launcher. After preparation, the same tab returns to the viewer address, preserving query and fragment. Incognito uses its own HPPT app; the publisher in the regular profile remains a peer and must stay open for the download. Ordinary fetch and resource requests still receive no package files over HTTP. Other static hosts or reverse proxies must implement this navigation redirect rule too.

Configuration automatically normalizes the old local viewer port `5174` to the app port. `setup:dev` also updates `.env`, preserving secrets. New viewer addresses use `5173`. The controller origin and local package library remain unchanged: refreshing the library prepares saved packages on the new viewer origin. The old viewer origin’s cache does not migrate automatically.

## Offline operation and storage

The UI and each site use separate Service Workers on their own origins to cache startup files. Before marking a package available offline, the UI verifies its own persistent copy and every file and torrent proof stored on the site’s origin. A fully saved site can reopen offline at its own HTTP(S) address, even with the HPPT app closed. Opening it offline from the UI also works. Neither route waits for the tracker, ICE API, or authentication.

Pinned packages can resume seeding after an online restart: the piece store is rebuilt, SHA-256 integrity is verified, and the original infoHash is checked. Unpinning disables automatic reseeding; clearing a package removes its content cache from both origins. The bootstrap cache is retained.

The first visit requires network access. Offline operation is not guaranteed after storage deletion, browser eviction, or loss of a private profile. Installing a PWA is optional. A Service Worker or closed browser is not a continuous seeder.

## Viewer and compatibility

The WebTorrent/WebRTC engine stays in the HPPT app. Each package opens in a normal browser tab on a separate origin, for example:

```text
http://<infoHash>.hppt.localhost:5173/pages/home.html?mode=1#details
```

The site’s Service Worker returns the original file bytes. On a cache miss, it requests the file from the open HPPT app through a dedicated MessagePort. The browser natively handles HTML, CSS imports, images, ES modules, relative navigation, query, and fragment. There is no HTML/CSS rewriting, data URL packaging, or display iframe. The controller UI uses a hidden `__hppt` helper frame for each site solely to maintain the worker-to-app message connection and reconnect it after worker restarts.

The separate origins must belong to the same schemeful site. This ensures the worker and cache prepared in the helper iframe use the same storage partition as the separately opened page. In development, `app.hppt.localhost` and `<hash>.hppt.localhost` provide this. Storage partitioning remains enabled in Playwright tests, with a dedicated negative test checking it.

Content can access storage on its own origin, so the cache is not a trust boundary. The worker checks the SHA-1 hash of the original torrent `info` bytes against the infoHash in the hostname, then authenticates the torrent pieces containing the manifest. This establishes the manifest’s SHA-256 file hashes. Every cached file is verified again when served; after a worker restart, the stored manifest proof is also authenticated again. The `__hppt` path namespace is reserved and cannot appear in a package.

CSP allows the package’s own scripts, styles, images, modules, and same-origin GET/fetch requests; it blocks external resources, new workers, frames, and form submissions. `Cross-Origin-Opener-Policy: same-origin` detaches the viewer window from the controller. `Origin-Agent-Cluster: ?1` prevents origins from being merged through `document.domain`. The bridge validates origin, source, nonce, session, version, and hash, with a timeout for each request.

Backends and arbitrary POST requests are unsupported. An explicit missing file returns 404 without an SPA fallback. A normal browser window can navigate to external links and other addresses: this is not an exfiltration-prevention or anonymity system. Peers, trackers, and TURN servers can see network metadata. Test with public demo content only.

## Configuration, LAN, and production

`.env.example` lists public settings. The UI can change the ICE policy without a new build; a new client handles new connections. Default limits are configurable: 1,000 files, 50 MiB total, and 10 MiB per file. Files are displayed or cached only after full SHA-256 verification. Range requests receive a complete, verified 200 response; large-file streaming is unsupported.

```sh
npm run setup:dev -- --turn-host 192.168.1.50
```

For LAN/mobile tests, `http://192.168.x.x` is not a localhost secure context. Both origins need trusted HTTPS, the tracker needs WSS, and TURN requires a reachable IP and appropriate firewall/NAT configuration. A phone’s `localhost` refers to the phone itself. Vite listens on loopback; LAN/public access requires an HTTPS reverse proxy or a separate static host. Frontend hostnames must be reachable from the browser, rather than being internal Compose service names.

`APP_ORIGIN` and `VIEWER_ORIGIN` must use different hostnames with the same scheme and port. A production example is `APP_ORIGIN=https://app.example.com` and `VIEWER_ORIGIN=https://sites.example.com`, both on HTTPS port 443. Hosts such as `<hash>.sites.example.com` require wildcard DNS and a trusted wildcard TLS certificate. Viewer origins should be cookie-free, and app authentication should use host-only cookies. The helper and separately opened page need the same schemeful site to share their storage partition.

The single frontend server serves `apps/web/dist` on the controller hostname and `apps/viewer/dist` on viewer and `<hash>` hostnames. Viewer hosts may serve only trusted startup files listed in the generated precache list, under `/__hppt/`; map that prefix to the viewer build directory. The worker requires `Service-Worker-Allowed: /`. Direct top-level navigation starts with a 302 redirect to the launcher; other package-file requests receive server-side 503/404 responses without HTTP payload or SPA fallback. Configure CSP, nosniff, and origin headers according to the [Vite host configuration](scripts/vite-shared.ts). The UI’s `/runtime-config.json` and viewer’s `/__hppt/runtime-config.json` endpoints must contain public settings only.

There is no built-in user management. The production ICE API assumes an external authentication gateway, with server-side `TURN_SECRET` and `AUTH_PROXY_TOKEN` settings. The gateway strips incoming `X-Authenticated-User`/`X-HTPPT-Gateway-Token` headers, then sets the authenticated identity and its secret gateway token. Only the gateway should be able to reach the ICE API. The gateway token and TURN shared secret must never reach the frontend. The credential endpoint uses restricted CORS, no-store, rate limiting, and issuance quotas.

The [production coturn example](infra/coturn/turnserver.production.conf.example) shows REST authentication, TLS certificate/key paths, denied peer destination ranges, and quotas. The API must return `turns:` only when a TLS listener is actually configured. No public HTTPS/WSS/TLS TURN deployment was performed in this session.

## Checks

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

P2P end-to-end tests run between real Chromium contexts on dedicated ports 5273/8100/3101. Relay testing is a separate mandatory CI job; skipping it in the normal suite does not validate relay operation. The relay suite starts its own coturn on port 3488 with authenticated REST credentials. It requires a Linux Docker Engine or native `TURNSERVER_BIN`. An unavailable external dependency causes failure, rather than a false pass. Tests stop their own processes.

See the [implementation report](docs/implementation.md) for exact results, versions, and environment limitations, and the [specification](docs/specification.md) for detailed requirements. The lockfile and Docker images are pinned. A transitive `ip` dependency currently has an upstream audit advisory; details are in the report.
