// Keep separate origins in the same schemeful site so a site's helper iframe
// and its top-level window share the browser's unpartitioned worker/storage.
export function normalizeAppOrigin(value = 'http://app.hppt.localhost:5173') {
  const url = new URL(value);
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = 'app.hppt.localhost';
  return url.origin;
}
export function normalizeViewerOrigin(value = 'http://hppt.localhost:5174') {
  const url = new URL(value);
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = 'hppt.localhost';
  return url.origin;
}
