import { test, expect, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP, ready, publish, start, stop, content, buildDirectories, trackViewers } from './helpers';

const originalDirectory = buildDirectories.web;
let directory: string;
let workerPath: string;
let currentWorker: Buffer;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'htppt-upgrade-'));
  await cp(originalDirectory, directory, { recursive: true });
  workerPath = join(directory, 'sw.js');
  currentWorker = await readFile(workerPath);
  buildDirectories.web = directory;
  await start();
});
test.afterEach(async () => { await writeFile(workerPath, currentWorker); });
test.beforeEach(({ page }) => { trackViewers(page); });
test.afterAll(async () => {
  await stop();
  buildDirectories.web = originalDirectory;
  if (directory) await rm(directory, { recursive: true, force: true });
});

// Reproduce the previous release's cache-first navigation and lack of a reload
// listener. Do not clear site storage: the update must preserve saved packages.
async function legacyShell(page: Page, origin: string) {
  const setup = `${origin}/legacy-setup`;
  await page.route(setup, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Update setup</title>' }));
  await page.goto(setup);
  // Serve two actual worker versions: browser worker-update fetches cannot be
  // simulated reliably with page.route. Only generated build output is changed.
  await writeFile(workerPath, `
    const shell = 'htppt-shell-legacy-update-test';
    self.addEventListener('install', event => event.waitUntil((async () => {
      const cache = await caches.open(shell);
      await cache.put('/index.html', new Response('<!doctype html><h1>Legacy cached application</h1>', { headers: { 'Content-Type': 'text/html' } }));
      await self.skipWaiting();
    })()));
    self.addEventListener('activate', event => event.waitUntil((async () => {
      for (const name of await caches.keys()) if (name.startsWith('htppt-shell-') && name !== shell) await caches.delete(name);
      await self.clients.claim();
    })()));
    self.addEventListener('message', event => event.ports[0]?.postMessage('legacy'));
    self.addEventListener('fetch', event => {
      if (event.request.mode === 'navigate' && ['/', '/index.html', '/open'].includes(new URL(event.request.url).pathname)) {
        event.respondWith(caches.open(shell).then(cache => cache.match('/index.html')));
      }
    });
  `);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/', updateViaCache: 'none' });
  });
  await expect.poll(() => page.evaluate(() => new Promise<boolean>(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 200);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data === 'legacy'); };
    navigator.serviceWorker.controller?.postMessage('version', [channel.port2]);
  }))).toBe(true);
  return async () => {
    await writeFile(workerPath, currentWorker);
    await page.evaluate(() => { void navigator.serviceWorker.getRegistration().then(registration => registration!.update()); });
  };
}

test('a cached legacy app reloads on upgrade and retains its saved package', async ({ page }) => {
  await ready(page);
  const hash = await publish(page);
  const update = await legacyShell(page, APP);
  await page.goto(`${APP}/open?source=upgrade#library`);
  await expect(page.locator('h1')).toHaveText('Legacy cached application');
  await update();
  await expect(page.locator('#sites')).toContainText(hash);
  await expect(page.locator('#sites')).toContainText('Offline elérhető');
  await expect(page).toHaveURL(`${APP}/open?source=upgrade#library`);
  await page.locator('#sites button', { hasText: 'Megnyitás' }).click();
  await expect(content(page).locator('h1')).toHaveText('Hello, peer!');
});

test('a cached legacy app on the loopback alias upgrades and redirects to APP_ORIGIN', async ({ page }) => {
  const alias = APP.replace(new URL(APP).hostname, '127.0.0.1');
  const update = await legacyShell(page, alias);
  const suffix = '/open?source=upgrade#publish';
  await page.goto(`${alias}${suffix}`);
  await expect(page.locator('h1')).toHaveText('Legacy cached application');
  await update();
  await expect(page).toHaveURL(`${APP}${suffix}`);
  await page.waitForFunction(() => (window as any).htppt && navigator.serviceWorker.controller);
  const hash = await publish(page);
  await page.evaluate(() => (window as any).htppt.library());
  await expect(page.locator('#sites')).toContainText(hash);
  await page.locator('#sites button', { hasText: 'Megnyitás' }).click();
  await expect(content(page).locator('h1')).toHaveText('Hello, peer!');
});
