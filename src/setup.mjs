import { join } from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT, AREA, UPSTREAM, configPath, readJson, atomicWrite, safePath, vaultPath } from './paths.mjs';

export async function installObsidian(root) {
  const lock = await readJson(join(ROOT, 'upstream-lock.json'));
  // Read and verify every upstream asset before writing any installed file.
  const assets = await Promise.all(['main.js', 'styles.css', 'manifest.json'].map(async name => {
    const bytes = await readFile(join(UPSTREAM.obsidian, name));
    if (createHash('sha256').update(bytes).digest('hex') !== lock.obsidian.files[name]) throw new Error(`Bundled Pi Agent integrity check failed: ${name}`);
    return [name, bytes];
  }));
  for (const [name, bytes] of assets) {
    const target = await safePath(root, `.obsidian/plugins/pi-agent/${name}`);
    let current; try { current = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!current?.equals(bytes)) await atomicWrite(target, bytes);
  }
  return join(root, '.obsidian/plugins/pi-agent');
}
export async function linkVault(input) {
  const root = await vaultPath(input);
  // Parse the enable list before installing, so malformed user settings stay intact.
  const enabledPath = await safePath(root, '.obsidian/community-plugins.json');
  const enabled = await readJson(enabledPath, true) ?? [];
  if (!Array.isArray(enabled) || !enabled.every(id => typeof id === 'string')) throw new Error('Obsidian community-plugins.json must be a list of plugin IDs.');
  await installObsidian(root);
  for (const name of ['main.js', 'styles.css', 'manifest.json']) {
    await atomicWrite(await safePath(root, `.obsidian/plugins/research-studio-viewer/${name}`), await readFile(join(ROOT, 'obsidian', name)));
  }
  // Enable our viewer on Obsidian's next load; never alter Restricted mode or other plugins.
  if (!enabled.includes('research-studio-viewer')) await atomicWrite(enabledPath, JSON.stringify([...enabled, 'research-studio-viewer'], null, 2) + '\n');
  for (const part of ['Sessions', 'Conversations', 'Reports', 'Attachments', 'Research', 'Sources']) await mkdir(await safePath(root, `${AREA}/${part}`), { recursive: true });
  const start = await safePath(root, `${AREA}/Start.md`);
  try { await readFile(start); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await atomicWrite(start, '# Research Studio\n\nEnter questions in Pi. Read the complete answer here in Obsidian. Use `/studio ask` for a focused answer or `/studio deep` for a broader investigation with research assistants. Both use your selected Pi model.\n\nConversations appear in `Research Studio/Conversations`. Visual answer notes live in `Research Studio/Reports` and are embedded in the conversation. Charts run inside those notes through the bundled Research Studio Viewer. Expand **Readable text and data** for the searchable Markdown copy. Citations link to notes in `Research Studio/Sources`, connected through Obsidian backlinks.\n\nThe viewer is installed when you link this vault. If Obsidian was already open, restart it once; allow community plugins if Restricted mode is on. No plugin download is needed. Plain answers, images, source notes and text copies remain readable without the viewer. Try `/studio example` in Pi to open an interactive example in this vault without a model call.\n\nOriginal images and PDFs live in `Research Studio/Attachments`. Native Pi sessions are in `Research Studio/Sessions`; use Pi’s `/resume`, `/tree` and `/fork` to revisit or branch. Deep assistant notes and native sessions live in `Research Studio/Research`.\n\nOptional: enable **Pi Agent** in Obsidian Community plugins for chat inside Obsidian; choose **Full agent** mode and use `/studio here`. It is not necessary for entering questions in Pi.\n');
  }
  await atomicWrite(configPath(), JSON.stringify({ version: 1, vault: root }, null, 2) + '\n');
  return root;
}
export async function createSession(root, parentSession, mode = 'ask', previousThinking) {
  const id = randomUUID(), timestamp = new Date().toISOString();
  const path = await safePath(root, `${AREA}/Sessions/${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const header = { type: 'session', version: 3, id, timestamp, cwd: root };
  const marker = { type: 'custom', customType: 'research-studio', data: { vault: root, parentSession, mode, previousThinking }, id: randomUUID().slice(0, 8), parentId: null, timestamp };
  await atomicWrite(path, JSON.stringify(header) + '\n' + JSON.stringify(marker) + '\n');
  return path;
}
