/** VERIFIED: extracts the pinned, unmodified VAE runtime after SHA-256 verification. */
import { readFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const pin = JSON.parse(await readFile('vendor/vae.json', 'utf8')) as { archive: string; sha256: string };
const archive = resolve('vendor', pin.archive);
const bytes = await readFile(archive);
if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('VAE archive checksum mismatch.');
const destination = resolve('tmp/vae-tooling');
await mkdir(destination, { recursive: true });
execFileSync('python3', ['-m', 'zipfile', '-e', archive, destination]);
try { await access('.git'); } catch { execFileSync('git', ['init', '-q', '.']); }
console.log('Pinned defuss-vae runtime is ready.');
