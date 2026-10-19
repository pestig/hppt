import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fresh, start, stop, publish, open, content, APP, VIEWER } from './helpers';
test.beforeAll(start); test.afterAll(() => stop());
test('sandboxed viewer displays real P2P HTML, CSS, image and classic JavaScript', async ({ browser }) => {
  const a = await fresh(browser), b = await fresh(browser);
  try {
    const hash = await publish(a.page);
    await open(b.page, hash);
    await expect(content(b.page).locator('h1')).toHaveText('Hello, peer!');
    await expect(content(b.page).locator('img')).toBeVisible();
    expect(await content(b.page).locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(content(b.page).locator('body')).toHaveCSS('background-color', 'rgb(242, 245, 233)');
    await content(b.page).locator('#hello').click();
    await expect(content(b.page).locator('#result')).toContainText('JavaScript működik');
  } finally { await a.context.close(); await b.context.close(); }
});

test('non-index nested entrypoint, CSS imports/images, query/fragment, links and exact 404', async ({ page }) => {
  await page.goto(APP); await page.waitForFunction(() => (window as any).htppt && navigator.serviceWorker.controller);
  await page.locator('#folder').setInputFiles(resolve('fixtures/nested-site'));
  await expect(page.locator('#publish-button')).toBeDisabled();
  await page.locator('#entrypoint').selectOption('pages/home.html');
  await page.locator('#publish-button').click();
  await expect(page.locator('#share-uri')).toHaveValue(/^web\+hppt:\/\/[a-f0-9]{40}$/);
  const hash = (await page.locator('#share-uri').inputValue()).slice('web+hppt://'.length);
  await open(page, hash, '/?start=1#hello');
  await expect(content(page).locator('h1')).toHaveText('Nested home');
  await expect(content(page).locator('body')).toHaveCSS('background-color', 'rgb(242, 245, 233)');
  expect(await content(page).locator('body').evaluate(el => getComputedStyle(el).backgroundImage)).toContain('data:image/svg+xml');
  await expect(page.locator('#uri')).toHaveValue(`web+hppt://${hash}/pages/home.html?start=1#hello`);
  await content(page).locator('#hello').click(); await expect(content(page).locator('#result')).toHaveText('Nested JS works');
  await content(page).locator('#next').click();
  await expect(content(page).locator('h1')).toHaveText('Nested about');
  await expect(page.locator('#share-uri')).toHaveValue(`web+hppt://${hash}/about.html?from=nested#detail`);
  await content(page).locator('#missing').click();
  await expect(page.locator('#status')).toContainText('404');
  await expect(page.frameLocator('#viewer > iframe').locator('iframe')).toHaveCount(0);
  await open(page, hash); await expect(content(page).locator('h1')).toHaveText('Nested home');
});

test('SW restricts session/hash/path/method and implements HEAD and full-200 Range', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page); await open(a.page, hash);
  await expect(content(a.page).locator('h1')).toHaveText('Hello, peer!');
  const bootstrap = a.page.frames().find(f => f.url().startsWith(VIEWER))!;
  const results = await bootstrap.evaluate(async hash => {
    const get = async (path: string, init?: RequestInit) => { const r = await fetch(path, init); return { status: r.status, text: await r.text(), type: r.headers.get('content-type'), nosniff: r.headers.get('x-content-type-options') }; };
    return {
      wrongHash: await get(`/content/${'b'.repeat(40)}/index.html`),
      missing: await get(`/content/${hash}/missing.html`),
      traversal: await get(`/content/${hash}/%252e%252e/index.html`),
      method: await get(`/content/${hash}/index.html`, { method: 'POST' }),
      head: await get(`/content/${hash}/index.html`, { method: 'HEAD' }),
      range: await get(`/content/${hash}/index.html`, { headers: { Range: 'bytes=0-3' } })
    };
  }, hash);
  expect(results.wrongHash.status).toBe(403); expect(results.missing.status).toBe(404); expect(results.traversal.status).toBe(400); expect(results.method.status).toBe(405);
  expect(results.head).toMatchObject({ status: 200, text: '', nosniff: 'nosniff' });
  expect(results.range.status).toBe(200); expect(results.range.text).toContain('Hello, peer!');
  const stranger = await a.context.newPage(); await stranger.goto(VIEWER);
  expect(await stranger.evaluate(async hash => (await fetch(`/content/${hash}/index.html`)).status, hash)).toBe(503);
  await a.context.close();
});

test('worker restart and bootstrap reload rebuild the dedicated session bridge', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page); await open(a.page, hash);
  await expect(content(a.page).locator('h1')).toHaveText('Hello, peer!');
  const cdp = await a.context.newCDPSession(a.page);
  await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers');
  await content(a.page).locator('a').click();
  await expect(content(a.page).locator('h1')).toHaveText('Relatív aloldal');
  await a.page.reload(); await a.page.waitForFunction(() => (window as any).htppt && navigator.serviceWorker.controller);
  await open(a.page, hash); await expect(content(a.page).locator('h1')).toHaveText('Hello, peer!');
  await a.context.close();
});

test('a worker version update replaces the shell cache and reconnects without relaxing isolation', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page); await open(a.page, hash);
  await expect(content(a.page).locator('h1')).toHaveText('Hello, peer!');
  const path = 'apps/viewer/dist/sw.js', source = await readFile(path, 'utf8');
  const version = `htppt-shell-viewer-update-${Date.now()}`;
  const changed = source.replace(/htppt-shell-viewer-\d+/g, version);
  expect(changed).not.toBe(source);
  try {
    await writeFile(path, changed);
    const bootstrap = a.page.frames().find(f => f.url().startsWith(VIEWER))!;
    await bootstrap.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    await expect.poll(() => bootstrap.evaluate(() => caches.keys())).toContain(version);
    await content(a.page).locator('a').click(); await expect(content(a.page).locator('h1')).toHaveText('Relatív aloldal');
    expect(await content(a.page).locator('body').evaluate(() => window.origin)).toBe('null');
  } finally { await writeFile(path, source); await a.context.close(); }
});

test('many referenced assets are queued below the bridge pending limit', async ({ browser }) => {
  const a = await fresh(browser);
  const hash = await a.page.evaluate(() => {
    const files = Array.from({ length: 60 }, (_, n) => ({ path: `${n}.svg`, bytes: new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="green"/><!--${n}--></svg>`) }));
    files.push({ path: 'home.html', bytes: new TextEncoder().encode(`<h1>Many assets</h1>${files.map(f => `<img src="${f.path}" width="16">`).join('')}`) });
    return (window as any).htppt.engine.publish(files, { entrypoint: 'home.html' });
  });
  await open(a.page, hash); await expect(content(a.page).locator('h1')).toHaveText('Many assets');
  await expect(content(a.page).locator('img')).toHaveCount(60);
  expect(await content(a.page).locator('img').evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await a.context.close();
});
