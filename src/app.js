import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './ui/styles.css';
import { Simulation } from './sim.js';
import { volumeVert, volumeFrag, pickFrag, shadowFrag } from './shaders/render.js';
import { ELEMENTS, E, TOOLS, toolById, isBuild, isSpawnerTool, isGearTool, LIGHTNING_TOOL, PROP_TOOL, wandPresetForTool } from './elements.js';
import { propIndex, parseProp, boxFromCorners, runFill, oneShotRate, FILL_AIR, FLOOD_MAX_CELLS } from './editing.js';
import { isDecoTool } from './elements.js';
import { createLightning } from './lightning.js';
import { Spawners, SPAWNER, ENEMY_KINDS, feetOnHit } from './spawners.js';
import { createBirdLife } from './birds/index.js';
import { BODY_HEIGHT, HAND_REACH } from './pov/constants.js';
import { PerkOrbs } from './perkOrbs.js';
import { buildPreset, ARENA_PRESETS } from './presets.js';
import { ArenaMarkers } from './arenas/markers.js';
import { DAM_VALLEY_BANNERS, shrineAltars } from './arenas/damValley.js';
import './world/bakeClient.js';   // the World's build-time bake (world/bake.js), before any world is made
import { structureClear, shrineAltars as worldShrineAltars } from './world/structures.js';
import { loadIsland, releaseGenerator } from './world/gpu.js';
import { WorldWindow, WIN_STEP } from './world/window.js';
import { bakedAir } from './constructions/runtime.js';
import { sceneByKey } from './world/scenes/index.js';
import { FarField } from './world/far.js';
import { farHazeGLSL, farCastersGLSL, farLayout, WORLD_SIZE } from './shaders/far.js';
import { quadVert } from './shaders/common.js';
import { createBrushCursor } from './brush.js';
import { createCameraRig } from './camera.js';
import { createMeshCut } from './gfx/meshCut.js';
import { createBrand, createToolbar } from './ui/topbar.js';
import { createDock } from './ui/dock.js';
import { createCard } from './ui/card.js';
import { createSettings } from './ui/settings.js';
import { createHud, createHelp } from './ui/hud.js';
import { createScoreboard } from './ui/scoreboard.js';
import { h, inkFor, luminance } from './ui/dom.js';
import { gfx, gfxUniforms, updateGfxUniforms } from './gfx/uniforms.js';
import { DETAIL, settingKey, detailDefaults, detailDefines, detailRows } from './gfx/detail.js';
import { createDetailGate } from './gfx/detailGate.js';
import { createColdShaderGuard } from './gfx/coldShader.js';
import { createGpuLossTracker, silentLinkFailure, processLossMessage, lossDetails } from './gfx/gpuLoss.js';
import { setAeration } from './gfx/foam.js';
import { decoView, prepareDeco, readDeco, uploadDeco, ensureDeco, DECO_BYTES, setDecoColor } from './deco.js';
import { claimPrograms } from './gfx/programs.js';
import { createPost, createAutoResolution, UPSCALE } from './gfx/post.js';
import { createPacer, settleFrames, sceneKey, createCapCheck, CAP_IDLE_MS, MAX_FPS } from './gfx/pacing.js';
import { CHANNELS, MEDIA } from './gfx/materials.js';
import { DAY, dayPhase, phaseSteps, keyLight, sunElevation } from './gfx/daylight.js';
import { GI_BLEND, cellTexel } from './sim.js';
import { createMultiplayer } from './net/multiplayer.js';
import { createProfiler } from './gfx/profiler.js';
import { createProfilerPanel } from './ui/profiler.js';
import { createPov } from './pov/index.js';
import { createDescentRunner, runSnapshot, LOAD_POLL_MS, LOAD_WAIT_MS } from './pov/descent/switch.js';
import { createDescentOverlay } from './pov/descent/overlay.js';
import { DESCENT_LEVELS, levelByScene } from './world/scenes/descent/levels.js';
import { descentWands } from './pov/wands/descentRun.js';
import { inventory } from './pov/tools/inventory.js';
import { gearByKey, SLOTS } from './pov/tools/catalog.js';
import { renderViewmodels } from './pov/viewmodel.js';
import { POV_FOV, POV_FOV_RANGE, SENSITIVITY_RANGE } from './pov/camera.js';
import { finishSignIn, account, accountsEnabled } from './account.js';
import { accountSection } from './ui/account-section.js';
import { launch, mark } from './launch.js';
import { MAPS, mapByKey, mapOf, isWorld, sizeTag, WORLD_DIMS } from './maps.js';
import { createSaves, SaveRefused } from './saves/game.js';
import { registerSaveSection, registerSavedSettings } from './saves/sections.js';
import { packCells, unpackCells } from './saves/format.js';
import { BRICK_CELLS } from './shaders/window.js';
import { putSave, getSave, cleanName } from './saves/local.js';
import { SIM_MODE_DEFAULTS, SIM_MODE_KEYS, EDGE, simModeRows, applySimModes, sanitizeModes, modeToast, MODE_KEYS, nextMode } from './simModes.js';
import { createConsole } from './console/index.js';
import { registerConsoleApi } from './console/registry.js';

// Optional modules (built in parallel); the app works without them.
const optional = import.meta.glob(['./views.js', './signs.js', './constructions.js'], { eager: true });
const VIEWS = optional['./views.js']?.VIEWS ?? [
  { id: 0, hotkey: '1', name: 'Realistic', desc: 'Sunlight, shadows and glowing heat.', legend: null },
  { id: 1, hotkey: '2', name: 'Heat', desc: 'Colour shows temperature.', legend: null },
];
const SignsClass = optional['./signs.js']?.Signs;
const BuildsClass = optional['./constructions.js']?.Constructions;

const SIZES = { '64': [64, 64, 64], '96': [96, 96, 96], '128': [128, 128, 128], wide: [160, 96, 160],
  valley: ARENA_PRESETS.damValley.size };
// Arena scenes (presets.js ARENA_PRESETS) are built for one grid each: picking
// one switches the grid to it, and any other box scene switches back. Their
// grids aren't in the Grid size row.
const ARENA_GRID = { damValley: 'valley' };
const ARENA_GRIDS = new Set(Object.values(ARENA_GRID));
// an arena's team banners (arenas/markers.js), by preset
const ARENA_BANNERS = { damValley: DAM_VALLEY_BANNERS };
// Massive worlds (docs/scaling.md D11): a world scene (world/scenes,
// settings.scene: the island by default), `size` cells, simulated and drawn
// through a window of `win` cells that follows the focus (the POV body, else
// the orbit target). The Grid size row's World. A scene with a size of its own
// (the giant volcano's taller world) gets a window as tall as it (worldOf).
const WORLDS = { world: { win: [128, 128, 128], size: WORLD_SIZE } };
// the world and window a WORLDS entry holds with scene s: the window spans the world's height
const worldOf = (w, s) => (s.size ? { size: s.size, win: [w.win[0], s.size[1], w.win[2]] } : w);
// God view over a world: the orbit target on the ground, the camera this far
// off it along the box view's direction (scene units), so the window fills
// about as much of the view as a box does
const WORLD_VIEW_DIR = [11, 9.5, 13];
const WORLD_VIEW_DIST = 21;
// WASD in a world: no faster than the window can follow the orbit target
// (one WIN_STEP move every few frames), in scene units per second
const WORLD_CAM_SPEED_MAX = 9;
const SIGN_TOOL = -5;
const SPAWNER_KIND = { [-6]: SPAWNER.ENEMY, [-7]: SPAWNER.PLAYER, [-20]: SPAWNER.JEEP, [-21]: SPAWNER.HOVERBIKE,
  [-30]: SPAWNER.GUNNER, [-31]: SPAWNER.WORM, [-32]: SPAWNER.GIANT_WORM, [-33]: SPAWNER.BIRDS };   // the Spawners tools' kinds
const SPAWNER_SET = {
  [SPAWNER.ENEMY]: 'Enemy spawner set: press V to fight', [SPAWNER.PLAYER]: 'Player spawn set: V drops you in here',
  [SPAWNER.JEEP]: 'Jeep pad set: press V, walk up to it and press E', [SPAWNER.HOVERBIKE]: 'Hoverbike pad set: press V, walk up to it and press E',
  [SPAWNER.BIRDS]: 'Bird flock set: they live here now',
};
// the lab's own enemy spawner: its open south floor, as shares of the grid (the old lab NPC's arena)
const LAB_ENEMY_AT = [0.555, 0.86];
// the most gravity a script may set (sim.gravity): the Gravity slider's top
const CONSOLE_GRAVITY_MAX = 0.06;

// ---------------------------------------------------------------- settings
// the box the Scene row goes back to from World, and phones' grid
const BOX_DEFAULT = '128';
const DEFAULTS = {
  size: 'world', preset: 'lab', scene: 'island',
  tool: E.SAND, radius: 5, shape: 0, rate: 1, replace: false,
  // TPT's specific delete and replace target (not kept between visits, as TPT's
  // aren't), and its Property tool's last property and value (kept, as TPT's prefs)
  specificDelete: false, replaceTarget: -1, propField: 'temp', propText: '',
  steps: 4, gravity: 0.025, paused: false,
  view: 0, camSpeed: 1, upscale: 'quality', dockCollapsed: true,
  character: 'real', povFov: POV_FOV, sensitivity: 1, viewBobbing: true, sprintMode: 'hold',
  nearGI: true, glowLights: true, caustics: true,
  ...detailDefaults(),
  profiler: false,
};
// Phones and tablets (touch-first, no hover) start on the plain look in the
// Lab box: no World, no extra lighting passes, no close-up detail, and the
// cheapest upscaling. Only the defaults change; anything the player picks in
// Settings still sticks.
const MOBILE = matchMedia('(hover: none) and (pointer: coarse)').matches;
const MOBILE_DEFAULTS = {
  size: BOX_DEFAULT, preset: 'lab',
  nearGI: false, glowLights: false, caustics: false, upscale: 'performance',
  ...Object.fromEntries(DETAIL.map((f) => [settingKey(f), false])),
};
if (MOBILE) Object.assign(DEFAULTS, MOBILE_DEFAULTS);
// Saved settings keep every key, so a changed default would never reach anyone
// who has played before. Each entry here is one such change, applied once to
// settings saved before it (the store's REV_KEY counts the ones applied).
const DEFAULT_CHANGES = [
  MOBILE ? MOBILE_DEFAULTS : {},   // 1: phones start on the plain look
  { size: DEFAULTS.size },         // 2: World by default (phones: the box)
];
const REV_KEY = 'rev';
const LEGACY_MOBILE_KEY = 'mobileLite';   // rev 1's flag before REV_KEY
const PERSIST = ['size', 'preset', 'scene', 'tool', 'radius', 'shape', 'rate', 'replace', 'propField', 'propText', 'steps', 'gravity', 'view',
  'camSpeed', 'upscale', 'dockCollapsed', 'character', 'povFov', 'sensitivity', 'viewBobbing', 'sprintMode',
  'nearGI', 'glowLights', 'caustics', ...DETAIL.map(settingKey), 'profiler'];
const STORE = 'powder-toy-3d:settings';
// Fixed look: glow is heat-driven light (×uLightGain); smoothing, TAA, bloom and
// exposure keep their defaults in gfx/uniforms.js and gfx/post.js.
const GLOW_GAIN = 1.6;

const settings = { ...DEFAULTS };
Object.assign(settings, SIM_MODE_DEFAULTS);   // world options (simModes.js): not remembered, a fresh scene starts them over
try {
  // only keys still in use: values of removed settings must not linger
  const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
  for (const k of PERSIST) if (k in saved) settings[k] = saved[k];
  const rev = saved[REV_KEY] ?? (saved[LEGACY_MOBILE_KEY] ? 1 : 0);
  for (const change of DEFAULT_CHANGES.slice(rev)) Object.assign(settings, change);
} catch { /* storage unavailable */ }
const params = new URLSearchParams(location.search);
// Explicit opt-in only: visual tests also use automation, so never infer this
// from navigator.webdriver. tools/browser.mjs supplies the same flag before boot.
const testMode = params.get('test') ?? window.__TPT_TEST_MODE__;
if (testMode != null && !['manual', 'preview', 'ui', 'visual'].includes(testMode)) throw new Error(`Unknown test mode: ${testMode}`);
let testParked = testMode === 'manual';
const PREVIEW_HZ = 10;
const knownSize = (s) => s in SIZES || s in WORLDS;
if (knownSize(params.get('size'))) settings.size = params.get('size');
if (params.get('preset')) settings.preset = params.get('preset');
if (params.get('scene')) settings.scene = params.get('scene');
settings.scene = sceneByKey(settings.scene).key;   // (a scene no longer listed: the island)
// the Island scene's world seed (world/generator.js), and World's; its default world without one
// (a loaded save sets it to the save's: saves/game.js)
let worldSeed = params.has('seed') ? Number(params.get('seed')) >>> 0 : undefined;
if (!knownSize(settings.size)) settings.size = DEFAULTS.size;
// the box size the Scene row goes back to from World
let boxSize = settings.size in SIZES && !ARENA_GRIDS.has(settings.size) ? settings.size : BOX_DEFAULT;
// a scene named in the URL is a box scene (World has its own), as in the Scene row
if (params.get('preset') && !params.get('size') && settings.size in WORLDS) settings.size = boxSize;
// an arena named in the URL brings its grid
if (params.get('preset') in ARENA_GRID && !params.get('size')) settings.size = ARENA_GRID[params.get('preset')];
// a map (maps.js): the start menu's pick (src/main.js), or ?map= — its scene at its own size
const bootMap = mapByKey(params.get('map') ?? launch.map);
if (bootMap) useMap(bootMap);
if (!toolById(settings.tool)) settings.tool = DEFAULTS.tool;
if (propIndex(settings.propField) < 0) settings.propField = DEFAULTS.propField;
if (!VIEWS.some((v) => v.id === settings.view)) settings.view = 0;
// (a saved 'wizard', the Castle Crashers body that was the default, falls back to it too)
if (!['real', 'stick'].includes(settings.character)) settings.character = DEFAULTS.character;
settings.paused = params.get('paused') === '1' || testMode === 'manual' || testMode === 'ui';

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ ...Object.fromEntries(PERSIST.map((k) => [k, settings[k]])), [REV_KEY]: DEFAULT_CHANGES.length })); } catch { /* ignore */ }
  }, 300);
}

// ---------------------------------------------------------------- renderer / scene
// The canvas only ever receives post's full-screen composite (no depth test; TAA
// does the antialiasing upstream), so it gets neither MSAA nor a depth buffer:
// both would only cost memory and bandwidth (~165 MB at 2880×1800).
const renderer = new THREE.WebGLRenderer({ antialias: false, depth: false, alpha: true, powerPreference: 'high-performance' });
let graphicsFailure = null;
let invalidateGpuWork = () => {};
function stopGraphics(error) {
  if (!graphicsFailure) {
    error.name = 'GraphicsFailure';
    graphicsFailure = error;
    // Also stop direct tool/async draws outside the frame loop. A failed
    // state pass must throw before its caller swaps state histories.
    renderer.render = () => { throw graphicsFailure; };
    invalidateGpuWork();
    const el = document.getElementById('error');
    el.style.display = 'flex';
    el.textContent = `${error.message}\n\nRendering and simulation stopped. Reload to restart.\nUnsaved simulation changes may be lost.`;
    console.error('Graphics stopped:', error);
  }
  return graphicsFailure;
}
// What the page was doing when the GPU went away (gfx/gpuLoss.js): a dead
// GPU process first shows as a link failure with no text, not a lost context.
const gpuLoss = createGpuLossTracker(renderer);
const meshCut = createMeshCut(renderer);   // the volume's march stops at the opaque meshes in it
renderer.domElement.addEventListener('webglcontextlost', () => {
  // Three restores its renderer, not our GPU-only state, undo history, or
  // manually attached array layers. Never resume those as an intact world.
  const seen = gpuLoss.snapshot();
  if (!graphicsFailure) gpuLoss.record({ kind: 'contextLost', ...seen });
  stopGraphics(new Error(`The browser lost the WebGL context. The cause is not available from this event.\n${lossDetails(seen)}`));
});
renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
  const name = renderer.info.programs.find(p => p.program === program)?.name || 'unnamed';
  if (silentLinkFailure(gl, program, vertex, fragment)) {
    const seen = gpuLoss.snapshot();
    gpuLoss.record({ kind: 'gpuProcessLost', linking: name, ...seen });
    throw stopGraphics(new Error(processLossMessage(name, seen)));
  }
  const logs = [
    gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment),
  ].filter(Boolean).join('\n');
  gpuLoss.record({ kind: 'shaderFailed', linking: name, log: logs.slice(0, 2000) });
  throw stopGraphics(new Error(`GPU shader failed: ${name}.\n${logs}`));
};
renderer.setClearColor(0x000000, 0);
// Keep the existing CSS-native output; adaptation only changes scene pixels.
const pixelRatio = Math.min(devicePixelRatio, 1);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.autoClear = false;
document.getElementById('app').appendChild(renderer.domElement);
// the Lightning tool's bolts and storms' (src/lightning.js)
const lightning = createLightning({ renderer });
// HDR post: TAA, bloom, AgX tone mapping (src/gfx/post.js)
const post = createPost(renderer, { pixScale: gfxUniforms.uPixScale });

const scene = new THREE.Scene();
let perkOrbs = null;   // perk orbs (perkOrbs.js), made with the spawners
let lastShrine = 0;    // the shrine id the last placement's orbs got (0: it set none)
let spawners = null;   // enemy and player spawners (spawners.js), made once the volume is
let birds = null;      // the birds (birds/index.js): a World's ambient flocks and the Bird flock spawners'
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.zoomToCursor = true;
controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };   // one finger paints (touchDown)

const FLOOR_SPAN = 80;   // scene units the floor grid spans, a line every unit (a world's is stretched over it)
const floorGrid = new THREE.GridHelper(FLOOR_SPAN, FLOOR_SPAN, 0x2b3240, 0x1b2029);
floorGrid.position.y = -0.002;
// GL lines are one rendered pixel wide: under TAAU that is 1/scale output pixels,
// so the grid and the box outline fade by the render scale to keep their weight.
// Transparent for that, but still drawn before the other transparent objects.
floorGrid.material.transparent = true;
floorGrid.material.depthWrite = false;   // (the volume's march stops at the depth meshes leave: gfx/meshCut.js)
floorGrid.renderOrder = -1;
const EDGE_OPACITY = 0.55;
scene.add(floorGrid);

// The key light (gfx/daylight.js): its direction and colour scale follow the
// day clock, in simulation steps. Tools pin it with __app.day.fixed = { az, el }.
const SUN = new THREE.Vector3();
const KEY_LIGHT = [1, 1, 1];
// settings.time (hours) mirrors the clock for the drawer's slider; it isn't saved.
const HOURS = 24;
const TIME_STEP = 0.25;   // h: the slider's resolution, and how far the clock runs before the open drawer redraws it
const day = { clock: 0, fixed: null };
function updateSun() {
  const phase = dayPhase(day.clock);
  keyLight(phase, SUN, KEY_LIGHT, day.fixed);
  settings.time = Math.round(phase * HOURS / TIME_STEP) * TIME_STEP % HOURS;
}
updateSun();

const brush = createBrushCursor();
scene.add(brush.mesh, ...brush.extras);

const isTyping = () => {
  const a = document.activeElement;
  return !!(signs?.editing || (a && (a.tagName === 'TEXTAREA' || a.isContentEditable ||
    (a.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(a.type)))));
};
const rig = createCameraRig(camera, controls, isTyping);

let sim, volume, edges, pickMat, shadowMat, shadowTarget, scale;
// world mode (a WORLDS size): the world, the window over it, and the world cell (x, z) at the scene's origin
let worldMode = null, win = null;
invalidateGpuWork = () => {
  sim?.wake(); // reject an outstanding idle certification
  birds?.probe.suspend();
  if (win) {
    win.epoch++; // reject readbacks without clearing surviving CPU edits
    if (win.far?.detail) win.far.detail.epoch++;
  }
};
const anchor = new THREE.Vector2();
const pickTarget = new THREE.WebGLRenderTarget(2, 1, { type: THREE.FloatType, depthBuffer: false });
const pickBuf = new Float32Array(8);
let pickPending = false;

function build() {
  if (graphicsFailure) throw graphicsFailure;
  pov?.exit(true);   // the body lives in the old grid
  pov?.worldReplaced();
  // The old grid's materials, disposed of only once the new grid's have
  // claimed their programs (the end of build): every program both use carries
  // over instead of compiling again (gfx/programs.js). A box and a world share
  // all of them but the world's own passes, so a switch compiles nothing big.
  const retired = [];
  if (sim) {
    releaseGenerator(sim, retired);   // the Island scene's, made for this grid
    sim.dispose(retired);
    scene.remove(volume, edges);
    volume.geometry.dispose();
    retired.push(volume.material, pickMat, shadowMat);
    edges.geometry.dispose();
    edges.material.dispose();
    shadowTarget.dispose();
  }
  worldMode = settings.size in WORLDS ? worldOf(WORLDS[settings.size], sceneByKey(settings.scene)) : null;
  const [nx, ny, nz] = worldMode?.win ?? SIZES[settings.size];
  win?.dispose(retired);   // (a new window over the world shares most of its passes' programs)
  win = null;
  sim = new Simulation(renderer, nx, ny, nz, { windowed: !!worldMode, world: worldMode?.size });
  sim.gravity = settings.gravity;
  applySimModes(sim, settings);
  sim.onPass = prof.on ? simPass : null;
  scale = 10 / Math.max(nx, nz);
  if (worldMode) {
    win = new WorldWindow(renderer, sim, { size: worldMode.size, seed: worldSeed, scene: sceneByKey(settings.scene) });
    sim.origin.fromArray(worldStart());
  }
  // the grid starts centred on the scene's origin
  anchor.set(sim.origin.x + nx / 2, sim.origin.z + nz / 2);
  // the floor grid: under a box, or across a world's whole footprint
  const span = win ? [win.size[0] * scale, win.size[2] * scale] : [FLOOR_SPAN, FLOOR_SPAN];
  floorGrid.scale.set(span[0] / FLOOR_SPAN, 1, span[1] / FLOOR_SPAN);
  floorGrid.position.x = win ? (win.size[0] / 2 - anchor.x) * scale : 0;
  floorGrid.position.z = win ? (win.size[2] / 2 - anchor.y) * scale : 0;

  const geo = new THREE.BoxGeometry(nx, ny, nz);
  geo.translate(nx / 2, ny / 2, nz / 2);
  // The view, shadow and GI programs hold a world's far-field parts for every
  // grid, off until a far field attaches (world/far.js attach): a box and a
  // world share all of them, so switching between them compiles nothing big.
  volume = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    vertexShader: volumeVert,
    fragmentShader: volumeFrag(sim.g, farHazeGLSL),
    uniforms: {
      tA: { value: null }, tB: { value: null }, tBrick: { value: null }, tLight: { value: null },
      uCam: { value: new THREE.Vector3() }, uMarchNear: { value: 0 },
      uSun: { value: SUN }, tShadow: { value: null }, uShadowRes: { value: 0 },
      uView: { value: 0 }, uShadows: { value: true }, uTime: { value: 0 }, uLightGain: { value: GLOW_GAIN },
      uOrigin: sim.originUniform,   // the window's place in the world (the sim passes get it from sim.run)
      uFar: { value: false },
      ...gfxUniforms,
      ...meshCut.uniforms,   // bodies in water show through it (gfx/meshCut.js)
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  }));
  volume.scale.setScalar(scale);
  volume.onBeforeRender = meshCut.hook;
  volume.frustumCulled = false;
  scene.add(volume);
  volume.add(sim.rays.view);   // photons and neutrons as points, in grid cells (raysLayer.js)
  // world mode: the world outside the window (world/far.js), drawn before everything else
  if (win) scene.add((win.far = new FarField(renderer, win, { sun: SUN, time: volume.material.uniforms.uTime })).mesh);

  edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0x56607a, transparent: true, opacity: EDGE_OPACITY }));
  edges.scale.copy(volume.scale);
  scene.add(edges);
  placeVolume();

  pickMat = new THREE.RawShaderMaterial({
    name: 'pick',
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
    name: 'shadow',
    glslVersion: THREE.GLSL3,
    vertexShader: quadVert,
    fragmentShader: shadowFrag(sim.g, farCastersGLSL(farLayout(sim.world))),
    uniforms: {
      tA: { value: null }, tBrick: { value: null }, tLight: { value: null },
      uSun: { value: SUN }, tShadow: { value: null }, uShadowRes: { value: shadowRes },
      uFar: { value: false }, tFarShadow: { value: null },
      ...gfxUniforms,
    },
    depthTest: false,
    depthWrite: false,
  });
  gfxUniforms.uClouds.value = false;   // a box has no sky of its own (a world's far field turns its clouds on)
  win?.far.attach(volume.material, shadowMat);   // world mode: the far field's haze and shadows on the window
  applyDetail();
  coldShader.watch(volume.material);
  volume.material.uniforms.tShadow.value = shadowTarget.texture;
  volume.material.uniforms.uShadowRes.value = shadowRes;

  const h = ny * scale;
  if (win) homeOver(anchor.x, anchor.y);
  else rig.setHome(new THREE.Vector3(11, h * 0.9 + 3, 13), new THREE.Vector3(0, h * 0.25, 0));
  rig.setMaxSpeed(win ? WORLD_CAM_SPEED_MAX : Infinity);
  rig.reset(true);
  if (signs) { signs.clear(); signs.rebuild(); }
  claimPrograms(renderer, [...sim.materials(), pickMat, shadowMat], { lights: scene });
  claimPrograms(renderer, [volume.material], { geometry: volume.geometry, lights: scene });
  // an arena only fits its own grid: in another, the lab
  if (!win && settings.preset in ARENA_GRID && ARENA_GRID[settings.preset] !== settings.size) settings.preset = 'lab';
  loadPreset(settings.preset, false);   // (the Island's generator claims its programs as it runs; a world's start compiling)
  retired.forEach((m) => m.dispose());
}

// World: the window's first origin (world cells): centred on the column its
// scene starts at (where the most is going on: the island's shore, seen from
// the sea), snapped to WIN_STEP and inside the world.
function worldStart() {
  const P = win.P, g = sim.g, n = [g.nx, g.nz];
  const c = win.scene.start(P, n);
  const origin = [0, 1].map((k) => {
    const o = Math.round((c[k] - n[k] / 2) / WIN_STEP) * WIN_STEP;
    return THREE.MathUtils.clamp(o, 0, P.size[2 * k] - n[k]);
  });
  return [origin[0], 0, origin[1]];
}

// World: every world gets a shrine (constructions/builtins.js shrine, with its
// perk orbs) near the middle of its first window, where the god view starts:
// on flat dry ground, with as few trees about as it can find, in a clearing
// (the island's trees around it are felled: stamped over with air, exactly as
// they were planted). It's stamped into the window like a placed one, so the
// window keeps it as an edit when it moves away (world/store.js).
const SHRINE_HALF = [9, 6];        // cells: half the shrine's footprint (x, z), a cell to spare
const SHRINE_SEARCH = 40;          // cells from the window's middle it looks within...
const SHRINE_SEARCH_STEP = 4;      // ...on a lattice this fine
const SHRINE_SAMPLE = 2;           // cells between the ground samples under a footprint
const SHRINE_FLAT = 3;             // cells of rise and fall it accepts under its floor
const SHRINE_DRY = 2;              // cells above the sea its lowest ground must be
const SHRINE_HEADROOM = 16;        // cells of window it needs above its floor (the roof, and a hop)
const SHRINE_GLADE = 10;           // cells around its footprint the clearing reaches (trunks within it are felled)
const SHRINE_TREE_COST = 2;        // a spot's score: cells of rise, plus this per tree to fell...
const SHRINE_FAR_COST = 0.05;      // ...plus this per cell from the window's middle (lowest wins)
function worldShrine() {
  if (!win || !builds || win.scene.shrine === false) return;   // (Descent's temples have their own altars)
  const P = win.P, g = sim.g, o = sim.origin, [hx, hz] = SHRINE_HALF;
  // a scene with structures places its own (world/structures.js: generated, in a clearing): set its orbs
  const altars = worldShrineAltars(P);
  if (altars) { perkOrbs?.shrineAt(altars.map((a) => a.sub(o))); return; }
  const sea = P.sea ?? 0;
  const fits = (x, z) => x - hx >= 0 && z - hz >= 0 && x + hx < g.nx && z + hz < g.nz;
  // the ground's lowest and highest under a footprint centred on grid column (x, z)
  const span = (x, z) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = -hx; i <= hx; i += SHRINE_SAMPLE)
      for (let k = -hz; k <= hz; k += SHRINE_SAMPLE) {
        if (structureClear(P, o.x + x + i, o.z + z + k)) return [0, Infinity];   // not on the world's structures (world/structures.js)
        const h = win.scene.ground(o.x + x + i, o.z + z + k, P);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
    return [lo, hi];
  };
  // the trees whose trunks stand in its glade (the scene's, if it plants any: the island's)
  const glade = (x, z) => (win.scene.trees
    ? win.scene.trees.treesIn(o.x + x - hx - SHRINE_GLADE, o.z + z - hz - SHRINE_GLADE, o.x + x + hx + SHRINE_GLADE + 1, o.z + z + hz + SHRINE_GLADE + 1, P, win.candidates)
    : []);
  const cx = Math.round(g.nx / 2), cz = Math.round(g.nz / 2);
  let best = null;
  for (let dx = -SHRINE_SEARCH; dx <= SHRINE_SEARCH; dx += SHRINE_SEARCH_STEP)
    for (let dz = -SHRINE_SEARCH; dz <= SHRINE_SEARCH; dz += SHRINE_SEARCH_STEP) {
      const x = cx + dx, z = cz + dz;
      if (!fits(x, z)) continue;
      const [lo, hi] = span(x, z);
      if (hi - lo > SHRINE_FLAT || lo < sea + SHRINE_DRY || hi + SHRINE_HEADROOM > g.ny) continue;
      const trees = glade(x, z);
      const score = hi - lo + SHRINE_TREE_COST * trees.length + SHRINE_FAR_COST * Math.hypot(dx, dz);
      if (!best || score < best.score) best = { x, z, y: Math.ceil(hi), trees, score };
    }
  if (!best) return;
  for (const t of best.trees) {
    const baked = win.bakeTree(t);
    if (baked) builds.stampBaked(bakedAir(baked), new THREE.Vector3(t.x - o.x - baked.base.x, t.y - o.y - baked.base.y, t.z - o.z - baked.base.z));
  }
  builds.stampAt('SHRINE', new THREE.Vector3(best.x, best.y, best.z));   // (onPlaced sets its orbs)
}

// World: the god view's home over world column (x, z), the orbit target on
// the ground there (the scene's: on the sea where the sea floor is lower), or
// as the scene's view has it (world/scenes/index.js)
function homeOver(x, z) {
  const v = win.scene.view;
  const ground = win.scene.ground(x, z, win.P) + (v?.lift ?? 0);
  const target = new THREE.Vector3((x - anchor.x) * scale, ground * scale, (z - anchor.y) * scale);
  rig.setHome(new THREE.Vector3(...(v?.dir ?? WORLD_VIEW_DIR)).setLength(v ? v.dist * scale : WORLD_VIEW_DIST).add(target), target);
}

// The grid's box in the scene: at its world origin, so a window moving over
// the world leaves the camera and everything already drawn where they are.
function placeVolume() {
  volume.position.set((sim.origin.x - anchor.x) * scale, 0, (sim.origin.z - anchor.y) * scale);
  edges.position.copy(volume.position);
  volume.updateMatrixWorld();
  edges.updateMatrixWorld();
}

// World mode: keep the window on the focus, the POV body or else the orbit
// target (a tool may pin it: __app.worldFocus = [x, z] in world cells).
function moveWindow() {
  let fx, fz;
  if (worldFocus) [fx, fz] = worldFocus;
  else if (pov?.active && pov.player) { fx = pov.player.pos.x + sim.origin.x; fz = pov.player.pos.z + sim.origin.z; }
  else { fx = controls.target.x / scale + anchor.x; fz = controls.target.z / scale + anchor.y; }
  const move = win.update(fx, fz);
  if (!move) return;
  const [dx, dz] = move;
  placeVolume();
  pov?.windowShifted(dx, dz);
  hover.cell.x -= dx;   // the last pick, in the moved grid (signs follow sim.origin themselves)
  hover.cell.z -= dz;
  if (hover.valid && !inWindow(hover.cell)) hover.valid = false;
}
let worldFocus = null;

// Is grid point p inside the window's columns (x and z)? Painting and tools
// act only there: beyond it, in a world, is ground the window doesn't hold.
const inWindow = (p) => p.x >= 0 && p.x < sim.g.nx && p.z >= 0 && p.z < sim.g.nz;

// A grid cell found by a pick asked for with the window at origin o: where
// it is in the window now (it may have moved since), in place.
function pickedNow(cell, o) {
  cell.x += o.x - sim.origin.x;
  cell.z += o.z - sim.origin.z;
  return cell;
}

// Multiplayer guests follow the host's grid size (a box: never World).
function setGrid(dims) {
  const size = Object.keys(SIZES).find((k) => SIZES[k].every((n, i) => n === dims[i]));
  if (!size) return false;
  settings.size = boxSize = size;
  build();
  return true;
}

// Switch the grid to `size` (SIZES or WORLDS) and rebuild.
function setSize(size) {
  if (graphicsFailure) throw graphicsFailure;
  settings.size = size;
  if (size in SIZES && !ARENA_GRIDS.has(size)) boxSize = size;
  build();
  save();
}

// A map (maps.js) is a scene at its own grid size: the settings that load it.
function useMap(m) {
  settings.size = m.size;
  if (isWorld(m)) settings.scene = m.scene;
  else { settings.preset = m.preset; boxSize = m.size; }
}
// The start menu's Start over a running game (src/main.js): the map, loaded
// fresh (the current one starts over), then its gamemode.
function openMap(key, mode = 'sandbox') {
  if (graphicsFailure) throw graphicsFailure;
  const m = mapByKey(key);
  if (!m || mp.guard() || (isWorld(m) && mp.guardWorld())) return false;
  if (!isWorld(m) && settings.size === m.size) loadPreset(m.preset);   // (undoable, as any box scene)
  else { useMap(m); setSize(m.size); }
  hud.toast(`Loaded ${m.name}`);
  scoreboard.reset();   // a new map: the sandbox's kills and deaths start over, as a GMod server's frags do
  startMode(mode, { fresh: true }).catch((err) => console.error('The match failed to start', err));
  return true;
}
// the map and gamemode playing now, for the menu to open on
function currentMap() {
  const m = mapOf(settings);
  return { map: m?.key ?? null, mode: pov?.game?.running ? pov.game.mode : m?.sandbox === false ? m.modes[0] : 'sandbox' };
}
// A team gamemode (src/game, where the build has it): in the body, a match of
// it on the map just loaded. Sandbox ends any match running. The match waits
// for the body to drop in (game.start needs the player: the first drop-in
// builds it), while the bots' module loads beside it; a map loaded just now
// (fresh) isn't loaded again for the match. Resolves true once it runs.
async function startMode(mode, { fresh = false } = {}) {
  if (mode === 'noita') { if (pov?.game?.running) pov.game.end(); if (pov && !pov.active) pov.enter(); return false; }   // its rules are the map's (Descent)
  const game = pov?.game;
  if (!game) return false;
  if (mode === 'sandbox') { if (game.running) game.end(); return false; }
  game.prepare();
  // the start menu's Play over a game is a click: the mouse is taken now, while it counts as a
  // gesture (a drop-in from the god view asks for it itself)
  if (pov.active && !pov.locked) try { renderer.domElement.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not allowed here */ }
  // Halo puts you in your eyes at a spawn: no swoop down from the god view, no sandbox key hint
  await pov.enter({ swoop: 0, hint: false });
  mark('entered');
  if (!pov.player) return false;   // (it couldn't drop in: pov.enter said why)
  return game.start(mode, { fresh });
}
// maps.js is plain data the menu loads on its own: it must agree with the tables here
for (const m of MAPS) {
  const dims = m.size in WORLDS ? worldOf(WORLDS[m.size], sceneByKey(m.scene)).size : SIZES[m.size];
  const ok = dims && dims.every((n, i) => n === m.dims[i]) && (isWorld(m) ? m.size in WORLDS && sceneByKey(m.scene).key === m.scene : m.size in SIZES);
  if (!ok) console.error(`maps.js: map '${m.key}' doesn't match app.js (size '${m.size}', ${m.dims.join('×')})`);
}
if (WORLD_DIMS.some((n, i) => n !== WORLD_SIZE[i])) console.error('maps.js: WORLD_DIMS is not shaders/far.js WORLD_SIZE');
// cells [nx, ny, nz] for a toast: '128^3' (as maps.js sizeTag), '160 × 96 × 160'; for the HUD: '2.1M'
const dimsName = (d) => (d.every((n) => n === d[0]) ? `${d[0]}^3` : d.join(' × '));
const millions = (d) => `${(d[0] * d[1] * d[2] / 1e6).toFixed(1)}M`;

// what undoing a scene load names: its map ('Undone Lab'), and the Empty map, TPT's Clear
function sceneLabel(preset) { return preset === 'empty' ? 'Clear' : MAPS.find((m) => m.preset === preset)?.name ?? preset; }
function loadPreset(name, undoable = true) {
  if (graphicsFailure) throw graphicsFailure;
  if (undoable && mp.guard()) return false;
  if (undoable && !win) sim.snapshot(sceneLabel(name));
  settings.preset = name;
  if (win) {
    // A world has one scene, its own: loading starts it over (and can't be
    // undone). Its passes compile in the background first (the first time):
    // till then the window is empty air, and the world fills in when they're done.
    const w = win, epoch = w.epoch;
    if (!w.loaded) sim.clear();
    w.whenReady().then(() => {
      if (win !== w || w.epoch !== epoch) return;   // rebuilt or loaded meanwhile (load bumps the epoch)
      w.load(worldStart());
      placeVolume();
      post.reset();
      pov?.worldReplaced();
      birds?.worldReplaced();
      worldShrine();
    }, (err) => console.error('world: its passes failed to compile, or its scene to prepare', err));
    toolbar.setUndoEnabled(false);
  } else if (name === 'empty') sim.clear();
  else if (name === 'island') loadIsland(sim, { seed: worldSeed });
  else arenaLayout = buildPreset(name, sim);
  if (win || !(name in ARENA_GRID)) arenaLayout = null;
  resetSimModes();
  post.reset();
  signs?.clear();
  resetSpawners(name);
  pov?.worldReplaced();
  save();
  return true;
}

// A new scene clears the spawners; the lab comes with an enemy spawner of its
// own. An arena sets its shrines' perk orbs, its team banners, and player
// spawners at red's spawn points (V drops you into the red base).
function resetSpawners(name) {
  birds?.worldReplaced();
  perkOrbs?.clear();
  arenaMarkers?.clear();
  pov?.vehicles.spawnLayout(arenaLayout);   // an arena's jeeps and hoverbikes (null clears the last arena's)
  pov?.game.useLayout(arenaLayout);          // its spawns, flags, hills and core for the team games (null: the lab's)
  if (!spawners) return;
  spawners.clear();
  if (name === 'lab' && !win) spawners.add(SPAWNER.ENEMY, new THREE.Vector3(Math.round(sim.g.nx * LAB_ENEMY_AT[0]), 0, Math.round(sim.g.nz * LAB_ENEMY_AT[1])));
  const a = arenaLayout;
  if (!a) return;
  for (const p of a.spawns.red) spawners.add(SPAWNER.PLAYER, new THREE.Vector3(p[0] + 0.5, p[1], p[2] + 0.5));
  for (const s of a.shrines) perkOrbs?.shrineAt(shrineAltars(s).map((p) => new THREE.Vector3(...p)));
  arenaMarkers?.set(ARENA_BANNERS[name] ?? []);
}
// the loaded arena's layout (arenas/damValley.js DAM_VALLEY_LAYOUT), else null: __app.arena
let arenaLayout = null;
let arenaMarkers = null;   // its team banners (arenas/markers.js)

// ---------------------------------------------------------------- Descent's level switch
// Descent (docs/descent-contract.md, "D"): each level is its own world scene;
// the temple's exit loads the next one here, in the same session, and drops
// the body in at its spawn. The POV shell, the body (health, perks, statuses),
// the toolbelt, the run's wands (wands/descentRun.js) and gold (pov.descent)
// all outlive build(), so the run comes through: nothing is rebuilt but the world.
let descent = null;   // pov/descent/switch.js createDescentRunner, made with the POV shell
const descentFeet = new THREE.Vector3();
// a level's spawn as grid feet (the middle of its cell), or null
function descentSpawn(level) {
  if (!level?.spawn || !sim) return null;
  const [x, y, z] = level.spawn;
  return new THREE.Vector3(x + 0.5, y, z + 0.5).sub(sim.origin);
}
// Load world scene `key` (as the map menu does a world map) and resolve once its window has filled.
function descentLoad(key) {
  settings.scene = key;
  setSize('world');
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (win?.loaded && win.scene.key === key) resolve();
      else if (performance.now() - t0 > LOAD_WAIT_MS) reject(new Error(`Descent: '${key}' took too long to load`));
      else setTimeout(check, LOAD_POLL_MS);
    };
    check();
  });
}
function descentFrame() {
  const p = pov?.player;
  const live = !!(win && p && pov.mode === 'on' && !p.dead);
  descent.frame({
    key: win ? settings.scene : null,
    feet: live ? descentFeet.copy(p.pos).add(sim.origin) : null,
    live, load: win,
  });
}

// ---------------------------------------------------------------- signs (optional module)
const signLayer = Object.assign(document.createElement('div'), { className: 'sign-layer' });
Object.assign(signLayer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 4 });
document.body.append(signLayer);
let signs = null;
let builds = null; // constructions (optional module)
let pov = null;    // first-person mode (src/pov)
let scripts = null; // the scripting console, ` (src/console)

// ---------------------------------------------------------------- picking & brush
const pointer = new THREE.Vector2();
let pointerInside = false;
let pointerClient = [0, 0];
const raycaster = new THREE.Raycaster();
const hover = { valid: false, cell: new THREE.Vector3(), face: 0, id: -1, T: 0, P: 0 };
let painting = false;
let strokeTool = E.SAND;   // what the stroke under way paints: the selected tool, or the tool gun's eraser
let strokeDist = 0;        // cells from the eye along the aim that a tool gun stroke of an element pours at
let toolGunOut = false;    // the tool gun is in hand this frame (toolGun.aim)
let dragY = 0;
const brushCenter = new THREE.Vector3();
let brushValid = false;
// The Wind tool blows the way the brush moves (TPT WIND.cpp takes the mouse's
// motion between frames): where the stroke last painted, in world cells, so a
// moving World window (docs/scaling.md D11) doesn't count as a gust.
const windFrom = new THREE.Vector3();
let windFromValid = false;
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
  const from = sim, o = sim.origin.clone();
  renderer.readRenderTargetPixelsAsync(pickTarget, 0, 0, 2, 1, pickBuf).then(() => {
    pickPending = false;
    if (from !== sim) return;   // a new grid since
    hover.valid = pickBuf[3] >= 0;
    if (hover.valid) {
      pickedNow(hover.cell.set(pickBuf[0], pickBuf[1], pickBuf[2]), o);
      hover.valid = inWindow(hover.cell);
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
  const o = sim.origin.clone();
  return renderer.readRenderTargetPixelsAsync(rayTarget, 0, 0, 2, 1, buf).then(() => {
    const cell = pickedNow(new THREE.Vector3(buf[0], buf[1], buf[2]), o);
    return { valid: buf[3] >= 0 && inWindow(cell), cell, face: buf[3], id: Math.round(buf[4]), T: buf[5], P: buf[6] };
  });
}

const isTool = () => settings.tool < 0;
const faceNormal = (face) => {
  const n = new THREE.Vector3();
  n.setComponent(Math.floor(face / 2), face % 2 === 0 ? 1 : -1);
  return n;
};

// an element's brush sits on the hovered face; a brush tool's (erase, heat) is centred in the hovered cell
function hoverBrushCenter(out, tool = settings.tool) {
  const axis = Math.floor(hover.face / 2);
  const sign = hover.face % 2 === 0 ? 1 : -1;
  out.copy(hover.cell).addScalar(0.5);
  if (tool >= 0 || hover.id < 0) out.setComponent(axis, out.getComponent(axis) + sign * (settings.radius + 0.5));
  return out;
}

const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const tmpV = new THREE.Vector3();
function updateBrush() {
  const g = sim.g;
  brushValid = false;
  if (pov?.active) { shapeDrag = null; updateGunBrush(); return; }
  if (isBrush(settings.tool)) {
    if (painting || shapeDrag) {
      // a box's brush stops at its walls; a world's window has none, so beyond it there's no brush
      if (planePoint(tmpV)) { brushCenter.copy(tmpV); brushValid = true; }
    } else if (hover.valid) {
      hoverBrushCenter(brushCenter);
      brushValid = true;
    }
  }
  if (brushValid) clampToGrid(brushCenter);
  if (shapeDrag) {
    if (brushValid) shapeDrag.end.copy(brushCenter);
    showShapeDrag();
    return;
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

const clampToGrid = (v) => v.set(THREE.MathUtils.clamp(v.x, 0, sim.g.nx), THREE.MathUtils.clamp(v.y, 0, sim.g.ny), THREE.MathUtils.clamp(v.z, 0, sim.g.nz));
// Where the pointer's ray meets the paint plane (the height a press started at), if in the grid's window.
function planePoint(out) {
  plane.constant = -dragY;
  return !!gridRay().intersectPlane(plane, out) && (!win || inWindow(out));
}

// ---------------------------------------------------------------- TPT's editing tools (src/editing.js)
// Line, box and flood fill (TPT's GameView.cpp UpdateDrawMode): Shift-drag draws
// a line, Ctrl-drag a box, Ctrl+Shift-click fills. ⌘ stands in for Ctrl, as a
// Mac's Ctrl-click is a right click. As in TPT the mode is fixed when the button
// goes down, and a line or box is put down when it comes up; one undo step each.
// TPT's Alt snaps them to 45°; Alt orbits here, so there's no snapping.
let shapeDrag = null;   // { kind: 'line' | 'box', start, end (grid cells on the paint plane) } while one is dragged
const drawModeOf = (e) => {
  const ctrl = e.metaKey || e.ctrlKey;
  return ctrl && e.shiftKey ? 'fill' : ctrl ? 'box' : e.shiftKey ? 'line' : null;
};
// TPT's tools (heat, cool, pressure: DEFAULT_TOOL_*) and particles don't flood fill: they paint as usual
const fills = (tool) => tool >= 0 || tool === ERASE_TOOL || tool === PROP_TOOL;

function startShape(kind) {
  const start = new THREE.Vector3();
  if (!planePoint(start)) return false;
  clampToGrid(start);
  shapeDrag = { kind, start, end: start.clone() };
  hud.dismissHint();
  return true;
}
// the line or box ghost while dragging (TPT's RenderLine and RenderRect previews)
const ghostA = new THREE.Vector3(), ghostB = new THREE.Vector3(), ghostHalf = new THREE.Vector3();
const toScene = (out, v) => out.copy(v).multiplyScalar(scale).add(volume.position);
function showShapeDrag() {
  const { kind, start, end } = shapeDrag, color = toolById(settings.tool).color;
  if (kind === 'line') {
    brush.setLine({ from: toScene(ghostA, start), to: toScene(ghostB, end), radius: settings.radius * scale, shape: settings.shape, color });
  } else {
    const b = boxFromCorners(start, end, settings.radius, [sim.g.nx, sim.g.ny, sim.g.nz]);
    brush.setBox({ position: toScene(ghostA, b.center), half: ghostHalf.fromArray(b.half).multiplyScalar(scale), color });
  }
}
// Put the line or box down (button up).
function finishShape() {
  const d = shapeDrag;
  shapeDrag = null;
  if (!d) return;
  const tool = settings.tool;
  const stroke = { ...brushStroke(tool), center: d.start, rate: oneShotRate(tool, settings.rate) };
  if (d.kind === 'line') stroke.end = d.end;
  else {
    const b = boxFromCorners(d.start, d.end, settings.radius, [sim.g.nx, sim.g.ny, sim.g.nz]);
    Object.assign(stroke, { center: new THREE.Vector3().copy(b.center), shape: 1, grow: b.grow });
  }
  if (!mp.isGuest) {
    sim.snapshot(`${toolById(tool)?.name ?? 'Shape'} ${d.kind}`);   // 'Undone Sand line'
    toolbar.setUndoEnabled(true);
  }
  paintStroke(stroke);
  pacer.wake();
}

// Replace mode and specific delete (TPT's REPLACE_MODE and SPECIFIC_DELETE,
// Editing.cpp CreatePartFlags) keep to the target element when one is set
// (TPT's replaceModeSelected). X keeps its meaning with no target: paint over
// anything; with one, only that element is painted over (TPT's replace mode).
const targetOn = () => (settings.replace || settings.specificDelete) && settings.replaceTarget >= 0;
function propValue() {
  const field = propIndex(settings.propField);
  const r = parseProp(field, settings.propText);
  return r.ok ? { field, value: r.value } : null;
}
// A stroke of `tool` with the brush as it is now (its centre is brushCenter's).
function brushStroke(tool) {
  return {
    center: brushCenter, radius: settings.radius, shape: settings.shape, tool, rate: settings.rate, replace: settings.replace,
    filter: targetOn() ? settings.replaceTarget : -1, erase: settings.specificDelete,
    prop: tool === PROP_TOOL ? propValue() : null,
  };
}
const paintStroke = (stroke) => (mp.isGuest ? mp.paint(stroke) : sim.paint(stroke));   // a guest's goes to the host

function editModeText() {
  const t = ELEMENTS[settings.replaceTarget]?.name;
  if (settings.specificDelete) return t ? `Deleting only ${t}` : 'Specific delete';
  if (settings.replace) return t ? `Replacing only ${t}` : 'Replace mode';
  return null;
}
// One at a time (TPT's GameController::SetReplaceModeFlags): turning one on turns the other off.
function setEditMode(patch) {
  Object.assign(settings, patch);
  if (patch.replace) settings.specificDelete = false;
  if (patch.specificDelete) settings.replace = false;
  dock.sync();
  hud.setEditMode(editModeText());
  save();
}
const EDIT_MODE_TOASTS = {
  replace: ['Replace mode off', 'Replace mode on: paints over anything (Alt+click a tile to keep to one element)'],
  specificDelete: ['Specific delete off', 'Specific delete on: the brush erases anything (Alt+click a tile to keep to one element)'],
};
function toggleEditMode(key) {
  setEditMode({ [key]: !settings[key] });
  hud.toast(settings[key] && settings.replaceTarget >= 0 ? editModeText() : EDIT_MODE_TOASTS[key][+settings[key]]);
}
// The target (TPT's Ctrl+Alt-click on an element button): picking one turns
// replace mode on unless specific delete is; picking it again clears it.
function setTarget(id) {
  const clear = id === settings.replaceTarget || !(id >= 0);
  setEditMode({ replaceTarget: clear ? -1 : id, ...(!clear && !settings.specificDelete ? { replace: true } : {}) });
  hud.toast(clear ? 'No target: replace and delete touch any element' : `${editModeText()}. Alt+click it again to clear`);
}
function targetHovered() {
  if (pointerInside && !uiHover && hover.valid && hover.id > 0) setTarget(hover.id);
  else hud.toast('Point at an element to make it the target');
}
// TPT's Ctrl+P: the Property tool, its window open
function openProp() {
  selectTool(PROP_TOOL);
  dock.openProp();
}

// Ctrl+Shift-click (TPT's DrawFill). An element fills the open air it was
// clicked into (FloodParts fills empty space), up to the top of the brush: in
// 3D open air would fill the sky, so the brush gives the fill a level, the way
// a liquid finds one. With replace mode on it fills over the connected cells of
// what was clicked instead. Erase, specific delete and PROP take the connected
// cells of what was clicked (FloodParts with no element, flood_prop).
const FILL_REFUSED = {
  start: 'Nothing to fill there',
  cap: `Too big to fill at once (over ${FLOOD_MAX_CELLS.toLocaleString()} cells). An element's fill rises to the top of the brush: try a smaller one`,
  edge: 'That runs on past the simulated area: fill something smaller',
  gone: 'The world changed before the fill: try again',
};
function fillAt() {
  if (!hover.valid) { hud.toast('Click a surface to fill from', { kind: 'error' }); return; }
  const tool = settings.tool, st = brushStroke(tool);
  let cell, id, maxY = sim.g.ny - 1;
  if (tool >= 0 && !settings.replace && !settings.specificDelete) {
    cell = hover.cell.clone().add(faceNormal(hover.face));
    id = FILL_AIR;
    maxY = Math.floor(hoverBrushCenter(tmpV).y + settings.radius - 0.5);
  } else {
    cell = hover.cell.clone();
    id = hover.id;
    if (id < 0) { hud.toast(FILL_REFUSED.start, { kind: 'error' }); return; }
    if (st.filter >= 0 && id !== st.filter) { hud.toast(`${editModeText()}: click ${ELEMENTS[st.filter].name} to fill it`); return; }
  }
  const req = { cell: cell.toArray(), id, maxY, stroke: { ...st, rate: oneShotRate(tool, settings.rate) } };
  delete req.stroke.center;
  hud.dismissHint();
  if (mp.isGuest) { mp.fill(req); return; }
  runFill(sim, req, { openSides: !!win, before: () => { sim.snapshot(`${toolById(tool)?.name ?? 'Flood'} fill`); toolbar.setUndoEnabled(true); } })
    .then((r) => { pacer.wake(); hud.toast(r.error ? FILL_REFUSED[r.error] : `Filled ${r.count.toLocaleString()} cells`, { kind: r.error ? 'error' : 'generic' }); })
    .catch((err) => { console.error('Fill failed', err); hud.toast('The fill failed'); });
}

// Whether the brush shows for `id`: everything but signs, spawners and constructions (lightning's sets its width).
const isBrush = (id) => id !== SIGN_TOOL && !isBuild(id) && !isSpawnerTool(id);

// First person: the brush and the construction ghost only show with the tool gun
// out, at the crosshair (the pick follows it there: requestPick). An element's
// stroke stays at the distance it started at, along the aim, as the god view's
// stays on its drag plane, so a held pour doesn't climb up its own heap toward
// you; a brush tool's (erase, heat) follows the crosshair into what it works on.
function updateGunBrush() {
  const g = sim.g;
  const out = toolGunOut;
  toolGunOut = false;   // the gun says so again next frame (toolGun.aim), while it's in hand
  if (!out) painting = false;
  const tool = painting ? strokeTool : settings.tool;
  if (out && isBrush(tool)) {
    if (painting && tool >= 0) {
      if (pov.aimRay(povRay.origin, povRay.direction)) {
        brushCenter.copy(povRay.origin).addScaledVector(povRay.direction, strokeDist);
        brushValid = !win || inWindow(brushCenter);
      }
    } else if (hover.valid) {
      hoverBrushCenter(brushCenter, tool);
      brushValid = true;
    }
  }
  if (brushValid) {
    brushCenter.x = THREE.MathUtils.clamp(brushCenter.x, 0, g.nx);
    brushCenter.y = THREE.MathUtils.clamp(brushCenter.y, 0, g.ny);
    brushCenter.z = THREE.MathUtils.clamp(brushCenter.z, 0, g.nz);
  }
  brush.set({
    visible: brushValid,
    position: tmpV.copy(brushCenter).multiplyScalar(scale).add(volume.position),
    radius: settings.radius * scale,
    shape: settings.shape,
    color: toolById(tool).color,
  });
  builds?.update({ hover, active: out && isBuild(settings.tool), crosshair: true });
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
  const wand = wandPresetForTool(id);
  if (wand) {
    pov?.equipWand(wand).catch((err) => { console.error('Wand equip failed', err); hud.toast('Could not equip this wand. Try entering first person with V.'); });
    return;   // Never save or send starter IDs to the paint shader.
  }
  if (!isBuild(id)) lastPaintTool = id;
  if (isDecoTool(id) && sim) prepareDeco(sim);   // its passes compile while the colour is picked (src/deco.js)
  settings.tool = id;
  const it = toolById(id);
  const accent = accentFor(it.color);
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-ink', inkFor(accent));
  card.show(id);
  dock.sync();
  save();
}

// A first-person tool from the palette's Tools group (GMod's spawn menu): every
// tool is carried (inventory.js), so it goes in hand, now in first person or at the next drop-in.
function giveGear(id) {
  const it = toolById(id);
  const g = gearByKey(it.gear);
  inventory.give(g.key);
  const slot = `key ${g.slot + 1} (${SLOTS[g.slot]})`;
  if (pov?.active) {
    pov.closeMenu();
    hud.toast(`${it.name}: ${slot}`);
  } else hud.toast(`${it.name} is in your tools: press V, then ${slot}`);
}

// Anything else picked from the spawn menu in first person loads the tool gun
// (toolGun below) and puts it in hand, as Garry's Mod's Q menu does with a tool.
function loadToolGun() {
  const it = toolById(settings.tool), g = gearByKey('TOOLGUN');
  inventory.give(g.key);
  pov.closeMenu();
  hud.toast(`${it.name} in the ${g.name}: left-click spawns, right-click erases (key ${g.slot + 1})`);
}

// Closing a construction's options goes back to the last element or tool.
function leaveBuild() { if (isBuild(settings.tool)) selectTool(lastPaintTool); }

let menuPick = null;   // the spawn menu's last pick: Q in first person opens the menu where it was left
const dock = createDock({
  settings,
  onSelect: (id) => {
    menuPick = id;
    if (isGearTool(id)) giveGear(id);
    else {
      selectTool(id);
      if (pov?.active && !wandPresetForTool(id)) loadToolGun();
    }
  },
  onBrushChange: (patch) => {
    if ('replace' in patch || 'specificDelete' in patch || 'replaceTarget' in patch) setEditMode(patch);
    else { Object.assign(settings, patch); dock.sync(); save(); }
  },
  onHover: (id) => card.show(id ?? settings.tool),
  onEyedropper: () => setEyedropper(!eyedropper),
  onDecoToggle: () => toggleDeco(),
  onTarget: setTarget,
});
hud.setEditMode(editModeText());

// TPT's Ctrl+B (src/gui/game/GameView.cpp): draw decoration or not. The paint
// stays either way (src/deco.js); off, everything draws as if undecorated.
function toggleDeco() {
  decoView.show = !decoView.show;
  dock.sync();
  pacer.wake();
  hud.toast(decoView.show ? 'Decoration shown' : 'Decoration hidden');
}

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
  // (in a world, over where the camera is looking: home is wherever you are)
  resetCamera: () => {
    if (win) homeOver(controls.target.x / scale + anchor.x, controls.target.z / scale + anchor.y);
    rig.reset();
    hud.toast('Camera reset');
  },
  screenshot: () => { wantShot = true; },
  saveGame: () => saveGame(),
  // the map menu on its Saves list (Garry's Mod's Saves; ⌘O)
  openSaves: () => { painting = false; launch.openMenu?.({ saves: true }); },
  firstPerson: () => { painting = false; pov?.toggle(); },
  // 'god' leaves the walking body; 'first' / 'third' drops in, or switches the camera if already in
  setCamera: (id) => {
    if (!pov) { hud.toast('Your body is still loading'); return; }
    if (id === 'god') { if (camState() !== 'god') pov.exit(); return; }
    pov.camera.third = id === 'third';
    if (camState() === 'god') { painting = false; pov.enter(); }
  },
  toggleSettings: () => setSettingsOpen(!settingsPanel.isOpen),
  toggleHelp: () => help.setOpen(!help.isOpen),
  // the start menu over the game (src/main.js), the way Garry's Mod's Esc brings up its menu
  openMenu: () => { painting = false; launch.openMenu?.(); },
  setView,
  renderThumb,
};
const toolbar = createToolbar({ views: VIEWS, settings, actions });
const mp = createMultiplayer({ renderer, scene, camera, hud, getSim: () => sim, getVolume: () => volume, setGrid, inWorld: () => !!win, score: () => scoreboard.mine });
// Tab held: Garry's Mod's scoreboard (ui/scoreboard.js), in the body and in the god view, while
// you're on the world: with the mouse held by the body, or nothing focused (a click on the world
// lets go of the controls: press). With a control or a dialog focused, Tab moves through them.
const scoreboard = createScoreboard({
  wantsTab() {
    if (isTyping() || pov?.editingWand) return false;
    const a = document.activeElement;
    return !!pov?.locked || !a || a === document.body || a === renderer.domElement;
  },
  map: () => mapOf(settings)?.name ?? null,
  match: () => pov?.game?.scoreboard?.() ?? null,
  session: () => mp.players,
  dead: () => !!(pov?.active && pov.player?.dead),
});

const fmtSpeed = (v) => `${v}×`;
// the drawer's Map row: the map's name and size, and Change map (the start menu)
function mapRow() {
  const name = h('span.map-name'), tag = h('span.map-tag');
  const change = h('button.btn', { type: 'button', text: 'Change map', on: { click: () => { setSettingsOpen(false); actions.openMenu(); } } });
  const sync = () => {
    const m = mapOf(settings);
    name.textContent = m?.name ?? 'Custom';
    // (a box at a size its map isn't, from an old save or a link: the grid's own)
    tag.textContent = m && (isWorld(m) || settings.size === m.size) ? sizeTag(m) : dimsName(SIZES[settings.size] ?? []);
  };
  return { type: 'custom', el: h('div.map-row', {}, name, tag, change), sync };
}
const fmtTime = (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`;
const settingsPanel = createSettings({
  settings,
  onClose: () => setSettingsOpen(false),
  // Sections and their rows run from most to least reached-for; keep that order when adding settings.
  sections: [
    // the map playing (maps.js: a scene at its own size); the start menu changes it
    { title: 'Map', rows: [mapRow()] },
    { title: 'Simulation', rows: [
      { type: 'slider', key: 'steps', label: 'Speed (steps per frame)', min: 1, max: 12, step: 1, def: DEFAULTS.steps, fmt: fmtSpeed, onChange: save },
      { type: 'slider', key: 'gravity', label: 'Gravity', min: 0, max: 0.06, step: 0.005, def: DEFAULTS.gravity,
        fmt: (v) => `${(v / DEFAULTS.gravity).toFixed(1)} g`, onChange: (v) => { sim.gravity = v; save(); } },
      // TPT's Simulation Options: gravity, air, ambient heat and edge modes (simModes.js)
      ...simModeRows({ change: setSimMode, locked: simModeLock }),
    ] },
    // a cost lever too: sim work grows with cells, ray marching with the grid's span
    { title: 'Lighting', rows: [
      // the day is held at this hour (DAY.running)
      { type: 'slider', key: 'time', label: 'Time of day', min: 0, max: HOURS - TIME_STEP, step: TIME_STEP, def: DAY.startPhase * HOURS,
        fmt: fmtTime, onChange: (v) => { day.clock = phaseSteps(v / HOURS); updateSun(); } },
      // each costs GPU time; turning one off restores the softer probe-only light
      ...[['nearGI', 'Contact Shadows'], ['glowLights', 'Lava Lights'], ['caustics', 'Caustics']]
        .map(([key, label]) => ({ type: 'seg', key, options: [[true, `${label}: On`], [false, 'Off']],
          onChange: (v) => { settings[key] = v; save(); } })),
    ] },
    // the scene renders at a share of the screen's pixels and TAA rebuilds full detail over frames
    { title: 'Upscaling', rows: [
      { type: 'seg', key: 'upscale', options: [['native', 'Off'], ['quality', 'Quality'], ['balanced', 'Balanced'], ['performance', 'Fast']],
        onChange: (v) => { settings.upscale = v; save(); } },
    ] },
    // each switch shows its measured cost; expensive ones start off (gfx/detail.js)
    // Balanced = each feature's cost-tier default; Customize has a switch per feature with its cost (gfx/detail.js)
    ...(DETAIL.length ? [{ title: 'Detail up close', rows: detailRows(settings, () => { applyDetail(); save(); }) }] : []),
    { title: 'Camera', rows: [
      { type: 'slider', key: 'camSpeed', label: 'Move speed (WASD)', min: 0.25, max: 3, step: 0.05, def: DEFAULTS.camSpeed,
        fmt: (v) => `${v.toFixed(2)}×`, onChange: (v) => { rig.setSpeed(v); save(); } },
    ] },
    // The body you see in third person and when you die: Realistic (a
    // skinned, animated, shredded superhero in a wizard's hat and purple
    // boxers, the default) or Stickman (the TPT homage). It switches live, in POV too.
    { title: 'First person', rows: [
      { type: 'seg', key: 'character', options: [['real', 'Realistic'], ['stick', 'Stickman']],
        onChange: (v) => { settings.character = v; save(); pacer.wake(); } },
      // named as Minecraft names them
      { type: 'slider', key: 'sensitivity', label: 'Mouse Sensitivity', min: SENSITIVITY_RANGE[0], max: SENSITIVITY_RANGE[1], step: 0.05,
        def: DEFAULTS.sensitivity, fmt: (v) => `${Math.round(v * 100)}%`, onChange: save },
      { type: 'slider', key: 'povFov', label: 'FOV', min: POV_FOV_RANGE[0], max: POV_FOV_RANGE[1], step: 1,
        def: DEFAULTS.povFov, fmt: (v) => `${v}`, onChange: save },
      { type: 'seg', key: 'viewBobbing', options: [[true, 'View Bobbing: On'], [false, 'Off']],
        onChange: (v) => { settings.viewBobbing = v; save(); } },
      { type: 'seg', key: 'sprintMode', options: [['hold', 'Sprint: Hold'], ['toggle', 'Toggle']],
        onChange: (v) => { settings.sprintMode = v; save(); } },
    ] },
    ...(accountsEnabled ? [accountSection({ toast: (text, opts) => hud.toast(text, opts) })] : []),
    // for working on the app itself (the frame loop applies it)
    { title: 'Developer', rows: [
      { type: 'seg', key: 'profiler', options: [[false, 'Profiler off'], [true, 'Profiler on']],
        onChange: (v) => { settings.profiler = v; save(); } },
    ] },
  ],
  footer: [['Reset all settings', resetSettings]],
});

// Close-up detail features compile in only when switched on (gfx/detail.js),
// and into the view only while the camera is near enough for them to show
// (gfx/detailGate.js). The shadow map sees every switched-on feature.
let detailVersion = 0;
const DETAIL_FOAM = DETAIL.find((f) => f.key === 'liquidFoam');   // whitewater also runs a field with the sim
const detailGate = createDetailGate(renderer, () => pacer.wake(), () => hud.toast('Preparing close-up detail… the first time after an update this can take several seconds'));
// The view program's first draw after an update freezes the page while the
// GPU driver builds it: say so first (gfx/coldShader.js), on the start menu's
// loading screen too while it is up.
const coldShader = createColdShaderGuard(() => { hud.toast('Loading something cool, please be patient'); launch.progress?.('cold'); });
function applyDetail() {
  shadowMat.defines = detailDefines(settings);
  shadowMat.needsUpdate = true;
  setAeration(sim, !!settings[settingKey(DETAIL_FOAM)]);   // whitewater's per-step field
  detailGate.configure(volume, settings, camera, scene);
  detailVersion++;   // the shadow map is a derived pass: redo it
  post.reset();
}

// Accounts: take the session the relay just sent back (#tpt3d_session=…) and say how it went
const signInResult = finishSignIn();
if (signInResult.error) hud.toast(signInResult.error);
account().then((user) => { if (signInResult.signedIn && user) hud.toast(`Signed in as ${user.name}`); });

function resetSettings() {
  const keep = { size: settings.size, preset: settings.preset, scene: settings.scene, tool: settings.tool, paused: settings.paused, dockCollapsed: settings.dockCollapsed };
  Object.assign(settings, DEFAULTS, keep);
  sim.gravity = settings.gravity;
  rig.setSpeed(settings.camSpeed);
  applyDetail();
  dock.sync();
  toolbar.sync();
  hud.setEditMode(editModeText());
  save();
  hud.toast('Settings reset', { kind: 'cleanup' });
}

// Simulation modes (simModes.js): options of the world playing, so the host's
// alone; a fresh scene starts them over at their defaults, or its map's.
function setSimMode(key, v, toast = false) {
  if (mp.guard()) return;
  if (simModeLock(key)) { hud.toast(simModeLock(key)); return; }
  settings[key] = v;
  applySimModes(sim, settings);
  settingsPanel.sync();
  if (toast) hud.toast(modeToast[key](settings[key]));
}
function simModeLock(key) {
  if (mp.isGuest) return 'The host sets these';
  if (key === 'edgeMode' && win) return 'World\'s edges stay solid: past them is the rest of the island, not the void';
  return false;
}
// a world's modes, all at once (a map's; a saved world's, after its scene has loaded)
function setSimModes(modes) {
  Object.assign(settings, sanitizeModes(modes));
  applySimModes(sim, settings);
  settingsPanel.sync();
}
function resetSimModes() { setSimModes({ ...SIM_MODE_DEFAULTS, ...mapOf(settings)?.modes }); }

// The Simulation options in the console by TPT's Lua names and numbers
// (src/lua/LuaSimulation.cpp gravityMode, airMode, ambientHeatSim, edgeMode):
// no argument reads, one sets. TPT numbers its edges void 0, solid 1, loop 2
// (SimulationSettings.h EdgeMode); ours start at solid.
const TPT_EDGES = [EDGE.VOID, EDGE.SOLID, EDGE.LOOP];
function consoleMode(key, toOurs = (v) => v, toTpt = (v) => v) {
  return function (v) {
    if (v === undefined || v === null) return toTpt(settings[key]);
    const ours = toOurs(v);
    if (sanitizeModes({ ...settings, [key]: ours })[key] !== ours) throw new Error(`${key}: no mode ${v}`);
    const lock = simModeLock(key);
    if (lock) throw new Error(lock);
    setSimMode(key, ours);
    return toTpt(settings[key]);
  };
}
registerConsoleApi('sim', 'gravityMode', consoleMode('gravityMode'),
  { args: '[mode]', doc: 'Gravity: 0 vertical, 1 off, 2 radial (toward the box centre).', writes: true });
registerConsoleApi('sim', 'airMode', consoleMode('airMode'),
  { args: '[mode]', doc: 'Air: 0 on, 1 pressure off, 2 velocity off, 3 off, 4 no update.', writes: true });
registerConsoleApi('sim', 'ambientHeatSim', consoleMode('ambientHeat', (v) => !!v),
  { args: '[on]', doc: 'Ambient heat: whether air holds and trades heat.', writes: true });
registerConsoleApi('sim', 'edgeMode', consoleMode('edgeMode', (v) => TPT_EDGES[v] ?? -1, (v) => TPT_EDGES.indexOf(v)),
  { args: '[mode]', doc: 'Box edges (TPT numbering): 0 void, 1 solid, 2 loop. World keeps solid.', writes: true });
// TPT's sim.decoColor: the deco tools' colour, read as a packed 0xAARRGGBB, set
// packed or as r, g, b[, a] (0-255).
const BYTE = 256;
registerConsoleApi('sim', 'decoColor', function (r, g, b, a) {
  if (r !== undefined && r !== null) {
    const rgba = g === undefined || g === null
      ? [(r >>> 16) & 0xff, (r >>> 8) & 0xff, r & 0xff, (r >>> 24) & 0xff]
      : [r, g, b ?? 0, a ?? BYTE - 1];
    setDecoColor(rgba);
    dock.sync();
  }
  const [cr, cg, cb, ca] = decoView.color;
  return ((ca * BYTE + cr) * BYTE + cg) * BYTE + cb;
}, { args: '[packed | r, g, b[, a]]', doc: 'The deco tools\' colour, as 0xAARRGGBB.', writes: false });

function setSettingsOpen(v) {
  settingsPanel.setOpen(v);
  toolbar.setSettingsOpen(v);
  if (v) toolbar.close();
}

function setPaused(p) {
  if (mp.guard()) return;
  settings.paused = p;
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

function undo() {
  if (mp.guard()) return;
  const { note, label } = sim.history?.at(-1) ?? {};
  const shrine = note?.shrine;
  if (sim.undo()) {
    if (shrine) perkOrbs?.removeShrine(shrine);
    if (note?.scene) restoreSceneExtras(note.scene);   // a loaded save taken back: the box's signs, spawners and orbs too
    pov?.worldReplaced();
    hud.toast(label ? `Undone ${label}` : 'Undone', { kind: 'undo' });   // Garry's Mod's "Undone Prop": it names what was undone
  }
  // (a world's window moved off all of it: it's kept for when the window comes back)
  else hud.toast(sim.canUndo ? 'Too far away to undo that: go back to it first' : 'Nothing to undo', { kind: 'error' });
  toolbar.setUndoEnabled(sim.canUndo);
}

// ---------------------------------------------------------------- saves (src/saves)
// ⌘S or the toolbar's Save keeps the game in the Saves list, with a picture;
// the map menu's Saves (Esc, ⌘O) loads one, exports it as a .tpt3d file or
// opens one. Garry's Mod's way: a save is named for its map and the time, and
// listed with its thumbnail. A box save loads as a scene change, so ⌘Z takes
// it back; a World save, like any world load, can't be undone.
const SAVE_THUMB_BG = '#0e1117';   // what a thumbnail's clear pixels (a box has no sky) sit on: the page's background
const SAVE_THUMB_TYPE = 'image/jpeg', SAVE_THUMB_QUALITY = 0.82;
const MB = 1024 * 1024;
// the gravity and speed a world was saved with come back with it (TPT keeps gravity in a save)
registerSavedSettings(['gravity', 'steps']);
// The decoration layer (src/deco.js) goes with its save, as TPT saves deco with
// each particle: RGBA8 per cell in the save's cell order (format.js packCells),
// and a World's painted bricks outside the window as [brick key u32, its
// bytes] records. Both load after the cells, since Simulation.load wipes the paint.
const DECO_KEY_BYTES = 4;
registerSaveSection('deco', {
  save: () => {
    const data = readDeco(sim);   // (null while nothing is painted)
    if (!data) return undefined;
    const g = sim.g;
    return packCells([g.nx, g.ny, g.nz], (x, y, z) => cellTexel(g, x, y, z), [data]);
  },
  load: (planes, h) => {
    const g = sim.g, data = new Uint8Array(g.width * g.height * DECO_BYTES);
    unpackCells(h.dims, (x, y, z) => cellTexel(g, x, y, z), planes, [data]);
    uploadDeco(sim, data);
  },
});
registerSaveSection('decoStore', {
  save: () => {
    const store = sim.deco?.store;
    if (!store?.size) return undefined;
    const rec = DECO_KEY_BYTES + store.values().next().value.length;
    const out = new Uint8Array(store.size * rec), view = new DataView(out.buffer);
    let at = 0;
    for (const [k, b] of store) { view.setUint32(at, k, true); out.set(b, at + DECO_KEY_BYTES); at += rec; }
    return out;
  },
  load: (bytes) => {
    const store = ensureDeco(sim).store, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rec = DECO_KEY_BYTES + BRICK_CELLS * DECO_BYTES;
    for (let at = 0; at + rec <= bytes.length; at += rec) store.set(view.getUint32(at, true), bytes.slice(at + DECO_KEY_BYTES, at + rec));
  },
});
// The simulation modes (simModes.js) are the world's, as TPT keeps gravity,
// air and edge modes in each save; a save from before them gets its map's
// defaults back, not whatever was on before it loaded.
registerSaveSection('simModes', {
  save: () => Object.fromEntries(SIM_MODE_KEYS.map((k) => [k, settings[k]])),
  load: (m) => setSimModes({ ...SIM_MODE_DEFAULTS, ...mapOf(settings)?.modes, ...m }),
  absent: () => resetSimModes(),
});
const saves = createSaves({
  renderer, settings, getSim: () => sim, getWin: () => win,
  header: () => {
    const m = mapOf(settings);
    return {
      map: m?.key ?? null, mapName: m?.name ?? null, size: settings.size, preset: win ? null : settings.preset,
      world: win ? { scene: settings.scene, seed: worldSeed ?? null } : null,
      guestCopy: mp.isGuest || undefined,   // a guest's copy of the host's world (no velocity or pressure: net/codec.js)
    };
  },
  thumbnail: saveThumbnail,
  prepare: prepareSave,
  finish: () => {
    if (win) placeVolume();
    post.reset();
    pov?.worldReplaced();
    birds?.worldReplaced();
    toolbar.setUndoEnabled(sim.canUndo);
    dock.sync();
    toolbar.sync();
    settingsPanel.sync();
    save();
    pacer.wake();
  },
  onSettings: () => { sim.gravity = settings.gravity; },
});

// The save's picture for the Saves list: the next frame on screen, cropped and
// scaled down, read from the canvas in the frame's own task as the screenshot
// is (saveScreenshot). It draws nothing extra (no second render, no program to
// build). Resolves to a data URL, or null if no frame comes (a parked test page).
const SAVE_THUMB_SIZE = [320, 200];   // px: the views menu's thumbnails' size
const SAVE_THUMB_WAIT_MS = 1500;
function saveThumbnail() {
  return new Promise((resolve) => {
    thumbWaiters.push(resolve);
    pacer.wake();
    setTimeout(() => {
      const i = thumbWaiters.indexOf(resolve);
      if (i >= 0) { thumbWaiters.splice(i, 1); resolve(null); }
    }, SAVE_THUMB_WAIT_MS);
  });
}
function takeSaveThumbnail() {
  const waiting = thumbWaiters;
  thumbWaiters = [];
  let url = null;
  try {
    const src = renderer.domElement, [w, h] = SAVE_THUMB_SIZE;
    const out = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = out.getContext('2d');
    ctx.fillStyle = SAVE_THUMB_BG;
    ctx.fillRect(0, 0, w, h);
    const k = Math.min(src.width / w, src.height / h);   // (cover: the middle of the view)
    ctx.drawImage(src, (src.width - w * k) / 2, (src.height - h * k) / 2, w * k, h * k, 0, 0, w, h);
    url = out.toDataURL(SAVE_THUMB_TYPE, SAVE_THUMB_QUALITY);
  } catch (err) {
    console.warn('save: no thumbnail', err);
  }
  for (const resolve of waiting) resolve(url);
}

// Get the grid ready for a save: its map and size (a rebuild if they differ),
// else an undo snapshot. Resolves false to refuse.
async function prepareSave(h) {
  if (graphicsFailure) throw graphicsFailure;
  if (mp.guard()) return false;
  painting = false;
  pov?.exit(true);   // the body is left out of a save; you come back in the god view
  if (h.world) {
    if (mp.guardWorld()) return false;
    const scene = sceneByKey(h.world.scene);
    if (!(h.size in WORLDS) || scene.key !== h.world.scene) throw new SaveRefused('That save is of a world this version doesn\'t have');
    const seed = h.world.seed ?? undefined;
    if (!win || settings.size !== h.size || settings.scene !== scene.key || worldSeed !== seed) {
      settings.scene = scene.key;
      worldSeed = seed;
      setSize(h.size);
    }
    const w = win;
    if (w.size.some((n, i) => n !== h.world.size?.[i])) throw new SaveRefused('That save\'s world is a different size');
    await w.whenReady();   // (after the world's own start, which the switch queued first)
    return win === w;      // (switched again meanwhile: the newer pick wins)
  }
  const fits = (k) => SIZES[k]?.every((n, i) => n === h.dims[i]);
  const size = fits(h.size) ? h.size : Object.keys(SIZES).find(fits);
  if (!size) throw new SaveRefused(`This version has no ${h.dims.join(' × ')} grid`);
  const preset = h.preset ?? 'empty';
  if (settings.size !== size) {
    settings.preset = 'empty';   // (the save brings the cells: no building the map's scene first)
    setSize(size);
  } else {
    // undoable like any scene change; TPT takes a history snapshot before opening a local save (GameController.cpp OpenLocalBrowse)
    sim.snapshot('Loaded save');
    sim.history.at(-1).note = { scene: sceneExtras() };
  }
  settings.preset = preset;
  // an arena's layout (spawns, flags, shrines) is its build's, without its cells
  arenaLayout = preset in ARENA_PRESETS ? ARENA_PRESETS[preset].build().layout : null;
  signs?.clear();
  resetSpawners(preset);
  return true;
}

// What a box holds besides its cells (its scene, signs, spawners, perk orbs), for undoing a load.
const sceneExtras = () => ({ preset: settings.preset, signs: signs?.toJSON(), spawners: spawners?.toJSON(), perkOrbs: perkOrbs?.toJSON() });
function restoreSceneExtras(x) {
  settings.preset = x.preset;
  arenaLayout = x.preset in ARENA_PRESETS ? ARENA_PRESETS[x.preset].build().layout : null;
  resetSpawners(x.preset);
  spawners?.fromJSON(x.spawners);
  perkOrbs?.fromJSON(x.perkOrbs);
  signs?.fromJSON(x.signs);
  save();
}

// the god camera in world cells, so it comes back over the same ground in a world whose window has moved
const camToCells = (v) => [v.x / scale + anchor.x, v.y / scale, v.z / scale + anchor.y];
const camFromCells = (a, out) => out.set((a[0] - anchor.x) * scale, a[1] * scale, (a[2] - anchor.y) * scale);
registerSaveSection('camera', {
  save: () => (camState() === 'god' ? { position: camToCells(camera.position), target: camToCells(controls.target) } : undefined),
  load: (d) => {
    camFromCells(d.position, camera.position);
    camFromCells(d.target, controls.target);
    controls.update();
  },
  // saved in the body: in a world, the god view over the window (the window would chase a camera left elsewhere)
  absent: () => { if (win) { homeOver(sim.origin.x + sim.g.nx / 2, sim.origin.z + sim.g.nz / 2); rig.reset(true); } },
});
registerSaveSection('day', {
  save: () => ({ clock: day.clock }),
  load: (d) => { if (Number.isFinite(d.clock)) { day.clock = d.clock; updateSun(); } },
});
registerSaveSection('signs', { save: () => signs?.toJSON(), load: (d) => signs?.fromJSON(d), absent: () => signs?.clear() });
registerSaveSection('spawners', { save: () => spawners?.toJSON(), load: (d) => spawners?.fromJSON(d) });
registerSaveSection('perkOrbs', { save: () => perkOrbs?.toJSON(), load: (d) => perkOrbs?.fromJSON(d) });

const saveName = () => {
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  return `${mapOf(settings)?.name ?? 'Custom'} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
let saving = false;
// Save the game into the Saves list. Resolves to the save's meta (saves/local.js), or null.
async function saveGame(name) {
  if (saving) return null;
  saving = true;
  hud.toast('Saving…');
  try {
    const bytes = await saves.capture(cleanName(name) || saveName());
    const meta = await putSave(bytes);
    hud.toast(`Saved "${meta.name}" (${(bytes.length / MB).toFixed(1)} MB). Esc → Saves to load it`);
    return meta;
  } catch (err) {
    if (!(err instanceof SaveRefused)) console.error('save failed', err);
    hud.toast(err instanceof SaveRefused ? err.message : `Couldn't save: ${err.message}`);
    return null;
  } finally {
    saving = false;
  }
}
let loadingSave = false;
// Load a save: a local save's id, or a save file's bytes. Resolves to whether it loaded.
async function openSave(what) {
  if (loadingSave) return false;
  loadingSave = true;
  try {
    const bytes = typeof what === 'string' ? await getSave(what) : what;
    const h = await saves.apply(bytes);
    if (h) hud.toast(`Loaded "${h.name}"${h.world ? '' : sim.canUndo ? ' (⌘Z takes it back)' : ''}`);
    return !!h;
  } catch (err) {
    if (!(err instanceof SaveRefused)) console.error('load failed', err);
    hud.toast(err instanceof SaveRefused ? err.message : `Couldn't load that save: ${err.message}`);
    return false;
  } finally {
    loadingSave = false;
  }
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
  if (pov?.active) {   // POV handles its own mouse buttons, but for the tool gun's middle one:
    // pick up what it aims at, Minecraft creative's pick block (TPT's middle click samples too)
    if (e.button === 1 && pov.locked && pov.toolbelt?.selectedKey === 'TOOLGUN') {
      e.preventDefault();
      if (!pickHovered()) hud.toast('Nothing to pick there. That\'s air.', { kind: 'error' });
    }
    return;
  }
  if (e.pointerType === 'touch') touchDown(e);
  else press(e);
});
function press(e) {
  const wasEditing = !!signs?.editing;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (e.button !== 0 || e.altKey || wasEditing) return; // a click that just finishes editing a sign doesn't paint
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (eyedropper) {
    if (!pickHovered()) hud.toast('Nothing to pick there. That\'s air.', { kind: 'error' });
    return;
  }
  if (clickTool() !== null) return;
  // TPT's PropertyTool does nothing until its window holds a value that reads
  if (settings.tool === PROP_TOOL && !propValue()) { hud.toast('Give the Property tool a value first (⌘P)'); openProp(); return; }
  dragY = hover.valid ? hoverBrushCenter(tmpV).y : (isTool() ? 0.5 : settings.radius);
  const mode = drawModeOf(e);
  if (mode === 'fill' && fills(settings.tool)) { fillAt(); return; }
  if (!((mode === 'line' || mode === 'box') && isBrush(settings.tool) && startShape(mode))) startStroke(settings.tool);
  if (e.pointerType !== 'touch') canvasEl.setPointerCapture(e.pointerId);   // (a touch is captured already)
}

// A click with a one-click tool (a sign, lightning, a spawner, a construction)
// at `hover`: under the cursor in the god view, under the crosshair through the
// tool gun. true if it did something, false if it couldn't (it says why),
// null if the tool paints a stroke instead.
function clickTool() {
  if (isDecoTool(settings.tool) && mp.guard()) return false;   // decoration isn't in the host's stream yet (src/deco.js)
  if (settings.tool === SIGN_TOOL) {
    if (signs && hover.valid) { signs.add({ cell: hover.cell.clone(), normal: faceNormal(hover.face) }); return true; }
    if (!signs) hud.toast('Signs are still loading');
    return false;
  }
  if (settings.tool === LIGHTNING_TOOL) {
    if (mp.guard()) return false;
    if (!hover.valid) { hud.toast('Click a surface to strike it', { kind: 'error' }); return false; }
    sim.snapshot(toolById(LIGHTNING_TOOL).name);
    toolbar.setUndoEnabled(true);
    lightning.strikeTool(sim, hover, settings.radius);
    pacer.wake();
    hud.dismissHint();
    return true;
  }
  if (isSpawnerTool(settings.tool)) {
    if (mp.guard()) return false;
    if (!hover.valid) { hud.toast('Click a surface to set it on', { kind: 'error' }); return false; }
    const kind = SPAWNER_KIND[settings.tool];
    const r = spawners.toggle(kind, feetOnHit(hover));
    pacer.wake();
    if (r === 'full') hud.toast('That many is the limit', { kind: 'error' });   // GMod's LimitHit
    else hud.toast(r === 'removed' ? 'Spawner removed' : SPAWNER_SET[ENEMY_KINDS.includes(kind) ? SPAWNER.ENEMY : kind]);
    return r !== 'full';
  }
  if (isBuild(settings.tool)) {
    if (mp.guard()) return false;
    if (!builds) { hud.toast('Constructions are still loading'); return false; }
    if (!builds.ready) return false;
    sim.snapshot(toolById(settings.tool)?.name);
    toolbar.setUndoEnabled(true);
    lastShrine = 0;
    builds.place();
    // a shrine's orbs go with its snapshot: undoing it takes them away (undo)
    if (lastShrine) { sim.history.at(-1).note = { shrine: lastShrine }; hud.toast('Shrine set: in first person (V), take one perk and the others vanish', { kind: 'hint' }); }
    hud.dismissHint();
    return true;
  }
  return null;
}

// A brush stroke of `tool` from now until the button lets go (undone as one).
function startStroke(tool) {
  if (!mp.isGuest) {
    sim.snapshot(toolById(tool)?.name);
    toolbar.setUndoEnabled(true);
  }
  strokeTool = tool;
  painting = true;
  windFromValid = false;
  hud.dismissHint();
}

// The tool gun (pov/tools/toolgun.tool.js, Garry's Mod's gmod_tool): the god
// view's click at the crosshair, with whatever the spawn menu picked last. In
// first person the pick follows the crosshair (requestPick), so `hover` is
// what the gun points at.
const ERASE_TOOL = TOOLS.find((t) => t.key === 'ERASE').id;   // its right button: TPT's right mouse paints its secondary element, nothing by default
const GUN_AIR_DIST = HAND_REACH;   // cells: a stroke started at the sky pours a hand's reach (Minecraft's) in front of you
const toolGun = {
  get item() { return toolById(settings.tool); },
  // it's in hand this frame: the brush and the construction ghost follow the crosshair (updateGunBrush)
  aim() { toolGunOut = true; },
  // a button went down: 'stroke' while a stroke runs until release(), 'click' for one-click tools, null if nothing happened
  press({ erase = false } = {}) {
    if (signs?.editing) { document.activeElement?.blur?.(); return null; }   // as in the god view, the click that ends a sign's edit does nothing else
    if (!erase) {
      const done = clickTool();
      if (done !== null) {
        // a sign takes typing: free the mouse for it (V or a click on the world takes it back)
        if (done && settings.tool === SIGN_TOOL && document.pointerLockElement) document.exitPointerLock();
        return done ? 'click' : null;
      }
    }
    const tool = erase ? ERASE_TOOL : settings.tool;
    if (tool >= 0) {
      if (!pov.aimRay(povRay.origin, povRay.direction)) return null;
      strokeDist = hover.valid ? hoverBrushCenter(tmpV, tool).distanceTo(povRay.origin) : GUN_AIR_DIST;
    }
    startStroke(tool);
    return 'stroke';
  },
  release() { painting = false; },
};
addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  painting = false;
  if (shapeDrag) finishShape();
});

// Touch: one finger paints, two fingers turn and zoom (controls.touches). A finger
// that lands has no hover pick yet, so it picks where it touched first; and it waits
// TOUCH_PRESS_DELAY_MS, so a second finger starting a turn cancels it before it pours.
const TOUCH_PRESS_DELAY_MS = 90;
const TOUCH_TAP_MS = 120;   // a tap that lifted before the press started still pours this long
const touchesDown = new Set();
let touchPress = 0;          // the pending press's id (0: none)
function touchDown(e) {
  touchesDown.add(e.pointerId);
  if (touchesDown.size > 1) { touchPress = 0; painting = false; return; }
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  pointerClient = [e.clientX, e.clientY];
  pointerInside = true;
  uiHover = false;
  const id = ++touchPress, ray = gridRay();
  Promise.all([pickRay(ray.origin, ray.direction), new Promise((r) => setTimeout(r, TOUCH_PRESS_DELAY_MS))]).then(([hit]) => {
    if (touchPress !== id) return;
    touchPress = 0;
    Object.assign(hover, { valid: hit.valid, face: hit.face, id: hit.id, T: hit.T, P: hit.P });
    hover.cell.copy(hit.cell);
    press(e);
    if (painting && !touchesDown.size) setTimeout(() => { if (!touchesDown.size) painting = false; }, TOUCH_TAP_MS);
  }).catch(() => { if (touchPress === id) touchPress = 0; });
}
const touchUp = (e) => {
  if (e.pointerType !== 'touch') return;
  touchesDown.delete(e.pointerId);
  if (e.type === 'pointercancel') { touchPress = 0; painting = false; }
};
addEventListener('pointerup', touchUp);
addEventListener('pointercancel', touchUp);
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
let timeShown = NaN;   // the time of day the drawer last showed
let wantShot = false;
let thumbWaiters = [];   // saves waiting for the next presented frame as their thumbnail (saveThumbnail)
const wantFrame = () => wantShot || thumbWaiters.length > 0;

addEventListener('keydown', (e) => {
  if (pov?.editingWand) return;
  if (e.key === 'Alt') controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  if (e.key === 'Shift') controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  if (isTyping()) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  // ⌘S saves, ⌘O opens the Saves list: every program's keys (TPT has none: its Save
  // and Open buttons go local with Ctrl held, GameView.cpp saveSimulationButton, searchButton)
  // (in the body Ctrl is the camera key and S walks back: there only ⌘ saves; the toolbar's Save always does)
  const fileMod = e.metaKey || (e.ctrlKey && !pov?.active);
  if (fileMod && e.key.toLowerCase() === 's') { e.preventDefault(); if (!e.repeat) actions.saveGame(); return; }
  if (fileMod && e.key.toLowerCase() === 'o') { e.preventDefault(); if (!e.repeat) actions.openSaves(); return; }
  if (e.ctrlKey && !pov?.active && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleDeco(); return; }   // TPT's key (in the body, Ctrl swims)
  // TPT's Ctrl+; (specific delete) and Ctrl+P (the Property tool): GameView.cpp OnKeyPress
  if (mod && e.key === ';' && !pov?.active) { e.preventDefault(); toggleEditMode('specificDelete'); return; }
  if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) { e.preventDefault(); if (!pov?.active) openProp(); return; }
  if (mod) return;
  const k = e.key;
  // V switches between the god view and the body (Garry's Mod's noclip key). F drops
  // in too, from the god view only: in the body F is the kick.
  if (k === 'v' || k === 'V' || ((k === 'f' || k === 'F') && !pov?.active)) { if (!e.repeat) actions.firstPerson(); return; }
  if ((k === 't' || k === 'T') && mp.chatAvailable) { e.preventDefault(); mp.openChat(); return; } // Minecraft's chat key, POV included
  if (pov?.blocksKey(e)) return;   // POV owns movement, Space and the digits while active
  if (e.code === 'Space') { e.preventDefault(); setPaused(!settings.paused); }
  else if (k === '.') stepOnce = true;
  else if (k === '[') setRadius(settings.radius - 1);
  else if (k === ']') setRadius(settings.radius + 1);
  else if (k === 'b' || k === 'B') { settings.shape ^= 1; dock.sync(); save(); }
  // replace mode: X, or TPT's ; and Insert; specific delete: TPT's Delete (a Mac's delete key is Backspace)
  else if (k === 'x' || k === 'X' || k === ';' || k === 'Insert') toggleEditMode('replace');
  else if (k === 'Delete' || k === 'Backspace') toggleEditMode('specificDelete');
  else if (e.code === 'KeyI' && e.altKey) targetHovered();   // (⌥I types a dead key on a Mac: by its code)
  else if (Object.hasOwn(MODE_KEYS, k.toLowerCase())) { const key = MODE_KEYS[k.toLowerCase()]; setSimMode(key, nextMode(key, settings[key]), true); }   // TPT's Y, U
  else if (k === 'i' || k === 'I') { if (!(pointerInside && !uiHover && pickHovered())) setEyedropper(!eyedropper); }
  else if (k === 'r' || k === 'R') actions.resetCamera();
  else if (k === 't' || k === 'T') dock.toggle();
  else if (k === '/') { e.preventDefault(); dock.focusSearch(); }
  else if (k === ',') actions.toggleSettings();
  else if (k === '?') actions.toggleHelp();
  else if (k === 'p' || k === 'P') actions.screenshot();
  else if (k === 'Escape') {
    const overlay = eyedropper || toolbar.isOpen || settingsPanel.isOpen || help.isOpen || mp.panelOpen || !!shapeDrag;
    shapeDrag = null;   // a line or box being dragged is dropped
    setEyedropper(false); toolbar.close(); setSettingsOpen(false); help.setOpen(false); mp.closePanel();
    // nothing open: out of a construction's options, else the start menu (Garry's Mod's Esc)
    if (!overlay) { if (isBuild(settings.tool)) leaveBuild(); else actions.openMenu(); }
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
  shapeDrag = null;
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- profiler (Settings → Developer)
// gfx/profiler.js measures and ui/profiler.js shows. Off, the pass hooks are unset.
const profPanel = createProfilerPanel();
const prof = createProfiler(renderer, {
  describe: () => ({
    sim, renderScale: post.renderScale,
    targets: [sim, post.allTargets, shadowTarget, pickTarget, rayTarget, thumbTarget],
  }),
  onSample: profPanel.update,
});
const simPass = (name, target) => prof.pass(name, target);
// post's passes after the scene (the view's raymarch) are a phase of their own
const postPass = (name, target) => { prof.pass(name, target); if (name === 'scene') prof.phase('post'); };
function applyProfiler() {
  const on = settings.profiler;
  prof.enable(on);
  profPanel.show(on);
  sim.onPass = on ? simPass : null;
  post.onPass = on ? postPass : null;
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Timer();
let animTime = 0;   // s the simulation has run: the scene's own animations (perk orbs, arena banners)
// The fps readout is the rate frames are drawn while drawing: a paused, still
// scene draws nothing (render on demand) and reads as idle, not as a low rate.
let frames = 0, fpsTime = 0, fps = 60, idleTime = 0, lastDrawAt = null;
let stepTime = 0, stepCount = 0, stepRate = 0;
// Render on demand (gfx/pacing.js). The derived passes settle once the slowest
// field EMA and the GI blend (each probe is traced every other frame) have
// converged; the view once TAA's history has (upscaled, it accumulates for longer).
const GI_PROBE_EVERY = 2;
const pacer = createPacer({
  derivedSettle: Math.max(...[...CHANNELS, ...MEDIA].map((c) => settleFrames(c.ema)), settleFrames(GI_BLEND, GI_PROBE_EVERY)),
  viewSettle: () => settleFrames(post.settleWeight),
  presentHz: testMode === 'preview' ? PREVIEW_HZ : MAX_FPS,
});
// input of any kind may change what the view shows
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'change', 'resize']) {
  addEventListener(type, () => { autoRes.wake(); pacer.wake(); }, { capture: true, passive: true });
}
let lastVersion = -1, renderedLast = false;
// the browser capping the page at 30 Hz (gfx/pacing.js createCapCheck): say so once
const capCheck = createCapCheck();
let lastIdle = false;
const CAP_NOTICE = 'Your browser is holding this page at 30 fps. In Chrome, turn off Energy Saver (Settings → Performance); on a Mac, Low Power Mode does the same.';
const CAP_NOTICE_MS = 9000;
const DT_MAX = 0.1;      // s: longer gaps (a hidden tab) count as this, so animations don't jump
const FPS_WINDOW = 0.5;  // s over which the fps readout averages
const invVol = new THREE.Matrix4();
const autoRes = createAutoResolution();
autoRes.enabled = !testMode || testMode === 'visual'; // intentional preview caps are not GPU slowness

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
    hud.toast('Screenshot saved', { icon: 'camera' });
  });
}

// the camera the toolbar shows: god view, or the body's first / third person
const camState = () => (!pov?.active || pov.mode === 'exiting' ? 'god' : pov.camera.third ? 'third' : 'first');
let camShown = '';
function frame(now) {
  if (graphicsFailure) return;
  requestAnimationFrame(frame);
  if (testParked) return;   // leave browser/UI rAF alone (Playwright actionability needs it)
  try { tick(now); gpuLoss.settle(); }
  catch (error) { if (error !== graphicsFailure) throw error; }
}
function tick(now, renderOnly = false) {
  if (graphicsFailure) throw graphicsFailure;
  if (!renderOnly && coldShader.hold()) return;   // a cold-compile message is painting
  if (!renderOnly && capCheck.feed(now, lastIdle)) hud.toast(CAP_NOTICE, { kind: 'hint', ms: CAP_NOTICE_MS });
  const t0 = performance.now();
  lastIdle = false;
  if (!renderOnly && !pacer.due(now)) { lastIdle = performance.now() - t0 < CAP_IDLE_MS; return; }
  if (prof.on !== settings.profiler) applyProfiler();
  prof.beginFrame(now);
  if (!renderOnly) clock.update(now);
  const dt = renderOnly ? 0 : Math.min(clock.getDelta(), DT_MAX);
  // only frames that rendered measure how expensive rendering is
  if (!renderOnly && renderedLast && post.settings.taa) autoRes.update(dt, clock.getElapsed());
  // Set before pacing's view key so a scale change always schedules a render.
  post.settings.resolutionScale = autoRes.scale;

  if (!renderOnly) {
    const cam = camState();
    if (cam !== camShown) toolbar.setCamera(camShown = cam);
    if (pov?.active) pov.update(dt);
    if (descent) descentFrame();
    if (!pov?.active) {
      rig.update(dt);
      controls.update();
    }
    if (win) moveWindow();
    updateBrush();

    prof.phase('paint');
    if (painting && brushValid) {
      tmpV.copy(brushCenter).add(sim.origin);   // world cells
      const wind = windFromValid ? [tmpV.x - windFrom.x, tmpV.y - windFrom.y, tmpV.z - windFrom.z] : null;
      windFrom.copy(tmpV);
      windFromValid = true;
      paintStroke({ ...brushStroke(strokeTool), wind });   // (a guest's: the host paints it)
    } else windFromValid = false;
  }
  // The world continues beyond its simulation window: don't outline the window.
  edges.visible = !win;
  prof.phase('sim');
  const stepping = !renderOnly && !mp.isGuest && (!settings.paused || stepOnce);
  if (!renderOnly) scripts?.tick();   // event.tick: every frame, paused too (TPT)
  if (stepping) {
    for (let i = 0; i < settings.steps; i++) { scripts?.beforeStep(); sim.step(); scripts?.afterStep(); }
    lightning.update(sim);   // storms: charged cloud strikes by itself (src/lightning.js)
    if (DAY.running) day.clock += settings.steps;
    animTime += dt;
    stepOnce = false;
  } else if (!renderOnly && mp.isGuest && DAY.running) day.clock += settings.steps;   // guests don't step: keep the day going at their own rate
  if (!renderOnly) scripts?.endFrame();
  updateSun();
  if (birds) {
    prof.phase('other');   // (their probe pass, birdProbe, counts here)
    birds.update(settings.paused ? 0 : dt);   // they hold still with the world
    if (!renderOnly && !settings.paused && birds.count) pacer.wake();
  }
  if (settings.time !== timeShown) {
    timeShown = settings.time;
    if (settingsPanel.isOpen) settingsPanel.sync();
  }
  prof.phase('other');
  if (!renderOnly) mp.update(dt, {
    visible: brushValid && pointerInside && !uiHover, center: brushCenter, painting,
    radius: settings.radius, shape: settings.shape, tool: settings.tool,
  });
  const worldChanged = sim.version !== lastVersion;
  if (worldChanged) autoRes.wake();
  lastVersion = sim.version;
  // Keep animation time tied to simulation, not the test preview's draw rate.
  if (worldChanged) volume.material.uniforms.uTime.value += dt;
  const present = renderOnly || pacer.present(now, wantFrame());
  const runDerived = present && pacer.derived(
    `${sim.id}:${sim.version}|${SUN.x},${SUN.y},${SUN.z}|${KEY_LIGHT}|${settings.view}|${gfx.smoothing}|${detailVersion}`);
  let runView = present && pacer.view(
    `${camera.matrixWorld.elements}|${camera.projectionMatrix.elements}|${pixelRatio}|${innerWidth}x${innerHeight}`
    + `|${JSON.stringify(settings)}|${JSON.stringify(gfx)}|${JSON.stringify(post.settings)}|${sceneKey(scene)}`
    + `|${win?.far?.chunksDrawn}`,   // a world scene's far field filling in (world/far.js)
    runDerived || wantFrame() || (!renderOnly && post.adapting));   // frozen-time snapshots cannot advance eye adaptation
  if (present && !runView && autoRes.recover(clock.getElapsed())) {
    post.settings.resolutionScale = autoRes.scale;
    pacer.wake();   // settle the final full-quality still; don't wake auto resolution
    runView = true;
  }
  if (!renderOnly) {
    // Preview draws are not adjacent app ticks; report draw and step rates separately.
    if (runView) {
      if (lastDrawAt != null && now - lastDrawAt <= FPS_WINDOW * 1000) { frames++; fpsTime += (now - lastDrawAt) / 1000; }
      else { frames = 0; fpsTime = 0; }
      lastDrawAt = now;
    }
    if (fpsTime > FPS_WINDOW) { fps = frames / fpsTime; frames = 0; fpsTime = 0; }
    stepTime += dt;
    if (stepping) stepCount += settings.steps;
    if (stepTime > FPS_WINDOW) { stepRate = stepCount / stepTime; stepTime = stepCount = 0; }
    idleTime = runView ? 0 : idleTime + dt;
    renderedLast = runView;
  }
  if (runView) updateGfxUniforms(sim, SUN, KEY_LIGHT);   // (runDerived implies runView)
  if (runDerived) {
    prof.phase('derived');
    sim.updateBricks();
    if (VIEWS.find((v) => v.id === settings.view)?.shadows) {
      prof.phase('shadow');
      shadowMat.uniforms.tA.value = sim.stateA;
      shadowMat.uniforms.tBrick.value = sim.brick.texture;
      sim.run(shadowMat, shadowTarget);
    }
    if (settings.view === 0) {
      prof.phase('gi');
      sim.updateGI(SUN, shadowTarget.texture, shadowMat.uniforms.uShadowRes.value, true);
    }
  }

  if (runView) {
    prof.phase('view');
    volume.updateMatrixWorld();
    const u = volume.material.uniforms;
    u.tA.value = sim.stateA;
    u.tB.value = sim.stateB;
    u.tBrick.value = sim.brick.texture;
    u.tLight.value = sim.lightTexture;
    u.uCam.value.copy(camera.position).applyMatrix4(invVol.copy(volume.matrixWorld).invert());
    u.uMarchNear.value = pov?.marchNear ?? 0;
    detailGate.update(camera, u.uCam.value, [sim.g.nx, sim.g.ny, sim.g.nz], scene);
    win?.far.view(volume, settings.view === 0, camera);
    u.uView.value = settings.view;

    post.settings.raw = settings.view !== 0;
    post.settings.upscale = UPSCALE[settings.upscale] ?? UPSCALE.native;
    gfxUniforms.uNearGI.value = settings.nearGI;
    gfxUniforms.uGlowLights.value = settings.glowLights;
    gfxUniforms.uCaustics.value = settings.caustics;
    sim.rays.updateView(camera, renderer.domElement.height * post.renderScale);
    floorGrid.material.opacity = post.renderScale;
    edges.material.opacity = EDGE_OPACITY * post.renderScale;
    post.render(scene, camera, null, dt);   // its passes after the scene count as 'post' (postPass)
    coldShader.drew();
    prof.phase('other');
    // POV: the held tool, drawn over the finished frame in its own pass (no TAA, its
    // own depth, so it never clips into walls); before the screenshot reads the canvas
    renderViewmodels(renderer, scene, camera, post);
    if (wantShot) { wantShot = false; saveScreenshot(); }
    if (thumbWaiters.length) takeSaveThumbnail();

    signs?.update();
  }
  // Picking is input work, not presentation: a preview must keep it responsive.
  if (!renderOnly && (runView || pov?.active || testMode === 'preview')) requestPick();
  if (spawners) { spawners.setGhosts(!pov?.active); spawners.update(); }   // the crosshair cell stays fresh for the tools
  // they hold still with the world, like the birds: on wall-clock time they moved every
  // frame, so the view key (sceneKey) never settled and a paused scene redrew at full rate
  perkOrbs?.update(animTime);
  arenaMarkers?.update(animTime);
  if (renderOnly) { prof.endFrame(0); return; }

  const povReadout = pov?.active ? pov.readout : null;   // the held tool's (the scanner's, the trowel's)
  if (povReadout) {
    const r = renderer.domElement.getBoundingClientRect();
    hud.showReadout(r.left + r.width / 2, r.top + r.height / 2, povReadout);
  } else if (!pov?.active && pointerInside && !uiHover && hover.valid && hover.id >= 0 && !painting) {
    const el = ELEMENTS[hover.id];
    hud.showReadout(pointerClient[0], pointerClient[1], { name: el.name, color: el.color, T: hover.T, P: hover.P });
  } else {
    hud.showReadout(0, 0, null);
  }
  const g = sim.g;
  hud.setStats({
    fpsV: idleTime > FPS_WINDOW ? null : fps,   // null: idle
    stepsV: settings.paused || mp.isGuest ? 0 : stepRate, // preview fps is not the simulation rate
    // the cells simulated (a world's window), and the world's
    cellsV: `${millions([g.nx, g.ny, g.nz])}${win ? ` of ${millions(win.size)}` : ''}`,
    resV: autoRes.enabled ? `${Math.round(post.renderScale * 100)}% res` : '',
  });
  prof.endFrame(stepping ? settings.steps : 0);
  lastIdle = !runView && !stepping && performance.now() - t0 < CAP_IDLE_MS;
}

// ---------------------------------------------------------------- boot
// The start menu's loading screen comes down once the first map is on screen:
// a frame after the first frame (that one compiles the renderer), and in a
// world once its window has filled (or after a while, whatever it's doing).
// A team gamemode picked with it starts behind the loading screen first (the
// body drops in, the bots are built and compiled), so the screen comes down
// on the match running, not on the hitches of setting it up.
const READY_POLL_MS = 100;
const READY_WAIT_MS = 20000;
const MATCH_WAIT_MS = 30000;   // the longest the loading screen waits on a match starting (a cold shader compile)
function bootReady(pending = null) {
  const t0 = performance.now();
  let settled = !pending;   // (a save picked on the menu: it loads first)
  pending?.finally(() => { settled = true; });
  const check = async () => {
    if (((win && !win.loaded) || !settled) && performance.now() - t0 < READY_WAIT_MS) {
      if (win && !win.loaded) launch.progress?.('world');   // (the loading screen's step: its passes compile, then it generates)
      setTimeout(check, READY_POLL_MS);
      return;
    }
    mark('first-frame');
    if (bootMap && launch.mode && launch.mode !== 'sandbox' && pov?.game) {
      launch.status?.(launch.mode === 'noita' ? 'Dropping in' : 'Picking the teams');
      const match = startMode(launch.mode, { fresh: true }).catch((err) => console.error('The match failed to start', err));
      await Promise.race([match, new Promise((r) => setTimeout(r, MATCH_WAIT_MS))]);
    }
    mark('ready');
    launch.ready?.();
  };
  requestAnimationFrame(() => requestAnimationFrame(check));
}

try {
  if (!renderer.capabilities.isWebGL2) throw new Error('This needs WebGL2, which your browser does not provide.');
  if (SignsClass) {
    signs = new SignsClass({
      renderer, camera, container: signLayer,
      getSim: () => sim, getVolume: () => volume,
      onChange: () => {},
    });
  }
  spawners = new Spawners({ scene, getSim: () => sim, getVolume: () => volume, getScale: () => scale });   // seeded by build()'s loadPreset, once there is a grid
  perkOrbs = new PerkOrbs({ scene, getSim: () => sim, getVolume: () => volume, getScale: () => scale });
  birds = createBirdLife({
    renderer, scene, camera, sun: SUN,
    getSim: () => sim, getVolume: () => volume, getScale: () => scale, getWin: () => win, getSpawners: () => spawners,
    sunEl: () => sunElevation(dayPhase(day.clock), day.fixed),
    // the body in first person, at its middle (world cells): it flushes birds near it
    player: () => (pov?.active && pov.player && !pov.player.dead
      ? { x: pov.player.pos.x + sim.origin.x, y: pov.player.pos.y + BODY_HEIGHT / 2, z: pov.player.pos.z + sim.origin.z } : null),
  });
  arenaMarkers = new ArenaMarkers({ scene, getSim: () => sim, getVolume: () => volume, getScale: () => scale });
  if (BuildsClass) {
    builds = new BuildsClass({
      scene, camera, settings, getSim: () => sim, getVolume: () => volume, getScale: () => scale, onClose: leaveBuild,
      requestRender: () => pacer.wake(),
      // a shrine: a random perk orb over each plinth
      onPlaced: ({ key, anchors }) => { if (key === 'SHRINE') lastShrine = perkOrbs?.shrineAt(anchors)?.[0]?.shrine ?? 0; },
    });
  }
  // a guest gets the host's box (multiplayer.js): opening an invite in World starts in a box, not the world
  if (mp.joining && settings.size in WORLDS) settings.size = boxSize;
  build();
  rig.setSpeed(settings.camSpeed);
  selectTool(settings.tool);
  setView(settings.view);
  setPaused(settings.paused);
  toolbar.setUndoEnabled(false);
  pov = createPov({
    renderer, scene, camera, controls, canvas: renderer.domElement, hud, settings, mp, isTyping, post,
    getSim: () => sim, getVolume: () => volume, getScale: () => scale,
    hover, pointerHover: () => pointerInside && !uiHover, pickRay,
    getSpawners: () => spawners,
    getPerkOrbs: () => perkOrbs,
    loadPreset: (name) => loadPreset(name, false),   // a team game's new round (src/game)
    getArena: () => arenaLayout,                      // the loaded arena's layout, for the team games (src/game)
    dropAt: () => descentSpawn(levelByScene(win ? settings.scene : null)),   // a Descent level: you start (and respawn) at its spawn
    requestRender: () => pacer.wake(),
    inWorld: () => !!win,
    toolGun,   // the tool gun's click at the crosshair
    // Q in first person: the spawn menu where it was left (at first, at what's selected)
    showToolsMenu: () => dock.reveal((it) => it.id === (menuPick ?? settings.tool)) || dock.reveal((it) => isGearTool(it.id)),
    hideToolsMenu: () => dock.setCollapsed(true),
  });
  pov.vehicles.spawnLayout(arenaLayout);   // the scene loaded before the POV shell existed
  // the scripting console, ` (optional: the game runs without it)
  try {
    scripts = createConsole({
      getSim: () => sim, isGuest: () => mp.isGuest,
      paused: () => settings.paused, setPaused,
      stepNow: (n) => { for (let i = 0; i < n; i++) sim.step(); if (DAY.running) day.clock += n; },
      gravity: () => settings.gravity / DEFAULTS.gravity,
      setGravity: (g) => {
        settings.gravity = THREE.MathUtils.clamp(g * DEFAULTS.gravity, 0, CONSOLE_GRAVITY_MAX);
        sim.gravity = settings.gravity;
        if (settingsPanel.isOpen) settingsPanel.sync();
        save();
      },
      brushRadius: () => settings.radius, setBrushRadius: setRadius,
      brushShape: () => settings.shape, setBrushShape: (v) => { settings.shape = v; dock.sync(); save(); },
      selected: () => settings.tool, select: selectTool,
      paint: ({ x, y, z, radius, shape, tool }) => sim.paint({
        center: new THREE.Vector3(x, y, z).addScalar(0.5), radius, shape, tool, rate: settings.rate, replace: false,
      }),
      snapshot: () => { sim.snapshot(); toolbar.setUndoEnabled(true); },
      requestRender: () => pacer.wake(),
      exitPointerLock: () => { if (document.pointerLockElement) document.exitPointerLock(); },
    });
  } catch (err) { console.error('Console unavailable', err); }
  pov.game.useLayout(arenaLayout);
  descent = createDescentRunner({
    levels: DESCENT_LEVELS,
    emit: (name, payload) => pov.events.emit(name, payload),
    loadScene: descentLoad,
    enterAt: async (spawn) => {
      await pov.enter({ at: descentSpawn({ spawn }) });
      if (!pov.active) throw new Error("the body didn't drop in");
    },
    snapshot: () => runSnapshot({ player: pov.player, gold: pov.descent?.gold ?? null, wands: descentWands }),
    overlay: createDescentOverlay(),
    toast: (text, opts) => hud.toast(text, opts),
    finish: () => { pov.exit(); actions.openMenu(); },
    wait: (s) => new Promise((resolve) => setTimeout(resolve, s * 1000)),
    loadId: () => win,
  });
  if (bootMap && launch.mode && launch.mode !== 'sandbox' && launch.mode !== 'noita') pov.game.prepare();   // a match was picked: the bots' module loads during the first frames
  mark('app');
  window.__app = {
    get sim() { return sim; }, get volume() { return volume; }, get scale() { return scale; }, get signs() { return signs; }, get builds() { return builds; },
    get pov() { return pov; },
    get descent() { return descent; },   // Descent's level switch (pov/descent/switch.js): level, index, inside, busy
    get spawners() { return spawners; },
    get birds() { return birds; },
    get perkOrbs() { return perkOrbs; },
    get scripts() { return scripts; },   // the console (src/console): .setOpen, .world
    lightning,     // the Lightning tool's and storms' bolts (src/lightning.js)
    // the loaded arena's layout (spawns, flags, hills, siege core, shrines, vehicles: arenas/damValley.js), else null
    get arena() { return arenaLayout; },
    get win() { return win; },
    get lastGpuFailure() { return gpuLoss.last; },   // the last GPU failure's report, kept across reloads (gfx/gpuLoss.js)
    // world mode: start the world over with the window at `origin` (world cells)
    worldLoad(origin) { if (graphicsFailure) throw graphicsFailure; win.load(origin); placeVolume(); post.reset(); pov?.worldReplaced(); },
    setSize,         // switch the grid (a SIZES or WORLDS key), keeping the scene settings
    openMap,         // as the start menu's Start does (a maps.js key, a gamemode)
    undo,            // as ⌘Z does
    hud,             // toast(text, { kind }): GMod's notices (ui/notices.js)
    scoreboard,      // GMod's, on Tab (ui/scoreboard.js): show(v), shown, mine
    saveGame,        // as ⌘S does: resolves to the save's meta (saves/local.js), or null
    openSave,        // a local save's id, or a .tpt3d file's bytes: resolves to whether it loaded
    setSimMode,      // (key, value): as the drawer's Simulation switches do (simModes.js SIM_MODE_KEYS)
    setSimModes,     // ({ gravityMode, airMode, ambientHeat, edgeMode }): a world's, at once (a save's)
    fill: (req) => runFill(sim, req, { openSides: !!win }),   // a flood fill on the current grid (editing.js runFill), for tools
    get worldFocus() { return worldFocus; }, set worldFocus(v) { worldFocus = v; },
    MOBILE, SUN, day, scene, settings, camera, controls, loadPreset, selectTool, setView, hover, renderer, rig, renderThumb, gfx, post, mp, autoRes, prof,
    applyDetail,   // after changing settings.detail_* by hand
    detailGate,    // .level / .shown: which close-up features the view has compiled in
    THREE,         // for tools (tools/detail-bench.mjs makes its own targets)
    requestRender: () => pacer.wake(),   // for changes the frame loop can't see (async results)
    // Manual mode parks only this app loop. Browser/UI callbacks remain live.
    test: testMode ? {
      mode: testMode,
      get parked() { return testParked; },
      park() { testParked = true; },
      resume() { clock.reset(); testParked = false; },
      step(count = 1) {
        if (graphicsFailure) throw graphicsFailure;
        if (!testParked || mp.isGuest) throw new Error('Park a local test page before stepping');
        if (!Number.isSafeInteger(count) || count < 0 || count > 10000) throw new RangeError('steps must be an integer from 0 to 10000');
        for (let i = 0; i < count; i++) sim.step();
        if (DAY.running) day.clock += count;
      },
      render() {
        // No physics, input, player, or multiplayer updates while converging a snapshot.
        // Two initial frames observe post-setting and spawner-transform changes.
        pacer.wake(); // also covers direct uniform edits that aren't in the scene key
        let n = 0;
        // The first render applies the requested upscale, which changes the limit.
        do { tick(performance.now(), true); n++; } while ((n < 2 || !pacer.settled) && n < pacer.settleLimit);
        if (!pacer.settled) throw new Error('Test render did not converge');
        return n;
      },
    } : null,
  };
  gpuLoss.settle();
  launch.progress?.('compile');   // the first frame compiles the view (the loading screen's step)
  requestAnimationFrame(frame);
  bootReady(launch.save ? openSave(launch.save) : null);   // a save picked on the menu's Saves before the game had loaded
} catch (err) {
  if (err !== graphicsFailure) {
    const el = document.getElementById('error');
    el.style.display = 'flex';
    el.textContent = String(err.stack || err);
  }
  throw err;
}

// for the start menu (src/main.js)
export { openMap, currentMap as current, openSave, saveGame };
