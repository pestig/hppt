import { z } from 'zod';
import { Fault, VERSION, HASH, filePath } from '@htppt/protocol';
const Base = z.object({ version: z.literal(VERSION), session: z.string().uuid(), hash: z.string().regex(HASH) });
export const Hello = Base.extend({ type: z.literal('ready'), nonce: z.string().uuid() }).strict();
export const Init = Base.extend({ type: z.literal('init'), nonce: z.string().uuid() }).strict();
export const ViewerStatus = Base.extend({ type: z.literal('viewer-status'), nonce: z.string().uuid(), state: z.enum(['loaded', 'error']), text: z.string().max(8192), uri: z.string().max(8192) }).strict();
export const Clear = Base.extend({ type: z.literal('clear'), nonce: z.string().uuid() }).strict();
export const Cleared = Base.extend({ type: z.literal('cleared'), nonce: z.string().uuid(), ok: z.boolean() }).strict();
export const RequestSchema = Base.extend({ type: z.literal('read'), id: z.string().uuid(), path: z.string() }).strict();
export const CancelSchema = Base.extend({ type: z.literal('abort'), id: z.string().uuid() }).strict();
export const ReplySchema = Base.extend({ type: z.literal('result'), id: z.string().uuid(), status: z.number().int().min(100).max(599), mime: z.string().optional(), bytes: z.instanceof(ArrayBuffer).optional(), error: z.string().optional() }).strict();
export const MAX_PENDING = 32;
export const TIMEOUT = 22000;
export async function workerControl() {
  if (!('serviceWorker' in navigator)) throw new Error('Service Workers require HTTPS / localhost');
  const registration = await navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/', updateViaCache: 'none' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', change); reject(new Error('Worker control timeout')); }, 10000);
    function change() { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', change); resolve(); }
    navigator.serviceWorker.addEventListener('controllerchange', change, { once: true });
    if (navigator.serviceWorker.controller) change();
  });
  return registration;
}
export function servePort(port: MessagePort, session: string, hash: string, read: (path: string, signal: AbortSignal) => Promise<{ bytes: Uint8Array; mime: string }>) {
  const pending = new Map<string, AbortController>();
  port.onmessage = async event => {
    const cancel = CancelSchema.safeParse(event.data);
    if (cancel.success && cancel.data.session === session && cancel.data.hash === hash) { pending.get(cancel.data.id)?.abort(); return; }
    const parsed = RequestSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.session !== session || parsed.data.hash !== hash) return;
    const message = parsed.data;
    const base = { type: 'result', version: VERSION, session, hash, id: message.id };
    if (pending.size >= MAX_PENDING || pending.has(message.id)) { port.postMessage({ ...base, status: 503, error: 'Bridge busy' }); return; }
    const controller = new AbortController();
    pending.set(message.id, controller);
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    controller.signal.addEventListener('abort', () => {
      if (!pending.delete(message.id)) return;
      clearTimeout(timer);
      port.postMessage({ ...base, status: 503, error: 'Read aborted or timed out' });
    }, { once: true });
    try {
      filePath(message.path);
      const result = await read(message.path, controller.signal);
      if (!controller.signal.aborted) { const bytes = result.bytes.slice().buffer; port.postMessage({ ...base, status: 200, mime: result.mime, bytes }, [bytes]); }
    } catch (error) { if (pending.has(message.id)) port.postMessage({ ...base, status: error instanceof Fault ? error.status : 503, error: error instanceof Error ? error.message : 'Bridge failed' }); }
    finally { clearTimeout(timer); pending.delete(message.id); }
  };
  port.start();
  return () => { for (const controller of pending.values()) controller.abort(); pending.clear(); port.close(); };
}
