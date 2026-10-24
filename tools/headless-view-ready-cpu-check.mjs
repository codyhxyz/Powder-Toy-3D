// CPU only: execute the production readiness/helpers with controlled external
// promises and real detail defines, camera transforms and post render-scale maths.
// (The close-up detail distance gate is gone, 2026-10-23: a material view draws
// one variant, every switched-on feature, at every distance; readiness waits on it.)
import assert from 'node:assert/strict';
import { kindOf } from '../src/mapKind.js';
import { readFileSync } from 'node:fs';
import { Matrix4, Object3D, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { detailDefines } from '../src/gfx/detail.js';
import { detailKey } from '../src/gfx/volume.js';
import { AUTO_RES, UPSCALE, UPSCALE_FLOOR } from '../src/gfx/post.js';
import { isMaterialView } from '../src/views.js';

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
const makeReady = new Function('state', `with(state) { ${helpers}; ${readySource}; allReady.syncResolution = syncRenderResolution; allReady.frameDetail = updateFrameDetail; return allReady; }`);
const scaleGetter = block(postSource, 'get renderScale()');
assert.doesNotMatch(app, /createDetailGate|gateVariants|detailGate/, 'no distance gate left in app.js');
assert.match(app, /const baseDetail = \(\) => \(isMaterialView\(settings\.view\) \? detailDefines\(settings\) : \{\}\)/, 'a lit material view draws every switched-on feature');
assert.match(app, /frameDetail = updateFrameDetail\(\)/, 'tick shares the readiness detail helper');
assert.match(block(app, 'function updateFrameDetail('), /return baseDetail\(\);/, 'the frame draws the variant readiness waited on');
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
// Pebbles and grains up close: the feature the old gate left out of far views.
// It is in the one variant now, near or far.
const FEATURE = 'DETAIL_GRAINS';
const settings = () => ({ view: 'realistic', upscale: 'quality', detail_grains: true });
function fakeVolume() {
  const pipes = new Map(), requests = [];
  const key = (view, detail, curved = false) => `${view}|${detailKey(detail)}|${curved}|${api.format}`;
  const api = {
    format: 0, pipes, requests,
    pipeline(view, detail, build = 'now', curved = false) {
      const k = key(view, detail, curved); requests.push({ view, detail, build, curved, format: api.format });
      if (!pipes.has(k)) {
        // a view with detail compiles (pending until resolved); a data view's is ready
        const d = deferred(), compiles = Object.keys(detail).length > 0;
        const p = { state: compiles ? 'idle' : 'ready', ready: d.promise,
          build() { if (this.state === 'idle') this.state = 'pending'; return this.ready; },
          resolve() { this.state = 'ready'; d.resolve(this); } };
        if (!compiles) d.resolve(p);
        pipes.set(k, p);
      }
      const p = pipes.get(k);
      if (build === 'now') p.build();
      return p;
    },
    viewReady(view, detail, curved) { return this.pipeline(view, detail, 'now', curved).ready; },
    shadowReady: () => Promise.resolve(),
    // the material view's one variant for these settings
    view(s, curved = false, view = 'realistic') { return pipes.get(key(view, detailDefines(s), curved)); },
  };
  return api;
}
function context({ close = false, curved = false, ratio = 1 } = {}) {
  const c = { settings: settings(), autoRes: { scale: 1 }, DEVICE_RATIO: ratio, pixelRatio: 1,
    innerWidth: 1280, innerHeight: 720, canvas: { width: 1280, height: 720 },
    sim: { g: { nx: 32, ny: 32, nz: 32 } }, vol: fakeVolume(), volume: new Object3D(),
    camera: new PerspectiveCamera(60, 1280 / 720, 0.1, 10000), camGrid: new Vector3(), invVol: new Matrix4(),
    coreWait: Promise.resolve(), coreReady: true, blocksOn: false, blocks: null,
    graphicsFailure: null, giWait: Promise.resolve(), physicsV2: null, win: null,
    get mapKind() { return kindOf(!!this.win); },   // (app.js: follows the window, as build() sets it)
    curved, isMaterialView, detailKey, UPSCALE_FLOOR,
    viewKeyOf: v => v, viewShadows: v => isMaterialView(v),
    post: { settings: { taa: true, upscale: 0.1, resolutionScale: 0.1 } }, settles: 0 };
  c.camera.position.set(close ? 16 : -10000, 16, 16);
  c.presetOf = () => UPSCALE[c.settings.upscale] ?? UPSCALE.native;
  c.outputRatio = () => c.presetOf() * c.DEVICE_RATIO > 1 ? c.DEVICE_RATIO : 1;
  c.renderer = { setPixelRatio(r) { c.pixelRatio = r; }, setSize(w, h) { c.canvas.width = w * c.pixelRatio; c.canvas.height = h * c.pixelRatio; } };
  c.warpNow = () => c.curved ? { k: 1 } : null;
  c.baseDetail = () => isMaterialView(c.settings.view) ? detailDefines(c.settings) : {};
  c.gpu = { async settled() { c.settles++; } }; // external completion; exact view/native promises must block themselves
  const postObject = new Function('settingsOf', 'temporalOf', 'AUTO_RES', 'UPSCALE_FLOOR', `return { ${scaleGetter} };`)(
    () => c.post.settings, () => true, AUTO_RES, UPSCALE_FLOOR);
  Object.defineProperty(c.post, 'renderScale', Object.getOwnPropertyDescriptor(postObject, 'renderScale'));
  c.ready = makeReady(c);
  c.height = () => c.canvas.height * c.post.renderScale;   // the next render's scene height
  return c;
}
const savedTimeout = globalThis.setTimeout;
let timersSet = 0;
globalThis.setTimeout = (...args) => { timersSet++; return savedTimeout(...args); };
try {
  // One variant at every distance: far and near ask for the same pipeline, every switched-on feature in it.
  const far = context(), fp = far.ready(), fd = watch(fp);
  await turn(); assert.equal(fd(), false, 'a far view waits on the same variant as a near one');
  assert.equal(far.vol.view(far.settings).state, 'pending');
  far.vol.view(far.settings).resolve(); await fp;
  const near = context({ close: true }), np = near.ready(), nd = watch(np);
  await turn(); assert.equal(nd(), false);
  near.vol.view(near.settings).resolve(); await np;
  for (const c of [far, near]) {
    assert(c.vol.requests.length > 0 && c.vol.requests.every(r => r.detail[FEATURE] && detailKey(r.detail) === detailKey(detailDefines(c.settings)) && r.build === 'now'),
      'readiness demands the settings\' one variant, nothing idle');
  }
  assert.equal(new Set([...far.vol.requests, ...near.vol.requests].map(r => detailKey(r.detail))).size, 1, 'camera distance picks no variant');

  // Curved: the bent pipeline alone (there is no flat gate variant to wait on as well).
  const bent = context({ close: true, curved: true }), bp = bent.ready();
  await turn(); assert(bent.vol.view(bent.settings, true)); assert.equal(bent.vol.view(bent.settings, false), undefined);
  bent.vol.view(bent.settings, true).resolve(); await bp;

  // Upscale/DPR/floor use the production post getter for the first render.
  const scale = context({ ratio: 2 });
  const sp = scale.ready(); await turn();
  assert.equal(scale.height(), 960);
  scale.vol.view(scale.settings).resolve(); await sp;
  scale.settings.upscale = 'native'; scale.autoRes.scale = 0.1; await scale.ready();
  assert.equal(scale.height(), 1440, 'native ignores adaptive scale');
  scale.settings.upscale = 'performance'; scale.autoRes.scale = 0.01;
  await scale.ready(); assert.equal(scale.height(), 480, 'adaptive floor retains device/output ratio');
  scale.post.settings.resolutionScale = 0.8; scale.ready.syncResolution();
  assert.equal(scale.post.settings.resolutionScale, 0.8, 'final render sync preserves beforeView resolution overrides');
  scale.post.settings.taa = false; await scale.ready();
  assert.equal(scale.height(), 720, 'TAA-off is the native scene height');

  // The frame helper's real transform: the eye in grid cells (the volume's uCam).
  const moved = context({ close: true }); moved.volume.position.set(100, 0, 0);
  moved.volume.scale.setScalar(2); moved.camera.position.set(132, 32, 32);
  assert.deepEqual(moved.ready.frameDetail(), detailDefines(moved.settings));
  assert.deepEqual(moved.camGrid.toArray(), [16, 16, 16]);

  const native = context(), gate = deferred(); native.physicsV2 = { ready: gate.promise, integrationReady: Promise.resolve() };
  const pending = native.ready(), done = watch(pending); await turn(); assert.equal(done(), false);
  native.vol.view(native.settings).resolve(); await turn();
  assert.equal(done(), false, 'the view alone does not satisfy pending native physics');
  gate.resolve(); await pending;
  const rejected = context(), bad = deferred(); rejected.physicsV2 = { ready: bad.promise, integrationReady: Promise.resolve() };
  const fail = rejected.ready(); bad.reject(new Error('native failed')); await assert.rejects(fail, /native failed/);
  const integration = context(), ig = deferred(); integration.physicsV2 = { ready: Promise.resolve(), integrationReady: ig.promise };
  integration.vol.pipeline('realistic', detailDefines(integration.settings)).resolve();
  const ip = integration.ready(), idone = watch(ip); await turn(); assert.equal(idone(), false); ig.resolve(); await ip;

  const changed = context({ close: true }), cp = changed.ready(), cd = watch(cp);
  await turn(); const old = changed.vol;
  changed.sim = { g: { nx: 16, ny: 16, nz: 16 } }; changed.vol = fakeVolume();
  old.view(changed.settings).resolve(); await turn(); assert.equal(cd(), false, 'a new grid re-waits'); assert(changed.vol.view(changed.settings));
  changed.settings.view = 'heat';
  changed.vol.view(changed.settings).resolve(); await cp;
  assert(changed.vol.requests.some(r => r.view === 'heat' && detailKey(r.detail) === ''), 'data views compile no material detail');

  const switches = context({ close: true }), swp = switches.ready(), swd = watch(swp);
  await turn(); const original = switches.vol.view(switches.settings);
  switches.settings.detail_mediaFlow = true;
  original.resolve(); await turn(); assert.equal(swd(), false, 'changed defines must re-wait');
  const switched = switches.vol.view(switches.settings);
  assert(switched && switched !== original); switched.resolve(); await swp;

  const dependencies = context(), shadow = deferred(), gi = deferred();
  dependencies.vol.pipeline('realistic', detailDefines(dependencies.settings)).resolve();
  dependencies.vol.shadowReady = () => shadow.promise; dependencies.giWait = gi.promise;
  const dp = dependencies.ready(), dd = watch(dp); await turn(); assert.equal(dd(), false);
  shadow.resolve(); await turn(); assert.equal(dd(), false, 'GI readiness is retained');
  gi.resolve(); await dp;

  const curvature = context({ close: true }), kp = curvature.ready(), kd = watch(kp);
  await turn(); curvature.curved = true; curvature.vol.view(curvature.settings).resolve(); await turn();
  assert.equal(kd(), false); assert(curvature.vol.view(curvature.settings, true)); curvature.vol.view(curvature.settings, true).resolve(); await kp;

  const transition = context({ close: true }); transition.vol.format = 2;
  const trp = transition.ready(), trd = watch(trp); await turn();
  const oldFormat = transition.vol.view(transition.settings);
  transition.vol.format = 0; oldFormat.resolve(); await turn();
  assert.equal(trd(), false, 'format transition re-waits instead of using a ready old-format shader');
  assert.notEqual(transition.vol.view(transition.settings), oldFormat);
  transition.vol.view(transition.settings).resolve(); await trp;

  const plain = context({ close: true }), blocks = deferred(); plain.blocksOn = true; plain.blocks = { ready: blocks.promise };
  const pp = plain.ready(), pd = watch(pp); await turn(); assert.equal(pd(), false);
  blocks.resolve(); await pp; assert.equal(plain.vol.requests.length, 0, 'Plain branch stays unchanged');
  assert.equal(timersSet, 0, 'readiness schedules no prefetch timer');
  console.log('Headless view CPU: one variant at every distance; demanded flat/curved detail; real transform; first-frame upscale/DPR/floor; grid/view/switch/curvature/format changes; native/integration/shadow/GI/World/Plain waits passed');
} finally {
  globalThis.setTimeout = savedTimeout;
}
