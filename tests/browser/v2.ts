/** Separate dedicated workers share real OPFS files and Web Locks. */
import { createOPFSStorage } from 'defuss-storage/opfs';
import { createDirectoryStorage } from 'defuss-storage/directory';
import { createBrowserBackend } from 'defuss-dbsonl/browser';
import { openDbsonl } from 'defuss-dbsonl';
self.onmessage = async ({ data }) => {
  try {
    const namespace = `dbsonl-${data.namespace}-${data.mode === 'directory' ? 'directory' : 'v2'}`;
    // Directory handles are the other supported browser Storage; they need the same lock namespace discipline.
    const storage = data.mode === 'directory'
      ? await createDirectoryStorage(await (await navigator.storage.getDirectory()).getDirectoryHandle(namespace, { create: true }), { name: namespace })
      : await createOPFSStorage({ name: namespace });
    const backend = createBrowserBackend(storage, namespace, navigator.locks);
    const db = await openDbsonl<number>(backend, 'browser', { create: true });
    if (data.mode === 'directory') {
      await db.transaction(tx => { tx.put('a', 1); tx.put('b', 2); });
      if ((await db.verify()).count !== 2) throw new Error('Directory-handle transaction failed.');
    } else if (data.mode !== 'verify') {
      for (let i = 0; i < 15; i++) {
        for (;;) {
          try { await db.transaction(async tx => { tx.put('counter', ((await tx.get('counter')).value ?? 0) + 1); tx.put(`${data.mode}-${i}`, i); }); break; }
          catch (error) { if ((error as { code?: string }).code !== 'CONFLICT') throw error; }
        }
      }
    } else {
      if ((await db.get('counter')).value !== 30) throw new Error('Cross-worker updates were lost.');
      const snapshot = await db.beginRead(); await db.put('counter', 31); await db.compact();
      if ((await snapshot.get('counter')).value !== 30) throw new Error('Snapshot changed.');
      if ((await db.collect()).retained.length !== 1) throw new Error('Pinned generation was not retained.');
      await snapshot.close(); if ((await db.collect()).removed.length !== 1) throw new Error('Unpinned generation was not reclaimed.');
      await db.verify();
    }
    await db.close(); self.postMessage({ ok: true });
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.stack : String(error) }); }
};
