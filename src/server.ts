/** VERIFIED: Native whole-file locks survive pauses and release on process death. */
import { open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants, readSync, read, fstat, fstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { createFileStorage } from 'defuss-storage/node';
import type { FileStorageOptions } from 'defuss-storage/node';
import { StorageError } from 'defuss-storage';
import type { Backend, Release } from './core/types.js';
import type { CancellationSignal } from 'defuss-storage';
import { createMemoryCoordinator } from './core/backend.js';
import { abort, name as validateName } from './core/common.js';

/** Keep the Storage error vocabulary when the native read capability bypasses its handle wrapper. */
function readFailure(cause: unknown): unknown {
  const code = (cause as { code?: string })?.code;
  if (code === 'ENOENT') return new StorageError('NOT_FOUND', 'Database file does not exist.', { cause });
  if (code === 'EACCES' || code === 'EPERM') return new StorageError('PERMISSION_DENIED', 'Database read was denied.', { cause });
  if (code === 'ELOOP') return new StorageError('UNSUPPORTED', 'Symlink reads are forbidden.', { cause });
  if (code && /^E[A-Z0-9]+$/.test(code)) return new StorageError('IO_ERROR', 'Native database read failed.', { cause });
  return cause;
}

/**
 * Create a coordinated native namespace. All processes must use this protocol.
 * Whole-file locks avoid macOS process-scoped fcntl lock release surprises.
 * Nonblocking polling also avoids starving libuv with waiting flock jobs.
 */
export async function createFileBackend(root: string, options?: FileStorageOptions): Promise<Backend> {
  // Capture before the first await; later caller mutation cannot change the
  // already validated limits or unexpectedly switch a connection to blocking I/O.
  options = { ...options };
  // Import the addon through its ESM condition even when this entry is required from CJS.
  // @lickle/lock 0.0.1 ships a CJS .js entry inside a type:module package.
  const { Lock, tryLock } = await import('@lickle/lock');
  // The pinned package's public wrapper dispatches even LOCK_NB to the thread
  // pool. Its shipped N-API binding exposes the nonblocking syscall directly.
  // Resolve relative to package.json to work in both installed ESM and CJS builds.
  const bindingPath = join(dirname(createRequire(import.meta.url).resolve('@lickle/lock/package.json')), 'esm.js');
  const native = createRequire(import.meta.url)(bindingPath) as {
    tryLockSync(fd: number, mode: number): boolean;
    lockSync(fd: number, mode: number): void;
    Lock: { Shared: number; Exclusive: number; Unlock: number };
  };
  if (typeof native.tryLockSync !== 'function' || typeof native.lockSync !== 'function') throw new Error('Pinned native locking binding is incompatible.');
  const storage = await createFileStorage(root, options);
  const synchronous = options.io === 'sync';
  const readChunk = options.maxReadBytes ?? 64 * 1024 * 1024;
  const syncDirectoryAt = async (path: string) => {
    const directory = await open(path, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  };
  // Storage may create nested roots. Persist their parent entries as well as the files inside them.
  // Doing this once per factory also detects unsupported directory fsync before creating a database.
  for (let path = storage.root;; path = dirname(path)) {
    await syncDirectoryAt(path);
    if (dirname(path) === path) break;
  }
  const lockPath = (name: string) => {
    if (!/^[a-z0-9_.-]+$/.test(name)) throw new TypeError('Invalid lock name.');
    return join(storage.root, `${name}.lock`);
  };
  const backend: Backend = {
    storage, durability: 'file-and-directory',
    writeChunkBytes: Math.min(65536, options?.maxWriteBytes ?? 65536, options?.maxPendingWriteBytes ?? 65536),
    coordinator: {
      async acquire(name, shared = false, signal, tryOnly = false) {
        abort(signal);
        const file = await open(lockPath(name), constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
          if (!(await file.stat()).isFile()) throw new TypeError('Lock path is not a regular file.');
          for (;;) {
            abort(signal);
            const guard = await tryLock(file, shared ? Lock.Shared : Lock.Exclusive);
            if (guard) {
              let released = false;
              return async () => { if (released) return; released = true; try { await guard.drop(); } finally { await file.close(); } };
            }
            if (tryOnly) { await file.close(); return undefined; }
            await delay(5);
          }
        } catch (error) { await file.close(); throw error; }
      },
      async syncDirectory() {
        // Failing closed is preferable to advertising a directory durability guarantee the OS rejected.
        await syncDirectoryAt(storage.root);
      },
      async retire(name) {
        for (const target of [`pin-${name}`, `io-${name}`]) {
          try { await unlink(lockPath(target)); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
        }
      },
    },
  };
  backend.connect = name => {
    validateName(name);
    const readers = new Map<string, { file: Promise<FileHandle>; handle?: FileHandle; users: number; failed: boolean }>();
    // One idle, unlocked descriptor per lock name. Reopening a lock file cost about 60 µs per lock on
    // macOS, three times per transaction. Simultaneous owners still get distinct open file
    // descriptions, otherwise flock would merge them.
    const idle = new Map<string, FileHandle>();
    let closed = false;
    const commitName = `commit-${name}`;
    const local = createMemoryCoordinator();
    const check = () => { if (closed) throw new StorageError('CLOSED', 'Native database connection is closed.'); };
    const releaseReader = async (filename: string) => {
      const entry = readers.get(filename);
      if (entry && !entry.users) { readers.delete(filename); await (await entry.file).close(); }
    };
    const acquireNative = async (target: string, shared: boolean, signal: CancellationSignal | undefined, tryOnly: boolean): Promise<Release | undefined> => {
      abort(signal);
      let file = idle.get(target); idle.delete(target);
      if (!file) {
        file = await open(lockPath(target), constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { if (!(await file.stat()).isFile()) throw new TypeError('Lock path is not a regular file.'); }
        catch (error) { await file.close(); throw error; }
      }
      const handle = file;
      try {
        for (;;) {
          abort(signal);
          const acquired = native.tryLockSync(handle.fd, shared ? native.Lock.Shared : native.Lock.Exclusive);
          if (acquired) {
            let released = false;
            return async () => {
              if (released) return; released = true;
              try { native.lockSync(handle.fd, native.Lock.Unlock); } catch (error) { await handle.close(); throw error; }
              if (closed || idle.has(target)) { await handle.close(); return; }
              idle.set(target, handle);
              // Pins of collected generations are never taken again; keep the idle set small.
              for (const [old, oldHandle] of idle) { if (idle.size <= 8) break; idle.delete(old); await oldHandle.close(); }
            };
          }
          if (tryOnly) { await handle.close(); return undefined; }
          await delay(5);
        }
      } catch (error) { await handle.close(); throw error; }
    };
    const scoped: Backend = {
      storage, durability: backend.durability, writeChunkBytes: backend.writeChunkBytes,
      coordinator: {
        ...backend.coordinator,
        async acquire(target, shared = false, signal, tryOnly = false) {
          check();
          // Only the commit lock queues locally first: it is the one that same-process writers contend for.
          if (target !== commitName) return acquireNative(target, shared, signal, tryOnly);
          const releaseLocal = await local.acquire(target, shared, signal, tryOnly);
          if (!releaseLocal) return undefined;
          try {
            const release = await acquireNative(target, shared, signal, tryOnly);
            if (!release) { await releaseLocal(); return undefined; }
            return async () => { try { await release(); } finally { await releaseLocal(); } };
          } catch (error) { await releaseLocal(); throw error; }
        },
        async retire(filename) {
          await releaseReader(filename);
          // A descriptor of an unlinked lock file would lock an inode no other process can open.
          for (const target of [`pin-${filename}`, `io-${filename}`]) { const handle = idle.get(target); idle.delete(target); await handle?.close(); }
          await backend.coordinator.retire(filename);
        },
      },
      async read(filename, offset, length) {
        check();
        // This capability is confined to this database's stable head and UUID generations.
        if (filename !== `${name}.head` && !(filename.startsWith(`${name}.g-`) && /^[0-9a-f]{32}\.dsq$/.test(filename.slice(name.length + 3)))) throw new TypeError('Invalid read filename.');
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(offset + length)) throw new RangeError('Invalid read range.');
        let entry = readers.get(filename);
        if (!entry) {
          const file = (async () => {
            try {
              const handle = await open(join(storage.root, filename), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
              try { if (!(await handle.stat()).isFile()) throw new StorageError('UNSUPPORTED', 'Read path is not a regular file.'); return handle; }
              catch (error) { await handle.close(); throw error; }
            } catch (cause) {
              throw readFailure(cause);
            }
          })();
          entry = { file, users: 0, failed: false }; readers.set(filename, entry);
        } else { readers.delete(filename); readers.set(filename, entry); }
        entry.users++;
        try {
          const handle = entry.handle ?? (entry.handle = await entry.file);
          const bytes = new Uint8Array(length);
          // A manifest size check runs beside the first read. It detects oversized
          // files without a second sequential EOF read on the common 8192-byte head.
          // The 8 KiB manifest is read on every operation and stays in the page cache, where a blocking read
          // took 0.4 to 0.6 µs against 9 to 18 µs for a thread-pool round trip; values keep the configured mode.
          const blocking = synchronous || filename === `${name}.head`;
          const fileSize = filename === `${name}.head` ? blocking ? fstatSync(handle.fd).size :
            new Promise<number>((resolve, reject) => fstat(handle.fd, (error, stat) => error ? reject(error) : resolve(stat.size))) : undefined;
          let used = 0;
          let end = length;
          while (used < length) {
            const size = Math.min(readChunk, length - used);
            // Callback fs avoids FileHandle's per-read Promise/ref bookkeeping;
            // the connection's users counter owns descriptor lifetime instead.
            const pending = blocking ? readSync(handle.fd, bytes, used, size, offset + used) :
              new Promise<number>((resolve, reject) => read(handle.fd, bytes, used, size, offset + used, (error, count) => error ? reject(error) : resolve(count)));
            let count: number;
            if (fileSize instanceof Promise) {
              const pair = await Promise.all([pending, fileSize]); count = pair[0];
              end = Math.min(length, Math.max(0, pair[1] - offset));
            } else {
              count = typeof pending === 'number' ? pending : await pending;
              if (fileSize !== undefined) end = Math.min(length, Math.max(0, fileSize - offset));
            }
            if (!count) break;
            used += count;
            if (used >= end) break;
          }
          return used === length ? bytes : bytes.subarray(0, used);
        } catch (error) {
          // Failed opens are not sticky: permissions or missing files can be repaired.
          if (readers.get(filename) === entry) readers.delete(filename);
          entry.failed = true;
          throw readFailure(error);
        } finally {
          entry.users--;
          if (entry.failed && !entry.users) try { await (await entry.file).close(); } catch { /* Preserve the read/open error. */ }
          // At most two idle descriptors: normally the manifest and current generation.
          // In-flight positional reads own their handles until completion, never eviction.
          let idle = 0;
          for (const value of readers.values()) if (!value.users) idle++;
          for (const [old, value] of readers) if (idle > 2 && !value.users) { await releaseReader(old); idle--; }
        }
      },
    };
    return { backend: scoped, close: async () => {
      if (closed) return; closed = true;
      const handles = [...readers.values()].map(entry => entry.file); readers.clear();
      for (const handle of idle.values()) handles.push(Promise.resolve(handle));
      idle.clear();
      await Promise.all(handles.map(async handle => (await handle).close()));
    } };
  };
  return backend;
}
