# Transaction engine

VERIFIED: Every module has one protocol responsibility, so each failure class has one place to look and one place to test.

| Module | Responsibility and reason |
| --- | --- |
| `types.ts` | Structural platform contract and typed public operations |
| `common.ts` | Shared limits, identifiers, cancellation and error categories |
| `backend.ts` | Shared local FIFO coordination, portable handle lifetime and chunked writes |
| `io.ts` | Two-slot publication, fresh-head parse cache, bounded framed reads/read-ahead and buffered append; one decoder boundary checks checksum, budget and exact frame length for values and index pages |
| `tree.ts` | Immutable B+tree lookup, path copying, bounded streaming bulk load and leaf-at-a-time traversal for batch scans |
| `page.ts` | Index pages as DSON frames with the same bytes as `encodeFrame` in trusted mode, about 30% faster in microbenchmarks; other shapes go to `encodeFrame` |
| `store.ts` | Admission, snapshots, transactions, commit groups that wait for in-flight transactions, per-key conflict checks, the second-chance page cache, verification, compaction and collection |

VERIFIED: A tree reference is valid only inside the committed end. Index children must physically precede their parent, so corrupt cycles cannot recurse forever. Tree traversal also enforces depth 64. Leaves have at most 32 entries; branches have at most 32 routing summaries. Deletion permits underfull pages and collapses unary roots. Compaction restores dense packing, avoiding merge cascades during ordinary writes.

VERIFIED: Snapshot readers load pages lazily and retain a generation pin; direct lookups hold the commit lock through their read. The cache has separate page-count and encoded-byte limits; decoded heap overhead is outside those numbers. Values bypass the cache so application mutation cannot affect a subsequent read. Commits edit copies of cached pages and cache the pages they publish. Portable I/O uses exclusive Storage handles; native immutable reads use the optional concurrent positional-read capability. No platform API is imported here.

VERIFIED: Scans read ahead 64 KiB, bounded by the snapshot's committed end, on every backend. Through 0.5 only backends with a positional `read` did, so a memory or OPFS scan opened, read and closed the file once per row; reading ahead cut a full memory scan by about a third of its time ([PERFORMANCE.md](../../docs/PERFORMANCE.md#batch-scans-on-macos-arm64)). `scanBatches` walks the tree one leaf at a time (`entryPages`) and tracks one pending pull per batch instead of one per row. The frames of a leaf that the window already holds, up to what the limit and the current batch still take, decode in one `decodeFrames` call (`readCachedValues`), which validates the options and wraps the window once per run. If any frame of a run fails, the run is read again frame by frame, so the error surfaces at its own row after the rows before it, as in a frame-by-frame scan. Every frame still passes the reference, budget, exact-length and checksum checks. Batch arrays and decoded values are never reused, because callers own them. On native storage, which already read ahead through 0.5, the row scan gains only what defuss-dson 1.5 saves per frame; batches gain more.

VERIFIED: `store.ts` owns publication rather than the tree: the tree cannot expose partial batches or choose a durability policy. GC uses the same coordinator and manifest protocol as commits, so it cannot remove a generation referenced by a published head or active snapshot. Root ARCH.md specifies lock order and crash behavior.
