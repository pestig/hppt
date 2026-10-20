import { test, expect } from '@playwright/test';
import { fresh, start, stop, publish, pin } from './helpers';
test.beforeAll(start); test.afterAll(() => stop());

test('real A → B transfer and B → fresh C after A closes; pin/reload reseeds', async ({ browser }) => {
  const a = await fresh(browser), b = await fresh(browser);
  const hash = await publish(a.page);
  expect((await a.page.evaluate(() => (window as any).htppt.engine.getStats())).downloaded).toBe(0);
  await b.page.evaluate(async hash => { const e = (window as any).htppt.engine; await e.open(hash); await e.pin(hash); }, hash);
  const stats = await b.page.evaluate(() => (window as any).htppt.engine.getStats());
  expect(stats.peers).toBeGreaterThan(0); expect(stats.verifiedBytes).toBeGreaterThan(100); expect(stats.downloaded).toBeGreaterThan(100);
  await a.context.close();
  const c = await fresh(browser);
  expect(await c.page.evaluate(async hash => { const e = (window as any).htppt.engine; await e.open(hash); return new TextDecoder().decode((await e.readFile(hash, 'index.html')).bytes); }, hash)).toContain('Hello, peer!');
  await c.context.close();
  await b.page.reload(); await b.page.waitForFunction(() => (window as any).htppt && navigator.serviceWorker.controller);
  await b.page.evaluate(hash => (window as any).htppt.engine.restore(hash), hash);
  const d = await fresh(browser);
  await d.page.evaluate(async hash => { const e = (window as any).htppt.engine; await e.open(hash); await e.pin(hash); }, hash);
  expect(await d.page.evaluate(() => (window as any).htppt.engine.getStats())).toMatchObject({ peers: 1 });
  await d.context.close(); await b.context.close();
});

test('finite timeout when no seeder exists, then retry remains possible', async ({ browser }) => {
  const b = await fresh(browser);
  const result = await b.page.evaluate(async () => {
    try { await (window as any).htppt.engine.open('f'.repeat(40)); return 'unexpected'; }
    catch (e) { return (e as Error).message; }
  });
  expect(result).toContain('timed out');
  const a = await fresh(browser), hash = await publish(a.page);
  await pin(b.page, hash); await a.context.close(); await b.context.close();
});

test('durable corruption is rejected and partial storage never receives the offline marker', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page);
  await a.page.evaluate(async hash => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('htppt-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(new Uint8Array([1, 2, 3]), `${hash}/index.html`); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  }, hash);
  await expect(a.page.evaluate(hash => (window as any).htppt.engine.readFile(hash, 'index.html'), hash)).rejects.toThrow('Integrity');
  await a.page.evaluate(() => (window as any).htppt.library());
  await expect(a.page.locator('#sites')).not.toContainText('Available offline');
  await a.context.close();
});

test('tracker outage blocks fresh discovery without invalidating cached content', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page);
  await stop('tracker');
  const b = await fresh(browser);
  await expect(b.page.evaluate(hash => (window as any).htppt.engine.open(hash), hash)).rejects.toThrow('timed out');
  expect(await a.page.evaluate(async hash => (await (window as any).htppt.engine.readFile(hash, 'index.html')).bytes.length, hash)).toBeGreaterThan(100);
  await a.context.close(); await b.context.close();
  await stop(); await start();
});
