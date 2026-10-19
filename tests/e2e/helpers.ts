import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { readdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { expect, type Page, type Browser, type BrowserContext } from '@playwright/test';
export const APP = 'http://localhost:5273';
export const VIEWER = 'http://localhost:5274';
export const buildDirectories = { web: resolve('apps/web/dist') };
export const turnSecret = randomBytes(32).toString('hex');
export const gatewayHeaders = { 'x-authenticated-user': 'browser-fixture', 'x-htppt-gateway-token': randomBytes(32).toString('hex') };
export const env = { ...process.env, APP_ORIGIN: APP, VIEWER_ORIGIN: VIEWER, TRACKER_URL: 'ws://localhost:8100', ICE_API_URL: 'http://localhost:3101/ice', ICE_TRANSPORT_POLICY: process.env.RELAY_TEST ? 'relay' : 'all', NODE_ENV: process.env.RELAY_TEST ? 'production' : 'development', ...(process.env.RELAY_TEST ? { TURN_HOST: '127.0.0.1', TURN_PORT: '3488', TURN_SECRET: turnSecret, AUTH_PROXY_TOKEN: gatewayHeaders['x-htppt-gateway-token'] } : {}) };
const processes = new Map<string, ChildProcess>();
let turnFolder: string | undefined;
let container: string | undefined;
export async function startTurn() {
  if (processes.has('turn')) return;
  turnFolder ??= await mkdtemp(resolve(tmpdir(), 'htppt-relay-'));
  const config = `listening-port=3488\nlistening-ip=127.0.0.1\nrelay-ip=127.0.0.1\nmin-port=49500\nmax-port=49620\nfingerprint\nuse-auth-secret\nstatic-auth-secret=${turnSecret}\nrealm=htppt.test\nallow-loopback-peers\nno-tls\nno-dtls\nno-cli\nno-multicast-peers\nno-tcp-relay\n`;
  const path = resolve(turnFolder, 'turn.conf'); await writeFile(path, config, { mode: 0o600 });
  let child: ChildProcess;
  if (process.env.TURNSERVER_BIN) child = spawn(process.env.TURNSERVER_BIN, ['-c', path], { stdio: 'ignore', env: { ...process.env, ...(process.env.TURNSERVER_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.TURNSERVER_LIBRARY_PATH } : {}) } });
  else {
    container = `htppt-relay-${process.pid}`;
    child = spawn('docker', ['run', '--rm', '--name', container, '--network', 'host', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '-v', `${path}:/etc/coturn/turnserver.conf:ro`, '--entrypoint', '/bin/sh', process.env.COTURN_IMAGE || 'coturn/coturn:4.7.0@sha256:a00afb5b4890de4df22bbe70379c6b316685dffee297d53cac1271dcb91fab93', '-c', 'test -r /etc/coturn/turnserver.conf && exec turnserver -c /etc/coturn/turnserver.conf'], { stdio: 'ignore' });
  }
  child.on('error', () => {}); processes.set('turn', child);
  await expect.poll(() => new Promise<boolean>(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: 3488 });
    socket.setTimeout(250); socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); }); socket.once('timeout', () => { socket.destroy(); resolve(false); });
  }), { timeout: 10000, message: 'Managed TURN unavailable. Use Linux Docker Engine or TURNSERVER_BIN with a local coturn; Docker Desktop host networking may be unreachable.' }).toBe(true);
}
function launch(name: string, args: string[], extra = {}) {
  const child = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`));
  processes.set(name, child);
}
export async function start() {
  if (processes.size) return;
  if (process.env.RELAY_TEST) await startTurn();
  launch('tracker', ['apps/tracker/main.ts'], { PORT: '8100' });
  launch('ice', ['apps/ice-api/main.ts'], { PORT: '3101' });
  launch('web', ['node_modules/vite/bin/vite.js', 'preview', '--config', 'apps/web/vite.config.ts', '--outDir', buildDirectories.web]);
  launch('viewer', ['node_modules/vite/bin/vite.js', 'preview', '--config', 'apps/viewer/vite.config.ts']);
  for (const url of [APP, VIEWER, 'http://localhost:3101/health', 'http://localhost:8100/stats.json']) await expect.poll(async () => { try { return (await fetch(url)).status; } catch { return 0; } }, { timeout: 15000 }).toBe(200);
}
export async function stop(name?: string) {
  for (const [id, child] of [...processes]) {
    if (name && id !== name) continue;
    processes.delete(id);
    if (id === 'turn' && container) await new Promise<void>(resolve => { execFile('docker', ['stop', '-t', '1', container!], () => resolve()); });
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
  }
  if (!name && turnFolder) { await rm(turnFolder, { recursive: true, force: true }); turnFolder = undefined; }
}
export async function ready(page: Page) {
  await page.goto(APP);
  await page.waitForFunction(() => (window as any).htppt && navigator.serviceWorker.controller);
}
export async function fresh(browser: Browser): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext(); const page = await context.newPage();
  if (process.env.RELAY_TEST) await page.route('**/ice', route => route.continue({ headers: { ...route.request().headers(), ...gatewayHeaders } }));
  await ready(page); return { page, context };
}
export async function fixture(name = 'hello-site') {
  const base = resolve('fixtures', name); const files = [];
  for (const f of await readdir(base, { recursive: true, withFileTypes: true })) if (f.isFile()) {
    const full = `${f.parentPath}/${f.name}`;
    files.push({ path: full.slice(base.length + 1), bytes: [...await readFile(full)] });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function publish(page: Page, name = 'hello-site', entrypoint = 'index.html') {
  return page.evaluate(async ({ files, entrypoint }) => (window as any).htppt.engine.publish(files.map(f => ({ ...f, bytes: new Uint8Array(f.bytes) })), { entrypoint }), { files: await fixture(name), entrypoint });
}
export async function open(page: Page, hash: string, suffix = '') { await page.evaluate(uri => (window as any).htppt.open(uri), `web+hppt://${hash}${suffix}`); }
export async function pin(page: Page, hash: string) { await page.evaluate(hash => (window as any).htppt.engine.pin(hash), hash); }
export function content(page: Page) { return page.frameLocator('#viewer > iframe').frameLocator('iframe'); }
