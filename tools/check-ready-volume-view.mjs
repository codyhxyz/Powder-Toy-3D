// CPU-only regression for uninterrupted live-window terrain on material switches.
import assert from 'node:assert/strict';
import { SMALL_MAP } from '../src/mapKind.js';
import { readFileSync } from 'node:fs';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { createReadyVolumeView } from '../src/gfx/readyVolumeView.js';
import { VIEWS, viewKey as viewKeyOf, isMaterialView } from '../src/views.js';
import { viewShadows } from '../src/shaders/render.js';
import { writeFrameUniforms } from '../src/gfx/uniforms.js';
import { createPacer } from '../src/gfx/pacing.js';
import { canPostFrame } from '../src/gfx/postFrames.js';

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function pipeline(state = 'pending') {
  let resolve, reject;
  const p = { state, ready: new Promise((yes, no) => { resolve = yes; reject = no; }) };
  p.ready.catch(() => {});
  p.finish = () => { p.state = 'ready'; resolve(p); };
  p.fail = () => { p.state = 'failed'; reject(new Error('compile failed')); };
  if (state === 'ready') p.finish();
  return p;
}
const gate = createReadyVolumeView(), volume = {};
const cozy = { view: 'cozy', detail: { SMOOTH: 1 }, curved: false };
const realistic = { view: 'realistic', detail: {}, curved: false };
const ready = pipeline('ready'), pending = pipeline();
assert.equal(gate.select(volume, cozy, [ready]), cozy);
for (const state of ['idle', 'pending', 'failed']) {
  assert.equal(gate.select(volume, realistic, [{ state }, ready]), cozy, state);
}
// No callbacks publish a stale choice: each frame selects only its latest request.
assert.equal(gate.select(volume, cozy, [ready]), cozy);
pending.finish();
await pending.ready;
assert.equal(gate.select(volume, cozy, [ready]), cozy, 'late completion cannot switch back');
assert.equal(gate.select(volume, realistic, [pending, { state: 'pending' }]), cozy, 'far/shadow still required');
assert.equal(gate.select(volume, realistic, [pending, ready]), realistic);
const detailed = { ...realistic, detail: { SMOOTH: 1, CRYSTALS: 1 } };
assert.equal(gate.select(volume, detailed, [{ state: 'pending' }]), realistic, 'retain exact ready detail');
assert.equal(gate.select(volume, detailed, [ready]), detailed);
assert.equal(gate.select({}, cozy, [{ state: 'pending' }]), cozy, 'new grid cannot retain old resources');
assert.equal(gate.select(volume, cozy, [ready]), cozy);
const bent = { ...realistic, curved: true };
assert.equal(gate.select(volume, bent, [{ state: 'pending' }]), bent, 'never reuse incompatible presentation geometry');
assert.equal(gate.select(volume, cozy, [ready]), cozy);
const heat = { view: 'heat', detail: {}, curved: false };
assert.equal(gate.select(volume, heat, [{ state: 'pending' }]), heat, 'nonmaterial lifetimes unchanged');
gate.reset();
assert.equal(gate.select(volume, realistic, [{ state: 'pending' }]), realistic, 'initial load still needs core readiness');

// Exercise the actual app functions, not a copied implementation. GPU calls
// are fixtures, while FrameUniforms uses the real writer and style selection.
const app = source('src/app.js');
const selectCode = app.slice(app.indexOf('function selectRenderView()'), app.indexOf("// The volume's draw into rp"));
const drawCode = app.slice(app.indexOf('function drawVolume(rp)'), app.indexOf('let testNoVolume ='));
const sceneCode = app.slice(app.indexOf('function drawScene(rp)'), app.indexOf("// This view frame's kind"));
const setCode = app.slice(app.indexOf('function setView(id)'), app.indexOf('// The blocks renderer on or off'));
const hooksCode = app.slice(app.indexOf('const frameHooks ='), app.indexOf('// Mesh-only frames (gfx/meshFrames.js;'));
const pipes = new Map();
const fakeVolume = {
  shadowState: 'ready', shadowReady: () => Promise.resolve(),
  pipeline(view, detail, build, curved) {
    const key = `${view}:${Object.keys(detail).sort()}:${curved}`;
    if (!pipes.has(key)) pipes.set(key, pipeline(view === 'cozy' ? 'ready' : 'pending'));
    return pipes.get(key);
  },
  draw(rp, options) {
    assert.equal(this.pipeline(options.view, options.detail, 'now', !!options.warp?.k).state, 'ready');
    this.lastDraw = options;
    return true;
  },
};
let written;
const gpu = { _frameUniforms: {
  uniforms: { write(values) { written = values; } },
  last: { viewProj: new Matrix4(), invViewProj: new Matrix4(), model: new Matrix4(), eye: new Vector3(), written: false },
} };
const camera = new PerspectiveCamera();
const runtime = new Function('helpers', `
  const { createReadyVolumeView, VIEWS, viewKeyOf, isMaterialView, viewShadows, writeFrameUniforms, vol, gpu, camera, Matrix4, Vector3, SMALL_MAP } = helpers;
  const settings = { view: 6 }, readyVolumeView = createReadyVolumeView();
  let volumeFormat;
  let renderView = settings.view, frameDetail = {}, frameMode = 'full', resets = 0, volumeDrawn = false;
  const blocks = null, blocksOn = false, testNoVolume = false, testBoxMarch = false, win = null, worldMode = null;
  // the material views' world march (gfx/worldView.js), over the same fake pipelines: the retention rules are its too
  const worldView = { draws: (v, curved) => isMaterialView(v) && !curved, pipeline: (v, d, b) => vol.pipeline(v, d, b, false),
    draw: (rp, o) => vol.draw(rp, o), writeUniforms() {} };
  const mapKind = { ...SMALL_MAP, boxFrame: false };   // (no floor grid: its overlays are fixtures here)
  const post = { reset() { resets++; } }, meshFrames = { drop() {} }, sim = { g: {}, resetGI() {} };
  const frameWires = { lighting() {}, beforeView() {}, compute() {}, sceneBelow() {}, sceneAbove() {}, overlay() {}, hasOverlay: false }, brush = { draw() {} };
  const ctx = { get renderView() { return renderView; } };
  const warpNow = () => null, baseDetail = () => ({}), cut = { take() { return null; } }, pov = null;
  const coldShader = { watch() {} }, wakeWhen = promise => promise.catch(() => {});
  const drawSkyFor = () => {}, overlays = { drawGrid() {}, drawEdges() {}, drawSky() {} }, boxSeaParams = () => null;   // (the sky pass: a fixture here)
  const detailGate = { setView() {} }, plainView = id => viewKeyOf(id) === 'plain';
  const setBlocks = () => {}, prepareGI = () => {}, pacer = { wake() {} };
  const settingsPanel = { sync() {} }, shaderPanel = { sync() {} }, hud = { setLegend() {}, toast() {} }, save = () => {};
  const frameValues = (cam, view) => ({ camera: cam, model: new Matrix4(), sun: new Vector3(0, 1, 0), view });
  ${setCode}\n${selectCode}\n${drawCode}\n${sceneCode}\n${hooksCode}
  return { setView, settings, frame(detail = {}) {
    frameDetail = detail;
    selectRenderView();
    frameHooks.prepare({ jitter: [0, 0] });
    drawScene({});
    return { draw: vol.lastDraw, volumeDrawn, renderView, contextView: ctx.renderView, resets };
  } };
`)({ createReadyVolumeView, VIEWS, viewKeyOf, isMaterialView, viewShadows, writeFrameUniforms,
  vol: fakeVolume, gpu, camera, Matrix4, Vector3, SMALL_MAP });
function check(expected, detail = {}) {
  const f = runtime.frame(detail);
  assert.equal(f.volumeDrawn, true, 'the volume draws in the scene pass');
  assert.equal(f.renderView, expected);
  assert.equal(f.contextView, expected, 'world/weather see the same retained view');
  assert.equal(f.draw.view, viewKeyOf(expected));
  assert.equal(written.view, expected, 'no mixed old/new frame uniform view');
  assert.equal(written.materialStyle, expected === 6 ? 1 : 0, 'far/detail artwork matches local shader');
  return f;
}
const initial = check(6);
runtime.setView(0);
assert.equal(runtime.settings.view, 0, 'UI/settings keep the requested view');
assert.equal(check(6).resets, initial.resets, 'pending switch preserves history and GI');
const realisticPipe = fakeVolume.pipeline('realistic', {}, 'now', false);
// Changing the request again before completion cannot publish the abandoned view.
runtime.setView(6);
check(6);
realisticPipe.finish();
await realisticPipe.ready;
check(6);
runtime.setView(0);
fakeVolume.shadowState = 'pending';
check(6); // Volume ready but required shadow pending.
fakeVolume.shadowState = 'ready';
assert.equal(check(0).resets, initial.resets + 1, 'reset only on complete-view promotion');
runtime.setView(6);
check(6);
runtime.setView(0);
check(0);
const requestedDetail = { CRYSTALS: 1 };
const failedDetail = fakeVolume.pipeline('realistic', requestedDetail, 'now', false);
check(0, requestedDetail);
failedDetail.fail();
await failedDetail.ready.catch(() => {});
assert.deepEqual(check(0, requestedDetail).draw.detail, {}, 'failed replacement retains ready detail');
runtime.setView(6);
check(6);
assert(app.indexOf('selectRenderView();') < app.indexOf('frameWires.beforeView(dt);'), 'select before any presentation hooks');
assert.match(source('src/wire/weather.js'), /enabled\(app\) && isMaterialView\(app\.renderView\)/);
// Paused, settled BOX: requested Realistic stays pending long enough for
// all earlier keys to settle. Pipeline completion only wakes VIEW pacing;
// the actual selected view must re-key DERIVED pacing after resetting GI.
const resolutionCode = app.slice(app.indexOf('function syncRenderResolution('), app.indexOf('// One tick: input'));
// Execute the actual BOX branch. WORLD has a separate admitted-frame driver.
const scheduleBegin = app.indexOf('  const present = renderOnly || pacer.present(');
const worldSplit = app.indexOf('  let runDerived=false, runView=false;', scheduleBegin);
const localBegin = app.indexOf('  runDerived = present && pacer.derived(', worldSplit);
assert(scheduleBegin>=0&&worldSplit>scheduleBegin&&localBegin>worldSplit);
const scheduleCode = app.slice(scheduleBegin,worldSplit)+'  let runDerived=false, runView=false;\n'+app.slice(localBegin,app.indexOf('  const viewV = present ?'));
const viewScheduleCode = app.match(/  runView = present && pacer\.view\(viewV, runDerived \|\| wantFrame\(\) \|\| betweenTicks\);/)[0];
const wakeCode = app.slice(app.indexOf('const waited = new WeakSet();'), app.indexOf("// The wires' per-frame hooks (src/wire/frameWires.js)"));
assert.equal((scheduleCode.match(/selectRenderView\(\);/g) ?? []).length, 1, 'select exactly once before scheduling');
assert.equal((app.match(/\bselectRenderView\(\);/g) ?? []).length, 1, 'no second selection after scheduling');
const latePipe = pipeline();
const settlingVolume = {
  shadowState: 'ready', shadowTextures: {}, shadowRes: 1,
  pipeline: view => view === 'cozy' ? ready : latePipe,
};
const paused = new Function('helpers', `
  const { createReadyVolumeView, createPacer, canPostFrame, VIEWS, viewKeyOf, isMaterialView, viewShadows,
    writeFrameUniforms, Matrix4, Vector3, camera, gpu, vol, SMALL_MAP } = helpers;
  const settings = { view: 6, paused: true }, readyVolumeView = createReadyVolumeView();
  const pacer = createPacer({ derivedSettle: 3, viewSettle: 2 });
  let volumeFormat;
  let renderView = settings.view, frameDetail = {}, frameMode = 'full', frameDerived = false, gi = 1;
  const events = [], blocks = null, blocksOn = false, live = [];
  const frameWires = { lighting() {}, beforeView() {}, compute() {}, sceneBelow() {}, sceneAbove() {}, overlay() {}, hasOverlay: false };
  const win = null, worldMode = null, mapKind = SMALL_MAP;
  const post = { settings: { cruelty: false }, renderScale: 1, reset() { events.push('post.reset'); } };
  const meshFrames = { drop() {} }, prof = { phase() {} };
  const sim = { id: 1, version: 1, g: { nx: 32, ny: 32, nz: 32 },
    resetGI() { gi = 0; events.push('GI.reset'); },
    updateBricks() { events.push('bricks'); },
    updateGI() { gi = 1; events.push('GI.update'); } };
  vol.recordShadow = () => { events.push('shadow'); return true; };
  vol.recordPicks = () => { events.push('picks'); };
  const ctx = { get renderView() { return renderView; } }, wire = () => ({ buildFarView() {} });
  const warpNow = () => null, baseDetail = () => ({}), coldShader = { watch() {} };
  const detailGate = { setView() {}, update: () => ({}) }, plainView = id => viewKeyOf(id) === 'plain';
  const setBlocks = () => {}, prepareGI = () => {}, settingsPanel = { sync() {} }, shaderPanel = { sync() {} };
  const hud = { setLegend() {}, toast() {} }, save = () => {};
  const volume = { matrixWorld: new Matrix4(), updateMatrixWorld() {} };
  const camGrid = new Vector3(), invVol = new Matrix4(), canvas = { height: 600 };
  const presetOf = () => 1, DEVICE_RATIO = 1, pixelRatio = 1, UPSCALE_FLOOR = 0.5;
  const selectedMode = 'sandbox', renderOnly = false, wantFrame = () => false, betweenTicks = false;   // (a V2 frame between ticks: app.js)
  const SUN = new Vector3(0, 1, 0), KEY_LIGHT = [1, 1, 1], gfx = { smoothing: 1 }, detailVersion = 0, giBuilt = 1;
  const frameValues = (cam, view) => ({ camera: cam, model: new Matrix4(), sun: SUN, view });
  const addEventListener = () => {};
  ${resolutionCode}\n${wakeCode}\n${setCode}\n${selectCode}\n${hooksCode}
  let now = 0;
  return { setView, tick() {
    events.length = 0;
    now += 20;
    ${scheduleCode}
    const viewV = 'still camera and world';
    ${viewScheduleCode}
    if (runView) {
      frameDerived = runDerived;
      frameHooks.prepare({ jitter: [0, 0] });
      frameHooks.compute();
    }
    const postOnlyEligible = canPostFrame({ renderOnly, runView, runDerived, settled: pacer.settled,
      viewChanged: false, worldChanged: false, meshesMoved: false, pointerDirty: false,
      painting: false, povActive: false, busy: false });
    return { runDerived, runView, renderView, gi, events: [...events], settled: pacer.settled, postOnlyEligible };
  } };
`)({ createReadyVolumeView, createPacer, canPostFrame, VIEWS, viewKeyOf, isMaterialView, viewShadows,
  writeFrameUniforms, Matrix4, Vector3, camera, gpu, vol: settlingVolume, SMALL_MAP });
for (let i = 0; i < 12; i++) paused.tick();
let settled = paused.tick();
assert(settled.settled && !settled.runDerived && !settled.runView);
paused.setView(0);
for (let i = 0; i < 12; i++) {
  const f = paused.tick();
  assert.equal(f.renderView, 6);
  assert.equal(f.gi, 1, 'request alone leaves old GI intact');
}
latePipe.finish();
await latePipe.ready; // Actual wakeWhen callback wakes the real pacer.
const promotion = paused.tick();
assert.equal(promotion.renderView, 0);
assert.equal(promotion.runDerived, true, 'late promotion restarts derived work despite unchanged paused sim');
assert.equal(promotion.runView, true);
assert.equal(promotion.gi, 1, 'GI reset is refilled in the promotion frame');
assert(promotion.events.indexOf('GI.reset') < promotion.events.indexOf('GI.update'), 'reset precedes GI update');
assert.equal(written.view, 0);
assert.equal(written.materialStyle, 0, 'promoted derived frame uses Realistic style');
let updates = promotion.events.filter(e => e === 'GI.update').length;
for (let i = 0; i < 12; i++) {
  const f = paused.tick();
  updates += f.events.filter(e => e === 'GI.update').length;
  assert(!f.events.includes('GI.reset'), 'no reset after derived scheduling or during settling');
  assert.equal(f.gi, 1);
}
assert.equal(updates, 3, 'real pacer completes all derived settling frames');
settled = paused.tick();
assert(settled.settled && settled.postOnlyEligible);
assert.deepEqual(settled.events, [], 'unchanged post-only candidate records no GI/scene/pick commands');
console.log('ready-volume-view: async view/detail retention and consistent style passed; paused late promotion resets then refills GI for all real-pacer settling frames; unchanged post-only preparation stays GPU-clean (CPU only)');
