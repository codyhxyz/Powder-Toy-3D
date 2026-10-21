// CPU only (wgsl_reflect's interpreter, no GPU): World's probe reader as the volume shader reads it
// (lighting.js probeAt -> worldAccess.js worldProbe, each tap's descriptor and probe address looked up
// once for the four GI bands) against four worldProbeTex (a lookup per band, as before 2026-10-20), run
// from the production WGSL on a random sparse atlas with unknown bricks, descriptors without GI, missing
// probes and taps clamped at the world's edge. The bands, the request bits and the query's
// incompleteness must all be equal. (compile-shape-check.mjs 1c checks the volume uses worldProbe.)
// usage: node tools/v2/world-probe-check.mjs
import assert from 'node:assert/strict';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { worldAccessWGSL } from '../../src/shaders/worldAccess.js';
const full = worldAccessWGSL({ backend: 'world' });
const piece = (re) => { const m = full.match(re); assert(m, String(re)); return m[0]; };
const fnText = (name) => { const i = full.indexOf(`fn ${name}(`); assert(i >= 0, name); let j = full.indexOf('{', i), d = 1; while (d && ++j < full.length) { if (full[j] === '{') d++; else if (full[j] === '}') d--; } return full.slice(i, j + 1); };
const consts = full.split('\n').filter(l => /^const WORLD_/.test(l)).join('\n');
const fns = ['worldBrickInBounds', 'worldBookIndex', 'worldRequest', 'worldLinearAddress', 'worldLightMeta', 'worldLightDescriptor', 'worldProbeLoad', 'worldProbeTex', 'worldProbe'].map(fnText).join('\n');
const head = `${consts}
${piece(/struct WorldParams \{[\s\S]*?\n\}/)}
@group(0) @binding(3) var<uniform> WA: WorldParams;
@group(0) @binding(5) var<storage, read> worldLightBook: array<u32>;
@group(1) @binding(5) var worldAux: texture_2d_array<u32>;
@group(2) @binding(0) var tGI0: texture_2d_array<f32>;
@group(2) @binding(1) var tGI1: texture_2d_array<f32>;
@group(2) @binding(2) var tGI2: texture_2d_array<f32>;
@group(2) @binding(3) var tGI3: texture_2d_array<f32>;
@group(3) @binding(1) var<storage, read_write> worldRequests: array<atomic<u32>>;
@group(3) @binding(7) var<storage, read_write> outBuf: array<vec4f>;
var<private> worldIncomplete: bool;
${piece(/struct WorldProbe \{[^\n]*\}/)}
${fns}`;
const N = 120;
const entry = (old) => `
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let p = vec3f(f32(i % 6u) * 6.37 - 3.0, f32((i / 6u) % 5u) * 7.13 - 2.0, f32(i / 30u) * 9.1 + 0.6);
  worldIncomplete = false;
  ${old ? 'let a = WorldProbe(worldProbeTex(tGI0,p,WORLD_GI), worldProbeTex(tGI1,p,WORLD_GI), worldProbeTex(tGI2,p,WORLD_GI), worldProbeTex(tGI3,p,WORLD_GI));' : 'let a = worldProbe(p);'}
  outBuf[i * 5u] = a.c0; outBuf[i * 5u + 1u] = a.cx; outBuf[i * 5u + 2u] = a.cy; outBuf[i * 5u + 3u] = a.cz;
  outBuf[i * 5u + 4u] = vec4f(select(0.0, 1.0, worldIncomplete));
}`;
// the atlas: a 32x32x32 world (8^3 bricks), 300 light descriptors, 256 probes
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const B = 8, bricks = B * B * B, ABI = Number(consts.match(/WORLD_ABI: u32 = (\d+)u/)[1]);
const LIGHT_RECORDS = 5, AUXW = 64, AUXH = 32, PW = 16, PH = 16, PROBES = 256, DESCS = 300;
const WA = new Uint32Array(28);
WA.set([32, 32, 32, 1], 0); WA.set([B, B, B, 1], 4); WA.set([8, 8, 1000, ABI], 8); WA.set([AUXW, AUXH, 1, 132], 12);
WA.set([PW, PH, 1, PROBES], 16); WA.set([0, DESCS, LIGHT_RECORDS, 1], 20); WA.set([16, 96, 0, 0], 24);
const book = new Uint32Array(bricks);
for (let i = 0; i < bricks; i++) {
  const r = rnd();
  if (r < 0.02) book[i] = 0;                                         // unknown brick
  else { const id = Math.floor(rnd() * DESCS); const ready = r < 0.03 ? 1 : (r < 0.04 ? 4 : 2 | (rnd() < 0.5 ? 1 : 0) | (rnd() < 0.5 ? 4 : 0));
    book[i] = ((id + 1) | (ready << 29)) >>> 0; }                    // ready bits: LIGHT's, shifted down 3 (GI = 2)
}
const aux = new Uint32Array(AUXW * AUXH * 4);
for (let id = 0; id < DESCS; id++) { const rec = id * LIGHT_RECORDS + 1; const r = rnd();
  aux[rec * 4] = r < 0.01 ? 0 : (r < 0.02 ? PROBES + 3 : 1 + Math.floor(rnd() * PROBES)); aux[rec * 4 + 1] = 1 + Math.floor(rnd() * PROBES); }
const gi = [0, 1, 2, 3].map(() => { const a = new Float32Array(PW * PH * 4); for (let k = 0; k < a.length; k++) a[k] = rnd() * 4 - 1; return a; });
const tex = (data, w, h, format) => ({ texture: [data.buffer], descriptor: { size: [w, h, 1], format, dimension: '2d' } });
const run = (old) => {
  const code = head + entry(old);
  const exec = new WgslExec(new WgslParser().parse(code));
  const out = new Float32Array(N * 5 * 4), req = new Uint32Array(128);
  exec.dispatchWorkgroups('main', N, { 0: { 3: WA, 5: book }, 1: { 5: tex(aux, AUXW, AUXH, 'rgba32uint') },
    2: { 0: tex(gi[0], PW, PH, 'rgba32float'), 1: tex(gi[1], PW, PH, 'rgba32float'), 2: tex(gi[2], PW, PH, 'rgba32float'), 3: tex(gi[3], PW, PH, 'rgba32float') },
    3: { 1: req, 7: out } });
  return { out, req };
};
const a = run(true), b = run(false);
let nonzero = 0, incomplete = 0;
for (let k = 0; k < a.out.length; k++) { assert.equal(Object.is(a.out[k], b.out[k]) || a.out[k] === b.out[k], true, `value ${k}: ${a.out[k]} vs ${b.out[k]}`); if (k % 20 < 16 && a.out[k] !== 0) nonzero++; if (k % 20 === 16 && a.out[k]) incomplete++; }
assert.deepEqual([...b.req], [...a.req], 'the same request bits');
const reqBits = a.req.reduce((s, w) => s + w.toString(2).split('1').length - 1, 0);
assert(nonzero > N * 8 && incomplete > 5 && incomplete < N && reqBits > 5, `coverage: ${nonzero} nonzero, ${incomplete} incomplete, ${reqBits} request bits`);
console.log(`worldProbe == 4 x worldProbeTex on ${N} points: ${nonzero} nonzero band values, ${incomplete} incomplete queries, ${reqBits} request bits, all equal`);
