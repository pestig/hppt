import { z } from 'zod';
import { parseAddress } from '@htppt/protocol';

export const LAUNCH_CHANNEL = 'hppt-launch-v1';
const id = z.string().uuid();
export const LaunchMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('discover'), request: id }),
  z.object({ type: z.literal('available'), request: id, controller: id }),
  z.object({ type: z.literal('prepare'), request: id, controller: id, uri: z.string().max(16384) }),
  z.object({ type: z.literal('prepared'), request: id, controller: id, uri: z.string().max(16384) }),
  z.object({ type: z.literal('failed'), request: id, controller: id, error: z.string() })
]);

// BroadcastChannel is scoped to the trusted application origin. Each request
// selects one controller, so multiple open application tabs do not all download.
export function serveLaunches(prepare: (uri: string) => Promise<string>) {
  const channel = new BroadcastChannel(LAUNCH_CHANNEL), controller = crypto.randomUUID();
  const pending = new Set<string>();
  let closed = false;
  channel.onmessage = event => {
    const parsed = LaunchMessage.safeParse(event.data);
    if (!parsed.success) return;
    const data = parsed.data;
    if (data.type === 'discover') channel.postMessage({ type: 'available', request: data.request, controller });
    if (data.type !== 'prepare' || data.controller !== controller || pending.has(data.request)) return;
    if (pending.size >= 8) { channel.postMessage({ type: 'failed', request: data.request, controller, error: 'Too many concurrent open requests. Try again.' }); return; }
    pending.add(data.request);
    void (async () => {
      try {
        parseAddress(data.uri);
        const uri = await prepare(data.uri);
        if (!closed) channel.postMessage({ type: 'prepared', request: data.request, controller, uri });
      } catch (error) {
        if (!closed) channel.postMessage({ type: 'failed', request: data.request, controller, error: error instanceof Error ? error.message : 'Failed to open.' });
      } finally { pending.delete(data.request); }
    })();
  };
  return () => { closed = true; channel.close(); };
}
