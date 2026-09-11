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
  await installObsidian(root);
  for (const part of ['Sessions', 'Conversations', 'Reports', 'Attachments', 'Research']) await mkdir(await safePath(root, `${AREA}/${part}`), { recursive: true });
  const start = await safePath(root, `${AREA}/Start.md`);
  try { await readFile(start); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await atomicWrite(start, '# Research Studio\n\nEnter questions in Pi. Use `/studio ask` for a focused answer or `/studio deep` for a broader investigation with research assistants. Both use your selected Pi model.\n\nConversations appear in `Research Studio/Conversations`. Full HTML reports live in `Research Studio/Reports`; open them in your browser for interactive charts. The report includes the explanation, supporting data and citations. Obsidian reads the conversation notes without any plugin.\n\nOriginal images and PDFs live in `Research Studio/Attachments`. Native Pi sessions are in `Research Studio/Sessions`; use Pi’s `/resume`, `/tree` and `/fork` to revisit or branch. Deep assistant notes and native sessions live in `Research Studio/Research`.\n\nOptional: enable **Pi Agent** in Obsidian Community plugins for chat inside Obsidian; choose **Full agent** mode and use `/studio here`. This is not necessary for entering questions in Pi.\n');
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
