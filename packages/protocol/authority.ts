import { assertHash, DEFAULT_LIMITS, Fault, filePath, MANIFEST, mapTorrentFiles, validateManifest, type Limits } from './index';

export type AuthorityProof = { torrent: Uint8Array; pieces: { index: number; bytes: Uint8Array }[] };
type Value = Uint8Array | number | Value[] | { [key: string]: Value };
type TorrentFile = { path: string; length: number; offset: number };
const fail = () => new Fault(422, 'Invalid torrent authority proof');
const text = (value: Value) => {
  if (!(value instanceof Uint8Array)) throw fail();
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
};
const digest = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-1', bytes.slice().buffer));
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

// Decode only bounded v1 torrent metadata. Keep the original info bytes: encoding
// the dictionary again could change the infoHash used by existing shared links.
async function torrentInfo(bytes: Uint8Array, hash: string, limits: Limits) {
  assertHash(hash);
  if (!(bytes instanceof Uint8Array) || bytes.length > 2 * 1024 ** 2) throw fail();
  let at = 0, nodes = 0, infoStart = 0, infoEnd = 0;
  function read(depth = 0): Value {
    if (depth > 20 || ++nodes > 30000 || at >= bytes.length) throw fail();
    const token = bytes[at++];
    if (token === 105) {
      const start = at;
      while (at < bytes.length && bytes[at] !== 101) at++;
      const raw = new TextDecoder().decode(bytes.slice(start, at));
      if (bytes[at++] !== 101 || !/^(0|-?[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw fail();
      return Number(raw);
    }
    if (token === 108 || token === 100) {
      const list: Value[] = [], dict: Record<string, Value> = Object.create(null);
      while (at < bytes.length && bytes[at] !== 101) {
        if (token === 108) list.push(read(depth + 1));
        else {
          const key = text(read(depth + 1));
          if (Object.hasOwn(dict, key)) throw fail();
          const start = at;
          dict[key] = read(depth + 1);
          if (depth === 0 && key === 'info') { infoStart = start; infoEnd = at; }
        }
      }
      if (bytes[at++] !== 101) throw fail();
      return token === 108 ? list : dict;
    }
    if (token < 48 || token > 57) throw fail();
    const start = at - 1;
    while (at < bytes.length && bytes[at] !== 58) at++;
    const raw = new TextDecoder().decode(bytes.slice(start, at));
    if (!/^(0|[1-9]\d*)$/.test(raw)) throw fail();
    const length = Number(raw);
    if (bytes[at++] !== 58 || !Number.isSafeInteger(length) || length > bytes.length - at) throw fail();
    const result = bytes.slice(at, at + length); at += length; return result;
  }
  const root = read() as Record<string, any>;
  if (at !== bytes.length || !infoEnd || !root?.info) throw fail();
  const actual = [...await digest(bytes.slice(infoStart, infoEnd))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (actual !== hash) throw fail();
  const info = root.info, pieceLength = info['piece length'], pieces = info.pieces;
  if (!Number.isSafeInteger(pieceLength) || pieceLength < 16384 || pieceLength > 1024 ** 2 || !(pieces instanceof Uint8Array)) throw fail();
  if (!Array.isArray(info.files) || info.files.length > limits.files + 1) throw fail();
  filePath(text(info.name));
  let offset = 0;
  const files: TorrentFile[] = info.files.map((file: any) => {
    if (!Array.isArray(file.path) || !Number.isSafeInteger(file.length) || file.length < 0) throw fail();
    const path = filePath(file.path.map(text).join('/'));
    if (file.length > (path === MANIFEST ? 1024 ** 2 : limits.file)) throw fail();
    const record = { path, length: file.length, offset }; offset += file.length; return record;
  });
  if (offset > limits.total + 1024 ** 2 || pieces.length !== Math.ceil(offset / pieceLength) * 20) throw fail();
  const manifest = files.filter(f => f.path === MANIFEST);
  if (manifest.length !== 1 || !manifest[0].length || manifest[0].length > 1024 ** 2) throw fail();
  return { files, pieceLength, pieces, total: offset, manifest: manifest[0] };
}

export async function makeAuthority(hash: string, torrent: Uint8Array, manifestBytes: Uint8Array, read: (path: string) => Promise<Uint8Array>, limits = DEFAULT_LIMITS): Promise<AuthorityProof> {
  const info = await torrentInfo(torrent, hash, limits);
  const loaded = new Map<string, Uint8Array>([[MANIFEST, manifestBytes]]);
  const first = Math.floor(info.manifest.offset / info.pieceLength);
  const last = Math.floor((info.manifest.offset + info.manifest.length - 1) / info.pieceLength);
  const pieces = [];
  for (let index = first; index <= last; index++) {
    const start = index * info.pieceLength, end = Math.min(start + info.pieceLength, info.total);
    const bytes = new Uint8Array(end - start);
    for (const file of info.files) {
      const from = Math.max(start, file.offset), to = Math.min(end, file.offset + file.length);
      if (to <= from) continue;
      if (!loaded.has(file.path)) loaded.set(file.path, await read(file.path));
      const source = loaded.get(file.path)!;
      if (source.length !== file.length) throw fail();
      bytes.set(source.subarray(from - file.offset, to - file.offset), from - start);
    }
    pieces.push({ index, bytes });
  }
  const proof = { torrent, pieces };
  await verifyAuthority(hash, proof, limits);
  return proof;
}

// Site JavaScript can write its own origin's Cache Storage. Never trust a cached
// manifest just because it was verified previously: bind it to the URL's infoHash.
export async function verifyAuthority(hash: string, proof: AuthorityProof, limits = DEFAULT_LIMITS) {
  if (!proof || !Array.isArray(proof.pieces) || proof.pieces.length > 66) throw fail();
  const info = await torrentInfo(proof.torrent, hash, limits);
  const first = Math.floor(info.manifest.offset / info.pieceLength);
  const last = Math.floor((info.manifest.offset + info.manifest.length - 1) / info.pieceLength);
  if (proof.pieces.length !== last - first + 1) throw fail();
  const manifestBytes = new Uint8Array(info.manifest.length);
  for (let i = 0; i < proof.pieces.length; i++) {
    const { index, bytes } = proof.pieces[i];
    const start = index * info.pieceLength, end = Math.min(start + info.pieceLength, info.total);
    if (index !== first + i || !(bytes instanceof Uint8Array) || bytes.length !== end - start) throw fail();
    if (!equal(await digest(bytes), info.pieces.subarray(index * 20, index * 20 + 20))) throw fail();
    const from = Math.max(start, info.manifest.offset), to = Math.min(end, info.manifest.offset + info.manifest.length);
    manifestBytes.set(bytes.subarray(from - start, to - start), from - info.manifest.offset);
  }
  const manifest = validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)), limits);
  mapTorrentFiles('', info.files, manifest);
  return manifest;
}

export function encodeAuthority(proof: AuthorityProof) {
  return JSON.stringify({ torrent: [...proof.torrent], pieces: proof.pieces.map(p => ({ index: p.index, bytes: [...p.bytes] })) });
}
export function decodeAuthority(value: string): AuthorityProof {
  if (value.length > 16 * 1024 ** 2) throw fail();
  const raw = JSON.parse(value);
  function bytes(value: unknown, max: number) {
    if (!Array.isArray(value) || value.length > max || value.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw fail();
    return new Uint8Array(value);
  }
  if (!Array.isArray(raw.pieces) || raw.pieces.length > 66) throw fail();
  return { torrent: bytes(raw.torrent, 2 * 1024 ** 2), pieces: raw.pieces.map((p: any) => ({ index: p.index, bytes: bytes(p.bytes, 1024 ** 2) })) };
}
