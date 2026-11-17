# DBSONL format 2

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

```ts
type Head = {
  dbsonl: 2;
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

## Commit and maintenance sequence

1. Acquire commit lock and read the latest valid head.
2. Check each queued commit in order: its expected revision, if supplied, and the revisions of a transaction's read keys. Each accepted commit takes the next revision.
3. Truncate only bytes after that head's committed end.
4. Append values and copied index paths; drain the bounded writer buffer, then flush the generation.
5. Write and flush the alternate head slot. Both files already exist, so a commit needs no directory sync; creation and compaction sync the directory before the first head refers to a new file.
6. Release locks and return each commit its revision receipt.

VERIFIED: One publication can therefore cover several revisions. Records carry the revision of the commit that wrote them, and the head carries the last one; intermediate revisions are never published as heads. Readers of any version see consecutive heads as before.

VERIFIED: Failure before step 5 cannot publish a partial batch. Failure during or after step 5 can have an uncertain outcome. Publication does not wait for older snapshots; their roots refer only to immutable earlier frames.

VERIFIED: Compaction builds a new generation from one pinned root, flushes it and syncs its directory entry. Under the commit lock it compares the original publication, then writes both head slots to the packed generation. Collection refreshes the alternate slot first, then removes only generations whose exclusive pin can be acquired. A crashed compactor leaves at most an orphan candidate which later collection can remove.

VERIFIED: CRCs are integrity checks, not authentication. The protocol assumes cooperating writers and a filesystem honoring its reported synchronization operations. SIGKILL tests exercise process failure, not power removal, controller caches or storage-device firmware.

VERIFIED: Versions 0.2 through 0.4 write format 2 identically. Native read-only descriptor reuse, parsed-head caching and read-ahead create no additional files or persistent metadata. They do not weaken the lock/pin lifetime, commit boundary or CRC checks.
