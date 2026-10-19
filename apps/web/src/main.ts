import './style.css';
import { Engine, type Config } from '@htppt/p2p';
import { checkSite, listSites, loadSite } from '../../../packages/p2p/storage';
import { encodePath, parseAddress, VERSION, type InputFile } from '@htppt/protocol';
import { Cleared, Hello, ViewerStatus, servePort, workerControl } from '@htppt/viewer-bridge';

document.querySelector('#app')!.innerHTML = `
<aside><a class="brand" href="/" aria-label="HPPT kezdőlap">h<span>p</span>pt<span class="badge">0.1</span></a><p class="tagline">A web, egymástól.</p><nav><a href="#publish">↥ &nbsp; Publikálás</a><a href="#browse">↗ &nbsp; Böngészés</a><a href="#library">▦ &nbsp; Saját könyvtár</a></nav><div class="aside-bottom"><span id="network" class="pill"></span><p>A megosztáshoz tartsd nyitva ezt az ablakot.</p><small>WebRTC · WebTorrent · SHA-256</small></div></aside>
<main><header><div><div class="eyebrow">HYPERTEXT PEER TO PEER TRANSFER PROTOCOL</div><h1>Adj otthont egy oldalnak.<br><span>Oszd meg a világgal.</span></h1><p>Statikus weboldalak közvetlenül böngészők között.<br>Publikáld a mappád, és küldd tovább a linket.</p></div><div class="network-art" aria-hidden="true"><span>YOU</span><i>↔</i><span>PEER</span><small>közvetlen kapcsolat</small></div></header>
<div class="columns"><section id="publish" class="card"><div class="section-number">01 / PUBLIKÁLÁS</div><h2>A mappádból weboldal</h2><label class="drop"><span class="upload-icon">↥</span><strong>Válassz egy weboldalmappát</strong><small>HTML, CSS, JavaScript és képek · legfeljebb 50 MiB</small><input id="folder" type="file" webkitdirectory multiple aria-label="Weboldalmappa"></label><div class="entry"><label for="entrypoint">Kezdőoldal</label><select id="entrypoint"><option value="">Előbb válassz mappát</option></select></div><p id="selection" class="muted">A fájlok a böngésződben maradnak.</p><button id="publish-button" class="primary" disabled>Publikálás és megosztás ↗</button></section>
<section id="browse" class="card"><div class="section-number">02 / BÖNGÉSZÉS</div><h2>Egy link. Egy új oldal.</h2><p class="muted">Illessz be egy HPPT-címet, és kapcsolódj a megosztókhoz.</p><label for="uri">HPPT-cím</label><textarea id="uri" rows="3" placeholder="web+hppt://…" spellcheck="false"></textarea><button id="open-button" class="primary">Oldal megnyitása →</button><div class="protocol"><button id="register" class="text-button">Protokollkezelő regisztrálása</button><small id="protocol-help">A beillesztés és a HTTPS-link regisztráció nélkül is működik.</small></div></section></div>
<div id="status" role="status" aria-live="polite">Indítás…</div><div id="share" hidden><label>Megosztható cím</label><input id="share-uri" readonly><div class="actions"><button id="copy-uri">HPPT-cím másolása</button><button id="copy-https">Belépési link másolása</button></div></div>
<section id="viewer-section" hidden><div class="viewer-heading"><h2>Megnyitott oldal</h2><button id="close-viewer">Bezárás ×</button></div><div id="viewer"></div></section>
<section id="library"><div class="section-head"><div><div class="section-number">03 / SAJÁT KÖNYVTÁR</div><h2>A nálad élő web</h2></div><button id="refresh-library">Frissítés ↻</button></div><div id="sites"></div></section>
<section class="diagnostics"><div class="section-head"><h2>Kapcsolat és átvitel</h2><label>Új kapcsolatok módja <select id="policy"><option value="all">Közvetlen + TURN</option><option value="relay">Csak TURN relay</option></select></label></div><div id="stats"></div><pre id="details"></pre></section><footer>Az oldalakat más résztvevők publikálják. A protokoll nem biztosít anonimitást.<br>Csak nyilvános tartalmat ossz meg. A cache a böngésző által megőrzött adatokra támaszkodik.</footer></main>`;
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
document.querySelector('.drop small')!.textContent = `HTML, CSS, JavaScript és képek · legfeljebb ${config.limits.total / 1024 ** 2} MiB`;
const savedPolicy = localStorage.getItem('htppt-policy');
if (savedPolicy === 'relay' || savedPolicy === 'all') config.policy = savedPolicy;
const engine = new Engine(config);
let files: InputFile[] = [];
let shareHash = '';
let shareAddress = '';
let cleanup: (() => void) | undefined;
let boot: Promise<void> = Promise.resolve();
let libraryGeneration = 0;
let viewerShellAvailable = false;
let warming: Promise<void> | undefined;
function warmViewer(): Promise<void> {
  if (warming) return warming;
  warming = new Promise<void>((resolve, reject) => {
    const hash = '0'.repeat(40), session = crypto.randomUUID(), nonce = crypto.randomUUID();
    const frame = document.createElement('iframe'); frame.hidden = true; frame.title = 'Offline viewer előkészítése';
    frame.src = `${config.viewerOrigin}/#${new URLSearchParams({ session, nonce, uri: `web+hppt://${hash}` })}`;
    const finish = () => { clearTimeout(timer); window.removeEventListener('message', listener); frame.remove(); };
    const timer = setTimeout(() => { finish(); reject(new Error('A viewer offline indítófájljai nem érhetők el.')); }, 10000);
    const listener = (event: MessageEvent) => {
      if (event.origin !== config.viewerOrigin || event.source !== frame.contentWindow) return;
      const hello = Hello.safeParse(event.data);
      if (!hello.success || hello.data.nonce !== nonce || hello.data.session !== session || hello.data.hash !== hash) return;
      viewerShellAvailable = true; finish(); resolve();
    };
    window.addEventListener('message', listener); document.body.append(frame);
  });
  return warming;
}
function message(text: string, error = false) { element('status').textContent = text; element('status').className = error ? 'error' : ''; }
async function action(task: () => Promise<unknown>) { try { await task(); } catch (error) { message(error instanceof Error ? error.message : String(error), true); } }
async function library() {
  const generation = ++libraryGeneration;
  try { await warmViewer(); } catch { viewerShellAvailable = false; warming = undefined; }
  const sites = document.createDocumentFragment();
  for (const site of await listSites()) {
    const valid = await checkSite(site, config.limits);
    const row = document.createElement('article'); row.className = 'site';
    const title = document.createElement('strong'); title.textContent = site.manifest.entrypoint;
    const hash = document.createElement('code'); hash.textContent = site.hash;
    const state = document.createElement('span'); state.className = 'pill'; state.textContent = valid && viewerShellAvailable ? 'Offline elérhető' : valid ? 'Csomag tárolva; viewer előkészítése szükséges' : 'Hiányos helyi csomag';
    const meta = document.createElement('small'); meta.textContent = `${site.manifest.files.length} fájl · ${(site.manifest.files.reduce((n, f) => n + f.size, 0) / 1024).toFixed(1)} KiB · ${site.pinned ? 'Pinelve' : 'Nincs pinelve'}`;
    row.append(title, state, hash, meta);
    const actions = document.createElement('div'); actions.className = 'actions';
    const buttons: [string, () => Promise<unknown>][] = [
      ['Megnyitás', () => open(`web+hppt://${site.hash}`)],
      ['Továbbosztás', async () => { await engine.restore(site.hash); message('Továbbosztás aktív. Tartsd nyitva az ablakot.'); }],
      [site.pinned ? 'Unpin' : 'Pin', async () => { if (site.pinned) await engine.unpin(site.hash); else await engine.pin(site.hash); await library(); }],
      ['Leállítás', async () => { await engine.stop(site.hash); message('A torrent továbbosztása leállt.'); }],
      ['Cache törlése', async () => { cleanup?.(); element('viewer').replaceChildren(); element('viewer-section').hidden = true; await clearViewer(site.hash); await engine.clear(site.hash); await library(); message('A helyi csomag és a viewer cache-e törölve.'); }]
    ];
    for (const [label, fn] of buttons) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => action(fn); actions.append(b); }
    row.append(actions); sites.append(row);
  }
  if (!sites.children.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Itt jelennek meg a publikált és offline mentett oldalaid.'; sites.append(empty); }
  if (generation === libraryGeneration) element('sites').replaceChildren(sites);
}
async function open(uri: string) {
  await boot;
  const address = parseAddress(uri);
  message('Csomag ellenőrzése és megnyitása…');
  const manifest = await engine.open(address.hash);
  // Check explicit paths early; the worker also enforces 404 independently.
  const path = address.path ?? manifest.entrypoint;
  if (!manifest.files.some(f => f.path === path)) throw new Error('404: A kért fájl nem létezik.');
  cleanup?.();
  const session = crypto.randomUUID(), nonce = crypto.randomUUID();
  const frame = document.createElement('iframe'); frame.title = 'Elkülönített HPPT viewer'; frame.referrerPolicy = 'no-referrer';
  frame.src = `${config.viewerOrigin}/#${new URLSearchParams({ session, nonce, uri })}`;
  let stopPort: (() => void) | undefined;
  const listener = (event: MessageEvent) => {
    if (event.origin !== config.viewerOrigin || event.source !== frame.contentWindow) return;
    const state = ViewerStatus.safeParse(event.data);
    if (state.success && state.data.nonce === nonce && state.data.session === session && state.data.hash === address.hash) {
      if (state.data.state === 'loaded') {
        const updated = parseAddress(state.data.uri);
        if (updated.hash !== address.hash) return;
        element<HTMLTextAreaElement>('uri').value = state.data.uri;
        share(address.hash, state.data.uri);
      }
      message(state.data.text, state.data.state === 'error'); return;
    }
    const hello = Hello.safeParse(event.data);
    if (!hello.success || hello.data.nonce !== nonce || hello.data.session !== session || hello.data.hash !== address.hash) return;
    stopPort?.(); const channel = new MessageChannel();
    stopPort = servePort(channel.port1, session, address.hash, (path, signal) => engine.readFile(address.hash, path, signal));
    frame.contentWindow!.postMessage({ type: 'init', version: VERSION, nonce, session, hash: address.hash, manifest }, config.viewerOrigin, [channel.port2]);
  };
  window.addEventListener('message', listener);
  cleanup = () => { window.removeEventListener('message', listener); stopPort?.(); frame.remove(); };
  element('viewer').replaceChildren(frame); element('viewer-section').hidden = false;
  element<HTMLTextAreaElement>('uri').value = uri;
  message('Oldal megnyitva. A teljes csomagot a „Mentés offline” gombbal tárolhatod.');
  const pinButton = document.createElement('button'); pinButton.textContent = 'Mentés offline + pin'; pinButton.id = 'pin-current';
  pinButton.onclick = () => action(async () => { message('Teljes csomag letöltése és ellenőrzése…'); await engine.pin(address.hash); await library(); message('Offline elérhető. A teljes csomag tartósan tárolva.'); });
  element('viewer').prepend(pinButton);
  if (await loadSite(address.hash)) await library();
}
async function clearViewer(hash: string): Promise<void> {
  const session = crypto.randomUUID(), nonce = crypto.randomUUID();
  const frame = document.createElement('iframe'); frame.hidden = true; frame.title = 'Viewer cache törlése';
  frame.src = `${config.viewerOrigin}/#${new URLSearchParams({ session, nonce, uri: `web+hppt://${hash}` })}`;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', listener); frame.remove(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('A viewer cache nem érhető el. Próbáld újra.')); }, 12000);
    const listener = (event: MessageEvent) => {
      if (event.origin !== config.viewerOrigin || event.source !== frame.contentWindow) return;
      const hello = Hello.safeParse(event.data), cleared = Cleared.safeParse(event.data);
      if (hello.success && hello.data.nonce === nonce && hello.data.session === session && hello.data.hash === hash) {
        const channel = new MessageChannel(); channel.port1.close();
        frame.contentWindow!.postMessage({ type: 'clear', version: VERSION, session, nonce, hash }, config.viewerOrigin, [channel.port2]);
      }
      if (cleared.success && cleared.data.nonce === nonce && cleared.data.session === session && cleared.data.hash === hash) {
        cleanup(); if (cleared.data.ok) resolve(); else reject(new Error('Viewer cache törlése sikertelen.'));
      }
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
  if (chosen.length > config.limits.files || chosen.some(f => f.size > config.limits.file) || chosen.reduce((n, f) => n + f.size, 0) > config.limits.total) throw new Error('A mappa túllépi a beállított fájlszám- vagy méretkorlátot.');
  const root = chosen[0]?.webkitRelativePath.split('/')[0];
  files = await Promise.all(chosen.map(async f => ({ path: f.webkitRelativePath ? f.webkitRelativePath.slice(root!.length + 1) : f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  const select = element<HTMLSelectElement>('entrypoint'); select.replaceChildren();
  const placeholder = new Option('Válassz HTML-kezdőfájlt', ''); select.add(placeholder);
  for (const file of files.filter(f => /\.html?$/i.test(f.path))) select.add(new Option(file.path, file.path));
  if (files.some(f => f.path === 'index.html')) select.value = 'index.html';
  element('selection').textContent = `${files.length} fájl · ${(files.reduce((n, f) => n + f.bytes.length, 0) / 1024).toFixed(1)} KiB`;
  element<HTMLButtonElement>('publish-button').disabled = !select.value;
});
element<HTMLSelectElement>('entrypoint').onchange = event => { element<HTMLButtonElement>('publish-button').disabled = !(event.target as HTMLSelectElement).value; };
element('publish-button').onclick = () => action(async () => {
  element<HTMLButtonElement>('publish-button').disabled = true;
  try { message('Integritásellenőrzés és publikálás…'); share(await engine.publish(files, { entrypoint: element<HTMLSelectElement>('entrypoint').value })); await library(); message('Publikálva és offline elérhető. Másold át a címet egy másik böngészőprofilba.'); }
  finally { element<HTMLButtonElement>('publish-button').disabled = false; }
});
element('open-button').onclick = () => action(() => open(element<HTMLTextAreaElement>('uri').value));
element('refresh-library').onclick = () => action(library);
element('copy-uri').onclick = () => action(async () => { await navigator.clipboard.writeText(shareAddress); message('HPPT-cím másolva.'); });
element('copy-https').onclick = () => action(async () => { await navigator.clipboard.writeText(`${config.appOrigin}/open?uri=${encodeURIComponent(shareAddress || `web+hppt://${shareHash}`)}`); message('Belépési link másolva.'); });
element('close-viewer').onclick = () => { cleanup?.(); element('viewer-section').hidden = true; };
element<HTMLSelectElement>('policy').value = config.policy;
element<HTMLSelectElement>('policy').onchange = () => action(async () => {
  await engine.destroy(); config.policy = element<HTMLSelectElement>('policy').value as RTCIceTransportPolicy;
  localStorage.setItem('htppt-policy', config.policy); await engine.restorePinned(); message('Új P2P-kliens indult a kiválasztott ICE-móddal.');
});
const supported = 'registerProtocolHandler' in navigator;
element<HTMLButtonElement>('register').disabled = !supported;
if (!supported) element('protocol-help').textContent = 'Ez a böngésző nem támogatja a regisztrációt. Használd a beillesztést vagy a belépési linket.';
element('register').onclick = () => { try { navigator.registerProtocolHandler('web+hppt', `${location.origin}/open?uri=%s`); message('A regisztrációt a böngészőben kell jóváhagyni. HTTPS-en tesztelendő.'); } catch (e) { message((e as Error).message, true); } };
function networkLabel() { element('network').textContent = navigator.onLine ? '● Online' : '○ Offline'; }
window.addEventListener('online', () => { networkLabel(); void engine.restorePinned(); }); window.addEventListener('offline', networkLabel); networkLabel();
async function stats() {
  const s = await engine.getStats();
  element('stats').textContent = `${s.peers} peer · ${(s.downloaded / 1024).toFixed(1)} KiB ↓ · ${(s.uploaded / 1024).toFixed(1)} KiB ↑ · ${(s.verifiedBytes / 1024).toFixed(1)} KiB ellenőrizve · cache ${s.cacheHits} hit / ${s.cacheMisses} miss`;
  element('details').textContent = [...s.pairs.map(p => `${p.local === 'relay' || p.remote === 'relay' ? 'TURN relay' : 'Direct'} · ${p.connection} · ${p.local} ↔ ${p.remote} · ${p.bytesSent} B ↑ / ${p.bytesReceived} B ↓`), ...s.errors].join('\n');
}
setInterval(() => { void stats(); }, 1500);
window.addEventListener('pagehide', () => cleanup?.());
// Public, same-origin diagnostics/automation surface; no credential data is exposed.
(window as any).htppt = { engine, open, config, parseAddress, encodePath, library, share };
boot = action(async () => { await workerControl(); await library(); message('Készen áll. Publikálj egy mappát, vagy nyiss meg egy címet.'); });
await boot;
const uri = new URL(location.href).searchParams.get('uri');
if (uri) await action(() => open(uri));
// Local display never awaits discovery or authentication.
if (navigator.onLine) void engine.restorePinned();
