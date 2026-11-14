/** VERIFIED: Fast reads retain isolation, resource bounds, corruption checks and close ordering. */
import { test, expect, beforeAll } from 'vitest';
import { mkdtemp, mkdir, rm, readdir, readlink, open, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeFrame } from 'defuss-dson/sequence';
import { createFileBackend } from '../src/server.js';
import { openDbsonl } from '../src/index.js';
import { headFile, generationFile, readHead, readValue, SLOT_BYTES } from '../src/core/io.js';
beforeAll(async () => { await mkdir('tmp', { recursive: true }); });

test('native capabilities capture validated factory options instead of retaining caller mutation', async () => {
  const root = await mkdtemp(resolve('tmp/fast-options-'));
  try {
    const options = { maxReadBytes: 1024 };
    const backend = await createFileBackend(root, options); options.maxReadBytes = 0;
    const db = await openDbsonl(backend, 'options', { create: true });
    try { await db.put('x', 1); expect((await db.get('x')).value).toBe(1); } finally { await db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const io of ['async', 'sync'] as const) test(`native ${io}: stale head speculation, buffered writes, scan windows and concurrent close`, async () => {
  const root = await mkdtemp(resolve('tmp/fast-'));
  try {
    // Tiny real adapter limits force both buffered and direct writes across chunks.
    const backend = await createFileBackend(root, { io, maxReadBytes: 257, maxWriteBytes: 127 });
    const a = await openDbsonl<{ n: number; binary: Uint8Array }>(backend, 'fast', { create: true });
    const b = await openDbsonl<{ n: number; binary: Uint8Array }>(await createFileBackend(root), 'fast');
    await a.batch(Array.from({ length: 70 }, (_, n) => ({ operation: 'put', key: `k${n}`, value: { n, binary: new Uint8Array(n === 4 ? 131073 : 129).fill(n) } })));
    const first = await a.get('k4'); first.value!.binary[0] = 255;
    expect((await a.get('k4')).value!.binary[0]).toBe(4);
    const old = await a.beginRead(); const scan = old.scan(); const firstRow = await scan.next();
    // Even accessing the returned view's entire buffer must not expose or mutate
    // the encoded read-ahead window containing other records.
    new Uint8Array(firstRow.value!.value.binary.buffer).fill(255);
    await b.put('k4', { n: 999, binary: new Uint8Array([99]) }); await b.compact();
    expect((await a.get('k4')).value!.n).toBe(999);
    expect((await old.get('k4')).value!.n).toBe(4);
    let count = 1; for await (const row of scan) { expect(row.value.n).toBe(Number(row.key.slice(1))); count++; }
    expect(count).toBe(70); await old.close(); await b.collect();
    // Cache a root, then remove its generation through another client. A failed
    // speculative read must not mask the successfully published replacement.
    const cold = await openDbsonl<{ n: number }>(backend, 'fast');
    await cold.stats(); await b.compact(); await b.collect();
    expect((await cold.get('k4')).value!.n).toBe(999); await cold.close();
    expect((await a.get('k4')).value!.n).toBe(999);
    const pending = Array.from({ length: 48 }, (_, n) => a.get(`k${n}`));
    const close = a.close(); const values = await Promise.all(pending);
    expect(values.every(value => value.found)).toBe(true); await close;
    await expect(a.get('k0')).rejects.toMatchObject({ code: 'CLOSED' });
    await b.verify(); await b.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native readers reread persisted values and detect manifest changes after warming', async () => {
  const root = await mkdtemp(resolve('tmp/fast-damage-'));
  try {
    const backend = await createFileBackend(root); const db = await openDbsonl(backend, 'damage', { create: true });
    await db.put('key', 'original'); await db.get('key'); await db.get('key');
    // Losing unused slot padding is permitted; odd-sized comparison must fall
    // back safely instead of constructing a misaligned Uint32Array view.
    const padding = await open(resolve(root, headFile('damage')), 'r+');
    await padding.truncate(SLOT_BYTES * 2 - 1); await padding.close();
    expect((await db.get('key')).value).toBe('original');
    expect((await db.get('key')).value).toBe('original');
    const head = await readHead(backend, 'damage');
    const data = await open(resolve(root, generationFile('damage', head.generation)), 'r+');
    await data.write(new Uint8Array([255]), 0, 1, 16); await data.close();
    await expect(db.get('key')).rejects.toMatchObject({ code: 'CORRUPT' });
    await expect(db.verify()).rejects.toMatchObject({ code: 'CORRUPT' });
    const manifest = await open(resolve(root, headFile('damage')), 'r+');
    await manifest.write(new Uint8Array(SLOT_BYTES * 2), 0, SLOT_BYTES * 2, 0);
    await expect(db.get('key')).rejects.toMatchObject({ code: 'CORRUPT' });
    await manifest.truncate(SLOT_BYTES * 2 + 1);
    await expect(db.stats()).rejects.toMatchObject({ code: 'CORRUPT' });
    await manifest.close(); await db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native known-length reads bound allocations, detect mismatched lengths and truncation', async () => {
  const root = await mkdtemp(resolve('tmp/fast-length-'));
  try {
    const backend = await createFileBackend(root); const db = await openDbsonl(backend, 'length', { create: true });
    await db.put('x', 1); const head = await readHead(backend, 'length');
    const frame = encodeFrame(1);
    await expect(readValue(db.backend, 'length', head, { offset: 0, byteLength: frame.length }, 1)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(readValue(db.backend, 'length', head, { offset: 0, byteLength: frame.length + 1 }, 1024)).rejects.toMatchObject({ code: 'CORRUPT' });
    const file = await open(resolve(root, generationFile('length', head.generation)), 'r+'); await file.truncate(17); await file.close();
    await expect(readValue(db.backend, 'length', head, { offset: 0, byteLength: frame.length }, 1024)).rejects.toMatchObject({ code: 'CORRUPT' });
    await db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== 'linux')('native descriptor reuse is bounded and closes after failed opens and database close', async () => {
  const root = await mkdtemp(resolve('tmp/fast-fds-'));
  const descriptors = async () => {
    let count = 0;
    for (const id of await readdir('/proc/self/fd')) {
      try { if ((await readlink(`/proc/self/fd/${id}`)).startsWith(root)) count++; } catch { /* Other concurrent tests close descriptors. */ }
    }
    return count;
  };
  try {
    const backend = await createFileBackend(root);
    expect(() => backend.connect!('../outside')).toThrow();
    for (let i = 0; i < 8; i++) await expect(openDbsonl(backend, 'absent')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await descriptors()).toBe(0);
    const db = await openDbsonl(backend, 'bounded', { create: true }); await db.put('x', 1);
    for (let i = 0; i < 32; i++) await db.get('x');
    expect(await descriptors()).toBeLessThanOrEqual(3);
    for (let i = 0; i < 5; i++) { await db.compact(); await db.collect(); await db.get('x'); }
    expect(await descriptors()).toBeLessThanOrEqual(3);
    await db.close(); expect(await descriptors()).toBe(0);
    await symlink(resolve(root, 'bounded.head'), resolve(root, 'linked.head'));
    await expect(openDbsonl(backend, 'linked')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(await descriptors()).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
