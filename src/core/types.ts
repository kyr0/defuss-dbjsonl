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
export interface Head {
  dbsonl: 2; publication: number; revision: number; generation: string;
  root: Ref | null; count: number; end: number;
}
export type Mutation<T> = { operation: 'put'; key: string; value: T } | { operation: 'delete'; key: string };
export type Lookup<T> = { found: false; value?: never; revision?: never } | { found: true; value: T; revision: number };
export interface Row<T> { key: string; value: T; revision: number }
export interface ScanOptions { gte?: string; lt?: string; limit?: number; signal?: CancellationSignal }
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
