import { z } from 'zod';
import { Clear, Init, workerControl } from '@htppt/viewer-bridge';
import { contentURL, Fault, parseAddress, validateManifest, VERSION, type Address, type Manifest } from '@htppt/protocol';
import { Renderer, logicalURI, resolveReference } from './renderer';

const status = document.querySelector<HTMLElement>('#status')!;
const locationLabel = document.querySelector<HTMLElement>('#location')!;
const config = await fetch('/runtime-config.json').then(r => r.json());
const params = new URLSearchParams(location.hash.slice(1));
const nonce = params.get('nonce') || '', session = params.get('session') || '';
const original = parseAddress(params.get('uri') || '');
await workerControl();
let manifest: Manifest;
let current: Address;
let frame: HTMLIFrameElement | undefined;
let renderer: Renderer | undefined;
let controller: AbortController | undefined;
let contentPort: MessagePort | undefined;
let binding: { promise: Promise<void>; resolve: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
let initialized = false;
let navigation = 0;
let token = '';
const Navigate = z.object({ type: z.literal('navigate'), version: z.literal(VERSION), href: z.string().max(8192) }).strict();
function report(state: 'loaded' | 'error', text: string) {
  parent.postMessage({ type: 'viewer-status', version: VERSION, session, nonce, hash: original.hash, state, text, uri: current ? logicalURI(current) : '' }, config.appOrigin);
}
function bind(): Promise<void> {
  if (binding) return binding.promise;
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => { binding = undefined; reject(new Error('Viewer bridge timeout. Nyisd meg újra az oldalt.')); }, 10000);
  binding = { promise, resolve, timer };
  parent.postMessage({ type: 'ready', version: VERSION, nonce, session, hash: original.hash }, config.appOrigin);
  return promise;
}
async function read(path: string, signal: AbortSignal): Promise<Uint8Array> {
  const address = { hash: original.hash, path, query: '', fragment: '' };
  let response = await fetch(contentURL(location.origin, address, manifest.entrypoint), { signal, cache: 'no-store' });
  if (response.headers.get('X-HTPPT-Rebind') === '1') {
    await bind();
    response = await fetch(contentURL(location.origin, address, manifest.entrypoint), { signal, cache: 'no-store' });
  }
  if (!response.ok) throw new Fault(response.status, await response.text());
  return new Uint8Array(await response.arrayBuffer());
}
async function navigate(address: Address) {
  const id = ++navigation;
  controller?.abort(); renderer?.dispose(); frame?.remove(); contentPort?.close();
  controller = new AbortController();
  current = { ...address, path: address.path ?? manifest.entrypoint };
  locationLabel.textContent = logicalURI(current);
  status.hidden = false; status.textContent = 'Ellenőrzött oldal betöltése…';
  token = crypto.randomUUID();
  const next = new Renderer(manifest, location.origin, read, controller.signal); renderer = next;
  try {
    const html = await next.document(current, token);
    if (id !== navigation) return;
    frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer'; frame.title = 'P2P weboldal';
    frame.srcdoc = html;
    frame.onload = () => { if (id === navigation) { status.hidden = true; report('loaded', 'Oldal megnyitva.'); } };
    document.body.append(frame);
  } catch (error) {
    next.dispose(); if (id !== navigation) return;
    controller.abort();
    status.textContent = `${error instanceof Fault ? error.status + ': ' : ''}${(error as Error).message}`;
    report('error', status.textContent);
  }
}
window.addEventListener('message', event => {
  if (event.source === frame?.contentWindow && event.origin === 'null' && event.data?.type === 'htppt-content' && event.data.version === VERSION && event.data.token === token && event.ports.length === 1) {
    contentPort?.close(); contentPort = event.ports[0];
    contentPort.onmessage = message => {
      const result = Navigate.safeParse(message.data); if (!result.success) return;
      try {
        const ref = resolveReference(result.data.href, current, location.origin);
        if (!ref) throw new Fault(403, 'Külső vagy másik csomagra mutató link blokkolva.');
        void navigate(ref);
      } catch (error) { status.hidden = false; status.textContent = (error as Error).message; report('error', status.textContent); }
    };
    contentPort.start(); return;
  }
  if (event.origin !== config.appOrigin || event.source !== parent || event.ports.length !== 1) return;
  const clear = Clear.safeParse(event.data);
  if (clear.success && clear.data.nonce === nonce && clear.data.session === session && clear.data.hash === original.hash) {
    const ack = new MessageChannel();
    ack.port1.onmessage = event => { parent.postMessage(event.data, config.appOrigin); ack.port1.close(); };
    navigator.serviceWorker.controller!.postMessage(clear.data, [ack.port2]); return;
  }
  const { manifest: raw, ...data } = event.data || {};
  const parsed = Init.safeParse(data);
  if (!parsed.success || parsed.data.nonce !== nonce || parsed.data.session !== session || parsed.data.hash !== original.hash) return;
  try { manifest = validateManifest(raw, config.limits); } catch { return; }
  const ack = new MessageChannel();
  ack.port1.onmessage = event => {
    if (event.data?.type !== 'bound' || event.data.session !== session) return;
    ack.port1.close();
    if (binding) { clearTimeout(binding.timer); binding.resolve(); binding = undefined; }
    if (!initialized) { initialized = true; void navigate(original); }
  };
  navigator.serviceWorker.controller!.postMessage({ ...parsed.data, manifest }, [event.ports[0], ack.port2]);
});
navigator.serviceWorker.addEventListener('controllerchange', () => { void bind().catch(error => report('error', error.message)); });
window.addEventListener('pagehide', () => {
  if (binding) clearTimeout(binding.timer);
  controller?.abort(); renderer?.dispose(); contentPort?.close();
  navigator.serviceWorker.controller?.postMessage({ type: 'close', session });
});
void bind().catch(error => { status.textContent = error.message; report('error', error.message); });
