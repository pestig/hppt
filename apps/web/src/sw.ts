import { installShell, shellResponse, SHELL } from '@htppt/viewer-bridge/shell';
const sw = self as any;
installShell(sw, true);
sw.addEventListener('fetch', (event: any) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== sw.location.origin) return;
  event.respondWith((async () => {
    if (new URL(event.request.url).pathname === '/runtime-config.json') {
      try {
        const response = await fetch(event.request, { signal: AbortSignal.timeout(1500) });
        if (!response.ok) throw new Error('Runtime config unavailable');
        await (await caches.open(SHELL)).put('/runtime-config.json', response.clone()); return response;
      } catch { return await shellResponse(event.request) || new Response('Offline configuration missing', { status: 503 }); }
    }
    return await shellResponse(event.request) || await fetch(event.request);
  })());
});
