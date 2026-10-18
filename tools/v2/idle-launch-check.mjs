// CPU-only: the idle tick's former all-brick launches now run over lists, exactly.
// 1. The jets: count lists every flagged brick (the one test spawn makes before
//    anything else), nothing between count and spawn writes a jets word, so
//    spawn over the list does what spawn over every brick did. count adds its
//    groups' sums into one total word (u32: the order is free) and the gate
//    exchanges it with 0: the same demand as the old loop over the groups, tick
//    after tick. A gate that keeps the total must break it.
// 2. The real driver records spawn and the three reach axes as list-indirect
//    dispatches (reach's scatter = gather proof is in air-reach-check).
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { nativeDynamicsHead } from '../../src/shaders/v2.js';
import { jetsWGSL } from '../../src/shaders/v2/jets.js';
import { blastsWGSL, ALLOCATION_STAGES, listsStageWGSL, LIST_ARGS } from '../../src/shaders/v2/blasts.js';
import { airWGSL } from '../../src/shaders/v2/air.js';

const g = gridLayout(16, 8, 8), main = code => code.slice(code.lastIndexOf('@compute'));
const count = main(jetsWGSL(g, 'count')), spawn = main(jetsWGSL(g, 'spawn')), gate = main(jetsWGSL(g, 'gate'));
assert.match(count, /if\(jetBrick\(t\)\) \{ dAppend\(LIST_JETS,t\);/, 'count lists every flagged brick');
assert.match(spawn, /let t = dListedCell\(LIST_JETS,wg,nwg,li\);/, 'spawn runs over the list');
assert.match(spawn, /if\(li==0u\) \{ wgListed=select\(0u,1u,jetBrick\(b\)\); \}\s*if\(workgroupUniformLoad\(&wgListed\)==0u\) \{ return; \}/, 'spawn tests the flag before anything else');
// nothing between count and spawn writes a jets word: the gate, the pool preparation, the allocation, the publish
for (const [name, code] of [['gate', gate], ['allocate', jetsWGSL(g, 'allocate')], ['publishCouple', listsStageWGSL(g, 'publishCouple')],
  ...ALLOCATION_STAGES.map(s => [s, blastsWGSL(g, nativeDynamicsHead, s)])])
  assert.doesNotMatch(main(code), /V2_JETS/, `${name} writes no jets word`);
assert.match(count, /if\(li==63u\) \{ atomicStore\(&control\[J_COUNTS\+t\/64u\],prefix\+count\); if\(prefix\+count!=0u\) \{ atomicAdd\(&control\[J_TOTAL\],prefix\+count\); \} \}/);
assert.match(gate, /let demand=atomicExchange\(&control\[J_TOTAL\],0u\);/);
assert.doesNotMatch(gate, /for\(/, 'the gate no longer loops over the groups');
// the total protocol over ticks, against the old loop (u32 wrap included)
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function demands(seed, keep = false) {
  const random = rng(seed), out = []; let total = 0;
  for (let tick = 0; tick < 20; tick++) {
    const groups = Array.from({ length: Math.ceil(g.nbricks / 64) + 3 }, () => (random() < 0.7 ? 0 : random() < 0.1 ? 0xffffffff : Math.floor(random() * 300)));
    const old = groups.reduce((a, x) => (a + x) >>> 0, 0) > 0;
    for (const x of groups) if (x) total = (total + x) >>> 0;
    const now = total > 0; if (!keep) total = 0;
    out.push([old, now]);
  }
  return out;
}
for (let seed = 1; seed <= 50; seed++) for (const [old, now] of demands(seed)) assert.equal(now, old, `jets demand differs: seed ${seed}`);
let kept = false; for (let seed = 1; seed <= 50 && !kept; seed++) kept = demands(seed, true).some(([o, n]) => o !== n);
assert.ok(kept, 'a gate that keeps the total must break the demand');

// 2. the driver
const { PhysicsV2 } = await import('../../src/v2/physics.js');
const { NativeDynamics } = await import('../../src/v2/dynamics.js');
const { contactWGSL } = await import('../../src/shaders/v2/contact.js');
const { GRAV, AIR, EDGE } = await import('../../src/simModes.js');
globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
const commands = [];
const gpu = { createBuffer: d => ({ ...d, destroy() {} }), queue: { writeBuffer() {} }, write() {}, layout: (name, entries) => ({ name, entries }),
  bindGroup: (layout, entries) => ({ layout, entries }), L: { EMPTY: {} }, emptyGroup: {},
  kernel: d => ({ ...d, ready: Promise.resolve(), state: 'ready', dispatch(frame, size, data) { commands.push({ name: d.name, size, params: data.params }); } }),
  readback: { buffer: (b, o, n) => Promise.resolve(new ArrayBuffer(n)) }, frame: { clear() { commands.push({ name: 'clear' }); }, copy() { commands.push({ name: 'copy' }); } }, flush() {} };
const sim = { g, gravity: 0.025, gravityMode: GRAV.VERTICAL, airMode: AIR.ON, ambientHeat: true, edgeMode: EDGE.SOLID, airT: 20,
  gpu, id: 1, version: 0, wholeWrites: 0, frame: 0, paints: 0, state: { A: {}, B: {}, F: {} }, marks: {}, tables: {}, L: { STATE_RO: {}, TABLES: {} },
  header: () => ({}), noteWrite() {}, origin: { x: 0, y: 0, z: 0 } };
const engine = new PhysicsV2(sim, { contactWGSL, Dynamics: NativeDynamics }); await engine.ready;
engine.sync(); engine._tick(); commands.length = 0; engine._tick();
const args = engine.dynamics.dispatchArgs, find = name => commands.filter(c => c.name === name);
assert.deepEqual(find('v2jets_spawn').map(c => c.size), [{ indirect: args, offset: LIST_ARGS.jetCells }]);
assert.deepEqual(find('v2air_reach').map(c => [c.size.offset, c.params.substep]), [[LIST_ARGS.source, 0], [LIST_ARGS.reachX, 1], [LIST_ARGS.reachY, 2]]);
assert.ok(find('v2air_reach').every(c => c.size.indirect === args));
assert.ok(!commands.some(c => c.name === 'copy' || c.name === 'clear'), 'still one compute pass');
assert.match(airWGSL(g, nativeDynamicsHead, 'reach'), /dListedBrick\(LIST_SOURCE,wg,nwg,li\)/);
console.log(`idle launches: jets spawn and the air reach run over lists; jets demand exact over 50x20 ticks; ${commands.length} dispatches a tick; 1 red variant caught`);
