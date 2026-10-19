import { contentPolicy, Fault, filePath, MANIFEST, parseAddress, urlPath, validateManifest, verify, VERSION, type Manifest } from '@htppt/protocol';
import { Clear, Init, MAX_PENDING, ReplySchema, TIMEOUT } from '@htppt/viewer-bridge';
import { installShell, shellResponse } from '@htppt/viewer-bridge/shell';
const sw = self as any;
installShell(sw);
const CONTENT = 'htppt-verified-0.1';
type Session = { session: string; hash: string; bootstrap: string; manifest: Manifest; port: MessagePort; pending: Map<string, { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout> }> };
const sessions = new Map<string, Session>();
const clients = new Map<string, string>();
const epochs = new Map<string, number>();
function close(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  for (const p of s.pending.values()) { clearTimeout(p.timer); p.resolve({ status: 503, error: 'Engine disconnected' }); }
  s.port.close(); sessions.delete(id);
  for (const [client, session] of clients) if (session === id) clients.delete(client);
}
sw.addEventListener('message', (event: any) => {
  event.waitUntil((async () => {
    const source = event.source;
    if (!source?.url || new URL(source.url).origin !== sw.location.origin || !['/', '/index.html'].includes(new URL(source.url).pathname)) return;
    if (event.data?.type === 'close' && sessions.get(event.data.session)?.bootstrap === source.id) { close(event.data.session); return; }
    const params = new URLSearchParams(new URL(source.url).hash.slice(1));
    const clear = Clear.safeParse(event.data);
    if (clear.success && event.ports.length === 1 && params.get('nonce') === clear.data.nonce && params.get('session') === clear.data.session && parseAddress(params.get('uri') || '').hash === clear.data.hash) {
      const { hash } = clear.data; epochs.set(hash, (epochs.get(hash) || 0) + 1);
      for (const s of [...sessions.values()]) if (s.hash === hash) close(s.session);
      let ok = true;
      try {
        const cache = await caches.open(CONTENT);
        for (const request of await cache.keys()) if (new URL(request.url).pathname.startsWith(`/__verified/${VERSION}/${hash}/`)) await cache.delete(request);
      } catch { ok = false; }
      event.ports[0].postMessage({ ...clear.data, type: 'cleared', ok }); event.ports[0].close(); return;
    }
    const { manifest: raw, ...message } = event.data || {};
    const parsed = Init.safeParse(message);
    if (!parsed.success || event.ports.length !== 2) return;
    const config = await (await caches.open((await caches.keys()).find(k => k.startsWith('htppt-shell-'))!)).match('/runtime-config.json');
    if (!config) return;
    const manifest = validateManifest(raw, (await config.json()).limits);
    if (params.get('nonce') !== message.nonce || params.get('session') !== message.session || parseAddress(params.get('uri') || '').hash !== message.hash) return;
    close(message.session);
    const live = new Set((await sw.clients.matchAll({ includeUncontrolled: true })).map((client: any) => client.id)); live.add(source.id);
    for (const s of sessions.values()) if (!live.has(s.bootstrap)) close(s.session);
    if (sessions.size >= 32) return;
    const s: Session = { session: message.session, hash: message.hash, bootstrap: source.id, manifest, port: event.ports[0], pending: new Map() };
    sessions.set(s.session, s); clients.set(source.id, s.session);
    s.port.onmessage = event => {
      const result = ReplySchema.safeParse(event.data);
      if (!result.success || result.data.session !== s.session || result.data.hash !== s.hash) return;
      const pending = s.pending.get(result.data.id);
      if (!pending) return;
      clearTimeout(pending.timer); s.pending.delete(result.data.id); pending.resolve(result.data);
    };
    s.port.start(); event.ports[1].postMessage({ type: 'bound', session: s.session }); event.ports[1].close();
  })());
});
async function read(s: Session, path: string, signal: AbortSignal): Promise<any> {
  if (s.pending.size >= MAX_PENDING) throw new Fault(503, 'Too many requests');
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    const finish = (result: any) => { const pending = s.pending.get(id); if (!pending) return; clearTimeout(pending.timer); s.pending.delete(id); signal.removeEventListener('abort', abort); resolve(result); };
    const abort = () => { s.port.postMessage({ type: 'abort', version: VERSION, session: s.session, hash: s.hash, id }); finish({ status: 503, error: 'Read aborted or timed out' }); };
    s.pending.set(id, { resolve: result => { signal.removeEventListener('abort', abort); resolve(result); }, timer: setTimeout(abort, TIMEOUT) });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    s.port.postMessage({ type: 'read', version: VERSION, session: s.session, hash: s.hash, path, id });
  });
}
sw.addEventListener('fetch', (event: any) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;
  if (!url.pathname.startsWith('/content/')) {
    event.respondWith((async () => await shellResponse(event.request) || new Response('Not found', { status: 404 }))()); return;
  }
  event.respondWith((async () => {
    try {
      if (!['GET', 'HEAD'].includes(event.request.method)) return new Response('GET and HEAD only', { status: 405, headers: { Allow: 'GET, HEAD' } });
      const match = /^\/content\/([a-f0-9]{40})(\/.*)$/.exec(url.pathname);
      if (!match) throw new Fault(400, 'Invalid content URL');
      const path = urlPath(match[2]);
      if (!path || path === MANIFEST) throw new Fault(404, 'File not found');
      filePath(path);
      const s = sessions.get(clients.get(event.clientId) || clients.get(event.resultingClientId) || '');
      if (!s) return new Response('Viewer session needs rebinding', { status: 503, headers: { 'X-HTPPT-Rebind': '1', 'Cache-Control': 'no-store' } });
      if (s.hash !== match[1]) throw new Fault(403, 'Session cannot access this site');
      if (event.resultingClientId) clients.set(event.resultingClientId, s.session);
      const record = s.manifest.files.find(f => f.path === path);
      if (!record) throw new Fault(404, 'File not found');
      const key = `${sw.location.origin}/__verified/${VERSION}/${s.hash}/${path}`;
      const cache = await caches.open(CONTENT);
      const epoch = epochs.get(s.hash) || 0;
      const cached = await cache.match(key);
      let bytes: Uint8Array;
      if (cached) bytes = new Uint8Array(await cached.arrayBuffer());
      else {
        const result = await read(s, path, event.request.signal);
        if (result.status !== 200 || !result.bytes) throw new Fault(result.status || 503, result.error || 'Engine unavailable');
        bytes = new Uint8Array(result.bytes);
      }
      await verify(bytes, record);
      if (!cached && epoch === (epochs.get(s.hash) || 0)) { try { await cache.put(key, new Response(bytes.slice().buffer)); } catch { /* UI durable store remains the source; quota does not block verified rendering. */ } }
      const headers = { 'Content-Type': record.mime, 'Content-Length': String(bytes.length), 'Content-Security-Policy': contentPolicy(sw.location.origin, s.hash), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-HTPPT-Cache': cached ? 'hit' : 'miss' };
      // Range is intentionally answered with the verified full 200 response in v0.1.
      return new Response(event.request.method === 'HEAD' ? null : bytes.slice().buffer, { status: 200, headers });
    } catch (error) { return new Response(error instanceof Error ? error.message : 'Viewer failed', { status: error instanceof Fault ? error.status : 503, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
  })());
});
