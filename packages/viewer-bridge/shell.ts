declare const __BUILD__: string;
export const SHELL = `htppt-shell-${__BUILD__}`;
export function installShell(sw: any, refreshOnUpdate = false) {
  sw.addEventListener('install', (event: any) => event.waitUntil((async () => {
    const response = await fetch('/precache.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Shell precache unavailable: run npm run build and npm run serve');
    const files = await response.json();
    const cache = await caches.open(SHELL);
    await cache.addAll(files);
    await sw.skipWaiting();
  })()));
  sw.addEventListener('activate', (event: any) => event.waitUntil((async () => {
    const previous = (await caches.keys()).filter(key => key.startsWith('htppt-shell-') && key !== SHELL);
    for (const key of previous) await caches.delete(key);
    await sw.clients.claim();
    if (refreshOnUpdate && previous.length) {
      // Replacing the controller alone leaves the previous app's JavaScript running.
      // Refresh even legacy pages that have no controllerchange listener yet.
      const clients = await sw.clients.matchAll({ type: 'window' });
      // Navigation fetches wait for activation to finish, so awaiting navigation
      // here would deadlock activation. Queue it and let this event complete.
      for (const client of clients) void client.navigate(client.url).catch(() => { /* The tab may have closed. */ });
    }
  })()));
}
export async function shellResponse(request: Request) {
  const cache = await caches.open(SHELL);
  if (request.mode === 'navigate') {
    const path = new URL(request.url).pathname;
    if (['/', '/index.html', '/open'].includes(path)) return await cache.match('/index.html');
  }
  return await cache.match(request.url, { ignoreSearch: true });
}
