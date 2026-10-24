// CPU checks for co-op under Physics V2 (src/net/codec.js): the native kernels validate with naga at
// several grid sizes, and the native section's framing rejects what it must (a newer build's section
// fails as "update", never as a keyframe loop). node tools/v2/net-native-check.mjs
import assert from 'node:assert/strict';
import { assertNaga } from './wgsl-grouping.mjs';
import * as codec from '../../src/net/codec.js';
import { gridLayout } from '../../src/sim.js';
import { PARTICLE_CAP } from '../../src/v2/dynamics-reference.js';

const v2 = await codec.nativeCodecParts();
for (const dims of [[64, 64, 64], [128, 128, 128], [160, 96, 160]]) {
  const g = gridLayout(...dims), parts = { helpers: v2.helpers, importA: v2.importA(g) };
  assertNaga(codec.packNativeFrag(g, parts), `packNative ${dims}`);
  assertNaga(codec.unpackNativeFrag(g, parts), `unpackNative ${dims}`);
  assertNaga(codec.nativeRecordsFrag(g), `nativeRecords ${dims}`);
}
assertNaga(codec.packParticlesFrag(PARTICLE_CAP), 'packParticles');
// the guest reads back the pack's own importA (the import kernel's text: leave.js importAWGSL)
assert.ok(codec.unpackNativeFrag(gridLayout(64, 64, 64), { helpers: v2.helpers, importA: v2.importA(gridLayout(64, 64, 64)) }).includes('fn importA(a: vec4f) -> vec4u'));
console.log('ok native codec WGSL (naga): packNative, unpackNative, nativeRecords, packParticles');

const dims = [64, 64, 64], slots = dims.reduce((a, b) => a * b, 1);
const texels = new Uint8Array(4 * slots);
const record = (slot) => [slot, 1, 2, 3, 4, 5];
const flying = (slot) => [slot, ...new Array(12).fill(0)];
const frame = (section, kind = codec.FRAME_NATIVE_KEY) => codec.encodeFrame(kind, 1, dims, texels, null, section);
const round = await codec.decodeFrame(await frame(codec.nativeSection({ records: new Uint32Array(record(7)), particles: new Uint32Array(flying(9)) })));
assert.deepEqual([...round.native.records], record(7)); assert.equal(round.native.particles[0], 9); assert.equal(round.body.length, texels.length);
// legacy kinds carry no section; a section on them is a body-length error, not a silent extra
assert.equal((await codec.decodeFrame(await codec.encodeFrame(codec.FRAME_KEY, 1, dims, texels))).native, null);
await assert.rejects(async () => codec.decodeFrame(await codec.encodeFrame(codec.FRAME_KEY, 1, dims, texels, null, codec.nativeSection({ records: new Uint32Array(0), particles: new Uint32Array(0) }))), /oversized/);
// a record outside the grid, flying matter outside any pool, a lying count: refused
await assert.rejects(async () => codec.decodeFrame(await frame(codec.nativeSection({ records: new Uint32Array(record(slots)), particles: new Uint32Array(0) }))), /outside the grid/);
await assert.rejects(async () => codec.decodeFrame(await frame(codec.nativeSection({ records: new Uint32Array(0), particles: new Uint32Array(flying(1 << 16)) }))), /outside the pool/);
const lying = codec.nativeSection({ records: new Uint32Array(record(1)), particles: new Uint32Array(0) }); new Uint32Array(lying.buffer)[1] = 2;
await assert.rejects(async () => codec.decodeFrame(await frame(lying)), /section size/);
assert.throws(() => codec.nativeSection({ records: new Uint32Array(5), particles: new Uint32Array(0) }), /section size/);
// a newer build's section or frame kind: NewerFrameError (multiplayer.js ends with "update", no key loop)
const newer = codec.nativeSection({ records: new Uint32Array(0), particles: new Uint32Array(0) }); new Uint32Array(newer.buffer)[0] = 2;
await assert.rejects(async () => codec.decodeFrame(await frame(newer)), (e) => e.newer === true);
const unknown = (await frame(codec.nativeSection({ records: new Uint32Array(0), particles: new Uint32Array(0) }))).slice(0);
new Uint32Array(unknown, 0, 1)[0] = codec.FRAME_NATIVE_DELTA + 1;
await assert.rejects(codec.decodeFrame(unknown), (e) => e.newer === true);
// the outdated frame is a legacy keyframe a shipped build decodes (seq OUTDATED_SEQ, a box no map has)
const old = await codec.decodeFrame(await codec.outdatedFrame());
assert.equal(old.kind, codec.FRAME_KEY); assert.equal(old.seq, codec.OUTDATED_SEQ); assert.deepEqual(old.dims, [16, 16, 16]);
assert.ok(codec.sameSection(codec.nativeSection({ records: new Uint32Array(record(3)), particles: new Uint32Array(0) }), codec.nativeSection({ records: new Uint32Array(record(3)), particles: new Uint32Array(0) })));
assert.ok(!codec.sameSection(codec.nativeSection({ records: new Uint32Array(record(3)), particles: new Uint32Array(0) }), codec.nativeSection({ records: new Uint32Array(record(4)), particles: new Uint32Array(0) })));
console.log('ok native section: round trip, bounds, lying counts, newer builds fail as updates, outdated frame decodes as a shipped keyframe');

// C1, the app's own session wiring (src/app.js, its source run against stubs, as scripts/check-terrain-edits.mjs
// runs its writer gate): a grid built while guesting gets its native owner, a replica keeps that owner
// presenting without ticking, and once the session ends the box is V2's to step.
{
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
  const slice = (from, to) => { const a = app.indexOf(from); const b = app.indexOf(to, a); assert.ok(a >= 0 && b > a, `app.js: ${from}`); return app.slice(a, b); };
  const construct = slice('  sim = new Simulation(gpu, nx, ny, nz,', '  derived = mapKind.boxDerived ? new Derived(sim) : null;');
  const built = new Function('physicsModeArg', 'mp', `
    let physicsMode = physicsModeArg, physicsV2 = null, sim = null, worldMode = null, mapKind = { streamed: false }; const gpu = {}, nx = 64, ny = 64, nz = 64, made = [];
    class Simulation { constructor(...a) { this.opts = a[4]; this.prepareNative = () => Promise.resolve(); } }
    const V2mod = { PhysicsV2: class { constructor(s) { made.push(s); } }, options: {} }, wakeLoop = () => {};
    ${construct}
    return { owner: physicsV2 };`);
  for (const mp of [{ isGuest: true, replica: true }, { isGuest: false, replica: false }]) {
    const r = built('v2', mp);
    assert.ok(r.owner, `a V2 grid built ${mp.isGuest ? 'while guesting' : 'solo'} gets its native owner`);
  }
  const gate = slice('function v2Box()', '  function v2Status()');
  const activate = slice('  if (physicsV2?.isReady) {', '  const stepping =');
  const frame = new Function('physicsMode', 'mp', 'log', `
    const settings = { paused: false }, HOST_HZ = 60; let v2Running = true;
    const physicsV2 = { isReady: true, activate: () => log.push('activate'), suspend: () => log.push('suspend') };
    ${gate}
    ${activate}
    return { v2Box: v2Box(), steps: v2Replica() ? replicaToolSteps(1 / 60, 1) : null };`);
  const log = [];
  let r = frame('v2', { replica: true }, log);
  assert.deepEqual(log, ['activate'], 'a V2 replica keeps its owner presenting (the frames are its cells)');
  assert.equal(r.v2Box, false, '...and never ticks it');
  assert.equal(r.steps, 1, 'its tools\' clocks run on game time (a tick a 60 Hz frame)');
  log.length = 0; r = frame('v2', { replica: false }, log);
  assert.deepEqual(log, ['activate']); assert.equal(r.v2Box, true, 'the session over, the box is V2\'s to step');
}
console.log('ok app session wiring (src/app.js run against stubs): guests\' grids get their owner, replicas present it unticked, the session\'s end steps it');
