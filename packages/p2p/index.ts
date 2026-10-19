import WebTorrent from 'webtorrent/dist/webtorrent.min.js';
import MemoryStore from 'memory-chunk-store';
import { z } from 'zod';
import { assertHash, DEFAULT_LIMITS, Fault, MANIFEST, makeManifest, mapTorrentFiles, validateManifest, verify, type Manifest, type InputFile, type Limits } from '@htppt/protocol';
import { checkSite, listSites, loadFile, loadSite, removeSite, saveSite, storeFile, type StoredSite } from './storage';
import { makeAuthority } from '@htppt/protocol/authority';
export type Config = { appOrigin: string; viewerOrigin: string; tracker: string; iceApi: string; policy: RTCIceTransportPolicy; limits: Limits };
const Ice = z.object({ iceServers: z.array(z.object({ urls: z.array(z.string()), username: z.string().optional(), credential: z.string().optional() })), expiresAt: z.number() });
export async function bounded<T>(promise: Promise<T>, ms = 20000, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Fault(503, 'No peer / operation timed out. Retry.')), ms);
    const abort = () => finish(new DOMException('Aborted', 'AbortError'));
    function finish(error?: unknown, value?: T) { clearTimeout(timeout); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(value!); }
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(value => finish(undefined, value), finish);
  });
}
export class Engine {
  client: any;
  manifests = new Map<string, Manifest>();
  errors: string[] = [];
  cacheHits = 0; cacheMisses = 0; verifiedBytes = 0;
  private expiry = 0;
  private starting?: Promise<any>;
  private opening = new Map<string, Promise<Manifest>>();
  constructor(public config: Config) {}
  private error = (error: Error) => { this.errors.push(error.message.replace(/(?:credential|password|username)[=:].*/gi, '[redacted]')); this.errors = this.errors.slice(-8); };
  private async network() {
    if (!navigator.onLine) throw new Fault(503, 'Offline: only stored sites are available');
    if (this.client && Date.now() < this.expiry) return this.client;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const response = await fetch(this.config.iceApi, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Fault(503, `ICE API: ${response.status}`);
      const ice = Ice.parse(await response.json());
      if (ice.expiresAt * 1000 <= Date.now()) throw new Fault(503, 'Expired TURN credentials');
      const rtcConfig = { iceServers: ice.iceServers, iceTransportPolicy: this.config.policy };
      if (this.client) {
        // Refresh credentials for future offers. Existing RTCPeerConnections remain intact.
        this.client.tracker.rtcConfig = rtcConfig;
        for (const torrent of this.client.torrents) if (torrent.discovery?.tracker) torrent.discovery.tracker._rtcConfig = rtcConfig;
      } else {
        // Bound speculative offers: each unused offer may retain a TURN allocation until expiry.
        this.client = new WebTorrent({ tracker: { rtcConfig, getAnnounceOpts: () => ({ numwant: 2 }) }, maxConns: 8, dht: false, lsd: false, utPex: false, webSeeds: false, natUpnp: false, natPmp: false, utp: false });
        this.client.on('error', this.error);
      }
      const remaining = ice.expiresAt * 1000 - Date.now();
      this.expiry = ice.expiresAt * 1000 - Math.min(60000, Math.max(1000, remaining * 0.2));
      return this.client;
    })();
    try { return await this.starting; } finally { this.starting = undefined; }
  }
  private watch(torrent: any) {
    torrent.on('error', this.error);
    torrent.on('warning', this.error);
    torrent.on('wire', (wire: any) => wire.on('error', this.error));
    return torrent;
  }
  private async seed(files: InputFile[]) {
    const client = await this.network();
    return bounded<any>(new Promise((resolve, reject) => {
      const input = files.map(f => Object.assign(f.bytes.slice(), { name: f.path }));
      const t = this.watch(client.seed(input, { name: 'htppt-site', announce: [this.config.tracker], private: true, pieceLength: 16384, store: MemoryStore, filterJunkFiles: false }, resolve));
      t.once('error', reject);
    }));
  }
  async publish(files: InputFile[], { entrypoint }: { entrypoint: string }) {
    files = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const manifest = await makeManifest(files, entrypoint, this.config.limits);
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    if (manifestBytes.length > 1024 ** 2) throw new Fault(413, 'Manifest exceeds 1 MiB');
    const torrent = await this.seed([...files, { path: MANIFEST, bytes: manifestBytes }]);
    assertHash(torrent.infoHash);
    this.manifests.set(torrent.infoHash, manifest);
    for (const f of files) await storeFile(torrent.infoHash, f.path, f.bytes);
    await saveSite({ hash: torrent.infoHash, manifest, manifestBytes, torrent: new Uint8Array(torrent.torrentFile), pinned: true, savedAt: Date.now() }, this.config.limits);
    this.verifiedBytes += files.reduce((n, f) => n + f.bytes.length, 0);
    return torrent.infoHash as string;
  }
  async open(hash: string): Promise<Manifest> {
    assertHash(hash);
    if (this.manifests.has(hash)) return this.manifests.get(hash)!;
    if (this.opening.has(hash)) return this.opening.get(hash)!;
    const operation = this.doOpen(hash);
    this.opening.set(hash, operation);
    try { return await operation; } finally { this.opening.delete(hash); }
  }
  async authority(hash: string) {
    await this.open(hash);
    const saved = await loadSite(hash);
    if (saved && await checkSite(saved, this.config.limits)) return makeAuthority(hash, saved.torrent, saved.manifestBytes, async path => (await this.readFile(hash, path)).bytes, this.config.limits);
    const torrent = this.client && await this.client.get(hash);
    if (!torrent) throw new Fault(503, 'Open the package before preparing its viewer');
    const file = mapTorrentFiles(torrent.name, torrent.files).get(MANIFEST) as any;
    const manifestBytes = new Uint8Array(await bounded<ArrayBuffer>(file.arrayBuffer()));
    return makeAuthority(hash, new Uint8Array(torrent.torrentFile), manifestBytes, async path => (await this.readFile(hash, path)).bytes, this.config.limits);
  }
  private async doOpen(hash: string) {
    const saved = await loadSite(hash);
    if (saved && await checkSite(saved, this.config.limits)) { this.manifests.set(hash, saved.manifest); return saved.manifest; }
    const client = await this.network();
    let torrent = await client.get(hash);
    try {
      if (!torrent?.ready) torrent = await bounded<any>(new Promise((resolve, reject) => {
        const t = this.watch(client.add(`magnet:?xt=urn:btih:${hash}&tr=${encodeURIComponent(this.config.tracker)}`, { store: MemoryStore, private: true }, resolve));
        t.once('error', reject);
      }));
      if (torrent.length > this.config.limits.total + 1024 ** 2 || torrent.files.length > this.config.limits.files + 1) throw new Fault(413, 'Torrent exceeds limits');
      const mapped = mapTorrentFiles(torrent.name, torrent.files);
      const manifestFile = mapped.get(MANIFEST) as any;
      if (!manifestFile || manifestFile.length > 1024 ** 2) throw new Fault(422, 'Missing / oversized manifest');
      const manifest = validateManifest(JSON.parse(new TextDecoder().decode(await bounded<ArrayBuffer>(manifestFile.arrayBuffer()))), this.config.limits);
      mapTorrentFiles(torrent.name, torrent.files, manifest);
      this.manifests.set(hash, manifest);
      return manifest;
    } catch (error) { await this.stop(hash); throw error; }
  }
  async readFile(hash: string, path: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }> {
    const manifest = await this.open(hash);
    const record = manifest.files.find(f => f.path === path);
    if (!record) throw new Fault(404, 'File not found');
    const cached = await loadFile(hash, path);
    if (cached) { await verify(cached, record); this.cacheHits++; return { bytes: cached, mime: record.mime }; }
    this.cacheMisses++;
    const client = await this.network();
    const torrent = await client.get(hash);
    if (!torrent) throw new Fault(503, 'Engine stopped; reopen the site');
    const file = mapTorrentFiles(torrent.name, torrent.files, manifest).get(path) as any;
    const bytes = new Uint8Array(await bounded<ArrayBuffer>(file.arrayBuffer(), 20000, signal));
    await verify(bytes, record);
    this.verifiedBytes += bytes.length;
    try { await storeFile(hash, path, bytes); } catch { this.error(new Error('Storage quota: file verified but not persisted')); }
    return { bytes, mime: record.mime };
  }
  async pin(hash: string) {
    const manifest = await this.open(hash);
    for (const record of manifest.files) { const f = await this.readFile(hash, record.path); await storeFile(hash, record.path, f.bytes); }
    const previous = await loadSite(hash);
    const torrent = this.client && await this.client.get(hash);
    const site: StoredSite = { hash, manifest, manifestBytes: previous?.manifestBytes || new TextEncoder().encode(JSON.stringify(manifest)), torrent: previous?.torrent || new Uint8Array(torrent.torrentFile), pinned: true, savedAt: Date.now() };
    await saveSite(site, this.config.limits);
    await navigator.storage?.persist?.();
    return site;
  }
  async restore(hash: string) {
    const saved = await loadSite(hash);
    if (!saved || !await checkSite(saved, this.config.limits)) throw new Fault(422, 'Stored package is incomplete');
    const client = await this.network();
    if (await client.get(hash)) return;
    const files: InputFile[] = [];
    for (const record of saved.manifest.files) files.push({ path: record.path, bytes: (await loadFile(hash, record.path))! });
    // Recompute piece hashes from fully SHA-256-verified durable bytes, rebuilding the store.
    const torrent = await this.seed([...files, { path: MANIFEST, bytes: saved.manifestBytes }]);
    if (torrent.infoHash !== hash) { await this.stop(torrent.infoHash); throw new Fault(422, 'Reseed hash mismatch'); }
    this.manifests.set(hash, saved.manifest);
  }
  async restorePinned() {
    for (const site of await listSites()) if (site.pinned) { try { await this.restore(site.hash); } catch (e) { this.error(e as Error); } }
  }
  async unpin(hash: string) {
    const site = await loadSite(hash);
    if (site) { site.pinned = false; await saveSite(site, this.config.limits); }
  }
  async clear(hash: string) { await this.stop(hash); this.manifests.delete(hash); await removeSite(hash); }
  async stop(hash: string) {
    this.manifests.delete(hash);
    const torrent = this.client && await this.client.get(hash);
    if (torrent) await this.client.remove(hash, { destroyStore: true });
  }
  async destroy() { if (this.client) await new Promise<void>(resolve => this.client.destroy(resolve)); this.client = undefined; }
  async getStats() {
    const torrents = this.client?.torrents || [];
    const pairs: any[] = [];
    for (const t of torrents) for (const peer of (t._peers?.values() || []) as Iterable<any>) {
      const pc: RTCPeerConnection | undefined = peer.conn?._pc;
      if (!pc || pc.connectionState === 'closed') continue;
      try {
        const report = await pc.getStats();
        const transport = [...report.values()].find(s => s.type === 'transport' && s.selectedCandidatePairId);
        const pair = transport ? report.get(transport.selectedCandidatePairId) : [...report.values()].find(s => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
        if (pair) {
          const local = report.get(pair.localCandidateId), remote = report.get(pair.remoteCandidateId);
          const data = [...report.values()].filter(s => s.type === 'data-channel');
          pairs.push({ local: local?.candidateType, remote: remote?.candidateType, state: pair.state, connection: pc.connectionState, ice: pc.iceConnectionState, bytesSent: pair.bytesSent, bytesReceived: pair.bytesReceived, dataSent: data.reduce((n, s) => n + (s.bytesSent || 0), 0), dataReceived: data.reduce((n, s) => n + (s.bytesReceived || 0), 0), policy: pc.getConfiguration().iceTransportPolicy });
        }
      } catch { /* Closed between sampling and getStats. */ }
    }
    return { peers: torrents.reduce((n: number, t: any) => n + t.numPeers, 0), downloaded: torrents.reduce((n: number, t: any) => n + t.received, 0), uploaded: torrents.reduce((n: number, t: any) => n + t.uploaded, 0), verifiedBytes: this.verifiedBytes, cacheHits: this.cacheHits, cacheMisses: this.cacheMisses, pairs, errors: this.errors };
  }
}
export { DEFAULT_LIMITS };
