import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, AREA } from '../src/paths.mjs';
import { createSession } from '../src/setup.mjs';
import { runResearch } from '../src/research.mjs';
import { readLocalPdf } from '../src/pdf.mjs';
import { registerStudio } from '../src/extension.mjs';
const sdkPath = process.env.PI_STUDIO_SDK;
const sdk = sdkPath ? await import(pathToFileURL(sdkPath)) : null;
const ai = sdkPath ? await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', pathToFileURL(sdkPath))) : null;

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'studio-runtime-'))), vault = join(directory, 'vault');
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  const cleanup = [];
  t.after(async () => { for (const fn of cleanup) await fn(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  return { directory, vault, cleanup };
}
async function modelFixture(t) {
  const data = await fixture(t);
  const runtimeOptions = { authPath: join(data.directory, 'auth.json'), modelsPath: null, modelsStorePath: join(data.directory, 'models.json'), refreshOnCreate: false };
  const runtime = await sdk.ModelRuntime.create(runtimeOptions);
  const fake = ai.fauxProvider({ provider: 'studio-test', models: [{ id: 'test', input: ['text', 'image'], reasoning: true }], tokensPerSecond: 1000000 });
  runtime.registerNativeProvider(fake.provider);
  return { ...data, runtime, fake, model: runtime.getModel('studio-test', 'test'), runtimeOptions };
}

test('real Pi loader opens Studio, uses actual web + visual tools, and archives the answer', { skip: !sdk }, async t => {
  const { directory, vault, runtime, fake, model, cleanup } = await modelFixture(t);
  const old = process.env.PI_STUDIO_CONFIG; process.env.PI_STUDIO_CONFIG = join(directory, 'studio.json');
  t.after(() => { if (old === undefined) delete process.env.PI_STUDIO_CONFIG; else process.env.PI_STUDIO_CONFIG = old; });
  await writeFile(process.env.PI_STUDIO_CONFIG, JSON.stringify({ vault }));
  const manager = sdk.SessionManager.open(await createSession(vault, undefined, 'ask', 'high'));
  const settings = sdk.SettingsManager.inMemory();
  const loader = new sdk.DefaultResourceLoader({ cwd: vault, agentDir: directory, settingsManager: settings,
    noExtensions: true, additionalExtensionPaths: [join(ROOT, 'index.ts')], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: vault, model, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, sessionManager: manager });
  cleanup.push(async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); });
  await session.bindExtensions({});
  assert.ok(session.getActiveToolNames().includes('studio_web_search'));
  assert.ok(!session.getActiveToolNames().includes('studio_research_assistant'));
  assert.equal(session.thinkingLevel, 'low');
  fake.setResponses([
    context => {
      assert.match(context.systemPrompt, /A chart cannot replace the answer/);
      return ai.fauxAssistantMessage(ai.fauxToolCall('studio_visual_explainer_render_html', { filename: 'real-pi-report', html: '<!doctype html><html><head><title>Research</title></head><body><h1>Complete explanation</h1><p>The chart supports the answer.</p></body></html>', open: false }), { stopReason: 'toolUse' });
    },
    ai.fauxAssistantMessage('The full explanation is saved in the report.'),
  ]);
  await session.prompt('Explain this and make a visual.');
  const report = manager.getBranch().find(entry => entry.customType === 'research-studio-report')?.data;
  assert.ok(report, JSON.stringify(manager.getBranch()));
  assert.match(await readFile(join(vault, report.htmlPath), 'utf8'), /Complete explanation/);
  assert.match(await readFile(join(vault, report.notePath), 'utf8'), /Readable text and data[\s\S]*chart supports the answer/);
  const notes = await readdir(join(vault, AREA, 'Conversations'));
  assert.ok(notes.some(name => name.includes('Explain this')));
  assert.match(await readFile(join(vault, AREA, 'Conversations', notes[0]), 'utf8'), /full explanation/);
  assert.ok((await readFile(join(vault, AREA, 'Conversations', notes[0]), 'utf8')).includes(`![[${report.notePath.replace(/\.md$/, '')}]]`));
});

test('Feynman verifier is a real, fresh Pi child that reads evidence and saves its findings', { skip: !sdk }, async t => {
  const { directory, vault, runtime, runtimeOptions, fake, model } = await modelFixture(t);
  const source = join(vault, 'evidence.txt'); await writeFile(source, 'The observed measurement was 42 units.');
  let seenOptions;
  const observedSdk = { ...sdk, ModelRuntime: { create: () => sdk.ModelRuntime.create(runtimeOptions) },
    createAgentSession: async options => { seenOptions = options; return sdk.createAgentSession(options); } };
  fake.setResponses([
    context => {
      assert.match(context.systemPrompt, /Verify meaning/); assert.doesNotMatch(JSON.stringify(context.messages), /private prior conversation/);
      return ai.fauxAssistantMessage(ai.fauxToolCall('read', { path: source }), { stopReason: 'toolUse' });
    },
    context => { assert.match(JSON.stringify(context.messages), /42 units/); return ai.fauxAssistantMessage('The draft is wrong: evidence.txt reports 42 units, not 10.'); },
  ]);
  const result = await runResearch({ root: vault, role: 'verifier', task: `Check the draft claim of 10 units against ${source}.`,
    ctx: { model, modelRegistry: new sdk.ModelRegistry(runtime) }, loadRuntime: async () => observedSdk, webTools: [] });
  assert.match(result.content[0].text, /42 units, not 10/);
  assert.match(await readFile(result.details.path, 'utf8'), /42 units/);
  assert.ok(result.details.sessionFile.startsWith(join(vault, AREA, 'Research')));
  assert.equal(seenOptions.model.id, model.id);
  assert.deepEqual(seenOptions.tools, ['read', 'studio_read_pdf']);
  assert.equal(fake.state.callCount, 2);
});

test('Ask/Deep switch preserves the original reasoning preference and assistants are bounded', async t => {
  const { directory, vault } = await fixture(t);
  const old = process.env.PI_STUDIO_CONFIG; process.env.PI_STUDIO_CONFIG = join(directory, 'studio.json');
  t.after(() => { if (old === undefined) delete process.env.PI_STUDIO_CONFIG; else process.env.PI_STUDIO_CONFIG = old; });
  await writeFile(process.env.PI_STUDIO_CONFIG, JSON.stringify({ vault }));
  const commands = new Map(), handlers = new Map(), tools = new Map(), entries = [];
  let activeTools = ['read'], thinking = 'max', calls = 0;
  const pi = { registerCommand: (name, command) => commands.set(name, command), on: (name, fn) => handlers.set(name, fn), registerTool: tool => tools.set(tool.name, tool),
    getActiveTools: () => activeTools, setActiveTools: names => { activeTools = names; }, getThinkingLevel: () => thinking, setThinkingLevel: value => { thinking = value; }, appendEntry: (_type, data) => entries.push(data) };
  registerStudio(pi, { loadWeb: async () => ({ default() {} }), research: async () => { calls++; return { content: [] }; }, makeMcp: () => ({ initialize: async () => [], close() {} }) });
  const ctx = { isIdle: () => true, ui: { notify() {}, setStatus() {} }, sessionManager: { getBranch: () => [] } };
  await commands.get('studio').handler('here', ctx);
  assert.equal(thinking, 'low'); assert.ok(!activeTools.includes('studio_research_assistant'));
  const delegate = tools.get('studio_research_assistant');
  await assert.rejects(delegate.execute('', { role: 'verifier', task: 'Check' }, undefined, undefined, ctx), /Deep|deep/);
  await commands.get('studio').handler('deep', ctx);
  assert.equal(thinking, 'max'); assert.equal(entries.at(-1).mode, 'deep');
  for (let i = 0; i < 4; i++) await delegate.execute('', { role: 'researcher', task: 'Check' }, undefined, undefined, ctx);
  await assert.rejects(delegate.execute('', {}, undefined, undefined, ctx), /Four/); assert.equal(calls, 4);
  await commands.get('studio').handler('ask', ctx); assert.equal(thinking, 'low');
  await commands.get('studio').handler('exit', ctx); assert.equal(thinking, 'max'); assert.deepEqual(activeTools, ['read']);
});

test('local PDF extraction preserves the original, reports pages and rejects invalid ranges', async t => {
  const { vault } = await fixture(t);
  // Minimal one-page PDF with a real text stream and byte-correct xref.
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = 'BT /F1 12 Tf 20 250 Td (Evidence reports 42 units.) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let text = '%PDF-1.4\n', offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(text.length); text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = text.length;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`;
  const source = join(vault, 'paper.pdf'); await writeFile(source, text);
  const result = await readLocalPdf(vault, { path: source, pages: [1] });
  const data = JSON.parse(result.content[0].text);
  assert.match(data.excerpts[0].text, /42 units/); assert.equal(data.totalPages, 1);
  assert.equal(await readFile(join(vault, data.original), 'utf8'), text);
  await assert.rejects(readLocalPdf(vault, { path: source, pages: [2] }), /valid page/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readLocalPdf(vault, { path: source }, controller.signal), /abort/i);
});
