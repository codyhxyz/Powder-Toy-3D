// The mesh layer's harness page (docs/webgpu.md F8, J1 U13): a Simulation,
// its derived passes (with the GI), the volume and post on this page's
// device, and three.js's meshes over them as the app draws them (Sync log S1:
// the opaque meshes first, the volume marching to their depth, then the
// transparent ones), no app. tools/mesh-check.mjs drives it through
// window.__harness.
//
// ?size=N (default 32): the grid, N³.

import { createPresenter } from '/src/gpu/index.js';
import { useWebGPUCamera, createThreeRenderer, threeHasVisible } from '/src/gpu/three.js';
import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { Simulation, cellTexel } from '/src/sim.js';
import { Derived } from '/src/derived.js';
import { E, ELEMENTS } from '/src/elements.js';
import { SEED_MAX } from '/src/shaders/common.js';
import { createPost, POST_DEFAULTS } from '/src/gfx/post.js';
import { createVolume } from '/src/gfx/volume.js';
import { createMeshCut } from '/src/gfx/meshCut.js';
import { writeFrameUniforms, updateGfxUniforms, gfxUniforms } from '/src/gfx/uniforms.js';
import { VIEWS } from '/src/views.js';
import { meshLight, litColor, updateMeshLight, setMeshGpu, prepareMesh, guardMeshes, PENDING_MASK } from '/src/gfx/meshLight.js';
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
await Promise.all([post.ready, sim.ready, derived.ready, vol.ready, vol.noiseReady, vol.viewReady('plain')]);
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
async function frame({ view = 'plain', gi = false, viewmodel = null, glow = null, volumeOn = true } = {}) {
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
// pixels differing by more than 8 levels in some channel between two captures
function changed(a, b) {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
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
    changedByHands: changed(cap, plain),
  };
  // the gun in the lower right (camera space → screen), and the flame
  const gunAt = project(hand.getWorldPosition(new THREE.Vector3()));
  const flameAt = project(flame.obj.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.3 * SCALE, 0)));
  out.gun = [patch(cap, gunAt, 1), patch(plain, gunAt, 1)];
  out.flame = [patch(cap, flameAt, 1), patch(plain, flameAt, 1)];
  // without the glow layer: the flame's pixel falls back
  const noGlow = await frame({ viewmodel: r.viewmodel, glow: null });
  out.flameNoGlow = patch(noGlow, flameAt, 1);
  out.shots = { plain: await png(plain), hands: await png(cap), noGlow: await png(noGlow) };
  camera.remove(vm);
  scene.remove(camera);
  rig.dispose();
  return { ...out, failures: h.failures };
});

// The particles: the effects' billboard pools (a gun's impact on stone: dust,
// chips; sparks off metal; a tracer; a muzzle flash) and the birds' motes.
test('particles', async () => {
  await load(ROOFED);
  lookFrom(new THREE.Vector3(9, 4, 11), new THREE.Vector3(0, 1.5, 0));
  const vfx = createVfx({ scene, camera, getVolume: () => volume, getScale: () => SCALE, isActive: () => true });
  const birds = createBirdView({ scene, sun: SUN, getScale: () => SCALE });
  const before = syncPipelines;
  await until(() => vfx.batch.parent === scene && birds.batch.parent === scene, 20000, 'the pools compiled');
  const plain = await frame({});
  const V = (x, y, z) => new THREE.Vector3(x, y, z), up = V(0, 1, 0);
  povEvents.emit('impact', { point: V(16, 1, 16), id: E.STONE, source: 'gun', normal: up, broke: true });
  povEvents.emit('impact', { point: V(20, 1, 12), id: E.METAL, source: 'gun', normal: up, broke: false });
  povEvents.emit('round:move', { kind: 'round', from: V(4, 6, 4), to: V(24, 2, 20) });
  povEvents.emit('gun:fire', { origin: V(10, 6, 10), dir: V(1, 0, 0) });
  birds.feathers([16, 10, 16], (p, o) => o.copy(toScene(p[0], p[1], p[2])));
  vfx.update(1 / 60);
  birds.update(1 / 60, [], (p, o) => o.copy(toScene(p.x, p.y, p.z)), { glow: 1, camera, span: 3 });
  const counts = vfx.counts();
  const cap = await frame({});
  const r = { counts, motes: birds.motes, syncAtFirstDraw: syncPipelines - before, syncLabels: syncLabels.slice(before), changed: changed(cap, plain) };
  // a second later they have moved and faded; after their lives, gone
  for (let i = 0; i < 6; i++) { vfx.update(0.5); birds.update(0.5, [], (p, o) => o, { glow: 1, camera, span: 3 }); }
  const late = await frame({});
  r.changedAfter3s = changed(late, plain);
  r.countsAfter3s = Object.values(vfx.counts()).reduce((a, b) => a + b, 0);
  r.shots = { plain: await png(plain), burst: await png(cap), late: await png(late) };
  vfx.dispose();
  birds.dispose();
  return { ...r, failures: h.failures };
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
