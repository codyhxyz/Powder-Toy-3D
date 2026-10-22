// CPU-only: Factory machines under V2. Drives the REAL machine driver
// (src/industry/physics.js) on the real PhysicsV2 owner over a fake GPU, as
// tools/v2/integration-check.mjs does. The native transfer reference below is
// an independent CPU specification of src/shaders/v2/transfer.js (select and
// rank on the pre-transfer state). No browser, no GPU.
import assert from 'node:assert/strict';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { cellSlot, marksLayout, editKernelWGSL } from '../../src/shaders/common.js';
import { createIndustryPhysics, machineBox, machinePorts } from '../../src/industry/physics.js';
import { deviceCell, deviceDirection, baseMaterial, FILTER_IDS } from '../../src/industry/catalog.js';
import { INDUSTRY_KIND, INDUSTRY_EDIT } from '../../src/shaders/industry.js';
import { NativeIndustry, MACHINE_SPEED_SI, MACHINE_CARRY_SI, DECK_SLIDE_TICKS, v1DeckCells, v1DeckKeep, deckSlideSI, industryMotionWGSL, nativeIndustryEvaluateWGSL, nativeIndustryPlanWGSL, nativeIndustryParams } from '../../src/v2/industry.js';
import { LAUNCH_MODE, PLAN } from '../../src/shaders/v2/blasts.js';
import { NOMINAL_STEP_RATE } from '../../src/physics.js';
import { nativeForceCommitWGSL } from '../../src/v2/nativeForcing.js';
import { nativeWeatherParams } from '../../src/v2/nativeWeather.js';
import { kickWGSL, KickParams } from '../../src/shaders/povKick.js';
import { gateWGSL, GATE_OWNER_MARKER, GATE_OWNER_MARKER_NATIVE, NATIVE_GATE, createGatePhysics, gateBodyWGSL } from '../../src/industry/gates.js';
import { createFactoryControlParts, NATIVE_CONTROL_PARTS } from '../../src/industry/controlParts.js';
import { NATIVE_CONSTRUCTION } from '../../src/industry/construction.js';
import { nativeWriterParams, nativeWriterEvaluateWGSL, nativeWriterFlyingWGSL, nativeWriterCommitWGSL, WRITER_SHARED_PARAMS } from '../../src/v2/industry.js';
import { constructionWGSL, PUMP_BACKPLATE_TAG_NATIVE } from '../../src/industry/construction.js';
import { PUMP_BACKPLATE_TAG } from '../../src/industry/pumpStructure.js';
import { nativeReadiness, HOST_HZ, LEGACY_STEP_HZ, LEGACY_STEPS_PER_TICK } from '../../src/v2/host.js';
import { nativeLife } from '../../src/v2/layout.js';
import { GRAVITY } from '../../src/v2/dynamics-reference.js';
import { SIM_GRAVITY } from '../../src/physics.js';
import { CELL_M } from '../../src/scale.js';
import { E, K, ELEMENTS } from '../../src/elements.js';
import { assertNaga } from './wgsl-grouping.mjs';

const g = gridLayout(32, 32, 32), calls = [], allocations = [], marks = [];
globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100, UNIFORM: 0x40, MAP_READ: 1 };
const buffer = ({ size, ...desc }) => ({ ...desc, size, data: new Uint8Array(size), destroy() {} });
const words = b => new Uint32Array(b.data.buffer);
const inside = p => p.every((v, i) => v >= 0 && v < [g.nx, g.ny, g.nz][i]);
const slot = p => cellSlot(g, ...p);
function referenceDispatch(name, opts) {
  if (name !== 'nativeTransfer') return;
  const [core, bank, result, items] = opts.bind[2].entries.map(e => e.resource.buffer).map(words), p = opts.params;
  const f = new Float32Array(result.buffer), candidates = [];
  for (let i = 0; i < p.count; i++) {
    f[i * 9] = -1;
    const at = p.cells[i].slice(0, 3);
    if (!inside(at)) continue;
    const s = slot(at), id = core[s * 4] & 255, kind = ELEMENTS[id].kind, fill = core[s * 4 + 1] & 0xffffff;
    const occupied = id !== 0 && (kind !== K.LIQUID || fill > 0);
    if (p.mode === 1) { if (!occupied) candidates.push({ i, s }); continue; }
    const T = ((core[s * 4] >>> 8) & 65535) / 4 - 273.25;
    if (!occupied || T > p.maxTemperature || !(p.kinds & (1 << kind))) continue;
    if (p.cells[i][3] >= 0 && p.cells[i][3] !== id) continue;
    candidates.push({ i, s, id, T });
  }
  candidates.slice(0, p.limit).forEach(({ i, s, id, T }, rank) => {
    if (p.mode === 1) {
      f[i * 9] = rank;
      assert.equal(items[rank * 8 + 5], 1, 'V2 cargo is placed exactly, never re-encoded from the legacy view');
      core.set(items.subarray(rank * 8, rank * 8 + 4), s * 4); bank[s] = items[rank * 8 + 4];
    } else {
      f.set([id, T, 0, core[s * 4 + 1] >>> 24], i * 9);
      result.set(core.subarray(s * 4, s * 4 + 4), i * 9 + 4); result[i * 9 + 8] = bank[s];
      core.set([1173 << 8, 0, 0, 0], s * 4); bank[s] = 0;
    }
  });
}
const gpu = {
  testMode: true, L: { EMPTY: [] }, emptyGroup: {}, stats: { flushes: 0 },
  createBuffer: buffer, layout: (name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
  queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); } },
  write(b, at, data) { this.queue.writeBuffer(b, at, data); },
  frame: { copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); },
    clear(b, at = 0, n = b.size - at) { calls.push({ name: 'clear', buffer: b }); b.data.fill(0, at, at + n); } },
  kernel: ({ name }) => ({ name, state: 'ready', ready: Promise.resolve(),
    dispatch(f, size, opts) { calls.push({ name, size, opts }); referenceDispatch(name, opts); } }),
  readback: { buffer: (b, at, n) => Promise.resolve(b.data.slice(at, at + n).buffer),
    ring: (name, bytes) => { const ring = buffer({ size: 16 * bytes }); let n = 0;
      return { buffer: ring, next: () => n++ % 16, read: s => Promise.resolve(ring.data.slice(s * bytes, (s + 1) * bytes).buffer) }; } },
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
owner.dynamics = { isReady: true, isIdle: true, ready: Promise.resolve(), plans, particles, air, airIndex: 0,
  // A Factory batch launches over its machines' bricks (dynamics.js markLaunch, allocateLaunch),
  // never the whole-grid allocation.
  _allocate() { throw new Error('a Factory batch never runs the whole-grid allocation'); },
  markLaunch: (tick, lo, hi) => { marks.push({ tick, lo, hi, at: calls.length }); },
  allocateLaunch: tick => allocations.push({ tick, params: { mode: LAUNCH_MODE }, at: calls.length }), _externalWork() {},
  advanceParticles() {}, consumeMaterialEvents() {}, advanceAir() {}, readActivity: async () => ({}),
  capabilities: { physicsReady: true, drawReady: true, impulse: true } };
await sim.prepareNative(owner);
owner.sync();
assert.equal(sim.compact, owner, 'the fixture runs on the active V2 owner');
assert.equal(nativeReadiness(sim).ready, true, 'V2 is ready with no Factory exception');

// Every legacy boundary is watched: a machine under V2 must not export the
// projection, write legacy B, or ask for a legacy edit.
let legacyExports = 0, legacyEdits = 0;
const legacyState = sim.legacyState.bind(sim), edit = sim.edit.bind(sim);
sim.legacyState = native => { legacyExports++; return legacyState(native); };
sim.edit = (...args) => { legacyEdits++; return edit(...args); };

const core = words(owner.cells), bank = words(owner.aux);
const water = (fill, bankValue) => ({ core: [E.WATER | (1173 << 8), fill | (3 << 24), 0x3c003c00, 0x00010000], bank: bankValue >>> 0 });
const put = (p, m) => { core.set(m.core, slot(p) * 4); bank[slot(p)] = m.bank; };
const machines = [
  { id: 'belt', type: 'belt', x: 0, y: 4, z: 0, rotation: 1 },
  { id: 'sorter', type: 'separator', x: 4, y: 4, z: 0, rotation: 2, filter: E.SAND },
  { id: 'lift', type: 'lift', x: 8, y: 4, z: 0, rotation: 0 },
  { id: 'miner', type: 'miner', x: 12, y: 4, z: 0, rotation: 0 },
  { id: 'furnace', type: 'heater', x: 0, y: 4, z: 16, rotation: 3 },
  { id: 'hearth', type: 'hearth', x: 8, y: 4, z: 16, rotation: 0 },
  { id: 'pump', type: 'pump', x: 20, y: 4, z: 8, rotation: 0 },
];
const errors = [], physics = createIndustryPhysics({ getSim: () => sim, onError: e => errors.push(e) });
await physics.ready;
const inlet = machinePorts(machines.find(d => d.type === 'pump')).inlet;
const cargo = water(0x6000, 0x89abcdef);   // a part-full cell with a heat bank: both must survive the trip
put(inlet[0], cargo);

const native = calls => calls.filter(c => c.name.startsWith('industryNative'));
// One app frame of one tick (app.js nativeHostTick: the tick, then industry.nativeStep; then the frame's update)
const tick = (n = 1) => { for (let i = 0; i < n; i++) { sim.frame++; sim.nativeTicks = (sim.nativeTicks ?? 0) + 1; physics.nativeStep(machines); } };
let mark = calls.length;
tick(); physics.step(1 / 60, machines);
const stepped = calls.slice(mark);
assert.equal(legacyEdits, 0, 'no V1 edit kernel runs on V2');
assert.equal(legacyExports, 0, 'no legacy projection is exported for machine transport');
assert(!stepped.some(c => c.name === 'industry' || c.name === 'industry apply'), 'the V1 industry edit kernel is never dispatched under V2');
const moving = machines.filter(d => !['pump', 'hearth'].includes(d.type));
const DECKS = ['belt', 'separator', 'lift', 'miner'];
// (the hearth's draft, on the tick, and its guidance, on the frame, are its own: checked below)
const hearthKind = c => [INDUSTRY_KIND.hearth, INDUSTRY_KIND.hearthHeat].includes(c.opts.params.kind);
const evaluates = stepped.filter(c => c.name === 'industryNativeEvaluate' && !hearthKind(c)), commits = stepped.filter(c => c.name === 'industryNativePlan' && !hearthKind(c));
assert.equal(evaluates.length, moving.length, 'one native evaluation per transport machine');
assert.equal(commits.length, moving.length, 'one native commit per transport machine');
// (dispatch priority rotates between frames, as V1's does; match machines by their box)
moving.forEach(d => {
  const box = machineBox(d), forward = deviceDirection(d);
  const i = evaluates.findIndex(c => c.opts.params.editLo.join() === box.lo.join() && c.opts.params.editHi.join() === box.hi.join());
  assert(i >= 0, `${d.id}: evaluated natively`);
  const p = evaluates[i].opts.params;
  assert.deepEqual(p.editLo, box.lo, `${d.id}: V1's machine box`); assert.deepEqual(p.editHi, box.hi);
  assert.equal(p.kind, INDUSTRY_KIND[d.type], `${d.id}: V1's rule`);
  assert.deepEqual(p.corner, deviceCell(d, 0, 0, 0)); assert.deepEqual(p.forward, forward); assert.deepEqual(p.right, [forward[2], 0, -forward[0]]);
  assert.deepEqual(p.guardBase, [d.x, d.y, d.z]); assert.equal(p.guardMaterial, baseMaterial(d.type));
  assert.equal(p.selectedId, FILTER_IDS.includes(d.filter) ? d.filter : E.NUGGETS);
  assert.equal(p.dt, DECKS.includes(d.type) ? 0 : 1 / 60, `${d.id}: a deck carries on the tick, a furnace heats on the frame's wall time`);
  assert.equal(p.drill, 0, 'the miner drills on its 0.35 s pulse, not every frame');
  assert.equal(p.carrySteps, 4, "V1's steps a frame at Speed 1");
  assert.equal(evaluates[i].opts.header.format, 3, `${d.id}: evaluates the canonical native core (physical read)`);
  assert.deepEqual(commits[i].opts.params, p, 'the commit sees the same machine');
});
// Evaluate then commit, machine by machine, so each sees what the last committed.
assert.deepEqual(native(stepped).filter(c => !hearthKind(c)).map(c => c.name), moving.flatMap(() => ['industryNativeEvaluate', 'industryNativePlan']));
assert(!stepped.some(c => c.name === 'clear' && c.buffer === plans), 'no whole-grid plan clear: the launch list clears the bricks it lists');
// Each box lists its bricks after its evaluation and before its plans, with its own box.
const stepStart = calls.length - stepped.length, batchMarks = marks.filter(m => m.at >= stepStart && !hearthKind(calls[m.at]));
assert.equal(batchMarks.length, moving.length, 'one launch mark per transport machine');
batchMarks.forEach(m => {
  const i = m.at - stepStart, before = stepped[i - 1], after = stepped[i];
  assert.equal(before.name, 'industryNativeEvaluate'); assert.equal(after.name, 'industryNativePlan');
  assert.deepEqual(m.lo, before.opts.params.editLo, 'the mark is the evaluated box'); assert.deepEqual(m.hi, before.opts.params.editHi);
});
assert.equal(allocations.length, 2, 'one native allocation for the tick\'s decks, one for the frame\'s furnace');
assert(allocations.every(a => a.params.mode === LAUNCH_MODE), 'bounded-forcing launches over the launch list carry absolute velocity and the whole cell');
assert.equal(allocations[1].at, calls.length, 'the allocation follows the last commit');
console.log(`PASS V2 step: ${moving.length} transport machines evaluate and commit natively, no legacy edit/export`);

// M7: the decks carry once a native tick, whatever the frames. A frame of three ticks (30 fps at Speed 1.5,
// Speed 3 at 60 fps) carries three times; a frame of none (a 120 Hz display) carries nothing more.
{
  const decks = cs => cs.filter(c => c.name === 'industryNativeEvaluate' && DECKS.includes(moving.find(d => machineBox(d).lo.join() === c.opts.params.editLo.join())?.type));
  mark = calls.length; tick(3); physics.step(3 / 60, machines);
  assert.equal(decks(calls.slice(mark)).length, 3 * 4, 'three ticks: three passes of the four decks');
  mark = calls.length; physics.step(1 / 120, machines);
  assert.equal(decks(calls.slice(mark)).length, 0, 'a frame that ran no tick carries nothing');
  console.log('PASS V2 decks carry once a native tick, never once a presentation frame');
}

// Drill pulses at V1's 0.35 s.
mark = calls.length;
for (let i = 0; i < 21; i++) physics.step(1 / 60, machines);
const pulses = calls.slice(mark).filter(c => c.name === 'industryNativeEvaluate' && c.opts.params.kind === INDUSTRY_KIND.miner);
assert.deepEqual(pulses.map(c => c.opts.params.drill).filter(Boolean).length, 1, 'one drill pulse in 0.35 s');
assert.equal(legacyEdits + legacyExports, 0);
console.log('PASS miner drill cadence is V1\'s 0.35 s under V2');

// The pump carries real V2 liquid: fill, flux and heat bank arrive intact.
const outlet = machinePorts(machines.find(d => d.type === 'pump')).outlet;
for (let i = 0; i < 40 && !outlet.some(p => (core[slot(p) * 4] & 255) === E.WATER); i++) {
  physics.step(1 / 60, machines); await new Promise(r => setTimeout(r, 0));
}
const landed = outlet.find(p => (core[slot(p) * 4] & 255) === E.WATER);
assert(landed, 'the pump moved the liquid to its outlet under V2');
assert.deepEqual([...core.subarray(slot(landed) * 4, slot(landed) * 4 + 4)], cargo.core, 'fill, ctype, flux and payload are exact');
assert.equal(bank[slot(landed)], cargo.bank, 'the heat bank is exact');
assert.equal(core[slot(inlet[0]) * 4] & 255, 0, 'the inlet gave the cell up');
assert.equal(physics.buffered, 0);
console.log('PASS V2 pump carries a part-full liquid cell inlet → outlet with fill and heat bank exact');

// Hearth draft: per native tick, real seconds (1/HOST_HZ), heat/life only (no launch).
const hearth = machines.find(d => d.type === 'hearth');
mark = calls.length; const before = allocations.length;
// (a native host tick advances sim.frame and nativeTicks together: v2/host.js nativeHostTick)
sim.frame += 2; sim.nativeTicks = (sim.nativeTicks ?? 0) + 2; physics.nativeStep([hearth]);   // (the decks' own pass: above)
const draft = calls.slice(mark).filter(c => c.name === 'industryNativeEvaluate');
assert.equal(draft.length, 1);
assert.equal(draft[0].opts.params.kind, INDUSTRY_KIND.hearthHeat);
assert.equal(draft[0].opts.params.dt, 2 / HOST_HZ, 'two native ticks are 2/60 s of paid draft');
assert.deepEqual(draft[0].opts.params.corner, deviceCell(hearth, 0, 0, 0));
assert.equal(allocations.length, before, 'heat and fuel commits launch nothing');
assert(!calls.slice(mark).some(c => c.name === 'clear' && c.buffer === plans), 'a heat-only batch leaves plans alone');
assert.equal(marks.filter(m => m.at >= mark).length, 0, 'and lists nothing to launch');
console.log('PASS V2 hearth draft runs per native tick in real seconds without a launch');
// The draft's seconds are game time (v2/host.js stepClock), so a span holding both engines' steps is right:
// four V1 steps nothing drafted after (a console sim.step under V1), a switch back, one native tick.
// On raw sim.frame those five counts all read as native ticks: 5/60 s, not 2/60.
{
  sim.compact = null; sim.frame += 4;            // V1: one a step (sim.js step)
  sim.compact = owner; sim.frame += 1; sim.nativeTicks += 1;
  mark = calls.length; physics.nativeStep([hearth]);
  const span = calls.slice(mark).filter(c => c.name === 'industryNativeEvaluate');
  assert.equal(span.length, 1);
  assert.equal(span[0].opts.params.dt, (4 + LEGACY_STEPS_PER_TICK) / LEGACY_STEP_HZ, 'four V1 steps and a tick are 2/60 s of draft');
  console.log('PASS hearth draft across a runtime switch counts game time, not raw sim.frame');
}

// Saves under V2: machine state is registrations and cargo; native cargo validates.
const snapshot = physics.toJSON();
physics.fromJSON(snapshot, machines);
assert.deepEqual(physics.toJSON(), snapshot);
assert.equal(errors.length, 0, errors.map(String).join('\n'));

// V1 is untouched: the same driver issues the V1 edit kernel, never a native batch.
owner.suspend?.(); sim.compact = null;
mark = calls.length; legacyEdits = 0;
physics.step(1 / 60, machines.filter(d => d.type === 'belt'));
assert.equal(legacyEdits, 1, 'V1 still edits through its own kernel');
assert.equal(native(calls.slice(mark)).length, 0, 'V1 never runs the native batch');
sim.compact = owner;
console.log('PASS V1 machine path unchanged (one V1 edit, no native batch)');

// The native modules: V1 rules, V2 commits, valid WGSL.
const params = nativeIndustryParams();
const evaluate = nativeIndustryEvaluateWGSL(g, params), plan = nativeIndustryPlanWGSL(g, params);
assert(evaluate.includes(INDUSTRY_EDIT.update) && evaluate.includes(INDUSTRY_EDIT.decls), "V1's machine rules run verbatim");
assert(!/\bownLegacy\(slotOf/.test(evaluate), 'evaluation claims no legacy ownership');
assert(plan.includes('plans[s]=ForcePlan(industryVelocity(p,id,r.motion.xyz),flags)'), "motion converts by what it is: a deck's carry or a throw");
assert(plan.includes(`if((flags&1u)!=0u && industryCarries(p)) { flags|=${PLAN.SLIDE}u; }`), "a deck's carry leaves from its contact with the deck");
const wgslF = n => (Number.isInteger(n) ? `${n}.0` : String(n));
assert(industryMotionWGSL.includes(`return motion * ${wgslF(MACHINE_SPEED_SI)}; }`), 'a throw keeps V1\'s trajectory in cells');
// under V1's pull (v2/gravity.js) a throw's map is V1's cells/s too: one speed keeps both
assert.equal(MACHINE_SPEED_SI, MACHINE_CARRY_SI);
assert(industryMotionWGSL.includes(`flat = motion.xz / along * (industryDeckCells(id, along) * ${wgslF(MACHINE_CARRY_SI * DECK_SLIDE_TICKS)}); }`)
  && industryMotionWGSL.includes(`return vec3f(flat.x, motion.y * ${wgslF(MACHINE_SPEED_SI)}, flat.y);`),
  "a carry moves at V1's game-time speed along the deck (v1DeckCells); its vertical part is a throw's");
// M7: V1's deck speed in game time, against V1 itself on the GPU (tools/v2/industry-belt-browser-check.mjs,
// 2026-10-22: nuggets on a belt line, 58 cells/s at Speed 1, 25 at Speed 3) and a Monte Carlo of V1's rules
// (move.js: a cell's chance |v| from its Margolus block's near side; react.js: drag, then friction).
{
  const keep = v1DeckKeep(ELEMENTS[E.NUGGETS]), perSecond = steps => v1DeckCells(keep, 0.6, steps) * NOMINAL_STEP_RATE;
  for (const [steps, gpu] of [[4, 58], [12, 25]]) assert(Math.abs(perSecond(steps) / gpu - 1) < 0.08, `Speed ${steps / 4}: ${perSecond(steps).toFixed(1)} cells/s, V1's ${gpu}`);
  let seed = 7; const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const carlo = steps => { let x = 0, u = 0.6, frame = 0; for (let f = 0; f < 4000; f++) { for (let k = 0; k < steps; k++, frame++) { if (((x - frame) & 1) === 0 && random() < u) x++; u *= keep; } u = 0.6; } return x / (4000 * steps); };
  for (const steps of [1, 2, 4, 12]) assert(Math.abs(carlo(steps) / v1DeckCells(keep, 0.6, steps) - 1) < 0.04, `the chain is V1's rules' mean at ${steps} steps`);
  // and V2 delivers it: a slide is a kick every DECK_SLIDE_TICKS ticks, a tick its speed's cells
  const tickCells = v => v / CELL_M / HOST_HZ / DECK_SLIDE_TICKS;
  assert(Math.abs(tickCells(deckSlideSI(v1DeckCells(keep, 0.6, 4))) - LEGACY_STEPS_PER_TICK * v1DeckCells(keep, 0.6, 4)) < 1e-9, "a tick carries V1's four steps' cells");
  console.log(`PASS V1's belt speed in game time: ${perSecond(4).toFixed(0)} cells/s at Speed 1, ${perSecond(12).toFixed(0)} at Speed 3 (V1 on the GPU: 58, 25)`);
}
assert(evaluate.includes(`/${MACHINE_SPEED_SI}`), 'grain fall state reads in the same unit');
assert(plan.includes('withLife(shaped,r.after.z)') && plan.includes('withCtype(shaped,ct)'), 'fuel life and ctype writes commit natively');
assert(plan.includes('if(flags!=0u) { plans[s]=ForcePlan('), 'boxes share one plan clear');
assert.equal(MACHINE_SPEED_SI, Math.sqrt(GRAVITY * CELL_M / SIM_GRAVITY));
const apex = v => (v * MACHINE_SPEED_SI) ** 2 / (2 * GRAVITY) / CELL_M;
assert(Math.abs(apex(1) - 1 / (2 * SIM_GRAVITY)) < 1e-9, "a lift's grain peaks at V1's 20 cells");
// Which motion is a carry: V1's rule kinds and the miner's deck (z 0..3) against its cut face (z 4..7).
const carries = (kind, rel, forward) => {
  if (kind === INDUSTRY_KIND.belt || kind === INDUSTRY_KIND.separator) return true;
  if (kind !== INDUSTRY_KIND.miner) return false;
  return rel[1] === 1 && rel[0] * forward[0] + rel[1] * forward[1] + rel[2] * forward[2] <= 3;
};
assert(carries(INDUSTRY_KIND.miner, [1, 1, 2], [0, 0, 1]) && !carries(INDUSTRY_KIND.miner, [1, 2, 5], [0, 0, 1]) && !carries(INDUSTRY_KIND.lift, [1, 1, 1], [0, 0, 1]));
assert(industryMotionWGSL.includes(`if (P.kind == ${INDUSTRY_KIND.belt}u || P.kind == ${INDUSTRY_KIND.separator}u) { return true; }`)
  && industryMotionWGSL.includes(`if (P.kind != ${INDUSTRY_KIND.miner}u) { return false; }`)
  && industryMotionWGSL.includes('return rel.y == 1 && dot(vec3f(rel), vec3f(P.forward)) <= 3.0;'), 'the WGSL classifies as this does');
// The POV force kernels keep their text exactly (opt-in options only).
const kick = nativeWeatherParams('povKick', { update: kickWGSL, params: { ...Object.fromEntries(KickParams.fields.map(f => [f.name, f.type])), origin: 'vec3i' } });
assert.equal(nativeForceCommitWGSL(g, kick, 'plan', {}), nativeForceCommitWGSL(g, kick, 'plan'));
assert(!nativeForceCommitWGSL(g, kick, 'plan').includes('withLife(shaped'));
for (const [name, code] of [['industryNativeEvaluate', evaluate], ['industryNativePlan', plan],
  ...[['industryGate', NATIVE_GATE], ['industryConstruction', NATIVE_CONSTRUCTION], ['industryFactoryControlParts', NATIVE_CONTROL_PARTS]]
    .map(([name, spec]) => [`${name}Evaluate`, nativeWriterEvaluateWGSL(g, spec.body(nativeWriterParams(name, spec.fields)), spec)]),
  ['industryWriterFlying', nativeWriterFlyingWGSL(WRITER_SHARED_PARAMS)], ['industryWriterCommit', nativeWriterCommitWGSL(g, WRITER_SHARED_PARAMS)]]) {
  assert.ok([...code.matchAll(/var<storage,/g)].length <= 8, `${name} storage budget`);
  assertNaga(code, name);
}
console.log('PASS native machine modules: V1 rules verbatim, V2 commits, naga-valid');

// Gate shutters and pump backplates keep their ownership tags in V2's payload.
for (const [id, v1, v2] of [[E.WALL, GATE_OWNER_MARKER, GATE_OWNER_MARKER_NATIVE], [E.TUNGSTEN, PUMP_BACKPLATE_TAG, PUMP_BACKPLATE_TAG_NATIVE]]) {
  assert.equal(nativeLife(id, v1), v2, 'a V1 tag imports to exactly the V2 tag');
  assert.equal(nativeLife(id, v2), v2, 'the V2 tag round-trips import/export');
  assert.equal(Math.fround(v2), v2, 'and is an exact f32');
}
assert(gateWGSL(g).includes(`const INDUSTRY_GATE_OWNER_TAG: f32 = ${GATE_OWNER_MARKER}.0;`), 'V1 gate text unchanged');
assert(gateBodyWGSL(GATE_OWNER_MARKER_NATIVE).includes(`const INDUSTRY_GATE_OWNER_TAG: f32 = ${GATE_OWNER_MARKER_NATIVE};`));
assert(constructionWGSL(g).includes(`const INDUSTRY_PUMP_BACKPLATE_TAG: f32 = ${PUMP_BACKPLATE_TAG}.0;`), 'V1 construction text unchanged');
assert.equal(editKernelWGSL(g, INDUSTRY_EDIT).includes('fn update('), true);
assert(NativeIndustry);
console.log('PASS gate and pump-backplate ownership tags survive V2 storage; V1 kernels unchanged');

// M10, M11: a gate's shutter and a switch's toggle write V2's own cells in the frame that asks: V1's body on the
// native grid, then the native commit. Nothing exports the projection, binds V1's state or waits for the ring's
// readback to tell V2 to import (the old path: a V1 kernel over bindRW, and sim.version moved after the read).
{
  legacyExports = 0;
  const bindRW = Object.getOwnPropertyDescriptor(Simulation.prototype, 'bindRW');
  let rw = 0; Object.defineProperty(sim, 'bindRW', { get() { rw++; return bindRW.get.call(this); }, configurable: true });
  const gates = createGatePhysics({ getSim: () => sim, onError: e => errors.push(e) });
  const gate = { id: 'gate', type: 'gate', x: 16, y: 4, z: 16, rotation: 0, gateMode: 'closed', gateClosed: false };
  mark = calls.length; const version = sim.version;
  gates.step(1 / 60, [gate]);
  await new Promise(r => setTimeout(r, 0));
  const shutter = calls.slice(mark).map(c => c.name).filter(n => n.startsWith('industry'));
  assert.deepEqual(shutter, ['industryWriterFlying', 'industryGateEvaluate', 'industryWriterCommit'], 'the shutter is V1\'s body on V2\'s cells, then the native commit');
  const at = calls.slice(mark).find(c => c.name === 'industryGateEvaluate');
  assert.equal(at.opts.header.format, 3, 'its rule reads the canonical native core (physical read)');
  assert.deepEqual([at.opts.params.editLo, at.opts.params.editHi], [[16, 5, 18], [19, 7, 18]], 'over the aperture alone');
  assert(sim.version > version && owner.seenVersion === sim.version, 'counted in the frame it is recorded, with nothing left for V2 to import');
  const parts = createFactoryControlParts({ getSim: () => sim });
  mark = calls.length;
  await parts.toggle({ x: 2, y: 2, z: 2 });
  assert.deepEqual(calls.slice(mark).map(c => c.name).filter(n => n.startsWith('industry')),
    ['industryWriterFlying', 'industryFactoryControlPartsEvaluate', 'industryWriterCommit'], 'a switch toggles on V2\'s cells');
  assert.equal(legacyExports + rw, 0, 'no export of the projection and no V1 state bound');
  assert.equal(errors.length, 0, errors.map(String).join('\n'));
  delete sim.bindRW;
  console.log('PASS V2 gates and switches write natively in the frame that asks: no bridge, no export, no import');
}

// M9: the machines' clocks are V1's, the frame's wall time (capped at 0.05 s in industry/index.js update), not
// the game time of the ticks it ran; a V2 frame that ran none still runs (its time goes with the next).
{
  const { machineFrame } = await import('../../src/industry/physics.js');
  const seen = [], app = { settings: { paused: false }, renderOnly: false };
  const afterStep = (a, dt) => seen.push(machineFrame(a, dt));                   // wire/industry.js afterStep
  afterStep({ ...app, stepping: true, nativeStepped: 3 }, 1 / 60);        // Speed 3: three ticks a 60 Hz frame
  afterStep({ ...app, stepping: false, nativeStepped: 0 }, 1 / 120);      // a 120 Hz frame between ticks
  afterStep({ ...app, stepping: false, nativeStepped: 0, settings: { paused: true } }, 1 / 60);
  afterStep({ ...app, stepping: true, nativeStepped: null }, 1 / 30);     // V1
  assert.deepEqual(seen, [[1 / 60, true, true], [1 / 120, false, true], [1 / 60, false, false], [1 / 30, true, true]]);
  console.log("PASS machine clocks run on V1's wall-clock frame time under V2 (Speed and tick-less frames)");
}
