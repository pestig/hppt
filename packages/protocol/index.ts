import { z } from 'zod';

export const VERSION = 'htppt/0.1' as const;
export const MANIFEST = 'htppt-manifest.json';
export const HASH = /^[a-f0-9]{40}$/;
export const DEFAULT_LIMITS = { files: 1000, total: 50 * 1024 ** 2, file: 10 * 1024 ** 2 };
export type Limits = typeof DEFAULT_LIMITS;
export class Fault extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'Fault'; }
}
export function assertHash(hash: string): string {
  if (!HASH.test(hash)) throw new Fault(400, 'Invalid v1 infoHash');
  return hash;
}
/** Paths are case-sensitive, NFC Unicode, with no duplicate aliases. Decode URLs once only. */
export function filePath(path: string): string {
  if (!path || path !== path.normalize('NFC') || /[\\%\u0000-\u001f\u007f?#:]/.test(path)) throw new Fault(400, 'Invalid file path');
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw new Fault(400, 'Invalid path segment');
  return path;
}
export function urlPath(raw: string): string | null {
  if (!raw || raw === '/') return null;
  if (!raw.startsWith('/') || /%2f|%5c/i.test(raw)) throw new Fault(400, 'Encoded separator');
  try { return filePath(decodeURIComponent(raw.slice(1))); }
  catch { throw new Fault(400, 'Invalid URL path'); }
}
export type Address = { hash: string; path: string | null; query: string; fragment: string };
export function parseAddress(value: string): Address {
  // Validate the raw path before URL's dot-segment normalization.
  // Previously shared addresses remain usable after the HPPT branding change.
  const match = /^web\+h(?:t)?ppt:\/\/([a-f0-9]{40})(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(value.trim());
  if (!match) throw new Fault(400, 'Expected web+hppt://<40 lowercase hex hash>[/path]');
  return { hash: assertHash(match[1]), path: urlPath(match[2] || ''), query: match[3] || '', fragment: match[4] || '' };
}
export function encodePath(path: string) { return filePath(path).split('/').map(encodeURIComponent).join('/'); }
export function contentURL(origin: string, address: Address, entrypoint: string) {
  return `${origin}/content/${assertHash(address.hash)}/${encodePath(address.path ?? entrypoint)}${address.query}${address.fragment}`;
}
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', txt: 'text/plain; charset=utf-8', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml', woff: 'font/woff', woff2: 'font/woff2'
};
export const mimeFor = (path: string): string => {
  const mime = MIME[path.split('.').pop()?.toLowerCase() || ''];
  if (!mime) throw new Fault(400, `Unsupported file type: ${path}`);
  return mime;
};
const allowedMimes = [...new Set(Object.values(MIME).flatMap(m => [m, m.split(';')[0]]))];
const FileSchema = z.object({ path: z.string(), mime: z.enum(allowedMimes as [string, ...string[]]), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const ManifestSchema = z.object({ protocol: z.literal(VERSION), entrypoint: z.string(), files: z.array(FileSchema) }).strict();
export type Manifest = z.infer<typeof ManifestSchema>;
export type FileRecord = Manifest['files'][number];
export function validateManifest(input: unknown, limits: Limits = DEFAULT_LIMITS): Manifest {
  const result = ManifestSchema.safeParse(input);
  if (!result.success) throw new Fault(422, 'Invalid manifest schema');
  const manifest = result.data;
  filePath(manifest.entrypoint);
  if (!manifest.files.length || manifest.files.length > limits.files) throw new Fault(413, 'File count limit');
  const paths = new Set<string>();
  let total = 0;
  for (const f of manifest.files) {
    filePath(f.path);
    if (f.path === MANIFEST || paths.has(f.path)) throw new Fault(422, 'Duplicate or reserved path');
    if (f.mime.split(';')[0] !== mimeFor(f.path).split(';')[0]) throw new Fault(422, 'MIME does not match file extension');
    paths.add(f.path); total += f.size;
    if (f.size > limits.file || total > limits.total) throw new Fault(413, 'Package size limit');
  }
  const entry = manifest.files.find(f => f.path === manifest.entrypoint);
  if (!entry || !entry.mime.startsWith('text/html')) throw new Fault(422, 'Entrypoint must be an existing HTML file');
  return manifest;
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
export async function verify(bytes: Uint8Array, record: FileRecord): Promise<void> {
  if (bytes.byteLength !== record.size || await sha256(bytes) !== record.sha256) throw new Fault(422, `Integrity failure: ${record.path}`);
}
export type InputFile = { path: string; bytes: Uint8Array };
export async function makeManifest(files: InputFile[], entrypoint: string, limits = DEFAULT_LIMITS): Promise<Manifest> {
  return validateManifest({ protocol: VERSION, entrypoint, files: await Promise.all(files.map(async f => ({ path: filePath(f.path), mime: mimeFor(f.path), size: f.bytes.byteLength, sha256: await sha256(f.bytes) }))) }, limits);
}
export function mapTorrentFiles<T extends { path: string; length: number }>(name: string, files: T[], manifest?: Manifest): Map<string, T> {
  const map = new Map<string, T>();
  for (const f of files) {
    const path = filePath(f.path.startsWith(`${name}/`) ? f.path.slice(name.length + 1) : f.path);
    if (map.has(path)) throw new Fault(422, 'Duplicate torrent path');
    map.set(path, f);
  }
  if (manifest) {
    if (map.size !== manifest.files.length + 1 || !map.has(MANIFEST)) throw new Fault(422, 'Torrent/manifest file count mismatch');
    for (const f of manifest.files) if (map.get(f.path)?.length !== f.size) throw new Fault(422, 'Torrent/manifest mismatch');
  }
  return map;
}
export function contentPolicy(origin: string, hash: string) {
  const root = `${new URL(origin).origin}/content/${assertHash(hash)}/`;
  return `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${root}; style-src 'unsafe-inline' ${root}; img-src data: ${root}; font-src ${root}; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}
