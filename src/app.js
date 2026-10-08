import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './ui/styles.css';
import { Simulation } from './sim.js';
import { volumeVert, volumeFrag, pickFrag, shadowFrag } from './shaders/render.js';
import { ELEMENTS, E, toolById, isBuild } from './elements.js';
import { buildPreset } from './presets.js';
import { quadVert } from './shaders/common.js';
import { createBrushCursor } from './brush.js';
import { createCameraRig } from './camera.js';
import { createBrand, createToolbar } from './ui/topbar.js';
import { createDock } from './ui/dock.js';
import { createCard } from './ui/card.js';
import { createSettings } from './ui/settings.js';
import { createHud, createHelp } from './ui/hud.js';
import { inkFor, luminance } from './ui/dom.js';
import { gfx, gfxUniforms, updateGfxUniforms } from './gfx/uniforms.js';
import { createPost, UPSCALE } from './gfx/post.js';
import { createPacer, settleFrames, sceneKey } from './gfx/pacing.js';
import { CHANNELS, MEDIA } from './gfx/materials.js';
import { GI_BLEND } from './sim.js';
import { createMultiplayer } from './net/multiplayer.js';
import { createPov } from './pov/index.js';
import { renderViewmodels } from './pov/viewmodel.js';

// Optional modules (built in parallel); the app works without them.
const optional = import.meta.glob(['./views.js', './signs.js', './constructions.js'], { eager: true });
const VIEWS = optional['./views.js']?.VIEWS ?? [
  { id: 0, hotkey: '1', name: 'Realistic', desc: 'Sunlight, shadows and glowing heat.', legend: null },
  { id: 1, hotkey: '2', name: 'Heat', desc: 'Colour shows temperature.', legend: null },
];
const SignsClass = optional['./signs.js']?.Signs;
const BuildsClass = optional['./constructions.js']?.Constructions;

const SIZES = { '64': [64, 64, 64], '96': [96, 96, 96], '128': [128, 128, 128], wide: [160, 96, 160] };
const SIGN_TOOL = -5;

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  size: '128', preset: 'lab',
  tool: E.SAND, radius: 5, shape: 0, rate: 1, replace: false,
  steps: 4, gravity: 0.025, paused: false,
  view: 0, sunAz: 38, sunEl: 55, camSpeed: 1, upscale: 'native', dockCollapsed: false,
};
const PERSIST = ['size', 'preset', 'tool', 'radius', 'shape', 'rate', 'replace', 'steps', 'gravity', 'view',
  'sunAz', 'sunEl', 'camSpeed', 'upscale', 'dockCollapsed'];
const STORE = 'powder-toy-3d:settings';
// Fixed look: glow is heat-driven light (×uLightGain); smoothing, TAA, bloom and
// exposure keep their defaults in gfx/uniforms.js and gfx/post.js.
const GLOW_GAIN = 1.6;
const RES_MAX = Math.min(devicePixelRatio, 1.5);   // auto resolution's ceiling (pixel ratio)

const settings = { ...DEFAULTS };
try {
  // only keys still in use: values of removed settings must not linger
  const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
  for (const k of PERSIST) if (k in saved) settings[k] = saved[k];
} catch { /* storage unavailable */ }
const params = new URLSearchParams(location.search);
if (params.get('size') in SIZES) settings.size = params.get('size');
if (params.get('preset')) settings.preset = params.get('preset');
if (!(settings.size in SIZES)) settings.size = DEFAULTS.size;
if (!toolById(settings.tool)) settings.tool = DEFAULTS.tool;
if (!VIEWS.some((v) => v.id === settings.view)) settings.view = 0;
settings.paused = false;

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(PERSIST.map((k) => [k, settings[k]])))); } catch { /* ignore */ }
  }, 300);
}

// ---------------------------------------------------------------- renderer / scene
// The canvas only ever receives post's full-screen composite (no depth test; TAA
// does the antialiasing upstream), so it gets neither MSAA nor a depth buffer:
// both would only cost memory and bandwidth (~165 MB at 2880×1800).
const renderer = new THREE.WebGLRenderer({ antialias: false, depth: false, alpha: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 0);
let pixelRatio = Math.min(RES_MAX, 1);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.autoClear = false;
document.getElementById('app').appendChild(renderer.domElement);
// HDR post: TAA, bloom, AgX tone mapping (src/gfx/post.js)
const post = createPost(renderer, { pixScale: gfxUniforms.uPixScale });

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.zoomToCursor = true;

const floorGrid = new THREE.GridHelper(80, 80, 0x2b3240, 0x1b2029);
floorGrid.position.y = -0.002;
// GL lines are one rendered pixel wide: under TAAU that is 1/scale output pixels,
// so the grid and the box outline fade by the render scale to keep their weight.
// Transparent for that, but still drawn before the other transparent objects.
floorGrid.material.transparent = true;
floorGrid.renderOrder = -1;
const EDGE_OPACITY = 0.55;
scene.add(floorGrid);

const SUN = new THREE.Vector3();
function updateSun() {
  const az = THREE.MathUtils.degToRad(settings.sunAz), el = THREE.MathUtils.degToRad(settings.sunEl);
  SUN.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
}
updateSun();

const brush = createBrushCursor();
scene.add(brush.mesh);

const isTyping = () => {
  const a = document.activeElement;
  return !!(signs?.editing || (a && (a.tagName === 'TEXTAREA' || a.isContentEditable ||
    (a.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(a.type)))));
};
const rig = createCameraRig(camera, controls, isTyping);

let sim, volume, edges, pickMat, shadowMat, shadowTarget, scale;
const pickTarget = new THREE.WebGLRenderTarget(2, 1, { type: THREE.FloatType, depthBuffer: false });
const pickBuf = new Float32Array(8);
let pickPending = false;

function build() {
  pov?.exit(true);   // the body lives in the old grid
  pov?.worldReplaced();
  if (sim) {
    sim.dispose();
    scene.remove(volume, edges);
    volume.geometry.dispose();
    volume.material.dispose();
    edges.geometry.dispose();
    pickMat.dispose();
    shadowMat.dispose();
    shadowTarget.dispose();
  }
  const [nx, ny, nz] = SIZES[settings.size];
  sim = new Simulation(renderer, nx, ny, nz);
  sim.gravity = settings.gravity;
  scale = 10 / Math.max(nx, nz);

  const geo = new THREE.BoxGeometry(nx, ny, nz);
  geo.translate(nx / 2, ny / 2, nz / 2);
  volume = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    vertexShader: volumeVert,
    fragmentShader: volumeFrag(sim.g),
    uniforms: {
      tA: { value: null }, tB: { value: null }, tBrick: { value: null }, tLight: { value: null },
      uCam: { value: new THREE.Vector3() },
      uSun: { value: SUN }, tShadow: { value: null }, uShadowRes: { value: 0 },
      uView: { value: 0 }, uShadows: { value: true }, uTime: { value: 0 }, uLightGain: { value: GLOW_GAIN },
      ...gfxUniforms,
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  }));
  volume.scale.setScalar(scale);
  volume.position.set(-nx / 2 * scale, 0, -nz / 2 * scale);
  volume.frustumCulled = false;
  scene.add(volume);
  volume.updateMatrixWorld();

  edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0x56607a, transparent: true, opacity: EDGE_OPACITY }));
  edges.scale.copy(volume.scale);
  edges.position.copy(volume.position);
  scene.add(edges);

  pickMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: quadVert,
    fragmentShader: pickFrag(sim.g),
    uniforms: {
      tA: { value: null }, tB: { value: null }, tBrick: { value: null }, tLight: { value: null },
      tBrickDist: gfxUniforms.tBrickDist,
      uRo: { value: new THREE.Vector3() }, uRd: { value: new THREE.Vector3() },
    },
    depthTest: false,
    depthWrite: false,
  });

  const shadowRes = Math.min(1024, 4 * Math.max(nx, ny, nz));
  shadowTarget = new THREE.WebGLRenderTarget(shadowRes, shadowRes, {
    type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
  });
  shadowMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: quadVert,
    fragmentShader: shadowFrag(sim.g),
    uniforms: {
      tA: { value: null }, tBrick: { value: null }, tLight: { value: null },
      uSun: { value: SUN }, tShadow: { value: null }, uShadowRes: { value: shadowRes },
      ...gfxUniforms,
    },
    depthTest: false,
    depthWrite: false,
  });
  volume.material.uniforms.tShadow.value = shadowTarget.texture;
  volume.material.uniforms.uShadowRes.value = shadowRes;

  const h = ny * scale;
  rig.setHome(new THREE.Vector3(11, h * 0.9 + 3, 13), new THREE.Vector3(0, h * 0.25, 0));
  rig.reset(true);
  if (signs) { signs.clear(); signs.rebuild(); }
  loadPreset(settings.preset, false);
}

// Multiplayer guests follow the host's grid size.
function setGrid(dims) {
  const size = Object.keys(SIZES).find((k) => SIZES[k].every((n, i) => n === dims[i]));
  if (!size) return false;
  settings.size = size;
  build();
  return true;
}

function loadPreset(name, undoable = true) {
  if (undoable && mp.guard()) return false;
  if (undoable) sim.snapshot();
  settings.preset = name;
  if (name === 'empty') sim.clear();
  else buildPreset(name, sim);
  post.reset();
  signs?.clear();
  pov?.worldReplaced();
  save();
  return true;
}

// ---------------------------------------------------------------- signs (optional module)
const signLayer = Object.assign(document.createElement('div'), { className: 'sign-layer' });
Object.assign(signLayer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 4 });
document.body.append(signLayer);
let signs = null;
let builds = null; // constructions (optional module)
let pov = null;    // first-person mode (src/pov)

// ---------------------------------------------------------------- picking & brush
const pointer = new THREE.Vector2();
let pointerInside = false;
let pointerClient = [0, 0];
const raycaster = new THREE.Raycaster();
const hover = { valid: false, cell: new THREE.Vector3(), face: 0, id: -1, T: 0, P: 0 };
let painting = false;
let dragY = 0;
const brushCenter = new THREE.Vector3();
let brushValid = false;
const invVolume = new THREE.Matrix4();

function gridRay() {
  raycaster.setFromCamera(pointer, camera);
  return raycaster.ray.clone().applyMatrix4(invVolume.copy(volume.matrixWorld).invert());
}

// In POV the pick follows the crosshair (the screen centre) instead of the pointer.
const povRay = new THREE.Ray();
function requestPick() {
  const fromPov = !!pov?.aimRay(povRay.origin, povRay.direction);
  if (pickPending || (!pointerInside && !fromPov)) return;
  const ray = fromPov ? povRay : gridRay();
  pickMat.uniforms.uRo.value.copy(ray.origin);
  pickMat.uniforms.uRd.value.copy(ray.direction);
  pickMat.uniforms.tA.value = sim.stateA;
  pickMat.uniforms.tB.value = sim.stateB;
  pickMat.uniforms.tBrick.value = sim.brick.texture;
  sim.run(pickMat, pickTarget);
  pickPending = true;
  renderer.readRenderTargetPixelsAsync(pickTarget, 0, 0, 2, 1, pickBuf).then(() => {
    pickPending = false;
    hover.valid = pickBuf[3] >= 0;
    if (hover.valid) {
      hover.cell.set(pickBuf[0], pickBuf[1], pickBuf[2]);
      hover.face = pickBuf[3];
      hover.id = Math.round(pickBuf[4]);
      hover.T = pickBuf[5];
      hover.P = pickBuf[6];
    }
  }).catch(() => { pickPending = false; });
}

// One-off pick along a grid-space ray (ro, rd), e.g. to find the ground: resolves to
// { valid, cell, face, id, T, P } like `hover`.
const rayTarget = new THREE.WebGLRenderTarget(2, 1, { type: THREE.FloatType, depthBuffer: false });
function pickRay(ro, rd) {
  pickMat.uniforms.uRo.value.copy(ro);
  pickMat.uniforms.uRd.value.copy(rd);
  pickMat.uniforms.tA.value = sim.stateA;
  pickMat.uniforms.tB.value = sim.stateB;
  pickMat.uniforms.tBrick.value = sim.brick.texture;
  sim.run(pickMat, rayTarget);
  const buf = new Float32Array(8);
  return renderer.readRenderTargetPixelsAsync(rayTarget, 0, 0, 2, 1, buf).then(() => ({
    valid: buf[3] >= 0, cell: new THREE.Vector3(buf[0], buf[1], buf[2]), face: buf[3],
    id: Math.round(buf[4]), T: buf[5], P: buf[6],
  }));
}

const isTool = () => settings.tool < 0;
const faceNormal = (face) => {
  const n = new THREE.Vector3();
  n.setComponent(Math.floor(face / 2), face % 2 === 0 ? 1 : -1);
  return n;
};

function hoverBrushCenter(out) {
  const axis = Math.floor(hover.face / 2);
  const sign = hover.face % 2 === 0 ? 1 : -1;
  out.copy(hover.cell).addScalar(0.5);
  if (!isTool() || hover.id < 0) out.setComponent(axis, out.getComponent(axis) + sign * (settings.radius + 0.5));
  return out;
}

const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const tmpV = new THREE.Vector3();
function updateBrush() {
  const g = sim.g;
  brushValid = false;
  if (pov?.active) {
    brush.set({ visible: false });
    builds?.update({ hover, active: false });
    return;
  }
  if (settings.tool !== SIGN_TOOL && !isBuild(settings.tool)) {
    if (painting) {
      plane.constant = -dragY;
      if (gridRay().intersectPlane(plane, tmpV)) { brushCenter.copy(tmpV); brushValid = true; }
    } else if (hover.valid) {
      hoverBrushCenter(brushCenter);
      brushValid = true;
    }
  }
  if (brushValid) {
    brushCenter.x = THREE.MathUtils.clamp(brushCenter.x, 0, g.nx);
    brushCenter.y = THREE.MathUtils.clamp(brushCenter.y, 0, g.ny);
    brushCenter.z = THREE.MathUtils.clamp(brushCenter.z, 0, g.nz);
  }
  brush.set({
    visible: brushValid && pointerInside && !uiHover && !eyedropper,
    position: tmpV.copy(brushCenter).multiplyScalar(scale).add(volume.position),
    radius: settings.radius * scale,
    shape: settings.shape,
    color: toolById(settings.tool).color,
  });
  builds?.update({ hover, active: isBuild(settings.tool) && pointerInside && !uiHover && !eyedropper });
}

// ---------------------------------------------------------------- UI
let uiHover = false;
let eyedropper = false; // armed by the dock's Eyedropper or by I away from any element
createBrand();
const card = createCard();
const hud = createHud();
const help = createHelp(() => help.setOpen(false));

function accentFor(hex) {
  // very dark elements (smoke, gunpowder) would vanish as an accent on a dark UI
  const l = luminance(hex);
  if (l > 0.06) return hex;
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * 0.55).toString(16).padStart(2, '0');
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

// the last element or tool picked, for leaving a construction's options
let lastPaintTool = E.SAND;
function selectTool(id) {
  setEyedropper(false);
  if (!isBuild(id)) lastPaintTool = id;
  settings.tool = id;
  const it = toolById(id);
  const accent = accentFor(it.color);
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-ink', inkFor(accent));
  card.show(id);
  dock.sync();
  save();
}

// Closing a construction's options goes back to the last element or tool.
function leaveBuild() { if (isBuild(settings.tool)) selectTool(lastPaintTool); }

const dock = createDock({
  settings,
  onSelect: selectTool,
  onBrushChange: (patch) => { Object.assign(settings, patch); dock.sync(); save(); },
  onHover: (id) => card.show(id ?? settings.tool),
  onEyedropper: () => setEyedropper(!eyedropper),
});

// Eyedropper: the next click on the scene selects whatever element it lands on.
function setEyedropper(on) {
  eyedropper = on;
  document.body.classList.toggle('eyedropper', on);
  dock.setEyedropper(on);
}
function pickHovered() {
  if (!(hover.valid && hover.id > 0)) return false;
  selectTool(hover.id);
  hud.toast(`Picked ${ELEMENTS[hover.id].name}`);
  return true;
}

const actions = {
  togglePause: () => setPaused(!settings.paused),
  undo,
  resetCamera: () => { rig.reset(); hud.toast('Camera reset'); },
  screenshot: () => { wantShot = true; },
  toggleSettings: () => setSettingsOpen(!settingsPanel.isOpen),
  toggleHelp: () => help.setOpen(!help.isOpen),
  setView,
  renderThumb,
};
const toolbar = createToolbar({ views: VIEWS, settings, actions });
const mp = createMultiplayer({ renderer, scene, camera, hud, getSim: () => sim, getVolume: () => volume, setGrid });

const fmtSpeed = (v) => `${v}×`;
const settingsPanel = createSettings({
  settings,
  onClose: () => setSettingsOpen(false),
  // Sections and their rows run from most to least reached-for; keep that order when adding settings.
  sections: [
    { title: 'Scene', rows: [
      // clicking the current scene reloads it; Empty clears
      { type: 'seg', key: 'preset', options: [['empty', 'Empty'], ['lab', 'Lab'], ['volcano', 'Volcano']],
        onChange: (v) => { if (loadPreset(v)) hud.toast(`Loaded ${v === 'empty' ? 'an empty box' : `the ${v}`}`); } },
    ] },
    { title: 'Simulation', rows: [
      { type: 'slider', key: 'steps', label: 'Speed (steps per frame)', min: 1, max: 12, step: 1, def: DEFAULTS.steps, fmt: fmtSpeed, onChange: save },
      { type: 'slider', key: 'gravity', label: 'Gravity', min: 0, max: 0.06, step: 0.005, def: DEFAULTS.gravity,
        fmt: (v) => `${(v / DEFAULTS.gravity).toFixed(1)} g`, onChange: (v) => { sim.gravity = v; save(); } },
    ] },
    // a cost lever too: sim work grows with cells, ray marching with the grid's span
    { title: 'Grid size', rows: [
      { type: 'seg', key: 'size', options: [['64', '64³'], ['96', '96³'], ['128', '128³'], ['wide', '160×96']],
        onChange: (v) => { if (mp.guard()) return; settings.size = v; build(); save(); hud.toast(`Grid is now ${v === 'wide' ? '160 × 96 × 160' : `${v}³`}`); } },
    ] },
    { title: 'Lighting', rows: [
      { type: 'slider', key: 'sunEl', label: 'Sun height', min: 12, max: 85, step: 1, def: DEFAULTS.sunEl,
        fmt: (v) => `${v}°`, onChange: () => { updateSun(); save(); } },
      { type: 'slider', key: 'sunAz', label: 'Sun direction', min: 0, max: 360, step: 1, def: DEFAULTS.sunAz,
        fmt: (v) => `${v}°`, onChange: () => { updateSun(); save(); } },
    ] },
    // the scene renders at a share of the screen's pixels and TAA rebuilds full detail over frames
    { title: 'Upscaling', rows: [
      { type: 'seg', key: 'upscale', options: [['native', 'Off'], ['quality', 'Quality'], ['balanced', 'Balanced'], ['performance', 'Fast']],
        onChange: (v) => { settings.upscale = v; save(); } },
    ] },
    { title: 'Camera', rows: [
      { type: 'slider', key: 'camSpeed', label: 'Move speed (WASD)', min: 0.25, max: 3, step: 0.05, def: DEFAULTS.camSpeed,
        fmt: (v) => `${v.toFixed(2)}×`, onChange: (v) => { rig.setSpeed(v); save(); } },
    ] },
  ],
  footer: [['Reset all settings', resetSettings]],
});

function resetSettings() {
  const keep = { size: settings.size, preset: settings.preset, tool: settings.tool, paused: settings.paused, dockCollapsed: settings.dockCollapsed };
  Object.assign(settings, DEFAULTS, keep);
  sim.gravity = settings.gravity;
  rig.setSpeed(settings.camSpeed);
  updateSun();
  dock.sync();
  toolbar.sync();
  save();
  hud.toast('Settings reset');
}

function setSettingsOpen(v) {
  settingsPanel.setOpen(v);
  toolbar.setSettingsOpen(v);
  if (v) toolbar.close();
}

function setPaused(p) {
  if (mp.guard()) return;
  settings.paused = p;
  hud.setPaused(p);
  toolbar.sync();
}

function setView(id) {
  if (!VIEWS.some((v) => v.id === id)) return;
  if (settings.view !== id) post.reset();
  settings.view = id;
  toolbar.sync();
  hud.setLegend(VIEWS.find((v) => v.id === id));
  save();
}

function setPixelRatio(r) {
  pixelRatio = r;
  renderer.setPixelRatio(r);
  renderer.setSize(innerWidth, innerHeight);
}

function undo() {
  if (mp.guard()) return;
  if (sim.undo()) { pov?.worldReplaced(); hud.toast('Undone'); }
  else hud.toast('Nothing to undo');
  toolbar.setUndoEnabled(sim.canUndo);
}

// UI elements shouldn't show the brush or receive paint
for (const el of document.querySelectorAll('.panel, .dock-tab')) {
  el.addEventListener('pointerenter', () => { uiHover = true; });
  el.addEventListener('pointerleave', () => { uiHover = false; });
}

// ---------------------------------------------------------------- thumbnails for the views menu
const thumbTarget = new THREE.WebGLRenderTarget(320, 200, { depthBuffer: true });
const thumbCam = new THREE.PerspectiveCamera();
const thumbPixels = new Uint8Array(320 * 200 * 4);
function renderThumb(viewId, canvas) {
  thumbCam.copy(camera, false);   // not its children (the POV viewmodel)
  thumbCam.aspect = 1.6;
  thumbCam.updateProjectionMatrix();
  const u = volume.material.uniforms;
  const prev = u.uView.value;
  u.uView.value = viewId;
  const brushWas = brush.mesh.visible;
  brush.mesh.visible = false;
  const rawWas = post.settings.raw;
  post.settings.raw = viewId !== 0;
  post.renderStill(scene, thumbCam, thumbTarget);
  post.settings.raw = rawWas;
  renderer.readRenderTargetPixels(thumbTarget, 0, 0, 320, 200, thumbPixels);
  renderer.setRenderTarget(null);
  u.uView.value = prev;
  brush.mesh.visible = brushWas;
  // flip vertically and un-premultiply
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(320, 200);
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      const s = ((199 - y) * 320 + x) * 4, d = (y * 320 + x) * 4;
      const a = thumbPixels[s + 3] / 255 || 1;
      img.data[d] = Math.min(255, thumbPixels[s] / a);
      img.data[d + 1] = Math.min(255, thumbPixels[s + 1] / a);
      img.data[d + 2] = Math.min(255, thumbPixels[s + 2] / a);
      img.data[d + 3] = thumbPixels[s + 3];
    }
  }
  ctx.putImageData(img, 0, 0);
  canvas.dataset.rendered = '1';
  if (viewId === settings.view) toolbar.sync();
}

// ---------------------------------------------------------------- input
const canvasEl = renderer.domElement;
canvasEl.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  pointerClient = [e.clientX, e.clientY];
  pointerInside = true;
  uiHover = false;
});
canvasEl.addEventListener('pointerleave', () => { pointerInside = false; });
canvasEl.addEventListener('pointerdown', (e) => {
  toolbar.close();
  if (pov?.active) return;   // POV handles its own mouse buttons
  const wasEditing = !!signs?.editing;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (e.button !== 0 || e.altKey || wasEditing) return; // a click that just finishes editing a sign doesn't paint
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (eyedropper) {
    if (!pickHovered()) hud.toast('Nothing to pick there');
    return;
  }
  if (settings.tool === SIGN_TOOL) {
    if (signs && hover.valid) signs.add({ cell: hover.cell.clone(), normal: faceNormal(hover.face) });
    else if (!signs) hud.toast('Signs are still loading');
    return;
  }
  if (isBuild(settings.tool)) {
    if (mp.guard()) return;
    if (!builds) hud.toast('Constructions are still loading');
    else if (builds.ready) { sim.snapshot(); toolbar.setUndoEnabled(true); builds.place(); hud.dismissHint(); }
    return;
  }
  dragY = hover.valid ? hoverBrushCenter(tmpV).y : (isTool() ? 0.5 : settings.radius);
  if (!mp.isGuest) {
    sim.snapshot();
    toolbar.setUndoEnabled(true);
  }
  painting = true;
  hud.dismissHint();
  canvasEl.setPointerCapture(e.pointerId);
});
addEventListener('pointerup', (e) => { if (e.button === 0) painting = false; });
canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());

// Shift + scroll changes the brush size instead of zooming.
canvasEl.addEventListener('wheel', (e) => {
  if (!e.shiftKey || pov?.active) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const d = e.deltaY || e.deltaX;
  if (d) setRadius(settings.radius + (d > 0 ? -1 : 1));
}, { capture: true, passive: false });

function setRadius(r) {
  settings.radius = THREE.MathUtils.clamp(Math.round(r), 1, 24);
  dock.sync();
  save();
}

let stepOnce = false;
let wantShot = false;

addEventListener('keydown', (e) => {
  if (e.key === 'Alt') controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  if (e.key === 'Shift') controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  if (isTyping()) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (mod) return;
  const k = e.key;
  if (k === 'f' || k === 'F') { if (!e.repeat) { painting = false; pov?.toggle(); } return; }
  if (pov?.blocksKey(e)) return;   // POV owns movement, Space and the digits while active
  if (e.code === 'Space') { e.preventDefault(); setPaused(!settings.paused); }
  else if (k === '.') stepOnce = true;
  else if (k === '[') setRadius(settings.radius - 1);
  else if (k === ']') setRadius(settings.radius + 1);
  else if (k === 'b' || k === 'B') { settings.shape ^= 1; dock.sync(); save(); }
  else if (k === 'x' || k === 'X') { settings.replace = !settings.replace; dock.sync(); save(); hud.toast(settings.replace ? 'Replace mode on' : 'Replace mode off'); }
  else if (k === 'i' || k === 'I') { if (!(pointerInside && !uiHover && pickHovered())) setEyedropper(!eyedropper); }
  else if (k === 'r' || k === 'R') actions.resetCamera();
  else if (k === 't' || k === 'T') dock.toggle();
  else if (k === '/') { e.preventDefault(); dock.focusSearch(); }
  else if (k === ',') actions.toggleSettings();
  else if (k === '?') actions.toggleHelp();
  else if (k === 'p' || k === 'P') actions.screenshot();
  else if (k === 'Escape') {
    const overlay = eyedropper || toolbar.isOpen || settingsPanel.isOpen || help.isOpen || mp.panelOpen;
    setEyedropper(false); toolbar.close(); setSettingsOpen(false); help.setOpen(false); mp.closePanel();
    if (!overlay) leaveBuild();
  }
  else if (/^[0-9]$/.test(k)) { const v = VIEWS.find((x) => x.hotkey === k); if (v) setView(v.id); }
});
addEventListener('keyup', (e) => {
  if (e.key === 'Alt') controls.mouseButtons.LEFT = null;
  if (e.key === 'Shift') controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
});
addEventListener('blur', () => {
  controls.mouseButtons.LEFT = null;
  controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  painting = false;
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- loop
const clock = new THREE.Timer();
// The fps readout is the rate frames are drawn while drawing: a paused, still
// scene draws nothing (render on demand) and reads as idle, not as a low rate.
let frames = 0, fpsTime = 0, fps = 60, idleTime = 0;
// Render on demand (gfx/pacing.js). The derived passes settle once the slowest
// field EMA and the GI blend (each probe is traced every other frame) have
// converged; the view once TAA's history has (upscaled, it accumulates for longer).
const GI_PROBE_EVERY = 2;
const pacer = createPacer({
  derivedSettle: Math.max(...[...CHANNELS, ...MEDIA].map((c) => settleFrames(c.ema)), settleFrames(GI_BLEND, GI_PROBE_EVERY)),
  viewSettle: () => settleFrames(post.settleWeight),
});
// input of any kind may change what the view shows
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'change', 'resize']) {
  addEventListener(type, () => pacer.wake(), { capture: true, passive: true });
}
let lastVersion = -1, renderedLast = false;
const DT_MAX = 0.1;      // s: longer gaps (a hidden tab) count as this, so animations don't jump
const FPS_WINDOW = 0.5;  // s over which the fps readout averages
let resTime = 0, resFrames = 0, resDt = 0;
const invVol = new THREE.Matrix4();

// Lower the render resolution when frames run long, but only if it actually
// helps: when the simulation (not drawing) is the bottleneck, a lower
// resolution just blurs the picture, so we undo the drop and stop trying.
// Auto resolution: every AUTO_RES_WINDOW seconds, drop the pixel ratio by
// AUTO_RES_DOWN when frames run slower than AUTO_RES_SLOW_FPS, raise it by
// AUTO_RES_UP when faster than AUTO_RES_FAST_FPS. A drop that didn't speed
// frames up by AUTO_RES_MIN_GAIN is undone and not retried for AUTO_RES_HOLD seconds.
const AUTO_RES_WINDOW = 1.2;      // s
const AUTO_RES_MIN = 0.6;         // lowest pixel ratio it goes to
const AUTO_RES_SLOW_FPS = 50;
const AUTO_RES_FAST_FPS = 57;
const AUTO_RES_DOWN = 0.85;
const AUTO_RES_UP = 1.08;
const AUTO_RES_MIN_GAIN = 0.93;   // frame time must fall below this × the old one
const AUTO_RES_HOLD = 15;         // s
const autoRes = { enabled: true, lastDt: 0, tried: 0, holdUntil: 0 };   // tools turn it off for stable timings
function autoResolution(dt, now) {
  if (!autoRes.enabled) return;
  resTime += dt; resFrames++; resDt += dt;
  if (resTime < AUTO_RES_WINDOW) return;
  const avg = resDt / resFrames;
  resTime = resFrames = resDt = 0;
  const max = RES_MAX, min = AUTO_RES_MIN;
  if (autoRes.tried) {
    // judge the previous decrease
    if (avg > autoRes.lastDt * AUTO_RES_MIN_GAIN) { setPixelRatio(autoRes.tried); autoRes.holdUntil = now + AUTO_RES_HOLD; }
    autoRes.tried = 0;
    return;
  }
  if (avg > 1 / AUTO_RES_SLOW_FPS && pixelRatio > min && now > autoRes.holdUntil) {
    autoRes.tried = pixelRatio;
    autoRes.lastDt = avg;
    setPixelRatio(Math.max(min, pixelRatio * AUTO_RES_DOWN));
  } else if (avg < 1 / AUTO_RES_FAST_FPS && pixelRatio < max) {
    setPixelRatio(Math.min(max, pixelRatio * AUTO_RES_UP));
  }
}

// Screenshots: the canvas is transparent where the page's sky shows through
// (body's background in ui/styles.css), so the shot paints that sky first, then
// the scene, then a small credit so shared images lead back to the app.
const SHOT_SKY = [[0, '#232b3a'], [0.55, '#161b25'], [1, '#0e1117']];   // the sky's linear gradient, top to bottom
const SHOT_GLOW = { color: 'rgba(255, 196, 120, 0.06)', x: 0.5, y: 1.08, rx: 1.2, ry: 0.7, end: 0.6 };   // its warm radial glow
const SHOT_CREDIT = 'tpt3d.codyh.xyz';
const SHOT_CREDIT_SIZE = 0.022;   // credit text height, as a share of the image height
const SHOT_CREDIT_MIN_PX = 12;
const SHOT_CREDIT_ALPHA = 0.75;
const SHOT_MARK_SCALE = 1.5;      // logo mark size relative to the text
const shotMark = Object.assign(new Image(), { src: '/favicon.svg' });

function saveScreenshot() {
  const src = renderer.domElement, w = src.width, h = src.height;
  const shot = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = shot.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  for (const [t, c] of SHOT_SKY) sky.addColorStop(t, c);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(SHOT_GLOW.x * w, SHOT_GLOW.y * h);
  ctx.scale(SHOT_GLOW.rx * w, SHOT_GLOW.ry * h);
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  glow.addColorStop(0, SHOT_GLOW.color);
  glow.addColorStop(SHOT_GLOW.end, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(-SHOT_GLOW.x / SHOT_GLOW.rx, -SHOT_GLOW.y / SHOT_GLOW.ry, 1 / SHOT_GLOW.rx, 1 / SHOT_GLOW.ry);
  ctx.restore();
  ctx.drawImage(src, 0, 0);   // same task as the render, so the drawing buffer is still intact

  const px = Math.max(SHOT_CREDIT_MIN_PX, Math.round(h * SHOT_CREDIT_SIZE)), mark = px * SHOT_MARK_SCALE;
  ctx.font = `600 ${px}px Archivo, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = SHOT_CREDIT_ALPHA;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = px / 2;
  ctx.fillStyle = '#e7eaf0';
  const tw = ctx.measureText(SHOT_CREDIT).width, y = h - px - mark / 2;
  ctx.fillText(SHOT_CREDIT, w - px - tw, y);
  if (shotMark.complete && shotMark.naturalWidth) ctx.drawImage(shotMark, w - px - tw - px / 2 - mark, y - mark / 2, mark, mark);

  shot.toBlob((blob) => {
    if (!blob) return;
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `powder-toy-3d-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    hud.toast('Screenshot saved');
  });
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!pacer.due(now)) return;
  clock.update(now);
  const dt = Math.min(clock.getDelta(), DT_MAX);
  // only frames that rendered measure how expensive rendering is
  if (renderedLast) autoResolution(dt, clock.getElapsed());

  if (pov?.active) pov.update(dt);
  else {
    rig.update(dt);
    controls.update();
  }
  updateBrush();

  if (painting && brushValid) {
    const stroke = {
      center: brushCenter, radius: settings.radius, shape: settings.shape,
      tool: settings.tool, rate: settings.rate, replace: settings.replace,
    };
    if (mp.isGuest) mp.paint(stroke); // the host paints it
    else sim.paint(stroke);
  }
  if (!mp.isGuest && (!settings.paused || stepOnce)) {
    for (let i = 0; i < settings.steps; i++) sim.step();
    stepOnce = false;
  }
  mp.update(dt, {
    visible: brushValid && pointerInside && !uiHover, center: brushCenter, painting,
    radius: settings.radius, shape: settings.shape, tool: settings.tool,
  });
  const worldChanged = sim.version !== lastVersion;
  lastVersion = sim.version;
  const runDerived = pacer.derived(
    `${sim.id}:${sim.version}|${SUN.x},${SUN.y},${SUN.z}|${settings.view}|${gfx.smoothing}`);
  const runView = pacer.view(
    `${camera.matrixWorld.elements}|${camera.projectionMatrix.elements}|${pixelRatio}|${innerWidth}x${innerHeight}`
    + `|${JSON.stringify(settings)}|${JSON.stringify(gfx)}|${JSON.stringify(post.settings)}|${sceneKey(scene)}`,
    runDerived || wantShot);
  // a frame's dt measures the drawing rate only when the frame before it drew too
  if (runView && renderedLast) { frames++; fpsTime += dt; }
  if (fpsTime > FPS_WINDOW) { fps = frames / fpsTime; frames = 0; fpsTime = 0; }
  idleTime = runView ? 0 : idleTime + dt;
  renderedLast = runView;
  if (runView) updateGfxUniforms(sim, SUN);   // (runDerived implies runView)
  if (runDerived) {
    sim.updateBricks();
    if (VIEWS.find((v) => v.id === settings.view)?.shadows) {
      shadowMat.uniforms.tA.value = sim.stateA;
      shadowMat.uniforms.tBrick.value = sim.brick.texture;
      sim.run(shadowMat, shadowTarget);
    }
    if (settings.view === 0) sim.updateGI(SUN, shadowTarget.texture, shadowMat.uniforms.uShadowRes.value, true);
  }

  if (runView) {
    volume.updateMatrixWorld();
    const u = volume.material.uniforms;
    u.tA.value = sim.stateA;
    u.tB.value = sim.stateB;
    u.tBrick.value = sim.brick.texture;
    u.tLight.value = sim.lightTexture;
    u.uCam.value.copy(camera.position).applyMatrix4(invVol.copy(volume.matrixWorld).invert());
    u.uView.value = settings.view;
    if (worldChanged) u.uTime.value += dt;   // animated looks (lava, ripples) hold still while the world does

    post.settings.raw = settings.view !== 0;
    post.settings.upscale = UPSCALE[settings.upscale] ?? UPSCALE.native;
    floorGrid.material.opacity = post.renderScale;
    edges.material.opacity = EDGE_OPACITY * post.renderScale;
    post.render(scene, camera);
    // POV: the held tool, drawn over the finished frame in its own pass (no TAA, its
    // own depth, so it never clips into walls); before the screenshot reads the canvas
    renderViewmodels(renderer, scene, camera, post);
    if (wantShot) { wantShot = false; saveScreenshot(); }

    signs?.update();
    requestPick();
  } else if (pov?.active) requestPick();   // the crosshair cell stays fresh for the tools

  if (!pov?.active && pointerInside && !uiHover && hover.valid && hover.id >= 0 && !painting) {
    const el = ELEMENTS[hover.id];
    hud.showReadout(pointerClient[0], pointerClient[1], { name: el.name, color: el.color, T: hover.T, P: hover.P });
  } else {
    hud.showReadout(0, 0, null);
  }
  const g = sim.g;
  hud.setStats({
    fpsV: idleTime > FPS_WINDOW ? null : fps,   // null: idle
    stepsV: settings.paused || mp.isGuest ? 0 : settings.steps * fps, // guests don't simulate
    cellsV: `${(g.nx * g.ny * g.nz / 1e6).toFixed(1)}M`,
    resV: autoRes.enabled ? `${Math.round(pixelRatio * 100)}% res` : '',
  });
}

// ---------------------------------------------------------------- boot
try {
  if (!renderer.capabilities.isWebGL2) throw new Error('This needs WebGL2, which your browser does not provide.');
  if (SignsClass) {
    signs = new SignsClass({
      renderer, camera, container: signLayer,
      getSim: () => sim, getVolume: () => volume,
      onChange: () => {},
    });
  }
  if (BuildsClass) {
    builds = new BuildsClass({
      scene, camera, settings, getSim: () => sim, getVolume: () => volume, getScale: () => scale, onClose: leaveBuild,
      requestRender: () => pacer.wake(),
    });
  }
  build();
  rig.setSpeed(settings.camSpeed);
  selectTool(settings.tool);
  setView(settings.view);
  setPaused(false);
  toolbar.setUndoEnabled(false);
  pov = createPov({
    renderer, scene, camera, controls, canvas: renderer.domElement, hud, settings, mp, isTyping,
    getSim: () => sim, getVolume: () => volume, getScale: () => scale,
    hover, pointerHover: () => pointerInside && !uiHover, pickRay,
    requestRender: () => pacer.wake(),
  });
  window.__app = {
    get sim() { return sim; }, get volume() { return volume; }, get scale() { return scale; }, get signs() { return signs; }, get builds() { return builds; },
    get pov() { return pov; },
    SUN, scene, settings, camera, controls, loadPreset, selectTool, setView, hover, renderer, rig, renderThumb, gfx, post, mp, autoRes,
    requestRender: () => pacer.wake(),   // for changes the frame loop can't see (async results)
  };
  requestAnimationFrame(frame);
} catch (err) {
  const el = document.getElementById('error');
  el.style.display = 'flex';
  el.textContent = String(err.stack || err);
  throw err;
}
