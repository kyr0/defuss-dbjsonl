import { expect, test } from 'vitest';
import { createMemoryBackend, openDbsonl } from '../src/index.js';

test('atomic batches publish one revision while old readers keep their roots', async () => {
  const backend = createMemoryBackend();
  const a = await openDbsonl<number>(backend, 'test', { create: true });
  const b = await openDbsonl<number>(backend, 'test');
  await a.put('a', 1);
  const snapshot = await a.beginRead();
  await b.batch([{ operation: 'put', key: 'a', value: 2 }, { operation: 'put', key: 'b', value: 3 }]);
  expect((await snapshot.get('a')).value).toBe(1);
  expect((await snapshot.get('b')).found).toBe(false);
  expect((await a.get('a')).value).toBe(2);
  await a.compact();
  expect((await snapshot.get('a')).value).toBe(1);
  await snapshot.close();
  expect((await a.collect()).removed.length).toBeGreaterThan(0);
  await a.close(); await b.close();
});

async function rows<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const row of source) result.push(row); return result; }

test('tree growth, splits, deletions and bulk packing match an independent ordered map', async () => {
  const backend = createMemoryBackend();
  const db = await openDbsonl<number>(backend, 'tree', { create: true, maxCacheBytes: 1024, maxCachePages: 2 });
  const expected = new Map<string, number>();
  let seed = 123456;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let round = 0; round < 5; round++) {
    const batch: ({ operation: 'put'; key: string; value: number } | { operation: 'delete'; key: string })[] = [];
    for (let n = 0; n < 500; n++) {
      const key = `k${String(random() % 2500).padStart(4, '0')}`;
      if (random() % 5) { expected.set(key, n); batch.push({ operation: 'put', key, value: n }); }
      else { expected.delete(key); batch.push({ operation: 'delete', key }); }
    }
    await db.batch(batch);
  }
  const snapshot = await db.beginRead();
  expect((await rows(snapshot.scan())).map(r => [r.key, r.value])).toEqual([...expected].sort(([a], [b]) => a < b ? -1 : 1));
  expect((await rows(snapshot.scan({ gte: 'k0500', lt: 'k0700', limit: 7 }))).length).toBe(7);
  expect(await rows(snapshot.scan({ limit: 0 }))).toEqual([]);
  const stats = await db.stats(); expect(stats.cacheBytes).toBeLessThanOrEqual(1024); expect(stats.cachePages).toBeLessThanOrEqual(2);
  const compact = await db.compact({ mode: 'exclusive' }); expect(compact.afterBytes).toBeLessThan(compact.beforeBytes);
  expect(await db.verify()).toMatchObject({ count: expected.size });
  expect((await db.collect()).retained).toHaveLength(1);
  await snapshot.close(); await db.collect(); await db.close();
  const reopened = await openDbsonl<number>(backend, 'tree');
  expect((await reopened.stats()).cachePages).toBe(0);
  await reopened.batch([...expected.keys()].map(key => ({ operation: 'delete', key })));
  expect(await reopened.verify()).toMatchObject({ count: 0 });
  await reopened.compact(); await reopened.collect(); await reopened.close();
});

test('queued writers, read-your-writes, phantom conflicts and callback rollback', async () => {
  const backend = createMemoryBackend(); const db = await openDbsonl<number>(backend, 'tx', { create: true });
  const peer = await openDbsonl<number>(backend, 'tx');
  await Promise.all(Array.from({ length: 30 }, (_, n) => (n % 2 ? db : peer).put(`${n}`, n)));
  expect((await db.stats()).revision).toBe(30);
  const success = await db.transaction(async tx => {
    tx.put('0', 200); tx.delete('1'); tx.put('z', 300);
    expect(await tx.get('0')).toMatchObject({ value: 200 }); expect(await tx.get('1')).toEqual({ found: false });
    const items = await rows(tx.scan({ gte: '0', lt: 'z' }));
    expect(items[0]!.value).toBe(200); expect(items.some(row => row.key === '1')).toBe(false);
    return 9;
  }); expect(success.result).toBe(9);
  await expect(db.transaction(async tx => { tx.put('rollback', 1); throw new Error('stop'); })).rejects.toThrow('stop');
  expect(await db.get('rollback')).toEqual({ found: false });
  await expect(db.transaction(async tx => {
    expect(await rows(tx.scan({ gte: 'phantom' }))).toHaveLength(1);
    await peer.put('phantom', 1); tx.put('lost', 3);
  })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await db.get('lost')).toEqual({ found: false });
  await expect(db.batch([], { ifRevision: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });
  await db.close(); await peer.close();
});

test('DSON cycles and binary survive batches and compaction; inputs are captured at admission', async () => {
  const db = await openDbsonl(createMemoryBackend(), 'dson', { create: true });
  const value: { bytes: Uint8Array; self?: unknown; date: Date } = { bytes: new Uint8Array([1, 2, 3]), date: new Date(1234) }; value.self = value;
  const write = db.put('rich', value); value.bytes[0] = 99; await write;
  await db.batch([{ operation: 'put', key: '', value: undefined }, { operation: 'put', key: '__proto__', value: 3n }]);
  await db.compact();
  const result = (await db.get('rich')).value as typeof value;
  expect(result.self).toBe(result); expect(result.bytes).toEqual(new Uint8Array([1, 2, 3])); expect(result.date.getTime()).toBe(1234);
  expect(await db.get('')).toMatchObject({ found: true, value: undefined });
  expect((await db.get('__proto__')).value).toBe(3n);
  await db.close();
});

test('limits, abort and lifecycle errors leave the database usable', async () => {
  const backend = createMemoryBackend();
  await expect(openDbsonl(backend, '../escape')).rejects.toThrow();
  const db = await openDbsonl(backend, 'bounds', { create: true, maxTransactionOperations: 2, maxTransactionBytes: 1000, maxPendingOperations: 1 });
  await expect(db.batch(Array.from({ length: 3 }, () => ({ operation: 'delete' as const, key: 'a' })))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  await expect(db.put('big', 'x'.repeat(2000))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  const controller = new AbortController(); controller.abort();
  await expect(db.put('no', 1, { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  const first = db.put('yes', 1); await expect(db.put('queued', 2)).rejects.toMatchObject({ code: 'QUEUE_FULL' }); await first;
  const snapshot = await db.beginRead(); const iterator = snapshot.scan(); await iterator.next();
  await snapshot.close(); await expect(iterator.next()).rejects.toMatchObject({ code: 'CLOSED' });
  await db.close(); await db.close(); await expect(db.get('yes')).rejects.toMatchObject({ code: 'CLOSED' });
  await expect(db.put('yes', 2)).rejects.toMatchObject({ code: 'CLOSED' });
});

test('small adapter chunks, pending-byte admission and transaction limits are enforced', async () => {
  const backend = createMemoryBackend({ maxWriteBytes: 128, maxPendingWriteBytes: 128, maxReadBytes: 64 });
  const db = await openDbsonl<string>(backend, 'small', { create: true, maxPendingBytes: 3000, maxTransactionBytes: 5000, maxTransactionOperations: 2 });
  const first = db.put('a', 'x'.repeat(1000));
  await expect(db.put('b', 'x'.repeat(1000))).rejects.toMatchObject({ code: 'QUEUE_FULL' }); await first;
  await expect(db.transaction(tx => { tx.put('b', 'x'.repeat(1000)); tx.put('c', 'x'.repeat(1000)); })).rejects.toMatchObject({ code: 'QUEUE_FULL' });
  await expect(db.transaction(tx => { tx.put('a', '1'); tx.put('b', '2'); tx.put('c', '3'); })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  const done = await db.transaction(async tx => {
    tx.put('a', 'a'); tx.put('a', 'updated'); tx.delete('b');
    expect((await rows(tx.scan())).map(row => row.key)).toEqual(['a']);
    return tx;
  });
  expect(() => done.result.put('a', 'late')).toThrow('finished');
  expect((await db.get('a')).value).toBe('updated'); await db.close();
});

test('real quota failure cannot expose part of a batch and a later commit reuses the tail', async () => {
  const backend = createMemoryBackend({ maxFileBytes: 32768 });
  const db = await openDbsonl<string>(backend, 'quota', { create: true });
  await db.put('old', 'kept');
  await expect(db.batch([{ operation: 'put', key: 'partial', value: 'first' }, { operation: 'put', key: 'large', value: 'x'.repeat(40000) }])).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  expect(await db.get('partial')).toEqual({ found: false }); expect((await db.get('old')).value).toBe('kept');
  await db.put('next', 'works'); expect(await db.verify()).toMatchObject({ count: 2, revision: 2 }); await db.close();
});

test('one atomic batch avoids persisting unobservable intermediate index paths', async () => {
  const db = await openDbsonl<number>(createMemoryBackend(), 'packed_batch', { create: true });
  await db.batch(Array.from({ length: 1000 }, (_, i) => ({ operation: 'put', key: String(i).padStart(4, '0'), value: i })));
  // Resource acceptance bound, not a timing assertion: live index and scalar payloads fit comfortably below 1 MiB.
  expect((await db.stats()).committedBytes).toBeLessThan(1024 * 1024);
  expect(await db.verify()).toEqual({ revision: 1, count: 1000 }); await db.close();
});

test('long keys remain addressable and a dirty-page budget cannot publish a partial update', async () => {
  const backend = createMemoryBackend(); const db = await openDbsonl<number>(backend, 'longkeys', { create: true });
  const prefix = 'Ω'.repeat(4000);
  await db.batch(Array.from({ length: 80 }, (_, i) => ({ operation: 'put', key: `${prefix}${String(i).padStart(3, '0')}`, value: i })));
  expect((await db.get(`${prefix}079`)).value).toBe(79);
  const bounded = await openDbsonl<number>(backend, 'longkeys', { maxTransactionBytes: 10000 });
  await expect(bounded.put('short', 5)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  expect((await db.get('short')).found).toBe(false);
  expect(await db.verify()).toEqual({ revision: 1, count: 80 });
  await bounded.close(); await db.close();
});
