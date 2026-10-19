import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP, ready, publish, start, stop, open, content, trackViewers } from './helpers';
import { browserOptions } from '../browser-options';
test.beforeAll(start); test.afterAll(() => stop());
test.beforeEach(({ page }) => { trackViewers(page); });
test('loopback alias redirects to the configured origin before publishing and opening a site', async ({ page }) => {
  const iceOrigins: Promise<string | undefined>[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/ice') iceOrigins.push(request.allHeaders().then(headers => headers.origin));
  });
  const suffix = '/open?source=alias#publish';
  await page.goto(`${APP.replace(new URL(APP).hostname, '127.0.0.1')}${suffix}`);
  await expect(page).toHaveURL(`${APP}${suffix}`);
  await page.waitForFunction(() => (window as any).htppt && navigator.serviceWorker.controller);
  await page.locator('#folder').setInputFiles(resolve('fixtures/hello-site'));
  await page.locator('#publish-button').click();
  await expect(page.locator('#sites')).toContainText('Offline elérhető');
  await page.locator('#sites button', { hasText: 'Megnyitás' }).click();
  await expect(content(page).locator('h1')).toHaveText('Hello, peer!');
  expect(iceOrigins.length).toBeGreaterThan(0);
  expect((await Promise.all(iceOrigins)).every(origin => origin === APP)).toBe(true);
});
test('UI directory import offers index.html and creates an offline package', async ({ page }) => {
  await ready(page);
  await expect(page).toHaveTitle('HPPT · Web a társaktól');
  await expect(page.getByRole('link', { name: 'HPPT kezdőlap' })).toHaveText('hppt0.1');
  await expect(page.locator('#uri')).toHaveAttribute('placeholder', 'web+hppt://…');
  await page.locator('#folder').setInputFiles(resolve('fixtures/hello-site'));
  await expect(page.locator('#entrypoint')).toHaveValue('index.html');
  await page.locator('#publish-button').click();
  await expect(page.locator('#sites')).toContainText('Offline elérhető');
  await expect(page.locator('#share-uri')).toHaveValue(/^web\+hppt:\/\/[a-f0-9]{40}$/);
});
test('complete UI, viewer and content restart offline after closing the browser and stopping all app servers', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'htppt-offline-'));
  let context = await chromium.launchPersistentContext(profile, browserOptions);
  try {
    const page = await context.newPage(); await ready(page);
    const hash = await publish(page);
    await page.evaluate(() => (window as any).htppt.library());
    await expect(page.locator('#sites')).toContainText('Offline elérhető');
    await open(page, hash); await expect(content(page).locator('h1')).toHaveText('Hello, peer!');
    const savedViewerURL = content(page).url();
    await context.close(); await stop();
    context = await chromium.launchPersistentContext(profile, browserOptions);
    await context.setOffline(true);
    // No controller window exists: the isolated site worker serves the saved
    // original files directly after a complete browser restart.
    const standalone = await context.newPage();
    await standalone.goto(savedViewerURL);
    await expect(standalone.locator('h1')).toHaveText('Hello, peer!');
    expect(standalone.frames()).toHaveLength(1);
    await standalone.locator('a').click();
    await expect(standalone.locator('h1')).toHaveText('Relatív aloldal');
    await standalone.close();
    const entry = await context.newPage();
    const network: string[] = [];
    context.on('request', request => { if (/\/ice(?:\?|$)|:8100/.test(request.url())) network.push(request.url()); });
    await entry.goto(`${APP}/open?uri=${encodeURIComponent(`web+hppt://${hash}/?offline=1#hello`)}`);
    await expect(entry).toHaveURL(`${new URL(savedViewerURL).origin}/index.html?offline=1#hello`);
    await expect(entry.locator('h1')).toHaveText('Hello, peer!');
    expect(context.pages().filter(p => new URL(p.url()).origin === APP)).toHaveLength(0);
    expect(network).toEqual([]);
    await entry.locator('#hello').click(); await expect(entry.locator('#result')).toContainText('JavaScript működik');
    await entry.close();
    const offline = await context.newPage();
    trackViewers(offline);
    await offline.goto(APP);
    await offline.waitForFunction(() => (window as any).htppt && navigator.serviceWorker.controller);
    await expect(offline.locator('h1')).toContainText('Adj otthont egy oldalnak');
    await expect(offline.locator('#sites')).toContainText('Offline elérhető');
    expect(await offline.evaluate(async hash => new TextDecoder().decode((await (window as any).htppt.engine.readFile(hash, 'index.html')).bytes), hash)).toContain('Hello, peer!');
    await open(offline, hash);
    await expect(content(offline).locator('h1')).toHaveText('Hello, peer!');
    await content(offline).locator('#hello').click(); await expect(content(offline).locator('#result')).toContainText('JavaScript működik');
    await content(offline).locator('a').click(); await expect(content(offline).locator('h1')).toHaveText('Relatív aloldal');
    await expect(content(offline).locator('body')).toHaveCSS('background-color', 'rgb(242, 245, 233)');
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); await start(); }
});
