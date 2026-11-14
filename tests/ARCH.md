# Architecture: tests

VERIFIED: The suite exercises real memory and native Storage adapters, real kernel locks and Node's real Web Lock manager. Corruption tests write actual truncated or damaged byte images. Mocked I/O was rejected because the defects that matter here, such as partial reads, torn slots and lock lifetimes, live inside the real subsystems a mock would replace.

| File | Failure classes covered |
| --- | --- |
| `mvcc.test.ts` | Tree results against an independent Map; atomic batches, snapshots, conflicts, phantoms, limits and real quota failures |
| `v2-recovery.test.ts` | Torn data and head slots, committed corruption, publication boundaries and recovery from an interrupted create |
| `native-v2.test.ts` | Independent native backends with real kernel locks and real permission failures |
| `native-performance.test.ts` | Descriptor bounds and cleanup through `/proc` on Linux, stale speculative roots after another client compacts, point-read corruption after cache warmup, partial read/write chunking, large binary values, scan snapshots and close draining |
| `web-locks.test.ts` | Shared pins, try-locks, cancelled waits and pinned-generation retention through `createBrowserBackend` |

VERIFIED: Correctness tests have no speed threshold, because timing assertions fail on loaded machines without indicating a defect; `make bench` measures speed separately. Native directories are temporary and removed after each run, and no test reads user data.

[Consumer tests](consumers/ARCH.md) run against the tarball installed in a separate directory. [Browser tests](browser/ARCH.md) run its bundled imports in real dedicated workers.
