/** VERIFIED: The website demos call the packaged library in the visitor's tab; nothing is simulated. */
import { createMemoryBackend, openDbsonl, type Dbsonl, type ReadSession } from 'defuss-dbsonl';

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const code = (error: unknown) => (error as { code?: string }).code ?? (error instanceof Error ? error.name : 'Error');
const text = (selector: string, value: string | number) => { $(selector).textContent = String(value); };
function log(list: HTMLElement, message: string, tone: 'ok' | 'fail' | 'info' = 'info'): void {
  const item = document.createElement('li');
  item.dataset.tone = tone;
  item.textContent = message;
  list.prepend(item);
  while (list.children.length > 6) list.lastElementChild!.remove();
}

/** Snapshot demo: a pinned read session keeps its root while transfers commit. */
async function snapshots(): Promise<void> {
  const db = await openDbsonl<number>(createMemoryBackend(), 'accounts', { create: true });
  await db.batch([{ operation: 'put', key: 'alice', value: 100 }, { operation: 'put', key: 'bob', value: 50 }]);
  let snapshot: ReadSession<number> = await db.beginRead();
  const render = async () => {
    const [alice, bob, a, b] = await Promise.all([db.get('alice'), db.get('bob'), snapshot.get('alice'), snapshot.get('bob')]);
    text('#snap-live-alice', alice.value!); text('#snap-live-bob', bob.value!);
    text('#snap-pin-alice', a.value!); text('#snap-pin-bob', b.value!);
    text('#snap-live-rev', (await db.stats()).revision); text('#snap-pin-rev', snapshot.revision);
  };
  $('#snap-transfer').addEventListener('click', async () => {
    try {
      await db.transaction(async tx => {
        const alice = (await tx.get('alice')).value!;
        const bob = (await tx.get('bob')).value!;
        if (alice < 20) throw new RangeError('alice has less than 20 left.');
        tx.put('alice', alice - 20); tx.put('bob', bob + 20);
      });
      $('#snap-note').textContent = '';
    } catch (error) { $('#snap-note').textContent = `The transaction threw ${code(error)} and published nothing.`; }
    await render();
  });
  $('#snap-refresh').addEventListener('click', async () => {
    await snapshot.close();
    snapshot = await db.beginRead();
    $('#snap-note').textContent = '';
    await render();
  });
  await render();
}

/** Conflict demo: a write lands while a transaction callback is still running. */
async function conflicts(): Promise<void> {
  const db: Dbsonl<number> = await openDbsonl<number>(createMemoryBackend(), 'counter', { create: true });
  await db.put('visits', 0);
  const list = $('#conflict-log');
  const show = async () => text('#conflict-value', (await db.get('visits')).value!);
  $('#conflict-run').addEventListener('click', async () => {
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const pending = db.transaction(async tx => {
      const seen = (await tx.get('visits')).value!;
      log(list, `Transaction A read visits = ${seen}.`);
      await paused;
      tx.put('visits', seen + 1);
    });
    // release() runs even if writer B fails, so transaction A never waits forever.
    try { await db.put('visits', ((await db.get('visits')).value ?? 0) + 10); log(list, 'Writer B added 10 and committed.'); }
    finally { release(); }
    try { await pending; log(list, 'Transaction A committed.', 'ok'); }
    catch (error) { log(list, `Transaction A failed with ${code(error)}; its write was not published.`, 'fail'); }
    await show();
  });
  $('#conflict-retry').addEventListener('click', async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await db.transaction(async tx => { tx.put('visits', ((await tx.get('visits')).value ?? 0) + 1); });
        log(list, `Retry committed on attempt ${attempt}.`, 'ok'); break;
      } catch (error) { if (code(error) !== 'CONFLICT') throw error; }
    }
    await show();
  });
  await show();
}

/** Types demo: DSON keeps values JSON would change or reject. */
async function values(): Promise<void> {
  type Note = { title: string; at: Date; bytes: Uint8Array; big: bigint; missing: undefined; self?: Note };
  const db = await openDbsonl<Note>(createMemoryBackend(), 'notes', { create: true });
  $('#types-run').addEventListener('click', async () => {
    const note: Note = { title: 'hello', at: new Date(), bytes: new Uint8Array([0, 128, 255]), big: 2n ** 64n, missing: undefined };
    note.self = note;
    await db.put('note', note);
    const back = (await db.get('note')).value!;
    const rows: [string, string, boolean][] = [
      ['at', `Date ${back.at.toISOString()}`, back.at instanceof Date],
      ['bytes', `Uint8Array [${[...back.bytes].join(', ')}]`, back.bytes instanceof Uint8Array],
      ['big', `bigint ${back.big}`, typeof back.big === 'bigint'],
      ['missing', 'present, value undefined', 'missing' in back && back.missing === undefined],
      ['self', 'the stored object itself', back.self === back],
    ];
    const body = $('#types-out');
    body.replaceChildren(...rows.map(([key, read, ok]) => {
      const row = document.createElement('tr');
      row.className = 'table-row';
      for (const cell of [key, read, ok ? 'kept' : 'lost']) { const td = document.createElement('td'); td.className = 'table-cell'; td.textContent = cell; row.append(td); }
      row.dataset.ok = String(ok);
      return row;
    }));
  });
}

/** Persistence demo: an OPFS database in a dedicated worker survives reloads and is shared by tabs. */
function persistence(): void {
  const status = $('#persist-status');
  if (!('storage' in navigator) || !('locks' in navigator) || typeof Worker === 'undefined') {
    status.textContent = 'This browser lacks OPFS or Web Locks, so the persistent demo cannot run here.';
    return;
  }
  // UNKNOWN: why the demo stopped answering on an iPhone after a delete; desktop WebKit and Chromium never hang.
  // A worker that leaves a request unanswered is replaced: ending it releases its Web Locks and OPFS handles,
  // and a commit it interrupted is either published or invisible, so the new worker reads a consistent counter.
  const silenceMs = 5000;
  let worker: Worker;
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notice = '';
  let replaced = false;
  const watch = () => { clearTimeout(timer); timer = pending ? setTimeout(restart, silenceMs) : undefined; };
  const send = (op: 'read' | 'increment' | 'reset') => { pending++; worker.postMessage({ op }); watch(); };
  const start = () => {
    worker = new Worker(new URL('./opfs.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      pending = Math.max(0, pending - 1); watch();
      if (!data.ok) { status.textContent = `The worker reported ${data.error}${data.detail ? ` (${data.detail})` : ''}.`; return; }
      replaced = false;
      text('#persist-count', data.counter); text('#persist-rev', data.revision);
      status.textContent = notice || (data.retries ? `Committed after ${data.retries} conflict retries.` : 'Stored in this origin\'s private file system.');
      notice = '';
      document.documentElement.dataset.persistReady = '';
    };
    worker.onerror = event => { pending = 0; watch(); status.textContent = `The worker failed: ${event.message}`; };
  };
  // One replacement per silence: a second silent worker means something outside this page holds the database.
  function restart(): void {
    worker.terminate(); pending = 0; start();
    // The next click goes to the fresh worker; the page itself stops retrying.
    if (replaced) { notice = ''; status.textContent = 'The replacement worker did not answer either; close other tabs of this site, then reload.'; return; }
    replaced = true;
    status.textContent = notice = `The worker did not answer for ${silenceMs / 1000} s, so the page replaced it.`;
    send('read');
  }
  start();
  $('#persist-inc').addEventListener('click', () => send('increment'));
  $('#persist-reset').addEventListener('click', () => send('reset'));
  send('read');
}

await Promise.all([snapshots(), conflicts(), values()]);
persistence();
document.documentElement.dataset.demoReady = '';
