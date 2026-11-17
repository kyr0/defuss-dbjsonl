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
