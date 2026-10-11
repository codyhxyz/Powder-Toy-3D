// Texture units a GLSL ES 3.00 shader binds, counted the way the driver does:
// ANGLE (Chrome and Safari on every platform the game targets) refuses to link
// a program whose fragment stage uses more samplers than
// MAX_TEXTURE_IMAGE_UNITS, and only counts a sampler uniform that is
// statically used by code reachable from main(): its translator prunes the
// functions main() never calls, and an uncalled helper's texture costs nothing.
// So: preprocess the source for one set of defines, find every function main()
// reaches, and count the declared sampler uniforms those functions name.
//
// Static use, not run-time use: a texture read behind a uniform `if` still
// takes its unit. Macros are followed (a macro naming a sampler counts where
// it is used). Sampler arrays count one unit per element.
//
// usage: samplerUnits(source, { DETAIL_LIQ_FOAM: 1, ... })
//   → { count, samplers: [names], declared: [names] }

const SAMPLER_DECL = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?[iu]?sampler\w*\s+(\w+)\s*(?:\[\s*(\w+)\s*\])?\s*;/g;
const IDENT = /[A-Za-z_]\w*/g;
// GLSL keywords that may stand right before `(` and are not calls
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'return', 'else', 'do']);

const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');

// The C preprocessor's conditionals, defines and undefs (GLSL ES 3.00 §3.4).
// Returns the active lines and the macro table.
function preprocess(src, defines) {
  const macros = new Map(Object.entries(defines).map(([k, v]) => [k, String(v)]));
  const out = [];
  const stack = [];   // { on: this branch is live, taken: some branch was, outer: the enclosing block is live }
  const live = () => stack.every((f) => f.on);
  const lines = stripComments(src).replace(/\\\n/g, '').split('\n');
  const evalIf = (expr) => {
    let e = expr.replace(/\bdefined\s*\(\s*(\w+)\s*\)|\bdefined\s+(\w+)/g, (_, a, b) => (macros.has(a ?? b) ? '1' : '0'));
    for (let i = 0; i < 8 && /[A-Za-z_]/.test(e); i++) e = e.replace(IDENT, (id) => (macros.has(id) ? `(${macros.get(id) || '0'})` : '0'));
    e = e.replace(/(\d+)[uU]\b/g, '$1');
    return !!Function(`"use strict"; return (${e});`)();
  };
  for (const line of lines) {
    const m = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
    if (!m) { if (live()) out.push(line); continue; }
    const [, dir, rest] = m;
    if (dir === 'ifdef' || dir === 'ifndef' || dir === 'if') {
      const outer = live();
      const on = outer && (dir === 'if' ? evalIf(rest) : macros.has(rest.trim()) === (dir === 'ifdef'));
      stack.push({ on, taken: on, outer });
    } else if (dir === 'elif') {
      const f = stack.at(-1);
      f.on = f.outer && !f.taken && evalIf(rest);
      f.taken ||= f.on;
    } else if (dir === 'else') {
      const f = stack.at(-1);
      f.on = f.outer && !f.taken;
      f.taken = true;
    } else if (dir === 'endif') {
      stack.pop();
    } else if (!live()) {
      continue;
    } else if (dir === 'define') {
      const d = /^(\w+)(\([^)]*\))?\s*(.*)$/.exec(rest);
      macros.set(d[1], d[3]);
    } else if (dir === 'undef') {
      macros.delete(rest.trim());
    }
  }
  if (stack.length) throw new Error('unbalanced #if');
  return { code: out.join('\n'), macros };
}

// Top-level function definitions by name (overloads kept apart): the text of
// their parameter lists and bodies.
function functions(code) {
  const defs = new Map();
  let depth = 0, start = -1, name = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '{') {
      if (depth === 0) {
        // a function body follows `name(params)`: find the parameters' `(`
        const from = Math.max(0, code.lastIndexOf(';', i), code.lastIndexOf('}', i));
        const head = code.slice(from, i).trimEnd();
        name = null;
        if (head.endsWith(')')) {
          let d = 0, j = head.length - 1;
          for (; j >= 0; j--) { if (head[j] === ')') d++; else if (head[j] === '(' && --d === 0) break; }
          name = /(\w+)\s*$/.exec(head.slice(0, j))?.[1] ?? null;
          start = from + j;
        }
      }
      depth++;
    } else if (c === '}') {
      if (--depth === 0 && name) defs.set(name, [...(defs.get(name) ?? []), code.slice(start, i + 1)]);
    }
  }
  return defs;
}

// Names a function declares for itself (parameters and locals): they hide a
// uniform of the same name (a local `float tF` is not the sampler tF).
const BASIC_TYPES = ['float', 'int', 'uint', 'bool', '[biu]?vec[234]', 'mat[234](?:x[234])?'];
function locals(text, structs) {
  const decl = new RegExp(`\\b(?:${[...BASIC_TYPES, ...structs].join('|')})\\s+([^;{})]*)`, 'g');
  const out = new Set();
  for (const m of text.matchAll(decl)) {
    // one declaration may name several: split at its top-level commas
    const pieces = [''];
    let d = 0;
    for (const ch of m[1]) {
      if (ch === '(' || ch === '[') d++;
      else if (ch === ')' || ch === ']') d--;
      if (ch === ',' && d === 0) pieces.push('');
      else pieces[pieces.length - 1] += ch;
    }
    for (const p of pieces) {
      const id = p.split('=')[0].replace(/\[[^\]]*\]/g, '').match(IDENT)?.at(-1);
      if (id) out.add(id);
    }
  }
  return out;
}

export function samplerUnits(src, defines = {}) {
  const { code, macros } = preprocess(src, defines);
  const sizes = new Map();
  for (const m of code.matchAll(SAMPLER_DECL)) {
    const n = m[2] === undefined ? 1 : Number(/^\d+$/.test(m[2]) ? m[2] : macros.get(m[2]));
    sizes.set(m[1], n);
  }
  const defs = functions(code);
  if (!defs.has('main')) throw new Error('no main()');
  const structs = [...code.matchAll(/\bstruct\s+(\w+)/g)].map((m) => m[1]);
  // identifiers a definition names, through the macros it uses
  const names = (text, seen = new Set()) => {
    for (const id of text.match(IDENT) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (macros.has(id)) names(macros.get(id), seen);
    }
    return seen;
  };
  // ...less the ones it declares itself
  const free = (text) => {
    const own = locals(text, structs);
    return [...names(text)].filter((id) => !own.has(id));
  };
  const reached = new Set(['main']), used = new Set(), todo = ['main'];
  while (todo.length) {
    for (const text of defs.get(todo.pop())) {
      for (const id of free(text)) {
        if (sizes.has(id)) used.add(id);
        if (defs.has(id) && !reached.has(id) && !NOT_CALLS.has(id)) { reached.add(id); todo.push(id); }
      }
    }
  }
  const samplers = [...used];
  return { count: samplers.reduce((s, n) => s + sizes.get(n), 0), samplers, declared: [...sizes.keys()] };
}
