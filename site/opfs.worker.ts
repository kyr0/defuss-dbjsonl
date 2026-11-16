/** VERIFIED: One OPFS database per origin; every tab's worker coordinates through the same Web Locks namespace. */
import { createOPFSStorage } from 'defuss-storage/opfs';
import { createBrowserBackend } from 'defuss-dbsonl/browser';
import { openDbsonl, type Dbsonl } from 'defuss-dbsonl';

const namespace = 'dbsonl-site-demo';
// A failed open is not cached: the next click tries again instead of repeating the first error forever.
let opened: Promise<Dbsonl<number>> | undefined;
const open = () => opened ??= (async () => {
  const storage = await createOPFSStorage({ name: namespace });
  return openDbsonl<number>(createBrowserBackend(storage, namespace, navigator.locks), 'visits', { create: true });
})().catch((error: unknown) => { opened = undefined; throw error; });

self.onmessage = async ({ data }: MessageEvent<{ op: 'read' | 'increment' | 'reset' }>) => {
  try {
    const db = await open();
    let retries = 0;
    if (data.op === 'reset') await db.delete('counter');
    if (data.op === 'increment') {
      // Another tab may commit between this read and the publish; the transaction then fails with CONFLICT and is retried here.
      for (;;) {
        try { await db.transaction(async tx => { tx.put('counter', ((await tx.get('counter')).value ?? 0) + 1); }); break; }
        catch (error) { if ((error as { code?: string }).code !== 'CONFLICT') throw error; retries++; }
      }
    }
    const { revision } = await db.stats();
    self.postMessage({ ok: true, counter: (await db.get('counter')).value ?? 0, revision, retries });
  } catch (error) {
    // The code names the failure class; the cause's message names the browser error behind it.
    const failure = error as { code?: string; message?: string; cause?: { name?: string; message?: string } };
    const detail = failure.cause ? `${failure.cause.name ?? 'Error'}: ${failure.cause.message ?? ''}` : failure.code ? failure.message : undefined;
    self.postMessage({ ok: false, error: failure.code ?? String(error), detail });
  }
};
