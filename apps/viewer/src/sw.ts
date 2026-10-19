import { DEFAULT_LIMITS, Fault, filePath, urlPath, verify, VERSION, type Manifest } from '@htppt/protocol';
import { decodeAuthority, encodeAuthority, verifyAuthority, type AuthorityProof } from '@htppt/protocol/authority';
import { originHash, VIEWER_BOOT } from '@htppt/protocol/site';
import { Clear, Init, Pin, MAX_PENDING, ReplySchema, TIMEOUT } from '@htppt/viewer-bridge';
import { installShell, shellResponse } from '@htppt/viewer-bridge/shell';

const sw = self as any;
installShell(sw, false, VIEWER_BOOT);
const hash = originHash(sw.location.origin);
const CONTENT = 'hppt-site-files-v1', AUTHORITY = `${VIEWER_BOOT}authority`;
const policy = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
type Pending = { finish: (value: any) => void; timer: ReturnType<typeof setTimeout> };
type Session = { id: string; bootstrap: string; port: MessagePort; pending: Map<string, Pending> };
const sessions = new Map<string, Session>();
let manifest: Manifest | undefined;
let epoch = 0;
let active = 0;
const queue: (() => void)[] = [];
const jobs = new Map<string, Promise<Uint8Array>>();
async function limits() {
  const config = await shellResponse(new Request(new URL(`${VIEWER_BOOT}runtime-config.json`, sw.location.origin)), VIEWER_BOOT);
  const value = config && (await config.json()).limits;
  if (value && ['files', 'total', 'file'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0)) return value;
  return DEFAULT_LIMITS;
}
function close(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  for (const pending of [...session.pending.values()]) pending.finish({ status: 503, error: 'HPPT application disconnected' });
  session.port.close(); sessions.delete(id);
}
async function authority() {
  if (manifest) return manifest;
  const response = await (await caches.open(CONTENT)).match(AUTHORITY);
  if (!response) throw new Fault(503, 'Open this site from the HPPT application first.');
  manifest = await verifyAuthority(hash, decodeAuthority(await response.text()), await limits());
  return manifest;
}
async function sessionForRead(): Promise<Session> {
  const live = new Set((await sw.clients.matchAll()).map((client: any) => client.id));
  for (const session of [...sessions.values()]) if (!live.has(session.bootstrap)) close(session.id);
  if (!sessions.size) {
    for (const client of await sw.clients.matchAll()) if (new URL(client.url).pathname.startsWith(VIEWER_BOOT)) client.postMessage({ type: 'hppt-rebind' });
    const deadline = Date.now() + 4000;
    while (!sessions.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  }
  const session = sessions.values().next().value;
  if (!session) throw new Fault(503, 'Missing local file. Keep the HPPT application open to download it from peers.');
  return session;
}
async function remote(path: string, signal?: AbortSignal): Promise<Uint8Array> {
  const session = await sessionForRead();
  if (session.pending.size >= MAX_PENDING) throw new Fault(503, 'Bridge busy');
  const id = crypto.randomUUID();
  const result = await new Promise<any>(resolve => {
    const abort = () => { session.port.postMessage({ type: 'abort', version: VERSION, session: session.id, hash, id }); finish({ status: 503, error: 'Read aborted or timed out' }); };
    const finish = (value: any) => {
      const pending = session.pending.get(id); if (!pending) return;
      clearTimeout(pending.timer); signal?.removeEventListener('abort', abort); session.pending.delete(id); resolve(value);
    };
    session.pending.set(id, { finish, timer: setTimeout(abort, TIMEOUT) });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    session.port.postMessage({ type: 'read', version: VERSION, session: session.id, hash, id, path });
  });
  if (result.status !== 200 || !result.bytes) throw new Fault(result.status || 503, result.error || 'Peer unavailable');
  return new Uint8Array(result.bytes);
}
async function file(path: string, signal?: AbortSignal): Promise<Uint8Array> {
  const current = await authority();
  const record = current.files.find(f => f.path === path);
  if (!record) throw new Fault(404, 'File not found');
  const cache = await caches.open(CONTENT), key = `${VIEWER_BOOT}verified/${path}`;
  const cached = await cache.match(key);
  if (cached) { const bytes = new Uint8Array(await cached.arrayBuffer()); await verify(bytes, record); return bytes; }
  if (jobs.has(path)) return jobs.get(path)!;
  const generation = epoch;
  const job = new Promise<Uint8Array>((resolve, reject) => {
    const run = () => {
      active++;
      (async () => {
        const bytes = await remote(path, signal);
        await verify(bytes, record);
        if (generation !== epoch) throw new Fault(503, 'Site cache was cleared');
        try { await cache.put(key, new Response(bytes.slice().buffer)); } catch { /* Pin checks persistence separately. */ }
        return bytes;
      })().then(resolve, reject).finally(() => { active--; jobs.delete(path); queue.shift()?.(); });
    };
    if (active < 8) run(); else queue.push(run);
  });
  jobs.set(path, job); return job;
}
async function pin() {
  const current = await authority();
  await Promise.all(current.files.map(record => file(record.path)));
  const cache = await caches.open(CONTENT);
  for (const record of current.files) {
    const cached = await cache.match(`${VIEWER_BOOT}verified/${record.path}`);
    if (!cached) throw new Fault(507, 'Viewer storage quota: incomplete offline package');
    await verify(new Uint8Array(await cached.arrayBuffer()), record);
  }
  const proof = await cache.match(AUTHORITY);
  if (!proof) throw new Fault(507, 'Viewer authority was not persisted');
  await verifyAuthority(hash, decodeAuthority(await proof.text()), await limits());
  await sw.navigator.storage?.persist?.();
}
sw.addEventListener('message', (event: any) => {
  event.waitUntil((async () => {
    const source = event.source;
    if (!source?.url || new URL(source.url).origin !== sw.location.origin || ![VIEWER_BOOT, `${VIEWER_BOOT}index.html`].includes(new URL(source.url).pathname)) return;
    if (event.data?.type === 'close' && sessions.get(event.data.session)?.bootstrap === source.id) { close(event.data.session); return; }
    const params = new URLSearchParams(new URL(source.url).hash.slice(1));
    if (params.get('nonce') !== event.data?.nonce || params.get('session') !== event.data?.session || event.data?.hash !== hash) return;
    const reply = event.ports[1] || event.ports[0];
    try {
      const clear = Clear.safeParse(event.data);
      if (clear.success && event.ports.length === 1) {
        epoch++; manifest = undefined;
        for (const id of [...sessions.keys()]) close(id);
        await caches.delete(CONTENT);
        reply.postMessage({ ...clear.data, type: 'cleared', ok: true }); reply.close(); return;
      }
      if (Pin.safeParse(event.data).success && event.ports.length === 1) {
        await pin(); reply.postMessage({ type: 'pinned' }); reply.close(); return;
      }
      const { proof, ...data } = event.data || {};
      const parsed = Init.safeParse(data);
      if (!parsed.success || event.ports.length !== 2) return;
      const verified = await verifyAuthority(hash, proof as AuthorityProof, await limits());
      close(parsed.data.session);
      manifest = verified;
      try { await (await caches.open(CONTENT)).put(AUTHORITY, new Response(encodeAuthority(proof))); } catch { /* Pin checks persistence. */ }
      const session: Session = { id: parsed.data.session, bootstrap: source.id, port: event.ports[0], pending: new Map() };
      sessions.set(session.id, session);
      session.port.onmessage = event => {
        const result = ReplySchema.safeParse(event.data);
        if (!result.success || result.data.session !== session.id || result.data.hash !== hash) return;
        session.pending.get(result.data.id)?.finish(result.data);
      };
      session.port.start(); reply.postMessage({ type: 'bound' }); reply.close();
    } catch (error) { reply?.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'Viewer preparation failed' }); reply?.close(); }
  })());
});

sw.addEventListener('fetch', (event: any) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;
  event.respondWith((async () => {
    if (url.pathname.startsWith(VIEWER_BOOT)) return await shellResponse(event.request, VIEWER_BOOT) || new Response('Not found', { status: 404 });
    try {
      if (!['GET', 'HEAD'].includes(event.request.method)) return new Response('GET and HEAD only', { status: 405, headers: { Allow: 'GET, HEAD' } });
      const current = await authority();
      const path = urlPath(url.pathname);
      if (!path) {
        const target = new URL(current.entrypoint.split('/').map(encodeURIComponent).join('/'), sw.location.origin + '/');
        target.search = url.search;
        return Response.redirect(target.href, 302);
      }
      filePath(path);
      const record = current.files.find(f => f.path === path);
      if (!record) throw new Fault(404, 'File not found');
      const bytes = await file(path, event.request.signal);
      const headers = { 'Content-Type': record.mime, 'Content-Length': String(bytes.length), 'Content-Security-Policy': policy, 'Cross-Origin-Opener-Policy': 'same-origin', 'Origin-Agent-Cluster': '?1', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
      return new Response(event.request.method === 'HEAD' ? null : bytes.slice().buffer, { status: 200, headers });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'Viewer failed', { status: error instanceof Fault ? error.status : 503, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
  })());
});
