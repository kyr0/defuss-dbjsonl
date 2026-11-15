# Episodes

<!-- Newest last. The gate appends FAIL|DONE|FINDING; past 100 entries it trims only its own oldest DONE|FAIL|learned
FINDING (git keeps them). Leads (LESSON, FINDING learn=none) stay until wrap settles them; doctor fails above 30.
Agents append `<UTC ISO> s=<session> LESSON <VAE-DIALECT>` only for a falsified HYPOTHESIS, a dead end, or a root cause.
Session start injects the 3 newest open entries: LESSON, FINDING learn=none, FAIL without a later DONE.
Wrap: EVERY lead becomes a test | .vae/VERIFY.py rule | one MEMORY line with BC, then delete; OR delete BC evidence. -->

2026-11-14T13:56:12Z s=afa01d3f DONE fp=3e7d757a42cd cov=98.3% paths=AGENTS.md,ARCH.md,CHANGELOG.md,Makefile(+82)
2026-11-14T13:56:12Z s=afa01d3f FINDING src/core/store.ts:openDbsonl learn=test: tests/v2-recovery.test.ts 'an interrupted create is recoverable…' covers recovery, collect of the orphan and the fail-closed truncated-head case
2026-11-14T13:56:12Z s=afa01d3f FINDING scripts/e2e.ts:69 learn=none: dev-harness fix; no proportionate mechanical check for every listen call
2026-11-14T13:56:12Z s=afa01d3f FINDING scripts/check-architecture.ts:5 learn=verifier: make lint runs check-architecture on every gate
2026-11-14T13:56:12Z s=afa01d3f FINDING .env.example learn=verifier: VAE gate checks env keys against .env.example
2026-11-14T13:56:12Z s=afa01d3f FINDING docs/LEGACY.md:13-28,45 learn=none: semantic doc drift; not mechanically checkable
2026-11-14T13:56:12Z s=afa01d3f FINDING ARCH.md:37; docs/PERFORMANCE.md:55,83 learn=none: semantic scope
2026-11-14T13:56:12Z s=afa01d3f FINDING docs/PERFORMANCE.md:3,81 learn=none: semantic evidence
2026-11-14T13:56:12Z s=afa01d3f FINDING tests/browser/ARCH.md:7; scripts/ARCH.md:3,12; tests/ARCH.md; src/legacy/ARCH.md:19; docs/legacy/ARCH.md:3; docs/legacy/API.md:3 learn=none: semantic doc drift
2026-11-14T14:32:48Z s=afa01d3f DONE fp=2119d9b29837 cov=97.9% paths=AGENTS.md,ARCH.md,CHANGELOG.md,Makefile(+52)
2026-11-14T14:32:48Z s=afa01d3f FINDING scripts/bench.ts:38 learn=none: report-text correctness; no proportionate mechanical check
2026-11-14T14:32:48Z s=afa01d3f FINDING scripts/e2e.ts:43 learn=test: make e2e fails if the baseline import is not rewritten
2026-11-14T14:32:48Z s=afa01d3f FINDING README.md:99 learn=verifier: vae.py prose flags it
2026-11-14T14:32:48Z s=afa01d3f FINDING src/core/io.ts:Appender.read learn=test: tests/mvcc.test.ts tree-growth and long-key budget tests load committed pages through Appender.read
2026-11-15T14:41:31Z s=afa01d3f DONE fp=a5cc221cb1bb cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/assets/demo.js(+11)
2026-11-15T14:41:31Z s=afa01d3f FINDING site/demo.ts:conflicts learn=none: Demo-only control flow; forcing a memory put to fail needs a fault hook the public API does not offer, so no real-subsystem test can trigger it.
2026-11-15T14:41:31Z s=afa01d3f FINDING site/demo.ts:snapshots learn=none: Presentation state; the e2e run drives the transfer path.
2026-11-15T14:41:31Z s=afa01d3f FINDING docs/index.html:head learn=test: sha384 integrity on every jsdelivr asset; scripts/e2e.ts waits for the three shader canvases, which fail to mount if an integrity check blocks the runtime.
2026-11-15T14:41:31Z s=afa01d3f FINDING scripts/e2e.ts:website learn=test: scripts/e2e.ts compares docs/assets byte for byte with a fresh bundle built from the packed tarball and fails with 'run make site'.
2026-11-15T15:34:38Z s=afa01d3f DONE fp=cec39c5b7f43 cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/assets/demo.js(+11)
2026-11-15T15:56:37Z s=afa01d3f DONE fp=d78d0d4d2c51 cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/assets/demo.js(+11)
2026-11-15T15:56:37Z s=afa01d3f FINDING docs/index.html:hero-title learn=none: Copy decision by the human; no mechanical check applies.
2026-11-15T16:01:02Z s=afa01d3f DONE fp=a7a30f9fbf01 cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/assets/demo.js(+11)
2026-11-15T16:01:02Z s=afa01d3f FINDING docs/index.html:hero-title learn=none: Copy accuracy; the types demo in e2e covers the round-trip behavior the copy describes.
2026-11-15T16:01:02Z s=afa01d3f FINDING docs/index.html:hero rotate learn=none: Component limit documented in its CSS comment; one-off markup.
2026-11-15T16:01:02Z s=afa01d3f FINDING docs/index.html:mk-hero-desc learn=none: Prose repetition; not mechanically checkable.
2026-11-15T16:06:10Z s=afa01d3f DONE fp=8f0cfbab4453 cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/PERFORMANCE.md(+13)
2026-11-15T16:06:10Z s=afa01d3f FINDING docs/index.html:#performance learn=memory: .vae/CLI_GIST.md: run make bench as mise exec -- make bench.
2026-11-15T16:06:10Z s=afa01d3f FINDING docs/PERFORMANCE.md:intro learn=none: Reference wording; not mechanically checkable.
2026-11-15T16:06:10Z s=afa01d3f FINDING docs/index.html:hero-title learn=none: Copy accuracy; the e2e types demo covers the round trip.
2026-11-15T16:06:10Z s=afa01d3f FINDING docs/index.html:hero rotate learn=none: Component limit documented in its CSS; one-off markup.
2026-11-15T16:06:10Z s=afa01d3f FINDING site/demo.ts:conflicts learn=none: Demo-only control flow; forcing a memory put to fail needs a fault hook the public API does not offer.
2026-11-15T16:06:10Z s=afa01d3f FINDING docs/index.html:head learn=test: sha384 integrity on every jsdelivr asset; scripts/e2e.ts waits for the three shader canvases.
2026-11-15T16:06:10Z s=afa01d3f FINDING scripts/e2e.ts:website learn=test: scripts/e2e.ts compares docs/assets byte for byte with a fresh bundle from the packed tarball.
2026-11-15T16:09:19Z s=afa01d3f DONE fp=ab61a144f7c0 cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/PERFORMANCE.md(+13)
2026-11-15T16:09:19Z s=afa01d3f FINDING docs/index.html:#tests learn=none: Keeping them current needs either generating the page section from output/coverage at make site time or a check against coverage-summary; neither exists yet. Ra
2026-11-15T16:09:19Z s=afa01d3f FINDING docs/index.html:#stack learn=none: Positioning copy; README carries the same sentence.
2026-11-15T16:09:19Z s=afa01d3f FINDING docs/index.html:hero rotate learn=none: Component limit documented in its CSS.
2026-11-15T16:10:10Z s=afa01d3f DONE fp=4fb22c135ca7 cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/PERFORMANCE.md(+13)
2026-11-15T16:10:10Z s=afa01d3f FINDING docs/index.html:#why open card learn=none: Copy accuracy; checked against ARCH.md and the benchmark file.
2026-11-15T16:22:10Z s=afa01d3f DONE fp=04dc18d42ba9 cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/PERFORMANCE.md(+13)
2026-11-15T16:22:10Z s=afa01d3f FINDING docs/index.html:#tests rings learn=none: Component behavior read from its source; one-off markup.
2026-11-15T16:24:56Z s=afa01d3f DONE fp=687e2d8a3383 cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/PERFORMANCE.md(+14)
2026-11-15T16:24:56Z s=afa01d3f FINDING scripts/bench.ts:baselines learn=none: Benchmark harness change; checksum mismatch throws before measuring, which is the mechanical guard.
2026-11-15T16:31:44Z s=afa01d3f DONE fp=9a69bd6697f6 cov=97.9% paths=CHANGELOG.md,Makefile,README.md,docs/PERFORMANCE.md(+15)
2026-11-15T16:31:44Z s=afa01d3f FINDING docs/PERFORMANCE.md:3 B01 learn=none: Root cause not established; no regression test before the cause is known (timing assertions are banned in correctness tests by tests/ARCH.md). Raised to the hum
