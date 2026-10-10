import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './ui/styles.css';
import { Simulation } from './sim.js';
import { volumeVert, volumeFrag, pickFrag, shadowFrag } from './shaders/render.js';
import { ELEMENTS, E, toolById, isBuild, isSpawnerTool, isGearTool, LIGHTNING_TOOL } from './elements.js';
import { createLightning } from './lightning.js';
import { Spawners, SPAWNER, ENEMY_KINDS, feetOnHit } from './spawners.js';
import { createBirdLife } from './birds/index.js';
import { BODY_HEIGHT } from './pov/constants.js';
import { PerkOrbs } from './perkOrbs.js';
import { buildPreset, ARENA_PRESETS } from './presets.js';
import { ArenaMarkers } from './arenas/markers.js';
import { DAM_VALLEY_BANNERS, shrineAltars } from './arenas/damValley.js';
import { structureClear, shrineAltars as worldShrineAltars } from './world/structures.js';
import { loadIsland, releaseGenerator } from './world/gpu.js';
import { WorldWindow, WIN_STEP } from './world/window.js';
import { bakedAir } from './constructions/runtime.js';
import { WORLD_SCENES, sceneByKey } from './world/scenes/index.js';
import { FarField } from './world/far.js';
import { farHazeGLSL, farCastersGLSL, farLayout, WORLD_SIZE } from './shaders/far.js';
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
import { DETAIL, settingKey, detailDefaults, detailDefines, detailRows } from './gfx/detail.js';
import { createDetailGate } from './gfx/detailGate.js';
import { claimPrograms } from './gfx/programs.js';
import { createPost, UPSCALE } from './gfx/post.js';
import { createPacer, settleFrames, sceneKey, createCapCheck, CAP_IDLE_MS } from './gfx/pacing.js';
import { CHANNELS, MEDIA } from './gfx/materials.js';
import { DAY, dayPhase, phaseSteps, keyLight, sunElevation } from './gfx/daylight.js';
import { GI_BLEND } from './sim.js';
import { createMultiplayer } from './net/multiplayer.js';
import { createProfiler } from './gfx/profiler.js';
import { createProfilerPanel } from './ui/profiler.js';
import { createPov } from './pov/index.js';
import { inventory } from './pov/tools/inventory.js';
import { gearByKey, SLOTS } from './pov/tools/catalog.js';
import { renderViewmodels } from './pov/viewmodel.js';
import { POV_FOV, POV_FOV_RANGE, SENSITIVITY_RANGE } from './pov/camera.js';
import { finishSignIn, account, accountsEnabled } from './account.js';
import { accountSection } from './ui/account-section.js';

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
// the orbit target). The Grid size row's World.
const WORLDS = { world: { win: [128, 128, 128], size: WORLD_SIZE } };
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

// ---------------------------------------------------------------- settings
// the box the Scene row goes back to from World, and phones' grid
const BOX_DEFAULT = '128';
const DEFAULTS = {
  size: 'world', preset: 'lab', scene: 'island',
  tool: E.SAND, radius: 5, shape: 0, rate: 1, replace: false,
  steps: 4, gravity: 0.025, paused: false,
  view: 0, camSpeed: 1, upscale: 'quality', dockCollapsed: false,
  character: 'wizard', povFov: POV_FOV, sensitivity: 1, viewBobbing: true, sprintMode: 'hold',
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
const PERSIST = ['size', 'preset', 'scene', 'tool', 'radius', 'shape', 'rate', 'replace', 'steps', 'gravity', 'view',
  'camSpeed', 'upscale', 'dockCollapsed', 'character', 'povFov', 'sensitivity', 'viewBobbing', 'sprintMode',
  'nearGI', 'glowLights', 'caustics', ...DETAIL.map(settingKey), 'profiler'];
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
  const rev = saved[REV_KEY] ?? (saved[LEGACY_MOBILE_KEY] ? 1 : 0);
  for (const change of DEFAULT_CHANGES.slice(rev)) Object.assign(settings, change);
} catch { /* storage unavailable */ }
const params = new URLSearchParams(location.search);
const knownSize = (s) => s in SIZES || s in WORLDS;
if (knownSize(params.get('size'))) settings.size = params.get('size');
if (params.get('preset')) settings.preset = params.get('preset');
if (params.get('scene')) settings.scene = params.get('scene');
settings.scene = sceneByKey(settings.scene).key;   // (a scene no longer listed: the island)
// the Island scene's world seed (world/generator.js), and World's; its default world without one
const worldSeed = params.has('seed') ? Number(params.get('seed')) >>> 0 : undefined;
if (!knownSize(settings.size)) settings.size = DEFAULTS.size;
// the box size the Scene row goes back to from World
let boxSize = settings.size in SIZES && !ARENA_GRIDS.has(settings.size) ? settings.size : BOX_DEFAULT;
// a scene named in the URL is a box scene (World has its own), as in the Scene row
if (params.get('preset') && !params.get('size') && settings.size in WORLDS) settings.size = boxSize;
// an arena named in the URL brings its grid
if (params.get('preset') in ARENA_GRID && !params.get('size')) settings.size = ARENA_GRID[params.get('preset')];
if (!toolById(settings.tool)) settings.tool = DEFAULTS.tool;
if (!VIEWS.some((v) => v.id === settings.view)) settings.view = 0;
if (!['wizard', 'real', 'stick'].includes(settings.character)) settings.character = DEFAULTS.character;
settings.paused = false;

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
renderer.setClearColor(0x000000, 0);
let pixelRatio = Math.min(RES_MAX, 1);
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
scene.add(brush.mesh);

const isTyping = () => {
  const a = document.activeElement;
  return !!(signs?.editing || (a && (a.tagName === 'TEXTAREA' || a.isContentEditable ||
    (a.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(a.type)))));
};
const rig = createCameraRig(camera, controls, isTyping);

let sim, volume, edges, pickMat, shadowMat, shadowTarget, scale;
// world mode (a WORLDS size): the world, the window over it, and the world cell (x, z) at the scene's origin
let worldMode = null, win = null;
const anchor = new THREE.Vector2();
const pickTarget = new THREE.WebGLRenderTarget(2, 1, { type: THREE.FloatType, depthBuffer: false });
const pickBuf = new Float32Array(8);
let pickPending = false;

function build() {
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
  worldMode = WORLDS[settings.size] ?? null;
  const [nx, ny, nz] = worldMode?.win ?? SIZES[settings.size];
  win?.dispose(retired);   // (a new window over the world shares most of its passes' programs)
  win = null;
  sim = new Simulation(renderer, nx, ny, nz, { windowed: !!worldMode });
  sim.gravity = settings.gravity;
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
      uCam: { value: new THREE.Vector3() },
      uSun: { value: SUN }, tShadow: { value: null }, uShadowRes: { value: 0 },
      uView: { value: 0 }, uShadows: { value: true }, uTime: { value: 0 }, uLightGain: { value: GLOW_GAIN },
      uOrigin: sim.originUniform,   // the window's place in the world (the sim passes get it from sim.run)
      uFar: { value: false },
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
    fragmentShader: shadowFrag(sim.g, farCastersGLSL(farLayout(WORLD_SIZE))),
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
  if (!win || !builds) return;
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
// the ground there (the scene's: on the sea where the sea floor is lower).
function homeOver(x, z) {
  const ground = win.scene.ground(x, z, win.P);
  const target = new THREE.Vector3((x - anchor.x) * scale, ground * scale, (z - anchor.y) * scale);
  rig.setHome(new THREE.Vector3(...WORLD_VIEW_DIR).setLength(WORLD_VIEW_DIST).add(target), target);
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
  settings.size = size;
  if (size in SIZES && !ARENA_GRIDS.has(size)) boxSize = size;
  build();
  save();
}

// The Scene row's box scenes: an arena brings its own grid, any other goes
// back to the box size from before (build() loads settings.preset).
function pickBoxScene(name) {
  const grid = ARENA_GRID[name] ?? boxSize;
  if (settings.size === grid) return loadPreset(name);
  if (mp.guard()) return false;
  settings.preset = name;
  setSize(grid);
  return true;
}
// cells [nx, ny, nz] for a toast: '128³', '160 × 96 × 160'; for the HUD: '2.1M'
const dimsName = (d) => (d.every((n) => n === d[0]) ? `${d[0]}³` : d.join(' × '));
const millions = (d) => `${(d[0] * d[1] * d[2] / 1e6).toFixed(1)}M`;

function loadPreset(name, undoable = true) {
  if (undoable && mp.guard()) return false;
  if (undoable && !win) sim.snapshot();
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
  if (settings.tool !== SIGN_TOOL && !isBuild(settings.tool) && !isSpawnerTool(settings.tool)) {
    if (painting) {
      // a box's brush stops at its walls; a world's window has none, so beyond it there's no brush
      plane.constant = -dragY;
      if (gridRay().intersectPlane(plane, tmpV) && (!win || inWindow(tmpV))) { brushCenter.copy(tmpV); brushValid = true; }
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

// A first-person tool from the palette's Tools group (GMod's spawn menu): it
// goes into the inventory and in hand, now in first person or at the next drop-in.
function giveGear(id) {
  const it = toolById(id);
  const g = gearByKey(it.gear);
  const fresh = inventory.give(g.key);
  const slot = `key ${g.slot + 1} (${SLOTS[g.slot]})`;
  if (pov?.active) {
    pov.closeMenu();
    hud.toast(fresh ? `${it.name} added: ${slot}` : `${it.name}: ${slot}`);
  } else hud.toast(`${it.name} ${fresh ? 'added to your tools' : 'is in your tools'}: press V, then ${slot}`);
}

// Closing a construction's options goes back to the last element or tool.
function leaveBuild() { if (isBuild(settings.tool)) selectTool(lastPaintTool); }

const dock = createDock({
  settings,
  onSelect: (id) => (isGearTool(id) ? giveGear(id) : selectTool(id)),
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
  // (in a world, over where the camera is looking: home is wherever you are)
  resetCamera: () => {
    if (win) homeOver(controls.target.x / scale + anchor.x, controls.target.z / scale + anchor.y);
    rig.reset();
    hud.toast('Camera reset');
  },
  screenshot: () => { wantShot = true; },
  firstPerson: () => { painting = false; pov?.toggle(); },
  // 'god' leaves the walking body; 'first' / 'third' drops in, or switches the camera if already in
  setCamera: (id) => {
    if (!pov) { hud.toast('First person is still loading'); return; }
    if (id === 'god') { if (camState() !== 'god') pov.exit(); return; }
    pov.camera.third = id === 'third';
    if (camState() === 'god') { painting = false; pov.enter(); }
  },
  toggleSettings: () => setSettingsOpen(!settingsPanel.isOpen),
  toggleHelp: () => help.setOpen(!help.isOpen),
  setView,
  renderThumb,
};
const toolbar = createToolbar({ views: VIEWS, settings, actions });
const mp = createMultiplayer({ renderer, scene, camera, hud, getSim: () => sim, getVolume: () => volume, setGrid, inWorld: () => !!win });

const fmtSpeed = (v) => `${v}×`;
const SCENE_COLS = 3;   // scenes per row of the Scene row (five or six don't fit the drawer's width in one)
const fmtTime = (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`;
const settingsPanel = createSettings({
  settings,
  onClose: () => setSettingsOpen(false),
  // Sections and their rows run from most to least reached-for; keep that order when adding settings.
  sections: [
    { title: 'Scene', rows: [
      // a box's scenes: clicking the current one reloads it; Empty clears
      { type: 'seg', key: 'preset', hidden: () => !!win, cols: SCENE_COLS,
        options: [['empty', 'Empty'], ['lab', 'Lab'], ['volcano', 'Volcano'], ['island', 'Island'], ['damValley', 'Dam Valley']],
        onChange: (v) => {
          if (pickBoxScene(v)) hud.toast(`Loaded ${v === 'empty' ? 'an empty box' : v in ARENA_GRID ? arenaLayout?.name ?? v : `the ${v}`}`);
        } },
      // a world's (world/scenes), in rows of three: clicking one starts the world over with it
      { type: 'seg', key: 'scene', hidden: () => !win, cols: SCENE_COLS,
        options: WORLD_SCENES.map((s) => [s.key, s.label]),
        onChange: (v) => {
          if (mp.guard()) return;
          settings.scene = v;
          setSize('world');
          hud.toast(`Loaded ${sceneByKey(v).label}`);
        } },
    ] },
    { title: 'Simulation', rows: [
      { type: 'slider', key: 'steps', label: 'Speed (steps per frame)', min: 1, max: 12, step: 1, def: DEFAULTS.steps, fmt: fmtSpeed, onChange: save },
      { type: 'slider', key: 'gravity', label: 'Gravity', min: 0, max: 0.06, step: 0.005, def: DEFAULTS.gravity,
        fmt: (v) => `${(v / DEFAULTS.gravity).toFixed(1)} g`, onChange: (v) => { sim.gravity = v; save(); } },
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
    { title: 'Grid size', rows: [
      // World: a world scene (the Scene row's; the island by default), simulated
      // through a window that follows you (clicking it again starts the world over)
      { type: 'seg', key: 'size', options: [['64', '64³'], ['96', '96³'], ['128', '128³'], ['wide', '160×96'], ['world', 'World']],
        onChange: (v) => {
          if (mp.guard() || (v in WORLDS && mp.guardWorld())) return;
          setSize(v);
          const w = WORLDS[v];
          hud.toast(w ? `World: ${w.size.join(' × ')} cells, simulated ${dimsName(w.win)} around you` : `Grid is now ${dimsName(SIZES[v])}`);
        } },
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
    // The body you see in third person and when you die: Wizard (Castle
    // Crashers-style, the default), Realistic (a skinned, animated mannequin
    // in a wizard's hat and robe) or Stickman (the TPT homage). It switches
    // live, in POV too. The key was 'body' before Wizard; the new key starts
    // everyone on the default.
    { title: 'First person', rows: [
      { type: 'seg', key: 'character', options: [['wizard', 'Wizard'], ['real', 'Realistic'], ['stick', 'Stickman']],
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
    ...(accountsEnabled ? [accountSection({ toast: (text) => hud.toast(text) })] : []),
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
const detailGate = createDetailGate(renderer, () => pacer.wake(), () => hud.toast('Preparing close-up detail… the first time after an update this can take half a minute'));
function applyDetail() {
  shadowMat.defines = detailDefines(settings);
  shadowMat.needsUpdate = true;
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
  const shrine = sim.history?.at(-1)?.note?.shrine;
  if (sim.undo()) { if (shrine) perkOrbs?.removeShrine(shrine); pov?.worldReplaced(); hud.toast('Undone'); }
  // (a world's window moved off all of it: it's kept for when the window comes back)
  else hud.toast(sim.canUndo ? 'Too far away to undo that: go back to it first' : 'Nothing to undo');
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
  if (e.pointerType === 'touch') touchDown(e);
  else press(e);
});
function press(e) {
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
  if (settings.tool === LIGHTNING_TOOL) {
    if (mp.guard()) return;
    if (!hover.valid) { hud.toast('Click a surface to strike it'); return; }
    sim.snapshot();
    toolbar.setUndoEnabled(true);
    lightning.strikeTool(sim, hover, settings.radius);
    pacer.wake();
    hud.dismissHint();
    return;
  }
  if (isSpawnerTool(settings.tool)) {
    if (mp.guard()) return;
    if (!hover.valid) { hud.toast('Click a surface to set it on'); return; }
    const kind = SPAWNER_KIND[settings.tool];
    const r = spawners.toggle(kind, feetOnHit(hover));
    pacer.wake();
    if (r === 'full') hud.toast('That many is the limit');
    else hud.toast(r === 'removed' ? 'Spawner removed' : SPAWNER_SET[ENEMY_KINDS.includes(kind) ? SPAWNER.ENEMY : kind]);
    return;
  }
  if (isBuild(settings.tool)) {
    if (mp.guard()) return;
    if (!builds) hud.toast('Constructions are still loading');
    else if (builds.ready) {
      sim.snapshot();
      toolbar.setUndoEnabled(true);
      lastShrine = 0;
      builds.place();
      // a shrine's orbs go with its snapshot: undoing it takes them away (undo)
      if (lastShrine) { sim.history.at(-1).note = { shrine: lastShrine }; hud.toast('Shrine set: in first person (V), take one perk and the others vanish'); }
      hud.dismissHint();
    }
    return;
  }
  dragY = hover.valid ? hoverBrushCenter(tmpV).y : (isTool() ? 0.5 : settings.radius);
  if (!mp.isGuest) {
    sim.snapshot();
    toolbar.setUndoEnabled(true);
  }
  painting = true;
  hud.dismissHint();
  if (e.pointerType !== 'touch') canvasEl.setPointerCapture(e.pointerId);   // (a touch is captured already)
}
addEventListener('pointerup', (e) => { if (e.button === 0) painting = false; });

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

addEventListener('keydown', (e) => {
  if (e.key === 'Alt') controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  if (e.key === 'Shift') controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  if (isTyping()) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (mod) return;
  const k = e.key;
  // V is noclip, Garry's Mod's: out of the body to the god view's free camera, and back in.
  // F drops in too (in the body it swaps first and third person: pov/index.js).
  if (k === 'v' || k === 'V' || ((k === 'f' || k === 'F') && !pov?.active)) { if (!e.repeat) actions.firstPerson(); return; }
  if ((k === 't' || k === 'T') && mp.chatAvailable) { e.preventDefault(); mp.openChat(); return; } // Minecraft's chat key, POV included
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
// the browser capping the page at 30 Hz (gfx/pacing.js createCapCheck): say so once
const capCheck = createCapCheck();
let lastIdle = false;
const CAP_NOTICE = 'Your browser is holding this page at 30 fps. In Chrome, turn off Energy Saver (Settings → Performance); on a Mac, Low Power Mode does the same.';
const CAP_NOTICE_MS = 9000;
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

// the camera the toolbar shows: god view, or the body's first / third person
const camState = () => (!pov?.active || pov.mode === 'exiting' ? 'god' : pov.camera.third ? 'third' : 'first');
let camShown = '';
function frame(now) {
  requestAnimationFrame(frame);
  if (capCheck.feed(now, lastIdle)) hud.toast(CAP_NOTICE, CAP_NOTICE_MS);
  const t0 = performance.now();
  lastIdle = false;
  if (!pacer.due(now)) { lastIdle = performance.now() - t0 < CAP_IDLE_MS; return; }
  if (prof.on !== settings.profiler) applyProfiler();
  prof.beginFrame(now);
  clock.update(now);
  const dt = Math.min(clock.getDelta(), DT_MAX);
  // only frames that rendered measure how expensive rendering is
  if (renderedLast) autoResolution(dt, clock.getElapsed());

  const cam = camState();
  if (cam !== camShown) toolbar.setCamera(camShown = cam);
  if (pov?.active) pov.update(dt);
  else {
    rig.update(dt);
    controls.update();
  }
  if (win) moveWindow();
  // In World the far field carries on past the window, so its outline would only be lines in the sky
  // and the landscape; where the god view can paint shows by the brush, which stops at the window's edge.
  edges.visible = !win;
  updateBrush();

  prof.phase('paint');
  if (painting && brushValid) {
    const stroke = {
      center: brushCenter, radius: settings.radius, shape: settings.shape,
      tool: settings.tool, rate: settings.rate, replace: settings.replace,
    };
    if (mp.isGuest) mp.paint(stroke); // the host paints it
    else sim.paint(stroke);
  }
  prof.phase('sim');
  const stepping = !mp.isGuest && (!settings.paused || stepOnce);
  if (stepping) {
    for (let i = 0; i < settings.steps; i++) sim.step();
    lightning.update(sim);   // storms: charged cloud strikes by itself (src/lightning.js)
    if (DAY.running) day.clock += settings.steps;
    stepOnce = false;
  } else if (mp.isGuest && DAY.running) day.clock += settings.steps;   // guests don't step: keep the day going at their own rate
  updateSun();
  if (birds) {
    prof.phase('other');   // (their probe pass, birdProbe, counts here)
    birds.update(settings.paused ? 0 : dt);   // they hold still with the world
    if (!settings.paused && birds.count) pacer.wake();
  }
  if (settings.time !== timeShown) {
    timeShown = settings.time;
    if (settingsPanel.isOpen) settingsPanel.sync();
  }
  prof.phase('other');
  mp.update(dt, {
    visible: brushValid && pointerInside && !uiHover, center: brushCenter, painting,
    radius: settings.radius, shape: settings.shape, tool: settings.tool,
  });
  const worldChanged = sim.version !== lastVersion;
  lastVersion = sim.version;
  const runDerived = pacer.derived(
    `${sim.id}:${sim.version}|${SUN.x},${SUN.y},${SUN.z}|${KEY_LIGHT}|${settings.view}|${gfx.smoothing}|${detailVersion}`);
  const runView = pacer.view(
    `${camera.matrixWorld.elements}|${camera.projectionMatrix.elements}|${pixelRatio}|${innerWidth}x${innerHeight}`
    + `|${JSON.stringify(settings)}|${JSON.stringify(gfx)}|${JSON.stringify(post.settings)}|${sceneKey(scene)}`
    + `|${win?.far?.chunksDrawn}`,   // a world scene's far field filling in (world/far.js)
    runDerived || wantShot || post.adapting);   // (eyes adjusting to the dark: gfx/post.js ADAPT)
  // a frame's dt measures the drawing rate only when the frame before it drew too
  if (runView && renderedLast) { frames++; fpsTime += dt; }
  if (fpsTime > FPS_WINDOW) { fps = frames / fpsTime; frames = 0; fpsTime = 0; }
  idleTime = runView ? 0 : idleTime + dt;
  renderedLast = runView;
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
    detailGate.update(camera, u.uCam.value, [sim.g.nx, sim.g.ny, sim.g.nz], scene);
    win?.far.view(volume, settings.view === 0);
    u.uView.value = settings.view;
    if (worldChanged) u.uTime.value += dt;   // animated looks (lava, ripples) hold still while the world does

    post.settings.raw = settings.view !== 0;
    post.settings.upscale = UPSCALE[settings.upscale] ?? UPSCALE.native;
    gfxUniforms.uNearGI.value = settings.nearGI;
    gfxUniforms.uGlowLights.value = settings.glowLights;
    gfxUniforms.uCaustics.value = settings.caustics;
    sim.rays.updateView(camera, renderer.domElement.height * post.renderScale);
    floorGrid.material.opacity = post.renderScale;
    edges.material.opacity = EDGE_OPACITY * post.renderScale;
    post.render(scene, camera, null, dt);   // its passes after the scene count as 'post' (postPass)
    prof.phase('other');
    // POV: the held tool, drawn over the finished frame in its own pass (no TAA, its
    // own depth, so it never clips into walls); before the screenshot reads the canvas
    renderViewmodels(renderer, scene, camera, post);
    if (wantShot) { wantShot = false; saveScreenshot(); }

    signs?.update();
    requestPick();
  } else if (pov?.active) requestPick();
  if (spawners) { spawners.setGhosts(!pov?.active); spawners.update(); }   // the crosshair cell stays fresh for the tools
  perkOrbs?.update();
  arenaMarkers?.update();

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
    stepsV: settings.paused || mp.isGuest ? 0 : settings.steps * fps, // guests don't simulate
    // the cells simulated (a world's window), and the world's
    cellsV: `${millions([g.nx, g.ny, g.nz])}${win ? ` of ${millions(win.size)}` : ''}`,
    resV: autoRes.enabled ? `${Math.round(pixelRatio * 100)}% res` : '',
  });
  prof.endFrame(stepping ? settings.steps : 0);
  lastIdle = !runView && !stepping && performance.now() - t0 < CAP_IDLE_MS;
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
  setPaused(false);
  toolbar.setUndoEnabled(false);
  pov = createPov({
    renderer, scene, camera, controls, canvas: renderer.domElement, hud, settings, mp, isTyping,
    getSim: () => sim, getVolume: () => volume, getScale: () => scale,
    hover, pointerHover: () => pointerInside && !uiHover, pickRay,
    getSpawners: () => spawners,
    getPerkOrbs: () => perkOrbs,
    requestRender: () => pacer.wake(),
    inWorld: () => !!win,
    showToolsMenu: () => dock.reveal((it) => isGearTool(it.id)),   // Q in first person: the palette at its first-person tools
  });
  pov.vehicles.spawnLayout(arenaLayout);   // the scene loaded before the POV shell existed
  window.__app = {
    get sim() { return sim; }, get volume() { return volume; }, get scale() { return scale; }, get signs() { return signs; }, get builds() { return builds; },
    get pov() { return pov; },
    get spawners() { return spawners; },
    get birds() { return birds; },
    get perkOrbs() { return perkOrbs; },
    lightning,     // the Lightning tool's and storms' bolts (src/lightning.js)
    // the loaded arena's layout (spawns, flags, hills, siege core, shrines, vehicles: arenas/damValley.js), else null
    get arena() { return arenaLayout; },
    get win() { return win; },
    // world mode: start the world over with the window at `origin` (world cells)
    worldLoad(origin) { win.load(origin); placeVolume(); post.reset(); pov?.worldReplaced(); },
    setSize,         // switch the grid as the Grid size row does, without its toast (a SIZES or WORLDS key)
    undo,            // as ⌘Z does
    get worldFocus() { return worldFocus; }, set worldFocus(v) { worldFocus = v; },
    MOBILE, SUN, day, scene, settings, camera, controls, loadPreset, selectTool, setView, hover, renderer, rig, renderThumb, gfx, post, mp, autoRes, prof,
    applyDetail,   // after changing settings.detail_* by hand
    detailGate,    // .level / .shown: which close-up features the view has compiled in
    THREE,         // for tools (tools/detail-bench.mjs makes its own targets)
    requestRender: () => pacer.wake(),   // for changes the frame loop can't see (async results)
  };
  requestAnimationFrame(frame);
} catch (err) {
  const el = document.getElementById('error');
  el.style.display = 'flex';
  el.textContent = String(err.stack || err);
  throw err;
}
