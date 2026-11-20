/** VERIFIED: One process runs matched, asserted workloads on the current defuss-dbsonl build and on a loopback Redis, round by round. */
import { performance } from 'node:perf_hooks';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, WatchError } from 'redis';
import type { Dbsonl } from '../src/index.js';

type Value = { score: number; text: string };
const [mode = '', portText = '', output = '', roundsText = '7', sizeText = '1000', batchText = '5000'] = process.argv.slice(2);
const port = Number(portText), rounds = Number(roundsText), count = Number(sizeText), batchSize = Number(batchText);
if (!['durable', 'volatile'].includes(mode) || !Number.isSafeInteger(port) || !output || !Number.isSafeInteger(rounds) || rounds < 1 || !Number.isSafeInteger(count) || count < 2 || count > 10000 || !Number.isSafeInteger(batchSize) || batchSize < count || batchSize > 100000) {
  throw new Error('Usage: redis-worker.ts durable|volatile REDIS_PORT OUTPUT ROUNDS RECORDS(2..10000) BATCH(RECORDS..100000)');
}
// durable pairs a flushed file commit with Redis appendfsync always; volatile pairs memory storage with Redis without persistence.
const { openDbsonl, createMemoryBackend } = await import(pathToFileURL(resolve('dist/index.mjs')).href);
const { createFileBackend } = await import(pathToFileURL(resolve('dist/server.mjs')).href);
const writers = 4, perWriter = Math.floor(count / writers);
const keys = Array.from({ length: count }, (_, i) => `k${i}`);
const input = keys.map((key, score) => ({ operation: 'put' as const, key, value: { score, text: 'record '.repeat(16) } }));
const total = (count * (count - 1)) / 2;
// The batch rewrites the benchmark records, which resets their scores, plus filler records of score 0 that no other
// workload reads, so one commit carries batchSize writes and the score sum stays the same.
const batch = [...input, ...Array.from({ length: batchSize - count }, (_, i) => ({ operation: 'put' as const, key: `fill${i}`, value: { score: 0, text: 'record '.repeat(16) } }))];
const check = (value: Value | undefined, i: number) => { if (value?.score !== i || value.text !== input[i]!.value.text) throw new Error('Wrong benchmark value.'); };
const pair = (i: number) => { const a = (i * 7919) % count; return [keys[a]!, keys[(a + 1) % count]!] as const; };

await mkdir('tmp', { recursive: true }); await mkdir(resolve(output, '..'), { recursive: true });
const root = await mkdtemp(resolve('tmp/redis-bench-'));
const db: Dbsonl<Value> = await openDbsonl(mode === 'durable' ? await createFileBackend(root) : createMemoryBackend(), 'bench', { create: true });
// node-redis on both runtimes, not Bun's built-in client: one client implementation leaves the runtime as the only variable.
const connect = async () => { const client = createClient({ socket: { host: '127.0.0.1', port } }); await client.connect(); return client; };
const redis = await connect();
// WATCH belongs to a connection, so every concurrent Redis writer needs its own.
const writerClients = await Promise.all(Array.from({ length: writers }, connect));
const json = (text: string | null) => (text === null ? undefined : JSON.parse(text) as Value);

/** Each engine implements the same four workloads; transfers move one point of score between two keys. */
const engines = {
  dbsonl: {
    batch: async () => { await db.batch(batch); },
    get: async (i: number) => (await db.get(keys[i]!)).value as Value | undefined,
    transfer: async (_writer: number, from: string, to: string) => {
      await db.transaction(async tx => {
        const a = (await tx.get(from)).value!, b = (await tx.get(to)).value!;
        tx.put(from, { ...a, score: a.score - 1 }); tx.put(to, { ...b, score: b.score + 1 });
      });
    },
    conflict: (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    sum: async () => {
      const snapshot = await db.beginRead();
      try { let sum = 0; for await (const row of snapshot.scan()) sum += row.value.score; return sum; } finally { await snapshot.close(); }
    },
  },
  redis: {
    batch: async () => { const multi = redis.multi(); for (const { key, value } of batch) multi.set(key, JSON.stringify(value)); await multi.exec(); },
    get: async (i: number) => json(await redis.get(keys[i]!)),
    transfer: async (writer: number, from: string, to: string) => {
      const client = writer < 0 ? redis : writerClients[writer]!;
      await client.watch([from, to]);
      const a = json(await client.get(from))!, b = json(await client.get(to))!;
      await client.multi().set(from, JSON.stringify({ ...a, score: a.score - 1 })).set(to, JSON.stringify({ ...b, score: b.score + 1 })).exec();
    },
    conflict: (error: unknown) => error instanceof WatchError,
    sum: async () => { let sum = 0; for (const text of await redis.mGet(keys)) sum += json(text)!.score; return sum; },
  },
};
type Engine = keyof typeof engines;
const samples: Record<Engine, Record<string, number[]>> = { dbsonl: { batch: [], get: [], transaction: [], contended: [] }, redis: { batch: [], get: [], transaction: [], contended: [] } };
const retries: Record<Engine, number[]> = { dbsonl: [], redis: [] };
async function time(engine: Engine, label: string, round: number, work: () => Promise<void>) {
  const start = performance.now(); await work(); const elapsed = performance.now() - start;
  if (round >= 0) samples[engine][label]!.push(elapsed);
}
async function measure(name: Engine, round: number) {
  const engine = engines[name];
  await time(name, 'batch', round, engine.batch);
  await time(name, 'get', round, async () => { for (let i = 0; i < count; i++) { const n = (i * 7919) % count; check(await engine.get(n), n); } });
  // Sequential transfers never overlap, so a conflict here is a defect, not contention.
  await time(name, 'transaction', round, async () => { for (let i = 0; i < count; i++) await engine.transfer(-1, ...pair(i)); });
  let retried = 0;
  await time(name, 'contended', round, async () => {
    await Promise.all(Array.from({ length: writers }, async (_, writer) => {
      for (let done = 0; done < perWriter;) {
        try { await engine.transfer(writer, ...pair(writer * perWriter + done)); done++; }
        catch (error) { if (!engine.conflict(error)) throw error; retried++; }
      }
    }));
  });
  if (round >= 0) retries[name].push(retried);
  if (await engine.sum() !== total) throw new Error(`${name} lost or duplicated a transfer.`);
}
// Each engine's turn starts on a collected heap. Without this, one engine's garbage was collected inside the other's
// timed work: Redis batches under Bun took about 1 ms after Redis's own turn and 3.5 to 8 ms right after defuss-dbsonl's.
const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun, nodeGc = (globalThis as { gc?: () => void }).gc;
if (!bun && !nodeGc) throw new Error('Run the worker with --expose-gc under Node.js.');
const collect = () => { if (bun) bun.gc(true); else nodeGc!(); };
const load = [loadavg()];
try {
  // Two untimed warmup rounds; the engine that runs first alternates, so neither always meets the warmer machine.
  for (let round = -2; round < rounds; round++) {
    for (const name of (round % 2 === 0 ? ['dbsonl', 'redis'] : ['redis', 'dbsonl']) as Engine[]) { collect(); await measure(name, round); }
  }
  await db.verify();
  load.push(loadavg());
  const summary = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { medianMs: sorted[Math.floor(sorted.length / 2)]!, minMs: sorted[0]!, maxMs: sorted.at(-1)!, samplesMs: values }; };
  const report = (name: Engine) => ({ ...Object.fromEntries(Object.entries(samples[name]).map(([label, values]) => [label, summary(values)])), contendedRetries: retries[name] });
  const metrics = { dbsonl: report('dbsonl'), redis: report('redis') };
  const version = JSON.parse(await readFile('package.json', 'utf8')).version as string;
  const server = (await redis.info('server')).match(/redis_version:(\S+)/)?.[1];
  const runtime = typeof (globalThis as { Bun?: unknown }).Bun === 'undefined' ? `node ${process.versions.node}` : `bun ${process.versions.bun}`;
  await writeFile(output, JSON.stringify({ mode, runtime, dbsonl: version, redis: server, records: count, batchWrites: batchSize, writers, rounds, warmupRounds: 2, loadavg: load, generatedAt: new Date().toISOString(), metrics }, null, 2) + '\n');
  console.log(`${new Date().toISOString()} INFO redis comparison mode=${mode} runtime=${runtime} transaction_dbsonl_ms=${summary(samples.dbsonl.transaction!).medianMs.toFixed(1)} transaction_redis_ms=${summary(samples.redis.transaction!).medianMs.toFixed(1)}`);
} finally {
  await Promise.allSettled([redis, ...writerClients].map(client => client.quit()));
  await db.close(); await rm(root, { recursive: true, force: true });
}
