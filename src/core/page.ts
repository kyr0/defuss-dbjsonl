/**
 * VERIFIED: Index pages as DSON 1.3.0 frames, with the same bytes as `encodeFrame(page, { trusted: true })`.
 * Pages hold only engine-built objects with a handful of known property names, so this writer copies
 * precomputed UTF-16 names and needs no checks for other value types. Any other name or value type, or a
 * page over the size bound, goes to `encodeFrame`. Equal strings and numbers share a node in the same
 * first-reference order as there. Objects are not deduplicated: the engine creates every entry, child and
 * ref of a page on its own, and checking identity cost a leaf about as much as this writer saves. A page that
 * did share an object would get one node per use, which decodes to an equal page.
 */
import { encodeFrame } from 'defuss-dson/sequence';

const STRING = 14, FLOAT64 = 15, ARRAY = 17, OBJECT = 18;
const utf16 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(4 + text.length * 2);
  new DataView(bytes.buffer).setUint32(0, text.length, true);
  for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); bytes[4 + 2 * i] = code & 255; bytes[5 + 2 * i] = code >>> 8; }
  return bytes;
};
const NAMES = new Map(['kind', 'entries', 'children', 'key', 'ref', 'revision', 'max', 'count', 'offset', 'byteLength'].map(name => [name, utf16(name)] as const));
const INDEX = Array.from({ length: 64 }, (_, i) => utf16(String(i)));
// CRC-32C, the checksum DSON frames carry, sixteen bytes per step.
const CRC = new Int32Array(16 * 256);
for (let n = 0; n < 256; n++) { let crc = n; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1) * 0x82f63b78; CRC[n] = crc; }
for (let n = 0; n < 256; n++) for (let k = 1; k < 16; k++) CRC[k * 256 + n] = CRC[(k - 1) * 256 + n]! >>> 8 ^ CRC[CRC[(k - 1) * 256 + n]! & 255]!;
function checksum(b: Uint8Array, start: number, end: number): number {
  let crc = -1, i = start;
  for (; i + 16 <= end; i += 16) {
    const low = crc ^ (b[i]! | b[i + 1]! << 8 | b[i + 2]! << 16 | b[i + 3]! << 24);
    crc = CRC[3840 + (low & 255)]! ^ CRC[3584 + (low >>> 8 & 255)]! ^ CRC[3328 + (low >>> 16 & 255)]! ^ CRC[3072 + (low >>> 24)]! ^
      CRC[2816 + b[i + 4]!]! ^ CRC[2560 + b[i + 5]!]! ^ CRC[2304 + b[i + 6]!]! ^ CRC[2048 + b[i + 7]!]! ^ CRC[1792 + b[i + 8]!]! ^ CRC[1536 + b[i + 9]!]! ^
      CRC[1280 + b[i + 10]!]! ^ CRC[1024 + b[i + 11]!]! ^ CRC[768 + b[i + 12]!]! ^ CRC[512 + b[i + 13]!]! ^ CRC[256 + b[i + 14]!]! ^ CRC[b[i + 15]!]!;
  }
  for (; i < end; i++) crc = crc >>> 8 ^ CRC[(crc ^ b[i]!) & 255]!;
  return ~crc >>> 0;
}
/** Thrown inside this module only: the page needs the generic encoder. */
const generic = new Error('generic');
// Reused between calls: per node its value, tag and member slice; per member its name bytes and node id.
const values: unknown[] = [], tags: number[] = [], starts: number[] = [], counts: number[] = [], names: Uint8Array[] = [], refs: number[] = [];
const ids = new Map<unknown, number>();

export function encodePage(page: object, maxRecordBytes: number): Uint8Array {
  let used = 0, pairs = 0, size = 8; // DSB magic and node count
  // Equal strings and numbers share a node, except -0, which encodeFrame never deduplicates.
  const primitive = (value: string | number): number => {
    if (!(value === 0 && 1 / value < 0)) { const id = ids.get(value); if (id !== undefined) return id; ids.set(value, used); }
    values[used] = value;
    if (typeof value === 'string') { tags[used] = STRING; size += 5 + value.length * 2; } else { tags[used] = FLOAT64; size += 9; }
    return used++;
  };
  const container = (value: object): number => { values[used] = value; tags[used] = Array.isArray(value) ? ARRAY : OBJECT; return used++; };
  try {
    container(page);
    // Nodes get ids in first-reference order: a node's members are numbered when the walk reaches it.
    for (let i = 0; i < used; i++) {
      const tag = tags[i];
      if (tag !== OBJECT && tag !== ARRAY) continue;
      const item = values[i] as Record<string, unknown>;
      starts[i] = pairs;
      if (tag === ARRAY) {
        const list = item as unknown as unknown[];
        size += 9;
        for (let j = 0; j < list.length; j++) {
          const member = list[j];
          if (typeof member !== 'object' || member === null) throw generic;
          const name = INDEX[j] ?? utf16(String(j));
          names[pairs] = name; refs[pairs++] = container(member); size += name.length + 4;
        }
      } else {
        size += 5;
        for (const key in item) {
          const name = NAMES.get(key), member = item[key];
          if (!name) throw generic;
          const type = typeof member;
          names[pairs] = name;
          refs[pairs++] = type === 'string' || type === 'number' ? primitive(member as string | number) : type === 'object' && member !== null ? container(member as object) : (() => { throw generic; })();
          size += name.length + 4;
        }
      }
      counts[i] = pairs - starts[i]!;
    }
    if (size > maxRecordBytes) throw generic;
    const bytes = new Uint8Array(16 + size), view = new DataView(bytes.buffer);
    bytes[16] = 68; bytes[17] = 83; bytes[18] = 66; bytes[19] = 1; view.setUint32(20, used, true);
    let p = 24;
    for (let i = 0; i < used; i++) {
      const tag = tags[i]!; bytes[p++] = tag;
      if (tag === STRING) {
        const text = values[i] as string;
        view.setUint32(p, text.length, true); p += 4;
        for (let k = 0; k < text.length; k++) { const code = text.charCodeAt(k); bytes[p++] = code & 255; bytes[p++] = code >>> 8; }
      } else if (tag === FLOAT64) { view.setFloat64(p, values[i] as number, true); p += 8; }
      else {
        if (tag === ARRAY) { view.setUint32(p, (values[i] as unknown[]).length, true); p += 4; }
        const start = starts[i]!, end = start + counts[i]!;
        view.setUint32(p, end - start, true); p += 4;
        for (let j = start; j < end; j++) { const name = names[j]!; for (let x = 0; x < name.length; x++) bytes[p + x] = name[x]!; p += name.length; view.setUint32(p, refs[j]!, true); p += 4; }
      }
    }
    bytes[0] = 68; bytes[1] = 83; bytes[2] = 81; bytes[3] = 1;
    view.setUint32(4, size, true);
    view.setUint32(8, checksum(bytes, 16, 16 + size), true);
    view.setUint32(12, checksum(bytes, 0, 12), true);
    return bytes;
  } catch (error) {
    if (error === generic) return encodeFrame(page, { maxRecordBytes, trusted: true });
    throw error;
  } finally { ids.clear(); values.fill(undefined, 0, used); }
}
