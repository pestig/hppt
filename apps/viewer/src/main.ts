import { Clear, Init, Pin, workerControl } from '@htppt/viewer-bridge';
import { originHash, VIEWER_BOOT } from '@htppt/protocol/site';
import { VERSION } from '@htppt/protocol';

const status = document.querySelector<HTMLElement>('#status')!;
const config = await fetch(`${VIEWER_BOOT}runtime-config.json`).then(r => r.json());
const params = new URLSearchParams(location.hash.slice(1));
const session = params.get('session') || '', nonce = params.get('nonce') || '';
let hash = '';
try { hash = originHash(location.origin); } catch { /* The base host is an informational landing page. */ }
if (!hash || !session || !nonce || parent === window) {
  status.textContent = 'The HPPT viewer uses a separate origin for each site. Open the site from the HPPT app.';
  const link = document.createElement('a'); link.href = config.appOrigin; link.textContent = 'Open HPPT'; document.body.append(link);
} else {
  if (document.hasStorageAccess && !await document.hasStorageAccess()) {
    const text = 'The viewer and HPPT app must use separate origins within the same schemeful site; the browser has partitioned the helper storage.';
    parent.postMessage({ type: 'viewer-status', version: VERSION, nonce, session, hash, state: 'error', text, uri: '' }, config.appOrigin);
    throw new Error(text);
  }
  await workerControl(`${VIEWER_BOOT}sw.js`);
  let waiting = false;
  function hello() {
    if (waiting) return;
    waiting = true;
    parent.postMessage({ type: 'ready', version: VERSION, nonce, session, hash }, config.appOrigin);
  }
  function command(message: unknown, ports: MessagePort[] = []) {
    return new Promise<any>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Viewer worker timeout')); }, 60000);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); if (event.data.type === 'error') reject(new Error(event.data.error)); else resolve(event.data); };
      navigator.serviceWorker.controller!.postMessage(message, [...ports, channel.port2]);
    });
  }
  window.addEventListener('message', event => {
    if (event.origin !== config.appOrigin || event.source !== parent) return;
    void (async () => {
      const pin = Pin.safeParse(event.data);
      if (pin.success && pin.data.nonce === nonce && pin.data.session === session && pin.data.hash === hash && event.ports.length === 1) {
        try { event.ports[0].postMessage(await command(pin.data)); }
        catch (error) { event.ports[0].postMessage({ type: 'error', error: (error as Error).message }); }
        finally { event.ports[0].close(); }
        return;
      }
      const clear = Clear.safeParse(event.data);
      if (clear.success && clear.data.nonce === nonce && clear.data.session === session && clear.data.hash === hash) {
        const result = await command(clear.data);
        parent.postMessage(result, config.appOrigin); return;
      }
      const { proof, ...data } = event.data || {};
      const parsed = Init.safeParse(data);
      if (!parsed.success || parsed.data.nonce !== nonce || parsed.data.session !== session || parsed.data.hash !== hash || event.ports.length !== 1) return;
      await command({ ...parsed.data, proof }, [event.ports[0]]);
      if (params.get('pin') === '1') await command({ type: 'pin', version: VERSION, nonce, session, hash });
      waiting = false;
      parent.postMessage({ type: 'viewer-status', version: VERSION, nonce, session, hash, state: 'loaded', text: 'Viewer prepared.', uri: `web+hppt://${hash}` }, config.appOrigin);
    })().catch(error => {
      waiting = false;
      parent.postMessage({ type: 'viewer-status', version: VERSION, nonce, session, hash, state: 'error', text: error.message, uri: '' }, config.appOrigin);
    });
  });
  navigator.serviceWorker.addEventListener('message', event => { if (event.data?.type === 'hppt-rebind') hello(); });
  navigator.serviceWorker.addEventListener('controllerchange', () => { waiting = false; hello(); });
  window.addEventListener('pagehide', () => navigator.serviceWorker.controller?.postMessage({ type: 'close', session }));
  hello();
}
