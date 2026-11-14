# Examples

VERIFIED: `basic.ts` stores and reads a typed value with a `Date` and scans a snapshot. `transaction.ts` shows an atomic transfer, a stable snapshot and compaction. Both use memory storage, so they run without filesystem access or a platform entry.

VERIFIED: `make e2e` runs both examples from the installed tarball rather than from this folder. A source-tree run would pass even when an example used an API the package does not export. No example contacts a network service.
