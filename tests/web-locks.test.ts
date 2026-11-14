import { test, expect } from 'vitest';
import { locks } from 'node:worker_threads';
import { createMemoryStorage } from 'defuss-storage';
import { createBrowserBackend } from '../src/browser.js';
import { openDbsonl } from '../src/index.js';

test('Web Locks adapter supports shared pins, try-locks, waiting and cancelled acquisition', async () => {
  const backend = createBrowserBackend(createMemoryStorage(), 'test-web-locks', locks);
  const a = await backend.coordinator.acquire('test', true);
  const b = await backend.coordinator.acquire('test', true);
  expect(await backend.coordinator.acquire('test', false, undefined, true)).toBeUndefined();
  const controller = new AbortController();
  const waiting = backend.coordinator.acquire('test', false, controller.signal);
  controller.abort(); await a!(); await b!();
  await expect(waiting).rejects.toMatchObject({ code: 'ABORTED' });
  const db = await openDbsonl(backend, 'web', { create: true });
  await db.put('a', 1); const snapshot = await db.beginRead(); await db.compact();
  expect((await db.collect()).retained.length).toBe(1); await snapshot.close();
  expect((await db.collect()).removed.length).toBe(1); await db.close();
  expect(() => createBrowserBackend(createMemoryStorage(), '', locks)).toThrow();
});
