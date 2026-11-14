# Architecture: browser workers

VERIFIED: `v2.ts` runs the packed library in dedicated module workers, because OPFS synchronous access handles exist only there. Two workers run concurrent transactions over shared OPFS files and Web Locks. A third, fresh worker checks the combined result, which also proves that reopening needs no realm-local state. It then confirms that an old snapshot survives writes and compaction and that the unpinned generation is reclaimed.

VERIFIED: The `directory` mode runs a transaction through `createDirectoryStorage` on a temporary OPFS directory handle. This tests the directory-handle adapter without asking for access to a user's folder.

The e2e server serves a blank page and the single bundle `v2.js` on loopback. Worker timeouts and browser launch failures fail the suite; no browser feature is silently skipped. The browser context is temporary and discarded after the run.
