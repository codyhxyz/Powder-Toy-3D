// The mesh layer's harness page (docs/webgpu.md F8, J1 U13): a Simulation,
// its derived passes (with the GI), the volume and post on this page's
// device, and three.js's meshes over them as the app draws them (Sync log S1:
// the opaque meshes first, the volume marching to their depth, then the
// transparent ones), no app. tools/mesh-check.mjs drives it through
// window.__harness.
//
// ?size=N (default 32): the grid, N³.

import { createPresenter } from '/src/gpu/index.js';
import { useWebGPUCamera, createThreeRenderer, threeHasVisible, gpuTextureOf } from '/src/gpu/three.js';
import * as THREE from 'three/webgpu';
import { vec3, vec4, attribute, select, positionGeometry } from 'three/tsl';
import { Simulation, cellTexel } from '/src/sim.js';
import { Derived } from '/src/derived.js';
import { E, ELEMENTS } from '/src/elements.js';
import { SEED_MAX } from '/src/shaders/common.js';
import { createPost, POST_DEFAULTS } from '/src/gfx/post.js';
import { createVolume } from '/src/gfx/volume.js';
import { createMeshCut } from '/src/gfx/meshCut.js';
import { writeFrameUniforms, updateGfxUniforms, gfxUniforms, frameUniformsOf } from '/src/gfx/uniforms.js';
import { VIEWS } from '/src/views.js';
import { meshLight, litColor, meshLightTerms, updateMeshLight, setMeshGpu, prepareMesh, guardMeshes, PENDING_MASK, GI_LIFT } from '/src/gfx/meshLight.js';
import { lib } from '/src/shaders/gfx/lib.js';
import { Header } from '/src/gpu/params.js';
import { createFigure } from '/src/pov/figure.js';
import { createCrasher } from '/src/pov/figureCrasher.js';
import { createBody } from '/src/pov/figureReal.js';
import { createLook } from '/src/pov/vehicles/look.js';
import { attachModel } from '/src/pov/models.js';
import { createFlame } from '/src/pov/flame.js';
import { viewmodelRig, renderViewmodels, VIEWMODEL_GLOW_LAYER } from '/src/pov/viewmodel.js';
import { createVfx } from '/src/pov/vfx.js';
import { povEvents } from '/src/pov/events.js';
import { createBirdView } from '/src/birds/render.js';
import { createBillboards } from '/src/gfx/billboards.js';
import { Constructions } from '/src/constructions.js';
import { bake, runGenerator } from '/src/constructions/runtime.js';
import { BUILTINS } from '/src/constructions/builtins.js';
import { boot, ready, test, log } from './harness.js';

const h = await boot({ label: 'mesh' });
const gpu = h.gpu;
// three's synchronous pipeline builds (a mesh drawn before it was compiled): our code never builds one (W18)
let syncPipelines = 0;
const syncLabels = [];
const createRenderPipeline = gpu.device.createRenderPipeline.bind(gpu.device);
gpu.device.createRenderPipeline = (desc) => {
  syncPipelines++;
  syncLabels.push(desc.label || desc.vertex?.module?.label || '?');
  if (DEBUG_SYNC) syncDiffs.push(diffProgram(lastPrograms.slice(-2)));
  return createRenderPipeline(desc);
};
// ?debugSync=1: each program three makes, and for a synchronous pipeline the first line
// where its programs differ from the nearest one made before (why three rebuilt it)
const DEBUG_SYNC = new URLSearchParams(location.search).has('debugSync');
const programs = [], lastPrograms = [], syncDiffs = [];
function diffProgram(made) {
  return made.map((code) => {
    const rl = code.split('\n');
    let best = null;
    for (const c of programs) {
      if (c === code) continue;
      const cl = c.split('\n');
      let i = 0;
      while (i < rl.length && rl[i] === cl[i]) i++;
      if (!best || i > best.i) best = { i, now: rl.slice(i, i + 2).join(' | '), before: cl.slice(i, i + 2).join(' | ') };
    }
    return best;
  });
}

const canvas = document.getElementById('view');
const W = canvas.width, H = canvas.height;
const presenter = createPresenter(gpu, canvas);
const three = await createThreeRenderer(gpu, canvas);
if (DEBUG_SYNC) {
  const cp = three.backend.createProgram.bind(three.backend);
  three.backend.createProgram = (st) => { programs.push(st.code); lastPrograms.push(st.code); return cp(st); };
}
three.setPixelRatio(1);
three.setSize(W, H, false);
const post = createPost(gpu, { presenter, pixScale: gfxUniforms.uPixScale, readable: true });
const N = Number(new URLSearchParams(location.search).get('size') ?? 32);
const sim = new Simulation(gpu, N, N, N, { debug: false });
const derived = new Derived(sim);
const vol = createVolume(gpu, sim);
const cut = createMeshCut(gpu);
await Promise.all([post.ready, sim.ready, derived.ready, vol.ready, vol.noiseReady, vol.viewReady('heat')]);
const g = sim.g;

// the box in the scene as app.js places it: SCALE scene units across, centred over the origin
const SCALE = 10 / Math.max(g.nx, g.nz);
const volume = new THREE.Object3D();
volume.scale.setScalar(SCALE);
volume.position.set(-g.nx / 2 * SCALE, 0, -g.nz / 2 * SCALE);
volume.updateMatrixWorld();
const toScene = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(volume.matrixWorld);
const SUN = new THREE.Vector3(0.45, 0.8, 0.3).normalize();
const KEY = [1, 1, 1];
const camera = useWebGPUCamera(new THREE.PerspectiveCamera(40, W / H, 0.05, 200));
const scene = new THREE.Scene();
scene.add(volume);
function lookFrom(eye, at) {
  camera.position.copy(eye);
  camera.up.set(0, 1, 0);
  camera.lookAt(at);
  camera.updateMatrixWorld();
}
lookFrom(new THREE.Vector3(9, 7, 11), new THREE.Vector3(0, 1.5, 0));
gpu.three.defaults = { camera, scene, get target() { if (!post.sceneTarget.rt) post.setSize(W, H, 1); return post.sceneTarget.rt; } };
setMeshGpu(gpu);
const setPost = (s = {}) => Object.assign(post.settings, POST_DEFAULTS, { taa: false, bloom: 0, adapt: false, meter: false }, s);
setPost();
const fence = async () => { await gpu.fence(); await gpu.readback.idle(); };
let viewTime = 0;
const app = { gpu, sim, derived, vol, volume, sun: SUN, viewTimeUniform: { get value() { return viewTime; } } };
Object.assign(h, { sim, derived, vol, post, three, scene, camera, meshLight, app, syncDiffs });

// Math.random from a seed (mulberry32), so the cells' seeds repeat
function seed(s) {
  Math.random = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// a scene of cells: set(x, y, z, id) for each
async function load(fill) {
  seed(12345);
  const [A, B] = sim.blankState();
  const set = (x, y, z, id) => {
    if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return;
    const i = cellTexel(g, x, y, z) * 4, e = ELEMENTS[id];
    A[i] = id; A[i + 1] = e.temp; A[i + 2] = e.life; A[i + 3] = Math.random() * SEED_MAX;
  };
  fill(set);
  sim.load(A, B);
  updateGfxUniforms(sim, SUN, KEY);
  for (let k = 0; k < 16; k++) sim.updateBricks();
  await fence();
}

const viewId = (key) => VIEWS.find((v) => v.key === key).id;
const isTransparent = (o) => (Array.isArray(o.material) ? o.material.some((m) => m.transparent) : !!o.material?.transparent);
// three.js's meshes of one kind into the scene target, as app.js's threeMeshes draws them
function threeMeshes(p, transparent) {
  if (!threeHasVisible(scene, camera)) return false;
  const others = [];
  let any = false;
  scene.traverseVisible((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
    if (isTransparent(o) === transparent) any = true;
    else others.push(o);
  });
  if (!any) return false;
  for (const o of others) o.visible = false;
  try {
    three.setRenderTarget(p.sceneTarget.rt);
    if (!transparent) { three.setClearColor(0x000000, 0); three.autoClear = true; }
    three.render(scene, camera);
  } finally {
    three.autoClear = false;
    three.setRenderTarget(null);
    for (const o of others) o.visible = true;
  }
  return true;
}
// One presented frame, as app.js draws it; resolves to the canvas as presented.
async function frame({ view = 'heat', gi = false, viewmodel = null, glow = null, volumeOn = true } = {}) {
  updateGfxUniforms(sim, SUN, KEY);
  updateMeshLight(app);
  post.render({
    prepare(p) {
      writeFrameUniforms(gpu, {
        camera, model: volume.matrixWorld, sun: SUN, view: viewId(view), shadowRes: vol.shadowRes, time: viewTime, lightGain: 1.6,
        shadows: true, far: false, jitter: p.jitter,
      });
    },
    compute() {
      sim.updateBricks();
      vol.recordShadow();
      if (gi) sim.updateGI(SUN, vol.shadowTextures, vol.shadowRes);
    },
    opaque: (p) => (threeMeshes(p, false) ? cut.capture(p.sceneTarget.depth) : false),
    draw(rp) { if (volumeOn) vol.draw(rp, { view, detail: {}, meshDepth: cut.take() }); },
    meshes: (p) => { threeMeshes(p, true); },
  }, camera, null, 1 / 60, { viewmodel, glow });
  const shot = post.capture();
  gpu.endFrame();
  const cap = await shot;
  await fence();
  return cap;
}
h.frame = frame;
// the pixel a scene point projects to (y down)
function project(p) {
  const v = p.clone().project(camera);
  return [Math.min(W - 1, Math.max(0, Math.floor((v.x * 0.5 + 0.5) * W))), Math.min(H - 1, Math.max(0, Math.floor((0.5 - v.y * 0.5) * H)))];
}
// a capture as a PNG (base64), for mesh-check's shots
async function png({ width, height, data }) {
  const c = new OffscreenCanvas(width, height);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height), 0, 0);
  const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const px = (cap, [x, y]) => Array.from(cap.data.subarray(4 * (y * cap.width + x), 4 * (y * cap.width + x) + 4));
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---------------------------------------------------------------- tests

// The lit material on a box: compiles through prepareMesh (no synchronous
// pipeline at its first draw) and draws.
test('spike', async () => {
  await load((set) => { for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) set(x, 0, z, E.STONE); });
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = litColor({ albedo: vec3(0.7, 0.7, 0.7) });
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  box.position.copy(toScene(g.nx / 2, 4, g.nz / 2));
  const t0 = performance.now();
  await prepareMesh(box);
  const prepMs = performance.now() - t0;
  scene.add(box);
  const before = syncPipelines;
  const cap = await frame({});
  const p = px(cap, project(box.position));
  scene.remove(box);
  return { prepMs: Math.round(prepMs), syncAtFirstDraw: syncPipelines - before, pixel: p, failures: h.failures };
});

// ---------------------------------------------------------------- the mesh kinds

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 20000, what = 'a condition') {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(50);
  }
}
const worldToGrid = () => new THREE.Matrix4().copy(volume.matrixWorld).invert();
// a figure's state standing still at grid cell (x, y, z) (figure.js update's s)
const standing = (x, y, z) => ({
  feet: toScene(x, y, z), scale: SCALE, yaw: 0, worldToGrid: worldToGrid(), speedH: 0, velY: 0,
  onGround: true, inLiquid: false, dead: false, heat: 0, crouch: 0, look: { pitch: 0, spine: 0 },
});
// the mean luminance of a w×h block around pixel c
function patch(cap, [x, y], r = 2) {
  let sum = 0, n = 0;
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
    const px2 = Math.min(W - 1, Math.max(0, x + i)), py2 = Math.min(H - 1, Math.max(0, y + j));
    sum += lum(px(cap, [px2, py2]));
    n++;
  }
  return sum / n;
}
// the most a pixel within r of c got brighter (luminance) from capture b to capture a
function lift(a, b, [x, y], r = 2) {
  let best = -Infinity;
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
    const q = [Math.min(W - 1, Math.max(0, x + i)), Math.min(H - 1, Math.max(0, y + j))];
    best = Math.max(best, lum(px(a, q)) - lum(px(b, q)));
  }
  return best;
}
// pixels differing by more than 8 levels in some channel between two captures
// (only where keep(byte index) holds, when given)
function changed(a, b, keep = null) {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (keep && !keep(i)) continue;
    if (Math.abs(a.data[i] - b.data[i]) > 8 || Math.abs(a.data[i + 1] - b.data[i + 1]) > 8 || Math.abs(a.data[i + 2] - b.data[i + 2]) > 8) n++;
  }
  return n;
}
// a stone floor, and a stone roof over x 2..22 at y 20: its shadow falls on (6, 1, 16), not on (27, 1, 16)
const ROOFED = (set) => {
  for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) set(x, 0, z, E.STONE);
  for (let x = 2; x <= 22; x++) for (let z = 2; z < g.nz - 2; z++) set(x, 20, z, E.STONE);
};
const FLOOR = (set) => { for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) set(x, 0, z, E.STONE); };
const SIDE = () => lookFrom(new THREE.Vector3(0, 1.4, 13), new THREE.Vector3(0, 1.0, 0));
// frames until the shadow map and the light are up (the shadow kernel builds on first use)
async function settle(n = 3, opts = {}) { let cap; for (let i = 0; i < n; i++) cap = await frame(opts); return cap; }

// The figures, lit as the volume is: one stickman under the roof's shadow and
// one in the sun (the sun term from our shadow map), a crasher, a vehicle's
// parts; each compiled through prepare, none built at its first draw.
test('figures', async () => {
  await load(ROOFED);
  SIDE();
  await vol.shadowReady();
  const out = { syncAtFirstDraw: 0 };
  const shade = createFigure(), sun = createFigure(), crasher = createCrasher();
  const look = createLook();
  const figs = [[shade, standing(6, 1, 16)], [sun, standing(27, 1, 16)], [crasher, standing(16, 1, 22)]];
  for (const [f, st] of figs) { f.update(1 / 60, st); f.setVisible?.(true); f.root.visible = true; }
  await Promise.all(figs.map(([f]) => f.compile()));
  const before = syncPipelines;
  for (const [f] of figs) scene.add(f.root);
  const cap = await settle(3);
  out.syncAtFirstDraw = syncPipelines - before;
  // the torsos: a third of the way up the body
  const torso = (st) => project(st.feet.clone().add(new THREE.Vector3(0, 4.5 * SCALE, 0)));
  out.shade = patch(cap, torso(figs[0][1]));
  out.sun = patch(cap, torso(figs[1][1]));
  out.crasher = patch(cap, torso(figs[2][1]));
  out.shadowState = vol.shadowState;
  out.shots = { lit: await png(cap) };
  out.ratio = +(out.shade / Math.max(out.sun, 1)).toFixed(3);
  // the GI probes gathering a while (the sky and the floor's bounce under the roof): the shaded one lifts
  let lit;
  for (let i = 0; i < 8; i++) lit = await frame({ gi: true });
  out.shadeGI = patch(lit, torso(figs[0][1]));
  out.shots.gi = await png(lit);
  out.sunGI = patch(lit, torso(figs[1][1]));
  // the roof gone: the shaded figure's spot is in the sun
  await load(FLOOR);
  const open = await settle(2);
  out.shadeOpen = patch(open, torso(figs[0][1]));
  for (const [f] of figs) scene.remove(f.root);
  out.look = !!look;
  return { ...out, failures: h.failures };
});

// The realistic body (GLTF, skinned): loaded, compiled, drawn lit.
test('gltf', async () => {
  await load(ROOFED);
  SIDE();
  const body = createBody({ choice: () => 'real' });
  body.setVisible(true);
  const st = standing(27, 1, 16);
  body.bind(volume, g);
  body.update(1 / 60, st);
  const t0 = performance.now();
  await until(() => body.loaded, 30000, 'the body model');
  const loadMs = Math.round(performance.now() - t0);
  body.update(1 / 60, st);
  await body.compile();
  const empty = await frame({});
  const before = syncPipelines;
  scene.add(body.root);
  const cap = await settle(2);
  const at = project(st.feet.clone().add(new THREE.Vector3(0, 4.5 * SCALE, 0)));
  const r = {
    loadMs, showing: body.showing, syncAtFirstDraw: syncPipelines - before, torso: patch(cap, at), behind: patch(empty, at), changed: changed(cap, empty),
    shots: { body: await png(cap) }, failures: h.failures,
  };
  scene.remove(body.root);
  body.dispose();
  return r;
});

// The held tool: its own MSAA pass (VIEWMODEL_LAYER, guarded until compiled),
// resolved and composited by post; the torch's flame on the glow layer, added.
test('viewmodel', async () => {
  await load(ROOFED);
  lookFrom(new THREE.Vector3(9, 4, 11), new THREE.Vector3(0, 1.5, 0));
  globalThis.__app = { sim, derived, vol, volume, SUN, gpu, requestRender() {} };
  scene.add(camera);
  const vm = new THREE.Group();
  vm.name = 'pov-viewmodel';
  camera.add(vm);
  const env = { viewmodel: vm, getScale: () => SCALE };
  const rig = viewmodelRig(env);
  const hand = rig.hand([0.7, -0.8, -2.2]);
  attachModel(hand, 'gun');
  hand.visible = true;
  const flame = createFlame({ width: 0.15, height: 0.5, mode: 'overlay' });
  flame.obj.position.set(-0.5, -0.4, -2);
  for (const m of flame.meshes) m.userData.vmLayer = VIEWMODEL_GLOW_LAYER;
  rig.root.add(flame.obj);
  rig.update({ dt: 1 / 60, dir: new THREE.Vector3(0, 0, -1), player: {} });
  await settle(3);   // (the floor settles: plain differs from the hands' frames only by them)
  const plain = await frame({});
  const before = syncPipelines;
  // the first pass parks every mesh three hasn't compiled for these targets; then they draw
  let r = renderViewmodels(three, scene, camera, post);
  const parked = [];
  vm.traverse((o) => { if (o.layers.mask === PENDING_MASK) parked.push(o.name || o.type); });
  await until(() => { let n = 0; vm.traverse((o) => { if (o.layers.mask === PENDING_MASK) n++; }); return n === 0; }, 20000, 'the hands compiled');
  await frame({});   // (the pass draws once a frame: the next one)
  r = renderViewmodels(three, scene, camera, post);
  const cap = await frame({ viewmodel: r.viewmodel, glow: r.glow });
  const out = {
    parkedAtFirst: parked.length, syncAtFirstDraw: syncPipelines - before, syncLabels: syncLabels.slice(before), hasGlow: !!r.glow,
  };
  // the flame (on the glow layer only)
  const flameAt = project(flame.obj.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.3 * SCALE, 0)));
  out.flame = [patch(cap, flameAt, 1), patch(plain, flameAt, 1)];
  // without the glow layer: the flame's pixel falls back, and what still
  // differs from the plain frame is the viewmodel target's composite alone:
  // counted inside the gun's box on screen (its bounds' corners projected) and outside it
  const noGlow = await frame({ viewmodel: r.viewmodel, glow: null });
  out.flameNoGlow = patch(noGlow, flameAt, 1);
  const box = new THREE.Box3().setFromObject(hand);
  const xs = [], ys = [];
  for (let k = 0; k < 8; k++) {
    const [x, y] = project(new THREE.Vector3(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z));
    xs.push(x); ys.push(y);
  }
  out.gunBox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const inGun = (i) => { const x = (i / 4) % W, y = Math.floor(i / 4 / W); return x >= out.gunBox[0] && x <= out.gunBox[2] && y >= out.gunBox[1] && y <= out.gunBox[3]; };
  out.handsInBox = changed(noGlow, plain, inGun);
  out.handsOutside = changed(noGlow, plain, (i) => !inGun(i));
  out.changedWithGlow = changed(cap, plain);
  out.shots = { plain: await png(plain), hands: await png(cap), noGlow: await png(noGlow) };
  camera.remove(vm);
  scene.remove(camera);
  rig.dispose();
  return { ...out, failures: h.failures };
});

// The particles: splash mist, sparks off metal, a tracer, a muzzle flash,
// and the birds' motes.
test('particles', async () => {
  await load(ROOFED);
  lookFrom(new THREE.Vector3(9, 4, 11), new THREE.Vector3(0, 1.5, 0));
  const vfx = createVfx({ scene, camera, getVolume: () => volume, getScale: () => SCALE, isActive: () => true });
  const birds = createBirdView({ scene, sun: SUN, getScale: () => SCALE });
  const before = syncPipelines;
  await until(() => vfx.batch.parent === scene && birds.batch.parent === scene, 20000, 'the pools compiled');
  // the frame just before the bursts (their spawn points show the sky, which doesn't change)
  const pre = await frame({});
  const V = (x, y, z) => new THREE.Vector3(x, y, z), up = V(0, 1, 0);
  // grid points (the box's cells, or past them) whose pixels show the sky
  // behind, not the settling floor; the sparks' streaks (0.09 cells wide)
  // near the camera, where they span pixels
  const SPAWN = { flash: [10, 6, 10], sparks: [34, 12, 40], mist: [30, 14, 36], tracer: [14, 4, 12], jet: [24, 9, 30.6], feathers: [16, 10, 16] };
  povEvents.emit('impact', { point: V(...SPAWN.mist), id: E.WATER, source: 'gun', normal: up, broke: true });
  povEvents.emit('impact', { point: V(...SPAWN.sparks), id: E.METAL, source: 'gun', normal: up, broke: false });
  povEvents.emit('round:move', { kind: 'round', from: V(4, 6, 4), to: V(24, 2, 20) });   // (SPAWN.tracer: its middle)
  povEvents.emit('gun:fire', { origin: V(...SPAWN.flash), dir: V(1, 0, 0) });
  const nozzles = [-0.3, 0.3].map((x) => {
    const nozzle = new THREE.Object3D();
    nozzle.position.copy(toScene(SPAWN.jet[0] + x, SPAWN.jet[1], SPAWN.jet[2]));
    nozzle.scale.setScalar(SCALE);
    return nozzle;
  });
  vfx.jet(nozzles, 0.1);
  birds.feathers(SPAWN.feathers, (p, o) => o.copy(toScene(p[0], p[1], p[2])));
  vfx.update(1 / 60);
  birds.update(1 / 60, [], (p, o) => o.copy(toScene(p.x, p.y, p.z)), { glow: 1, camera, span: 3 });
  const counts = vfx.counts();
  const cap = await frame({});
  const r = { counts, motes: birds.motes, syncAtFirstDraw: syncPipelines - before, syncLabels: syncLabels.slice(before), changed: changed(cap, pre) };
  // at each spawn point on screen, the most a pixel near it brightened
  r.lift = {};
  for (const [k, p] of Object.entries(SPAWN)) r.lift[k] = +lift(cap, pre, project(toScene(...p)), 5).toFixed(1);
  // a second later they have moved and faded; after their lives, gone
  for (let i = 0; i < 6; i++) { vfx.update(0.5); birds.update(0.5, [], (p, o) => o, { glow: 1, camera, span: 3 }); }
  const late = await frame({});
  r.changedAfter3s = changed(late, pre);
  r.countsAfter3s = Object.values(vfx.counts()).reduce((a, b) => a + b, 0) + birds.motes;
  r.shots = { pre: await png(pre), burst: await png(cap), late: await png(late) };
  vfx.dispose();
  birds.dispose();
  return { ...r, failures: h.failures };
});

// A pool's records reach the GPU however its updates and draws interleave
// (gfx/billboards.js update: three uploads an attribute's ranges at the next
// draw and only then clears them): two spawning updates with no draw between
// (a tick that doesn't present); a clear followed by a spawn before a draw
// (the cleared records must go up too, or the ones in flight show again); and
// more separate runs than MAX_RANGES before a draw (they merge into one
// range). Each particle's own pixel is read.
test('uploads', async () => {
  await load(FLOOR);
  lookFrom(new THREE.Vector3(9, 7, 11), new THREE.Vector3(0, 1.5, 0));
  // slots 0-2 the first three, 3 one spawned after the clear, 4-51 the run pattern below
  const CAP = 52;
  const pool = createBillboards({ name: 'uploads', capacity: CAP, texture: 'dot', blending: 'additive' });
  await prepareMesh(pool.mesh);
  scene.add(pool.mesh);
  const before = syncPipelines;
  const HIDDEN = [16, 4, 80];   // behind the camera: spawned, never on screen
  const spawn = (at, life = 100) => pool.burst(1, (p) => p.set(toScene(...at), new THREE.Vector3(), 0.5, [20, 20, 20], 1, life, { move: 0 }));
  await settle(2);
  const base = await frame({});
  const P = { p0: [16, 6, 16], p1: [6, 6, 10], p2: [26, 6, 10], q1: [6, 9, 24], q2: [26, 9, 24] };
  const at = Object.fromEntries(Object.entries(P).map(([k, p]) => [k, project(toScene(...p))]));
  const lifts = (cap, keys) => Object.fromEntries(keys.map((k) => [k, +lift(cap, base, at[k]).toFixed(1)]));
  // one drawn: three holds the attribute buffers from here on
  spawn(P.p0); pool.update(1 / 60);
  await frame({});
  // two spawning updates, no draw between
  spawn(P.p1); pool.update(1 / 60);
  spawn(P.p2); pool.update(1 / 60);
  const two = await frame({});
  const r = { syncAtFirstDraw: syncPipelines - before, aliveTwo: pool.count(), twoLift: lifts(two, ['p0', 'p1', 'p2']) };
  // cleared, then a spawn before the next draw (into slot 3): p0-p2 gone
  pool.clear();
  pool.update(1 / 60);
  spawn(HIDDEN); pool.update(1 / 60);
  const cleared = await frame({});
  r.clearedLift = lifts(cleared, ['p0', 'p1', 'p2']);
  // every other slot of 4-51 freed (short lives), then one spawn per update
  // into slots 0-2 and those, no draw between: 20 separate runs
  for (let i = 0; i < 48; i++) spawn(HIDDEN, i & 1 ? 0.05 : 100);
  pool.update(1 / 60);
  await frame({});
  pool.update(0.2);
  spawn(P.q1); pool.update(1 / 60);
  for (let i = 0; i < 20; i++) { spawn(HIDDEN); pool.update(1 / 60); }
  spawn(P.q2); pool.update(1 / 60);
  const runs = pool.mesh.geometry.getAttribute('iA').updateRanges.length;
  const many = await frame({});
  Object.assign(r, { rangesBeforeDraw: runs, aliveMany: pool.count(), manyLift: lifts(many, ['q1', 'q2']) });
  r.shots = { base: await png(base), two: await png(two), cleared: await png(cleared), many: await png(many) };
  scene.remove(pool.mesh);
  pool.dispose();
  return { ...r, failures: h.failures };
});

// ---------------------------------------------------------------- the meshes' light against the volume's

// The light the meshes read (gfx/meshLight.js meshLightTerms: its own copy of
// lighting.js's functions, with FrameUniforms' fields as parameters) against
// lighting.js itself, on the same textures at the same points: a kernel built
// on the render library (shaders/gfx/lib.js) evaluates FU.sunCol ×
// sunShadowAt(p) and giIrradiance(probeAt(q), n) + sampleLight(p) ×
// FU.lightGain; a TSL draw evaluates meshLightTerms there, one pixel per point,
// into a float target. A scene with every term in play: the roof's shadow, a
// pool's tint and caustics, lava's glow, two wand lights, a cave ambient,
// converged GI, then the clouds' shadow.
const LIGHT_POINTS = 192;
// what the reference kernel writes: point k's sun at 3N + k, its ambient at 4N + k (vec4s); p, q, n at k, N + k, 2N + k
const lightRefWGSL = (g, N) => /* wgsl */ `
${lib(g, { variant: 'LIGHTING' })}
@group(3) @binding(2) var<storage, read_write> io: array<vec4f>;
const NPTS: u32 = ${N}u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= NPTS) { return; }
  let p = io[k].xyz;
  let q = io[NPTS + k].xyz;
  let n = io[2u * NPTS + k].xyz;
  var sun = FU.sunCol;
  if (FU.shadows != 0u) { sun = FU.sunCol * sunShadowAt(p); }
  io[3u * NPTS + k] = vec4f(sun, 1.0);
  io[4u * NPTS + k] = vec4f(giIrradiance(probeAt(q), n) + sampleLight(p) * FU.lightGain, 1.0);
}`;
let lightRef = null;
async function lightReference() {
  if (lightRef) return lightRef;
  const dev = gpu.device;
  const l3 = gpu.layout('MESH_LIGHT_REF', [
    { binding: 0, buffer: { type: 'uniform' } }, { binding: 2, buffer: { type: 'storage' } },
  ]);
  const module = dev.createShaderModule({ label: 'mesh light ref', code: lightRefWGSL(g, LIGHT_POINTS) });
  const t0 = performance.now();
  const pipeline = await dev.createComputePipelineAsync({
    label: 'mesh light ref', compute: { module, entryPoint: 'main' },
    layout: dev.createPipelineLayout({ bindGroupLayouts: [gpu.L.FRAME, gpu.L.STATE_RO, gpu.L.LIGHTING, l3] }),
  });
  const io = gpu.createBuffer({ label: 'mesh light ref io', size: 5 * LIGHT_POINTS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const header = gpu.createBuffer({ label: 'mesh light ref header', size: Header.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const group3 = gpu.bindGroup(l3, [{ binding: 0, resource: { buffer: header } }, { binding: 2, resource: { buffer: io } }], 'mesh light ref');
  lightRef = { pipeline, io, header, group3, buildMs: Math.round(performance.now() - t0) };
  return lightRef;
}
// lighting.js's terms at the points: { sun, ambient } (Float32Array, 4 per point)
async function lightingAt(pts) {
  const R = await lightReference(), N = LIGHT_POINTS;
  gpu.queue.writeBuffer(R.io, 0, pts);
  gpu.queue.writeBuffer(R.header, 0, Header.pack(sim.header()));
  const enc = gpu.frame.direct();
  const pass = enc.beginComputePass({ label: 'mesh light ref' });
  pass.setPipeline(R.pipeline);
  [frameUniformsOf(gpu).group, sim.bindRO, vol.lightingGroup, R.group3].forEach((grp, i) => pass.setBindGroup(i, grp));
  pass.dispatchWorkgroups(Math.ceil(N / 64));
  pass.end();
  const out = new Float32Array(await gpu.readback.buffer(R.io, 3 * N * 16, 2 * N * 16));
  return { sun: out.subarray(0, 4 * N), ambient: out.subarray(4 * N) };
}
// meshLightTerms at the points, drawn: row 0 of an N×2 float target the sun, row 1 the ambient
let lightDraw = null;
function lightDrawOf() {
  if (lightDraw) return lightDraw;
  const N = LIGHT_POINTS;
  const geo = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['aP', 3], ['aQ', 3], ['aN', 3], ['aW', 1]]) {
    geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(12 * N * size), size));
  }
  // a quad over pixel (k, row) of the target: x right, row 0 at the top (y down, F4)
  const pos = geo.getAttribute('position'), w = geo.getAttribute('aW');
  const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
  for (let row = 0; row < 2; row++) for (let k = 0; k < N; k++) {
    CORNERS.forEach(([cx, cy], c) => {
      const v = 6 * (row * N + k) + c;
      pos.setXYZ(v, (k + cx) / N * 2 - 1, 1 - row - cy, 0);
      w.setX(v, row);
    });
  }
  const mat = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  mat.lights = false;
  mat.blending = THREE.NoBlending;
  const { sun, ambient } = meshLightTerms({ p: attribute('aP', 'vec3'), q: attribute('aQ', 'vec3'), n: attribute('aN', 'vec3') });
  mat.vertexNode = vec4(positionGeometry.xy, 0, 1);
  mat.fragmentNode = vec4(select(attribute('aW', 'float').greaterThan(0.5), ambient, sun), 1);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const sc = new THREE.Scene();
  sc.add(mesh);
  // (with a depth buffer: three's compileAsync keys a target's pipelines as if it had
  // one, renderer.depth, where a draw keys them on rt.depthBuffer; without, the
  // first draw built its pipeline again)
  const rt = new THREE.RenderTarget(N, 2, { type: THREE.FloatType });
  lightDraw = { geo, sc, rt, cam: useWebGPUCamera(new THREE.OrthographicCamera()), prepared: null };
  return lightDraw;
}
async function meshLightAt(pts) {
  const D = lightDrawOf(), N = LIGHT_POINTS;
  // each point's p, q and n on all six corners of both its quads
  for (const [name, at] of [['aP', 0], ['aQ', N], ['aN', 2 * N]]) {
    const a = D.geo.getAttribute(name);
    for (let row = 0; row < 2; row++) for (let k = 0; k < N; k++) for (let c = 0; c < 6; c++) {
      a.setXYZ(6 * (row * N + k) + c, pts[4 * (at + k)], pts[4 * (at + k) + 1], pts[4 * (at + k) + 2]);
    }
    a.needsUpdate = true;
  }
  if (!D.prepared) {
    const t0 = performance.now();
    await prepareMesh(D.sc, { camera: D.cam, scene: D.sc, target: D.rt });
    D.prepared = { ms: Math.round(performance.now() - t0), sync: syncPipelines };
  }
  three.setRenderTarget(D.rt);
  try { three.render(D.sc, D.cam); } finally { three.setRenderTarget(null); }
  const px4 = await gpu.readback.texture(gpuTextureOf(three, D.rt.texture), { size: [N, 2, 1], format: 'rgba32float' });
  return { sun: px4.subarray(0, 4 * N), ambient: px4.subarray(4 * N) };
}
// the largest error of a against the reference b (rgb), relative to the reference (absolute below 0.01)
function lightErr(a, b) {
  let worst = 0, at = -1;
  for (let i = 0; i < a.length; i++) {
    if ((i & 3) === 3) continue;
    const e = Math.abs(a[i] - b[i]) / Math.max(Math.abs(b[i]), 0.01);
    if (!(e <= worst)) { worst = e; at = i >> 2; }   // (a NaN counts as the worst)
  }
  return { err: worst, at };
}

test('light', async () => {
  const LIT = (set) => {
    ROOFED(set);
    // a pool in the sun, three cells deep (tint and caustics under it) ...
    for (let x = 24; x < 30; x++) for (let z = 4; z < 12; z++) for (let y = 1; y <= 3; y++) set(x, y, z, E.WATER);
    // ... and lava under the roof (the glow volume)
    for (let x = 4; x < 8; x++) for (let z = 22; z < 27; z++) set(x, 1, z, E.LAVA);
  };
  await load(LIT);
  SIDE();
  await vol.shadowReady();
  const u = gfxUniforms;
  const was = { wands: u.uWandLightCount.value, cave: u.uCaveAmbient.value, clouds: u.uClouds.value, caustics: u.uCaustics.value, sea: u.uCloudSea.value, time: viewTime };
  // two wand lights, a cave's ambient floor, the ripples' clock
  u.uWandLightCount.value = 2;
  u.uWandLightPosition.value[0].set(12, 4, 8, 7);
  u.uWandLightColor.value[0].set(0.3, 0.6, 1.0, 2.5);
  u.uWandLightPosition.value[1].set(20, 12, 24, 9);
  u.uWandLightColor.value[1].set(1.0, 0.4, 0.8, 1.5);
  u.uCaveAmbient.value = [0.02, 0.03, 0.05];
  u.uCaustics.value = true;
  u.uClouds.value = false;
  viewTime = 2.75;
  const out = { points: LIGHT_POINTS };
  const syncBefore = syncPipelines;
  try {
    // the GI converging, the light volume and the shadow map up
    for (let i = 0; i < 10; i++) await frame({ gi: true });
    // the points: a third anywhere, a third in and under the pool, a third by the lava and the lights
    let s = 0x2545f491;
    const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0; return ((s ^ (s >>> 13)) >>> 0) / 4294967296; };
    const N = LIGHT_POINTS, pts = new Float32Array(3 * N * 4);
    const box = (k) => (k % 3 === 0 ? [[0.5, g.nx - 0.5], [0.5, g.ny - 0.5], [0.5, g.nz - 0.5]]
      : k % 3 === 1 ? [[23, 31], [0.5, 4.5], [3, 13]] : [[3, 13], [1, 8], [6, 28]]);
    for (let k = 0; k < N; k++) {
      const b = box(k), p = b.map(([lo, hi]) => lo + (hi - lo) * rnd());
      const n = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
      pts.set([...p, 1], 4 * k);
      pts.set([p[0] + n.x * GI_LIFT, p[1] + n.y * GI_LIFT, p[2] + n.z * GI_LIFT, 1], 4 * (N + k));
      pts.set([n.x, n.y, n.z, 0], 4 * (2 * N + k));
    }
    const compare = async (label) => {
      const before = syncPipelines;
      const ref = await lightingAt(pts), mine = await meshLightAt(pts);
      const sun = lightErr(mine.sun, ref.sun), amb = lightErr(mine.ambient, ref.ambient);
      // which terms the points reached: full sun, none, part (the map's edge, the clouds'), tinted (liquid), glow above the GI
      const full = [...u.uSunCol.value];
      let lit = 0, dark = 0, part = 0, tinted = 0, glow = 0;
      for (let k = 0; k < N; k++) {
        const r = ref.sun.subarray(4 * k, 4 * k + 3);
        const share = r.map((x, c) => x / Math.max(full[c], 1e-6));
        if (share.every((x) => x > 0.999)) lit++; else if (share.every((x) => x < 1e-4)) dark++; else part++;
        if (Math.max(...share) - Math.min(...share) > 0.02) tinted++;
        if (ref.ambient[4 * k] + ref.ambient[4 * k + 1] + ref.ambient[4 * k + 2] > 0.5) glow++;
      }
      out[label] = {
        sunErr: +sun.err.toExponential(2), sunErrAt: sun.at, ambientErr: +amb.err.toExponential(2), ambientErrAt: amb.at,
        lit, dark, part, tinted, glow, syncAtFirstDraw: syncPipelines - before,
        sample: { p: Array.from(pts.subarray(0, 3)), ref: [Array.from(ref.sun.subarray(0, 3)), Array.from(ref.ambient.subarray(0, 3))],
          mesh: [Array.from(mine.sun.subarray(0, 3)), Array.from(mine.ambient.subarray(0, 3))] },
      };
      return ref;
    };
    const open = await compare('open');
    out.refBuildMs = lightRef.buildMs;
    out.prepareMs = lightDraw.prepared.ms;
    // the clouds' shadow: the box is small against the clouds (their shapes
    // tile every 20,000 cells), so its points are under one or none; the deck
    // is raised until one shades them, each step moving where the sun's ray
    // meets it by about an eighth of a tile (from 28,000 cells, where one
    // shades this scene's points: the search is for a change to the clouds)
    u.uClouds.value = true;
    for (const sea of [28000, ...Array.from({ length: 15 }, (_, i) => 4000 * i)]) {
      u.uCloudSea.value = sea;
      await frame({});
      const ref = await compare('clouds');
      let clouded = 0;
      for (let k = 0; k < N; k++) if (open.sun[4 * k] > 1e-3 && ref.sun[4 * k] < 0.98 * open.sun[4 * k]) clouded++;
      Object.assign(out.clouds, { cloudSea: sea, clouded });
      if (clouded) break;
    }
    // the negative control: the mesh side reading the GI half a brick off; the comparison must see it
    u.uClouds.value = false;
    await frame({});
    for (let k = 0; k < N; k++) pts[4 * (N + k)] += 2;
    const ref = await lightingAt(pts);
    for (let k = 0; k < N; k++) pts[4 * (N + k)] -= 2;
    const mine = await meshLightAt(pts);
    out.controlAmbientErr = +lightErr(mine.ambient, ref.ambient).err.toExponential(2);
    out.syncAtFirstDraw = syncPipelines - syncBefore;
    out.syncLabels = syncLabels.slice(syncBefore);
  } finally {
    u.uWandLightCount.value = was.wands;
    u.uCaveAmbient.value = was.cave;
    u.uClouds.value = was.clouds;
    u.uCaustics.value = was.caustics;
    u.uCloudSea.value = was.sea;
    viewTime = was.time;
  }
  return { ...out, failures: h.failures };
});

// The constructions: the ghost (a depth prepass and the translucent cubes,
// compiled before it shows) and the stamp (a two-phase box writer: the house
// built into the grid, its footing grown down to the floor).
test('construction', async () => {
  await load((set) => { for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) set(x, 0, z, E.STONE); });
  lookFrom(new THREE.Vector3(9, 6, 11), new THREE.Vector3(0, 1.5, 0));
  const settings = { tool: -1, radius: 2 };
  const builds = new Constructions({
    scene, camera, settings, getSim: () => sim, getVolume: () => volume, getScale: () => SCALE,
    onClose() {}, requestRender() {},
  });
  const baked = bake(runGenerator(BUILTINS.CAMPFIRE, { size: 2, seed: 7 }), 0);
  const plain = await frame({});
  const before = syncPipelines;
  builds.baked = baked;
  builds._setGhost(baked);
  await until(() => builds.ghostReady === true, 20000, 'the ghost compiled');
  builds._placeGhost({ cell: new THREE.Vector3(16, 0, 16), face: 2 });


  const cap = await frame({});

  const r = {
    cells: baked.ghost.length / 4, box: [baked.w, baked.h, baked.d], shown: builds.group.visible, changedByGhost: changed(cap, plain),
    syncAtFirstDraw: syncPipelines - before, syncLabels: syncLabels.slice(before), shots: { ghost: await png(cap) },
  };
  builds.group.visible = false;
  // the stamp: a house on a raised spot, its base two cells over the floor: the
  // two-phase writer builds it and grows a footing under each base column
  const house = bake(runGenerator(BUILTINS.HOUSE, { size: 1, seed: 7 }), 0);
  const O = [8, 3, 8];
  const v0 = sim.version;
  builds.stampBaked(house, new THREE.Vector3(...O));
  await until(() => sim.version !== v0, 20000, 'the stamp kernel');
  await fence();
  const [A] = await sim.readState();
  const idAt = (x, y, z) => Math.round(A[cellTexel(g, x, y, z) * 4]);
  const cell = (x, y, z) => 4 * (x + house.w * (y + house.h * z));
  let want = 0, placed = 0, footWant = 0, footing = 0;
  for (let z = 0; z < house.d; z++) for (let y = 0; y < house.h; y++) for (let x = 0; x < house.w; x++) {
    const v = house.data[cell(x, y, z)];
    if (v < 0.5) continue;
    want++;
    if (idAt(O[0] + x, O[1] + y, O[2] + z) === Math.round(v) - 1) placed++;
  }
  for (let z = 0; z < house.d; z++) for (let x = 0; x < house.w; x++) {
    const i = cell(x, 0, z);
    if (house.data[i] < 0.5 || house.data[i + 3] < 0.5) continue;
    for (let y = 1; y < O[1]; y++) {
      footWant++;
      if (idAt(O[0] + x, y, O[2] + z) === Math.round(house.data[i]) - 1) footing++;
    }
  }
  Object.assign(r, { stampFoot: house.foot, stampWant: want, stampPlaced: placed, footingWant: footWant, footingCells: footing });
  builds.dispose();
  return { ...r, failures: h.failures };
});

// The guard: a mesh added without prepare waits on PENDING_LAYER, then draws;
// three builds nothing at its first draw.
test('guard', async () => {
  await load((set) => { for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) set(x, 0, z, E.STONE); });
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = vec3(0.9, 0.2, 0.1);
  const box = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 1), mat);
  box.position.copy(toScene(g.nx / 2, 6, g.nz / 2));
  scene.add(box);
  const before = syncPipelines;
  const waiting = guardMeshes(scene, camera, {});
  const parked = box.layers.mask === PENDING_MASK;
  const hidden = await frame({});
  await until(() => box.layers.mask !== PENDING_MASK, 20000, 'the guard');
  const cap = await frame({});
  const r = {
    waiting, parked, syncAtFirstDraw: syncPipelines - before, at: project(box.position), hidden: px(hidden, project(box.position)), shown: px(cap, project(box.position)),
    changed: changed(cap, hidden), mask: box.layers.mask, inScene: !!box.parent,
  };
  // a light comes: three would build the box's program again at its next draw; the guard parks it first
  const light = new THREE.PointLight(0xffffff, 0);
  scene.add(light);
  const beforeLight = syncPipelines;
  guardMeshes(scene, camera, {});
  r.parkedForLight = box.layers.mask === PENDING_MASK;
  await until(() => box.layers.mask !== PENDING_MASK, 20000, 'the guard after a light');
  await frame({});
  r.syncAfterLight = syncPipelines - beforeLight;
  scene.remove(light);
  guardMeshes(scene, camera, {});
  await until(() => box.layers.mask !== PENDING_MASK, 20000, 'the guard after the light went');
  // the negative control: the same light, unguarded: three builds the box's pipeline at the draw
  scene.add(light);
  const unguarded = syncPipelines;
  await frame({});
  r.syncUnguarded = syncPipelines - unguarded;
  scene.remove(light);
  scene.remove(box);
  return { ...r, failures: h.failures };
});

ready();
