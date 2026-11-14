/** VERIFIED: the example uses only public exports and runs from the installed tarball during make e2e. */
import { createMemoryBackend, openDbsonl } from 'defuss-dbsonl';

const db = await openDbsonl<{ title: string; updated: Date }>(createMemoryBackend(), 'notes', { create: true });
try {
  await db.put('first', { title: 'Typed records', updated: new Date('2026-11-13T00:00:00Z') });
  const result = await db.get('first');
  // DSON keeps rich types; JSON would return a string here.
  if (!result.found || !(result.value.updated instanceof Date)) throw new Error('Date did not survive storage.');
  const snapshot = await db.beginRead();
  try { for await (const row of snapshot.scan()) console.log(row.key, row.revision); }
  finally { await snapshot.close(); }
} finally { await db.close(); }
