import { chromium } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
const browser = await chromium.launch();
try {
  const a = await (await browser.newContext()).newPage(), b = await (await browser.newContext()).newPage();
  for (const p of [a, b]) {
    p.on('pageerror', e => console.log('ERROR', e.message));
    p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
    p.on('response', async r => { if (r.url().includes('/content/')) console.log(r.status(), r.url(), r.status() === 200 ? '' : await r.text().catch(() => '')); });
    await p.goto('http://localhost:5173'); await p.waitForFunction(() => window.htppt && navigator.serviceWorker.controller);
  }
  const files = [];
  for (const f of await readdir('fixtures/hello-site', { recursive: true, withFileTypes: true })) if (f.isFile()) {
    const path = `${f.parentPath}/${f.name}`; files.push({ path: path.slice('fixtures/hello-site/'.length), bytes: [...await readFile(path)] });
  }
  const hash = await a.evaluate(async files => window.htppt.engine.publish(files.map(f => ({ ...f, bytes: new Uint8Array(f.bytes) })), { entrypoint: 'index.html' }), files);
  await b.evaluate(hash => window.htppt.open(`web+hppt://${hash}`), hash);
  await b.waitForTimeout(5000);
  console.log('FRAMES', b.frames().map(f => f.url()));
  for (const frame of b.frames()) console.log('BODY', (await frame.locator('body').innerText()).slice(0, 900));
  await b.screenshot({ path: '/tmp/htppt-viewer.png', fullPage: true });
} finally { await browser.close(); }
