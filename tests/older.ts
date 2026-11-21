/** Test helpers for databases of an older format than the one new databases use. */
import { encodeFrame } from 'defuss-dson/sequence';
import { openDbsonl } from '../src/index.js';
import type { Backend } from '../src/index.js';
import { headFile, readHead, SLOT_BYTES } from '../src/core/io.js';

/** A power loss that kept the generation's flushed commits but lost later head slot writes, or a rewritten head. */
export async function restore(backend: Backend, name: string, data: Uint8Array): Promise<void> {
  const file = await backend.storage.open(name);
  try { await file.truncate(0); await file.write(0, data); await file.flush(); } finally { await file.close(); }
}
/**
 * An empty database whose head an older version wrote: format 2 without a seal, format 3 or 4 with one, none with
 * format 5's log fields. Converted before any write, so every page the test writes uses that format's encoding.
 */
export async function older(backend: Backend, name: string, format: 2 | 3 | 4): Promise<void> {
  await (await openDbsonl(backend, name, { create: true })).close();
  const head = await readHead(backend, name), { seal, log: _log, last: _last, ...rest } = head;
  const slots = new Uint8Array(SLOT_BYTES * 2);
  for (const publication of [head.publication, head.publication + 1])
    slots.set(encodeFrame({ ...rest, dbsonl: format, publication, ...(format >= 3 && { seal }) }), (publication % 2) * SLOT_BYTES);
  await restore(backend, headFile(name), slots);
}
