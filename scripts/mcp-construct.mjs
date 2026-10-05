#!/usr/bin/env node
// MCP server (stdio) for authoring constructions from any MCP client, e.g.
//   claude mcp add powder-constructions -- node scripts/mcp-construct.mjs
//
// Tools: construction_guide (the API, materials, physics and examples),
// construct_exec (run code: lint report + two preview images) and
// construct_builtin (the same for a built-in, to study how they're made).
// Minimal JSON-RPC over newline-delimited stdio; no dependencies.

import readline from 'node:readline';
import { lint, formatReport } from '../src/constructions/lint.js';
import { PREVIEW_VIEWS } from '../src/constructions/preview.js';
import { buildSystemPrompt } from '../src/ai/prompt.js';
import { DEFAULT_SIZE, DEFAULT_SEED, DEFAULT_MAX_SPAN, BUILT_IN_KEYS, runCode, pngOf, builtinsSource, builtinCells } from './construct-lib.mjs';

const SERVER = { name: 'powder-toy-3d-constructions', version: '1.0.0' };
const FALLBACK_PROTOCOL = '2025-06-18';
const SIZE_PROP = { type: 'integer', minimum: 1, maximum: 24, description: `Size setting; ${DEFAULT_SIZE} gives T = 1.` };
const SEED_PROP = { type: 'integer', description: `Seed for rnd (default ${DEFAULT_SEED}).` };

const TOOLS = [
  {
    name: 'construction_guide',
    description: 'The construction API, the material table with real physics numbers, building rules, and the built-in constructions as examples. Read this before writing code.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'construct_exec',
    description: 'Run construction code (a JavaScript function body using put, box, ball, disc, rod, ...). Returns cell counts, a physics lint report (leaks, unsupported powder, ...) and preview pictures from the front-right and back-left.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' }, size: SIZE_PROP, seed: SEED_PROP },
      required: ['code'],
    },
  },
  {
    name: 'construct_builtin',
    description: 'Build one of the game\'s built-in constructions and return the same report and pictures as construct_exec.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', enum: BUILT_IN_KEYS }, variant: { type: 'string' }, size: SIZE_PROP, seed: SEED_PROP },
      required: ['key'],
    },
  },
];

function result(cells) {
  const report = lint(cells, { maxSpan: DEFAULT_MAX_SPAN });
  return {
    content: [
      { type: 'text', text: formatReport(report) },
      ...PREVIEW_VIEWS.map((q) => ({ type: 'image', mimeType: 'image/png', data: pngOf(cells, q).toString('base64') })),
    ],
    isError: !report.ok,
  };
}

const opts = (a) => ({ size: a.size ?? DEFAULT_SIZE, seed: a.seed ?? DEFAULT_SEED });
const TOOL_IMPL = {
  construction_guide: () => ({ content: [{ type: 'text', text: buildSystemPrompt({ examples: builtinsSource(), mode: 'chat' }) }] }),
  construct_exec: (a) => result(runCode(String(a.code ?? ''), opts(a))),
  construct_builtin: (a) => result(builtinCells(a.key, a.variant, opts(a))),
};

function callTool({ name, arguments: a = {} } = {}) {
  try {
    if (!TOOL_IMPL[name]) throw new Error(`Unknown tool ${name}`);
    return TOOL_IMPL[name](a);
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

const METHODS = {
  initialize: (params) => ({ protocolVersion: params?.protocolVersion ?? FALLBACK_PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER }),
  'tools/list': () => ({ tools: TOOLS }),
  'tools/call': (params) => callTool(params),
  ping: () => ({}),
};

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const { id, method, params } = req;
  if (id === undefined) return; // notifications need no reply
  if (!METHODS[method]) { send({ id, error: { code: -32601, message: `Method not found: ${method}` } }); return; }
  try { send({ id, result: METHODS[method](params) }); } catch (err) { send({ id, error: { code: -32603, message: err.message } }); }
});
