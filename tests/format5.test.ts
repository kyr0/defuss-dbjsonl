/**
 * Format 5: index pages are written at checkpoints; in between, each commit logs its key changes, and every handle that
 * did not write them replays the log onto the written root (src/core/store.ts effective(), docs/FORMAT.md).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { decodeFrame } from 'defuss-dson/sequence';
import { createMemoryBackend, openDbsonl } from '../src/index.js';
import type { Backend } from '../src/index.js';
import { createFileBackend } from '../src/server.js';
import { generationFile, readHead } from '../src/core/io.js';
import { decodeChanges, encodeChanges } from '../src/core/page.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const directory = async () => { const root = await mkdtemp(join(tmpdir(), 'dbsonl-format5-')); roots.push(root); return root; };
const backends: [string, () => Promise<Backend>][] = [
  ['memory', async () => createMemoryBackend()],
  ['native', async () => createFileBackend(await directory(), { scanWorkers: 0 })],
];
type Db = Awaited<ReturnType<typeof openDbsonl<number>>>;
async function rows(db: Db): Promise<[string, number][]> {
  const out: [string, number][] = [], session = await db.beginRead();
  try { for await (const row of session.scan()) out.push([row.key, row.value]); } finally { await session.close(); }
  return out;
}
const sorted = (map: Map<string, number>) => [...map].sort(([a], [b]) => (a < b ? -1 : 1));
function random(seed: number) { return () => (seed = (seed * 48271) % 2147483647); }

for (const [kind, open] of backends) {
  test(`${kind}: logged commits match a Map across both checkpoint triggers, snapshots, compaction and reopen`, async () => {
    const backend = await open();
    // A small page budget, so logged commits reach it and checkpoint often.
    let db = await openDbsonl<number>(backend, 'log', { create: true, maxCachePages: 24 });
    const oracle = new Map<string, number>(), next = random(7);
    const pinned: { session: Awaited<ReturnType<Db['beginRead']>>; expected: [string, number][] }[] = [];
    let logged = 0, checkpoints = 0;
    for (let round = 0; round < 120; round++) {
      await db.batch(Array.from({ length: 1 + (next() % 40) }, () => {
        const key = `k${String(next() % 900).padStart(4, '0')}`;
        if (next() % 5 === 0) { oracle.delete(key); return { operation: 'delete' as const, key }; }
        const value = next(); oracle.set(key, value); return { operation: 'put' as const, key, value };
      }));
      const head = await readHead(backend, 'log');
      expect(head.dbsonl).toBe(5);
      if (head.last) logged++; else checkpoints++;
      if (round % 17 === 0) pinned.push({ session: await db.beginRead(), expected: sorted(oracle) });
      if (round % 29 === 0) expect(await rows(db)).toEqual(sorted(oracle));
      if (round === 60) await db.compact({ mode: 'exclusive' });
    }
    expect(logged).toBeGreaterThan(0); expect(checkpoints).toBeGreaterThan(0);
    expect(await rows(db)).toEqual(sorted(oracle));
    expect((await db.stats()).count).toBe(oracle.size);
    for (const { session, expected } of pinned) {
      const seen: [string, number][] = [];
      for await (const row of session.scan()) seen.push([row.key, row.value]);
      expect(seen).toEqual(expected);
      await session.close();
    }
    await db.close();
    // A new handle replays the log that the last checkpoint left.
    db = await openDbsonl<number>(backend, 'log');
    expect(await rows(db)).toEqual(sorted(oracle));
    expect(await db.verify()).toMatchObject({ count: oracle.size });
    await db.close();
  });

  test(`${kind}: other handles replay each other's logged commits, also from an older snapshot head`, async () => {
    const backend = await open();
    const a = await openDbsonl<number>(backend, 'shared', { create: true }), b = await openDbsonl<number>(backend, 'shared');
    await a.batch(Array.from({ length: 50 }, (_, n) => ({ operation: 'put' as const, key: `a${n}`, value: n })));
    const early = await a.beginRead();
    expect((await b.get('a7')).value).toBe(7);
    // b builds on the log a wrote, and a then replays b's commit after its own.
    await b.batch([{ operation: 'put', key: 'b1', value: 1 }, { operation: 'delete', key: 'a3' }]);
    await a.put('a50', 50);
    expect((await a.get('b1')).value).toBe(1); expect((await a.get('a3')).found).toBe(false);
    expect((await b.get('a50')).value).toBe(50);
    expect((await readHead(backend, 'shared')).last).not.toBeNull();
    // A third handle reads the older snapshot head, which is no longer the latest.
    const c = await openDbsonl<number>(backend, 'shared'), old = await c.beginRead({ at: early.head });
    let count = 0; for await (const row of old.scan()) { expect(row.key).toMatch(/^a\d+$/); count++; }
    expect(count).toBe(50);
    await old.close(); await early.close();
    expect(await c.verify()).toMatchObject({ count: 51, revision: 3 });
    await Promise.all([a.close(), b.close(), c.close()]);
  });

  test(`${kind}: a damaged change list in the log fails with CORRUPT instead of being skipped`, async () => {
    const backend = await open();
    const db = await openDbsonl<number>(backend, 'damage', { create: true });
    await db.put('x', 1); await db.put('y', 2);
    const head = await readHead(backend, 'damage'); await db.close();
    // The change list frame sits just before the last record; flip a byte of its payload.
    const file = await backend.storage.open(generationFile('damage', head.generation));
    const data = await file.read(0, await file.size());
    const record = decodeFrame(data.subarray(head.last!.offset, head.end), 0, { maxRecordBytes: 1024, maxDepth: 8, maxReferences: 100 }).value as { changes: { offset: number } };
    const at = record.changes.offset + 20, byte = await file.readExactly(at, 1); byte[0] = byte[0]! ^ 255;
    await file.write(at, byte); await file.close();
    const reopened = await openDbsonl<number>(backend, 'damage');
    await expect(reopened.get('x')).rejects.toMatchObject({ code: 'CORRUPT' });
    await expect(reopened.verify()).rejects.toMatchObject({ code: 'CORRUPT' });
    await reopened.close();
  });
}

test('a commit that takes the log past 16 MiB writes its pages and starts a new log', async () => {
  const backend = createMemoryBackend(), db = await openDbsonl<Uint8Array>(backend, 'big', { create: true, maxRecordBytes: 2 << 20 });
  let head = await readHead(backend, 'big');
  for (let n = 0; head.end - head.log! < 16 * 1024 * 1024 || head.last; n++) {
    await db.put(`v${String(n).padStart(3, '0')}`, new Uint8Array(1 << 20).fill(n));
    head = await readHead(backend, 'big');
    if (!head.last) break;
  }
  expect(head.last).toBeNull(); expect(head.root).not.toBeNull(); expect(head.log).toBe(head.end);
  expect((await db.get('v005')).value![0]).toBe(5);
  await db.close();
});

test('scan workers replay the log of the snapshot they scan', async () => {
  const backend = await createFileBackend(await directory(), { scanWorkers: 2, scanThreshold: 1000 });
  const db = await openDbsonl<number>(backend, 'workers', { create: true });
  for (let round = 0; round < 6; round++)
    await db.batch(Array.from({ length: 1000 }, (_, n) => ({ operation: 'put' as const, key: `k${String(n * 6 + round).padStart(5, '0')}`, value: n })));
  expect((await readHead(backend, 'workers')).last).not.toBeNull();
  const session = await db.beginRead();
  try {
    let count = 0, previous = '';
    for await (const batch of session.scanBatches()) for (const row of batch) { expect(row.key > previous).toBe(true); previous = row.key; count++; }
    expect(count).toBe(6000);
  } finally { await session.close(); }
  await db.close();
});

test('change lists round-trip in key order and reject unordered or malformed input', () => {
  const entries = ['', 'a', 'ab', 'abc', 'é', '😀', '\ud800'].sort().map((key, n) => ({ key, ref: n % 3 ? { offset: n * 100, byteLength: 40 } : { offset: 0, byteLength: 0 }, revision: 1 + n }));
  const bytes = encodeChanges(entries);
  expect(decodeChanges(bytes, bytes.length)).toEqual(entries);
  expect(() => decodeChanges(encodeChanges([entries[1]!, entries[0]!]), 100)).toThrow(expect.objectContaining({ code: 'CORRUPT' }));
  expect(() => decodeChanges(bytes.subarray(0, bytes.length - 1), bytes.length)).toThrow(expect.objectContaining({ code: 'CORRUPT' }));
  const page = bytes.slice(); page[0] = 1;
  expect(() => decodeChanges(page, page.length)).toThrow(expect.objectContaining({ code: 'CORRUPT' }));
});
