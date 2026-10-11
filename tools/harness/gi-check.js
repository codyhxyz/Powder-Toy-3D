// The GI's harness page (docs/webgpu.md E, J1 U9): a Simulation, its derived
// passes and their GI probes (shaders/gi.js; src/derived.js updateGI) on
// this page's device, no app. tools/gi-check.mjs and budget-check's gi
// scenarios drive it through window.__harness:
//   gather   giGather alone over a made-up giSrc (open, blocking, partly
//            blocking and buried bricks, lit faces every way) against a JS
//            march of the same rays and its SH projection, under the real sky
//   sky      an empty box under the sky: every probe against the JS
//            projection of the sky and the floor; the open sky's visibility
//   cube     a stone cube in a level sun with the sky off, and a wall slab
//            beside it: giSource against a JS twin from the cells, the probes
//            against the JS projection, the light's direction and energy on
//            either side; the next frame's bounce (the slab's shaded face lit
//            by the cube's light), again against the twin; derived.readProbe
//   bits     giSource's coverage and light against the twin on a plate one
//            cell thick, glass, half a brick of water, metal, lamps lit and not
//   parity   from zero history, frame by frame: exactly the frame's
//            checkerboard changes, by GI_BLEND toward the reset's value, the
//            rest keep their bits; converged after 30 frames; the history and
//            the textures agree; resetGI zeroes both; the reset after it traces
//            every probe at once, as the first did
//   lit      a lit room (the shadow map, sun, sky, hot metal, an overhang): the
//            probes converge with their bounces; sky visibility under the
//            overhang and in the open; the light near the hot metal is redder
//   far      FrameUniforms.far on, with a stand-in far field: finite, the open
//            sky's visibility exactly the box's
//   lazy     a new Derived builds no GI pipeline until asked (B5); updateGI
//            records nothing until they're ready
//   bench    ms per derived frame with and without the GI
//   budget:* tools/budgets/gi.mjs
// The JS references read what the kernels read (giSrc as stored, the GPU's own
// ray directions: SwiftShader's sin and cos needn't match JS's), march in f32
// where the kernel does (Math.fround), and leave out a probe whose ray passes
// within 1e-5 of a brick face or whose transmittance lands within 1e-5 of
// GI.T_MIN, where f32 and f64 may part ways; each test says how many.

import { boot, ready, log, test, measure } from './harness.js';
import { Simulation, cellTexel } from '/src/sim.js';
import { Derived } from '/src/derived.js';
import { E, ELEMENTS, R } from '/src/elements.js';
import { brickIdOf } from '/src/shaders/common.js';
import { LOOK, LAMP_GLOW } from '/src/gfx/materials.js';
import { LAMP_DC } from '/src/electricity.js';
import { GI, giGatherFrag, giProbeCount, giGatherDispatch } from '/src/shaders/gi.js';
import { SH_Y0, SH_Y1, SKYVIS_OPEN_DC } from '/src/shaders/gfx/lighting.js';
import { SKY, skyState, airMass } from '/src/gfx/sky.js';
import { GI_BLEND } from '/src/sim.js';
import { halfsToFloats } from '/src/gpu/readback.js';
import { frameUniformsOf, writeFrameUniforms, updateGfxUniforms } from '/src/gfx/uniforms.js';
import { createVolume } from '/src/gfx/volume.js';
import { useWebGPUCamera } from '/src/gpu/three.js';
import { PerspectiveCamera, Matrix4, Vector3 } from 'three/webgpu';

const h = await boot({ label: 'gi-check' });
const gpu = h.gpu;
const fu = frameUniformsOf(gpu);
const PI_L = 3.14159265;              // the library's π (gfx/lighting.js)
const W = (4 * PI_L) / GI.RAYS;       // a ray's share of the sphere
const SH_COS1 = 2 / 3;                // gfx/lighting.js giIrradiance
const AMB = 1e-5;                     // a ray this close to a brick face, or T to T_MIN, is left out
const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mean3 = (v) => (v[0] + v[1] + v[2]) / 3;

function check(out, name, ok, detail = '') {
  out.checks.push({ name, ok: Boolean(ok), detail: ok ? '' : String(detail) });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

// A simulation, its derived passes and their GI kernels, every pipeline ready.
async function make(n = 32) {
  const sim = new Simulation(gpu, n, n, n, { debug: false });
  const derived = new Derived(sim);
  await Promise.all([sim.ready, derived.ready, derived.prepareGI()]);
  return { sim, derived, g: sim.g, dispose: () => { derived.dispose(); sim.dispose(); } };
}

// Loads a scene built by fill(set, g) and returns its cells for the JS twin:
// { ids, lit } (element per cell x + nx·(y + ny·z), and the lit lamps).
function load(sim, fill) {
  const g = sim.g;
  const [A, B] = sim.blankState();
  const ids = new Int32Array(g.nx * g.ny * g.nz), lit = new Uint8Array(ids.length);
  const set = (x, y, z, id, { temp, ctype = 0 } = {}) => {
    const i = cellTexel(g, x, y, z) * 4, e = ELEMENTS[id];
    A[i] = id;
    A[i + 1] = temp ?? e.temp;
    A[i + 2] = e.life;
    A[i + 3] = ctype + (A[i + 3] % 1);   // (blankState's seed, the cell's ctype)
    ids[x + g.nx * (y + g.ny * z)] = id;
    lit[x + g.nx * (y + g.ny * z)] = id === E.LAMP && ctype === LAMP_DC ? 1 : 0;
  };
  const box = (lo, hi, id, extra) => {
    for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) set(x, y, z, id, extra);
  };
  fill(box, set, g);
  sim.load(A, B);
  return { ids, lit };
}

// ---------------------------------------------------------------- the sky

const SKY_SUN = norm([0.45, 0.8, 0.3]);
// FrameUniforms' sky for a sun (gfx/sky.js skyState, as gfx/uniforms.js updateGfxUniforms)
function skyValues(sun, light = [1, 1, 1]) {
  const s = skyState({ x: sun[0], y: sun[1], z: sun[2] }, light, {});
  return { sun, keyLight: light, sunExt: s.sunExt, sunCol: s.sunCol, skyUp: s.skyUp, ground: s.ground };
}
// a sky that is dark but for the sun's direct light (keyLight 0: no sky radiance)
const darkSky = (sun, sunCol = [1, 0.9, 0.8]) => ({ sun, keyLight: [0, 0, 0], sunExt: [1, 1, 1], sunCol, skyUp: [0, 0, 0], ground: [0, 0, 0] });
function writeFU(v) {
  fu.uniforms.write({ shadowRes: 1, shadows: false, far: false, clouds: false, caustics: false, sea: 0, ...v });
}
// JS twin of gfx/lighting.js skyRadiance and skyColor (gfx/sky.js keeps its own private)
const TAU_AIR = SKY.tauRayleigh.map((t) => t + SKY.tauAerosol);
const AIRMASS_EQ_EPS = 1e-3, HORIZON_BLEND = 0.02;
function skyRadiance(d, v) {
  const mu = dot(d, v.sun), mv = airMass(d[1]), ms = airMass(v.sun[1]);
  const pR = (3 / (16 * PI_L)) * (1 + mu * mu);
  const g2 = SKY.aerosolG * SKY.aerosolG;
  const pM = (1 - g2) / (4 * PI_L * Math.pow(1 + g2 - 2 * SKY.aerosolG * mu, 1.5));
  return TAU_AIR.map((t, k) => {
    const dm = mv - ms, ev = Math.exp(-t * mv);
    const path = Math.abs(dm) < AIRMASS_EQ_EPS ? t * mv * ev : (mv * (v.sunExt[k] - ev)) / dm;
    return v.keyLight[k] * SKY.multi * PI_L * SKY.sunTOA * (SKY.tauRayleigh[k] * pR + SKY.tauAerosol * pM) / t * path;
  });
}
function skyColor(d, v) {
  const x = Math.min(Math.max((d[1] + HORIZON_BLEND) / (2 * HORIZON_BLEND), 0), 1), s = x * x * (3 - 2 * x);
  const r = skyRadiance(d, v);
  return v.ground.map((gc, k) => gc * (1 - s) + r[k] * s);
}
// shaders/gi.js beyond() with the sun unshadowed: the sky, or the floor and ground
const beyondOf = (v) => {
  const floor = SKY.groundAlb.map((a, k) => a * (v.sunCol[k] * Math.max(v.sun[1], 0) + v.skyUp[k]));
  return (d) => (d[1] >= 0 ? skyColor(d, v) : floor);
};

// ---------------------------------------------------------------- the GPU's side

// The gather's ray directions as the GPU computes them (its giDir, run alone).
let dirsCache = null;
async function gpuDirs(g) {
  if (dirsCache) return dirsCache;
  const text = giGatherFrag(g);
  const golden = text.match(/const GOLDEN_ANGLE: f32 = [^;]+;/)[0];
  const fn = text.match(/fn giDir\(i: i32\) -> vec3f \{[\s\S]*?\n\}/)[0];
  const code = `${golden}\nconst GI_RAYS: i32 = ${GI.RAYS};\n${fn}
@group(0) @binding(0) var<storage, read_write> dirs: array<vec4f, ${GI.RAYS}>;
@compute @workgroup_size(${GI.RAYS}) fn main(@builtin(local_invocation_index) i: u32) { dirs[i] = vec4f(giDir(i32(i)), 0.0); }`;
  const layout = gpu.layout('GI_CHECK_DIRS', [{ binding: 0, buffer: { type: 'storage' } }]);
  const kernel = gpu.kernel({ name: 'giCheckDirs', code, layouts: [layout] });
  await kernel.ready;
  const buf = gpu.createBuffer({ label: 'gi-check dirs', size: GI.RAYS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  kernel.dispatch(gpu.frame, [1, 1, 1], { bind: [gpu.bindGroup(layout, [{ binding: 0, resource: { buffer: buf } }])] });
  const f = new Float32Array(await gpu.readback.buffer(buf, 0, GI.RAYS * 16));
  buf.destroy();
  return (dirsCache = Array.from({ length: GI.RAYS }, (_, i) => [f[4 * i], f[4 * i + 1], f[4 * i + 2]]));
}
// The Fibonacci lattice in f64 (shaders/gi.js giDir), to show the GPU's is it.
const jsDir = (i) => {
  const y = 1 - (2 * i + 1) / GI.RAYS, r = Math.sqrt(Math.max(1 - y * y, 0)), a = i * Math.PI * (3 - Math.sqrt(5));
  return [r * Math.cos(a), y, r * Math.sin(a)];
};

// giSrc, the history and the four band textures, as they are now.
async function readGI(derived) {
  const n = derived.g.nbricks, rb = gpu.readback;
  const [src, hist, ...tex] = await Promise.all([
    rb.buffer(derived.giSrc, 0, n * 16), rb.buffer(derived.giHist, 0, 4 * n * 8), ...derived.giTextures.map((t) => rb.texture(t)),
  ]);
  const histBits = new Uint16Array(hist);
  return { n, src: new Uint32Array(src), histBits, hist: halfsToFloats(histBits), tex };
}
// probe id's four bands (rgba each) from a read
const probeOf = (r, id) => [0, 1, 2, 3].map((k) => Array.from(r.hist.subarray((k * r.n + id) * 4, (k * r.n + id) * 4 + 4)));
// giSrc as the gather decodes it (shaders/gi.js giSrcWGSL)
function decodeSrc(words, n) {
  const halves = halfsToFloats(new Uint16Array(words.buffer, words.byteOffset, n * 8));
  const q = (w, j) => (((w >>> (10 * j)) & 1023) - GI.DIR_STEPS) / GI.DIR_STEPS;
  return (id) => ({
    rad: [halves[8 * id], halves[8 * id + 1], halves[8 * id + 2]],
    cov: [halves[8 * id + 3], halves[8 * id + 4], halves[8 * id + 5]],
    dir: [0, 1, 2].map((j) => q(words[4 * id + 3], j)),
  });
}
// every brick, x fastest
function* bricks(g) {
  for (let z = 0; z < g.bz; z++) for (let y = 0; y < g.by; y++) for (let x = 0; x < g.bx; x++) yield [x, y, z, brickIdOf(g, x, y, z)];
}
// The history and the band textures hold the same halves, bit for bit.
function agree(g, r) {
  let bad = 0, first = '';
  for (const [x, y, z, id] of bricks(g)) {
    const t = ((z * g.by + y) * g.bx + x) * 4;
    for (let k = 0; k < 4; k++) {
      for (let c = 0; c < 4; c++) {
        if (r.histBits[(k * r.n + id) * 4 + c] !== r.tex[k][t + c]) { bad++; first ||= `brick ${x},${y},${z} band ${k}.${c}`; }
      }
    }
  }
  return { bad, first };
}
const finite = (r) => r.hist.every(Number.isFinite);

// ---------------------------------------------------------------- the JS references

// giGather's march and projection for the probe of brick bc (shaders/gi.js),
// over src(id) (decoded giSrc) and beyond(d), with the GPU's directions.
// Returns { sh: 4 bands of rgba, amb: a tie f32 and f64 may break apart, buried }.
function refProbe(g, bc, src, dirs, beyond) {
  const B = [g.bx, g.by, g.bz], f = Math.fround;
  const sh = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  let amb = false, blk = 1;
  for (let k = 0; k < 7; k++) {
    const b = [...bc];
    if (k > 0) b[(k - 1) >> 1] += (k & 1) === 1 ? 1 : -1;
    if (b.some((v, j) => v < 0 || v >= B[j])) { blk = 0; break; }
    blk = Math.min(blk, ...src(brickIdOf(g, ...b)).cov);
  }
  if (Math.abs(blk - GI.BURIED) < 1e-6) amb = true;
  if (blk > GI.BURIED) return { sh, amb, buried: true };
  for (let i = 0; i < GI.RAYS; i++) {
    const d = dirs[i], d2 = d.map((x) => x * x);
    let T = 1;
    const L = [0, 0, 0], q = bc.map((v) => v + 0.5);
    for (let k = 0; k < GI.STEPS; k++) {
      const stride = k < GI.NEAR_STEPS ? 1 : GI.FAR_STRIDE;
      for (let j = 0; j < 3; j++) {
        q[j] = f(q[j] + f(d[j] * stride));
        const fr = q[j] - Math.floor(q[j]);
        if (Math.min(fr, 1 - fr) > 0 && Math.min(fr, 1 - fr) < AMB) amb = true;
      }
      const b = q.map(Math.floor);
      if (b.some((v, j) => v < 0 || v >= B[j])) break;
      const s = src(brickIdOf(g, ...b));
      let a = dot(s.cov, d2);
      if (a <= 0) continue;
      if (k >= GI.NEAR_STEPS) a = 1 - Math.pow(1 - a, GI.FAR_STRIDE);
      const face = Math.max(1 - GI.FACING * dot(s.dir, d), 0);
      for (let c = 0; c < 3; c++) L[c] += T * a * s.rad[c] * face;
      T *= 1 - a;
      if (Math.abs(T - GI.T_MIN) < AMB) amb = true;
      if (T < GI.T_MIN) break;
    }
    if (T >= GI.T_MIN) { const bl = beyond(d); for (let c = 0; c < 3; c++) L[c] += T * bl[c]; }
    const vis = d[1] > 0 ? T : 0;
    const y = [SH_Y0, SH_Y1 * d[0], SH_Y1 * d[1], SH_Y1 * d[2]];
    for (let k = 0; k < 4; k++) {
      for (let c = 0; c < 3; c++) sh[k][c] += L[c] * y[k];
      sh[k][3] += vis * y[k];
    }
  }
  for (const band of sh) for (let c = 0; c < 4; c++) band[c] *= W;
  return { sh, amb, buried: false };
}

// The probes a read holds against references (Map id → refProbe's), within
// a half's rounding (1e-3 relative) and the f32 sums' (2e-4 of the probe's
// band 0: band 1 cancels). Returns { compared, skipped, bad, first, buried }.
function compareProbes(g, r, refs) {
  let compared = 0, skipped = 0, bad = 0, buried = 0, first = '';
  for (const [x, y, z, id] of bricks(g)) {
    const ref = refs.get(id);
    if (!ref) continue;
    if (ref.amb) { skipped++; continue; }
    compared++;
    if (ref.buried) buried++;
    const got = probeOf(r, id);
    const scaleRGB = Math.max(...ref.sh[0].slice(0, 3).map(Math.abs)), scaleA = Math.abs(ref.sh[0][3]);
    let worst = 0;
    for (let k = 0; k < 4; k++) {
      for (let c = 0; c < 4; c++) {
        const want = ref.sh[k][c], tol = 1e-3 * Math.abs(want) + 2e-4 * (c < 3 ? scaleRGB : scaleA) + 1e-7;
        worst = Math.max(worst, Math.abs(got[k][c] - want) / tol);
      }
    }
    if (worst > 1) { bad++; first ||= `brick ${x},${y},${z}: got ${JSON.stringify(got.map((b) => b.map((v) => +v.toPrecision(5))))} want ${JSON.stringify(ref.sh.map((b) => b.map((v) => +v.toPrecision(5))))}`; }
  }
  return { compared, skipped, bad, first, buried };
}
const refsFor = (g, src, dirs, beyond, only = () => true) => {
  const refs = new Map();
  for (const [x, y, z, id] of bricks(g)) if (only(x, y, z)) refs.set(id, refProbe(g, [x, y, z], src, dirs, beyond));
  return refs;
};

// giSource from the cells (shaders/gi.js giSourceFrag), the sun unshadowed:
// per brick id { rad, cov, dir }. probe(id) gives last frame's probe there
// (4 bands of rgba); cells is load()'s. Emission: a lit lamp's (LAMP_GLOW;
// the scenes hold nothing hot or luminous otherwise).
function refSource(g, cells, probe, v) {
  const { ids, lit } = cells;
  const at = (x, y, z) => ids[x + g.nx * (y + g.ny * z)];
  const opaque = (id) => id !== E.EMPTY && ELEMENTS[id].render === R.OPAQUE;
  const giOpaque = (x, y, z) => (y < 0 ? true : x < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz ? false : opaque(at(x, y, z)));
  const out = new Map();
  for (const [bx, by, bz, id] of bricks(g)) {
    const o = [bx * 4, by * 4, bz * 4];
    let any = false, tau = 0;
    const mask = new Set(), px = new Set(), py = new Set(), pz = new Set();
    for (let lz = 0; lz < 4; lz++) for (let ly = 0; ly < 4; ly++) for (let lx = 0; lx < 4; lx++) {
      const e = at(o[0] + lx, o[1] + ly, o[2] + lz);
      if (e === E.EMPTY) continue;
      any = true;
      if (opaque(e)) { mask.add(lx + 4 * ly + 16 * lz); px.add(ly + 4 * lz); py.add(lx + 4 * lz); pz.add(lx + 4 * ly); } else tau += mean3(ELEMENTS[e].sigma);
    }
    if (!any) { out.set(id, { rad: [0, 0, 0], cov: [0, 0, 0], dir: [0, 0, 0] }); continue; }
    const trans = Math.exp((-tau * 4) / 64);
    const cov = [px.size, py.size, pz.size].map((c) => 1 - (1 - c / 16) * trans);
    const pr = probe(id);
    const rad = [0, 0, 0], dir = [0, 0, 0];
    let nf = 0;
    for (const b of mask) {
      const l = [b & 3, (b >> 2) & 3, b >> 4], c = l.map((x, j) => x + o[j]);
      const e = at(...c);
      for (let f = 0; f < 6; f++) {
        const n = [0, 0, 0];
        n[f >> 1] = (f & 1) === 0 ? 1 : -1;
        const ln = l.map((x, j) => x + n[j]);
        const covered = ln.every((x) => x >= 0 && x < 4) ? mask.has(ln[0] + 4 * ln[1] + 16 * ln[2]) : giOpaque(c[0] + n[0], c[1] + n[1], c[2] + n[2]);
        if (covered) continue;
        const alb = LOOK[e].alb.map((a) => a * (1 - LOOK[e].metal * (1 - GI.METAL_DIFFUSE)));
        const em = lit[c[0] + g.nx * (c[1] + g.ny * c[2])] ? LAMP_GLOW : [0, 0, 0];
        const irr = [0, 1, 2].map((k) => Math.max(SH_Y0 * pr[0][k] + SH_COS1 * SH_Y1 * (pr[1][k] * n[0] + pr[2][k] * n[1] + pr[3][k] * n[2]), 0));
        const nl = dot(n, v.sun);
        const L = [0, 1, 2].map((k) => alb[k] * (irr[k] + (nl > 0 ? v.sunCol[k] * nl : 0)) + em[k]);
        for (let k = 0; k < 3; k++) { rad[k] += L[k]; dir[k] += n[k] * mean3(L); }
        nf++;
      }
    }
    const lum = mean3(rad);
    out.set(id, { rad: nf > 0 ? rad.map((x) => x / nf) : [0, 0, 0], cov, dir: nf > 0 && lum > 0 ? dir.map((x) => x / lum) : [0, 0, 0] });
  }
  return out;
}
// giSrc as stored against refSource: rad within a half's rounding, cov to
// 1e-3, the direction to its 10-bit step.
function compareSource(g, src, refs) {
  let bad = 0, first = '', lit = 0;
  for (const [x, y, z, id] of bricks(g)) {
    const got = src(id), want = refs.get(id);
    const scale = Math.max(...want.rad, 1e-6);
    const ok = got.rad.every((v, k) => Math.abs(v - want.rad[k]) <= 1e-3 * scale + 1e-7)
      && got.cov.every((v, k) => Math.abs(v - want.cov[k]) <= 1e-3)
      && got.dir.every((v, k) => Math.abs(v - want.dir[k]) <= 1.01 / GI.DIR_STEPS);
    if (Math.max(...want.rad) > 0) lit++;
    if (!ok) { bad++; first ||= `brick ${x},${y},${z}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`; }
  }
  return { bad, first, lit };
}
// last frame's probes, as giSource reads them (the band textures hold the history's halves)
const probesOf = (r) => (id) => probeOf(r, id);
const zeroProbe = () => [0, 1, 2, 3].map(() => [0, 0, 0, 0]);

// One derived frame with the GI (the brick map first: giSource reads it).
function frame(sim, derived, opts = {}) {
  sim.updateBricks();
  return derived.updateGI({ frame: fu.group, ...opts });
}

// ---------------------------------------------------------------- tests

// giGather alone over a made-up giSrc: half the bricks open, some blocking,
// some partly; a 3×3×3 block of blocking bricks buries its centre's probe;
// light of every colour leaving every way.
test('gather', async ({ seed = 7 } = {}) => {
  const out = { checks: [] };
  const { sim, derived, g, dispose } = await make(32);
  try {
    const v = skyValues(SKY_SUN);
    writeFU(v);
    let s = seed >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const n = g.nbricks, words = new Uint32Array(n * 4), halves = new Uint16Array(words.buffer);
    const ONE = 0x3c00;   // 1.0 as a half
    for (const [x, y, z, id] of bricks(g)) {
      const block = [x, y, z].every((c) => c >= 2 && c <= 4);
      const kind = rnd();
      const cov = block || (kind >= 0.55 && kind < 0.7) ? [ONE, ONE, ONE] : kind < 0.55 ? [0, 0, 0] : [0, 1, 2].map(() => Math.floor(rnd() * (ONE + 1)));
      const rad = [0, 1, 2].map(() => 0x2000 + Math.floor(rnd() * 0x2401));   // about 0.008 to 4
      halves.set([...rad, ...cov], 8 * id);
      const q = [0, 1, 2].map(() => Math.floor(rnd() * 1023));
      words[4 * id + 3] = (q[0] | (q[1] << 10) | (q[2] << 20)) >>> 0;
    }
    gpu.write(derived.giSrc, 0, words);
    derived.resetGI();
    const k = derived.giKernels();
    k.giGather.dispatch(gpu.frame, giGatherDispatch(g, -1), {
      bind: [fu.group, sim.bindRO, derived._giGroup('LIGHTING_GI', null)], header: sim.header(),
      params: { parity: -1, count: giProbeCount(g, -1), blend: 1, shadows: false },
    });
    const r = await readGI(derived);
    const dirs = await gpuDirs(g);
    const dev = Math.max(...dirs.map((d, i) => Math.max(...d.map((x, j) => Math.abs(x - jsDir(i)[j])))));
    // (SwiftShader's cos and sin of up to 74 rad stray about 2e-4: the JS march takes the GPU's directions)
    check(out, `the GPU's ray directions are the Fibonacci lattice (max |Δ| ${dev.toExponential(1)} against JS)`, dev < 1e-3, dev);
    check(out, 'giSrc holds the words written', r.src.every((w, i) => w === words[i]));
    const cmp = compareProbes(g, r, refsFor(g, decodeSrc(r.src, n), dirs, beyondOf(v)));
    check(out, `every probe against the JS march and projection (${cmp.compared} compared, ${cmp.buried} buried, ${cmp.skipped} left out at a tie)`,
      cmp.bad === 0 && cmp.compared >= 0.9 * n && cmp.buried >= 1, cmp.bad ? `${cmp.bad} differ; ${cmp.first}` : `compared ${cmp.compared}, buried ${cmp.buried}`);
    const a = agree(g, r);
    check(out, 'the history and the band textures hold the same halves', a.bad === 0, `${a.bad} differ, ${a.first}`);
    out.info = { compared: cmp.compared, skipped: cmp.skipped, buried: cmp.buried, dirDev: dev };
  } finally { dispose(); }
  return out;
});

// An empty box under the sky: the reset frame traces every probe, which sees
// the sky above and the sunlit floor below.
test('sky', async () => {
  const out = { checks: [] };
  const { sim, derived, g, dispose } = await make(32);
  try {
    const v = skyValues(SKY_SUN);
    writeFU(v);
    check(out, 'updateGI records', frame(sim, derived) === true);
    const r = await readGI(derived);
    const n = g.nbricks, src = decodeSrc(r.src, n);
    check(out, 'giSource: nothing in the box, nothing blocks or shines', [...bricks(g)].every(([, , , id]) => [...src(id).rad, ...src(id).cov].every((x) => x === 0)));
    const cmp = compareProbes(g, r, refsFor(g, src, await gpuDirs(g), beyondOf(v)));
    check(out, `every probe against the JS projection of the sky and the floor (${cmp.compared} compared, ${cmp.skipped} left out)`, cmp.bad === 0 && cmp.compared === n, `${cmp.bad} differ; ${cmp.first}`);
    // the open sky: half the rays see it, so band 0's visibility is 2π·Y0 and giAirSkyVis reads 1
    const open = 2 * PI_L * SH_Y0;
    const vis = [...bricks(g)].map(([, , , id]) => probeOf(r, id)[0][3]);
    const worst = Math.max(...vis.map((x) => Math.abs(x - open) / open));
    check(out, `the open sky's visibility: band 0 = 2π·Y0 (${open.toFixed(5)}) at every probe, giAirSkyVis 1 (worst ${worst.toExponential(1)})`,
      worst < 1e-3 && Math.abs((SH_Y0 * vis[0]) / SKYVIS_OPEN_DC - 1) < 1e-3, worst);
    const a = agree(g, r);
    check(out, 'the history and the band textures hold the same halves', a.bad === 0, `${a.bad} differ, ${a.first}`);
  } finally { dispose(); }
  return out;
});

// A stone cube (one brick) in a level sun from +x, the sky dark: alone, then
// with a wall slab on its +z side (its face toward the cube gets no sun).
test('cube', async () => {
  const out = { checks: [] };
  const { sim, derived, g, dispose } = await make(32);
  try {
    const n = g.nbricks, dirs = await gpuDirs(g);
    const v = darkSky([1, 0, 0]);
    writeFU(v);
    let cells = load(sim, (box) => box([12, 12, 12], [16, 16, 16], E.STONE));
    frame(sim, derived);
    const r0 = await readGI(derived);
    const src0 = decodeSrc(r0.src, n);
    const s0 = compareSource(g, src0, refSource(g, cells, zeroProbe, v));
    check(out, 'the cube alone: giSource against the JS twin from the cells', s0.bad === 0 && s0.lit === 1, `${s0.bad} differ; ${s0.first}`);
    const cube = src0(brickIdOf(g, 3, 3, 3));
    check(out, 'the cube blocks everything, and its sunlit faces\' light leaves toward +x',
      cube.cov.every((c) => c === 1) && Math.abs(cube.dir[0] - 1) < 1e-6 && cube.dir[1] === 0 && cube.dir[2] === 0, JSON.stringify(cube));
    const c0 = compareProbes(g, r0, refsFor(g, src0, dirs, beyondOf(v)));
    check(out, `...every probe against the JS projection (${c0.compared} compared, ${c0.skipped} left out)`, c0.bad === 0 && c0.compared >= 0.9 * n, `${c0.bad} differ; ${c0.first}`);
    // direction and energy: two bricks from the cube on its lit side the light comes from it, -x; on its dark side there is little
    const lum = (p) => mean3(p[0]);
    const litSide = probeOf(r0, brickIdOf(g, 5, 3, 3)), darkSide = probeOf(r0, brickIdOf(g, 1, 3, 3));
    const v1 = norm([mean3(litSide[1]), mean3(litSide[2]), mean3(litSide[3])]);
    check(out, `the probe on the cube's lit side: its light comes from the cube, -x (band 1 toward ${v1.map((x) => x.toFixed(3))})`, v1[0] < -0.95, v1);
    check(out, `...and the probe on its dark side gets under a tenth of it (${lum(darkSide).toExponential(2)} against ${lum(litSide).toExponential(2)})`,
      lum(litSide) > 0 && lum(darkSide) < 0.1 * lum(litSide));
    // with the slab: a new scene, the GI started over
    cells = load(sim, (box) => {
      box([12, 12, 12], [16, 16, 16], E.STONE);
      box([8, 8, 20], [20, 20, 24], E.WALL);
    });
    sim.resetGI();
    frame(sim, derived);
    const r1 = await readGI(derived);
    const src1 = decodeSrc(r1.src, n);
    const s1 = compareSource(g, src1, refSource(g, cells, zeroProbe, v));
    check(out, `with the slab, frame 1: giSource against the JS twin (${s1.lit} bricks give light)`, s1.bad === 0 && s1.lit > 1, `${s1.bad} differ; ${s1.first}`);
    const c1 = compareProbes(g, r1, refsFor(g, src1, dirs, beyondOf(v)));
    check(out, `...every probe against the JS projection (${c1.compared} compared, ${c1.skipped} left out)`, c1.bad === 0 && c1.compared >= 0.9 * n, `${c1.bad} differ; ${c1.first}`);
    // frame 2: the probes feed back into giSource (the bounce)
    frame(sim, derived);
    const r2 = await readGI(derived);
    const src2 = decodeSrc(r2.src, n);
    const s2 = compareSource(g, src2, refSource(g, cells, probesOf(r1), v));
    check(out, 'frame 2: giSource with last frame\'s probes against the JS twin', s2.bad === 0, `${s2.bad} differ; ${s2.first}`);
    // the slab's middle brick has no sunlit face: what it sends now is bounce, mostly toward the cube (-z)
    const slab1 = src1(brickIdOf(g, 3, 3, 5)), slab2 = src2(brickIdOf(g, 3, 3, 5));
    check(out, `the bounce: the slab's middle brick, dark in frame 1, sends light in frame 2 (${mean3(slab1.rad).toExponential(2)} → ${mean3(slab2.rad).toExponential(2)}), toward the cube (-z)`,
      mean3(slab1.rad) === 0 && mean3(slab2.rad) > 0 && slab2.dir[2] < 0, `${JSON.stringify(slab1)} ${JSON.stringify(slab2)}`);
    const a = agree(g, r2);
    check(out, 'the history and the band textures hold the same halves', a.bad === 0, `${a.bad} differ, ${a.first}`);
    const p = await derived.readProbe([5, 3, 3]), want = probeOf(r2, brickIdOf(g, 5, 3, 3)).flat();
    check(out, 'derived.readProbe gives a probe\'s four bands as the history holds them', p.length === 16 && p.every((x, i) => x === want[i]), `${p} ${want}`);
  } finally { dispose(); }
  return out;
});

// giSource's coverage, extinction and light on small pieces of everything.
test('bits', async () => {
  const out = { checks: [] };
  const { sim, derived, g, dispose } = await make(32);
  try {
    const cells = load(sim, (box) => {
      box([20, 21, 12], [24, 22, 16], E.STONE);              // a plate one cell thick: blocks along y only
      box([4, 4, 4], [8, 8, 8], E.GLASS);                    // glass: optical depth
      box([20, 4, 4], [24, 6, 8], E.WATER);                  // half a brick of water
      box([12, 4, 20], [16, 8, 24], E.METAL);                // metal: half its albedo bounces
      box([4, 16, 20], [6, 18, 22], E.LAMP, { ctype: LAMP_DC });   // a lit lamp
      box([24, 16, 20], [26, 18, 22], E.LAMP);               // and one off
      box([12, 24, 4], [14, 26, 6], E.STONE);                // stone and glass in one brick
      box([14, 24, 4], [16, 26, 6], E.GLASS);
    });
    const v = darkSky(norm([0.3, 0.9, 0.2]), [1, 1, 1]);
    writeFU(v);
    frame(sim, derived);
    const r = await readGI(derived);
    const src = decodeSrc(r.src, g.nbricks);
    const s = compareSource(g, src, refSource(g, cells, zeroProbe, v));
    check(out, `giSource against the JS twin (${s.lit} bricks give light)`, s.bad === 0, `${s.bad} differ; ${s.first}`);
    const plate = src(brickIdOf(g, 5, 5, 3));
    check(out, `the plate blocks along y only: coverage ${plate.cov.map((c) => c.toFixed(3))} (0.25, 1, 0.25)`,
      plate.cov[1] === 1 && Math.abs(plate.cov[0] - 0.25) < 1e-6 && Math.abs(plate.cov[2] - 0.25) < 1e-6);
    const on = src(brickIdOf(g, 1, 4, 5)), off = src(brickIdOf(g, 6, 4, 5));
    check(out, 'the lit lamp gives off LAMP_GLOW, the one off only the sun\'s light', mean3(on.rad) > mean3(off.rad) + 0.5 * mean3(LAMP_GLOW));
  } finally { dispose(); }
  return out;
});

// Parity and blending, from zero history in the empty box under the sky:
// every probe's new light is the reset's value S each time.
test('parity', async ({ frames = 30 } = {}) => {
  const out = { checks: [] };
  const { sim, derived, g, dispose } = await make(32);
  try {
    writeFU(skyValues(SKY_SUN));
    frame(sim, derived);
    const S = await readGI(derived);   // the reset frame: every probe traced, replaced
    derived.resetGI();
    sim.giReset = false;               // from zero history, blended (sim.resetGI() would trace all at once)
    const z = await readGI(derived);
    check(out, 'resetGI zeroes the history and the four textures', z.histBits.every((b) => b === 0) && z.tex.every((t) => t.every((b) => b === 0)));
    let prev = z, parityOk = true, blendOk = true, agreeOk = true, detail = '';
    for (let f = 1; f <= frames; f++) {
      frame(sim, derived);
      const r = await readGI(derived);
      const parity = f & 1;   // (resetGI starts the frames over: the first update is frame 1)
      for (const [x, y, z2, id] of bricks(g)) {
        const traced = ((x + y + z2 + parity) & 1) === 1;
        for (let k = 0; k < 4; k++) {
          for (let c = 0; c < 4; c++) {
            const i = (k * r.n + id) * 4 + c;
            if (!traced) {
              if (r.histBits[i] !== prev.histBits[i]) { parityOk = false; detail ||= `frame ${f}: brick ${x},${y},${z2} off the checkerboard changed`; }
            } else {
              const want = prev.hist[i] + (S.hist[i] - prev.hist[i]) * GI_BLEND;
              if (Math.abs(r.hist[i] - want) > 1e-3 * Math.abs(want) + 1e-6) { blendOk = false; detail ||= `frame ${f}: brick ${x},${y},${z2} band ${k}.${c} ${r.hist[i]}, want ${want}`; }
              if (f <= 2 && r.histBits[i] === prev.histBits[i] && S.hist[i] !== 0) { parityOk = false; detail ||= `frame ${f}: brick ${x},${y},${z2} on the checkerboard unchanged`; }
            }
          }
        }
      }
      if (agree(g, r).bad) agreeOk = false;
      prev = r;
    }
    check(out, `${frames} frames: each traces exactly its checkerboard, the rest keep their bits`, parityOk, detail);
    check(out, `...each traced probe moves GI_BLEND (${GI_BLEND}) of the way to the reset's value`, blendOk, detail);
    check(out, '...the history and the band textures hold the same halves after every frame', agreeOk);
    const worst = Math.max(...Array.from(prev.hist, (x, i) => Math.abs(x - S.hist[i]) / (Math.abs(S.hist[i]) + 1e-6)));
    check(out, `...and converge to the reset's value (worst ${worst.toExponential(1)} relative after ${frames / 2} traces each)`, worst < 2e-3, worst);
    sim.resetGI();
    const zr = await readGI(derived);
    check(out, 'sim.resetGI(): the history and the textures are zeros', zr.histBits.every((b) => b === 0) && zr.tex.every((t) => t.every((b) => b === 0)));
    frame(sim, derived);
    const again = await readGI(derived);
    check(out, 'the frame after it traces every probe and replaces it: the first reset\'s values, bit for bit',
      again.histBits.every((b, i) => b === S.histBits[i]) && agree(g, again).bad === 0);
  } finally { dispose(); }
  return out;
});

// A lit room: a stone floor, a wall, an overhang, hot metal, the sun through
// the shadow map (gfx/volume.js) and the sky. The probes converge.
test('lit', async ({ frames = 40 } = {}) => {
  const out = { checks: [], changes: [] };
  const { sim, derived, g, dispose } = await make(32);
  const volume = createVolume(gpu, sim);
  try {
    await volume.ready;
    load(sim, (box) => {
      box([0, 0, 0], [32, 1, 32], E.STONE);                  // the floor
      box([0, 1, 0], [2, 24, 32], E.WALL);                   // a wall
      box([0, 16, 0], [16, 18, 32], E.WALL);                 // an overhang from it
      box([20, 1, 12], [24, 5, 16], E.METAL, { temp: 1200 });   // hot metal
    });
    const SUN = new Vector3(0.5, 0.75, 0.35).normalize();
    const camera = useWebGPUCamera(new PerspectiveCamera(40, 1.6, 0.05, 400));
    camera.position.set(60, 50, 70);
    camera.lookAt(16, 8, 16);
    camera.updateMatrixWorld();
    const model = new Matrix4();
    let last = null, recorded = 0, shadowOk = true;
    for (let f = 1; f <= frames; f++) {
      updateGfxUniforms(sim, SUN, [1, 1, 1]);
      writeFrameUniforms(gpu, { camera, model, sun: SUN, shadowRes: volume.shadowRes, shadows: true });
      sim.updateBricks();
      shadowOk &&= volume.recordShadow();
      if (derived.updateGI({ frame: fu.group, shadow: volume.shadowTextures })) recorded++;
      if (f % 2) continue;
      const r = await readGI(derived);
      if (last) {
        // band 0's light: the largest change over two frames (every probe traced once), against the brightest probe
        let top = 0, change = 0;
        for (let i = 0; i < r.n; i++) for (let c = 0; c < 3; c++) top = Math.max(top, r.hist[i * 4 + c]);
        for (let i = 0; i < r.n; i++) for (let c = 0; c < 3; c++) change = Math.max(change, Math.abs(r.hist[i * 4 + c] - last.hist[i * 4 + c]) / top);
        out.changes.push(+change.toExponential(2));
      }
      last = r;
    }
    check(out, `every frame recorded its shadow map and GI (${recorded}/${frames})`, shadowOk && recorded === frames);
    check(out, 'the probes are finite', finite(last));
    const ch = out.changes;
    check(out, `the probes converge: the largest change over two frames falls from ${ch[0]} to ${ch[ch.length - 1]} of the brightest probe`,
      ch[ch.length - 1] < 1e-2 && ch[ch.length - 1] < ch[0] / 10, ch.join(' '));
    const skyVis = (p) => (SH_Y0 * p[0][3]) / SKYVIS_OPEN_DC;
    const open = probeOf(last, brickIdOf(g, 6, 6, 4)), under = probeOf(last, brickIdOf(g, 2, 2, 4));
    check(out, `sky visibility: ${skyVis(open).toFixed(3)} in the open, ${skyVis(under).toFixed(3)} under the overhang`,
      skyVis(open) > 0.9 && skyVis(under) < 0.6 && skyVis(under) < skyVis(open) - 0.3);
    const near = probeOf(last, brickIdOf(g, 4, 1, 3));
    const red = (p) => p[0][0] / Math.max(p[0][2], 1e-9);
    check(out, `the light beside the hot metal is redder than the open sky's (red/blue ${red(near).toFixed(2)} against ${red(open).toFixed(2)})`, red(near) > 1.2 * red(open));
    const a = agree(g, last);
    check(out, 'the history and the band textures hold the same halves', a.bad === 0, `${a.bad} differ, ${a.first}`);
    out.info = { skyOpen: skyVis(open), skyUnder: skyVis(under), redNear: red(near), redOpen: red(open) };
  } finally { volume.dispose(); dispose(); }
  return out;
});

// The far branch (FrameUniforms.far, a world's): with a stand-in far field (no
// ground past the window, sea level 0) the probes stay finite, see the sky
// exactly as the box does above the horizon, and see something else below it.
test('far', async () => {
  const out = { checks: [] };
  const { sim, derived, g, dispose } = await make(32);
  try {
    const v = skyValues(SKY_SUN);
    writeFU(v);
    frame(sim, derived);
    const boxRead = await readGI(derived);
    derived.resetGI();
    sim.giReset = true;
    writeFU({ ...v, far: true });
    frame(sim, derived);
    const farRead = await readGI(derived);
    check(out, 'finite', finite(farRead));
    let sameA = true, diffRGB = false;
    for (let i = 0; i < farRead.hist.length; i++) {
      if (i % 4 === 3) sameA &&= farRead.histBits[i] === boxRead.histBits[i];
      else diffRGB ||= farRead.histBits[i] !== boxRead.histBits[i];
    }
    check(out, 'the sky visibility (every band\'s alpha) is the box\'s, bit for bit', sameA);
    check(out, 'the light below the horizon is the far field\'s, not the box\'s floor', diffRGB);
  } finally { writeFU({ far: false }); dispose(); }
  return out;
});

// B5: a Derived builds its GI kernels only when asked.
test('lazy', async () => {
  const out = { checks: [] };
  const sim = new Simulation(gpu, 32, 32, 32, { debug: false });
  const derived = new Derived(sim);
  try {
    await Promise.all([sim.ready, derived.ready]);
    const k = derived.giKernels();
    check(out, 'a new Derived has built no GI kernel (its ready doesn\'t wait for them)', k.giSource.state === 'idle' && k.giGather.state === 'idle');
    writeFU(skyValues(SKY_SUN));
    sim.updateBricks();
    const before = { ...gpu.stats };
    const first = derived.updateGI({ frame: fu.group });
    check(out, 'updateGI before they are ready records nothing and starts them', first === false && gpu.stats.dispatches === before.dispatches && k.giSource.state !== 'idle');
    await derived.prepareGI();
    check(out, 'once prepareGI resolves, updateGI records', derived.updateGI({ frame: fu.group }) === true && sim.giReset === false);
    let threw = false;
    try { derived.updateGI({}); } catch { threw = true; }
    check(out, 'updateGI without the frame group throws', threw);
  } finally { derived.dispose(); sim.dispose(); }
  return out;
});

// What the GI costs on this device (wall clock over fenced frames: SwiftShader
// runs on the CPU, so that is its GPU time): derived frames with and without
// it, in a room scaled to the grid.
test('bench', async ({ size = 32, frames = 8 } = {}) => {
  const { sim, derived, g, dispose } = await make(size);
  try {
    const s = size / 32;
    load(sim, (box) => {
      box([0, 0, 0], [g.nx, 1, g.nz], E.STONE);
      box([0, 1, 0], [2 * s, 24 * s, g.nz], E.WALL);
      box([0, 16 * s, 0], [16 * s, 18 * s, g.nz], E.WALL);
      box([20 * s, 1, 12 * s], [24 * s, 5 * s, 16 * s], E.METAL, { temp: 1200 });
      box([8 * s, 1, 20 * s], [14 * s, 6 * s, 26 * s], E.SAND);
    });
    writeFU(skyValues(SKY_SUN));
    frame(sim, derived);
    await gpu.fence();
    const time = async (fn) => {
      await gpu.fence();
      const t0 = performance.now();
      for (let f = 0; f < frames; f++) fn();
      await gpu.fence();
      return (performance.now() - t0) / frames;
    };
    const bricksMs = await time(() => sim.updateBricks());
    const withGiMs = await time(() => frame(sim, derived));
    return { checks: [], info: { size, frames, bricksMs: +bricksMs.toFixed(1), withGiMs: +withGiMs.toFixed(1), giMs: +(withGiMs - bricksMs).toFixed(1) } };
  } finally { dispose(); }
});

// tools/budgets/gi.mjs: a derived frame with the GI (the realistic view's), and one after a reset.
test('budget:frame', async () => {
  const { sim, derived, dispose } = await make(32);
  try {
    load(sim, (box) => { box([12, 12, 12], [16, 16, 16], E.STONE); box([8, 8, 20], [20, 20, 24], E.WALL); });
    writeFU(darkSky([1, 0, 0]));
    for (let f = 0; f < 3; f++) frame(sim, derived);
    await sim.gpuSync();
    const stats = await measure(gpu, async () => { frame(sim, derived); gpu.endFrame(); await sim.gpuSync(); });
    return { stats };
  } finally { dispose(); }
});
test('budget:reset', async () => {
  const { sim, derived, dispose } = await make(32);
  try {
    writeFU(darkSky([1, 0, 0]));
    for (let f = 0; f < 3; f++) frame(sim, derived);
    await sim.gpuSync();
    const stats = await measure(gpu, async () => { sim.resetGI(); frame(sim, derived); gpu.endFrame(); await sim.gpuSync(); });
    return { stats };
  } finally { dispose(); }
});

ready();
