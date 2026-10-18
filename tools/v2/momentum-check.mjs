// CPU-only: what writes velocity or pressure, or throws matter, does it natively under V2.
// Drives the real PhysicsV2 owner, the real native transfer and force drivers and the real
// POV routing over a fake GPU, as tools/v2/industry-native-check.mjs does; the generated WGSL
// is validated with Naga. No browser, no GPU.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { cellSlot, marksLayout } from '../../src/shaders/common.js';
import { nativeTransferWGSL, NATIVE_TRANSFER_LAYOUT } from '../../src/shaders/v2/transfer.js';
import { nativeForceCommitWGSL, NATIVE_LAUNCH_MODE } from '../../src/v2/nativeForcing.js';
import { nativeWeatherParams, nativeWeatherEvaluateWGSL } from '../../src/v2/nativeWeather.js';
import { flushNativeLaunch } from '../../src/v2/interactions.js';
import { povGpu } from '../../src/pov/gpu.js';
import { toStepVelocity } from '../../src/pov/tools/transfer.js';
import { blowWGSL, BlowParams, flameWGSL, FlameParams, axeFrag, flamerFrag } from '../../src/shaders/povTools.js';
import { burrowWGSL, BurrowParams } from '../../src/shaders/povBore.js';
import { wandApplyWGSL, WandParams } from '../../src/shaders/wands.js';
import { TRANSFER_PUT, TRANSFER_TAKE } from '../../src/shaders/transfer.js';
import { NOMINAL_STEP_RATE, PHYS } from '../../src/physics.js';
import { CELL_M } from '../../src/scale.js';
import { E } from '../../src/elements.js';
import { assertNaga } from './wgsl-grouping.mjs';

const g = gridLayout(32, 32, 32), calls = [], allocations = [];
globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100, UNIFORM: 0x40, MAP_READ: 1 };
const buffer = ({ size, ...desc }) => ({ ...desc, size, data: new Uint8Array(size), destroy() {} });
const gpu = {
  testMode: true, L: { EMPTY: [] }, emptyGroup: {}, stats: { flushes: 0 },
  createBuffer: buffer, layout: (name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
  queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); } },
  write(b, at, data) { this.queue.writeBuffer(b, at, data); },
  frame: { copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); },
    clear(b, at = 0, n = b.size - at) { calls.push({ name: 'clear', buffer: b }); b.data.fill(0, at, at + n); } },
  kernel: ({ name, code }) => ({ name, code, state: 'ready', ready: Promise.resolve(),
    dispatch(f, size, opts) { calls.push({ name, size, opts }); } }),
  readback: { buffer: (b, at, n) => Promise.resolve(b.data.slice(at, at + n).buffer) },
  flush() {},
};
const bytes = g.slots * 16;
const sim = Object.assign(Object.create(Simulation.prototype), {
  gpu, g, id: 1, origin: { x: 0, y: 0, z: 0, clone() { return { x: this.x, y: this.y, z: this.z }; } }, cur: 0, version: 0, wholeWrites: 0, frame: 0, paints: 0,
  L: { TABLES: [], STATE_RO: [], STATE_RW: [], UNDO: [], FLOW_SHIFT: [] }, tables: {}, marks: buffer({ size: marksLayout(g).words * 4 }),
  state: { A: buffer({ size: bytes * 2 }), B: buffer({ size: bytes * 2 }), F: buffer({ size: g.slots * 8 }) },
  _bindRO: {}, _bindRW: {}, _bindFlagsRO: {}, _bindAct: {}, history: [], flow: buffer({ size: g.slots * 8 }),
  _shiftListeners: [], _scratchGroups: [], shiftKeepsHistory: true, wake() {}, _retire() {}, stillFlow() {},
  rays: { wake() {}, reset() {}, paint() { return false; }, noteElement() {} },
  passOf: name => gpu.kernel({ name }), passes: { paint: {}, undoShift: gpu.kernel({ name: 'undoShift' }) },
});
const owner = new PhysicsV2(sim); await owner.ready;
owner.aux ??= buffer({ size: g.slots * 4 });
owner.contactReady = true;
const plans = buffer({ size: g.slots * 16 }), particles = buffer({ size: 64 }), air = [buffer({ size: g.nbricks * 32 }), buffer({ size: g.nbricks * 32 })];
owner.dynamics = { isReady: true, isIdle: true, ready: Promise.resolve(), plans, particles, air, airIndex: 0, control: buffer({ size: 64 }),
  _allocate: (tick, params) => allocations.push({ tick, params, at: calls.length }), _externalWork() {}, _work() {},
  deferLaunch: NativeDynamics.prototype.deferLaunch, flushLaunch: NativeDynamics.prototype.flushLaunch,
  advanceParticles() {}, consumeMaterialEvents() {}, advanceAir() {}, readActivity: async () => ({}),
  capabilities: { physicsReady: true, drawReady: true, impulse: true, physgun: true } };
await sim.prepareNative(owner);
owner.sync();
assert.equal(sim.compact, owner, 'the fixture runs on the active V2 owner');
let legacyEdits = 0;
const edit = sim.edit.bind(sim);
sim.edit = (...args) => { legacyEdits++; return edit(...args); };

// ---- 1. A throw: the native put launches what lands at V1's velocity, in m/s.
{
  const at = [4, 8, 4], vel = [0.25, 0.5, 0];
  const water = [E.WATER, 20, 0, 0, E.WATER | (1173 << 8), 0x8000, 0, 0, 0];
  let mark = calls.length; const before = allocations.length;
  const answer = povGpu(sim).transfer({ count: 1, limit: 1, mode: TRANSFER_PUT, kinds: 0, breaks: 0, maxHard: 1e30, only: 0, allow: [], maxTemperature: 1e30,
    guardBase: [0, 0, 0], guardMaterial: -1, guardPort: [0, 0, 0], guardPowered: 0, vel, cells: [[...at, -1]], items: [water] });
  assert(answer, 'the native put is issued');
  const stepped = calls.slice(mark), dispatch = stepped.find(c => c.name === 'nativeTransfer');
  assert(dispatch, 'one native transfer dispatch');
  const bound = dispatch.opts.bind[2].entries.map(e => e.resource.buffer);
  assert.equal(bound.length, NATIVE_TRANSFER_LAYOUT.length, 'every native transfer binding is bound');
  assert.equal(bound[4], plans, 'the put plans its launches in the native dynamics plans');
  assert(stepped.findIndex(c => c.name === 'clear' && c.buffer === plans) < stepped.indexOf(dispatch), 'plans start clear');
  assert.equal(allocations.length, before + 1, 'one native allocation launches the thrown cells');
  assert.equal(allocations.at(-1).params.mode, NATIVE_LAUNCH_MODE, 'bounded forcing: the throw is the absolute velocity');
  assert.equal(allocations.at(-1).at, calls.length, 'the allocation follows the put');
  assert.deepEqual(dispatch.opts.params.vel, vel, "V1's cells/step reach the kernel");
  await answer;
  // The rule in the kernel: a placed cell plans V1's vel × 240 steps/s × CELL_M; a take clears its plan.
  const code = nativeTransferWGSL(g), ms = (NOMINAL_STEP_RATE * CELL_M).toFixed(1);
  assert(new RegExp(`if \\(any\\(P\\.vel != vec3f\\(0\\.0\\)\\)\\) \\{ plans\\[s\\] = TransferPlan\\(P\\.vel \\* ${ms.replace('.', '\\.')},\\s*1u\\); \\}`).test(code), 'a placed cell plans its launch at V1 vel in m/s');
  assert(/\} else \{\s*plans\[s\] = TransferPlan\(vec3f\(0\.0\), 0u\);/.test(code), "a take clears its cells' plans");
  assertNaga(code, 'nativeTransfer');
  // a drop at rest (a spill, a bomb's charge) launches nothing
  mark = calls.length; const still = allocations.length;
  await povGpu(sim).transfer({ count: 1, limit: 1, mode: TRANSFER_PUT, kinds: 0, breaks: 0, maxHard: 1e30, only: 0, allow: [], maxTemperature: 1e30,
    guardBase: [0, 0, 0], guardMaterial: -1, guardPort: [0, 0, 0], guardPowered: 0, vel: [0, 0, 0], cells: [[5, 8, 4, -1]], items: [water] });
  assert.equal(allocations.length, still, 'a put at rest allocates nothing');
  assert(!calls.slice(mark).some(c => c.name === 'clear' && c.buffer === plans), 'nor touches the plans');
  console.log('PASS V2 throw: the native put launches placed cells at V1 vel (cells/step × 240 × CELL_M m/s); takes clear plans');
}

// ---- 2. Throw speeds are V1's: V1's cells/step at V1's step rate, with V1's cap.
{
  const v = new THREE.Vector3(120, 0, 0);
  const v2 = toStepVelocity(v, { sim: { compact: {} }, stepsPerFrame: 1, dt: 1 / 120 });
  const v1 = toStepVelocity(v, { sim: {}, stepsPerFrame: 4, dt: 1 / 60 });
  assert.equal(v2.x, v1.x, 'under V2 the throw is V1 cells/step (120 cells/s → 0.5)');
  assert.equal(v2.x, 120 / NOMINAL_STEP_RATE);
  const fast = toStepVelocity(new THREE.Vector3(1000, 0, 0), { sim: { compact: {} } });
  assert.equal(fast.x, PHYS.V_MAX, "V1's V_MAX caps it at V1's 240 cells/s, not 60");
  console.log('PASS V2 throw speed is V1 cells/step at NOMINAL_STEP_RATE with V1 V_MAX');
}

// ---- 3. POV writers of velocity route to native forcing, never V1's edit.
const blowValues = { ...axeFrag.values, center: [8, 8, 8], dir: [1, 0, 0] };
const box = sim.touchCentres([5, 5, 5], [11, 11, 11]);
{
  for (const [name, values] of [['povBlow', blowValues], ['povFlame', { ...flamerFrag.values, nozzle: [8, 8, 8], dir: [1, 0, 0], reach: 4, dt: 1 / 60, frame: 1 }],
    ['povBurrow', { nose0: [8, 8, 8], nose1: [9, 8, 8], cut: 1, pathN: 0, dir: [1, 0, 0], lo: [5, 5, 5], hi: [11, 11, 11], path: [] }],
    ['povWand', { lo: [5, 5, 5], hi: [11, 11, 11], count: 0, commands: [] }]]) {
    const mark = calls.length; legacyEdits = 0;
    assert.equal(povGpu(sim).edit(name, box, values), true, `${name}: accepted natively`);
    const names = calls.slice(mark).map(c => c.name);
    assert.equal(legacyEdits, 0, `${name}: no V1 edit under V2`);
    assert(names.includes(`${name}ForceEvaluate`) && names.includes(`${name}ForcePlan`) && names.includes(`${name}ForceAir`), `${name}: V1's rule evaluated and committed natively`);
    assert(!names.includes(name), `${name}: the V1 edit kernel is not dispatched`);
    flushNativeLaunch(sim);
  }
  console.log('PASS V2 povBlow/povFlame/povBurrow/povWand route to native forcing (no V1 edit, no import)');
}

// ---- 4. The melee blow holds its launches for the gather's take, then flies what is left.
{
  const before = allocations.length;
  assert.equal(povGpu(sim).edit('povBlow', box, blowValues), true);
  assert.equal(allocations.length, before, 'the blow leaves its chips planned for the take');
  // the take that gathers the debris clears the plans of what it takes, and keeps the launch pending
  await povGpu(sim).transfer({ count: 1, limit: 1, mode: TRANSFER_TAKE, kinds: 1 << 1, breaks: 0, maxHard: 1e30, only: 0, allow: [], maxTemperature: 1e30,
    guardBase: [0, 0, 0], guardMaterial: -1, guardPort: [0, 0, 0], guardPowered: 0, vel: [0, 0, 0], cells: [[8, 8, 8, -1]], items: [] });
  assert.equal(allocations.length, before, 'the take does not allocate the blow\'s launches');
  assert.equal(flushNativeLaunch(sim), true, 'the melee tool flushes after its gather');
  assert.equal(allocations.length, before + 1);
  assert.equal(allocations.at(-1).params.mode, NATIVE_LAUNCH_MODE);
  assert.equal(flushNativeLaunch(sim), false, 'once');
  // a tick flushes a launch nobody flushed
  povGpu(sim).edit('povBlow', box, blowValues);
  owner.ticks(1);
  assert.equal(allocations.length, before + 2, 'the next tick allocates a held launch first');
  console.log('PASS V2 melee: the blow renames at once, its take clears taken plans, the rest launch after it');
}

// ---- 5. The commit rules, generated and validated: fracture at once (blow), new cells (flame, wand).
{
  const params = (P) => nativeWeatherParams('check', { params: { ...Object.fromEntries(P.fields.map(f => [f.name, f.type])), origin: 'vec3i' } });
  const rename = nativeForceCommitWGSL(g, params(BlowParams), 'plan', { renameNow: true });
  assert(/broken=withEnergy\(broken,energyOf\(before\)\);storeMaterial\(s,before,broken\)/.test(rename), 'renameNow: the fracture is energy-exact and stored in the plan stage');
  assert(/if\(r\.motion\.w!=0\.0\) \{ plans\[s\]=ForcePlan\(r\.motion\.xyz\*72(\.0)?,1u\); \}/.test(rename), 'renameNow: only the launch is planned (no apply rename)');
  const made = nativeForceCommitWGSL(g, params(FlameParams), 'plan', { sources: true });
  assert(/var m=makeMaterial\(made,r\.after\.y,FULLU,/.test(made), "sources: a new element is a new cell at V1's temperature");
  assert(/m\.core=withLife\(m\.core,r\.after\.z\)/.test(made), "sources: with V1's life");
  const plain = nativeForceCommitWGSL(g, params(BlowParams), 'plan');
  assert(!/var m=makeMaterial\(made|broken=withEnergy/.test(plain), 'the default (kick, strike) keeps the fracture at apply');
  for (const [label, update, P, commit] of [['blow', blowWGSL, BlowParams, { renameNow: true }], ['flame', flameWGSL, FlameParams, { sources: true }],
    ['burrow', burrowWGSL, BurrowParams, {}], ['wand', wandApplyWGSL, WandParams, { sources: true }]]) {
    const p = params(P);
    for (const stage of ['plan', 'particles']) assertNaga(nativeForceCommitWGSL(g, p, stage, commit), `${label} ${stage}`);
    assertNaga(nativeWeatherEvaluateWGSL(g, { update, nativeForcing: true }, p), `${label} evaluate`);
  }
  console.log('PASS V2 force commit rules generate and validate (Naga): fracture-now, new-source, default');
}

console.log('momentum-check: all passed');
