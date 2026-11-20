/** VERIFIED: The scan pool's worker thread: its own synchronous native backend, serving one pinned range per task. */
import { parentPort, workerData } from 'node:worker_threads';
import { openDbsonl } from './core/store.js';
import { serveScans } from './scan-pool.js';
import { createFileBackend } from './server.js';
import type { FileBackendOptions } from './server.js';

const { root, options } = workerData as { root: string; options: FileBackendOptions };
// A scanning thread has nothing else to run, so blocking reads skip the thread pool that all threads share.
const backend = await createFileBackend(root, { ...options, io: 'sync', scanWorkers: 0 });
serveScans(parentPort!, (name, limits) => openDbsonl(backend, name, limits));
parentPort!.postMessage({ type: 'ready' });
