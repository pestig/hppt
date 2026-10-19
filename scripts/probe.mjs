import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true });
try {
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext();
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', e => console.error('PAGE:', e.message));
    page.on('console', m => { if (m.type() === 'error') console.error('BROWSER:', m.text()); });
    await page.goto('http://localhost:5173');
    await page.waitForFunction(() => window.htppt && navigator.serviceWorker.controller);
    await page.evaluate(relay => { window.htppt.config.policy = relay ? 'relay' : 'all'; }, process.argv.includes('--relay'));
  }
  const [a, b] = pages;
  const hash = await a.evaluate(async () => await window.htppt.engine.publish([{ path: 'home.html', bytes: new TextEncoder().encode('<h1>Real P2P</h1>') }], { entrypoint: 'home.html' }));
  console.log('Published:', hash);
  let result;
  try { result = await b.evaluate(async hash => { const e = window.htppt.engine; await e.open(hash); return new TextDecoder().decode((await e.readFile(hash, 'home.html')).bytes); }, hash); }
  catch (error) { for (const p of pages) console.error(JSON.stringify(await p.evaluate(async () => ({ stats: await window.htppt.engine.getStats(), torrents: window.htppt.engine.client?.torrents.map(t => ({ hash: t.infoHash, ready: t.ready, peers: t.numPeers, tracker: t.announce })) })), null, 2)); throw error; }
  assert.equal(result, '<h1>Real P2P</h1>');
  await b.waitForTimeout(1500);
  const stats = await Promise.all(pages.map(p => p.evaluate(() => window.htppt.engine.getStats())));
  console.log(JSON.stringify(stats, null, 2));
  if (process.argv.includes('--relay')) for (const s of stats) assert(s.pairs.some(p => p.policy === 'relay' && p.local === 'relay' && p.remote === 'relay' && p.dataSent + p.dataReceived > 0));
  console.log('Browser → browser transport verified.');
} finally { await browser.close(); }
