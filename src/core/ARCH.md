# Transaction engine

VERIFIED: Every module has one protocol responsibility, so each failure class has one place to look and one place to test.

| Module | Responsibility and reason |
| --- | --- |
| `types.ts` | Structural platform contract and typed public operations |
| `common.ts` | Shared limits, identifiers, cancellation and error categories |
| `backend.ts` | Shared local FIFO coordination, portable handle lifetime and chunked writes |
| `io.ts` | Two-slot publication, fresh-head parse cache, bounded framed reads/read-ahead and buffered append; one decoder boundary checks checksum, budget and exact frame length for values and index pages |
| `tree.ts` | Immutable B+tree lookup, path copying and bounded streaming bulk load |
| `page.ts` | Index pages as DSON frames with the same bytes as `encodeFrame` in trusted mode, about 30% faster in microbenchmarks; other shapes go to `encodeFrame` |
| `store.ts` | Admission, snapshots, transactions, commit groups that wait for in-flight transactions, per-key conflict checks, the second-chance page cache, verification, compaction and collection |

VERIFIED: A tree reference is valid only inside the committed end. Index children must physically precede their parent, so corrupt cycles cannot recurse forever. Tree traversal also enforces depth 64. Leaves have at most 32 entries; branches have at most 32 routing summaries. Deletion permits underfull pages and collapses unary roots. Compaction restores dense packing, avoiding merge cascades during ordinary writes.

VERIFIED: Snapshot readers load pages lazily and retain a generation pin; direct lookups hold the commit lock through their read. The cache has separate page-count and encoded-byte limits; decoded heap overhead is outside those numbers. Values bypass the cache so application mutation cannot affect a subsequent read. Commits edit copies of cached pages and cache the pages they publish. Portable I/O uses exclusive Storage handles; native immutable reads use the optional concurrent positional-read capability. No platform API is imported here.

VERIFIED: `store.ts` owns publication rather than the tree: the tree cannot expose partial batches or choose a durability policy. GC uses the same coordinator and manifest protocol as commits, so it cannot remove a generation referenced by a published head or active snapshot. Root ARCH.md specifies lock order and crash behavior.
