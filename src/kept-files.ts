/**
 * VERIFIED: Native head and generation files stay open between commits, shared by every handle in the JS realm.
 *
 * Opening and closing both files cost about 1 ms of a 5.8 ms lone durable transaction in a traced probe at a load
 * average near 15; keeping them open took a lone transaction from 4.44 to 4.19 ms under Node and from 4.37 to 4.11 ms
 * under Bun (docs/PERFORMANCE.md). The files are opened as Storage shared writers, which re-read the file size on
 * every call, so writes by other processes stay visible. Every lease is taken inside withFile, under the file's I/O
 * lock, so two leases never write at once, and a removal, which holds that lock alone, finds no lease in use and
 * closes the idle file first, for every adapter in the realm. Each adapter keeps its own handles, because handles
 * carry their adapter's limits and I/O mode. Why not per handle: other handles in the realm could then not remove or open the file
 * while it sat idle. Generation names are random and never reused, and collection removes only generations no head
 * refers to, so an open descriptor never stands for a newer file of the same name.
 */
import { StorageError } from 'defuss-storage';
import type { OpenOptions, StorageAdapter, StorageFile } from 'defuss-storage';

type Entry = { file: Promise<StorageFile>; users: number; path: string; database: string };
type Registry = { files: Map<string, Entry>; databases: Map<string, number>; adapters: number };
// One registry per realm, shared by ESM and CJS copies like Storage's own ownership registry.
const KEY = Symbol.for('defuss-dbsonl.kept-files.v1');
const registry = (): Registry => ((globalThis as Record<symbol, Registry | undefined>)[KEY] ??= { files: new Map(), databases: new Map(), adapters: 0 });

/** The database a head or generation file belongs to; other names are not kept. */
function database(filename: string): string | undefined {
  return /^([a-z0-9][a-z0-9_-]{0,63})(?:\.head|\.g-[0-9a-f]{32}\.dsq)$/.exec(filename)?.[1];
}
function release(id: string, entry: Entry): Promise<void> {
  const files = registry().files;
  if (files.get(id) !== entry) return Promise.resolve();
  files.delete(id);
  // A failed close leaves Storage holding the name, which later opens report as BUSY; nothing here can do better.
  return entry.file.then(file => file.close()).catch(() => {});
}
function lease(file: StorageFile, readOnly: boolean, done: () => void): StorageFile {
  let closed = false;
  const live = () => { if (closed) throw new StorageError('CLOSED', `defuss-dbsonl: ${file.name} is closed`); };
  const writable = () => { live(); if (readOnly) throw new StorageError('READ_ONLY', `defuss-dbsonl: ${file.name} is read-only`); };
  return {
    name: file.name, readOnly, maxReadBytes: file.maxReadBytes,
    async size() { live(); return file.size(); },
    async read(offset, length, options) { live(); return file.read(offset, length, options); },
    async readInto(offset, target, options) { live(); return file.readInto(offset, target, options); },
    async readExactly(offset, length, options) { live(); return file.readExactly(offset, length, options); },
    async write(offset, data, options) { writable(); return file.write(offset, data, options); },
    async append(data, options) { writable(); return file.append(data, options); },
    async truncate(size, options) { writable(); return file.truncate(size, options); },
    async flush() { live(); return file.flush(); },
    async close() { if (!closed) { closed = true; done(); } },
    stream(options) { live(); return file.stream(options); },
  };
}

/**
 * Wraps the native adapter so plain opens of head and generation files lease a kept shared writer. Opens with
 * create, exclusive or any other option pass through, as do other names. track() counts a database's connections;
 * files stay open only while one is open, and the last close releases them.
 */
export function keepFiles(storage: StorageAdapter, root: string): { storage: StorageAdapter; track(name: string): () => Promise<void> } {
  const adapter = ++registry().adapters;
  const key = (filename: string) => `${root}\0${filename}`, own = (filename: string) => `${adapter}\0${key(filename)}`;
  const kept: StorageAdapter = {
    capabilities: storage.capabilities,
    list: () => storage.list(),
    async open(filename: string, options: OpenOptions = {}): Promise<StorageFile> {
      const owner = database(filename);
      if (owner === undefined || Object.keys(options).some(option => option !== 'readOnly')) return storage.open(filename, options);
      const { files, databases } = registry(), id = own(filename);
      let entry = files.get(id);
      if (!entry) {
        // A new generation of a database supersedes its older ones: close those nobody uses.
        if (filename.includes('.g-')) for (const [other, old] of files) if (old.database === key(owner) && old.users === 0 && old.path.includes('.g-')) void release(other, old);
        entry = { file: storage.open(filename, { shared: true }), users: 0, path: key(filename), database: key(owner) };
        files.set(id, entry);
      }
      const current = entry;
      current.users++;
      let file: StorageFile;
      try { file = await current.file; }
      catch (error) {
        current.users--; void release(id, current);
        // A file this process may only read, for example one made read-only, still opens for reading.
        if (options.readOnly) return storage.open(filename, options);
        throw error;
      }
      return lease(file, options.readOnly === true, () => {
        if (--current.users === 0 && !databases.get(current.database)) void release(id, current);
      });
    },
    async remove(filename: string): Promise<boolean> {
      // Callers remove under the file's exclusive I/O lock, so no lease is in use; one that is makes Storage say BUSY.
      const path = key(filename), idle = [...registry().files].filter(([, entry]) => entry.path === path && entry.users === 0);
      await Promise.all(idle.map(([id, entry]) => release(id, entry)));
      return storage.remove(filename);
    },
  };
  return {
    storage: kept,
    track(name: string) {
      const { files, databases } = registry(), database = key(name);
      databases.set(database, (databases.get(database) ?? 0) + 1);
      let done = false;
      // Resolves once the database's idle files are closed, so a closed handle leaves no descriptor behind.
      return async () => {
        if (done) return; done = true;
        const left = databases.get(database)! - 1;
        if (left) { databases.set(database, left); return; }
        databases.delete(database);
        await Promise.all([...files].filter(([, entry]) => entry.database === database && entry.users === 0).map(([id, entry]) => release(id, entry)));
      };
    },
  };
}
