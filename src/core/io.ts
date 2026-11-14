/** VERIFIED: Data is flushed before a checksummed head slot makes a root visible. */
import { encodeFrame, decodeFrame } from 'defuss-dson/sequence';
import type { StorageFile } from 'defuss-storage';
import { withFile, writeBytes } from './backend.js';
import { DbsonlError, corrupt, reference, natural } from './common.js';
import type { Limits } from './common.js';
import type { Backend, Head, Ref } from './types.js';

export const SLOT_BYTES = 4096;
export const generationFile = (name: string, generation: string) => `${name}.g-${generation}.dsq`;
export const headFile = (name: string) => `${name}.head`;
/** Per-connection parse cache; bytes are reread under the commit lock on every call. */
export interface HeadCache { bytes?: Uint8Array; head?: Head }
/** Fill length bytes unless EOF arrives first; callers decide whether a short read is corruption. */
async function readExact(file: StorageFile, offset: number, length: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(length); let used = 0;
  while (used < length) {
    const count = await file.readInto(offset + used, bytes.subarray(used, Math.min(length, used + file.maxReadBytes)));
    if (!count) break;
    used += count;
  }
  return used === length ? bytes : bytes.subarray(0, used);
}
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Aligned word comparison won in both runtime microbenchmarks. Manual four-way
  // unrolling regressed Node, so the hot loop stays simple for each JIT to optimize.
  if (!((a.byteOffset | b.byteOffset | a.length) & 3)) {
    const x = new Uint32Array(a.buffer, a.byteOffset, a.length / 4), y = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** A valid newer head never silently falls back merely because its data is corrupt. */
export async function readHead(backend: Backend, name: string, cache?: HeadCache): Promise<Head> {
  const data = backend.read ? await backend.read(headFile(name), 0, SLOT_BYTES * 2 + 1) :
    await withFile(backend, headFile(name), { readOnly: true }, async file => {
      const size = await file.size();
      if (size > SLOT_BYTES * 2) corrupt('Manifest exceeds its two fixed slots.');
      const bytes = await readExact(file, 0, size);
      if (bytes.length !== size) corrupt('Manifest shrank while locked.');
      return bytes;
    });
  const size = data.length;
  if (size > SLOT_BYTES * 2) corrupt('Manifest exceeds its two fixed slots.');
  // This is a parse cache, never a freshness shortcut. Comparing all persisted
  // bytes also notices corruption without trusting revision or timestamp metadata.
  if (cache?.bytes && cache.head && equalBytes(data, cache.bytes)) return cache.head;
  const heads: Head[] = [];
  for (let slot = 0; slot < 2; slot++) {
    const offset = slot * SLOT_BYTES;
    if (size <= offset) continue;
    const bytes = data.subarray(offset, Math.min(size, offset + SLOT_BYTES));
    let value: unknown;
    try { value = decodeFrame(bytes, 0, { maxRecordBytes: SLOT_BYTES - 16, maxDepth: 8, maxReferences: 100 }).value; }
    catch { continue; } // A torn slot is the reason there are two independently checksummed slots.
    const h = value as Head;
    if (!h || h.dbsonl !== 2) throw new DbsonlError('UNSUPPORTED', 'Unsupported database manifest version.');
    if (!Number.isSafeInteger(h.publication) || h.publication < 1 || !Number.isSafeInteger(h.revision) || h.revision < 0 || !Number.isSafeInteger(h.count) || h.count < 0 || !Number.isSafeInteger(h.end) || h.end < 0 || !/^[0-9a-f]{32}$/.test(h.generation)) corrupt('Invalid manifest fields.');
    if (h.root !== null) reference(h.root, h.end);
    if ((h.root === null) !== (h.count === 0)) corrupt('Empty root and count disagree.');
    heads.push(h);
  }
  if (!heads.length) corrupt('No valid commit slot. Refuse automatic data loss recovery.');
  heads.sort((a, b) => b.publication - a.publication);
  const head = heads[0]!;
  if (cache) { cache.bytes = data; cache.head = head; }
  return head;
}
/** Publish exactly one slot. A failed call has an uncertain commit outcome; reopen to resolve it. */
export async function publish(backend: Backend, name: string, head: Head): Promise<void> {
  natural(head.publication, 'publication', 1);
  const bytes = encodeFrame(head, { maxRecordBytes: SLOT_BYTES - 16 });
  const slot = new Uint8Array(SLOT_BYTES); slot.set(bytes);
  await withFile(backend, headFile(name), { create: true }, async file => {
    await writeBytes(file, (head.publication % 2) * SLOT_BYTES, slot, backend.writeChunkBytes);
    await file.flush();
  });
  await backend.coordinator.syncDirectory();
}
/** A small page budget and a value budget are separate because long keys are legitimate. */
export const PAGE_BYTES = 512 * 1024;
/** A scan owns one bounded window; point lookups and verify always reread values. */
export interface ReadWindow { offset?: number; bytes?: Uint8Array }
export async function readValue<T>(backend: Backend, name: string, head: Head, ref: Ref, maxRecordBytes: number, window?: ReadWindow): Promise<T> {
  reference(ref, head.end);
  // The index already supplies a checked address and length. Bound that length
  // before allocation, then verify the complete frame in one positional read.
  if (ref.byteLength - 16 > maxRecordBytes) throw new DbsonlError('LIMIT_EXCEEDED', 'Referenced record exceeds the decoder budget.');
  let bytes: Uint8Array;
  if (window?.bytes && window.offset !== undefined && ref.offset >= window.offset && ref.offset + ref.byteLength <= window.offset + window.bytes.length) {
    bytes = window.bytes.subarray(ref.offset - window.offset, ref.offset - window.offset + ref.byteLength);
  } else {
    const length = backend.read && window && ref.byteLength <= 65536 ? Math.min(65536, head.end - ref.offset) : ref.byteLength;
    const filename = generationFile(name, head.generation);
    const data = backend.read ? await backend.read(filename, ref.offset, length) :
      // Portable handles also benefit from known, bounded reference lengths:
      // fetch header and payload together rather than allocate and copy twice.
      await withFile(backend, filename, { readOnly: true }, file => readExact(file, ref.offset, length));
    // Prefetch stays inside the pinned committed prefix. Large records bypass it
    // so the scan cannot retain a second record-sized allocation between pulls.
    if (window && backend.read) { window.offset = ref.offset; window.bytes = length <= 65536 ? data : new Uint8Array(0); }
    bytes = data.subarray(0, ref.byteLength);
  }
  return decodeRef<T>(bytes, ref, maxRecordBytes);
}
/** One decoder boundary for values and the writer's page reads: checksum, budget and exact length. */
function decodeRef<T>(bytes: Uint8Array, ref: Ref, maxRecordBytes: number): T {
  if (bytes.length !== ref.byteLength) corrupt('Committed record is truncated.');
  try {
    const frame = decodeFrame(bytes, 0, { maxRecordBytes, maxDepth: 512, maxReferences: 1_000_000 });
    if (frame.byteLength !== ref.byteLength) corrupt('Record reference length does not match its frame.');
    return frame.value as T;
  } catch (cause) {
    if (cause instanceof DbsonlError) throw cause;
    throw new DbsonlError(cause instanceof RangeError ? 'LIMIT_EXCEEDED' : 'CORRUPT', 'DSON record decoding failed.', { cause });
  }
}
/** Appends are private until publish; no uncommitted address escapes the writer. */
export class Appender {
  end: number;
  private readonly buffer: Uint8Array;
  private used = 0;
  private flushedEnd: number;
  constructor(readonly file: StorageFile, end: number, readonly limits: Limits, private readonly chunkSize: number) {
    this.end = end; this.flushedEnd = end; this.buffer = new Uint8Array(Math.min(chunkSize, 65536));
  }
  /** Coalesce small frames, but preserve the data-before-manifest durability barrier. */
  async flush(): Promise<void> {
    if (!this.used) return;
    await writeBytes(this.file, this.flushedEnd, this.buffer.subarray(0, this.used), this.chunkSize);
    this.flushedEnd += this.used; this.used = 0;
  }
  async bytes(bytes: Uint8Array): Promise<Ref> {
    const ref = { offset: this.end, byteLength: bytes.length };
    natural(this.end + bytes.length, 'file end');
    if (bytes.length > this.buffer.length - this.used) await this.flush();
    if (bytes.length > this.buffer.length) {
      await writeBytes(this.file, this.end, bytes, this.chunkSize); this.flushedEnd += bytes.length;
    } else { this.buffer.set(bytes, this.used); this.used += bytes.length; }
    this.end += bytes.length; return ref;
  }
  async value(value: unknown, page = false): Promise<Ref> {
    return this.bytes(encodeFrame(value, { maxRecordBytes: page ? PAGE_BYTES : this.limits.maxRecordBytes }));
  }
  /** Committed pages only: the writer's own handle is exclusive, so it cannot reopen the file. */
  async read<T>(ref: Ref): Promise<T> {
    reference(ref, this.end);
    if (ref.byteLength - 16 > PAGE_BYTES) corrupt('Index page reference exceeds the page budget.');
    return decodeRef<T>(await readExact(this.file, ref.offset, ref.byteLength), ref, PAGE_BYTES);
  }
}
