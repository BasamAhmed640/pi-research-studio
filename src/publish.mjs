import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { relative, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AREA, atomicWrite, safePath } from './paths.mjs';

export const wiki = path => path.replace(/\\/g, '/').replace(/\.md$/, '');
const label = text => text.replace(/[\[\]|#\r\n]/g, ' ').trim();
const slug = text => label(text).replace(/[<>:"/\\?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').slice(0, 70).replace(/[. ]+$/, '') || 'Source';

export async function sourceNote(root, input, title) {
  let url; try { url = new URL(input); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
  // Fragments often identify different passages; retain them in the source note.
  const hash = createHash('sha256').update(url.href).digest('hex').slice(0, 16);
  const folder = await safePath(root, `${AREA}/Sources`);
  await mkdir(folder, { recursive: true });
  const existing = (await readdir(folder)).find(name => name.endsWith(`(${hash}).md`));
  const path = `${AREA}/Sources/${existing || `${slug(title || url.hostname)} (${hash}).md`}`;
  const target = await safePath(root, path);
  try {
    await writeFile(target, `# ${label(title || url.hostname)}\n\n[Open original source](<${url.href}>)\n\nReferenced by Research Studio. See Obsidian's backlinks for the answers that cite this source. This reference is not a saved copy or a verification certificate.\n`, { flag: 'wx' });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return { path, title: label(title || url.hostname), url: url.href };
}

export async function publishReport(root, htmlPath, conversationPath) {
  const rel = relative(root, htmlPath).replace(/\\/g, '/');
  if (!rel.startsWith(`${AREA}/Reports/`) || !rel.endsWith('.html')) throw new Error('Reports must be HTML files inside the vault Reports folder.');
  const target = await safePath(root, rel);
  const bytes = await readFile(target);
  if (bytes.length > 12 * 1024 * 1024) throw new Error('Report exceeds the 12 MiB viewer limit.');
  // Parsing dependencies stay dormant until an answer is published.
  const [{ parse }, { default: TurndownService }] = await Promise.all([import('node-html-parser'), import('turndown')]);
  const document = parse(bytes.toString('utf8'));
  const body = document.querySelector('body');
  if (!body) throw new Error('A report needs a complete HTML document with a body.');
  const title = label(document.querySelector('h1')?.textContent || document.querySelector('title')?.textContent || 'Research answer');
  const sources = new Map();
  for (const anchor of body.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (sources.has(href)) continue;
    const source = await sourceNote(root, href, anchor.textContent.trim());
    if (source) sources.set(href, source);
  }
  for (const anchor of body.querySelectorAll('a[href]')) {
    const source = sources.get(anchor.getAttribute('href'));
    if (source) anchor.setAttribute('data-studio-note', source.path);
    else if (!/^(?:https?:\/\/|#)/i.test(anchor.getAttribute('href'))) anchor.removeAttribute('href');
  }
  for (const img of body.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (/^https?:/i.test(src)) throw new Error('Remote report photos are blocked by the viewer. Use an image already saved in the linked vault or an embedded data image.');
    if (/^data:/i.test(src)) {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(src);
      if (!match) continue;
      const image = Buffer.from(match[2], 'base64');
      if (image.length > 8 * 1024 * 1024) throw new Error('Report photos must be under 8 MiB each.');
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[match[1].toLowerCase()];
      const attachment = `${AREA}/Attachments/${createHash('sha256').update(image).digest('hex').slice(0, 24)}.${extension}`;
      await atomicWrite(await safePath(root, attachment), image);
      img.setAttribute('data-studio-attachment', attachment);
      continue;
    }
    const decoded = src.startsWith('file:') ? fileURLToPath(src) : decodeURIComponent(src);
    const local = decoded.replace(/\\/g, '/').startsWith(`${AREA}/`) ? resolve(root, decoded) : resolve(dirname(target), decoded);
    const vaultRelative = relative(root, local).replace(/\\/g, '/');
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extname(local).toLowerCase()];
    if (!mime) throw new Error('Use PNG, JPEG, WebP or GIF for a local report photo.');
    const image = await readFile(await safePath(root, vaultRelative));
    if (image.length > 8 * 1024 * 1024) throw new Error('Report photos must be under 8 MiB each.');
    img.setAttribute('src', `data:${mime};base64,${image.toString('base64')}`);
    img.setAttribute('data-studio-attachment', vaultRelative);
  }
  // The viewer can follow citations into source notes instead of leaving Obsidian.
  const visual = document.toString();
  if (Buffer.byteLength(visual) > 12 * 1024 * 1024) throw new Error('Report including its photos exceeds 12 MiB.');
  await atomicWrite(target, visual);
  for (const node of body.querySelectorAll('script,style,svg,canvas,iframe,form,input,button')) node.remove();
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  turndown.addRule('vault-photos', { filter: node => node.nodeName === 'IMG' && node.hasAttribute('data-studio-attachment'), replacement: (_content, node) => `![[${node.getAttribute('data-studio-attachment')}]]` });
  turndown.addRule('source-links', { filter: node => node.nodeName === 'A' && node.hasAttribute('data-studio-note'), replacement: (content, node) => `[[${wiki(node.getAttribute('data-studio-note'))}|${label(content) || 'Source'}]]` });
  turndown.addRule('tables', { filter: 'table', replacement: (_content, node) => {
    const rows = Array.from(node.querySelectorAll('tr')).map(row => Array.from(row.children).filter(cell => ['TH', 'TD'].includes(cell.nodeName)).map(cell => turndown.turndown(cell.innerHTML).replace(/\|/g, '&#124;').replace(/\n+/g, '<br>'))).filter(row => row.length);
    if (!rows.length) return '';
    const width = Math.max(...rows.map(row => row.length));
    const line = row => `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`;
    return `\n\n${[line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`;
  } });
  turndown.addRule('mermaid', { filter: node => node.nodeName === 'PRE' && (node.classList.contains('mermaid') || node.querySelector('code.language-mermaid')), replacement: (_content, node) => `\n\n\`\`\`mermaid\n${node.textContent.trim()}\n\`\`\`\n\n` });
  const markdown = turndown.turndown(body.toString());
  if (!markdown.trim()) throw new Error('The report needs readable explanation and data alongside its visuals.');
  const notePath = `${AREA}/Reports/${slug(title)} (${createHash('sha256').update(rel).digest('hex').slice(0, 8)}).md`;
  const back = conversationPath ? `[[${wiki(relative(root, conversationPath))}|Back to conversation]] · ` : '';
  const sourceLinks = [...sources.values()].map(source => `- [[${wiki(source.path)}|${source.title}]]`).join('\n');
  const text = `---\ncssclasses: [research-studio-note]\n---\n\n# ${title}\n\n${back}[[${AREA}/Start|Research Studio]]\n\n\`\`\`research-studio\n${rel}\n\`\`\`\n\n> [!abstract]- Readable text and data\n${markdown.split('\n').map(line => `> ${line}`).join('\n')}\n\n${sourceLinks ? `## Linked sources\n\n${sourceLinks}\n` : ''}`;
  await atomicWrite(await safePath(root, notePath), text);
  return { notePath, htmlPath: rel, title, sources: [...sources.values()] };
}
