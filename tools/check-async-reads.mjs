// Lint for docs/webgpu.md W6: every GPU→CPU read of the simulation is a
// promise now (C7), so a call to readState, readCell, census, gpuSync,
// readCopies, readMaps or readFlow in tools/ or scripts/ must be awaited or
// .then'ed. A missed await doesn't throw, it turns
//   check('rock painted', sim.census()[E.ROCK]?.n > 0)
// into a comparison of undefined that fails quietly, and
//   const [A] = sim.readState()
// into a TypeError only if it's lucky.
//
// A call counts as consumed when the call itself (not an index or a field of
// its promise) is
//   - awaited:                  await sim.readState(), (await sim.census())[id]
//   - chained:                  sim.readState().then(...)  (or .catch, .finally)
//   - handed to the caller:     return sim.census(); () => sim.census()
//   - an element of an array given to Promise.all, allSettled, race or any
//     that is itself consumed: await Promise.all([a.readState(), b.readState()])
// A function of the file that hands a read to its caller, or is async and
// reads, joins the list: its own calls must be consumed too, so
//   const cell = (x, y, z) => sim.readCell(x, y, z);
//   check(cell(8, 8, 8)[0][0] === E.ROCK, ...)
// fails at the check (bare calls for `const cell`, `.ids(` calls for
// `H.ids = async ...`). Definitions don't count (function census(...),
// async readState() { ... }), nor bare calls of a function the file defines
// synchronously (a CPU twin's own census(w) { ... }). The scan reads code
// only: comments, strings, template text and regex literals are blanked
// first, ${...} kept.
// Its blind spots: a promise kept in a variable and awaited later is flagged
// (await the call itself); an anonymous arrow that returns a read is trusted
// whatever its caller does with it (xs.map((x) => sim.readCell(...x)) needs
// its Promise.all); two functions of one name in one file are one name. A
// line holding `check-async-reads: ignore <why>` is skipped, for a call the
// scan misreads; say why.
//
// PENDING lists the files other units still port (docs/webgpu.md J1): they are
// reported, not failed, until their unit converts them. A clean one is noted;
// U16 deletes the list. Never add a file of your own to it.
// A self-test runs first: known misses must be caught, known good forms not.
// usage: node tools/check-async-reads.mjs [--verbose]   (--verbose: every pending site)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['tools', 'scripts'];
export const NAMES = ['readState', 'readCell', 'census', 'gpuSync', 'readCopies', 'readMaps', 'readFlow'];
const IGNORE = 'check-async-reads: ignore';

/** @type {Record<string, string>} file → the unit that converts it (J1), or why it waits */
const PENDING = {
  'tools/activity-check.mjs': 'U2', 'tools/sleep-crossover.mjs': 'U2',
  'tools/derived-bench.mjs': 'U4', 'tools/detail-bench.mjs': 'U6', 'tools/profile-check.mjs': 'U7',
  'tools/headless-check.mjs': 'U8', 'tools/idle-check.mjs': 'U8',
  'tools/caves-check.mjs': 'U10', 'tools/far-check.mjs': 'U10', 'tools/gen-check.mjs': 'U10',
  'tools/island-dump.mjs': 'U10', 'tools/landforms-gpu.mjs': 'U10', 'tools/world-check.mjs': 'U10',
  'tools/burrower-laser-check.mjs': 'U11', 'tools/flask-check.mjs': 'U11', 'tools/gibs-check.mjs': 'U11',
  'tools/kick-hook-check.mjs': 'U11', 'tools/pov-engine-check.mjs': 'U11', 'tools/pov-player-check.mjs': 'U11',
  'tools/pov-tools-a.mjs': 'U11', 'tools/pov-tools-b.mjs': 'U11',
  'scripts/check-wand-recipes.mjs': 'U11', 'scripts/check-wand-world.mjs': 'U11',
  'tools/elec-gpu-check.mjs': 'U12', 'tools/nt-mat-gpu.mjs': 'U12', 'tools/rays-gpu.mjs': 'U12',
  'tools/bench.mjs': 'U14b', 'tools/headless-cost.mjs': 'U14b', 'tools/state-hash.mjs': 'U14b',
  // no J1 owner: its timing fence is raw GL (a 1×1 WebGLRenderTarget and gl.readPixels), a
  // rewrite rather than an await; U14b's "no getContext() left in tools/" covers it
  'tools/crystal-check.mjs': 'U14b',
};

// ---------------------------------------------------------------- the scanner

const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'yield', 'await', 'instanceof']);
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const KEYWORDS = new Set([...REGEX_WORDS, ...CONTROL]);
const isWord = (c) => c !== undefined && /[\w$]/.test(c);
const isSpace = (c) => c !== undefined && /\s/.test(c);

/**
 * The source with comments, string and template text and regex literals
 * blanked (same length, newlines kept), template ${...} code kept.
 * @param {string} src
 */
export function codeOnly(src) {
  const out = src.split('');
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  const holes = [];   // brace depth at each open ${
  let depth = 0, i = 0, prev = '', word = '';
  // template text from i to its closing ` or the next ${, which is kept
  const template = () => {
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { blank(i++); blank(i++); continue; }
      if (c === '`') { i++; prev = '`'; return; }
      if (c === '$' && src[i + 1] === '{') { holes.push(depth); depth++; i += 2; prev = '{'; return; }
      blank(i++);
    }
  };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (isWord(c)) {
      let j = i;
      while (isWord(src[j])) j++;
      word = src.slice(i, j);
      prev = 'w';
      i = j;
      continue;
    }
    if (isSpace(c)) { i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') blank(i++); continue; }
    if (c === '/' && n === '*') {
      blank(i++); blank(i++);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      if (i < src.length) { blank(i++); blank(i++); }
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') blank(i++);
        blank(i++);
      }
      i++;
      prev = c;
      continue;
    }
    if (c === '`') { i++; template(); continue; }
    if (c === '/' && (prev === '' || REGEX_AFTER.test(prev) || (prev === 'w' && REGEX_WORDS.has(word)))) {
      i++;
      let cls = false;
      while (i < src.length && src[i] !== '\n') {
        const r = src[i];
        if (r === '\\') { blank(i++); blank(i++); continue; }
        if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) break;
        blank(i++);
      }
      i++;
      prev = 'w';   // flags follow; a / after a regex divides
      word = '';
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (holes.length && holes.at(-1) === depth - 1) { holes.pop(); depth--; i++; template(); continue; }
      depth--;
    }
    prev = c;
    i++;
  }
  return out.join('');
}

const OPEN = { ')': '(', ']': '[', '}': '{' };
const CLOSE = { '(': ')', '[': ']', '{': '}' };
// the index of the bracket matching the one at i (forwards from an opener, backwards from a closer)
function match(code, i) {
  const fwd = code[i] in CLOSE, step = fwd ? 1 : -1;
  let d = 0;
  for (let j = i; j >= 0 && j < code.length; j += step) {
    const k = code[j];
    if (k in CLOSE) d += fwd ? 1 : -1;
    else if (k in OPEN) d += fwd ? -1 : 1;
    if (d === 0) return j;
  }
  return -1;
}
const back = (code, i) => { while (i >= 0 && isSpace(code[i])) i--; return i; };
const ahead = (code, i) => { while (i < code.length && isSpace(code[i])) i++; return i; };
const wordBefore = (code, i) => { const end = i + 1; while (i >= 0 && isWord(code[i])) i--; return code.slice(i + 1, end); };
const wordAt = (code, i) => { let j = i; while (isWord(code[j])) j++; return code.slice(i, j); };

// where the member chain ending in the name at s starts: window.__app.sim.readState → window,
// foo()[0].readCell → foo, (await x).sim.census → the opening parenthesis
function chainStart(code, s) {
  let j = s;
  for (;;) {
    let k = back(code, j - 1);
    if (code[k] !== '.') return j;
    k--;
    if (code[k] === '?') k--;
    k = back(code, k);
    for (;;) {
      if (code[k] === ')' || code[k] === ']') {
        const o = match(code, k);
        if (o < 0) return j;
        k = back(code, o - 1);
        if (code[k] === '.' && code[k - 1] === '?') k = back(code, k - 2);   // f?.(), a?.[0]
        // a call or an index (foo(...), a[0], f()()) continues the chain; a group after a keyword doesn't
        if ((isWord(code[k]) && !KEYWORDS.has(wordBefore(code, k))) || code[k] === ')' || code[k] === ']') continue;
        j = o;
        break;
      }
      if (isWord(code[k])) { while (k >= 0 && isWord(code[k])) k--; j = k + 1; break; }
      return j;
    }
  }
}

const CHAINED = /^\??\.\s*(then|catch|finally)\s*\(/;
const COMBINATOR = /\bPromise\s*\.\s*(all|allSettled|race|any)\s*$/;
/**
 * How the call whose chain starts at `start` and whose argument list closes
 * at `close` is consumed: { how: 'await' | 'then' }, { how: 'return' | 'arrow',
 * at } (handed to the caller; `at` is the return keyword or the arrow's =),
 * or null when it isn't.
 */
function consumption(code, start, close) {
  // parentheses around the call, (sim.census()), are closed right after it
  let k = back(code, start - 1), wraps = 0;
  while (code[k] === '(') { wraps++; k = back(code, k - 1); }
  let a = ahead(code, close + 1);
  for (let w = 0; w < wraps && code[a] === ')'; w++) a = ahead(code, a + 1);
  const rest = code.slice(a, a + 32);
  if (CHAINED.test(rest)) return { how: 'then' };
  const used = /^(\?\.|[.[(`])/.test(rest);           // the promise itself indexed, read or called
  const whole = a >= code.length || /^[;)\]},]/.test(rest);   // nothing but the call is handed back
  const w = wordBefore(code, k);
  if (w === 'await') return used ? null : { how: 'await' };
  if (w === 'return') return whole ? { how: 'return', at: k - 5 } : null;
  if (code[k] === '>' && code[k - 1] === '=') return whole ? { how: 'arrow', at: k - 1 } : null;
  // an element of an array literal handed to a Promise combinator
  for (let j = start - 1, d = 0; j >= 0; j--) {
    const c = code[j];
    if (c in OPEN) d++;
    else if (c in CLOSE) {
      if (d > 0) { d--; continue; }
      if (c !== '[') return null;
      const p = back(code, j - 1);
      if (code[p] !== '(') return null;
      const e = back(code, p - 1);
      if (!COMBINATOR.test(code.slice(Math.max(0, e - 60), e + 1))) return null;
      return consumption(code, chainStart(code, e - wordBefore(code, e).length + 1), match(code, p));
    }
  }
  return null;
}

// where a concise arrow body that starts at s ends
function conciseEnd(code, s) {
  let d = 0;
  for (let i = s; i < code.length; i++) {
    const c = code[i];
    if (c in CLOSE) d++;
    else if (c in OPEN) { if (d === 0) return i; d--; }
    else if (d === 0 && (c === ',' || c === ';')) return i;
    else if (d === 0 && c === '\n' && !/[.?:+\-*/%&|<>=]/.test(code[ahead(code, i)] ?? '')) return i;
  }
  return code.length;
}

/**
 * Every function body (a brace body, or a named arrow's expression), and the
 * named functions: { name, member, async, start, end, arrow } where member
 * means it is called as x.name(...) and arrow is the index of a concise
 * arrow's =>.
 */
function functions(code) {
  const ranges = [], defs = [];
  const at = new Map();   // brace body start → its def
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '{') continue;
    const k = back(code, i - 1);
    let name = null, isFn = false, member = false, async = false;
    if (code[k] === '>' && code[k - 1] === '=') isFn = true;
    else if (code[k] === ')') {
      const o = match(code, k), q = back(code, o - 1);
      if (isWord(code[q]) && !CONTROL.has(wordBefore(code, q))) {
        isFn = true;
        const w = wordBefore(code, q), before = wordBefore(code, back(code, q - w.length));
        if (w !== 'function') {   // function name(...) { or a method's name(...) {
          name = w;
          member = before !== 'function';
          async = before === 'async' || wordBefore(code, back(code, back(code, q - w.length) - before.length)) === 'async';
        }
      }
    }
    if (!isFn) continue;
    const end = match(code, i);
    if (end < 0) continue;
    ranges.push({ start: i, end });
    if (name && !KEYWORDS.has(name)) at.set(i, { name, member, async, start: i, end, arrow: -1 });
  }
  // name = [async] function (...) {...} | name = [async] (...) => ... | name: [async] x => ...
  for (const m of code.matchAll(/(?<![\w$])([\w$]+)\s*(=(?![=>])|:)\s*/g)) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    let j = m.index + m[0].length, async = false;
    if (wordAt(code, j) === 'async') { async = true; j = ahead(code, j + 5); }
    const member = m[2] === ':' || code[back(code, m.index - 1)] === '.';
    let arrow = -1;
    if (wordAt(code, j) === 'function') {
      const o = code.indexOf('(', j), c = o < 0 ? -1 : match(code, o), b = c < 0 ? -1 : ahead(code, c + 1);
      if (code[b] === '{') at.set(b, { name, member, async, start: b, end: match(code, b), arrow: -1 });
      continue;
    }
    if (code[j] === '(') { const c = match(code, j); if (c < 0) continue; arrow = ahead(code, c + 1); }
    else if (isWord(code[j])) arrow = ahead(code, j + wordAt(code, j).length);
    if (arrow < 0 || code[arrow] !== '=' || code[arrow + 1] !== '>') continue;
    const body = ahead(code, arrow + 2);
    if (code[body] === '{') { at.set(body, { name, member, async, start: body, end: match(code, body), arrow: -1 }); continue; }
    const def = { name, member, async, start: body, end: conciseEnd(code, body), arrow };
    ranges.push({ start: def.start, end: def.end, def });
    defs.push(def);
  }
  for (const r of ranges) if (!r.def && at.has(r.start)) r.def = at.get(r.start);
  for (const d of at.values()) defs.push(d);
  return { ranges, defs };
}

// names of NAMES this file defines as synchronous functions, and nothing else
function syncLocals(code) {
  const kinds = new Map();
  const note = (name, sync) => kinds.set(name, (kinds.get(name) ?? true) && sync);
  for (const name of NAMES) {
    for (const m of code.matchAll(new RegExp(`(\\basync\\s+)?\\bfunction\\s*\\*?\\s*${name}\\s*\\(`, 'g'))) note(name, !m[1]);
    for (const m of code.matchAll(new RegExp(`\\b${name}\\s*=\\s*(async\\b)?\\s*(function\\b|\\([^()]*\\)\\s*=>\\s*(\\{)?|[\\w$]+\\s*=>\\s*(\\{)?)`, 'g'))) {
      note(name, !m[1] && (m[2].startsWith('function') || Boolean(m[3] || m[4])));
    }
  }
  return new Set([...kinds].filter(([, sync]) => sync).map(([name]) => name));
}

/**
 * The unconsumed calls in one file's source.
 * @param {string} src
 * @param {boolean} [html] scan only the file's <script> elements
 * @returns {{ line: number, col: number, name: string, text: string }[]}
 */
export function scan(src, html = false) {
  if (html) src = src.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)|[^\n]/g, (all, open) => (open ? all : ' '));
  const code = codeOnly(src), lines = src.split('\n');
  const local = syncLocals(code), { ranges, defs } = functions(code);
  const innermost = (p) => {
    let best = null;
    for (const r of ranges) if (r.start < p && p < r.end && (!best || r.end - r.start < best.end - best.start)) best = r;
    return best?.def ?? null;
  };
  // the file's functions that hand a read back or read while async: name → { member, via }
  const derived = new Map();
  let found = [];
  for (let pass = 0; pass < 8; pass++) {
    found = [];
    const known = derived.size;
    const names = [...NAMES, ...derived.keys()];
    const call = new RegExp(`(?<![\\w$])(${names.map((n) => n.replace(/\$/g, '\\$')).join('|')})\\s*(\\?\\.\\s*)?\\(`, 'g');
    for (const m of code.matchAll(call)) {
      const s = m.index, name = m[1], open = s + m[0].length - 1, close = match(code, open);
      if (close < 0) continue;
      // a definition: function name(...), or a method's name(...) { ... }
      if (wordBefore(code, back(code, s - 1)) === 'function' || code[ahead(code, close + 1)] === '{') continue;
      const member = code[back(code, s - 1)] === '.';
      const via = derived.get(name);
      if (via ? via.member !== member : !member && local.has(name)) continue;
      const line = code.slice(0, s).split('\n').length;
      if (lines[line - 1].includes(IGNORE)) continue;
      const used = consumption(code, chainStart(code, s), close);
      if (!used) {
        const col = s - code.lastIndexOf('\n', s - 1);
        found.push({ line, col, name: via ? `${name} (reads with ${via.via})` : name, text: lines[line - 1].trim() });
        continue;
      }
      const handed = used.how === 'arrow' ? defs.find((d) => d.arrow === used.at)
        : used.how === 'return' ? innermost(used.at) : null;
      const own = innermost(s);
      for (const d of [handed, own?.async ? own : null]) {
        if (d && !NAMES.includes(d.name) && !derived.has(d.name)) derived.set(d.name, { member: d.member, via: via?.via ?? name });
      }
    }
    if (derived.size === known) break;
  }
  return found;
}

// ---------------------------------------------------------------- self-test

const BAD = [
  'const [A] = sim.readState();',
  "check('rock', a.sim.census()[E.ROCK]?.n > 0);",
  'sim.gpuSync();',
  'const c = window.__app.sim.census()[E.WOOD];',
  'const id = x.readCell(1, 2, 3)[0][0];',
  'a.sim.gpuSync?.();',
  'const m = (await getSim()).readMaps();',
  'const t = `${sim.census()[1].n} cells`;',
  'foo(sim.readFlow());',
  'void sim.readCopies();',
  'await Promise.all([foo(sim.readState())]);',
  'Promise.all([sim.readState()]);',
  'const census = () => ev(() => 1);\nconst c = census();',
  'const c = window.__pageGpu.census();',
  'const y = (await sims())[0].census();',
  'return (sim.census()[E.WOOD]?.Tmax ?? 0) > 300;',
  'return window.__app.sim.census()[E.FIRE]?.n ?? 0;',
  'const n = await sim.census()[1];',
  'const n = await (sim.census())[1];',
  'const f = () => sim.census()[1];',
  'return sim.census() > 3;',
  'const all = await Promise.all([sim.readState()])[0];',
  'const cell = (x) => sim.readCell(x, 0, 0);\ncheck(cell(1)[0][0] === 3);',
  'function cell(x) { return sim.readCell(x, 0, 0); }\nconst c = cell(1)[0];',
  'const ids = async () => { const [A] = await sim.readState(); return A; };\nconst a = ids();',
  'H.ids = async () => (await sim.readState())[0];\nconst a = H.ids()[3];',
  'const t = { async sync() { await sim.gpuSync(); } };\nt.sync();',
  'const cell = (x) => sim.readCell(x, 0, 0);\nconst id = () => cell(1);\ncheck(id()[0] === 3);',
];
const GOOD = [
  'const [A] = await sim.readState();',
  'const n = (await a.sim.census())[E.ROCK]?.n ?? 0;',
  'sim.readState().then((s) => s);',
  'a.sim.gpuSync?.().then(done);',
  'return sim.census();',
  'const f = async () => sim.readState();\nawait f();',
  'await Promise.all([sim.readState(), s2.readCell(1, 2, 3)]);',
  'const census = (w) => { return w.length; };\nconst c = census(w);',
  'function readCell(page, x) { return page; }',
  'class S { async readState() { return 1; } census() { return 2; } }',
  '// sim.readState()',
  "const s = 'sim.census()';",
  'const t = `census() of ${n}`;',
  'const re = /readState\\(/;',
  'if (typeof sim.readState === "function") x = 1;',
  'const c = await window.__pageGpu.census(sim);',
  "x = sim.census(); // check-async-reads: ignore a sync CPU stand-in",
  'await (window.__app.sim).gpuSync();',
  'const x = await a.sims[0].readCell(1, 2, 3);',
  'const y = await sims()[0].census();',
  'return (sim.readState());',
  'const t = `${await sim.census()}`;',
  'const cell = (x) => sim.readCell(x, 0, 0);\ncheck((await cell(1))[0][0] === 3);',
  'async function ids() { return (await sim.readState())[0]; }\nconst a = await ids();',
  'const f = () => ev(async () => (await sim.census())[1]);\nf();',
  'H.ids = async () => (await sim.readState())[0];\nconst a = (await H.ids())[3];',
  'const t = { async sync() { await sim.gpuSync(); } };\nawait t.sync();',
  'const total = (c) => { let n = 0; for (const k in c) n += c[k]; return n; };\nconst t = total(c);',
  'const p = await ev(() => sim.census());',
];
const selfFails = [];
for (const s of BAD) if (scan(s).length !== 1) selfFails.push(`should catch exactly one (got ${scan(s).length}): ${s}`);
for (const s of GOOD) if (scan(s).length) selfFails.push(`should pass: ${s}`);
if (scan('<p>sim.census()</p>\n<script type="module">\nconst c = sim.census();\n</script>', true).length !== 1) {
  selfFails.push('should catch the one call in an HTML page\'s script');
}
if (selfFails.length) {
  console.error(`check-async-reads self-test failed:\n  ${selfFails.join('\n  ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------- the run

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const verbose = process.argv.includes('--verbose');
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules') return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(mjs|js|cjs|html)$/.test(n) ? [p] : [];
  });
  const files = DIRS.flatMap((d) => walk(join(ROOT, d))).map((f) => relative(ROOT, f).split('\\').join('/')).sort();
  const failed = [], pending = [], clean = [];
  for (const rel of files) {
    const found = scan(readFileSync(join(ROOT, rel), 'utf8'), rel.endsWith('.html'));
    if (PENDING[rel]) (found.length ? pending : clean).push([rel, found]);
    else if (found.length) failed.push([rel, found]);
  }
  for (const [rel] of clean) console.log(`note: ${rel} awaits every read now; delete it from PENDING`);
  for (const rel of Object.keys(PENDING)) if (!files.includes(rel)) console.log(`note: ${rel} is gone; delete it from PENDING`);
  for (const [rel, found] of pending) {
    console.log(`pending (${PENDING[rel]}): ${rel}, ${found.length} read${found.length === 1 ? '' : 's'} not awaited`);
    if (verbose) for (const f of found) console.log(`    ${rel}:${f.line}:${f.col}  ${f.name}(  ${f.text.slice(0, 120)}`);
  }
  if (failed.length) {
    console.error('These GPU reads are promises now (docs/webgpu.md W6, C7): await them.');
    for (const [rel, found] of failed) for (const f of found) console.error(`  ${rel}:${f.line}:${f.col}  ${f.name}(  ${f.text.slice(0, 120)}`);
    process.exit(1);
  }
  const n = files.length - pending.length;
  console.log(`async reads OK: ${n} files await every read (${pending.length} pending other units' ports)`);
}
