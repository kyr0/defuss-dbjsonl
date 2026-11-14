/** VERIFIED: Compare published v0.2 and current builds using identical, asserted workloads. */
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
const baseline = resolve('tmp/bench-v020'); await mkdir(baseline, { recursive: true });
const tarball = resolve('vendor/defuss-dbsonl-0.2.0.tgz');
if (createHash('sha256').update(await readFile(tarball)).digest('hex') !== '90eaf0e5e6c78cc636f6fb9273cc0475a1e2220180ecd569f97bac7ad0a3fe1b') throw new Error('Benchmark baseline checksum mismatch.');
await writeFile(resolve(baseline, 'package.json'), JSON.stringify({ name: 'dbsonl-bench-v020', private: true, type: 'module', dependencies: { 'defuss-dbsonl': tarball } }));
run(bun, ['install', '--ignore-scripts'], baseline);
const results: unknown[] = [];
for (const runtime of ['node', bun]) {
  for (const io of scale ? ['async'] : ['async', 'sync', 'memory']) {
    const versions = runtime === 'node' ? ['baseline', 'current'] : ['current', 'baseline'];
    for (const version of versions) {
      const directory = version === 'baseline' ? resolve(baseline, 'node_modules/defuss-dbsonl') : process.cwd();
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
