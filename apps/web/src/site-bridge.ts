import type { Config } from '@htppt/p2p';
import type { AuthorityProof } from '@htppt/protocol/authority';
import { VERSION } from '@htppt/protocol';
import { Hello, ViewerStatus, servePort } from '@htppt/viewer-bridge';
import { siteOrigin, VIEWER_BOOT } from '@htppt/protocol/site';

export type SiteBridge = { frame: HTMLIFrameElement; ready: Promise<void>; offline: boolean; refresh: () => Promise<void>; dispose: () => void };
export function createSiteBridge(config: Config, hash: string, proof: AuthorityProof,
  read: (path: string, signal?: AbortSignal) => Promise<{ bytes: Uint8Array; mime: string }>,
  offline = false, onDispose = () => {}) {
  const origin = siteOrigin(config.viewerOrigin, hash);
  const session = crypto.randomUUID(), nonce = crypto.randomUUID();
  const frame = document.createElement('iframe'); frame.hidden = true; frame.title = 'HPPT file server';
  frame.src = `${origin}${VIEWER_BOOT}#${new URLSearchParams({ session, nonce, hash, pin: offline ? '1' : '0' })}`;
  let stopPort: (() => void) | undefined;
  let listener: (event: MessageEvent) => void;
  let timer: ReturnType<typeof setTimeout>;
  const dispose = () => { clearTimeout(timer); window.removeEventListener('message', listener); stopPort?.(); frame.remove(); onDispose(); };
  const ready = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => { dispose(); reject(new Error('Viewer preparation failed. Check the viewer address and browser storage permissions.')); }, 60000);
    listener = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.contentWindow) return;
      const hello = Hello.safeParse(event.data);
      if (hello.success && hello.data.nonce === nonce && hello.data.session === session && hello.data.hash === hash) {
        stopPort?.(); const channel = new MessageChannel();
        stopPort = servePort(channel.port1, session, hash, (path, signal) => read(path, signal));
        frame.contentWindow!.postMessage({ type: 'init', version: VERSION, nonce, session, hash, proof }, origin, [channel.port2]);
      }
      const state = ViewerStatus.safeParse(event.data);
      if (!state.success || state.data.nonce !== nonce || state.data.session !== session || state.data.hash !== hash) return;
      clearTimeout(timer);
      if (state.data.state === 'error') { dispose(); reject(new Error(state.data.text)); }
      else resolve();
    };
    window.addEventListener('message', listener);
  });
  const refresh = () => new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Viewer offline verification timed out')); }, 60000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); if (event.data.type === 'pinned') resolve(); else reject(new Error(event.data.error || 'Viewer offline verification failed')); };
    frame.contentWindow!.postMessage({ type: 'pin', version: VERSION, nonce, session, hash }, origin, [channel.port2]);
  });
  document.body.append(frame);
  return { frame, ready, offline, refresh, dispose };
}
