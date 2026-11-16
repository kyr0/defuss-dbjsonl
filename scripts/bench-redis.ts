/** VERIFIED: Starts a throwaway, loopback-only Redis per durability mode and runs the matched comparison under Node and Bun. */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { arch, cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { createClient } from 'redis';

if (process.argv.length > 2) throw new Error('Usage: bun scripts/bench-redis.ts');
const rounds = 7, records = 1000;
// Fail fast: the pinned server comes from mise.toml, so a missing binary means `make setup` has not run.
const version = spawnSync('redis-server', ['--version'], { encoding: 'utf8' });
if (version.status !== 0) throw new Error('redis-server is not on PATH; run make setup, then mise exec -- make bench-redis.');
const free = () => new Promise<number>((done, fail) => {
  const probe = createServer(); probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as AddressInfo; probe.close(() => done(port)); });
});
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 900000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
  process.stdout.write(result.stdout);
}
await mkdir('output', { recursive: true }); await mkdir('tmp', { recursive: true });
// durable: every EXEC is appended and fsynced before Redis replies; volatile: no AOF and no RDB snapshots.
const modes = { durable: ['--appendonly', 'yes', '--appendfsync', 'always'], volatile: ['--appendonly', 'no'] };
const results: unknown[] = [];
for (const [mode, persistence] of Object.entries(modes)) {
  const directory = await mkdtemp(resolve('tmp/redis-server-'));
  const port = await free();
  const server = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--dir', directory, '--save', '', '--protected-mode', 'yes', '--logfile', resolve(directory, 'redis.log'), ...persistence], { stdio: 'ignore' });
  try {
    const client = createClient({ socket: { host: '127.0.0.1', port, reconnectStrategy: false } });
    for (let attempt = 0; ; attempt++) {
      try { await client.connect(); break; } catch (error) { if (attempt > 50) throw error; await new Promise(done => setTimeout(done, 100)); }
    }
    const config = await client.configGet(['appendonly', 'appendfsync', 'save', 'dir']);
    await client.quit();
    // The worker overwrites keys, so it must reach this throwaway server and never another Redis that took the port first.
    if (config.dir !== await realpath(directory)) throw new Error(`Port ${port} answers from ${config.dir}, not from ${directory}.`);
    for (const runtime of ['node', process.execPath]) {
      const output = `output/redis-${mode}-${runtime === 'node' ? 'node' : 'bun'}.json`;
      // --expose-gc lets the Node.js worker collect between engines; Bun exposes Bun.gc.
      run(runtime, [...(runtime === 'node' ? ['--expose-gc'] : []), 'scripts/redis-worker.ts', mode, String(port), output, String(rounds), String(records)]);
      results.push({ ...JSON.parse(await readFile(output, 'utf8')), redisConfig: config });
    }
  } finally {
    server.kill('SIGTERM'); if (server.exitCode === null) await once(server, 'exit');
    await rm(directory, { recursive: true, force: true });
  }
}
await writeFile('output/bench-redis.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  server: version.stdout.trim(),
  protocol: `Two warmup rounds, ${rounds} measured rounds, ${records} records of about 130 JSON bytes; the engine that runs first alternates per round, and each engine's turn starts after a full garbage collection. Redis runs on loopback TCP with the node-redis client; defuss-dbsonl runs in the measuring process. durable: native asynchronous file backend vs appendfsync always; volatile: memory backend vs no persistence. contended: 4 writers, each with its own Redis connection, retry until ${records} transfers commit.`,
  results,
}, null, 2) + '\n');
console.log(`${new Date().toISOString()} INFO redis comparison written path=output/bench-redis.json`);
