const { Plugin, MarkdownRenderChild, TFile } = require('obsidian');
const REPORTS = 'Research Studio/Reports/';
function validPath(path, extension = '.html') {
  return typeof path === 'string' && path.startsWith(REPORTS) && path.endsWith(extension) && !/[\\\x00-\x1f]/.test(path) && !path.split('/').some(part => part === '..' || part === '.');
}
function safeNote(path) {
  return typeof path === 'string' && path.startsWith('Research Studio/') && path.endsWith('.md') && !/[\\\x00-\x1f]/.test(path) && !path.split('/').some(part => part === '..' || part === '.');
}

// Runs inside an opaque-origin sandbox. It has no Obsidian or Node access.
function frameBridge(token) {
  const send = value => parent.postMessage({ studio: token, ...value }, '*');
  let height = 0;
  const resize = () => {
    const next = Math.ceil(document.body.getBoundingClientRect().height + parseFloat(getComputedStyle(document.body).marginTop || '0') + parseFloat(getComputedStyle(document.body).marginBottom || '0'));
    if (Math.abs(next - height) > 2) { height = next; send({ height: next }); }
  };
  new ResizeObserver(resize).observe(document.body);
  addEventListener('load', resize); document.fonts?.ready.then(resize); resize();
  document.addEventListener('click', event => {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (href.startsWith('#')) return;
    event.preventDefault();
    if (anchor.dataset.studioNote) send({ note: anchor.dataset.studioNote });
    else if (/^https?:\/\//i.test(href)) send({ external: href });
  }, true);
}
function frameDocument(html, token) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // A report cannot loosen the outer policy or run refresh/navigation directives.
  doc.querySelectorAll('meta[http-equiv],base,iframe,object,embed,form').forEach(node => node.remove());
  const csp = doc.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  doc.head.prepend(csp);
  const style = doc.createElement('style');
  style.textContent = ':root{color-scheme:dark}html{background:#1e1e1e;overflow:hidden}body{min-height:0!important;height:auto!important;margin:0;background:#1e1e1e;color:#e8e6e3}img,svg,canvas{max-width:100%}';
  doc.head.append(style);
  const bridge = doc.createElement('script'); bridge.textContent = `(${frameBridge.toString()})(${JSON.stringify(token)})`; doc.body.append(bridge);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
class Report extends MarkdownRenderChild {
  constructor(el, app, path, sourcePath) { super(el); this.app = app; this.path = path; this.sourcePath = sourcePath; this.revision = 0; }
  onload() {
    this.containerEl.classList.add('research-studio-report');
    this.registerDomEvent(window, 'message', event => {
      if (!this.frame || event.source !== this.frame.contentWindow || event.data?.studio !== this.token) return;
      const data = event.data;
      if (typeof data.height === 'number' && Number.isFinite(data.height)) this.frame.style.height = Math.max(240, Math.min(100000, data.height + 4)) + 'px';
      if (safeNote(data.note)) this.app.workspace.openLinkText(data.note, this.sourcePath, false);
      if (typeof data.external === 'string' && /^https?:\/\//i.test(data.external)) window.open(data.external, '_blank', 'noopener,noreferrer');
    });
    this.registerEvent(this.app.vault.on('modify', file => { if (file.path === this.path) this.render(); }));
    this.render();
  }
  onunload() { this.revision++; this.frame = null; }
  async render() {
    const revision = ++this.revision;
    try {
      if (!validPath(this.path)) throw new Error('Invalid Studio report path.');
      const file = this.app.vault.getAbstractFileByPath(this.path);
      if (!(file instanceof TFile)) throw new Error('Report file is missing.');
      if (file.stat.size > 12 * 1024 * 1024) throw new Error('Report is larger than 12 MiB.');
      const html = await this.app.vault.read(file);
      if (revision !== this.revision) return;
      this.token = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      const frame = document.createElement('iframe');
      frame.title = 'Research Studio visual answer'; frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.srcdoc = frameDocument(html, this.token);
      this.frame = frame; this.containerEl.replaceChildren(frame);
    } catch (error) {
      if (revision !== this.revision) return;
      this.frame = null;
      const message = document.createElement('p'); message.className = 'research-studio-status';
      message.textContent = `${error.message} The readable text and data are available below.`;
      this.containerEl.replaceChildren(message);
    }
  }
}
module.exports = class ResearchStudioViewer extends Plugin {
  onload() {
    this.registerMarkdownCodeBlockProcessor('research-studio', (source, el, ctx) => {
      ctx.addChild(new Report(el, this.app, source.trim(), ctx.sourcePath));
    });
    this.addCommand({ id: 'open-start', name: 'Open Research Studio', callback: () => this.app.workspace.openLinkText('Research Studio/Start', '', false) });
  }
};
