import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP, ready, publish, start, stop, open, content } from './helpers';
test.beforeAll(start); test.afterAll(() => stop());
test('loopback alias redirects to the configured origin before publishing and opening a site', async ({ page }) => {
  const iceOrigins: Promise<string | undefined>[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/ice') iceOrigins.push(request.allHeaders().then(headers => headers.origin));
  });
  const suffix = '/open?source=alias#publish';
  await page.goto(`${APP.replace('localhost', '127.0.0.1')}${suffix}`);
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
  let context = await chromium.launchPersistentContext(profile);
  try {
    const page = await context.newPage(); await ready(page);
    const hash = await publish(page);
    await page.evaluate(() => (window as any).htppt.library());
    await expect(page.locator('#sites')).toContainText('Offline elérhető');
    await open(page, hash); await expect(content(page).locator('h1')).toHaveText('Hello, peer!');
    await context.close(); await stop();
    context = await chromium.launchPersistentContext(profile);
    await context.setOffline(true);
    const offline = await context.newPage();
    await offline.goto(`${APP}/open?uri=${encodeURIComponent(`web+hppt://${hash}`)}`);
    await offline.waitForFunction(() => (window as any).htppt && navigator.serviceWorker.controller);
    await expect(offline.locator('h1')).toContainText('Adj otthont egy oldalnak');
    await expect(offline.locator('#sites')).toContainText('Offline elérhető');
    expect(await offline.evaluate(async hash => new TextDecoder().decode((await (window as any).htppt.engine.readFile(hash, 'index.html')).bytes), hash)).toContain('Hello, peer!');
    await expect(content(offline).locator('h1')).toHaveText('Hello, peer!');
    await content(offline).locator('#hello').click(); await expect(content(offline).locator('#result')).toContainText('JavaScript működik');
    await content(offline).locator('a').click(); await expect(content(offline).locator('h1')).toHaveText('Relatív aloldal');
    await expect(content(offline).locator('body')).toHaveCSS('background-color', 'rgb(242, 245, 233)');
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); await start(); }
});
