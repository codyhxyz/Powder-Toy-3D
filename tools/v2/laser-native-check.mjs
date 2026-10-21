// CPU-only: the laser cannon under V2 burns V2's own cells (src/v2/interactions.js nativeLaser), never
// V1's apply. V1's apply wrote V1's cells and V2 imported them, so a thin water film became a full
// steam cell at VAPOR_T. Drives the real PhysicsV2 owner, the real native force driver and the real
// POV laser call over a fake GPU (as tools/v2/momentum-check.mjs does); the generated WGSL is
// validated with Naga; the energy rule is checked on V2's CPU twin of its packed state (layout.js).
import assert from 'node:assert/strict';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { marksLayout } from '../../src/shaders/common.js';
import { nativeForceCommitWGSL, NATIVE_LAUNCH_MODE } from '../../src/v2/nativeForcing.js';
import { nativeWeatherParams } from '../../src/v2/nativeWeather.js';
import { laserSegments } from '../../src/v2/interactions.js';
import { povGpu } from '../../src/pov/gpu.js';
import { LASER, LASER_SEGMENT, LaserNativeParams, laserReachFrag, laserFrag } from '../../src/shaders/povBore.js';
import { E } from '../../src/elements.js';
import { makeMaterial, energyOf, withEnergy, energyFits, cid, cTq, cFill, isLiquid, FULL } from '../../src/v2/layout.js';
import { assertNaga } from './wgsl-grouping.mjs';

const g = gridLayout(32, 32, 32), calls = [], allocations = [];
globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100, UNIFORM: 0x40, MAP_READ: 1 };
const buffer = ({ size, ...desc }) => ({ ...desc, size, data: new Uint8Array(size), destroy() {} });
const REACH = 21.5;   // what the fake ring answers for the shot
const gpu = {
  testMode: true, L: { EMPTY: [] }, emptyGroup: {}, stats: { flushes: 0 }, limits: {},
  createBuffer: buffer, layout: (name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
  queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); } },
  write(b, at, data) { this.queue.writeBuffer(b, at, data); },
  frame: { copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); },
    clear(b, at = 0, n = b.size - at) { calls.push({ name: 'clear', buffer: b }); b.data.fill(0, at, at + n); } },
  kernel: ({ name, code }) => ({ name, code, state: 'ready', ready: Promise.resolve(),
    dispatch(f, size, opts) { calls.push({ name, size, opts, code }); } }),
  readback: {
    buffer: (b, at, n) => Promise.resolve(b.data.slice(at, at + n).buffer),
    ring: (label, bytes, slots) => ({ buffer: buffer({ size: bytes * slots }), next: () => 0, read: () => Promise.resolve(new Float32Array([REACH, E.WALL, 0, 1]).buffer) }),
  },
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
let legacyWrites = 0;
const legacyState = sim.legacyState.bind(sim);
sim.legacyState = (write, ...rest) => { if (write) legacyWrites++; return legacyState(write, ...rest); };
sim.edit = () => { throw Error('no V1 edit under V2'); };

// ---- 1. The shot: V2's reach, then V1's rule natively over the beam's segments; no V1 write, no import.
const muzzle = [3.5, 20.25, 4.5], dir = [0.7, -0.2, 0.6].map((v, _, a) => v / Math.hypot(...a));
{
  await povGpu(sim).prepare();
  calls.length = 0; allocations.length = 0;
  const version = sim.version;
  const shot = povGpu(sim).laser(muzzle, dir);
  assert(shot, 'the native shot is issued');
  const names = calls.map(c => c.name);
  assert.equal(legacyWrites, 0, "no V1 state is bound writable (V2 imported V1's laser cells: a thin film became a full steam cell)");
  assert(!names.includes('povLaser'), "V1's apply kernel is not dispatched under V2");
  assert.equal(names[0], 'povLaserReachNative', "V2's reach walks first");
  const reach = calls[0];
  assert.equal(reach.opts.header.format, 3, "the reach reads V2's physical cells");
  const evaluates = calls.filter(c => c.name === 'povLaserForceEvaluate'), planned = calls.filter(c => c.name === 'povLaserForcePlan');
  const parts = laserSegments(muzzle, dir), inGrid = parts.filter(p => p.box.lo.every((v, a) => Math.max(0, v) <= Math.min([g.nx, g.ny, g.nz][a] - 1, p.box.hi[a])));
  assert.equal(evaluates.length, inGrid.length, 'one evaluation per segment that reaches the grid');
  assert.equal(planned.length, inGrid.length, 'one plan per segment');
  assert(evaluates.every(c => c.opts.bind[2].entries[0].resource.buffer === povGpu(sim).d.beam), "every segment reads the reach kernel's shot on the GPU");
  for (const [i, c] of evaluates.entries()) assert.deepEqual([c.opts.params.segFrom, c.opts.params.segTo], [inGrid[i].values.segFrom, inGrid[i].values.segTo], 'its own stretch of the axis');
  assert.equal(calls.filter(c => c.name === 'clear' && c.buffer === plans).length, 1, 'one plan clear for the whole beam');
  assert.equal(allocations.length, 1, 'one shared allocation');
  assert.equal(allocations[0].params.mode, NATIVE_LAUNCH_MODE);
  assert(calls.findLastIndex(c => c.name === 'povLaserForcePlan') < allocations[0].at, 'after the last segment is planned');
  const particle = calls.find(c => c.name === 'povLaserForceParticleEvaluate');
  assert(particle && particle.opts.params.segFrom < -1e30 && particle.opts.params.segTo > 1e30, 'flying matter is evaluated once, over the whole beam');
  assert(sim.version > version, 'the write is the native driver\'s (version, wake)');
  assert.deepEqual(await shot, { reach: REACH, stopId: E.WALL }, 'the reach still comes back through the ring');
  // the kernels the shot ran, validated
  for (const name of ['povLaserReachNative', 'povLaserForceEvaluate', 'povLaserForceParticleEvaluate', 'povLaserForcePlan', 'povLaserForceParticleCommit', 'povLaserForceAir'])
    assertNaga(calls.find(c => c.name === name).code, name);
  console.log(`PASS V2 laser: native reach, ${evaluates.length} segments evaluated and planned, one plan clear, one allocation; no V1 apply, no V1 write`);
}

// ---- 2. The segments: every cell the rule can change is one segment's alone and inside that segment's box,
// and the beam's scratch stays small where one box round a slanting beam would not.
{
  const span = LASER.LENGTH + LASER.RIM_RADIUS, f = Math.fround;
  for (const [m, d] of [[muzzle, dir], [[0.5, 63.5, 0.5], [1, -1, 1].map(v => v / Math.sqrt(3))], [[10.2, 3.7, 40.1], [0, 0, -1]]]) {
    const parts = laserSegments(m, d);
    assert.equal(parts[0].values.segFrom, 0);
    assert(parts.at(-1).values.segTo >= span, 'the stretches reach the end of the longest beam');
    for (let i = 1; i < parts.length; i++) assert.equal(parts[i].values.segFrom, parts[i - 1].values.segTo, 'no gap, no overlap');
    let cells = 0;
    for (let z = 0; z < 64; z++) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const q = [x + 0.5 - m[0], y + 0.5 - m[1], z + 0.5 - m[2]].map(f);
      const along = f(q[0] * d[0] + q[1] * d[1] + q[2] * d[2]);
      if (along < 0 || along > span) continue;
      if (Math.hypot(...q.map((v, a) => v - along * d[a])) > LASER.RIM_RADIUS) continue;
      const own = parts.filter(p => along >= p.values.segFrom && along < p.values.segTo);
      assert.equal(own.length, 1, `cell ${[x, y, z]} has one segment`);
      assert([x, y, z].every((v, a) => v >= own[0].box.lo[a] && v <= own[0].box.hi[a]), `cell ${[x, y, z]} is inside its segment's box`);
      cells++;
    }
    assert(cells > 0);
  }
  // a 128³ grid's long diagonal: one box round the beam against the segments' boxes
  const n = 128, diag = [1, 1, 1].map(v => v / Math.sqrt(3)), at = [0.5, 0.5, 0.5];
  const clipCells = b => b.lo.reduce((k, v, a) => k * Math.max(0, Math.min(n - 1, b.hi[a]) - Math.max(0, v) + 1), 1);
  const end = at.map((v, a) => v + diag[a] * span), pad = LASER.RIM_RADIUS + 1;
  const whole = clipCells({ lo: at.map((v, a) => Math.floor(Math.min(v, end[a]) - pad)), hi: at.map((v, a) => Math.floor(Math.max(v, end[a]) + pad)) }) * 64;
  const split = laserSegments(at, diag).reduce((k, p) => k + clipCells(p.box), 0) * 64;
  assert(whole > 100e6, `one box would be most of the grid's 134 MB of scratch (${(whole / 1e6).toFixed(0)} MB)`);
  assert(split < 12e6, `the segments' scratch is small (${(split / 1e6).toFixed(1)} MB)`);
  console.log(`PASS laser segments: each cell in one segment and its box; 128³ diagonal ${(split / 1e6).toFixed(1)} MB against one box's ${(whole / 1e6).toFixed(0)} MB`);
}

// ---- 3. The core's vaporisation: V1's change in the share of a full cell the cell holds, energy-exact.
{
  const params = nativeWeatherParams('povLaser', { params: { ...Object.fromEntries(LaserNativeParams.fields.map(f => [f.name, f.type])), origin: 'vec3i' } });
  const code = nativeForceCommitWGSL(g, params, 'plan', { vaporise: true, sparse: true, motion: { flags: 'if(all(r.motion.xyz==vec3f(0.0))) { flags&=~1u; }' } });
  assert(/if\(r\.before\.x!=r\.after\.x && cls\(u32\(r\.after\.x\)\)==C_GAS\) \{\n var gas=makeMaterial\(u32\(r\.after\.x\),r\.after\.y,FULLU,0u\);/.test(code), "vaporise: V1's gas, a fresh full cell at V1's temperature");
  assert(/if\(isLiq\(before\.core\)\) \{ share=cFill\(before\.core\);/.test(code), "a liquid's share is its fill");
  assert(/let e=energyAdd\(energyOf\(before\),energyScale\(energySub\(energyOf\(gas\),energyOf\(whole\)\),share,FULLU\)\);/.test(code), "it takes that share of V1's change to a full cell");
  assert(/if\(energyFits\(gas,e\)\) \{ out=withEnergy\(gas,e\); \} else if\(energyFits\(before,e\)\) \{ out=withEnergy\(before,e\); \}/.test(code), 'exactly that energy, as the gas or, until it can be, as itself');
  assert(/if\(flags!=0u\) \{ plans\[s\]=/.test(code), "sparse: a segment never clears another segment's plans");
  assertNaga(code, 'vaporise plan');
  assert(!/var gas=makeMaterial/.test(nativeForceCommitWGSL(g, params, 'plan', {})), 'only a writer that asks vaporises');
  // The rule on V2's CPU twin of its cells (layout.js is shaders/v2/state.js's).
  const vaporise = (before, into) => {
    const gas = makeMaterial(into, LASER.VAPOR_T, FULL, 0), liquid = isLiquid(cid(before.core)), share = liquid ? cFill(before.core) : FULL;
    const whole = { core: new Uint32Array(before.core), bank: before.bank };
    if (liquid) whole.core[1] = (before.core[1] & 0xff000000) | FULL;
    const e = energyOf(before) + (energyOf(gas) - energyOf(whole)) * BigInt(share) / BigInt(FULL);
    return energyFits(gas, e) ? withEnergy(gas, e) : energyFits(before, e) ? withEnergy(before, e) : before;
  };
  const celsius = m => cTq(m.core) / 4 - 273.25;
  const v1Steam = makeMaterial(E.STEAM, LASER.VAPOR_T);   // V1's product, and what V2 imported from V1's apply whatever the fill
  const full = makeMaterial(E.WATER, 20, FULL), film = makeMaterial(E.WATER, 20, FULL / 8);
  const fromFull = vaporise(full, E.STEAM), fromFilm = vaporise(film, E.STEAM);
  assert.equal(cid(fromFull.core), E.STEAM, 'a full cell of water flashes to steam');
  assert.equal(energyOf(fromFull), energyOf(v1Steam), "V1's steam exactly: at VAPOR_T");
  assert.equal(Math.round(celsius(fromFull)), LASER.VAPOR_T);
  const rock = vaporise(makeMaterial(E.ROCK, 20), E.SMOKE);
  assert.equal(cid(rock.core), E.SMOKE, 'rock in the core still goes up as smoke (the tunnel opens)');
  assert.equal(energyOf(rock), energyOf(makeMaterial(E.SMOKE, LASER.VAPOR_T)), "V1's smoke at VAPOR_T");
  const filmShare = energyOf(film) + (energyOf(v1Steam) - energyOf(full)) / 8n;
  assert.equal(energyOf(fromFilm), filmShare, "an eighth of a cell takes an eighth of V1's change: only its own share");
  assert(energyOf(fromFilm) < energyOf(v1Steam) / 4n, "far less than the full steam cell at VAPOR_T V2 imported");
  console.log(`PASS V2 laser vaporise: full water -> V1's steam at ${celsius(fromFull).toFixed(0)} °C, rock -> smoke; an 1/8 film -> ${cid(fromFilm.core) === E.STEAM ? 'steam' : 'water (V2 boils it as its own: ctConvert waits)'} holding 1/8 of V1's change`);
}

// ---- 4. V1 is untouched: the shared rule renders V1's apply and reach as before (tools/v2 hashes in the report).
{
  const v1 = laserFrag(g), reach = laserReachFrag(g), native = laserReachFrag(g, true);
  assert(!/laserFill/.test(reach) && /laserFill\(c, id\)/.test(native), "only V2's reach charges a liquid by its fill");
  assert(/fn laser\(p: vec3i/.test(v1) && /writeCell\(p, a, bb, fetchF\(p\), oA, oB\)/.test(v1), "V1's apply keeps its rule and its in-place write");
  console.log('PASS V1 laser kernels keep their text; the fill share is V2-only');
}
