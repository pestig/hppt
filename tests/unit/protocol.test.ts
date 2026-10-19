import { describe, it, expect } from 'vitest';
import { makeManifest, mapTorrentFiles, parseAddress, validateManifest, verify, urlPath, DEFAULT_LIMITS } from '@htppt/protocol';
import { siteURL } from '@htppt/protocol/site';
const hash = 'a'.repeat(40);
describe('URI and path validation', () => {
  it('accepts previously shared addresses with the same path validation', () => {
    expect(parseAddress(`web+htppt://${hash}/pages/home.html?mode=1#hello`)).toEqual(parseAddress(`web+hppt://${hash}/pages/home.html?mode=1#hello`));
    expect(() => parseAddress(`web+htppt://${hash}/%2e%2e/private`)).toThrow();
  });
  it('resolves omitted and root paths through the manifest, preserving query and fragment', () => {
    for (const suffix of ['', '/']) expect(parseAddress(`web+hppt://${hash}${suffix}`).path).toBeNull();
    const uri = parseAddress(`web+hppt://${hash}?mode=1#hello`);
    expect(siteURL('https://viewer.example', uri.hash, uri.path ?? 'pages/home.html', uri.query, uri.fragment)).toBe(`https://${hash}.viewer.example/pages/home.html?mode=1#hello`);
    expect(parseAddress(`web+hppt://${hash}/about.html`).path).toBe('about.html');
  });
  it.each(['/../secret', '/a/../b', '/%2e%2e/private', '/a%2fb', '/a%5cb', '/%252e%252e/private', '/%00', '/a\\b', '//b', '/./a', '/bad%ZZ'])('rejects unsafe raw path %s', path => {
    expect(() => parseAddress(`web+hppt://${hash}${path}`)).toThrow();
  });
  it('rejects injected trackers, credentials, uppercase and v2 hashes', () => {
    for (const uri of [`web+hppt://${'A'.repeat(40)}`, `web+hppt://${'a'.repeat(64)}`, `web+hppt://user@${hash}`, `https://${hash}/`]) expect(() => parseAddress(uri)).toThrow();
  });
  it('uses case-sensitive NFC paths without decoding twice', () => {
    expect(urlPath('/%C3%A1.html')).toBe('á.html');
    expect(urlPath('/About.html')).toBe('About.html');
    expect(() => urlPath('/a%CC%81.html')).toThrow();
  });
});
describe('manifest, integrity and torrent boundary', () => {
  const files = [{ path: 'pages/home.html', bytes: new TextEncoder().encode('<h1>Hello</h1>') }, { path: 'style.css', bytes: new TextEncoder().encode('body{}') }];
  it('accepts a nested HTML entrypoint with no index.html', async () => {
    const manifest = await makeManifest(files, 'pages/home.html');
    expect(manifest.entrypoint).toBe('pages/home.html');
    expect(manifest.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(verify(files[0].bytes, manifest.files[0])).resolves.toBeUndefined();
    await expect(verify(new TextEncoder().encode('<h1>Hella</h1>'), manifest.files[0])).rejects.toThrow('Integrity');
  });
  it('rejects absent, missing, non-HTML and non-normalized entrypoints', async () => {
    const manifest = await makeManifest(files, 'pages/home.html');
    for (const entrypoint of [undefined, 'missing.html', 'style.css', '/pages/home.html', '../home.html']) expect(() => validateManifest({ ...manifest, entrypoint })).toThrow();
  });
  it('enforces reserved paths, duplicates, MIME and configured limits', async () => {
    const manifest = await makeManifest(files, 'pages/home.html');
    expect(() => validateManifest({ ...manifest, files: [...manifest.files, manifest.files[0]] })).toThrow('Duplicate');
    expect(() => validateManifest({ ...manifest, files: [{ ...manifest.files[0], mime: 'text/css; charset=utf-8' }] })).toThrow('MIME');
    expect(() => validateManifest(manifest, { ...DEFAULT_LIMITS, total: 1 })).toThrow('size');
    expect(() => validateManifest(manifest, { ...DEFAULT_LIMITS, files: 1 })).toThrow('count');
    await expect(makeManifest([{ path: 'htppt-manifest.json', bytes: new Uint8Array() }], 'home.html')).rejects.toThrow('reserved');
    await expect(makeManifest([...files, { path: '__hppt/worker.js', bytes: new Uint8Array() }], 'pages/home.html')).rejects.toThrow('reserved');
  });
  it('maps the torrent root once and checks every size and path', async () => {
    const manifest = await makeManifest(files, 'pages/home.html');
    const torrent = [{ path: 'site/htppt-manifest.json', length: 99 }, ...manifest.files.map(f => ({ path: `site/${f.path}`, length: f.size }))];
    expect([...mapTorrentFiles('site', torrent, manifest).keys()]).toContain('pages/home.html');
    expect(() => mapTorrentFiles('site', [...torrent, { path: 'site/evil.js', length: 1 }], manifest)).toThrow('count');
    expect(() => mapTorrentFiles('site', torrent.map((f, i) => i ? { ...f, length: 0 } : f), manifest)).toThrow('mismatch');
  });
});
