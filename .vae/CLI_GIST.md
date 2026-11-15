# CLI gist

<!-- Commands future agents need that the Makefile verbs do not cover (setup, env, data, deploy):
- VERIFIED[purpose] `cmd`: only after an observed success
- UNKNOWN[purpose] BC gap
Budget 2 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->
- VERIFIED[sandboxed bun] `export BUN_TMPDIR=$TMPDIR BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache` before `bun install`|`make e2e`: else EPERM on tempdir
- VERIFIED[make e2e] needs loopback bind + Chromium launch; a sandbox without local binding fails with EADDRINUSE
- VERIFIED[mise] run `mise trust` once per checkout before `make setup`
- VERIFIED[make bench] run as `mise exec -- make bench`: a plain shell measures whatever `node` is on PATH (26.13.0 here), not the pinned 24.22.1
