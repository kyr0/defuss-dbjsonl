/** VERIFIED: The memory coordinator queues competing owners and keeps reader pins shared. */
import { createMemoryStorage } from 'defuss-storage';
import type { CancellationSignal, MemoryStorageOptions, StorageFile, OpenOptions } from 'defuss-storage';
import type { Backend, Coordinator, Release } from './types.js';
import { abort } from './common.js';

/** Realm-local FIFO coordination; native connections also use it before OS locking. */
export function createMemoryCoordinator(): Coordinator {
  const states = new Map<string, { readers: number; writer: boolean; queue: { shared: boolean; resolve: (release: Release) => void }[] }>();
  const coordinator: Coordinator = {
    async acquire(name, shared = false, signal, tryOnly = false) {
      abort(signal);
      let state = states.get(name);
      if (!state) { state = { readers: 0, writer: false, queue: [] }; states.set(name, state); }
      const current = state;
      const grant = (read: boolean): Release => {
        if (read) current.readers++; else current.writer = true;
        let released = false;
        return async () => {
          if (released) return; released = true;
          if (read) current.readers--; else current.writer = false;
          while (!current.writer && current.queue.length && (!current.readers || current.queue[0]!.shared)) {
            const next = current.queue.shift()!; next.resolve(grant(next.shared));
          }
          if (!current.writer && !current.readers && !current.queue.length) states.delete(name);
        };
      };
      if (!current.writer && !current.queue.length && (shared || !current.readers)) return grant(shared);
      if (tryOnly) return undefined;
      const release = await new Promise<Release>(resolve => current.queue.push({ shared, resolve }));
      try { abort(signal); return release; } catch (error) { await release(); throw error; }
    },
    async syncDirectory() {},
    async retire() {},
  };
  return coordinator;
}

/** Realm-local implementation for a new, isolated memory namespace. */
export function createMemoryBackend(options?: MemoryStorageOptions): Backend {
  return { storage: createMemoryStorage(options), coordinator: createMemoryCoordinator(), durability: 'memory', writeChunkBytes: Math.min(65536, options?.maxWriteBytes ?? 65536, options?.maxPendingWriteBytes ?? 65536) };
}

/**
 * Readers share the I/O lock, writers and removals take it alone. Storage 0.4 shares read-only handles but rejects
 * BUSY when one meets an owner or a removal, so the lock mirrors that rule and turns BUSY into waiting. Always close
 * the Storage handle before unlocking.
 */
export async function withFile<T>(backend: Backend, name: string, open: OpenOptions, work: (file: StorageFile) => Promise<T>): Promise<T> {
  const release = await backend.coordinator.acquire(`io-${name}`, open.readOnly === true && open.shared !== false);
  if (!release) throw new Error('Coordinator did not grant a blocking lock.');
  try {
    const file = await backend.storage.open(name, open);
    try { return await work(file); } finally { await file.close(); }
  } finally { await release(); }
}
/** One cleanup boundary for every coordinator implementation; shared takes the lock in shared mode. */
export async function locked<T>(backend: Backend, name: string, work: () => Promise<T>, signal?: CancellationSignal, shared = false): Promise<T> {
  const release = await backend.coordinator.acquire(name, shared, signal);
  if (!release) throw new Error('Coordinator did not grant a blocking lock.');
  try { abort(signal); return await work(); } finally { await release(); }
}
/** Split writes at the byte adapter's bound; publication still happens only after flush. */
export async function writeBytes(file: StorageFile, offset: number, bytes: Uint8Array, chunkSize: number): Promise<void> {
  for (let used = 0; used < bytes.length; used += chunkSize) await file.write(offset + used, bytes.subarray(used, used + chunkSize));
}
