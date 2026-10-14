// CPU only: input wakes the loop, not scene caches; actual render inputs still invalidate them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PerspectiveCamera, Scene, Object3D, Vector3, Quaternion } from 'three';
import { createPacer, createFrameLoop, createViewKey } from '../src/gfx/pacing.js';
import { createViewSettings, bindViewInputWake, brushKey } from '../src/gfx/viewInputs.js';
import { DETAIL, settingKey } from '../src/gfx/detail.js';

const settings = { view: 0, upscale: 'quality', nearGI: true, glowLights: true, caustics: true,
  ...Object.fromEntries(DETAIL.map(f => [settingKey(f), true])) };
const inputs = createViewSettings(settings);
const scene = new Scene(), camera = new PerspectiveCamera(), volume = new Object3D();
scene.add(volume);
const key = createViewKey({ still: [volume] });
const part = { visible: false, shape: 0, position: new Vector3(), scale: new Vector3(1, 1, 1), quaternion: new Quaternion() };
const brush = { parts: { mesh: part }, get visible() { return part.visible; } };
let color = '#ff0000', width = 800;
const view = () => key(camera, scene, 1, width, 600, brushKey(brush, color), inputs, {}, {});
const callbacks = [];
let frames = 0, draws = 0, lastStill = 0;
const loop = createFrameLoop(() => {
  frames++;
  pacer.derived('same simulation');
  if (pacer.view(view())) draws++;
  lastStill = key.still;
  return !pacer.settled;
}, { raf: fn => callbacks.push(fn) });
const pacer = createPacer({ derivedSettle: 1, viewSettle: 2, onWake: () => loop.wake() });
const target = new EventTarget();
bindViewInputWake(target, () => loop.wake());
function drain() {
  let n = 0;
  while (callbacks.length) { assert.ok(n++ < 20, 'loop returns to idle'); callbacks.shift()(n * 20); }
}
loop.start(); drain();
assert.ok(loop.asleep);
const still = lastStill, wakes = pacer.wakes, rendered = draws;

// DOM events (including keyboard controls and window leave) schedule inspection,
// but an unchanged view stays settled and its reusable scene stays valid.
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerleave', 'pointercancel',
  'wheel', 'keydown', 'keyup', 'input', 'change', 'resize', 'blur']) {
  const before = frames;
  target.dispatchEvent(new Event(type));
  assert.equal(callbacks.length, 1, `${type}: sleeping loop wakes`);
  drain();
  assert.equal(frames, before + 1, `${type}: no convergence frames`);
  assert.equal(draws, rendered, `${type}: no scene draw`);
  assert.equal(lastStill, still, `${type}: cached scene retained`);
  assert.equal(pacer.wakes, wakes, `${type}: no explicit cache invalidation`);
}
for (const field of ['dockCollapsed', 'profiler', 'propText', 'propField', 'rate', 'replace', 'specificDelete',
  'replaceTarget', 'steps', 'gravity', 'paused', 'camSpeed', 'sensitivity', 'sprintMode', 'tool', 'radius', 'shape']) {
  settings[field] = 'changed';
  target.dispatchEvent(new Event('input')); drain();
  assert.equal(draws, rendered, `${field}: control setting alone does not redraw`);
  assert.equal(lastStill, still, `${field}: no scene invalidation`);
}

function changes(label, change, event = 'change') {
  const before = draws, oldStill = lastStill;
  change(); target.dispatchEvent(new Event(event)); drain();
  assert.equal(draws, before + 2, `${label}: redraw and converge`);
  assert.notEqual(lastStill, oldStill, `${label}: cached scene invalidated`);
}
for (const field of Object.keys(inputs)) changes(field, () => { settings[field] = settings[field] === true ? false : 'different'; });
changes('camera movement from keyboard', () => { camera.position.x++; camera.updateMatrixWorld(); }, 'keydown');
changes('camera projection', () => { camera.fov++; camera.updateProjectionMatrix(); }, 'wheel');
changes('resize', () => { width++; }, 'resize');
changes('volume transform', () => { volume.position.x++; });
changes('brush appears', () => { part.visible = true; }, 'pointermove');
changes('brush moves', () => { part.position.x++; }, 'pointermove');
changes('brush radius', () => { part.scale.multiplyScalar(2); });
changes('brush shape', () => { part.shape = 1; });
changes('brush color only', () => { color = '#00ff00'; });
changes('leaving canvas hides brush', () => { part.visible = false; }, 'pointerleave');
const hidden = draws;
color = '#0000ff'; target.dispatchEvent(new Event('input')); drain();
assert.equal(draws, hidden, 'hidden brush color is irrelevant');
const beforeAsync = draws;
pacer.wake(); drain();
assert.equal(draws, beforeAsync + 2, 'asynchronous explicit invalidation still redraws');
assert.equal(pacer.wakes, wakes + 1, 'only explicit invalidation advances wake counter');

// Keep the production wiring on this tested path, not the old full-settings key.
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.ok(app.includes('const viewSettings = createViewSettings(settings);'));
assert.ok(app.includes('bindViewInputWake(window, () => { autoRes.wake(); wakeLoop(); });'));
assert.ok(app.includes('viewSettings, gfx, post.settings)'));
assert.ok(app.includes('brushKey(brush, toolById(settings.tool).color)'));
assert.ok(app.includes('pointerPickDirty = true;'));
assert.ok(app.includes("if (!renderOnly && (pointerPickDirty || runView || pov?.active || testMode === 'preview')) requestPick();"));
console.log('PASS view input invalidation: UI stays settled; render settings, camera, resize, brush and async changes redraw');
