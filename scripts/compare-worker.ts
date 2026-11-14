/** VERIFIED: Run the same asserted workload against an explicitly selected built package. */
import { performance } from 'node:perf_hooks';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Backend, Dbsonl } from '../src/index.js';

const [directory = '.', output = 'output/comparison-run.json', io = 'async', roundsText = '7', sizeText = '1000'] = process.argv.slice(2);
const rounds = Number(roundsText), count = Number(sizeText);
if (!Number.isSafeInteger(rounds) || rounds < 1 || !Number.isSafeInteger(count) || count < 1 || count > 10000 || !['async', 'sync', 'memory'].includes(io)) throw new Error('Usage: compare-worker.ts PACKAGE OUTPUT async|sync|memory ROUNDS RECORDS(1..10000)');
const { openDbsonl, createMemoryBackend } = await import(pathToFileURL(resolve(directory, 'dist/index.mjs')).href);
// The 0.2.0 baseline ships its native entry as dist/node.mjs; 0.4.0 renamed it to dist/server.mjs.
const native = existsSync(resolve(directory, 'dist/server.mjs')) ? 'dist/server.mjs' : 'dist/node.mjs';
const { createFileBackend } = await import(pathToFileURL(resolve(directory, native)).href);
const version = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')).version;
const artifacts: Record<string, string> = {};
for (const path of (await readdir(resolve(directory, 'dist'), { recursive: true })).filter(path => path.endsWith('.mjs')).sort()) {
  artifacts[`dist/${path}`] = createHash('sha256').update(await readFile(resolve(directory, 'dist', path))).digest('hex');
}
await mkdir('tmp', { recursive: true }); await mkdir(resolve(output, '..'), { recursive: true });
const root = await mkdtemp(resolve('tmp/compare-'));
const results: Record<string, number[]> = { get: [], snapshotGet: [], scan: [], batch: [], reopen: [], compact: [] };
const keys = Array.from({ length: count }, (_, i) => `k${i}`);
const input = keys.map((key, score) => ({ operation: 'put' as const, key, value: { score, text: 'record '.repeat(16) } }));
const backend: Backend = io === 'memory' ? createMemoryBackend() : await createFileBackend(root, { io });
let db: Dbsonl<{ score: number; text: string }> = await openDbsonl(backend, 'bench', { create: true });
const check = (value: { score: number; text: string } | undefined, i: number) => { if (value?.score !== i || value.text !== input[i]!.value.text) throw new Error('Wrong benchmark value.'); };
async function time(label: string, round: number, fn: () => Promise<void>) {
  const start = performance.now(); await fn(); const elapsed = performance.now() - start;
  if (round >= 0) results[label]!.push(elapsed);
}
try {
  // Two complete untimed rounds warm both JITs and every measured read path equally.
  for (let round = -2; round < rounds; round++) {
    await time('batch', round, async () => { await db.batch(input); });
    await time('get', round, async () => { for (let i = 0; i < count; i++) { const n = (i * 7919) % count; check((await db.get(keys[n]!)).value, n); } });
    const snapshot = await db.beginRead();
    try {
      await time('snapshotGet', round, async () => { for (let i = 0; i < count; i++) { const n = (i * 7919) % count; check((await snapshot.get(keys[n]!)).value, n); } });
      await time('scan', round, async () => { let rows = 0; for await (const row of snapshot.scan()) { check(row.value, Number(row.key.slice(1))); rows++; } if (rows !== count) throw new Error('Wrong scan count.'); });
    } finally { await snapshot.close(); }
    await time('compact', round, async () => { await db.compact(); }); await db.collect();
    await db.close();
    await time('reopen', round, async () => { db = await openDbsonl(backend, 'bench'); });
  }
  await db.verify();
  const metrics = Object.fromEntries(Object.entries(results).map(([key, samples]) => { const sorted = [...samples].sort((a, b) => a - b); return [key, { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: samples }]; }));
  await writeFile(output, JSON.stringify({ version, artifacts, runtime: process.versions, io, records: count, rounds, warmupRounds: 2, generatedAt: new Date().toISOString(), metrics }, null, 2) + '\n');
  console.log(JSON.stringify({ version, io, records: count, metrics }));
} finally { await db.close(); await rm(root, { recursive: true, force: true }); }
