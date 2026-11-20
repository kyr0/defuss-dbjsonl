/** VERIFIED: Worker threads scan key ranges of one pinned snapshot for scanBatches and return them in key order. */
import type { Worker } from 'node:worker_threads';
import { DbsonlError } from './core/common.js';
import type { ErrorCode } from './core/common.js';
import { batchBytes } from './core/store.js';
import type { Dbsonl } from './core/store.js';
import type { Head, ParallelScan, ParallelScanner, ParallelScanRequest, Row, ScanLimits } from './core/types.js';

/** Frame bytes a worker may have sent for one scan before the consumer takes them. */
const CREDIT_BYTES = 8 * 1024 * 1024;
/** Batches travel in messages of about this size: one structured clone per message, not per batch. */
const MESSAGE_BYTES = 1024 * 1024, MESSAGE_ROWS = 4096;
/** An idle pool closes its workers after this long and starts them again on the next large scan. */
const IDLE_MS = 30_000;
const CODES = new Set<string>(['CLOSED', 'CORRUPT', 'UNSUPPORTED', 'CONFLICT', 'ABORTED', 'QUEUE_FULL', 'LIMIT_EXCEEDED', 'COMMIT_UNCERTAIN']);

type Range = { gte?: string; lt?: string };
type Task = { type: 'task'; scan: number; task: number; name: string; head: Head; range: Range; batchSize: number; maxBatchBytes: number; limits: ScanLimits };
type ToWorker = Task | { type: 'ack'; scan: number; bytes: number } | { type: 'cancel'; scan: number } | { type: 'exit' };
type FromWorker =
  | { type: 'ready' } | { type: 'closed' } | { type: 'cancelled'; scan: number }
  | { type: 'rows'; scan: number; task: number; batches: Row<unknown>[][]; bytes: number }
  | { type: 'done'; scan: number; task: number }
  | { type: 'error'; scan: number; task: number; code?: string | undefined; message: string };
/** The parent port of a worker thread, or one end of a MessageChannel. */
export interface Port { on(event: 'message', listener: (message: ToWorker) => void): unknown; postMessage(message: FromWorker): void }

/** Rebuild an error that crossed the thread boundary with its code, so callers branch on it as on a local error. */
function received(message: { code?: string | undefined; message: string }): Error {
  if (message.code && CODES.has(message.code)) return new DbsonlError(message.code as ErrorCode, message.message);
  return Object.assign(new Error(message.message), message.code ? { code: message.code } : {});
}

/**
 * The worker side: one handle per database name and budget, one pinned session per task. A task stops sending once
 * CREDIT_BYTES of its scan are unconsumed, so a consumer that pauses holds the workers back instead of filling memory.
 */
export function serveScans(port: Port, open: (name: string, limits: ScanLimits) => Promise<Dbsonl<unknown>>): void {
  const scans = new Map<number, { outstanding: number; cancelled: boolean; wake?: () => void; running?: Promise<void> }>();
  const handles = new Map<string, Promise<Dbsonl<unknown>>>();
  const handle = (name: string, limits: ScanLimits) => {
    const id = `${name}:${limits.maxRecordBytes}:${limits.maxCacheBytes}:${limits.maxCachePages}`;
    let db = handles.get(id);
    if (!db) { db = open(name, limits); handles.set(id, db); db.catch(() => handles.delete(id)); }
    return db;
  };
  const state = (scan: number) => { let s = scans.get(scan); if (!s) { s = { outstanding: 0, cancelled: false }; scans.set(scan, s); } return s; };
  async function run(task: Task): Promise<void> {
    const s = state(task.scan);
    let batches: Row<unknown>[][] = [], rows = 0, bytes = 0;
    const flush = async () => {
      if (!batches.length || s.cancelled) return;
      port.postMessage({ type: 'rows', scan: task.scan, task: task.task, batches, bytes });
      s.outstanding += bytes; batches = []; rows = 0; bytes = 0;
      while (s.outstanding > CREDIT_BYTES && !s.cancelled) await new Promise<void>(resolve => { s.wake = resolve; });
    };
    try {
      const session = await (await handle(task.name, task.limits)).beginRead({ at: task.head });
      try {
        for await (const batch of session.scanBatches({ ...task.range, batchSize: task.batchSize, maxBatchBytes: task.maxBatchBytes })) {
          if (s.cancelled) return;
          batches.push(batch as Row<unknown>[]); rows += batch.length; bytes += batchBytes.get(batch) ?? 0;
          if (rows >= MESSAGE_ROWS || bytes >= MESSAGE_BYTES) await flush();
        }
        await flush();
      } finally { await session.close(); }
      if (!s.cancelled) port.postMessage({ type: 'done', scan: task.scan, task: task.task });
    } catch (error) {
      // Batches completed before the failure arrive first, so the error surfaces at the same row as in one thread.
      await flush();
      if (!s.cancelled) port.postMessage({ type: 'error', scan: task.scan, task: task.task, code: (error as { code?: string }).code, message: (error as Error).message ?? String(error) });
    }
  }
  port.on('message', message => {
    if (message.type === 'task') {
      const s = state(message.scan), previous = s.running;
      s.running = (async () => { await previous; await run(message); })();
    } else if (message.type === 'ack') {
      const s = scans.get(message.scan); if (s) { s.outstanding -= message.bytes; s.wake?.(); }
    } else if (message.type === 'cancel') {
      const s = state(message.scan); s.cancelled = true; s.wake?.();
      // Reply once this scan's sessions are closed, so the caller's close() returns with every worker pin released.
      void (async () => { await s.running; scans.delete(message.scan); port.postMessage({ type: 'cancelled', scan: message.scan }); })();
    } else if (message.type === 'exit') {
      void (async () => {
        await Promise.allSettled([...scans.values()].map(s => s.running));
        await Promise.allSettled([...handles.values()].map(async db => (await db).close()));
        port.postMessage({ type: 'closed' });
      })();
    }
  });
}

export interface ScanPoolOptions { workers: number; threshold: number; spawn(): Worker }

/**
 * The calling side. Workers start on the first large scan and close after IDLE_MS without one; while no scan runs
 * they are unreferenced, so they never keep a process alive. A pool whose workers cannot start, for example because
 * a bundler left scan-worker.mjs behind, stays disabled and every scan runs in the calling thread.
 */
export function createScanPool(options: ScanPoolOptions): ParallelScanner {
  let lanes: Worker[] | undefined, starting: Promise<Worker[] | undefined> | undefined, failed = false;
  let nextScan = 1, active = 0, served = 0, idle: ReturnType<typeof setTimeout> | undefined;
  const routes = new Map<number, (message: FromWorker, lane: number) => void>();
  const waiters = new Map<number, Map<number, () => void>>();
  const stop = async (workers: Worker[]) => {
    await Promise.all(workers.map(worker => new Promise<void>(done => {
      const timer = setTimeout(done, 2000); timer.unref?.();
      worker.on('message', (message: FromWorker) => { if (message.type === 'closed') { clearTimeout(timer); done(); } });
      worker.postMessage({ type: 'exit' } satisfies ToWorker);
    })));
    await Promise.all(workers.map(worker => worker.terminate()));
  };
  const start = () => starting ??= (async () => {
    const spawned: Worker[] = [];
    try {
      for (let i = 0; i < options.workers; i++) spawned.push(options.spawn());
      await Promise.all(spawned.map(worker => new Promise<void>((ready, fail) => {
        // Remove only these listeners: removeAllListeners() also drops the ones Node's Worker needs to deliver messages.
        const settle = (error?: Error) => { worker.off('error', failed); worker.off('exit', exited); worker.off('message', started); if (error) fail(error); else ready(); };
        const failed = (error: Error) => settle(error), exited = (code: number) => settle(new Error(`Scan worker exited with code ${code}.`));
        const started = (message: FromWorker) => settle(message.type === 'ready' ? undefined : new Error('Scan worker did not start.'));
        worker.on('error', failed); worker.on('exit', exited); worker.on('message', started);
      })));
    } catch {
      failed = true; await Promise.allSettled(spawned.map(worker => worker.terminate())); return undefined;
    }
    spawned.forEach((worker, lane) => {
      worker.on('message', (message: FromWorker) => {
        if (message.type === 'cancelled') { waiters.get(message.scan)?.get(lane)?.(); return; }
        if ('scan' in message) routes.get(message.scan)?.(message, lane);
      });
      // A worker that dies mid-scan fails every scan in flight; the next large scan starts a fresh pool.
      worker.on('exit', () => {
        if (lanes !== spawned) return;
        lanes = undefined; starting = undefined;
        for (const [scan, route] of routes) route({ type: 'error', scan, task: -1, message: 'A scan worker exited.' }, lane);
        for (const lanesOf of waiters.values()) for (const done of lanesOf.values()) done();
        void Promise.allSettled(spawned.filter(other => other !== worker).map(other => other.terminate()));
      });
      worker.unref();
    });
    lanes = spawned; return spawned;
  })();
  const pool: ParallelScanner = {
    workers: options.workers, threshold: options.threshold,
    get scans() { return served; },
    async scan<T>(request: ParallelScanRequest): Promise<ParallelScan<T> | undefined> {
      if (failed || !options.workers) return undefined;
      const workers = lanes ?? await start();
      if (!workers) return undefined;
      served++;
      if (active++ === 0) { clearTimeout(idle); for (const worker of workers) worker.ref(); }
      const id = nextScan++, count = request.ranges.length, window = workers.length * 2;
      const tasks = request.ranges.map(() => ({ queue: [] as { batches: Row<unknown>[][]; bytes: number; lane: number }[], done: false, error: undefined as Error | undefined }));
      const busy = workers.map(() => false), used = new Set<number>();
      let current = 0, dispatched = 0, taken = 0, closed = false, wake: (() => void) | undefined, failure: Error | undefined;
      const dispatch = () => {
        for (let lane = 0; lane < workers.length && dispatched < count && dispatched < current + window; lane++) {
          if (busy[lane]) continue;
          busy[lane] = true; used.add(lane);
          workers[lane]!.postMessage({ type: 'task', scan: id, task: dispatched, name: request.name, head: request.head as Head, range: request.ranges[dispatched]!, batchSize: request.batchSize, maxBatchBytes: request.maxBatchBytes, limits: request.limits } satisfies ToWorker);
          dispatched++;
        }
      };
      routes.set(id, (message, lane) => {
        if (message.type === 'rows') tasks[message.task]!.queue.push({ batches: message.batches, bytes: message.bytes, lane });
        else if (message.type === 'done') { tasks[message.task]!.done = true; busy[lane] = false; dispatch(); }
        else if (message.type === 'error') {
          if (message.task < 0) failure = received(message); else { tasks[message.task]!.error = received(message); busy[lane] = false; }
        }
        wake?.();
      });
      dispatch();
      return {
        next: async () => {
          for (;;) {
            if (closed || current >= count) return undefined;
            const task = tasks[current]!, first = task.queue[0];
            if (first) {
              const batch = first.batches[taken++]!;
              if (taken === first.batches.length) { task.queue.shift(); taken = 0; workers[first.lane]!.postMessage({ type: 'ack', scan: id, bytes: first.bytes } satisfies ToWorker); }
              return batch as Row<T>[];
            }
            if (task.error) throw task.error;
            if (failure) throw failure;
            if (task.done) { current++; dispatch(); continue; }
            await new Promise<void>(resolve => { wake = resolve; });
          }
        },
        close: async () => {
          if (closed) return;
          closed = true; routes.delete(id);
          const pending = new Map<number, () => void>(); waiters.set(id, pending);
          await Promise.all([...used].map(lane => new Promise<void>(done => {
            pending.set(lane, done);
            if (lanes !== workers) done(); else workers[lane]!.postMessage({ type: 'cancel', scan: id } satisfies ToWorker);
          })));
          waiters.delete(id);
          if (--active === 0 && lanes === workers) {
            for (const worker of workers) worker.unref();
            idle = setTimeout(() => { if (!active && lanes === workers) { lanes = undefined; starting = undefined; void stop(workers); } }, IDLE_MS);
            idle.unref?.();
          }
        },
      };
    },
  };
  return pool;
}
