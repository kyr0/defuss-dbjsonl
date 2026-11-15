/** VERIFIED: Compare the vendored v0.2.0 and v0.3.0 builds with the current build using identical, asserted workloads. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cpus, platform, release, arch } from 'node:os';
import { createHash } from 'node:crypto';

const bun = process.execPath;
const scale = process.argv.includes('--scale');
if (process.argv.slice(2).some(value => value !== '--scale')) throw new Error('Usage: bun scripts/bench.ts [--scale]');
const records = scale ? 10000 : 1000, rounds = scale ? 3 : 7;
function run(command: string, args: string[], cwd = process.cwd()): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300000 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
await mkdir('output', { recursive: true });
// Both earlier builds are vendored and checksum-pinned, so every run measures the same bytes.
const baselines = [
  { label: 'v020', tarball: 'vendor/defuss-dbsonl-0.2.0.tgz', sha256: '90eaf0e5e6c78cc636f6fb9273cc0475a1e2220180ecd569f97bac7ad0a3fe1b' },
  { label: 'v030', tarball: 'vendor/defuss-dbsonl-0.3.0.tgz', sha256: '264209b1774450d4b267483539d1d48dda9d4d808f09d94c7ac4412e57bbbc50' },
];
const packages: Record<string, string> = { current: process.cwd() };
for (const { label, tarball, sha256 } of baselines) {
  if (createHash('sha256').update(await readFile(tarball)).digest('hex') !== sha256) throw new Error(`Benchmark baseline checksum mismatch: ${tarball}.`);
  const directory = resolve(`tmp/bench-${label}`); await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: `dbsonl-bench-${label}`, private: true, type: 'module', dependencies: { 'defuss-dbsonl': resolve(tarball) } }));
  run(bun, ['install', '--ignore-scripts'], directory);
  packages[label] = resolve(directory, 'node_modules/defuss-dbsonl');
}
const results: unknown[] = [];
for (const runtime of ['node', bun]) {
  for (const io of scale ? ['async'] : ['async', 'sync', 'memory']) {
    // Version order reverses between runtimes, so warm caches and thermal drift do not always favor the same build.
    const versions = runtime === 'node' ? ['v020', 'v030', 'current'] : ['current', 'v030', 'v020'];
    for (const version of versions) {
      const directory = packages[version]!;
      const output = `output/${scale ? 'scale-' : ''}perf-${runtime === 'node' ? 'node' : 'bun'}-${io}-${version}.json`;
      run(runtime, ['scripts/compare-worker.ts', directory, output, io, String(rounds), String(records)]);
      const result = JSON.parse(await readFile(output, 'utf8')); results.push(result);
      console.log(`${new Date().toISOString()} INFO benchmark runtime=${runtime === 'node' ? 'node' : 'bun'} version=${result.version} io=${io} get_ms=${result.metrics.get.medianMs.toFixed(2)}`);
    }
  }
  run(runtime, ['scripts/microbench.ts']);
}
const microbench = await Promise.all(['node', 'bun'].map(async runtime => JSON.parse(await readFile(`output/microbench-${runtime}.json`, 'utf8'))));
await writeFile(scale ? 'output/bench-scale.json' : 'output/bench.json', JSON.stringify({ generatedAt: new Date().toISOString(), host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length }, protocol: `Two complete warmup rounds, ${rounds} measured rounds; isolated child per version/runtime/mode. Same values, randomized lookups, atomic batches, fsync barriers, assertions, compaction and reopen. Runtime order reverses version order. No timing assertion in correctness gates.`, units: `milliseconds per workload; ${records} reads, scan rows or atomic batch mutations`, limitations: `One ${platform()} ${arch()} host and warm filesystem cache. Not cold-device latency, power-loss certification, or a universal speed ranking. sync mode blocks its calling thread.`, results, microbench }, null, 2) + '\n');
