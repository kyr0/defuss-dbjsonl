# Changelog

## 0.4.0

Breaking changes:

- The native entry `defuss-dbsonl/node` is renamed to `defuss-dbsonl/server`. Replace the import path; `createFileBackend` and its options are unchanged.
- The `defuss-dbsonl/legacy` subpath (the v0.1 log store) and the `defuss-dbsonl/records` frame API are removed, together with `examples/migrate.ts`. Migrate v0.1 data with defuss-dbsonl 0.3.x, then upgrade.

VERIFIED: Format 2 and the lock protocol are unchanged; the packed-package suite runs 0.2.0 and 0.4.0 writers concurrently against one database. `openDbsonl(..., { create: true })` completes an interrupted create: an empty head file whose generation files are all empty. Any persisted byte still fails closed with `CORRUPT`. Writer index-page loads use one known-length read. Browser tests cover directory-handle Storage through the format-2 API.

## 0.3.0

VERIFIED: Preserved format 2, all public operations, portable backends and legacy exports. Added per-database native descriptor ownership, local FIFO commit admission, nonblocking native lock attempts, concurrent positional reads and pipelined fresh-head/value reads. Metadata parsing is cached only while freshly read bytes match. Point values remain uncached and detached.

VERIFIED: Added bounded 64 KiB scan/compaction read-ahead and writer buffering before the existing durability barrier. Added repeated matched benchmarks against the shipped v0.2 tarball, Node/Bun equality-kernel measurements, mixed-version process tests and native resource/corruption regressions. Manual loop unrolling was measured and rejected for the shared implementation.

## 0.2.0

VERIFIED: Added persistent copy-on-write B+tree indexing, immutable snapshot roots, queued multi-client writers, atomic batches, optimistic serializable transactions, compare-and-swap revisions, streaming compaction, generation reclamation and full logical integrity verification. Native clients coordinate through whole-file OS locks; browser workers coordinate through Web Locks. Manifest publication uses two checksummed slots and a committed byte boundary.

VERIFIED: Added bounded page caching, aggregate pending-write admission, mixed Node/Bun process tests, SIGKILL coverage, browser-worker contention and a migration example. Retained the v0.1 implementation under `/legacy` and the unchanged frame API under `/records`. Root API and format are intentionally versioned changes; no automatic data rewrite occurs.

## 0.1.0

VERIFIED: Initial DSON framed record layer, append-only keyed log, bounded scans, explicit recovery inspection/repair and memory/native/browser adapter verification.
