import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { E } from '../../src/elements.js';
import { createElectronicsInteractions, beforeControlContact } from '../../src/pov/electronicsInteractions.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
function fixture() {
  const sim = { g: { nx: 32, ny: 32, nz: 32 }, origin: new Vector3(64, 0, 96) };
  const world = { scene: {}, historyIdentity: {}, epoch: 1, pending: null }, writes = [], sent = [];
  let allowed = true, pick = async () => ({ valid: true, id: E.SWITCH, cell: new Vector3(2, 5, 3) });
  let commit = async spec => { writes.push(spec); return { ok: true }; };
  const api = createElectronicsInteractions({
    getSim: () => sim, getWorld: () => world, getSceneKey: () => 'map', canMutate: () => allowed,
    guestUse: intent => { sent.push(intent); return true; }, pickRay: (...args) => pick(...args),
    parts: { activate: spec => commit(spec), reset() {}, dispose() {} },
  });
  return { sim, world, api, writes, sent, eye: new Vector3(2, 5, 8), dir: new Vector3(0, 0, -1),
    pick(fn) { pick = fn; }, commit(fn) { commit = fn; }, authority(v) { allowed = v; } };
}
test('fresh exact physics ray and world coordinates reach the native writer', async () => {
  const f = fixture(); let args;
  f.pick(async (...a) => { args = a; return { valid: true, id: E.SWITCH, cell: new Vector3(2, 5, 3) }; });
  assert.equal((await f.api.useRay(f.eye, f.dir)).ok, true);
  assert.deepEqual(args.slice(2), [false, false]);
  assert.deepEqual(f.writes, [{ x: 2, y: 5, z: 3, material: E.SWITCH }]); assert.equal(f.world.pending, null);
});
test('button activation does not inject supply, heat or matter parameters', async () => {
  const f = fixture(); f.pick(async () => ({ valid: true, id: E.BUTTON, cell: new Vector3(2, 5, 3) }));
  await f.api.useRay(f.eye, f.dir);
  assert.deepEqual(f.writes, [{ x: 2, y: 5, z: 3, material: E.BUTTON }]);
});
test('blocked, non-control, changed and out-of-reach targets never write', async () => {
  const f = fixture();
  for (const hit of [{ valid: false }, { valid: true, id: E.METAL, cell: new Vector3(2, 5, 3) },
    { valid: true, id: E.SWITCH, cell: new Vector3(2, 5, 31) }]) {
    f.pick(async () => hit); assert.equal((await f.api.useRay(f.eye, f.dir)).ok, false);
  }
  f.pick(async () => ({ valid: true, id: E.SWITCH, cell: new Vector3(2, 5, 3) }));
  assert.equal((await f.api.useRay(f.eye, f.dir, { expected: { cell: [67, 5, 99], material: E.SWITCH } })).ok, false);
  assert.equal(f.writes.length, 0);
});
test('window barrier, save settling and commit guard span readback and original impact', async () => {
  const f = fixture(), wait = deferred(), order = [];
  f.commit(async () => { order.push('activate'); assert.equal(f.api.canCommit, true); await wait.promise; return { ok: true }; });
  assert.equal(beforeControlContact(f.sim, { id: E.SWITCH, cell: new Vector3(2, 5, 3) }, 'ballistic', () => {
    assert(f.world.pending); order.push('penetrate');
  }), true);
  await tick(); assert(f.world.pending); assert.equal(f.api.pending, 1);
  let saved = false; const save = f.api.settle().then(() => { saved = true; });
  await tick(); assert.equal(saved, false); wait.resolve(); await save;
  assert.deepEqual(order, ['activate', 'penetrate']); assert.equal(f.api.canCommit, false); assert.equal(f.world.pending, null);
});
test('scene, window, native owner and same-Sim replacements invalidate stale picks', async () => {
  for (const replace of [f => f.api.reset(), f => { f.sim.origin.x++; }, f => { f.sim.compactOwner = {}; },
    f => { f.world.historyIdentity = {}; }, f => { f.world.scene = {}; }]) {
    const f = fixture(), wait = deferred(); f.pick(() => wait.promise);
    const job = f.api.useRay(f.eye, f.dir); await tick(); replace(f);
    wait.resolve({ valid: true, id: E.SWITCH, cell: new Vector3(2, 5, 3) });
    assert.equal((await job).ok, false); assert.equal(f.writes.length, 0);
  }
});
test('guest use sends captured rays; physical contacts never mutate the replica', async () => {
  const f = fixture(); f.authority(false);
  assert.equal((await f.api.useRay(f.eye, f.dir)).matched, true);
  assert.deepEqual(f.sent, [{ cell: [66, 5, 99], material: E.SWITCH, source: 'use',
    actionRay: { eye: [66, 5, 104], dir: [0, 0, -1] } }]);
  await f.api.useRay(f.eye, f.dir, { source: 'god' });
  let after = false;
  await f.api.contact({ id: E.SWITCH, cell: new Vector3(2, 5, 3) }, 'melee', () => { after = true; });
  assert.equal(after, false); assert.equal(f.writes.length, 0); assert.equal(f.sent.length, 2);
});
test('authority loss or disposal fences destruction after readback', async () => {
  for (const cancel of [f => f.authority(false), f => f.api.dispose()]) {
    const f = fixture(), wait = deferred(); let after = false;
    f.commit(async () => { await wait.promise; assert.equal(f.api.canCommit, false); return { ok: true }; });
    const job = f.api.contact({ id: E.SWITCH, cell: new Vector3(2, 5, 3) }, 'melee', () => { after = true; });
    await tick(); cancel(f); wait.resolve(); await job; assert.equal(after, false);
  }
});
test('foreign transactions are not overwritten and queued arguments are owned', async () => {
  const f = fixture(), other = deferred(); f.world.pending = other.promise;
  assert.equal((await f.api.useRay(f.eye, f.dir)).ok, false); assert.equal(f.world.pending, other.promise);
  f.world.pending = null;
  const hit = { id: E.SWITCH, cell: new Vector3(2, 5, 3) };
  const a = f.api.contact(hit, 'melee'); hit.cell.x = 4;
  const b = f.api.contact(hit, 'melee'); hit.cell.x = 9;
  await Promise.all([a, b]); assert.deepEqual(f.writes.map(w => w.x), [2, 4]); assert.equal(f.world.pending, null);
});
test('ordinary contacts wait for a foreign owner then rebase frozen world coordinates', async () => {
  for (const source of ['melee', 'ballistic']) {
    const f = fixture(), foreign = deferred(), calls = []; f.world.pending = foreign.promise;
    assert.equal(beforeControlContact(f.sim, { id: E.METAL, cell: new Vector3(5, 5, 3) }, source,
      shift => calls.push(shift.toArray())), true);
    await tick(); assert.equal(f.world.pending, foreign.promise); assert.equal(calls.length, 0);
    f.sim.origin.x++; f.world.pending = null; foreign.resolve(); await f.api.settle();
    assert.deepEqual(calls, [[-1, 0, 0]]); assert.equal(f.writes.length, 0); assert.equal(f.world.pending, null);
  }
});
test('foreign queued contacts cancel on scene change, authority loss or reset', async () => {
  for (const change of [f => { f.world.historyIdentity = {}; }, f => f.authority(false), f => f.api.reset()]) {
    const f = fixture(), foreign = deferred(); let calls = 0; f.world.pending = foreign.promise;
    beforeControlContact(f.sim, { id: E.METAL, cell: new Vector3(2, 5, 3) }, 'ballistic', () => calls++);
    await tick(); change(f); f.world.pending = null; foreign.resolve(); await f.api.settle(); assert.equal(calls, 0);
  }
});
test('ordinary unblocked contacts retain the immediate existing path', () => {
  const f = fixture();
  assert.equal(beforeControlContact(f.sim, { id: E.METAL, cell: new Vector3(2, 5, 3) }, 'melee', () => {}), false);
});
test('caller instance authority is rechecked after the asynchronous ray', async () => {
  const f = fixture(), wait = deferred(); let current = true; f.pick(() => wait.promise);
  const job = f.api.useRay(f.eye, f.dir, { authority: () => current }); await tick(); current = false;
  wait.resolve({ valid: true, id: E.BUTTON, cell: new Vector3(2, 5, 3) });
  assert.equal((await job).ok, false); assert.equal(f.writes.length, 0);
});
