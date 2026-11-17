# Architecture: tests

VERIFIED: The suite exercises real memory and native Storage adapters, real kernel locks and Node's real Web Lock manager. Corruption tests write actual truncated or damaged byte images. Mocked I/O was rejected because the defects that matter here, such as partial reads, torn slots and lock lifetimes, live inside the real subsystems a mock would replace.

| File | Failure classes covered |
| --- | --- |
| `mvcc.test.ts` | Tree results against an independent Map; atomic batches, snapshots, conflicts, phantoms, limits and real quota failures |
| `v2-recovery.test.ts` | Torn data and head slots, committed corruption, publication boundaries and recovery from an interrupted create |
| `native-v2.test.ts` | Independent native backends with real kernel locks and real permission failures |
| `commit-groups.test.ts` | Per-key transaction conflicts (disjoint keys, changed and deleted read keys, point-read phantoms, write skew), commit groups with per-member revisions, checks and receipts in one publication, and cancelled or over-quota members that leave the rest committed; full groups for four concurrent transaction writers and a long-held snapshot that does not hold back other commits |
| `page.test.ts` | The index-page writer against `encodeFrame` in trusted mode: identical bytes for 2000 generated leaf and branch pages in both child key orders, and identical results for other names, value types and oversized pages |
| `native-performance.test.ts` | Descriptor bounds and cleanup through `/proc` on Linux and `lsof` on macOS, stale speculative roots after another client compacts, point-read corruption after cache warmup, partial read/write chunking, large binary values, scan snapshots and close draining |
| `batches.test.ts` | Batch scans on memory and native storage against the row scan for every range and limit, batch and byte budgets, stable snapshots across compaction, owned output, invalid options and row sizes, an oversized row after earlier batches, a failing frame inside a run decoded in one call, cancellation, a close from inside `sizeOf`, and the decoder budget on frames served from the read window |
| `contracts.test.ts` | API contracts no other file reached: transaction scans that merge staged writes with the snapshot under ranges and limits, the whole-database fallback past `maxTransactionOperations` distinct reads, TypeError and RangeError for invalid keys, bounds, operations, revisions, modes and budgets, zero cache budgets, early scan breaks, `close()` draining work and closing owned snapshots, the memory and native lock protocol, checksummed heads of another format version or with inconsistent fields, and a denied native read that works again once access is restored |
| `web-locks.test.ts` | Shared pins, try-locks, cancelled waits and pinned-generation retention through `createBrowserBackend` |

VERIFIED: Correctness tests have no speed threshold, because timing assertions fail on loaded machines without indicating a defect; `make bench` measures speed separately. Native directories are temporary and removed after each run, and no test reads user data.

[Consumer tests](consumers/ARCH.md) run against the tarball installed in a separate directory. [Browser tests](browser/ARCH.md) run its bundled imports in real dedicated workers.
