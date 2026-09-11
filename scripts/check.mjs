import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('upstream-lock.json', 'utf8'));
for (const file of await readdir('src')) if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', join('src', file)]);
execFileSync(process.execPath, ['--check', 'obsidian/main.js']);
const viewer = JSON.parse(await readFile('obsidian/manifest.json', 'utf8'));
if (viewer.id !== 'research-studio-viewer' || viewer.version !== pkg.version) throw new Error('Viewer manifest and package version must agree.');
for (const [name, digest] of Object.entries(lock.obsidian.files)) {
  const actual = createHash('sha256').update(await readFile(join('vendor/obsidian-pi', name))).digest('hex');
  if (actual !== digest) throw new Error(`Upstream release mismatch: ${name}`);
}
for (const [name, digest] of Object.entries(lock.feynman.files)) {
  const actual = createHash('sha256').update(await readFile(join('vendor/feynman', name))).digest('hex');
  if (actual !== digest) throw new Error(`Feynman role mismatch: ${name}`);
}
for (const [name, version] of Object.entries(pkg.dependencies)) {
  if (JSON.parse(await readFile(join('node_modules', name, 'package.json'), 'utf8')).version !== version) throw new Error(`Unpinned dependency: ${name}`);
}
console.log('Syntax, pinned versions, and upstream Obsidian release hashes passed.');
