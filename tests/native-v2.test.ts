import { test, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFileBackend } from '../src/server.js';
import { openDbsonl } from '../src/index.js';
beforeAll(async () => { await mkdir('tmp', { recursive: true }); });

test('independent native backends serialize writes and hold shared snapshot pins', async () => {
  const root = await mkdtemp(resolve('tmp/native-v2-'));
  try {
    const first = await createFileBackend(root); const second = await createFileBackend(root);
    const a = await openDbsonl(first, 'native', { create: true }); const b = await openDbsonl(second, 'native');
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).put(`${i}`, i)));
    expect((await a.stats()).count).toBe(12);
    const reader = await a.beginRead(); await b.put('0', 99); await b.compact();
    expect((await reader.get('0')).value).toBe(0);
    expect((await b.collect()).retained).toHaveLength(1);
    await reader.close(); expect((await b.collect()).removed).toHaveLength(1);
    await a.close(); await b.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});


test.skipIf(process.getuid?.() === 0)('real manifest permission failure reports uncertainty and preserves the prior commit', async () => {
  const root = await mkdtemp(resolve('tmp/publication-'));
  try {
    const backend = await createFileBackend(root); let db = await openDbsonl(backend, 'publish', { create: true });
    await db.put('a', 1);
    // An open handle keeps its files open, and permissions apply to the next open: reopen after the change.
    await db.close();
    await chmod(resolve(root, 'publish.head'), 0o444);
    db = await openDbsonl(backend, 'publish');
    try {
      await expect(db.batch([{ operation: 'put', key: 'a', value: 2 }, { operation: 'put', key: 'b', value: 3 }])).rejects.toMatchObject({ code: 'COMMIT_UNCERTAIN' });
      expect((await db.get('a')).value).toBe(1); expect((await db.get('b')).found).toBe(false);
      await expect(db.compact()).rejects.toMatchObject({ code: 'COMMIT_UNCERTAIN' });
    } finally { await chmod(resolve(root, 'publish.head'), 0o600); }
    // Format 3: the uncertain batch reached the generation with its commit record, so the next writer adopts it.
    await db.put('next', 4); expect(await db.verify()).toMatchObject({ count: 3, revision: 3 }); expect((await db.get('a')).value).toBe(2);
    // Compaction failed adopting that batch, before it wrote a candidate generation, so nothing is left to reclaim.
    expect((await db.collect()).removed).toEqual([]); await db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
