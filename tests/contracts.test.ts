/** VERIFIED: Public contracts from docs/API.md that the other suites leave unexercised. */
import { expect, test, beforeAll } from 'vitest';
import { mkdtemp, mkdir, rm, chmod, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMemoryBackend, openDbsonl } from '../src/index.js';
import type { Mutation } from '../src/index.js';
import { createFileBackend } from '../src/server.js';
import { encodeFrame } from 'defuss-dson/sequence';
import { readHead, headFile, SLOT_BYTES } from '../src/core/io.js';
beforeAll(async () => { await mkdir('tmp', { recursive: true }); });

async function rows<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const row of source) result.push(row); return result; }
/** The API promises TypeError or RangeError for invalid arguments, thrown or rejected. */
async function failure(call: () => unknown): Promise<unknown> { try { await call(); } catch (error) { return error; } return undefined; }

test('a transaction scan merges staged writes with its snapshot in key order, within range and limit', async () => {
  const db = await openDbsonl<number>(createMemoryBackend(), 'overlay', { create: true });
  await db.batch(['b', 'd', 'f'].map((key, value) => ({ operation: 'put' as const, key, value })));
  await db.transaction(async tx => {
    tx.put('a', 10); tx.put('c', 30); tx.delete('d'); tx.put('f', 60); tx.put('g', 70); tx.put('h', 80); tx.delete('absent');
    // Staged rows report the snapshot revision plus one; untouched rows keep their own.
    expect((await rows(tx.scan())).map(row => [row.key, row.value, row.revision])).toEqual([
      ['a', 10, 2], ['b', 0, 1], ['c', 30, 2], ['f', 60, 2], ['g', 70, 2], ['h', 80, 2],
    ]);
    // The limit ends the scan on a staged row before the first base row, on a base row, and after the last base row.
    expect((await rows(tx.scan({ limit: 1 }))).map(row => row.key)).toEqual(['a']);
    expect((await rows(tx.scan({ limit: 2 }))).map(row => row.key)).toEqual(['a', 'b']);
    expect((await rows(tx.scan({ limit: 5 }))).map(row => row.key)).toEqual(['a', 'b', 'c', 'f', 'g']);
    expect((await rows(tx.scan({ gte: 'b', lt: 'g' }))).map(row => row.key)).toEqual(['b', 'c', 'f']);
    expect((await rows(tx.scan({ gte: 'g' }))).map(row => row.key)).toEqual(['g', 'h']);
    // The overlay is captured at the first pull; later staging is visible to a new scan.
    const paused = tx.scan();
    expect((await paused.next()).value?.key).toBe('a');
    tx.put('e', 50);
    expect((await rows(paused)).map(row => row.key)).toEqual(['b', 'c', 'f', 'g', 'h']);
    expect((await rows(tx.scan({ gte: 'd', lt: 'f' }))).map(row => [row.key, row.value])).toEqual([['e', 50]]);
  });
  const snapshot = await db.beginRead();
  expect((await rows(snapshot.scan())).map(row => [row.key, row.value])).toEqual([['a', 10], ['b', 0], ['c', 30], ['e', 50], ['f', 60], ['g', 70], ['h', 80]]);
  await snapshot.close(); await db.close();
});

test('past maxTransactionOperations distinct reads, a transaction falls back to the whole-database check', async () => {
  const backend = createMemoryBackend();
  const db = await openDbsonl<number>(backend, 'readset', { create: true, maxTransactionOperations: 2 });
  const peer = await openDbsonl<number>(backend, 'readset');
  await db.batch([{ operation: 'put', key: 'a', value: 1 }, { operation: 'put', key: 'b', value: 2 }]);
  await db.put('c', 3);
  // Two tracked keys, the second read twice: a commit on another key does not conflict.
  await db.transaction(async tx => { await tx.get('a'); await tx.get('b'); await tx.get('a'); await peer.put('z', 0); tx.put('a', 10); });
  // A third distinct key exceeds the tracking budget, so any commit after the snapshot conflicts.
  await expect(db.transaction(async tx => {
    await tx.get('a'); await tx.get('b'); await tx.get('c'); await peer.put('z', 1); tx.put('a', 20);
  })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await db.get('a')).value).toBe(10);
  await db.close(); await peer.close();
});

test('invalid keys, scan bounds, operations, revisions, modes and budgets are TypeError or RangeError', async () => {
  const backend = createMemoryBackend();
  for (const options of [{ maxPendingOperations: 0 }, { maxRecordBytes: 0 }, { maxTransactionOperations: 1.5 }, { maxCacheBytes: -1 }]) {
    expect(await failure(() => openDbsonl(backend, 'args', { create: true, ...options }))).toBeInstanceOf(RangeError);
  }
  // Zero cache budgets are valid and disable index caching.
  const db = await openDbsonl<number>(backend, 'args', { create: true, maxCacheBytes: 0, maxCachePages: 0 });
  const longest = 'k'.repeat(4096);
  await db.put(longest, 1);
  const snapshot = await db.beginRead();
  const typeErrors = [
    () => db.get('k'.repeat(4097)), () => db.get(1 as unknown as string), () => db.put('k'.repeat(4097), 1), () => snapshot.get('k'.repeat(4097)),
    () => snapshot.scan({ gte: 1 as unknown as string }), () => db.batch([{ operation: 'upsert', key: 'a', value: 1 } as unknown as Mutation<number>]),
    () => db.compact({ mode: 'fast' as unknown as 'exclusive' }),
  ];
  for (const call of typeErrors) expect(await failure(call)).toBeInstanceOf(TypeError);
  for (const call of [() => snapshot.scan({ limit: -1 }), () => db.batch([], { ifRevision: -1 }), () => db.put('a', 1, { ifRevision: 0.5 })]) {
    expect(await failure(call)).toBeInstanceOf(RangeError);
  }
  expect((await db.get(longest)).value).toBe(1);
  expect(await db.stats()).toMatchObject({ revision: 1, count: 1, cachePages: 0, cacheBytes: 0 });
  expect(await db.verify()).toEqual({ revision: 1, count: 1 });
  await snapshot.close(); await db.close();
});

test('an early break ends a scan, and close() drains admitted work and closes the snapshots its handle holds', async () => {
  const backend = createMemoryBackend();
  const db = await openDbsonl<number>(backend, 'closing', { create: true });
  await db.batch(['a', 'b', 'c'].map((key, value) => ({ operation: 'put' as const, key, value })));
  const snapshot = await db.beginRead();
  const scan = snapshot.scan();
  for await (const row of scan) { expect(row.key).toBe('a'); break; }
  expect(await scan.next()).toEqual({ done: true, value: undefined });
  expect((await snapshot.get('c')).value).toBe(2);
  const write = db.put('d', 3);
  await db.close();
  await expect(write).resolves.toMatchObject({ revision: 2, count: 4 });
  await expect(snapshot.get('a')).rejects.toMatchObject({ code: 'CLOSED' });
  // Closing a snapshot the handle already closed, as a finally block after db.close() does, is harmless.
  await snapshot.close();
  const reopened = await openDbsonl<number>(backend, 'closing');
  expect((await reopened.get('d')).value).toBe(3);
  await reopened.close();
});

for (const kind of ['memory', 'native'] as const) {
  test(`${kind} coordinator: shared pins coexist, exclusive and try-only locks exclude, a cancelled wait rejects and keeps nothing`, async () => {
    const root = await mkdtemp(resolve('tmp/coordinator-'));
    try {
      const { coordinator } = kind === 'memory' ? createMemoryBackend() : await createFileBackend(root);
      const a = (await coordinator.acquire('pin-x', true))!, b = (await coordinator.acquire('pin-x', true))!;
      expect(await coordinator.acquire('pin-x', false, undefined, true)).toBeUndefined();
      const controller = new AbortController();
      // The native poller rejects as soon as it sees the abort; the memory queue rejects when the lock frees up.
      const cancelled = coordinator.acquire('pin-x', false, controller.signal).catch((error: unknown) => error);
      let granted = false;
      const waiting = coordinator.acquire('pin-x').then(release => { granted = true; return release!; });
      controller.abort();
      await a(); await a();
      await new Promise(done => setTimeout(done, 20));
      expect(granted).toBe(false);
      await b();
      expect(await cancelled).toMatchObject({ code: 'ABORTED' });
      const writer = await waiting;
      expect(await coordinator.acquire('pin-x', true, undefined, true)).toBeUndefined();
      await writer();
      const next = await coordinator.acquire('pin-x', false, undefined, true);
      expect(next).toBeTypeOf('function'); await next!();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('a checksummed newer head of another format version fails UNSUPPORTED, an inconsistent one CORRUPT, with no fallback', async () => {
  const backend = createMemoryBackend();
  const db = await openDbsonl<number>(backend, 'manifest', { create: true });
  await db.put('a', 1); const head = await readHead(backend, 'manifest'); await db.close();
  // Written exactly where the next publication would go, with a valid frame checksum.
  const replace = async (next: object) => {
    const slot = new Uint8Array(SLOT_BYTES); slot.set(encodeFrame({ ...head, publication: head.publication + 1, ...next }));
    const file = await backend.storage.open(headFile('manifest'));
    try { await file.write(((head.publication + 1) % 2) * SLOT_BYTES, slot); } finally { await file.close(); }
  };
  await replace({ dbsonl: 6 });
  await expect(openDbsonl(backend, 'manifest')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  // Format 5: a count that disagrees with the logged commits fails when they are replayed, at the first read; open
  // stays O(1). A log reference past the committed end fails at open.
  await replace({ count: 0 });
  const inconsistent = await openDbsonl<number>(backend, 'manifest');
  await expect(inconsistent.get('a')).rejects.toMatchObject({ code: 'CORRUPT' });
  await inconsistent.close();
  await replace({ last: { offset: head.end, byteLength: 1 } });
  await expect(openDbsonl(backend, 'manifest')).rejects.toMatchObject({ code: 'CORRUPT' });
  await replace({ revision: -1 });
  await expect(openDbsonl(backend, 'manifest')).rejects.toMatchObject({ code: 'CORRUPT' });
});

test.skipIf(process.getuid?.() === 0)('a denied generation read reports PERMISSION_DENIED and succeeds once access is restored', async () => {
  const root = await mkdtemp(resolve('tmp/denied-'));
  try {
    const writer = await openDbsonl<number>(await createFileBackend(root), 'denied', { create: true });
    await writer.put('a', 1); await writer.close();
    const generations = (await readdir(root)).filter(file => file.startsWith('denied.g-') && file.endsWith('.dsq'));
    expect(generations).toHaveLength(1);
    const path = resolve(root, generations[0]!);
    const db = await openDbsonl<number>(await createFileBackend(root), 'denied');
    await chmod(path, 0o000);
    try { await expect(db.get('a')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); }
    finally { await chmod(path, 0o600); }
    expect((await db.get('a')).value).toBe(1);
    await db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
