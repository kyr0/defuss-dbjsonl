/** VERIFIED: every integration run installs and consumes the packed package in tmp. */
import { mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { build, transform } from 'esbuild';
import { chromium, devices, webkit } from 'playwright';
import { createHash } from 'node:crypto';

const root = process.cwd();
const consumer = resolve('tmp/consumer');
const output = resolve('output');
const bun = process.execPath;
const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
await mkdir(output, { recursive: true });
await rm(consumer, { recursive: true, force: true });
await mkdir(consumer, { recursive: true });
run(bun, ['pm', 'pack', '--destination', output]);
const tarball = resolve(output, `defuss-dbsonl-${version}.tgz`);
await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ name: 'dbsonl-clean-consumer', private: true, type: 'module', dependencies: { 'defuss-dbsonl': tarball } }));
run(bun, ['install', '--ignore-scripts'], consumer);
const compile = async (source: string, destination: string, format: 'esm' | 'cjs' = 'esm') =>
  writeFile(resolve(consumer, destination), (await transform(await readFile(source, 'utf8'), { loader: 'ts', format, target: 'es2022' })).code);
// Examples are taken from the installed package, proving they ship and run against its exports.
for (const name of ['basic', 'transaction']) { await compile(resolve(consumer, `node_modules/defuss-dbsonl/examples/${name}.ts`), `${name}.js`); run('node', [`${name}.js`], consumer); }
for (const name of ['esm', 'v2', 'v2-worker', 'parallel', 'parallel-worker']) await compile(`tests/consumers/${name}.ts`, `${name}.js`);
await compile('tests/consumers/v2-cjs.cts', 'v2-cjs.cjs', 'cjs');
const runtimes = [JSON.parse(run('node', ['esm.js'], consumer)), JSON.parse(run(bun, ['esm.js'], consumer))];
run('node', ['v2-cjs.cjs'], consumer); run(bun, ['v2-cjs.cjs'], consumer);
// Worker threads scan split() ranges of one pinned native snapshot under both runtimes.
const parallel = [JSON.parse(run('node', ['parallel.js'], consumer)), JSON.parse(run(bun, ['parallel.js'], consumer))];
// Consume the previously shipped artifact as well: format compatibility includes
// live lock interoperability, not merely reopening a copied fixture.
const baselineTarball = resolve('vendor/defuss-dbsonl-0.2.0.tgz');
if (createHash('sha256').update(await readFile(baselineTarball)).digest('hex') !== '90eaf0e5e6c78cc636f6fb9273cc0475a1e2220180ecd569f97bac7ad0a3fe1b') throw new Error('Compatibility baseline checksum mismatch.');
const baseline = resolve('tmp/compat-v020'); await mkdir(baseline, { recursive: true });
await writeFile(resolve(baseline, 'package.json'), JSON.stringify({ name: 'dbsonl-compat-v020', private: true, type: 'module', dependencies: { 'defuss-dbsonl': baselineTarball } }));
run(bun, ['install', '--ignore-scripts'], baseline);
// The same worker drives the 0.2.0 baseline, which ships its native entry as `/node`, not `/server`.
await writeFile(resolve(baseline, 'v2-worker.js'), (await readFile(resolve(consumer, 'v2-worker.js'), 'utf8')).replace(/(["'])defuss-dbsonl\/server\1/, '$1defuss-dbsonl/node$1'));
const v2 = JSON.parse(run('node', ['v2.js', bun, resolve(baseline, 'v2-worker.js')], consumer));
await copyFile('tests/consumers/v2-types.ts', resolve(consumer, 'v2-types.ts'));
await writeFile(resolve(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], lib: ['ES2022'], noEmit: true, skipLibCheck: false }, files: ['v2-types.ts'] }));
run('node', [resolve('node_modules/typescript/bin/tsc'), '-p', resolve(consumer, 'tsconfig.json')]);

await copyFile('tests/browser/v2.ts', resolve(consumer, 'browser.ts'));
const bundle = await build({ entryPoints: [resolve(consumer, 'browser.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: resolve(output, 'v2.js'), metafile: true });
if (Object.keys(bundle.metafile!.inputs).some(path => /defuss-dbsonl\/src\//.test(path))) throw new Error('Browser test accidentally imported workspace source.');
// The website demos are bundled against the installed tarball, so the page is tested on the code users receive.
run(bun, ['scripts/site.ts', resolve(output, 'site/assets'), resolve(consumer, 'node_modules/defuss-dbsonl')]);
const site: Record<string, [string, string]> = {
  '/site/': [resolve('docs/index.html'), 'text/html'],
  '/site/favicon.svg': [resolve('docs/favicon.svg'), 'image/svg+xml'],
  '/site/assets/demo.js': [resolve(output, 'site/assets/demo.js'), 'text/javascript'],
  '/site/assets/opfs.worker.js': [resolve(output, 'site/assets/opfs.worker.js'), 'text/javascript'],
};
const server = createServer(async (request, response) => {
  const path = request.url?.split('?')[0];
  if (path && site[path]) { response.setHeader('content-type', site[path][1]); response.end(await readFile(site[path][0])); return; }
  if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>DBSONL package verification</title>'); return; }
  if (path !== '/v2.js') { response.writeHead(404); response.end(); return; }
  response.setHeader('content-type', 'text/javascript'); response.end(await readFile(resolve(output, path.slice(1))));
});
// A refused bind must fail the run; without the error listener the listen Promise never settles.
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    ...(process.env.CHROMIUM_ARGS ? { args: JSON.parse(process.env.CHROMIUM_ARGS) as string[] } : {}),
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  const result = await page.evaluate(async () => {
    const namespace = `${Date.now()}`;
    const call = async (path: string, mode = ''): Promise<Record<string, unknown>> => {
      const worker = new Worker(path, { type: 'module' });
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Worker timed out.')), 45000);
          worker.onmessage = event => { clearTimeout(timer); if (event.data.ok) resolve(event.data); else reject(new Error(event.data.error)); };
          worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
          worker.postMessage({ namespace, mode });
        });
      } finally { worker.terminate(); }
    };
    await Promise.all([call('/v2.js', 'a'), call('/v2.js', 'b')]);
    await call('/v2.js', 'verify');
    await Promise.all([call('/v2.js', 'scan'), call('/v2.js', 'scan'), call('/v2.js', 'scan'), call('/v2.js', 'write')]);
    const split = await call('/v2.js', 'split');
    if (split.ranges !== 3 || !split.rows) throw new Error(`Split scan returned ${JSON.stringify(split)}.`);
    await call('/v2.js', 'directory');
    return { opfs: '30 concurrent worker transactions, snapshot isolation and compaction', parallel: 'three scanning workers beside a writing, compacting worker', split: `${split.rows} rows in 3 ranges of one pinned snapshot, scanned by nested workers`, restart: 'verified in a different worker', directory: 'transaction on a directory handle' };
  });
  // Every interactive element of the website runs once against the packed build.
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/site/`);
  await page.waitForSelector('html[data-demo-ready]', { timeout: 30000 });
  await page.waitForSelector('html[data-persist-ready]', { timeout: 30000 });
  await page.click('#snap-transfer');
  await page.waitForFunction(() => document.querySelector('#snap-live-alice')?.textContent === '80');
  if (await page.textContent('#snap-pin-alice') !== '100') throw new Error('Website snapshot changed after a transfer.');
  await page.click('#snap-refresh');
  await page.waitForFunction(() => document.querySelector('#snap-pin-alice')?.textContent === '80');
  await page.click('#conflict-run');
  await page.waitForFunction(() => document.querySelector('#conflict-log')?.textContent?.includes('CONFLICT'));
  await page.click('#conflict-retry');
  await page.waitForFunction(() => document.querySelector('#conflict-value')?.textContent === '11');
  await page.click('#types-run');
  await page.waitForFunction(() => document.querySelectorAll('#types-out tr[data-ok="true"]').length === 5);
  const before = Number(await page.textContent('#persist-count'));
  await page.click('#persist-inc');
  await page.waitForFunction(count => document.querySelector('#persist-count')?.textContent === String(count), before + 1);
  await page.reload();
  await page.waitForSelector('html[data-persist-ready]', { timeout: 30000 });
  if (Number(await page.textContent('#persist-count')) !== before + 1) throw new Error('Website counter did not survive a reload.');
  await page.click('#persist-reset');
  await page.waitForFunction(() => document.querySelector('#persist-count')?.textContent === '0');
  // The counter keeps working after a delete, where the demo was reported to stop on an iPhone.
  await page.click('#persist-inc');
  await page.waitForFunction(() => document.querySelector('#persist-count')?.textContent === '1');
  // A worker stuck behind a lock it cannot get is replaced after 5 s; the blocked increment never commits.
  await page.evaluate(() => new Promise<void>(held => {
    void navigator.locks.request('defuss-dbsonl:dbsonl-site-demo:commit-visits', () => new Promise<void>(release => { (window as unknown as { release: () => void }).release = release; held(); }));
  }));
  await page.click('#persist-inc');
  await page.waitForFunction(() => document.querySelector('#persist-status')?.textContent?.includes('did not answer'), undefined, { timeout: 9000 });
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await page.click('#persist-inc');
  await page.waitForFunction(() => document.querySelector('#persist-count')?.textContent === '2');
  // The shader runtime comes from a pinned, integrity-checked CDN file; three effects must have mounted their canvas.
  await page.waitForFunction(() => document.querySelectorAll('.shader canvas').length === 3, undefined, { timeout: 30000 });
  await page.click('#tab-browser');
  if (await page.isHidden('#use-browser')) throw new Error('Website install tabs did not switch.');
  // The Redis comparison: ECharts, pinned and integrity-checked, draws both dumbbell charts; the gauges open on Bun
  // flushed to disk and follow the runtime and storage switches, with one button of each group pressed.
  await page.waitForFunction(() => document.querySelectorAll('#redis .chart svg').length === 2, undefined, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#vs-contended .tacho-value')?.textContent === '3.2× faster');
  for (const value of ['node', 'volatile', 'volatile']) await page.click(`#redis .toggle[data-value="${value}"]`);
  await page.waitForFunction(() => document.querySelector('#vs-get .tacho-value')?.textContent === '3.2× faster' && document.querySelector('#vs-get-times')?.textContent === '14 µs against 47 µs');
  const pressed = await page.$$eval('#redis .toggle[aria-pressed="true"]', toggles => toggles.map(toggle => (toggle as HTMLElement).dataset.value).join(' '));
  if (pressed !== 'node volatile') throw new Error(`Website comparison switches show ${pressed} pressed.`);
  // ECharts replaces a chart container's aria-label with a generated text unless the option passes the authored one.
  const labels = await page.$$eval('#redis .chart', charts => charts.map(chart => chart.getAttribute('aria-label') ?? ''));
  if (!labels.every(label => label.startsWith('Dumbbell chart of the time per operation'))) throw new Error(`Website chart descriptions were replaced: ${labels.join(' | ')}`);
  if (errors.length) throw new Error(`Website errors: ${errors.join('; ')}`);
  // Safari's engine at iPhone size: OPFS needs a persistent profile there, and the page must not scroll sideways.
  const profile = resolve('tmp/webkit-profile'); await rm(profile, { recursive: true, force: true });
  const phone = await webkit.launchPersistentContext(profile, { ...devices['iPhone 15'] });
  try {
    const mobile = phone.pages()[0] ?? await phone.newPage();
    const mobileErrors: string[] = [];
    mobile.on('pageerror', error => mobileErrors.push(`${error.message} ${error.stack ?? ''}`));
    await mobile.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/site/`);
    await mobile.waitForSelector('html[data-demo-ready]', { timeout: 30000 });
    await mobile.waitForSelector('html[data-persist-ready]', { timeout: 30000 });
    for (const [button, count] of [['#persist-inc', '1'], ['#persist-reset', '0'], ['#persist-inc', '1']] as const) {
      await mobile.tap(button);
      await mobile.waitForFunction(value => document.querySelector('#persist-count')?.textContent === value, count);
    }
    // The menu button and its sheet exist only at phone width.
    await mobile.tap('.db-menu');
    await mobile.waitForSelector('#db-sheet[open]');
    await mobile.tap('#db-sheet a[href="#performance"]');
    await mobile.waitForSelector('#db-sheet', { state: 'hidden' });
    await mobile.tap('#types-run');
    await mobile.waitForFunction(() => document.querySelectorAll('#types-out tr[data-ok="true"]').length === 5);
    await mobile.waitForFunction(() => document.querySelectorAll('#redis .chart svg').length === 2, undefined, { timeout: 30000 });
    const layout = await mobile.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    if (layout.page > layout.viewport) throw new Error(`Website scrolls sideways on a phone: ${layout.page} px content in a ${layout.viewport} px viewport.`);
    await mobile.screenshot({ path: resolve(output, 'site-iphone.png'), fullPage: true });
    if (mobileErrors.length) throw new Error(`Website errors in WebKit: ${mobileErrors.join('; ')}`);
    Object.assign(result, { webkit: `${webkit.name()} ${phone.browser()?.version() ?? ''}`.trim(), phone: 'iPhone 15 viewport: OPFS add, delete, add; menu sheet; DSON demo; Redis charts; no sideways page scroll' });
  } finally { await phone.close(); }
  // The committed bundles must equal a fresh build from the packed package, or `make site` was skipped after a change.
  for (const file of ['demo.js', 'opfs.worker.js']) {
    if (!(await readFile(resolve(output, 'site/assets', file))).equals(await readFile(resolve('docs/assets', file)))) throw new Error(`docs/assets/${file} is stale; run make site.`);
  }
  Object.assign(result, { website: 'snapshot, conflict, DSON and OPFS demos; reload persistence; delete then add; silent worker replaced; install tabs; Redis gauges, switches and charts' });
  const report = { package: `defuss-dbsonl@${version}`, generatedAt: new Date().toISOString(), runtimes, v2, parallel, commonjs: ['Node', 'Bun'], declarations: 'no DOM or Node ambient types', browser: { name: 'Chromium', version: browser.version(), ...result } };
  await writeFile(resolve(output, 'e2e.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Node, Bun, ESM, CommonJS, declaration checks, Chromium ${browser.version()} and WebKit at iPhone size passed.`);
} finally { await browser?.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
