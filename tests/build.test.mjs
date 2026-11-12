import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSite } from '../scripts/build.mjs';
import { PUBLIC_ASSETS } from '../scripts/public-assets.mjs';

async function fixture(t) {
  const tempRoot = resolve(tmpdir());
  const root = await mkdtemp(join(tempRoot, 'esports-pulse-build-'));
  t.after(async () => {
    assert.equal(dirname(root), tempRoot);
    assert.ok(basename(root).startsWith('esports-pulse-build-'));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([...PUBLIC_ASSETS.keys()].map(async name => writeFile(join(root, name), await readFile(new URL('../' + name, import.meta.url)))));
  return root;
}

test('production build contains every browser asset and excludes server files and secrets', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.env'), 'PRIVATE=value');
  await writeFile(join(root, 'worker.js'), 'private backend');
  await mkdir(join(root, '.wrangler'));
  const { output } = await buildSite(root);
  assert.equal(output, resolve(await realpath(root), 'dist'));
  assert.deepEqual((await readdir(output)).sort(), [...PUBLIC_ASSETS.keys()].sort());
  for (const name of PUBLIC_ASSETS.keys()) {
    assert.deepEqual(await readFile(join(output, name)), await readFile(join(root, name)));
  }
  const html = await readFile(join(output, 'index.html'), 'utf8');
  for (const [, resource] of html.matchAll(/\b(?:src|href)="(\/[^"#?]*)"/g)) {
    assert.ok(PUBLIC_ASSETS.has(resource.slice(1)), `Missing deployed resource: ${resource}`);
  }
  for (const name of ['index.html', 'app.js', 'app-core.js', 'styles.css', 'manifest.webmanifest']) {
    assert.doesNotMatch(await readFile(join(output, name), 'utf8'), /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/i);
  }
});

test('rebuilding removes obsolete output while a missing source preserves the last build', async t => {
  const root = await fixture(t);
  const { output } = await buildSite(root);
  await writeFile(join(output, 'obsolete.txt'), 'previous output');
  await buildSite(root);
  assert.ok(!(await readdir(output)).includes('obsolete.txt'));
  const previous = await readFile(join(output, 'index.html'));
  await rm(join(root, 'app.js'));
  await assert.rejects(buildSite(root), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(output, 'index.html')), previous);
});

test('build refuses to replace a regular file named dist', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'dist'), 'keep this file');
  await assert.rejects(buildSite(root), /regular directory/);
  assert.equal(await readFile(join(root, 'dist'), 'utf8'), 'keep this file');
});

test('Vercel publishes the static output and retains direct entity routes', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(config.framework, null);
  assert.equal(config.buildCommand, 'npm run build');
  assert.equal(config.outputDirectory, 'dist');
  assert.equal(pkg.scripts.build, 'node scripts/build.mjs');
  assert.ok(!config.buildCommand.includes('start'));
  assert.ok(!config.outputDirectory.includes('..' + sep));
  for (const entity of ['player', 'team', 'tournament']) {
    assert.ok(config.rewrites.some(rule => rule.source === `/${entity}/:path*` && rule.destination === '/index.html'));
  }
});
