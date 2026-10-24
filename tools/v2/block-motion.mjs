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
    ...constArrays(code), fallVelocity: c => fallSpeed(c),
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
    .replaceAll('pt + down*I32(dd)', 'add(pt,down.map(v=>v*dd))').replaceAll('rnd(&rs)', '(rs=pcg(rs), unit(rs))');
}

// ---- the column pass's fast movers (v2.js colMoverWGSL, R1b), executed from the emitted WGSL. `env` supplies the
// grid: loadCell, loadMaterial, storeMaterial, slotOf, events, noteEvents, decoOf, setDeco, markBusy, zeroQ, cFill,
// vec3i (objects {x, y, z}), NY and P (live).
import { ELEMENTS } from '../../src/elements.js';
const COLUMN_MOVER_FNS = ['v1Drift', 'v1DragF', 'colTemp', 'colAirDensity', 'colDensity', 'colGasLike', 'colSinkP', 'colRiseP', 'colExcess', 'colCells', 'colShift'];
export function columnMoverHelpers(code, env) {
  const rows = v2Rows(), T = 273.25;
  const pcg = v => { const s = (Math.imul(v, 747796405) + 2891336453) >>> 0; const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0; return ((w >>> 22) ^ w) >>> 0; };
  const ctx = {
    ...constants(code), C_AIR: 0, C_SOLID: 1, C_POWDER: 2, C_LIQUID: 3, C_GAS: 4, T_OFFSET: T, FULLU: 65536,
    V1_SPAWN_C: ELEMENTS.map(e => f(Math.round((e.temp + T) * 4) * 0.25 - T)),
    sel: (a, b, c) => (c ? b : a), clamp: (x, a, b) => Math.min(Math.max(x, a), b), U32: x => Math.floor(x) >>> 0, F32: f, I32: x => Math.trunc(x),
    fract: x => x - Math.floor(x), pcg, unit: s => f(f(f(s >>> 8) * 256) + f(s & 255)) / 4294967296,
    seed3: (p, tick, salt) => pcg((p.x + pcg((p.y + pcg((p.z + pcg((Math.imul(tick, 1664525) + salt) >>> 0)) >>> 0)) >>> 0)) >>> 0),
    driftOf: id => f(rows[id].drift), densOfE: id => f(rows[id].dens), clsOf: c => rows[c[0] & 255].cls, cid: c => c[0] & 255,
    cTq: c => (c[0] >>> 8) & 0xffff, Material: (core, bank) => ({ core, bank }),
  };
  Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(env));
  for (const name of COLUMN_MOVER_FNS) {
    const { args, body } = wgslFunction(code, name);
    ctx[name] = new Function('ctx', ...args, `with (ctx) { ${motionJS(body).replaceAll('rnd(&rs)', '(rs=pcg(rs), unit(rs))')} }`).bind(null, ctx);
  }
  return ctx;
}

// ---- the column pass's grain landing (v2.js grainLandWGSL: BL-7 odds, BL-8 breaking, TH-10 heat), executed from
// the emitted WGSL. `env` as columnMoverHelpers', plus inGrid; energies are BigInt (src/v2/layout.js twins).
import * as Layout from '../../src/v2/layout.js';
import { setFall as fallSet, fallVelocity as fallSpeed } from '../../src/v2/fall.js';
export function constArrays(code) {
  const out = {};
  for (const m of code.matchAll(/const (\w+) = array<\w+, \d+>\(([^)]*)\);/g)) out[m[1]] = m[2].split(',').map(v => Number(v.replace(/u$/, '')));
  return out;
}
export function grainLandingHelpers(code, env) {
  const ctx = columnMoverHelpers(code, env);
  Object.assign(ctx, constArrays(code), {
    energyOf: m => Layout.energyOf(m), energyAdd: (a, b) => a + b, energySub: (a, b) => a - b, energyMul: (a, b) => BigInt(a) * BigInt(b),
    energyFits: (m, e) => Layout.energyFits(m, e), withEnergy: (m, e) => Layout.withEnergy(m, e),
    setFall: (c, v, a) => fallSet(Uint32Array.from(c), v, a), vec4u: (...v) => Uint32Array.from(v), cls: id => v2Rows()[id].cls,
    round: Math.round, densOfE: id => f(v2Rows()[id].dens),
  });
  for (const name of ['grainFallen', 'grainOdds', 'grainHeat', 'grainLands']) {
    const { args, body } = wgslFunction(code, name);
    ctx[name] = new Function('ctx', ...args, `with (ctx) { ${motionJS(body).replace(/\bround\(/g, 'Math.round(').replaceAll('rnd(&rs)', '(rs=pcg(rs), unit(rs))')} }`).bind(null, ctx);
  }
  return ctx;
}
