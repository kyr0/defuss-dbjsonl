/** VERIFIED: Web Locks coordinate independent workers; a generation pin is a held shared lock. */
import type { StorageAdapter } from 'defuss-storage';
import type { Backend, Release } from './core/types.js';
import { abort, natural } from './core/common.js';

/** Minimal structural surface keeps core declarations independent of DOM ambient types. */
export interface WebLockManager {
  request(name: string, options: { mode: 'shared' | 'exclusive'; ifAvailable: boolean }, callback: (lock: unknown | null) => Promise<void>): Promise<void>;
}
/**
 * Supply navigator.locks and the same namespace for every adapter addressing the same files.
 * OPFS flush persists file contents; Web APIs offer no directory-fsync primitive.
 */
export function createBrowserBackend(storage: StorageAdapter, namespace: string, locks: WebLockManager, writeChunkBytes = 65536): Backend {
  if (!namespace || !locks?.request) throw new TypeError('A namespace and Web Lock manager are required.');
  natural(writeChunkBytes, 'writeChunkBytes', 1);
  return { storage, writeChunkBytes, durability: storage.capabilities.persistent ? 'file' : 'memory', coordinator: {
    acquire(name, shared = false, signal, tryOnly = false) {
      abort(signal);
      return new Promise<Release | undefined>((resolve, reject) => {
        const request = locks.request(`defuss-dbsonl:${namespace}:${name}`, { mode: shared ? 'shared' : 'exclusive', ifAvailable: tryOnly }, async lock => {
          if (!lock) { resolve(undefined); return; }
          try { abort(signal); } catch (error) { reject(error); return; }
          let finish!: () => void;
          const held = new Promise<void>(done => { finish = done; });
          resolve(async () => { finish(); await request; });
          await held;
        }).catch(reject);
      });
    },
    async syncDirectory() {},
    async retire() {},
  } };
}
