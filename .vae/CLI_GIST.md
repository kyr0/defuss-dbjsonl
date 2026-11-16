# CLI gist

<!-- Commands future agents need that the Makefile verbs do not cover (setup, env, data, deploy):
- VERIFIED[purpose] `cmd`: only after an observed success
- UNKNOWN[purpose] BC gap
Budget 2 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->
- VERIFIED[sandboxed bun] `export BUN_TMPDIR=$TMPDIR BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache` before `bun install`|`make e2e`: else EPERM on tempdir
- VERIFIED[make e2e] needs loopback bind + Chromium launch; a sandbox without local binding fails with EADDRINUSE
- VERIFIED[mise] run `mise trust` once per checkout before `make setup`
- VERIFIED[make bench] run as `mise exec -- make bench`: a plain shell measures whatever `node` is on PATH (26.13.0 here), not the pinned 24.22.1
- VERIFIED[make bench-redis] run as `mise exec -- make bench-redis`: redis-server comes only from mise.toml; ~5 min per run on an M5 Max at load 6-11. Keep the turn open until it ends, with a blocking foreground wait (a Bash loop of at most 590 s per call): ending a turn runs the gate, whose `make e2e` rebuilds dist/ under the benchmark and loads the CPU, and a Monitor or background wait does not keep the turn open
- VERIFIED[redis probes] start a probe's redis-server as a child process (`redis-server ... &`), as bench-redis does, not with `--daemonize yes`: daemonized on macOS it ran 4-writer transfers 2.7x slower (140 vs 52 ms per 1000)
