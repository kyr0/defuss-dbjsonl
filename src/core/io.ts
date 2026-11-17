/** VERIFIED: Data is flushed before a checksummed head slot makes a root visible. */
import { decodeFrame, decodeFrames, encodeFrame } from 'defuss-dson/sequence';
import { encodePage } from './page.js';
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
/**
 * Publish exactly one slot. A failed call has an uncertain commit outcome; reopen to resolve it.
 * Publication only overwrites a slot of an existing file, so it needs no directory sync: callers
 * sync the directory after creating or removing a file, before any head refers to it.
 */
export async function publish(backend: Backend, name: string, head: Head, cache?: HeadCache): Promise<void> {
  natural(head.publication, 'publication', 1);
  // trusted: the engine builds heads from plain data, so the per-property descriptor checks are skipped.
  const bytes = encodeFrame(head, { maxRecordBytes: SLOT_BYTES - 16, trusted: true });
  const slot = new Uint8Array(SLOT_BYTES); slot.set(bytes);
  const offset = (head.publication % 2) * SLOT_BYTES;
  await withFile(backend, headFile(name), {}, async file => {
    await writeBytes(file, offset, slot, backend.writeChunkBytes);
    await file.flush();
  });
  // The caller read cache.bytes under the same commit lock, so they plus this slot are the file now.
  // readHead still compares every byte it rereads, so a wrong guess costs only a parse.
  if (cache?.bytes?.length === SLOT_BYTES * 2) { const next = cache.bytes.slice(); next.set(slot, offset); cache.bytes = next; cache.head = head; }
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
  if (window && windowContains(window, ref)) {
    bytes = window.bytes!.subarray(ref.offset - window.offset!, ref.offset - window.offset! + ref.byteLength);
  } else {
    const length = window && ref.byteLength <= 65536 ? Math.min(65536, head.end - ref.offset) : ref.byteLength;
    const filename = generationFile(name, head.generation);
    const data = backend.read ? await backend.read(filename, ref.offset, length) :
      // Portable handles read the same bounded window, so a scan opens the file once per window, not per row.
      await withFile(backend, filename, { readOnly: true }, file => readExact(file, ref.offset, length));
    // Prefetch stays inside the pinned committed prefix. Large records bypass it
    // so the scan cannot retain a second record-sized allocation between pulls.
    if (window) { window.offset = ref.offset; window.bytes = length <= 65536 ? data : new Uint8Array(0); }
    bytes = data.subarray(0, ref.byteLength);
  }
  return decodeRef<T>(bytes, ref, maxRecordBytes);
}
/** Test the bounded committed window without allocating a Promise per cache hit. */
export function windowContains(window: ReadWindow, ref: Ref): boolean {
  return !!window.bytes && window.offset !== undefined && ref.offset >= window.offset && ref.offset + ref.byteLength <= window.offset + window.bytes.length;
}
/** Caller checked windowContains; validate limits and checksum even on a hit. */
export function readCachedValue<T>(head: Readonly<Head>, ref: Ref, maxRecordBytes: number, window: ReadWindow): T {
  reference(ref, head.end);
  if (ref.byteLength - 16 > maxRecordBytes) throw new DbsonlError('LIMIT_EXCEEDED', 'Referenced record exceeds the decoder budget.');
  return decodeRef<T>(window.bytes!.subarray(ref.offset - window.offset!, ref.offset - window.offset! + ref.byteLength), ref, maxRecordBytes);
}
/**
 * Decode entries[start, end), whose frames windowContains already found in the window, in one decoder call: that
 * validates the options and wraps the window once per run instead of once per frame. Returns no values when any frame
 * fails; the caller then reads that run frame by frame, so the error surfaces at its own row, after the rows before it.
 */
export function readCachedValues<T>(head: Readonly<Head>, entries: readonly { ref: Ref }[], start: number, end: number, maxRecordBytes: number, window: ReadWindow): T[] {
  try {
    const offsets: number[] = [];
    for (let i = start; i < end; i++) {
      const ref = entries[i]!.ref;
      reference(ref, head.end);
      if (ref.byteLength - 16 > maxRecordBytes) return [];
      // | 0 is exact (the window is at most 64 KiB) and hands the decoder an int32. An offset decoded from an index
      // page is a double in JavaScriptCore, which then left the reader's int32 code. VERIFIED: (probe, 2026-11-17,
      // Bun 1.4.3) without | 0, 503 type-speculation exits in its u32 reads and 2.7 instead of 1.9 µs per document.
      offsets.push((ref.offset - window.offset!) | 0);
    }
    const frames = decodeFrames(window.bytes!, offsets, { maxRecordBytes, maxDepth: 512, maxReferences: 1_000_000 }), values: T[] = [];
    // decodeFrames follows each frame's own header through the whole window, so only this check catches a reference
    // whose length differs from its frame; readCachedValue decodes a subarray of exactly the referenced length.
    for (let i = 0; i < frames.length; i++) { if (frames[i]!.byteLength !== entries[start + i]!.ref.byteLength) return []; values.push(frames[i]!.value as T); }
    return values;
  } catch { return []; }
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
  /** Synchronous unless the buffer must be written first; most frames only need a copy. */
  bytes(bytes: Uint8Array): Ref | Promise<Ref> {
    const ref = { offset: this.end, byteLength: bytes.length };
    natural(this.end + bytes.length, 'file end');
    if (bytes.length <= this.buffer.length - this.used) { this.buffer.set(bytes, this.used); this.used += bytes.length; this.end += bytes.length; return ref; }
    return this.spill(bytes, ref);
  }
  private async spill(bytes: Uint8Array, ref: Ref): Promise<Ref> {
    await this.flush();
    if (bytes.length > this.buffer.length) {
      await writeBytes(this.file, this.end, bytes, this.chunkSize); this.flushedEnd += bytes.length;
    } else { this.buffer.set(bytes, this.used); this.used += bytes.length; }
    this.end += bytes.length; return ref;
  }
  async value(value: unknown, page = false): Promise<Ref> {
    // Index pages are engine-built plain data with known property names; caller values keep encodeFrame's checks.
    return this.bytes(page ? encodePage(value as object, PAGE_BYTES) : encodeFrame(value, { maxRecordBytes: this.limits.maxRecordBytes }));
  }
  /** Committed pages only: the writer's own handle is exclusive, so it cannot reopen the file. */
  async read<T>(ref: Ref): Promise<T> {
    reference(ref, this.end);
    if (ref.byteLength - 16 > PAGE_BYTES) corrupt('Index page reference exceeds the page budget.');
    return decodeRef<T>(await readExact(this.file, ref.offset, ref.byteLength), ref, PAGE_BYTES);
  }
}
