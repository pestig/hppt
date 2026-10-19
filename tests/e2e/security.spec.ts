import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { APP, VIEWER, content, fixture, fresh, open, publish, start, stop } from './helpers';
test.beforeAll(start); test.afterAll(() => stop());

test('hostile content remains opaque; external fetch/script/image/CSS and top navigation are blocked', async ({ browser }) => {
  let networkRequests = 0;
  const trap = createServer((_req, res) => { networkRequests++; res.writeHead(200, { 'Content-Type': 'text/plain' }).end('trap'); });
  await new Promise<void>(resolve => trap.listen(39200, '127.0.0.1', resolve));
  const a = await fresh(browser), b = await fresh(browser);
  try {
    const files = (await fixture('hostile-site')).map(f => ({ path: f.path, bytes: [...Buffer.from(Buffer.from(f.bytes).toString().replaceAll('https://example.invalid', 'http://localhost:39200'))] }));
    const html = files.find(f => f.path === 'index.html')!;
    html.bytes = [...Buffer.from(Buffer.from(html.bytes).toString().replace('</html>', '<style>@import url("http://localhost:39200/css"); body{background-image:url("http://localhost:39200/bg")}</style></html>'))];
    const hash = await a.page.evaluate(files => (window as any).htppt.engine.publish(files.map(f => ({ ...f, bytes: new Uint8Array(f.bytes) })), { entrypoint: 'index.html' }), files);
    await b.page.evaluate(() => localStorage.setItem('sentinel', 'private-ui-value'));
    await open(b.page, hash);
    await expect(content(b.page).locator('#results')).toContainText('"fetch":"blocked"');
    const results = JSON.parse(await content(b.page).locator('#results').innerText());
    expect(results).toMatchObject({ parent: 'blocked', top: 'blocked', storage: 'blocked', topNavigation: 'blocked', sw: 'blocked', fetch: 'blocked' });
    expect(await content(b.page).locator('body').evaluate(() => window.origin)).toBe('null');
    expect(await b.page.evaluate(() => localStorage.getItem('sentinel'))).toBe('private-ui-value');
    await expect(b.page).toHaveURL(APP + '/');
    expect(networkRequests).toBe(0);
    await content(b.page).locator('#external').click();
    await expect(b.page.locator('#status')).toContainText('Külső');
    await expect(content(b.page).locator('h1')).toHaveText('Hostile fixture');
    expect(networkRequests).toBe(0);
  } finally { await a.context.close(); await b.context.close(); await new Promise<void>(resolve => trap.close(() => resolve())); }
});

test('wrong source/origin/nonce/session/hash cannot replace the bridge or report success', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page); await open(a.page, hash);
  await expect(content(a.page).locator('h1')).toHaveText('Hello, peer!');
  await a.page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('#viewer > iframe')!;
    const values = Object.fromEntries(new URLSearchParams(new URL(frame.src).hash.slice(1)));
    const base = { type: 'init', version: 'htppt/0.1', session: values.session, nonce: values.nonce, hash: new URL(values.uri).hostname, manifest: {} };
    for (const change of [{ nonce: crypto.randomUUID() }, { session: crypto.randomUUID() }, { hash: 'b'.repeat(40) }, { version: 'htppt/9' }]) {
      const channel = new MessageChannel(); channel.port1.close(); frame.contentWindow!.postMessage({ ...base, ...change }, new URL(frame.src).origin, [channel.port2]);
    }
    window.postMessage({ ...base, type: 'viewer-status', state: 'loaded', text: 'forged-success', uri: values.uri }, location.origin);
  });
  const bootstrap = a.page.frames().find(f => f.url().startsWith(VIEWER))!;
  await bootstrap.evaluate(() => {
    const data = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
    window.postMessage({ type: 'init', version: 'htppt/0.1', nonce: data.nonce, session: data.session, hash: new URL(data.uri).hostname, manifest: {} }, location.origin);
  });
  await content(a.page).locator('a').click();
  await expect(content(a.page).locator('h1')).toHaveText('Relatív aloldal');
  await expect(a.page.locator('#status')).not.toContainText('forged-success');
  await a.context.close();
});

test('storage quota failure never grants offline availability or freezes the UI', async ({ browser }) => {
  const a = await fresh(browser), b = await fresh(browser), hash = await publish(a.page);
  await b.page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'files') throw new DOMException('Simulated storage quota exceeded', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await open(b.page, hash); await expect(content(b.page).locator('h1')).toHaveText('Hello, peer!');
  await b.page.locator('#pin-current').click();
  await expect(b.page.locator('#status')).toContainText('quota');
  await expect(b.page.locator('#sites')).not.toContainText('Offline elérhető');
  await content(b.page).locator('#hello').click(); await expect(content(b.page).locator('#result')).toContainText('JavaScript működik');
  await a.context.close(); await b.context.close();
});

test('cache deletion removes durable files and viewer responses while keeping offline shells', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page);
  await a.page.evaluate(() => (window as any).htppt.library());
  await open(a.page, hash); await expect(content(a.page).locator('h1')).toHaveText('Hello, peer!');
  await a.page.locator('#sites button', { hasText: 'Cache törlése' }).click();
  await expect(a.page.locator('#status')).toContainText('viewer cache-e törölve');
  await expect(a.page.locator('#sites')).not.toContainText(hash);
  const viewer = await a.context.newPage(); await viewer.goto(VIEWER);
  expect(await viewer.evaluate(async hash => {
    const cache = await caches.open('htppt-verified-0.1'); return (await cache.keys()).some(k => k.url.includes(hash));
  }, hash)).toBe(false);
  expect(await viewer.evaluate(async () => (await caches.keys()).some(k => k.startsWith('htppt-shell-viewer-')))).toBe(true);
  await a.context.close();
});

test('closing a viewer aborts pending bridge work and a subsequent open works', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page);
  await a.page.evaluate(() => {
    const state = (window as any).htppt;
    state.originalRead = state.engine.readFile.bind(state.engine); state.started = false; state.aborted = false;
    state.engine.readFile = (_hash: string, _path: string, signal: AbortSignal) => {
      state.started = true;
      signal.addEventListener('abort', () => { state.aborted = true; }, { once: true });
      return new Promise(() => {});
    };
  });
  await open(a.page, hash);
  await a.page.waitForFunction(() => (window as any).htppt.started);
  await a.page.locator('#close-viewer').click();
  await a.page.waitForFunction(() => (window as any).htppt.aborted);
  await a.page.evaluate(() => { (window as any).htppt.engine.readFile = (window as any).htppt.originalRead; });
  await open(a.page, hash); await expect(content(a.page).locator('h1')).toHaveText('Hello, peer!');
  await a.context.close();
});

test('corrupt durable bytes never reach the iframe or the verified viewer cache', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page);
  await a.page.evaluate(async hash => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('htppt-v1'); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(new Uint8Array([9, 8, 7]), `${hash}/index.html`);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }); db.close();
  }, hash);
  await open(a.page, hash); await expect(a.page.locator('#status')).toContainText('Integrity failure');
  await expect(a.page.frameLocator('#viewer > iframe').locator('iframe')).toHaveCount(0);
  const bootstrap = a.page.frames().find(f => f.url().startsWith(VIEWER))!;
  expect(await bootstrap.evaluate(async hash => (await (await caches.open('htppt-verified-0.1')).keys()).some(k => k.url.includes(`${hash}/index.html`)), hash)).toBe(false);
  await a.context.close();
});
