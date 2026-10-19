import { test, expect } from '@playwright/test';
import { APP, VIEWER, ready, publish, fresh, start, stop } from './helpers';
import { siteOrigin } from '../../packages/protocol/site';

const entry = (uri: string) => `${APP}/open?uri=${encodeURIComponent(uri)}`;
test.beforeAll(start); test.afterAll(() => stop());

test('a saved protocol link navigates its own tab without a controller or network client', async ({ page, context }) => {
  await ready(page);
  const hash = await publish(page, 'nested-site', 'pages/home.html');
  await page.evaluate(() => (window as any).htppt.library());
  await expect(page.locator('#sites')).toContainText('Offline elérhető');
  await page.close();
  const launcher = await context.newPage();
  const network: string[] = [];
  context.on('request', request => { if (/\/ice(?:\?|$)|:8100/.test(request.url())) network.push(request.url()); });
  await launcher.addInitScript(() => {
    window.open = () => { throw new Error('A saved link must not open another tab'); };
    window.RTCPeerConnection = class { constructor() { throw new Error('A saved link must not start WebRTC'); } } as typeof RTCPeerConnection;
  });
  await launcher.goto(entry(`web+hppt://${hash}/?start=1#hello`));
  await expect(launcher).toHaveURL(`${siteOrigin(VIEWER, hash)}/pages/home.html?start=1#hello`);
  await expect(launcher.locator('h1')).toHaveText('Nested home');
  await expect(launcher.locator('body')).toHaveCSS('background-color', 'rgb(242, 245, 233)');
  await launcher.locator('#hello').click(); await expect(launcher.locator('#result')).toHaveText('Nested JS works');
  expect(context.pages()).toEqual([launcher]); expect(network).toEqual([]);
  expect(await launcher.evaluate(() => (window as any).htppt)).toBeUndefined();
  await launcher.goto(entry(`web+htppt://${hash}/about.html?explicit=1#detail`));
  await expect(launcher).toHaveURL(`${siteOrigin(VIEWER, hash)}/about.html?explicit=1#detail`);
  await expect(launcher.locator('h1')).toHaveText('Nested about');
});

test('an uncached protocol link reuses the live app and renders in the entry tab', async ({ browser }) => {
  const a = await fresh(browser), b = await fresh(browser);
  try {
    const hash = await publish(a.page, 'nested-site', 'pages/home.html');
    const launcher = await b.context.newPage();
    await launcher.addInitScript(() => { window.open = () => { throw new Error('The existing controller must be reused'); }; });
    await launcher.goto(entry(`web+hppt://${hash}?from=protocol#hello`));
    await expect(launcher).toHaveURL(`${siteOrigin(VIEWER, hash)}/pages/home.html?from=protocol#hello`);
    await expect(launcher.locator('h1')).toHaveText('Nested home');
    await expect(launcher.locator('body')).toHaveCSS('background-color', 'rgb(242, 245, 233)');
    expect(b.context.pages()).toHaveLength(2);
    await expect(b.page).toHaveURL(APP + '/');
    await expect(b.page.locator('#viewer-link')).toHaveAttribute('href', launcher.url());
    expect(await b.page.evaluate(() => (window as any).htppt.engine.client.torrents.length)).toBeGreaterThan(0);
    // Force a subsequent read through the live controller after navigation.
    await launcher.evaluate(async () => (await caches.open('hppt-site-files-v1')).delete('/__hppt/verified/about.html'));
    await launcher.locator('#next').click(); await expect(launcher.locator('h1')).toHaveText('Nested about');
  } finally { await a.context.close(); await b.context.close(); }
});

test('a first download starts a separate app with an explicit fallback for blocked popups', async ({ browser }) => {
  const a = await fresh(browser), context = await browser.newContext();
  try {
    const hash = await publish(a.page);
    const launcher = await context.newPage();
    await launcher.addInitScript(() => { (window as any).originalOpen = window.open; window.open = () => null; });
    await launcher.goto(entry(`web+hppt://${hash}/index.html?new=1#hello`));
    await expect(launcher.locator('#start-app')).toBeVisible();
    expect(context.pages()).toHaveLength(1);
    await launcher.evaluate(() => { window.open = (window as any).originalOpen; });
    const appOpened = context.waitForEvent('page');
    await launcher.locator('#start-app').click();
    const controller = await appOpened;
    await expect(controller).toHaveURL(APP + '/');
    await expect(launcher).toHaveURL(`${siteOrigin(VIEWER, hash)}/index.html?new=1#hello`);
    await expect(launcher.locator('h1')).toHaveText('Hello, peer!');
    expect(context.pages()).toHaveLength(2); expect(launcher.frames()).toHaveLength(1);
    await expect(controller.locator('#viewer-link')).toHaveAttribute('href', launcher.url());
    await launcher.locator('#hello').click(); await expect(launcher.locator('#result')).toContainText('JavaScript működik');
  } finally { await a.context.close(); await context.close(); }
});

test('automatic controller startup keeps the protocol tab as the viewer', async ({ browser }) => {
  const a = await fresh(browser), context = await browser.newContext();
  try {
    const hash = await publish(a.page), launcher = await context.newPage();
    const appOpened = context.waitForEvent('page');
    await launcher.goto(entry(`web+hppt://${hash}`));
    const controller = await appOpened;
    await expect(launcher).toHaveURL(`${siteOrigin(VIEWER, hash)}/index.html`);
    await expect(launcher.locator('h1')).toHaveText('Hello, peer!');
    await expect(controller).toHaveURL(APP + '/');
    expect(context.pages()).toHaveLength(2);
  } finally { await a.context.close(); await context.close(); }
});

test('invalid links and explicit missing files show an error without entrypoint fallback', async ({ page, context }) => {
  await ready(page); const hash = await publish(page);
  const launcher = await context.newPage();
  for (const uri of [`web+hppt://${hash}/missing.html`, `web+hppt://${hash}/../index.html`, 'https://example.com/']) {
    await launcher.goto(entry(uri));
    await expect(launcher.locator('#status')).toHaveClass('error');
    await expect(launcher.locator('#retry')).toBeVisible();
    await expect(launcher).toHaveURL(entry(uri));
    expect(context.pages()).toHaveLength(2);
    if (uri.includes('missing.html')) await expect(launcher.locator('#status')).toContainText('404');
  }
});

test('a direct viewer URL in a fresh profile discovers the open app and downloads from the publisher', async ({ browser }) => {
  const a = await fresh(browser), b = await fresh(browser);
  try {
    const hash = await publish(a.page, 'nested-site', 'pages/home.html');
    const viewer = await b.context.newPage();
    await viewer.addInitScript(() => { window.open = () => { throw new Error('The open app must be reused'); }; });
    const url = `${siteOrigin(VIEWER, hash)}/pages/home.html?mode=direct&value=a%26b#hello`;
    const responses: { status: number; worker: boolean; type: string }[] = [];
    viewer.on('response', response => {
      if (response.url() === url.split('#')[0]) responses.push({ status: response.status(), worker: response.fromServiceWorker(), type: response.headers()['content-type'] || '' });
    });
    await viewer.goto(url);
    await expect(viewer).toHaveURL(url);
    await expect(viewer.locator('h1')).toHaveText('Nested home');
    await expect(viewer.locator('body')).toHaveCSS('background-color', 'rgb(242, 245, 233)');
    await viewer.locator('#hello').click(); await expect(viewer.locator('#result')).toHaveText('Nested JS works');
    expect(responses[0]).toMatchObject({ status: 302, worker: false });
    expect(responses.some(response => response.status === 200 && response.worker)).toBe(true);
    expect(responses.some(response => response.status === 200 && !response.worker)).toBe(false);
    expect(b.context.pages()).toHaveLength(2);
    expect(await b.page.evaluate(() => (window as any).htppt.engine.client.torrents.length)).toBeGreaterThan(0);
    await viewer.locator('#next').click(); await expect(viewer.locator('h1')).toHaveText('Nested about');
  } finally { await a.context.close(); await b.context.close(); }
});

test('a direct root viewer URL in a fresh profile resolves the manifest entrypoint', async ({ browser }) => {
  const a = await fresh(browser), b = await fresh(browser);
  try {
    const hash = await publish(a.page, 'nested-site', 'pages/home.html'), viewer = await b.context.newPage();
    await viewer.goto(`${siteOrigin(VIEWER, hash)}/?root=1#hello`);
    await expect(viewer).toHaveURL(`${siteOrigin(VIEWER, hash)}/pages/home.html?root=1#hello`);
    await expect(viewer.locator('h1')).toHaveText('Nested home');
    expect(b.context.pages()).toHaveLength(2);
  } finally { await a.context.close(); await b.context.close(); }
});

test('a direct explicit missing file in a fresh profile never opens the entrypoint', async ({ browser }) => {
  const a = await fresh(browser), b = await fresh(browser);
  try {
    const hash = await publish(a.page), viewer = await b.context.newPage();
    await viewer.goto(`${siteOrigin(VIEWER, hash)}/missing.html?missing=1#detail`);
    await expect(viewer.locator('#status')).toHaveClass('error');
    await expect(viewer.locator('#status')).toContainText('404');
    await expect(viewer.locator('#retry')).toBeVisible();
    const url = new URL(viewer.url());
    expect(url.origin).toBe(APP); expect(url.pathname).toBe('/open');
    expect(url.searchParams.get('uri')).toBe(`web+hppt://${hash}/missing.html?missing=1`);
    expect(url.hash).toBe('#detail');
    expect(b.context.pages()).toHaveLength(2);
  } finally { await a.context.close(); await b.context.close(); }
});
