# Architecture: website demos

VERIFIED: `docs/index.html` is a static page, served from the `docs/` folder. The four demos on it run the library in the visitor's tab, because a demo that calls the real package shows its behavior directly, and a recording or simulation would only describe it. `make site` bundles these sources into `docs/assets/` against the built `dist/` entries, not against `src/`, so the page runs the code a user installs.

| File | Purpose and reason |
| --- | --- |
| `demo.ts` | Main-thread demos on memory backends: a snapshot during transfers, a transaction that fails with `CONFLICT`, and a DSON round trip. Memory storage needs no worker and leaves nothing behind in the browser |
| `opfs.worker.ts` | A dedicated worker holding one OPFS database per origin. OPFS synchronous access handles exist only in dedicated workers; every tab uses one Web Locks namespace, so tabs share the database and retry `CONFLICT` explicitly |

VERIFIED: `make e2e` bundles both files against the installed tarball, serves the page from loopback and drives every demo in Chromium. The page loads defuss-shadcn styles, its shader runtime and fonts from public CDNs; the demos themselves send no network requests. The OPFS demo stores one integer in the visitor's origin private file system, and its delete button removes that key.
