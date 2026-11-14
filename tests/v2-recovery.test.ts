import { test, expect } from 'vitest';
import { encodeFrame } from 'defuss-dson/sequence';
import { createMemoryBackend, openDbsonl } from '../src/index.js';
import { readHead, generationFile, headFile, SLOT_BYTES } from '../src/core/io.js';

test('torn unpublished data and a torn next head preserve the last complete atomic batch', async () => {
  const backend = createMemoryBackend(); const db = await openDbsonl(backend, 'recover', { create: true });
  await db.batch([{ operation: 'put', key: 'a', value: 1 }, { operation: 'put', key: 'b', value: 2 }]);
  const head = await readHead(backend, 'recover'); await db.close();
  let file = await backend.storage.open(generationFile('recover', head.generation));
  await file.append(encodeFrame('orphan').subarray(0, 17)); await file.close();
  file = await backend.storage.open(headFile('recover'));
  await file.write(((head.publication + 1) % 2) * SLOT_BYTES, encodeFrame({ ...head, publication: head.publication + 1 }).subarray(0, 20)); await file.close();
  const reopened = await openDbsonl(backend, 'recover');
  expect(await reopened.verify()).toEqual({ revision: 1, count: 2 });
  await reopened.put('c', 3); expect(await reopened.verify()).toEqual({ revision: 2, count: 3 }); await reopened.close();
});

test('committed corruption is not erased by opening or compaction', async () => {
  const backend = createMemoryBackend(); const db = await openDbsonl(backend, 'damage', { create: true });
  await db.put('a', 'payload'); const head = await readHead(backend, 'damage'); await db.close();
  const file = await backend.storage.open(generationFile('damage', head.generation));
  const bytes = await file.readExactly(16, 1); bytes[0] = bytes[0]! ^ 255; await file.write(16, bytes); await file.close();
  const reopened = await openDbsonl(backend, 'damage');
  await expect(reopened.get('a')).rejects.toMatchObject({ code: 'CORRUPT' });
  await expect(reopened.verify()).rejects.toMatchObject({ code: 'CORRUPT' });
  await expect(reopened.compact()).rejects.toMatchObject({ code: 'CORRUPT' });
  await reopened.close();
});

test('optimistic compaction conflicts with a writer and leaves the writer commit intact', async () => {
  const backend = createMemoryBackend(); const a = await openDbsonl(backend, 'conflict', { create: true });
  const b = await openDbsonl(backend, 'conflict');
  await a.batch(Array.from({ length: 200 }, (_, i) => ({ operation: 'put' as const, key: String(i), value: i })));
  const compact = a.compact();
  const write = b.put('new', 42);
  const result = await Promise.allSettled([compact, write]);
  expect(result[1]!.status).toBe('fulfilled');
  expect(result[0]!.status).toBe('rejected');
  if (result[0]!.status === 'rejected') expect(result[0]!.reason.code).toBe('CONFLICT');
  expect((await a.get('new')).value).toBe(42);
  await a.collect(); await a.close(); await b.close();
});

test('a missing generation and two invalid slots fail without automatic overwrite', async () => {
  const backend = createMemoryBackend(); let db = await openDbsonl(backend, 'missing', { create: true });
  await db.put('a', 1); const head = await readHead(backend, 'missing'); await db.close();
  await backend.storage.remove(generationFile('missing', head.generation));
  await expect(openDbsonl(backend, 'missing', { create: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  db = await openDbsonl(backend, 'heads', { create: true }); await db.close();
  const file = await backend.storage.open(headFile('heads'));
  await file.write(0, new Uint8Array(SLOT_BYTES * 2)); await file.close();
  await expect(openDbsonl(backend, 'heads', { create: true })).rejects.toMatchObject({ code: 'CORRUPT' });
});

test('every manifest frame cut selects either the old batch or the complete new batch', async () => {
  const backend = createMemoryBackend(); let db = await openDbsonl<number>(backend, 'cuts_v2', { create: true });
  await db.batch([{ operation: 'put', key: 'a', value: 1 }, { operation: 'put', key: 'b', value: 1 }]);
  let manifest = await backend.storage.open(headFile('cuts_v2')); const before = await manifest.readExactly(0, SLOT_BYTES * 2); await manifest.close();
  await db.batch([{ operation: 'put', key: 'a', value: 2 }, { operation: 'put', key: 'b', value: 2 }]);
  const head = await readHead(backend, 'cuts_v2'); await db.close();
  const next = encodeFrame(head); const offset = (head.publication % 2) * SLOT_BYTES;
  for (let cut = 0; cut <= next.length; cut++) {
    manifest = await backend.storage.open(headFile('cuts_v2'));
    await manifest.write(0, before); await manifest.write(offset, next.subarray(0, cut)); await manifest.close();
    db = await openDbsonl<number>(backend, 'cuts_v2');
    const a = await db.get('a'), b = await db.get('b');
    expect(a.value === 1 || a.value === 2).toBe(true); expect(b.value).toBe(a.value);
    expect((await db.stats()).revision).toBe(a.value); await db.close();
  }
});

test('collection never treats a foreign name sharing the generation prefix and suffix as owned', async () => {
  const backend = createMemoryBackend(); const db = await openDbsonl(backend, 'foreign', { create: true });
  const filename = `foreign.g-unrelated.g-${'a'.repeat(32)}.dsq`;
  const file = await backend.storage.open(filename, { create: true }); await file.append(new Uint8Array([42])); await file.close();
  expect((await db.collect()).removed).not.toContain(filename);
  expect(await backend.storage.list()).toContain(filename); await db.close();
});

test('an interrupted create is recoverable with create, while an empty head over data fails closed', async () => {
  const backend = createMemoryBackend();
  const empty = async (filename: string) => { const file = await backend.storage.open(filename, { create: true, exclusive: true }); await file.flush(); await file.close(); };
  // State left by a crash between head-file creation and the first slot publication.
  await empty(generationFile('crashed', '0'.repeat(32))); await empty(headFile('crashed'));
  await expect(openDbsonl(backend, 'crashed')).rejects.toMatchObject({ code: 'CORRUPT' });
  const db = await openDbsonl(backend, 'crashed', { create: true });
  await db.put('a', 1); expect(await db.verify()).toEqual({ revision: 1, count: 1 });
  expect((await db.collect()).removed).toEqual([generationFile('crashed', '0'.repeat(32))]); await db.close();

  const live = await openDbsonl(backend, 'truncated', { create: true }); await live.put('kept', 1); await live.close();
  const head = await backend.storage.open(headFile('truncated')); await head.truncate(0); await head.close();
  await expect(openDbsonl(backend, 'truncated', { create: true })).rejects.toMatchObject({ code: 'CORRUPT' });
});
