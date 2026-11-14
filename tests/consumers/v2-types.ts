/** The platform-neutral entry works with no Node or DOM ambient declarations. */
import { openDbsonl, createMemoryBackend, type Transaction, type ReadSession } from 'defuss-dbsonl';
const db = await openDbsonl<{ x: number }>(createMemoryBackend(), 'types', { create: true });
await db.put('a', { x: 1 });
// @ts-expect-error Generic values remain enforced through the batch API.
await db.put('bad', 1);
const session: ReadSession<{ x: number }> = await db.beginRead();
const found = await session.get('a'); if (found.found) { const value: number = found.value.x; void value; }
await db.transaction(async (tx: Transaction<{ x: number }>) => { tx.put('b', { x: 2 }); return (await tx.get('b')).found; });
await session.close(); await db.close();
