import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { siteOrigin } from '../../packages/protocol/site';
import { APP, VIEWER, content, fixture, fresh, open, publish, start, stop } from './helpers';
test.beforeAll(start); test.afterAll(() => stop());

test('browser storage partitioning is enabled in the test environment', async ({ browser }) => {
  const a = await fresh(browser);
  const thirdParty = 'http://localhost:5273/__hppt/';
  await a.page.evaluate(url => { const iframe = document.createElement('iframe'); iframe.src = url; iframe.id = 'partition-probe'; document.body.append(iframe); }, thirdParty);
  await expect(a.page.frameLocator('#partition-probe').locator('#status')).toContainText('HPPT');
  const helper = a.page.frames().find(f => f.url() === thirdParty)!;
  await helper.evaluate(async () => (await caches.open('partition-probe')).put('/marker', new Response('third-party')));
  const top = await a.context.newPage(); await top.goto(thirdParty);
  expect(await top.evaluate(async () => !!await (await caches.open('partition-probe')).match('/marker'))).toBe(false);
  await a.context.close();
});

test('site origin detaches the opener and CSP blocks external fetch, script, image, CSS and workers', async ({ browser }) => {
  let networkRequests = 0;
  const trap = createServer((_req, res) => { networkRequests++; res.writeHead(200).end('trap'); });
  await new Promise<void>(resolve => trap.listen(39200, '127.0.0.1', resolve));
  const a = await fresh(browser), b = await fresh(browser);
  try {
    const files = (await fixture('hostile-site')).map(f => ({ path: f.path, bytes: [...Buffer.from(Buffer.from(f.bytes).toString().replaceAll('https://example.invalid', 'http://localhost:39200'))] }));
    const html = files.find(f => f.path === 'index.html')!;
    html.bytes = [...Buffer.from(Buffer.from(html.bytes).toString().replace('</html>', '<style>@import url("http://localhost:39200/css");body{background-image:url("http://localhost:39200/bg")}</style></html>'))];
    const hash = await a.page.evaluate(files => (window as any).htppt.engine.publish(files.map(f => ({ ...f, bytes: new Uint8Array(f.bytes) })), { entrypoint: 'index.html' }), files);
    await b.page.evaluate(() => localStorage.setItem('sentinel', 'private-ui-value'));
    await open(b.page, hash); const viewer = content(b.page);
    await expect(viewer.locator('#results')).toContainText('"fetch":"blocked"');
    expect(JSON.parse(await viewer.locator('#results').innerText())).toMatchObject({ opener: 'detached', storage: 'site-only', sw: 'blocked', fetch: 'blocked' });
    expect(await b.page.evaluate(() => localStorage.getItem('sentinel'))).toBe('private-ui-value');
    expect(await viewer.evaluate(() => localStorage.getItem('sentinel'))).toBeNull();
    await expect(b.page).toHaveURL(APP + '/'); expect(networkRequests).toBe(0);
    expect(viewer.frames()).toHaveLength(1);
  } finally { await a.context.close(); await b.context.close(); await new Promise<void>(resolve => trap.close(() => resolve())); }
});

test('wrong origin, source, nonce, session, hash and protocol cannot replace a bridge', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page); await open(a.page, hash);
  await expect(content(a.page).locator('h1')).toHaveText('Hello, peer!');
  await a.page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="HPPT fájlkiszolgáló"]')!;
    const values = Object.fromEntries(new URLSearchParams(new URL(frame.src).hash.slice(1)));
    const base = { type: 'init', version: 'htppt/0.1', session: values.session, nonce: values.nonce, hash: values.hash, proof: {} };
    for (const change of [{ nonce: crypto.randomUUID() }, { session: crypto.randomUUID() }, { hash: 'b'.repeat(40) }, { version: 'htppt/9' }]) {
      const channel = new MessageChannel(); channel.port1.close(); frame.contentWindow!.postMessage({ ...base, ...change }, new URL(frame.src).origin, [channel.port2]);
    }
    window.postMessage({ ...base, type: 'viewer-status', state: 'loaded', text: 'forged-success', uri: '' }, location.origin);
  });
  const helper = a.page.frames().find(f => new URL(f.url()).origin === siteOrigin(VIEWER, hash))!;
  await helper.evaluate(() => {
    const data = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
    window.postMessage({ type: 'init', version: 'htppt/0.1', nonce: data.nonce, session: data.session, hash: data.hash, proof: {} }, location.origin);
  });
  await content(a.page).locator('a').click(); await expect(content(a.page).locator('h1')).toHaveText('Relatív aloldal');
  await expect(a.page.locator('#status')).not.toContainText('forged-success'); await a.context.close();
});

test('UI storage quota failure never grants offline availability', async ({ browser }) => {
  const a = await fresh(browser), b = await fresh(browser), hash = await publish(a.page);
  await b.page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'files') throw new DOMException('Simulated storage quota exceeded', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await open(b.page, hash); await expect(content(b.page).locator('h1')).toHaveText('Hello, peer!');
  await b.page.locator('#pin-current').click(); await expect(b.page.locator('#status')).toContainText('quota');
  await expect(b.page.locator('#sites')).not.toContainText('Offline elérhető');
  await content(b.page).locator('#hello').click(); await expect(content(b.page).locator('#result')).toContainText('JavaScript működik');
  await a.context.close(); await b.context.close();
});

test('cache deletion clears the site origin and durable files while preserving its bootstrap', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page);
  await a.page.evaluate(() => (window as any).htppt.library()); await open(a.page, hash); const viewer = content(a.page);
  await expect(viewer.locator('h1')).toHaveText('Hello, peer!');
  await a.page.locator('#sites button', { hasText: 'Cache törlése' }).click();
  await expect(a.page.locator('#status')).toContainText('viewer cache-e törölve');
  await expect(a.page.locator('#sites')).not.toContainText(hash);
  expect(await viewer.evaluate(async () => (await fetch('/index.html')).status)).toBe(503);
  expect(await viewer.evaluate(async () => (await caches.keys()).some(k => k.startsWith('htppt-shell-viewer-')))).toBe(true);
  expect(await viewer.evaluate(async () => (await caches.keys()).includes('hppt-site-files-v1'))).toBe(true);
  expect(await viewer.evaluate(async () => (await (await caches.open('hppt-site-files-v1')).keys()).length)).toBe(0);
  await a.context.close();
});

test('different packages have isolated storage and cannot fetch each other or the UI', async ({ page }) => {
  await page.goto(APP); await page.waitForFunction(() => (window as any).htppt && navigator.serviceWorker.controller);
  const first = await publish(page); await open(page, first); const a = content(page);
  await expect(a.locator('h1')).toHaveText('Hello, peer!');
  await a.evaluate(() => localStorage.setItem('site-secret', 'first-only'));
  const second = await publish(page, 'nested-site', 'pages/home.html'); await open(page, second); const b = content(page);
  await expect(b.locator('h1')).toHaveText('Nested home');
  expect(new URL(a.url()).origin).not.toBe(new URL(b.url()).origin);
  expect(await b.evaluate(() => localStorage.getItem('site-secret'))).toBeNull();
  expect(await a.evaluate(async origin => { try { await fetch(`${origin}/pages/home.html`); return 'allowed'; } catch { return 'blocked'; } }, new URL(b.url()).origin)).toBe('blocked');
  expect(await b.evaluate(async app => { try { await fetch(`${app}/runtime-config.json`); return 'allowed'; } catch { return 'blocked'; } }, APP)).toBe('blocked');
});

test('tampered site cache bytes never render, even though content can access its own storage', async ({ page }) => {
  await page.goto(APP); await page.waitForFunction(() => (window as any).htppt && navigator.serviceWorker.controller);
  const hash = await publish(page); await open(page, hash); const viewer = content(page);
  await expect(viewer.locator('h1')).toHaveText('Hello, peer!');
  await viewer.evaluate(async () => (await caches.open('hppt-site-files-v1')).put('/__hppt/verified/index.html', new Response('<h1>Forged page</h1>')));
  const response = await viewer.reload(); expect(response!.status()).toBe(422);
  await expect(viewer.locator('body')).toContainText('Integrity failure'); await expect(viewer.locator('h1')).toHaveCount(0);
});

test('a forged cached manifest proof is rejected after worker restart', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page); await open(a.page, hash); const viewer = content(a.page);
  await expect(viewer.locator('h1')).toHaveText('Hello, peer!');
  await viewer.evaluate(async () => {
    const cache = await caches.open('hppt-site-files-v1'); const proof = await (await cache.match('/__hppt/authority'))!.json();
    proof.pieces[0].bytes[0] ^= 1; await cache.put('/__hppt/authority', new Response(JSON.stringify(proof)));
  });
  const cdp = await a.context.newCDPSession(viewer); await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers');
  const response = await viewer.reload(); expect(response!.status()).toBe(422);
  await expect(viewer.locator('h1')).toHaveCount(0); await a.context.close();
});

test('disconnecting the application aborts pending bridge work', async ({ browser }) => {
  const a = await fresh(browser);
  const hash = await a.page.evaluate(() => (window as any).htppt.engine.publish([
    { path: 'index.html', bytes: new TextEncoder().encode('<h1>Pending read</h1>') },
    { path: 'late.txt', bytes: new TextEncoder().encode('late content') }
  ], { entrypoint: 'index.html' }));
  await a.page.evaluate(() => (window as any).htppt.library()); await open(a.page, hash); const viewer = content(a.page);
  await expect(viewer.locator('h1')).toHaveText('Pending read');
  await viewer.evaluate(async () => (await caches.open('hppt-site-files-v1')).delete('/__hppt/verified/late.txt'));
  await a.page.evaluate(() => {
    const state = (window as any).htppt; state.started = false; state.aborted = false;
    const read = state.engine.readFile.bind(state.engine);
    state.engine.readFile = (hash: string, path: string, signal: AbortSignal) => {
      if (path !== 'late.txt') return read(hash, path, signal);
      state.started = true; signal.addEventListener('abort', () => { state.aborted = true; }); return new Promise(() => {});
    };
  });
  await viewer.evaluate(() => { (window as any).pending = fetch('/late.txt').then(r => r.status); });
  await a.page.waitForFunction(() => (window as any).htppt.started);
  await a.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await a.page.waitForFunction(() => (window as any).htppt.aborted);
  expect(await viewer.evaluate(() => (window as any).pending)).toBe(503); await a.context.close();
});

test('viewer persistence failure removes offline availability and can be retried', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page);
  await a.page.evaluate(() => (window as any).htppt.library()); await open(a.page, hash); const viewer = content(a.page);
  await expect(viewer.locator('h1')).toHaveText('Hello, peer!');
  const worker = a.context.serviceWorkers().find(w => w.url().startsWith(siteOrigin(VIEWER, hash)))!;
  expect(worker).toBeTruthy();
  await worker.evaluate(() => {
    const original = Cache.prototype.put; (self as any).originalCachePut = original;
    Cache.prototype.put = function (...args: Parameters<typeof original>) {
      const url = String(args[0] instanceof Request ? args[0].url : args[0]);
      if (url.includes('/verified/')) return Promise.reject(new DOMException('Viewer quota exceeded', 'QuotaExceededError'));
      return original.apply(this, args);
    };
  });
  await viewer.evaluate(async () => (await caches.open('hppt-site-files-v1')).delete('/__hppt/verified/pages/about.html'));
  await a.page.locator('#refresh-library').click();
  await expect(a.page.locator('#sites')).not.toContainText('Offline elérhető');
  await expect(a.page.locator('#sites')).toContainText('viewer előkészítése szükséges');
  await viewer.locator('a').click(); await expect(viewer.locator('h1')).toHaveText('Relatív aloldal');
  await worker.evaluate(() => { Cache.prototype.put = (self as any).originalCachePut; });
  await a.page.locator('#refresh-library').click(); await expect(a.page.locator('#sites')).toContainText('Offline elérhető');
  await a.context.close();
});
