/** VERIFIED: Queued commits publish together with their own revisions and checks; transactions conflict on the keys they read. */
import { expect, test, beforeAll } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMemoryBackend, openDbsonl } from '../src/index.js';
import { createFileBackend } from '../src/server.js';
import { readHead } from '../src/core/io.js';
beforeAll(async () => { await mkdir('tmp', { recursive: true }); });

/** Holds the database's commit lock so that commits queue behind it; returns the release. */
const holdCommitLock = async (db: { backend: { coordinator: { acquire(name: string): Promise<(() => Promise<void>) | undefined> } }; name: string }) => (await db.backend.coordinator.acquire(`commit-${db.name}`))!;

test('transactions on disjoint keys both commit; a changed read key, a point-read phantom and write skew conflict', async () => {
  const backend = createMemoryBackend();
  const db = await openDbsonl<number>(backend, 'keys', { create: true });
  const peer = await openDbsonl<number>(backend, 'keys');
  await db.batch([{ operation: 'put', key: 'a', value: 1 }, { operation: 'put', key: 'b', value: 1 }]);

  // Disjoint keys: the peer commits between this transaction's read and its commit.
  const disjoint = await db.transaction(async tx => { const a = (await tx.get('a')).value!; await peer.put('b', 5); tx.put('a', a + 1); });
  expect(disjoint.revision).toBe(3); expect((await db.get('a')).value).toBe(2); expect((await db.get('b')).value).toBe(5);

  await expect(db.transaction(async tx => { const a = (await tx.get('a')).value!; await peer.put('a', 10); tx.put('a', a + 1); })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await db.get('a')).value).toBe(10);

  // A key read as absent that appears before the commit is a phantom.
  await expect(db.transaction(async tx => { expect((await tx.get('new')).found).toBe(false); await peer.put('new', 1); tx.put('count', 1); })).rejects.toMatchObject({ code: 'CONFLICT' });
  // A deletion of a read key conflicts too, and so does a read-only transaction.
  await expect(db.transaction(async tx => { await tx.get('b'); await peer.delete('b'); })).rejects.toMatchObject({ code: 'CONFLICT' });

  // Write skew: both read a and b and each writes one of them; at most one may commit.
  await db.batch([{ operation: 'put', key: 'a', value: 1 }, { operation: 'put', key: 'b', value: 1 }]);
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  const skew = (handle: typeof db, target: string) => handle.transaction(async tx => {
    const sum = (await tx.get('a')).value! + (await tx.get('b')).value!;
    await gate; tx.put(target, sum - 2);
  });
  const outcomes = await Promise.allSettled([skew(db, 'a'), skew(peer, 'b'), Promise.resolve().then(release)]);
  expect(outcomes.slice(0, 2).filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.slice(0, 2).filter(outcome => outcome.status === 'rejected').map(outcome => (outcome as PromiseRejectedResult).reason.code)).toEqual(['CONFLICT']);
  // a, b and new: the phantom transaction's write never landed, and b was deleted and written again.
  expect(await db.verify()).toMatchObject({ count: 3 }); expect((await db.get('count')).found).toBe(false);
  await db.close(); await peer.close();
});

test('queued commits on one handle share one publication and keep their own revisions, checks and receipts', async () => {
  const root = await mkdtemp(resolve('tmp/groups-'));
  try {
    const backend = await createFileBackend(root);
    const db = await openDbsonl<number>(backend, 'grouped', { create: true });
    const before = await readHead(db.backend, 'grouped');
    const release = await holdCommitLock(db);
    const puts = Array.from({ length: 20 }, (_, i) => db.put(`k${i}`, i));
    // A compare-and-swap that expects the revision before the queue, and an empty batch, inside the same group.
    // Rejections are caught at once: they settle before the assertions below run.
    const stale = db.batch([{ operation: 'put', key: 'stale', value: 1 }], { ifRevision: 0 }).catch((error: unknown) => error);
    const empty = db.batch([]);
    const later = db.put('k0', 100);
    await new Promise(done => setTimeout(done, 20)); await release();
    const receipts = await Promise.all(puts);
    expect(receipts.map(receipt => receipt.revision)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(receipts.map(receipt => receipt.count)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await stale).toMatchObject({ code: 'CONFLICT' });
    expect(await empty).toEqual({ revision: 20, count: 20 });
    expect(await later).toEqual({ revision: 21, count: 20 });
    expect((await db.get('k0')).value).toBe(100);
    // 21 commits, far fewer head publications: they shared the flushes.
    expect((await readHead(db.backend, 'grouped')).publication - before.publication).toBeLessThanOrEqual(2);
    expect(await db.verify()).toEqual({ revision: 21, count: 20 });
    await db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a cancelled or failing member leaves the rest of its group committed', async () => {
  const db = await openDbsonl<string>(createMemoryBackend({ maxFileBytes: 32768 }), 'members', { create: true });
  let release = await holdCommitLock(db);
  const controller = new AbortController();
  const first = db.put('first', 'kept'), cancelled = db.put('cancelled', 'no', { signal: controller.signal }).catch((error: unknown) => error), last = db.put('last', 'kept');
  controller.abort(); await release();
  expect(await cancelled).toMatchObject({ code: 'ABORTED' });
  expect((await first).revision).toBe(1); expect((await last).revision).toBe(2);

  release = await holdCommitLock(db);
  const small = db.put('small', 'kept'), large = db.put('large', 'x'.repeat(40000)).catch((error: unknown) => error), after = db.put('after', 'kept');
  await release();
  expect(await large).toMatchObject({ code: 'QUOTA_EXCEEDED' });
  expect((await small).revision).toBe(3); expect((await after).revision).toBe(4);
  expect((await db.get('large')).found).toBe(false);
  expect(await db.verify()).toEqual({ revision: 4, count: 4 });
  await db.close();
});

test('concurrent transactions on one handle commit in full groups instead of alternating', async () => {
  const root = await mkdtemp(resolve('tmp/full-groups-'));
  try {
    const db = await openDbsonl<number>(await createFileBackend(root), 'full', { create: true });
    const keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
    await db.batch(keys.map(key => ({ operation: 'put', key, value: 0 })));
    const before = (await readHead(db.backend, 'full')).publication;
    // Four writers moving a point between two keys of their own. Without waiting for siblings that already
    // hold a snapshot, groups alternated between one and three members: about 50 publications for 100 commits.
    await Promise.all(Array.from({ length: 4 }, async (_, writer) => {
      for (let round = 0; round < 25; round++) {
        const from = keys[writer * 10 + (round % 10)]!, to = keys[writer * 10 + ((round + 1) % 10)]!;
        await db.transaction(async tx => { const a = (await tx.get(from)).value!, b = (await tx.get(to)).value!; tx.put(from, a - 1); tx.put(to, b + 1); });
      }
    }));
    expect((await readHead(db.backend, 'full')).publication - before).toBeLessThanOrEqual(35);
    expect(await db.verify()).toEqual({ revision: 101, count: 40 });
    await db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a transaction that keeps its snapshot open does not hold back other commits', async () => {
  const db = await openDbsonl<number>(createMemoryBackend(), 'slow', { create: true });
  await db.put('seed', 0); await db.put('seed', 1); // the first group publishes before any wait is measured
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  let settled = false;
  const slow = db.transaction(async tx => { await tx.get('seed'); await gate; tx.put('slow', 1); }).finally(() => { settled = true; });
  await new Promise(done => setTimeout(done, 5));
  // Each of these commits finds the slow transaction preparing; the wait for it is bounded.
  for (let i = 0; i < 20; i++) await db.put(`k${i}`, i);
  expect(settled).toBe(false);
  release();
  expect((await slow).revision).toBe(23);
  expect(await db.verify()).toEqual({ revision: 23, count: 22 });
  await db.close();
});
