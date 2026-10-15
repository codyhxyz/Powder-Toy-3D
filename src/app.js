// The game (docs/webgpu.md J1 U8): the settings, the grid and its scene, the
// UI and input, and the frame loop, on one WebGPU device (src/gpu, B1).
//
// A presented frame (B3, F1; post.render's hooks, gfx/post.js): E1's work
// first (the brush, the steps), then FrameUniforms, the derived passes, the
// shadow map and the picks; three.js's opaque meshes if it has any (Sync log
// S1); our scene pass (the floor grid, the volume, the box's edges, the
// brush); three's transparent meshes and the rays' sprites; post; the canvas.
// In box mode three has nothing to draw, so a frame is one command buffer.
// Every pipeline builds asynchronously (B5): the boot waits for the ones the
// session draws with (warm from the start menu, src/preload.js), and a view
// switched to for the first time builds then, drawing without the volume
// meanwhile. A settled scene schedules no animation frames at all (deep idle,
// F7): the frame loop stops and input, a resize, a setting or a landed read
// starts it again.
//
// What hooks into the game (the world, first person, rays, lightning, signs,
// birds, multiplayer, the meshes, whitewater, decoration, the console, saves)
// is wired in src/wire/*.js, one module per subsystem (J3). A wire whose
// unit hasn't ported it to WebGPU yet isn't called, and what it serves is
// greyed out (its tools, the first-person camera, Save, the World maps).
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './ui/styles.css';
import { createGpu } from './gpu/device.js';
import { createPresenter } from './gpu/present.js';
import { createThreeRenderer, useWebGPUCamera, threeHasVisible } from './gpu/three.js';
import { Simulation, GI_BLEND } from './sim.js';
import { seedWaveDemo } from './world/waveDemo.js';
import { Derived } from './derived.js';
import { createVolume } from './gfx/volume.js';
import { createBlocks } from './gfx/blocks.js';
import { viewShadows } from './shaders/render.js';
import { createOverlays, FLOOR_SPAN, FLOOR_Y } from './gfx/overlays.js';
import { ELEMENTS, E, TOOLS, toolById, isBuild, isSpawnerTool, isGearTool, LIGHTNING_TOOL, PROP_TOOL, wandPresetForTool, isDecoTool } from './elements.js';
import { rayKindOfTool, RAY_KIND } from './rays.js';
import { propIndex, parseProp, boxFromCorners, runFill, oneShotRate, FILL_AIR, FLOOD_MAX_CELLS } from './editing.js';
import { SPAWNER, feetOnHit } from './spawners.js';
import { HAND_REACH } from './pov/constants.js';
import { faceNormal } from './pov/grid.js';
import { buildPreset, ARENA_PRESETS } from './presets.js';
import { DAM_VALLEY_BANNERS, shrineAltars } from './arenas/damValley.js';
import { sceneByKey } from './world/scenes/index.js';
import { WORLD_SIZE } from './shaders/farShared.js';
import { createBrushCursor } from './brush.js';
import { bindBrushEraseClick } from './brushInput.js';
import { createCameraRig } from './camera.js';
import { createMeshCut } from './gfx/meshCut.js';
import { createMeshFrames } from './gfx/meshFrames.js';
import { createBrand, createToolbar } from './ui/topbar.js';
import { createDock } from './ui/dock.js';
import { createCard } from './ui/card.js';
import { createSettings } from './ui/settings.js';
import { createShaderPicker } from './ui/shaders.js';
import { createHud, createHelp } from './ui/hud.js';
import { createScoreboard } from './ui/scoreboard.js';
import { h, inkFor, luminance } from './ui/dom.js';
import { gfx, gfxUniforms, updateGfxUniforms, writeFrameUniforms } from './gfx/uniforms.js';
import { cloudShift } from './shaders/gfx/clouds.js';
import { DETAIL, settingKey, detailDefaults, detailRows } from './gfx/detail.js';
import { createDetailGate, gateVariants } from './gfx/detailGate.js';
import { createColdShaderGuard } from './gfx/coldShader.js';
import { createGpuLossTracker, failureKind, lossDetails } from './gfx/gpuLoss.js';
import { createPost, createAutoResolution, UPSCALE, UPSCALE_FLOOR } from './gfx/post.js';
import { canPostFrame } from './gfx/postFrames.js';
import { sprintBlurStep } from './gfx/sprintBlur.js';
import { createPresentation } from './gfx/presentation.js';
import { inverseRay, rayPoint, planeRoots, warp } from './gfx/presentationMath.js';
import { povEvents } from './pov/events.js';
import { createPacer, settleFrames, createViewKey, createFrameLoop, createCapCheck, CAP_IDLE_MS, MAX_FPS } from './gfx/pacing.js';
import { createViewSettings, bindViewInputWake, brushKey } from './gfx/viewInputs.js';
import { CHANNELS, MEDIA } from './gfx/materials.js';
import { DAY, dayPhase, phaseSteps, keyLight } from './gfx/daylight.js';
import { createProfiler } from './gfx/profiler.js';
import { PHYS } from './physics.js';
import { createProfilerPanel } from './ui/profiler.js';
import { POV_FOV, POV_FOV_RANGE, SENSITIVITY_RANGE } from './pov/camera.js';
import { inventory } from './pov/tools/inventory.js';
import { gearByKey, SLOTS } from './pov/tools/catalog.js';
import { finishSignIn, account, accountsEnabled } from './account.js';
import { accountSection } from './ui/account-section.js';
import { launch, mark } from './launch.js';
import { HOMES as VILLAGE_HOMES, FLOOR as VILLAGE_FLOOR, HOME_Z as VILLAGE_Z, HOME_ENTRY } from './pov/village/state.js';
import { withCityBusFocus } from './pov/village/bus.js';
import { MAPS, mapByKey, mapOf, isWorld, sizeTag, WORLD_DIMS, resolveMode, modeByKey } from './maps.js';
import { SIM_MODE_DEFAULTS, simModeRows, applySimModes, sanitizeModes, modeToast, MODE_KEYS, nextMode } from './simModes.js';
import { SUPER_SETTLE_STEPS } from './shaders/activity.js';
import { VIEWS, viewKey as viewKeyOf, isMaterialView, viewForMode } from './views.js';
import { createReadyVolumeView } from './gfx/readyVolumeView.js';
import { WIRES, wireNamed } from './wire/index.js';
import { offline as OFFLINE } from './wire/mp.js';
import weatherWire, { weather } from './wire/weather.js';
import { weatherSection } from './ui/weather.js';

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
// WASD in a world: no faster than the window can follow the orbit target
// (one WIN_STEP move every few frames), in scene units per second
const WORLD_CAM_SPEED_MAX = 9;
const SIGN_TOOL = -5;
const SPAWNER_KIND = { [-6]: SPAWNER.ENEMY, [-7]: SPAWNER.PLAYER, [-20]: SPAWNER.JEEP, [-21]: SPAWNER.HOVERBIKE, [-22]: SPAWNER.BOAT,
  [-30]: SPAWNER.GUNNER, [-31]: SPAWNER.WORM, [-32]: SPAWNER.GIANT_WORM, [-33]: SPAWNER.BIRDS };   // the Spawners tools' kinds
const SPAWNER_SET = { [SPAWNER.PLAYER]: 'Player spawn set: V drops you in here' };
// the lab's own enemy spawner: its open south floor, as shares of the grid (the old lab NPC's arena)
const LAB_ENEMY_AT = [0.555, 0.86];

// ---------------------------------------------------------------- the subsystems' wiring (src/wire)
// The wires whose units have landed: their hooks run (src/wire/index.js).
const live = WIRES.filter((w) => w.ready);
// A subsystem's wire if it is ready, else null.
const wire = (name) => (wireNamed(name)?.ready ? wireNamed(name) : null);
// What a subsystem that isn't ported yet says when asked for (its tool, its
// button, its map): 'World maps: not in this WebGPU version yet'.
const notYet = (what) => `${what}: not in this WebGPU version yet`;
// The subsystem a tool needs (src/wire), or null for the brush's own.
function toolWire(id) {
  if (id === LIGHTNING_TOOL) return 'lightning';
  if (id === SIGN_TOOL) return 'signs';
  if (SPAWNER_KIND[id] === SPAWNER.BIRDS) return 'birds';
  if (isSpawnerTool(id) || isBuild(id)) return 'mesh';
  if (isDecoTool(id)) return 'deco';
  if (rayKindOfTool(id) !== RAY_KIND.NONE) return 'rays';
  if (wandPresetForTool(id) || isGearTool(id)) return 'pov';
  return null;
}

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
  character: 'real', villageCharacter: 'boy', povFov: POV_FOV, sensitivity: 1, viewBobbing: true, sprintMode: 'hold',
  sprintBlur: true, sprintMusic: true,
  nearGI: true, glowLights: true, caustics: true,
  ...detailDefaults(),
  profiler: false,
};
// Phones and tablets (touch-first, no hover) start on the plain look in the
// Lab box: no World, no extra lighting passes, no close-up detail, and the
// cheapest upscaling. Only the defaults change; anything the player picks in
// Settings still sticks.
const MOBILE = matchMedia('(hover: none) and (pointer: coarse)').matches;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
REDUCED_MOTION.addEventListener('change', () => wakeLoop());
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
  'camSpeed', 'upscale', 'dockCollapsed', 'character', 'villageCharacter', 'povFov', 'sensitivity', 'viewBobbing', 'sprintMode', 'sprintBlur', 'sprintMusic',
  'nearGI', 'glowLights', 'caustics', ...DETAIL.map(settingKey), 'profiler'];
const STORE = 'powder-toy-3d:settings';
// Fixed look: glow is heat-driven light (×uLightGain); smoothing, TAA, bloom and
// exposure keep their defaults in gfx/uniforms.js and gfx/post.js.
const GLOW_GAIN = 1.6;

// The frame loop (gfx/pacing.js createFrameLoop): it stops when a frame
// finds nothing to do (deep idle, F7) and anything that changes what the view
// shows wakes it.
let loop = null;
function wakeLoop() { loop?.wake(); }
// A setting that changes wakes a sleeping frame loop: the drawer's rows, the
// dock and tools all write through here.
const settings = new Proxy({ ...DEFAULTS }, {
  set(t, k, v) {
    const changed = t[k] !== v;
    t[k] = v;
    if (changed) wakeLoop();
    return true;
  },
});
Object.assign(settings, SIM_MODE_DEFAULTS);   // world options (simModes.js): not remembered, a fresh scene starts them over
try {
  // only keys still in use: values of removed settings must not linger
  const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
  for (const k of PERSIST) if (k in saved) settings[k] = saved[k];
  const rev = saved[REV_KEY] ?? (saved[LEGACY_MOBILE_KEY] ? 1 : 0);
  for (const change of DEFAULT_CHANGES.slice(rev)) Object.assign(settings, change);
} catch { /* storage unavailable */ }
const params = new URLSearchParams(location.search);
// ?shot=<name>: a shot of the side-by-side sheet (src/shot.js), its scene's parameters set here, played once booted
const shotLink = params.has('shot') ? await import('./shot.js') : null;
const linkShot = shotLink?.shotParams(params) ?? null;
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
// ?view=plain (or a view's id): the view to boot in. The test tools boot the
// plain view, the cheapest to build (docs/webgpu.md B5, I1).
const viewParam = params.get('view');
const linkedView = VIEWS.find((v) => v.key === viewParam || String(v.id) === viewParam);
if (linkedView) settings.view = linkedView.id;
// ?win=<x>[,<y>,<z>]: a world window of another size, for the test tools
// (docs/webgpu.md G1: container tests run world scenes 64 wide), applied by
// build() before the window's Simulation is made (worldModeOf). x and z are
// whole supertiles (WIN_ALIGN), z defaulting to x. y only where the scene's
// world allows: a window always spans its world's height (world/window.js),
// so a y other than that height is ignored, with a warning.
const WIN_ALIGN = 16;   // cells: world/window.js WIN_STEP, whole supertiles along x and z
const winParam = params.get('win')?.split(',').map(Number);
let winSize = winParam?.every((n) => Number.isInteger(n) && n > 0)
  ? [winParam[0], winParam.length > 1 ? winParam[1] : null, winParam[2] ?? winParam[0]] : null;
if (winSize && (winSize[0] % WIN_ALIGN || winSize[2] % WIN_ALIGN)) {
  console.warn(`?win=${params.get('win')}: a window's x and z are multiples of ${WIN_ALIGN}; ignored`);
  winSize = null;
}
// World mode's world and window for WORLDS size `size` with scene `scene` (a key): ?win='s window, if any
function worldModeOf(size, scene) {
  const w = worldOf(WORLDS[size], sceneByKey(scene));
  if (!winSize) return w;
  if (winSize[1] !== null && winSize[1] !== w.win[1]) console.warn(`?win=: a window spans its world's height, ${w.win[1]} here; y ${winSize[1]} ignored`);
  return { ...w, win: [winSize[0], w.win[1], winSize[2]] };
}
// Why the device can't hold a grid of `dims` cells (B2: both copies of the state in one binding), or null if it can.
const gridRefusal = (dims) => gpu.fitsReason({ nx: dims[0], ny: dims[1], nz: dims[2] });
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
// the gamemode playing (maps.js GAMEMODES): the start menu's pick, or ?mode= with ?map=; Sandbox otherwise.
// Set from the first frame: Noita's wands-only toolbelt reads it (pov gamemode). modeEpoch: a later
// map or mode takes over a mode still starting (startMode)
let selectedMode = bootMap ? resolveMode(bootMap, launch.mode ?? params.get('mode') ?? 'sandbox').key : 'sandbox', modeEpoch = 0;
// Launch defaults supersede a saved shader, not an explicit URL or a later picker change.
if (!linkedView) settings.view = viewForMode(modeByKey(selectedMode), settings.view, mapOf(settings));
if (!toolById(settings.tool)) settings.tool = DEFAULTS.tool;
if (propIndex(settings.propField) < 0) settings.propField = DEFAULTS.propField;
if (!VIEWS.some((v) => v.id === settings.view)) settings.view = 0;
// (a saved 'wizard', the Castle Crashers body that was the default, falls back to it too)
if (!['real', 'woman', 'stick'].includes(settings.character)) settings.character = DEFAULTS.character;
if (!['boy', 'girl'].includes(settings.villageCharacter)) settings.villageCharacter = DEFAULTS.villageCharacter;
settings.paused = params.get('paused') === '1' || testMode === 'manual' || testMode === 'ui';
// ?physics=v2: the new physics' fast version (src/v2/physics.js, docs/v2.md 5) in box mode, loaded only
// then; not persisted. A world, first person and a multiplayer guest keep today's physics (the box
// switches back to it while the body is out, and to v2 again after). __app.setPhysics('v2' | 'v1') for tools.
let physicsMode = params.get('physics') === 'v2' ? 'v2' : 'v1';
// Experimental opt-in, not persisted. The default renderer remains unchanged.
const hybridModule = params.get('renderer') === 'hybrid' ? await import('./gfx/hybrid/index.js') : null;
let V2mod = physicsMode === 'v2' ? await import('./v2/physics.js') : null;
let physicsV2 = null;    // the box's PhysicsV2 while the mode is v2
let v2Running = false;   // the last steps were v2's (switching away notes a whole write for today's activity map)

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ ...Object.fromEntries(PERSIST.map((k) => [k, settings[k]])), [REV_KEY]: DEFAULT_CHANGES.length })); } catch { /* storage unavailable */ }
  }, 300);
}

// ---------------------------------------------------------------- the device, three.js and the canvas
// The device: the one the start menu made while it was up (src/preload.js),
// else one now. A refused device is the WebGPU error page's case, not a bug
// in here: main.js tells them apart by launch.deviceError (G5).
let gpu;
if (launch.startupError) throw launch.startupError;
try {
  gpu = await (launch.gpu ??= createGpu({ adapter: launch.adapter ?? undefined, label: 'tpt3d' }));
  if (launch.startupError) { gpu.fail(launch.startupError); throw launch.startupError; }
  // The menu's device lost (or stopped) while the menu was up: the GPU
  // process restarted, a phone put the tab away. Nothing of the game lived on
  // it yet (B9's "no restore" is about the state on the GPU, which starts
  // here), so the game starts on a new one, on a new adapter: an adapter
  // makes one device.
  if (gpu.lost || gpu.failure) {
    if (launch.startupError) throw launch.startupError;
    gpu.destroy();
    gpu = await (launch.gpu = createGpu({ label: 'tpt3d' }));
    if (launch.startupError) { gpu.fail(launch.startupError); throw launch.startupError; }
  }
} catch (err) {
  launch.deviceError = err;
  throw err;
}
// The canvas is ours: three.js sizes it and renders only into render targets,
// and post's canvas pass presents (docs/webgpu.md W7, F7). It is opaque (the
// composite draws the page's sky), with neither MSAA nor a depth buffer: TAA
// antialiases upstream.
const canvas = document.createElement('canvas');
document.getElementById('app').appendChild(canvas);
const presenter = createPresenter(gpu, canvas);
const renderer = await createThreeRenderer(gpu, canvas, { hdr: presenter.hdr });
if (launch.startupError) { gpu.fail(launch.startupError); throw launch.startupError; }
// The canvas matches the screen's pixels (up to RETINA_MAX), so the browser no
// longer stretches a CSS-sized picture 2× on a Retina display. The Upscaling
// presets are shares of these real pixels, as AMD FSR 2 defines its modes
// (gfx/post.js UPSCALE): Off renders every one of them. Phones stay at 1
// (their GPUs pay for every output pixel of post).
// The canvas takes the screen's pixels only while the preset draws the scene
// with more pixels than the page has (Off, Quality and Balanced on Retina).
// Fast draws it at the page's size, where a Retina canvas adds output pixels
// and nothing for them to show but TAAU's still-camera build-up, and post pays
// for every one: 14.1 ms at the Retina canvas against 3.8 ms at the page's
// size for the same 1.3 MP scene, measured on the M5 (2026-10-13). Fast keeps
// the page-sized canvas, the scene 1:1 on it, and auto resolution still works
// under it (post.settings.adaptive) from the same floor of the screen.
const RETINA_MAX = 2;
const DEVICE_RATIO = MOBILE ? 1 : Math.min(devicePixelRatio, RETINA_MAX);
const presetOf = () => UPSCALE[settings.upscale] ?? UPSCALE.native;
const outputRatio = () => (presetOf() * DEVICE_RATIO > 1 ? DEVICE_RATIO : 1);
let pixelRatio = outputRatio();
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
// The canvas follows the Upscaling preset (Settings), however it was set: at a
// frame's start, before it draws anything (tick), as the resize does between frames.
function applyOutputRatio() {
  if (outputRatio() === pixelRatio) return;
  pixelRatio = outputRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
}

// the grid: the simulation, its derived passes and its volume (made per grid: build)
let sim, derived, vol, scale, hybrid = null;
// The blocks renderer (gfx/blocks.js) draws the Plain view (src/views.js):
// the world as its cells' visible faces, Minecraft's way, and nothing that
// only feeds the volume's march runs (the derived passes, GI, the volume's
// shadow map). Every other view is the volume's.
const plainView = (id = settings.view) => viewKeyOf(id) === 'plain';
let blocksOn = plainView();
let blocks = null;   // the grid's (made by build() while blocksOn, or by setBlocks)
// world mode (a WORLDS size): the world, the window over it (src/wire/world.js)
let worldMode = null, win = null;
let wired = false;   // the wires have booted (their invalidate hooks can run)

let graphicsFailure = null;
// What the page was doing when its GPU work stopped (gfx/gpuLoss.js), kept for the bug report.
const gpuLoss = createGpuLossTracker(gpu);
// Graphics stop once, for good (docs/webgpu.md B9): device loss, an uncaptured
// error (ours or three's) or a pipeline that didn't build. After it gpu.frame
// throws the same GraphicsFailure, so every entry point that would record GPU
// work (a step, a stroke, a load, a map) throws it, and the frame loop stops.
// There is no restore: the state lived on the GPU.
function stopGraphics(error) {
  if (!graphicsFailure) {
    graphicsFailure = error;
    gpuLoss.record({ kind: failureKind(error.message), message: error.message.slice(0, 2000), ...gpuLoss.snapshot() });
    invalidateGpuWork();
    const el = document.getElementById('error');
    el.style.display = 'flex';
    const lost = failureKind(error.message) === 'deviceLost' ? `\n${lossDetails(gpuLoss.snapshot())}` : '';
    el.textContent = `${error.message}${lost}\n\nRendering and simulation stopped. Reload to restart.\nUnsaved simulation changes may be lost.`;
    console.error('Graphics stopped:', error);
    launch.failed?.(error);
  }
  return graphicsFailure;
}
gpu.onFailure(stopGraphics);
// A gamemode's presentation effect (gfx/presentation.js; maps.js GAMEMODES.effect:
// Animal Crossing's rolling log): the displayed world bends, physics stays flat.
// Selecting one drops TAA's history, ends a stroke and wakes the view.
const presentation = createPresentation(() => {
  post.reset(); pacer.wake();
  hover.valid = false; painting = false;
});
// HDR post: TAA, bloom, AgX tone mapping, the canvas (src/gfx/post.js); made
// after three's renderer, so its scene target is three's (docs/webgpu.md F3).
// A change to its settings wakes the frame loop, as the app's do. Its TAA
// reprojects through the presentation's bend.
const post = createPost(gpu, { presenter, pixScale: gfxUniforms.uPixScale, presentation });
post.settings = new Proxy(post.settings, {
  set(t, k, v) {
    const changed = t[k] !== v;
    t[k] = v;
    if (changed) wakeLoop();
    return true;
  },
});
// the floor grid and the box's edges, and the brush cursor: pipelines of ours in the scene pass (F1)
const overlays = createOverlays(gpu);
const brush = createBrushCursor(gpu);
// the volume's march stops at the opaque meshes in it (gfx/meshCut.js; Sync log S1)
const cut = createMeshCut(gpu);
// the scene kept while only three's meshes move (gfx/meshFrames.js; docs/webgpu.md K3):
// its pipelines build on first use, and the frame after draws with them
const meshFrames = createMeshFrames(gpu, { onReady: () => pacer.wakeMeshes() });

// three.js's scene: the meshes (src/wire's), and two transforms of ours whose
// changes the view key sees (gfx/pacing.js createViewKey): the grid's box
// (`volume`: grid cells → scene; the raymarch draws it) and the floor grid's.
const scene = new THREE.Scene();
const camera = useWebGPUCamera(new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 200));
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.zoomToCursor = true;
controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };   // one finger paints (touchDown)
// What gpu.three.prepare(object) compiles a new kind of mesh for (B5, F8):
// this camera and scene, and the formats of the scene target three renders
// the meshes into (post's; sized here if no frame has sized it yet). The
// target is the same RenderTarget across resizes (post resizes it in place).
gpu.three.defaults = {
  camera, scene,
  get target() {
    if (!post.sceneTarget.rt) post.setSize(undefined, undefined, post.renderScale);
    return post.sceneTarget.rt;
  },
};

// three's GridHelper(FLOOR_SPAN, FLOOR_SPAN) as it was, now drawn by
// gfx/overlays.js: its transform here (a world's is stretched over it)
const floorGrid = Object.assign(new THREE.Object3D(), { name: 'floorGrid' });
floorGrid.position.y = FLOOR_Y;
scene.add(floorGrid);
const volume = Object.assign(new THREE.Object3D(), { name: 'volume' });
scene.add(volume);

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

const isTyping = () => {
  const a = document.activeElement;
  return !!(signs?.editing || (a && (a.tagName === 'TEXTAREA' || a.isContentEditable ||
    (a.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(a.type)))));
};
const rig = createCameraRig(camera, controls, isTyping);

// the subsystems the wires fill in (src/wire), null while theirs isn't ready
let pov = null, mp = OFFLINE, signs = null, builds = null, spawners = null, perkOrbs = null, arenaMarkers = null;
let birds = null, lightning = null, scripts = null, descent = null;
let lastShrine = 0;    // the shrine id the last placement's orbs got (0: it set none)
// Stop work that would read back a world the GPU no longer has.
function invalidateGpuWork() {
  sim?.wake(); // reject an outstanding idle certification
  if (wired) for (const w of live) w.invalidate?.(ctx);
}
const anchor = new THREE.Vector2();
let pickPending = false;
// The presentation's frame: scene units → world cells (the grid's box sits at its world
// origin less the anchor, × scale), and the camera that anchors the bend (beneath the eye)
const presentationTransform = new THREE.Matrix4();
function updatePresentation() {
  presentationTransform.makeScale(1 / scale, 1 / scale, 1 / scale).setPosition(anchor.x, 0, anchor.y);
  presentation.update(camera, presentationTransform);
}
// A team match takes over the gamemode (its own effect: none); one that ends gives the map back to Sandbox
povEvents.on('game:start', ({ mode }) => { selectedMode = mode; presentation.select(null); pacer.wake(); });
povEvents.on('game:end', () => {
  if (modeByKey(selectedMode)?.team) { selectedMode = 'sandbox'; presentation.select(null); pacer.wake(); }
});
// the grid's pipelines (B5): coreReady once the ones a frame draws with are built
let coreReady = false, coreWait = Promise.resolve();
const readySims = new WeakSet();   // simulations whose own pipelines are ready (a load can be recorded)
let viewTime = 0;   // s the scene's animations have run (FrameUniforms.time: it runs with the simulation)

let replicaMap = null;
function build(savedWorldSize = null) {
  if (!mp.replica) { replicaMap = null; mp.resumeSolo?.(); }
  if (graphicsFailure) throw graphicsFailure;
  pov?.exit(true);   // the body lives in the old grid
  pov?.worldReplaced();
  if (sim) {
    for (const w of live) w.detach?.(ctx);
    // (what is recorded on the old grid goes out first: each dispose flushes)
    vol.dispose();
    hybrid?.dispose();
    hybrid = null;
    blocks?.dispose();
    blocks = null;
    derived.dispose?.();
    physicsV2?.dispose();
    physicsV2 = null;
    v2Running = false;
    sim.dispose();
  }
  worldMode = replicaMap?.mode === 'world' ? { win: replicaMap.dims, size: replicaMap.size } : settings.size in WORLDS ? worldModeOf(settings.size, settings.scene) : null;
  if (worldMode && savedWorldSize) worldMode = { ...worldMode, size: savedWorldSize };
  if (worldMode && !wire('world')) {
    // (until the world's port lands: the box, and why)
    worldMode = null;
    settings.size = boxSize;
    hud.toast(`${notYet('World maps')}. Here is a box instead`, { kind: 'error' });
  }
  // a grid the device can't hold (B2; from a link or the menu's first Start): the default box, and why
  const refused = gridRefusal(worldMode?.win ?? SIZES[settings.size]);
  if (refused) {
    hud.toast(`${dimsName(worldMode?.win ?? SIZES[settings.size])} ${refused}. Here is a ${dimsName(SIZES[BOX_DEFAULT])} box instead`, { kind: 'error' });
    worldMode = null;
    settings.size = boxSize = BOX_DEFAULT;
  }
  const [nx, ny, nz] = worldMode?.win ?? SIZES[settings.size];
  win = null;
  sim = new Simulation(gpu, nx, ny, nz, { windowed: !!worldMode, world: worldMode?.size });
  if (physicsMode === 'v2') {
    if (worldMode) hud.toast('The new physics (?physics=v2) runs in boxes: this world keeps today\'s', { kind: 'hint' });
    else {
      physicsV2 = new V2mod.PhysicsV2(sim);
      physicsV2.ready.then(() => wakeLoop(), () => {});   // (the loop may have slept meanwhile)
    }
  }
  derived = new Derived(sim);
  blocksOn = plainView();
  vol = createVolume(gpu, sim, { shadows: !blocksOn && viewShadows(viewKeyOf(settings.view)), sourceAppearance: !!(worldMode && sceneByKey(settings.scene).importManifest?.appearance) });
  hybrid = hybridModule?.createHybridRenderer(gpu, sim, {
    post, invalidateCaches: () => meshFrames.drop(), onRead: () => wakeLoop(),
    world: !!worldMode, sourceAppearance: !!(worldMode && sceneByKey(settings.scene).importManifest?.appearance),
  }) ?? null;
  if (blocksOn) blocks = createBlocks(gpu, sim, { world: !!worldMode });
  // a write from anywhere (a tool's stroke, a load) wakes the frame loop (F7)
  const s = sim, simWake = s.wake.bind(s);
  s.wake = () => { simWake(); wakeLoop(); };
  applyGravity();
  sim.airT = worldMode ? sceneByKey(settings.scene).airT ?? PHYS.AMBIENT : PHYS.AMBIENT;   // (a box: room temperature)
  applySimModes(sim, settings);
  scale = 10 / Math.max(nx, nz);
  volume.scale.setScalar(scale);
  // the pipelines a frame needs (warm from the start menu, or building now)
  coreReady = false;
  s.ready.then(() => readySims.add(s), () => {});
  const core = coreWait = Promise.all([s.ready, derived.ready, vol.ready, vol.noiseReady, post.ready, overlays.ready, brush.ready, hybrid?.ready,
    blocks ? blocks.ready : vol.viewReady(viewKeyOf(settings.view), baseDetail(), !!warpNow())]).then(() => {
    if (coreWait === core) { coreReady = true; wakeLoop(); }
  });
  core.catch(() => {});   // (a pipeline that fails stops graphics: stopGraphics says why)
  prepareGI();
  for (const w of live) w.attach?.(ctx);   // (a world's window sets sim.origin)
  // the grid starts centred on the scene's origin
  anchor.set(sim.origin.x + nx / 2, sim.origin.z + nz / 2);
  // the floor grid: under a box, or across a world's whole footprint
  const span = win ? [win.size[0] * scale, win.size[2] * scale] : [FLOOR_SPAN, FLOOR_SPAN];
  floorGrid.scale.set(span[0] / FLOOR_SPAN, 1, span[1] / FLOOR_SPAN);
  floorGrid.position.x = win ? (win.size[0] / 2 - anchor.x) * scale : 0;
  floorGrid.position.z = win ? (win.size[2] / 2 - anchor.y) * scale : 0;
  floorGrid.updateMatrixWorld();
  placeVolume();
  gfxUniforms.uClouds.value = false;   // a box has no sky of its own (a world's far field turns its clouds on)
  applyDetail();

  const h = ny * scale;
  if (win) homeOver(anchor.x, anchor.y);
  else rig.setHome(new THREE.Vector3(11, h * 0.9 + 3, 13), new THREE.Vector3(0, h * 0.25, 0));
  rig.setMaxSpeed(win ? WORLD_CAM_SPEED_MAX : Infinity);
  rig.reset(true);
  // an arena only fits its own grid: in another, the lab
  if (!win && settings.preset in ARENA_GRID && ARENA_GRID[settings.preset] !== settings.size) settings.preset = 'lab';
  loadPreset(settings.preset, false);   // (once the simulation's pipelines are ready: whenSimReady)
}

// Runs fn now if the simulation's own pipelines are built (a load or a stroke
// can be recorded), else once they are, unless the grid was rebuilt meanwhile.
function whenSimReady(fn) {
  if (readySims.has(sim)) { fn(); return; }
  const s = sim;
  s.ready.then(() => { if (s === sim && !graphicsFailure) fn(); }, () => {});
}

// Lit material views draw the gate's base variant first (gfx/detailGate.js).
const baseDetail = () => (isMaterialView(settings.view) ? gateVariants(settings).base : {});

// The GI's kernels (derived.prepareGI, U9) build with lit material views
// (B5: at boot in one, or on switching to it). Until they
// are built updateGI records nothing and the probes stay dark; their ready
// re-keys the derived passes (giBuilt), so the next frame traces them, and
// test.ready() waits for them (giWait).
let giWait = Promise.resolve(), giBuilt = 0;
function prepareGI() {
  const d = derived;
  if (blocksOn || !isMaterialView(settings.view) || !d?.prepareGI) return;
  const p = giWait = Promise.resolve(d.prepareGI()).then(() => { if (d === derived) { giBuilt++; wakeLoop(); } });
  p.catch(() => {});   // (a kernel that fails stops graphics: stopGraphics says why)
}

// World: the god view's home over world column (x, z) (src/wire/world.js)
function homeOver(x, z) { wire('world')?.homeOver(ctx, x, z); }

// The grid's box in the scene: at its world origin, so a window moving over
// the world leaves the camera and everything already drawn where they are.
function placeVolume() {
  volume.position.set((sim.origin.x - anchor.x) * scale, 0, (sim.origin.z - anchor.y) * scale);
  volume.updateMatrixWorld();
}
let worldFocus = null, villageFocus = null;

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
function setGrid(dims, meta = null) {
  if (replicaMap?.id === meta?.id && !!win === (meta?.mode === 'world') && [sim.g.nx, sim.g.ny, sim.g.nz].every((n, i) => n === dims[i])) return true;
  const size = Object.keys(SIZES).find((k) => SIZES[k].every((n, i) => n === dims[i]));
  if (meta?.mode === 'world') {
    const s = sceneByKey(meta.scene), expected = s && worldOf(WORLDS.world, s);
    const supported = expected && [expected.size, s.legacySize].some(d => d?.every((n, i) => n === meta.size[i]));
    if (!s || s.key !== meta.scene || !supported || dims[1] !== meta.size[1] || dims.some((n, i) => n > meta.size[i]) || !gridFits(dims)) return false;
    settings.size = 'world'; settings.scene = meta.scene; worldSeed = meta.seed;
    selectedMode = 'sandbox'; presentation.select(null);
  } else {
    if (!size || !gridFits(SIZES[size])) return false;
    settings.size = boxSize = size;
  }
  replicaMap = meta ? { ...meta, dims } : null;
  build();
  return true;
}

// The cells of size `size`'s grid (SIZES, or a WORLDS window with scene `scene`).
const dimsOf = (size, scene = settings.scene) => (size in WORLDS ? worldModeOf(size, scene).win : SIZES[size]);
// A grid the device can't hold is refused, with the reason (B2). True if it can.
function gridFits(dims) {
  const why = gridRefusal(dims);
  if (why) hud.toast(`${dimsName(dims)} ${why}`, { kind: 'error' });
  return !why;
}

// Switch the grid to `size` (SIZES or WORLDS) and rebuild. False if the device can't hold it.
function setSize(size, savedWorldSize = null) {
  // Only an explicitly supported historical size can override a map's current size.
  if (savedWorldSize && (!(size in WORLDS) || !sceneByKey(settings.scene).legacySize?.every((n, i) => n === savedWorldSize[i]))) return false;
  if (mp.frozen) { mp.resumeSolo(); replicaMap = null; }
  if (graphicsFailure) throw graphicsFailure;
  if (!gridFits(dimsOf(size))) return false;
  settings.size = size;
  // a grid that is no longer the gamemode's map (or a mode the map doesn't have): Sandbox
  const resolved = resolveMode(mapOf(settings), selectedMode);
  if (resolved.key !== selectedMode || mapOf(settings)?.size !== size) startMode('sandbox');
  if (size in SIZES && !ARENA_GRIDS.has(size)) boxSize = size;
  build(savedWorldSize);
  save();
  return true;
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
  if (mp.frozen) { mp.resumeSolo(); replicaMap = null; }
  if (graphicsFailure) throw graphicsFailure;
  const m = mapByKey(key);
  if (!m || mp.guard() || (isWorld(m) && mp.guardWorld())) return false;
  if (isWorld(m) && mp.role === 'host' && mode !== 'sandbox') { hud.toast('World co-op supports Sandbox exploration only.'); return false; }
  if (isWorld(m) && !wire('world')) { hud.toast(notYet(`${m.name} (World maps)`), { kind: 'error' }); return false; }
  if (!gridFits(dimsOf(m.size, m.scene))) return false;
  modeEpoch++;
  pov?.game?.end();   // cancel pending team loads before replacing their world
  pov?.mission?.end();
  // the gamemode, and its presentation effect, before the grid: the build then
  // waits on the view's pipelines as they will draw (B5: the rolling log's
  // curved variants, behind the loading screen); startMode below finds them chosen
  const chosen = resolveMode(m, mode);
  const modeView = viewForMode(chosen, settings.view, m);
  if (modeView !== settings.view) setView(modeView);
  selectedMode = chosen.key;
  presentation.select(chosen.effect ?? null);
  if (!isWorld(m) && settings.size === m.size) loadPreset(m.preset);   // (undoable, as any box scene)
  else { useMap(m); setSize(m.size); }
  hud.toast(`Loaded ${m.name}`);
  scoreboard.reset();   // a new map: the sandbox's kills and deaths start over, as a GMod server's frags do
  startMode(mode, { fresh: true }).catch((err) => console.error('The match failed to start', err));
  return true;
}
// Animal Crossing on Tinker Creek: the drop point in front of your cottage (grid cells), else null
function villageSpawn() {
  if (selectedMode !== 'animalCrossing' || win?.scene.key !== 'willowCove') return null;
  return new THREE.Vector3(win.P.size[0] / 2 + VILLAGE_HOMES[0] + HOME_ENTRY.x, VILLAGE_FLOOR, win.P.size[2] / 2 + VILLAGE_Z + HOME_ENTRY.z).sub(sim.origin);
}
// Keep the user's setting intact when entering/leaving a low-gravity gamemode.
function applyGravity() {
  if (sim) sim.gravity = settings.gravity * (modeByKey(selectedMode)?.gravityScale ?? 1);
}
// the map and gamemode playing now, for the menu to open on
function currentMap() {
  return { map: mapOf(settings)?.key ?? null, mode: pov?.game?.running ? pov.game.mode : selectedMode };
}
// The gamemode (maps.js GAMEMODES) on the map just loaded: its presentation effect (Animal Crossing's
// rolling log), and a team gamemode's match (src/game, where the build has it) in the body. Sandbox
// ends any match running. The match waits for the body to drop in (game.start needs the player: the
// first drop-in builds it), while the bots' module loads beside it; a map loaded just now (fresh)
// isn't loaded again for the match. Resolves true once it runs.
async function startMode(mode, { fresh = false } = {}) {
  if (mode !== 'sandbox' && win && mp.role && mp.role !== 'solo') { hud.toast('World co-op supports Sandbox exploration, not matches or progression.'); return; }
  const epoch = ++modeEpoch;
  villageFocus = null;
  const chosen = resolveMode(mapOf(settings), mode);
  const game = pov?.game;
  pov?.mission?.end();
  if (chosen.key !== selectedMode) {
    const modeView = viewForMode(chosen, settings.view, mapOf(settings));
    if (modeView !== settings.view) setView(modeView);
  }
  selectedMode = chosen.key;
  if (chosen.key === 'factory') hud.dismissHint(); // Sandbox's free-pouring hint is wrong here.
  applyGravity();
  ctx.industry?.modeChanged();
  presentation.select(chosen.effect ?? null);
  pacer.wake();
  if (chosen.key !== 'animalCrossing') pov?.village.setEnabled(false);
  if (chosen.key === 'animalCrossing' && pov && win?.scene.key === 'willowCove') {
    game?.end();
    const world = win;
    pov.exit(true);
    try {
      await world.whenReady();
      if (epoch !== modeEpoch || win !== world) return false;
      // Stream toward the cottage rather than reloading the world: existing voxel edits survive.
      // A cancelled entry cannot restore another entry's temporary focus; a tool's worldFocus stays its own.
      const homeFocus = [world.P.size[0] / 2 + VILLAGE_HOMES[0], world.P.size[2] / 2 + VILLAGE_Z];
      villageFocus = homeFocus;
      try {
        await world.pending;
        while (epoch === modeEpoch && win === world && wire('world')?.moveWindow(ctx)) await world.pending;
        if (epoch !== modeEpoch || win !== world) return false;
        pov.village.setEnabled(true, world.P);
        if (!pov.active) await pov.enter({ valid: () => epoch === modeEpoch });
      } finally { if (villageFocus === homeFocus) villageFocus = null; }
    } catch (error) {
      if (epoch === modeEpoch) { pov.village.setEnabled(false); hud.toast('Could not enter your home. Try starting Animal Crossing again.', { kind: 'error' }); }
      console.error('Village failed to start', error);
    }
    return false;
  }
  if (chosen.key === 'crueltySquad' && pov) {
    game?.end();
    const map = mapOf(settings);
    pov.exit(true);
    if (win) {
      const world = win, focus = [map.mission.spawn[0], map.mission.spawn[2]];
      // Reuse the authored-mode focus seam: switching from far-away Sandbox
      // must load the source spawn, not teleport into nonresident voxel cells.
      villageFocus = focus;
      try {
        await world.whenReady();
        await world.pending;
        while (epoch === modeEpoch && win === world && wire('world')?.moveWindow(ctx)) await world.pending;
        if (epoch !== modeEpoch || win !== world) return false;
      } finally { if (villageFocus === focus) villageFocus = null; }
    }
    if (epoch !== modeEpoch) return false;
    const at = new THREE.Vector3(...map.mission.spawn).sub(sim.origin);
    await pov.enter({ at, swoop: 0, hint: false, valid: () => epoch === modeEpoch });
    if (epoch !== modeEpoch || !pov.player) return false;
    pov.setLook(map.mission.spawnYaw ?? 0, 0);
    return pov.mission.start(map);
  }
  if (!chosen.team || !game) {
    game?.end();   // (end() also cancels a match still starting)
    if (chosen.key === 'noita' && pov && !pov.active) pov.enter();   // its rules are the map's (Descent)
    return false;
  }
  game.prepare();
  // the start menu's Play over a game is a click: the mouse is taken now, while it counts as a
  // gesture (a drop-in from the god view asks for it itself)
  if (pov.active && !pov.locked) try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not allowed here */ }
  // Halo puts you in your eyes at a spawn: no swoop down from the god view, no sandbox key hint
  await pov.enter({ swoop: 0, hint: false });
  mark('entered');
  if (epoch !== modeEpoch || !pov.player) return false;   // (a later map/mode took over, or it couldn't drop in: pov.enter said why)
  return game.start(chosen.key, { fresh });
}
// maps.js is plain data the menu loads on its own: it must agree with the tables here
for (const m of MAPS) {
  const dims = m.size in WORLDS ? worldOf(WORLDS[m.size], sceneByKey(m.scene)).size : SIZES[m.size];
  const ok = dims && dims.every((n, i) => n === m.dims[i]) && (isWorld(m) ? m.size in WORLDS && sceneByKey(m.scene).key === m.scene : m.size in SIZES);
  if (!ok) console.error(`maps.js: map '${m.key}' doesn't match app.js (size '${m.size}', ${m.dims.join('×')})`);
}
if (WORLD_DIMS.some((n, i) => n !== WORLD_SIZE[i])) console.error('maps.js: WORLD_DIMS is not shaders/farShared.js WORLD_SIZE');
// cells [nx, ny, nz] for a toast: '128^3' (as maps.js sizeTag), '160 × 96 × 160'; for the HUD: '2.1M'
const dimsName = (d) => (d.every((n) => n === d[0]) ? `${d[0]}^3` : d.join(' × '));
const millions = (d) => `${(d[0] * d[1] * d[2] / 1e6).toFixed(1)}M`;

// what undoing a scene load names: its map ('Undone Lab'), and the Empty map, TPT's Clear
function sceneLabel(preset) { return preset === 'empty' ? 'Clear' : MAPS.find((m) => m.preset === preset)?.name ?? preset; }
// Box scenes another unit's port builds: the Islet is the world's generator on a box (src/wire/world.js).
const presetWire = (name) => (name === 'island' ? 'world' : null);
function loadPreset(name, undoable = true) {
  if (mp.frozen && undoable) { mp.resumeSolo(); replicaMap = null; }
  if (mp.replica) return false;
  ctx.resetWeather?.();
  if (graphicsFailure) throw graphicsFailure;
  if (undoable && mp.guard()) return false;
  if (undoable && ctx.industry?.pending) { hud.toast('Wait for the machine transfer before changing the scene.'); return false; }
  if (!win && presetWire(name) && !wire(presetWire(name))) {
    hud.toast(`${notYet(sceneLabel(name))}. Here is the Lab instead`, { kind: 'error' });
    name = 'lab';
  }
  if (undoable && !win) {
    // Scene undo must restore registered machines and conserved pump cargo,
    // not just their physical decks. Ordinary brush snapshots stay terrain-only.
    let industry;
    try { if (ctx.industry) industry = { preset: settings.preset, data: ctx.industry.toJSON() }; }
    catch (error) { hud.toast(error.message); return false; }
    sim.snapshot(sceneLabel(name));
    if (industry) sim.history.at(-1).note = { industry };
  }
  settings.preset = name;
  if (resolveMode(mapOf(settings), selectedMode).key !== selectedMode) startMode('sandbox');   // (not the gamemode's map now)
  // (the cells go in once the simulation's pipelines are built: at boot, behind the loading screen)
  whenSimReady(() => {
    if (mp.replica) return;
    if (win) wire('world').loadScene(ctx);
    else if (name === 'empty') sim.clear();
    else if (name === 'island') wire('world').loadIsland(ctx);
    else arenaLayout = buildPreset(name, sim);
    if (win || !(name in ARENA_GRID)) arenaLayout = null;
    resetSimModes();
    ctx.industry?.reset({ starters: name === 'quarry' && !win });
    post.reset();
    signs?.clear();
    resetSpawners(name);
    pov?.worldReplaced();
  });
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

// ---------------------------------------------------------------- picking & brush
const pointer = new THREE.Vector2();
let pointerInside = false;
let pointerPickDirty = false;   // a new pointer ray needs a pick even if the scene stayed cached
let pointerClient = [0, 0];
const raycaster = new THREE.Raycaster();
const hover = { valid: false, cell: new THREE.Vector3(), face: 0, id: -1, T: 0, P: 0 };
let painting = false;
let strokePainted = false;    // the stroke under way has painted at least once
let releasePending = false;   // its button went up before it had: it stops after its next paint
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

// The pointer's ray in grid cells (the camera unjittered: casts are made outside post's frame).
function gridRay() {
  raycaster.setFromCamera(pointer, camera);
  return raycaster.ray.clone().applyMatrix4(invVolume.copy(volume.matrixWorld).invert());
}

// In POV the pick follows the crosshair (the screen centre) instead of the pointer.
// The ray is marched by the volume's pick kernel (gfx/volume.js, F5), recorded
// with the next frame (post's compute hook) or on its own, and its result lands
// 1-3 frames later; a pick asked for on an old grid is dropped.
const povRay = new THREE.Ray();
// The bend's parameters while a presentation effect bends the view (the pick
// walks the displayed ray then), else null.
const warpNow = () => (presentation.active ? presentation.parameters : null);
// the crosshair's ray, on screen: in first person from the displayed eye
const aimScreenRay = () => pov?.aimRay(povRay.origin, povRay.direction, presentation.active);
const skipPickLiquids = () => !!pov?.active && !gearByKey(pov.toolbelt?.selectedKey)?.pickLiquids;
// Grid point p where the presentation shows it (out; p itself when flat).
function presentationPoint(p, out = new THREE.Vector3()) {
  return out.fromArray(warp(p.clone().add(sim.origin).toArray(), presentation.parameters)).sub(sim.origin);
}
// A grid ray as the screen shows it: the displayed straight ray's parabola in
// grid cells (presentationMath.js inverseRay), t along the displayed ray.
function screenCurve(ray) {
  const r = inverseRay(ray.origin.clone().add(sim.origin).toArray(), ray.direction.toArray(), presentation.parameters);
  const origin = sim.origin.toArray();
  r.C = r.C.map((v, i) => v - origin[i]);
  return r;
}
function screenAt(ray, t, out) { return out.fromArray(rayPoint(screenCurve(ray), t)); }
// Where the screen's ray meets height `height` (grid cells), or null.
function screenPlane(ray, height, out) {
  if (!presentation.active) return ray.intersectPlane(plane.set(plane.normal, -height), out);
  const r = screenCurve(ray), t = planeRoots(r, 1, height).find((x) => x >= 0);
  return t == null ? null : out.fromArray(rayPoint(r, t));
}
function requestPick() {
  const fromPov = !!aimScreenRay();
  if (pickPending || (!pointerInside && !fromPov)) return;
  pointerPickDirty = false;
  const ray = fromPov ? povRay : gridRay();
  const skipLiquids = fromPov && skipPickLiquids();
  pickPending = true;
  const from = sim, o = sim.origin.clone(), revision = presentation.revision;
  vol.pick(ray.origin, ray.direction, warpNow(), skipLiquids).then((hit) => {
    pickPending = false;
    if (from !== sim || revision !== presentation.revision || skipLiquids !== skipPickLiquids()) return;   // a new grid/effect/tool since
    hover.valid = hit.valid;
    if (hover.valid) {
      pickedNow(hover.cell.fromArray(hit.cell), o);
      hover.valid = inWindow(hover.cell);
      hover.face = hit.face;
      hover.id = hit.id;
      hover.T = hit.T;
      hover.P = hit.P;
    }
    wakeLoop();   // (the brush follows the pick)
  }, () => { pickPending = false; });
}

// One-off pick along a grid-space ray (ro, rd), e.g. to find the ground: resolves to
// { valid, cell, face, id, T, P } like `hover`. visible: the ray is one on screen
// (from the eye through a pixel), which a presentation effect bends: it walks the
// displayed ray then. Physics' rays (the ground, the body) keep the flat path.
function pickRay(ro, rd, visible = false) {
  const o = sim.origin.clone(), from = sim, revision = presentation.revision;
  return vol.pick(ro, rd, visible ? warpNow() : null).then((hit) => {
    const cell = pickedNow(new THREE.Vector3().fromArray(hit.cell), o);
    return { valid: from === sim && (!visible || revision === presentation.revision) && hit.valid && inWindow(cell), cell, face: hit.face, id: hit.id, T: hit.T, P: hit.P };
  });
}

const isTool = () => settings.tool < 0;

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
  brushValid = false;
  if (ctx.industry?.building || selectedMode === 'factory') {
    brush.set({ visible: false });
    builds?.update({ hover, active: false });
    return;
  }
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
    position: presentationPoint(brushCenter, tmpV).multiplyScalar(scale).add(volume.position),   // (where the view shows it: a presentation effect bends it)
    radius: settings.radius * scale,
    shape: settings.shape,
    color: toolById(settings.tool).color,
  });
  builds?.update({ hover, active: isBuild(settings.tool) && pointerInside && !uiHover && !eyedropper });
}

const clampToGrid = (v) => v.set(THREE.MathUtils.clamp(v.x, 0, sim.g.nx), THREE.MathUtils.clamp(v.y, 0, sim.g.ny), THREE.MathUtils.clamp(v.z, 0, sim.g.nz));
// Where the pointer's ray meets the paint plane (the height a press started at), if in the grid's window.
function planePoint(out) {
  return !!screenPlane(gridRay(), dragY, out) && (!win || inWindow(out));   // (bent with the view: Animal Crossing's rolling log)
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
  shapeDrag = { kind, start, end: start.clone(), sim, origin: sim.origin.clone() };
  hud.dismissHint();
  return true;
}
// the line or box ghost while dragging (TPT's RenderLine and RenderRect previews)
const ghostA = new THREE.Vector3(), ghostB = new THREE.Vector3(), ghostHalf = new THREE.Vector3();
const toScene = (out, v) => presentationPoint(v, out).multiplyScalar(scale).add(volume.position);   // (as the view shows it)
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
  if (d.sim !== sim || !d.origin.equals(sim.origin)) { hud.toast('The host area moved; draw the shape again.'); return; }
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
const paintStroke = (stroke) => (mp.replica && !mp.isGuest ? undefined : mp.isGuest ? mp.paint(stroke)   // a guest's goes to the host
  : v2Box() && rayKindOfTool(stroke.tool) !== RAY_KIND.NONE ? undefined   // (v2 has no particle layer: selectTool)
    : sim.paint(stroke));

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
  if (mp.replica && !mp.isGuest) { mp.guard(); return; }
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
      if (aimScreenRay()) {
        screenAt(povRay, strokeDist, brushCenter);   // (along the displayed aim: the rolling log bends it)
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
    position: presentationPoint(brushCenter, tmpV).multiplyScalar(scale).add(volume.position),   // (where the view shows it: a presentation effect bends it)
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
const hud = createHud({ onTogglePause: () => setPaused(!settings.paused) });
hud.setPaused(settings.paused);
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
  // a tool whose subsystem isn't ported yet stays greyed out (src/wire)
  const needs = toolWire(id);
  // the new physics' fast version has no particle layer: photons and neutrons wait for today's physics
  if (needs === 'rays' && v2Box()) {
    hud.toast(`${toolById(id)?.name ?? 'That tool'}: not in the new physics (?physics=v2) yet`, { kind: 'error' });
    return;
  }
  if (needs && !wire(needs)) {
    hud.toast(notYet(toolById(id)?.name ?? 'That tool'), { kind: 'error' });
    if (!toolById(settings.tool) || (toolWire(settings.tool) && !wire(toolWire(settings.tool)))) selectTool(DEFAULTS.tool);
    return;
  }
  const wand = wandPresetForTool(id);
  if (wand) {
    pov?.equipWand(wand).catch((err) => { console.error('Wand equip failed', err); hud.toast('Could not equip this wand. Try entering first person with V.'); });
    return;   // Never save or send starter IDs to the paint shader.
  }
  if (!isBuild(id)) lastPaintTool = id;
  if (isDecoTool(id) && sim) wire('deco')?.prepare(ctx);   // its passes compile while the colour is picked (src/deco.js)
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
  if (!wire('pov')) { hud.toast(notYet(toolById(id)?.name ?? 'That tool'), { kind: 'error' }); return; }
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

// TPT's Ctrl+B: draw decoration or not (src/wire/deco.js)
function toggleDeco() {
  const d = wire('deco');
  if (d) d.toggle(ctx);
  else hud.toast(notYet('Decoration'), { kind: 'error' });
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
  toggleIndustryBuild: () => ctx.industry?.toggle(),
  undo,
  // (in a world, over where the camera is looking: home is wherever you are)
  resetCamera: () => {
    if (win) homeOver(controls.target.x / scale + anchor.x, controls.target.z / scale + anchor.y);
    rig.reset();
    hud.toast('Camera reset');
  },
  screenshot: () => { wantShot = true; pacer.wake(); },
  saveGame: () => saveGame(),
  // the map menu on its Saves list (Garry's Mod's Saves; ⌘O)
  openSaves: () => { painting = false; launch.openMenu?.({ saves: true }); },
  firstPerson: () => {
    painting = false;
    if (!wire('pov')) { hud.toast(notYet('First person'), { kind: 'error' }); return; }
    pov?.toggle();
  },
  // 'god' leaves the walking body; 'first' / 'third' drops in, or switches the camera if already in
  setCamera: (id) => {
    if (!wire('pov')) { if (id !== 'god') hud.toast(notYet('First and third person'), { kind: 'error' }); return; }
    if (!pov) { hud.toast('Your body is still loading'); return; }
    if (id === 'god') { if (camState() !== 'god') pov.exit(); return; }
    pov.camera.third = id === 'third';
    if (camState() === 'god') { painting = false; pov.enter(); }
  },
  toggleSettings: () => setSettingsOpen(!settingsPanel.isOpen),
  openShaders: () => setShadersOpen(!shaderPanel.isOpen),
  toggleHelp: () => help.setOpen(!help.isOpen),
  // the start menu over the game (src/main.js), the way Garry's Mod's Esc brings up its menu
  openMenu: () => { painting = false; launch.openMenu?.(); },
  setView,
  renderThumb,
};
// (greyed out until their subsystems are ported: src/wire)
const toolbar = createToolbar({ actions, available: { camera: !!wire('pov') } });
// Tab held: Garry's Mod's scoreboard (ui/scoreboard.js), in the body and in the god view, while
// you're on the world: with the mouse held by the body, or nothing focused (a click on the world
// lets go of the controls: press). With a control or a dialog focused, Tab moves through them.
const scoreboard = createScoreboard({
  wantsTab() {
    if (isTyping() || pov?.editingWand) return false;
    const a = document.activeElement;
    return !!pov?.locked || !a || a === document.body || a === canvas;
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
function waveDemoRow() {
  let busy = false;
  const note = h('p.row-note');
  const buttons = [['shore', 'Create shore wave'], ['ocean', 'Create offshore wave']].map(([kind, text]) =>
    h('button', { type: 'button', text, on: { click: async () => {
      if (busy) return;
      busy = true; sync();
      try {
        const made = await seedWaveDemo(win, kind);
        if (made) {
          setSettingsOpen(false);
          hud.toast(settings.paused ? 'Wave created. Unpause to let it move.' : 'Wave created. Undo restores the water.');
          wakeLoop();
        } else hud.toast('Move into sea water and try again.');
      } catch (error) {
        console.error('Wave demo:', error);
        hud.toast('Could not create the wave.');
      } finally { busy = false; sync(); }
    } } }));
  const sync = () => {
    const why = mp.isGuest ? 'The host controls the water.'
      : !win?.loaded || !(win.P.sea > 0) ? 'Requires a world with an ocean.' : '';
    buttons.forEach(button => { button.disabled = busy || !!why; });
    note.textContent = busy ? 'Preparing wave…' : why || 'One-shot physical waves, not automatic swells. Changes water volume; supports Undo. Use offshore waves in open sea.';
  };
  return { type: 'custom', el: h('div', {}, h('div.seg', { role: 'group', 'aria-label': 'Create a physical wave' }, buttons), note), sync };
}
const shaderPanel = createShaderPicker({
  settings, views: VIEWS, renderThumb, onChange: setView,
  onClose: () => setShadersOpen(false), trigger: toolbar.shaderButton,
});
const settingsPanel = createSettings({
  settings,
  onClose: () => setSettingsOpen(false),
  // Sections and their rows run from most to least reached-for; keep that order when adding settings.
  sections: [
    { title: 'Game', rows: [
      { type: 'custom', el: h('div.settings-actions', {},
        h('button.btn', { type: 'button', text: 'Save game', title: 'Save game (⌘S)',
          disabled: !wire('saves'), on: { click: actions.saveGame } }),
        h('button.btn', { type: 'button', text: 'Keyboard shortcuts', title: 'Keyboard shortcuts (?)',
          on: { click: actions.toggleHelp } })) },
    ] },
    // the map playing (maps.js: a scene at its own size); the start menu changes it
    { title: 'Map', rows: [mapRow()] },
    { title: 'Simulation', rows: [
      waveDemoRow(),
      { type: 'slider', key: 'steps', label: 'Speed (steps per frame)', min: 1, max: 12, step: 1, def: DEFAULTS.steps, fmt: fmtSpeed, onChange: save },
      { type: 'slider', key: 'gravity', label: 'Gravity', min: 0, max: 0.06, step: 0.005, def: DEFAULTS.gravity,
        fmt: (v) => `${(v / DEFAULTS.gravity).toFixed(1)} g`, onChange: () => { applyGravity(); save(); } },
      // TPT's Simulation Options: gravity, air, ambient heat and edge modes (simModes.js)
      ...simModeRows({ change: setSimMode, locked: simModeLock }),
    ] },
    // a cost lever too: sim work grows with cells, ray marching with the grid's span
    weatherSection(weather, { enabled: () => !!win?.loaded && !mp.isGuest }),
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
    // The body you see in third person and when you die. The wizards wear a hat;
    // the third body is the same guy with a marker-drawn paper bag over his head.
    { title: 'Character body', rows: [
      { type: 'seg', key: 'character', options: [['real', 'Male wizard'], ['woman', 'Female wizard'], ['stick', 'Paper bag']],
        onChange: (v) => { settings.character = v; save(); pacer.wake(); } },
      { type: 'seg', key: 'villageCharacter', options: [['boy', 'Animal Crossing: Boy'], ['girl', 'Girl']],
        onChange: (v) => { settings.villageCharacter = v; save(); pacer.wake(); } },
      { type: 'custom', el: h('p.row-note', { text: 'Changes your body and first-person arms.' }) },
    ] },
    { title: 'First-person controls', rows: [
      // named as Minecraft names them
      { type: 'slider', key: 'sensitivity', label: 'Mouse Sensitivity', min: SENSITIVITY_RANGE[0], max: SENSITIVITY_RANGE[1], step: 0.05,
        def: DEFAULTS.sensitivity, fmt: (v) => `${Math.round(v * 100)}%`, onChange: save },
      { type: 'slider', key: 'povFov', label: 'FOV', min: POV_FOV_RANGE[0], max: POV_FOV_RANGE[1], step: 1,
        def: DEFAULTS.povFov, fmt: (v) => `${v}`, onChange: save },
      { type: 'seg', key: 'viewBobbing', options: [[true, 'View Bobbing: On'], [false, 'Off']],
        onChange: (v) => { settings.viewBobbing = v; save(); } },
      { type: 'seg', key: 'sprintMode', options: [['hold', 'Sprint: Hold'], ['toggle', 'Toggle']],
        onChange: (v) => { settings.sprintMode = v; save(); } },
      { type: 'seg', key: 'sprintBlur', options: [[true, 'Sprint Blur: On'], [false, 'Off']],
        onChange: (v) => { settings.sprintBlur = v; save(); } },
      { type: 'seg', key: 'sprintMusic', options: [[true, 'Sprint Music: On'], [false, 'Off']],
        onChange: (v) => { settings.sprintMusic = v; save(); } },
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
// Pending material views retain the last complete variant (readyVolumeView).
// At initial load without one, coldShader reports the wait; readiness wakes the loop.
const detailGate = createDetailGate(gpu, () => pacer.wake(), () => hud.toast('Preparing close-up detail… the first time after an update this can take several seconds'));
const coldShader = createColdShaderGuard(() => { hud.toast('Loading something cool, please be patient'); launch.progress?.('cold'); });
function applyDetail() {
  for (const w of live) w.detail?.(ctx);   // whitewater's per-step field (src/wire/foam.js)
  detailGate.configure(vol, settings, settings.view);
  detailVersion++;   // the shadow map is a derived pass: redo it
  post.reset();
}

// Accounts: take the session the relay just sent back (#tpt3d_session=…) and say how it went
const signInResult = finishSignIn();
if (signInResult.error) hud.toast(signInResult.error);
account().then((user) => { if (signInResult.signedIn && user) hud.toast(`Signed in as ${user.name}`); });

function resetSettings() {
  weather.reset();
  const keep = { size: settings.size, preset: settings.preset, scene: settings.scene, tool: settings.tool, paused: settings.paused, dockCollapsed: settings.dockCollapsed };
  Object.assign(settings, DEFAULTS, keep);
  applyGravity();
  rig.setSpeed(settings.camSpeed);
  applyDetail();
  dock.sync();
  hud.setPaused(settings.paused);
  settingsPanel.sync();
  shaderPanel.sync();
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

function setSettingsOpen(v) {
  if (v) shaderPanel.setOpen(false);
  settingsPanel.setOpen(v);
  toolbar.setSettingsOpen(v);
}

function setShadersOpen(v) {
  if (v) setSettingsOpen(false);
  shaderPanel.setOpen(v);
}

function setPaused(p) {
  if (mp.guard()) return;
  settings.paused = p;
  hud.setPaused(settings.paused);
}

// A view (src/views.js) builds on first use. Settings/UI select it now, but
// material presentation keeps its complete predecessor until the new pipelines
// are ready; its history and GI reset when the rendered view actually switches.
function setView(id) {
  if (!VIEWS.some((v) => v.id === id)) return;
  if (settings.view !== id && !(isMaterialView(settings.view) && isMaterialView(id))) {
    post.reset();
    meshFrames.drop();
    sim.resetGI();
  }
  settings.view = id;
  detailGate.setView(id);
  setBlocks(plainView(id));
  prepareGI();
  const key = viewKeyOf(id);
  if (!blocksOn && viewShadows(key) && vol.shadowState === 'idle') vol.shadowReady().then(() => pacer.wake(), () => {});
  settingsPanel.sync();
  shaderPanel.sync();
  hud.setLegend(VIEWS.find((v) => v.id === id));
  save();
}

// The blocks renderer on or off (setView: on in the Plain view). Off again,
// the derived passes it skipped rebuild every brick.
function setBlocks(on) {
  on = !!on;
  if (on === blocksOn || graphicsFailure) return;
  blocksOn = on;
  if (on) {
    blocks = createBlocks(gpu, sim, { world: !!worldMode });
    blocks.ready.then(() => pacer.wake(), () => {});
  } else {
    blocks?.dispose();
    blocks = null;
    sim.changedAll = true;
  }
  post.reset();
  pacer.wake();
}

function undo() {
  if (selectedMode === 'factory') { hud.toast('Use Build → Dismantle to remove machines.'); return; }
  if (ctx.industry?.pending) { hud.toast('Wait for the machine transfer before undoing.'); return; }
  if (mp.guard()) return;
  const { note, label } = sim.history?.at(-1) ?? {};
  const shrine = note?.shrine;
  if (sim.undo()) {
    if (shrine) perkOrbs?.removeShrine(shrine);
    if (note?.scene) wire('saves')?.restoreSceneExtras(ctx, note.scene);   // a loaded save taken back: the box's signs, spawners and orbs too
    if (note?.industry) {
      settings.preset = note.industry.preset;
      ctx.industry?.fromJSON(note.industry.data);
      save();
    }
    pov?.worldReplaced();
    hud.toast(label ? `Undone ${label}` : 'Undone', { kind: 'undo' });   // Garry's Mod's "Undone Prop": it names what was undone
    if (!note?.scene && !note?.industry && ctx.industry?.state.devices.length) hud.toast('Terrain restored; machine placements are unchanged.');
  }
  // (a world's window moved off all of it: it's kept for when the window comes back)
  else hud.toast(sim.canUndo ? 'Too far away to undo that: go back to it first' : 'Nothing to undo', { kind: 'error' });
  toolbar.setUndoEnabled(sim.canUndo);
}

// ---------------------------------------------------------------- saves (src/wire/saves.js)
// ⌘S or the toolbar's Save keeps the game in the Saves list; the map menu's
// Saves (Esc, ⌘O) loads one. Resolves to the save's meta, or null.
function saveGame(name) {
  const s = wire('saves');
  if (!s) { hud.toast(notYet('Saves'), { kind: 'error' }); return Promise.resolve(null); }
  return s.saveGame(ctx, name);
}
// Load a save: a local save's id, or a save file's bytes. Resolves to whether it loaded.
function openSave(what) {
  const s = wire('saves');
  if (!s) { hud.toast(notYet('Loading a save'), { kind: 'error' }); return Promise.resolve(false); }
  return s.openSave(ctx, what);
}

// UI elements shouldn't show the brush or receive paint
for (const el of document.querySelectorAll('.panel, .dock-tab')) {
  el.addEventListener('pointerenter', () => { uiHover = true; });
  el.addEventListener('pointerleave', () => { uiHover = false; });
}

// ---------------------------------------------------------------- thumbnails for the views menu
// A still of the current scene in each view (post.renderStill: no TAA, the
// last adaptation, its alpha kept) into a 320×200 target, read back, made
// straight (un-premultiplied) and put on the card's canvas (F5). A view not
// drawn yet this session builds its pipeline first: the menu is its first use.
const THUMB_SIZE = [320, 200];
const thumbCam = useWebGPUCamera(new THREE.PerspectiveCamera());
let thumbTarget = null;
async function renderThumb(viewId, out) {
  if (graphicsFailure || !coreReady) return false;
  const view = viewKeyOf(viewId), detail = isMaterialView(view) ? gateVariants(settings).base : {};
  // (Plain is the blocks renderer's, which only the Plain view keeps: from another view its card stays
  // blank; the volume's views from Plain draw the bricks as they were when Plain began)
  const v = vol, b = view === 'plain' ? blocks : null;
  if (view === 'plain' && !b) return false;
  await (b ? b.ready : Promise.all([v.viewReady(view, detail), ...(viewShadows(view) ? [v.shadowReady()] : [])]));
  if (graphicsFailure || v !== vol || (b && b !== blocks)) return false;
  thumbTarget ??= gpu.createTexture({
    label: 'view thumbnail', size: THUMB_SIZE, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  thumbCam.copy(camera, false);   // not its children (the POV viewmodel)
  thumbCam.aspect = THUMB_SIZE[0] / THUMB_SIZE[1];
  useWebGPUCamera(thumbCam);
  const rawWas = post.settings.raw;
  const crueltyWas = post.settings.cruelty;
  post.settings.raw = view === 'plain' ? false : !isMaterialView(view);
  post.settings.cruelty = selectedMode === 'crueltySquad' && isMaterialView(view);
  try {
    // flat, as main's stills are: a presentation effect is the play view's (gfx/presentation.js neutral)
    presentation.neutral(() => post.renderStill({
      prepare() { writeFrameUniforms(gpu, frameValues(thumbCam, viewId, [0, 0])); },
      // the meshes too, as a frame draws them (the stills' target is post's still one)
      opaque: (p) => (threeMeshes(p, false, thumbCam) ? (b ? true : cut.capture(p.sceneTarget.depth)) : false),
      draw(rp) {
        const lit = !win && isMaterialView(view);   // under the sky that lights it (gfx/overlays.js drawSky)
        if (lit) overlays.drawSky(rp);
        if (!win) overlays.drawGrid(rp, { model: floorGrid.matrixWorld, opacity: 1, lit });
        if (b) {
          b.drawOpaque(rp, { marchNear: pov?.marchNear ?? 0, floor: !win });
          b.drawTranslucent(rp, { marchNear: pov?.marchNear ?? 0 });
        } else vol.draw(rp, { view, detail, meshDepth: cut.take(), marchNear: pov?.marchNear ?? 0, aerCopy: sim.aeration?.cur ?? 0 });
        if (!win) overlays.drawEdges(rp, { size: [sim.g.nx, sim.g.ny, sim.g.nz], lit });
      },
      meshes: (p) => { threeMeshes(p, true, thumbCam); },
    }, thumbCam, thumbTarget));
  } finally {
    post.settings.raw = rawWas;
    post.settings.cruelty = crueltyWas;
  }
  const px = await gpu.readback.texture(thumbTarget);
  const [w, hgt] = THUMB_SIZE;
  const ctx2d = out.getContext('2d');
  const img = ctx2d.createImageData(w, hgt);
  // un-premultiply (rows are top down already: F4)
  for (let i = 0; i < w * hgt * 4; i += 4) {
    const a = px[i + 3] / 255 || 1;
    img.data[i] = Math.min(255, px[i] / a);
    img.data[i + 1] = Math.min(255, px[i + 1] / a);
    img.data[i + 2] = Math.min(255, px[i + 2] / a);
    img.data[i + 3] = px[i + 3];
  }
  ctx2d.putImageData(img, 0, 0);
  out.dataset.rendered = '1';
  return true;
}

// ---------------------------------------------------------------- input
const canvasEl = canvas;
const canEraseClick = () => !pov?.active && selectedMode !== 'factory' && !ctx.industry?.building
  && !signs?.editing && !painting && !shapeDrag;
bindBrushEraseClick(canvasEl, {
  canErase: canEraseClick,
  erase: e => eraseClick(e).catch(err => { console.error('Erase click failed', err); hud.toast('Could not erase here. Try again.'); }),
});
async function eraseClick(e) {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const from = sim, ray = gridRay(), stroke = brushStroke(ERASE_TOOL);
  const hit = await pickRay(ray.origin, ray.direction, true);
  if (from !== sim || !hit.valid || hit.id < 0 || !canEraseClick()) return;
  if (!mp.isGuest) {
    sim.snapshot(toolById(ERASE_TOOL).name);
    toolbar.setUndoEnabled(true);
  }
  paintStroke({ ...stroke, center: hit.cell.clone().addScalar(0.5) });
  pacer.wake();
  hud.dismissHint();
}
canvasEl.addEventListener('pointermove', (e) => {
  pointerPickDirty = true;
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  pointerClient = [e.clientX, e.clientY];
  pointerInside = true;
  uiHover = false;
});
canvasEl.addEventListener('pointerleave', () => { pointerInside = false; });
canvasEl.addEventListener('pointerdown', (e) => {
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
  if (selectedMode === 'factory' || ctx.industry?.building) {
    if (e.button === 0 && !e.altKey && !ctx.industry?.building) hud.toast('Use Build for machines, or choose 1st to mine.');
    return;
  }
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
  if ((settings.tool === SIGN_TOOL || isDecoTool(settings.tool) || isSpawnerTool(settings.tool)) && mp.guardEntities?.()) return false;
  if (selectedMode === 'factory' || ctx.industry?.building) return false;
  if (isDecoTool(settings.tool) && mp.guard()) return false;   // decoration isn't in the host's stream yet (src/deco.js)
  if (settings.tool === SIGN_TOOL) {
    if (signs && hover.valid) { signs.add({ cell: hover.cell.clone(), normal: faceNormal(hover.face) }); return true; }
    if (!signs) hud.toast(wire('signs') ? 'Signs are still loading' : notYet('Signs'));
    return false;
  }
  if (settings.tool === LIGHTNING_TOOL) {
    if (mp.guard()) return false;
    if (!lightning) { hud.toast(notYet('Lightning'), { kind: 'error' }); return false; }
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
    if (!spawners) { hud.toast(notYet('Spawners'), { kind: 'error' }); return false; }
    if (!hover.valid) { hud.toast('Click a surface to set it on', { kind: 'error' }); return false; }
    const kind = SPAWNER_KIND[settings.tool];
    const r = spawners.place(kind, feetOnHit(hover));
    pacer.wake();
    if (r === 'full') hud.toast('That many is the limit', { kind: 'error' });   // GMod's LimitHit
    else if (r === 'unsupported') hud.toast('Vehicles and NPCs are not supported in scrolling World maps; use a box map', { kind: 'error' });
    else hud.toast(r === 'removed' ? 'Player spawn removed' : SPAWNER_SET[kind] ?? `${toolById(settings.tool).name} spawned`);
    return r !== 'full' && r !== 'unsupported';
  }
  if (isBuild(settings.tool)) {
    if (mp.guard()) return false;
    if (!builds) { hud.toast(wire('mesh') ? 'Constructions are still loading' : notYet('Constructions')); return false; }
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
  if (selectedMode === 'factory' || ctx.industry?.building) return;
  if (!mp.isGuest) {
    sim.snapshot(toolById(tool)?.name);
    toolbar.setUndoEnabled(true);
  }
  strokeTool = tool;
  painting = true;
  strokePainted = releasePending = false;
  windFromValid = false;
  hud.dismissHint();
  pacer.wake();
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
    if (selectedMode === 'factory' || ctx.industry?.building) return null;
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
      if (!aimScreenRay()) return null;
      strokeDist = hover.valid ? presentationPoint(hoverBrushCenter(tmpV, tool), tmpV).distanceTo(povRay.origin) : GUN_AIR_DIST;
    }
    startStroke(tool);
    return 'stroke';
  },
  release() { painting = false; },
};
addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  // a click shorter than the GPU's frame (its frames still in flight, B3)
  // has painted nothing yet: it paints once, on the next tick that runs
  if (painting && !strokePainted) releasePending = true;
  else painting = false;
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
  Promise.all([pickRay(ray.origin, ray.direction, true), new Promise((r) => setTimeout(r, TOUCH_PRESS_DELAY_MS))]).then(([hit]) => {
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
// Calls waiting for the next presented frame (a save's thumbnail: src/wire/saves.js),
// run in that frame's task once it is submitted, so the canvas still holds it.
const frameWaiters = [];
function onNextFrame(fn) { frameWaiters.push(fn); pacer.wake(); }
const wantFrame = () => wantShot || frameWaiters.length > 0;

addEventListener('keydown', (e) => {
  if (pov?.editingWand) return;
  if (e.key === 'Alt') controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  if (e.key === 'Shift') controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE; // OrbitControls turns Shift+rotate into pan
  if (isTyping()) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  // ⌘S saves, ⌘O opens the Saves list: every program's keys (TPT has none: its Save
  // and Open buttons go local with Ctrl held, GameView.cpp saveSimulationButton, searchButton)
  // (in the body Ctrl is the camera key and S walks back: there only ⌘ saves; Settings' Save always does)
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
  else if (k === '.') { stepOnce = true; pacer.wake(); }
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
  // Minecraft Java's screenshot key; holding it must not download a stream of images.
  else if (k === 'F2') { e.preventDefault(); if (!e.repeat) actions.screenshot(); }
  else if (k === 'Escape') {
    const overlay = eyedropper || shaderPanel.isOpen || settingsPanel.isOpen || help.isOpen || mp.panelOpen || !!shapeDrag;
    shapeDrag = null;   // a line or box being dragged is dropped
    setEyedropper(false); setShadersOpen(false); setSettingsOpen(false); help.setOpen(false); mp.closePanel();
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
// (no frame is open here: each tick submits its own before it returns, so the
// canvas texture it drew into is never resized under a pending submit)
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- profiler (Settings → Developer)
// gfx/profiler.js measures (gpu.timing in split mode) and ui/profiler.js shows.
const profPanel = createProfilerPanel({ onClose: () => { settings.profiler = false; save(); applyProfiler(); } });
const prof = createProfiler(gpu, {
  describe: () => ({ sim, renderScale: post.renderScale, canvas: [canvas.width, canvas.height], pixelRatio, bytes: post.threeBytes }),
  onSample: profPanel.update,
  onFrame: profPanel.frame,
});
// post's passes after the scene (the view's raymarch) are a phase of their own
const postPass = (name) => { if (name === 'scene') prof.phase('post'); };
function applyProfiler() {
  const on = settings.profiler;
  prof.enable(on);
  profPanel.show(on);
  post.onPass = on ? postPass : null;
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Timer();
clock.connect(document);   // hidden-tab time is not rendering cost
let animTime = 0;   // s the simulation has run: the scene's own animations (perk orbs, arena banners)
// The fps readout is the rate frames are drawn while drawing: a paused, still
// scene draws nothing (render on demand) and reads as idle, not as a low rate.
let frames = 0, fpsTime = 0, fps = 60, idleTime = 0, lastDrawAt = null;
let stepTime = 0, stepCount = 0, stepRate = 0;
// Render on demand (gfx/pacing.js). The derived passes settle once the slowest
// field EMA and the GI blend (each probe is traced every other frame) have
// converged; the view once TAA's history has (upscaled, it accumulates for
// longer), or at once without TAA (tools turn it off: no history to converge).
const GI_PROBE_EVERY = 2;
const pacer = createPacer({
  derivedSettle: Math.max(...[...CHANNELS, ...MEDIA].map((c) => settleFrames(c.ema)), settleFrames(GI_BLEND, GI_PROBE_EVERY)),
  viewSettle: () => (post.settings.taa ? settleFrames(post.settleWeight) : 1),
  presentHz: testMode === 'preview' ? PREVIEW_HZ : MAX_FPS,
  onWake: wakeLoop,
});
// the view's key: a counter that changes when what the view shows does
// (gfx/pacing.js); viewKey.still, when what our own passes draw with does
const viewKey = createViewKey({ still: [volume, floorGrid] });
const viewSettings = createViewSettings(settings);
bindViewInputWake(window, () => { autoRes.wake(); wakeLoop(); });
let lastVersion = -1, renderedLast = false;
// the browser capping the page at 30 Hz (gfx/pacing.js createCapCheck): say so once
const capCheck = createCapCheck();
let lastIdle = false;
const CAP_NOTICE = 'Your browser is holding this page at 30 fps. In Chrome, turn off Energy Saver (Settings → Performance); on a Mac, Low Power Mode does the same.';
const CAP_NOTICE_MS = 9000;
const DT_MAX = 0.1;      // s: longer gaps (a hidden tab, a sleeping loop) count as this, so animations don't jump
const FPS_WINDOW = 0.5;  // s over which the fps readout averages
const invVol = new THREE.Matrix4();
const autoRes = createAutoResolution();
autoRes.enabled = !testMode || testMode === 'visual'; // intentional preview caps are not GPU slowness
post.onRead = wakeLoop;   // an eye-adaptation reading landed: the view may have more adapting to do

// Screenshots: the canvas, read in the task that submitted its frame (the
// drawing buffer is still the frame's then), and a small credit so shared
// images lead back to the app. The canvas is opaque: its sky is drawn in
// post's composite (docs/webgpu.md F7).
const SHOT_CREDIT = 'tpt3d.codyh.xyz';
const SHOT_CREDIT_SIZE = 0.022;   // credit text height, as a share of the image height
const SHOT_CREDIT_MIN_PX = 12;
const SHOT_CREDIT_ALPHA = 0.75;
const SHOT_MARK_SCALE = 1.5;      // logo mark size relative to the text
const shotMark = Object.assign(new Image(), { src: '/favicon.svg' });

function saveScreenshot() {
  const src = canvas, w = src.width, h = src.height;
  const shot = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx2d = shot.getContext('2d');
  ctx2d.drawImage(src, 0, 0);   // same task as the frame's submit, so the drawing buffer is still intact

  const px = Math.max(SHOT_CREDIT_MIN_PX, Math.round(h * SHOT_CREDIT_SIZE)), mark = px * SHOT_MARK_SCALE;
  ctx2d.font = `600 ${px}px Archivo, sans-serif`;
  ctx2d.textBaseline = 'middle';
  ctx2d.globalAlpha = SHOT_CREDIT_ALPHA;
  ctx2d.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx2d.shadowBlur = px / 2;
  ctx2d.fillStyle = '#e7eaf0';
  const tw = ctx2d.measureText(SHOT_CREDIT).width, y = h - px - mark / 2;
  ctx2d.fillText(SHOT_CREDIT, w - px - tw, y);
  if (shotMark.complete && shotMark.naturalWidth) ctx2d.drawImage(shotMark, w - px - tw - px / 2 - mark, y - mark / 2, mark, mark);

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

// ---------------------------------------------------------------- a presented frame
// FrameUniforms for a frame of `cam` in view `view` (gfx/uniforms.js): written
// once per frame, in post's prepare hook, from the jittered camera.
function frameValues(cam, view, jitter) {
  return {
    camera: cam, model: volume.matrixWorld, sun: SUN, view, shadowRes: vol.shadowRes, time: viewTime, lightGain: GLOW_GAIN,
    shadows: true, far: !!win?.far, sea: win?.P?.sea ?? 0, jitter,
    sourceAppearance: win?.far?.appearance.uniform ?? [0, 0, 0, 0],
    sourceStyle: selectedMode === 'crueltySquad' && isMaterialView(view),
  };
}
let frameDerived = false;   // this frame runs the derived passes (pacer.derived)
let frameDetail = {};       // the material view's ready detail this frame
let renderView = settings.view;   // settings.view is the request; this is the complete presented view
const readyVolumeView = createReadyVolumeView();
const camGrid = new THREE.Vector3();   // the eye in grid cells (the volume's uCam)
// wakes the frame loop once a pipeline the frame wanted is built
const waited = new WeakSet();
function wakeWhen(promise) {
  if (waited.has(promise)) return;
  waited.add(promise);
  promise.then(() => pacer.wake(), () => {});
}
// the wires that draw into the scene pass, before the volume and after it, and into the overlay pass
const sceneWires = live.filter((w) => w.scene).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const before = sceneWires.filter((w) => (w.order ?? 0) < 0), after = sceneWires.filter((w) => (w.order ?? 0) >= 0);
const overlayWires = live.filter((w) => w.overlay);

// three.js's meshes of one kind into the scene target, seen by `cam`: the
// opaque ones before our scene pass (clearing it; Sync log S1: the volume
// marches to their depth), the transparent ones after it. False when there are none.
// clear false: the opaque ones over what the target holds, depth-tested
// against it (a mesh-only frame's kept scene, gfx/meshFrames.js).
const isTransparent = (o) => (Array.isArray(o.material) ? o.material.some((m) => m.transparent) : !!o.material?.transparent);
function threeMeshes(p, transparent, cam = camera, clear = !transparent) {
  if (!threeHasVisible(scene, cam)) return false;
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
    renderer.setRenderTarget(p.sceneTarget.rt);
    if (clear) { renderer.setClearColor(0x000000, 0); renderer.autoClear = true; }
    presentation.prepare(scene, cam);   // (the jittered projection: the bend's clip ↔ world for this render)
    renderer.render(scene, cam);
  } finally {
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    for (const o of others) o.visible = true;
  }
  return true;
}

// The scene pass (F1): the floor grid, the wires below the volume (a world's
// far field), the volume, the wires above it, the box's edges, the brush.
// Lines are one rendered pixel wide: under TAAU that is 1/scale output pixels,
// so the grid and the box outline fade by the render scale to keep their weight.
let volumeDrawn = false;   // the last presented frame drew the volume (__app.view.volumeDrawn)
let volumeFirst = false;  // this frame's volume drew before the scene pass (the opaque hook: world/far.js volumePass)
// Select once, before any presentation consumer writes uniforms or draws.
// The far meshes discard live-window columns even without a local draw; a
// pending shader must therefore keep the actual previous full-resolution view.
function selectRenderView() {
  let next = { view: viewKeyOf(settings.view), detail: frameDetail, curved: !!warpNow()?.k };
  if (blocks) {
    readyVolumeView.reset();
  } else {
    if (next.curved && isMaterialView(next.view)
      && vol.pipeline(next.view, next.detail, 'idle', true).state !== 'ready') next.detail = baseDetail();
    const pipe = vol.pipeline(next.view, next.detail, 'now', next.curved);
    const required = [pipe];
    if (pipe.state !== 'ready') { coldShader.watch(pipe); wakeWhen(pipe.ready); }
    if (viewShadows(next.view)) {
      if (vol.shadowState !== 'ready') wakeWhen(vol.shadowReady());
      required.push({ state: vol.shadowState });
    }
    const far = win?.far;
    if (far && isMaterialView(next.view)) {
      wire('world').buildFarView(ctx, far);
      required.push(far.viewPipeline);
    }
    next = readyVolumeView.select(vol, next, required);
  }
  const id = VIEWS.find((v) => v.key === next.view).id;
  if (renderView !== id) { post.reset(); meshFrames.drop(); sim.resetGI(); }
  renderView = id;
  frameDetail = next.detail;
}
// The volume's draw into rp (the scene pass, or its own pass first), its
// options this frame's (cut.take(): the meshes' depth, once a frame).
// Returns whether it drew.
function drawVolume(rp) {
  const view = viewKeyOf(renderView), detail = frameDetail;
  const meshDepth = cut.take();
  const warp = warpNow(), curved = !!warp && warp.k !== 0;
  const drew = !testNoVolume && vol.draw(rp, {
    view, detail, meshDepth, marchNear: pov?.marchNear ?? 0, aerCopy: sim.aeration?.cur ?? 0, warp,
  });
  if (!drew && !testNoVolume) {
    // (its pipeline is building: the frame goes without it, and the toast says why after a moment)
    const pipe = vol.pipeline(view, detail, 'now', curved);
    coldShader.watch(pipe);
    wakeWhen(pipe.ready);
  }
  return drew;
}
// A world's volume first (world/far.js volumeFirst, docs/webgpu.md F1): into
// its own colour and depth after three's opaque meshes (it marches to their
// depth), then the occluder the far view stops at, so the view skips what the
// volume covers opaquely; drawScene composites it where it used to draw.
function drawVolumeFirst(p) {
  volumeFirst = false;
  const far = win?.far;
  if (blocks || !far?.volumeFirst(p.sceneTarget)) return;
  const rp = far.volumePass(p.sceneTarget);
  let drew = false;
  try { drew = drawVolume(rp); } finally { rp.end(); }
  far.occlude(p.sceneTarget, drew);
  volumeFirst = true;
}
let testNoVolume = false;  // test.renderOnce({ volume: false }): a frame without it, the smoke test's reference
function drawScene(rp) {
  const g = sim.g, view = viewKeyOf(renderView);
  // the realistic view's box stands under the sky that lights it (B1: the page's navy gradient behind a
  // daylit scene disagreed with what its water and metal mirrored); the data views keep the page's sky
  const lit = !win && isMaterialView(view);
  if (lit) overlays.drawSky(rp);
  if (!win) overlays.drawGrid(rp, { model: floorGrid.matrixWorld, opacity: Math.min(1, post.renderScale * pixelRatio), lit });   // one scene pixel wide: fade as it widens past a CSS pixel
  for (const w of before) w.scene(ctx, rp);
  if (blocks) {
    // the blocks renderer (gfx/blocks.js): the opaque faces and a box's floor,
    // what draws above the volume, then the translucent faces
    const marchNear = pov?.marchNear ?? 0;
    volumeDrawn = !testNoVolume && blocks.drawOpaque(rp, { marchNear, floor: !win });
    if (!volumeDrawn && !testNoVolume) wakeWhen(blocks.ready);
    for (const w of after) w.scene(ctx, rp);
    if (volumeDrawn) blocks.drawTranslucent(rp, { marchNear });
    if (!win) overlays.drawEdges(rp, { size: [g.nx, g.ny, g.nz], scale: post.renderScale, lit });
    brush.draw(rp);
    return;
  }
  // the volume: drawn first this frame (volumeFirst), it composites over the far field now; else drawn here
  volumeDrawn = volumeFirst ? win.far.drawVolume(rp) : drawVolume(rp);
  volumeFirst = false;
  for (const w of after) w.scene(ctx, rp);
  if (!win) overlays.drawEdges(rp, { size: [g.nx, g.ny, g.nz], scale: post.renderScale, lit });
  brush.draw(rp);
}

// This view frame's kind (gfx/meshFrames.js): 'full', or while only three's
// meshes move, 'capture' (the scene drawn without them first, and kept) and
// then 'meshes' (the kept scene, the meshes over it: no volume, no far field)
let frameMode = 'full';
// post.render's hooks (gfx/post.js), made once
const frameHooks = {
  prepare: (p) => {
    // (the kept scene is for other targets: post's sizes changed with this frame's settings)
    if (frameMode === 'meshes' && !meshFrames.fits(p)) { meshFrames.drop(); frameMode = 'full'; }
    writeFrameUniforms(gpu, frameValues(camera, renderView, p.jitter));
  },
  // E1's work that reads FrameUniforms, after it is written: the derived
  // passes, the shadow map (views that read it), GI (the realistic view), the
  // wires' upkeep, the picks asked for this tick
  compute: () => {
    if (blocks) {
      // nothing that only feeds the march: the faces again if the state or the window moved
      prof.phase('blocks');
      blocks.update({ sun: SUN });
    } else if (frameDerived) {
      prof.phase('derived');
      sim.updateBricks();
      if (viewShadows(viewKeyOf(renderView))) {
        prof.phase('shadow');
        if (!vol.recordShadow()) wakeWhen(vol.shadowReady());   // (its kernel builds: the derived key moves when it is ready)
      }
      if (isMaterialView(renderView)) {
        prof.phase('gi');
        sim.updateGI(SUN, vol.shadowTextures, vol.shadowRes);
      }
    }
    prof.phase('view');
    // (a mesh-only frame keeps what the wires drew into the scene pass: their upkeep for it too, the far field's prepass)
    for (const w of live) if (frameMode !== 'meshes' || !w.scene) w.compute?.(ctx);
    hybrid?.update({
      view: viewKeyOf(renderView), sun: SUN, model: volume.matrixWorld, warp: warpNow(),
      disabled: !!blocks || testNoVolume,
      decoration: gfxUniforms.uDeco.value,
      animated: !settings.paused || live.some(w => w.busy?.(ctx)),
    });
    vol.recordPicks();
  },
  // (the blocks' faces are depth-tested against the meshes: no copy of their depth for the volume's cut)
  opaque: (p) => {
    // the kept scene, then the opaque meshes over it, depth-tested against its depth
    if (frameMode === 'meshes' && meshFrames.restore(p)) { threeMeshes(p, false, camera, false); return true; }
    if (frameMode === 'meshes') frameMode = 'full';
    if (frameMode === 'capture') { drawVolumeFirst(p); return false; }   // (the volume uncut: the meshes go over it in the meshes hook)
    let drew = threeMeshes(p, false);
    if (hybrid?.drawOpaque(p, { load: drew })) drew = true;
    if (drew && !blocks) cut.capture(p.sceneTarget.depth);
    drawVolumeFirst(p);
    return drew;
  },
  draw: (rp) => { if (frameMode !== 'meshes') drawScene(rp); },
  meshes: (p) => {
    if (frameMode === 'capture') {
      // the scene as drawn, before the meshes, kept; then the opaque meshes over it
      if (volumeDrawn) meshFrames.capture(p); else meshFrames.drop();
      threeMeshes(p, false, camera, false);
    }
    threeMeshes(p, true);
  },
  overlay: overlayWires.length ? (rp) => { for (const w of overlayWires) w.overlay(ctx, rp); } : undefined,
};

// Mesh-only frames (gfx/meshFrames.js; docs/webgpu.md K3): this view frame's
// kind. Only while three's meshes are what moved, there are meshes, the
// derived passes didn't run, and no wire animates anything but meshes (the
// POV body, a session, particles, foam: wire `meshesOnly` marks the birds);
// the kept scene goes with any change of the view key but its meshes, a
// wake, the detail variant or the grid.
let viewSeen = -1, stillSeen = -1, meshesMoved = false, lastFrameMode = 'full';
let frameDetailSeen = null, frameDetailV = 0;   // (the detail variant drawn, the last frame's: a new one is a new scene)
function planMeshFrame(runDerived) {
  if (frameDetail !== frameDetailSeen) { frameDetailSeen = frameDetail; frameDetailV++; }
  if (!threeHasVisible(scene, camera)) { meshFrames.release(); return 'full'; }
  if (hybrid || runDerived || blocks || testNoVolume || live.some((w) => !w.meshesOnly && w.busy?.(ctx))) {
    meshFrames.drop();
    return 'full';
  }
  return meshFrames.plan(`${sim.id}|${viewKey.still}|${pacer.wakes}|${frameDetailV}`, { moved: meshesMoved, settle: pacer.viewSettle });
}

// The simulation's clock as the view draws it (FrameUniforms' simClock and
// the clouds' drift: the ripples, rising gas, the cloud deck and its
// shadows): it holds while the scene is kept (capture and mesh-only frames,
// gfx/meshFrames.js), as a sleeping view's does (deep idle), and goes on from
// there, so nothing jumps forward when the view is drawn in full again.
const SIM_CLOCK_WRAP = 1 << 20;   // (gfx/uniforms.js's)
let clockSim = null, clockAt = 0, clockLag = 0;
function viewClock(held) {
  if (sim !== clockSim) { clockSim = sim; clockAt = sim.frame; clockLag = 0; }
  if (held) clockLag += Math.max(0, sim.frame - clockAt);
  clockAt = sim.frame;
  clockLag = Math.min(clockLag, sim.frame);
  if (!clockLag) return;
  const t = sim.frame - clockLag;
  gfxUniforms.uSimClock.value = t % SIM_CLOCK_WRAP;
  cloudShift(t, gfxUniforms.uCloudShift.value);
}

// The new physics owns this box's steps (?physics=v2): no world, body or guest. Today's step never runs
// meanwhile, not even while v2's pipelines build (then nothing steps); v2Active: they're built.
// (declarations: the tool picker asks before this line has run)
function v2Box() { return !!physicsV2 && !win && !pov?.active && !mp.isGuest; }
function v2Active() { return v2Box() && physicsV2.isReady; }
// The simulation records nothing per step (certified idle: sim.js step(); v2's own), so ticking it is pointless.
const simAsleep = () => (v2Box() ? v2Active() && v2Running && physicsV2.asleep
  : sim.idleCertified && !sim.actDirty && !sim.actFresh && sim.actSteps >= SUPER_SETTLE_STEPS
    && sim.quietOk && sim.skipSleeping && !sim.rays.active);

// the camera the toolbar shows: god view, or the body's first / third person
const camState = () => (!pov?.active || pov.mode === 'exiting' ? 'god' : pov.camera.third ? 'third' : 'first');
let camShown = '';
let loopCallbacks = 0;   // frames the loop has run (tools/idle-check.mjs: none while asleep)
let captureNext = null;  // test.renderOnce({ capture }): takes the next presented frame's canvas
let settledSleep = false;   // the last tick stopped the loop because the page had settled (deep idle)
// The animation frame: false stops the loop (deep idle, or graphics stopped, or a parked test page).
function frame(now) {
  loopCallbacks++;
  if (graphicsFailure || testParked) return false;   // (resume() wakes it; nothing restarts a stopped GPU)
  try {
    const keep = tick(now);
    gpuLoss.settle();
    if (!keep && settledSleep) gpuLoss.sleep();   // (a loss from here on happened to a page with nothing to draw)
    return keep;
  } catch (error) {
    if (error !== graphicsFailure) throw error;
    return false;
  }
}
// One tick: input, the steps, and, when due, a presented frame. Returns
// whether the loop should go on (false: nothing to do until something wakes it).
function tick(now, renderOnly = false) {
  if (graphicsFailure) throw graphicsFailure;
  settledSleep = false;
  if (!coreReady) return false;   // (the grid's pipelines wake the loop when they are built)
  if (!renderOnly && capCheck.feed(now, lastIdle)) hud.toast(CAP_NOTICE, { kind: 'hint', ms: CAP_NOTICE_MS });
  const t0 = performance.now();
  lastIdle = false;
  // not due: too soon after the last (MAX_FPS), or the GPU still has its frames in flight (B3)
  if (!renderOnly && (gpu.inFlight >= gpu.maxFramesInFlight || !pacer.due(now))) { lastIdle = performance.now() - t0 < CAP_IDLE_MS; return true; }
  if (prof.on !== settings.profiler) applyProfiler();
  applyOutputRatio();
  prof.beginFrame(now);
  if (!renderOnly) clock.update(now);
  const frameDt = renderOnly ? 0 : clock.getDelta();
  const dt = Math.min(frameDt, DT_MAX);
  // Measure real rendering time: the animation cap hides improvements below 10 fps.
  if (!renderOnly && renderedLast && post.settings.taa && frameDt > 0) autoRes.update(frameDt, clock.getElapsed());
  // Set before pacing's view key so a scale change always schedules a render.
  post.settings.resolutionScale = autoRes.scale;
  ctx.renderOnly = renderOnly;

  if (!renderOnly) {
    const cam = camState();
    if (cam !== camShown) toolbar.setCamera(camShown = cam);
    for (const w of live) if (!mp.replica || w.name === 'pov' || w.name === 'mp') w.beforeStep?.(ctx, dt);   // the body, Descent's level switch
    // (after the body's update, which can leave it: then the god view moves this tick)
    if (!pov?.active) {
      rig.update(dt);
      controls.update();
    }
    for (const w of live) w.follow?.(ctx, dt);   // the world's window following the focus
    updatePresentation();   // (after the camera and the window: the bend is anchored beneath the eye)
    updateBrush();

    prof.phase('paint');
    if (selectedMode === 'factory' || ctx.industry?.building) painting = false;
  if (painting && brushValid) {
      tmpV.copy(brushCenter).add(sim.origin);   // world cells
      const wind = windFromValid ? [tmpV.x - windFrom.x, tmpV.y - windFrom.y, tmpV.z - windFrom.z] : null;
      windFrom.copy(tmpV);
      windFromValid = true;
      paintStroke({ ...brushStroke(strokeTool), wind });   // (a guest's: the host paints it)
      strokePainted = true;
    } else windFromValid = false;
    if (releasePending) painting = releasePending = false;   // (the button went up before this tick: its one paint)
  }
  prof.phase('sim');
  const stepping = !renderOnly && !mp.replica && (!settings.paused || stepOnce);
  ctx.stepping = stepping;
  if (!renderOnly && !mp.replica) scripts?.tick();   // event.tick: every frame, paused too (TPT)
  let stepped = settings.steps;
  if (stepping && v2Box()) {
    // v2: a fixed 60 Hz tick on game time, Speed scaling it (4 steps a frame is 1×); none while it rests
    stepped = 0;
    if (v2Active()) {
      if (!v2Running) { physicsV2.resync(); v2Running = true; }
      stepped = physicsV2.frame(dt, { speed: settings.steps / DEFAULTS.steps, once: stepOnce && settings.paused, each: () => scripts?.beforeStep() });
      for (let i = 0; i < stepped; i++) scripts?.afterStep();
    }
    if (DAY.running) day.clock += settings.steps;
    animTime += dt;
    stepOnce = false;
  } else if (stepping) {
    if (v2Running) { v2Running = false; sim.noteWrite(); }   // (today's activity map: every brick, as after a load)
    for (let i = 0; i < settings.steps; i++) { scripts?.beforeStep(); weatherWire.step(ctx); sim.step(); scripts?.afterStep(); }
    if (DAY.running) day.clock += settings.steps;
    animTime += dt;
    stepOnce = false;
  } else if (!renderOnly && mp.isGuest && DAY.running) day.clock += settings.steps;   // guests don't step: keep the day going at their own rate
  if (!renderOnly && !mp.replica) scripts?.endFrame();
  updateSun();
  for (const w of live) if (!mp.replica || ['pov', 'mp'].includes(w.name)) w.afterStep?.(ctx, dt);   // lightning, birds, the session, the meshes
  if (settings.time !== timeShown) {
    timeShown = settings.time;
    if (settingsPanel.isOpen) settingsPanel.sync();
  }
  prof.phase('other');
  const worldChanged = sim.version !== lastVersion;
  if (worldChanged) autoRes.wake();
  lastVersion = sim.version;
  // Keep animation time tied to simulation, not the test preview's draw rate.
  if (worldChanged) viewTime += dt;
  if (renderOnly) updatePresentation();
  const present = renderOnly || pacer.present(now, wantFrame());
  if (present) {
    // CPU-only inspection, before scheduling derived work: a late-ready view
    // can reset GI here and must start its settling passes in this same frame.
    // Uniform uploads and scene hooks stay draw-only for post-only reuse.
    volume.updateMatrixWorld();
    camGrid.copy(camera.position).applyMatrix4(invVol.copy(volume.matrixWorld).invert());
    frameDetail = detailGate.update(camera, camGrid, [sim.g.nx, sim.g.ny, sim.g.nz], canvas.height * post.renderScale);
    selectRenderView();
  }
  // Set before viewKey: changing source style invalidates the cached image.
  const crueltyDisplay = selectedMode === 'crueltySquad' && isMaterialView(renderView);
  if (post.settings.cruelty !== crueltyDisplay) {
    post.settings.cruelty = crueltyDisplay;
    post.reset(); // Never blend temporal history across source-style transitions.
  }
  const runDerived = present && pacer.derived(
    `${sim.id}:${sim.version}|${SUN.x},${SUN.y},${SUN.z}|${KEY_LIGHT}|${renderView}|${gfx.smoothing}|${detailVersion}|${vol.shadowState}|${giBuilt}|${blocksOn}`);
  const viewV = present ? viewKey(camera, scene, pixelRatio, innerWidth, innerHeight,
    `${win?.far?.chunksDrawn}|${brushKey(brush, toolById(settings.tool).color)}|${presentation.key}`,   // a world scene's far field filling in (world/far.js); the brush (ours); the bend
    viewSettings, gfx, post.settings) : viewSeen;
  const viewChanged = viewV !== viewSeen;
  let runView = present && pacer.view(viewV, runDerived || wantFrame());
  // Adaptation is scheduled separately below: forcing the view here would
  // restart TAA settling on every exposure update, forever until eyes settle.
  // three's meshes moved, and nothing else in the key (gfx/meshFrames.js), since the last view frame
  if (pacer.takeMeshWake() || (viewV !== viewSeen && viewKey.still === stillSeen)) meshesMoved = true;
  viewSeen = viewV;
  stillSeen = viewKey.still;
  if (present && !runView && autoRes.recover(clock.getElapsed())) {
    post.settings.resolutionScale = autoRes.scale;
    pacer.wake();   // settle the final full-quality still; don't wake auto resolution
    runView = true;
  }
  let postOnly = false;
  if (present && !renderOnly && !runView && post.adapting) {
    if (canPostFrame({ renderOnly, runView, runDerived, settled: pacer.settled, viewChanged,
      worldChanged, meshesMoved, pointerDirty: pointerPickDirty, painting, povActive: pov?.active,
      busy: live.some((w) => w.busy?.(ctx)) })) {
      prof.phase('post');
      postOnly = post.render(null, camera, null, dt,
        { postOnly: true, viewmodel: ctx.viewmodel, glow: ctx.glow });
    }
    // Failed validation records nothing; run all full-frame preparation and
    // picks below in this same tick. Raw/night/meter/held tools stay full.
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
    if (stepping) stepCount += stepped;
    if (stepTime > FPS_WINDOW) { stepRate = stepCount / stepTime; stepTime = stepCount = 0; }
    idleTime = runView ? 0 : idleTime + dt;
    renderedLast = runView;
  }
  // Picking is input work, not presentation: a preview must keep it responsive.
  // (Asked for before the frame, so the frame's compute pass marches it.)
  if (!renderOnly && (pointerPickDirty || (!postOnly && (runView || pov?.active || testMode === 'preview')))) requestPick();
  if (runView && !postOnly) {
    prof.phase('view');
    updateGfxUniforms(sim, SUN, KEY_LIGHT);   // (runDerived implies runView)
    frameMode = renderOnly ? 'full' : planMeshFrame(runDerived);
    meshesMoved = false;
    viewClock(frameMode !== 'full');   // (before the wires read it: the meshes' light under the clouds)
    for (const w of live) w.beforeView?.(ctx, dt);   // the world's far field and ambient, signs, the held tool
    // (the blocks' faces are radiance, as the material views'; data views are finished colours)
    post.settings.raw = blocks ? false : !isMaterialView(renderView);
    const blurAllowed = settings.sprintBlur && !REDUCED_MOTION.matches && pov?.mode === 'on'
      && !pov.player?.dead && !pov.vehicles.seated && pov.camera.zoom === 1;
    post.settings.sprintBlur = blurAllowed
      ? sprintBlurStep(post.settings.sprintBlur, pov.player?.sprintRush ?? 0, dt) : 0;
    // The preset is a share of the screen's (device) pixels, FSR 2's; post takes shares of the canvas's.
    post.settings.upscale = presetOf() * DEVICE_RATIO / pixelRatio;
    post.settings.adaptive = presetOf() < 1;
    post.settings.floor = UPSCALE_FLOOR * DEVICE_RATIO / pixelRatio;
    gfxUniforms.uNearGI.value = settings.nearGI;
    gfxUniforms.uGlowLights.value = settings.glowLights;
    gfxUniforms.uCaustics.value = settings.caustics;
    frameDerived = runDerived;
    post.render(frameHooks, camera, null, dt, { viewmodel: ctx.viewmodel, glow: ctx.glow });   // its passes after the scene count as 'post'
    // (a mesh-only frame doesn't measure what rendering costs: auto resolution skips it)
    if (frameMode === 'meshes' && !renderOnly) renderedLast = false;
    lastFrameMode = frameMode;
    frameMode = 'full';
    // (a test's capture: the canvas texture is this frame's only until the task ends)
    if (captureNext) { const c = captureNext; captureNext = null; c(post.capture()); }
    prof.phase('other');
  }
  if (postOnly) {
    // Exposure-only frames cannot measure scene rendering cost, advance the
    // scene clock, or recapture mesh motion. Capture the freshly composited canvas.
    renderedLast = false;
    lastFrameMode = 'post';
    if (captureNext) { const c = captureNext; captureNext = null; c(post.capture()); }
    prof.phase('other');
  }
  gpu.endFrame();   // this tick's command buffer, if it recorded anything (B3)
  if (runView) {
    if (wantShot) { wantShot = false; saveScreenshot(); }
    for (const fn of frameWaiters.splice(0)) fn();
  }
  if (renderOnly) { prof.endFrame(0); return true; }

  const povReadout = pov?.active ? pov.readout : null;   // the held tool's (the trowel's), else what the crosshair is on
  if (povReadout) {
    const r = canvas.getBoundingClientRect();
    hud.showReadout(r.left + r.width / 2, r.top + r.height / 2, povReadout);
  } else if (!pov?.active && pointerInside && !uiHover && hover.valid && hover.id >= 0 && !painting) {
    const el = ELEMENTS[hover.id];
    hud.showReadout(pointerClient[0], pointerClient[1], { name: el.name, color: el.color, T: hover.T, P: hover.P });
  } else {
    hud.showReadout(0, 0, null);
  }
  // Deep idle (docs/webgpu.md F7): a presentable tick that drew nothing (so
  // auto resolution has had its say), with the view and the derived passes
  // settled, no steps that would record anything (paused, or certified idle),
  // no stroke, nothing waiting for a frame or adapting, no profiler and no
  // wire animating: the loop stops. Input, a setting, a write, a landed read
  // or a built pipeline wakes it.
  const wantsSteps = !mp.replica && (!settings.paused || stepOnce) && !simAsleep();
  const busy = wantsSteps || painting || wantFrame() || post.adapting || prof.on || live.some((w) => w.busy?.(ctx));
  settledSleep = present && !runView && pacer.settled && !busy;
  const g = sim.g;
  hud.setStats({
    // null: idle (and a sleeping loop is idle until it wakes: it ticks no idle time meanwhile)
    fpsV: settledSleep || idleTime > FPS_WINDOW ? null : fps,
    stepsV: settings.paused || mp.isGuest ? 0 : stepRate, // preview fps is not the simulation rate
    // the cells simulated (a world's window), and the world's
    cellsV: `${millions([g.nx, g.ny, g.nz])}${win ? ` of ${millions(win.size)}` : ''}`,
    resV: autoRes.enabled ? `${Math.round(post.renderScale * pixelRatio / DEVICE_RATIO * 100)}% res` : '',   // of the screen's pixels across, as the presets
  });
  prof.endFrame(stepping ? settings.steps : 0);
  lastIdle = !runView && !stepping && performance.now() - t0 < CAP_IDLE_MS;
  return !settledSleep;
}

// ---------------------------------------------------------------- the wires' view of the app (src/wire)
// What a subsystem's wiring reads and sets: the device, the grid, the scene,
// the UI, and the subsystems' slots, which the wires fill.
const ctx = {
  // J3's app: { gpu, three, sim, derived, scene, camera, settings, pacer, post } (three is the renderer, also as `renderer`)
  gpu, three: renderer, renderer, pacer, canvas, post, presenter, cut, overlays, brush, scene, camera, controls, rig, settings, DEFAULTS, SIZES, WORLDS,
  hover, day, sun: SUN, keyLight: KEY_LIGHT, toolGun, camGrid, sceneByKey,
  get sim() { return sim; }, get derived() { return derived; }, get vol() { return vol; }, get volume() { return volume; },
  get renderView() { return renderView; },
  get scale() { return scale; }, get anchor() { return anchor; }, get worldMode() { return worldMode; },
  get win() { return win; }, set win(v) { win = v; },
  get worldSeed() { return worldSeed; }, set worldSeed(v) { worldSeed = v; },
  get worldFocus() { return worldFocus; }, set worldFocus(v) { worldFocus = v; },
  get villageFocus() { return villageFocus; },
  villageSpawn,
  withVillageFocus(at, valid, visit) {
    const world = win, epoch = modeEpoch;
    return withCityBusFocus({ world, at,
      valid: () => win === world && modeEpoch === epoch && selectedMode === 'animalCrossing' && valid(),
      getFocus: () => villageFocus, setFocus: value => { villageFocus = value; pacer.wake(); },
      move: () => wire('world')?.moveWindow(ctx), visit,
    });
  },
  get pov() { return pov; }, set pov(v) { pov = v; },
  get mp() { return mp; }, set mp(v) { mp = v ?? OFFLINE; },
  get signs() { return signs; }, set signs(v) { signs = v; },
  get builds() { return builds; }, set builds(v) { builds = v; },
  get spawners() { return spawners; }, set spawners(v) { spawners = v; },
  get perkOrbs() { return perkOrbs; }, set perkOrbs(v) { perkOrbs = v; },
  get arenaMarkers() { return arenaMarkers; }, set arenaMarkers(v) { arenaMarkers = v; },
  get birds() { return birds; }, set birds(v) { birds = v; },
  get lightning() { return lightning; }, set lightning(v) { lightning = v; },
  get scripts() { return scripts; }, set scripts(v) { scripts = v; },
  get descent() { return descent; }, set descent(v) { descent = v; },
  get arenaLayout() { return arenaLayout; }, set arenaLayout(v) { arenaLayout = v; },
  get lastShrine() { return lastShrine; }, set lastShrine(v) { lastShrine = v; },
  get painting() { return painting; }, set painting(v) { painting = v; },
  get pointerInside() { return pointerInside; }, get uiHover() { return uiHover; },
  get brushValid() { return brushValid; }, get brushCenter() { return brushCenter; },
  industry: null,
  get menuPick() { return menuPick; }, get gamemode() { return selectedMode; },
  get animTime() { return animTime; }, get graphicsFailure() { return graphicsFailure; },
  // the animation clock as the far field's uniform-like reader takes it ({ value })
  viewTimeUniform: { get value() { return viewTime; } },
  // set by wires per tick: whether it stepped, a renderOnly (test) frame, the held tool's targets (F3)
  stepping: false, renderOnly: false, viewmodel: null, glow: null,
  // a match picked with the map: the bots' module loads during the first frames
  bootMatch: !!(bootMap && launch.mode && launch.mode !== 'sandbox' && launch.mode !== 'noita'),
  // the UI
  get hud() { return hud; }, get dock() { return dock; }, get toolbar() { return toolbar; }, get settingsPanel() { return settingsPanel; },
  get scoreboard() { return scoreboard; }, get prof() { return prof; }, actions,
  // the app's own
  build, setSize, setGrid, openMap, loadPreset, resetSpawners, placeVolume, homeOver, inWindow, pickedNow, pickRay,
  // the presentation effect (gfx/presentation.js: wires bend their draws with it) and a grid point where it shows it
  presentation, presentationPoint,
  setMode: startMode,
  isTyping, selectTool, leaveBuild, setPaused, setRadius, setSimMode, setSimModes, resetSimModes, simModeLock,
  updateSun, save, camState, onNextFrame,
  requestRender: () => pacer.wake(),
  // only three's meshes changed (the birds): a frame, which may keep the volume's scene (gfx/meshFrames.js)
  requestMeshFrame: () => pacer.wakeMeshes(),
};

// ---------------------------------------------------------------- boot
// The start menu's loading screen comes down once the first map is on screen:
// a frame after the first frame, and in a world once its window has filled (or
// after a while, whatever it's doing). A team gamemode picked with it starts
// behind the loading screen first (the body drops in, the bots are built and
// compiled), so the screen comes down on the match running, not on the hitches
// of setting it up.
const READY_POLL_MS = 100;
const READY_WAIT_MS = 20000;
const MATCH_WAIT_MS = 30000;   // the longest the loading screen waits on a match starting (a cold pipeline build)
function bootReady(pending = null) {
  const t0 = performance.now();
  let settled = !pending;   // (a save picked on the menu: it loads first)
  pending?.finally(() => { settled = true; });
  const check = async () => {
    if (graphicsFailure || launch.startupError) return;
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
    } else if (bootMap) startMode(params.get('mode') ?? launch.mode ?? 'sandbox');   // ?mode=, or Sandbox: its effect (Sandbox's none)
    if (graphicsFailure || launch.startupError) return;
    mark('ready');
    launch.ready?.();
  };
  requestAnimationFrame(() => requestAnimationFrame(check));
}

// Everything the session's settings draw with is built (docs/webgpu.md B5):
// the grid's pipelines, the view's module (the realistic view's base
// variant), the shadow kernel if the view reads it, and whatever else is
// still building (the near-detail variant's prefetch, a wire's meshes).
async function allReady() {
  for (;;) {
    const s = sim, v = vol;
    await coreWait;
    const view = viewKeyOf(settings.view);
    if (blocksOn) {
      if (blocks) await blocks.ready;
      await gpu.settled();
      if (graphicsFailure) throw graphicsFailure;
      if (s === sim && v === vol && coreReady && blocksOn) return;
      continue;
    }
    // (bent by a presentation effect: the view's curved variant, and a world's curved far view)
    const curved = !!warpNow()?.k, far = win?.far;
    await Promise.all([v.viewReady(view, baseDetail(), curved), ...(viewShadows(view) ? [v.shadowReady()] : []), giWait,
      ...(physicsV2 ? [physicsV2.ready] : []),
      ...(far && isMaterialView(view) ? [far.buildView()] : [])]);
    await gpu.settled();
    if (graphicsFailure) throw graphicsFailure;
    if (s === sim && v === vol && coreReady) return;   // (rebuilt meanwhile: wait for the new grid)
  }
}

try {
  for (const w of live) w.boot?.(ctx);   // the subsystems that outlive a grid (a session, birds, signs, spawners)
  wired = true;
  // a guest gets the host's box (multiplayer.js): opening an invite in World starts in a box, not the world
  if (mp.joining && settings.size in WORLDS) settings.size = boxSize;
  // the boot map's gamemode's presentation effect before the grid is built, so
  // the build and the loading screen wait on the curved variants it draws (B5),
  // not on flat ones it won't (bootReady's startMode then selects the same)
  if (bootMap) presentation.select(resolveMode(mapOf(settings), selectedMode).effect ?? null);
  build();
  rig.setSpeed(settings.camSpeed);
  selectTool(settings.tool);
  setView(settings.view);
  setPaused(settings.paused);
  toolbar.setUndoEnabled(false);
  mark('app');
  // The pipelines this session draws with: warm from the start menu
  // (src/preload.js), or building now behind its loading screen.
  launch.progress?.('compile');
  await coreWait;
  if (graphicsFailure) throw graphicsFailure;
  window.__app = {
    get sim() { return sim; }, get derived() { return derived; }, get scale() { return scale; }, get signs() { return signs; }, get builds() { return builds; },
    // the grid's box (grid cells → scene: a three Object3D, its transform only) and its GPU volume (gfx/volume.js: pick, shadowTextures, pipelines)
    volume, get vol() { return vol; }, get shadowMap() { return vol.shadowTextures; },
    // the blocks renderer (gfx/blocks.js: stats, pipelines), the Plain view's; null in the others
    get blocks() { return blocks; },
    get hybrid() { return hybrid; },
    get pov() { return pov; },
    get descent() { return descent; },   // Descent's level switch (pov/descent/switch.js): level, index, inside, busy
    get spawners() { return spawners; },
    get birds() { return birds; },
    get perkOrbs() { return perkOrbs; },
    get scripts() { return scripts; },   // the console (src/console): .setOpen, .world
    get lightning() { return lightning; },   // the Lightning tool's and storms' bolts (src/lightning.js)
    weather,
    get elementWeather() { return ctx.elementWeather; },
    get oceanEvents() { return ctx.oceanEvents; },
    get lighthouse() { return ctx.lighthouse; },
    // the loaded arena's layout (spawns, flags, hills, siege core, shrines, vehicles: arenas/damValley.js), else null
    get arena() { return arenaLayout; },
    get win() { return win; },
    get lastGpuFailure() { return gpuLoss.last; },   // the last GPU failure's report, kept across reloads (gfx/gpuLoss.js)
    // world mode: start the world over with the window at `origin` (world cells)
    worldLoad(origin) {
      if (graphicsFailure) throw graphicsFailure;
      const w = wire('world');
      if (!w || !win) throw new Error(`worldLoad: ${notYet('World maps')}`);
      w.worldLoad(ctx, origin);
    },
    setSize,         // switch the grid (a SIZES or WORLDS key), keeping the scene settings
    openMap,         // as the start menu's Start does (a maps.js key, a gamemode)
    current: currentMap,   // { map, mode } playing now
    get industry() { return ctx.industry; },
  presentation, setMode: startMode, // the gamemode's render-only effect (gfx/presentation.js): no map reload or simulation mutation
    pickRay, pickScreenRay: (ro, rd) => pickRay(ro, rd, true),   // a pick along a grid ray (pickScreenRay: as the screen shows it)
    undo,            // as ⌘Z does
    hud,             // toast(text, { kind }): GMod's notices (ui/notices.js)
    scoreboard,      // GMod's, on Tab (ui/scoreboard.js): show(v), shown, mine
    saveGame,        // as ⌘S does: resolves to the save's meta (saves/local.js), or null
    openSave,        // a local save's id, or a .tpt3d file's bytes: resolves to whether it loaded
    setSimMode,      // (key, value): as the drawer's Simulation switches do (simModes.js SIM_MODE_KEYS)
    setSimModes,     // ({ gravityMode, airMode, ambientHeat, edgeMode }): a world's, at once (a save's)
    // the physics a box runs: 'v1' (today's) or 'v2' (the new physics' fast version, as ?physics=v2);
    // resolves once v2's pipelines are built. Not persisted. physics: { mode, active, v2 (its PhysicsV2) }
    async setPhysics(mode) {
      if (mode !== 'v1' && mode !== 'v2') throw new Error(`setPhysics: 'v1' or 'v2', not ${mode}`);
      if (mode === 'v2') V2mod ??= await import('./v2/physics.js');
      physicsMode = mode;
      if (mode === 'v2' && worldMode) hud.toast('The new physics (?physics=v2) runs in boxes: this world keeps today\'s', { kind: 'hint' });
      if (mode === 'v2' && !physicsV2 && !worldMode) physicsV2 = new V2mod.PhysicsV2(sim);
      if (mode === 'v1' && physicsV2) {
        physicsV2.dispose();
        physicsV2 = null;
        if (v2Running) { v2Running = false; sim.noteWrite(); }
      }
      await physicsV2?.ready;
      pacer.wake();
      wakeLoop();
      return physicsMode;
    },
    get physics() { return { mode: physicsMode, active: v2Active(), v2: physicsV2 }; },
    fill: (req) => runFill(sim, req, { openSides: !!win }),   // a flood fill on the current grid (editing.js runFill), for tools
    get worldFocus() { return worldFocus; }, set worldFocus(v) { worldFocus = v; },
    MOBILE, SUN, day, scene, settings, camera, controls, loadPreset, selectTool, setView, hover, renderer, rig, renderThumb, gfx, post, mp, autoRes, prof,
    gpu,           // the WebGPU device and its frame, stats, readback (src/gpu)
    // the volume's per-frame values that were uniforms (tools read them): its animation clock, the frame counter, the detail drawn
    // volumeDrawn: the last presented frame drew the volume (material transitions retain a ready view)
    // meshFrames: the last view frame's kind ('full', 'capture', 'meshes': gfx/meshFrames.js) and the kept scene's state
    view: {
      get time() { return viewTime; }, get frame() { return gfxUniforms.uFrame.value; }, get detailShown() { return detailGate.shown; }, get volumeDrawn() { return volumeDrawn; },
      get renderView() { return renderView; },
      get meshFrames() { return { mode: lastFrameMode, ...meshFrames.state }; },
    },
    // the frame loop: asleep when settled (deep idle, F7); callbacks: animation frames it ran
    loop: { get asleep() { return loop.asleep; }, get callbacks() { return loopCallbacks; } },
    wires: Object.fromEntries(WIRES.map((w) => [w.name, w.ready])),   // which subsystems are ported (src/wire)
    applyDetail,   // after changing settings.detail_* by hand
    detailGate,    // .level / .shown: which close-up features the view has compiled in
    THREE,         // for tools
    requestRender: () => pacer.wake(),   // for changes the frame loop can't see (async results)
    // Manual mode parks only this app loop. Browser/UI callbacks remain live.
    test: testMode ? {
      mode: testMode,
      get parked() { return testParked; },
      park() { testParked = true; },
      resume() { clock.reset(); testParked = false; loop.wake(); },
      step(count = 1) {
        if (graphicsFailure) throw graphicsFailure;
        if (!testParked || mp.isGuest) throw new Error('Park a local test page before stepping');
        if (!Number.isSafeInteger(count) || count < 0 || count > 10000) throw new RangeError('steps must be an integer from 0 to 10000');
        if (!readySims.has(sim)) throw new Error('The grid is still building its pipelines: await __app.test.ready() first');
        if (v2Box()) {
          if (!v2Active()) throw new Error('The new physics is still building its pipelines: await __app.test.ready() first');
          if (!v2Running) { physicsV2.resync(); v2Running = true; }
          physicsV2.ticks(count);
        } else for (let i = 0; i < count; i++) {
          weatherWire.step(ctx); sim.step();
          lightning?.update(sim, { worldEpoch: win?.epoch, worldIdentity: win });
        }
        if (DAY.running) day.clock += count;
      },
      // Every pipeline the current settings need is built, ours and three's (B5).
      ready: allReady,
      // A converged snapshot: frames until the view settles, with no physics,
      // input, player or multiplayer updates, then the GPU done with them.
      async render() {
        await coreWait;
        if (graphicsFailure) throw graphicsFailure;
        // Two initial frames observe post-setting and spawner-transform changes.
        pacer.wake(); // also covers direct setting edits that aren't in the view key
        let n = 0;
        // The first render applies the requested upscale, which changes the limit.
        do { tick(performance.now(), true); n++; } while ((n < 2 || !pacer.settled) && n < pacer.settleLimit);
        if (!pacer.settled) throw new Error('Test render did not converge');
        await gpu.fence();
        return n;
      },
      // The view's clocks back to their start (its animation time and the
      // frame counter its noise is keyed on) and the post history dropped:
      // tools/regress.mjs's fixed shot, whatever frames the page ran before.
      resetView() {
        viewTime = 0;
        clockLag = 0;   // (the simulation's clock as the view draws it: the sim's own again)
        gfxUniforms.uFrame.value = 0;
        post.reset();
        pacer.wake();
      },
      // One frame (no convergence), the GPU done with it: the smoke test's
      // shot (docs/webgpu.md I1). capture: resolves to the canvas as that
      // frame presented it ({ width, height, data }: RGBA bytes). volume:
      // false draws the frame without the volume (the smoke test's reference
      // for what the volume adds); __app.view.volumeDrawn says whether it drew.
      async renderOnce({ capture = false, volume = true } = {}) {
        await coreWait;
        if (graphicsFailure) throw graphicsFailure;
        pacer.wake();
        let shot = null;
        if (capture) captureNext = (p) => { shot = p; };
        testNoVolume = !volume;
        try {
          tick(performance.now(), true);
        } finally {
          testNoVolume = false;
          captureNext = null;
        }
        await gpu.fence();
        return shot ? await shot : null;
      },
    } : null,
  };
  gpuLoss.settle();
  loop = createFrameLoop(frame);
  loop.start();
  bootReady(launch.save ? openSave(launch.save) : null);   // a save picked on the menu's Saves before the game had loaded
  if (linkShot) shotLink.playShot(window.__app, linkShot, { setPaused });
} catch (err) {
  // A stop of graphics is stopGraphics's to explain, with the first failure,
  // which is the cause: a lost device rejects every pipeline still building,
  // each with its own 'GPU shader failed', and the one the boot awaited can
  // be any of them (gpu.fail keeps the first). The stack-trace page is for a
  // bug in here.
  if (err?.name === 'GraphicsFailure') gpu.fail(err);
  if (!graphicsFailure) {
    const el = document.getElementById('error');
    el.style.display = 'flex';
    el.textContent = String(err.stack || err);
  }
  throw graphicsFailure ?? err;
}

// for the start menu (src/main.js)
export { openMap, currentMap as current, openSave, saveGame };
