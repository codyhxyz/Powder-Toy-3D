// WGSL operator mixing, CPU only (a deploy gate). WGSL has no precedence
// between some operators: a bitwise operator's operands are unary expressions,
// a shift's too, a relational expression compares two shift expressions, and
// && / || join relational expressions (WGSL spec, "Operator Precedence and
// Associativity": "a < b & c" or "a && b || c" need parentheses). Chrome's
// Tint rejects such a module; naga accepts it, so the CPU checks passed and
// the site stopped on every map with "mixing '>' and '&' requires
// parenthesis" (nativeWindowactShift, 2026-10-24).
//
// Every module under src/ that exports WGSL_CHECK (src/gpu/checks.js) is
// generated for each check grid, as tools/check-wgsl.mjs does, and each
// distinct text is tokenized and its expressions checked against those rules.
//
// usage: node tools/check-wgsl-operators.mjs [--file part]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const FILE = argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : null;
// tools/check-wgsl.mjs's grids
const GRIDS = { 32: [32, 32, 32], 64: [64, 64, 64], 128: [128, 128, 128], wide: [160, 96, 160], valley: [256, 96, 128], giant: [128, 384, 128] };

async function makeGrids() {
  let layout = null;
  try { ({ gridLayout: layout } = await import(pathToFileURL(join(ROOT, 'src/sim.js')))); } catch { /* sizes only */ }
  return Object.fromEntries(Object.entries(GRIDS).map(([k, [nx, ny, nz]]) => {
    const g = { ...(layout ? layout(nx, ny, nz) : { nx, ny, nz }), name: k };
    g.slots ??= nx * ny * nz;
    g.bx ??= nx / 4; g.by ??= ny / 4; g.bz ??= nz / 4;
    g.nbricks ??= g.slots / 64;
    g.nsuper ??= g.slots / 1024;
    return [k, g];
  }));
}
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.js$/.test(n) ? [p] : [];
});

// ---------------------------------------------------------------- tokens

const PUNCT = ['<<=', '>>=', '&&', '||', '<<', '>>', '<=', '>=', '==', '!=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '++', '--',
  '&', '|', '^', '<', '>', '+', '-', '*', '/', '%', '!', '~', '=', '(', ')', '[', ']', '{', '}', ',', ';', ':', '.', '@'];
// identifiers a "<" right after opens a template list (types, bitcast, var<storage, …>)
const TEMPLATED = /^(var|vec[234]|mat[234]x[234]|array|ptr|atomic|bitcast|binding_array|texture_\w+)$/;

function tokenize(code) {
  const src = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const out = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    const word = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 64)) ?? /^(0[xX][0-9a-fA-F]+|\d*\.?\d+([eE][+-]?\d+)?)[a-z]*/.exec(src.slice(i, i + 64));
    if (word) { out.push({ t: word[0], line, word: true }); i += word[0].length; continue; }
    const p = PUNCT.find((s) => src.startsWith(s, i));
    out.push({ t: p ?? c, line });
    i += (p ?? c).length;
  }
  // drop template lists: vec3<f32>, array<u32, 4>, bitcast<u32>(…)
  const kept = [];
  for (let k = 0; k < out.length; k++) {
    kept.push(out[k]);
    if (!(out[k].word && TEMPLATED.test(out[k].t) && out[k + 1]?.t === '<')) continue;
    let depth = 0;
    for (k++; k < out.length; k++) {
      const t = out[k].t;
      if (t === '<') depth++;
      else if (t === '>') depth--;
      else if (t === '>>') depth -= 2;
      if (depth <= 0) break;
    }
  }
  return kept;
}

// ---------------------------------------------------------------- rules

const BITWISE = new Set(['&', '|', '^']), SHIFT = new Set(['<<', '>>']), REL = new Set(['<', '>', '<=', '>=', '==', '!=']);
const LOGIC = new Set(['&&', '||']), ARITH = new Set(['+', '-', '*', '/', '%']);
const BINARY = new Set([...BITWISE, ...SHIFT, ...REL, ...LOGIC, ...ARITH]);
const UNARY = new Set(['-', '!', '~', '*', '&']);
const OPEN = new Set(['(', '[', '{']), CLOSE = new Set([')', ']', '}']);
// tokens that end an expression run at its own depth
const BOUNDARY = new Set([',', ';', ':', '=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '++', '--', '@',
  'return', 'let', 'var', 'const', 'if', 'else', 'loop', 'while', 'for', 'switch', 'case', 'default', 'break', 'continue', 'discard', 'fn', 'struct', 'override', 'continuing']);

// The binary operators of one run (a parenthesized or indexed part counts as an operand).
function runProblems(ops) {
  if (!ops.length) return null;
  const kinds = new Set(ops.map((o) => o.t));
  const bit = ops.filter((o) => BITWISE.has(o.t));
  if (bit.length) return kinds.size > 1 ? ops : null;   // a bitwise expression: one operator, unary operands
  if ([...kinds].filter((k) => LOGIC.has(k)).length > 1) return ops;   // && with ||
  // the relational operands, between the logical operators
  let seg = [];
  for (const o of [...ops, { t: '&&' }]) {
    if (!LOGIC.has(o.t)) { seg.push(o); continue; }
    const rel = seg.filter((s) => REL.has(s.t));
    if (rel.length > 1) return seg;   // a < b < c
    // a shift's operands are unary: no arithmetic in the same relational operand
    const sides = rel.length ? [seg.slice(0, seg.indexOf(rel[0])), seg.slice(seg.indexOf(rel[0]) + 1)] : [seg];
    for (const side of sides) if (side.some((s) => SHIFT.has(s.t)) && side.length > 1) return seg;
    seg = [];
  }
  return null;
}

function moduleProblems(code) {
  const toks = tokenize(code), problems = [];
  const stack = [[]];   // per open bracket: the binary operators of its current run
  const flush = () => { const bad = runProblems(stack.at(-1)); if (bad) problems.push(bad); stack[stack.length - 1] = []; };
  for (let k = 0; k < toks.length; k++) {
    const { t } = toks[k], prev = toks[k - 1];
    if (OPEN.has(t)) { stack.push([]); continue; }
    if (CLOSE.has(t)) { flush(); if (stack.length > 1) stack.pop(); continue; }
    if (BOUNDARY.has(t)) { flush(); continue; }
    if (!BINARY.has(t)) continue;
    // unary: first in its run, or after an operator or an opening
    const afterOperand = prev && (prev.word || CLOSE.has(prev.t));
    if (UNARY.has(t) && !afterOperand) continue;
    stack.at(-1).push(toks[k]);
  }
  flush();
  return problems.map((ops) => `line ${ops[0].line}: ${ops.map((o) => o.t).join(' ')} mixed without parentheses`);
}

// ---------------------------------------------------------------- main

const grids = await makeGrids();
const files = walk(join(ROOT, 'src')).filter((f) => /export\s+(const|let|function)\s+WGSL_CHECK\b/.test(readFileSync(f, 'utf8')))
  .filter((f) => !FILE || relative(ROOT, f).includes(FILE));
let failures = 0;
const seen = new Set();
for (const f of files) {
  const rel = relative(ROOT, f);
  let mod;
  try { mod = await import(pathToFileURL(f)); } catch (e) { console.log(`FAIL ${rel}: doesn't import in Node: ${e.message.split('\n')[0]}`); failures++; continue; }
  const list = typeof mod.WGSL_CHECK === 'function' ? mod.WGSL_CHECK() : mod.WGSL_CHECK;
  for (const entry of list ?? []) {
    const keys = entry.grids === false ? [null] : (Array.isArray(entry.grids) ? entry.grids : Object.keys(GRIDS));
    for (const k of keys) {
      let code;
      try { code = entry.code(k ? grids[k] : null); } catch { continue; }   // (tools/check-wgsl.mjs reports generators that throw)
      if (seen.has(code)) continue;
      seen.add(code);
      for (const p of moduleProblems(code)) { failures++; console.log(`FAIL ${entry.name}@${k ?? '-'} (${rel}): ${p}`); }
    }
  }
}
console.log(`wgsl operators: ${seen.size} distinct modules, ${failures} problem(s)`);
process.exit(failures ? 1 : 0);
