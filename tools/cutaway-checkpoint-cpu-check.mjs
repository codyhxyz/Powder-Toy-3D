import test from 'node:test';
import assert from 'node:assert/strict';
import { clipRayToCutaway, cutawayNormal, cutawayParams, cutawayPlaneHit, newCutaway } from '../src/cutaway.js';
import { createCheckpoint } from '../src/checkpoint.js';
import { is, KEYS } from '../src/keys.js';
import { gridLayout } from '../src/sim.js';
import { FrameUniforms } from '../src/shaders/bindings.js';
import { FrameUniformsStruct } from '../src/gfx/uniforms.js';
import { PickParams, PICK_BATCH, pickFrag, volumeFrag } from '../src/shaders/render.js';
import { worldPickFrag } from '../src/shaders/world/pick.js';
import { worldMarchFrag } from '../src/shaders/world/march.js';
import { meshWGSL, drawWGSL } from '../src/shaders/blocks.js';
import { nativeParticleWGSL, particlePickWGSL } from '../src/shaders/v2/particleRender.js';
import { nagaExec } from './naga.mjs';
import { Vector3 } from 'three';
import { createSaves } from '../src/saves/game.js';
import { registerSaveSection, unregisterSaveSection } from '../src/saves/sections.js';
import { BrickStore } from '../src/world/store.js';
import { NativeBrickStore } from '../src/world/nativeStore.js';

for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) {
  test(`axis ${axis}, hidden side ${sign}: entry, exit and normal`, () => {
    const state = { enabled: true, axis, sign, coord: 16 };
    const outward = cutawayNormal(state), inward = outward.map(x => 0 - x);
    const center = [16, 16, 16], hidden = center.map((x, i) => x + 2 * outward[i]);
    const retained = center.map((x, i) => x + 4 * inward[i]);
    assert.deepEqual(outward, [0, 1, 2].map(i => i === axis ? sign : 0));
    assert.deepEqual(cutawayPlaneHit(hidden, inward, state), { t: 2, point: center, normal: outward });
    assert.deepEqual(clipRayToCutaway(hidden, inward, state, 0, 9), { tNear: 2, tFar: 9, normal: outward });
    assert.deepEqual(clipRayToCutaway(retained, outward, state), { tNear: 0, tFar: 4, normal: null });
    assert.deepEqual(clipRayToCutaway(hidden, inward, state, 3, 9), { tNear: 3, tFar: 9, normal: null });
    assert.equal(clipRayToCutaway(hidden, outward, state), null);
    assert.equal(clipRayToCutaway(hidden, inward, state, 0, 2), null);
    const tangent = [0, 1, 2].map(i => i === (axis + 1) % 3 ? 1 : 0);
    assert.equal(cutawayPlaneHit(hidden, tangent, state), null);
    assert.equal(clipRayToCutaway(hidden, tangent, state), null);
    assert.deepEqual(clipRayToCutaway(retained, tangent, state), { tNear: 0, tFar: Infinity, normal: null });
    assert.deepEqual(clipRayToCutaway(center, tangent, state), { tNear: 0, tFar: Infinity, normal: null });
    assert.deepEqual(cutawayParams(state, [4, 8, 12]), [16 - [4, 8, 12][axis], sign, axis, 1]);
  });
}

test('disabled cutaway leaves the interval and its entry normal alone', () => {
  const state = newCutaway();
  assert.deepEqual(clipRayToCutaway([0, 0, 0], [0, 1, 0], state, 1, 2), { tNear: 1, tFar: 2, normal: null });
  assert.deepEqual(cutawayParams(state), [0, 0, 0, 0]);
});

test('one independent checkpoint can replace, restore repeatedly, and clear', async () => {
  let cells = [1, 2];
  const seen = [];
  const c = createCheckpoint({ capture: async () => cells.slice(), restore: async (state, valid) => {
    if (!valid()) return false;
    cells = state.slice(); return true;
  }, onChange: (s) => seen.push(s) });
  assert.equal(await c.reset(), false);
  assert.equal(await c.save(), true);
  cells[0] = 8;
  for (let i = 0; i < 2; i++) {
    assert.equal(await c.reset(), true);
    assert.deepEqual(cells, [1, 2]);
    cells[1]++;
  }
  assert.equal(await c.save(), true);
  assert.equal(await c.reset(), true);
  assert.deepEqual(cells, [1, 3]);
  c.clear();
  assert.equal(await c.reset(), false);
  assert.deepEqual(seen.at(-1), { ready: false, busy: null });
});

test('map switches invalidate in-flight readbacks and gate a queued restore', async () => {
  let finishRead, finishRestore;
  const c = createCheckpoint({ capture: () => new Promise(r => { finishRead = r; }), restore: async (_data, valid) => {
    await new Promise(r => { finishRestore = r; });
    return valid();
  } });
  const oldRead = c.save();
  assert.equal(c.state.busy, 'saving');
  assert.equal(await c.save(), false);
  c.clear();
  finishRead([1]);
  assert.equal(await oldRead, false);
  const fresh = c.save(); finishRead([2]);
  assert.equal(await fresh, true);
  const resetting = c.reset();
  assert.equal(c.state.busy, 'restoring');
  c.clear();
  finishRestore();
  assert.equal(await resetting, false);
  assert.equal(c.state.ready, false);
});

test('checkpoint uses the native save path, including retained world edits, without a legacy read or thumbnail', async () => {
  const g = gridLayout(32, 32, 32);
  const sim = { g, origin: new Vector3(16, 0, 0), loadNative() {} };
  const bricks = [12, 8, 8], win = {
    loaded: true, size: [48, 32, 32], scene: {}, store: new BrickStore(bricks), nativeStore: new NativeBrickStore(bricks),
    planted: new Uint8Array(bricks[0] * bricks[2]), acquireReadLock: () => () => {},
    loadSaved(origin, fill, store, planted) {
      sim.origin.fromArray(origin); this.store.fromBytes(store); this.planted.set(planted); fill();
    },
  };
  win.planted[5] = 1;
  let words = new Uint32Array([170, 0x7fc00001, 3, 4]);
  const key = 'checkpointTestCore';
  registerSaveSection(key, { save: () => words.slice(), load: (data) => { words = data.slice(); } });
  try {
    const game = createSaves({ getSim: () => sim, getWin: () => win, settings: {},
      captureNativeOnly: () => true, nativeLoad: () => true, header: () => ({ world: { seed: 17 } }),
      thumbnail: () => assert.fail('checkpoint requested a thumbnail'), finish() {}, onSettings() {} });
    const data = await game.captureCheckpoint();
    assert.equal(data.planes, null);
    sim.origin.set(0, 0, 0); win.planted.fill(0); words.fill(0);
    assert.ok(await game.restoreCheckpoint(data, { prepare: () => true }));
    assert.deepEqual(sim.origin.toArray(), [16, 0, 0]);
    assert.equal(win.planted[5], 1);
    assert.deepEqual([...words], [170, 0x7fc00001, 3, 4]);
  } finally { unregisterSaveSection(key); }
});

test('new controls do not collide with any binding, including character/code and modifiers', () => {
  const added = ['slice', 'sliceFlip', 'sliceBack', 'sliceForward', 'checkpointSave', 'checkpointReset'];
  for (const action of added) for (const binding of KEYS[action]) {
    const parts = binding.split('+'), code = parts.pop(), key = code.slice(3).toLowerCase();
    for (const shiftKey of [false, true]) {
      const e = { code, key, altKey: parts.includes('Alt'), shiftKey };
      assert.deepEqual(Object.entries(KEYS).filter(([, keys]) => is(e, keys)).map(([name]) => name), [action]);
    }
  }
});

test('frame and per-ray uniforms pack the same cutaway for all marcher and picker variants', () => {
  const g = gridLayout(32, 32, 32);
  const plane = [16, -1, 2, 1];
  assert.equal(FrameUniforms.offsetOf('cutaway'), FrameUniformsStruct.offsets.cutaway);
  assert.equal(FrameUniformsStruct.offsets.cutaway % 16, 0);
  const bytes = FrameUniformsStruct.pack({ cutaway: plane });
  assert.deepEqual([...new Float32Array(bytes, FrameUniformsStruct.offsets.cutaway, 4)], plane);
  const batch = PickParams.pack({ cutaway: Array.from({ length: PICK_BATCH }, (_, i) => i ? [0, 0, 0, 0] : plane) });
  assert.deepEqual([...new Float32Array(batch, PickParams.offsets.cutaway, 8)], [...plane, 0, 0, 0, 0]);
  for (const code of [volumeFrag(g), volumeFrag(g, { view: 'heat', curved: true }), worldMarchFrag(g)]) {
    assert.match(code, /cutaway: vec4f,/);
    assert.match(code, /FU\.cutaway/);
    assert.match(code, /cutawayKeepsCell\(cell, /);
  }
  for (const code of [pickFrag(g), worldPickFrag(g)]) {
    assert.match(code, /cutaway: array<vec4f, 8>,/);
    assert.match(code, /P\.cutaway\[i\]/);
    assert.match(code, /cutawayKeepsCell\(cell, slice\)/);
  }
});

test('Naga validates cutaway shader entrypoints without a browser or GPU', () => {
  const g = gridLayout(32, 32, 32);
  const modules = {
    box: volumeFrag(g, { fixedReadFormat: 2 }),
    boxCurved: volumeFrag(g, { curved: true, fixedReadFormat: 2 }),
    data: volumeFrag(g, { view: 'pressure', fixedReadFormat: 2 }),
    dataCurved: volumeFrag(g, { view: 'flow', curved: true, fixedReadFormat: 2 }),
    boxPick: pickFrag(g), worldPick: worldPickFrag(g),
    plainMesh: meshWGSL(g), plainDraw: drawWGSL(g),
    particles: nativeParticleWGSL(), rays: nativeParticleWGSL(true), particlePick: particlePickWGSL(),
  };
  for (const [name, code] of Object.entries(modules)) nagaExec(code, `${name}.wgsl`);
});
