import { WebSocket } from 'ws';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;
let failed = false;
async function check(label, task) { try { await task(); console.log(`OK    ${label}`); } catch (error) { failed = true; console.error(`FAIL  ${label}: ${error.message}`); } }
await check('Node 24', async () => { if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error(process.versions.node); });
for (const [label, url] of [['Web UI', env.APP_ORIGIN || 'http://localhost:5173'], ['Viewer', env.VIEWER_ORIGIN || 'http://localhost:5174']]) await check(label, async () => { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); });
await check('Origin isolation', async () => { if (env.APP_ORIGIN === env.VIEWER_ORIGIN) throw new Error('Origins must differ'); });
await check('ICE API', async () => {
  const response = await fetch(env.ICE_API_URL || 'http://localhost:3001/ice', { headers: { Origin: env.APP_ORIGIN || 'http://localhost:5173' }, signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}${response.status === 401 ? ' (production gateway authentication required)' : ''}`);
  const data = await response.json();
  if (!data.iceServers?.some(s => s.urls.some(u => u.startsWith('turn:'))) || data.expiresAt * 1000 <= Date.now()) throw new Error('Missing TURN or expired credentials');
  if (response.headers.get('cache-control') !== 'no-store') throw new Error('ICE API must use no-store');
});
await check('Tracker WebSocket', () => new Promise((resolve, reject) => {
  const socket = new WebSocket(env.TRACKER_URL || 'ws://localhost:8000');
  const timer = setTimeout(() => { socket.terminate(); reject(new Error('WS timeout')); }, 4000);
  socket.once('open', () => { clearTimeout(timer); socket.close(); resolve(); });
  socket.once('error', error => { clearTimeout(timer); reject(error); });
}));
console.log('NOTE  A working TURN path requires browser allocation + selected relay pair + real data transfer. Run npm run test:relay.');
process.exitCode = failed ? 1 : 0;
