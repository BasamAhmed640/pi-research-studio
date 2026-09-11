import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerStudio } from './src/extension.mjs';

export default function (pi: ExtensionAPI) {
  registerStudio(pi, {
    loadWeb: () => import('pi-web-access/index.ts'),
    loadRuntime: () => import('@earendil-works/pi-coding-agent'),
  });
}
