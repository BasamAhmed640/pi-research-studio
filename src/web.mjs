export async function attachWeb(pi, load, isActive) {
  const hooks = new Map(), commands = new Map(), names = [], definitions = [];
  const originalFetch = globalThis.fetch;
  const api = new Proxy(pi, { get(target, key) {
    if (key === 'registerTool') return definition => {
      const name = `studio_${definition.name}`; names.push(name);
      const wrapped = { ...definition, name, execute: (...args) => {
        if (!isActive()) throw new Error('Open /studio before using its tools.');
        // The browser curator is a separate UI and can add a second model pass.
        // Keep the ordinary Pi question workflow direct in both modes.
        if (definition.name === 'web_search') args[1] = { ...args[1], workflow: 'none' };
        return definition.execute(...args);
      } };
      definitions.push(wrapped); pi.registerTool(wrapped);
    };
    if (key === 'on') return (event, handler) => { if (!hooks.has(event)) hooks.set(event, []); hooks.get(event).push(handler); };
    if (key === 'registerCommand') return (name, command) => commands.set(name, command);
    if (key === 'registerShortcut') return () => {}; // No global keyboard changes.
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  try { const module = await load(); await module.default(api); }
  catch (error) { globalThis.fetch = originalFetch; throw error; }
  const installedFetch = globalThis.fetch;
  return {
    names, commands, definitions,
    async emit(event, ctx) { for (const handler of hooks.get(event.type) || []) await handler(event, ctx); },
    async close(ctx) {
      try { for (const handler of hooks.get('session_shutdown') || []) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx); }
      finally { if (globalThis.fetch === installedFetch) globalThis.fetch = originalFetch; }
    },
  };
}
