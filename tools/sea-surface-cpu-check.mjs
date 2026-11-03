// CPU-only: a liquid surface the lean march met is handed on, not found again (shaders/render.js
// rsResumeWGSL, shaders/world/march.js rsStore/rsResume). The production world march WGSL (the lean
// march, the liquid kernel and the fat event stage, and the one-pass loop as the reference) runs in
// wgsl_reflect's interpreter on a fixture sea: a world copy built by the production twin
// (world/worldCopyTwin.js), wavy water over a sloping sand bed that comes out of it (a shore), and
// the fields' level 0 sampled from the same heights. No GPU, no browser.
//   For every ray (cameras above the sea, grazing it, at the shore, and inside the water): the lean
//   march runs to its stop and writes its record (K); the liquid kernel (if the stop is its body) and
//   the fat stage resume from that record; each, like the one-pass loop from the eye, is stopped at its
//   first liquid interface (the loop head's ifPend) and its whole loop state there is compared bit for
//   bit with the one-pass loop's. phiA is the one value left out: it is dead after a surface event (the
//   head resamples it at the refracted ray's start), and the record no longer holds it there.
//   Negative control: the kernel with the handed-on t moved by a few ulps must differ.
//   Field taps (fieldTexL past its empty-level return, fieldFetch8 as 8: the cost view's count) are
//   counted per stage up to that point.
// node tools/sea-surface-cpu-check.mjs [--rays N] [--seed S] [--root DIR] [--dump FILE]
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const ROOT = opt('root', new URL('..', import.meta.url).pathname);
const imp = (p) => import(pathToFileURL(`${ROOT}/${p}`).href);
const { worldMarchFrag, MarchParams } = await imp('src/shaders/world/march.js');
const { REALISTIC_LEVELS } = await imp('src/shaders/render.js');
const { WorldCopyTwin, wcWordOf } = await imp('src/world/worldCopyTwin.js');
const { WorldCopyUniforms } = await imp('src/shaders/world/copy.js');
const { FieldClip, FIELD_FAR } = await imp('src/shaders/world/fields.js');
const { tablesBuffer } = await imp('src/shaders/common.js');
const { FrameUniformsStruct } = await imp('src/gfx/uniforms.js');
const { E } = await imp('src/elements.js');
const { LOOK, CHANNELS } = await imp('src/gfx/materials.js');
const { BRICK_INFO } = await imp('src/shaders/bindings.js');

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
  // (1.6.0 executes a for loop's init unguarded: the march's \`for (; i <= stepCap; i++)\` has none)
  execStatement(node, context) { return node === null ? null : super.execStatement(node, context); }
}
let seed = Number(opt('seed', 11)) >>> 0;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const RAYS = Number(opt('rays', 48));

// ---- the fixture sea: water to a wavy level over a sand bed that rises out of it along +x ----
const SIZE = [64, 32, 64];
const SEA = (x, z) => 14 + 0.7 * Math.sin(0.55 * x + 0.3 * z) + 0.45 * Math.sin(0.8 * z - 0.35 * x);
const BED = (x, z) => 3 + 16 * (x / SIZE[0]) ** 2 + 2.5 * Math.sin(z / 6);
const twin = new WorldCopyTwin(SIZE, { capacity: 2048 });
const cellWord = (x, y, z) => {
  const yc = y + 0.5, b = BED(x + 0.5, z + 0.5), h = SEA(x + 0.5, z + 0.5);
  if (yc < b) return wcWordOf(E.SAND, 20, 1, 0, 1);
  const fill = Math.min(1, h - y);
  return fill > 0 ? wcWordOf(E.WATER, 20, 0, 0, fill) : twin.air;
};
for (let bz = 0; bz < SIZE[2] / 4; bz++) for (let by = 0; by < SIZE[1] / 4; by++) for (let bx = 0; bx < SIZE[0] / 4; bx++) {
  const w = new Uint32Array(64);
  for (let i = 0; i < 64; i++) w[i] = cellWord(bx * 4 + (i & 3), by * 4 + ((i >> 2) & 3), bz * 4 + (i >> 4));
  twin.commit([bx, by, bz], w);
}
twin.dilateAll();
const occ = twin.occupancy();
const L = twin.L;
const meta = new Uint32Array(L.metaWords);
meta.set(twin.info, 0);
meta.set(occ, L.occ1At);
const surfBricks = twin.info.filter((v) => v & BRICK_INFO.SURF).length;

// F's level 0 over the whole world (one level, a texel a cell): each channel's φ from the same heights
const CH_LIQ = CHANNELS.findIndex((c) => c.key === 'LIQUID'), CH_SAND = LOOK[E.SAND].ch;
assert(CH_LIQ === 0 && CH_SAND > 0);
const DIMS = [SIZE[0], SIZE[1] + 1, SIZE[2]];   // (the level's guard row)
const fs = new Float32Array(DIMS[0] * DIMS[1] * DIMS[2] * 4);
const ramp = (d) => Math.min(1, Math.max(0, 0.5 + 0.5 * d));   // φ rising through SURF_ISO 0.5 at the surface, 2 cells wide
for (let z = 0; z < DIMS[2]; z++) for (let y = 0; y < SIZE[1]; y++) for (let x = 0; x < DIMS[0]; x++) {
  const xc = x + 0.5, yc = y + 0.5, zc = z + 0.5, o = 4 * (x + DIMS[0] * (y + DIMS[1] * z));
  fs[o + CH_LIQ] = ramp(SEA(xc, zc) - yc) * ramp(yc - BED(xc, zc) + 1.5);
  fs[o + CH_SAND] = ramp(BED(xc, zc) - yc);
}
const tex3 = (data, dims, format) => ({ texture: [data.buffer], descriptor: { size: dims, format, dimension: '3d', bytesPerRow: dims[0] * 16 } });
const zero3 = tex3(new Float32Array(DIMS[0] * DIMS[1] * DIMS[2] * 4), DIMS, 'rgba32float');
const sampler = { sampler: { descriptor: { magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' } } };
const far = FIELD_FAR;
const fc = FieldClip.pack({
  world: [...SIZE, 1], band: [[0, SIZE[1], 1, 0], ...Array(7).fill([0, 0, 0, 0])],
  lo: [[-far, -far, -far, 4], ...Array(7).fill([1, 1, 1, 0])], hi: [[far, far, far, 0], ...Array(7).fill([0, 0, 0, 0])],
});
const wc = WorldCopyUniforms.pack({ size: SIZE, air: twin.air, bricks: L.bricks, capacity: twin.capacity, n1: L.n1, occ1At: L.occ1At, n2: L.n2, occ2At: L.occ2At, revision: 1, cols: 0 });
const PIX_ANG = 0.002;   // radians a pixel: the cubic reading close up (cubicClose, under ~30 cells), trilinear past it
const frameOf = (cam) => FrameUniformsStruct.pack({ cam, sun: [0.3, 0.8, 0.5], sunCol: [1, 1, 1], pixScale: 1, frame: 7, shadows: 0, time: 3.5, simClock: 3.5 });
const params = MarchParams.pack({ marchNear: 0, boxed: 0, sceneRes: [64, 64], physSize: SIZE, physSuper: [SIZE[0] / 16, SIZE[1] / 16, SIZE[2] / 16] });
const TB = new Uint8Array(tablesBuffer());
const KW = 64;   // the record's texture: a pixel a ray
const kData = new Uint32Array(KW * KW * 3 * 4);
const gbK = { texture: [kData.buffer], descriptor: { size: [KW, KW, 3], format: 'rgba32uint', bytesPerRow: KW * 16 } };
const gbT = { texture: [new Float32Array(KW * KW).buffer], descriptor: { size: [KW, KW, 1], format: 'r32float', bytesPerRow: KW * 4 } };

// ---- the modules: production text, plus the probe (test only, as the cost view's spans) ----
const detail = REALISTIC_LEVELS.balanced();
const grid = { nx: SIZE[0], ny: SIZE[1], nz: SIZE[2] };
// the loop state compared at the first liquid interface (the head's ifPend); phiA is dead there
const STATE_T = {
  vec3f: ['ifP', 'ifG', 'hitPos', 'col', 'trans', 'mediumLight', 'lightRef', 'tMax', 'ro', 'rd', 'tDelta'],
  f32: ['ifT', 'ifFilmH', 'lightY', 'tCut', 'mNext', 'mOp', 'gPickA', 'gSkyIn', 'tEnter'],
  i32: ['ifLid', 'filmKey', 'bends', 'i', 'liq', 'prevCrisp', 'hitK', 'ax', 'panes'],
  u32: ['gPickL', 'flags', 'bid'],
  bool: ['ifEnter', 'ifMirror', 'ifStraight', 'ifEntry', 'ifFilm', 'ifStepOn', 'anyHit', 'lightRefAt', 'stop', 'cut', 'gThin', 'phiStale', 'glassBlock', 'gReflPend'],
  vec3i: ['cell', 'lastB', 'istp'],
};
const STATE = Object.values(STATE_T).flat();
const TYPES = Object.fromEntries(Object.entries(STATE_T).flatMap(([t, ns]) => ns.map((n) => [n, t])));
const PR_N = 128;
const putOf = (n, t) => {
  const w = (e) => `prOut[gPrAt] = ${e}; gPrAt += 1u;`;
  switch (t) {
    case 'f32': return w(`bitcast<u32>(${n})`);
    case 'i32': return w(`bitcast<u32>(${n})`);
    case 'u32': return w(n);
    case 'bool': return w(`select(0u, 1u, ${n})`);
    case 'vec3f': return ['x', 'y', 'z'].map((c) => w(`bitcast<u32>(${n}.${c})`)).join(' ');
    case 'vec3i': return ['x', 'y', 'z'].map((c) => w(`bitcast<u32>(${n}.${c})`)).join(' ');
    case 'vec4f': return ['x', 'y', 'z', 'w'].map((c) => w(`bitcast<u32>(${n}.${c})`)).join(' ');
    case 'vec2u': return ['x', 'y'].map((c) => w(`${n}.${c}`)).join(' ');
    default: throw new Error(`probe: type ${t} of ${n}`);
  }
};
const HEAD = '    if (ifPend) {\n      ifPend = false;';
async function moduleOf(stage, mutate = (c) => c) {
  let code = mutate(worldMarchFrag(grid, { view: 'realistic', detail, stage, optics: true }));
  // (wgsl_reflect 1.6.0's parser rejects a vector-typed const of a vector times a scalar: a private var)
  code = code.replace(/^const (\w+): ((?:vec|mat)\w*)\s*=/gm, 'var<private> $1: $2 =');
  // the field taps, counted where the cost view counts them (shaders/costView.js RULES)
  const tap1 = 'if (!fieldHas(t, L)) { return vec4f(0.0); }';
  assert(code.includes(tap1), 'fieldTexL changed');
  code = code.replace(`fn fieldTexL(t: texture_3d<f32>, p: vec3f, L: u32) -> vec4f {\n  ${tap1}`, `fn fieldTexL(t: texture_3d<f32>, p: vec3f, L: u32) -> vec4f {\n  ${tap1}\n  gTaps += 1u;`);
  code = code.replace(/(fn fieldFetch8\([^)]*\) -> vec4f \{)/, '$1\n  gTaps += 8u;');
  assert((code.match(/gTaps \+=/g) || []).length === 2, 'tap anchors');
  // the record K through a buffer (1.6.0's textureStore takes an array layer for a mip level): its words as
  // rsStore and rsResume write and read them
  const kIO = (code.match(/textureStore\(gbK, px, |textureLoad\(gbK, px, /g) || []).length;
  assert(kIO === (stage === 'march' ? 3 : 0) + (['ev_liquid', 'event'].includes(stage) ? 3 : 0), `${stage}: the record's reads and writes (${kIO})`);
  code = code.replace(/textureStore\(gbK, px, (\d), /g, 'prKPut(px, $1u, ').replace(/textureLoad\(gbK, px, (\d), 0\)/g, 'prKGet(px, $1u)');
  const tv = code.indexOf('fn traceView(');
  const ret = /fn traceView\([^)]*\) -> (\w+)/.exec(code)[1];
  if (code.includes(HEAD)) {
    const at = code.indexOf(HEAD, tv);
    assert(at > tv, `${stage}: the loop head`);
    const probe = `    if (ifPend) {\n      ${STATE.map((n) => putOf(n, TYPES[n])).join('\n      ')}\n      gPrHit = 1u;\n      var pr: ${ret};\n      return pr;\n    }\n`;
    code = code.slice(0, at) + probe + code.slice(at);
  }
  const pre = /* wgsl */ `
var<private> gTaps: u32 = 0u;
var<private> gPrAt: u32 = 0u;
var<private> gPrHit: u32 = 0u;
@group(0) @binding(30) var<storage, read_write> prOut: array<u32>;
@group(0) @binding(31) var<storage, read> prIn: array<f32>;
@group(0) @binding(29) var<storage, read_write> prK: array<vec4u>;
fn prKPut(px: vec2i, l: u32, v: vec4u) { prK[u32(px.x + ${KW} * px.y) * 3u + l] = v; }
fn prKGet(px: vec2i, l: u32) -> vec4u { return prK[u32(px.x + ${KW} * px.y) * 3u + l]; }
`;
  const isWhole = ret === 'VolumeHit';
  const main = /* wgsl */ `
@compute @workgroup_size(1) fn prMain(@builtin(global_invocation_id) id: vec3u) {
  let b = id.x * 8u;
  gPrAt = id.x * ${PR_N}u + 4u;
  gFragCoord = vec2f(prIn[b + 6u], prIn[b + 7u]) + 0.5;
  gAerCopy = P.aerCopy;
  let ro = FU.cam;
  let rd = safeDir(normalize(vec3f(prIn[b + 3u], prIn[b + 4u], prIn[b + 5u])));
  surfViewAng(FU.cam, ${PIX_ANG});   // (fs's surfView without derivatives: a compute kernel's)
  gCubicEye = gEye;
  gCubicPixAng = gPixAng;
  let bh = marchSpan(ro, rd);
  let t0 = max(bh.x, P.marchNear);
  var flag = 0u;
  if (bh.y <= t0 || !marchEnters(ro, rd, t0, bh)) { flag = 9u; } else {
    let g = traceView(ro, rd, t0, bh);
    ${isWhole ? 'flag = select(0u, 1u, g.hit);' : 'flag = select(0u, 2u, g.ev) | (g.body << 4u);'}
  }
  prOut[id.x * ${PR_N}u] = flag;
  prOut[id.x * ${PR_N}u + 1u] = gPrHit;
  prOut[id.x * ${PR_N}u + 2u] = gTaps;
}`;
  if (process.env.SEA_DUMP) (await import('node:fs')).writeFileSync(`${process.env.SEA_DUMP}/${stage}.wgsl`, pre + code + main);
  const t = performance.now();
  const exec = new ShaderExec(new WgslParser().parse(pre + code + main));
  return { exec, stage, ms: performance.now() - t };
}

// ---- the rays ----
const rays = [];
const add = (cam, dir, kind) => { const l = Math.hypot(...dir); rays.push({ cam, dir: dir.map((v) => v / l), kind }); };
for (let k = 0; k < RAYS; k++) {
  const kind = ['above', 'grazing', 'shore', 'under'][k % 4];
  const x = 6 + rnd() * 40, z = 6 + rnd() * 52;
  if (kind === 'above') add([x, 22 + rnd() * 8, z], [rnd() - 0.5, -0.4 - rnd(), rnd() - 0.5], kind);
  else if (kind === 'grazing') add([x, SEA(x, z) + 0.6 + rnd() * 2, z], [rnd() - 0.5, -0.02 - 0.08 * rnd(), rnd() - 0.5], kind);
  else if (kind === 'shore') add([30 + rnd() * 10, 18 + rnd() * 4, z], [0.5 + rnd(), -0.25 - 0.3 * rnd(), rnd() - 0.5], kind);
  else add([x, Math.max(BED(x, z) + 1, SEA(x, z) - 1.5 - rnd() * 3), z], [rnd() - 0.5, 0.2 + rnd(), rnd() - 0.5], kind);
}
// the eye can't be inside the sand (the march draws the cut face there: no surface to compare)
const live = rays.filter((r) => r.cam[1] >= BED(r.cam[0], r.cam[2]) + 0.5);

function run(mod, ray, r) {
  const inp = new Float32Array([...ray.cam, ...ray.dir, r % KW, Math.floor(r / KW)]);
  const out = new Uint32Array(PR_N);
  const t = performance.now();
  mod.exec.dispatchWorkgroups('prMain', 1, {
    0: { 0: TB, 1: { uniform: new Uint8Array(frameOf(ray.cam)) }, 4: gbK, 5: gbT, 29: kData, 30: out, 31: inp },
    1: { 0: { uniform: new Uint8Array(wc) }, 1: twin.table, 2: twin.pool, 3: meta },
    2: { 0: tex3(fs, DIMS, 'rgba32float'), 1: zero3, 2: zero3, 6: sampler, 7: { uniform: new Uint8Array(fc) } },
    3: { 0: { uniform: new Uint8Array(64) }, 1: { uniform: new Uint8Array(params) } },
  });
  return { flag: out[0], hit: out[1], taps: out[2], state: Array.from(out.slice(4)), ms: performance.now() - t };
}
console.log(`fixture: ${SIZE.join('x')} cells, ${surfBricks} smooth-surface bricks; ${live.length} rays`);
const T0 = performance.now();
const lean = await moduleOf('march'), kern = await moduleOf('ev_liquid'), fat = await moduleOf('event'), whole = await moduleOf('whole');
console.log(`parsed 4 modules in ${((performance.now() - T0) / 1000).toFixed(1)} s`);
const r0 = run(lean, live[0], 0);
console.log('lean', r0.flag, r0.taps, r0.ms.toFixed(0));
const w0 = run(whole, live[0], 0);
console.log('whole', w0.flag, w0.hit, w0.taps, w0.ms.toFixed(0));
