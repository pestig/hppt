import { it, expect } from 'vitest';
import { makeManifest, MANIFEST } from '@htppt/protocol';
import { makeAuthority, verifyAuthority, encodeAuthority, decodeAuthority } from '@htppt/protocol/authority';
import { siteOrigin, siteURL } from '@htppt/protocol/site';
const encode = (value: any): Uint8Array => {
  const join = (parts: Uint8Array[]) => { const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; } return bytes; };
  const text = (s: string) => new TextEncoder().encode(s);
  if (value instanceof Uint8Array) return join([text(`${value.length}:`), value]);
  if (typeof value === 'string') return encode(text(value));
  if (typeof value === 'number') return text(`i${value}e`);
  if (Array.isArray(value)) return join([text('l'), ...value.map(encode), text('e')]);
  return join([text('d'), ...Object.keys(value).sort().flatMap(key => [encode(key), encode(value[key])]), text('e')]);
};
async function fixture() {
  const files = [{ path: 'index.html', bytes: new TextEncoder().encode('<h1>Proof</h1>' + ' '.repeat(16300)) }, { path: 'style.css', bytes: new TextEncoder().encode('body{}' + ' '.repeat(18000)) }];
  const manifest = await makeManifest(files, 'index.html'), manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const all = [files[0], { path: MANIFEST, bytes: manifestBytes }, files[1]];
  const bytes = new Uint8Array(all.reduce((n, f) => n + f.bytes.length, 0)); let at = 0;
  for (const file of all) { bytes.set(file.bytes, at); at += file.bytes.length; }
  const pieces = new Uint8Array(Math.ceil(bytes.length / 16384) * 20);
  for (let i = 0; i < pieces.length / 20; i++) pieces.set(new Uint8Array(await crypto.subtle.digest('SHA-1', bytes.slice(i * 16384, (i + 1) * 16384))), i * 20);
  const info = { name: 'site', files: all.map(f => ({ path: [f.path], length: f.bytes.length })), 'piece length': 16384, pieces };
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', encode(info).slice().buffer))].map(b => b.toString(16).padStart(2, '0')).join('');
  const proof = await makeAuthority(hash, encode({ info }), manifestBytes, async path => files.find(f => f.path === path)!.bytes);
  return { hash, proof, manifest };
}
it('authenticates a manifest across piece/file boundaries and survives storage serialization', async () => {
  const { hash, proof, manifest } = await fixture();
  expect(proof.pieces.length).toBe(2);
  expect(await verifyAuthority(hash, decodeAuthority(encodeAuthority(proof)))).toEqual(manifest);
});
it('rejects forged metadata, changed piece bytes, wrong origins and missing pieces', async () => {
  const { hash, proof } = await fixture();
  const changed = structuredClone(proof); changed.pieces[0].bytes[0] ^= 1;
  await expect(verifyAuthority(hash, changed)).rejects.toThrow('authority');
  await expect(verifyAuthority('b'.repeat(40), proof)).rejects.toThrow('authority');
  await expect(verifyAuthority(hash, { ...proof, pieces: proof.pieces.slice(1) })).rejects.toThrow('authority');
  const metadata = structuredClone(proof); metadata.torrent[20] ^= 1;
  await expect(verifyAuthority(hash, metadata)).rejects.toThrow();
});
it('maps each content hash to a different origin and keeps real paths, query and fragment', () => {
  const hash = 'a'.repeat(40);
  expect(siteOrigin('http://localhost:5174', hash)).toBe(`http://${hash}.hppt.localhost:5174`);
  expect(siteOrigin('https://sites.example.com', hash)).toBe(`https://${hash}.sites.example.com`);
  expect(siteURL('http://localhost:5174', hash, 'pages/home.html', '?x=1', '#hello')).toBe(`http://${hash}.hppt.localhost:5174/pages/home.html?x=1#hello`);
  expect(() => siteURL('http://localhost:5174', hash, '../other.html')).toThrow();
});
