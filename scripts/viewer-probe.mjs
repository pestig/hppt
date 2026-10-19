import { chromium } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
const browser = await chromium.launch();
try {
  const a = await (await browser.newContext()).newPage(), b = await (await browser.newContext()).newPage();
  for (const p of [a, b]) {
    p.on('pageerror', e => console.log('ERROR', e.message));
    p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
    await p.goto('http://app.hppt.localhost:5173'); await p.waitForFunction(() => window.htppt && navigator.serviceWorker.controller);
  }
  const files = [];
  for (const f of await readdir('fixtures/hello-site', { recursive: true, withFileTypes: true })) if (f.isFile()) {
    const path = `${f.parentPath}/${f.name}`; files.push({ path: path.slice('fixtures/hello-site/'.length), bytes: [...await readFile(path)] });
  }
  const hash = await a.evaluate(async files => window.htppt.engine.publish(files.map(f => ({ ...f, bytes: new Uint8Array(f.bytes) })), { entrypoint: 'index.html' }), files);
  const opening = b.waitForEvent('popup');
  await b.evaluate(hash => window.htppt.open(`web+hppt://${hash}`), hash);
  const viewer = await opening;
  await viewer.locator('h1').waitFor();
  console.log('VIEWER', viewer.url(), 'frames:', viewer.frames().length);
  console.log('BODY', (await viewer.locator('body').innerText()).slice(0, 900));
  await viewer.screenshot({ path: '/tmp/hppt-viewer.png', fullPage: true });
} finally { await browser.close(); }
