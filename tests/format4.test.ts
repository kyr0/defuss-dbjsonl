/** Format 4: format 3's commit records with compact index pages (src/core/page.ts, docs/FORMAT.md). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { decodeFrame, encodeFrame } from 'defuss-dson/sequence';
import { createMemoryBackend, openDbsonl } from '../src/index.js';
import type { Backend, Mutation } from '../src/index.js';
import { createFileBackend } from '../src/server.js';
import { generationFile, headFile, readHead, SLOT_BYTES } from '../src/core/io.js';
import { older } from './older.js';
import { decodeCompactPage, encodeCompactPage } from '../src/core/page.js';
import type { Page } from '../src/core/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const backends: [string, () => Promise<Backend>][] = [
  ['memory', async () => createMemoryBackend()],
  ['native', async () => { const root = await mkdtemp(join(tmpdir(), 'dbsonl-format4-')); roots.push(root); return createFileBackend(root, { scanWorkers: 0 }); }],
];
async function bytes(backend: Backend, name: string): Promise<Uint8Array> {
  const file = await backend.storage.open(name, { readOnly: true });
  try { return await file.read(0, await file.size()); } finally { await file.close(); }
}
async function rootPage(backend: Backend, name: string): Promise<unknown> {
  const head = await readHead(backend, name), root = head.root!;
  const data = await bytes(backend, generationFile(name, head.generation));
  return decodeFrame(data.subarray(root.offset, root.offset + root.byteLength), 0, { maxRecordBytes: 1 << 20, maxDepth: 16, maxReferences: 1 << 16 }).value;
}
const order = ([a]: [string, number], [b]: [string, number]) => (a < b ? -1 : 1);
async function rows(db: Awaited<ReturnType<typeof openDbsonl<number>>>): Promise<[string, number][]> {
  const out: [string, number][] = [], session = await db.beginRead();
  try { for await (const row of session.scan()) out.push([row.key, row.value]); } finally { await session.close(); }
  return out;
}
// Keys a prefix or a byte-per-unit encoding could get wrong: empty, Latin-1 and wider units, surrogate pairs split by a
// shared prefix, lone surrogates, and the 4096-unit maximum.
const SPECIAL = ['', 'a', 'ab', 'é', 'éa', 'ÿ', 'Ā', '😀', '😀a', '😁', '\ud800', '\ud800x', '\udc00', 'x'.repeat(4096), 'x'.repeat(4095) + 'y'];

for (const [backendKind, make] of backends) for (const format of [4, 5] as const) {
  const kind = `${backendKind} format ${format}`;
  test(`${kind}: compact pages keep every key exact through commits, deletes, compaction and reopening`, async () => {
    const backend = await make();
    if (format === 4) await older(backend, 'keys', 4);
    let db = await openDbsonl<number>(backend, 'keys', { create: true });
    const expected = new Map<string, number>();
    let seed = 99;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const pick = () => {
      const n = random() % 5000;
      switch (random() % 4) {
        case 0: return `o:events:tenant_score:${String(n % 64).padStart(4, '0')}!${String(99999 - n).padStart(6, '0')}~n${n}`;
        case 1: return `d:events:n${n}`;
        case 2: return `ключ-${n}`;
        default: return String.fromCharCode(0xd800 + (n % 2048)) + n;
      }
    };
    for (let round = 0; round < 6; round++) {
      const batch: Mutation<number>[] = [];
      for (let n = 0; n < 400; n++) {
        const key = round === 0 && n < SPECIAL.length ? SPECIAL[n]! : pick();
        if (round === 0 || random() % 6) { expected.set(key, n); batch.push({ operation: 'put', key, value: n }); }
        else { expected.delete(key); batch.push({ operation: 'delete', key }); }
      }
      await db.batch(batch);
    }
    const sorted = [...expected].sort(order);
    expect(await rows(db)).toEqual(sorted);
    // Format 5 logs these commits, so its pages are written by the compaction below.
    if (format === 4) expect(await rootPage(backend, 'keys')).toBeInstanceOf(Uint8Array);
    for (const key of SPECIAL) expect(await db.get(key)).toMatchObject({ found: expected.has(key) });
    await db.compact({ mode: 'exclusive' });
    expect((await readHead(backend, 'keys')).dbsonl).toBe(format);
    expect(await rootPage(backend, 'keys')).toBeInstanceOf(Uint8Array);
    await db.close();
    db = await openDbsonl<number>(backend, 'keys');
    expect(await rows(db)).toEqual(sorted);
    expect(await db.verify()).toMatchObject({ count: expected.size });
    await db.close();
  });

}

for (const [kind, make] of backends) {
  test(`${kind}: compact pages under a format 3 head are CORRUPT, not misread`, async () => {
    const backend = await make();
    await older(backend, 'mixed', 4);
    const db = await openDbsonl<number>(backend, 'mixed', { create: true });
    await db.batch(Array.from({ length: 100 }, (_, n) => ({ operation: 'put' as const, key: `k${n}`, value: n })));
    await db.close();
    const head = await readHead(backend, 'mixed');
    const slots = new Uint8Array(SLOT_BYTES * 2);
    for (const publication of [head.publication, head.publication + 1])
      slots.set(encodeFrame({ ...head, dbsonl: 3, publication }), (publication % 2) * SLOT_BYTES);
    const file = await backend.storage.open(headFile('mixed'));
    try { await file.truncate(0); await file.write(0, slots); await file.flush(); } finally { await file.close(); }
    const reopened = await openDbsonl<number>(backend, 'mixed');
    await expect(reopened.get('k5')).rejects.toMatchObject({ code: 'CORRUPT' });
    await reopened.close();
  });
}

test('compact pages round-trip leaves and branches exactly', () => {
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let n = 0; n < 200; n++) {
    const size = 1 + (random() % 32);
    const keys = [...new Set(Array.from({ length: size }, () => (SPECIAL[random() % SPECIAL.length]! + String.fromCharCode(random() % 0x10000) + (random() % 1000)).slice(-4096)))].sort();
    const ref = () => ({ offset: random() * 2 ** 20 + (random() % 2 ** 20), byteLength: 1 + (random() % 70_000) });
    const page: Page = n % 2
      ? { kind: 'leaf', entries: keys.map(key => ({ key, ref: ref(), revision: 1 + (random() % 2 ** 30) })) }
      : { kind: 'branch', children: keys.map(max => ({ max, ref: ref(), count: 1 + random() })) };
    expect(decodeCompactPage(encodeCompactPage(page))).toEqual(page);
  }
});

test('malformed compact pages fail with CORRUPT', () => {
  const good = encodeCompactPage({ kind: 'leaf', entries: [{ key: 'a', ref: { offset: 1, byteLength: 20 }, revision: 1 }, { key: 'ab', ref: { offset: 30, byteLength: 20 }, revision: 2 }] });
  expect(decodeCompactPage(good)).toMatchObject({ kind: 'leaf' });
  for (const bad of [
    new Uint8Array([3, 1, 0, 2, 97, 1, 20, 1]), // unknown kind
    new Uint8Array([1, 0]), // no entries
    new Uint8Array([1, 33]), // more than 32 entries
    new Uint8Array([1, 1, 5, 2, 97, 1, 20, 1]), // shares 5 units with an empty previous key
    new Uint8Array([1, 1, 0, 0x80, 0x40, 97]), // key longer than 4096 units
    good.subarray(0, good.length - 1), // truncated
    new Uint8Array([...good, 0]), // trailing byte
    new Uint8Array([1, 1, 0, 2, 97, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 20, 1]), // number over 8 bytes
    new Uint8Array([1, 1, 0, 2, 97, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 20, 1]), // number above 2^53
  ]) expect(() => decodeCompactPage(bad)).toThrow(expect.objectContaining({ code: 'CORRUPT' }));
});
