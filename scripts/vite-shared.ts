import { defineConfig, loadEnv, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { VIEWER_BOOT } from '../packages/protocol/site.ts';
import { hostHeaders, viewerHost } from './viewer-host.ts';
import { normalizeAppOrigin, normalizeViewerOrigin } from './origins.ts';
import type { Config } from '@htppt/p2p';
export function publicConfig(): Config {
  const env = { ...loadEnv('development', process.cwd(), ''), ...process.env };
  const appOrigin = normalizeAppOrigin(env.APP_ORIGIN);
  const viewerOrigin = normalizeViewerOrigin(env.VIEWER_ORIGIN, appOrigin);
  if (appOrigin === viewerOrigin) throw new Error('Viewer must use a separate origin');
  const appURL = new URL(appOrigin), viewerURL = new URL(viewerOrigin);
  if (appURL.protocol !== viewerURL.protocol || appURL.port !== viewerURL.port) throw new Error('Frontend origins must share a scheme and port');
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
  const origin = new URL(config.appOrigin), viewer = new URL(config.viewerOrigin);
  const serveViewer = viewerHost(config, resolve(process.env.VIEWER_DIST || 'apps/viewer/dist'));
  const allowedHosts = [...new Set([origin.hostname, viewer.hostname, `.${viewer.hostname}`])];
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
      let hostname: string;
      try { hostname = new URL(`http://${req.headers.host}`).hostname; }
      catch { res.writeHead(421).end(); return; }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
      const candidate = hostname.endsWith(`.${viewer.hostname}`) ? hostname.slice(0, -viewer.hostname.length - 1) : '';
      const hash = /^[a-f0-9]{40}$/.test(candidate) ? candidate : undefined;
      if (hash || hostname === viewer.hostname || (loopback && path.startsWith(VIEWER_BOOT))) {
        void serveViewer(req, res, hash); return;
      }
      if (hostname !== origin.hostname && !loopback) { res.writeHead(421).end(); return; }
      if (path.startsWith(VIEWER_BOOT)) { res.writeHead(404).end(); return; }
      if (['/sw.js', '/precache.json', '/', '/index.html', '/open'].includes(path)) res.setHeader('Cache-Control', 'no-cache');
      if (path === '/runtime-config.json') { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(publicConfig())); return; }
      if (path.startsWith('/content/')) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Viewer worker required; no HTTP content fallback'); return; }
      if (/^\/(fixtures|\.env|infra|node_modules)(\/|$)/.test(path)) { res.writeHead(404).end(); return; }
      next();
    });
  }
  return defineConfig({
    root: resolve(`apps/${app}`), base, appType: app === 'web' ? 'spa' : 'mpa',
    plugins: [plugin], define: { __BUILD__: JSON.stringify(`${app}-${Date.now()}`) },
    server: { host: '127.0.0.1', port: Number(origin.port) || 443, strictPort: true, allowedHosts, headers: hostHeaders },
    preview: { host: '127.0.0.1', port: Number(origin.port) || 443, strictPort: true, allowedHosts, headers: hostHeaders },
    build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1600, rollupOptions: { input: { app: resolve(`apps/${app}/index.html`), sw: resolve(`apps/${app}/src/sw.ts`) }, output: { entryFileNames: chunk => chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js' } } }
  });
}
