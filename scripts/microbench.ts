/** VERIFIED: Compare equality kernels with consumed results and exact correctness checks. */
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
const bytewise = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const words = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  if ((a.byteOffset | b.byteOffset | a.length) & 3) return bytewise(a, b);
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length / 4), y = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};
const unrolled = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  if ((a.byteOffset | b.byteOffset | a.length) & 3) return bytewise(a, b);
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length / 4), y = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
  let i = 0;
  for (; i + 3 < x.length; i += 4) if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2] || x[i + 3] !== y[i + 3]) return false;
  for (; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};
const kernels = { bytewise, words, unrolled };
for (const fn of Object.values(kernels)) for (let length = 0; length < 66; length++) for (const offset of [0, 1]) {
  const a = new Uint8Array(length + offset).subarray(offset), b = a.slice();
  assert.equal(fn(a, b), true); assert.equal(fn(a, new Uint8Array(length + 1)), false);
  for (let i = 0; i < length; i++) { b[i] = 1; assert.equal(fn(a, b), false); b[i] = 0; }
}
const a = new Uint8Array(8192), b = a.slice();
let consumed = 0;
const results: Record<string, number[]> = Object.fromEntries(Object.keys(kernels).map(name => [name, []]));
// Alternate execution order to reduce order bias; change bytes between rounds.
for (let round = -2; round < 7; round++) {
  a[round + 2] = 1; b.set(a);
  const order = Object.entries(kernels); if (round % 2) order.reverse();
  for (const [name, fn] of order) {
    const start = performance.now(); for (let i = 0; i < 20000; i++) consumed += Number(fn(a, b));
    if (round >= 0) results[name]!.push(performance.now() - start);
  }
}
assert.equal(consumed, 9 * 3 * 20000);
await mkdir('output', { recursive: true });
const report = { runtime: process.versions, iterations: 20000, bytes: a.length, results };
await writeFile(`output/microbench-${process.versions.bun ? 'bun' : 'node'}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(results));
