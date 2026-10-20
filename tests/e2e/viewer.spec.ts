import { test, expect } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { siteOrigin } from '../../packages/protocol/site';
import { fresh, start, stop, publish, open, content, VIEWER, buildDirectories, ready } from './helpers';
const originalDirectory = buildDirectories.viewer;
let directory: string;
test.beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'hppt-viewer-test-')); await cp(originalDirectory, directory, { recursive: true }); buildDirectories.viewer = directory; await start(); });
test.afterAll(async () => { await stop(); buildDirectories.viewer = originalDirectory; await rm(directory, { recursive: true, force: true }); });

test('a separate viewer window receives original P2P HTML, CSS, image and JavaScript bytes', async ({ browser }) => {
  const a = await fresh(browser), b = await fresh(browser);
  try {
    const hash = await publish(a.page); await open(b.page, hash);
    const viewer = content(b.page);
    await expect(viewer.locator('h1')).toHaveText('Hello, peer!');
    expect(viewer.frames()).toHaveLength(1);
    await expect(viewer).toHaveURL(`${siteOrigin(VIEWER, hash)}/index.html`);
    await expect(viewer.locator('body')).toHaveCSS('background-color', 'rgb(242, 245, 233)');
    expect(await viewer.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await viewer.locator('#hello').click(); await expect(viewer.locator('#result')).toContainText('JavaScript works');
    const original = await a.page.evaluate(async hash => [...(await (window as any).htppt.engine.readFile(hash, 'index.html')).bytes], hash);
    expect(await viewer.evaluate(async () => [...new Uint8Array(await (await fetch(location.href)).arrayBuffer())])).toEqual(original);
    expect(await viewer.evaluate(() => window.opener)).toBeNull();
    expect(await b.page.evaluate(() => typeof RTCPeerConnection)).toBe('function');
  } finally { await a.context.close(); await b.context.close(); }
});

test('native relative paths, custom entrypoint, CSS imports, query, fragment and explicit 404', async ({ page }) => {
  await ready(page);
  await page.locator('#folder').setInputFiles(resolve('fixtures/nested-site'));
  await expect(page.locator('#publish-button')).toBeDisabled();
  await page.locator('#entrypoint').selectOption('pages/home.html'); await page.locator('#publish-button').click();
  await expect(page.locator('#share-uri')).toHaveValue(/^web\+hppt:\/\/[a-f0-9]{40}$/);
  const hash = (await page.locator('#share-uri').inputValue()).slice('web+hppt://'.length);
  await open(page, hash, '/?start=1#hello'); const viewer = content(page);
  await expect(viewer).toHaveURL(`${siteOrigin(VIEWER, hash)}/pages/home.html?start=1#hello`);
  await expect(viewer.locator('h1')).toHaveText('Nested home');
  await expect(viewer.locator('body')).toHaveCSS('background-color', 'rgb(242, 245, 233)');
  expect(await viewer.locator('body').evaluate(el => getComputedStyle(el).backgroundImage)).toContain('/leaf.svg');
  await viewer.locator('#hello').click(); await expect(viewer.locator('#result')).toHaveText('Nested JS works');
  await viewer.locator('#next').click(); await expect(viewer).toHaveURL(`${siteOrigin(VIEWER, hash)}/about.html?from=nested#detail`);
  await expect(viewer.locator('h1')).toHaveText('Nested about');
  const response = await Promise.all([viewer.waitForResponse(r => r.url().endsWith('/missing.html')), viewer.locator('#missing').click()]);
  expect(response[0].status()).toBe(404); await expect(viewer.locator('body')).toContainText('File not found');
  await viewer.goto(`${siteOrigin(VIEWER, hash)}/?root=1#hello`);
  await expect(viewer).toHaveURL(`${siteOrigin(VIEWER, hash)}/pages/home.html?root=1#hello`);
});

test('native ES modules, body attributes, location and same-site fetch work without a renderer', async ({ page }) => {
  await ready(page);
  const hash = await page.evaluate(() => (window as any).htppt.engine.publish([
    { path: 'pages/home.html', bytes: new TextEncoder().encode('<!doctype html><html lang="en"><head><title>Native site</title><link rel="stylesheet" href="../style.css"></head><body class="native"><h1>Native page</h1><p id="result"></p><script type="module" src="../js/main.js"></script></body></html>') },
    { path: 'style.css', bytes: new TextEncoder().encode('body.native{background:rgb(10, 20, 30)}') },
    { path: 'js/main.js', bytes: new TextEncoder().encode('import {label} from "./label.js"; const data=await fetch("../data.json").then(r=>r.json());document.querySelector("#result").textContent=label+":"+data.value+":"+location.pathname;') },
    { path: 'js/label.js', bytes: new TextEncoder().encode('export const label="module";') },
    { path: 'data.json', bytes: new TextEncoder().encode('{"value":42}') }
  ], { entrypoint: 'pages/home.html' }));
  await open(page, hash); const viewer = content(page);
  await expect(viewer).toHaveTitle('Native site');
  await expect(viewer.locator('html')).toHaveAttribute('lang', 'en');
  await expect(viewer.locator('body')).toHaveClass('native');
  await expect(viewer.locator('body')).toHaveCSS('background-color', 'rgb(10, 20, 30)');
  await expect(viewer.locator('#result')).toHaveText('module:42:/pages/home.html');
});

test('the site worker enforces manifest paths, methods, HEAD and full-200 Range', async ({ page }) => {
  await ready(page); const hash = await publish(page); await open(page, hash); const viewer = content(page);
  await expect(viewer.locator('h1')).toHaveText('Hello, peer!');
  const results = await viewer.evaluate(async () => {
    const get = async (path: string, init?: RequestInit) => { const r = await fetch(path, init); return { status: r.status, text: await r.text(), nosniff: r.headers.get('x-content-type-options') }; };
    return { missing: await get('/missing.html'), private: await get('/__hppt/authority'), traversal: await get('/%252e%252e/index.html'), method: await get('/index.html', { method: 'POST' }), head: await get('/index.html', { method: 'HEAD' }), range: await get('/index.html', { headers: { Range: 'bytes=0-3' } }) };
  });
  expect(results.missing.status).toBe(404); expect(results.private.status).toBe(404); expect(results.traversal.status).toBe(400); expect(results.method.status).toBe(405);
  expect(results.head).toMatchObject({ status: 200, text: '', nosniff: 'nosniff' }); expect(results.range.text).toContain('Hello, peer!');
  expect((await page.request.get(`${VIEWER.replace(new URL(VIEWER).hostname, '127.0.0.1')}/index.html`, { headers: { Host: new URL(siteOrigin(VIEWER, hash)).host } })).status()).toBe(503);
});

test('a stopped worker reconnects to the open app for an uncached file', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page); await open(a.page, hash); const viewer = content(a.page);
  await expect(viewer.locator('h1')).toHaveText('Hello, peer!');
  await viewer.evaluate(async () => (await caches.open('hppt-site-files-v1')).delete('/__hppt/verified/pages/about.html'));
  const cdp = await a.context.newCDPSession(viewer); await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers');
  await viewer.locator('a').click(); await expect(viewer.locator('h1')).toHaveText('Relative subpage');
  await a.page.reload(); await a.page.waitForFunction(() => (window as any).htppt && navigator.serviceWorker.controller);
  await open(a.page, hash); await expect(content(a.page).locator('h1')).toHaveText('Hello, peer!');
  await a.context.close();
});

test('updating a site worker retains native content and its isolated origin', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page); await open(a.page, hash); const viewer = content(a.page);
  await expect(viewer.locator('h1')).toHaveText('Hello, peer!');
  const path = join(directory, 'sw.js'), source = await readFile(path, 'utf8');
  const version = `htppt-shell-viewer-update-${Date.now()}`;
  const changed = source.replace(/htppt-shell-viewer-\d+/g, version); expect(changed).not.toBe(source);
  try {
    await writeFile(path, changed);
    // worker-src deliberately blocks content from creating a new registration;
    // the existing registration can still receive its normal browser update.
    const helper = a.page.frames().find(f => new URL(f.url()).origin === siteOrigin(VIEWER, hash))!;
    await helper.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    await expect.poll(() => viewer.evaluate(() => caches.keys())).toContain(version);
    await viewer.locator('a').click(); await expect(viewer.locator('h1')).toHaveText('Relative subpage');
    expect(await viewer.evaluate(() => location.origin)).toBe(siteOrigin(VIEWER, hash));
  } finally { await writeFile(path, source); await a.context.close(); }
});

test('many native resource requests are queued below the bridge pending limit', async ({ page }) => {
  await ready(page);
  const hash = await page.evaluate(() => {
    const files = Array.from({ length: 60 }, (_, n) => ({ path: `${n}.svg`, bytes: new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/><!--${n}--></svg>`) }));
    files.push({ path: 'home.html', bytes: new TextEncoder().encode(`<h1>Many assets</h1>${files.map(f => `<img src="${f.path}" width="16">`).join('')}`) });
    return (window as any).htppt.engine.publish(files, { entrypoint: 'home.html' });
  });
  await open(page, hash); const viewer = content(page);
  await expect(viewer.locator('img')).toHaveCount(60);
  await expect.poll(() => viewer.locator('img').evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
});

test('blocked popups leave a working explicit link to the prepared site', async ({ page, context }) => {
  await ready(page); const hash = await publish(page);
  await page.evaluate(() => { window.open = () => null; });
  await page.locator('#uri').fill(`web+hppt://${hash}`); await page.locator('#open-button').click();
  await expect(page.locator('#status')).toContainText('click');
  await expect(page.locator('#viewer-link')).toHaveAttribute('href', `${siteOrigin(VIEWER, hash)}/index.html`);
  const opened = context.waitForEvent('page'); await page.locator('#viewer-link').click(); const viewer = await opened;
  await expect(viewer.locator('h1')).toHaveText('Hello, peer!'); expect(viewer.frames()).toHaveLength(1);
});
