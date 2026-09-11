import { createHash } from 'node:crypto';
import { AREA, atomicWrite, safePath } from './paths.mjs';

export async function archiveConversation(root, manager) {
  const branch = manager.getBranch();
  const first = branch.find(entry => entry.type === 'message' && entry.message.role === 'user')?.message;
  const question = (typeof first?.content === 'string' ? first.content : first?.content?.filter(part => part.type === 'text').map(part => part.text).join(' ')) || 'Research conversation';
  const title = question.replace(/[\r\n]+/g, ' ').slice(0, 100);
  const blocks = [`# ${title}\n`];
  for (const entry of branch) {
    if (entry.type !== 'message' || !['user', 'assistant'].includes(entry.message.role)) continue;
    const message = entry.message, text = [];
    for (const part of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || []) {
      if (part.type === 'text') text.push(part.text);
      if (part.type === 'image' && typeof part.data === 'string') {
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[part.mimeType];
        if (!extension) continue;
        const bytes = Buffer.from(part.data, 'base64');
        if (bytes.length > 40 * 1024 * 1024) { text.push('[Image retained in native Pi history; too large for a duplicate preview.]'); continue; }
        const path = `${AREA}/Attachments/${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${extension}`;
        await atomicWrite(await safePath(root, path), bytes);
        text.push(`![[${path}]]`);
      }
    }
    if (text.length) blocks.push(`## ${message.role === 'user' ? 'You' : 'Assistant'}\n\n${text.join('\n\n')}\n`);
  }
  const id = manager.getSessionId().replace(/[^a-zA-Z0-9_-]/g, '');
  const filename = title.replace(/[<>:"/\\|?*\x00-\x1f\[\]#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70).replace(/[. ]+$/, '') || 'Research conversation';
  const date = manager.getHeader?.()?.timestamp?.slice(0, 10) || 'Conversation';
  const path = await safePath(root, `${AREA}/Conversations/${date} ${filename} (${id.slice(0, 8)}).md`);
  await atomicWrite(path, blocks.join('\n---\n\n'));
  return path;
}
