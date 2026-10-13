// Pacing check, no browser and no GPU: node tools/pacing-check.mjs [--ticks N] [--seed S]
//
// 1. createViewKey (gfx/pacing.js) against the string it replaces: app.js's
//    per-tick view key, built here exactly as app.js built it (camera
//    matrices, pixel ratio, window size, JSON of settings, gfx and
//    post.settings, sceneKey(scene), the far field's chunksDrawn). Over a
//    recorded session (a scripted one: orbit, zoom, resize, settings and
//    scene edits, figures moving, objects hidden and re-added, values that
//    print alike, such as 0 and -0, NaN and Infinity in JSON, 1 and '1') and
//    then a seeded random one, the counter must change on exactly the ticks
//    where the string does. Negative controls: createViewKey with one of its
//    rules broken (made from gfx/pacing.js's own text: the scene read before
//    the camera, key names ignored, scalars compared with ===, no
//    scene.updateMatrixWorld) must each fail those sessions.
// 2. createFrameLoop: deep idle (F7) stops scheduling callbacks when a frame
//    says so; wake() and pacer.wake() start it again, once.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createViewKey, sceneKey, createFrameLoop, createPacer } from '../src/gfx/pacing.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
const TICKS = opt('ticks', 20000);
const SEED = opt('seed', 7);

// the string app.js built every presentable tick (app.js main 9b075ae, tick())
const oldKey = (camera, scene, pixelRatio, width, height, extra, settings, gfx, postSettings) =>
  `${camera.matrixWorld.elements}|${camera.projectionMatrix.elements}|${pixelRatio}|${width}x${height}`
  + `|${JSON.stringify(settings)}|${JSON.stringify(gfx)}|${JSON.stringify(postSettings)}|${sceneKey(scene)}`
  + `|${extra}`;

// mulberry32: a seeded PRNG, so a failure replays
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The session's state: what app.js passes, built from three's real objects.
function session() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1.6, 0.05, 200);
  camera.position.set(12, 8, 14);
  camera.lookAt(0, 0, 0);
  const volume = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  volume.scale.setScalar(10 / 128);
  scene.add(volume);
  const grid = new THREE.Object3D();
  scene.add(grid);
  const figures = [];
  for (let i = 0; i < 3; i++) {
    const f = new THREE.Group();
    f.position.set(i, 0, -i);
    const head = new THREE.Mesh();
    head.position.y = 1.7;
    f.add(head);
    scene.add(f);
    figures.push(f);
  }
  const state = {
    scene, camera, volume, grid, figures, pixelRatio: 1, width: 1280, height: 800, extra: undefined,
    settings: { view: 0, steps: 4, paused: false, tool: 'SAND', radius: 6, upscale: 'quality', detail: { foam: true, level: 2 } },
    gfx: { smoothing: 0.5, sunTilt: 0.3, lamps: [1, 2, 3] },
    post: { taa: true, upscale: 1 / 1.5, resolutionScale: 1, bloom: 0.3, exposure: 0.7, raw: false, night: 0, nightGain: 1 },
  };
  return state;
}

// Each mutation is one thing that happens between two ticks of a real session.
const mutations = {
  orbit(s, r) {   // OrbitControls: position and orientation; matrixWorld follows when the camera is updated
    s.camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), (r() - 0.5) * 0.1);
    s.camera.lookAt(0, 0, 0);
    if (r() < 0.7) s.camera.updateMatrixWorld();   // (post.render updates it on view frames only)
  },
  zoom(s, r) { s.camera.fov = 30 + Math.floor(r() * 3) * 10; s.camera.updateProjectionMatrix(); },
  aspect(s, r) { s.width = [1280, 1281, 900][Math.floor(r() * 3)]; s.camera.aspect = s.width / s.height; s.camera.updateProjectionMatrix(); },
  resize(s, r) { s.height = [800, 799, 600][Math.floor(r() * 3)]; },
  pixelRatio(s, r) { s.pixelRatio = [1, 1, 0.5, 2][Math.floor(r() * 4)]; },
  cameraIntoScene(s) { if (!s.camera.parent) s.scene.add(s.camera); else s.scene.remove(s.camera); },
  walk(s, r) { const f = s.figures[Math.floor(r() * s.figures.length)]; if (f) f.position.x += (r() - 0.5) * 0.2; },
  walkBack(s) { const f = s.figures[0]; if (f) f.position.x = Math.round(f.position.x); },
  negZero(s) { const f = s.figures[0]; if (f) f.position.z = Object.is(f.position.z, -0) ? 0 : -0; },   // prints alike
  nan(s, r) { const f = s.figures[1]; if (f) f.position.y = r() < 0.5 ? NaN : 0; },
  hide(s, r) { const f = s.figures[Math.floor(r() * s.figures.length)]; if (f) f.visible = !f.visible; },
  hideChild(s) { const h = s.figures[0]?.children[0]; if (h) h.visible = !h.visible; },
  add(s) { const f = new THREE.Group(); f.add(new THREE.Mesh()); s.scene.add(f); s.figures.push(f); },
  remove(s, r) { if (!s.figures.length) return; const i = Math.floor(r() * s.figures.length); s.scene.remove(s.figures[i]); s.figures.splice(i, 1); },
  reorder(s) { const f = s.figures[0]; if (f) { s.scene.remove(f); s.scene.add(f); s.figures.push(s.figures.shift()); } },
  manualMatrix(s, r) {   // an object that keeps its own matrices (matrixAutoUpdate false, as world chunks do)
    s.grid.matrixAutoUpdate = false;
    s.grid.matrix.makeTranslation(Math.floor(r() * 2), 0, 0);
    s.grid.matrixWorldNeedsUpdate = r() < 0.8;
  },
  steps(s, r) { s.settings.steps = 1 + Math.floor(r() * 3); },
  toggle(s) { s.settings.paused = !s.settings.paused; },
  tool(s, r) { s.settings.tool = ['SAND', 'WATR', 'SAND"x', 'é'][Math.floor(r() * 4)]; },
  nested(s, r) { s.settings.detail.level = Math.floor(r() * 3); },
  keyOrder(s) { const v = s.settings.view; delete s.settings.view; s.settings.view = v; },   // the same keys in another order
  undefinedValue(s) { s.settings.extraMenu = s.settings.extraMenu === undefined ? null : undefined; },
  functionValue(s) { s.settings.onPick = s.settings.onPick ? undefined : () => 1; },   // JSON leaves functions out
  sameValuesOtherKeys(s, r) {   // only the keys' names or order differ
    s.gfx.pair = [{ a: 1, b: 1 }, { b: 1, a: 1 }, { c: 1, b: 1 }][Math.floor(r() * 3)];
  },
  addKey(s) { if ('label' in s.gfx) delete s.gfx.label; else s.gfx.label = 'x'; },
  arrayEdit(s, r) {
    const a = s.gfx.lamps;
    const k = Math.floor(r() * 4);
    if (k === 0) a.push(1); else if (k === 1) a.pop(); else if (k === 2) a[0] = undefined; else a[0] = r() < 0.5 ? null : 1;
  },
  infinity(s, r) { s.gfx.sunTilt = [NaN, Infinity, -Infinity, null, 0.3][Math.floor(r() * 5)]; },   // all but 0.3 are null in JSON
  zeroSign(s) { s.gfx.smoothing = Object.is(s.gfx.smoothing, -0) ? 0 : -0; },
  dateValue(s, r) { s.gfx.when = new Date(r() < 0.5 ? 0 : 1000); },   // toJSON
  boxed(s, r) { s.gfx.boxed = r() < 0.5 ? new Number(1) : 1; },   // eslint-disable-line no-new-wrappers
  resolution(s, r) { s.post.resolutionScale = r() < 0.5 ? 1 : 0.85; },
  rawView(s) { s.post.raw = !s.post.raw; },
  far(s, r) { s.extra = [undefined, 0, 1, '1', 2, 'undefined'][Math.floor(r() * 6)]; },   // 1 and '1' print alike
  nothing() {},
};

// Both keys mutate what they read (sceneKey brings the world matrices up to
// date), so each runs on a session of its own, the two kept in lockstep: the
// same mutations with the same random draws.
function run(name, seed, steps, makeViewKey = createViewKey) {
  const sOld = session(), sNew = session();
  const rOld = rng(seed), rNew = rng(seed);
  const viewKey = makeViewKey();
  let prevOld = null, prevNew = null, changes = 0, ticks = 0;
  for (const [what, apply] of steps()) {
    apply(sOld, rOld);
    apply(sNew, rNew);
    const o = oldKey(sOld.camera, sOld.scene, sOld.pixelRatio, sOld.width, sOld.height, sOld.extra, sOld.settings, sOld.gfx, sOld.post);
    const n = viewKey(sNew.camera, sNew.scene, sNew.pixelRatio, sNew.width, sNew.height, sNew.extra, sNew.settings, sNew.gfx, sNew.post);
    const oldChanged = o !== prevOld, newChanged = n !== prevNew;
    assert.equal(newChanged, oldChanged, `${name}: tick ${ticks} after "${what}": the string ${oldChanged ? 'changed' : 'stayed'}, the counter ${newChanged ? 'changed' : 'stayed'}`);
    if (oldChanged) changes++;
    prevOld = o; prevNew = n; ticks++;
  }
  return { ticks, changes };
}

// the scripted session: each mutation alone, with settled ticks around it, then each again to undo or repeat it
function* scriptedSteps() {
  yield ['first tick', () => {}];
  for (const [what, m] of Object.entries(mutations)) {
    yield [what, m];
    yield [`${what}, settled`, () => {}];
    yield [`${what} again`, m];
    yield [`${what} again, settled`, () => {}];
  }
}
const scripted = run('scripted', 1, scriptedSteps);
assert.ok(scripted.changes > 20 && scripted.changes < scripted.ticks, `scripted: ${scripted.changes} changes in ${scripted.ticks} ticks`);
console.log(`PASS: view key, scripted session: ${scripted.ticks} ticks, the string changed on ${scripted.changes}, the counter on the same ticks`);

// the seeded random session: 0-3 mutations between ticks (often none: a settled view)
const names = Object.keys(mutations);
const randomSteps = (seed, ticks) => function* () {
  const pick = rng(seed + 1);
  for (let i = 0; i < ticks; i++) {
    const n = pick() < 0.4 ? 0 : 1 + Math.floor(pick() * 3);
    const picked = Array.from({ length: n }, () => names[Math.floor(pick() * names.length)]);
    yield [picked.join(' + ') || 'nothing', (s, r) => picked.forEach((k) => mutations[k](s, r))];
  }
};
const random = run(`random (seed ${SEED})`, SEED, randomSteps(SEED, TICKS));
console.log(`PASS: view key, random session (seed ${SEED}): ${random.ticks} ticks, ${random.changes} changes, all on the string's ticks`);

// Negative controls: createViewKey with one rule broken, each made from
// gfx/pacing.js's own text by one edit (which must still apply: a control
// that no longer matches the source fails), must fail the scripted session
// or the random one (seed 7, up to 20,000 ticks, whatever --ticks says).
const SOURCE = readFileSync(new URL('../src/gfx/pacing.js', import.meta.url), 'utf8');
const SCENE_LINE = '    if (sceneChanged(scene)) changed = true;\n';
const CAMERA_LINE = '    if (storeNumbers(camera.matrixWorld.elements';
const CONTROLS = {
  'the scene read before the camera (its update moves a camera inside it)': (src) => src.replace(SCENE_LINE, '').replace(CAMERA_LINE, `${SCENE_LINE}${CAMERA_LINE}`),
  'object key names ignored (only values compared)': (src) => src.replace('keys[n] !== k || ', ''),
  'scalars compared with === (0 and -0, NaN, 1 and \'1\' print alike)': (src) => src.replace('const same = sameText(v, scalars[i]);', 'const same = v === scalars[i];'),
  'no scene.updateMatrixWorld before reading world matrices': (src) => src.replace('    scene.updateMatrixWorld();\n    n = 0;', '    n = 0;'),
};
for (const [what, edit] of Object.entries(CONTROLS)) {
  const broken = edit(SOURCE);
  assert.notEqual(broken, SOURCE, `negative control "${what}": its edit no longer applies to gfx/pacing.js (update the control)`);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(broken).toString('base64')}`);
  let caught = null;
  for (const [name, seed, steps] of [['scripted', 1, scriptedSteps], ['random', 7, randomSteps(7, 20000)]]) {
    try { run(name, seed, steps, mod.createViewKey); } catch (e) { caught = e.message.split('\n')[0]; break; }
  }
  assert.ok(caught, `negative control "${what}": the broken key passed every session (the check can't see that rule)`);
  console.log(`PASS: negative control, ${what}: fails (${caught})`);
}

// the cost it removes: the string per tick against the counter, on a settled scene with many objects
{
  const s = session();
  for (let i = 0; i < 400; i++) mutations.add(s, Math.random);
  const viewKey = createViewKey();
  const N = 300;
  let t = performance.now();
  for (let i = 0; i < N; i++) oldKey(s.camera, s.scene, s.pixelRatio, s.width, s.height, s.extra, s.settings, s.gfx, s.post);
  const oldMs = (performance.now() - t) / N;
  t = performance.now();
  for (let i = 0; i < N; i++) viewKey(s.camera, s.scene, s.pixelRatio, s.width, s.height, s.extra, s.settings, s.gfx, s.post);
  const newMs = (performance.now() - t) / N;
  console.log(`note: a settled tick with ${s.scene.children.length} scene objects: string ${oldMs.toFixed(3)} ms, counter ${newMs.toFixed(3)} ms`);
}

// ---------------------------------------------------------------- the frame loop
{
  const queue = [];
  const raf = (fn) => queue.push(fn);
  const pump = (now) => { const q = queue.splice(0); q.forEach((fn) => fn(now)); return q.length; };
  let busy = 3, frames = 0;
  const loop = createFrameLoop(() => { frames++; return busy-- > 0; }, { raf });
  assert.ok(loop.asleep, 'a new loop waits for start()');
  loop.start(); loop.start();
  assert.equal(queue.length, 1, 'start() is idempotent');
  for (let t = 0; t < 10; t++) pump(t);
  assert.equal(frames, 4, 'it runs until a frame returns false');
  assert.ok(loop.asleep, 'then it schedules nothing');
  assert.equal(pump(10), 0, 'asleep: no callbacks at all');
  loop.wake(); loop.wake();
  assert.equal(queue.length, 1, 'wake() schedules one callback');
  pump(11);
  assert.ok(loop.asleep);
  // a wake during the frame that goes to sleep keeps it running
  const l2 = createFrameLoop(() => { l2.wake(); return false; }, { raf });
  l2.start();
  pump(12);
  assert.ok(!l2.asleep, 'a wake during the frame wins over its false');
  queue.length = 0;
  // a frame that throws keeps the loop running (the old loop re-requested first)
  let throws = true;
  const l3 = createFrameLoop(() => { if (throws) { throws = false; throw new Error('frame failed'); } return false; }, { raf });
  l3.start();
  assert.throws(() => pump(13), /frame failed/);
  assert.ok(!l3.asleep, 'still scheduled after a throw');
  pump(14);
  assert.ok(l3.asleep);
  // pacer.wake() reaches the loop through onWake
  const l4 = createFrameLoop(() => false, { raf });
  const pacer = createPacer({ derivedSettle: 2, viewSettle: 3, onWake: () => l4.wake() });
  assert.ok(l4.asleep);
  pacer.wake();
  assert.ok(!l4.asleep, 'pacer.wake() starts a sleeping loop');
  pump(15);
  assert.ok(l4.asleep);
  console.log('PASS: frame loop: sleeps when a frame says so, wake()/pacer.wake() restart it once, a wake during the frame or a throw keeps it running');
}
