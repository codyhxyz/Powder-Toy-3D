import { E } from '../../elements.js';

// Shared machinery of the world scenes written once for GPU and CPU: the
// themed ones (labWorld.js, volcanoWorld.js) and the island's generator
// (world/generator.js and its hooks, world/island).
//
// One source of truth. A scene's geometry is written once, in a small subset
// of GLSL that also reads as JavaScript once its type names are dropped. The
// GPU compiles it as it is (after the prelude, its #defines and the helpers
// below); the CPU gets a JS twin from the same text (toJs), so ground(),
// start() and the CPU previews (tools/scene-themed-preview.mjs) see exactly
// the cells the GPU makes, up to float rounding where a scene uses floats.
//
// The subset (toJs refuses anything outside it):
//   - scalars only: int, uint, float, bool; no vectors, structs, arrays,
//     out/inout parameters or const;
//   - functions are `type name(type a, ...) {` on one line, declared before use;
//   - no `/` or `%`: integer division differs (GLSL truncates, JS doesn't), so
//     write thDiv / thMod for ints and thFdiv for floats;
//   - no `u` literals and no bit operations: hash values (uint) are made and
//     read only through the th* helpers;
//   - constants are #defines from constant tables (defines / jsConstants), so
//     they too have one source;
//   - names a source doesn't define come from its scope: on the GPU what is
//     declared before it (uniforms, texel fetches), in the JS twin compileShared's
//     consts (the island's world parameters and baked columns, world/generator.js).
// Hash and noise helpers. The GPU halves are in helpersGLSL, the CPU halves in
// helpersJs, line for line the same arithmetic (uint32 wrap-around: >>> 0 in
// JS; the CPU's floats are doubles, so float results agree to rounding).
//
// Extensions for the island's generator (its noise is fBm of gradient noise
// with derivatives, which the subset's scalars can't return):
//   - thStream(salt, k): a noise field's hash stream, k further on (its octave);
//   - thNoised(x, z, s): 2D gradient noise, its value, leaving its derivatives
//     for thNoiseDx() and thNoiseDz() to read until the next thNoised;
//   - smoothstep, a GLSL built-in, in the twin's scope.

// A 16-bit hash field, as a share out of this many (shares are compared as
// integers, so a pick never depends on float rounding).
export const SHARE_ONE = 0x10000;
const LATTICE_ONE = 0x1000000;   // 24-bit hash field to [0, 1): exact in a float32 and a double
const UINT_RANGE = 4294967296;   // 2^32: a 32-bit hash to [0, 1) (the prelude's UINT_TO_UNIT)
const GRAD_CACHE = 1 << 16;          // lattice gradients the JS twin keeps (a power of two: the slot is a mask)
const GRAD_MIX_X = 0x27d4eb2d;        // ...hashed to a slot by these odd multipliers (no structure in the slots)
const GRAD_MIX_Z = 0x165667b1;
const TAU = Math.PI * 2;
// 2D gradient noise peaks near ±1/√2: this scales it to about ±1
const NOISE_NORM = 1.4142;

// PCG hash, as common.js's pcg (uint32 arithmetic)
export function pcg(v) {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

export const helpersGLSL = /* glsl */ `
#define TH_SHARE_ONE ${SHARE_ONE}
#define TH_LATTICE_ONE ${LATTICE_ONE}.0
#define TH_TAU ${TAU}
#define TH_NOISE_NORM ${NOISE_NORM}
uniform uint uSceneSeed;
// a hash of integer coordinates (a, b) in the world seed's stream salt
uint thHash2(int a, int b, uint salt) { return pcg(uint(a) + pcg(uint(b) + pcg(uSceneSeed + salt))); }
// parameter k's own hash, from the hash of what it belongs to
uint thKey(uint h, int k) { return pcg(h + uint(k)); }
// an integer in [lo, hi] (lo when hi < lo)
int thRange(uint h, int lo, int hi) { return lo + int(h % uint(max(hi - lo + 1, 1))); }
// a share in [0, TH_SHARE_ONE)
int thShare(uint h) { return int(h & 0xffffu); }
// a float in [0, 1), 16 bits
float thUnit(uint h) { return float(h & 0xffffu) / float(TH_SHARE_ONE); }
// a float in [0, 1), 24 bits, at lattice point (ix, iz) of stream salt
float thLattice(int ix, int iz, uint salt) { return float(thHash2(ix, iz, salt) >> 8u) / TH_LATTICE_ONE; }
// floor division and modulo of ints (b > 0), the same for negative a in GLSL and JS
int thDiv(int a, int b) { return a >= 0 ? a / b : -((b - 1 - a) / b); }
int thMod(int a, int b) { return a - b * thDiv(a, b); }
float thFdiv(float a, float b) { return a / b; }
int thFloor(float x) { return int(floor(x)); }
int thRound(float x) { return int(floor(x + 0.5)); }
// a noise field's hash stream: the world seed's stream salt, k further on (octave k gets its own)
uint thStream(uint salt, int k) { return pcg(uSceneSeed + salt) + uint(k); }
// Gradient noise at (x, z) in stream s, about ±1, with its derivatives, which
// thNoiseDx() and thNoiseDz() read until the next call. Gradients are unit
// vectors at a hashed angle per lattice point; the fade is Perlin's quintic
// 6t⁵ - 15t⁴ + 10t³ (its published coefficients, and its derivative's: 30t²(t - 1)²).
float thNoiseDxLast, thNoiseDzLast;
vec2 thGrad(ivec2 c, uint s) {
  float a = float(pcg(uint(c.x) + pcg(uint(c.y) + s))) * UINT_TO_UNIT * TH_TAU;
  return vec2(cos(a), sin(a));
}
float thNoised(float x, float z, uint s) {
  vec2 p = vec2(x, z);
  vec2 i = floor(p), f = p - i;
  ivec2 c = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = thGrad(c, s), gb = thGrad(c + ivec2(1, 0), s);
  vec2 gc = thGrad(c + ivec2(0, 1), s), gd = thGrad(c + ivec2(1, 1), s);
  float va = dot(ga, f), vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0)), vd = dot(gd, f - vec2(1.0));
  float k = va - vb - vc + vd;
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k;
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
         + du * (u.yx * k + vec2(vb, vc) - va);
  vec3 n = vec3(v, d) * TH_NOISE_NORM;
  thNoiseDxLast = n.y;
  thNoiseDzLast = n.z;
  return n.x;
}
float thNoiseDx() { return thNoiseDxLast; }
float thNoiseDz() { return thNoiseDzLast; }
`;

// The CPU halves, for world seed `seed`.
function helpersJs(seed) {
  const stream = (salt) => pcg((seed + salt) >>> 0);
  const thHash2 = (a, b, salt) => pcg(((a >>> 0) + pcg(((b >>> 0) + stream(salt)) >>> 0)) >>> 0);
  // thNoised's derivatives, till the next call
  let dxLast = 0, dzLast = 0;
  // Lattice gradients, cached: neighbouring samples, octaves of the same field
  // and repeated rays share corners, and each costs two hashes, a cos and a sin.
  // Direct-mapped (a slot per hashed corner, the newest wins); a hit returns the
  // very numbers a miss computes, so results are bit for bit the same.
  const gKeyX = new Int32Array(GRAD_CACHE), gKeyZ = new Int32Array(GRAD_CACHE), gKeyS = new Uint32Array(GRAD_CACHE);
  const gCos = new Float64Array(GRAD_CACHE), gSin = new Float64Array(GRAD_CACHE), gSet = new Uint8Array(GRAD_CACHE);
  let gc = 0, gs = 0;   // the last grad's cos and sin
  const grad = (ix, iz, s) => {
    const slot = (Math.imul(ix, GRAD_MIX_X) ^ Math.imul(iz, GRAD_MIX_Z) ^ s) & (GRAD_CACHE - 1);
    if (gSet[slot] && gKeyX[slot] === ix && gKeyZ[slot] === iz && gKeyS[slot] === s) { gc = gCos[slot]; gs = gSin[slot]; return; }
    const a = (pcg(((ix >>> 0) + pcg(((iz >>> 0) + s) >>> 0)) >>> 0) / UINT_RANGE) * TAU;
    gc = Math.cos(a); gs = Math.sin(a);
    gKeyX[slot] = ix; gKeyZ[slot] = iz; gKeyS[slot] = s; gCos[slot] = gc; gSin[slot] = gs; gSet[slot] = 1;
  };
  const thNoised = (x, z, s) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duz = 30 * fz * fz * (fz * (fz - 2) + 1);
    grad(ix, iz, s); const ga0 = gc, ga1 = gs;
    grad(ix + 1, iz, s); const gb0 = gc, gb1 = gs;
    grad(ix, iz + 1, s); const gc0 = gc, gc1 = gs;
    grad(ix + 1, iz + 1, s); const gd0 = gc, gd1 = gs;
    const va = ga0 * fx + ga1 * fz;
    const vb = gb0 * (fx - 1) + gb1 * fz;
    const vc = gc0 * fx + gc1 * (fz - 1);
    const vd = gd0 * (fx - 1) + gd1 * (fz - 1);
    const k = va - vb - vc + vd;
    const v = va + ux * (vb - va) + uz * (vc - va) + ux * uz * k;
    const dx = ga0 + ux * (gb0 - ga0) + uz * (gc0 - ga0) + ux * uz * (ga0 - gb0 - gc0 + gd0)
      + dux * (uz * k + vb - va);
    const dz = ga1 + ux * (gb1 - ga1) + uz * (gc1 - ga1) + ux * uz * (ga1 - gb1 - gc1 + gd1)
      + duz * (ux * k + vc - va);
    dxLast = dx * NOISE_NORM;
    dzLast = dz * NOISE_NORM;
    return v * NOISE_NORM;
  };
  return {
    thHash2,
    thKey: (h, k) => pcg((h + k) >>> 0),
    thRange: (h, lo, hi) => lo + (h % Math.max(hi - lo + 1, 1)),
    thShare: (h) => h & 0xffff,
    thUnit: (h) => (h & 0xffff) / SHARE_ONE,
    thLattice: (ix, iz, salt) => (thHash2(ix, iz, salt) >>> 8) / LATTICE_ONE,
    thDiv: (a, b) => Math.floor(a / b),
    thMod: (a, b) => a - b * Math.floor(a / b),
    thFdiv: (a, b) => a / b,
    thFloor: Math.floor,
    thRound: (x) => Math.floor(x + 0.5),
    thStream: (salt, k) => (stream(salt) + k) >>> 0,
    thNoised,
    thNoiseDx: () => dxLast,
    thNoiseDz: () => dzLast,
    // the GLSL built-ins the subset may use
    abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, sqrt: Math.sqrt, pow: Math.pow,
    cos: Math.cos, sin: Math.sin,
    clamp: (x, a, b) => Math.min(Math.max(x, a), b),
    mix: (a, b, t) => a + (b - a) * t,
    smoothstep: (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); },
    float: (x) => x,
    int: Math.trunc,
  };
}

// ---------------------------------------------------------------- constants
// A scene's constants, in tables: ints, floats, salts (hash streams: uint in
// GLSL) and picks. A pick is a list of [name, weight] (weights summing to 1):
// it gives each name an index, PREFIX_<PICK>_<NAME>, and a cumulative share
// cut, PREFIX_<PICK>_<NAME>_CUT; pickGLSL writes the function that picks one.
const glslFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
function flatten(prefix, { ints = {}, floats = {}, salts = {}, picks = {} }) {
  const out = [];   // [name, js value, glsl text]
  for (const [k, v] of Object.entries(ints)) out.push([`${prefix}_${k}`, v, v < 0 ? `(${v})` : String(v)]);
  for (const [k, v] of Object.entries(floats)) out.push([`${prefix}_${k}`, v, v < 0 ? `(${glslFloat(v)})` : glslFloat(v)]);
  for (const [k, v] of Object.entries(salts)) out.push([`${prefix}_SALT_${k}`, v, `${v}u`]);
  for (const [pick, list] of Object.entries(picks)) {
    let cum = 0;
    list.forEach(([name, w], i) => {
      cum += w;
      const cut = Math.round(cum * SHARE_ONE);
      out.push([`${prefix}_${pick}_${name}`, i, String(i)]);
      out.push([`${prefix}_${pick}_${name}_CUT`, cut, String(cut)]);
    });
    if (Math.abs(cum - 1) > 1e-9) throw new Error(`${prefix} pick ${pick}: weights sum to ${cum}, not 1`);
  }
  return out;
}
export const definesGLSL = (prefix, tables) =>
  flatten(prefix, tables).map(([name, , text]) => `#define ${name} ${text}`).join('\n');
export const jsConstants = (prefix, tables) =>
  Object.fromEntries(flatten(prefix, tables).map(([name, v]) => [name, v]));

// The shared-source function `int fnName(uint h)` picking one name of pick
// table `pick` by h's share.
export function pickGLSL(prefix, pick, list, fnName) {
  const lines = list.slice(0, -1).map(([name]) => `  if (s < ${prefix}_${pick}_${name}_CUT) return ${prefix}_${pick}_${name};`);
  return `int ${fnName}(uint h) {\n  int s = thShare(h);\n${lines.join('\n')}\n  return ${prefix}_${pick}_${list[list.length - 1][0]};\n}`;
}

// Element ids, for the JS twin (the prelude has them as E_* #defines).
const elementConstants = Object.fromEntries(Object.entries(E).map(([k, v]) => [`E_${k}`, v]));

// ---------------------------------------------------------------- GLSL subset → JS
const TYPE = '(?:int|uint|float|bool|void)';
export function toJs(src) {
  const code = src.replace(/\/\/[^\n]*/g, '');
  const banned = [
    [/[/%]/, '/ or % (use thDiv, thMod, thFdiv)'],
    [/\b\d+u\b|0x[0-9a-f]+u\b/i, 'a uint literal'],
    [/[&|^~](?![&|])|<<|>>/, 'a bit operation'],
    [/\b(?:[iu]?vec[234]|mat[234]|struct|out|inout|const)\b|\[/, 'a vector, struct, array, out parameter or const'],
  ];
  for (const [re, what] of banned) {
    // (&& and || are fine: the bit-operation test looks for a lone & or |)
    const m = code.replace(/&&|\|\|/g, '').match(re);
    if (m) throw new Error(`themed scene source has ${what}: "${m[0]}" near "${code.slice(Math.max(0, m.index - 40), m.index + 20)}"`);
  }
  return code
    .replace(new RegExp(`\\b${TYPE}\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*\\{`, 'g'), (_, name, params) =>
      `function ${name}(${params.split(',').map((p) => p.trim().split(/\s+/).pop()).filter(Boolean).join(', ')}) {`)
    .replace(/\b(?:int|uint|float|bool)\s+(?=[A-Za-z_]\w*\s*[=;,])/g, 'let ');
}

// The names of the functions a shared source defines.
const functionNames = (src) =>
  [...src.replace(/\/\/[^\n]*/g, '').matchAll(new RegExp(`\\b${TYPE}\\s+(\\w+)\\s*\\([^)]*\\)\\s*\\{`, 'g'))].map((m) => m[1]);

// The JS twin of shared source src: an object of its functions, for world
// seed `seed`, with the constants in `consts` (and the element ids) in scope.
export function compileShared(src, seed, consts) {
  const scope = { ...helpersJs(seed >>> 0), ...elementConstants, ...consts };
  const names = Object.keys(scope);
  const fns = functionNames(src);
  // eslint-disable-next-line no-new-func
  const make = new Function(...names, `"use strict";\n${toJs(src)}\nreturn { ${fns.join(', ')} };`);
  return make(...names.map((n) => scope[n]));
}

// The top of the topmost matter in world column (x, z), scanning a cell
// function cell(x, y, z) → element id down from y = top - 1 (air above top).
export function groundScan(cell, x, z, top) {
  const xi = Math.floor(x), zi = Math.floor(z);
  for (let y = top - 1; y >= 0; y--) if (cell(xi, y, zi) !== E.EMPTY) return y + 1;
  return 0;
}
