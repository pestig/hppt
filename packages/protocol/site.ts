import { assertHash, Fault, filePath } from './index.ts';

export const VIEWER_BOOT = '/__hppt/';
export function siteOrigin(viewerOrigin: string, hash: string): string {
  assertHash(hash);
  const url = new URL(viewerOrigin);
  const host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'hppt.localhost' : url.hostname;
  url.hostname = `${hash}.${host}`;
  return url.origin;
}
export function originHash(origin: string): string {
  try { return assertHash(new URL(origin).hostname.split('.')[0]); }
  catch { throw new Fault(400, 'An isolated HPPT site origin is required'); }
}
export function siteURL(viewerOrigin: string, hash: string, path: string, query = '', fragment = '') {
  const url = new URL(siteOrigin(viewerOrigin, hash));
  url.pathname = '/' + filePath(path).split('/').map(encodeURIComponent).join('/');
  url.search = query; url.hash = fragment;
  return url.href;
}
