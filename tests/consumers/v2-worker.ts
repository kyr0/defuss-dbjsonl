/** Real processes exercise kernel ownership; no process-local surrogate locks. */
import { openDbsonl } from 'defuss-dbsonl';
import { createFileBackend } from 'defuss-dbsonl/server';
const [root, mode, id = '0'] = process.argv.slice(2);
const db = await openDbsonl<number>(await createFileBackend(root!), 'multi');
if (mode === 'increment') {
  for (let i = 0; i < 15; i++) {
    for (;;) {
      try {
        await db.transaction(async tx => { const old = await tx.get('counter'); tx.put('counter', (old.value ?? 0) + 1); tx.put(`writer-${id}-${i}`, i); });
        break;
      } catch (error) { if ((error as { code?: string }).code !== 'CONFLICT') throw error; }
    }
  }
  await db.close(); console.log('done');
} else if (mode === 'pin') {
  await db.beginRead(); console.log('pinned'); setInterval(() => {}, 1000);
} else if (mode === 'crash') {
  console.log('ready');
  await db.batch(Array.from({ length: 1000 }, (_, i) => ({ operation: 'put', key: `crash-${id}-${i}`, value: i })));
  console.log('committed'); await db.close();
} else throw new Error('Unknown child mode.');
