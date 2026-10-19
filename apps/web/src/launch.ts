import './style.css';
import type { Config } from '@htppt/p2p';
import { parseAddress, verify, type Address, type Manifest } from '@htppt/protocol';
import { makeAuthority } from '@htppt/protocol/authority';
import { siteURL } from '@htppt/protocol/site';
import { checkSite, loadFile, loadSite } from '../../../packages/p2p/storage';
import { workerControl } from '@htppt/viewer-bridge';
import { createSiteBridge, type SiteBridge } from './site-bridge';
import { LAUNCH_CHANNEL, LaunchMessage } from './launch-channel';

document.querySelector('#app')!.innerHTML = `<main class="launch"><div class="eyebrow">HPPT</div><h1>Oldal megnyitása</h1><p id="status" role="status" aria-live="polite">A cím ellenőrzése…</p><button id="start-app" class="primary" hidden>HPPT alkalmazás indítása</button><button id="retry" hidden>Újrapróbálás</button><p><a id="app-link" href="/" target="hppt-controller">HPPT alkalmazás megnyitása ↗</a></p></main>`;
const status = document.querySelector<HTMLElement>('#status')!;
const start = document.querySelector<HTMLButtonElement>('#start-app')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
let bridge: SiteBridge | undefined;
let disconnect = () => {};
window.addEventListener('pagehide', () => { disconnect(); bridge?.dispose(); });
retry.onclick = () => location.reload();

function target(config: Config, address: Address, manifest: Manifest) {
  const path = address.path ?? manifest.entrypoint;
  if (!manifest.files.some(file => file.path === path)) throw new Error('404: A kért fájl nem létezik.');
  return siteURL(config.viewerOrigin, address.hash, path, address.query, address.fragment);
}

function controller(config: Config, uri: string, address: Address): Promise<string> {
  const channel = new BroadcastChannel(LAUNCH_CHANNEL), request = crypto.randomUUID();
  let selected = '';
  return new Promise((resolve, reject) => {
    const discover = () => channel.postMessage({ type: 'discover', request });
    const poll = setInterval(discover, 500);
    const timeout = setTimeout(() => { cleanup(); reject(new Error('A HPPT alkalmazás nem válaszol. Nyisd meg, majd próbáld újra.')); }, 90000);
    const popup = setTimeout(() => { if (!selected) openApp(); }, 500);
    function cleanup() { clearInterval(poll); clearTimeout(timeout); clearTimeout(popup); channel.close(); start.hidden = true; }
    disconnect = cleanup;
    function openApp() {
      const tab = window.open(`${config.appOrigin}/`, 'hppt-controller');
      start.hidden = !!tab;
      status.textContent = tab ? 'A HPPT alkalmazás indul. A letöltéshez hagyd nyitva a külön alkalmazáslapot.' : 'A letöltéshez nyisd meg a HPPT alkalmazást az alábbi gombbal.';
    }
    start.onclick = openApp;
    channel.onmessage = event => {
      const parsed = LaunchMessage.safeParse(event.data);
      if (!parsed.success || parsed.data.request !== request) return;
      const data = parsed.data;
      if (data.type === 'available' && !selected) {
        selected = data.controller; clearInterval(poll); clearTimeout(popup); start.hidden = true;
        status.textContent = 'A HPPT alkalmazás előkészíti az oldalt…';
        channel.postMessage({ type: 'prepare', request, controller: selected, uri });
      }
      if (!('controller' in data) || data.controller !== selected) return;
      if (data.type === 'failed') { cleanup(); reject(new Error(data.error)); }
      if (data.type === 'prepared') {
        try {
          const resolved = parseAddress(data.uri);
          if (resolved.hash !== address.hash || !resolved.path || (address.path && resolved.path !== address.path) || resolved.query !== address.query || resolved.fragment !== address.fragment) throw new Error('Érvénytelen megnyitási válasz.');
          const url = siteURL(config.viewerOrigin, address.hash, resolved.path, address.query, address.fragment);
          cleanup(); resolve(url);
        } catch (error) { cleanup(); reject(error); }
      }
    };
    discover();
  });
}

try {
  const params = new URL(location.href).searchParams;
  const original = params.get('uri')!;
  // A fragment never reaches the viewer HTTP server. Its bootstrap redirect
  // inherits it on the outer URL; protocol-handler links already include it.
  const uri = original + (params.get('source') === 'viewer' ? location.hash : '');
  const address = parseAddress(uri);
  const response = await fetch('/runtime-config.json');
  if (!response.ok) throw new Error('Az alkalmazás konfigurációja nem érhető el.');
  const config: Config = await response.json();
  if (location.origin !== config.appOrigin) {
    const canonical = new URL(config.appOrigin); canonical.pathname = '/open'; canonical.search = location.search; canonical.hash = location.hash;
    location.replace(canonical.href);
  } else {
    document.querySelector<HTMLAnchorElement>('#app-link')!.href = `${config.appOrigin}/`;
    await workerControl();
    const saved = await loadSite(address.hash);
    let url: string;
    if (saved && await checkSite(saved, config.limits)) {
      status.textContent = 'A helyi csomag ellenőrzése…';
      url = target(config, address, saved.manifest);
      const read = async (path: string) => {
        const record = saved.manifest.files.find(file => file.path === path), bytes = await loadFile(address.hash, path);
        if (!record || !bytes) throw new Error('A helyi csomag hiányos.');
        await verify(bytes, record); return { bytes, mime: record.mime };
      };
      const proof = await makeAuthority(address.hash, saved.torrent, saved.manifestBytes, async path => (await read(path)).bytes, config.limits);
      bridge = createSiteBridge(config, address.hash, proof, read, true);
      await bridge.ready;
    } else {
      if (!navigator.onLine) throw new Error('Ez az oldal még nincs teljesen elmentve. Az első letöltéshez internetkapcsolat szükséges.');
      status.textContent = 'Kapcsolódás a HPPT alkalmazáshoz…';
      url = await controller(config, uri, address);
    }
    location.replace(url);
  }
} catch (error) {
  disconnect(); bridge?.dispose();
  status.textContent = error instanceof Error ? error.message : 'Az oldal megnyitása sikertelen.';
  status.className = 'error'; retry.hidden = false;
}
