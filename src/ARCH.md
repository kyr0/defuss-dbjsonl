# Runtime boundaries

VERIFIED: The package has three entries because the platform capabilities they need cannot share one bundle. `index.ts` exports the portable engine and the memory backend; its declarations compile with neither Node nor DOM ambient types, so any runtime can import it. `server.ts` adds kernel locks and directory sync for Node.js and Bun. `browser.ts` adapts Web Locks through a structural interface. A single entry with runtime detection would pull the native addon and `node:fs` into browser bundles.

VERIFIED: `core/` owns formats 2, 3 and 4 and their commit protocol and imports no platform API. Platform code reaches it only through the `Backend` contract in `core/types.ts`, so a new platform needs a backend, not engine changes.

VERIFIED: `kept-files.ts` keeps the native head and generation files open between commits for every handle of a database in the JS realm; it lives beside the native backend because only native Storage has shared writers whose size follows other processes' writes (ARCH.md, read descriptors).

VERIFIED: `scan-pool.ts` and `scan-worker.ts` run large `scanBatches` calls of native backends in worker threads. The pool lives beside the native backend, not in `core/`, because worker threads are a Node.js and Bun API; the engine sees only the optional `parallel` capability of the `Backend` contract. The worker entry is a build entry of its own, `dist/scan-worker.mjs`, which the server build finds next to itself. Spawning the server module itself would run a bundled application's whole code in every worker; a missing worker file only turns the pool off. From TypeScript source, as in the test suite, Node loads `scan-worker.ts` with its type transform and a resolver that maps `.js` specifiers to `.ts` files.

VERIFIED: Native locking uses one pinned addon because standard Node APIs expose no `flock`. The alternative, lock files with a stale-time heuristic, can hand ownership to a second writer while a paused first writer still believes it holds the lock.

VERIFIED: Native factories derive write chunk sizes from Storage admission limits. Browser backends take the chunk size as an argument, because their Storage limits are configured by the application. Mutations and portable reads close their Storage handle before releasing the matching lock, because OPFS handles are exclusive. Native connections own reusable read-only descriptors separately; pins and the commit lock protect the immutable ranges they read. The root ARCH.md covers privacy, failure ordering and platform guarantees.
