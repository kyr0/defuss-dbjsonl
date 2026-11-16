# Architecture: development scripts

Scripts are TypeScript programs run by Bun; `compare-worker.ts` and `microbench.ts` also run under Node for benchmarks. Production runtime code never imports them.

| Script | Purpose and reason |
| --- | --- |
| `e2e.ts` | Packs, installs, typechecks and consumes exports, then drives every demo of the website against the installed build; detects packaging failures that source tests miss. Reads the version from package.json, so tarball names never drift |
| `bench.ts` | Runs isolated, matched Node/Bun benchmarks of the vendored v0.2.0 and v0.3.0 builds and the current build in one session, with two warmups and seven measured rounds, so builds are never compared across days or machine states |
| `bench-redis.ts` | Starts one throwaway Redis per durability mode on a free loopback port with its data in `tmp/`, runs `redis-worker.ts` under Node and Bun, and stops the server. A separate script because Redis is an external server and the build comparison must not depend on it |
| `redis-worker.ts` | Runs four asserted workloads on the current build and on Redis in the same process, alternating which engine goes first each round and collecting garbage before each engine's turn: point reads, a 1000-write atomic batch (`MULTI`/`EXEC`), sequential transfers (`WATCH`/`MULTI`/`EXEC` against `transaction()`) and four contending writers that retry conflicts |
| `compare-worker.ts` | Executes one asserted workload against an explicit built package, with raw samples; loads the native entry from `dist/server.mjs`, or `dist/node.mjs` for the 0.2.0 baseline |
| `microbench.ts` | Checks byte-equality correctness and compares scalar, word and unrolled loops |
| `site.ts` | Bundles the website demos from `site/` into `docs/assets/`, resolving the package to built `dist/` entries; e2e passes the installed tarball instead |
| `check-architecture.ts` | Requires an ARCH.md in every authored source directory, including tests and scripts |
| `vae.ts` | Verifies the bundled VAE archive checksum and extracts its unchanged runtime into temporary storage; initializes a Git repository when none exists |
| `release.ts` | Creates a complete source ZIP, tarball and integrity manifest without publishing; refuses to package unless the VAE gate passes for the current fingerprint |

The e2e server is loopback-only and serves an explicit path allowlist; e2e drives the website in Chromium and again in WebKit at iPhone size, where OPFS needs a persistent profile in `tmp/webkit-profile`. The Redis comparison binds its server to 127.0.0.1 with protected mode on, refuses a port whose server reports another data directory, and deletes its data directory afterwards. Package installation can contact the package registry, and the website check loads defuss-shadcn styles, its shader runtime and fonts from public CDNs. VAE extraction uses the bundled archive, so it needs no network request. Release scripts exclude dependencies, Git metadata, temporary state and browser profiles.

VERIFIED: Benchmarks compare the vendored v0.2.0 and v0.3.0 archives with the current build under matched guarantees. Each subprocess isolates its version and runtime. Raw samples, build SHA-256 hashes and host metadata are retained. `make bench-scale` repeats the native asynchronous comparison with 10000 records and three measured rounds. Results describe warm filesystem caches on one host, not another database or a universal performance ranking.
