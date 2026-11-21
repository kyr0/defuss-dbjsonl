/** Compaction copies checked value frames in file order (readFrames in src/core/io.ts), not decoded values. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createMemoryBackend, openDbsonl } from '../src/index.js';
import type { Backend } from '../src/index.js';
import { createFileBackend } from '../src/server.js';
import { generationFile, readHead } from '../src/core/io.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const backends: [string, () => Promise<Backend>][] = [
  ['memory', async () => createMemoryBackend()],
  ['native', async () => { const root = await mkdtemp(join(tmpdir(), 'dbsonl-copy-')); roots.push(root); return createFileBackend(root, { scanWorkers: 0 }); }],
];
// Keys in one order, commits in another, so values sit in the file far from their key order; a few frames are
// larger than one read run, and every key is rewritten once so the file holds garbage between live frames.
const value = (i: number) => (i % 499 === 0 ? { i, blob: new Uint8Array(1_200_000).fill(i % 251) } : { i, at: new Date(i * 1000), note: 'n'.repeat(i % 300) });
const keys = Array.from({ length: 1500 }, (_, i) => `k${String((i * 7919) % 1500).padStart(5, '0')}`);
async function rows(db: Awaited<ReturnType<typeof openDbsonl<unknown>>>) {
  const out = new Map<string, { value: unknown; revision: number }>(), session = await db.beginRead();
  try { for await (const row of session.scan()) out.set(row.key, { value: row.value, revision: row.revision }); } finally { await session.close(); }
  return out;
}

for (const [kind, open] of backends) {
  test(`${kind}: compaction keeps every value and its revision across scattered commits`, async () => {
    const backend = await open(); const db = await openDbsonl<unknown>(backend, 'copy', { create: true, maxRecordBytes: 2 << 20 });
    for (let round = 0; round < 2; round++)
      for (let start = 0; start < keys.length; start += 100)
        await db.batch(keys.slice(start, start + 100).map((key, j) => ({ operation: 'put' as const, key, value: value(start + j + round) })));
    const before = await rows(db);
    const result = await db.compact({ mode: 'exclusive' });
    expect(result.afterBytes).toBeLessThan(result.beforeBytes);
    expect(await db.verify()).toMatchObject({ count: keys.length });
    expect(await rows(db)).toEqual(before);
    await db.close();
  });
}

test('compaction stops at a value whose frame header was damaged', async () => {
  const backend = createMemoryBackend(); const db = await openDbsonl(backend, 'header', { create: true });
  await db.batch(Array.from({ length: 50 }, (_, i) => ({ operation: 'put' as const, key: `k${i}`, value: i })));
  const head = await readHead(backend, 'header'); await db.close();
  const file = await backend.storage.open(generationFile('header', head.generation));
  // The first frame starts at offset 0; byte 4 lies inside its checksummed header.
  const bytes = await file.readExactly(4, 1); bytes[0] = bytes[0]! ^ 255; await file.write(4, bytes); await file.close();
  const reopened = await openDbsonl(backend, 'header');
  await expect(reopened.compact()).rejects.toMatchObject({ code: 'CORRUPT' });
  await reopened.close();
});
