/** Published-package test: worker threads scan split() ranges of one pinned native snapshot while a writer commits. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDbsonl } from 'defuss-dbsonl';
import { createFileBackend } from 'defuss-dbsonl/server';

type Result = { count: number; sum: number; first?: string; last?: string };
const root = await mkdtemp(resolve('parallel-'));
try {
  const db = await openDbsonl<{ n: number; text: string }>(await createFileBackend(root), 'parallel', { create: true });
  for (let start = 0; start < 20000; start += 2000) await db.batch(Array.from({ length: 2000 }, (_, i) => ({ operation: 'put' as const, key: `doc:${String(start + i).padStart(6, '0')}`, value: { n: start + i, text: 'x'.repeat((start + i) % 100) } })));
  await db.batch(Array.from({ length: 1000 }, (_, i) => ({ operation: 'delete' as const, key: `doc:${String(i * 13).padStart(6, '0')}` })));
  const session = await db.beginRead();
  let sum = 0; for await (const batch of session.scanBatches()) for (const row of batch) sum += row.value.n;
  const ranges = await session.split(4);
  assert.equal(ranges.length, 4);
  const scans = ranges.map(range => new Promise<Result>((done, fail) => {
    const worker = new Worker(resolve('parallel-worker.js'), { workerData: { root, head: session.head, range } });
    worker.once('message', done); worker.once('error', fail);
    worker.once('exit', code => { if (code) fail(new Error(`worker exited ${code}`)); });
  }));
  // The writer changes and compacts the database while the workers read the pinned snapshot.
  const writes = (async () => { for (let i = 0; i < 50; i++) await db.put(`doc:${String(i).padStart(6, '0')}`, { n: -1, text: '' }); await db.compact(); })();
  const results = await Promise.all(scans); await writes;
  assert.deepEqual(results.map(result => result.count), ranges.map(range => range.count));
  assert.equal(results.reduce((total, result) => total + result.count, 0), session.count);
  assert.equal(results.reduce((total, result) => total + result.sum, 0), sum);
  for (let i = 1; i < results.length; i++) assert.ok(results[i - 1]!.last! < results[i]!.first!, 'ranges overlap or are out of order');
  // The default backend scans a pinned snapshot this large in its own worker pool, with the rows of one thread.
  const auto = await createFileBackend(root), view = await openDbsonl<{ n: number }>(auto, 'parallel');
  const pinned = await view.beginRead({ at: session.head }); let autoRows = 0, autoSum = 0, previous = '';
  for await (const batch of pinned.scanBatches()) for (const row of batch) { assert.ok(row.key > previous, 'auto scan out of order'); previous = row.key; autoRows++; autoSum += row.value.n; }
  await pinned.close();
  assert.equal(autoRows, session.count); assert.equal(autoSum, sum);
  assert.equal(auto.parallel?.scans, 1, 'the default backend did not scan in workers');
  await session.close(); await db.collect(); await db.close(); await view.close();
  console.log(JSON.stringify({ workers: results.length, rows: session.count, writerCommitsDuringScan: 50, autoScanWorkers: auto.parallel?.workers }));
} finally { await rm(root, { recursive: true, force: true }); }
