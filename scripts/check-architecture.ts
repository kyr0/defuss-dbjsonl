/** VERIFIED: every directory containing authored source must carry an ARCH.md. */
import { readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
// .vae holds agent state and verifier policy, not package source.
const excluded = new Set(['node_modules', '.git', '.vae', 'dist', 'tmp', 'output', 'var']);
// docs/assets holds bundles that `make site` generates from site/, which carries the ARCH.md.
const generated = new Set(['docs/assets']);
const missing: string[] = [];
async function walk(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (generated.has(directory)) return;
  if (entries.some(entry => entry.isFile() && /\.(?:ts|cts|mts|js|mjs|cjs|py)$/.test(entry.name))) {
    try { await access(join(directory, 'ARCH.md')); } catch { missing.push(directory); }
  }
  for (const entry of entries) if (entry.isDirectory() && !excluded.has(entry.name)) await walk(join(directory, entry.name));
}
await walk('.');
if (missing.length) throw new Error(`Missing ARCH.md: ${missing.join(', ')}`);
console.log('Source-directory architecture coverage passed.');
