// CPU-only contact-motion regression: node tools/tool-camera-check.mjs
import assert from 'node:assert/strict';
import { createFeel } from '../src/pov/feel.js';
import { povEvents } from '../src/pov/events.js';
import { HIT } from '../src/pov/viewmodel.js';

let reduced = false;
globalThis.matchMedia = () => ({ get matches() { return reduced; } });
const feel = createFeel({});
const eye = { x: 0, y: 0, z: 0 };
const step = (dt) => {
  const { pitch, yaw, roll } = feel.update({ dt, live: true, eye });
  return { pitch: pitch || 0, yaw: yaw || 0, roll: roll || 0 };
};
const hit = (source, extra = {}) => povEvents.emit('impact', { source, point: eye, energy: 60, ...extra });
const dig = (extra = {}) => povEvents.emit('tool:action', { tool: 'shovel', action: 'dig', amount: 1, ...extra });
const start = (tool) => tool === 'shovel' ? dig() : hit(tool);
const sample = (tool, dt = 1 / 240) => {
  feel.reset(); step(0); start(tool);
  return Array.from({ length: Math.ceil(0.4 / dt) }, () => {
    const f = step(dt);
    assert.ok(f.pitch === feel.offsets.punchPitch && f.yaw === feel.offsets.punchYaw, 'third-person camera can omit the contact nod');
    return f;
  });
};
try {
  for (const key of ['PICK', 'AXE', 'SHOVEL']) {
    assert.ok(HIT[key].kick > 0 && !HIT[key].punch, `${key}: hand recoil without a second camera kick`);
  }
  const peaks = {};
  for (const tool of ['pickaxe', 'axe', 'shovel']) {
    const frames = sample(tool);
    peaks[tool] = Math.max(...frames.map(f => -f.pitch));
    assert.ok(peaks[tool] > 0 && peaks[tool] <= 0.6 * Math.PI / 180, `${tool}: bounded nod`);
    assert.ok(frames.every(f => f.pitch <= 0 && f.roll === 0), `${tool}: no overshoot or roll`);
    assert.equal(feel.trauma, 0, `${tool}: no random impact shake`);
    assert.deepEqual(frames.at(-1), { pitch: 0, yaw: 0, roll: 0 }, `${tool}: fully settles`);
    const peak = frames.findIndex(f => -f.pitch === peaks[tool]);
    assert.ok(frames.slice(0, peak).every((f, i) => f.pitch >= frames[i + 1].pitch), `${tool}: smooth attack`);
    assert.ok(frames.slice(peak, -1).every((f, i) => f.pitch <= frames[peak + i + 1].pitch), `${tool}: smooth recovery`);
    if (tool !== 'axe') assert.ok(frames.every(f => f.yaw === 0), `${tool}: no sideways motion`);
    const normal = frames;
    reduced = true;
    const quiet = sample(tool);
    reduced = false;
    assert.ok(quiet.every((f, i) => Math.abs(f.pitch - normal[i].pitch * 0.15) < 1e-12), `${tool}: reduced motion`);
    for (const dt of [1 / 30, 1 / 60, 1 / 144, 0.1]) {
      feel.reset(); step(0); start(tool);
      const n = Math.round(0.2 / dt);
      for (let i = 0; i < n; i++) step(dt);
      const t = n * dt, actual = { ...feel.offsets };
      feel.reset(); step(0); start(tool);
      const expected = step(t);
      assert.ok(Math.abs(actual.pitch - expected.pitch) < 1e-12, `${tool}: frame-rate independent`);
    }
  }
  assert.ok(peaks.pickaxe > peaks.axe && peaks.axe > peaks.shovel, 'distinct tool weights');
  feel.reset(); step(0); dig();
  const before = step(0.06);
  for (let i = 0; i < 20; i++) dig();
  assert.deepEqual(step(0), before, 'rapid scoops neither stack nor restart the nod');
  step(0.3);
  assert.deepEqual(step(0), { pitch: 0, yaw: 0, roll: 0 }, 'rapid scoops still settle');
  dig(); step(0.06); feel.reset();
  assert.deepEqual(step(0.01), { pitch: 0, yaw: 0, roll: 0 }, 'respawn clears contact');
  dig({ action: 'chip', amount: 0 });
  assert.ok(step(0.035).pitch < 0, 'shovel chips also confirm contact');

  for (const event of [
    () => dig({ amount: 0 }), () => dig({ action: 'refuse' }), () => dig({ action: 'dump' }),
    () => dig({ by: 'npc' }), () => povEvents.emit('tool:action', { tool: 'axe', action: 'swing' }),
  ]) {
    feel.reset(); event();
    assert.deepEqual(step(0.06), { pitch: 0, yaw: 0, roll: 0 }, 'no nod for misses, refusals, empty or remote scoops');
  }
  feel.reset(); feel.update({ dt: 0, live: false, eye }); hit('pickaxe'); dig();
  assert.deepEqual(step(0.06), { pitch: 0, yaw: 0, roll: 0 }, 'inactive POV ignores contact');
  hit('axe', { by: 'npc' });
  assert.ok(feel.trauma > 0, 'nearby NPC blows retain environmental shake');
  feel.reset(); hit('gun');
  assert.ok(feel.trauma > 0, 'gun impacts retain shake');
  feel.reset(); povEvents.emit('blast', { point: eye });
  assert.ok(feel.trauma > 0, 'blasts retain shake');
  feel.reset(); povEvents.emit('punch', { pitch: 0.01 }); step(0.01);
  assert.ok(feel.punch.pitch > 0, 'other view punches unchanged');
  console.log('PASS: distinct smooth tool contacts; bounded repetition, reduced motion, reset and combat effects');
} finally {
  feel.dispose();
  delete globalThis.matchMedia;
}
