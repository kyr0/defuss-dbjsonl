/** VERIFIED: Times full snapshot scans of the current build, row by row and in batches, against the vendored 0.5.0 row scan. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, loadavg, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const records = 100000, rounds = 7;
// The same documents defuss-dataview's DBSONL benchmark stores: a short string, a number, an array and a Date.
const record = (i: number) => ({ title: `doc ${i}`, score: (i * 7919) % 1000, tags: ['a', 'b'], at: new Date(1_700_000_000_000 + i) });
type Doc = ReturnType<typeof record>;
type Snapshot = { scan(): AsyncIterable<{ value: Doc }>; scanBatches?(): AsyncIterable<readonly { value: Doc }[]>; close(): Promise<void> };
type Db = { batch(input: unknown[]): Promise<unknown>; beginRead(): Promise<Snapshot>; close(): Promise<void> };
type Build = { openDbsonl(backend: unknown, name: string, options: object): Promise<Db>; createMemoryBackend(): unknown; createFileBackend(root: string): Promise<unknown> };

async function load(directory: string): Promise<Build> {
  const index = await import(pathToFileURL(resolve(directory, 'dist/index.mjs')).href), server = await import(pathToFileURL(resolve(directory, 'dist/server.mjs')).href);
  return { ...index, createFileBackend: server.createFileBackend };
}

/** One process: both builds hold the same records; the three scans alternate order every round. */
async function worker(baseline: string, output: string): Promise<void> {
  const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun, nodeGc = (globalThis as { gc?: () => void }).gc;
  if (!bun && !nodeGc) throw new Error('Run the worker with --expose-gc under Node.js.');
  const collect = () => { if (bun) bun.gc(true); else nodeGc!(); };
  const builds = { '0.5.0': await load(baseline), current: await load(process.cwd()) };
  // The answer covers every decoded value, so a scan that skipped or mangled one cannot pass.
  const rows = async (db: Db) => { const s = await db.beginRead(); let n = 0, sum = 0; try { for await (const row of s.scan()) { n++; sum += row.value.score + row.value.at.getTime() % 2; } } finally { await s.close(); } return `${n}:${sum}`; };
  const batches = async (db: Db) => { const s = await db.beginRead(); let n = 0, sum = 0; try { for await (const batch of s.scanBatches!()) for (const row of batch) { n++; sum += row.value.score + row.value.at.getTime() % 2; } } finally { await s.close(); } return `${n}:${sum}`; };
  const root = await mkdtemp(resolve('tmp/bench-scan-'));
  const load0 = loadavg()[0]!, result: Record<string, Record<string, { medianMs: number; samplesMs: number[] }>> = {};
  try {
    for (const storage of ['memory', 'native'] as const) {
      const dbs: Record<string, Db> = {};
      for (const [label, build] of Object.entries(builds)) {
        const db = await build.openDbsonl(storage === 'memory' ? build.createMemoryBackend() : await build.createFileBackend(await mkdtemp(resolve(root, `${label}-`))), 'scan', { create: true });
        for (let start = 0; start < records; start += 5000) {
          await db.batch(Array.from({ length: 5000 }, (_, i) => ({ operation: 'put', key: `doc:${String(start + i).padStart(8, '0')}`, value: record(start + i) })));
        }
        dbs[label] = db;
      }
      const cases: [string, () => Promise<string>][] = [['0.5.0 scan', () => rows(dbs['0.5.0']!)], ['scan', () => rows(dbs.current!)], ['scanBatches', () => batches(dbs.current!)]];
      // Untimed warmup; every case must return the same answer.
      const answers = new Set<string>(); for (const [, run] of cases) answers.add(await run());
      if (answers.size !== 1) throw new Error(`Scans disagree: ${[...answers].join(' ')}`);
      const samples = cases.map(() => [] as number[]);
      for (let round = 0; round < rounds; round++) {
        const order = cases.map((_, i) => i); if (round % 2) order.reverse();
        for (const i of order) { collect(); const start = performance.now(); await cases[i]![1](); samples[i]!.push(performance.now() - start); }
      }
      result[storage] = Object.fromEntries(cases.map(([label], i) => [label, { medianMs: [...samples[i]!].sort((a, b) => a - b)[rounds >> 1]!, samplesMs: samples[i]! }]));
      for (const db of Object.values(dbs)) await db.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  const runtime = bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
  await writeFile(output, JSON.stringify({ runtime, records, rounds, loadavg: [load0, loadavg()[0]], result }, null, 2) + '\n');
  console.log(`${new Date().toISOString()} INFO scan benchmark runtime=${runtime} memory_batches_ms=${result.memory!.scanBatches!.medianMs.toFixed(1)} native_batches_ms=${result.native!.scanBatches!.medianMs.toFixed(1)}`);
}

if (process.argv[2] === '--worker') {
  await worker(process.argv[3]!, process.argv[4]!);
} else {
  if (process.argv.length > 2) throw new Error('Usage: bun scripts/bench-scan.ts');
  const run = (command: string, args: string[], cwd = process.cwd()) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 900000 });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
    process.stdout.write(result.stdout);
  };
  await mkdir('output', { recursive: true }); await mkdir('tmp', { recursive: true });
  // The published 0.5.0 tarball, vendored and checksum-pinned, so every run measures the same baseline bytes.
  const tarball = 'vendor/defuss-dbsonl-0.5.0.tgz';
  if (createHash('sha256').update(await readFile(tarball)).digest('hex') !== 'd7de80813dbcaefac8f6e2df6e92f1f270ea89a87224216fa8d03b79ed2f58c7') throw new Error(`Benchmark baseline checksum mismatch: ${tarball}.`);
  const directory = resolve('tmp/bench-v050'); await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: 'dbsonl-bench-v050', private: true, type: 'module', dependencies: { 'defuss-dbsonl': resolve(tarball) } }));
  run(process.execPath, ['install', '--ignore-scripts'], directory);
  const baseline = resolve(directory, 'node_modules/defuss-dbsonl'), reports = [];
  for (const runtime of ['node', process.execPath]) {
    const output = `output/bench-scan-${runtime === 'node' ? 'node' : 'bun'}.json`;
    run(runtime, [...(runtime === 'node' ? ['--expose-gc'] : []), 'scripts/bench-scan.ts', '--worker', baseline, output]);
    reports.push(JSON.parse(await readFile(output, 'utf8')));
  }
  await writeFile('output/bench-scan.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    protocol: `${records} documents of four fields, written in batches of 5000. One untimed warmup that checks every scan returns the same count and checksum, then ${rounds} rounds alternating the order of the three scans, each after a full garbage collection. memory: memory backend; native: native asynchronous file backend.`,
    reports,
  }, null, 2) + '\n');
  console.log(`${new Date().toISOString()} INFO scan benchmark written path=output/bench-scan.json`);
}
