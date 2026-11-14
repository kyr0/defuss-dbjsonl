/** CommonJS consumers exercise both the isomorphic and native entry points. */
import { openDbsonl, createMemoryBackend } from 'defuss-dbsonl';
import { createFileBackend } from 'defuss-dbsonl/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
async function main() {
  const root = await mkdtemp(resolve('cjs-v2-'));
  try {
    for (const backend of [createMemoryBackend(), await createFileBackend(root)]) {
      const db = await openDbsonl<number>(backend, 'cjs', { create: true });
      await db.transaction(tx => { tx.put('a', 1); tx.put('b', 2); });
      if ((await db.verify()).count !== 2) throw new Error('CommonJS transaction failed.');
      await db.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
