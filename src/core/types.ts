/** VERIFIED: Platform capabilities are explicit; the core never imports an OS API. */
import type { CancellationSignal, StorageAdapter } from 'defuss-storage';

/** An acquired lock is released exactly once, after the protected resource closes. */
export type Release = () => Promise<void>;
/** Shared pins protect generations; exclusive locks serialize short critical sections. */
export interface Coordinator {
  acquire(name: string, shared?: boolean, signal?: CancellationSignal, tryOnly?: boolean): Promise<Release | undefined>;
  /** Persist newly created directory entries before a manifest can reference them. */
  syncDirectory(): Promise<void>;
  /** Remove a generation's obsolete lock files while holding the commit lock. */
  retire(name: string): Promise<void>;
}
/** Use one coordinated namespace. Mixing raw Storage operations with DB operations is unsafe. */
export interface Backend {
  readonly storage: StorageAdapter;
  readonly coordinator: Coordinator;
  /** Largest write chunk accepted by this adapter; factories derive it from configured admission limits. */
  readonly writeChunkBytes: number;
  readonly durability: 'memory' | 'file' | 'file-and-directory';
  /** Optional per-database resources. The engine closes them after draining all work. */
  connect?(name: string): { backend: Backend; close: Release };
  /**
   * Optional concurrent positional reads of immutable committed bytes, or of the
   * manifest under the commit lock. Fill length bytes unless EOF is reached,
   * retrying partial OS reads; return fresh owned bytes, never cached data.
   * Implementations must preserve regular-file, name and read-chunk validation.
   */
  read?(name: string, offset: number, length: number): Promise<Uint8Array>;
  /**
   * Optional: a write is visible to every handle and process on these files before it is flushed, as POSIX page
   * caches are. Format 3 commits then flush only the generation and write the head slot without a flush.
   */
  readonly coherent?: boolean;
  /** Optional worker threads that scanBatches uses for snapshots of at least threshold rows. */
  readonly parallel?: ParallelScanner;
}
/** The decoder and cache budgets a worker opens its handle with, so it fails where the caller's handle would. */
export interface ScanLimits { maxRecordBytes: number; maxCacheBytes: number; maxCachePages: number }
/** One scan for the workers: the database, the pinned head, its key ranges in order and the caller's batch budgets. */
export interface ParallelScanRequest {
  name: string; head: Readonly<Head>; ranges: { gte?: string; lt?: string }[];
  batchSize: number; maxBatchBytes: number; limits: ScanLimits;
}
/** Batches of the ranges in key order, each within maxBatchBytes; close() stops the workers' part of the scan. */
export interface ParallelScan<T> { next(): Promise<Row<T>[] | undefined>; close(): Promise<void> }
export interface ParallelScanner {
  readonly workers: number;
  /** Rows a scan must cover before it runs in workers. */
  readonly threshold: number;
  /** Scans that ran in workers, for tests and diagnostics. */
  readonly scans: number;
  /** Undefined when no worker could start; the caller then scans in its own thread. */
  scan<T>(request: ParallelScanRequest): Promise<ParallelScan<T> | undefined>;
}
/** Capacities bound retained engine work, not the caller's heap or the database size. */
export interface Options {
  create?: boolean;
  maxRecordBytes?: number;
  maxTransactionBytes?: number;
  maxTransactionOperations?: number;
  maxPendingOperations?: number;
  maxPendingBytes?: number;
  maxCacheBytes?: number;
  maxCachePages?: number;
  signal?: CancellationSignal;
}
export interface Ref { offset: number; byteLength: number }
export interface Entry { key: string; ref: Ref; revision: number }
export interface Child { max: string; ref: Ref; count: number }
export type Page = { kind: 'leaf'; entries: Entry[] } | { kind: 'branch'; children: Child[] };
/** Format 2 flushes the head on every commit. Format 3 seals each commit with a record in the generation; see FORMAT.md. */
export interface Head {
  dbsonl: 2 | 3; publication: number; revision: number; generation: string;
  root: Ref | null; count: number; end: number;
  /** Format 3: the generation's random seal, which a commit record must repeat. */
  seal?: string;
}
export type Mutation<T> = { operation: 'put'; key: string; value: T } | { operation: 'delete'; key: string };
export type Lookup<T> = { found: false; value?: never; revision?: never } | { found: true; value: T; revision: number };
export interface Row<T> { key: string; value: T; revision: number }
/** A key range of one snapshot and the exact number of its rows; pass gte and lt to scan or scanBatches. */
export interface Partition { gte?: string; lt?: string; count: number }
/** at: the head of an open snapshot, from ReadSession.head, possibly copied from another worker or process. */
export interface ReadOptions { at?: Readonly<Head> }
export interface ScanOptions { gte?: string; lt?: string; limit?: number; signal?: CancellationSignal }
/** Batch bytes use encoded frame lengths unless a pure retained-size estimator is supplied. */
export interface BatchScanOptions<T> extends ScanOptions { batchSize?: number; maxBatchBytes?: number; sizeOf?: (row: Row<T>) => number }
export interface CommitOptions { ifRevision?: number; signal?: CancellationSignal }
export interface Commit { revision: number; count: number }
export interface Stats extends Commit {
  generation: string; committedBytes: number; cacheBytes: number; cachePages: number;
  durability: Backend['durability'];
}
export interface Transaction<T> {
  readonly revision: number;
  get(key: string): Promise<Lookup<T>>;
  put(key: string, value: T): void;
  delete(key: string): void;
  scan(options?: ScanOptions): AsyncIterableIterator<Row<T>>;
}
