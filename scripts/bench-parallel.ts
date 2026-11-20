/** VERIFIED: Times a full native snapshot scan in one thread against split() ranges scanned by worker threads. */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, availableParallelism, cpus, loadavg, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const records = 100000, rounds = 7, pools = [1, 2, 4, 8];
// default: every handle's own 1024-page cache, which a full scan of these records overflows but an eighth of it does
// not; whole index: a cache that holds every page on every handle, so the figures show parallel decoding alone.
const caches = { default: {}, 'whole index': { maxCachePages: 16384, maxCacheBytes: 256 * 1024 * 1024 } } as const;
// async: reads go through the process's libuv thread pool, which Node worker threads share; sync: each thread blocks itself.
const modes = ['async', 'sync'] as const;
// The documents of make bench-scan, which are defuss-dataview's DBSONL benchmark documents.
const record = (i: number) => ({ title: `doc ${i}`, score: (i * 7919) % 1000, tags: ['a', 'b'], at: new Date(1_700_000_000_000 + i) });
type Doc = ReturnType<typeof record>;
type Range = { gte?: string; lt?: string; count: number };
type Snapshot = { head: object; split(parts: number): Promise<Range[]>; scanBatches(options?: object): AsyncIterable<readonly { value: Doc }[]>; close(): Promise<void> };
type Db = { batch(input: unknown[]): Promise<unknown>; beginRead(options?: { at?: object }): Promise<Snapshot>; close(): Promise<void> };
type Build = { openDbsonl(backend: unknown, name: string, options: object): Promise<Db>; createFileBackend(root: string, options?: { io?: string; scanWorkers?: number }): Promise<unknown> };
type Answer = { n: number; sum: number };

async function load(): Promise<Build> {
  const index = await import(pathToFileURL(resolve('dist/index.mjs')).href), server = await import(pathToFileURL(resolve('dist/server.mjs')).href);
  return { ...index, createFileBackend: server.createFileBackend };
}
// The answer covers every decoded value, so a scan that skipped, repeated or mangled one cannot pass.
async function scan(session: Snapshot, range: object = {}): Promise<Answer> {
  let n = 0, sum = 0;
  for await (const batch of session.scanBatches(range)) for (const row of batch) { n++; sum += row.value.score + row.value.at.getTime() % 2; }
  return { n, sum };
}

/** A pool thread: its own native backend and handle, pinned per request to the head it is sent. */
async function thread(root: string, io: string, options: object): Promise<void> {
  const build = await load(), db = await build.openDbsonl(await build.createFileBackend(root, { io, scanWorkers: 0 }), 'scan', options);
  parentPort!.on('message', async ({ head, range }: { head: object; range: Range }) => {
    const session = await db.beginRead({ at: head });
    try { parentPort!.postMessage(await scan(session, range)); } finally { await session.close(); }
  });
  parentPort!.postMessage('ready');
}

/** One runtime process: one database, one warm pool per size, the cases alternating order every round. */
async function measure(output: string): Promise<void> {
  const result: Record<string, Record<string, { medianMs: number; samplesMs: number[] }>> = {}, load0 = loadavg()[0]!;
  for (const io of modes) for (const [label, options] of Object.entries(caches)) result[`${io} io, ${label} cache`] = await measureCache(io, options);
  const runtime = (globalThis as { Bun?: unknown }).Bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
  await writeFile(output, JSON.stringify({ runtime, records, rounds, loadavg: [load0, loadavg()[0]], caches, modes, result }, null, 2) + '\n');
  for (const [cache, cases] of Object.entries(result)) console.log(`${new Date().toISOString()} INFO parallel scan benchmark runtime=${runtime} config="${cache}" ${Object.entries(cases).map(([label, { medianMs }]) => `${label.replace(' ', '_')}_ms=${medianMs.toFixed(1)}`).join(' ')}`);
}
async function measureCache(io: string, options: object): Promise<Record<string, { medianMs: number; samplesMs: number[] }>> {
  const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun, nodeGc = (globalThis as { gc?: () => void }).gc;
  if (!bun && !nodeGc) throw new Error('Run with --expose-gc under Node.js.');
  const collect = () => { if (bun) bun.gc(true); else nodeGc!(); };
  const build = await load(), root = await mkdtemp(resolve('tmp/bench-parallel-'));
  const threads: Worker[] = [];
  try {
    const db = await build.openDbsonl(await build.createFileBackend(root, { io, scanWorkers: 0 }), 'scan', { ...options, create: true });
    // The default backend: scanBatches() on the main thread with the built-in pool, its rows returned to this thread.
    const auto = await build.openDbsonl(await build.createFileBackend(root, { io }), 'scan', options);
    for (let start = 0; start < records; start += 5000) {
      await db.batch(Array.from({ length: 5000 }, (_, i) => ({ operation: 'put', key: `doc:${String(start + i).padStart(8, '0')}`, value: record(start + i) })));
    }
    const pool = async (size: number) => {
      const members = await Promise.all(Array.from({ length: size }, () => new Promise<Worker>((ready, fail) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { root, io, options } });
        threads.push(worker); worker.once('error', fail); worker.once('message', () => ready(worker));
      })));
      return async (): Promise<Answer> => {
        const session = await db.beginRead();
        try {
          const ranges = await session.split(size);
          const answers = await Promise.all(ranges.map((range, i) => new Promise<Answer>(done => { members[i]!.once('message', done); members[i]!.postMessage({ head: session.head, range }); })));
          return answers.reduce((total, answer) => ({ n: total.n + answer.n, sum: total.sum + answer.sum }), { n: 0, sum: 0 });
        } finally { await session.close(); }
      };
    };
    const cases: [string, () => Promise<Answer>][] = [['one thread', async () => { const session = await db.beginRead(); try { return await scan(session); } finally { await session.close(); } }]];
    cases.push(['scanBatches, default pool', async () => { const session = await auto.beginRead(); try { return await scan(session); } finally { await session.close(); } }]);
    for (const size of pools) cases.push([`${size} workers`, await pool(size)]);
    // Untimed warmup; every case must return the same answer.
    const answers = new Set<string>(); for (const [, run] of cases) { const answer = await run(); answers.add(`${answer.n}:${answer.sum}`); }
    if (answers.size !== 1 || !answers.has(`${records}:${[...answers][0]!.split(':')[1]}`)) throw new Error(`Scans disagree: ${[...answers].join(' ')}`);
    const samples = cases.map(() => [] as number[]);
    for (let round = 0; round < rounds; round++) {
      const order = cases.map((_, i) => i); if (round % 2) order.reverse();
      for (const i of order) { collect(); const start = performance.now(); await cases[i]![1](); samples[i]!.push(performance.now() - start); }
    }
    await db.close(); await auto.close();
    return Object.fromEntries(cases.map(([label], i) => [label, { medianMs: [...samples[i]!].sort((a, b) => a - b)[rounds >> 1]!, samplesMs: samples[i]! }]));
  } finally { await Promise.all(threads.map(worker => worker.terminate())); await rm(root, { recursive: true, force: true }); }
}

if (!isMainThread) { const { root, io, options } = workerData as { root: string; io: string; options: object }; await thread(root, io, options); }
else if (process.argv[2] === '--runtime') await measure(process.argv[3]!);
else {
  if (process.argv.length > 2) throw new Error('Usage: bun scripts/bench-parallel.ts');
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 900000 });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
    process.stdout.write(result.stdout);
  };
  await mkdir('output', { recursive: true }); await mkdir('tmp', { recursive: true });
  const reports = [];
  for (const runtime of ['node', process.execPath]) {
    const output = `output/bench-parallel-${runtime === 'node' ? 'node' : 'bun'}.json`;
    run(runtime, [...(runtime === 'node' ? ['--expose-gc'] : []), 'scripts/bench-parallel.ts', '--runtime', output]);
    reports.push(JSON.parse(await readFile(output, 'utf8')));
  }
  await writeFile('output/bench-parallel.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, availableParallelism: availableParallelism() },
    protocol: `Each I/O mode and cache setting applies to every handle. ${records} documents of four fields on the native file backend, written in batches of 5000. One thread: scanBatches on a handle with scanWorkers 0. Default pool: scanBatches on a default backend, whose built-in pool of up to 4 workers scans and sends every row back to the calling thread. N workers: a warm pool of worker threads with a handle each; a round pins a snapshot, splits it into N ranges, sends each worker the head and one range, and ends when every worker has scanned its range and closed its pin. One untimed warmup that checks every case returns the same count and checksum, then ${rounds} rounds alternating the order of the cases, each after a full garbage collection on the main thread.`,
    reports,
  }, null, 2) + '\n');
  console.log(`${new Date().toISOString()} INFO parallel scan benchmark written path=output/bench-parallel.json`);
}
