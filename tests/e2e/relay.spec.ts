import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { APP, fresh, gatewayHeaders, start, startTurn, stop, publish, pin, turnSecret } from './helpers';
test.skip(!process.env.RELAY_TEST, 'Separate required relay job: npm run test:relay');
test.beforeAll(start); test.afterAll(() => stop());
test('both peers select relay pairs and exchange actual datachannel bytes', async ({ browser }) => {
  const a = await fresh(browser), b = await fresh(browser), hash = await publish(a.page);
  await pin(b.page, hash);
  for (const page of [a.page, b.page]) await expect.poll(async () => {
    const stats = await page.evaluate(() => (window as any).htppt.engine.getStats());
    return stats.pairs.some((pair: any) => pair.policy === 'relay' && pair.local === 'relay' && pair.remote === 'relay' && pair.state === 'succeeded' && pair.dataSent + pair.dataReceived > 0);
  }).toBe(true);
  await a.context.close(); await b.context.close();
});
test('bad TURN credentials fail on fresh relay-only connections, with no direct fallback', async ({ browser }) => {
  const a = await fresh(browser), hash = await publish(a.page);
  const b = await fresh(browser);
  // Negative fixture modifies the API response, never production validation.
  await b.page.route('**/ice', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), ...gatewayHeaders } }); const data = await response.json();
    for (const s of data.iceServers) if (s.credential) s.credential = 'intentionally-wrong-test-credential';
    await route.fulfill({ response, json: data });
  });
  await expect(b.page.evaluate(hash => (window as any).htppt.engine.open(hash), hash)).rejects.toThrow('timed out');
  expect((await b.page.evaluate(() => (window as any).htppt.engine.getStats())).pairs).toEqual([]);
  await a.context.close(); await b.context.close();
});

test('stopping TURN disconnects existing peers and prevents new relay-only connections', async ({ browser }) => {
  test.setTimeout(100000);
  const a = await fresh(browser), b = await fresh(browser), hash = await publish(a.page);
  await pin(b.page, hash);
  await stop('turn');
  const c = await fresh(browser);
  await expect(c.page.evaluate(hash => (window as any).htppt.engine.open(hash), hash)).rejects.toThrow('timed out');
  await expect.poll(async () => b.page.evaluate(() => {
    const client = (window as any).htppt.engine.client;
    return client.torrents.every((t: any) => [...(t._peers?.values() || [])].every((p: any) => !p.conn?._pc || ['disconnected', 'failed', 'closed'].includes(p.conn._pc.connectionState)));
  }), { timeout: 45000 }).toBe(true);
  await b.page.locator('#refresh-library').click(); await expect(b.page.locator('#sites')).toContainText('Available offline');
  await a.context.close(); await b.context.close(); await c.context.close(); await startTurn();
});

test('expired TURN REST credentials reject fresh peers; renewal retains the working connection', async ({ browser }) => {
  test.setTimeout(90000);
  const a = await fresh(browser), b = await fresh(browser);
  const expiresAt = Math.floor(Date.now() / 1000) + 9;
  const username = `${expiresAt}:short-lived-fixture`;
  const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
  const shortIce = { iceServers: [{ urls: ['turn:127.0.0.1:3488?transport=udp'], username, credential }], expiresAt };
  await b.page.route('**/ice', route => route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': APP, 'Access-Control-Allow-Credentials': 'true', 'Cache-Control': 'no-store' }, json: shortIce }));
  const hash = await publish(a.page); await pin(b.page, hash);
  await b.page.evaluate(() => { const e = (window as any).htppt.engine; (window as any).originalPC = [...e.client.torrents[0]._peers.values()].find((p: any) => p.conn?._pc)?.conn._pc; });
  await expect.poll(() => Date.now() > (expiresAt + 1) * 1000, { timeout: 12000 }).toBe(true);
  await b.page.unroute('**/ice');
  await b.page.route('**/ice', route => route.continue({ headers: { ...route.request().headers(), ...gatewayHeaders } }));
  await b.page.evaluate(hash => (window as any).htppt.engine.restore(hash), hash);
  expect(await b.page.evaluate(() => { const pc = (window as any).originalPC; return pc.connectionState === 'connected' && [...(window as any).htppt.engine.client.torrents[0]._peers.values()].some((p: any) => p.conn?._pc === pc); })).toBe(true);
  const c = await fresh(browser);
  await c.page.route('**/ice', route => route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': APP, 'Access-Control-Allow-Credentials': 'true' }, json: { ...shortIce, expiresAt: Math.floor(Date.now() / 1000) + 3600 } }));
  await expect(c.page.evaluate(hash => (window as any).htppt.engine.open(hash), hash)).rejects.toThrow('timed out');
  const d = await fresh(browser); await pin(d.page, hash);
  await a.context.close(); await b.context.close(); await c.context.close(); await d.context.close();
});
