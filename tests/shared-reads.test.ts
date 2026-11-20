/** Storage 0.4 shares read-only handles; the I/O lock must share with them and keep owners and removals apart. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locks } from 'node:worker_threads';
import { createMemoryStorage } from 'defuss-storage';
import { afterEach, expect, test } from 'vitest';
import { createMemoryBackend, openDbsonl } from '../src/index.js';
import type { Backend } from '../src/index.js';
import { createFileBackend } from '../src/server.js';
import { createBrowserBackend } from '../src/browser.js';
import { locked, withFile } from '../src/core/backend.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const backends: [string, () => Promise<Backend>][] = [
  ['memory', async () => createMemoryBackend()],
  // The browser coordinator on Node's real Web Lock manager; OPFS itself runs in the browser suite.
  ['web-locks', async () => createBrowserBackend(createMemoryStorage(), `shared-${Math.random()}`, locks)],
  ['native', async () => { const root = await mkdtemp(join(tmpdir(), 'dbsonl-shared-')); roots.push(root); return createFileBackend(root); }],
];

for (const [kind, make] of backends) {
  test(`${kind}: read-only opens of one file overlap`, async () => {
    const backend = await make();
    await withFile(backend, 'f', { create: true }, file => file.write(0, new Uint8Array([7])));
    // An exclusive I/O lock would deadlock here: the inner reader waits for the outer one, which waits for it.
    const inner = await withFile(backend, 'f', { readOnly: true }, () =>
      withFile(backend, 'f', { readOnly: true }, async file => (await file.read(0, 1))[0]));
    expect(inner).toBe(7);
  }, 3000);

  test(`${kind}: a writer and a removal wait for open readers instead of failing BUSY`, async () => {
    const backend = await make();
    await withFile(backend, 'f', { create: true }, file => file.flush());
    let finishRead!: () => void; let opened!: () => void;
    const open = new Promise<void>(resolve => { opened = resolve; });
    const reading = withFile(backend, 'f', { readOnly: true }, () => { opened(); return new Promise<void>(resolve => { finishRead = resolve; }); });
    await open;
    let wrote = false;
    const writing = withFile(backend, 'f', {}, async file => { await file.write(0, new Uint8Array([1])); wrote = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(wrote).toBe(false);
    finishRead(); await reading; await writing;
    expect(wrote).toBe(true);
    const held = withFile(backend, 'f', { readOnly: true }, () => new Promise(resolve => setTimeout(resolve, 20)));
    await new Promise(resolve => setTimeout(resolve, 5));
    // collect() removes under the bare I/O lock, without a handle of its own.
    await locked(backend, 'io-f', () => backend.storage.remove('f'));
    await held;
    expect(await backend.storage.list()).not.toContain('f');
  });
}

test('memory: parallel snapshot scans run beside commits, compaction and collection', async () => {
  const db = await openDbsonl<{ n: number; pad: string }>(createMemoryBackend(), 'parallel', { create: true });
  await db.batch(Array.from({ length: 2000 }, (_, n) => ({ operation: 'put' as const, key: `k${String(n).padStart(5, '0')}`, value: { n, pad: 'x'.repeat(200) } })));
  const scan = async () => {
    const session = await db.beginRead(); let rows = 0;
    try { for await (const batch of session.scanBatches({ batchSize: 64 })) rows += batch.length; } finally { await session.close(); }
    return { rows, count: session.count };
  };
  const writes = (async () => { for (let i = 0; i < 40; i++) await db.put(`w${i}`, { n: i, pad: '' }); await db.compact(); await db.collect(); })();
  const results = await Promise.all([scan(), scan(), scan(), scan(), writes.then(scan)]);
  for (const { rows, count } of results) expect(rows).toBe(count);
  expect(results.at(-1)!.count).toBe(2040);
  expect((await db.verify()).count).toBe(2040);
  await db.close();
});
