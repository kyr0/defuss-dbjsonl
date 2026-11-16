# Changelog

## 0.5.1

VERIFIED: `package.json` names the project website, https://dbsonl.defuss.org, as its homepage, and links the GitHub repository and issue tracker. The README explains installing from npm: on 2026-11-16, `bun add defuss-dbsonl@0.5.0` and `npm install defuss-dbsonl@0.5.0` each installed five packages in an empty project with no install script, and the `/server` entry stored and read a value under Node.js and Bun on macOS arm64.

VERIFIED: The website describes 0.5.0: per-key transaction conflicts, commit groups, the second-chance page cache and the `make bench` figures of three runs on the 0.5.0 source. Against v0.3.0 in those runs no figure was slower in all three, and atomic batches took 1.6 times less time under Node.js and 2.4 times less under Bun. `docs/PERFORMANCE.md` has the tables; the 0.4.0 runs moved to `validation/bench-macos-arm64-0.4.0.json`.

VERIFIED: Below the hero, the website compares defuss-dbsonl with Redis 8.10.3 in the 16 pairings of `make bench-redis`. It shows the headline figures, four gauges that follow a runtime and storage switch, opening on Bun flushed to disk, and two dumbbell charts drawn with ECharts 6.1.0. The tables moved into that section. Under the DSON line, the hero has a second rotating line listing what defuss-dbsonl adds. `make e2e` checks that both charts draw, that the switches move the gauges, and that the page still does not scroll sideways at iPhone size.

VERIFIED: `tests/contracts.test.ts` adds eight tests for documented contracts no other test reached. Coverage rose from 91.33% to 93.86% of statements, 86.17% to 90.15% of branches, 96.39% to 97.29% of functions and 97.67% to 98.41% of lines. No production code changed.

## 0.5.0

VERIFIED: The website fits phones: code and tables scroll sideways instead of wrapping, tables tint every other row, cards put their icon beside the heading, and the install tabs stack. `make e2e` now also drives the website in WebKit at iPhone size, including the OPFS counter and the menu sheet, and fails if the page scrolls sideways.

VERIFIED: The OPFS demo replaces a worker that leaves a request unanswered for 5 s, retries a failed open on the next click and shows the browser error behind a failure. The demo was reported to stop on an iPhone after a delete; desktop WebKit and Chromium did not reproduce it, so the cause is still open.

VERIFIED: Commits got cheaper without changing the format or the lock protocol. A commit edits cached copies of the index pages on its paths instead of rereading and decoding them, and caches the pages it publishes. Publication patches the manifest parse cache, skips the directory sync (a commit creates no file), and truncates only when a failed commit left a tail. Native connections reuse one idle descriptor per lock name instead of reopening a lock file for every I/O lock and pin. In single-process probes on macOS arm64, a memory transaction fell from 0.31–0.38 ms to 0.14–0.15 ms and a durable Bun transaction from 1.16 ms to 0.50 ms; durable Node commits stay bound by their two flushes, which took about 3 ms each under Node on that host.

VERIFIED: Behavior change: a transaction now conflicts only when a key it read changed, appeared or disappeared after its snapshot, instead of on any concurrent commit. Writers on disjoint keys no longer retry; write skew and point-read phantoms are still rejected, and a transaction that scanned falls back to the whole-database check. With four contending writers, retries fell from 1.5 to 2.1 per commit to none.

VERIFIED: Commits queued on one handle publish as a group: one append, one generation flush and one head flush, with a revision and receipt per commit. A cancelled, conflicting or failing member is rejected alone. A transaction started while its handle's group holds the commit lock pins the last flushed head instead of waiting behind the group's flushes.

VERIFIED: A forming commit group waits, at most half the previous group's publication time, for transactions on its handle that already hold a snapshot. Four transaction writers on one handle had alternated between groups of one and three members; in full groups a contended durable Node commit fell from 4.4 to 2.1 ms on macOS arm64, and a contended memory commit from 65 to 59 µs under Node and from 72 to 63 µs under Bun. A transaction that outlasts one wait is not waited for again.

VERIFIED: defuss-dson is now 1.4.0, which writes the same frames as 1.3.0. In microbenchmarks of dbsonl's values, pages and manifests on macOS arm64 it encoded three to five times faster and decoded 2.5 to 6 times faster. Index pages and manifests use its `trusted` mode, which skips the per-property checks for plain data the engine built itself. On macOS arm64 a 24-entry leaf page encoded in 9 to 12 µs instead of 49 to 53 µs and decoded in 12 to 15 µs instead of 42 to 65 µs.

VERIFIED: Index pages are written by a page-specific DSON writer with the same bytes as `encodeFrame` in trusted mode (checked on 2000 generated pages per test run), about 30% faster per page, and the page cache evicts by second chance instead of reordering on every hit. Together they took a contended memory commit from 59 to 49 µs under Node and from 63 to 56 µs under Bun in single-process probes.

VERIFIED: Index edits and buffered appends run synchronously unless they need I/O, and native connections read the 8 KiB manifest with a blocking call; a cold manifest blocks the event loop for one 8 KiB read. A durable point read fell from 45 to 27 µs under Node and to about 33 µs under Bun in single-process probes.

VERIFIED: In `make bench-redis` on macOS arm64, defuss-dbsonl now takes less time than Redis in 12 of 16 pairings, against 4 for 0.4.0. The single durable Node writes still lose, because each commit flushes twice and a flush took about 3 ms under Node there, and so do the 1000-write batches in memory, where encoding each value as its own DSON frame costs more than Redis's `JSON.stringify`. `docs/PERFORMANCE.md` has the table.

VERIFIED: defuss-storage is now 0.3.1.

VERIFIED: `make bench-redis` compares the current build with a throwaway loopback Redis pinned in `mise.toml`: point reads, 1000-write batches, `WATCH`/`MULTI`/`EXEC` transactions against `transaction()`, and four contending writers. Each engine's turn starts after a full garbage collection, because otherwise one engine's garbage was collected inside the other's timed work. `docs/PERFORMANCE.md` has the results.

## 0.4.0

Breaking changes:

- The native entry `defuss-dbsonl/node` is renamed to `defuss-dbsonl/server`. Replace the import path; `createFileBackend` and its options are unchanged.
- The `defuss-dbsonl/legacy` subpath (the v0.1 log store) and the `defuss-dbsonl/records` frame API are removed, together with `examples/migrate.ts`. Migrate v0.1 data with defuss-dbsonl 0.3.x, then upgrade.

VERIFIED: Format 2 and the lock protocol are unchanged; the packed-package suite runs 0.2.0 and 0.4.0 writers concurrently against one database. `openDbsonl(..., { create: true })` completes an interrupted create: an empty head file whose generation files are all empty. Any persisted byte still fails closed with `CORRUPT`. Writer index-page loads use one known-length read. Browser tests cover directory-handle Storage through the format-2 API.

VERIFIED: Added a project website in `docs/index.html` whose demos run the library in the visitor's tab: a snapshot during transfers, a transaction conflict, a DSON round trip and an OPFS counter that survives reloads. `make e2e` drives every demo against the installed tarball. The npm package ships only the Markdown pages from `docs/`.

VERIFIED: `make bench` measures the vendored v0.2.0 and v0.3.0 builds beside the current build in one session. In three macOS arm64 runs, Bun ran some 0.4.0 read workloads slower than 0.3.0: snapshot reads and scans on memory storage by 20% to 26%, and scans on native storage by 12% to 34%. Node showed no consistent difference. `docs/PERFORMANCE.md` has the tables.

## 0.3.0

VERIFIED: Preserved format 2, all public operations, portable backends and legacy exports. Added per-database native descriptor ownership, local FIFO commit admission, nonblocking native lock attempts, concurrent positional reads and pipelined fresh-head/value reads. Metadata parsing is cached only while freshly read bytes match. Point values remain uncached and detached.

VERIFIED: Added bounded 64 KiB scan/compaction read-ahead and writer buffering before the existing durability barrier. Added repeated matched benchmarks against the shipped v0.2 tarball, Node/Bun equality-kernel measurements, mixed-version process tests and native resource/corruption regressions. Manual loop unrolling was measured and rejected for the shared implementation.

## 0.2.0

VERIFIED: Added persistent copy-on-write B+tree indexing, immutable snapshot roots, queued multi-client writers, atomic batches, optimistic serializable transactions, compare-and-swap revisions, streaming compaction, generation reclamation and full logical integrity verification. Native clients coordinate through whole-file OS locks; browser workers coordinate through Web Locks. Manifest publication uses two checksummed slots and a committed byte boundary.

VERIFIED: Added bounded page caching, aggregate pending-write admission, mixed Node/Bun process tests, SIGKILL coverage, browser-worker contention and a migration example. Retained the v0.1 implementation under `/legacy` and the unchanged frame API under `/records`. Root API and format are intentionally versioned changes; no automatic data rewrite occurs.

## 0.1.0

VERIFIED: Initial DSON framed record layer, append-only keyed log, bounded scans, explicit recovery inspection/repair and memory/native/browser adapter verification.
