# Agent memory

<!-- One tagged line per durable fact NOT derivable from code, git or docs:
- VERIFIED[scope] fact BC evidence
- HYPOTHESIS[scope] claim BC observation; falsifier=`cmd`
- UNKNOWN[scope] gap BC missing evidence
[scope] = the narrowest path|module|command|condition the evidence covers, not a topic: the entry decides nothing
outside it, and recurrence inside one subsystem never widens it.
Every line carries its BC and stays within 240 chars. Replace stale lines instead of appending.
Mechanizable lessons belong in tests or .vae/VERIFY.py.
Budget 4 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->
- VERIFIED[Bun, defuss-dson 1.5.0 decodeFrame(s) at an offset] offsets held as doubles (decoded refs) deoptimized the reader, scanBatches 0.70 vs 0.52 of 0.5.0; 1.5.1 converts them itself BC OSR exits 503→0 with int32
- VERIFIED[defuss-db bench store, Node 26/Bun 1.4.4] format 4 compact pages: 100k load 13.0-15.7→8.7-9.5 s, 11→5 compactions, 102→33 MiB; warm reads unchanged; Bun get is bimodal 13/23 µs in every format, not a format effect BC A/B 2026-11-21
- VERIFIED[release tarballs] make verify (e2e) repacks output/defuss-dbsonl-<package.json version>.tgz from the working tree: after packing a release, move its tarball to output/release-<version>/ and bump the version before changing code, or the tarball to publish is overwritten BC 0.8.1 tarball overwritten by format 5 work 2026-11-21, restored from the release ZIP (sha512 kGduxs45…)
