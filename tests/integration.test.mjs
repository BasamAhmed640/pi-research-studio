import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AREA, UPSTREAM, safePath, readJson } from '../src/paths.mjs';
import { linkVault, createSession, installObsidian } from '../src/setup.mjs';
import { LocalMcp } from '../src/mcp.mjs';
import { archiveConversation } from '../src/archive.mjs';
import { registerStudio } from '../src/extension.mjs';
import { attachWeb } from '../src/web.mjs';
const sdkFile = process.env.PI_STUDIO_SDK;
const sdk = sdkFile ? await import(pathToFileURL(sdkFile)) : null;

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'pi-studio-test-'))), vault = join(temporary, "Test's vault");
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return { temporary, vault };
}
test('linking preserves Obsidian settings and installs byte-identical upstream assets', async t => {
  const { temporary, vault } = await fixture(t);
  const old = process.env.PI_STUDIO_CONFIG; process.env.PI_STUDIO_CONFIG = join(temporary, 'config.json');
  t.after(() => { if (old === undefined) delete process.env.PI_STUDIO_CONFIG; else process.env.PI_STUDIO_CONFIG = old; });
  await mkdir(join(vault, '.obsidian/plugins/pi-agent'), { recursive: true });
  await writeFile(join(vault, '.obsidian/plugins/pi-agent/data.json'), '{"keep":true}');
  await writeFile(join(vault, '.obsidian/community-plugins.json'), '["another-plugin"]');
  assert.equal(await linkVault(`"${vault}"`), vault);
  for (const name of ['main.js', 'styles.css', 'manifest.json']) assert.deepEqual(await readFile(join(vault, '.obsidian/plugins/pi-agent', name)), await readFile(join(UPSTREAM.obsidian, name)));
  assert.equal(await readFile(join(vault, '.obsidian/plugins/pi-agent/data.json'), 'utf8'), '{"keep":true}');
  assert.equal(await readFile(join(vault, '.obsidian/community-plugins.json'), 'utf8'), '["another-plugin"]');
  await assert.rejects(linkVault(join(temporary, 'missing')));
  assert.equal((await readJson(process.env.PI_STUDIO_CONFIG)).vault, vault);
});
test('vault writes reject traversal and outward junctions', async t => {
  const { temporary, vault } = await fixture(t), outside = join(temporary, 'outside');
  await mkdir(outside); await symlink(outside, join(vault, 'escape'), 'junction');
  await assert.rejects(safePath(vault, '../outside/a'), /inside/);
  await assert.rejects(safePath(vault, 'escape/a'), /outside/);
  assert.equal(await safePath(vault, 'new/folder/a'), join(vault, 'new/folder/a'));
});
test('a damaged bundled companion cannot overwrite installed data', async t => {
  const { vault } = await fixture(t);
  await symlink(await realpath(tmpdir()), join(vault, '.obsidian/plugins'), 'junction');
  await assert.rejects(installObsidian(vault), /outside/);
});
test('Studio sessions open with Pi native context, persistence and branch support', { skip: !sdk }, async t => {
  const { vault } = await fixture(t);
  const path = await createSession(vault, 'parent-session.jsonl');
  const manager = sdk.SessionManager.open(path);
  assert.equal(manager.getCwd(), vault);
  assert.equal(manager.getBranch()[0].customType, 'research-studio');
  assert.equal(manager.getBranch()[0].data.parentSession, 'parent-session.jsonl');
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Explain this company.' }], timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'A substantive answer.' }], api: 'test', provider: 'test', model: 'test', stopReason: 'stop', usage: {}, timestamp: Date.now() });
  const note = await archiveConversation(vault, manager);
  assert.match(await readFile(note, 'utf8'), /Explain this company\.[\s\S]*A substantive answer\./);
  const reopened = sdk.SessionManager.open(path);
  assert.equal(reopened.getBranch().length, 3);
  assert.equal(reopened.getSessionDir(), join(vault, AREA, 'Sessions'));
});
test('Visual Explainer uses its actual MCP server and writes inside the selected vault', async t => {
  const { vault } = await fixture(t), reports = join(vault, AREA, 'Reports');
  const mcp = new LocalMcp(process.execPath, [join(UPSTREAM.visual, 'mcp/server.mjs')], { env: { ...process.env, VISUAL_EXPLAINER_OUTPUT_DIR: reports } });
  t.after(() => mcp.close());
  const tools = await mcp.initialize();
  assert.ok(tools.some(tool => tool.name === 'visual_explainer_render_html'));
  const result = await mcp.request('tools/call', { name: 'visual_explainer_render_html', arguments: { filename: 'example', html: '<!doctype html><html><head><title>Research</title></head><body><h1>Context matters</h1><table><tr><td>Evidence</td></tr></table></body></html>', open: false } });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.match(await readFile(join(reports, 'example.html'), 'utf8'), /Context matters/);
  const rejected = await mcp.request('tools/call', { name: 'visual_explainer_render_html', arguments: { filename: '../escape', html: '<html></html>', open: false } });
  assert.equal(rejected.isError, true);
  mcp.close(); await assert.rejects(mcp.request('tools/list'), /closed/);
});
test('the upstream quick renderer validates its own table shape', async t => {
  const { vault } = await fixture(t);
  const mcp = new LocalMcp(process.execPath, [join(UPSTREAM.visual, 'mcp/server.mjs')], { env: { ...process.env, VISUAL_EXPLAINER_OUTPUT_DIR: join(vault, 'Reports') } });
  t.after(() => mcp.close()); await mcp.initialize();
  const bad = await mcp.request('tools/call', { name: 'visual_explainer_render_quick', arguments: { filename: 'bad', spec: { title: 'Bad table', sections: [{ title: 'Values', table: { columns: ['A', 'B'], rows: [['one']] } }] }, open: false } });
  assert.equal(bad.isError, true);
});
test('web adapter namespaces upstream tools, gates execution and restores its fetch wrapper', async () => {
  const tools = [], calls = [], baseFetch = globalThis.fetch; let active = false;
  const pi = { registerTool: definition => tools.push(definition), getActiveTools: () => [] };
  const web = await attachWeb(pi, async () => ({ default(api) {
    globalThis.fetch = (...args) => baseFetch(...args);
    api.registerTool({ name: 'web_search', execute: () => 'result' });
    api.on('session_start', () => calls.push('start'));
    api.on('session_shutdown', () => calls.push('stop'));
    api.registerCommand('search', {}); api.registerShortcut('ctrl+x', {});
  } }), () => active);
  assert.equal(tools[0].name, 'studio_web_search'); assert.throws(() => tools[0].execute(), /Open/);
  active = true; assert.equal(tools[0].execute(), 'result');
  await web.emit({ type: 'session_start' }, {}); await web.close({});
  assert.deepEqual(calls, ['start', 'stop']); assert.equal(globalThis.fetch, baseFetch);
});
test('installation is dormant; help and ordinary input do not load upstream engines', async () => {
  const handlers = new Map(), commands = new Map(); let imports = 0;
  registerStudio({ registerCommand: (name, value) => commands.set(name, value), on: (name, handler) => handlers.set(name, handler) }, { loadWeb: () => { imports++; throw new Error('unexpected'); } });
  const notices = [], ctx = { sessionManager: { getBranch: () => [] }, ui: { notify: text => notices.push(text) } };
  await handlers.get('session_start')({}, ctx);
  assert.equal(await handlers.get('before_agent_start')({ systemPrompt: 'ordinary Pi' }, ctx), undefined);
  assert.equal(handlers.has('input'), false);
  await commands.get('studio').handler('help', ctx);
  assert.match(notices[0], /Feynman/); assert.equal(imports, 0);
  await handlers.get('session_shutdown')({}, ctx);
});
