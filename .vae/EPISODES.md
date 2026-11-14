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
