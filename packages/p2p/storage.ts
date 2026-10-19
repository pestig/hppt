import { assertHash, DEFAULT_LIMITS, filePath, validateManifest, verify, type Manifest, type Limits } from '@htppt/protocol';
export type StoredSite = { hash: string; manifest: Manifest; manifestBytes: Uint8Array; torrent: Uint8Array; pinned: boolean; savedAt: number };
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('htppt-v1', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('sites', { keyPath: 'hash' }); request.result.createObjectStore('files'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest<T>): Promise<T> {
  const tx = (await db()).transaction(stores, mode);
  return new Promise((resolve, reject) => {
    const request = work(tx);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Persistent storage failed'));
  });
}
const key = (hash: string, path: string) => `${assertHash(hash)}/${filePath(path)}`;
export const storeFile = (hash: string, path: string, bytes: Uint8Array) => transaction(['files'], 'readwrite', tx => tx.objectStore('files').put(bytes, key(hash, path)));
export const loadFile = (hash: string, path: string): Promise<Uint8Array | undefined> => transaction(['files'], 'readonly', tx => tx.objectStore('files').get(key(hash, path)));
export const loadSite = (hash: string): Promise<StoredSite | undefined> => transaction(['sites'], 'readonly', tx => tx.objectStore('sites').get(assertHash(hash)));
export const listSites = (): Promise<StoredSite[]> => transaction(['sites'], 'readonly', tx => tx.objectStore('sites').getAll());
export async function saveSite(site: StoredSite, limits: Limits = DEFAULT_LIMITS) {
  validateManifest(site.manifest, limits);
  for (const f of site.manifest.files) {
    const bytes = await loadFile(site.hash, f.path);
    if (!bytes) throw new Error(`Missing durable file: ${f.path}`);
    await verify(bytes, f);
  }
  await transaction(['sites'], 'readwrite', tx => tx.objectStore('sites').put(site));
}
export async function checkSite(site: StoredSite, limits: Limits = DEFAULT_LIMITS): Promise<boolean> {
  try {
    validateManifest(site.manifest, limits);
    for (const f of site.manifest.files) {
      const bytes = await loadFile(site.hash, f.path);
      if (!bytes) return false;
      await verify(bytes, f);
    }
    return true;
  } catch { return false; }
}
export async function removeSite(hash: string) {
  assertHash(hash);
  await transaction(['sites', 'files'], 'readwrite', tx => {
    const store = tx.objectStore('files');
    const cursor = store.openCursor(IDBKeyRange.bound(`${hash}/`, `${hash}/\uffff`));
    cursor.onsuccess = () => { const c = cursor.result; if (c) { c.delete(); c.continue(); } };
    return tx.objectStore('sites').delete(hash);
  });
}
