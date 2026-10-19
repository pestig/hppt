// Keep separate origins in the same schemeful site so a site's helper iframe
// and its top-level window share the browser's unpartitioned worker/storage.
export function normalizeAppOrigin(value = 'http://app.hppt.localhost:5173') {
  const url = new URL(value);
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = 'app.hppt.localhost';
  return url.origin;
}
export function normalizeViewerOrigin(value = 'http://hppt.localhost:5173', appOrigin = normalizeAppOrigin()) {
  const url = new URL(value);
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = 'hppt.localhost';
  const app = new URL(appOrigin);
  // Migrate legacy local configurations and custom local ports to one listener.
  if (url.hostname.endsWith('.localhost') && app.hostname.endsWith('.localhost') && url.protocol === app.protocol) url.port = app.port;
  return url.origin;
}
