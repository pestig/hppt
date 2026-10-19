import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { contentURL, encodePath, Fault, filePath, urlPath, verify, VERSION, type Address, type Manifest } from '@htppt/protocol';

export const FRAME_POLICY = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function resolveReference(href: string, current: Address, origin: string): Address | null {
  const raw = href.trim();
  if (/[\\\u0000-\u001f\u007f]/.test(raw) || /%2f|%5c|%25|%00/i.test(raw)) throw new Fault(400, 'Invalid relative URL');
  try { for (const segment of raw.split(/[?#]/)[0].split('/')) if (segment.includes('%') && ['.', '..'].includes(decodeURIComponent(segment))) throw new Error(); }
  catch { throw new Fault(400, 'Encoded dot segment'); }
  const root = `${origin}/content/${current.hash}/`;
  const target = new URL(raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/content/') ? root + raw.slice(1) : raw, contentURL(origin, current, current.path!));
  if (target.origin !== origin || !target.pathname.startsWith(`/content/${current.hash}/`)) return null;
  const path = urlPath(target.pathname.slice(`/content/${current.hash}`.length));
  if (!path) throw new Fault(400, 'A file path is required');
  return { hash: current.hash, path, query: target.search, fragment: target.hash };
}

export class Renderer {
  private assets = new Map<string, Promise<string>>();
  private source = new Map<string, Promise<Uint8Array>>();
  private edges = new Map<string, Set<string>>();
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private manifest: Manifest, private origin: string, private read: (path: string, signal: AbortSignal) => Promise<Uint8Array>, private signal: AbortSignal) {}
  dispose() { this.assets.clear(); this.source.clear(); this.edges.clear(); }
  private dataURL(bytes: Uint8Array | string, mime: string) {
    this.signal.throwIfAborted();
    // Cross-origin opaque frames cannot reliably dereference their parent's blob URLs.
    // Embed only fully verified package bytes; data resources need no network or origin access.
    const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += 16384) chunks.push(String.fromCharCode(...data.subarray(i, i + 16384)));
    return `data:${mime};base64,${btoa(chunks.join(''))}`;
  }
  private bytes(path: string) {
    if (!this.source.has(path)) this.source.set(path, (async () => {
      const record = this.manifest.files.find(f => f.path === path);
      if (!record) throw new Fault(404, `File not found: ${path}`);
      const bytes = await this.fetch(path); await verify(bytes, record); return bytes;
    })());
    return this.source.get(path)!;
  }
  private fetch(path: string): Promise<Uint8Array> {
    this.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cancel = () => { const index = this.queue.indexOf(run); if (index >= 0) this.queue.splice(index, 1); reject(new DOMException('Aborted', 'AbortError')); };
      const run = () => {
        this.signal.removeEventListener('abort', cancel);
        if (this.signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        this.active++;
        this.read(path, this.signal).then(resolve, reject).finally(() => { this.active--; this.queue.shift()?.(); });
      };
      if (this.active < 6) run();
      else { this.queue.push(run); this.signal.addEventListener('abort', cancel, { once: true }); }
    });
  }
  private async asset(href: string, base: Address, chain: string[] = []): Promise<string> {
    const ref = resolveReference(href, base, this.origin);
    // Network URLs remain blocked by the iframe's independent CSP.
    if (!ref) return href;
    const path = filePath(ref.path!);
    if (chain.includes(path)) throw new Fault(422, 'Cyclic CSS import');
    const reaches = (from: string, target: string, visited = new Set<string>()): boolean => {
      if (from === target) return true;
      if (visited.has(from)) return false;
      visited.add(from);
      return [...(this.edges.get(from) || [])].some(next => reaches(next, target, visited));
    };
    if (reaches(path, base.path!)) throw new Fault(422, 'Cyclic resource dependency');
    const edges = this.edges.get(base.path!) || new Set<string>(); edges.add(path); this.edges.set(base.path!, edges);
    if (!this.assets.has(path)) this.assets.set(path, (async () => {
      const record = this.manifest.files.find(f => f.path === path);
      if (!record) throw new Fault(404, `File not found: ${path}`);
      const bytes = await this.bytes(path);
      return this.dataURL(record.mime.startsWith('text/css') ? await this.css(new TextDecoder().decode(bytes), ref, [...chain, path]) : bytes, record.mime);
    })());
    return (await this.assets.get(path)!) + ref.fragment;
  }
  private async cssValue(value: string, base: Address, chain: string[]) {
    const parsed = valueParser(value); const jobs: Promise<void>[] = [];
    parsed.walk(node => {
      if (node.type === 'function' && node.value.toLowerCase() === 'url') {
        const href = node.nodes.length === 1 && node.nodes[0].type === 'string' ? node.nodes[0].value : valueParser.stringify(node.nodes);
        if (href.startsWith('#')) return false;
        jobs.push(this.asset(href, base, chain).then(url => { node.nodes = [{ type: 'string', quote: '"', value: url, sourceIndex: 0, sourceEndIndex: 0 }]; }));
        return false;
      }
    });
    await Promise.all(jobs); return parsed.toString();
  }
  private async css(text: string, base: Address, chain: string[]) {
    const root = postcss.parse(text, { from: undefined }); const jobs: Promise<void>[] = [];
    root.walkDecls(declaration => { jobs.push(this.cssValue(declaration.value, base, chain).then(value => { declaration.value = value; })); });
    root.walkAtRules('import', rule => {
      const parsed = valueParser(rule.params), first = parsed.nodes[0];
      if (first?.type === 'string') jobs.push(this.asset(first.value, base, chain).then(url => { first.value = url; rule.params = parsed.toString(); }));
      else jobs.push(this.cssValue(rule.params, base, chain).then(value => { rule.params = value; }));
    });
    await Promise.all(jobs); return root.toString();
  }
  async document(address: Address, token: string): Promise<string> {
    const record = this.manifest.files.find(f => f.path === address.path);
    if (!record?.mime.startsWith('text/html')) throw new Fault(record ? 415 : 404, 'Requested document must be an existing HTML file');
    const bytes = await this.bytes(address.path!);
    // Template parsing is inert: untrusted HTML cannot fetch in the bootstrap.
    const template = document.createElement('template'); template.innerHTML = new TextDecoder().decode(bytes);
    const nodes = template.content;
    for (const el of nodes.querySelectorAll('base,meta[http-equiv],iframe,frame,object,embed')) el.remove();
    const jobs: Promise<void>[] = [];
    for (const el of nodes.querySelectorAll('*')) {
      for (const attr of ['ping', 'srcset', 'imagesrcset', 'crossorigin', 'integrity', 'download', 'target']) el.removeAttribute(attr);
      if (el.tagName === 'LINK') {
        if (el.getAttribute('rel')?.toLowerCase() !== 'stylesheet') { el.remove(); continue; }
        jobs.push(this.asset(el.getAttribute('href') || '', address).then(url => el.setAttribute('href', url)));
      }
      if (el.tagName === 'STYLE') jobs.push(this.css(el.textContent || '', address, []).then(css => { el.textContent = css; }));
      if (el.hasAttribute('style')) jobs.push(this.cssValue(el.getAttribute('style')!, address, []).then(css => el.setAttribute('style', css)));
      if (['IMG', 'SCRIPT', 'INPUT'].includes(el.tagName) && el.hasAttribute('src')) jobs.push(this.asset(el.getAttribute('src')!, address).then(url => el.setAttribute('src', url)));
      if (['A', 'AREA'].includes(el.tagName) && el.hasAttribute('href')) {
        const href = el.getAttribute('href')!;
        try { const ref = resolveReference(href, address, this.origin); el.setAttribute('href', ref ? contentURL(this.origin, ref, this.manifest.entrypoint) : href); }
        catch { el.setAttribute('href', 'about:invalid'); }
      }
    }
    await Promise.all(jobs); this.signal.throwIfAborted();
    const runtime = `(() => {
      const channel = new MessageChannel();
      parent.postMessage({type:'htppt-content',version:${JSON.stringify(VERSION)},token:${JSON.stringify(token)}}, '*', [channel.port2]);
      addEventListener('click', event => {
        const link = event.composedPath().find(node => node && node.tagName && ['A','AREA'].includes(node.tagName) && node.hasAttribute('href'));
        if (!link) return;
        event.preventDefault(); event.stopImmediatePropagation();
        channel.port1.postMessage({type:'navigate',version:${JSON.stringify(VERSION)},href:link.getAttribute('href')});
      }, true);
      addEventListener('DOMContentLoaded', () => {
        const fragment = ${JSON.stringify(address.fragment)};
        if (fragment) { try { document.getElementById(decodeURIComponent(fragment.slice(1)))?.scrollIntoView(); } catch {} }
      }, {once:true});
    })();`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"><meta name="referrer" content="no-referrer"><script>${runtime.replace(/<\/script/gi, '<\\/script')}</script></head><body>${template.innerHTML}</body></html>`;
  }
}
export const logicalURI = (a: Address) => `web+hppt://${a.hash}/${encodePath(a.path!)}${a.query}${a.fragment}`;
