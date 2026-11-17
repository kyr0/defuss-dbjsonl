/** VERIFIED: Snapshot batch scans, the contract defuss-dataview's adapter depends on (docs/API.md). */
import { expect, test, beforeAll } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMemoryBackend, openDbsonl } from '../src/index.js';
import type { Backend, Row } from '../src/index.js';
import { createFileBackend } from '../src/server.js';
import { encodeFrame, FRAME_HEADER_BYTES } from 'defuss-dson/sequence';
import { generationFile, readHead } from '../src/core/io.js';
beforeAll(async () => { await mkdir('tmp', { recursive: true }); });

async function rows<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const row of source) result.push(row); return result; }
const pad = (n: number) => String(n).padStart(3, '0');

for (const kind of ['memory', 'native'] as const) {
  test(`${kind}: batches equal the row scan and keep ranges, limits, a stable snapshot and owned output`, async () => {
    const root = await mkdtemp(resolve('tmp/batches-'));
    try {
      const backend: Backend = kind === 'memory' ? createMemoryBackend() : await createFileBackend(root);
      const db = await openDbsonl<{ n: number }>(backend, 'batches', { create: true });
      await db.batch(Array.from({ length: 100 }, (_, n) => ({ operation: 'put' as const, key: pad(n), value: { n } })));
      const snapshot = await db.beginRead();
      try {
        // Every range and limit yields the row scan's rows, in batches of at most batchSize.
        for (const options of [{}, { gte: '017' }, { lt: '050' }, { gte: '011', lt: '079', limit: 39 }, { gte: '0995' }, { limit: 1 }]) {
          const batches = await rows(snapshot.scanBatches({ ...options, batchSize: 16 }));
          expect(batches.every(batch => batch.length > 0 && batch.length <= 16)).toBe(true);
          expect(batches.flat()).toEqual(await rows(snapshot.scan(options)));
        }
        // 2 units per row against a budget of 9: four rows per batch, below the batchSize of 7.
        const scan = snapshot.scanBatches({ gte: '011', lt: '079', batchSize: 7, maxBatchBytes: 9, sizeOf: () => 2, limit: 39 });
        const first = (await scan.next()).value!;
        expect(first.map(row => row.value.n)).toEqual([11, 12, 13, 14]);
        await db.put('015', { n: 999 }); await db.compact();
        expect((await db.collect()).retained.length).toBeGreaterThan(0);
        const all: Row<{ n: number }>[] = [...first];
        for await (const batch of scan) { expect(batch.length).toBeLessThanOrEqual(4); expect(batch).not.toBe(first); all.push(...batch); }
        expect(all.map(row => row.value.n)).toEqual(Array.from({ length: 39 }, (_, i) => i + 11));
        first[0]!.value.n = -1;
        expect(await snapshot.get('011')).toMatchObject({ value: { n: 11 } });
        expect((await snapshot.scanBatches({ limit: 0 }).next()).done).toBe(true);
        expect((await snapshot.scanBatches({ gte: '099', lt: '050' }).next()).done).toBe(true);
        expect((await rows(snapshot.scanBatches({ batchSize: 32 }))).map(batch => batch.length)).toEqual([32, 32, 32, 4]);
      } finally { await snapshot.close(); }
      expect((await db.collect()).removed.length).toBeGreaterThan(0);
      await db.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('invalid options throw, an oversized row fails its batch after earlier batches, and cancellation and close end a paused scan', async () => {
  const db = await openDbsonl(createMemoryBackend(), 'limits', { create: true });
  try {
    await db.batch([{ operation: 'put', key: 'a', value: 1 }, { operation: 'put', key: 'b', value: new Uint8Array(100) }, { operation: 'put', key: 'c', value: 3 }]);
    const session = await db.beginRead();
    for (const batchSize of [0, -1, 0.5]) expect(() => session.scanBatches({ batchSize })).toThrow(RangeError);
    expect(() => session.scanBatches({ maxBatchBytes: 0 })).toThrow(RangeError);
    expect(() => session.scanBatches({ sizeOf: 1 as never })).toThrow(TypeError);
    // Row a fits the budget and is emitted; row b alone exceeds it.
    const oversized = session.scanBatches({ batchSize: 1, maxBatchBytes: 64 });
    expect((await oversized.next()).value!.map(row => row.key)).toEqual(['a']);
    await expect(oversized.next()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    // sizeOf must return a safe non-negative integer.
    for (const size of [NaN, -1, 1.5]) await expect(session.scanBatches({ sizeOf: () => size }).next()).rejects.toThrow(RangeError);
    const controller = new AbortController();
    const scan = session.scanBatches({ batchSize: 1, signal: controller.signal });
    await scan.next(); controller.abort();
    await expect(scan.next()).rejects.toMatchObject({ code: 'ABORTED' });
    const paused = session.scanBatches({ batchSize: 1 }); await paused.next();
    await session.close(); await session.close();
    await expect(paused.next()).rejects.toMatchObject({ code: 'CLOSED' }); await paused.return?.();
  } finally { await db.close(); }
});

test('a close from inside sizeOf drains the admitted batch before releasing its pin', async () => {
  const db = await openDbsonl(createMemoryBackend(), 'reentrant', { create: true });
  try {
    await db.batch(Array.from({ length: 100 }, (_, n) => ({ operation: 'put' as const, key: pad(n), value: n })));
    const snapshot = await db.beginRead(); let closing: Promise<void> | undefined, released = false, visits = 0;
    const scan = snapshot.scanBatches({ batchSize: 10, sizeOf: () => {
      if (++visits === 11) closing = snapshot.close().then(() => { released = true; });
      expect(released).toBe(false); return 1;
    } });
    await scan.next(); expect((await scan.next()).value!.length).toBe(10);
    await closing; expect(released).toBe(true);
    await expect(scan.next()).rejects.toMatchObject({ code: 'CLOSED' }); await scan.return?.();
  } finally { await db.close(); }
});

test('a failing frame inside a run of window frames fails its own batch, with the error of a frame-by-frame read', async () => {
  const backend = createMemoryBackend(), writer = await openDbsonl(backend, 'runs', { create: true });
  await writer.batch([...['a', 'b', 'c'].map(key => ({ operation: 'put' as const, key, value: `value ${key}` })),
    { operation: 'put', key: 'd', value: new Uint8Array(1000) }, { operation: 'put', key: 'e', value: 'value e' }, { operation: 'put', key: 'f', value: 'value f' }]);
  const head = await readHead(backend, 'runs'); await writer.close();
  // Row a's read fills the window; b and c then decode in one call, d and e or d to f in the next run.
  const scanned = async (options: object, code: string) => {
    const db = await openDbsonl(backend, 'runs', options), session = await db.beginRead();
    try {
      const batches = session.scanBatches({ batchSize: 3 });
      expect((await batches.next()).value!.map(row => row.value)).toEqual(['value a', 'value b', 'value c']);
      await expect(batches.next()).rejects.toMatchObject({ code });
    } finally { await session.close(); await db.close(); }
  };
  // d exceeds the reader's decoder budget.
  await scanned({ maxRecordBytes: 64 }, 'LIMIT_EXCEEDED');
  // One flipped payload byte in e's frame fails its checksum.
  const file = await backend.storage.open(generationFile('runs', head.generation));
  try {
    const bytes = await file.readExactly(0, await file.size()), frame = encodeFrame('value e');
    const at = Buffer.from(bytes).indexOf(Buffer.from(frame)) + FRAME_HEADER_BYTES; expect(at).toBeGreaterThan(FRAME_HEADER_BYTES);
    await file.write(at, new Uint8Array([bytes[at]! ^ 255]));
  } finally { await file.close(); }
  await scanned({}, 'CORRUPT');
  const db = await openDbsonl(backend, 'runs');
  try {
    const session = await db.beginRead(), rows: string[] = [];
    try { await expect((async () => { for await (const row of session.scan()) rows.push(row.key); })()).rejects.toMatchObject({ code: 'CORRUPT' }); } finally { await session.close(); }
    expect(rows).toEqual(['a', 'b', 'c', 'd']);
  } finally { await db.close(); }
});

test('frames served from the read window still enforce the reader decoder budget', async () => {
  const backend = createMemoryBackend(), writer = await openDbsonl(backend, 'budget', { create: true });
  await writer.batch([{ operation: 'put', key: 'a', value: 1 }, { operation: 'put', key: 'b', value: new Uint8Array(1000) }]);
  await writer.close();
  const reader = await openDbsonl(backend, 'budget', { maxRecordBytes: 64 });
  try {
    const session = await reader.beginRead();
    try {
      // Row a's read fills the window with both frames; row b is then decoded from it, and must still be refused.
      const batches = session.scanBatches({ batchSize: 1 });
      expect((await batches.next()).value).toEqual([{ key: 'a', value: 1, revision: 1 }]);
      await expect(batches.next()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      const scan = session.scan();
      expect((await scan.next()).value).toEqual({ key: 'a', value: 1, revision: 1 });
      await expect(scan.next()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    } finally { await session.close(); }
  } finally { await reader.close(); }
});
