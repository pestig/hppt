import { defineConfig, loadEnv, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { VIEWER_BOOT } from '../packages/protocol/site.ts';
import { parseAddress } from '../packages/protocol/index.ts';
import { normalizeAppOrigin, normalizeViewerOrigin } from './origins.ts';
export function publicConfig() {
  const env = { ...loadEnv('development', process.cwd(), ''), ...process.env };
  const appOrigin = normalizeAppOrigin(env.APP_ORIGIN);
  const viewerOrigin = normalizeViewerOrigin(env.VIEWER_ORIGIN);
  if (appOrigin === viewerOrigin) throw new Error('Viewer must use a separate origin');
  for (const origin of [appOrigin, viewerOrigin]) {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && !u.hostname.endsWith('.localhost')) throw new Error('Non-local origins require HTTPS');
  }
  const tracker = env.TRACKER_URL || 'ws://localhost:8000';
  if (!['ws:', 'wss:'].includes(new URL(tracker).protocol)) throw new Error('Expected WS/WSS tracker');
  const iceApi = env.ICE_API_URL || 'http://localhost:3001/ice';
  if (!['http:', 'https:'].includes(new URL(iceApi).protocol)) throw new Error('Expected HTTP/HTTPS ICE API');
  for (const value of [tracker, iceApi]) if (new URL(value).username || new URL(value).password) throw new Error('Frontend endpoints cannot contain secret URL credentials');
  if (appOrigin.startsWith('https:') && !tracker.startsWith('wss:')) throw new Error('HTTPS requires WSS tracker');
  if (appOrigin.startsWith('https:') && !iceApi.startsWith('https:')) throw new Error('HTTPS requires HTTPS ICE API');
  const limits = { files: Number(env.MAX_FILES || 1000), total: Number(env.MAX_TOTAL_BYTES || 52428800), file: Number(env.MAX_FILE_BYTES || 10485760) };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Package limits must be positive integers');
  return { appOrigin, viewerOrigin, tracker, iceApi, policy: env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all', limits };
}
export function configuration(app: 'web' | 'viewer') {
  const config = publicConfig();
  const base = app === 'viewer' ? VIEWER_BOOT : '/';
  const origin = new URL(app === 'web' ? config.appOrigin : config.viewerOrigin);
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Origin-Agent-Cluster': '?1', ...(app === 'viewer' ? { 'Service-Worker-Allowed': '/', 'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${config.appOrigin}` } : {}) };
  const plugin: Plugin = {
    name: 'htppt-host',
    configureServer(server) { middleware(server); },
    configurePreviewServer(server) { middleware(server); },
    generateBundle(_options, bundle) {
      this.emitFile({ type: 'asset', fileName: 'runtime-config.json', source: JSON.stringify(config) });
      const files = [`${base}index.html`, `${base}runtime-config.json`, ...Object.keys(bundle).filter(f => !f.endsWith('.map')).map(f => `${base}${f}`)];
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: JSON.stringify([...new Set(files)]) });
    }
  };
  function middleware(server: any) {
    server.middlewares.use((req: any, res: any, next: () => void) => {
      const path = (req.url || '').split('?')[0];
      if (app === 'viewer') {
        const hostname = (req.headers.host || '').split(':')[0];
        const suffix = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ? 'localhost' : origin.hostname;
        const site = hostname.endsWith(`.${suffix}`) && /^[a-f0-9]{40}$/.test(hostname.slice(0, -suffix.length - 1));
        if (!site && ![origin.hostname, 'localhost', '127.0.0.1'].includes(hostname)) { res.writeHead(421).end(); return; }
        if (path === '/' && !site) { res.writeHead(302, { Location: base }).end(); return; }
        if (!path.startsWith(base)) {
          // A fresh profile has no site worker yet. Bootstrap top-level visits
          // through the app; resource/fetch requests never receive HTTP payloads.
          if (site && req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document') {
            const uri = `web+hppt://${hostname.slice(0, -suffix.length - 1)}${req.url}`;
            try { parseAddress(uri); }
            catch { res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Invalid HPPT path'); return; }
            const target = new URL('/open', config.appOrigin);
            target.searchParams.set('uri', uri); target.searchParams.set('source', 'viewer');
            // No fragment is supplied: the browser carries the original one
            // across the redirect, where the launcher adds it to the HPPT URI.
            res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Vary: 'Sec-Fetch-Mode, Sec-Fetch-Dest' }).end(); return;
          }
          res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Open this site from the HPPT application first. No HTTP content fallback.'); return;
        }
      }
      if (['/sw.js', '/precache.json', '/', '/index.html', '/open'].includes(path)) res.setHeader('Cache-Control', 'no-cache');
      if (path === `${base}runtime-config.json`) { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(publicConfig())); return; }
      if (path.startsWith('/content/')) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Viewer worker required; no HTTP content fallback'); return; }
      if (/^\/(fixtures|\.env|infra|node_modules)(\/|$)/.test(path)) { res.writeHead(404).end(); return; }
      if (app === 'viewer') res.setHeader('Cache-Control', 'no-cache');
      next();
    });
  }
  return defineConfig({
    root: resolve(`apps/${app}`), base, appType: app === 'web' ? 'spa' : 'mpa',
    plugins: [plugin], define: { __BUILD__: JSON.stringify(`${app}-${Date.now()}`) },
    server: { host: '127.0.0.1', port: Number(origin.port) || 443, strictPort: true, allowedHosts: [origin.hostname, `.${origin.hostname}`, ...(app === 'viewer' ? ['.localhost'] : [])], headers },
    preview: { host: '127.0.0.1', port: Number(origin.port) || 443, strictPort: true, allowedHosts: [origin.hostname, `.${origin.hostname}`, ...(app === 'viewer' ? ['.localhost'] : [])], headers },
    build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1600, rollupOptions: { input: { app: resolve(`apps/${app}/index.html`), sw: resolve(`apps/${app}/src/sw.ts`) }, output: { entryFileNames: chunk => chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js' } } }
  });
}
