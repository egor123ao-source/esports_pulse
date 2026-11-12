import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_ASSETS } from './public-assets.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildSite(projectRoot = PROJECT_ROOT) {
  const root = await realpath(projectRoot);
  const output = resolve(root, 'dist');
  // Validate the absolute output before cleaning it, including Windows junctions.
  if (dirname(output) !== root || basename(output) !== 'dist') throw new Error('Unsafe build directory');
  const existing = await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('dist must be a regular directory');

  // Read everything first: a missing source must leave the last build intact.
  const files = await Promise.all([...PUBLIC_ASSETS.keys()].map(async name => {
    const source = resolve(root, name);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Public asset must be a regular file: ${name}`);
    return [name, await readFile(source)];
  }));
  await rm(output, { recursive: true, force: true });
  await mkdir(output);
  await Promise.all(files.map(([name, contents]) => writeFile(resolve(output, name), contents)));
  return { output, files: files.map(([name]) => name) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildSite();
    console.log(`Production build: dist/ (${result.files.length} public files). No local server required.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
