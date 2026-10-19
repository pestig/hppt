import { defineConfig, loadEnv, type Plugin } from 'vite';
import { resolve } from 'node:path';
export function publicConfig() {
  const env = { ...loadEnv('development', process.cwd(), ''), ...process.env };
  const appOrigin = new URL(env.APP_ORIGIN || 'http://localhost:5173').origin;
  const viewerOrigin = new URL(env.VIEWER_ORIGIN || 'http://localhost:5174').origin;
  if (appOrigin === viewerOrigin) throw new Error('Viewer must use a separate origin');
  for (const origin of [appOrigin, viewerOrigin]) {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('Non-local origins require HTTPS');
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
  const origin = new URL(app === 'web' ? config.appOrigin : config.viewerOrigin);
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(app === 'viewer' ? { 'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline' data:; style-src 'self' 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'self'; worker-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${config.appOrigin}` } : {}) };
  const plugin: Plugin = {
    name: 'htppt-host',
    configureServer(server) { middleware(server); },
    configurePreviewServer(server) { middleware(server); },
    generateBundle(_options, bundle) {
      this.emitFile({ type: 'asset', fileName: 'runtime-config.json', source: JSON.stringify(config) });
      const files = ['/index.html', '/runtime-config.json', ...Object.keys(bundle).filter(f => !f.endsWith('.map')).map(f => `/${f}`)];
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: JSON.stringify([...new Set(files)]) });
    }
  };
  function middleware(server: any) {
    server.middlewares.use((req: any, res: any, next: () => void) => {
      const path = (req.url || '').split('?')[0];
      if (['/sw.js', '/precache.json', '/', '/index.html', '/open'].includes(path)) res.setHeader('Cache-Control', 'no-cache');
      if (path === '/runtime-config.json') { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(publicConfig())); return; }
      if (path.startsWith('/content/')) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Viewer worker required; no HTTP content fallback'); return; }
      if (/^\/(fixtures|\.env|infra|node_modules)(\/|$)/.test(path)) { res.writeHead(404).end(); return; }
      if (app === 'viewer' && !['/', '/index.html', '/sw.js', '/precache.json'].includes(path) && !/^\/(assets|src|@vite|@fs|@id)\//.test(path)) { res.writeHead(404).end(); return; }
      next();
    });
  }
  return defineConfig({
    root: resolve(`apps/${app}`), appType: app === 'web' ? 'spa' : 'mpa',
    plugins: [plugin], define: { __BUILD__: JSON.stringify(`${app}-${Date.now()}`) },
    server: { host: '127.0.0.1', port: Number(origin.port) || 443, strictPort: true, allowedHosts: [origin.hostname], headers },
    preview: { host: '127.0.0.1', port: Number(origin.port) || 443, strictPort: true, allowedHosts: [origin.hostname], headers },
    build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1600, rollupOptions: { input: { app: resolve(`apps/${app}/index.html`), sw: resolve(`apps/${app}/src/sw.ts`) }, output: { entryFileNames: chunk => chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js' } } }
  });
}
