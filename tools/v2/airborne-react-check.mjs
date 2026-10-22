// CPU only (no GPU, no browser): V2's airborne matter takes part as V1's moving cells did
// (src/v2/airborne.js). V1 had no flying state, so its react pass heated, burnt, boiled and
// reacted splashes and ejecta as the cells they were, with their six face neighbours; V2's
// particle lane now runs the native contact rules on each flying packet with its host's six faces.
// Checks: the CPU twin's physics with its neighbours and its exact energy, the block pass's
// partition and the colouring the react stage runs in, every packet of a crowded cell taking part
// in an order no replay changes, the generated stages (Naga, the eight-buffer budget, the whole
// contact table), and that the real driver records them every tick after the landings.
import assert from 'node:assert/strict';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { gridLayout } from '../../src/sim.js';
import { makeMaterial, packetOwnedEnergy, energyOf, cTq, cid, FULL } from '../../src/v2/layout.js';
import { airborneReference, outsideOf, nearOf, openNear, inBlockFaces, trailingFace, colourOf, airborneOrder, packAirborne,
  FACE6, AIRBORNE, AIRBORNE_COLOURS, AIRBORNE_COLOUR_TABLE, AIRBORNE_NO_CHARGE, dustFacesOf } from '../../src/v2/airborne.js';
import { DUST_MIN_FALL_SPEED, CONTACT_PUFF_UNIT, ctNew, packContact, unpackContact } from '../../src/v2/contact.js';
import { offsetOf } from '../../src/v2/physics.js';
import { particlesWGSL, PARTICLE_STAGES, airborneBase, airbornePuffBase, heldBase, shockPostBase, setOffBase, PARTICLE_CAP, DynamicParams,
  pressureCellWGSL, pressureOnWGSL, crushWGSL } from '../../src/shaders/v2/particles.js';
import { blastsWGSL, BLAST_STAGES, externalBlastBase } from '../../src/shaders/v2/blasts.js';
import { nativeDynamicsHead, v2Table } from '../../src/shaders/v2.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { assertNaga } from './wgsl-grouping.mjs';
import { dynamicsRows } from '../../src/v2/dynamics-reference.js';

const T = core => cTq(core) / 4 - 273.25;
const key = core => ELEMENTS[cid(core)].key;
// A flying packet as the jets, blasts and throws make one: the cell's words, bank 0 (shaders/v2/jets.js).
const packet = (id, t, amount = FULL) => makeMaterial(id, t, amount);
const air = (t = 20) => makeMaterial(E.EMPTY, t, 0);
const fire = () => makeMaterial(E.FIRE, ELEMENTS[E.FIRE].temp);
const six = make => Array.from({ length: 6 }, (_, f) => make(f));
const openFaces = () => six(() => air());
assert.deepEqual(outsideOf(openFaces().map(m => m.core)), [6, 0, 0, 6], 'open air all round: six faces of air');
// The host cell the packets fly through (its parity picks its partners), and the way they fly.
const CELL = [5, 5, 5], FALLING = [0, -3, 0];
const energy = m => (m ? energyOf(m) : 0n);
const sum = ms => ms.reduce((s, m) => s + energy(m), 0n);

// Runs a packet through hosts (one a tick) with the faces around them, the block pass's partition
// offset of each tick (physics.js offsetOf), checking exact energy every tick: packet, host and
// faces before, plus declared sources, minus sinks, is what they all hold after. facesAt(i, last)
// gives a tick's faces (last: what the tick before left of them).
// (t0: the tick it sets out on, for its draws and the block offsets)
function fly(p, hostAt, ticks, facesAt = openFaces, { velocity = FALLING, modes, cell = CELL, onFloor = 0, t0 = 0 } = {}) {
  const log = []; let faces = null;
  for (let i = 0; i < ticks; i++) {
    const host = hostAt(i); faces = facesAt(i, faces);
    const before = packetOwnedEnergy(p) + energyOf(host) + sum(faces);
    const r = airborneReference(p, host, Math.imul(i + t0 + 1, 2654435761) | 0, nearOf(faces, cell, offsetOf(i + t0), velocity, onFloor), modes);
    const flying = r.state === AIRBORNE.FLYING || r.state === AIRBORNE.DISPLACED;
    if (r.state !== AIRBORNE.REFUSED) {
      assert.equal((flying ? packetOwnedEnergy(r.particle) : 0n) + energyOf(r.host) + sum(r.faces), before + r.source - r.sink, `exact energy, tick ${i}`);
    }
    log.push(r); faces = r.faces;
    if (!flying) { if (r.state !== AIRBORNE.REFUSED) return { r, tick: i, log }; continue; }
    p = r.particle;
    if (r.state === AIRBORNE.DISPLACED || cid(p.core) !== cid(log[0].particle.core)) return { r, tick: i, log, p };
  }
  return { r: log.at(-1), tick: ticks, log, p };
}
// The face at f of a fresh open-air neighbourhood holds m (made new each tick: the packet passes a
// sheet of it), or keeps what the last tick left there (a wall it flies along).
const withFace = (f, make, keep = false) => (i, last) => {
  if (keep && last) return last;
  const faces = openFaces(); faces[f] = make(); return faces;
};

// ---- the partition and the colouring ----
// The block pass's 2x2x2 blocks: corner brick*4 + offset - 1 on each axis (shaders/v2.js v2BlockWGSL).
for (let o = 0; o < 8; o++) {
  const offset = [o & 1, (o >> 1) & 1, (o >> 2) & 1];
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) for (let z = 0; z < 8; z++) {
    const p = [x, y, z], corner = p.map((v, a) => v - (((v - offset[a] + 1) % 2 + 2) % 2));
    inBlockFaces(p, offset).forEach((f, a) => {
      assert.equal(f >> 1, a, 'one partner an axis');
      const q = p.map((v, k) => v + FACE6[f][k]);
      assert(q.every((v, k) => v === corner[k] || v === corner[k] + 1), `the partner of ${p} at offset ${offset} is in its block`);
    });
  }
}
// Over a cycle of offsets, each face is a partner exactly half the ticks: the share ctFlux and the
// reactions' per-tick rates assume (contact.js ctFlux: each face present 1/2 ticks).
{
  const counts = new Array(6).fill(0);
  for (let t = 0; t < 64; t++) for (const f of inBlockFaces(CELL, offsetOf(t))) counts[f]++;
  assert.deepEqual(counts, new Array(6).fill(32), 'each face a partner half the ticks');
}
assert.equal(trailingFace([0, -3, 0]), 2, 'falling: its host is the face above it');
assert.equal(trailingFace([4, 1, -2]), 1, 'flying +x: its host behind it, -x');
assert.equal(trailingFace([0, 0, 0]), 1, 'at rest: x, counted as moving +');
// The colouring: any two distinct cells within two faces of each other (across a looped edge too)
// differ, so no two hosts of one colour share a cell of their footprints (a host and its six faces).
{
  assert.equal(AIRBORNE_COLOUR_TABLE.length, 64); assert.equal(Math.max(...AIRBORNE_COLOUR_TABLE) + 1, AIRBORNE_COLOURS);
  for (const [nx, ny, nz] of [[4, 4, 4], [16, 8, 8], [32, 16, 24]]) {
    const wrap = (d, n) => Math.min(Math.abs(d), n - Math.abs(d));
    const cells = []; for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) cells.push([x, y, z]);
    const byColour = new Map();
    for (const p of cells) { const c = colourOf(p); if (!byColour.has(c)) byColour.set(c, []); byColour.get(c).push(p); }
    for (const [, ps] of byColour) for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const d = wrap(ps[i][0] - ps[j][0], nx) + wrap(ps[i][1] - ps[j][1], ny) + wrap(ps[i][2] - ps[j][2], nz);
      assert(d >= 3, `${ps[i]} and ${ps[j]} share colour ${colourOf(ps[i])} ${d} faces apart (${nx}x${ny}x${nz}, looped)`);
    }
  }
}

// ---- with the air it flies through (its host, and the open air around it) ----
// 1. Heat exchange: a hot stone cools, its host and the air partners beside it warm, nothing is made;
// the faces out of its block this tick trade nothing.
{
  const stone = packet(E.STONE, 500), host = air(20), faces = openFaces();
  const near = nearOf(faces, CELL, [0, 0, 0], FALLING);
  assert.deepEqual(near.inBlock, [0, 2, 4]); assert.equal(near.trailing, 2, 'its host stands in the +y face, a partner');
  const r = airborneReference(stone, host, 7, near);
  assert.equal(r.state, AIRBORNE.FLYING);
  assert(T(r.particle.core) < 500 && T(r.host.core) > 20, 'conduction with its host (ctFlux)');
  assert(T(r.faces[0].core) > 20 && T(r.faces[4].core) > 20, 'and with the air beside it');
  for (const f of [1, 3, 5]) assert.equal(T(r.faces[f].core), 20, `face ${f} is out of its block this tick`);
  assert.equal(r.faces[2], faces[2], 'the face behind it is its host, the cell there untouched');
  assert.equal(packetOwnedEnergy(r.particle) + energyOf(r.host) + sum(r.faces), packetOwnedEnergy(stone) + energyOf(host) + sum(faces));
  assert.equal(r.source, 0n); assert.equal(r.sink, 0n);
}
// 2. Boiling: a water drop through flames turns to steam (phase.js latent heat; V1 WATER→STEAM at 100 °C).
{
  const out = fly(packet(E.WATER, 20), fire, 600);
  assert.equal(key(out.p.core), 'STEAM', 'the drop boils in flight');
  assert.equal(out.r.requests & 2, 2, 'its steam is the air\'s gas source at its host (requests bit 1)');
  assert.equal(out.r.requests & 1, 0, 'never a detonation while flying');
}
// ...and a part-filled drop makes a whole steam cell with its fill's chance, else leaves its carrier air
// (contact.js ctPhase: V1's whole cells boil one for one), its energy exact either way (fly's ledger).
{
  let steam = 0, gone = 0;
  for (let k = 0; k < 48; k++) {
    const out = fly(packet(E.WATER, 90, FULL / 8), fire, 600, openFaces, { t0: 7919 * k });
    if (out.p && key(out.p.core) === 'STEAM') steam++; else if (!out.p) gone++;
  }
  assert.equal(steam + gone, 48, 'every film drop boils away');
  assert(steam >= 1 && steam <= 15, `an eighth of a cell makes steam about an eighth of the time: ${steam}/48`);
}
// 3. Melting: ice through flames melts.
assert.equal(key(fly(packet(E.ICE, -10), fire, 600).p.core), 'WATER', 'ice melts in flight');
// 4. Freezing the other way round: lava cools to its stone in cold air.
assert.equal(key(fly(packet(E.LAVA, 1500), () => air(20), 4000).p.core), 'STONE', 'a lava drop sets in flight');
// 5. Ignition and burning: sawdust thrown through a fire catches, spends its fuel and leaves its exhaust.
{
  const out = fly(packet(E.SAWDUST, 20), fire, 600);
  assert(out.log.some(r => r.state === AIRBORNE.FLYING && cid(r.particle.core) === E.SAWDUST && ((r.particle.core[1] >>> 24) & 1)), 'it catches (burning bit)');
  assert(out.log.some(r => r.source > 0n), 'burning releases its heat as a declared source');
  assert(['ASH', 'CO2'].includes(key(out.p?.core ?? out.r.particle.core)) || out.r.state === AIRBORNE.GONE, 'its fuel runs out: ash, CO2 or nothing');
}
// 6. Fire's own life: a flame packet burns out in about V1's flame life, leaving smoke
// CT_FIRE_TO_SMOKE of the time or nothing (ctStepAtmosphere's FIRE decrement, V1 react.js).
{
  const out = fly(packet(E.FIRE, 900), () => air(20), 600);
  assert(out.r.state === AIRBORNE.GONE || key(out.p.core) === 'SMOKE', 'a spent flame leaves smoke or nothing');
  assert(out.tick < 60, `out within a second (${out.tick} ticks)`);
}
// 7. A burning packet's flames lick into the air it flies through and beside it (ctLick, V1 react.js nBurning).
{
  let burning = packet(E.SAWDUST, 400); burning.core[1] |= 1 << 24;
  const out = fly(burning, () => air(20), 200);
  assert(out.log.some(r => [E.FIRE, E.SMOKE, E.CO2].includes(cid(r.host.core))), 'flame, smoke or CO2 left behind in its air');
  assert(out.log.some(r => r.faces.some(m => cid(m.core) === E.FIRE)), 'and flames in the air beside it');
}
// ...and not into air that CO2 smothers (ctSmothered: CO2 at 30% of the gas around it).
{
  let burning = packet(E.SAWDUST, 400); burning.core[1] |= 1 << 24;
  const out = fly(burning, () => air(20), 200, () => six(() => makeMaterial(E.CO2, 20)));
  assert(!out.log.some(r => cid(r.host.core) === E.FIRE || r.faces.some(m => cid(m.core) === E.FIRE)), 'no flame licks into smothered air');
}
// 7b. Ambient heat off (V1 react.js): matter trades no heat with air, so a hot stone flies unchanged.
{
  const off = { ambient: 20, ambientHeat: 0 }, on = { ambient: 20, ambientHeat: 1 };
  const stone = packet(E.STONE, 400);
  assert.equal(T(airborneReference(stone, air(20), 7, openNear(), off).particle.core), 400, 'no exchange with air');
  assert(T(airborneReference(stone, air(20), 7, openNear(), on).particle.core) < 400, 'with it on, the stone cools into the air');
}
// 7c. A flying gas radiates toward the scene's ambient by its rad (ctAmbient), even with no air to touch.
{
  const off = { ambient: 20, ambientHeat: 0 };
  const steam = packet(E.STEAM, 300), r = airborneReference(steam, air(20), 7, openNear(), off);
  assert(T(r.particle.core) < 300 && T(r.particle.core) > 20, 'steam cools toward ambient');
}
// 8. Reactions with what it passes through: a water drop through caustic gas absorbs it as acid (elements.js REACTIONS).
{
  const out = fly(packet(E.WATER, 20, FULL / 4), () => makeMaterial(E.CAUSTIC_GAS, 20), 600);
  assert.equal(key(out.p.core), 'ACID');
}
// 9. Detonation is a cell's event: a charge set off in flight lands where it is, in air...
{
  const r = airborneReference(packet(E.GUNPOWDER, 400), air(20), 3, openNear());
  assert.equal(r.state, AIRBORNE.LANDED); assert.equal(cid(r.host.core), E.GUNPOWDER, 'the charge is the host cell now');
  assert.equal(r.requests & 1, 1, 'and its detonation request is posted there, for this tick\'s blasts');
}
// ...or in the flames that set it off, the fire flying on in its place.
{
  const out = fly(packet(E.GUNPOWDER, 20), fire, 600);
  assert.equal(out.r.state, AIRBORNE.DISPLACED); assert.equal(cid(out.r.host.core), E.GUNPOWDER); assert.equal(cid(out.r.particle.core), E.FIRE);
}
// 9b. Set off by a hit (particles.js dShockHit marks it): a C-4 lump lands with its detonation where it is,
// in air or in a gas (the gas flying on); without the mark it flies on, inert.
{
  const lump = packet(E.C4, 20);
  assert.equal(airborneReference(lump, air(20), 3, openNear()).state, AIRBORNE.FLYING);
  const r = airborneReference(lump, air(20), 3, openNear(), undefined, { ...AIRBORNE_NO_CHARGE, setOff: true });
  assert.equal(r.state, AIRBORNE.LANDED); assert.equal(cid(r.host.core), E.C4); assert.equal(r.requests & 1, 1);
  const smoke = airborneReference(lump, makeMaterial(E.SMOKE, 20), 3, openNear(), undefined, { ...AIRBORNE_NO_CHARGE, setOff: true });
  assert.equal(smoke.state, AIRBORNE.DISPLACED); assert.equal(cid(smoke.host.core), E.C4); assert.equal(cid(smoke.particle.core), E.SMOKE);
  // the smoke flies on in the lump's slot, under its id: it is no charge, and react clears the mark there
  assert.equal(airborneReference(smoke.particle, air(20), 3, openNear(), undefined, { ...AIRBORNE_NO_CHARGE, setOff: true }).requests & 1, 0);
  assert.match(particlesWGSL(gridLayout(32, 32, 32), nativeDynamicsHead, 'react'), /if \(r\.state == D_REACT_LANDED \|\| r\.state == D_REACT_DISPLACED\) \{ atomicStore\(&control\[D_SET_OFF\+t\],0u\); \}/);
}
// 9b'. Set off by the pressure on it (V1 react.js setOff: more than its blast.crushP of the highest air
// pressure on it, its own and its open neighbours'): a flying explosive goes off as a resident one does
// (blasts.js couplePlan), landing with its detonation where it is; at its crushP or under it flies on, and
// matter with no crushP never does. A blast's ejecta can't carry its explosive out past its own pressure.
{
  for (const [name, host] of [['NITRO', air(20)], ['NITRO', makeMaterial(E.SMOKE, 20)], ['C4', air(20)], ['TNT', air(20)]]) {
    const crush = dynamicsRows[E[name]].crush, charge = p => ({ ...AIRBORNE_NO_CHARGE, pressure: p });
    assert.ok(crush > 0, `${name} has a crushP`);
    const lump = packet(E[name], 20);
    const over = airborneReference(lump, host, 3, openNear(), undefined, charge(crush * 1.01));
    assert.equal(over.requests & 1, 1, `${name} under more than its crushP: its detonation`);
    assert.equal(cid(over.host.core), E[name], `${name} lands in its host cell to go off there`);
    assert.equal(over.state, cid(host.core) === E.EMPTY ? AIRBORNE.LANDED : AIRBORNE.DISPLACED, `${name} in ${key(host.core)}`);
    for (const p of [crush, crush * 0.99, 0, -crush * 2]) {
      const r = airborneReference(lump, host, 3, openNear(), undefined, charge(p));
      assert.equal(r.requests & 1, 0, `${name} at ${p} Pa (its crushP ${crush}) is not set off`); assert.equal(r.state, AIRBORNE.FLYING);
    }
  }
  // a partial fill of nitroglycerin is as sensitive as a full one (its crushP is the element's)
  assert.equal(airborneReference(packet(E.NITRO, 20, FULL >> 3), air(20), 3, openNear(), undefined, { ...AIRBORNE_NO_CHARGE, pressure: dynamicsRows[E.NITRO].crush * 2 }).requests & 1, 1);
  // matter with no crushP flies on through any pressure (water, and gunpowder: V1 sets it off by heat alone)
  for (const id of [E.WATER, E.GUNPOWDER, E.SAND]) assert.equal(airborneReference(packet(id, 20), air(20), 3, openNear(), undefined, { ...AIRBORNE_NO_CHARGE, pressure: 1e9 }).requests & 1, 0, ELEMENTS[id].key);
  // the react stage reads that pressure for a charge with a crushP, as couplePlan reads a resident cell's,
  // and dReact compares it with the same table
  const react = particlesWGSL(gridLayout(32, 32, 32), nativeDynamicsHead, 'react');
  assert.ok(react.includes('if (dCrush(chargeId) > 0.0 && mAirPressure()) {\n    var on = -1e30; if (cls(chargeId) != C_SOLID) { on = dPressureCell(p); }\n    for (var f = 0u; f < 2u * dAxes(); f++) { on = max(on, dOpenPressure(p + face6(i32(f)))); }\n    charge.pressure = on;'), 'react reads the pressure on a charge');
  assert.ok(react.includes('let crushed = dCrush(u32(v.id)) > 0.0 && charge.pressure > dCrush(u32(v.id));'), 'dReact sets it off past its crushP');
  assert.ok(react.includes('(charge.setOff || crushed)'), 'as a hit does');
  assert.equal(react.match(/fn dPressureCell\(/g).length, 1, 'the blasts\' own pressure read');
  const plan = blastsWGSL(gridLayout(32, 32, 32), nativeDynamicsHead, 'couplePlan');
  for (const read of [pressureCellWGSL(), pressureOnWGSL(), crushWGSL]) assert.ok(react.includes(read) && plan.includes(read), 'one pressure read for resident cells and flying ones');
}
// 9c. A dust cloud (V1 react.js dust clouds, physics.js DUST_*): wind-blown dust, faster than DUST_LIFT_V,
// with dust beside it and air enough, goes off as one when lit, landing with its detonation; lean, rich,
// settling or unlit, it does not.
{
  const mote = packet(E.DUST, 20), fast = DUST_MIN_FALL_SPEED * 1.5;
  const cloud = { ...AIRBORNE_NO_CHARGE, speed: fast, dust: 2, fire: 1 };
  // rich: smoke on every face, so its host, behind it, is the only air among its six contacts
  const rich = nearOf(six(() => makeMaterial(E.SMOKE, 20)), [0, 0, 0], [0, 0, 0], [1, 0, 0]);
  const lit = airborneReference(mote, air(20), 5, openNear(), undefined, cloud);
  assert.equal(lit.state, AIRBORNE.LANDED); assert.equal(cid(lit.host.core), E.DUST); assert.equal(lit.requests & 1, 1, 'a flame beside the cloud');
  for (const [why, charge, outside] of [
    ['settling (dust\'s own terminal speed, 3 m/s, is under the lift speed)', { ...cloud, speed: DUST_MIN_FALL_SPEED * 0.9 }, openNear()],
    ['lean: no dust beside it', { ...cloud, dust: 0 }, openNear()],
    ['rich: one air face', cloud, rich],
    ['unlit', { ...cloud, fire: 0 }, openNear()],
  ]) {
    const r = airborneReference(mote, air(20), 5, outside, undefined, charge);
    assert.equal(r.requests & 1, 0, why); assert.equal(r.state, AIRBORNE.FLYING, why);
  }
  // lit by matter at its ignition point beside it, by its own heat, or by the flame it flies through
  assert.equal(airborneReference(mote, air(20), 5, openNear(), undefined, { ...cloud, fire: 0, hot: 1 }).requests & 1, 1);
  // (its own heat past what a tick's exchange with the three air cells it pairs with takes: 5 °C over
  // its ignition point it cools under it first, as V1's mover did with its six)
  assert.equal(airborneReference(packet(E.DUST, ELEMENTS[E.DUST].ignite + 50), air(20), 5, openNear(), undefined, { ...cloud, fire: 0 }).requests & 1, 1);
  const inFlame = airborneReference(mote, fire(), 5, openNear(), undefined, { ...cloud, fire: 0 });
  assert.equal(inFlame.state, AIRBORNE.DISPLACED); assert.equal(cid(inFlame.host.core), E.DUST);
  // the faces as react reads them (shaders/v2/airborne.js dReactDustFaces)
  const faces = [fire().core, makeMaterial(E.STONE, ELEMENTS[E.DUST].ignite + 1).core, makeMaterial(E.STONE, 20).core, makeMaterial(E.SMOKE, 900).core, air().core, air().core];
  assert.deepEqual(dustFacesOf(faces), [1, 1], 'a flame face; hot matter, not hot gas');
  assert.deepEqual(dustFacesOf([...faces.slice(0, 5), null]), [1, 1], 'beyond the box: its wall, cold');
  // with the six cells around it: a dust cloud's air is its six contacts', counted as its own step counts them
  const airy = six(() => air()); airy[0] = makeMaterial(E.SMOKE, 20);
  assert.equal(airborneReference(mote, air(20), 5, nearOf(airy, [0, 0, 0], [0, 0, 0], [1, 0, 0]), undefined, cloud).requests & 1, 1, 'five air contacts are air enough');
}
// 10. Smothered: no burning in CO2.
{
  let burning = packet(E.SAWDUST, 400); burning.core[1] |= 1 << 24;
  const co2 = () => makeMaterial(E.CO2, 20);
  const r = airborneReference(burning, co2(), 5, nearOf(six(co2), CELL, [0, 0, 0], FALLING));
  assert.equal((r.particle.core[1] >>> 24) & 1, 0, 'CO2 puts it out (ctStepAtmosphere smothered)');
}

// ---- with the cells beside it (V1's mover saw all six; these fail with the host alone) ----
// The +x face is a partner at CELL with offset 0 (inBlockFaces), the -x face is not.
const nearX = (faces, offset = [0, 0, 0]) => nearOf(faces, CELL, offset, FALLING);
// 11. A hot solid beside it: a cold stone flying past a hot wall warms, the wall cools, exactly (V1 react.js condFlux).
{
  const faces = openFaces(); faces[0] = makeMaterial(E.STONE, 1000);
  const stone = packet(E.STONE, 20), host = air(20);
  const r = airborneReference(stone, host, 11, nearX(faces));
  assert(T(r.particle.core) > 20, `it warms from the wall beside it (${T(r.particle.core)} °C)`);
  assert(T(r.faces[0].core) < 1000, 'the wall cools');
  assert.equal(packetOwnedEnergy(r.particle) + energyOf(r.host) + sum(r.faces), packetOwnedEnergy(stone) + energyOf(host) + sum(faces));
  // along its whole pass, it nears the wall's temperature as V1's cell beside it would
  const out = fly(packet(E.STONE, 20), () => air(20), 240, withFace(0, () => makeMaterial(E.STONE, 1000)));
  assert(T(out.p.core) > 200, `a second along a 1000 °C wall: ${T(out.p.core).toFixed(0)} °C`);
  // the face out of its block this tick waits for its turn
  const later = six(() => air()); later[1] = makeMaterial(E.STONE, 1000);
  assert.equal(T(airborneReference(packet(E.STONE, 20), air(20), 11, nearX(later)).particle.core), 20, 'no exchange with a face out of its block');
}
// 12. Ignition from a flame beside it: sawdust flying along a flame catches (V1 react.js nFire; contact.js hotFront).
{
  const out = fly(packet(E.SAWDUST, 20), () => air(20), 120, withFace(0, fire));
  assert(out.log.some(r => cid(r.particle.core) === E.SAWDUST && ((r.particle.core[1] >>> 24) & 1)), 'it catches from the flame beside it');
}
// 13. Ignition from a hot solid beside it: a gunpowder charge flying past a 600 °C stone goes off
// (V1 react.js hotTouch: a non-gas neighbour past its ignition point), landing where it is.
{
  const faces = openFaces(); faces[0] = makeMaterial(E.STONE, 600);
  const r = airborneReference(packet(E.GUNPOWDER, 20), air(20), 13, nearX(faces));
  assert.equal(r.state, AIRBORNE.LANDED, 'set off by the hot stone it touched'); assert.equal(r.requests & 1, 1);
  assert.equal(airborneReference(packet(E.GUNPOWDER, 20), air(20), 13, nearX(openFaces())).state, AIRBORNE.FLYING, 'in open air it flies on');
}
// 14. Reactions with a cell beside it: a water drop past caustic gas turns acid; an acid drop past
// a stone wall eats it (ctAcid: V1 react.js acidEats), the wall's cell air or smoke after.
{
  const out = fly(packet(E.WATER, 20, FULL / 4), () => air(20), 600, withFace(0, () => makeMaterial(E.CAUSTIC_GAS, 20)));
  assert.equal(key(out.p.core), 'ACID', 'it reacts with the gas beside it');
  // A drop spends its life on the wall, eaten or not (ctAcid; V1 react.js ACIDIC), so as V1's cell
  // (1 - ACID_USE)^34 ≈ a third of drops are used up first: of eight drops, some eat it.
  const drops = Array.from({ length: 8 }, (_, d) => fly(packet(E.ACID, 20, FULL), () => air(20), 600, withFace(0, () => makeMaterial(E.STONE, 20), true), { t0: 97 * d }));
  const ate = d => d.log.some(r => [E.EMPTY, E.SMOKE].includes(cid(r.faces[0].core)));
  assert(drops.some(ate), 'the acid eats the wall it flies along');
  // the rest are used up on it: in the partnered tick holding V1's 34th step, 5 of its partnered ticks
  assert(drops.some(d => !ate(d)), 'some are used up first');
  for (const d of drops) if (!ate(d)) assert.ok(d.tick < 12 && (d.r.state === AIRBORNE.GONE || [E.EMPTY, E.SMOKE].includes(cid(d.p.core))), `used up on the wall by tick ${d.tick}`);
}
// 15. An acid pool beside it eats a packet flying low over it.
{
  const out = fly(packet(E.SAWDUST, 20), () => air(20), 600, withFace(3, () => makeMaterial(E.ACID, 20, FULL)));
  assert(out.r.state === AIRBORNE.GONE || [E.EMPTY, E.SMOKE].includes(cid(out.r.particle.core)), 'eaten by the pool below it');
}
// 16. Condensing onto a surface beside it: steam next to a cold wall condenses to water (V1 react.js
// surface), where in open air it makes cloud.
{
  const wall = fly(packet(E.STEAM, 100), () => air(20), 4000, withFace(0, () => makeMaterial(E.STONE, -20)));
  assert.equal(key(wall.p.core), 'WATER', 'steam condenses on the wall beside it');
}
// 17. Out of the grid: a face beyond the box is no partner, and on the solid floor the floor is a surface.
{
  const faces = openFaces(); faces[3] = null;
  const r = airborneReference(packet(E.STONE, 500), air(20), 3, nearOf(faces, [5, 0, 5], [0, 0, 0], FALLING, 1));
  assert.equal(r.faces[3], null, 'nothing beyond the box');
}

// 18. Electricity with its six contacts (V1 react.js runs it on all six faces every step; contact.js
// ctElecAirborne, its steps a tick): a metal packet flying past a battery is sparked, on a face it
// pairs with this tick or not; in open air its spark only runs down. These fail with the host alone.
{
  const fresh = (id, t) => packContact(ctNew(id, Math.round((t + 273.25) * 4), 65536));
  for (const f of [0, 1, 3]) {
    const faces = openFaces(); faces[f] = makeMaterial(E.BATTERY, 20);
    const r = airborneReference(fresh(E.METAL, 20), air(20), 21, nearX(faces));
    assert(unpackContact(r.particle.core, r.particle.bank).spark > 0, `sparked by a battery on face ${f}`);
  }
  assert.equal(unpackContact(airborneReference(fresh(E.METAL, 20), air(20), 21, nearX(openFaces())).particle.core).spark, 0, 'in open air, nothing');
  // an unlit fuse flying past stone at its ignition point lights (V1 react.js FUSE: anything not gas)
  const fuse = fresh(E.FUSE, 20), hot = openFaces(); hot[1] = makeMaterial(E.STONE, ELEMENTS[E.FUSE].ignite + 50);
  const lit = airborneReference(fuse, air(20), 23, nearX(hot));
  assert(unpackContact(lit.particle.core).life < unpackContact(fuse.core).life, 'lit by the hot stone beside it');
  assert.equal(unpackContact(airborneReference(fuse, air(20), 23, nearX(openFaces())).particle.core).life, unpackContact(fuse.core).life, 'in open air it stays unlit');
}
// 19. The puff of gas a reaction at one of its faces sets free rides its gas request to its host
// (contact.js ctPuff; blasts.js airborneEvents posts it): lithium flying past water.
{
  const out = fly(packet(E.LITHIUM, 20), () => air(20), 600, withFace(0, () => makeMaterial(E.WATER, 20, FULL)));
  assert(out.log.some(r => (r.requests & 2) && r.requests >= CONTACT_PUFF_UNIT), 'its gas and its puff are posted at its host');
}

// ---- every packet of a crowded cell, in an order no replay changes ----
// The react stage's CPU twin (particles.js reactClaim, react): every packet in air or gas joins its
// host's list in whatever order the GPU's claims land; then a colour at a time, each host of the
// colour takes its packets in airborneOrder, each seeing what the one before left. The hosts of a
// colour run in whatever order the GPU schedules them. hostOrder and claimOrder stand for those.
const dHash = x0 => { let x = x0 >>> 0; x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0; x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0; return (x ^ (x >>> 16)) >>> 0; };
const dKey = (id, tick) => dHash((id ^ Math.imul(tick, 2654435761)) >>> 0);
function stage(world, packets, tick, { claimOrder = x => x, hostOrder = x => x, colours = AIRBORNE_COLOURS, colour = colourOf, onePerCell = false } = {}) {
  const { dims } = world, cells = world.cells.map(m => m && { core: new Uint32Array(m.core), bank: m.bank });
  const index = p => p[0] + dims[0] * (p[1] + dims[1] * p[2]);
  const lists = new Map();
  for (const t of claimOrder(packets.map((_, i) => i))) {
    const q = packets[t]; if (!q) continue;
    const p = q.position.map(Math.floor), kind = ELEMENTS[cid(cells[index(p)].core)].kind;
    if (kind !== K.EMPTY && kind !== K.GAS) continue;
    const entry = { slot: t, key: dKey(q.id ^ AIRBORNE.SALT, tick), hash: q.hash ?? 0 };
    if (!lists.has(index(p))) lists.set(index(p), { p, entries: [] });
    lists.get(index(p)).entries.push(entry);
  }
  const out = packets.map(q => q && { ...q }), offset = offsetOf(tick);
  let reacted = 0;
  for (let c = 0; c < colours; c++) {
    for (const { p, entries } of hostOrder([...lists.values()].filter(l => colour(l.p) % colours === c))) {
      const ordered = [...entries].sort(airborneOrder);
      for (const e of onePerCell ? ordered.slice(0, 1) : ordered) {
        const host = cells[index(p)], kind = ELEMENTS[cid(host.core)].kind;
        if (kind !== K.EMPTY && kind !== K.GAS) break;
        const q = out[e.slot];
        const faces = FACE6.map(d => { const n = p.map((v, a) => v + d[a]); return n.every((v, a) => v >= 0 && v < dims[a]) ? cells[index(n)] : null; });
        const r = airborneReference(q.material, host, e.key | 0, nearOf(faces, p, offset, q.velocity, 0));
        if (r.state === AIRBORNE.REFUSED) continue;
        reacted++;
        cells[index(p)] = r.host;
        FACE6.forEach((d, f) => { if (r.faces[f]) cells[index(p.map((v, a) => v + d[a]))] = r.faces[f]; });
        out[e.slot] = r.state === AIRBORNE.FLYING || r.state === AIRBORNE.DISPLACED ? { ...q, material: r.particle } : null;
      }
    }
  }
  return { cells, packets: out, reacted };
}
const dims = [12, 8, 12], cellCount = dims[0] * dims[1] * dims[2];
const at = (world, p) => world.cells[p[0] + dims[0] * (p[1] + dims[1] * p[2])];
function scene(fill) {
  const cells = Array.from({ length: cellCount }, (_, i) => fill([i % dims[0], Math.floor(i / dims[0]) % dims[1], Math.floor(i / dims[0] / dims[1])]));
  return { dims, cells };
}
const state = r => JSON.stringify({ cells: r.cells.map(m => m && [...m.core, m.bank]), packets: r.packets.map(q => q && [...q.material.core, q.material.bank]) });
const rotate = k => xs => xs.slice(k).concat(xs.slice(0, k)), reverse = xs => [...xs].reverse();
// 20. A dense spray: eight water drops in one flame cell all take part every tick (V1 had a cell for
// each), each seeing the flame as the one before left it; one a cell, as before, boils one at a time.
{
  const world = scene(p => (p[0] === 5 && p[1] === 4 && p[2] === 5 ? fire() : air(20)));
  const drops = Array.from({ length: 8 }, (_, i) => ({ id: 1000 + i, hash: i, position: [5.5, 4.5, 5.5], velocity: [0.1 * i, -1, 0], material: packet(E.WATER, 20, FULL / 8) }));
  const r = stage(world, drops, 1), one = stage(world, drops, 1, { onePerCell: true });
  assert.equal(r.reacted, 8, 'all eight take part'); assert.equal(one.reacted, 1, 'one a cell, before');
  // numbers for the report: ticks until every drop has boiled, with a fresh flame each tick
  const boil = opts => { let qs = drops.map(q => ({ ...q })); for (let t = 1; t <= 4000; t++) {
    qs = stage(world, qs, t, opts).packets; if (qs.every(q => !q || cid(q.material.core) !== E.WATER)) return t; } return Infinity; };
  const all = boil({}), single = boil({ onePerCell: true });
  console.log(`dense spray, 8 drops in one flame: all boiled in ${all} ticks with every packet taking part, ${single} with one a cell`);
  assert(all * 2 < single, 'crowding no longer slows them');
}
// 21. The same result in any order the GPU's claims land and its threads run, with neighbours shared:
// drops in neighbouring cells along a hot wall and a flame (their footprints overlap).
{
  const world = scene(p => (p[1] === 2 ? makeMaterial(E.STONE, 900) : p[0] === 7 && p[1] === 4 ? fire() : air(20)));
  const drops = [];
  for (let x = 3; x < 9; x++) for (let z = 3; z < 8; z++) for (let k = 0; k < 2; k++)
    drops.push({ id: 7 * x + 131 * z + k, hash: k, position: [x + 0.5, 3.5 + (k ? 1 : 0), z + 0.5], velocity: [1, -2 + k, 0.5], material: packet(k ? E.SAWDUST : E.WATER, 20, k ? FULL : FULL / 8) });
  for (let tick = 1; tick <= 3; tick++) {
    const base = state(stage(world, drops, tick));
    for (const opts of [{ claimOrder: reverse }, { claimOrder: rotate(5) }, { hostOrder: reverse }, { hostOrder: rotate(3), claimOrder: rotate(7) }]) {
      assert.equal(state(stage(world, drops, tick, opts)), base, `tick ${tick}: the same in any claim and thread order`);
    }
    // ...which needs the colours: hosts whose footprints overlap, run together, depend on the order
    const together = { colours: 1, colour: () => 0 };
    if (tick === 1) assert.notEqual(state(stage(world, drops, tick, { ...together, hostOrder: reverse })), state(stage(world, drops, tick, together)),
      'run as one dispatch, neighbours\' reads race');
  }
}

// ---- the generated stages: Naga, the particle family's eight buffers, the whole contact table ----
const table = new Uint32Array(v2Table().buffer).length;
let modules = 0;
for (const dims of [[32, 32, 32], [48, 16, 32]]) {
  const g = gridLayout(...dims);
  for (const stage of ['reactClaim', 'reactDust', 'react']) {
    const code = particlesWGSL(g, nativeDynamicsHead, stage);
    assert([...code.matchAll(/var<storage,/g)].length <= 8, `${stage} storage budget`);
    assertNaga(code, `particles/${stage} ${dims}`); modules++;
  }
  const claim = particlesWGSL(g, nativeDynamicsHead, 'reactClaim');
  assert.match(claim, /let next = atomicExchange\(&claims\[s\*4u\],t\+1u\); atomicAdd\(&claims\[s\*4u\+1u\],1u\);/, 'each packet joins its cell\'s list, counted');
  const react = particlesWGSL(g, nativeDynamicsHead, 'react');
  assert.match(react, new RegExp(`const EV = array<vec4u, ${Math.ceil(table / 4)}>`), 'the rule stage reads the contact rows (EV tail)');
  assert.doesNotMatch(react, /arrayLength\(&events\)/, 'no block storage in the particle family');
  for (const rule of ['ctFlux(v, b)', 'ctReaction(v, b, s)', 'ctStepAtmosphere(v, ps,', 'ctResolvePhase(v, ps[a])', 'ctLick(ps[a], 1,', 'ctAmbient(v, ambientQ, airHeat)', 'ctConducts(v, b, airHeat)']) assert(react.includes(rule), `the packet runs ${rule}`);
  assert(react.includes('fn ctNeighborCount()->i32 { return i32(min(3u,arrayLength(&flight))); }'), 'the rules\' neighbour loops bound at run time, not unrolled');
  assert.match(react, /let q = mEdge\(p \+ face6\(i32\(f\)\)\);/, 'it reads its host\'s six faces');
  assert.match(react, /storeMaterial\(slots\[f\],was,now\);/, 'and writes back what changed there');
  assert.match(react, /dReactColour\(p\) != \(P\.airborne >> D_REACT_OFFSET_BITS\) \|\| atomicLoad\(&claims\[s\*4u\]\) != t\+1u/, 'one thread a cell, a colour at a time');
  assert.match(react, /for \(var k = 0u; k < count && at != 0u; k\+\+\)/, 'which takes every packet in its cell\'s list, and no more');
  assert.match(react, new RegExp(`const D_REACT_COLOURS = array<u32, 64>\\(${AIRBORNE_COLOUR_TABLE.map(c => `${c}u`).join(',')}\\);`), 'the CPU\'s colouring');
}
assert(['reactClaim', 'reactDust', 'react'].every(s => PARTICLE_STAGES.includes(s)));
assert('airborne' in DynamicParams.offsets, 'the react stage\'s offset and colour ride its params');
// the requests' posting stage (blasts family: it binds events) and its control words
for (const dims of [[32, 32, 32], [48, 16, 32]]) {
  const g = gridLayout(...dims), code = blastsWGSL(g, nativeDynamicsHead, 'airborneEvents');
  assertNaga(code, `blasts/airborneEvents ${dims}`); modules++;
  assert.match(code, /let request = \(\(events\[s\] \| bits\) & 255u\) \| \(max\(events\[s\] \/ 256u, puff\) \* 256u\);\n\s*events\[s\] = request; noteEvents\(s, request\);/, 'posted as the block pass posts a cell\'s requests (ctMergeRequest: flags together, the larger puff)');
  assert.equal(airborneBase(g), heldBase(g) + PARTICLE_CAP); assert.equal(airbornePuffBase(g), airborneBase(g) + 1 + PARTICLE_CAP);
  assert.equal(shockPostBase(g), airbornePuffBase(g) + PARTICLE_CAP); assert.equal(setOffBase(g), shockPostBase(g) + 1 + PARTICLE_CAP);
  assert.equal(externalBlastBase(g), setOffBase(g) + PARTICLE_CAP, 'its words overlap no other range');
}
assert(BLAST_STAGES.includes('airborneEvents'));

// ---- the real driver records them every tick, after the landings, a colour at a time ----
globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
const calls = [];
const copy = (b, offset, src) => { const u = src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength); new Uint8Array(b.bytes).set(u, offset); };
const gpu = { createBuffer: ({ size, label }) => ({ size, label, bytes: new ArrayBuffer(size), destroy() {} }), queue: { writeBuffer: copy }, write: copy,
  layout: (_n, l) => l, bindGroup: (_l, b) => b, frame: { clear() {}, copy() {} },
  kernel: d => ({ name: d.name, ready: Promise.resolve(), dispatch: (_f, size, opts) => { d.params.pack(opts.params); calls.push({ name: d.name, airborne: opts.params.airborne }); } }) };
const g = gridLayout(16, 8, 8);
const owner = { gpu, g, epoch: 0, tick: 1, sim: { origin: { x: 0, y: 0, z: 0 }, header: () => ({}) },
  nativeDynamics: { head: () => '', layout: [], group: [] }, wake() {}, _params: t => ({ offset: offsetOf(t) }) };
owner.events = gpu.createBuffer({ size: g.slots * 4, label: 'events' });
const d = new NativeDynamics(owner); await d.ready;
const TICK = 13;
d.advanceParticles(TICK);
const names = calls.map(c => c.name), last = name => names.lastIndexOf(`v2particles_${name}`);
assert(last('reactClaim') > last('deposit'), 'after this tick\'s landings');
const reacts = calls.filter(c => c.name === 'v2particles_react');
assert.deepEqual(reacts.map(c => c.airborne), Array.from({ length: AIRBORNE_COLOURS }, (_, c) => packAirborne(offsetOf(TICK), c)),
  'a react dispatch a colour, with the block pass\'s partition offset this tick');
assert(names.indexOf('v2particles_react') > last('reactDust') && last('reactDust') > last('reactClaim') && !names.slice(last('reactClaim')).includes('v2particles_elect'),
  'claim, the dust clouds\' faces once every packet has claimed, then react: no election');
assert(names.lastIndexOf('v2blasts_airborneEvents') > last('react'), 'then their requests are posted, before the grid passes read them');
console.log(`airborne matter: conduction, boiling, melting, setting, burning, plume, reactions, smothering, detonation with its host and the six cells around it, all exact; every packet of a crowded cell, the same in any order; ${modules} stage modules validated; driver records them a colour at a time; no GPU`);
