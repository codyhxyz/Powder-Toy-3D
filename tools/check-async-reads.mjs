// Lint for docs/webgpu.md W6: every GPU→CPU read of the simulation is a
// promise now (C7), and so is every fence (B8's gpu.fence(), page-gpu's
// fence), so a call to readState, readCell, census, gpuSync, fence,
// readCopies, readMaps or readFlow in tools/ or scripts/ must be awaited or
// .then'ed. A missed await doesn't throw, it turns
//   check('rock painted', sim.census()[E.ROCK]?.n > 0)
// into a comparison of undefined that fails quietly,
//   const [A] = sim.readState()
// into a TypeError only if it's lucky, and a timing loop's fence into a
// number that times the recording, not the GPU.
//
// A call counts as consumed when the call itself (not an index or a field of
// its promise) is
//   - awaited:                  await sim.readState(), (await sim.census())[id]
//   - chained:                  sim.readState().then(...)  (or .catch, .finally)
//   - handed to the caller:     return sim.census(); () => sim.census()
//   - an element of an array given to Promise.all, allSettled, race or any
//     that is itself consumed: await Promise.all([a.readState(), b.readState()])
// A function of the file that hands a read to its caller (the call, or a
// .then chain of it), or is async and reads, joins the list: its own calls
// must be consumed too, so
//   const cell = (x, y, z) => sim.readCell(x, y, z);
//   check(cell(8, 8, 8)[0][0] === E.ROCK, ...)
// fails at the check (bare calls for `const cell`, `.ids(` calls for
// `H.ids = async ...`). Definitions don't count (function census(...),
// async readState() { ... }), nor bare calls of a function the file defines
// synchronously (a CPU twin's own census(w) { ... }), unless that function
// hands a read back itself (function census() { return sim.census(); }). The
// scan reads code only: comments, strings, template text and regex literals
// are blanked first, ${...} kept.
// It also fails a predicate given to Playwright's waitForFunction (or to a
// function of the file that calls it) that returns a promise: an async one,
// one that hands a read back (() => sim.census(), .then chains included), or
// a function of the file named there that does either. waitForFunction
// doesn't await the predicate, so a pending promise counts as true and the
// wait passes at once.
// Its blind spots: a promise kept in a variable and awaited later is flagged
// (await the call itself); an anonymous arrow that returns a read is trusted
// whatever its caller does with it (xs.map((x) => sim.readCell(...x)) needs
// its Promise.all); two functions of one name in one file are one name. A
// line holding `check-async-reads: ignore <why>` is skipped, for a call the
// scan misreads; say why.
//
// PENDING lists the files other units still port (docs/webgpu.md J1): they are
// reported, not failed, until their unit converts them. A clean one is noted;
// U16 deletes the list. Never add a file of your own to it. A converting unit
// runs its J4 gate with --unit <its id>, which fails its own pending files
// like any other; --strict fails every pending file (U16, at the end).
// A self-test runs first: known misses must be caught, known good forms not.
// usage: node tools/check-async-reads.mjs [--unit U11 | --strict] [--verbose]
//        (--verbose: every pending site)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['tools', 'scripts'];
export const NAMES = ['readState', 'readCell', 'census', 'gpuSync', 'fence', 'readCopies', 'readMaps', 'readFlow'];
const IGNORE = 'check-async-reads: ignore';

/** @type {Record<string, string>} file → the unit that converts it (J1), or why it waits */
const PENDING = {
  'tools/activity-check.mjs': 'U2', 'tools/sleep-crossover.mjs': 'U2',
  'tools/derived-bench.mjs': 'U4', 'tools/detail-bench.mjs': 'U6', 'tools/profile-check.mjs': 'U7',
  'tools/headless-check.mjs': 'U8', 'tools/idle-check.mjs': 'U8',
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
 * at `close` is consumed: { how: 'await' }, { how: 'return' | 'arrow', at }
 * (handed to the caller; `at` is the return keyword or the arrow's =),
 * { how: 'then', back } (back: how the .then chain is handed to the caller,
 * as above, or null), or null when it isn't.
 */
function consumption(code, start, close) {
  // parentheses around the call, (sim.census()), are closed right after it
  let k = back(code, start - 1), wraps = 0;
  while (code[k] === '(') { wraps++; k = back(code, k - 1); }
  let a = ahead(code, close + 1);
  for (let w = 0; w < wraps && code[a] === ')'; w++) a = ahead(code, a + 1);
  const rest = code.slice(a, a + 32);
  const w = wordBefore(code, k), arrow = code[k] === '>' && code[k - 1] === '=';
  // nothing but the call (or its chain) up to e is handed back
  const whole = (e) => e >= code.length || /^[;)\]},]/.test(code[e]);
  if (CHAINED.test(rest)) {
    // past every .then(...), .catch(...) and .finally(...): a function that
    // returns the chain hands the read back as surely as one returning the call
    let e = a;
    for (let m; (m = CHAINED.exec(code.slice(e, e + 32)));) {
      const c = match(code, e + m[0].length - 1);
      if (c < 0) break;
      e = ahead(code, c + 1);
    }
    const handed = !whole(e) ? null : w === 'return' ? { how: 'return', at: k - 5 } : arrow ? { how: 'arrow', at: k - 1 } : null;
    return { how: 'then', back: handed };
  }
  const used = /^(\?\.|[.[(`])/.test(rest);           // the promise itself indexed, read or called
  if (w === 'await') return used ? null : { how: 'await' };
  if (w === 'return') return whole(a) ? { how: 'return', at: k - 5 } : null;
  if (arrow) return whole(a) ? { how: 'arrow', at: k - 1 } : null;
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

// the plain parameter names in a parameter list's text (destructured ones are left out)
const paramNames = (text) => text.split(',').map((t) => /^\s*(?:\.\.\.)?([\w$]+)/.exec(t)?.[1]).filter(Boolean);

/**
 * Every function body (a brace body, or a named arrow's expression), and the
 * named functions: { name, member, async, params, start, end, arrow } where
 * member means it is called as x.name(...) and arrow is the index of a
 * concise arrow's =>.
 */
function functions(code) {
  const ranges = [], defs = [];
  const at = new Map();   // brace body start → its def
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '{') continue;
    const k = back(code, i - 1);
    let name = null, isFn = false, member = false, async = false, params = [];
    if (code[k] === '>' && code[k - 1] === '=') isFn = true;
    else if (code[k] === ')') {
      const o = match(code, k), q = back(code, o - 1);
      if (isWord(code[q]) && !CONTROL.has(wordBefore(code, q))) {
        isFn = true;
        params = paramNames(code.slice(o + 1, k));
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
    if (name && !KEYWORDS.has(name)) at.set(i, { name, member, async, params, start: i, end, arrow: -1 });
  }
  // name = [async] function (...) {...} | name = [async] (...) => ... | name: [async] x => ...
  for (const m of code.matchAll(/(?<![\w$])([\w$]+)\s*(=(?![=>])|:)\s*/g)) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    let j = m.index + m[0].length, async = false;
    if (wordAt(code, j) === 'async') { async = true; j = ahead(code, j + 5); }
    const member = m[2] === ':' || code[back(code, m.index - 1)] === '.';
    let arrow = -1, params = [];
    if (wordAt(code, j) === 'function') {
      const o = code.indexOf('(', j), c = o < 0 ? -1 : match(code, o), b = c < 0 ? -1 : ahead(code, c + 1);
      if (code[b] === '{') at.set(b, { name, member, async, params: paramNames(code.slice(o + 1, c)), start: b, end: match(code, b), arrow: -1 });
      continue;
    }
    if (code[j] === '(') {
      const c = match(code, j);
      if (c < 0) continue;
      params = paramNames(code.slice(j + 1, c));
      arrow = ahead(code, c + 1);
    } else if (isWord(code[j])) {
      params = [wordAt(code, j)];
      arrow = ahead(code, j + params[0].length);
    }
    if (arrow < 0 || code[arrow] !== '=' || code[arrow + 1] !== '>') continue;
    const body = ahead(code, arrow + 2);
    if (code[body] === '{') { at.set(body, { name, member, async, params, start: body, end: match(code, body), arrow: -1 }); continue; }
    const def = { name, member, async, params, start: body, end: conciseEnd(code, body), arrow };
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
  // the innermost function body around p (a range: { start, end, def? })
  const around = (p) => {
    let best = null;
    for (const r of ranges) if (r.start < p && p < r.end && (!best || r.end - r.start < best.end - best.start)) best = r;
    return best;
  };
  const innermost = (p) => around(p)?.def ?? null;
  // the file's functions that hand a read back or read while async: name → { member, via }
  const derived = new Map();
  let found = [], handBacks = [];
  for (let pass = 0; pass < 8; pass++) {
    found = [];
    handBacks = [];   // how each read handed to a caller was handed: { how: 'return' | 'arrow', at }
    const known = derived.size;
    let unhid = false;
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
      const h = used.how === 'then' ? used.back : used;
      if (h?.how === 'arrow' || h?.how === 'return') handBacks.push(h);
      const handed = h?.how === 'arrow' ? defs.find((d) => d.arrow === h.at)
        : h?.how === 'return' ? innermost(h.at) : null;
      const own = innermost(s);
      for (const d of [handed, own?.async ? own : null]) {
        if (!d) continue;
        // a function named after a read that hands one back is no CPU twin: its bare calls count
        if (NAMES.includes(d.name)) { if (!d.member && local.delete(d.name)) unhid = true; continue; }
        if (!derived.has(d.name)) derived.set(d.name, { member: d.member, via: via?.via ?? name });
      }
    }
    if (derived.size === known && !unhid) break;
  }
  // Playwright's waitForFunction doesn't await its predicate: a promise is truthy, so the
  // wait ends at once and the check it guards always passes. Flag a predicate that returns
  // one (async, or handing a read back, or a function of the file named there that does
  // either) given to waitForFunction, or to a function of the file that hands its own
  // parameter to waitForFunction as the predicate.
  const hands = (d) => d.params.some((q) => new RegExp(`\\bwaitForFunction\\s*\\(\\s*${q.replace(/\$/g, '\\$')}\\b`).test(code.slice(d.start, d.end)));
  const waiters = new Set(['waitForFunction', ...defs.filter(hands).map((d) => d.name)]);
  // why the predicate starting at p returns a promise, or null
  const promising = (p) => {
    const w = wordAt(code, p);
    if (w === 'async') return 'an async predicate';
    // an arrow's => (a concise body hands back what it reads) or a brace body's {
    let arrow = -1, body = -1;
    if (w === 'function') {
      const o = code.indexOf('(', p), c = o < 0 ? -1 : match(code, o);
      body = c < 0 ? -1 : ahead(code, c + 1);
    } else {
      const c = code[p] === '(' ? match(code, p) : w ? p + w.length - 1 : -1;
      const q = c < 0 ? -1 : ahead(code, c + 1);
      if (code[q] === '=' && code[q + 1] === '>') {
        arrow = q;
        body = ahead(code, q + 2);
      } else if (w && /[,)]/.test(code[q] ?? '')) {
        // a function of the file, named
        const d = derived.get(w);
        if ((d && !d.member) || defs.some((f) => f.name === w && f.async && !f.member)) return `${w}, which returns a promise`;
        return null;
      }
    }
    if (body < 0) return null;
    const braced = code[body] === '{';
    const hit = handBacks.some((h) => (h.how === 'arrow' && h.at === arrow && !braced)
      || (h.how === 'return' && braced && around(h.at)?.start === body));
    return hit ? 'a predicate that hands back a read\'s promise' : null;
  };
  const wait = new RegExp(`(?<![\\w$])(${[...waiters].map((n) => n.replace(/\$/g, '\\$')).join('|')})\\s*\\(`, 'g');
  for (const m of code.matchAll(wait)) {
    const open = m.index + m[0].length - 1, close = match(code, open);
    if (close < 0 || wordBefore(code, back(code, m.index - 1)) === 'function' || code[ahead(code, close + 1)] === '{') continue;
    const why = promising(ahead(code, open + 1));
    if (!why) continue;
    const line = code.slice(0, m.index).split('\n').length;
    if (lines[line - 1].includes(IGNORE)) continue;
    found.push({ line, col: m.index - code.lastIndexOf('\n', m.index - 1),
      name: `${m[1]} with ${why}, which it doesn't await (poll through evaluate)`, text: lines[line - 1].trim() });
  }
  return found.sort((a, b) => a.line - b.line || a.col - b.col);
}

/**
 * Splits scanned files into failed, pending (another unit's port, reported
 * only) and clean pending ones. A pending file fails like any other with
 * `strict`, or when `unit` is the unit that ports it (its J4 gate).
 * @param {[string, object[]][]} results [file, its unconsumed calls]
 * @param {{ unit?: string | null, strict?: boolean, pending?: Record<string, string> }} [opts]
 */
export function classify(results, { unit = null, strict = false, pending = PENDING } = {}) {
  const failed = [], waiting = [], clean = [];
  for (const [rel, found] of results) {
    const owner = pending[rel];
    if (owner && !strict && owner !== unit) (found.length ? waiting : clean).push([rel, found]);
    else if (found.length) failed.push([rel, found]);
    else if (owner) clean.push([rel, found]);
  }
  return { failed, pending: waiting, clean };
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
  'await p.waitForFunction(async () => (await sim.census())[1] > 0);',
  'const until = (fn, ms) => p.waitForFunction(fn, null, { timeout: ms });\nawait until(async () => true, 100);',
  'window.__pageGpu.fence();',
  'gpu.fence();',
  "import { fence } from './page-gpu.mjs';\nfence(page);",
  'await ev(() => { sim.step(); window.__pageGpu.fence(); return performance.now(); });',
  'await p.waitForFunction(() => window.__pageGpu.census().then((c) => c[1].n > 0));',
  'await p.waitForFunction(() => window.__app.sim.census());',
  'await p.waitForFunction((id) => sim.census().then((c) => c[id].n > 0), 3);',
  'await p.waitForFunction(function () { return sim.census(); });',
  'const pred = async () => (await sim.census())[1].n > 0;\nawait p.waitForFunction(pred);',
  'async function ready() { return window.x; }\nawait p.waitForFunction(ready, null, { timeout: 5000 });',
  'const until = (fn) => p.waitForFunction(fn);\nawait until(() => sim.census().then((c) => c[1]));',
  'function census() { return window.__app.sim.census(); }\nconst c = census()[1];',
  'const readCell = (x, y, z) => { return sim.readCell(x, y, z); };\nconst id = readCell(1, 2, 3)[0][0];',
  'const n = () => sim.census().then((c) => c[1].n);\ncheck(n() > 0);',
  'function water() { return sim.census().then((c) => c[1].n).catch(() => 0); }\nconst w = water() + 1;',
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
  'await p.waitForFunction(() => window.__app.sim.frame > 10);',
  'const until = (fn, ms) => p.waitForFunction(fn, null, { timeout: ms });\nawait until(() => window.x, 100);',
  'const withLab = async (fn) => { await p.waitForFunction(() => window.ready); return fn(1); };\nawait withLab(async (lab) => lab);',
  'await gpu.fence();',
  'await window.__pageGpu.fence(sim);',
  'const t0 = performance.now(); sim.step(); await gpu.fence(); out.push(performance.now() - t0);',
  'const pred = () => window.ready;\nawait p.waitForFunction(pred);',
  'await p.waitForFunction(() => { const f = () => sim.census(); return window.x > 1; });',
  'await p.waitForFunction((n) => window.__app.sim.frame > n, 10);',
  "await p.waitForFunction('window.__app?.sim');",
  'function census(w) { let n = 0; for (const k in w) n++; return n; }\nconst c = census(w);',
  'const n = () => sim.census().then((c) => c[1].n);\ncheck((await n()) > 0);',
  'sim.census().then((c) => { window.c = c; });',
];
const selfFails = [];
for (const s of BAD) if (scan(s).length !== 1) selfFails.push(`should catch exactly one (got ${scan(s).length}): ${s}`);
for (const s of GOOD) if (scan(s).length) selfFails.push(`should pass: ${s}`);
if (scan('<p>sim.census()</p>\n<script type="module">\nconst c = sim.census();\n</script>', true).length !== 1) {
  selfFails.push('should catch the one call in an HTML page\'s script');
}
{
  const results = [['tools/a.mjs', [{}]], ['tools/b.mjs', [{}]], ['tools/c.mjs', []]];
  const sorted = (opts) => {
    const c = classify(results, { ...opts, pending: { 'tools/a.mjs': 'U11', 'tools/c.mjs': 'U11' } });
    return [c.failed, c.pending, c.clean].map((l) => l.map(([rel]) => rel).join()).join(' | ');
  };
  const want = [[{}, 'tools/b.mjs | tools/a.mjs | tools/c.mjs'], [{ unit: 'U10' }, 'tools/b.mjs | tools/a.mjs | tools/c.mjs'],
    [{ unit: 'U11' }, 'tools/a.mjs,tools/b.mjs |  | tools/c.mjs'], [{ strict: true }, 'tools/a.mjs,tools/b.mjs |  | tools/c.mjs']];
  for (const [opts, w] of want) if (sorted(opts) !== w) selfFails.push(`classify ${JSON.stringify(opts)}: ${sorted(opts)}, want ${w}`);
}
if (selfFails.length) {
  console.error(`check-async-reads self-test failed:\n  ${selfFails.join('\n  ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------- the run

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose'), strict = argv.includes('--strict');
  const u = argv.findIndex((x) => x === '--unit' || x.startsWith('--unit='));
  const unit = u < 0 ? null : argv[u].includes('=') ? argv[u].slice(7) : argv[u + 1];
  if (u >= 0 && !/^U\d+[a-z]?$/.test(unit ?? '')) {
    console.error(`--unit wants a unit id of docs/webgpu.md J1 (U11, U14b), got ${unit ?? 'nothing'}`);
    process.exit(2);
  }
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules') return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(mjs|js|cjs|html)$/.test(n) ? [p] : [];
  });
  const files = DIRS.flatMap((d) => walk(join(ROOT, d))).map((f) => relative(ROOT, f).split('\\').join('/')).sort();
  const results = files.map((rel) => [rel, scan(readFileSync(join(ROOT, rel), 'utf8'), rel.endsWith('.html'))]);
  const { failed, pending, clean } = classify(results, { unit, strict });
  if (strict) console.log('--strict: every pending file fails like any other');
  else if (unit) {
    const own = Object.keys(PENDING).filter((rel) => PENDING[rel] === unit);
    console.log(own.length ? `--unit ${unit}: its ${own.length} pending file${own.length === 1 ? '' : 's'} fail like any other`
      : `--unit ${unit}: no pending file is ${unit}'s; its tools are checked like every other file`);
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
