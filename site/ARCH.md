# Architecture: website demos

VERIFIED: `docs/index.html` is a static page, served from the `docs/` folder. The four demos on it run the library in the visitor's tab, because a demo that calls the real package shows its behavior directly, and a recording or simulation would only describe it. `make site` bundles these sources into `docs/assets/` against the built `dist/` entries, not against `src/`, so the page runs the code a user installs.

| File | Purpose and reason |
| --- | --- |
| `demo.ts` | Main-thread demos on memory backends: a snapshot during transfers, a transaction that fails with `CONFLICT`, and a DSON round trip. Memory storage needs no worker and leaves nothing behind in the browser |
| `opfs.worker.ts` | A dedicated worker holding one OPFS database per origin. OPFS synchronous access handles exist only in dedicated workers; every tab uses one Web Locks namespace, so tabs share the database and retry `CONFLICT` explicitly |

VERIFIED: The page replaces a worker that leaves a request unanswered for 5 s, once per silence, and reports it in the status line. Ending a worker releases its Web Locks and OPFS handles, so the replacement can open the database; after a second silence the page reports it and stops replacing workers; the next click goes to a fresh one. Worker errors show the error code and the browser error behind it, so a failure on a device we cannot test names its cause. A failed open is not cached; the next request opens again, so one transient OPFS error does not disable the demo until reload.

VERIFIED: `make e2e` bundles both files against the installed tarball, serves the page from loopback and drives every demo in Chromium, then the OPFS and DSON demos in WebKit at iPhone size, where it also checks that the page does not scroll sideways. The page loads defuss-shadcn styles, its shader runtime and fonts from public CDNs; the demos themselves send no network requests. The OPFS demo stores one integer in the visitor's origin private file system, and its delete button removes that key.
