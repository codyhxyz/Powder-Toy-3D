// CPU only (no GPU, no browser): V2's airborne matter takes part as V1's moving cells did
// (src/v2/airborne.js). V1 had no flying state, so its react pass heated, burnt, boiled and
// reacted splashes and ejecta as the cells they were; V2's particle lane now runs the native
// contact rules on each flying packet and the cell it passes through. Checks: the CPU twin's
// physics and its exact energy, the generated stages (Naga, the eight-buffer budget, the whole
// contact table), and that the real driver records them every tick after the landings.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { gridLayout } from '../../src/sim.js';
import { makeMaterial, packetOwnedEnergy, energyOf, cTq, cid, FULL } from '../../src/v2/layout.js';
import { airborneReference, outsideOf, AIRBORNE } from '../../src/v2/airborne.js';
import { particlesWGSL, PARTICLE_STAGES, airborneBase, airbornePuffBase, heldBase, PARTICLE_CAP } from '../../src/shaders/v2/particles.js';
import { blastsWGSL, BLAST_STAGES, externalBlastBase } from '../../src/shaders/v2/blasts.js';
import { nativeDynamicsHead, v2Table } from '../../src/shaders/v2.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { assertNaga } from './wgsl-grouping.mjs';

const T = core => cTq(core) / 4 - 273.25;
const key = core => ELEMENTS[cid(core)].key;
// A flying packet as the jets, blasts and throws make one: the cell's words, bank 0 (shaders/v2/jets.js).
const packet = (id, t, amount = FULL) => makeMaterial(id, t, amount);
const air = (t = 20) => makeMaterial(E.EMPTY, t, 0);
const fire = () => makeMaterial(E.FIRE, ELEMENTS[E.FIRE].temp);
const OPEN = outsideOf(Array.from({ length: 6 }, () => air().core));
assert.deepEqual(OPEN, [6, 0, 0, 6], 'open air all round: six faces of air');

// Runs a packet through hosts (one a tick), checking exact energy every tick:
// packet + host before, plus declared sources, minus sinks, is what both hold after.
function fly(p, hostAt, ticks, outside = OPEN) {
  const log = [];
  for (let i = 0; i < ticks; i++) {
    const host = hostAt(i);
    const before = packetOwnedEnergy(p) + energyOf(host);
    const r = airborneReference(p, host, Math.imul(i + 1, 2654435761) | 0, outside);
    const flying = r.state === AIRBORNE.FLYING || r.state === AIRBORNE.DISPLACED;
    if (r.state !== AIRBORNE.REFUSED) {
      assert.equal((flying ? packetOwnedEnergy(r.particle) : 0n) + energyOf(r.host), before + r.source - r.sink, `exact energy, tick ${i}`);
    }
    log.push(r);
    if (!flying) { if (r.state !== AIRBORNE.REFUSED) return { r, tick: i, log }; continue; }
    p = r.particle;
    if (r.state === AIRBORNE.DISPLACED || cid(p.core) !== cid(log[0].particle.core)) return { r, tick: i, log, p };
  }
  return { r: log.at(-1), tick: ticks, log, p };
}

// 1. Heat exchange with the air it passes through: a hot stone cools, its air warms, nothing is made.
{
  const stone = packet(E.STONE, 500), host = air(20);
  const r = airborneReference(stone, host, 7, OPEN);
  assert.equal(r.state, AIRBORNE.FLYING);
  assert(T(r.particle.core) < 500 && T(r.host.core) > 20, 'conduction both ways (ctFlux)');
  assert.equal(packetOwnedEnergy(r.particle) + energyOf(r.host), packetOwnedEnergy(stone) + energyOf(host));
  // the virtual carrier's share: what the packet's own air gained is the host's, not the packet's
  assert.equal(r.source, 0n); assert.equal(r.sink, 0n);
}
// 2. Boiling: a water drop through flames turns to steam (phase.js latent heat; V1 WATER→STEAM at 100 °C).
{
  const out = fly(packet(E.WATER, 20, FULL / 8), fire, 600);
  assert.equal(key(out.p.core), 'STEAM', 'the drop boils in flight');
  assert.equal(out.r.requests & 2, 2, 'its steam is the air\'s gas source at its host (requests bit 1)');
  assert.equal(out.r.requests & 1, 0, 'never a detonation while flying');
}
// 3. Melting: ice through flames melts.
assert.equal(key(fly(packet(E.ICE, -10), fire, 600).p.core), 'WATER', 'ice melts in flight');
// 4. Freezing the other way round: lava cools to its stone in cold air.
assert.equal(key(fly(packet(E.LAVA, 1500, FULL / 4), () => air(20), 4000).p.core), 'STONE', 'a lava drop sets in flight');
// 5. Ignition and burning: sawdust thrown through a fire catches, spends its fuel and leaves its exhaust.
{
  const out = fly(packet(E.SAWDUST, 20), fire, 600);
  assert(out.log.some(r => r.state === AIRBORNE.FLYING && cid(r.particle.core) === E.SAWDUST && ((r.particle.core[1] >>> 24) & 1)), 'it catches (burning bit)');
  assert(out.log.some(r => r.source > 0n), 'burning releases its heat as a declared source');
  assert(['ASH', 'CO2'].includes(key(out.p.core)) || out.r.state === AIRBORNE.GONE, 'its fuel runs out: ash, CO2 or nothing');
}
// 6. Fire's own life: a flame packet burns out in about V1's flame life, leaving smoke
// CT_FIRE_TO_SMOKE of the time or nothing (ctStepAtmosphere's FIRE decrement, V1 react.js).
{
  const out = fly(packet(E.FIRE, 900), () => air(20), 600);
  assert(out.r.state === AIRBORNE.GONE || key(out.p.core) === 'SMOKE', 'a spent flame leaves smoke or nothing');
  assert(out.tick < 60, `out within a second (${out.tick} ticks)`);
}
// 7. A burning packet's flames lick into the air it flies through (ctLick, V1 react.js).
{
  let burning = packet(E.SAWDUST, 400); burning.core[1] |= 1 << 24;
  const out = fly(burning, () => air(20), 200);
  assert(out.log.some(r => [E.FIRE, E.SMOKE, E.CO2].includes(cid(r.host.core))), 'flame, smoke or CO2 left behind in its air');
}
// ...and not into air that CO2 smothers (ctSmothered: CO2 at 30% of the gas around it).
{
  let burning = packet(E.SAWDUST, 400); burning.core[1] |= 1 << 24;
  const out = fly(burning, () => air(20), 200, [0, 0, 6, 6]);
  assert(!out.log.some(r => cid(r.host.core) === E.FIRE), 'no flame licks into smothered air');
}
// 7b. Ambient heat off (V1 react.js): matter trades no heat with air, so a hot stone flies unchanged.
{
  const off = { ambient: 20, ambientHeat: 0 }, on = { ambient: 20, ambientHeat: 1 };
  const stone = packet(E.STONE, 400);
  assert.equal(T(airborneReference(stone, air(20), 7, OPEN, off).particle.core), 400, 'no exchange with air');
  assert(T(airborneReference(stone, air(20), 7, OPEN, on).particle.core) < 400, 'with it on, the stone cools into the air');
}
// 7c. A flying gas radiates toward the scene's ambient by its rad (ctAmbient), even with no air to touch.
{
  const off = { ambient: 20, ambientHeat: 0 };
  const steam = packet(E.STEAM, 300), r = airborneReference(steam, air(20), 7, OPEN, off);
  assert(T(r.particle.core) < 300 && T(r.particle.core) > 20, 'steam cools toward ambient');
}
// 8. Reactions with what it passes through: a water drop through caustic gas absorbs it as acid (elements.js REACTIONS).
{
  const out = fly(packet(E.WATER, 20, FULL / 4), () => makeMaterial(E.CAUSTIC_GAS, 20), 600);
  assert.equal(key(out.p.core), 'ACID');
}
// 9. Detonation is a cell's event: a charge set off in flight lands where it is, in air...
{
  const r = airborneReference(packet(E.GUNPOWDER, 400), air(20), 3, OPEN);
  assert.equal(r.state, AIRBORNE.LANDED); assert.equal(cid(r.host.core), E.GUNPOWDER, 'the charge is the host cell now');
  assert.equal(r.requests & 1, 1, 'and its detonation request is posted there, for this tick\'s blasts');
}
// ...or in the flames that set it off, the fire flying on in its place.
{
  const out = fly(packet(E.GUNPOWDER, 20), fire, 600);
  assert.equal(out.r.state, AIRBORNE.DISPLACED); assert.equal(cid(out.r.host.core), E.GUNPOWDER); assert.equal(cid(out.r.particle.core), E.FIRE);
}
// 10. Smothered: no burning in CO2.
{
  let burning = packet(E.SAWDUST, 400); burning.core[1] |= 1 << 24;
  const r = airborneReference(burning, makeMaterial(E.CO2, 20), 5, [0, 0, 6, 6]);
  assert.equal((r.particle.core[1] >>> 24) & 1, 0, 'CO2 puts it out (ctStepAtmosphere smothered)');
}

// 11. The generated stages: Naga, the particle family's eight buffers, the whole contact table.
const table = new Uint32Array(v2Table().buffer).length;
let modules = 0;
for (const dims of [[32, 32, 32], [48, 16, 32]]) {
  const g = gridLayout(...dims);
  for (const stage of ['reactClaim', 'react']) {
    const code = particlesWGSL(g, nativeDynamicsHead, stage);
    assert([...code.matchAll(/var<storage,/g)].length <= 8, `${stage} storage budget`);
    assertNaga(code, `particles/${stage} ${dims}`); modules++;
  }
  const react = particlesWGSL(g, nativeDynamicsHead, 'react');
  assert.match(react, new RegExp(`const EV = array<vec4u, ${Math.ceil(table / 4)}>`), 'the rule stage reads the contact rows (EV tail)');
  assert.doesNotMatch(react, /arrayLength\(&events\)/, 'no block storage in the particle family');
  for (const rule of ['ctFlux(v, h)', 'ctReaction(v, h, seed)', 'ctStepAtmosphere(v,', 'ctResolvePhase(v, h)', 'ctLick(h, 1,', 'ctAmbient(v, ambientQ, airHeat)', 'ctConducts(v, h, airHeat)']) assert(react.includes(rule), `the pair runs ${rule}`);
}
assert(PARTICLE_STAGES.includes('reactClaim') && PARTICLE_STAGES.includes('react'));
// the requests' posting stage (blasts family: it binds events) and its control words
for (const dims of [[32, 32, 32], [48, 16, 32]]) {
  const g = gridLayout(...dims), code = blastsWGSL(g, nativeDynamicsHead, 'airborneEvents');
  assertNaga(code, `blasts/airborneEvents ${dims}`); modules++;
  assert.match(code, /let request = \(\(events\[s\] \| bits\) & 255u\) \| \(max\(events\[s\] \/ 256u, puff\) \* 256u\);\n    events\[s\] = request; noteEvents\(s, request\);/, 'posted as the block pass posts a cell\'s requests (ctMergeRequest: flags together, the larger puff)');
  assert.equal(airborneBase(g), heldBase(g) + PARTICLE_CAP); assert.equal(airbornePuffBase(g), airborneBase(g) + 1 + PARTICLE_CAP); assert.equal(externalBlastBase(g), airbornePuffBase(g) + PARTICLE_CAP, 'its words overlap no other range');
}
assert(BLAST_STAGES.includes('airborneEvents'));

// 12. The real driver records them every tick, after the landings, with elect between.
globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
const calls = [];
const copy = (b, offset, src) => { const u = src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength); new Uint8Array(b.bytes).set(u, offset); };
const gpu = { createBuffer: ({ size, label }) => ({ size, label, bytes: new ArrayBuffer(size), destroy() {} }), queue: { writeBuffer: copy }, write: copy,
  layout: (_n, l) => l, bindGroup: (_l, b) => b, frame: { clear() {}, copy() {} },
  kernel: d => ({ name: d.name, ready: Promise.resolve(), dispatch: (_f, size, opts) => { d.params.pack(opts.params); calls.push(d.name); } }) };
const g = gridLayout(16, 8, 8);
const owner = { gpu, g, epoch: 0, tick: 1, sim: { origin: { x: 0, y: 0, z: 0 }, header: () => ({}) },
  nativeDynamics: { head: () => '', layout: [], group: [] }, wake() {}, _params: () => ({}) };
owner.events = gpu.createBuffer({ size: g.slots * 4, label: 'events' });
const d = new NativeDynamics(owner); await d.ready;
d.advanceParticles(1);
const at = name => calls.lastIndexOf(`v2particles_${name}`);
assert(at('react') > at('reactClaim') && at('reactClaim') > at('deposit') && calls.slice(at('reactClaim'), at('react')).includes('v2particles_elect'),
  'claim, elect, react: after this tick\'s landings');
assert(calls.lastIndexOf('v2blasts_airborneEvents') > at('react'), 'then their requests are posted, before the grid passes read them');
console.log(`airborne matter: conduction, boiling, melting, setting, burning, plume, reactions, smothering, detonation all exact, requests posted at the host; ${modules} stage modules validated; driver records them; no GPU`);
