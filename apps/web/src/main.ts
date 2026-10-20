import './style.css';
import { Engine, type Config } from '@htppt/p2p';
import { checkSite, listSites } from '../../../packages/p2p/storage';
import { encodePath, parseAddress, VERSION, type InputFile } from '@htppt/protocol';
import { Cleared, Hello, workerControl } from '@htppt/viewer-bridge';
import { siteOrigin, siteURL, VIEWER_BOOT } from '@htppt/protocol/site';
import { createSiteBridge, type SiteBridge } from './site-bridge';
import { serveLaunches } from './launch-channel';

document.querySelector('#app')!.innerHTML = `
<aside><a class="brand" href="/" aria-label="HPPT home">h<span>p</span>pt<span class="badge">0.1</span></a><p class="tagline">The web, peer to peer.</p><nav><a href="#publish">↥ &nbsp; Publish</a><a href="#browse">↗ &nbsp; Browse</a><a href="#library">▦ &nbsp; My library</a></nav><div class="aside-bottom"><span id="network" class="pill"></span><p>Keep this window open to share.</p><small>WebRTC · WebTorrent · SHA-256</small></div></aside>
<main><header><div><div class="eyebrow">HYPERTEXT PEER TO PEER TRANSFER PROTOCOL</div><h1>Host a site.<br><span>Share it with the world.</span></h1><p>Static websites shared directly between browsers.<br>Publish your folder and pass on the link.</p></div><div class="network-art" aria-hidden="true"><span>YOU</span><i>↔</i><span>PEER</span><small>direct connection</small></div></header>
<div class="columns"><section id="publish" class="card"><div class="section-number">01 / PUBLISH</div><h2>Turn your folder into a website</h2><label class="drop"><span class="upload-icon">↥</span><strong>Choose a website folder</strong><small>HTML, CSS, JavaScript and images · up to 50 MiB</small><input id="folder" type="file" webkitdirectory multiple aria-label="Website folder"></label><div class="entry"><label for="entrypoint">Entry page</label><select id="entrypoint"><option value="">Choose a folder first</option></select></div><p id="selection" class="muted">Your files stay in your browser.</p><button id="publish-button" class="primary" disabled>Publish and share ↗</button></section>
<section id="browse" class="card"><div class="section-number">02 / BROWSE</div><h2>One link. A new site.</h2><p class="muted">Paste an HPPT address and connect to the peers sharing it.</p><label for="uri">HPPT address</label><textarea id="uri" rows="3" placeholder="web+hppt://…" spellcheck="false"></textarea><button id="open-button" class="primary">Open site →</button><div class="protocol"><button id="register" class="text-button">Register protocol handler</button><small id="protocol-help">Pasting an address and using an HTTPS link work without registration.</small></div></section></div>
<div id="status" role="status" aria-live="polite">Starting…</div><div id="share" hidden><label>Shareable address</label><input id="share-uri" readonly><div class="actions"><button id="copy-uri">Copy HPPT address</button><button id="copy-https">Copy launch link</button></div></div>
<section id="viewer-section" hidden><div class="viewer-heading"><h2>The site opens in a new tab</h2><button id="close-viewer">Hide ×</button></div><p>Keep this app open to download and share.</p><div class="actions"><a id="viewer-link" target="_blank" rel="noopener">Open site in a new tab ↗</a><button id="pin-current">Save offline + pin</button></div></section>
<section id="library"><div class="section-head"><div><div class="section-number">03 / MY LIBRARY</div><h2>The web you host</h2></div><button id="refresh-library">Refresh ↻</button></div><div id="sites"></div></section>
<section class="diagnostics"><div class="section-head"><h2>Connection and transfer</h2><label>Mode for new connections <select id="policy"><option value="all">Direct + TURN</option><option value="relay">TURN relay only</option></select></label></div><div id="stats"></div><pre id="details"></pre></section><footer>Sites are published by other participants. The protocol does not provide anonymity.<br>Share public content only. The cache relies on data retained by your browser.</footer></main>`;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const config: Config = await fetch('/runtime-config.json').then(r => r.json());
// CORS, the viewer bridge and persistent storage all use this exact origin.
// In particular, localhost and 127.0.0.1 cannot be used interchangeably.
if (location.origin !== config.appOrigin) {
  const target = new URL(config.appOrigin);
  target.pathname = location.pathname;
  target.search = location.search;
  target.hash = location.hash;
  location.replace(target.href);
  // Do not start workers, storage or P2P while the navigation is pending.
  await new Promise<never>(() => {});
}
document.querySelector('.drop small')!.textContent = `HTML, CSS, JavaScript and images · up to ${config.limits.total / 1024 ** 2} MiB`;
const savedPolicy = localStorage.getItem('htppt-policy');
if (savedPolicy === 'relay' || savedPolicy === 'all') config.policy = savedPolicy;
const engine = new Engine(config);
let files: InputFile[] = [];
let shareHash = '';
let shareAddress = '';
let boot: Promise<void> = Promise.resolve();
let libraryGeneration = 0;
const bridges = new Map<string, SiteBridge>();
function message(text: string, error = false) { element('status').textContent = text; element('status').className = error ? 'error' : ''; }
async function action(task: () => Promise<unknown>) { try { await task(); } catch (error) { message(error instanceof Error ? error.message : String(error), true); } }
async function library() {
  const generation = ++libraryGeneration;
  const sites = document.createDocumentFragment();
  for (const site of await listSites()) {
    const valid = await checkSite(site, config.limits);
    let available = false;
    if (valid) { try { await prepareSite(site.hash, true); available = true; } catch { /* Keep the stored package visible so preparation can be retried. */ } }
    const row = document.createElement('article'); row.className = 'site';
    const title = document.createElement('strong'); title.textContent = site.manifest.entrypoint;
    const hash = document.createElement('code'); hash.textContent = site.hash;
    const state = document.createElement('span'); state.className = 'pill'; state.textContent = valid && available ? 'Available offline' : valid ? 'Package stored; viewer preparation required' : 'Incomplete local package';
    const meta = document.createElement('small'); meta.textContent = `${site.manifest.files.length} files · ${(site.manifest.files.reduce((n, f) => n + f.size, 0) / 1024).toFixed(1)} KiB · ${site.pinned ? 'Pinned' : 'Not pinned'}`;
    row.append(title, state, hash, meta);
    const actions = document.createElement('div'); actions.className = 'actions';
    const buttons: [string, () => Promise<unknown>][] = [
      ['Open', () => open(`web+hppt://${site.hash}`)],
      ['Seed', async () => { await engine.restore(site.hash); message('Seeding active. Keep this window open.'); }],
      [site.pinned ? 'Unpin' : 'Pin', async () => { if (site.pinned) await engine.unpin(site.hash); else await engine.pin(site.hash); await library(); }],
      ['Stop', async () => { await engine.stop(site.hash); message('Torrent seeding stopped.'); }],
      ['Clear cache', async () => { element('viewer-section').hidden = true; await clearViewer(site.hash); await engine.clear(site.hash); await library(); message('Local package and viewer cache cleared.'); }]
    ];
    for (const [label, fn] of buttons) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => action(fn); actions.append(b); }
    row.append(actions); sites.append(row);
  }
  if (!sites.children.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Your published and offline sites will appear here.'; sites.append(empty); }
  if (generation === libraryGeneration) element('sites').replaceChildren(sites);
}
async function prepareSite(hash: string, offline = false): Promise<void> {
  const existing = bridges.get(hash);
  if (existing && !offline) return existing.ready;
  if (existing?.offline) { await existing.ready; try { return await existing.refresh(); } catch (error) { existing.offline = false; throw error; } }
  existing?.dispose();
  const proof = await engine.authority(hash);
  const pending = bridges.get(hash);
  if (pending && !offline) return pending.ready;
  const bridge = createSiteBridge(config, hash, proof, (path, signal) => engine.readFile(hash, path, signal), offline,
    () => { if (bridges.get(hash) === bridge) bridges.delete(hash); });
  bridges.set(hash, bridge);
  return bridge.ready;
}
async function prepareAddress(uri: string) {
  const address = parseAddress(uri);
  await boot;
  message('Verifying the package and preparing the file server…');
  const manifest = await engine.open(address.hash);
  const path = address.path ?? manifest.entrypoint;
  if (!manifest.files.some(f => f.path === path)) throw new Error('404: The requested file does not exist.');
  await prepareSite(address.hash);
  const target = siteURL(config.viewerOrigin, address.hash, path, address.query, address.fragment);
  element<HTMLAnchorElement>('viewer-link').href = target;
  element('viewer-section').hidden = false;
  const resolved = `web+hppt://${address.hash}/${encodePath(path)}${address.query}${address.fragment}`;
  element<HTMLTextAreaElement>('uri').value = resolved; share(address.hash, resolved);
  element('pin-current').onclick = () => action(async () => {
    message('Downloading and verifying the complete package…');
    await engine.pin(address.hash); await prepareSite(address.hash, true); await library();
    message('Available offline. The complete package is stored persistently.');
  });
  return { target, resolved };
}
async function open(uri: string) {
  parseAddress(uri);
  // The app stays alive; only the protocol-entry tab navigates in place.
  const tab = window.open('about:blank', '_blank');
  try {
    const { target } = await prepareAddress(uri);
    if (tab) { tab.location.replace(target); message('The site opened in a new tab.'); }
    else message('Site prepared. To open it, click the “Open site in a new tab” link.');
  } catch (error) { tab?.close(); throw error; }
}
async function clearViewer(hash: string): Promise<void> {
  bridges.get(hash)?.dispose();
  const origin = siteOrigin(config.viewerOrigin, hash);
  const session = crypto.randomUUID(), nonce = crypto.randomUUID();
  const frame = document.createElement('iframe'); frame.hidden = true; frame.title = 'Clear viewer cache';
  frame.src = `${origin}${VIEWER_BOOT}#${new URLSearchParams({ session, nonce, hash })}`;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', listener); frame.remove(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('The viewer cache is unavailable. Try again.')); }, 12000);
    const listener = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.contentWindow) return;
      const hello = Hello.safeParse(event.data), cleared = Cleared.safeParse(event.data);
      if (hello.success && hello.data.nonce === nonce && hello.data.session === session && hello.data.hash === hash) frame.contentWindow!.postMessage({ type: 'clear', version: VERSION, session, nonce, hash }, origin);
      if (cleared.success && cleared.data.nonce === nonce && cleared.data.session === session && cleared.data.hash === hash) { cleanup(); if (cleared.data.ok) resolve(); else reject(new Error('Failed to clear the viewer cache.')); }
    };
    window.addEventListener('message', listener); document.body.append(frame);
  });
}
function share(hash: string, uri = `web+hppt://${hash}`) {
  shareHash = hash; shareAddress = uri;
  element('share').hidden = false; element<HTMLInputElement>('share-uri').value = shareAddress;
}
element<HTMLInputElement>('folder').onchange = () => action(async () => {
  const chosen = [...(element<HTMLInputElement>('folder').files || [])];
  if (chosen.length > config.limits.files || chosen.some(f => f.size > config.limits.file) || chosen.reduce((n, f) => n + f.size, 0) > config.limits.total) throw new Error('The folder exceeds the configured file count or size limit.');
  const root = chosen[0]?.webkitRelativePath.split('/')[0];
  files = await Promise.all(chosen.map(async f => ({ path: f.webkitRelativePath ? f.webkitRelativePath.slice(root!.length + 1) : f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  const select = element<HTMLSelectElement>('entrypoint'); select.replaceChildren();
  const placeholder = new Option('Choose an HTML entry file', ''); select.add(placeholder);
  for (const file of files.filter(f => /\.html?$/i.test(f.path))) select.add(new Option(file.path, file.path));
  if (files.some(f => f.path === 'index.html')) select.value = 'index.html';
  element('selection').textContent = `${files.length} files · ${(files.reduce((n, f) => n + f.bytes.length, 0) / 1024).toFixed(1)} KiB`;
  element<HTMLButtonElement>('publish-button').disabled = !select.value;
});
element<HTMLSelectElement>('entrypoint').onchange = event => { element<HTMLButtonElement>('publish-button').disabled = !(event.target as HTMLSelectElement).value; };
element('publish-button').onclick = () => action(async () => {
  element<HTMLButtonElement>('publish-button').disabled = true;
  try {
    message('Verifying integrity and publishing…');
    const hash = await engine.publish(files, { entrypoint: element<HTMLSelectElement>('entrypoint').value }); share(hash);
    await library();
    if (!bridges.get(hash)?.offline) throw new Error('Published, but offline viewer preparation failed. Use Refresh in the library to try again.');
    message('Published and available offline. Copy the address to another browser profile.');
  }
  finally { element<HTMLButtonElement>('publish-button').disabled = false; }
});
element('open-button').onclick = () => action(() => open(element<HTMLTextAreaElement>('uri').value));
element('refresh-library').onclick = () => action(library);
element('copy-uri').onclick = () => action(async () => { await navigator.clipboard.writeText(shareAddress); message('HPPT address copied.'); });
element('copy-https').onclick = () => action(async () => { await navigator.clipboard.writeText(`${config.appOrigin}/open?uri=${encodeURIComponent(shareAddress || `web+hppt://${shareHash}`)}`); message('Launch link copied.'); });
element('close-viewer').onclick = () => { element('viewer-section').hidden = true; };
element<HTMLSelectElement>('policy').value = config.policy;
element<HTMLSelectElement>('policy').onchange = () => action(async () => {
  await engine.destroy(); config.policy = element<HTMLSelectElement>('policy').value as RTCIceTransportPolicy;
  localStorage.setItem('htppt-policy', config.policy); await engine.restorePinned(); message('A new P2P client started with the selected ICE mode.');
});
const supported = 'registerProtocolHandler' in navigator;
element<HTMLButtonElement>('register').disabled = !supported;
if (!supported) element('protocol-help').textContent = 'This browser does not support registration. Paste an address or use a launch link.';
element('register').onclick = () => { try { navigator.registerProtocolHandler('web+hppt', `${location.origin}/open?uri=%s`); message('Approve registration in your browser. Test it over HTTPS.'); } catch (e) { message((e as Error).message, true); } };
function networkLabel() { element('network').textContent = navigator.onLine ? '● Online' : '○ Offline'; }
window.addEventListener('online', () => { networkLabel(); void engine.restorePinned(); }); window.addEventListener('offline', networkLabel); networkLabel();
async function stats() {
  const s = await engine.getStats();
  element('stats').textContent = `${s.peers} peer · ${(s.downloaded / 1024).toFixed(1)} KiB ↓ · ${(s.uploaded / 1024).toFixed(1)} KiB ↑ · ${(s.verifiedBytes / 1024).toFixed(1)} KiB verified · cache ${s.cacheHits} hit / ${s.cacheMisses} miss`;
  element('details').textContent = [...s.pairs.map(p => `${p.local === 'relay' || p.remote === 'relay' ? 'TURN relay' : 'Direct'} · ${p.connection} · ${p.local} ↔ ${p.remote} · ${p.bytesSent} B ↑ / ${p.bytesReceived} B ↓`), ...s.errors].join('\n');
}
setInterval(() => { void stats(); }, 1500);
const stopLaunches = serveLaunches(async uri => {
  try { const { resolved } = await prepareAddress(uri); message('The site opened in the launch tab. Keep this app open to download.'); return resolved; }
  catch (error) { message((error as Error).message, true); throw error; }
});
window.addEventListener('pagehide', () => { stopLaunches(); for (const bridge of [...bridges.values()]) bridge.dispose(); });
// Public, same-origin diagnostics/automation surface; no credential data is exposed.
(window as any).htppt = { engine, open, config, parseAddress, encodePath, library, share };
boot = action(async () => { await workerControl(); await library(); message('Ready. Publish a folder or open an address.'); });
await boot;
// Local display never awaits discovery or authentication.
if (navigator.onLine) void engine.restorePinned();
