/** Real processes exercise kernel ownership; no process-local surrogate locks. */
import { openDbsonl } from 'defuss-dbsonl';
import { createFileBackend } from 'defuss-dbsonl/server';
const [root, mode, id = '0'] = process.argv.slice(2);
if (mode === 'create') {
  // The older build creates the shared database, so older and current writers meet on format 2.
  await (await openDbsonl<number>(await createFileBackend(root!), 'multi', { create: true })).close();
  console.log('created'); process.exit(0);
}
if (mode === 'refuse') {
  // An older build must refuse a database in the current format (4) instead of reading or writing it.
  let refused = false;
  try { await openDbsonl<number>(await createFileBackend(root!), 'modern'); } catch (error) { refused = (error as { code?: string }).code === 'UNSUPPORTED'; }
  if (!refused) throw new Error('The older build did not refuse a format 5 database.');
  console.log('refused'); process.exit(0);
}
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
