import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishReport, sourceNote } from '../src/publish.mjs';
import { obsidianUri } from '../src/open.mjs';
import { registerStudio } from '../src/extension.mjs';
import { AREA, atomicWrite } from '../src/paths.mjs';
import { linkVault } from '../src/setup.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-publish-')));
  await mkdir(join(root, '.obsidian'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('publishing preserves prose, comparison tables, Mermaid, and bidirectional source links', async t => {
  const root = await fixture(t), html = join(root, AREA, 'Reports/report.html');
  await atomicWrite(join(root, AREA, 'Attachments/photo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6qZEAAAAASUVORK5CYII=', 'base64'));
  await atomicWrite(html, '<!doctype html><html><head><title>Answer</title></head><body><h1>What changed?</h1><p>Output rose from 10 to 42 units.</p><table><tr><th>Year</th><th>Units</th></tr><tr><td>2025</td><td>42</td></tr></table><pre class="mermaid">flowchart LR\nA --> B</pre><a href="https://example.org/report">Annual report</a><a href="javascript:alert(1)">bad link</a><script>secretRuntime();</script></body></html>');
  await writeFile(html, (await readFile(html, 'utf8')).replace('</body>', '<img src="Research Studio/Attachments/photo.png" alt="Uploaded photo"></body>'));
  const report = await publishReport(root, html, join(root, AREA, 'Conversations/question.md'));
  assert.equal(report.sources.length, 1);
  const note = await readFile(join(root, report.notePath), 'utf8');
  assert.match(note, /Output rose from 10 to 42 units/);
  assert.match(note, /\| Year \| Units \|[\s\S]*\| 2025 \| 42 \|/);
  assert.match(note, /```mermaid[\s\S]*A --> B/);
  assert.match(note, /Back to conversation/);
  assert.ok(note.includes(report.sources[0].path.replace(/\.md$/, '')));
  assert.doesNotMatch(note, /secretRuntime/);
  assert.match(note, /!\[\[Research Studio\/Attachments\/photo.png\]\]/);
  assert.match(await readFile(html, 'utf8'), /src="data:image\/png;base64,/);
  assert.doesNotMatch(note, /javascript:/);
  assert.match(await readFile(html, 'utf8'), /data-studio-note=/);
  assert.match(await readFile(join(root, report.sources[0].path), 'utf8'), /https:\/\/example.org\/report/);
  await writeFile(join(root, report.sources[0].path), 'User annotation');
  const again = await sourceNote(root, 'https://example.org/report', 'Different citation label');
  assert.equal(again.path, report.sources[0].path);
  assert.equal(await readFile(join(root, again.path), 'utf8'), 'User annotation');
  await assert.rejects(publishReport(root, join(root, 'outside.html')), /Reports folder/);
  assert.equal(await sourceNote(root, 'file:///private.txt', 'Private'), undefined);
});

test('Obsidian URI encodes spaces, apostrophes, hashes and query delimiters', () => {
  const path = join(process.cwd(), "Basam's vault", 'a #?&note.md');
  const uri = new URL(obsidianUri(path));
  assert.equal(uri.protocol, 'obsidian:'); assert.equal(uri.searchParams.get('path'), path);
  assert.equal([...uri.searchParams].length, 1);
  assert.throws(() => obsidianUri('relative.md'), /absolute/);
});

test('render requests cannot open browsers or overwrite an older answer; only the final note opens', async t => {
  const root = await fixture(t), oldConfig = process.env.PI_STUDIO_CONFIG;
  process.env.PI_STUDIO_CONFIG = join(root, 'pointer.json');
  t.after(() => { if (oldConfig === undefined) delete process.env.PI_STUDIO_CONFIG; else process.env.PI_STUDIO_CONFIG = oldConfig; });
  await writeFile(process.env.PI_STUDIO_CONFIG, JSON.stringify({ vault: root }));
  const handlers = new Map(), commands = new Map(), tools = new Map(), entries = [], opens = [], requests = [];
  let activeTools = ['read'];
  const pi = { registerCommand: (n,v) => commands.set(n,v), on: (n,v) => handlers.set(n,v), registerTool: v => tools.set(v.name,v),
    getActiveTools: () => activeTools, setActiveTools: v => activeTools = v, getThinkingLevel: () => 'high', setThinkingLevel() {},
    appendEntry: (customType,data) => entries.push({ type:'custom', customType,data }) };
  registerStudio(pi, { openNote: async path => opens.push(path), loadWeb: async () => ({ default() {} }), makeMcp: () => ({
    initialize: async () => [{ name:'visual_explainer_render_html', inputSchema:{type:'object'} }], close() {},
    request: async (_method, request) => {
      requests.push(request.arguments);
      const path = join(root, AREA, 'Reports', request.arguments.filename + '.html');
      await atomicWrite(path, request.arguments.html);
      return { content: [], structuredContent: { path } };
    }
  }) });
  const ctx = { isIdle: () => true, hasUI:true, ui: { notify() {}, setStatus() {} }, sessionManager: { getBranch: () => entries, getSessionId: () => 'test1234' } };
  await commands.get('studio').handler('here', ctx);
  await handlers.get('agent_start')({}, ctx);
  const render = tools.get('studio_visual_explainer_render_html');
  const args = { html:'<!doctype html><html><body><h1>Complete answer</h1><p>Evidence and an explanation.</p></body></html>', filename:'same', open:true, viewer:'browser' };
  await render.execute('', args, undefined, undefined, ctx);
  await render.execute('', args, undefined, undefined, ctx);
  assert.ok(requests.every(r => r.open === false));
  assert.notEqual(requests[0].filename, requests[1].filename); assert.equal(opens.length, 0);
  await handlers.get('agent_end')({}, ctx); assert.equal(opens.length, 1); assert.match(opens[0], /\.md$/);
  const note = await readFile(opens[0], 'utf8'); assert.equal((note.match(/!\[\[Research Studio\/Reports/g) || []).length, 2);
  await handlers.get('session_shutdown')({}, ctx);
});

test('malformed Obsidian settings are retained and cannot change the vault pointer', async t => {
  const root = await fixture(t), oldConfig = process.env.PI_STUDIO_CONFIG;
  process.env.PI_STUDIO_CONFIG = join(root, 'pointer.json');
  t.after(() => { if (oldConfig === undefined) delete process.env.PI_STUDIO_CONFIG; else process.env.PI_STUDIO_CONFIG = oldConfig; });
  await writeFile(process.env.PI_STUDIO_CONFIG, '{"vault":"previous"}');
  await writeFile(join(root, '.obsidian/community-plugins.json'), '{broken');
  await assert.rejects(linkVault(root));
  assert.equal(await readFile(process.env.PI_STUDIO_CONFIG, 'utf8'), '{"vault":"previous"}');
  assert.equal(await readFile(join(root, '.obsidian/community-plugins.json'), 'utf8'), '{broken');
});
