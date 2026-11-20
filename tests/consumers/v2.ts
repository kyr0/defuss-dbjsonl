/** Published-package tests: native multi-process contention, SIGKILL and snapshot reclamation. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { openDbsonl } from 'defuss-dbsonl';
import { createFileBackend } from 'defuss-dbsonl/server';
const root = await mkdtemp(resolve('native-v2-'));
function child(runtime: string, mode: string, id = '0', script = 'v2-worker.js') {
  const process = spawn(runtime, [script, root, mode, id], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  process.stdout.on('data', bytes => { stdout += String(bytes); if (/ready|pinned/.test(stdout)) ready(); });
  process.stderr.on('data', bytes => { stderr += String(bytes); });
  const done = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    process.once('error', reject); process.once('exit', (code, signal) => { if (code !== 0 && signal !== 'SIGKILL') reject(new Error(stderr)); else resolve({ code, signal }); });
  });
  return { process, done, started };
}
const children: ReturnType<typeof child>[] = [];
try {
  const created = child('node', 'create', '0', process.argv[3]!); children.push(created); await created.done;
  const backend = await createFileBackend(root); const db = await openDbsonl<number>(backend, 'multi');
  const modern = await openDbsonl<number>(backend, 'modern', { create: true }); await modern.put('a', 1); await modern.close();
  const refusal = child('node', 'refuse', '0', process.argv[3]!); children.push(refusal); await refusal.done;
  await db.put('counter', 0);
  const snapshot = await db.beginRead();
  const writers = ['node', process.argv[2]!].flatMap((runtime, id) => [child(runtime, 'increment', `new-${id}`), child(runtime, 'increment', `old-${id}`, process.argv[3]!)]);
  children.push(...writers); await Promise.all(writers.map(worker => worker.done));
  assert.equal((await db.get('counter')).value, 60); assert.equal((await snapshot.get('counter')).value, 0);
  await snapshot.close();
  const pinned = child('node', 'pin'); children.push(pinned); await pinned.started;
  await db.compact(); assert.equal((await db.collect()).retained.length, 1);
  pinned.process.kill('SIGKILL'); await pinned.done;
  assert.equal((await db.collect()).removed.length, 1);
  let killedProcesses = 1;
  for (let i = 0; i < 3; i++) {
    const crash = child(i % 2 ? process.argv[2]! : 'node', 'crash', String(i)); children.push(crash);
    await crash.started; await new Promise(resolve => setTimeout(resolve, [0, 15, 60][i]));
    crash.process.kill('SIGKILL'); if ((await crash.done).signal === 'SIGKILL') killedProcesses++;
    const view = await db.beginRead(); let count = 0;
    for await (const _row of view.scan({ gte: `crash-${i}-`, lt: `crash-${i}.` })) count++;
    assert.ok(count === 0 || count === 1000, `partial batch visible: ${count}`);
    await view.close(); await db.verify(); await db.put(`after-kill-${i}`, i);
  }
  await db.close();
  const reopened = await openDbsonl(await createFileBackend(root), 'multi');
  assert.equal((await reopened.stats()).cachePages, 0); await reopened.verify(); await reopened.close();
  console.log(JSON.stringify({ multiProcess: 'Node and Bun, v0.2 and current concurrently on a format 2 database; v0.2 refuses format 3', increments: 60, killedProcesses, atomicCrashBatches: 3, reopen: 'persistent index' }));
} finally { for (const worker of children) worker.process.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
