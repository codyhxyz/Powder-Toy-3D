// The volume's harness page (docs/webgpu.md U6, F1, F2, F5): a Simulation,
// its derived passes, the volume (src/gfx/volume.js), the scene's overlays,
// the brush and post on this page's device, no app. tools/volume-check.mjs,
// tools/compile-bench.mjs and tools/detail-bench.mjs drive it through
// window.__harness:
//   views       each view module draws a known scene (pipeline build times, coverage, a shot)
//   inside      the camera inside the box: the box's back faces cover the screen (cull winding)
//   shadow      the shadow map of a wall slab and a glass slab against a JS march of the same rays;
//               its r32float copy equals its .x
//   pick        a batch of rays against cells the scene puts there (hits, floor, misses)
//   overlays    the floor grid, the box's edges and the brush each draw into the scene pass
//   meshes      three.js renders a box standing in a pool first; the march stops at it, the water
//               in front tints it; without the cut (control) the water hides it
//   bench       one view's pipeline creation (a module no cache has seen), the main thread's longest gap
//   gpuTime     a view's scene pass in GPU ms (timestamps), for detail-bench
//
// ?size=N (default 64): the grid, N³.

import { createPresenter } from '/src/gpu/index.js';
import { halfsToFloats } from '/src/gpu/readback.js';
import { useWebGPUCamera, createThreeRenderer, threeHasVisible } from '/src/gpu/three.js';
import { PerspectiveCamera, Matrix4, Vector3, Scene, Mesh, BoxGeometry, MeshBasicNodeMaterial } from 'three/webgpu';
import { Simulation, cellTexel } from '/src/sim.js';
import { Derived } from '/src/derived.js';
import { buildPreset } from '/src/presets.js';
import { E, ELEMENTS } from '/src/elements.js';
import { SEED_MAX } from '/src/shaders/common.js';
import { createPost, POST_DEFAULTS } from '/src/gfx/post.js';
import { createVolume } from '/src/gfx/volume.js';
import { createOverlays, FLOOR_Y, EDGE_OPACITY } from '/src/gfx/overlays.js';
import { createBrushCursor } from '/src/brush.js';
import { createMeshCut } from '/src/gfx/meshCut.js';
import { writeFrameUniforms, updateGfxUniforms, gfxUniforms } from '/src/gfx/uniforms.js';
import { VIEWS } from '/src/views.js';
import { volumeFrag, volumePipeline, VOLUME_LAYOUTS } from '/src/shaders/render.js';
import { boot, ready, test, log } from './harness.js';

const h = await boot({ label: 'volume' });
const gpu = h.gpu;
const canvas = document.getElementById('view');
const W = canvas.width, H = canvas.height;
const presenter = createPresenter(gpu, canvas);
// three before post, so post's scene target is three's RenderTarget (F3) and the
// meshes test renders into it
const three = await createThreeRenderer(gpu, canvas);
three.setPixelRatio(1);
three.setSize(W, H, false);
const post = createPost(gpu, { presenter, pixScale: gfxUniforms.uPixScale, readable: true });
const N = Number(new URLSearchParams(location.search).get('size') ?? 64);
const sim = new Simulation(gpu, N, N, N, { debug: false });
const derived = new Derived(sim);
const volume = createVolume(gpu, sim);
const overlays = createOverlays(gpu);
const brush = createBrushCursor(gpu);
const cut = createMeshCut(gpu);
await Promise.all([post.ready, sim.ready, derived.ready, volume.ready, overlays.ready, brush.ready, volume.noiseReady]);
Object.assign(h, { sim, derived, volume, post, E });
const g = sim.g;

// the volume in the scene as app.js places a box: SCALE scene units across the
// larger side, centred over the origin
const SCALE = 10 / Math.max(g.nx, g.nz);
const model = new Matrix4().makeScale(SCALE, SCALE, SCALE).setPosition(-g.nx / 2 * SCALE, 0, -g.nz / 2 * SCALE);
const gridModel = new Matrix4().makeTranslation(0, FLOOR_Y, 0);
const toScene = (x, y, z) => new Vector3(x, y, z).applyMatrix4(model);
const SUN = new Vector3(0.45, 0.8, 0.3).normalize();
const KEY = [1, 1, 1];
const GLOW_GAIN = 1.6;   // app.js uLightGain
const camera = useWebGPUCamera(new PerspectiveCamera(40, W / H, 0.05, 200));
function lookFrom(eye, at) {
  camera.position.copy(eye);
  camera.up.set(0, 1, 0);
  camera.lookAt(at);
  camera.updateMatrixWorld();
}
// app.js's box home
const home = () => lookFrom(new Vector3(11, g.ny * SCALE * 0.9 + 3, 13), new Vector3(0, g.ny * SCALE * 0.25, 0));
home();
const setPost = (s = {}) => Object.assign(post.settings, POST_DEFAULTS, { taa: false, bloom: 0, adapt: false, meter: false }, s);
setPost();
const fence = async () => { await gpu.fence(); await gpu.readback.idle(); };

// ---------------------------------------------------------------- scenes

const SCENES = {
  empty() {},
  // a bit of everything: an opaque slab in the air, a glass pane, a pool in a
  // glass tank, a sand pile, a smoke puff, a stone pillar, lava
  test(set) {
    for (let x = 8; x < 24; x++) for (let z = 8; z < 24; z++) for (let y = 40; y < 43; y++) set(x, y, z, E.WALL);
    for (let x = 36; x < 52; x++) for (let y = 6; y < 26; y++) set(x, y, 26, E.GLASS);
    for (let x = 30; x <= 58; x++) for (let z = 34; z <= 58; z++) for (let y = 0; y <= 12; y++) {
      const wall = x === 30 || x === 58 || z === 34 || z === 58 || y === 0;
      if (wall) set(x, y, z, E.GLASS); else if (y <= 10) set(x, y, z, E.WATER);
    }
    for (let y = 0; y < 8; y++) for (let x = 14 - (7 - y); x <= 14 + (7 - y); x++) for (let z = 44 - (7 - y); z <= 44 + (7 - y); z++) set(x, y, z, E.SAND);
    for (let x = 18; x < 25; x++) for (let y = 18; y < 25; y++) for (let z = 18; z < 25; z++) set(x, y, z, E.SMOKE);
    for (let x = 4; x < 7; x++) for (let z = 54; z < 57; z++) for (let y = 0; y < 30; y++) set(x, y, z, E.STONE);
    for (let x = 50; x < 55; x++) for (let z = 10; z < 15; z++) for (let y = 0; y < 4; y++) set(x, y, z, E.LAVA);
  },
  // the shadow test: a wall slab and a glass slab in the air, apart
  shadow(set) {
    for (let x = 8; x < 24; x++) for (let z = 8; z < 24; z++) for (let y = 40; y < 43; y++) set(x, y, z, E.WALL);
    for (let x = 36; x < 52; x++) for (let z = 36; z < 52; z++) for (let y = 30; y < 32; y++) set(x, y, z, E.GLASS);
  },
  // the meshes test: a pool in a glass tank (a body stands in it, near its front)
  pool(set) {
    for (let x = 16; x <= 48; x++) for (let z = 16; z <= 48; z++) for (let y = 0; y <= 14; y++) {
      const wall = x === 16 || x === 48 || z === 16 || z === 48 || y === 0;
      if (wall) set(x, y, z, E.GLASS); else if (y <= 12) set(x, y, z, E.WATER);
    }
  },
};
const SCENE_BOXES = {
  shadow: { wall: [[8, 40, 8], [24, 43, 24]], glass: [[36, 30, 36], [52, 32, 52]] },
};

// Math.random from a seed (mulberry32), so the cells' seeds repeat
function seed(s) {
  Math.random = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Loads a scene (or one of the app's presets) and brings the derived fields to rest.
async function load(name) {
  seed(12345);
  if (SCENES[name]) {
    const [A, B] = sim.blankState();
    const set = (x, y, z, id) => {
      if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return;
      const i = cellTexel(g, x, y, z) * 4, e = ELEMENTS[id];
      A[i] = id; A[i + 1] = e.temp; A[i + 2] = e.life; A[i + 3] = Math.random() * SEED_MAX;
    };
    SCENES[name](set);
    sim.load(A, B);
  } else buildPreset(name, sim);
  updateGfxUniforms(sim, SUN, KEY);
  // the field EMA's settle frames and then some (shaders/fields.js FIELD_EMA_SETTLE)
  for (let k = 0; k < 16; k++) sim.updateBricks();
  await fence();
}
h.load = load;

// ---------------------------------------------------------------- a frame

const viewId = (key) => VIEWS.find((v) => v.key === key).id;
/**
 * The frame's parts: FrameUniforms, the shadow map, then (optionally three's
 * opaque meshes first) the grid, the volume, the edges and the brush.
 */
function hooks({ view = 'plain', detail = {}, meshes = null, useCut = true, grid = true, edges = true, withBrush = false, volumeOn = true } = {}) {
  return {
    prepare(p) {
      writeFrameUniforms(gpu, {
        camera, model, sun: SUN, view: viewId(view), shadowRes: volume.shadowRes, time: 0, lightGain: GLOW_GAIN,
        shadows: true, far: false, jitter: p.jitter,
      });
    },
    compute() { volume.recordShadow(); },
    opaque: meshes ? (p) => {
      // three's opaque meshes, clearing the target (S1): the hook's contract
      three.setRenderTarget(p.sceneTarget.rt);
      three.setClearColor(0x000000, 0);
      three.autoClear = true;
      three.render(meshes, camera);
      three.autoClear = false;
      three.setRenderTarget(null);
      return useCut ? cut.capture(p.sceneTarget.depth) : true;
    } : undefined,
    draw(rp) {
      if (grid) overlays.drawGrid(rp, { model: gridModel, opacity: 1 });
      if (volumeOn) volume.draw(rp, { view, detail, meshDepth: cut.take() });
      if (edges) overlays.drawEdges(rp, { size: [g.nx, g.ny, g.nz], opacity: EDGE_OPACITY });
      if (withBrush) brush.draw(rp);
    },
  };
}
// One frame to the canvas, or with `size` [w, h] to an rgba8unorm target of
// that size (the realistic view is slow on SwiftShader: fewer pixels); the
// scene target's colour (linear, premultiplied) and depth after it.
const targets = new Map();
function targetOf([w, h]) {
  let t = targets.get(`${w}x${h}`);
  if (!t) targets.set(`${w}x${h}`, t = gpu.createTexture({ label: `volume target ${w}x${h}`, size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
  return t;
}
async function frame({ size = null, ...opts } = {}) {
  const target = size ? targetOf(size) : null;
  post.render(hooks(opts), camera, target);
  const shot = target ? gpu.readback.texture(target).then((data) => ({ width: target.width, height: target.height, data })) : post.capture();
  gpu.endFrame();
  const scene = post.targets.scene, depth = post.targets.depth;
  const [c, d, cap] = await Promise.all([
    gpu.readback.texture(scene), gpu.readback.texture(depth, { aspect: 'depth-only' }), shot,
  ]);
  await fence();
  return { color: halfsToFloats(c), depth: new Float32Array(d.buffer, d.byteOffset, d.length), w: scene.width, h: scene.height, cap };
}
async function png({ width, height, data }) {
  const c = new OffscreenCanvas(width, height);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height), 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// coverage, mean luminance and luminance variance of the scene target
function stats(f) {
  let covered = 0, sum = 0, sum2 = 0;
  const n = f.w * f.h;
  for (let i = 0; i < n; i++) {
    const a = f.color[4 * i + 3];
    if (a > 0.01) covered++;
    const l = 0.2126 * f.color[4 * i] + 0.7152 * f.color[4 * i + 1] + 0.0722 * f.color[4 * i + 2];
    sum += l; sum2 += l * l;
  }
  return { covered: covered / n, mean: sum / n, variance: sum2 / n - (sum / n) ** 2 };
}
const px = (f, [x, y]) => Array.from(f.color.subarray(4 * (y * f.w + x), 4 * (y * f.w + x) + 4));
const pxDepth = (f, [x, y]) => f.depth[y * f.w + x];
// the pixel a scene point projects to (y down)
function project(p, [w, h] = [W, H]) {
  const v = p.clone().project(camera);
  return [Math.min(w - 1, Math.max(0, Math.floor((v.x * 0.5 + 0.5) * w))), Math.min(h - 1, Math.max(0, Math.floor((0.5 - v.y * 0.5) * h)))];
}
// the realistic view's frames here (SwiftShader runs it on the CPU)
const SMALL = [160, 100];

// ---------------------------------------------------------------- tests

test('views', async ({ views = VIEWS.map((v) => v.key), detail = {}, scene = 'test', shots = false } = {}) => {
  await load(scene);
  home();
  const out = {};
  for (const view of views) {
    const t0 = performance.now();
    await volume.viewReady(view, detail);
    const buildMs = performance.now() - t0;
    const f = await frame({ view, detail, size: view === 'realistic' ? SMALL : null });
    out[view] = { buildMs, ...stats(f), shot: shots ? await png(await f.cap) : null };
    log(view, JSON.stringify({ buildMs: Math.round(buildMs), ...stats(f) }));
  }
  return { out, failures: [...h.failures] };
});

// The camera inside the box looking down: every pixel's ray meets the floor
// (or what is on it), so the box's back faces must cover the screen (cullMode
// 'front'); with the wrong winding nothing would draw from inside.
test('inside', async () => {
  await load('empty');
  await volume.viewReady('plain');
  lookFrom(toScene(g.nx / 2, g.ny * 0.6, g.nz / 2), toScene(g.nx / 2 + 0.01, 0, g.nz / 2 + 0.02));
  const f = await frame({ view: 'plain', grid: false, edges: false });
  home();
  return { ...stats(f), failures: [...h.failures] };
});

// The shadow map against a JS march of the same texel rays (sunBasis as
// shaders/gfx/lighting.js, origin 0): where a ray meets the wall slab, x is
// where it enters it; where it crosses the glass slab first, y and z are where
// it enters and leaves it and w's tint id is glass's; elsewhere x is the
// floor's depth. Rays that pass within EDGE cells of a slab's edges are left out.
test('shadow', async () => {
  await load('shadow');
  writeFrameUniforms(gpu, { camera, model, sun: SUN, shadowRes: volume.shadowRes, lightGain: GLOW_GAIN });
  volume.recordShadow();
  const { map, x: mapX } = volume.shadowTextures;
  const [m, mx] = await Promise.all([gpu.readback.texture(map), gpu.readback.texture(mapX)]);
  await fence();
  const res = volume.shadowRes, G = [g.nx, g.ny, g.nz];
  const sun = [SUN.x, SUN.y, SUN.z];
  const c = G.map((n) => n / 2);
  const R = 0.5 * Math.hypot(...G) + 1;   // SHADOW_PAD
  const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const u = norm(cross([0, 1, 0], sun)), v = cross(sun, u);
  const rd = sun.map((s) => -s);
  const EDGE = 0.02, TOL = 2e-3;
  const slab = ([lo, hi], ro) => {
    let tn = -Infinity, tf = Infinity;
    for (let k = 0; k < 3; k++) {
      const a = (lo[k] - ro[k]) / rd[k], b = (hi[k] - ro[k]) / rd[k];
      tn = Math.max(tn, Math.min(a, b)); tf = Math.min(tf, Math.max(a, b));
    }
    return { hit: tf > tn, tn, tf };
  };
  // the slab's answer where it doesn't depend on rounding: grown and shrunk by EDGE it agrees, else null
  const grow = ([lo, hi], e) => [lo.map((x) => x - e), hi.map((x) => x + e)];
  const robust = (b, ro) => (slab(grow(b, EDGE), ro).hit === slab(grow(b, -EDGE), ro).hit ? slab(b, ro) : null);
  const boxes = SCENE_BOXES.shadow;
  let checked = 0, skipped = 0, bad = 0, xCopyBad = 0, glassTexels = 0, wallTexels = 0, floorTexels = 0;
  const worst = [];
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = (j * res + i) * 4;
      if (m[k] !== mx[j * res + i]) xCopyBad++;
      const st = [((i + 0.5) / res) * 2 - 1, ((j + 0.5) / res) * 2 - 1];
      const ro = c.map((cc, a) => cc + sun[a] * R + (u[a] * st[0] + v[a] * st[1]) * R);
      // the ray must cross the box
      const box = slab([[0, 0, 0], G], ro);
      if (!box.hit || box.tf <= Math.max(box.tn, 0)) continue;
      const wall = robust(boxes.wall, ro), glass = robust(boxes.glass, ro);
      if (!wall || !glass) { skipped++; continue; }
      const want = { x: ro[1] / -rd[1], y: 1e5, z: 1e5, tid: 0 };
      if (glass.hit && (!wall.hit || glass.tn < wall.tn)) { want.y = glass.tn; want.z = glass.tf; want.tid = E.GLASS; }
      if (wall.hit) want.x = wall.tn;
      if (wall.hit) wallTexels++; else floorTexels++;
      if (want.tid) glassTexels++;
      const got = { x: m[k], y: m[k + 1], z: m[k + 2], tid: Math.floor(m[k + 3] / 256) };
      const err = Math.max(Math.abs(got.x - want.x), Math.abs(got.y - want.y), Math.abs(got.z - want.z)) / Math.max(1, Math.abs(want.x));
      checked++;
      if (err > TOL || got.tid !== want.tid) {
        bad++;
        if (worst.length < 5) worst.push({ i, j, got, want: { ...want } });
      }
    }
  }
  return { res, checked, skipped, bad, xCopyBad, wallTexels, glassTexels, floorTexels, worst, failures: [...h.failures] };
});

// A batch of rays (more than one dispatch takes) against cells the test scene
// holds: straight down onto the wall slab (its top face), onto the floor, into
// the smoke puff (gas is passed through: the floor), from above the box
// pointing away (a miss), and sideways into the stone pillar.
test('pick', async () => {
  await load('test');
  const rays = [
    { ro: [10.5, g.ny + 5, 10.5], rd: [0, -1, 0], want: { valid: true, cell: [10, 42, 10], face: 2, id: E.WALL } },
    { ro: [20.5, g.ny + 5, 15.5], rd: [0, -1, 0], want: { valid: true, cell: [20, 42, 15], face: 2, id: E.WALL } },
    { ro: [27.5, g.ny + 5, 5.5], rd: [0, -1, 0], want: { valid: true, cell: [27, -1, 5], face: 2, id: -1 } },
    { ro: [21.5, g.ny + 5, 21.5], rd: [0, -1, 0], want: { valid: true, cell: [21, 42, 21], face: 2, id: E.WALL } },
    { ro: [21.5, 30.5, 21.5], rd: [0, -1, 0], want: { valid: true, cell: [21, -1, 21], face: 2, id: -1 } },   // through the smoke
    { ro: [10.5, g.ny + 5, 10.5], rd: [0, 1, 0], want: { valid: false } },
    { ro: [-5, 10.5, 55.5], rd: [1, 0, 0], want: { valid: true, cell: [4, 10, 55], face: 1, id: E.STONE } },   // stepping +x: face 0·2 + 1
    { ro: [44.5, 20.5, -5], rd: [0, 0, 1], want: { valid: true, cell: [44, 20, 26], face: 5, id: E.GLASS } },
    { ro: [40.5, g.ny + 5, 40.5], rd: [0, -1, 0], want: { valid: true, cell: [40, 10, 40], face: 2, id: E.WATER } },
    { ro: [14.5, g.ny + 5, 44.5], rd: [0, -1, 0], want: { valid: true, cell: [14, 7, 44], face: 2, id: E.SAND } },
    { ro: [52.5, g.ny + 5, 12.5], rd: [0, -1, 0], want: { valid: true, cell: [52, 3, 12], face: 2, id: E.LAVA } },
    { ro: [62.5, g.ny + 5, 2.5], rd: [0, -1, 0], want: { valid: true, cell: [62, -1, 2], face: 2, id: -1 } },
  ].filter((r) => r.ro.every((c) => c < g.nx + 6));
  const stats0 = { ...gpu.stats };
  const got = await Promise.all(rays.map((r) => volume.pick(r.ro, r.rd)));
  const dispatches = gpu.stats.dispatches - stats0.dispatches;
  const results = rays.map((r, i) => {
    const p = got[i];
    const ok = p.valid === r.want.valid && (!r.want.valid || (p.cell.every((c, k) => c === r.want.cell[k]) && p.face === r.want.face && p.id === r.want.id));
    return { ok, want: r.want, got: { valid: p.valid, cell: p.cell, face: p.face, id: p.id, T: p.T } };
  });
  return { results, dispatches, failures: [...h.failures] };
});

// The floor grid, the box's edges and the brush, each alone over the same
// frame: the pixels each changes.
test('overlays', async ({ shots = false } = {}) => {
  await load('test');
  await volume.viewReady('plain');
  home();
  const base = await frame({ view: 'plain', grid: false, edges: false });
  brush.set({ visible: true, position: toScene(16, 44, 16), radius: 5 * SCALE, shape: 0, color: '#ffcc66' });
  const parts = { grid: { grid: true, edges: false }, edges: { grid: false, edges: true }, brush: { grid: false, edges: false, withBrush: true } };
  const out = {};
  for (const [name, o] of Object.entries(parts)) {
    const f = await frame({ view: 'plain', ...o });
    let changed = 0, overVolume = 0;
    for (let i = 0; i < f.w * f.h; i++) {
      const d = Math.max(...[0, 1, 2, 3].map((c) => Math.abs(f.color[4 * i + c] - base.color[4 * i + c])));
      if (d > 1e-3) { changed++; if (base.color[4 * i + 3] > 0.5) overVolume++; }
    }
    out[name] = { changed, overVolume, shot: shots ? await png(await f.cap) : null };
  }
  // a box brush and a line's preview (both ends and the body between)
  brush.setLine({ from: toScene(10, 30, 50), to: toScene(50, 30, 50), radius: 3 * SCALE, shape: 1, color: '#66ccff' });
  const fl = await frame({ view: 'plain', grid: false, edges: false, withBrush: true });
  let lineChanged = 0;
  for (let i = 0; i < fl.w * fl.h; i++) if (Math.abs(fl.color[4 * i + 3] - base.color[4 * i + 3]) > 1e-3 || Math.abs(fl.color[4 * i] - base.color[4 * i]) > 1e-3) lineChanged++;
  brush.set({ visible: false });
  return { out, lineChanged, lineShot: shots ? await png(await fl.cap) : null, failures: [...h.failures] };
});

// Sync log S1: a red box (three.js) stands in a pool near its front glass,
// its top above the water. Rendered first (opaque), its depth copied; the
// realistic march stops there. Points: its top above the water (the volume
// draws nothing there: pure red, at the box's depth), its submerged front
// (the glass and a little water in front tint it: the volume's hit, nearer),
// and water beside it (identical with and without the cut). The control
// draws the same frame without the cut: the water then hides the box.
test('meshes', async ({ detail = {}, shots = false } = {}) => {
  await load('pool');
  await volume.viewReady('realistic', detail);
  const meshScene = new Scene();
  const sx = 6, sy = 24, sz = 6;   // cells
  const body = new Mesh(new BoxGeometry(sx * SCALE, sy * SCALE, sz * SCALE), new MeshBasicNodeMaterial({ color: 0xff0000 }));
  body.position.copy(toScene(32, sy / 2, 22));
  meshScene.add(body);
  meshScene.updateMatrixWorld();
  lookFrom(toScene(32, 22, -12), toScene(32, 9, 32));
  await three.compileAsync(meshScene, camera);
  const pAbove = project(toScene(32, 19, 19), SMALL), pBelow = project(toScene(32, 6, 19), SMALL), pWater = project(toScene(42, 6, 19), SMALL);
  const common = { view: 'realistic', detail, meshes: meshScene, grid: false, edges: false, size: SMALL };
  const withCut = await frame({ ...common, useCut: true });
  const control = await frame({ ...common, useCut: false });
  // the box's own depth there: three alone, no volume
  const alone = await frame({ ...common, useCut: true, volumeOn: false });
  home();
  body.geometry.dispose();
  body.material.dispose();
  const at = (f, p) => ({ color: px(f, p), depth: pxDepth(f, p) });
  return {
    points: { above: pAbove, below: pBelow, water: pWater },
    visible: threeHasVisible(meshScene, camera),
    withCut: { above: at(withCut, pAbove), below: at(withCut, pBelow), water: at(withCut, pWater) },
    control: { above: at(control, pAbove), below: at(control, pBelow), water: at(control, pWater) },
    alone: { above: at(alone, pAbove), below: at(alone, pBelow), water: at(alone, pWater) },
    shots: shots ? { withCut: await png(await withCut.cap), control: await png(await control.cap) } : null,
    failures: [...h.failures],
  };
});

// One view's pipeline, built in a module no cache has seen (a unique constant
// it really uses), timed; meanwhile a 4 ms timer measures the main thread's
// longest gap (docs/webgpu.md goal 4: nothing over 100 ms while pipelines build).
test('bench', async ({ view = 'plain', detail = {}, runs = 1 } = {}) => {
  const L = VOLUME_LAYOUTS().map((entries, i) => gpu.device.createBindGroupLayout({ label: `bench ${i}`, entries }));
  const layout = gpu.device.createPipelineLayout({ label: 'bench', bindGroupLayouts: L });
  const d = volumePipeline();
  const out = [];
  for (let r = 0; r < runs; r++) {
    const bust = `${Date.now()}${r}${Math.random()}`.replace(/\D/g, '').slice(0, 9);
    const code = volumeFrag(g, { view, detail }).replace('let t0 = max(bh.x, P.marchNear);', `let t0 = max(bh.x, P.marchNear) + f32(${bust}u % 1u);`);
    let gap = 0, last = performance.now(), ticks = 0;
    const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; ticks++; }, 4);
    const t0 = performance.now();
    const module = gpu.device.createShaderModule({ label: `bench ${view}`, code });
    const tModule = performance.now() - t0;
    await gpu.device.createRenderPipelineAsync({
      label: `bench ${view}`, layout,
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: d.fragment.targets },
      primitive: d.primitive, depthStencil: d.depthStencil,
    });
    const ms = performance.now() - t0;
    clearInterval(timer);
    gap = Math.max(gap, performance.now() - last);
    out.push({ ms, moduleMs: tModule, maxGapMs: gap, ticks, lines: code.split('\n').length });
  }
  return { out, failures: [...h.failures] };
});

// GPU ms of the scene pass (timestamps) for a view at a detail, over `frames`
// frames (median), from a camera: [eye, at] in grid cells (null: home).
test('gpuTime', async ({ view = 'realistic', detail = {}, scene = 'test', cam = null, frames = 5, size = null } = {}) => {
  if (scene) await load(scene);
  if (size) { canvas.width = size[0]; canvas.height = size[1]; }
  if (cam) lookFrom(toScene(...cam[0]), toScene(...cam[1])); else home();
  await volume.viewReady(view, detail);
  if (!gpu.timing.supported) return { error: 'no timestamp-query on this device' };
  gpu.timing.enabled = true;
  const ms = [];
  for (let k = 0; k < frames + 1; k++) {
    post.render(hooks({ view, detail }), camera);
    gpu.endFrame();
    await fence();
    await new Promise((r) => setTimeout(r, 0));
    if (k > 0 && gpu.timing.last?.scene !== undefined) ms.push(gpu.timing.last.scene);
  }
  gpu.timing.enabled = false;
  ms.sort((a, b) => a - b);
  return { median: ms[Math.floor(ms.length / 2)] ?? null, samples: ms, failures: [...h.failures] };
});

ready();
log('ready');
