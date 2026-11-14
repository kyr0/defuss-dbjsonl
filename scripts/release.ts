/** VERIFIED: packages reviewed sources and recorded evidence without remote mutation. */
import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
const gate = execFileSync('python3', ['tmp/vae-tooling/plugin/scripts/vae.py', 'gate', '--repo', '.', '--session', 'dbsonl-release'], { encoding: 'utf8' });
await mkdir('output', { recursive: true });
await mkdir('validation', { recursive: true });
for (const [from, to] of [['output/e2e.json', 'e2e.json'], ['output/coverage/coverage-summary.json', 'coverage-summary.json'], ['output/bench.json', 'bench.json']] as const) {
  await copyFile(from, `validation/${to}`);
}
// Keep scale measurements when they were run; the default benchmark is mandatory.
try { await copyFile('output/bench-scale.json', 'validation/bench-scale.json'); }
catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
// Rendered diagram evidence is optional on a fresh checkout; the Mermaid source is always included.
for (const extension of ['png', 'svg']) {
  try { await copyFile(`output/architecture.${extension}`, `validation/architecture.${extension}`); }
  catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
}
// The gate checks current fingerprints; stale attestations cannot authorize packaging.
await writeFile('validation/vae-gate.txt', gate);
execFileSync(process.execPath, ['pm', 'pack', '--destination', 'output'], { stdio: 'inherit' });
await copyFile(`output/defuss-dbsonl-${version}.tgz`, `validation/defuss-dbsonl-${version}.tgz`);
const excluded = new Set(['.git', 'node_modules', 'tmp', 'var', 'output', 'validation', '__pycache__']);
const files: string[] = [];
async function walk(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name === '.env' || entry.name === 'SHA256SUMS') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path); else if (entry.isFile()) files.push(path);
  }
}
await walk('.');
for (const name of await readdir('validation')) files.push(join('validation', name));
files.sort();
const sums: string[] = [];
for (const path of files) sums.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${path}`);
await writeFile('SHA256SUMS', sums.join('\n') + '\n');
files.push('SHA256SUMS');
const filename = `defuss-dbsonl-v${version}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.zip`;
const archive = resolve('output', filename);
// Python's stdlib ZIP writer avoids adding a packaging dependency to the runtime.
execFileSync('python3', ['-c', 'import json,sys,zipfile; data=json.load(sys.stdin); z=zipfile.ZipFile(data["archive"],"w",zipfile.ZIP_DEFLATED); [z.write(p,"defuss-dbsonl/"+p) for p in data["files"]]; z.close()'], { input: JSON.stringify({ archive, files }), stdio: ['pipe', 'inherit', 'inherit'] });
console.log(archive);
