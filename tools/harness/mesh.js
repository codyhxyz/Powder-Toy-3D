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
import { meshLight, litColor, updateMeshLight, setMeshGpu, prepareMesh } from '/src/gfx/meshLight.js';
import { boot, ready, test, log } from './harness.js';

const h = await boot({ label: 'mesh' });
const gpu = h.gpu;
// three's synchronous pipeline builds (a mesh drawn before it was compiled): our code never builds one (W18)
let syncPipelines = 0;
const createRenderPipeline = gpu.device.createRenderPipeline.bind(gpu.device);
gpu.device.createRenderPipeline = (desc) => { syncPipelines++; return createRenderPipeline(desc); };

const canvas = document.getElementById('view');
const W = canvas.width, H = canvas.height;
const presenter = createPresenter(gpu, canvas);
const three = await createThreeRenderer(gpu, canvas);
three.setPixelRatio(1);
three.setSize(W, H, false);
const post = createPost(gpu, { presenter, pixScale: gfxUniforms.uPixScale, readable: true });
const N = Number(new URLSearchParams(location.search).get('size') ?? 32);
const sim = new Simulation(gpu, N, N, N, { debug: false });
const derived = new Derived(sim);
const vol = createVolume(gpu, sim);
const cut = createMeshCut(gpu);
await Promise.all([post.ready, sim.ready, derived.ready, vol.ready, vol.noiseReady]);
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
Object.assign(h, { sim, derived, vol, post, three, scene, camera, meshLight, app });

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

ready();
