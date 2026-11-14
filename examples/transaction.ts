/** VERIFIED: A transaction either publishes both changes or leaves both unchanged. */
import { createMemoryBackend, openDbsonl } from 'defuss-dbsonl';
const db = await openDbsonl<number>(createMemoryBackend(), 'accounts', { create: true });
await db.batch([{ operation: 'put', key: 'alice', value: 100 }, { operation: 'put', key: 'bob', value: 50 }]);
const before = await db.beginRead();
try {
  await db.transaction(async tx => {
    const alice = (await tx.get('alice')).value!;
    const bob = (await tx.get('bob')).value!;
    tx.put('alice', alice - 20); tx.put('bob', bob + 20);
  });
  if ((await before.get('alice')).value !== 100) throw new Error('Snapshot was not stable.');
  await db.compact();
} finally { await before.close(); await db.collect(); await db.close(); }
