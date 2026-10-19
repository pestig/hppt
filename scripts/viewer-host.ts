import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '@htppt/p2p';
import { mimeFor, parseAddress } from '../packages/protocol/index.ts';
import { VIEWER_BOOT } from '../packages/protocol/site.ts';

export const hostHeaders = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Origin-Agent-Cluster': '?1' };

// Only compiled viewer shell files are available on content origins. Keeping
// this handler ahead of Vite's UI middleware prevents a controller SPA fallback.
export function viewerHost(config: Config, directory: string) {
  let files: Promise<Set<string>> | undefined;
  return async (req: IncomingMessage, res: ServerResponse, hash?: string) => {
    const path = (req.url || '/').split('?')[0];
    for (const [name, value] of Object.entries(hostHeaders)) res.setHeader(name, value);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${config.appOrigin}`);
    if (path === '/' && !hash) { res.writeHead(302, { Location: VIEWER_BOOT }).end(); return; }
    if (!path.startsWith(VIEWER_BOOT)) {
      if (hash && req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document') {
        const uri = `web+hppt://${hash}${req.url}`;
        try { parseAddress(uri); }
        catch { res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Invalid HPPT path'); return; }
        const target = new URL('/open', config.appOrigin);
        target.searchParams.set('uri', uri); target.searchParams.set('source', 'viewer');
        // The browser inherits the original fragment; the launcher restores it.
        res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store', Vary: 'Sec-Fetch-Mode, Sec-Fetch-Dest' }).end(); return;
      }
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Open this site from the HPPT application first. No HTTP content fallback.'); return;
    }
    if (!['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    if (path === `${VIEWER_BOOT}runtime-config.json`) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(req.method === 'HEAD' ? undefined : JSON.stringify(config)); return;
    }
    try {
      const allowed = await (files ??= readFile(resolve(directory, 'precache.json'), 'utf8').then(text => new Set<string>(JSON.parse(text))).catch(error => { files = undefined; throw error; }));
      const key = path === VIEWER_BOOT ? `${VIEWER_BOOT}index.html` : path;
      if (key !== `${VIEWER_BOOT}precache.json` && !allowed.has(key)) { res.writeHead(404).end(); return; }
      // The allowlist is build-generated; never resolve an arbitrary URL path.
      const bytes = await readFile(resolve(directory, key.slice(VIEWER_BOOT.length)));
      res.writeHead(200, { 'Content-Type': mimeFor(key), 'Content-Length': bytes.length }).end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      res.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' }).end('Viewer bootstrap unavailable; run npm run build.');
    }
  };
}
