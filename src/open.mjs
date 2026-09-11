import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';

export function obsidianUri(path) {
  if (!isAbsolute(path)) throw new Error('Obsidian needs an absolute note path.');
  return `obsidian://open?path=${encodeURIComponent(path)}`;
}
export async function openInObsidian(path) {
  const uri = obsidianUri(path);
  const [command, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', uri]]
    : process.platform === 'darwin' ? ['open', [uri]] : ['xdg-open', [uri]];
  await promisify(execFile)(command, args, { windowsHide: true, timeout: 10000 });
}
