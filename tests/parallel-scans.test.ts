/** split() ranges and beginRead({ at }) pins: what parallel scans in several workers rely on. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createMemoryBackend, openDbsonl } from '../src/index.js';
import type { Backend, Dbsonl, Partition, ReadSession, Row } from '../src/index.js';
import { createFileBackend } from '../src/server.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const native = async () => { const root = await mkdtemp(join(tmpdir(), 'dbsonl-parallel-')); roots.push(root); return root; };
// memory: two handles on one backend; native: two independent backends on one directory, as two processes would be.
const pairs: [string, () => Promise<[Backend, Backend]>][] = [
  ['memory', async () => { const backend = createMemoryBackend(); return [backend, backend]; }],
  ['native', async () => { const root = await native(); return [await createFileBackend(root), await createFileBackend(root)]; }],
];
type Doc = { n: number; text: string };
async function rows(session: ReadSession<Doc>, range: Partition = { count: 0 }): Promise<Row<Doc>[]> {
  const out: Row<Doc>[] = [];
  for await (const batch of session.scanBatches({ ...range, batchSize: 50 })) out.push(...batch);
  return out;
}
/** Overwrites and deletes leave superseded values and pages in the file, which a byte-range split would return. */
async function fill(db: Dbsonl<Doc>): Promise<void> {
  for (let start = 0; start < 3000; start += 500) {
    await db.batch(Array.from({ length: 500 }, (_, i) => { const n = start + i; return { operation: 'put' as const, key: `k${(n * 7919) % 3000}`.padEnd(2 + (n % 9), '~'), value: { n, text: 'x'.repeat(n % 300) } }; }));
  }
  await db.batch(Array.from({ length: 400 }, (_, i) => ({ operation: 'delete' as const, key: `k${i * 7}`.padEnd(2 + ((i * 7 * 7919) % 3000 % 9), '~') })));
  for (let i = 0; i < 300; i++) await db.put(`k${i * 3}`.padEnd(2 + (i % 4), '~'), { n: -i, text: 'updated' });
}

for (const [kind, make] of pairs) {
  test(`${kind}: split ranges cover the full scan exactly, in order, with exact counts`, async () => {
    const [backend] = await make();
    const db = await openDbsonl<Doc>(backend, 'split', { create: true });
    await fill(db);
    const session = await db.beginRead(), full = await rows(session);
    expect(full.length).toBe(session.count);
    for (const parts of [1, 2, 3, 4, 7, 8, 16, 64, 10000]) {
      const ranges = await session.split(parts);
      expect(ranges.length).toBeGreaterThanOrEqual(1);
      expect(ranges.length).toBeLessThanOrEqual(Math.min(parts, session.count));
      expect(ranges[0]!.gte).toBeUndefined(); expect(ranges.at(-1)!.lt).toBeUndefined();
      for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.gte).toBe(ranges[i - 1]!.lt);
      const union: Row<Doc>[] = [];
      for (const range of ranges) { const part = await rows(session, range); expect(part.length).toBe(range.count); union.push(...part); }
      expect(union).toEqual(full);
      // Near-equal: every piece is at most an eighth of a share, so a range misses its share by less than a quarter.
      if (parts <= 64) for (const range of ranges) expect(Math.abs(range.count - session.count / ranges.length)).toBeLessThan(session.count / ranges.length / 4 + 1);
    }
    // Ranges of a key interval: the same coverage and exact counts, bounded by the interval's own gte and lt.
    for (const [gte, lt] of [['k1', 'k2'], ['k15', undefined], [undefined, 'k07'], ['k2999~', 'k3'], ['k5', 'k4'], ['zzz', undefined]] as const) {
      const range = { ...(gte !== undefined && { gte }), ...(lt !== undefined && { lt }) };
      const expected: Row<Doc>[] = [];
      for await (const batch of session.scanBatches(range)) expected.push(...batch);
      for (const parts of [1, 3, 8]) {
        const ranges = await session.split(parts, range), union: Row<Doc>[] = [];
        expect(ranges[0]!.gte).toBe(gte); expect(ranges.at(-1)!.lt).toBe(lt);
        for (const part of ranges) { const rowsOf = await rows(session, part); expect(rowsOf.length).toBe(part.count); union.push(...rowsOf); }
        expect(union).toEqual(expected);
      }
    }
    await session.close(); await db.close();
  });

  test(`${kind}: another handle reads the same snapshot through beginRead({ at }) and its pin keeps it`, async () => {
    const [first, second] = await make();
    const a = await openDbsonl<Doc>(first, 'pinned', { create: true });
    await fill(a);
    const source = await a.beginRead(), expected = await rows(source);
    await a.put('k1', { n: 1, text: 'after' }); await a.delete('k2'); await a.compact();
    const b = await openDbsonl<Doc>(second, 'pinned');
    // A structured clone, as postMessage or workerData delivers it.
    const copy = await b.beginRead({ at: structuredClone(source.head) });
    expect(copy.revision).toBe(source.revision);
    await source.close();
    expect((await a.collect()).retained).toHaveLength(1);
    const parts = await copy.split(3), union: Row<Doc>[] = [];
    for (const range of parts) union.push(...await rows(copy, range));
    expect(union).toEqual(expected);
    const head = { ...copy.head };
    await copy.close();
    expect((await a.collect()).removed).toHaveLength(1);
    await expect(b.beginRead({ at: head })).rejects.toMatchObject({ code: 'CONFLICT' });
    await a.close(); await b.close();
  });
}

test('split and beginRead({ at }) reject invalid input', async () => {
  const db = await openDbsonl<number>(createMemoryBackend(), 'invalid', { create: true });
  const empty = await db.beginRead();
  expect(await empty.split(4)).toEqual([{ count: 0 }]);
  expect(() => empty.split(0)).toThrow(RangeError);
  await db.put('a', 1);
  const session = await db.beginRead();
  expect(() => db.beginRead({ at: { ...session.head, generation: 'nope' } })).toThrow(TypeError);
  expect(() => db.beginRead({ at: null as never })).toThrow(TypeError);
  // Bytes past the published end belong to the next writer.
  await expect(db.beginRead({ at: { ...session.head, end: session.head.end + 16, publication: session.head.publication + 1 } })).rejects.toThrow(TypeError);
  await expect(db.beginRead({ at: { ...session.head, generation: '0'.repeat(32) } })).rejects.toMatchObject({ code: 'CONFLICT' });
  await empty.close(); await session.close();
  await expect(session.split(2)).rejects.toMatchObject({ code: 'CLOSED' });
  await db.close();
});
