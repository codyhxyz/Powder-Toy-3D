// CPU-only: the beam pre-pass (src/shaders/world/beam.js) on a fixture world, its production WGSL run by
// wgsl_reflect's interpreter. No GPU, no browser. node tools/beam-cpu-check.mjs [--tiles N] [--seed S]
//   1. Conservative: for random cameras (inside the world, above it, outside its side; TAA-jittered),
//      every ray through a tile (its pixel centres and random points of it, each the march's own ray
//      through P.meshInv) meets its first brick with matter no nearer than the tile's distance. A brute
//      walk over the bricks in doubles is the reference.
//   2. Exact start: the lean march's head start (beamStartAt) then the production empty-node jumps
//      (skipEmpty, ddaJumpBox) reach the ray's first brick with matter (or its exit) in the state the
//      walk from the ray's own start reaches it: the same cell, tEnter and tMax, for head starts anywhere
//      in the ray's empty run.
import assert from 'node:assert/strict';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { beamMarchWGSL, beamStartWGSL, BEAM_TILE, BEAM_FAR } from '../src/shaders/world/beam.js';
import { worldMarchFrag } from '../src/shaders/world/march.js';
import { ddaWalk } from '../src/shaders/dda.js';

// (tools/check-crystal-transmission.mjs: wgsl_reflect 1.6.0's void calls bind arguments with setVariable)
class ShaderExec extends WgslExec {
  _call(node, context) {
    const fn = context.getFunction(node.name);
    if (!fn) return super._call(node, context);
    const values = node.args.map((arg) => this.evalExpression(arg, context));
    const scope = context.clone();
    scope.currentFunctionName = node.name;
    fn.node.args.forEach((arg, i) => scope.createVariable(arg.name, values[i], arg));
    this._execStatements(fn.node.body, scope);
  }
}

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
let seed = opt('seed', 7) >>> 0;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const TILES = opt('tiles', 48);   // tiles a camera
const CAMS = opt('cams', 6);

// ---- the fixture world: bricks with matter (a floor, boxes, a pillar, specks), and W's levels over them ----
const SIZE = [96, 64, 96];
const B = SIZE.map((n) => n / 4), N1 = B.map((n) => Math.ceil(n / 4)), N2 = N1.map((n) => Math.ceil(n / 4));
const bi = (x, y, z) => x + B[0] * (y + B[1] * z);
const occ0 = new Uint32Array(B[0] * B[1] * B[2]);
const fill = (lo, hi) => { for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) occ0[bi(x, y, z)] = 1; };
fill([0, 0, 0], [B[0], 2, B[2]]);            // the floor, 8 cells deep
fill([5, 2, 5], [9, 5, 8]);                  // a box
fill([16, 2, 14], [17, 12, 15]);             // a pillar
for (let i = 0; i < 40; i++) { const x = Math.floor(rnd() * B[0]), y = 2 + Math.floor(rnd() * (B[1] - 2)), z = Math.floor(rnd() * B[2]); occ0[bi(x, y, z)] = 1; }   // specks
const occ1 = new Uint32Array(N1[0] * N1[1] * N1[2]), occ2 = new Uint32Array(N2[0] * N2[1] * N2[2]);
for (let z = 0; z < B[2]; z++) for (let y = 0; y < B[1]; y++) for (let x = 0; x < B[0]; x++) {
  if (!occ0[bi(x, y, z)]) continue;
  occ1[(x >> 2) + N1[0] * ((y >> 2) + N1[1] * (z >> 2))] = 1;
  occ2[(x >> 4) + N2[0] * ((y >> 4) + N2[1] * (z >> 4))] = 1;
}
const occ = Uint32Array.from([...occ0, ...occ1, ...occ2]);
const occAt1 = occ0.length, occAt2 = occ0.length + occ1.length;
const brickFull = (b) => b.every((v, i) => v >= 0 && v < B[i]) && occ0[bi(...b)] === 1;

const fixtureHead = /* wgsl */ `
struct PP { meshInv: mat4x4f, sceneRes: vec2f }
struct FF { cam: vec3f }
struct WW { size: vec3i }
var<private> P: PP;
var<private> FU: FF;
var<private> WC: WW;
@group(0) @binding(0) var<storage, read_write> outv: array<f32>;
@group(0) @binding(1) var<storage, read> fxOcc: array<u32>;   // (not "occ": the interpreter scopes names dynamically, and beamEmpty has an occ)
@group(0) @binding(2) var<storage, read> inp: array<f32>;
fn wcInWorld(c: vec3i) -> bool { return all(c >= vec3i(0)) && all(c < WC.size); }
fn wcOccupied(level: u32, c: vec3i) -> bool {
  if (!wcInWorld(c)) { return false; }
  if (level == 0u) { let b = c >> vec3u(2u); return fxOcc[u32(b.x + ${B[0]} * (b.y + ${B[1]} * b.z))] != 0u; }
  if (level == 1u) { let n = c >> vec3u(4u); return fxOcc[${occAt1}u + u32(n.x + ${N1[0]} * (n.y + ${N1[1]} * n.z))] != 0u; }
  let n = c >> vec3u(6u);
  return fxOcc[${occAt2}u + u32(n.x + ${N2[0]} * (n.y + ${N2[1]} * n.z))] != 0u;
}
fn setup() {
  WC.size = vec3i(${SIZE.join(', ')});
  FU.cam = vec3f(inp[0], inp[1], inp[2]);
  P.sceneRes = vec2f(inp[3], inp[4]);
  P.meshInv = mat4x4f(inp[8], inp[9], inp[10], inp[11], inp[12], inp[13], inp[14], inp[15],
                      inp[16], inp[17], inp[18], inp[19], inp[20], inp[21], inp[22], inp[23]);
}
`;
const IN_HEAD = 24;

// ---- 1. conservative ----
const RES = [160, 100];
const beamExec = new ShaderExec(new WgslParser().parse(`${fixtureHead}
${beamMarchWGSL}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  setup();
  let t = vec2u(u32(inp[${IN_HEAD} + 2u * id.x]), u32(inp[${IN_HEAD} + 2u * id.x + 1u]));
  outv[id.x] = beamTile(t);
}`));

// the march's ray through pixel point (px, py) (gfx/worldView.js: P.meshInv's far point, the camera's eye)
const rayOf = (inv, cam, px, py) => {
  const v = new Vector3(px / RES[0] * 2 - 1, 1 - py / RES[1] * 2, 1).applyMatrix4(inv);   // (applyMatrix4 divides by w)
  return v.sub(cam).normalize();
};
// the brute walk: the entry t of the ray's first brick with matter (Infinity: none), in doubles
function firstMatter(o, d) {
  const lo = [0, 0, 0], hi = SIZE;
  let tn = 0, tf = Infinity;
  for (let a = 0; a < 3; a++) {
    const t0 = (lo[a] - o[a]) / d[a], t1 = (hi[a] - o[a]) / d[a];
    tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
  }
  if (tn >= tf) return Infinity;
  const p = o.map((v, a) => v + d[a] * (tn + 1e-9));
  const b = p.map((v, a) => Math.min(B[a] - 1, Math.max(0, Math.floor(v / 4))));
  const st = d.map((v) => (v >= 0 ? 1 : -1));
  const tm = b.map((v, a) => ((v + (st[a] > 0 ? 1 : 0)) * 4 - o[a]) / d[a]);
  const td = d.map((v) => Math.abs(4 / v));
  let t = tn;
  for (let i = 0; i < 1000; i++) {
    if (b.some((v, a) => v < 0 || v >= B[a])) return Infinity;
    if (brickFull(b)) return t;
    const a = tm[0] < tm[1] ? (tm[0] < tm[2] ? 0 : 2) : (tm[1] < tm[2] ? 1 : 2);
    t = tm[a]; b[a] += st[a]; tm[a] += td[a];
  }
  return Infinity;
}
const cams = [];
for (let c = 0; c < CAMS; c++) {
  const kind = c % 3;   // inside the world, above it, off its side
  const eye = kind === 0 ? [10 + rnd() * 76, 12 + rnd() * 40, 10 + rnd() * 76] : kind === 1 ? [rnd() * 96, 90 + rnd() * 60, rnd() * 96] : [-60 - rnd() * 60, 10 + rnd() * 50, rnd() * 96];
  const target = [20 + rnd() * 56, rnd() * 24, 20 + rnd() * 56];
  const cam = new PerspectiveCamera(50 + rnd() * 30, RES[0] / RES[1], 0.1, 4000);
  cam.position.set(...eye);
  cam.lookAt(...target);
  // TAA's jitter: a sub-pixel view offset, in the matrix the march and the beam both read
  cam.setViewOffset(RES[0], RES[1], rnd() - 0.5, rnd() - 0.5, RES[0], RES[1]);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const inv = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
  cams.push({ eye: new Vector3(...eye), inv });
}
let rays = 0, tilesN = 0, startedTiles = 0, gain = 0, gainN = 0, worst = Infinity;
const t0c = performance.now();
const samples = [];   // (eye, dir, tile's t, the ray's first matter) for part 2
for (const { eye, inv } of cams) {
  const tw = Math.ceil(RES[0] / BEAM_TILE), th = Math.ceil(RES[1] / BEAM_TILE);
  const tiles = Array.from({ length: TILES }, () => [Math.floor(rnd() * tw), Math.floor(rnd() * th)]);
  const inp = new Float32Array(IN_HEAD + 2 * TILES);
  inp.set([eye.x, eye.y, eye.z, RES[0], RES[1]]);
  inp.set(inv.elements, 8);
  tiles.forEach(([x, y], i) => { inp[IN_HEAD + 2 * i] = x; inp[IN_HEAD + 2 * i + 1] = y; });
  const out = new Float32Array(TILES);
  beamExec.dispatchWorkgroups('main', TILES, { 0: { 0: out, 1: occ, 2: inp } });
  tiles.forEach(([x, y], i) => {
    const U = out[i];
    assert(Number.isFinite(U) && U >= 0, `tile ${x},${y}: distance ${U}`);
    tilesN++;
    if (U > 0) startedTiles++;
    const pts = [];
    for (let py = 0; py < BEAM_TILE; py++) for (let px = 0; px < BEAM_TILE; px++) pts.push([x * BEAM_TILE + px + 0.5, y * BEAM_TILE + py + 0.5]);
    for (let k = 0; k < 16; k++) pts.push([x * BEAM_TILE + rnd() * BEAM_TILE, y * BEAM_TILE + rnd() * BEAM_TILE]);
    for (const [px, py] of pts) {
      const d = rayOf(inv, eye, px, py);
      const o = [eye.x, eye.y, eye.z], dv = [d.x, d.y, d.z];
      const hit = firstMatter(o, dv);
      rays++;
      worst = Math.min(worst, hit - U);
      assert(U <= hit, `tile ${x},${y} (eye ${o.map((v) => v.toFixed(1))}): distance ${U} past the ray (${px.toFixed(2)}, ${py.toFixed(2)})'s first brick with matter at ${hit}`);
      if (Number.isFinite(hit)) { gain += Math.min(U, hit) / hit; gainN++; }
      if (samples.length < 400 && rnd() < 0.3) samples.push({ o, d: dv, U, hit });
    }
  });
}
console.log(`PASS conservative: ${rays} rays of ${tilesN} tiles (${CAMS} cameras, jittered) meet matter no nearer than their tile's distance; `
  + `head start ${(100 * gain / Math.max(1, gainN)).toFixed(0)} % of the way to the first matter on average, ${startedTiles} tiles past 0; closest margin ${worst === Infinity ? '-' : worst.toFixed(3)} cells (${((performance.now() - t0c) / 1000).toFixed(1)} s)`);
assert(gain / Math.max(1, gainN) > 0.3, 'the beam should give a real head start on this fixture');

// ---- 2. exact start ----
// production text: the DDA (shaders/dda.js), the march's outside/skipEmpty (shaders/world/march.js), the head start
const grid = { nx: 64, ny: 64, nz: 64 };
const marchCode = worldMarchFrag(grid, { view: 'realistic', stage: 'march' });
const cut = (from, to) => { const i = marchCode.indexOf(from), j = marchCode.indexOf(to, i); assert(i >= 0 && j > i, `march: ${from}`); return marchCode.slice(i, j); };
const skipCode = cut('const OCC_NODE_1', '// Brick bc\'s flags');
const outsideCode = cut('fn outside(c: vec3i)', '\n// World position');
const dda = ddaWalk().replace('vec3i(NX, NY, NZ) - 1', 'WC.size - 1');
const startExec = new ShaderExec(new WgslParser().parse(`${fixtureHead}
const BS: i32 = 4;
${dda}
${outsideCode}
${skipCode.replaceAll('GRID', 'WC.size')}
${beamStartWGSL.replace(/fn beamStart\(ro[\s\S]*$/, '').replaceAll('GRID', 'WC.size')}
// walk from the state given to the first brick with matter, or out of the world: (cell, tEnter, tMax, trips)
fn walk(ro: vec3f, rd: vec3f, istp: vec3i, c0: vec3i, tm0: vec3f, te0: f32, o: u32) {
  var cell = c0; var tMax = tm0; var tEnter = te0; var n = 0;
  loop {
    if (outside(cell) || n > 400) { break; }
    if (wcOccupied(0u, cell)) { break; }
    let ax = skipEmpty(cell >> vec3u(2u), ro, rd, istp, &cell, &tMax, &tEnter);
    n++;
  }
  outv[o] = f32(cell.x); outv[o + 1u] = f32(cell.y); outv[o + 2u] = f32(cell.z); outv[o + 3u] = tEnter;
  outv[o + 4u] = tMax.x; outv[o + 5u] = tMax.y; outv[o + 6u] = tMax.z; outv[o + 7u] = f32(n);
}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  setup();
  let b = ${IN_HEAD}u + 8u * id.x;
  let ro = vec3f(inp[b], inp[b + 1u], inp[b + 2u]);
  let rd = safeDir(vec3f(inp[b + 3u], inp[b + 4u], inp[b + 5u]));
  let tb = inp[b + 6u];
  // the ray's own start, as the march's (its span through the world)
  let t0 = (vec3f(0.0) - ro) / rd;
  let t1 = (vec3f(WC.size) - ro) / rd;
  let tn = max(max(min(t0, t1).x, min(t0, t1).y), min(t0, t1).z);
  let tf = min(min(max(t0, t1).x, max(t0, t1).y), max(t0, t1).z);
  let ts = max(tn, 0.0);
  var istp: vec3i; var tDelta: vec3f; var cell: vec3i; var tMax: vec3f;
  ddaStart(ro, rd, ts, &istp, &tDelta, &cell, &tMax);
  walk(ro, rd, istp, cell, tMax, ts, 16u * id.x);
  var tEnter = ts;
  let ax = beamStartAt(tb, ro, rd, ts, tf, 0, &cell, &tMax, &tEnter);
  walk(ro, rd, istp, cell, tMax, tEnter, 16u * id.x + 8u);
}`));
// and rays grazing a brick's face (along a plane of brick boundaries, a hair off it): where a floor() can
// land on either side, and the jumps' never-backwards clamp decides
for (let i = 0; i < 120; i++) {
  const ax = i % 3, o = [rnd() * SIZE[0], 8 + rnd() * (SIZE[1] - 8), rnd() * SIZE[2]];
  o[ax] = 4 * Math.round(o[ax] / 4) + (i % 2 ? 0 : 1e-5);
  const d = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
  d[ax] = [0, 1e-6, -1e-6, 1e-4, -1e-4][i % 5];
  const l = Math.hypot(...d), dv = d.map((v) => v / l), hit = firstMatter(o, dv);
  samples.push({ o, d: dv, U: 0, hit });
}
const runs = samples.filter((s) => s.U > 0 || Number.isFinite(s.hit));
// head starts: the tile's own, and others anywhere in the ray's empty run
const cases = runs.flatMap((s) => [...(s.U > 0 ? [s.U] : []), ...[0.25, 0.5, 0.9, 0.999].map((f) => f * (Number.isFinite(s.hit) ? s.hit : 300))].map((tb) => ({ ...s, tb })));
const inp2 = new Float32Array(IN_HEAD + 8 * cases.length);
cases.forEach((c, i) => inp2.set([...c.o, ...c.d, c.tb], IN_HEAD + 8 * i));
const out2 = new Float32Array(16 * cases.length);
const t1c = performance.now();
startExec.dispatchWorkgroups('main', cases.length, { 0: { 0: out2, 1: occ, 2: inp2 } });
let same = 0, fewer = 0, saved = 0;
cases.forEach((c, i) => {
  const a = out2.slice(16 * i, 16 * i + 7), b = out2.slice(16 * i + 8, 16 * i + 15);
  assert.deepEqual([...b], [...a], `ray ${i} (tb ${c.tb}): the head start's walk ends at ${[...b]}, the walk's own at ${[...a]}`);
  same++;
  const na = out2[16 * i + 7], nb = out2[16 * i + 15];
  assert(nb <= na, `ray ${i}: the head start took more jumps (${nb} > ${na})`);
  if (nb < na) fewer++;
  saved += na - nb;
});
console.log(`PASS exact start: ${same} head starts reach the first matter (or the world's exit) in the walk's own state (cell, tEnter, tMax); ${fewer} with fewer jumps, ${(saved / Math.max(1, same)).toFixed(1)} fewer on average (${((performance.now() - t1c) / 1000).toFixed(1)} s)`);
assert(BEAM_FAR > 1e20);
