// CPU only: execute the production readiness/helpers with controlled external
// promises and real detail-gate, camera transforms and post render-scale maths.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Matrix4, Object3D, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { createDetailGate, gateVariants, PREWARM_DELAY_MS } from '../src/gfx/detailGate.js';
import { detailKey } from '../src/gfx/volume.js';
import { AUTO_RES, UPSCALE, UPSCALE_FLOOR } from '../src/gfx/post.js';
import { isMaterialView } from '../src/views.js';
import { CELL_M } from '../src/scale.js';

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const postSource = readFileSync(new URL('../src/gfx/post.js', import.meta.url), 'utf8');
function block(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, marker);
  let i = source.indexOf('{', start), depth = 1;
  for (i++; depth; i++) { if (source[i] === '{') depth++; if (source[i] === '}') depth--; }
  return source.slice(start, i);
}
const helpers = ['applyOutputRatio', 'syncRenderResolution', 'updateFrameDetail']
  .map(name => block(app, `function ${name}(`)).join('\n');
const readySource = block(app, 'async function allReady(');
const makeReady = new Function('state', `with(state) { ${helpers}; ${readySource}; allReady.syncResolution = syncRenderResolution; return allReady; }`);
const scaleGetter = block(postSource, 'get renderScale()');
assert.match(app, /createDetailGate\(gpu,[^\n]+\{ prefetch: testMode == null \}\)/);
assert.match(app, /frameDetail = updateFrameDetail\(\)/, 'tick shares actual footprint helper');
assert.equal((app.match(/post\.settings\.upscale = presetOf\(\) \* DEVICE_RATIO \/ pixelRatio;/g) ?? []).length, 1,
  'tick and readiness share next-render scale calculations');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function watch(p) { let done = false; p.then(() => { done = true; }, () => { done = true; }); return () => done; }
// The gate is exercised with a feature it gates: Loose clumps up close (a
// lone clod's lumps start at 1.3 cm per pixel). Smooth up close used to be
// the one; its fade (gfx/detail.js CUBIC_ERR: shape error over 1 px) now
// shows from any ordinary view, so the gate leaves it in the base variant.
const GATED = 'DETAIL_GRAIN_CLUSTERS';
const settings = () => ({ view: 'realistic', upscale: 'quality', detail_grainClusters: true });
{
  const balanced = gateVariants({ view: 'realistic', detail_smoothClose: true });
  assert.equal(balanced.base.DETAIL_CUBIC_CLOSE, 1, 'Smooth up close is in the base variant');
  assert.equal(balanced.nearFadeM, 0, 'nothing left to gate with Smooth up close alone');
}
function fakeVolume() {
  const pipes = new Map(), requests = [];
  const key = (view, detail, curved = false) => `${view}|${detailKey(detail)}|${curved}|${api.format}`;
  const api = {
    format: 0, pipes, requests,
    pipeline(view, detail, build = 'now', curved = false) {
      const k = key(view, detail, curved); requests.push({ view, detail, build, curved, format: api.format });
      if (!pipes.has(k)) {
        const d = deferred(), near = !!detail[GATED];
        const p = { state: near ? 'idle' : 'ready', ready: d.promise,
          build() { if (this.state === 'idle') this.state = 'pending'; return this.ready; },
          resolve() { this.state = 'ready'; d.resolve(this); } };
        if (!near) d.resolve(p);
        pipes.set(k, p);
      }
      const p = pipes.get(k);
      if (build === 'now') p.build();
      return p;
    },
    viewReady(view, detail, curved) { return this.pipeline(view, detail, 'now', curved).ready; },
    shadowReady: () => Promise.resolve(),
    near(curved = false, view = 'realistic') { return pipes.get(key(view, { [GATED]: 1 }, curved)); },
  };
  return api;
}
const savedTimers = { setTimeout, clearTimeout };
let clock = 0, id = 0;
const timers = new Map();
globalThis.setTimeout = (fn, ms) => { const n = ++id; timers.set(n, { fn, at: clock + ms }); return n; };
globalThis.clearTimeout = n => timers.delete(n);
function advance(ms) {
  clock += ms;
  for (const [n, t] of [...timers]) if (t.at <= clock) { timers.delete(n); t.fn(); }
}
function context({ close = false, curved = false, ratio = 1 } = {}) {
  const c = { settings: settings(), autoRes: { scale: 1 }, DEVICE_RATIO: ratio, pixelRatio: 1,
    innerWidth: 1280, innerHeight: 720, canvas: { width: 1280, height: 720 },
    sim: { g: { nx: 32, ny: 32, nz: 32 } }, vol: fakeVolume(), volume: new Object3D(),
    camera: new PerspectiveCamera(60, 1280 / 720, 0.1, 10000), camGrid: new Vector3(), invVol: new Matrix4(),
    coreWait: Promise.resolve(), coreReady: true, blocksOn: false, blocks: null,
    graphicsFailure: null, giWait: Promise.resolve(), physicsV2: null, win: null,
    hybridLoad: null, hybrid: null, hybridWait: Promise.resolve(),   // the hybrid renderer off (app.js)
    curved, isMaterialView, gateVariants, detailKey, UPSCALE_FLOOR,
    viewKeyOf: v => v, viewShadows: v => isMaterialView(v),
    post: { settings: { taa: true, upscale: 0.1, resolutionScale: 0.1 } }, updates: [], settles: 0 };
  c.camera.position.set(close ? 16 : -10000, 16, 16);
  c.presetOf = () => UPSCALE[c.settings.upscale] ?? UPSCALE.native;
  c.outputRatio = () => c.presetOf() * c.DEVICE_RATIO > 1 ? c.DEVICE_RATIO : 1;
  c.renderer = { setPixelRatio(r) { c.pixelRatio = r; }, setSize(w, h) { c.canvas.width = w * c.pixelRatio; c.canvas.height = h * c.pixelRatio; } };
  c.warpNow = () => c.curved ? { k: 1 } : null;
  c.baseDetail = () => isMaterialView(c.settings.view) ? gateVariants(c.settings).base : {};
  c.gpu = { async settled() { c.settles++; } }; // external completion; exact view/native promises must block themselves
  c.detailGate = createDetailGate(null, undefined, undefined, { prefetch: false });
  const update = c.detailGate.update;
  c.detailGate.update = (...args) => { c.updates.push({ height: args[3], grid: args[1].clone ? args[1].clone() : new Vector3().fromArray(args[1]) }); return update(...args); };
  c.detailGate.configure(c.vol, c.settings, c.settings.view);
  const postObject = new Function('settingsOf', 'temporalOf', 'AUTO_RES', 'UPSCALE_FLOOR', `return { ${scaleGetter} };`)(
    () => c.post.settings, () => true, AUTO_RES, UPSCALE_FLOOR);
  Object.defineProperty(c.post, 'renderScale', Object.getOwnPropertyDescriptor(postObject, 'renderScale'));
  c.ready = makeReady(c);
  return c;
}
try {
  // Normal gameplay keeps its existing delayed idle compilation by default.
  const normalVolume = fakeVolume(), normalGate = createDetailGate(null);
  normalGate.configure(normalVolume, settings(), 'realistic');
  advance(PREWARM_DELAY_MS - 1); assert.equal(normalVolume.near(), undefined);
  advance(1); assert(normalVolume.requests.some(r => r.build === 'idle' && r.detail[GATED]));
  normalGate.setView('cozy'); advance(PREWARM_DELAY_MS);
  assert(normalVolume.requests.some(r => r.view === 'cozy' && r.build === 'idle' && r.detail[GATED]));
  normalGate.dispose();

  const far = context(); await far.ready(); advance(PREWARM_DELAY_MS * 3);
  assert.equal(far.vol.near(), undefined); assert.equal(timers.size, 0);
  assert.equal(far.detailGate.level, 0);

  const near = context({ close: true }), np = near.ready(), nd = watch(np);
  await turn(); assert.equal(nd(), false); assert.equal(near.detailGate.level, 1);
  assert.equal(near.detailGate.shown, '', 'pending shown fallback is not demanded readiness');
  assert.equal(near.vol.near().state, 'pending'); near.vol.near().resolve(); await np;
  assert.match(near.detailGate.shown, new RegExp(GATED));

  const bent = context({ close: true, curved: true }), bp = bent.ready(), bd = watch(bp);
  await turn(); assert(bent.vol.near(true)); assert(bent.vol.near(false));
  bent.vol.near(true).resolve(); await turn(); assert.equal(bd(), false, 'curved alone does not satisfy flat gate dependency');
  bent.vol.near(false).resolve(); await bp;

  // Upscale/DPR/floor use the production post getter before the FIRST footprint.
  const scale = context({ ratio: 2 });
  const fade = gateVariants(scale.settings).nearFadeM;
  const distance = fade * 840 / (CELL_M * 2 * Math.tan(scale.camera.fov * Math.PI / 360));
  scale.camera.position.x = -distance;
  const sp = scale.ready(); await turn();
  assert.equal(scale.updates[0].height, 960); assert.equal(scale.detailGate.level, 1);
  scale.vol.near().resolve(); await sp;
  scale.settings.upscale = 'native'; scale.autoRes.scale = 0.1; await scale.ready();
  assert.equal(scale.updates.at(-1).height, 1440, 'native ignores adaptive scale');
  scale.camera.position.x = -10000; scale.settings.upscale = 'performance'; scale.autoRes.scale = 0.01;
  await scale.ready(); assert.equal(scale.updates.at(-1).height, 480, 'adaptive floor retains device/output ratio');
  scale.post.settings.resolutionScale = 0.8; scale.ready.syncResolution();
  assert.equal(scale.post.settings.resolutionScale, 0.8, 'final render sync preserves beforeView resolution overrides');
  scale.post.settings.taa = false; await scale.ready();
  assert.equal(scale.updates.at(-1).height, 720, 'TAA-off footprint is the native scene height');

  // Real transform, and real hysteresis (not a fake desired-view algorithm).
  const moved = context({ close: true }); moved.volume.position.set(100, 0, 0);
  moved.volume.scale.setScalar(2); moved.camera.position.set(132, 32, 32);
  const mp = moved.ready(); await turn(); assert.deepEqual(moved.updates[0].grid.toArray(), [16, 16, 16]);
  moved.vol.near().resolve(); await mp;
  const height = moved.canvas.height * moved.post.renderScale;
  const threshold = fade * height / (CELL_M * 2 * Math.tan(moved.camera.fov * Math.PI / 360));
  moved.detailGate.update(moved.camera, [-threshold * 1.1, 16, 16], [32, 32, 32], height);
  assert.equal(moved.detailGate.level, 1);
  moved.detailGate.update(moved.camera, [-threshold * 1.3, 16, 16], [32, 32, 32], height);
  assert.equal(moved.detailGate.level, 0);

  const native = context(), gate = deferred(); native.physicsV2 = { ready: gate.promise, integrationReady: Promise.resolve() };
  const pending = native.ready(), done = watch(pending); await turn(); assert.equal(done(), false);
  native.camera.position.set(16, 16, 16); gate.resolve(); await turn();
  assert.equal(done(), false, 'camera demand changed while native was pending');
  native.vol.near().resolve(); await pending;
  const rejected = context(), bad = deferred(); rejected.physicsV2 = { ready: bad.promise, integrationReady: Promise.resolve() };
  const fail = rejected.ready(); bad.reject(new Error('native failed')); await assert.rejects(fail, /native failed/);
  const integration = context(), ig = deferred(); integration.physicsV2 = { ready: Promise.resolve(), integrationReady: ig.promise };
  const ip = integration.ready(), idone = watch(ip); await turn(); assert.equal(idone(), false); ig.resolve(); await ip;

  const changed = context({ close: true }), cp = changed.ready(), cd = watch(cp);
  await turn(); const old = changed.vol;
  changed.sim = { g: { nx: 16, ny: 16, nz: 16 } }; changed.vol = fakeVolume();
  changed.detailGate.configure(changed.vol, changed.settings, 'realistic');
  old.near().resolve(); await turn(); assert.equal(cd(), false); assert(changed.vol.near());
  changed.settings.view = 'heat'; changed.detailGate.setView('heat');
  changed.vol.near().resolve(); await cp;
  assert(changed.vol.requests.some(r => r.view === 'heat' && !r.detail[GATED]));

  const switches = context({ close: true }), swp = switches.ready(), swd = watch(swp);
  await turn(); const originalNear = switches.vol.near();
  switches.settings.detail_mediaFlow = true;
  switches.detailGate.configure(switches.vol, switches.settings, 'realistic');
  originalNear.resolve(); await turn(); assert.equal(swd(), false, 'same near level with changed defines must re-wait');
  const switchedNear = [...switches.vol.pipes.entries()].find(([key]) => key.includes(GATED) && key.includes('DETAIL_MEDIA_FLOW'))?.[1];
  assert(switchedNear); switchedNear.resolve(); await swp;

  const dependencies = context(), shadow = deferred(), gi = deferred(), farView = deferred();
  dependencies.vol.shadowReady = () => shadow.promise; dependencies.giWait = gi.promise;
  dependencies.win = { far: { buildView: () => farView.promise } };
  const dp = dependencies.ready(), dd = watch(dp); await turn(); assert.equal(dd(), false);
  shadow.resolve(); gi.resolve(); await turn(); assert.equal(dd(), false, 'far-view readiness is retained');
  farView.resolve(); await dp;

  const curvature = context({ close: true }), kp = curvature.ready(), kd = watch(kp);
  await turn(); curvature.curved = true; curvature.vol.near().resolve(); await turn();
  assert.equal(kd(), false); assert(curvature.vol.near(true)); curvature.vol.near(true).resolve(); await kp;

  const transition = context({ close: true }); transition.vol.format = 2;
  const trp = transition.ready(), trd = watch(trp); await turn();
  const oldFormatNear = transition.vol.near();
  transition.vol.format = 0; oldFormatNear.resolve(); await turn();
  assert.equal(trd(), false, 'format transition re-waits instead of using a ready old-format shader');
  assert.notEqual(transition.vol.near(), oldFormatNear);
  assert.equal(transition.detailGate.level, 1, 'format refresh retains demanded near level');
  transition.vol.near().resolve(); await trp;

  const stale = fakeVolume(); stale.format = 2;
  let wakes = 0;
  const staleGate = createDetailGate(null, () => { wakes++; }, undefined, { prefetch: false });
  staleGate.configure(stale, settings(), 'realistic');
  const cam = { fov: 60 };
  staleGate.update(cam, [16, 16, 16], [32, 32, 32], 720);
  const priorNear = stale.near(); stale.format = 0;
  const edge = gateVariants(settings()).nearFadeM * 720 / (CELL_M * 2 * Math.tan(Math.PI / 6));
  staleGate.update(cam, [-edge * 1.1, 16, 16], [32, 32, 32], 720);
  assert.equal(staleGate.level, 1, 'representation change preserves hysteresis');
  priorNear.resolve(); await turn(); assert.equal(wakes, 0, 'stale promise cannot wake replacement');
  stale.near().resolve(); await turn(); assert.equal(wakes, 1); staleGate.dispose();

  const plain = context({ close: true }), blocks = deferred(); plain.blocksOn = true; plain.blocks = { ready: blocks.promise };
  const pp = plain.ready(), pd = watch(pp); await turn(); assert.equal(pd(), false);
  blocks.resolve(); await pp; assert.equal(plain.updates.length, 0, 'Plain branch stays unchanged');
  assert.equal(plain.vol.near(), undefined);
  for (const c of [far, near, bent, scale, moved, native, rejected, integration, changed, switches, dependencies, curvature, transition, plain]) c.detailGate.dispose();
  assert.equal(timers.size, 0);
  console.log('Headless view CPU: default timer retained; far opt-out; demanded flat/curved detail; real transforms/hysteresis; first-frame upscale/DPR/floor; grid/view/camera/curvature changes; native/integration/Plain waits passed');
} finally {
  globalThis.setTimeout = savedTimers.setTimeout; globalThis.clearTimeout = savedTimers.clearTimeout;
}
