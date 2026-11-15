/** VERIFIED: Bundles the website demos against the built package entries, never against src/. */
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Usage: bun scripts/site.ts [outdir] [package root]. The e2e run passes the installed tarball as package root.
const [outdir = 'docs/assets', root = '.'] = process.argv.slice(2);
const entry = (name: string) => resolve(root, 'dist', `${name}.mjs`);
await build({
  entryPoints: { demo: 'site/demo.ts', 'opfs.worker': 'site/opfs.worker.ts' },
  outdir, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none',
  // Aliasing to dist keeps the page on the same code a user installs.
  alias: { 'defuss-dbsonl': entry('index'), 'defuss-dbsonl/browser': entry('browser') },
  // dist imports defuss-storage for its types only; the package declares no side effects, so esbuild drops it.
  logOverride: { 'ignored-bare-import': 'silent' },
  nodePaths: [resolve(root, 'node_modules'), resolve(root, '..')],
});
console.log(`${new Date().toISOString()} INFO site bundled outdir=${outdir} package=${resolve(root)}`);
