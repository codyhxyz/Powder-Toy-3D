// Model providers are plug-ins. Nothing in the construction code knows which
// model or SDK is behind a provider; register one and the Generate button uses it.
//
// A provider is { id, name, generate } where
//
//   generate({ system, messages, tools, signal }) → Promise<{ content, usage? }>
//
// does ONE model turn. Everything it receives and returns is provider-neutral:
//
//   messages:
//     { role: 'user',      content: [{ type: 'text', text }] }
//     { role: 'assistant', content: [{ type: 'text', text } | { type: 'tool_call', id, name, input }] }
//     { role: 'tool',      content: [{ type: 'tool_result', id, name, text, images?, isError? }] }
//        images: [{ mediaType: 'image/png', data: <base64> }]
//   tools: [{ name, description, inputSchema }]   (inputSchema is JSON Schema)
//   content: the assistant blocks above, in order
//   usage: { inputTokens, outputTokens }
//
// An adapter maps these onto its SDK (Vercel AI SDK, an official SDK, a local
// model...) and owns its own key handling. Keys never go anywhere else.

const providers = new Map();
const listeners = new Set();

export function registerProvider(p) {
  if (!p?.id || !p.name || typeof p.generate !== 'function') {
    throw new Error('A provider needs { id, name, generate({ system, messages, tools, signal }) }');
  }
  providers.set(p.id, p);
  for (const fn of listeners) fn();
  return () => { providers.delete(p.id); for (const fn of listeners) fn(); };
}

export const listProviders = () => [...providers.values()];
export const getProvider = (id) => providers.get(id) ?? listProviders()[0] ?? null;
export const onProvidersChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// A provider that replays canned assistant turns: for tests, demos and wiring
// up the UI before a real model is connected.
export function scriptedProvider(turns, { id = 'scripted', name = 'Scripted' } = {}) {
  let i = 0;
  return {
    id, name,
    async generate() {
      const content = turns[Math.min(i, turns.length - 1)];
      i++;
      return { content, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
