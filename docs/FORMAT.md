# DBSONL formats 2 and 3

VERIFIED: The disk format uses DSON 1.3.0 sequence frames. defuss-dson 1.4.0, 1.5.0 and 1.5.1 write the same bytes as 1.3.0, so builds on any of these versions read each other's files. Each frame has a 16-byte DSQ header with length, header CRC32C and payload CRC32C. Payloads encode values and references locally to that frame. DBSONL adds no JSON/base64 layer.

## Files

| Name | Contents |
| --- | --- |
| `<name>.head` | Two 4096-byte manifest slots |
| `<name>.g-<32 hex digits>.dsq` | Append-only value and index-page frames for one generation |
| `commit-<name>.lock` | Native commit coordination inode |
| `pin-<generation filename>.lock` | Native shared snapshot/candidate pin inode |
| `io-<filename>.lock` | Native short-lived exclusive Storage-handle coordination inode |

Native lock files carry no database data. Memory and Web Locks implementations do not need these files. Database identifiers have their own validated namespace; foreign files are not reclaimed.

## Head slots

VERIFIED: Each slot begins with one framed object and is zero-padded to 4096 bytes. Slot index is `publication % 2`. The highest valid publication is selected. A torn frame is ignored. A checksummed object with an unknown version or invalid fields fails validation rather than masquerading as a torn write.

VERIFIED: Version 0.7 creates format 3 databases and keeps reading and writing format 2 databases in format 2, so older writers can share them. Compaction keeps a database's format. Versions before 0.7 refuse a format 3 head with `UNSUPPORTED`.

```ts
type Head = {
  dbsonl: 2 | 3;
  seal?: string; // format 3 only: 32 random hex digits, new for every generation
  publication: number;
  revision: number;
  generation: string;
  root: { offset: number; byteLength: number } | null;
  count: number;
  end: number;
};
```

`publication` increases for commits and maintenance; `revision` increases only for nonempty logical batches. `end` is the committed byte boundary. No reference may cross it. A null root and count zero must agree. Existing invalid manifests are not overwritten by `create: true`. A crash during initial creation can leave an invalid empty manifest; inspect or remove that new incomplete database explicitly before retrying creation.

## Index pages

```ts
type Entry = { key: string; ref: Ref; revision: number };
type Child = { max: string; ref: Ref; count: number };
type Page = { kind: 'leaf'; entries: Entry[] }
  | { kind: 'branch'; children: Child[] };
type Ref = { offset: number; byteLength: number };
```

VERIFIED: Pages contain between 1 and 32 entries/children. Keys and child maxima are strictly increasing under JavaScript string comparison. Each child stores its subtree's maximum key and live count. Every referenced frame ends at or before its parent frame's starting offset. Values are written before leaves and children before parents. This physical ordering prevents cycles independently of decoder reference support. A depth bound of 64 is an additional safety check.

VERIFIED: An update appends a value, then edits private copies of the leaf and affected ancestors. The batch coalesces repeated edits and persists each final dirty page once before publication. Splits produce two pages. Deletes may produce underfull pages or remove empty subtrees. Unary roots collapse. Old pages remain valid for older snapshot roots until the generation is reclaimed. Full verification checks child partition ordering, actual subtree maxima/counts, record revisions and every reachable value checksum.

## Commit records (format 3)

VERIFIED: In format 3 the last frame of every commit is a commit record:

```ts
type CommitRecord = {
  dbsonl: 3; seal: string; publication: number; revision: number;
  root: Ref | null; count: number;
  offset: number; // the record's own position in the generation
  prev: number;   // the end of the commit before it: the head.end this commit started from
};
```

The record's end is the head's `end`. It lets one flush of the generation make a commit durable: on storage whose writes are visible to every process before a flush (native files), the head slot is then written without a flush, and flushed only once 16 MiB of the generation went by since this handle last flushed it. A power loss can therefore leave a head slot older than the last durable commit. Opening, committing, compacting and collecting walk the frames after the head's end and adopt the last record that repeats the generation's seal, sits at its own `offset` and chains through `prev` to the commit before it, provided every frame up to it passes its payload checksum. The walk checks values and pages by checksum alone, so values above the reopening handle's `maxRecordBytes` do not stop it. The first torn or damaged frame ends the walk, so a commit whose blocks the device wrote only in part is not adopted. The walk reads at most about 16 MiB, because a committing handle flushes the slot whenever the generation grew that much since its own last flush.

VERIFIED: The seal is random per generation and appears only in the head and the records, so a stored value cannot pose as a record without access to the files. Like the CRCs, it is not authentication against someone who can write the files.

## Commit and maintenance sequence

1. Acquire commit lock and read the latest valid head.
2. Check each queued commit in order: its expected revision, if supplied, and the revisions of a transaction's read keys. Each accepted commit takes the next revision.
3. Truncate only bytes after that head's committed end.
4. Format 3: adopt durable commits after the head's end first, as described above. Append values and copied index paths, and in format 3 the commit record last; drain the bounded writer buffer, then flush the generation.
5. Write the alternate head slot, and flush it in format 2, on storage that needs a flush to show a write to other handles, or every 16 MiB in format 3. Both files already exist, so a commit needs no directory sync; creation and compaction sync the directory before the first head refers to a new file.
6. Release locks and return each commit its revision receipt.

VERIFIED: One publication can therefore cover several revisions. Records carry the revision of the commit that wrote them, and the head carries the last one; intermediate revisions are never published as heads. Readers of any version see consecutive heads as before.

VERIFIED: Failure before the generation flush in step 4 cannot publish a partial batch. In format 2, failure during or after step 5 can have an uncertain outcome; in format 3 the outcome is uncertain from the generation flush on, because its record makes the commit adoptable even when the head slot is never written. Publication does not wait for older snapshots; their roots refer only to immutable earlier frames.

VERIFIED: Compaction builds a new generation from one pinned root, flushes it and syncs its directory entry. Under the commit lock it compares the original publication, then writes both head slots to the packed generation. Collection refreshes the alternate slot first, then removes only generations whose exclusive pin can be acquired. A crashed compactor leaves at most an orphan candidate which later collection can remove.

VERIFIED: CRCs are integrity checks, not authentication. The protocol assumes cooperating writers and a filesystem honoring its reported synchronization operations. SIGKILL tests exercise process failure, not power removal, controller caches or storage-device firmware.

VERIFIED: Versions 0.2 through 0.6 write format 2 identically, and 0.7 writes format 2 the same way for existing format 2 databases. Native read-only descriptor reuse, parsed-head caching and read-ahead create no additional files or persistent metadata. They do not weaken the lock/pin lifetime, commit boundary or CRC checks.
