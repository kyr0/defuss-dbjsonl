/** scanBatches in real worker threads: the same rows in the same order, the same errors, and pins that end on close. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, test } from 'vitest';
import { openDbsonl } from '../src/index.js';
import type { Dbsonl, Row } from '../src/index.js';
import { createFileBackend } from '../src/server.js';
import { createScanPool } from '../src/scan-pool.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
type Doc = { n: number; at: Date; tags: Set<string>; bytes: Uint8Array; big: bigint; self?: Doc };
const doc = (n: number): Doc => { const value: Doc = { n, at: new Date(1_700_000_000_000 + n), tags: new Set(['a', String(n % 7)]), bytes: new Uint8Array([n % 256, 1]), big: BigInt(n) * 3n }; if (n % 50 === 0) value.self = value; return value; };
const key = (n: number) => `k${String(n).padStart(6, '0')}`;
/** One directory, one handle that scans in workers and one that never does, as the reference. */
async function open(rows = 6000): Promise<{ parallel: Dbsonl<Doc>; single: Dbsonl<Doc>; backend: Awaited<ReturnType<typeof createFileBackend>> }> {
  const root = await mkdtemp(join(tmpdir(), 'dbsonl-workers-')); roots.push(root);
  const backend = await createFileBackend(root, { scanWorkers: 2, scanThreshold: 1000 });
  const parallel = await openDbsonl<Doc>(backend, 'scan', { create: true });
  for (let start = 0; start < rows; start += 1000) await parallel.batch(Array.from({ length: 1000 }, (_, i) => ({ operation: 'put' as const, key: key(start + i), value: doc(start + i) })));
  await parallel.batch(Array.from({ length: 300 }, (_, i) => ({ operation: 'delete' as const, key: key(i * 11) })));
  const single = await openDbsonl<Doc>(await createFileBackend(root, { scanWorkers: 0 }), 'scan');
  return { parallel, single, backend };
}
async function batches(db: Dbsonl<Doc>, options: object = {}): Promise<Row<Doc>[][]> {
  const session = await db.beginRead(), out: Row<Doc>[][] = [];
  try { for await (const batch of session.scanBatches(options)) out.push(batch as Row<Doc>[]); } finally { await session.close(); }
  return out;
}

test('large scans run in workers and return the rows, values and order of one thread', async () => {
  const { parallel, single, backend } = await open();
  for (const options of [{}, { batchSize: 7 }, { gte: key(1234), lt: key(4321) }, { gte: key(5000) }, { lt: key(2500), limit: 1500 }, { gte: key(1234), limit: 2000 }, { maxBatchBytes: 2000 }]) {
    const before = backend.parallel!.scans;
    const got = await batches(parallel, options), expected = await batches(single, options);
    expect(backend.parallel!.scans).toBe(before + 1);
    expect(got.flat()).toEqual(expected.flat());
    const size = (options as { batchSize?: number }).batchSize ?? 256;
    for (const batch of got) { expect(batch.length).toBeGreaterThan(0); expect(batch.length).toBeLessThanOrEqual(size); }
  }
  // DSON values arrive as values of their own types, cycles included.
  const first = (await batches(parallel, { gte: key(50), limit: 1 }))[0]?.[0];
  expect(first?.value.self).toBe(first?.value); expect(first?.value.tags).toBeInstanceOf(Set); expect(first?.value.big).toBe(150n);
  // Below the threshold, and with a sizeOf callback, the calling thread scans.
  const before = backend.parallel!.scans;
  await batches(parallel, { limit: 999 }); await batches(parallel, { sizeOf: () => 1 }); await batches(parallel, { gte: key(10), lt: key(500) });
  expect(backend.parallel!.scans).toBe(before);
  await parallel.close(); await single.close();
});

test('worker errors surface as the same codes; closing a snapshot ends the workers\' pins', async () => {
  const { parallel, single } = await open();
  // A row larger than the batch budget fails in the worker as it does in one thread.
  await expect(batches(parallel, { maxBatchBytes: 20 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  await expect(batches(single, { maxBatchBytes: 20 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  // A paused scan: the snapshot closes, then compaction and collection reclaim its generation.
  const session = await parallel.beginRead(), iterator = session.scanBatches({ batchSize: 10 })[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toHaveLength(10);
  await session.close();
  await expect(iterator.next()).rejects.toMatchObject({ code: 'CLOSED' });
  await parallel.compact();
  expect((await parallel.collect()).removed).toHaveLength(1);
  // An early break closes the worker scan too.
  const again = await parallel.beginRead();
  for await (const _batch of again.scanBatches()) break;
  await again.close(); await parallel.compact();
  expect((await parallel.collect()).removed).toHaveLength(1);
  await parallel.close(); await single.close();
});

test('a pool whose workers cannot start leaves scans to the calling thread', async () => {
  const pool = createScanPool({ workers: 2, threshold: 1, spawn: () => new Worker('throw new Error("no worker")', { eval: true }) });
  expect(await pool.scan({ name: 'x', head: { dbsonl: 2, publication: 1, revision: 0, generation: '0'.repeat(32), root: null, count: 0, end: 0 }, ranges: [{}], batchSize: 1, maxBatchBytes: 1, limits: { maxRecordBytes: 1, maxCacheBytes: 0, maxCachePages: 0 } })).toBeUndefined();
  expect(pool.scans).toBe(0);
  await expect(createFileBackend(roots[0] ?? tmpdir(), { scanWorkers: -1 })).rejects.toThrow(RangeError);
});
