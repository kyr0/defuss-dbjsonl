# Episodes

<!-- Newest last. The gate appends FAIL|DONE|FINDING; past 100 entries it trims only its own oldest DONE|FAIL|learned
FINDING (git keeps them). Leads (LESSON, FINDING learn=none) stay until wrap settles them; doctor fails above 30.
Agents append `<UTC ISO> s=<session> LESSON <VAE-DIALECT>` only for a falsified HYPOTHESIS, a dead end, or a root cause.
Session start injects the 3 newest open entries: LESSON, FINDING learn=none, FAIL without a later DONE.
Wrap: EVERY lead becomes a test | .vae/VERIFY.py rule | one MEMORY line with BC, then delete; OR delete BC evidence. -->

2026-11-14T13:56:12Z s=afa01d3f FINDING scripts/e2e.ts:69 learn=none: dev-harness fix; no proportionate mechanical check for every listen call
2026-11-14T13:56:12Z s=afa01d3f FINDING docs/LEGACY.md:13-28,45 learn=none: semantic doc drift; not mechanically checkable
2026-11-14T13:56:12Z s=afa01d3f FINDING ARCH.md:37; docs/PERFORMANCE.md:55,83 learn=none: semantic scope
2026-11-14T13:56:12Z s=afa01d3f FINDING docs/PERFORMANCE.md:3,81 learn=none: semantic evidence
2026-11-14T13:56:12Z s=afa01d3f FINDING tests/browser/ARCH.md:7; scripts/ARCH.md:3,12; tests/ARCH.md; src/legacy/ARCH.md:19; docs/legacy/ARCH.md:3; docs/legacy/API.md:3 learn=none: semantic doc drift
2026-11-14T14:32:48Z s=afa01d3f FINDING scripts/bench.ts:38 learn=none: report-text correctness; no proportionate mechanical check
2026-11-15T14:41:31Z s=afa01d3f FINDING site/demo.ts:conflicts learn=none: Demo-only control flow; forcing a memory put to fail needs a fault hook the public API does not offer, so no real-subsystem test can trigger it.
2026-11-15T14:41:31Z s=afa01d3f FINDING site/demo.ts:snapshots learn=none: Presentation state; the e2e run drives the transfer path.
2026-11-15T15:56:37Z s=afa01d3f FINDING docs/index.html:hero-title learn=none: Copy decision by the human; no mechanical check applies.
2026-11-15T16:01:02Z s=afa01d3f FINDING docs/index.html:hero-title learn=none: Copy accuracy; the types demo in e2e covers the round-trip behavior the copy describes.
2026-11-15T16:01:02Z s=afa01d3f FINDING docs/index.html:hero rotate learn=none: Component limit documented in its CSS comment; one-off markup.
2026-11-15T16:01:02Z s=afa01d3f FINDING docs/index.html:mk-hero-desc learn=none: Prose repetition; not mechanically checkable.
2026-11-15T16:06:10Z s=afa01d3f FINDING docs/PERFORMANCE.md:intro learn=none: Reference wording; not mechanically checkable.
2026-11-15T16:06:10Z s=afa01d3f FINDING docs/index.html:hero-title learn=none: Copy accuracy; the e2e types demo covers the round trip.
2026-11-15T16:06:10Z s=afa01d3f FINDING docs/index.html:hero rotate learn=none: Component limit documented in its CSS; one-off markup.
2026-11-15T16:06:10Z s=afa01d3f FINDING site/demo.ts:conflicts learn=none: Demo-only control flow; forcing a memory put to fail needs a fault hook the public API does not offer.
2026-11-15T16:09:19Z s=afa01d3f FINDING docs/index.html:#tests learn=none: Keeping them current needs either generating the page section from output/coverage at make site time or a check against coverage-summary; neither exists yet. Ra
2026-11-15T16:09:19Z s=afa01d3f FINDING docs/index.html:#stack learn=none: Positioning copy; README carries the same sentence.
2026-11-15T16:09:19Z s=afa01d3f FINDING docs/index.html:hero rotate learn=none: Component limit documented in its CSS.
2026-11-15T16:10:10Z s=afa01d3f FINDING docs/index.html:#why open card learn=none: Copy accuracy; checked against ARCH.md and the benchmark file.
2026-11-15T16:22:10Z s=afa01d3f FINDING docs/index.html:#tests rings learn=none: Component behavior read from its source; one-off markup.
2026-11-15T16:24:56Z s=afa01d3f DONE fp=687e2d8a3383 cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/PERFORMANCE.md(+14)
2026-11-15T16:24:56Z s=afa01d3f FINDING scripts/bench.ts:baselines learn=none: Benchmark harness change; checksum mismatch throws before measuring, which is the mechanical guard.
2026-11-15T16:31:44Z s=afa01d3f DONE fp=9a69bd6697f6 cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/PERFORMANCE.md(+15)
2026-11-15T16:31:44Z s=afa01d3f FINDING docs/PERFORMANCE.md:3 B01 learn=none: Root cause not established; no regression test before the cause is known (timing assertions are banned in correctness tests by tests/ARCH.md). Raised to the hum
2026-11-15T17:13:42Z s=afa01d3f DONE fp=89cd6e38f4e4 cov=97.9% paths=docs/index.html
2026-11-15T17:13:42Z s=afa01d3f FINDING docs/index.html:hero transfer.ts learn=none: Example copy checked against docs/API.md and the demo behavior covered by make e2e.
2026-11-15T17:14:05Z s=afa01d3f DONE fp=8696f346acff cov=97.9% paths=docs/index.html
2026-11-15T17:14:05Z s=afa01d3f FINDING docs/index.html:#stack learn=none: One-off link.
2026-11-15T17:15:10Z s=afa01d3f DONE fp=5ea587c862f4 cov=97.9% paths=docs/PERFORMANCE.md,docs/index.html
2026-11-15T17:15:10Z s=afa01d3f FINDING docs/index.html:#performance learn=none: Label copy; Node.js embeds V8 and Bun embeds JavaScriptCore.
2026-11-16T11:11:19Z s=85830ead FAIL prose,tests.e2e.1
2026-11-16T11:43:21Z s=85830ead FAIL tests.e2e.1
2026-11-16T11:46:21Z s=85830ead DONE fp=f666524387df cov=97.9% paths=CHANGELOG.md,Makefile,README.md,bun.lock(+14)
2026-11-16T11:46:21Z s=85830ead FINDING scripts/bench-redis.ts:configGet dir learn=none: The guard itself is the mechanical check and runs on every make bench-redis.
2026-11-16T11:46:21Z s=85830ead FINDING scripts/e2e.ts:WebKit pass learn=test: make e2e now drives both.
2026-11-16T11:46:21Z s=85830ead FINDING scripts/e2e.ts:db-sheet wait learn=none: One-off test-code defect; the passing e2e run covers it.
2026-11-16T11:46:21Z s=85830ead FINDING site/opfs.worker.ts:open learn=none: Whether a transient open failure caused the iPhone report is not established; no device was available.
2026-11-16T11:46:21Z s=85830ead FINDING site/ARCH.md:9 L01 learn=none: Wording fix.
2026-11-16T11:46:21Z s=85830ead FINDING CHANGELOG.md:7 P04 learn=none: Wording fix.
2026-11-16T11:46:21Z s=85830ead FINDING docs/PERFORMANCE.md:46 B03 learn=none: Wording fix.
2026-11-16T11:46:21Z s=85830ead FINDING docs/index.html:.table tbody .table-row:nth-child(even) learn=none: Root cause documented in the CSS comment; no rule kind can check rendered color.
2026-11-16T11:46:21Z s=85830ead FINDING docs/index.html:.db-install .tab-list learn=none: Visual layout; e2e asserts no sideways page scroll, not label truncation.
2026-11-16T11:46:21Z s=85830ead FINDING docs/index.html:.db-points learn=none: Visual layout.
2026-11-16T11:46:21Z s=85830ead FINDING scripts/redis-worker.ts:connect learn=none: Comment only.
2026-11-16T14:41:29Z s=85830ead FAIL tests.e2e.1
2026-11-16T15:04:31Z s=85830ead DONE fp=8c3f1625d53b cov=98.1% paths=ARCH.md,CHANGELOG.md,Makefile,README.md(+24)
2026-11-16T15:04:31Z s=85830ead FINDING src/core/tree.ts:BatchTree.finish, src/core/store.ts:commit learn=none: Only a tree-construction defect could trigger it; no real input produces an invalid page to test with.
2026-11-16T15:04:31Z s=85830ead FINDING tests/native-performance.test.ts:descriptor test learn=test: The bound is the documented resource contract (docs/API.md, ARCH.md) and now runs on both platforms.
2026-11-16T15:04:31Z s=85830ead FINDING src/server.ts:connect.retire learn=test: The descriptor test counts descriptors under the database root after five compact+collect cycles.
2026-11-16T15:04:31Z s=85830ead FINDING docs/assets/demo.js, docs/assets/opfs.worker.js learn=test: The e2e byte comparison already catches it.
2026-11-16T15:04:31Z s=85830ead FINDING gate tests.e2e.1 goto timeout learn=memory: CLI_GIST line: keep the turn open until bench-redis ends.
2026-11-16T16:02:49Z s=85830ead DONE fp=e2c829653ed9 cov=97.8% paths=ARCH.md,CHANGELOG.md,Makefile,README.md(+28)
2026-11-16T16:02:49Z s=85830ead FINDING src/core/store.ts:drain learn=none: A test that queued the commit from the cancelled member's rejection handler passed with and without the fix; the window depends on microtask order inside the co
2026-11-16T16:02:49Z s=85830ead FINDING src/core/store.ts:close learn=none: Release after connection close was already handled by the release function; no deterministic failing case observed.
2026-11-16T16:02:49Z s=85830ead FINDING src/core/codec.ts:frame learn=test: Byte comparison after the reset catches stale table entries.
2026-11-16T16:02:49Z s=85830ead FINDING src/core/store.ts:awaitSiblings (removed) learn=none: Documented in docs/PERFORMANCE.md as a rejected experiment.
2026-11-16T16:02:49Z s=85830ead FINDING src/core/codec.ts:allocate (removed) learn=none: Documented in docs/PERFORMANCE.md.
2026-11-16T16:02:49Z s=85830ead FINDING tests/commit-groups.test.ts learn=none: Test code only.
2026-11-16T16:02:49Z s=85830ead FINDING tests/codec.test.ts:generator learn=test: The generator exercises the edge directly.
2026-11-16T17:42:02Z s=85830ead FAIL tests.e2e.1
2026-11-16T17:59:39Z s=85830ead DONE fp=2a352924b1b4 cov=97.5% paths=ARCH.md,CHANGELOG.md,Makefile,README.md(+26)
2026-11-16T17:59:39Z s=85830ead FINDING src/core/io.ts:publish, Appender.value; src/core/store.ts:encode learn=none: Cross-version reading stays gated by make e2e, which runs the 0.2.0 tarball with its own defuss-dson 1.3.0 concurrently with the new build on one database.
2026-11-16T17:59:39Z s=85830ead FINDING validation/bench-redis-macos-arm64.json learn=none: Process-to-process variance under Bun; the isolated checked read loop was faster on 1.4.0 (8.6-15 vs 20-24 ms).
2026-11-16T17:59:39Z s=85830ead FINDING .vae/CLI_GIST.md learn=memory: CLI_GIST now says a Monitor or background wait does not keep the turn open.
2026-11-16T19:03:10Z s=85830ead DONE fp=3c3dc90aaa1f cov=97.7% paths=ARCH.md,CHANGELOG.md,Makefile,README.md(+28)
2026-11-16T19:03:10Z s=85830ead FINDING src/core/store.ts:drain/gather learn=test: commit-groups.test.ts 'full groups' fails without gather (50 publications for 100 commits) and passes with it (<= 35).
2026-11-16T19:03:10Z s=85830ead FINDING src/core/store.ts:gather bound learn=test: commit-groups.test.ts 'keeps its snapshot open' runs 20 puts while a transaction waits on a gate and asserts it is still pending afterwards.
2026-11-16T19:03:10Z s=85830ead FINDING src/core/store.ts:drain readHead learn=none: Equivalent outcome by code reading; retries in publishGroup still pass no head and re-read it.
2026-11-16T19:03:10Z s=85830ead FINDING src/core/store.ts:cached/remember learn=test: mvcc.test.ts still bounds cachePages and cacheBytes at 2 pages and 1024 bytes.
2026-11-16T19:03:10Z s=85830ead FINDING src/core/page.ts learn=test: page.test.ts; make e2e has 0.2.0 on DSON 1.3.0 read the frames concurrently.
2026-11-16T19:03:10Z s=85830ead FINDING scripts/redis-worker.ts:collect learn=none: Documented in docs/PERFORMANCE.md: it turned Bun's memory batch from 0.47 to 1.61 of Redis's time.
2026-11-16T19:03:10Z s=85830ead FINDING tree.ts split threshold (probe, reverted) learn=none: Documented as rejected in docs/PERFORMANCE.md.
2026-11-16T19:03:10Z s=85830ead FINDING .vae/CLI_GIST.md learn=memory: CLI_GIST line 'redis probes'.
2026-11-16T19:37:01Z s=85830ead DONE fp=43ef50f1b78a cov=97.7% paths=ARCH.md,CHANGELOG.md,Makefile,README.md(+28)
2026-11-16T19:37:01Z s=85830ead FINDING package.json:version learn=none: Version bump only; no code path changed.
2026-11-16T19:57:55Z s=a4ea8ca3 DONE fp=02e07bd46195 cov=98.4% paths=CHANGELOG.md,README.md,docs/PERFORMANCE.md,docs/index.html(+5)
2026-11-16T19:57:55Z s=a4ea8ca3 FINDING README.md:17 (B evidence) learn=none: Prose evidence slip; not mechanically checkable.
2026-11-16T19:57:55Z s=a4ea8ca3 FINDING docs/index.html: What you get, Guarantees, conflict demo, page-cache and several-writers cards (L logic) learn=none: Semantic doc drift; no deterministic rule distinguishes old from new wording.
2026-11-16T19:57:55Z s=a4ea8ca3 FINDING tests/contracts.test.ts:coordinator test learn=test: The fixed test itself covers the cancelled native wait.
2026-11-16T19:57:55Z s=a4ea8ca3 FINDING docs/PERFORMANCE.md macOS section (B evidence) learn=none: Prose evidence slip.
2026-11-16T21:13:21Z s=a4ea8ca3 DONE fp=543003b319f9 cov=98.4% paths=CHANGELOG.md,README.md,docs/PERFORMANCE.md,docs/index.html(+8)
2026-11-16T21:13:21Z s=a4ea8ca3 FINDING docs/index.html:dumbbell (chart mount) learn=test: scripts/e2e.ts asserts both chart descriptions in Chromium; the check failed on the previous markup per the probe.
2026-11-16T21:13:21Z s=a4ea8ca3 FINDING docs/index.html:.db-vs-gauge learn=test: make e2e already fails on sideways scroll at iPhone size and now waits for both charts before measuring.
2026-11-16T21:13:21Z s=a4ea8ca3 FINDING docs/index.html:Redis comparison script guard learn=none: A CDN outage is not reproducible in e2e without blocking the request; proportionate check would mock the network, which the project rules forbid.
2026-11-16T21:13:21Z s=a4ea8ca3 FINDING docs/index.html:RUNS learn=none: Figures change only with a new benchmark run; a test pinning them would pin values that worked once.
2026-11-16T22:12:24Z s=a4ea8ca3 DONE fp=5dd8028ce88f cov=98.4% paths=CHANGELOG.md,Makefile,README.md,docs/API.md(+24)
2026-11-16T22:12:24Z s=a4ea8ca3 FINDING docs/assets/demo.js learn=verifier: scripts/e2e.ts already compares the committed bundles with a fresh build and caught it.
2026-11-16T22:12:24Z s=a4ea8ca3 FINDING docs/API.md scanBatches paragraph (handoff wording) learn=test: tests/batches.test.ts 'invalid options throw, an oversized row fails its batch after earlier batches...'.
2026-11-16T22:12:24Z s=a4ea8ca3 FINDING src/core/store.ts:scanBatches sizeOf learn=test: tests/batches.test.ts asserts the three rejected sizes.
2026-11-16T22:12:24Z s=a4ea8ca3 FINDING src/index.ts:BatchScanOptions learn=none: pkgroll reports this as a warning, not an exit code; failing the build on dts warnings would be a broader tooling change.
2026-11-16T22:12:24Z s=a4ea8ca3 FINDING src/core/io.ts:readValue, src/core/store.ts:cachedValue learn=none: Structure cleanup, no defect.
2026-11-16T22:12:24Z s=a4ea8ca3 FINDING scripts/bench-scan.ts:record learn=none: Naming only.
2026-11-16T22:12:24Z s=a4ea8ca3 FINDING src/core/io.ts read window on portable backends learn=test: Covered by the stable-snapshot case on memory and native storage and the OPFS worker case.
2026-11-17T00:12:30Z s=a4ea8ca3 DONE fp=029ee2b849b2 cov=98.4% paths=CHANGELOG.md,Makefile,README.md,bun.lock(+26)
2026-11-17T00:12:30Z s=a4ea8ca3 FINDING src/core/io.ts:readCachedValues learn=memory: A performance threshold test would pin a machine-specific value; the lesson is a .vae/MEMORY.md line and a code comment.
2026-11-17T00:12:30Z s=a4ea8ca3 FINDING CHANGELOG.md:0.6.0 P-precision learn=none: Wording only.
2026-11-17T00:12:30Z s=a4ea8ca3 FINDING src/core/store.ts:scanBatches run decode learn=test: Covered by the new batches test.
2026-11-17T00:40:14Z s=a4ea8ca3 DONE fp=743c0f73c4af cov=98.4% paths=CHANGELOG.md,Makefile,README.md,bun.lock(+26)
2026-11-17T00:40:14Z s=a4ea8ca3 FINDING src/core/io.ts:readCachedValues learn=none: Simplification; behavior covered by the existing batches test.
