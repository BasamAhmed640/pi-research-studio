import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename, unlink, realpath, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const AREA = 'Research Studio';
export const UPSTREAM = {
  visual: join(ROOT, 'node_modules/visual-explainer/plugins/visual-explainer'),
  feynman: join(ROOT, 'vendor/feynman'),
  obsidian: join(ROOT, 'vendor/obsidian-pi'),
};
export const configPath = () => process.env.PI_STUDIO_CONFIG || join(homedir(), '.pi/agent/research-studio.json');
export async function readJson(path, optional = false) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
export function contained(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
export async function safePath(root, path) {
  if (isAbsolute(path)) throw new Error('Use a vault-relative path.');
  const target = resolve(root, path);
  if (!contained(root, target)) throw new Error('Path must stay inside the linked vault.');
  let parent = target;
  for (;;) {
    try {
      const actual = await realpath(parent);
      if (!contained(root, actual)) throw new Error('A linked folder points outside the vault.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = dirname(parent); if (next === parent) throw error; parent = next;
    }
  }
  return target;
}
export async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { flag: 'wx' }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function vaultPath(input) {
  let path = input.trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
  if (!path) throw new Error('Provide the path of an existing Obsidian vault.');
  const root = await realpath(resolve(path));
  if (!(await lstat(join(root, '.obsidian'))).isDirectory()) throw new Error('Choose an existing Obsidian vault containing .obsidian.');
  return root;
}
export async function linkedVault() {
  const config = await readJson(configPath(), true);
  if (!config?.vault) throw new Error('Link your vault first: /studio vault "C:\\path\\to\\vault"');
  return vaultPath(config.vault);
}
