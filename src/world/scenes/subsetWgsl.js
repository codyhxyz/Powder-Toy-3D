// The shared GLSL subset (themedShared.js) → WGSL (docs/webgpu.md G1, H1.27):
// the scenes' geometry stays written once in the subset, which toJs turns
// into the CPU twin; this turns the same text into the WGSL the GPU runs, so
// the two can't drift. It parses the subset (functions of int, uint, float
// and bool; declarations, if/else, for, return, break, continue, assignment
// and ++/--; the operators toJs allows, and ?:) into a tree, infers each
// expression's type and writes WGSL:
//   - int, uint, float, bool → i32, u32, f32, bool; every local is a typed
//     `var`; a parameter the body assigns becomes a `var` copy of it;
//   - float(<uint>) → u32ToF32 (H1.28: WGSL may round an unrepresentable
//     conversion either way; the subset's ints are coordinates, exact in f32);
//   - ?: whose branches are cheap (no call but to the pure helpers) →
//     select(); else hoisted into a typed `var` set by if/else before the
//     statement, with the operands evaluated before it hoisted too where
//     they have side effects (thNoised writes its derivatives), and && / ||
//     around a hoisted part turned into ifs, so what runs and in what order
//     is the GLSL's (H1.9: select evaluates both sides);
//   - names: a scene's uniforms → fields of its uniform struct (SU.name; a
//     bool one as `SU.name != 0u`), WGSL's reserved words → name_;
//   - braces everywhere, `else if` chains as nested blocks where a condition
//     needs hoisting.
// Anything outside the subset throws, with where.

const TYPES = { int: 'i32', uint: 'u32', float: 'f32', bool: 'bool', void: null };
// WGSL's reserved words and keywords a subset name might hit (H1.24)
const RESERVED = new Set(('of mod move set get new pass common from smooth shared super use with where as do ref target '
  + 'filter meta module layout active self type match final alias default override enable requires const_assert fn let var '
  + 'loop struct switch case const continuing discard while private storage uniform workgroup function read write '
  + 'read_write array atomic ptr sampler texture_1d vec2 vec3 vec4 mat2x2 handle demote static typedef unless').split(' '));

// The th* helpers' types (themedShared.js helpersGLSL) and whether they are pure.
export const HELPER_SIGS = {
  pcg: ['u32', true], thHash2: ['u32', true], thKey: ['u32', true], thRange: ['i32', true], thShare: ['i32', true],
  thUnit: ['f32', true], thLattice: ['f32', true], thDiv: ['i32', true], thMod: ['i32', true], thFdiv: ['f32', true],
  thFloor: ['i32', true], thRound: ['i32', true], thStream: ['u32', true],
  thNoised: ['f32', false], thNoiseDx: ['f32', true], thNoiseDz: ['f32', true],
};
// builtins the subset may call (themedShared.js helpersJs): result type, 'arg' for the first argument's
const BUILTINS = {
  abs: 'arg', min: 'arg', max: 'arg', clamp: 'arg', mix: 'arg',
  floor: 'f32', sqrt: 'f32', pow: 'f32', cos: 'f32', sin: 'f32', smoothstep: 'f32', exp: 'f32', fract: 'f32',
  float: 'f32', int: 'i32', uint: 'u32', bool: 'bool',
};
// builtins emitted as the helpers' own (themedShared.js helpersGLSL): cos and sin to about an ulp
const EMIT_AS = { cos: 'thCos', sin: 'thSin' };

// ---------------------------------------------------------------- tokens
function tokenize(src) {
  const toks = [];
  const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+|0[xX][0-9a-fA-F]+|\d+)|([A-Za-z_]\w*)|(\+\+|--|\+=|-=|\*=|==|!=|<=|>=|&&|\|\||[-+*<>=!?:;,(){}])/y;
  let m, line = 1;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    m = re.exec(src);
    if (!m) throw new Error(`subset → WGSL: can't read "${src.slice(at, at + 30)}" (line ${line})`);
    if (m[1]) toks.push({ k: 'num', v: m[1], line });
    else if (m[2]) toks.push({ k: 'id', v: m[2], line });
    else if (m[3]) toks.push({ k: 'op', v: m[3], line });
    line += (m[0].match(/\n/g) ?? []).length;
  }
  toks.push({ k: 'eof', v: '<end>', line });
  return toks;
}

// ---------------------------------------------------------------- parse
function parse(src) {
  const t = tokenize(src);
  let i = 0;
  const peek = (o = 0) => t[i + o];
  const err = (msg) => { throw new Error(`subset → WGSL: ${msg} at line ${peek().line} near "${t.slice(i, i + 8).map((x) => x.v).join(' ')}"`); };
  const is = (v) => peek().v === v && peek().k !== 'num';
  const eat = (v) => { if (!is(v)) err(`expected "${v}"`); return t[i++]; };
  const isType = (o = 0) => peek(o).k === 'id' && peek(o).v in TYPES;
  const ident = () => { if (peek().k !== 'id') err('expected a name'); return t[i++].v; };

  const PREC = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6 };
  function primary() {
    const tk = peek();
    if (tk.k === 'num') { i++; return { k: 'num', v: tk.v }; }
    if (tk.k === 'id') {
      i++;
      if (tk.v === 'true' || tk.v === 'false') return { k: 'bool', v: tk.v };
      if (is('(')) {
        i++;
        const args = [];
        if (!is(')')) { do args.push(expr()); while (is(',') && ++i); }
        eat(')');
        return { k: 'call', name: tk.v, args };
      }
      return { k: 'name', v: tk.v };
    }
    if (is('(')) { i++; const e = expr(); eat(')'); return { k: 'paren', e }; }
    return err('expected an expression');
  }
  function unary() {
    if (is('-') || is('!') || is('+')) { const op = t[i++].v; return { k: 'unary', op, e: unary() }; }
    const e = primary();
    if (is('++') || is('--')) err('++/-- inside an expression');
    return e;
  }
  function binary(min) {
    let l = unary();
    for (;;) {
      const op = peek().v, p = PREC[op];
      if (peek().k !== 'op' || !p || p < min) return l;
      i++;
      l = { k: 'bin', op, l, r: binary(p + 1) };
    }
  }
  function ternary() {
    const c = binary(1);
    if (!is('?')) return c;
    i++;
    const a = expr();
    eat(':');
    return { k: 'cond', c, a, b: ternary() };
  }
  const expr = () => ternary();

  // a declaration after its type: name (= e)? (, name (= e)?)*
  function declRest(type) {
    const vars = [];
    do {
      const name = ident();
      vars.push({ name, init: is('=') ? (i++, expr()) : null });
    } while (is(',') && ++i);
    return { k: 'decl', type: TYPES[type], vars };
  }
  // an expression statement: assignment, compound assignment, ++/--, or a call
  function simple() {
    if (peek().k === 'id' && (peek(1).v === '++' || peek(1).v === '--')) { const name = ident(); return { k: 'incr', name, op: t[i++].v }; }
    if (peek().k === 'id' && ['=', '+=', '-=', '*='].includes(peek(1).v)) {
      const name = ident(), op = t[i++].v;
      return { k: 'assign', name, op, e: expr() };
    }
    const e = expr();
    if (e.k !== 'call') err('an expression statement that is not a call');
    return { k: 'expr', e };
  }
  function stmt() {
    if (is('{')) return block();
    if (isType()) { const s = declRest(t[i++].v); eat(';'); return s; }
    if (is('if')) {
      i++; eat('(');
      const c = expr();
      eat(')');
      const a = stmt();
      let b = null;
      if (is('else')) { i++; b = stmt(); }
      return { k: 'if', c, a, b };
    }
    if (is('for')) {
      i++; eat('(');
      let init = null;
      if (!is(';')) init = isType() ? declRest(t[i++].v) : simple();
      eat(';');
      const c = is(';') ? null : expr();
      eat(';');
      const step = is(')') ? null : simple();
      eat(')');
      return { k: 'for', init, c, step, body: stmt() };
    }
    if (is('return')) { i++; const e = is(';') ? null : expr(); eat(';'); return { k: 'return', e }; }
    if (is('break') || is('continue')) { const k = t[i++].v; eat(';'); return { k }; }
    if (is(';')) { i++; return { k: 'block', body: [] }; }
    const s = simple();
    eat(';');
    return s;
  }
  function block() {
    eat('{');
    const body = [];
    while (!is('}')) body.push(stmt());
    eat('}');
    return { k: 'block', body };
  }
  const fns = [];
  while (peek().k !== 'eof') {
    if (!isType()) err('expected a function');
    const ret = TYPES[t[i++].v], name = ident();
    eat('(');
    const params = [];
    if (is('void')) i++;
    else if (!is(')')) {
      do {
        if (!isType()) err('expected a parameter type');
        const type = TYPES[t[i++].v];
        params.push({ type, name: ident() });
      } while (is(',') && ++i);
    }
    eat(')');
    if (is(';')) err('a prototype (WGSL needs none: leave it out of the subset)');
    fns.push({ ret, name, params, body: block() });
  }
  return fns;
}

// ---------------------------------------------------------------- emit
/**
 * WGSL for subset source `src`.
 * @param {string} src the subset text (functions only: constants come from definesGLSL)
 * @param {{ consts?: Record<string, string>, uniforms?: Record<string, string>, externs?: Record<string, string | [string, boolean]>,
 *   uniformStruct?: string }} [env]
 *   consts: the names definesGLSL made, with their WGSL types; uniforms: the
 *   scene's uniforms (read as `${uniformStruct}.name`, a bool one compared
 *   with 0u); externs: functions the scene's hand-written WGSL defines, by
 *   result type ([type, cheap] when a call to it may be evaluated eagerly in select())
 * @returns {string}
 */
export function toWgsl(src, { consts = {}, uniforms = {}, externs = {}, uniformStruct = 'SU' } = {}) {
  const fns = parse(src);
  const sigs = new Map();
  for (const [n, [type, pure]] of Object.entries(HELPER_SIGS)) sigs.set(n, { ret: type, cheap: pure, pure, extern: true });
  for (const [n, v] of Object.entries(externs)) {
    const [type, cheap] = Array.isArray(v) ? v : [v, false];
    sigs.set(n, { ret: type, cheap, pure: true, extern: true });
  }
  for (const f of fns) {
    if (sigs.has(f.name) && !sigs.get(f.name).extern) throw new Error(`subset → WGSL: ${f.name} is defined twice`);
    sigs.set(f.name, { ret: f.ret, cheap: false, pure: true, fn: f, params: f.params });
  }
  // purity: a function that calls thNoised (or one that does) writes its derivatives
  let changed = true;
  const calls = (node, out = new Set()) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => calls(n, out)); return out; }
    if (node.k === 'call') out.add(node.name);
    for (const v of Object.values(node)) if (v && typeof v === 'object') calls(v, out);
    return out;
  };
  const fnCalls = new Map(fns.map((f) => [f.name, calls(f.body)]));
  while (changed) {
    changed = false;
    for (const f of fns) {
      const s = sigs.get(f.name);
      if (s.pure && [...fnCalls.get(f.name)].some((n) => sigs.get(n) && !sigs.get(n).pure)) { s.pure = false; changed = true; }
    }
  }

  const rename = (n) => (RESERVED.has(n) ? `${n}_` : n);
  let tmp = 0;
  const out = [];
  for (const f of fns) {
    // scopes: name → { type, wgsl }
    const scopes = [new Map()];
    const assigned = new Set();
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if ((n.k === 'assign' || n.k === 'incr') && n.name) assigned.add(n.name);
      for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
    })(f.body);
    const head = [];
    for (const p of f.params) {
      const w = rename(p.name);
      if (assigned.has(p.name)) {
        scopes[0].set(p.name, { type: p.type, wgsl: w });
        head.push(`  var ${w}: ${p.type} = ${w}_in;`);
      } else scopes[0].set(p.name, { type: p.type, wgsl: w });
    }
    const lookup = (n) => {
      for (let k = scopes.length - 1; k >= 0; k--) if (scopes[k].has(n)) return scopes[k].get(n);
      if (n in uniforms) return { type: uniforms[n], wgsl: uniforms[n] === 'bool' ? `(${uniformStruct}.${n} != 0u)` : `${uniformStruct}.${n}` };
      if (n in consts) return { type: consts[n], wgsl: n };
      if (/^E_[A-Z0-9_]+$/.test(n)) return { type: 'i32', wgsl: n };
      throw new Error(`subset → WGSL: ${f.name} reads ${n}, which nothing declares`);
    };
    const where = (msg) => new Error(`subset → WGSL: ${f.name}: ${msg}`);

    // An expression's type (no emission).
    function typeOf(e) {
      switch (e.k) {
        case 'num': return /[.eE]/.test(e.v) && !/^0[xX]/.test(e.v) ? 'f32' : 'i32';
        case 'bool': return 'bool';
        case 'name': return lookup(e.v).type;
        case 'paren': return typeOf(e.e);
        case 'unary': return e.op === '!' ? 'bool' : typeOf(e.e);
        case 'bin': return PRECS[e.op] <= 4 ? 'bool' : typeOf(e.l) === 'abstract' ? typeOf(e.r) : typeOf(e.l);
        case 'cond': { const a = typeOf(e.a); return a; }
        case 'call': {
          if (e.name in BUILTINS) return BUILTINS[e.name] === 'arg' ? typeOf(e.args[0]) : BUILTINS[e.name];
          const s = sigs.get(e.name);
          if (!s) throw where(`calls ${e.name}, which nothing defines`);
          return s.ret;
        }
        default: throw where(`unknown expression ${e.k}`);
      }
    }
    // Whether evaluating e may write (thNoised), and whether it's cheap (select() may evaluate it eagerly).
    const impure = (e) => [...calls(e)].some((n) => sigs.get(n) && !sigs.get(n).pure);
    const cheap = (e) => [...calls(e)].every((n) => n in BUILTINS || sigs.get(n)?.cheap);
    // A hoisted temporary of type `type`.
    const temp = (type, pre, init = null) => {
      const n = `_t${tmp++}`;
      pre.push(init == null ? `var ${n}: ${type};` : `var ${n}: ${type} = ${init};`);
      return n;
    };

    // Emits e: its WGSL text, with the statements that must run first appended to pre.
    function ex(e, pre, want = null) {
      switch (e.k) {
        case 'num': return /^0[xX]/.test(e.v) ? String(parseInt(e.v, 16)) : e.v;
        case 'bool': return e.v;
        case 'name': return lookup(e.v).wgsl;
        case 'paren': return `(${ex(e.e, pre, want)})`;
        case 'unary': {
          const inner = ex(e.e, pre, want);
          return e.op === '+' ? inner : `${e.op}${/^[\w.]+$/.test(inner) && !/^-/.test(inner) ? inner : `(${inner})`}`;
        }
        case 'bin': return exBin(e, pre);
        case 'cond': return exCond(e, pre, want);
        case 'call': return exCall(e, pre);
        default: throw where(`unknown expression ${e.k}`);
      }
    }
    // operands in order; an earlier operand with side effects is hoisted before a later one's statements
    function exList(list, pre) {
      const texts = [], pres = list.map(() => []);
      list.forEach((a, k) => { texts[k] = ex(a, pres[k]); });
      for (let k = 0; k < list.length; k++) {
        const later = pres.slice(k + 1).some((p) => p.length);
        if (later && impure(list[k])) {
          pre.push(...pres[k]);
          texts[k] = temp(wgslTypeOf(list[k]), pre, texts[k]);
        } else pre.push(...pres[k]);
      }
      return texts;
    }
    const wgslTypeOf = (e) => typeOf(e);
    function exBin(e, pre) {
      const p = PRECS[e.op];
      const wrap = (child, text, right) => {
        if (child.k !== 'bin') return text;
        const cp = PRECS[child.op];
        const logicMix = (cp <= 2 && p <= 2 && child.op !== e.op);
        return cp < p || (right && cp === p) || logicMix || (cp === 3 || cp === 4) && (p === 3 || p === 4) ? `(${text})` : text;
      };
      if (e.op === '&&' || e.op === '||') {
        const lp = [], rp = [];
        const l = ex(e.l, lp), r = ex(e.r, rp);
        pre.push(...lp);
        if (!rp.length) return `${wrap(e.l, l, false)} ${e.op} ${wrap(e.r, r, true)}`;
        // the right side needs statements first: run them only when it is evaluated
        const n = temp('bool', pre, l);
        pre.push(`if (${e.op === '&&' ? n : `!${n}`}) {`, ...rp.map((s) => `  ${s}`), `  ${n} = ${r};`, '}');
        return n;
      }
      const [l, r] = exList([e.l, e.r], pre);
      return `${wrap(e.l, l, false)} ${e.op} ${wrap(e.r, r, true)}`;
    }
    function exCond(e, pre, want) {
      const type = want ?? typeOf(e.a);
      const cp = [], ap = [], bp = [];
      const c = ex(e.c, cp), a = ex(e.a, ap, type), b = ex(e.b, bp, type);
      pre.push(...cp);
      if (cheap(e.a) && cheap(e.b) && !impure(e.a) && !impure(e.b) && !ap.length && !bp.length) {
        return `select(${b}, ${a}, ${c})`;
      }
      const n = temp(type, pre);
      pre.push(`if (${c}) {`, ...ap.map((s) => `  ${s}`), `  ${n} = ${a};`, '} else {', ...bp.map((s) => `  ${s}`), `  ${n} = ${b};`, '}');
      return n;
    }
    function exCall(e, pre) {
      const args = exList(e.args, pre);
      if (e.name === 'float') {
        if (args.length !== 1) throw where('float() takes one argument');
        const t = typeOf(e.args[0]);
        return t === 'u32' ? `u32ToF32(${args[0]})` : `f32(${args[0]})`;
      }
      if (e.name === 'int') return `i32(${args[0]})`;
      if (e.name === 'uint') return `u32(${args[0]})`;
      if (e.name === 'bool') return `bool(${args[0]})`;
      if (!(e.name in BUILTINS) && !sigs.has(e.name)) throw where(`calls ${e.name}, which nothing defines`);
      return `${e.name in BUILTINS ? EMIT_AS[e.name] ?? e.name : rename(e.name)}(${args.join(', ')})`;
    }

    // statements → lines
    const ind = (lines) => lines.map((l) => `  ${l}`);
    function block(s) {
      scopes.push(new Map());
      const body = s.k === 'block' ? s.body.flatMap(st) : st(s);
      scopes.pop();
      return body;
    }
    function declare(name, type) {
      const top = scopes[scopes.length - 1];
      const w = rename(name);
      top.set(name, { type, wgsl: w });
      return w;
    }
    function decl(s) {
      const lines = [];
      for (const v of s.vars) {
        const pre = [];
        const init = v.init ? ex(v.init, pre, s.type) : null;
        lines.push(...pre);
        const w = declare(v.name, s.type);
        lines.push(init == null ? `var ${w}: ${s.type};` : `var ${w}: ${s.type} = ${init};`);
      }
      return lines;
    }
    function simpleStmt(s, pre) {
      if (s.k === 'incr') return `${lookup(s.name).wgsl}${s.op}`;
      if (s.k === 'assign') { const v = lookup(s.name); return `${v.wgsl} ${s.op} ${ex(s.e, pre, v.type)}`; }
      if (s.k === 'expr') return `_ = ${ex(s.e, pre)}`;
      throw where(`unknown statement ${s.k}`);
    }
    function st(s) {
      switch (s.k) {
        case 'block': return ['{', ...ind(block(s)), '}'];
        case 'decl': return decl(s);
        case 'incr': case 'assign': case 'expr': {
          const pre = [];
          const line = simpleStmt(s, pre);
          return [...pre, `${line};`];
        }
        case 'return': {
          if (!s.e) return ['return;'];
          const pre = [];
          const e = ex(s.e, pre, f.ret);
          return [...pre, `return ${e};`];
        }
        case 'break': return ['break;'];
        case 'continue': return ['continue;'];
        case 'if': {
          const pre = [];
          const c = ex(s.c, pre, 'bool');
          const lines = [...pre, `if (${c}) {`, ...ind(block(s.a))];
          if (s.b) {
            const b = block(s.b);
            if (s.b.k === 'if' && b[0].startsWith('if (')) lines.push(`} else ${b[0]}`, ...b.slice(1));
            else lines.push('} else {', ...ind(b), '}');
          } else lines.push('}');
          return lines;
        }
        case 'for': {
          scopes.push(new Map());
          const pre = [];
          let init = '';
          if (s.init?.k === 'decl') {
            if (s.init.vars.length !== 1) throw where('a for loop declaring more than one variable');
            const v = s.init.vars[0];
            const e = v.init ? ex(v.init, pre, s.init.type) : null;
            const w = declare(v.name, s.init.type);
            init = e == null ? `var ${w}: ${s.init.type}` : `var ${w}: ${s.init.type} = ${e}`;
          } else if (s.init) init = simpleStmt(s.init, pre);
          const cpre = [], spre = [];
          const c = s.c ? ex(s.c, cpre, 'bool') : '';
          const step = s.step ? simpleStmt(s.step, spre) : '';
          if (cpre.length || spre.length) throw where('a for loop whose condition or step needs statements of its own (a ?: with calls)');
          const body = block(s.body);
          scopes.pop();
          return [...pre, `for (${init}; ${c}; ${step}) {`, ...ind(body), '}'];
        }
        default: throw where(`unknown statement ${s.k}`);
      }
    }

    const body = block(f.body);
    const params = f.params.map((p) => `${rename(p.name)}${assigned.has(p.name) ? '_in' : ''}: ${p.type}`).join(', ');
    out.push(`fn ${rename(f.name)}(${params})${f.ret ? ` -> ${f.ret}` : ''} {`, ...head, ...ind(body), '}');
  }
  return out.join('\n');
}
const PRECS = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6 };

// The subset's syntax tree (tools: the cost of inlining each function, scenes/subsetWgsl.js's parse).
export const parseSubset = (src) => parse(src);
