/** VERIFIED: One published root is the atomicity boundary for every batch and transaction. */
import { decodeFrame, encodeFrame } from 'defuss-dson/sequence';
import type { CancellationSignal } from 'defuss-storage';
import { withFile, locked } from './backend.js';
import { DbsonlError, abort, key, name as validateName, options as resolveOptions, natural, corrupt } from './common.js';
import type { Limits } from './common.js';
import { Appender, generationFile, headFile, publish, readHead, readValue, readCachedValue, readCachedValues, windowContains, PAGE_BYTES } from './io.js';
import type { HeadCache, ReadWindow } from './io.js';
import { entries, entryPages, find, validatePage, BulkTree, BatchTree } from './tree.js';
import type { Backend, Entry, Head, Page, Ref, Release, Options, Lookup, Row, ScanOptions, BatchScanOptions, Mutation, Commit, CommitOptions, Stats, Transaction } from './types.js';

type Encoded = { key: string; bytes: Uint8Array | undefined };
/** A transaction's point reads, checked key by key at commit. After a scan or too many reads, whole falls back to the database revision. */
interface ReadSet { snapshot: number; keys: Map<string, number>; whole: boolean }
/** One queued commit. done guards against settling twice when a group falls back to single commits. */
interface Member { input: Encoded[]; ifRevision: number | undefined; reads: ReadSet | undefined; signal: CancellationSignal | undefined; done: boolean; resolve(commit: Commit): void; reject(error: unknown): void }
const GROUP_MEMBERS = 64;
/** Every supported runtime (Node, Bun, browser workers) has these; the ES2022 lib does not declare them. */
const clock = globalThis as unknown as { performance: { now(): number }; setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };
const encodedBytes = (input: Encoded[]) => input.reduce((sum, item) => sum + (item.bytes?.length ?? 0) + item.key.length * 2 + 64, 0);
function newGeneration(): string {
  const crypto = (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto;
  if (!crypto?.randomUUID) throw new DbsonlError('UNSUPPORTED', 'A secure randomUUID implementation is required.');
  return crypto.randomUUID().replaceAll('-', '');
}
function code(error: unknown): string | undefined { return (error as { code?: string })?.code; }
/** Addresses inside a generation are immutable below its published end, so they name a page for good. */
const pageId = (head: Readonly<Head>, ref: Ref) => `${head.generation}:${ref.offset}:${ref.byteLength}`;

/** Immutable root, explicit lifetime. Holding it never reserves the writer's commit lock. */
export class ReadSession<T = unknown> {
  private closed = false;
  private closing: Promise<void> | undefined;
  private pending = new Set<Promise<unknown>>();
  readonly revision: number;
  readonly count: number;
  /** @internal Sessions are created only by the database factory. */
  constructor(private readonly db: {
    load(head: Readonly<Head>, ref: Ref): Page | Promise<Page>;
    value(head: Readonly<Head>, ref: Ref, window?: ReadWindow): Promise<T>;
    cachedValue(head: Readonly<Head>, ref: Ref, window: ReadWindow): T;
    cachedValues(entries: readonly Entry[], start: number, end: number, window: ReadWindow): T[];
    forget(session: ReadSession<T>): void;
  }, readonly head: Readonly<Head>, private readonly release: Release) {
    if (head.root) Object.freeze(head.root);
    this.revision = head.revision; this.count = head.count;
  }
  private work<R>(fn: () => Promise<R>, invokesUserCode = false): Promise<R> {
    if (this.closed) return Promise.reject(new DbsonlError('CLOSED', 'Snapshot is closed.'));
    // A batch can call user sizeOf before its first await; admission must be recorded first.
    const promise = invokesUserCode ? Promise.resolve().then(fn) : fn(); this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  /** Presence is separate from value because undefined is a valid DSON value. */
  get(id: string): Promise<Lookup<T>> {
    key(id);
    return this.work(async () => {
      const entry = await find(ref => this.db.load(this.head, ref), this.head.root, id);
      return entry ? { found: true, value: await this.db.value(this.head, entry.ref), revision: entry.revision } : { found: false };
    });
  }
  /** Yield one owned decoded value per pull, in UTF-16 code-unit key order. */
  scan(options: ScanOptions = {}): AsyncIterableIterator<Row<T>> {
    if (options.gte !== undefined) key(options.gte); if (options.lt !== undefined) key(options.lt);
    const limit = natural(options.limit ?? Number.MAX_SAFE_INTEGER, 'scan limit');
    const { db, head } = this;
    async function* rows() {
      let count = 0;
      const window: ReadWindow = {};
      if (!limit) return;
      for await (const entry of entries(ref => db.load(head, ref), head.root, options.gte, options.lt)) {
        abort(options.signal);
        yield { key: entry.key, revision: entry.revision, value: await db.value(head, entry.ref, window) };
        if (++count >= limit) break;
      }
    }
    const iterator = rows();
    // Track each next(), not the iterator lifetime: a paused consumer cannot delay close forever.
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => this.work(() => iterator.next()),
      return: () => iterator.return(undefined),
      throw: error => iterator.throw(error),
    };
  }
  /** Native bounded batches: one tracked pull per batch and one async traversal per leaf. */
  scanBatches(options: BatchScanOptions<T> = {}): AsyncIterableIterator<readonly Row<T>[], void> {
    const { gte, lt, signal, sizeOf } = options;
    if (gte !== undefined) key(gte); if (lt !== undefined) key(lt);
    const limit = natural(options.limit ?? Number.MAX_SAFE_INTEGER, 'scan limit');
    const batchSize = natural(options.batchSize ?? 256, 'batchSize', 1);
    const maxBytes = natural(options.maxBatchBytes ?? 4 * 1024 * 1024, 'maxBatchBytes', 1);
    if (sizeOf !== undefined && typeof sizeOf !== 'function') throw new TypeError('sizeOf must be a function.');
    const { db, head } = this;
    async function* batches() {
      let count = 0, bytes = 0, batch: Row<T>[] = [];
      const window: ReadWindow = {};
      abort(signal); if (!limit) return;
      for await (const page of entryPages(ref => db.load(head, ref), head.root, gte, lt)) {
        // page[first, last) was decoded in one call; run is empty when that call failed and the rows read one by one.
        let first = 0, last = 0, run: T[] = [];
        for (let i = 0; i < page.length; i++) {
          const entry = page[i]!;
          abort(signal);
          if (i >= last && windowContains(window, entry.ref)) {
            // The frames already in the window, up to what the limit and this batch still take, so a run decodes no row
            // the caller may never ask for.
            const stop = Math.min(page.length, i + limit - count, i + batchSize - batch.length);
            first = i; last = i + 1;
            while (last < stop && windowContains(window, page[last]!.ref)) last++;
            run = last - first > 1 ? db.cachedValues(page, first, last, window) : [];
          }
          // A frame already in the window decodes without an await; only a real read suspends the batch.
          const value = i < last && run.length ? run[i - first] as T : windowContains(window, entry.ref) ? db.cachedValue(head, entry.ref, window) : await db.value(head, entry.ref, window);
          abort(signal);
          const row = { key: entry.key, revision: entry.revision, value };
          const size = natural(sizeOf ? sizeOf(row) : entry.ref.byteLength, 'batch row bytes');
          if (size > maxBytes) throw new DbsonlError('LIMIT_EXCEEDED', 'One row exceeds the batch byte budget.');
          if (batch.length && bytes + size > maxBytes) { yield batch; batch = []; bytes = 0; abort(signal); }
          batch.push(row); bytes += size; count++;
          if (batch.length === batchSize) { yield batch; batch = []; bytes = 0; abort(signal); }
          if (count === limit) { if (batch.length) yield batch; return; }
        }
      }
      if (batch.length) yield batch;
    }
    const iterator = batches();
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => this.work(() => iterator.next(), true),
      return: () => iterator.return(undefined),
      throw: error => iterator.throw(error),
    };
  }
  /** Drain admitted reads before releasing the generation pin used by garbage collection. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => { await Promise.allSettled(this.pending); await this.release(); this.db.forget(this); })();
    return this.closing;
  }
}

/**
 * Multi-client transactional store. Commits queued on one handle publish together under one
 * commit lock; optimistic callbacks detect conflicts on the keys they read.
 */
export class Dbsonl<T = unknown> {
  private closed = false;
  private closing: Promise<void> | undefined;
  private pending = new Set<Promise<unknown>>();
  private sessions = new Set<ReadSession<T>>();
  private cache = new Map<string, { page: Page; bytes: number; used: boolean }>();
  private cacheBytes = 0;
  private reservedBytes = 0;
  private readonly limits: Limits;
  private readonly headCache: HeadCache = {};
  private queue: Member[] = [];
  private draining = false;
  /** The running drain; close() waits for it, because receipts resolve before the group releases the lock. */
  private drained: Promise<void> = Promise.resolve();
  /** The flushed head while this handle's commit group holds the commit lock; see snapshot(). */
  private lockedHead: Head | undefined;
  /** Pins taken under lockedHead; the group keeps the lock until they are granted. */
  private pinning = new Set<Promise<Release>>();
  /** Transactions on this handle that hold a snapshot and have not queued their commit yet; see gather(). */
  private preparing = new Set<object>();
  /** Wakes a group waiting in gather() when a commit arrives or a preparing transaction ends. */
  private arrival: (() => void) | undefined;
  /** Wall time of the last group publication in ms, which bounds gather(). */
  private groupCost = 0;
  constructor(readonly backend: Backend, readonly name: string, options: Options, private readonly closeBackend?: Release) { this.limits = resolveOptions(options); }
  private run<R>(fn: () => Promise<R>): Promise<R> {
    if (this.closed) return Promise.reject(new DbsonlError('CLOSED', 'Database is closed.'));
    if (this.pending.size >= this.limits.maxPendingOperations) return Promise.reject(new DbsonlError('QUEUE_FULL', 'Too many admitted operations.'));
    // Defer execution until after admission is recorded, including synchronous encoder failures.
    const promise = Promise.resolve().then(fn); this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  /** Internal cache returns immutable implementation-owned pages, never application values. */
  private load(head: Readonly<Head>, ref: Ref): Page | Promise<Page> {
    const id = pageId(head, ref);
    return this.cached(id) ?? this.loadUncached(head, ref, id);
  }
  /**
   * Second-chance eviction instead of exact LRU: a hit only marks its page, and eviction moves a marked page
   * to the back once instead of dropping it. Reordering the Map on every hit took about 5% of a memory commit.
   */
  private cached(id: string): Page | undefined {
    const hit = this.cache.get(id);
    if (hit) hit.used = true;
    return hit?.page;
  }
  /** The cold path alone allocates an asynchronous load operation. */
  private async loadUncached(head: Readonly<Head>, ref: Ref, id: string): Promise<Page> {
    return this.remember(id, validatePage(await readValue(this.backend, this.name, head, ref, PAGE_BYTES), ref), ref.byteLength);
  }
  private remember(id: string, page: Page, bytes: number): Page {
    if (bytes > this.limits.maxCacheBytes || !this.limits.maxCachePages) return page;
    // Concurrent reads of the same page must not charge the cache twice.
    const existing = this.cache.get(id); if (existing) return existing.page;
    // Marked on insert: in an A/B of four memory writers this was slightly faster than leaving new pages unmarked.
    this.cache.set(id, { page, bytes, used: true }); this.cacheBytes += bytes;
    while (this.cacheBytes > this.limits.maxCacheBytes || this.cache.size > this.limits.maxCachePages) {
      const [oldest, entry] = this.cache.entries().next().value!;
      this.cache.delete(oldest);
      // Each pass clears a mark, so the loop ends within one round over the cache.
      if (entry.used) { entry.used = false; this.cache.set(oldest, entry); } else this.cacheBytes -= entry.bytes;
    }
    return page;
  }
  /** Values deliberately bypass the page cache so a caller cannot mutate future reads. */
  private value(head: Readonly<Head>, ref: Ref, window?: ReadWindow): Promise<T> { return readValue(this.backend, this.name, head, ref, this.limits.maxRecordBytes, window); }
  private async snapshot(): Promise<ReadSession<T>> {
    // While this handle's own commit group holds the commit lock, no process can publish or collect, and
    // lockedHead is the current flushed head: pin it instead of queueing behind the group's flushes.
    // Without this, every transaction's snapshot waited for the previous group and groups stayed small.
    if (this.lockedHead) {
      const head = this.lockedHead;
      const pinning = this.pin(head); this.pinning.add(pinning);
      try { return this.session(head, await pinning); } finally { this.pinning.delete(pinning); }
    }
    return locked(this.backend, `commit-${this.name}`, async () => {
      const head = await readHead(this.backend, this.name, this.headCache);
      return this.session(head, await this.pin(head));
    });
  }
  private async pin(head: Head): Promise<Release> {
    const release = await this.backend.coordinator.acquire(`pin-${generationFile(this.name, head.generation)}`, true);
    if (!release) throw new Error('Coordinator did not grant generation pin.');
    return release;
  }
  private session(head: Head, release: Release): ReadSession<T> {
    const session = new ReadSession<T>({ load: (head, ref) => this.load(head, ref), value: (head, ref, window) => this.value(head, ref, window), cachedValue: (head, ref, window) => readCachedValue<T>(head, ref, this.limits.maxRecordBytes, window), cachedValues: (entries, start, end, window) => readCachedValues<T>(entries, start, end, this.limits.maxRecordBytes, window), forget: session => { this.sessions.delete(session); } }, Object.freeze(head), release);
    this.sessions.add(session); return session;
  }
  /** Pin the currently published root; subsequent writers do not wait for its lifetime. */
  beginRead(): Promise<ReadSession<T>> { return this.run(() => this.snapshot()); }
  /** Internal lookup only: callers must hold a commit lock or generation pin. */
  private async lookup(head: Head, id: string): Promise<Lookup<T>> {
    const entry = await find(ref => this.load(head, ref), head.root, id);
    return entry ? { found: true, value: await this.value(head, entry.ref), revision: entry.revision } : { found: false };
  }
  get(id: string): Promise<Lookup<T>> {
    key(id);
    // A one-value read has no user-held lifetime. Keeping the commit lock for this
    // bounded read also excludes GC, so allocating a snapshot and a pin is redundant.
    return this.run(() => locked(this.backend, `commit-${this.name}`, async () => {
      const prior = this.headCache.head;
      const current = readHead(this.backend, this.name, this.headCache);
      // Immutable addresses allow the last root's read to overlap the fresh head
      // read. Its result is accepted ONLY when every head byte still agrees.
      // A changed head, even compaction + GC by another process, forces a new lookup.
      const candidate = prior && this.backend.read ? this.lookup(prior, id).then(
        value => ({ ok: true as const, value }), cause => ({ ok: false as const, cause }),
      ) : undefined;
      let head: Head;
      let result: Awaited<typeof candidate>;
      // Drain speculation even on manifest failure before releasing the commit
      // lock: no I/O may outlive its GC exclusion or database close barrier.
      try { head = await current; } finally { result = await candidate; }
      if (result && head === prior) { if (!result.ok) throw result.cause; return result.value; }
      return this.lookup(head, id);
    }));
  }
  /** Capture values synchronously so subsequent caller mutation cannot change an admitted batch. */
  private encode(input: readonly Mutation<T>[]): Encoded[] {
    if (!Array.isArray(input) || input.length > this.limits.maxTransactionOperations) throw new DbsonlError('LIMIT_EXCEEDED', 'Transaction operation capacity exceeded.');
    let bytes = 0;
    return input.map(operation => {
      key(operation.key);
      if (operation.operation !== 'put' && operation.operation !== 'delete') throw new TypeError('Unknown mutation operation.');
      const encoded = operation.operation === 'put' ? encodeFrame(operation.value, { maxRecordBytes: this.limits.maxRecordBytes }) : undefined;
      bytes += (encoded?.length ?? 0) + operation.key.length * 2 + 64;
      if (bytes > this.limits.maxTransactionBytes) throw new DbsonlError('LIMIT_EXCEEDED', 'Transaction encoded-byte capacity exceeded.');
      return { key: operation.key, bytes: encoded };
    });
  }
  /**
   * Queue a commit. The next holder of the commit lock publishes every queued commit with one write,
   * one data flush and one head flush; each keeps its own revision, checks and receipt, so the result
   * equals committing them one by one with no reader in between.
   */
  private commit(input: Encoded[], options: CommitOptions & { reads?: ReadSet }): Promise<Commit> {
    try { abort(options.signal); if (options.ifRevision !== undefined) natural(options.ifRevision, 'ifRevision'); }
    catch (error) { return Promise.reject(error); }
    return new Promise<Commit>((resolve, reject) => {
      const member: Member = { input, ifRevision: options.ifRevision, reads: options.reads, signal: options.signal, done: false,
        resolve: commit => { member.done = true; resolve(commit); }, reject: error => { member.done = true; reject(error); } };
      this.queue.push(member); this.arrival?.();
      if (!this.draining) this.drained = this.drain();
    });
  }
  /** Reject cancelled members; true once nobody is left waiting. */
  private prune(): boolean {
    this.queue = this.queue.filter(member => { try { abort(member.signal); return true; } catch (error) { member.reject(error); return false; } });
    return !this.queue.length;
  }
  private async drain(): Promise<void> {
    this.draining = true;
    // Native and Web Locks waits poll this signal, so a cancelled member leaves the queue while the group waits.
    const prune = () => this.prune();
    const waiting: CancellationSignal = { get aborted() { return prune(); } };
    try {
      while (this.queue.length) {
        try {
          await locked(this.backend, `commit-${this.name}`, async () => {
            const head = await readHead(this.backend, this.name, this.headCache);
            // Set before waiting: a transaction that starts meanwhile pins this head instead of queueing behind the lock.
            this.lockedHead = head;
            try {
              await this.gather();
              let bytes = 0, operations = 0; const group: Member[] = [];
              while (this.queue.length && group.length < GROUP_MEMBERS) {
                const next = this.queue[0]!, size = encodedBytes(next.input);
                if (group.length && (bytes + size > this.limits.maxTransactionBytes || operations + next.input.length > this.limits.maxTransactionOperations)) break;
                bytes += size; operations += next.input.length; group.push(this.queue.shift()!);
              }
              const started = clock.performance.now();
              if (group.length) await this.publishGroup(group, head);
              this.groupCost = clock.performance.now() - started;
            } finally { this.lockedHead = undefined; await Promise.allSettled(this.pinning); }
          }, waiting);
        } catch (error) {
          // ABORTED only means the queue emptied while waiting; members queued since then are drained next.
          // Any other failure to take the lock is shared by everyone still queued.
          if (code(error) !== 'ABORTED') for (const member of this.queue.splice(0)) member.reject(error);
        }
      }
    } finally { this.draining = false; }
  }
  /**
   * Caller holds the commit lock and lockedHead is set. A transaction that already holds its snapshot would
   * otherwise commit just after this group formed and need a group of its own: four writers on one handle
   * alternated between groups of one and three members, each paying both flushes. So wait while such
   * transactions remain, waking on every arrival, for at most half the last group's publication time. One
   * that outlasts the wait is not waited for again, and a lone writer never waits.
   */
  private async gather(): Promise<void> {
    if (!this.preparing.size || !this.groupCost) return;
    const deadline = clock.performance.now() + this.groupCost / 2;
    while (this.preparing.size) {
      const remaining = deadline - clock.performance.now();
      if (remaining <= 0) { this.preparing.clear(); break; }
      await new Promise<void>(resolve => {
        const timer = clock.setTimeout(() => { this.arrival = undefined; resolve(); }, remaining);
        this.arrival = () => { clock.clearTimeout(timer); this.arrival = undefined; resolve(); };
      });
    }
  }
  /** Caller holds the commit lock. Never throws: every member is settled. head is the current head, if known. */
  private async publishGroup(group: Member[], known?: Head): Promise<void> {
    let publishing = false;
    try {
      const head = known ?? await readHead(this.backend, this.name, this.headCache);
      this.lockedHead = head;
      // Decide each member in order against the state the members before it leave behind.
      let revision = head.revision;
      const written = new Set<string>(), accepted: { member: Member; revision: number }[] = [];
      for (const member of group) {
        try {
          abort(member.signal);
          if (member.ifRevision !== undefined && member.ifRevision !== revision) throw new DbsonlError('CONFLICT', 'Database changed since the transaction snapshot.');
          if (member.reads && member.reads.snapshot !== revision) await this.validate(head, member.reads, written);
        } catch (error) { member.reject(error); continue; }
        if (member.input.length) { revision = natural(revision + 1, 'revision'); for (const operation of member.input) written.add(operation.key); }
        accepted.push({ member, revision });
      }
      if (revision === head.revision) { for (const { member } of accepted) member.resolve({ revision, count: head.count }); return; }
      const next = await withFile(this.backend, generationFile(this.name, head.generation), {}, async file => {
        const size = await file.size();
        if (size < head.end) corrupt('Committed generation is truncated.');
        // An interrupted, unpublished transaction owns only bytes after this boundary.
        if (size > head.end) await file.truncate(head.end);
        const writer = new Appender(file, head.end, this.limits, this.backend.writeChunkBytes);
        // A group holds no more operations than one batch may, so one batch's page budget applies; a group
        // that still exceeds it falls back to single commits below.
        const tree = new BatchTree(writer, head.root, head.count, this.limits.maxTransactionBytes, ref => this.cached(pageId(head, ref)));
        const counts: number[] = [];
        for (const { member, revision } of accepted) {
          for (const operation of member.input) {
            abort(member.signal);
            let entry: Entry | undefined;
            // Both calls finish synchronously unless they need I/O; awaiting every write cost a microtask each.
            if (operation.bytes) { const ref = writer.bytes(operation.bytes); entry = { key: operation.key, ref: ref instanceof Promise ? await ref : ref, revision }; }
            const applying = tree.apply(operation.key, entry); if (applying) await applying;
          }
          counts.push(tree.size);
        }
        const { root, count } = await tree.finish();
        await writer.flush();
        await file.flush();
        return { head: { ...head, publication: natural(head.publication + 1, 'publication'), revision, root, count, end: writer.end }, written: tree.written, counts };
      });
      // Cancellation is no longer observed once publication starts: a successful commit gets a receipt.
      publishing = true;
      try { await publish(this.backend, this.name, next.head, this.headCache); }
      catch (cause) { this.lockedHead = undefined; throw new DbsonlError('COMMIT_UNCERTAIN', 'Head publication failed; read the current revision before retrying.', { cause }); }
      this.lockedHead = next.head;
      // Only published pages enter the cache: an unpublished tail is truncated and its addresses reused.
      for (const { ref, page } of next.written) this.remember(pageId(next.head, ref), page, ref.byteLength);
      accepted.forEach(({ member, revision }, index) => member.resolve({ revision, count: next.counts[index]! }));
    } catch (error) {
      // Nothing was published, so one member's failure (a cancellation, a budget, a full disk) must not fail
      // the others: commit them one at a time, each against the then current head.
      if (!publishing && group.length > 1) { for (const member of group) if (!member.done) await this.publishGroup([member]); return; }
      for (const member of group) if (!member.done) member.reject(error);
    }
  }
  /** Each point read must still see the entry revision it saw, or absence (0); a scan needs the whole database unchanged. */
  private async validate(head: Head, reads: ReadSet, written: Set<string>): Promise<void> {
    if (reads.whole) throw new DbsonlError('CONFLICT', 'Database changed since the transaction snapshot.');
    for (const [id, seen] of reads.keys) {
      const entry = written.has(id) ? undefined : await find(ref => this.load(head, ref), head.root, id);
      if (written.has(id) || (entry?.revision ?? 0) !== seen) throw new DbsonlError('CONFLICT', 'A key the transaction read changed after its snapshot.');
    }
  }
  /** Encode at call time, then publish the entire operation list under one new revision. */
  batch(input: readonly Mutation<T>[], options: CommitOptions = {}): Promise<Commit> {
    if (this.closed) return Promise.reject(new DbsonlError('CLOSED', 'Database is closed.'));
    if (this.pending.size >= this.limits.maxPendingOperations) return Promise.reject(new DbsonlError('QUEUE_FULL', 'Too many admitted operations.'));
    let encoded: Encoded[];
    try { abort(options.signal); encoded = this.encode(input); } catch (error) { return Promise.reject(error); }
    const bytes = encodedBytes(encoded);
    if (this.reservedBytes + bytes > this.limits.maxPendingBytes) return Promise.reject(new DbsonlError('QUEUE_FULL', 'Pending encoded-byte capacity exceeded.'));
    this.reservedBytes += bytes;
    const commitOptions = { ...options };
    return this.run(() => this.commit(encoded, commitOptions)).finally(() => { this.reservedBytes -= bytes; });
  }
  /** Replace one key through the same commit protocol used for multi-key batches. */
  put(id: string, value: T, options?: CommitOptions): Promise<Commit> { return this.batch([{ operation: 'put', key: id, value }], options); }
  /** Delete is idempotent in value state, while every nonempty commit receives a revision. */
  delete(id: string, options?: CommitOptions): Promise<Commit> { return this.batch([{ operation: 'delete', key: id }], options); }
  /**
   * Serializable optimistic transaction. The callback runs exactly once; CONFLICT is explicit
   * because retrying user code can repeat external side effects. Reads see staged writes.
   */
  transaction<R>(callback: (transaction: Transaction<T>) => Promise<R> | R, options: { signal?: CancellationSignal } = {}): Promise<{ result: R; revision: number; count: number }> {
    return this.run(async () => {
      const session = await this.snapshot();
      // Counted until its commit is queued or it fails, so a forming group can wait for it; see gather().
      const token = {}; this.preparing.add(token);
      const prepared = () => { if (this.preparing.delete(token)) this.arrival?.(); };
      const staged = new Map<string, Encoded>(); let size = 0, active = true;
      const reads: ReadSet = { snapshot: session.revision, keys: new Map(), whole: false };
      const observe = (id: string, lookup: Lookup<T>) => {
        if (reads.whole || reads.keys.has(id)) return;
        // Tracking stays bounded: past the operation budget the transaction falls back to the database revision.
        if (reads.keys.size >= this.limits.maxTransactionOperations) { reads.whole = true; reads.keys.clear(); return; }
        reads.keys.set(id, lookup.found ? lookup.revision : 0);
      };
      const check = () => { if (!active) throw new DbsonlError('CLOSED', 'Transaction callback has finished.'); abort(options.signal); };
      const stage = (operation: Mutation<T>) => {
        check(); const encoded = this.encode([operation])[0]!;
        const old = staged.get(encoded.key);
        const nextSize = size - (old ? (old.bytes?.length ?? 0) + old.key.length * 2 + 64 : 0) + (encoded.bytes?.length ?? 0) + encoded.key.length * 2 + 64;
        if (nextSize > this.limits.maxTransactionBytes || (!old && staged.size >= this.limits.maxTransactionOperations)) throw new DbsonlError('LIMIT_EXCEEDED', 'Transaction capacity exceeded.');
        if (this.reservedBytes + nextSize - size > this.limits.maxPendingBytes) throw new DbsonlError('QUEUE_FULL', 'Pending encoded-byte capacity exceeded.');
        this.reservedBytes += nextSize - size; size = nextSize; staged.set(encoded.key, encoded);
      };
      const tx: Transaction<T> = {
        revision: session.revision,
        get: async id => {
          check(); key(id); const item = staged.get(id);
          if (item) return item.bytes ? { found: true, value: decodeFrame(item.bytes).value as T, revision: session.revision + 1 } : { found: false };
          const lookup = await session.get(id); observe(id, lookup); return lookup;
        },
        put: (id, value) => stage({ operation: 'put', key: id, value }),
        delete: id => stage({ operation: 'delete', key: id }),
        async *scan(scan = {}) {
          check();
          // A range read cannot be checked key by key: absent keys that appear later are phantoms.
          reads.whole = true; reads.keys.clear();
          // Copy only the bounded overlay. The base remains a pull-driven disk traversal.
          const overlay = [...staged.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
          let at = 0, emitted = 0;
          const limit = natural(scan.limit ?? Number.MAX_SAFE_INTEGER, 'scan limit');
          const inRange = (id: string) => (scan.gte === undefined || id >= scan.gte) && (scan.lt === undefined || id < scan.lt);
          const row = (item: Encoded): Row<T> => ({ key: item.key, revision: session.revision + 1, value: decodeFrame(item.bytes!).value as T });
          if (!limit) return;
          for await (const base of session.scan({ ...scan, limit: Number.MAX_SAFE_INTEGER })) {
            check();
            while (at < overlay.length && overlay[at]!.key < base.key) {
              const item = overlay[at++]!;
              if (item.bytes && inRange(item.key)) { yield row(item); if (++emitted >= limit) return; }
            }
            const item = overlay[at]?.key === base.key ? overlay[at++]! : undefined;
            if (!item || item.bytes) { yield item ? row(item) : base; if (++emitted >= limit) return; }
          }
          while (at < overlay.length) { check(); abort(scan.signal); const item = overlay[at++]!; if (item.bytes && inRange(item.key)) { yield row(item); if (++emitted >= limit) return; } }
        },
      };
      try {
        const result = await callback(tx); active = false;
        this.preparing.delete(token);
        const commit = await this.commit([...staged.values()], { ...options, reads });
        return { result, ...commit };
      } finally { prepared(); active = false; this.reservedBytes -= size; await session.close(); }
    });
  }
  /** Read current persisted metadata without scanning values or warming the index cache. */
  stats(): Promise<Stats> {
    return this.run(() => locked(this.backend, `commit-${this.name}`, async () => {
      const head = await readHead(this.backend, this.name, this.headCache);
      return { revision: head.revision, count: head.count, generation: head.generation, committedBytes: head.end, cacheBytes: this.cacheBytes, cachePages: this.cache.size, durability: this.backend.durability };
    }));
  }
  /** Full logical integrity walk, separate from the O(1) open path. */
  verify(): Promise<{ revision: number; count: number }> {
    return this.run(async () => {
      const session = await this.snapshot(); let count = 0;
      try {
        async function audit(db: Dbsonl<T>, ref: Ref, depth: number): Promise<{ min: string; max: string; count: number }> {
          if (depth > 64) corrupt('Index depth exceeds the format safety bound.');
          const page = await db.load(session.head, ref);
          if (page.kind === 'leaf') {
            for (const entry of page.entries) { if (entry.revision > session.revision) corrupt('Value revision exceeds snapshot.'); await db.value(session.head, entry.ref); }
            return { min: page.entries[0]!.key, max: page.entries.at(-1)!.key, count: page.entries.length };
          }
          let total = 0, minimum = '', prior: string | undefined;
          for (const child of page.children) {
            const actual = await audit(db, child.ref, depth + 1);
            if (actual.max !== child.max || actual.count !== child.count || (prior !== undefined && actual.min <= prior)) corrupt('Branch routing summary or key partition disagrees with child.');
            if (prior === undefined) minimum = actual.min;
            prior = actual.max; total += actual.count;
          }
          return { min: minimum, max: page.children.at(-1)!.max, count: total };
        }
        // Cache is expendable. Verification rereads persisted bytes, even after a prior lookup.
        this.cache.clear(); this.cacheBytes = 0;
        if (session.head.root) count = (await audit(this, session.head.root, 0)).count;
        if (count !== session.count) corrupt('Root key count disagrees with manifest.');
        return { revision: session.revision, count };
      } finally { await session.close(); }
    });
  }
  /**
   * Copy live values into a packed generation. Writers continue during the copy;
   * a concurrent commit causes CONFLICT, never a lost update. Exclusive mode queues
   * writers during the copy and guarantees progress under sustained write traffic.
   */
  compact(options: { mode?: 'optimistic' | 'exclusive'; signal?: CancellationSignal } = {}): Promise<{ revision: number; beforeBytes: number; afterBytes: number }> {
    return this.run(async () => {
      if (options.mode !== undefined && options.mode !== 'optimistic' && options.mode !== 'exclusive') throw new TypeError('Unknown compaction mode.');
      let outerRelease: Release | undefined;
      let pin: Release | undefined;
      let sourcePin: Release | undefined;
      let head!: Head; const generation = newGeneration(); const filename = generationFile(this.name, generation);
      const prepare = async () => {
        head = await readHead(this.backend, this.name, this.headCache);
        sourcePin = await this.backend.coordinator.acquire(`pin-${generationFile(this.name, head.generation)}`, true);
        pin = await this.backend.coordinator.acquire(`pin-${filename}`, true);
      };
      try {
        if (options.mode === 'exclusive') { outerRelease = await this.backend.coordinator.acquire(`commit-${this.name}`, false, options.signal); await prepare(); }
        else await locked(this.backend, `commit-${this.name}`, prepare, options.signal);
        const next = await withFile(this.backend, filename, { create: true, exclusive: true }, async file => {
          const writer = new Appender(file, 0, this.limits, this.backend.writeChunkBytes); const tree = new BulkTree(writer);
          const window: ReadWindow = {};
          for await (const entry of entries(ref => this.load(head, ref), head.root)) {
            abort(options.signal);
            const value = await this.value(head, entry.ref, window);
            await tree.add({ ...entry, ref: await writer.value(value) });
          }
          const packed = await tree.finish();
          if (packed.count !== head.count) corrupt('Compaction key count disagrees with manifest.');
          await writer.flush();
          await file.flush();
          return { ...head, ...packed, generation, end: writer.end, publication: natural(head.publication + 1, 'publication') };
        });
        await this.backend.coordinator.syncDirectory();
        const install = async () => {
          abort(options.signal);
          const current = await readHead(this.backend, this.name, this.headCache);
          if (current.publication !== head.publication) throw new DbsonlError('CONFLICT', 'Database changed during compaction; retry or use exclusive mode.');
          try {
            await publish(this.backend, this.name, next, this.headCache);
            // Both fallback slots must reference the new generation before the old one can be unlinked.
            await publish(this.backend, this.name, { ...next, publication: natural(next.publication + 1, 'publication') }, this.headCache);
          } catch (cause) { throw new DbsonlError('COMMIT_UNCERTAIN', 'Compaction publication failed; reopen or inspect stats.', { cause }); }
        };
        if (outerRelease) await install(); else await locked(this.backend, `commit-${this.name}`, install, options.signal);
        return { revision: head.revision, beforeBytes: head.end, afterBytes: next.end };
      } finally { await sourcePin?.(); await pin?.(); await outerRelease?.(); }
    });
  }
  /** Reclaim unreferenced generations only after every process has released its pin. */
  collect(): Promise<{ removed: string[]; retained: string[] }> {
    return this.run(() => locked(this.backend, `commit-${this.name}`, async () => {
      const head = await readHead(this.backend, this.name, this.headCache);
      // Refresh both slots before reclamation, including recovery after interrupted compaction.
      await publish(this.backend, this.name, { ...head, publication: natural(head.publication + 1, 'publication') }, this.headCache);
      const current = generationFile(this.name, head.generation);
      const removed: string[] = [], retained: string[] = [];
      for (const filename of await this.backend.storage.list()) {
        const prefix = `${this.name}.g-`;
        // Match the complete reserved name, not independent prefix/suffix fragments.
        if (!filename.startsWith(prefix) || !/^[0-9a-f]{32}\.dsq$/.test(filename.slice(prefix.length)) || filename === current) continue;
        const release = await this.backend.coordinator.acquire(`pin-${filename}`, false, undefined, true);
        if (!release) { retained.push(filename); continue; }
        try {
          await locked(this.backend, `io-${filename}`, () => this.backend.storage.remove(filename));
          removed.push(filename);
        } finally { await release(); }
        await this.backend.coordinator.retire(filename);
      }
      await this.backend.coordinator.syncDirectory();
      return { removed, retained };
    }));
  }
  /** Stop admission, drain work, close owned snapshots and discard the expendable cache. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => { await Promise.allSettled(this.pending); await this.drained; try { await Promise.all([...this.sessions].map(session => session.close())); } finally { this.cache.clear(); this.cacheBytes = 0; await this.closeBackend?.(); } })();
    return this.closing;
  }
}

/**
 * A crash inside create can leave an empty head beside empty generations. Nothing was
 * published, so create may proceed. Any byte in the head or a generation fails closed:
 * a truncated head over real data must not be hidden and later collected.
 */
async function interruptedCreate(backend: Backend, name: string): Promise<boolean> {
  const size = (filename: string) => withFile(backend, filename, { readOnly: true }, file => file.size());
  if (await size(headFile(name))) return false;
  const prefix = `${name}.g-`;
  for (const filename of await backend.storage.list()) {
    if (filename.startsWith(prefix) && /^[0-9a-f]{32}\.dsq$/.test(filename.slice(prefix.length)) && await size(filename)) return false;
  }
  return true;
}

/** Open from the persisted root without replaying values or rebuilding a RAM key map. */
export async function openDbsonl<T = unknown>(backend: Backend, name: string, options: Options = {}): Promise<Dbsonl<T>> {
  validateName(name); resolveOptions(options); natural(backend.writeChunkBytes, 'writeChunkBytes', 1); abort(options.signal);
  const connection = backend.connect?.(name);
  backend = connection?.backend ?? backend;
  try {
  await locked(backend, `commit-${name}`, async () => {
    let head: Head;
    try { head = await readHead(backend, name); }
    catch (error) {
      const missing = code(error) === 'NOT_FOUND';
      if (!options.create || (!missing && !(code(error) === 'CORRUPT' && await interruptedCreate(backend, name)))) throw error;
      const generation = newGeneration();
      await withFile(backend, generationFile(name, generation), { create: true, exclusive: true }, file => file.flush());
      // Establish the manifest inode before referencing it; never overwrite an existing invalid head.
      if (missing) await withFile(backend, headFile(name), { create: true, exclusive: true }, file => file.flush());
      await backend.coordinator.syncDirectory();
      head = { dbsonl: 2, publication: 1, revision: 0, generation, root: null, count: 0, end: 0 };
      await publish(backend, name, head);
      await publish(backend, name, { ...head, publication: 2 });
    }
    await withFile(backend, generationFile(name, head.generation), { readOnly: true }, async file => {
      if (await file.size() < head.end) corrupt('Committed generation is truncated.');
    });
  }, options.signal);
  return new Dbsonl<T>(backend, name, options, connection?.close);
  } catch (error) { await connection?.close(); throw error; }
}
