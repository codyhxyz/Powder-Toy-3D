// Lint for docs/scaling.md D5 and docs/webgpu.md D8.1: the simulation state is
// reached only through the accessors in src/shaders/common.js (fetchA, fetchB,
// fetchF and their slot twins to read; writeState, writeStateS and writeCell
// to write, and writeFlags where a pass settles only a cell's flags, as the
// move's quiet blocks do in place, D2)
// and, on the CPU, through Simulation's readState/readCell in src/sim.js, so
// its layout and format can change in those two files (and the slot order
// only through brickId, slotOf, brickCoord and cellOf, C2). Fails on any
// direct access elsewhere, e.g. in code merged from main:
//   - WGSL indexing a state buffer: A[...], B[...], F[...]
//   - WGSL declaring a state binding (the prelude declares A, B, F)
//   - JS reading a state buffer back (gpu.readback.buffer(sim.state.A, ...))
//     or a state target (sim.targets[...]) outside src/sim.js
//   - while the port runs, the WebGL rules too: GLSL sampling or declaring
//     tA/tB/tF, or declaring a pass's own state outputs
// The WGSL rules read only shader text: the template literals of a JS file
// (their ${...} parts are JS), so JS arrays named A or B don't count.
// A self-test runs first: known violations must be caught, accessors not.
// usage: node tools/check-state-access.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '../..');
const SELF = 'tools/check-state-access.mjs';
const OWNER = 'src/shaders/common.js';

const SAMPLE = 'texelFetch|texelFetchOffset|texture|textureLod|textureLodOffset|textureOffset|textureGrad|textureGradOffset|textureProj|textureProjLod|textureSize';
// where: directories; text: 'shader' (template literal text only) or 'all' (every line)
const RULES = [
  { where: ['src'], except: [OWNER], text: 'shader', what: 'indexes a state buffer (use fetchA/fetchB/fetchF, writeState/writeCell)',
    re: /(?<![\w.])[ABF]\s*\[/ },
  { where: ['src'], except: [OWNER], text: 'shader', what: 'declares a state binding (the prelude has A, B and F)',
    re: /\bvar\s*<\s*storage[^>]*>\s*[ABF]\s*:/ },
  { where: ['src', 'tools', 'scripts'], except: ['src/sim.js'], text: 'all', what: 'reads a state buffer back (use sim.readState/readCell)',
    re: /readback\s*\.\s*buffer\s*\(\s*[\w.()]*state\s*\.\s*[ABF]\b/ },
  { where: ['src', 'tools', 'scripts'], except: ['src/sim.js'], text: 'all', what: 'reads a state target back (use sim.readState/readCell)',
    re: /readRenderTargetPixels(?:Async)?\s*\(\s*[\w.()]*targets\s*\[/ },
  // WebGL, until every pass is ported (docs/webgpu.md J1; U16 removes these)
  { where: ['src'], except: [OWNER], text: 'all', what: 'samples a state texture (use fetchA/fetchB/fetchF)',
    re: new RegExp(`\\b(?:${SAMPLE})\\s*\\(\\s*t[ABF]\\s*[,)]`) },
  { where: ['src'], except: [OWNER], text: 'all', what: 'declares a state sampler (the prelude has the state)',
    re: /\buniform\s+(?:(?:high|medium|low)p\s+)?[iu]?sampler2D\s+t[ABF]\s*;/ },
  { where: ['src'], except: [OWNER], text: 'all', what: 'declares state outputs (use writeState)',
    re: /\bout\s+(?:(?:high|medium|low)p\s+)?(?:[iu]?vec4|uint)\s+(?:o[ABF]|outState[AB]|outFlags)\s*;|\boutState[AB]\b|\boutFlags\b/ },
];

// The source with everything but template literal text blanked (newlines
// kept, so lines still match): a small JS scanner that knows comments,
// strings, regex literals and ${...} nesting.
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);
export function shaderText(src) {
  let out = '', mode = 'code', depth = 0, prev = '', word = '', inClass = false;
  const holes = [];   // brace depth at each open ${
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (mode === 'code') {
      if (/[\w$]/.test(c)) { word += c; prev = c; out += ' '; continue; }
      const lastWord = word;
      word = '';
      if (c === '/' && n === '/') { mode = 'line'; out += ' '; continue; }
      if (c === '/' && n === '*') { mode = 'block'; out += ' '; continue; }
      if (c === "'" || c === '"') { mode = c; out += ' '; continue; }
      if (c === '`') { mode = 'tpl'; out += ' '; continue; }
      if (c === '/' && (prev === '' || REGEX_AFTER.test(prev) || (lastWord && REGEX_WORDS.has(lastWord)))) {
        mode = 're'; inClass = false; out += ' '; continue;
      }
      if (c === '{') depth++;
      if (c === '}') {
        if (holes.length && depth === holes.at(-1)) { holes.pop(); mode = 'tpl'; out += ' '; continue; }
        depth--;
      }
      if (!/\s/.test(c)) prev = c;
      else if (lastWord) word = lastWord;   // "return /x/": the word holds across the space
      out += blank(c);
    } else if (mode === 'line') {
      if (c === '\n') mode = 'code';
      out += blank(c);
    } else if (mode === 'block') {
      if (c === '*' && n === '/') { out += '  '; i++; mode = 'code'; continue; }
      out += blank(c);
    } else if (mode === "'" || mode === '"') {
      if (c === '\\') { out += ' ' + blank(n ?? ''); i++; continue; }
      if (c === mode || c === '\n') { mode = 'code'; prev = c; }
      out += blank(c);
    } else if (mode === 're') {
      if (c === '\\') { out += ' ' + blank(n ?? ''); i++; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if ((c === '/' && !inClass) || c === '\n') { mode = 'code'; prev = 'x'; }   // (its flags read as a word)
      out += blank(c);
    } else {   // template text
      if (c === '\\') { out += c + (n ?? ''); i++; continue; }
      if (c === '`') { mode = 'code'; prev = '`'; out += ' '; continue; }
      if (c === '$' && n === '{') { holes.push(depth); mode = 'code'; prev = '{'; out += '  '; i++; continue; }
      out += c;
    }
  }
  return out;
}

const files = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(m?js)$/.test(n) ? [p] : [];
});

function violations(rel, src, rules) {
  const found = [];
  const shader = rules.some((r) => r.text === 'shader') ? shaderText(src).split('\n') : null;
  const lines = src.split('\n');
  for (const rule of rules) {
    if (rule.except.includes(rel)) continue;
    (rule.text === 'shader' ? shader : lines).forEach((line, i) => {
      if (rule.re.test(line)) found.push({ rel, line: i + 1, what: rule.what, text: lines[i].trim() });
    });
  }
  return found;
}

// ---- self-test: the scanner and the rules on known text ----
const SAMPLES = [
  ['bad', 'const k = (g) => /* wgsl */ `\nfn f(p: vec3i) -> vec4f { return A[H.src * SLOTS + slotOf(p)]; }\n`;'],
  ['bad', 'const k = `${prelude(g)}\nfn w(s: u32) { F[s] = 0u; }`;'],
  ['bad', 'const k = `@group(1) @binding(0) var<storage, read_write> B: array<vec4f>;`;'],
  ['bad', 'const k = `${x ? `${y}` : \'}\'}\nlet v = B [i];`;'],
  ['bad', 'const bytes = await gpu.readback.buffer(sim.state.A, 0, 64);'],
  ['ok', 'const k = `fn f(p: vec3i) -> vec4f { return fetchA(p) + fetchB(p); }`;'],
  ['ok', 'const k = `if (fl != f0) { writeFlags(c, fl); }`;'],
  ['ok', 'const [A, B] = await sim.readState();\nconst id = A[i * 4];   // JS, not shader text'],
  ['ok', 'const k = `${A[0]} cells`;   // a JS expression inside the template'],
  ['ok', 'const re = /`/; const x = A[1]; const s = "`"; const t = \'`\';'],
  ['ok', 'function f() { return /`[A]/.test(s) ? A[1] : B[2]; }'],
  ['ok', 'const k = `let na = array<vec4f, 6>(); let v = na[0]; let q = TB.elem[id].dens; let a = DATA[i];`;'],
  ['ok', 'const a = b / c; const d = A[2] / B[3];'],
];
let selfBad = 0;
for (const [want, src] of SAMPLES) {
  const n = violations('src/sample.js', src, RULES).length;
  if ((want === 'bad') !== (n > 0)) { selfBad++; console.log(`self-test: ${want} sample ${n ? 'flagged' : 'passed'}:\n    ${src.replace(/\n/g, '\n    ')}`); }
}
if (selfBad) {
  console.log(`check-state-access self-test failed (${selfBad})`);
  process.exit(2);
}

let failures = 0;
const seen = new Set();
for (const dir of new Set(RULES.flatMap((r) => r.where))) {
  for (const f of files(join(root, dir))) {
    const rel = relative(root, f);
    if (rel === SELF || seen.has(rel)) continue;
    seen.add(rel);
    const rules = RULES.filter((r) => r.where.includes(dir));
    for (const v of violations(rel, readFileSync(f, 'utf8'), rules)) {
      failures++;
      console.log(`${v.rel}:${v.line}: ${v.what}\n    ${v.text}`);
    }
  }
}
console.log(failures ? `${failures} direct state access(es)` : `state access OK: only through the accessors (self-test: ${SAMPLES.length} samples)`);
process.exit(failures ? 1 : 0);
