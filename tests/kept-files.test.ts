/** Native head and generation files stay open between commits, shared by the handles of one realm. */
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createFileStorage } from 'defuss-storage/node';
import { openDbsonl } from '../src/index.js';
import { createFileBackend } from '../src/server.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const directory = async () => { const root = await mkdtemp(join(tmpdir(), 'dbsonl-kept-')); roots.push(root); return root; };

test('handles of two backends commit in turn, collect generations the other kept open, and release them on close', async () => {
  const root = await directory();
  // Different limits per backend: each keeps its own handles, which carry its adapter's limits.
  const a = await openDbsonl<number>(await createFileBackend(root, { scanWorkers: 0 }), 'shared', { create: true });
  const b = await openDbsonl<number>(await createFileBackend(root, { scanWorkers: 0, maxWriteBytes: 4096 }), 'shared');
  for (let i = 0; i < 6; i++) await (i % 2 ? b : a).put(`k${i}`, i);
  expect((await a.stats()).revision).toBe(6); expect((await b.get('k4')).value).toBe(4);
  // b compacts to a new generation and removes the old one, which a still holds open for its commits.
  await b.compact();
  expect((await b.collect()).removed).toHaveLength(1);
  await a.put('after', 7);
  expect(await b.verify()).toMatchObject({ count: 7, revision: 7 });
  expect((await readdir(root)).filter(file => file.endsWith('.dsq'))).toHaveLength(1);
  await a.close(); await b.close();
  // With every handle closed, nothing in this realm owns the files: a plain exclusive Storage open succeeds.
  const storage = await createFileStorage(root);
  for (const file of (await readdir(root)).filter(name => name === 'shared.head' || name.endsWith('.dsq'))) await (await storage.open(file)).close();
});

test.skipIf(process.getuid?.() === 0)('read-only database files still open for reading', async () => {
  const root = await directory();
  const db = await openDbsonl<string>(await createFileBackend(root, { scanWorkers: 0 }), 'frozen', { create: true });
  await db.put('a', 'value'); await db.close();
  const files = (await readdir(root)).filter(name => name === 'frozen.head' || name.endsWith('.dsq'));
  await Promise.all(files.map(file => chmod(join(root, file), 0o444)));
  try {
    const reader = await openDbsonl<string>(await createFileBackend(root, { scanWorkers: 0 }), 'frozen');
    expect((await reader.get('a')).value).toBe('value');
    await expect(reader.put('b', 'x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await reader.close();
  } finally { await Promise.all(files.map(file => chmod(join(root, file), 0o600))); }
});

test('syncReadBytes bounds blocking reads and is validated', async () => {
  const root = await directory();
  const blocking = await openDbsonl<string>(await createFileBackend(root, { scanWorkers: 0, syncReadBytes: 1 << 20 }), 'reads', { create: true });
  await blocking.batch(Array.from({ length: 50 }, (_, i) => ({ operation: 'put' as const, key: `k${i}`, value: 'x'.repeat(i * 100) })));
  const pooled = await openDbsonl<string>(await createFileBackend(root, { scanWorkers: 0, syncReadBytes: 0 }), 'reads');
  for (let i = 0; i < 50; i += 7) expect((await pooled.get(`k${i}`)).value).toBe((await blocking.get(`k${i}`)).value);
  await blocking.close(); await pooled.close();
  await expect(createFileBackend(root, { syncReadBytes: -1 })).rejects.toThrow(RangeError);
});
