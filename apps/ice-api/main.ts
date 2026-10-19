import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeAppOrigin } from '../../scripts/origins.ts';

const env = process.env;
const production = env.NODE_ENV === 'production';
if (production && (!env.TURN_SECRET || !env.AUTH_PROXY_TOKEN)) throw new Error('Production requires TURN_SECRET and AUTH_PROXY_TOKEN');
const windows = new Map<string, { start: number; count: number }>();
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = req.headers.origin;
  const app = normalizeAppOrigin(env.APP_ORIGIN);
  if (origin && origin !== app) { res.writeHead(403).end(); return; }
  if (origin) { res.setHeader('Access-Control-Allow-Origin', app); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Credentials', 'true'); res.writeHead(204).end(); return; }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); res.writeHead(405).end(); return; }
  if (req.url === '/health') { res.end('ok'); return; }
  if (req.url !== '/ice') { res.writeHead(404).end(); return; }
  let user = 'dev';
  if (production) {
    // The gateway must strip both incoming headers, authenticate, then inject them.
    const expected = Buffer.from(env.AUTH_PROXY_TOKEN!);
    const received = Buffer.from(String(req.headers['x-htppt-gateway-token'] || ''));
    user = String(req.headers['x-authenticated-user'] || '');
    if (received.length !== expected.length || !timingSafeEqual(received, expected) || !/^[a-zA-Z0-9_-]{1,128}$/.test(user)) { res.writeHead(401).end(); return; }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  const key = production ? user : req.socket.remoteAddress || 'local';
  const now = Date.now();
  for (const [k, value] of windows) if (now - value.start > 60000) windows.delete(k);
  const state = windows.get(key) || { start: now, count: 0 };
  windows.set(key, state);
  if (++state.count > 30 || windows.size > 10000) { res.setHeader('Retry-After', '60'); res.writeHead(429).end(); return; }
  const expiresAt = Math.floor(now / 1000) + 3600;
  const username = production ? `${expiresAt}:${user}` : env.TURN_USERNAME;
  const credential = production ? createHmac('sha1', env.TURN_SECRET!).update(username!).digest('base64') : env.TURN_PASSWORD;
  if (!username || !credential) { res.writeHead(503).end('Run npm run setup:dev'); return; }
  const host = env.TURN_HOST || '127.0.0.1';
  const port = env.TURN_PORT || '3478';
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) { res.writeHead(500).end(); return; }
  const urls = [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`];
  if (env.TURN_TLS_PORT) urls.push(`turns:${host}:${env.TURN_TLS_PORT}?transport=tcp`);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ iceServers: [{ urls: [`stun:${host}:${port}`] }, { urls, username, credential }], expiresAt }));
});
server.listen(Number(env.PORT || 3001), '0.0.0.0', () => console.log('ICE API listening'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit()));
