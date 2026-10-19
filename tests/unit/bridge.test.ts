import { it, expect } from 'vitest';
import { Hello, RequestSchema, ReplySchema, servePort, MAX_PENDING } from '@htppt/viewer-bridge';
import { VERSION } from '@htppt/protocol';
it('rejects malformed, unversioned and extra-field messages', () => {
  const message = { type: 'read', version: VERSION, id: crypto.randomUUID(), session: crypto.randomUUID(), hash: 'a'.repeat(40), path: 'home.html' };
  expect(RequestSchema.safeParse(message).success).toBe(true);
  expect(RequestSchema.safeParse({ ...message, version: 'htppt/9' }).success).toBe(false);
  expect(RequestSchema.safeParse({ ...message, evil: 1 }).success).toBe(false);
  expect(Hello.safeParse({ type: 'ready' }).success).toBe(false);
  expect(ReplySchema.safeParse({ ...message, type: 'result', status: 200, bytes: 'not bytes' }).success).toBe(false);
});
it('aborts an uncooperative reader and releases its pending slot', async () => {
  const session = crypto.randomUUID(), hash = 'a'.repeat(40), channel = new MessageChannel();
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const close = servePort(channel.port1, session, hash, () => { started(); return new Promise(() => {}); });
  const id = crypto.randomUUID();
  channel.port2.postMessage({ type: 'read', version: VERSION, id, session, hash, path: 'home.html' });
  await reading;
  const result = new Promise<any>(resolve => { channel.port2.onmessage = e => resolve(e.data); });
  channel.port2.postMessage({ type: 'abort', version: VERSION, id, session, hash });
  expect(await result).toMatchObject({ id, status: 503 });
  close(); channel.port2.close();
});
it('caps pending work and returns a finite busy response', async () => {
  const session = crypto.randomUUID(), hash = 'a'.repeat(40), channel = new MessageChannel();
  const close = servePort(channel.port1, session, hash, () => new Promise(() => {}));
  const response = new Promise<any>(resolve => { channel.port2.onmessage = e => resolve(e.data); });
  for (let i = 0; i <= MAX_PENDING; i++) channel.port2.postMessage({ type: 'read', version: VERSION, id: crypto.randomUUID(), session, hash, path: 'home.html' });
  expect(await response).toMatchObject({ status: 503, error: 'Bridge busy' });
  close(); channel.port2.close();
});
it('a dedicated port cannot read another hash or session', async () => {
  const session = crypto.randomUUID(), hash = 'a'.repeat(40), channel = new MessageChannel();
  let reads = 0;
  const close = servePort(channel.port1, session, hash, async () => { reads++; return { bytes: new Uint8Array([42]), mime: 'text/plain; charset=utf-8' }; });
  const request = { type: 'read', version: VERSION, id: crypto.randomUUID(), session, hash, path: 'test.txt' };
  channel.port2.postMessage({ ...request, hash: 'b'.repeat(40) });
  channel.port2.postMessage({ ...request, session: crypto.randomUUID() });
  const response = new Promise<any>(resolve => { channel.port2.onmessage = event => resolve(event.data); });
  channel.port2.postMessage(request);
  const result = await response;
  expect(reads).toBe(1); expect(result.status).toBe(200); expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([42]));
  close(); channel.port2.close();
});
