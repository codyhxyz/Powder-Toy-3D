// Shared by the construction CLI and MCP server: run code in a Node vm with a
// timeout, render previews, and read the built-ins' source for the prompt.

import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { execConstruction, runGenerator, EXEC_TIMEOUT_MS, API_NAMES } from '../src/constructions/runtime.js';
import { BUILTINS } from '../src/constructions/builtins.js';
import { BUILDS } from '../src/elements.js';
import { renderIso, encodePNG } from '../src/constructions/preview.js';

export const DEFAULT_SIZE = 5;       // the app's default brush size (T = 1)
export const DEFAULT_SEED = 1;
export const DEFAULT_MAX_SPAN = 128; // the default 128³ grid

// A fresh vm context per run, stopped after EXEC_TIMEOUT_MS.
export const vmRun = (code, api) => {
  const ctx = vm.createContext(Object.fromEntries(API_NAMES.map((k) => [k, api[k]])));
  vm.runInContext(`"use strict";\n(() => {\n${code}\n})();`, ctx, { timeout: EXEC_TIMEOUT_MS, filename: 'construction.js' });
};

export const runCode = (code, { size = DEFAULT_SIZE, seed = DEFAULT_SEED } = {}) => execConstruction(code, { size, seed }, vmRun);

export const pngOf = (cells, quarter = 0) => Buffer.from(encodePNG(renderIso(cells, { quarter }), zlib.deflateSync));

// the built-ins' source for the prompt: the human scale they share (shared.js), then the built-ins
const source = (name) => fs.readFileSync(new URL(`../src/constructions/${name}`, import.meta.url), 'utf8');
export const builtinsSource = () => `${source('shared.js')}\n${source('builtins.js')}`;

export const BUILT_IN_KEYS = BUILDS.filter((b) => BUILTINS[b.key]).map((b) => b.key);

// A built-in by key (case-insensitive) and variant (default: its first).
export function builtinCells(key, variant, { size = DEFAULT_SIZE, seed = DEFAULT_SEED } = {}) {
  const build = BUILDS.find((b) => b.key === String(key).toUpperCase());
  if (!build || !BUILTINS[build.key]) throw new Error(`No built-in ${key}. Try: ${BUILT_IN_KEYS.join(', ')}`);
  return runGenerator(BUILTINS[build.key], { size, seed, variant: variant ?? build.variants?.[0][0] });
}
