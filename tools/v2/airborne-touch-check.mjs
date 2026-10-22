// CPU only (no GPU, no browser): the grid's cells see the flying packets beside them, as V1's react pass
// saw a moving neighbour (src/shaders/react.js: nFire, hotTouch, nBurning; V1 had no flying state, so a
// splash or an ember was a cell like the rest). The packet's side is the react stage's (v2/airborne.js
// airborneReference: its touch on each face, contact.js ctPacketTouch), which marks each face cell; the
// cell's side is its own step in the block pass (contact.js ctStepAtmosphere's touch: contactReference's
// twin of contactBlock) and, for a fuse, the electric pass's (ctFuseTouch). Checks the two CPU twins end
// to end (an explosive set off by a hot packet's touch or by a flame's at its blast.flame chance, a fuel NOT
// lit by a burning packet beside it (V1 has no contact ignition), air catching from a flame past a fuel's flash
// point, a fuse lit from any face), the marks' layout and stamp, and that the block, react and electric
// stages carry the marks (Naga).
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { gridLayout } from '../../src/sim.js';
import { makeMaterial, FULL } from '../../src/v2/layout.js';
import { airborneReference, nearOf, FACE6 } from '../../src/v2/airborne.js';
import * as C from '../../src/v2/contact.js';
import { auxLayout, packetTouchWGSL, PACKET_TOUCH_STAMP_SHIFT, PACKET_TOUCH_STAMP_BITS } from '../../src/shaders/v2/state.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { v2BlockWGSL } from '../../src/shaders/v2.js';
import { particlesWGSL, PARTICLE_CAP } from '../../src/shaders/v2/particles.js';
import { nativeDynamicsHead } from '../../src/shaders/v2.js';
import { v2ElecGatherWGSL } from '../../src/shaders/v2/electric.js';
import { assertNaga } from './wgsl-grouping.mjs';

const K = C.CONTACT_CONSTANTS, bit = key => K[key][1];
const FLAME = bit('CT_TOUCH_FLAME'), HOT = bit('CT_TOUCH_HOT');
const q = T => Math.round((T + 273.25) * 4);
const cell = (id, T = ELEMENTS[id].temp) => C.ctNew(id, q(T), 65536);
const air = (t = 20) => makeMaterial(E.EMPTY, t, 0);
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }

// The packet flies down through the host at CELL in the block partition offset 0: its block partners are
// its +x, +y and +z faces (v2/airborne.js inBlockFaces), the +y one behind it holding its host.
const CELL = [5, 5, 5], OFFSET = [0, 0, 0], FALLING = [0, -3, 0], PX = 0, MX = 1, PZ = 4;
const hotStone = () => makeMaterial(E.STONE, 400, FULL);
function touchOn(packet, faceAt, host = air()) {
  const faces = FACE6.map((_, f) => faceAt(f) ?? air());
  return airborneReference(packet, host, 7, nearOf(faces, CELL, OFFSET, FALLING)).touch;
}
// The grid cell beside it in the block pass: cell 1 of an eight-cell block whose cell 0 is the packet's host
// (its x partner) and the rest air (contactReference, contactBlock's CPU twin), with its touch this tick.
function gridStep(id, T, touch, tick = 0, others = []) {
  const cores = Array.from({ length: 8 }, () => air().core);
  cores[1] = makeMaterial(id, T, FULL).core;
  for (const [i, m] of others) cores[i] = m.core;
  const marks = Array(8).fill(0); marks[1] = touch;
  return C.contactReference(cores.map(c => new Uint32Array(c)), new Int32Array(8), tick, undefined, undefined, undefined, undefined, undefined, marks);
}
const detonates = r => (r.requests[1] & 1) !== 0;

test('a packet is to the cells beside it what V1\'s moving cell was: its flame, burning and heat (ctPacketTouch)', () => {
  // a hot stone on its +x partner face: hot to C-4 (V1 react.js hotTouch: matter at its ignition point)
  const t = touchOn(hotStone(), f => (f === PX ? makeMaterial(E.C4, 20, FULL) : null));
  assert.equal(t[PX], HOT);
  // not on the face its host stands in, nor on a face that is not its block partner (the -x face)
  const both = touchOn(hotStone(), f => (f === PX || f === MX ? makeMaterial(E.C4, 20, FULL) : null));
  assert.equal(both[MX], 0);
  // a cold stone touches nothing; neither does a hot one beside stone, which doesn't burn
  assert.equal(touchOn(makeMaterial(E.STONE, 20, FULL), f => (f === PX ? makeMaterial(E.C4, 20, FULL) : null))[PX], 0);
  assert.equal(touchOn(hotStone(), f => (f === PX ? makeMaterial(E.STONE, 20, FULL) : null))[PX], 0);
  // a flame: a flame on every face but its host's (V1 react.js nFire counts FIRE on all six), partner or not
  const flame = makeMaterial(E.FIRE, 900, FULL);
  const ft = touchOn(flame, f => (f === PX || f === PZ || f === MX ? makeMaterial(E.WOOD, 20, FULL) : null));
  for (const f of [PX, PZ, MX]) assert.equal(ft[f], FLAME, `face ${f}: a flame, nothing else (no burning front)`);
  // in a flame's own cell the face already sees a flame there: no second one
  assert.equal(touchOn(flame, f => (f === PX ? makeMaterial(E.WOOD, 20, FULL) : null), makeMaterial(E.FIRE, 900, FULL))[PX] & FLAME, 0);
  // a burning ember is no flame to it (V1 nFire), only its heat to what goes off by heat
  const ember = makeMaterial(E.WOOD, 600, FULL); ember.core[1] |= 1 << 24;
  assert.equal(touchOn(ember, f => (f === PX ? makeMaterial(E.WOOD, 20, FULL) : null))[PX], HOT);
  // a fuse reads all six faces (the electric pass): the -x face too
  const fuse = touchOn(flame, f => (f === MX ? makeMaterial(E.FUSE, 20, FULL) : null));
  assert.ok(fuse[MX] & FLAME);
});

test('an explosive beside a hot packet goes off by its touch (V1 react.js explosives: hotTouch)', () => {
  const t = touchOn(hotStone(), f => (f === PX ? makeMaterial(E.C4, 20, FULL) : null))[PX];
  assert.ok(detonates(gridStep(E.C4, 20, t)), 'the C-4 the hot stone flies past');
  assert.ok(!detonates(gridStep(E.C4, 20, 0)), 'without it: nothing');
  // a mark only says what was there: C-4 touched by matter under its ignition point does not go off
  assert.ok(!detonates(gridStep(E.C4, 20, touchOn(makeMaterial(E.STONE, 200, FULL), f => (f === PX ? makeMaterial(E.C4, 20, FULL) : null))[PX])));
});

test('an explosive beside a flying flame goes off at its blast.flame chance a step (V1 react.js nFire, BLAST_LIT)', () => {
  const flame = makeMaterial(E.FIRE, 900, FULL);
  const t = touchOn(flame, f => (f === PX ? makeMaterial(E.GUNPOWDER, 20, FULL) : null))[PX];
  assert.ok(t & FLAME);
  const chance = C.ctRow(E.GUNPOWDER).blastChance;
  assert.ok(chance > 0 && chance < 1);
  // ticks whose draw lies under the chance: set off with the flame beside it, never without
  let fired = 0, tried = 0;
  for (let tick = 0; tick < 400; tick++) {
    const r = gridStep(E.GUNPOWDER, 20, t, tick);
    assert.ok(!detonates(gridStep(E.GUNPOWDER, 20, 0, tick)));
    tried++; if (detonates(r)) fired++;
  }
  assert.ok(Math.abs(fired / tried - chance) < 0.05, `${fired}/${tried} against ${chance}`);
});

test('a cold fuel beside a burning packet does not catch (V1: heat, not touch); air beside a flame past a fuel\'s flash point catches', () => {
  // a burning wood ember flying past a wood wall: V1 react.js lights a fuel only at its ignition point (or its
  // flash point with a flame face); the ember's heat reaches it by conduction, its flames by the air between
  const ember = makeMaterial(E.WOOD, 600, FULL); ember.core[1] |= 1 << 24; // burning
  const t = touchOn(ember, f => (f === PX ? makeMaterial(E.WOOD, 20, FULL) : null))[PX];
  for (let tick = 0; tick < 200; tick++) assert.equal(C.unpackContact(gridStep(E.WOOD, 20, t, tick).cores[1]).burning, 0, 'the wood stays unlit');
  // air with a flying flame on its x partner and whiskey past its flash point on its y partner (cell 3): V1's
  // vapour flame (react.js nFlash) lights it, as a flame cell there would
  const oil = C.ctRow(E.WHISKEY), oilC = (oil.flashQ + oil.igniteQ) / 2 / 4 - 273.25;
  assert.ok(oil.flashQ < oil.igniteQ);
  const flameTouch = touchOn(makeMaterial(E.FIRE, 900, FULL), f => (f === PX ? air() : null))[PX];
  assert.ok(flameTouch & FLAME);
  let caught = 0, without = 0;
  for (let tick = 0; tick < 200; tick++) {
    if (C.unpackContact(gridStep(E.EMPTY, 20, flameTouch, tick, [[3, makeMaterial(E.WHISKEY, oilC, FULL)]]).cores[1]).id === E.FIRE) caught++;
    if (C.unpackContact(gridStep(E.EMPTY, 20, 0, tick, [[3, makeMaterial(E.WHISKEY, oilC, FULL)]]).cores[1]).id === E.FIRE) without++;
  }
  assert.ok(caught > 100 && without === 0, `${caught} and ${without}`);
});

test('a fuse lights from a flying packet on any face (V1 react.js FUSE, its step\'s one draw: ctFuseTouch)', () => {
  const unlit = cell(E.FUSE, 20);
  assert.ok(unlit.life >= bit('CT_FUSE_UNLIT'));
  const lights = word => word !== 0 && word === bit('CT_ELEC_PENDING') + C.ctFuseLife(1);
  assert.ok(lights(C.ctFuseTouch(unlit, HOT, 0.99)), 'matter at its ignition point');
  assert.ok(lights(C.ctFuseTouch(unlit, FLAME, 0)), 'a flame, on a draw under its chance');
  assert.equal(C.ctFuseTouch(unlit, FLAME, Math.fround(bit('CT_FUSE_FLAME_LIGHT')) + 1e-6), 0, 'not past it');
  assert.equal(C.ctFuseTouch(unlit, 0, 0), 0);
  assert.equal(C.ctFuseTouch({ ...unlit, life: 100 }, HOT, 0), 0, 'a lit one burns on by its own step');
  assert.equal(C.ctFuseTouch(cell(E.WOOD, 20), HOT, 0), 0);
});

test('the marks: an aux region of a word a cell, the touch under the tick\'s stamp', () => {
  const g = gridLayout(32, 32, 32), a = auxLayout(g.slots, PARTICLE_CAP);
  assert.deepEqual([a.banks, a.deco, a.particleDeco, a.touch, a.words], [0, g.slots, 2 * g.slots, 2 * g.slots + PARTICLE_CAP, 3 * g.slots + PARTICLE_CAP]);
  for (const b of [FLAME, HOT]) assert.ok(b < 2 ** PACKET_TOUCH_STAMP_SHIFT);
  assert.equal(2 ** PACKET_TOUCH_STAMP_SHIFT, bit('CT_TOUCH_STAMP'));
  assert.ok(2 ** PACKET_TOUCH_STAMP_BITS / 60 / 86400 > 7, 'a stamp repeats after more than a week of ticks');
  assert.ok(packetTouchWGSL(PARTICLE_CAP).includes(`const PACKET_TOUCH: u32 = 2u * SLOTS + ${PARTICLE_CAP}u;`));
});

test('the block, react and electric stages carry the marks and validate (Naga)', () => {
  const g = gridLayout(32, 32, 32);
  const block = v2BlockWGSL(g, contactWGSL);
  assert.match(block, /let touch=packetTouchNow\(slotOf\(positions\[i\]\)\);\n\s*cells\[i\]=ctStepAtmosphere\([^;]*,contactAmbientQ\(\),touch,i32\(outside>>8u\),faces\);/);
  assertNaga(block, 'v2block');
  const react = particlesWGSL(g, nativeDynamicsHead, 'react');
  assert.ok(react.includes('notePacketTouch(slots[f], r.touch[f])'));
  assertNaga(react, 'v2particles_react');
  const gather = v2ElecGatherWGSL(g);
  assert.ok(gather.includes('if (id == CT_FUSE) { touch = packetTouchNow(s); }') && gather.includes('word = ctFuseTouch(c, touch, roll);'));
  assertNaga(gather, 'v2elecGather');
});

console.log(`${checks} airborne-touch CPU groups passed; no GPU launched`);
