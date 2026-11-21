/** VERIFIED: Copy-on-write B+tree paths keep old snapshot roots immutable. */
import type { Child, Entry, Page, Partition, Ref } from './types.js';
import { corrupt, key, reference, natural, DbsonlError } from './common.js';
import { decodeCompactPage } from './page.js';
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
/** A decoded page frame: format 4 stores compact bytes, earlier formats a DSON object; any other shape is corrupt. */
export function toPage(value: unknown, ref: Ref, compact: boolean): Page {
  if (compact !== value instanceof Uint8Array) corrupt('Index page encoding does not match the database format.');
  return validatePage(compact ? decodeCompactPage(value as Uint8Array) : value, ref);
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
/** Batch traversal amortizes async generator handoffs over a complete leaf. */
export async function* entryPages(load: LoadPage, root: Ref | null, gte?: string, lt?: string, depth = 0): AsyncIterableIterator<readonly Entry[]> {
  if (!root) return;
  if (depth > 64) corrupt('Index depth exceeds the format safety bound.');
  const loaded = load(root), page = 'kind' in loaded ? loaded : await loaded;
  if (page.kind === 'leaf') {
    const start = gte === undefined ? 0 : lower(page.entries, gte, item => item.key);
    const end = lt === undefined ? page.entries.length : lower(page.entries, lt, item => item.key);
    if (end > start) yield start === 0 && end === page.entries.length ? page.entries : page.entries.slice(start, end);
  } else {
    let prior: string | undefined;
    for (const child of page.children) {
      if (lt !== undefined && prior !== undefined && prior >= lt) break;
      if (gte === undefined || child.max >= gte) yield* entryPages(load, child.ref, gte, lt, depth + 1);
      prior = child.max;
    }
  }
}
export type Link = Ref | DirtyPage;
type Route = { max: string; count: number; ref: Link };
type DirtyPage = { kind: 'leaf'; entries: Entry[] } | { kind: 'branch'; children: Route[] };
/** Format 5: a root or child may be a page held in memory since an earlier commit or a replay; readers load it as is. */
export function isMemoryPage(link: unknown): link is DirtyPage { return !!link && typeof link === 'object' && 'kind' in link; }

/**
 * Batch-local mutable paths coalesce repeated edits before writing. Only immutable
 * committed pages are shared with readers; dirty nodes are never published directly.
 * This avoids serializing every intermediate root within one atomic transaction.
 */
export class BatchTree {
  private root: Link | null;
  private count: number;
  private loadedBytes = 0;
  /** Live key count after the edits applied so far. */
  get size(): number { return this.count; }
  /** Pages this batch appended, for the caller to cache once the root is published. */
  readonly written: { ref: Ref; page: Page }[] = [];
  /** cached returns an already validated committed page, or undefined to read it through the writer or load. */
  private readonly writer: Appender | null;
  private readonly byteBudget: number;
  private readonly cached: (ref: Ref) => Page | undefined;
  /** Format 5 replay has no writer: it reads committed pages through the store. */
  private readonly load: LoadPage | undefined;
  constructor(writer: Appender | null, root: Link | null, count: number, byteBudget: number, cached: (ref: Ref) => Page | undefined = () => undefined, load?: LoadPage) {
    this.writer = writer; this.byteBudget = byteBudget; this.cached = cached; this.root = root; this.count = count; this.load = load;
  }
  /**
   * Pages this batch created or copied. A page held in memory since an earlier commit may be read by a snapshot of
   * that commit, so this batch copies it before editing, as it copies committed pages.
   */
  private readonly mine = new WeakSet<object>();
  /**
   * Format 5: how many more pages the tree holds in memory than before this batch: copies of written pages and pages
   * new from splits, less pages that emptied or collapsed. A copy of an in-memory page replaces it and counts nothing.
   */
  memoryPages = 0;
  /** Format 5: the new root without writing its pages; a later checkpoint's finish() writes them. */
  open(): { root: Link | null; count: number } { return { root: this.root, count: this.count }; }
  /** Committed pages on the next edit's path, found by missing(); each becomes a dirty copy in editable(). */
  private readonly fetched = new Map<Ref, Page>();
  private editable(link: Link | null): DirtyPage {
    if (!link) { const page: DirtyPage = { kind: 'leaf', entries: [] }; this.mine.add(page); this.memoryPages++; return page; }
    if ('kind' in link) {
      if (this.mine.has(link)) return link;
      const copy: DirtyPage = link.kind === 'leaf' ? { kind: 'leaf', entries: link.entries.slice() } : { kind: 'branch', children: link.children.slice() };
      this.mine.add(copy); return copy;
    }
    if (this.loadedBytes + link.byteLength > this.byteBudget) throw new DbsonlError('LIMIT_EXCEEDED', 'Dirty index paths exceed the transaction byte budget.');
    this.loadedBytes += link.byteLength;
    // Committed pages are immutable, so a cached copy equals a reread; editing copies its arrays.
    const page = this.fetched.get(link)!; this.fetched.delete(link);
    const copy: DirtyPage = page.kind === 'leaf' ? { kind: 'leaf', entries: page.entries.slice() } : { kind: 'branch', children: page.children.slice() };
    this.mine.add(copy); this.memoryPages++; return copy;
  }
  /** Collect the committed pages on key's path; return the first one that needs a read, if any. */
  private missing(key: string): Ref | undefined {
    let link: Link | null = this.root;
    for (let depth = 0; link; depth++) {
      if (depth > 64) corrupt('Index depth exceeds the format safety bound.');
      let page: Page | DirtyPage;
      if ('kind' in link) page = link;
      else {
        const known = this.fetched.get(link) ?? this.cached(link);
        if (!known) return link;
        this.fetched.set(link, known); page = known;
      }
      if (page.kind === 'leaf') return undefined;
      // The same child edit() descends into.
      link = (page.children as { ref: Link }[])[Math.min(page.children.length - 1, lower(page.children as { max: string }[], key, item => item.max))]!.ref;
    }
    return undefined;
  }
  private route(page: DirtyPage): Route {
    this.mine.add(page);
    const max = page.kind === 'leaf' ? page.entries.at(-1)!.key : page.children.at(-1)!.max;
    const count = page.kind === 'leaf' ? page.entries.length : page.children.reduce((sum, item) => sum + item.count, 0);
    natural(count, 'key count'); return { max, count, ref: page };
  }
  /**
   * Synchronous when every page on the key's path is dirty or cached, the common case; a promise only
   * when a page must be read. A 1000-write batch awaited about five times per write before.
   */
  apply(key: string, entry: Entry | undefined): void | Promise<void> {
    const ref = this.missing(key);
    if (!ref) { this.edit(key, entry); return; }
    const writer = this.writer;
    const page = this.load ? Promise.resolve(this.load(ref)) : writer!.read<unknown>(ref).then(value => toPage(value, ref, writer!.compact));
    return page.then(page => { this.fetched.set(ref, page); return this.apply(key, entry); });
  }
  private edit(key: string, entry: Entry | undefined): void {
    const edit = (link: Link | null, depth: number): Route[] => {
      if (depth > 64) corrupt('Index depth exceeds the format safety bound.');
      const page = this.editable(link);
      if (page.kind === 'leaf') {
        const at = lower(page.entries, key, item => item.key), exists = page.entries[at]?.key === key;
        if (entry) page.entries.splice(at, exists ? 1 : 0, entry); else if (exists) page.entries.splice(at, 1);
        if (!page.entries.length) { this.memoryPages--; return []; }
        if (page.entries.length > FANOUT) {
          const right = page.entries.splice(Math.ceil(page.entries.length / 2));
          this.memoryPages++;
          return [this.route(page), this.route({ kind: 'leaf', entries: right })];
        }
      } else {
        const at = Math.min(page.children.length - 1, lower(page.children, key, item => item.max));
        page.children.splice(at, 1, ...edit(page.children[at]!.ref, depth + 1));
        if (!page.children.length) { this.memoryPages--; return []; }
        if (page.children.length > FANOUT) {
          const right = page.children.splice(Math.ceil(page.children.length / 2));
          this.memoryPages++;
          return [this.route(page), this.route({ kind: 'branch', children: right })];
        }
      }
      return [this.route(page)];
    };
    const changed = edit(this.root, 0);
    if (!changed.length) { this.root = null; this.count = 0; return; }
    if (changed.length > 1) this.memoryPages++;
    const result = changed.length === 1 ? changed[0]! : this.route({ kind: 'branch', children: changed });
    this.root = result.ref; this.count = result.count;
    while (this.root && 'kind' in this.root && this.root.kind === 'branch' && this.root.children.length === 1) { this.root = this.root.children[0]!.ref; this.memoryPages--; }
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
      const ref = await this.writer!.value(page, true);
      // Validated before publication: a page readers would reject must fail the commit, not enter the cache.
      this.written.push({ ref, page: validatePage(page, ref) });
      return ref;
    };
    return { root: this.root ? await persist(this.root) : null, count: this.count };
  }
}

/**
 * One subtree with its exact row count, or one entry (no ref) with its key. A subtree's keys lie in (low, high]:
 * high is its routing max, low the max of the sibling before it, undefined at the left edge of the tree.
 */
type Piece = { count: number; ref?: Ref; key?: string; low?: string; high?: string };
/** The smallest key of a piece: its own, or the first one down the left edge of its subtree. */
async function firstKey(load: LoadPage, piece: Piece): Promise<string> {
  if (piece.key !== undefined) return piece.key;
  let ref = piece.ref!;
  for (let depth = 0; ; depth++) {
    if (depth > 64) corrupt('Index depth exceeds the format safety bound.');
    const loaded = load(ref), page = 'kind' in loaded ? loaded : await loaded;
    if (page.kind === 'leaf') return page.entries[0]!.key;
    ref = page.children[0]!.ref;
  }
}
/** Replace a subtree by its children, or a leaf by its entries, keeping each child's key interval. */
async function open(load: LoadPage, piece: Piece, next: Piece[]): Promise<void> {
  const loaded = load(piece.ref!), page = 'kind' in loaded ? loaded : await loaded;
  if (page.kind === 'leaf') { for (const entry of page.entries) next.push({ count: 1, key: entry.key }); return; }
  let low = piece.low;
  for (const child of page.children) { next.push({ count: child.count, ref: child.ref, ...(low !== undefined && { low }), high: child.max }); low = child.max; }
}
/**
 * Cut the rows in [gte, lt) into at most parts contiguous key ranges with near-equal row counts. First the subtrees
 * that straddle gte or lt are opened, at most two per level, until every piece lies inside or outside the range; the
 * inside pieces' subtree counts then give the exact number of rows. Next, only subtrees above an eighth of one share
 * are opened, so the cost is a few pages near the root. Each boundary is a real key, the first of the next range: a
 * key one code unit past the previous range's last key could exceed the key length bound that scan options enforce.
 */
export async function split(load: LoadPage, root: Ref | null, total: number, parts: number, gte?: string, lt?: string): Promise<Partition[]> {
  const whole = (count: number): Partition[] => [{ ...(gte !== undefined && { gte }), ...(lt !== undefined && { lt }), count }];
  if (!root || (gte !== undefined && lt !== undefined && gte >= lt)) return whole(0);
  if (gte === undefined && lt === undefined && parts === 1) return whole(total);
  let pieces = await within(load, root, total, gte, lt);
  const rows = pieces.reduce((sum, piece) => sum + piece.count, 0);
  if (!rows || parts === 1) return whole(rows);
  const limit = Math.max(1, Math.floor(rows / parts / 8));
  for (let depth = 0; pieces.some(piece => piece.ref && piece.count > limit); depth++) {
    if (depth > 64) corrupt('Index depth exceeds the format safety bound.');
    const next: Piece[] = [];
    for (const piece of pieces) if (!piece.ref || piece.count <= limit) next.push(piece); else await open(load, piece, next);
    pieces = next;
  }
  const out: Partition[] = [];
  let used = 0, count = 0, low = gte;
  for (let i = 0; i < pieces.length; i++) {
    count += pieces[i]!.count; used += pieces[i]!.count;
    // Cut once the running total reaches the next of parts equal shares; one large piece can skip a share.
    if (i + 1 < pieces.length && out.length + 1 < parts && used * parts >= rows * (out.length + 1)) {
      const high = await firstKey(load, pieces[i + 1]!);
      out.push(low === undefined ? { lt: high, count } : { gte: low, lt: high, count }); low = high; count = 0;
    }
  }
  out.push({ ...(low !== undefined && { gte: low }), ...(lt !== undefined && { lt }), count });
  return out;
}
/**
 * The key of row index (from 0) of [gte, lt), or undefined past its last row. Subtree counts lead the way down, so
 * it costs one page per level besides the range's two boundaries.
 */
export async function keyAt(load: LoadPage, root: Ref | null, total: number, index: number, gte?: string, lt?: string): Promise<string | undefined> {
  if (!root || (gte !== undefined && lt !== undefined && gte >= lt)) return undefined;
  let pieces = await within(load, root, total, gte, lt);
  for (let depth = 0; ; depth++) {
    if (depth > 64) corrupt('Index depth exceeds the format safety bound.');
    let i = 0;
    for (; i < pieces.length && index >= pieces[i]!.count; i++) index -= pieces[i]!.count;
    const piece = pieces[i];
    if (!piece) return undefined;
    if (piece.key !== undefined) return piece.key;
    const next: Piece[] = []; await open(load, piece, next); pieces = next;
  }
}
/** The pieces that hold exactly the rows of [gte, lt), in key order; the subtrees on its two boundaries are opened. */
async function within(load: LoadPage, root: Ref, total: number, gte?: string, lt?: string): Promise<Piece[]> {
  const inside = (piece: Piece) => piece.key !== undefined
    ? (gte === undefined || piece.key >= gte) && (lt === undefined || piece.key < lt)
    : (gte === undefined || (piece.low !== undefined && piece.low >= gte)) && (lt === undefined || piece.high! < lt);
  const outside = (piece: Piece) => piece.key !== undefined ? !inside(piece)
    : (gte !== undefined && piece.high! < gte) || (lt !== undefined && piece.low !== undefined && piece.low >= lt);
  let pieces: Piece[] = [{ count: total, ref: root }];
  for (let depth = 0; pieces.some(piece => !inside(piece) && !outside(piece)); depth++) {
    if (depth > 64) corrupt('Index depth exceeds the format safety bound.');
    const next: Piece[] = [];
    for (const piece of pieces) if (outside(piece)) continue; else if (inside(piece)) next.push(piece); else await open(load, piece, next);
    pieces = next.filter(piece => !outside(piece));
  }
  return pieces;
}
/** Streaming bulk load retains at most FANOUT references per level, never all keys. */
export class BulkTree {
  private leaf: Entry[] = [];
  private levels: Child[][] = [];
  private readonly writer: Appender;
  constructor(writer: Appender) { this.writer = writer; }
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
