/** VERIFIED: The index-page writer produces the same frames as encodeFrame in trusted mode, or hands the page to it. */
import { test, expect } from 'vitest';
import { encodeFrame, decodeFrame } from 'defuss-dson/sequence';
import { encodePage } from '../src/core/page.js';
import { PAGE_BYTES } from '../src/core/io.js';

const reference = (page: unknown, maxRecordBytes = PAGE_BYTES) => encodeFrame(page, { maxRecordBytes, trusted: true });
function outcome(encode: () => Uint8Array): { bytes?: string; error?: string } {
  try { return { bytes: Buffer.from(encode()).toString('hex') }; }
  catch (error) { return { error: `${(error as Error).constructor.name}: ${(error as Error).message}` }; }
}

// Deterministic generator: a failure names its seed.
function random(seed: number) { return () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; }; }
// 'leaf' and 'branch' as keys share a node with the page kind; '\ud800' is a lone surrogate.
const KEYS = ['', 'a', 'k0001', 'leaf', 'branch', 'ä', '日本', '😀', '\ud800', 'x'.repeat(300)];
const NUMBERS = [0, -0, 1, 3, 160, 2 ** 40, 2 ** 53 - 1, NaN, 0.5];
function page(next: () => number): unknown {
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  const number = () => next() < 0.5 ? pick(NUMBERS) : Math.floor(next() * 5000);
  const ref = () => ({ offset: number(), byteLength: number() });
  const length = 1 + Math.floor(next() * 70); // past the 64 precomputed array indexes
  if (next() < 0.5) return { kind: 'leaf', entries: Array.from({ length }, () => ({ key: pick(KEYS) + Math.floor(next() * 50), ref: ref(), revision: number() })) };
  // Edited children are { max, count, ref }; bulk-loaded ones are { ref, max, count }; one page can hold both.
  return { kind: 'branch', children: Array.from({ length }, () => next() < 0.5 ? { max: pick(KEYS), count: number(), ref: ref() } : { ref: ref(), max: pick(KEYS), count: number() }) };
}

test('generated leaf and branch pages encode to the same bytes as encodeFrame and decode back', () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const input = page(random(seed));
    const bytes = encodePage(input as object, PAGE_BYTES);
    expect(Buffer.from(bytes).equals(Buffer.from(reference(input))), `seed ${seed}`).toBe(true);
    expect(decodeFrame(bytes, 0, { maxRecordBytes: PAGE_BYTES }).byteLength).toBe(bytes.length);
  }
});

test('other names, other value types and oversized pages go to encodeFrame', () => {
  const entry = { key: 'a', ref: { offset: 1, byteLength: 2 }, revision: 1 };
  for (const input of [
    { kind: 'leaf', entries: [entry], extra: 1 },
    { kind: 'leaf', entries: [{ ...entry, revision: null }] },
    { kind: 'leaf', entries: [{ ...entry, revision: true }] },
    { kind: 'leaf', entries: [{ ...entry, ref: undefined }] },
    { kind: 'leaf', entries: [1] },
  ]) expect(outcome(() => encodePage(input, PAGE_BYTES))).toEqual(outcome(() => reference(input)));
  // Engine-built pages never share an object; one that did gets a node per use and still decodes to an equal page.
  const shared = { kind: 'leaf', entries: [entry, { ...entry, key: 'b', ref: entry.ref }] };
  expect(decodeFrame(encodePage(shared, PAGE_BYTES), 0).value).toEqual(shared);
  const big = { kind: 'leaf', entries: [{ ...entry, key: 'x'.repeat(200) }] };
  expect(outcome(() => encodePage(big, 300))).toEqual(outcome(() => reference(big, 300)));
  expect(outcome(() => encodePage(big, 300)).error).toMatch(/maxRecordBytes/);
});
