// The block pass's motion section (src/shaders/v2.js v2BlockWGSL, R2 topple through R4b) and its exchange
// helpers (blockExchangeWGSL), as JS EXECUTED from the emitted WGSL: the finite spelling of column-wgsl.mjs plus
// WGSL's builtins, for the CPU witnesses (tools/v2/exchange-check.mjs, block-compact-check.mjs). Not a second model.
import { v2Rows } from '../../src/shaders/v2.js';
import { wgslFunction, syntax, constants } from './column-wgsl.mjs';

const f = Math.fround;
export const motionJS = body => syntax(body).replace(/\bselect\(/g, 'sel(').replace(/\b(abs|max|min|sqrt|floor)\(/g, 'Math.$1(')
  .replace(/\bu32\(/g, 'U32(').replace(/\bf32\(/g, 'F32(').replace(/\bi32\(/g, 'I32(');
/** The emitted exchange helpers bound to params P (read live: set P's fields between calls), with the module's constants. */
export function exchangeHelpers(code, P) {
  const rows = v2Rows();
  const ctx = {
    ...constants(code), P, C_AIR: 0, C_SOLID: 1, C_POWDER: 2, C_LIQUID: 3, C_GAS: 4, T_OFFSET: 273.25,
    sel: (a, b, c) => (c ? b : a), clamp: (x, a, b) => Math.min(Math.max(x, a), b), U32: x => Math.floor(x) >>> 0, F32: f, I32: x => Math.trunc(x),
    driftOf: id => f(rows[id].drift), jitterOf: id => f(rows[id].jitter), cTq: c => (c[0] >>> 8) & 0xffff,
  };
  for (const name of ['v1Drift', 'v1DragF', 'v1Exchange', 'v2Chance']) {
    const { args, body } = wgslFunction(code, name);
    ctx[name] = new Function('ctx', ...args, `with (ctx) { ${motionJS(body)} }`).bind(null, ctx);
  }
  return ctx;
}
/** The motion section's JS body (cs, bs, positions, pending, fromCell, P, down, supportAt and helpers in scope). */
export function motionSource(code) {
  return motionJS(code.slice(code.indexOf('  // R2 topple'), code.indexOf('  // Obligations follow')))
    .replace(/array<u32, 3>\(([^)]+)\)/g, '[$1]').replace(/array<f32, 3>\(([^)]+)\)/g, '[$1]')
    .replaceAll('pt + down*i32(dd)', 'add(pt,down.map(v=>v*dd))').replaceAll('rnd(&rs)', '(rs=pcg(rs), unit(rs))');
}
