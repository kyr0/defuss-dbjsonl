/**
 * Formats 3 to 5: one generation flush per commit, with commit records that rebuild a head whose slot never reached the
 * disk. Format 4 adds compact index pages to format 3's records; format 5, which new databases use, logs key changes
 * between checkpoints. The recovery tests run on formats 4 and 5.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { decodeFrame, encodeFrame, inspectFrame } from 'defuss-dson/sequence';
import { createMemoryBackend, openDbsonl } from '../src/index.js';
import type { Backend } from '../src/index.js';
import { createFileBackend } from '../src/server.js';
import { crc32c, generationFile, headFile, readHead } from '../src/core/io.js';
import { older, restore } from './older.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const backends: [string, () => Promise<Backend>][] = [
  ['memory', async () => createMemoryBackend()],
  ['native', async () => { const root = await mkdtemp(join(tmpdir(), 'dbsonl-format3-')); roots.push(root); return createFileBackend(root, { scanWorkers: 0 }); }],
];
async function bytes(backend: Backend, name: string): Promise<Uint8Array> {
  const file = await backend.storage.open(name, { readOnly: true });
  try { return await file.read(0, await file.size()); } finally { await file.close(); }
}
/** A database of format 4, or a new one, which is format 5. */
async function create<T>(backend: Backend, name: string, format: 4 | 5, options: { maxRecordBytes?: number } = {}) {
  if (format === 4) await older(backend, name, 4);
  return openDbsonl<T>(backend, name, { create: true, ...options });
}
/** The decoded frame of the root page: a DSON object in formats 2 and 3, compact bytes in format 4. */
async function rootPage(backend: Backend, name: string): Promise<unknown> {
  const head = await readHead(backend, name), root = head.root!;
  const data = await bytes(backend, generationFile(name, head.generation));
  return decodeFrame(data.subarray(root.offset, root.offset + root.byteLength), 0, { maxRecordBytes: 1 << 20, maxDepth: 16, maxReferences: 1 << 16 }).value;
}
async function truncate(backend: Backend, name: string, size: number): Promise<void> {
  const file = await backend.storage.open(name);
  try { await file.truncate(size); await file.flush(); } finally { await file.close(); }
}

for (const [backendKind, make] of backends) for (const format of [4, 5] as const) {
  const kind = `${backendKind} format ${format}`;
  test(`${kind}: reopening adopts commits whose head slot was lost`, async () => {
    const backend = await make();
    let db = await create<unknown>(backend, 'lost', format);
    await db.put('a', 1);
    const head = await readHead(backend, 'lost');
    expect(head.dbsonl).toBe(format); expect(head.seal).toMatch(/^[0-9a-f]{32}$/);
    const early = await bytes(backend, headFile('lost'));
    await db.put('b', 2);
    // A stored value shaped like a commit record, with a seal it cannot know, stays a value.
    await db.batch([{ operation: 'put', key: 'c', value: { dbsonl: 3, seal: 'f'.repeat(32), publication: 99, revision: 99, root: null, count: 0, offset: 0, prev: 0 } }, { operation: 'put', key: 'd', value: 4 }]);
    const latest = await readHead(backend, 'lost');
    await db.close();
    await restore(backend, headFile('lost'), early);
    db = await openDbsonl(backend, 'lost');
    expect((await db.stats()).revision).toBe(3);
    expect((await readHead(backend, 'lost')).publication).toBe(latest.publication);
    expect((await db.get('b')).value).toBe(2); expect((await db.get('c')).value).toMatchObject({ publication: 99 });
    expect((await db.verify()).count).toBe(4);
    await db.close();
  });

  test(`${kind}: recovery checks frames by checksum, so values above the reopening handle's budget do not stop it`, async () => {
    const backend = await make();
    let db = await create<unknown>(backend, 'large', format, { maxRecordBytes: 1 << 20 });
    await db.put('a', 1);
    const early = await bytes(backend, headFile('large'));
    await db.put('big', new Uint8Array(600_000).fill(7)); await db.put('after', 2);
    await db.close();
    await restore(backend, headFile('large'), early);
    db = await openDbsonl(backend, 'large', { maxRecordBytes: 1024 });
    expect((await db.stats()).revision).toBe(3);
    expect((await db.get('after')).value).toBe(2);
    await db.close();
    // The checksum the walk computes is the one DSON writes into every frame header.
    const frame = encodeFrame({ some: 'value', n: [1, 2, 3] }), meta = inspectFrame(frame, 0);
    expect(crc32c(frame.subarray(meta.payloadOffset, meta.payloadOffset + meta.payloadLength))).toBe(meta.checksum);
  });

  test(`${kind}: a torn last commit ends recovery at the one before it`, async () => {
    const backend = await make();
    let db = await create<number>(backend, 'torn', format);
    await db.put('a', 1);
    const early = await bytes(backend, headFile('torn'));
    await db.put('b', 2); await db.put('c', 3);
    const { generation, end } = await readHead(backend, 'torn');
    await db.close();
    await restore(backend, headFile('torn'), early);
    await truncate(backend, generationFile('torn', generation), end - 3);
    db = await openDbsonl(backend, 'torn');
    expect((await db.stats()).revision).toBe(2);
    expect((await db.get('c')).found).toBe(false);
    // The next commit cuts the torn tail and goes on from the recovered commit.
    expect((await db.put('d', 4)).revision).toBe(3);
    expect((await db.verify()).count).toBe(3);
    await db.close();
  });

  test(`${kind}: a writer adopts durable commits that another handle left without a head slot`, async () => {
    const backend = await make();
    const a = await create<number>(backend, 'crash', format);
    const b = await openDbsonl<number>(backend, 'crash');
    await a.put('x', 1);
    const early = await bytes(backend, headFile('crash'));
    await a.put('y', 2);
    // The process that wrote y died after its generation flush and before its head slot.
    await a.close(); await restore(backend, headFile('crash'), early);
    expect((await b.get('y')).found).toBe(false);
    expect((await b.put('z', 3)).revision).toBe(3);
    expect((await b.get('y')).value).toBe(2);
    await b.compact(); await b.collect();
    expect(await b.verify()).toMatchObject({ count: 3, revision: 3 });
    expect((await readHead(backend, 'crash')).dbsonl).toBe(format);
    await b.close();
  });

  test(`${kind}: a write rejected before recovery stays rejected when its group is checked again`, async () => {
    const backend = await make();
    const a = await create<number>(backend, 'retry', format);
    const b = await openDbsonl<number>(backend, 'retry');
    await a.put('x', 1);
    const early = await bytes(backend, headFile('retry'));
    await a.put('y', 2);
    await a.close(); await restore(backend, headFile('retry'), early);
    // One group: w expects revision 2, which only the recovered commit reaches, so it fails against the old head.
    const [w, v] = await Promise.allSettled([b.put('w', 0, { ifRevision: 2 }), b.put('v', 0)]);
    expect(w).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
    expect(v).toMatchObject({ status: 'fulfilled', value: { revision: 3 } });
    expect((await b.get('w')).found).toBe(false);
    await b.close();
  });

}

for (const [kind, make] of backends) {
  test(`${kind}: a format 3 database keeps format 3, its commit records and DSON object pages`, async () => {
    const backend = await make();
    await older(backend, 'three', 3);
    const db = await openDbsonl<number>(backend, 'three');
    await db.batch(Array.from({ length: 300 }, (_, n) => ({ operation: 'put' as const, key: `k${n}`, value: n })));
    expect(await rootPage(backend, 'three')).toMatchObject({ kind: 'branch' });
    await db.compact({ mode: 'exclusive' });
    const head = await readHead(backend, 'three');
    expect(head.dbsonl).toBe(3); expect(head.seal).toMatch(/^[0-9a-f]{32}$/);
    expect(await rootPage(backend, 'three')).toMatchObject({ kind: 'branch' });
    await db.put('k300', 300);
    expect(await db.verify()).toMatchObject({ count: 301 });
    await db.close();
  });
  test(`${kind}: a format 2 database keeps format 2 and writes no commit records`, async () => {
    const backend = await make();
    await older(backend, 'legacy', 2);
    let db = await openDbsonl<number>(backend, 'legacy');
    await db.put('a', 1); await db.put('b', 2);
    const after = await readHead(backend, 'legacy');
    expect(after.dbsonl).toBe(2); expect(after.seal).toBeUndefined();
    // Without records, a lost head slot is a lost commit for format 2, so its commits keep flushing the head.
    const early = await bytes(backend, headFile('legacy'));
    await db.put('c', 3); await db.close();
    await restore(backend, headFile('legacy'), early);
    db = await openDbsonl(backend, 'legacy');
    expect((await db.get('c')).found).toBe(false);
    await db.compact();
    expect((await readHead(backend, 'legacy')).dbsonl).toBe(2);
    expect(await db.verify()).toMatchObject({ count: 2 });
    await db.close();
  });
}
