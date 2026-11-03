// CPU-only: the lean march's liquid stop (shaders/render.js, the lean loop's "liquid surface entered in this
// segment" test) against the crossing tests it stands in front of, their production WGSL run by wgsl_reflect's
// interpreter. No GPU, no browser. node tools/lean-liquid-cpu-check.mjs [--cases N] [--seed S]
//
// The lean loop stops at a ray's first rich event and the liquid kernel resumes that iteration from the record
// (shaders/world/march.js "The event stage"). The test stops before the crossing tests when the liquid's channel
// crosses in the segment and no other channel does, so the liquid's root (surfRoot: SURF_ROOT_STEPS field reads)
// is left to the kernel, which finds it again. It is exact when:
//   1. Whenever it stops, the tests below it would have stopped this iteration at the liquid too (ev EV_ENTER,
//      not cut), with the record the same (phiStale false, nothing else the record holds changed in between):
//      except a liquid root rounded past tExit, where those tests find no event here; that case is counted.
//   2. It is surfCross's own crossing test: wherever the tests below stop at the liquid, no other channel
//      crosses and the cut lies past the segment, it stops. (Where it doesn't stop, the tests below run as before.)
// The cases: random segments of random cubic fields along the ray, with the grazing ones (a sample exactly at
// SURF_ISO, the closest point at either end of the segment, the cut at, before and past tExit). Negative
// controls: mutated copies of the test must fail 1 or 2.
import assert from 'node:assert/strict';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { worldMarchFrag } from '../src/shaders/world/march.js';
import { REALISTIC_LEVELS } from '../src/shaders/render.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
let seed = opt('seed', 11) >>> 0;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const CASES = opt('cases', 4000);

// ---- the production text: the lean march stage (Balanced: the split's default detail), both optics ----
const grid = { nx: 128, ny: 128, nz: 128 };
const leanOf = (optics) => worldMarchFrag(grid, { view: 'realistic', detail: REALISTIC_LEVELS.balanced(), stage: 'march', optics });
const code = leanOf(false), codeRich = leanOf(true);
const between = (src, from, to) => { const i = src.indexOf(from), j = src.indexOf(to, i + from.length); assert(i >= 0 && j > i, `lean march: ${from}`); return src.slice(i, j + to.length); };
// the bracket at `open` and its match
const closing = (src, open) => { let d = 0; for (let i = open; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return i + 1; } throw new Error('unbalanced'); };
const blockAt = (src, head) => { const i = src.indexOf(head); assert(i >= 0, `lean march: ${head}`); return src.slice(i, closing(src, src.indexOf("{", i))); };
const STOP_HEAD = '{\n            let xa = phiA - SURF_ISO;';
const stopBlock = blockAt(code, STOP_HEAD);
assert(/evK = EVK_RESUME; evB = 1u; break;/.test(stopBlock), 'the test stops at the liquid (RICH_BODIES 0)');
assert(blockAt(codeRich, STOP_HEAD) === stopBlock.replace('(tCut >= tExit))', '(tCut >= tExit) & !brickFilm(flags))'), 'the rich optics\' test is the same, films left to the tests below');
const tests = between(code, '          let inLiq = false;', '\n') + blockAt(code, 'for (var c = 0; c < 4; c++) {');
assert(tests.includes('surfCross(ro, rd, c, !(inLiq && c == CH_LIQUID), tEnter, tM, tExit'), 'the crossing tests');
assert(code.indexOf(STOP_HEAD) < code.indexOf('          let inLiq = false;'), 'the test stands in front of the crossing tests');
const roots = between(code, 'const SURF_ROOT_STEPS', '// Outward normal');
const consts = [...code.matchAll(/^const (?:EV_\w+|OPAQUE_TIE|E_EMPTY|CH_LIQUID|SURF_ISO|EVK_RESUME)\b[^\n]*$/gm)].map((m) => m[0]).join('\n');
assert(consts.includes('const EV_ENTER') && consts.includes('const SURF_ISO') && consts.includes('const OPAQUE_TIE'), 'constants');

// ---- the fixture: the ray along x from 0, each channel's field a cubic in t (f32), surfChannel counted ----
const OUT = 9;   // floats a case's result: evK, evB, phiStale, ev, cut, the liquid's crossing, others cross, reads, reachable
const IN = 24;   // floats a case: 4 channels × 4 coefficients, tEnter, tM, tExit, tCut, then phiA.x / phiM.x / phiB.x overrides (NaN: none), spare
const fixture = (stop) => /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> outv: array<f32>;
@group(0) @binding(1) var<storage, read> inp: array<f32>;
const OUT: u32 = ${OUT}u;
${consts}
var<private> gCase: u32;
var<private> gReads: u32;
fn phiAt(t: f32, ch: i32) -> f32 {
  let b = gCase * ${IN}u + 4u * u32(ch);
  return inp[b] + t * (inp[b + 1u] + t * (inp[b + 2u] + t * inp[b + 3u]));
}
fn surfChannel(p: vec3f, ch: i32) -> f32 { gReads++; return phiAt(p.x, ch); }
fn phiVec(t: f32) -> vec4f { return vec4f(phiAt(t, 0), phiAt(t, 1), phiAt(t, 2), phiAt(t, 3)); }
fn over(v: vec4f, k: u32) -> vec4f { let o = inp[gCase * ${IN}u + k]; return select(v, vec4f(o, v.yzw), o == o); }
${roots}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  gCase = id.x;
  let b = gCase * ${IN}u;
  let ro = vec3f(0.0);
  let rd = vec3f(1.0, 0.0, 0.0);
  let tEnter = inp[b + 16u];
  let tM = inp[b + 17u];
  let tExit = inp[b + 18u];
  let tCut = inp[b + 19u];
  let phiA = over(phiVec(tEnter), 20u);
  let phiM = over(phiVec(tM), 21u);
  let phiB = over(phiVec(tExit), 22u);
  // the test (production text) in a loop of one trip, as its break leaves the march's
  var evK = 0u;
  var evB = 0u;
  var phiStale = true;
  loop {
    ${stop}
    break;
  }
  // the crossing tests (production text), as the lean loop runs them after it, and its next steps there
  var ev = EV_NONE;
  var evCh = -1;
  var tEv = tExit;
  var liq = E_EMPTY;
  gReads = 0u;
  ${tests}
  let reads = gReads;
  var cut = false;
  if (tCut < tEv) { tEv = tCut; ev = EV_NONE; cut = true; }
  // the liquid's own crossing (surfCross: NO_HIT or its root), and whether another channel crosses at all
  let tLiq = surfCross(ro, rd, CH_LIQUID, true, tEnter, tM, tExit, phiA.x, phiM.x, phiB.x);
  var others = false;
  for (var c = 1; c < 4; c++) { others = others | (surfCross(ro, rd, c, true, tEnter, tM, tExit, phiA[c], phiM[c], phiB[c]) < NO_HIT); }
  let o = OUT * gCase;
  outv[o] = f32(evK);
  outv[o + 1u] = f32(evB);
  outv[o + 2u] = select(0.0, 1.0, phiStale);
  outv[o + 3u] = f32(ev);
  outv[o + 4u] = select(0.0, 1.0, cut);
  outv[o + 5u] = tLiq;
  outv[o + 6u] = select(0.0, 1.0, others);
  outv[o + 7u] = f32(reads);
  outv[o + 8u] = select(0.0, 1.0, all(phiA < vec4f(SURF_ISO)));
}`;

// ---- the cases ----
const f32 = Math.fround;
const inp = new Float32Array(IN * CASES);
const reachable = [];   // the lean loop meets the tests only with phiA under SURF_ISO on every channel (else it stopped or hit before)
let grazing = 0;
for (let k = 0; k < CASES; k++) {
  const b = IN * k;
  const tEnter = f32(rnd() < 0.1 ? rnd() * 0.01 : 1 + rnd() * 400), len = f32(rnd() < 0.15 ? 1e-4 * rnd() : 0.05 + rnd() * 1.7);
  const tExit = f32(tEnter + len);
  const kind = rnd();
  const tM = kind < 0.2 ? tExit : kind < 0.3 ? tEnter : f32(tEnter + rnd() * (tExit - tEnter));   // tClosest clamps to either end
  const cutK = rnd();
  const tCut = cutK < 0.1 ? tExit : cutK < 0.2 ? f32(tEnter + rnd() * (tExit - tEnter)) : cutK < 0.3 ? f32(tEnter - 1) : 1e9;
  for (let c = 0; c < 4; c++) {
    // a cubic through SURF_ISO near the segment for some channels (the liquid's more often), flat below it for others
    const crosses = rnd() < (c === 0 ? 0.75 : 0.25);
    const r = tEnter + (rnd() * 1.6 - 0.3) * (tExit - tEnter);   // its crossing, in or near the segment
    const s = (rnd() < 0.8 ? 1 : -1) * (0.02 + rnd() * 2) / Math.max(len, 1e-3) * (rnd() < 0.2 ? 1e-3 : 1);
    const q = (rnd() - 0.5) * 0.1;
    // φ(t) = 0.5 + s (t - r) + q (t - r)³ around the crossing, or a constant under the iso
    const co = crosses ? [0.5 - s * r - q * r ** 3, s + 3 * q * r * r, -3 * q * r, q] : [rnd() * 0.45, 0, 0, 0];
    co.forEach((v, j) => { inp[b + 4 * c + j] = v; });
  }
  inp.set([tEnter, tM, tExit, tCut], b + 16);
  // grazing samples: exactly SURF_ISO at one of the liquid's samples, or just under it
  for (let j = 0; j < 3; j++) inp[b + 20 + j] = NaN;
  if (rnd() < 0.25) { inp[b + 20 + 1 + Math.floor(rnd() * 2)] = rnd() < 0.5 ? 0.5 : f32(0.5 - 2 ** -24); grazing++; }
  if (rnd() < 0.05) { inp[b + 20] = f32(0.5 - 2 ** -24); grazing++; }
}

function run(stop) {
  const ex = new WgslExec(new WgslParser().parse(fixture(stop)));
  const out = new Float32Array(OUT * CASES);
  ex.dispatchWorkgroups('main', CASES, { 0: { 0: out, 1: inp } });
  return out;
}
const EV_ENTER = Number(/const EV_ENTER: i32 = (\d+)/.exec(consts)[1]);
const EVK_RESUME = Number(/const EVK_RESUME: u32 = (\d+)u/.exec(consts)[1]);
const NO_HIT = 1e9;
function judge(out) {
  const r = { cases: 0, stops: 0, sameStop: 0, early: 0, missed: 0, bad1: [], bad2: [], readsBefore: 0, readsSaved: 0, liqStops: 0 };
  for (let k = 0; k < CASES; k++) {
    const o = out.subarray(OUT * k, OUT * k + OUT);
    const b = IN * k;
    if (o[8] !== 1) continue;   // (not reachable: phiA at SURF_ISO on a channel, so the lean loop stopped or hit before the tests)
    r.cases++;
    const stopped = o[0] === EVK_RESUME, oldLiq = o[3] === EV_ENTER && o[4] === 0;
    r.readsBefore += o[7];
    if (oldLiq) r.liqStops++;
    if (stopped) {
      r.stops++;
      r.readsSaved += o[7];
      if (oldLiq && o[1] === 1 && o[2] === 0) r.sameStop++;
      else if (o[5] < NO_HIT && o[5] > inp[b + 18] && o[6] === 0 && o[3] !== EV_ENTER && o[4] === 0 && inp[b + 19] >= inp[b + 18]) r.early++;   // a root rounded past tExit
      else r.bad1.push(k);
    } else if (oldLiq && o[6] === 0 && inp[b + 19] >= inp[b + 18]) { r.missed++; r.bad2.push(k); }
  }
  return r;
}

const t0 = performance.now();
const res = judge(run(stopBlock));
const show = (k) => `case ${k}: tEnter ${inp[IN * k + 16]} tM ${inp[IN * k + 17]} tExit ${inp[IN * k + 18]} tCut ${inp[IN * k + 19]}`;
assert(res.bad1.length === 0, `1: the test stopped where the crossing tests don't stop at the liquid: ${res.bad1.slice(0, 5).map(show).join('; ')}`);
assert(res.bad2.length === 0, `2: the crossing tests stop at the liquid alone where the test doesn't: ${res.bad2.slice(0, 5).map(show).join('; ')}`);
assert(res.stops > CASES / 8 && res.sameStop > 0, 'the fixture should exercise the stop');
console.log(`PASS lean liquid stop: ${res.cases} reachable segments of ${CASES} (${grazing} cases with a grazing sample), ${res.stops} stopped before the crossing tests: `
  + `${res.sameStop} where those tests stop at the liquid with the same record, ${res.early} a rounded root's iteration early; `
  + `none missed. Root reads (surfChannel) of the crossing tests ${res.readsBefore} -> ${res.readsBefore - res.readsSaved} (−${(100 * res.readsSaved / Math.max(1, res.readsBefore)).toFixed(0)} % on these segments; `
  + `${(res.readsSaved / Math.max(1, res.stops)).toFixed(1)} a stop) (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

// ---- negative controls: each mutation of the test must break 1 or 2 ----
const mutations = [
  ['others crossing ignored', '& !any(xs.yzw) ', ''],
  ['the cut ignored', ' & (tCut >= tExit)', ''],
  ['the iso point counted as outside', '(xm >= vec4f(0.0))', '(xm > vec4f(0.0))'],
  ['the closest point at tExit given a second half', ' & vec4<bool>(tM < tExit)', ''],
];
for (const [what, a, b] of mutations) {
  assert(stopBlock.includes(a), `negative control "${what}": the test no longer contains ${JSON.stringify(a)}`);
  const r = judge(run(stopBlock.replace(a, b)));
  const n = r.bad1.length + r.bad2.length;
  assert(n > 0, `negative control "${what}" passed: the check can't see that change`);
  console.log(`PASS negative control (${what}): ${r.bad1.length} wrong stops, ${r.bad2.length} missed`);
}
