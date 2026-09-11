import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from '../src/paths.mjs';
const playwright = process.env.PI_STUDIO_PLAYWRIGHT ? createRequire(import.meta.url)(process.env.PI_STUDIO_PLAYWRIGHT) : null;

test('bundled viewer runs chart interactions, resizes, links sources and isolates generated code', { skip: !playwright }, async t => {
  const browser = await playwright.chromium.launch({ channel: process.env.PI_STUDIO_BROWSER || 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><html><head><style>body{margin:0;background:#1e1e1e;color:#e8e6e3;font:16px system-ui}main{max-width:1120px;margin:32px auto;padding:0 24px}header{color:#aaa;font-size:13px}h1{font-weight:500}</style></head><body><main><header>Research Studio · Viewer test harness (Obsidian API stub)</header><h1>How growth compounds</h1><div id="report"></div></main></body></html>');
  await page.addStyleTag({ content: await readFile(join(ROOT, 'obsidian/styles.css'), 'utf8') });
  await page.evaluate(({ plugin, html }) => {
    class Component {
      cleanups = [];
      registerDomEvent(el, type, fn) { el.addEventListener(type, fn); this.cleanups.push(() => el.removeEventListener(type, fn)); }
      registerEvent(ref) { this.cleanups.push(ref); }
      unload() { this.onunload?.(); this.cleanups.forEach(fn => fn()); }
    }
    class MarkdownRenderChild extends Component { constructor(el) { super(); this.containerEl = el; } }
    class TFile { path = 'Research Studio/Reports/example.html'; stat = { size: html.length }; }
    const callbacks = new Set(), opens = [], file = new TFile();
    class Plugin { registerMarkdownCodeBlockProcessor(_lang, handler) { window.processor = handler; } addCommand() {} }
    const module = { exports: {} };
    new Function('require', 'module', plugin)(() => ({ Plugin, MarkdownRenderChild, TFile }), module);
    const app = { vault: { getAbstractFileByPath: path => path === file.path ? file : null, read: async () => window.currentHtml,
      on: (_event, callback) => { callbacks.add(callback); return () => callbacks.delete(callback); } },
      workspace: { openLinkText: (...args) => { opens.push(args); } } };
    window.currentHtml = html; window.openedNotes = opens; window.callbacks = callbacks;
    const extension = new module.exports(); extension.app = app; extension.onload();
    window.processor(file.path, document.getElementById('report'), { sourcePath: 'Research Studio/Reports/example.md', addChild: child => { window.viewer = child; child.onload(); } });
    window.refresh = html => { window.currentHtml = html; callbacks.forEach(fn => fn(file)); };
  }, { plugin: await readFile(join(ROOT, 'obsidian/main.js'), 'utf8'), html: await readFile(join(ROOT, 'examples/growth.html'), 'utf8') });
  const frame = page.frameLocator('iframe');
  await frame.locator('#takeaway').getByText(/259.4 units/).waitFor();
  await page.waitForFunction(() => parseFloat(document.querySelector('iframe').style.height) > 1500);
  await frame.locator('#rate').fill('15');
  await frame.locator('#takeaway').getByText(/404.6 units/).waitFor();
  await frame.locator('summary').click();
  await frame.locator('#data tbody tr').last().getByText('404.6').waitFor();
  const measurement = await frame.locator('body').evaluate(body => ({ overflow: body.scrollWidth > innerWidth, dark: getComputedStyle(body).backgroundColor }));
  assert.deepEqual(measurement, { overflow: false, dark: 'rgb(30, 30, 30)' });
  const before = await page.locator('iframe').evaluate(el => el.clientHeight);
  await page.evaluate(() => dispatchEvent(new MessageEvent('message', { data: { studio: viewer.token, height: 42 }, source: window })));
  assert.equal(await page.locator('iframe').evaluate(el => el.clientHeight), before);
  if (process.env.PI_STUDIO_SCREENSHOTS) {
    await mkdir(process.env.PI_STUDIO_SCREENSHOTS, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    await frame.locator('body').evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(process.env.PI_STUDIO_SCREENSHOTS, 'viewer-desktop.png') });
  }
  await page.setViewportSize({ width: 430, height: 900 });
  await frame.locator('#rate').fill('10');
  assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth > innerWidth), false);
  if (process.env.PI_STUDIO_SCREENSHOTS) {
    await page.evaluate(() => scrollTo(0, 0));
    await frame.locator('body').evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(process.env.PI_STUDIO_SCREENSHOTS, 'viewer-mobile.png') });
  }
  await page.evaluate(() => refresh('<!doctype html><html><body><h1>Updated report</h1><a href="https://example.org" data-studio-note="Research Studio/Sources/Evidence.md">Evidence</a><script>try{parent.document.body.dataset.compromised="yes"}catch(e){document.body.dataset.isolated="yes"}</script></body></html>'));
  await frame.getByText('Updated report').waitFor();
  assert.equal(await frame.locator('body').getAttribute('data-isolated'), 'yes');
  assert.equal(await page.locator('body').getAttribute('data-compromised'), null);
  await frame.getByText('Evidence').click();
  assert.deepEqual(await page.evaluate(() => openedNotes), [['Research Studio/Sources/Evidence.md', 'Research Studio/Reports/example.md', false]]);
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  if (process.env.PI_STUDIO_CDN_TESTS) {
    await page.evaluate(() => refresh('<!doctype html><html><body><h1>Diagram and chart</h1><pre class="mermaid">flowchart LR\nA[Question] --> B[Evidence] --> C[Answer]</pre><canvas id="chart" width="400" height="200"></canvas><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script><script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script><script>mermaid.initialize({startOnLoad:true,theme:"dark"});new Chart(document.getElementById("chart"),{type:"bar",data:{labels:["Before","After"],datasets:[{data:[10,42]}]},options:{animation:false,responsive:false}});document.body.dataset.chart="ready";</script></body></html>'));
    await frame.locator('.mermaid svg').waitFor({ timeout: 20000 });
    assert.equal(await frame.locator('body').getAttribute('data-chart'), 'ready');
    assert.ok(await frame.locator('.mermaid svg').getByText('Evidence', { exact: true }).count());
  }
  await page.evaluate(() => viewer.unload());
  assert.equal(await page.evaluate(() => callbacks.size), 0);
  assert.deepEqual(errors, []);
});
