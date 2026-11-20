/** One worker thread: its own native backend and handle, pinned to the head it was given, scanning one range. */
import { parentPort, workerData } from 'node:worker_threads';
import { openDbsonl } from 'defuss-dbsonl';
import { createFileBackend } from 'defuss-dbsonl/server';

const { root, head, range } = workerData as { root: string; head: never; range: { gte?: string; lt?: string } };
const backend = await createFileBackend(root);
// A backend created in a worker thread has no pool of its own; nested pools would oversubscribe the CPUs.
if (backend.parallel) throw new Error('A worker thread started a nested scan pool.');
const db = await openDbsonl<{ n: number }>(backend, 'parallel');
const session = await db.beginRead({ at: head });
let count = 0, sum = 0, first: string | undefined, last: string | undefined;
for await (const batch of session.scanBatches(range)) {
  for (const row of batch) { count++; sum += row.value.n; first ??= row.key; last = row.key; }
}
await session.close(); await db.close();
parentPort!.postMessage({ count, sum, first, last });
