/** VERIFIED: Copy-on-write B+tree paths keep old snapshot roots immutable. */
import type { Child, Entry, Page, Ref } from './types.js';
import { corrupt, key, reference, natural, DbsonlError } from './common.js';
import type { Appender } from './io.js';
export const FANOUT = 32;
export type LoadPage = (ref: Ref) => Page | Promise<Page>;

/** Validate address monotonicity: every child predates its parent, ruling out disk cycles. */
export function validatePage(value: unknown, ref: Ref): Page {
  const page = value as Page;
  if (!page || (page.kind !== 'leaf' && page.kind !== 'branch')) corrupt('Invalid index page kind.');
  const items = page.kind === 'leaf' ? page.entries : page.children;
  if (!Array.isArray(items) || !items.length || items.length > FANOUT) corrupt('Invalid index fanout.');
  let previous: string | undefined;
  for (const item of items) {
    if (!item || typeof item !== 'object') corrupt('Invalid index entry.');
    const label = page.kind === 'leaf' ? (item as Entry).key : (item as Child).max;
    try { key(label); } catch { corrupt('Invalid index key.'); }
    if (previous !== undefined && previous >= label) corrupt('Index keys are not strictly ordered.');
    previous = label;
    reference(item.ref, ref.offset);
    const count = page.kind === 'leaf' ? (item as Entry).revision : (item as Child).count;
    if (!Number.isSafeInteger(count) || count < 1) corrupt('Invalid index count or revision.');
  }
  return page;
}
/** Store one page and its parent's routing summary. */
async function save(writer: Appender, page: Page): Promise<Child> {
  const ref = await writer.value(page, true);
  const max = page.kind === 'leaf' ? page.entries.at(-1)!.key : page.children.at(-1)!.max;
  const count = page.kind === 'leaf' ? page.entries.length : page.children.reduce((sum, child) => sum + child.count, 0);
  natural(count, 'key count');
  return { ref, max, count };
}
function lower<T>(items: readonly T[], key: string, label: (item: T) => string): number {
  let start = 0, end = items.length;
  while (start < end) { const mid = (start + end) >>> 1; if (label(items[mid]!) < key) start = mid + 1; else end = mid; }
  return start;
}
/** Lookup requires one page per level rather than a database-sized in-memory map. */
export async function find(load: LoadPage, root: Ref | null, key: string): Promise<Entry | undefined> {
  let ref = root;
  for (let depth = 0; ref; depth++) {
    if (depth > 64) corrupt('Index depth exceeds the format safety bound.');
    // Cached pages are already immutable and resident. Avoid a Promise and a
    // microtask per tree level; only a cache miss needs asynchronous I/O.
    const loaded = load(ref); const page = 'kind' in loaded ? loaded : await loaded;
    if (page.kind === 'leaf') { const entry = page.entries[lower(page.entries, key, item => item.key)]; return entry?.key === key ? entry : undefined; }
    ref = page.children[lower(page.children, key, item => item.max)]?.ref ?? null;
  }
  return undefined;
}
/** Ordered traversal holds at most one path and supports pruning at each level. */
export async function* entries(load: LoadPage, root: Ref | null, gte?: string, lt?: string, depth = 0): AsyncIterableIterator<Entry> {
  if (!root) return;
  if (depth > 64) corrupt('Index depth exceeds the format safety bound.');
  const page = await load(root);
  if (page.kind === 'leaf') {
    for (const entry of page.entries) { if (gte !== undefined && entry.key < gte) continue; if (lt !== undefined && entry.key >= lt) break; yield entry; }
  } else {
    let prior: string | undefined;
    for (const child of page.children) {
      if (lt !== undefined && prior !== undefined && prior >= lt) break;
      if (gte === undefined || child.max >= gte) yield* entries(load, child.ref, gte, lt, depth + 1);
      prior = child.max;
    }
  }
}
type Link = Ref | DirtyPage;
type Route = { max: string; count: number; ref: Link };
type DirtyPage = { kind: 'leaf'; entries: Entry[] } | { kind: 'branch'; children: Route[] };

/**
 * Batch-local mutable paths coalesce repeated edits before writing. Only immutable
 * committed pages are shared with readers; dirty nodes are never published directly.
 * This avoids serializing every intermediate root within one atomic transaction.
 */
export class BatchTree {
  private root: Link | null;
  private count: number;
  private loadedBytes = 0;
  constructor(private readonly writer: Appender, root: Ref | null, count: number, private readonly byteBudget: number) { this.root = root; this.count = count; }
  private async editable(link: Link | null): Promise<DirtyPage> {
    if (!link) return { kind: 'leaf', entries: [] };
    if ('kind' in link) return link;
    if (this.loadedBytes + link.byteLength > this.byteBudget) throw new DbsonlError('LIMIT_EXCEEDED', 'Dirty index paths exceed the transaction byte budget.');
    this.loadedBytes += link.byteLength;
    const page = validatePage(await this.writer.read(link), link);
    return page.kind === 'leaf' ? { kind: 'leaf', entries: page.entries.slice() } : { kind: 'branch', children: page.children.slice() };
  }
  private route(page: DirtyPage): Route {
    const max = page.kind === 'leaf' ? page.entries.at(-1)!.key : page.children.at(-1)!.max;
    const count = page.kind === 'leaf' ? page.entries.length : page.children.reduce((sum, item) => sum + item.count, 0);
    natural(count, 'key count'); return { max, count, ref: page };
  }
  async apply(key: string, entry: Entry | undefined): Promise<void> {
    const edit = async (link: Link | null, depth: number): Promise<Route[]> => {
      if (depth > 64) corrupt('Index depth exceeds the format safety bound.');
      const page = await this.editable(link);
      if (page.kind === 'leaf') {
        const at = lower(page.entries, key, item => item.key), exists = page.entries[at]?.key === key;
        if (entry) page.entries.splice(at, exists ? 1 : 0, entry); else if (exists) page.entries.splice(at, 1);
        if (!page.entries.length) return [];
        if (page.entries.length > FANOUT) {
          const right = page.entries.splice(Math.ceil(page.entries.length / 2));
          return [this.route(page), this.route({ kind: 'leaf', entries: right })];
        }
      } else {
        const at = Math.min(page.children.length - 1, lower(page.children, key, item => item.max));
        page.children.splice(at, 1, ...await edit(page.children[at]!.ref, depth + 1));
        if (!page.children.length) return [];
        if (page.children.length > FANOUT) {
          const right = page.children.splice(Math.ceil(page.children.length / 2));
          return [this.route(page), this.route({ kind: 'branch', children: right })];
        }
      }
      return [this.route(page)];
    };
    const changed = await edit(this.root, 0);
    if (!changed.length) { this.root = null; this.count = 0; return; }
    const result = changed.length === 1 ? changed[0]! : this.route({ kind: 'branch', children: changed });
    this.root = result.ref; this.count = result.count;
    while (this.root && 'kind' in this.root && this.root.kind === 'branch' && this.root.children.length === 1) this.root = this.root.children[0]!.ref;
  }
  /** Children flush first, preserving backward-only references without an in-place page write. */
  async finish(): Promise<{ root: Ref | null; count: number }> {
    const persist = async (link: Link): Promise<Ref> => {
      if (!('kind' in link)) return link;
      let page: Page;
      if (link.kind === 'leaf') page = link;
      else {
        const children: Child[] = [];
        for (const child of link.children) children.push({ ...child, ref: await persist(child.ref) });
        page = { kind: 'branch', children };
      }
      return this.writer.value(page, true);
    };
    return { root: this.root ? await persist(this.root) : null, count: this.count };
  }
}

/** Streaming bulk load retains at most FANOUT references per level, never all keys. */
export class BulkTree {
  private leaf: Entry[] = [];
  private levels: Child[][] = [];
  constructor(private readonly writer: Appender) {}
  private async push(child: Child, level: number): Promise<void> {
    const items = this.levels[level] ?? (this.levels[level] = []); items.push(child);
    if (items.length === FANOUT) { this.levels[level] = []; await this.push(await save(this.writer, { kind: 'branch', children: items }), level + 1); }
  }
  async add(entry: Entry): Promise<void> {
    this.leaf.push(entry);
    if (this.leaf.length === FANOUT) { const items = this.leaf; this.leaf = []; await this.push(await save(this.writer, { kind: 'leaf', entries: items }), 0); }
  }
  async finish(): Promise<{ root: Ref | null; count: number }> {
    if (this.leaf.length) { await this.push(await save(this.writer, { kind: 'leaf', entries: this.leaf }), 0); this.leaf = []; }
    for (let level = 0; level < this.levels.length; level++) {
      const items = this.levels[level]!;
      if (!items.length) continue;
      if (items.length === 1 && this.levels.slice(level + 1).every(next => !next.length)) return { root: items[0]!.ref, count: items[0]!.count };
      this.levels[level] = []; await this.push(await save(this.writer, { kind: 'branch', children: items }), level + 1);
    }
    return { root: null, count: 0 };
  }
}
