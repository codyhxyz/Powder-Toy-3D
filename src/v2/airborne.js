// Airborne matter takes part, as V1's moving cells did. V1 had no flying state: a splash, a
// blast's ejecta or a thrown clump were ordinary cells, so V1's react pass (src/shaders/react.js)
// conducted, burnt, boiled and reacted them with their six face neighbours every one of its 240
// steps a second. V2 keeps them as particles (src/shaders/v2/particles.js), so once a 60 Hz tick
// (src/v2/host.js HOST_HZ) each flying packet takes part as the cell it flies through would:
//   its contacts  the six faces of its host cell, as V1's mover saw its six neighbours, except the
//                 face behind it, which holds its host: V1's move swapped a mover with the gas it
//                 moved into, leaving that gas the face behind it (shaders/move.js). A packet at
//                 rest counts its host behind it along x (trailingFace).
//   partners      of the six, the three the block pass pairs its host cell with this tick (physics.js
//                 offsetOf; shaders/v2.js: a block's low corner on an axis is brick*4 + offset - 1),
//                 so each face is a partner half the ticks, the share V2's per-tick rates already
//                 assume (contact.js ctFlux: 4 legacy steps a tick, each face present 1/2 ticks;
//                 V1 react.js RX_PAIRINGS for reactions). The other three are its outside, counted
//                 as the support pass counts a cell's out-of-block faces (shaders/v2.js v2SupportWGSL).
// and with them it runs V2's native contact rules (src/v2/contact.js, already converted from V1's
// per-step rates to per-tick ones) in contactBlock's order, the packet as the block's cell 0:
//   conduction    ctFlux with each partner, the harmonic-mean face exchange, none between matter
//                 and air with ambient heat off (ctConducts), never past a phase point it can't
//                 hold (ctHeatRoom): a stone flying past a hot wall warms, the wall cools
//   reactions     ctReaction (elements.js REACTIONS: a water drop through caustic gas turns acid),
//                 ctAcid (an acid drop eats the wall it passes), ctSwallow, both ways round
//   electricity   ctElecAirborne: V1's spark, switch, sensor and fuse steps, four a tick, with its six
//                 contacts as V1's mover's six neighbours (a spark runs down in flight or hops on from
//                 a live wire it passes, a lit fuse burns on, an unlit one lights from a flame beside it)
//   own step      ctStepAtmosphere with its partners as its neighbours: ignition from a flame
//                 or a hot solid beside it (V1 react.js nFire, hotTouch), burning with the air
//                 around it (fuel spent at burnRate, heat up to the flame ceiling, CO2/ASH
//                 exhaust), fire's and smoke's life, phases (boil, melt, freeze, condense onto a
//                 surface beside it: phase.js latent heat)
//   phases        ctResolvePhase with each partner, a change waiting on its partner's heat
//   flames        ctLick: a burning packet's flames lick into the air or oxygen partners beside
//                 it, as V1's burning cell's did into the air beside it (V1 react.js nBurning)
//   ambient       ctAmbient: a flying gas radiates toward the scene's ambient by its rad
// Energy is exact. A packet owns no air carrier (layout.js packetCapacityQ), so it is seen as a
// cell with a virtual carrier at its own temperature, and whatever that carrier gains or loses
// meanwhile is the host air's at the end. A packet that is used up (burnt to nothing) leaves all
// it held in the host. Requests are a cell's (native-contract.md), so the packet's and its host's
// are posted at the host slot (blasts.js airborneEvents): gas and neutrons from where it flies, and
// a detonation once a charge set off in flight has landed where it is (displacing a gas there,
// which flies on in its place), for this tick's blasts to set off. The gas a reaction at one of its
// faces sets free (ctReaction's puff, ctAcid's fizz) is posted there too, at the cell beside it:
// a packet's words hold one slot (AIRBORNE_BITS_SHIFT), and the air family spreads a gas source
// over the cells around it either way (the same look, different code: not a deviation).
// A charge is set off in flight as V1's moving cells were (the charge argument):
//   a hit      V1 react.js shock: a hit past its shock sets it off (particles.js dShockHit marks it);
//              it lands with its detonation, here or at the deposit it lands in first
//   dust       V1 react.js dust clouds (physics.js DUST_*): suspended dust (faster than DUST_LIFT_V,
//              contact.js DUST_MIN_FALL_SPEED a tick) with DUST_MEC_NB dust faces and DUST_RICH_AIR air
//              faces goes off as one when lit (its own heat, matter at its ignition point beside it, or
//              a flame beside it or around it: DUST_FIRE, every step), as grid dust does (contact.js);
//              its air faces are its six contacts' (the host in the face behind it), as its own step
//              counts them (ctStepAtmosphere fullAir)
// Anything that cannot be represented leaves the packet and every cell exactly as they were for
// the next tick.
//
// Every packet takes part every tick, however many share a cell (V1 had a cell for each), and the
// result is the same on every replay (particles.js reactClaim, react): the packets in a cell form a
// list, and one thread takes them in a fixed order (airborneOrder: their claim keys, then their
// contents as they were, then their slots), so each sees the host and faces the one before it
// left. A packet reads and writes its host and six faces, so cells whose footprints overlap never
// run together: the react stage runs once for each of AIRBORNE_COLOURS colours, a 4-periodic
// colouring (AIRBORNE_COLOUR_TABLE) in which any two cells within two faces of each other differ,
// across a looped edge too (every side is a multiple of 4: shaders/common.js gridDims).
import { E, ELEMENTS, K } from '../elements.js';
import { AIR_CAPACITY_Q, makeMaterial, cTq, cid, energyOf, withEnergy, energyFits, withPacketEnergy, packetEnergyFits } from './layout.js';
import { unpackContact, packContact, ctNew, ctFlux, ctHeat, ctReaction, ctAcid, ctSwallow, ctStepAtmosphere, ctElecAirborne,
  ctResolvePhase, ctLick, ctHotFuel, ctSmothered, ctRow, ctConducts, ctHeatRoom, ctAmbient, ctPairValue,
  contactAmbientQ, CONTACT_DEFAULT_MODES, DUST_MIN_FALL_SPEED, CONTACT_DUST_MEC_NB, CONTACT_DUST_RICH_AIR, CONTACT_PUFF_UNIT } from './contact.js';
import { PHYS } from '../physics.js';

export const AIRBORNE = Object.freeze({
  // the flight record's kind for a react claim (particles.js kinds: 1 hit, 2-4 neutron, 5 photon)
  KIND: 6,
  // the claim key's salt, so a react order never reuses an integrate election's
  SALT: 0x52454143,
  // contactBlock seeds a pair with its cell's seed ^ its partner's index (1, 2, 4 for cell 0's
  // partners along x, y, z: PAIR_SALT << axis); a flame licking into a partner, past them
  PAIR_SALT: 1, PLUME_SALT: 8,
  // what became of a packet: unchanged (refused), still flying, used up, landed in its host's air,
  // landed in its host's gas (which flies on in the packet's place)
  REFUSED: 0, FLYING: 1, GONE: 2, LANDED: 3, DISPLACED: 4,
});

// A posted request word: the host slot (grids hold under 2^28 slots: v2/state.js stateLengths)
// and the request bits above it.
export const AIRBORNE_BITS_SHIFT = 28;
export const AIRBORNE_SLOT_MASK = (1 << AIRBORNE_BITS_SHIFT) - 1;
// Which requests a packet's host takes, by what became of the packet: a detonation only once it
// has landed (bit 0), gas and neutron requests from wherever it is (bits 1, 2).
export const AIRBORNE_FLYING_REQUESTS = 6, AIRBORNE_LANDED_REQUESTS = 7;
// What a face's own requests post at the packet's host: the gas its pair's reaction set free.
export const AIRBORNE_FACE_REQUESTS = 2;

// A cell's six faces, as shaders/v2.js face6: axis f >> 1, toward + for even f.
export const FACE6 = Object.freeze(Array.from({ length: 6 }, (_, f) => { const d = [0, 0, 0]; d[f >> 1] = 1 - 2 * (f & 1); return d; }));
/** The three faces the block pass pairs the cell at p with this tick (one an axis, x y z), for the
 * partition offset physics.js offsetOf gives: a block's low corner on an axis is brick*4 + offset - 1
 * (shaders/v2.js v2BlockWGSL), so the cell is a low corner, its partner +1, where p + offset is odd. */
export function inBlockFaces(p, offset) { return [0, 1, 2].map(a => 2 * a + (((p[a] + offset[a]) & 1) === 1 ? 0 : 1)); }
/** The face behind a packet: against its fastest axis (ties to the lower axis, a still axis counts
 * as moving +). That face holds its host, as V1's move left the gas a mover swapped with behind it. */
export function trailingFace(velocity) {
  let a = 0; for (let k = 1; k < 3; k++) if (Math.abs(Math.fround(velocity[k])) > Math.abs(Math.fround(velocity[a]))) a = k;
  return 2 * a + (Math.fround(velocity[a]) >= 0 ? 1 : 0);
}
// The packed partition offset in DynamicParams.airborne (x | y << 1 | z << 2), and the react stage's
// colour above it.
export const AIRBORNE_OFFSET_BITS = 3;
export const packAirborne = (offset, colour = 0) => (offset[0] | (offset[1] << 1) | (offset[2] << 2)) | (colour << AIRBORNE_OFFSET_BITS);

// A 4-periodic colouring of the grid in which any two cells within two faces of each other differ,
// so the footprints (a host and its six faces) of cells of one colour never overlap: eight colours,
// the fewest a 4-periodic one can have (a colour's footprints are disjoint 7-cell octahedra, so it
// holds at most 9 of a period's 64 cells). tools/v2/airborne-react-check checks the property on the
// torus. Indexed (x & 3) + 4 (y & 3) + 16 (z & 3).
export const AIRBORNE_COLOURS = 8;
export const AIRBORNE_COLOUR_TABLE = Object.freeze([
  0, 1, 2, 3, 2, 7, 4, 6, 1, 5, 0, 7, 4, 3, 6, 5,
  5, 4, 0, 7, 3, 6, 5, 1, 0, 2, 3, 4, 6, 7, 1, 2,
  2, 3, 6, 4, 7, 1, 2, 0, 5, 4, 7, 6, 1, 0, 5, 3,
  6, 5, 7, 1, 4, 0, 3, 5, 3, 6, 1, 2, 7, 2, 4, 0]);
export const colourOf = p => AIRBORNE_COLOUR_TABLE[(p[0] & 3) + 4 * (p[1] & 3) + 16 * (p[2] & 3)];

/** The order a cell's packets take part in: their claim keys, then their contents as they were at
 * the claim (a hash, 24 bits so a flight record's f32 holds it exactly), then their slots. */
export function airborneOrder(a, b) { return a.key - b.key || a.hash - b.hash || a.slot - b.slot; }

const C_AIR = K.EMPTY, C_GAS = K.GAS;
// V1 react.js lights a dust cloud beside a flame with chance DUST_FIRE a step: every step, so every tick.
if (PHYS.DUST_FIRE !== 1) throw new Error('airborne.js: a flame beside a dust cloud lights it every tick only while DUST_FIRE is 1');
/** What sets a flying packet off besides its own rules (particles.js react): none by default. */
export const AIRBORNE_NO_CHARGE = Object.freeze({ setOff: false, speed: 0, dust: 0, fire: 0, hot: 0 });
// setOff: a hit set it off (particles.js dShockHit); speed: |v| in cells a tick; dust: its dust faces
// (particles.js dDustFaces); fire, hot: its flame faces and hot faces (dustFacesOf)

/** [flame faces, hot faces] among the host's six faces (null beyond the box): V1 react.js dust clouds' nFire and hotTouch. */
export function dustFacesOf(cores) {
  const out = [0, 0];
  for (const c of cores) {
    if (!c) continue; // (beyond the box: its wall, cold)
    const id = c[0] & 255, kind = ELEMENTS[id].kind;
    if (id === E.FIRE) out[0]++;
    if (kind !== K.EMPTY && kind !== K.GAS && cTq(c) >= ctRow(E.DUST).igniteQ) out[1]++;
  }
  return out;
}

/** [air, oxygen, CO2, gas] among faces, as the support pass counts a cell's out-of-block faces for
 * contactBlock (shaders/v2.js v2SupportWGSL; V1 react.js: a flame is burning air to a fuel, oxygen
 * when it burns in it). A face outside the grid (null) is the box's wall and counts as none. */
export function outsideOf(cores) {
  const out = [0, 0, 0, 0];
  for (const c of cores) {
    if (!c) continue;
    const id = c[0] & 255, kind = ELEMENTS[id].kind, oxygenFlame = id === E.FIRE && ((c[1] >>> 16) & 255) === E.OXYGEN;
    if (id === E.EMPTY || (id === E.FIRE && !oxygenFlame)) out[0]++;
    if (id === E.OXYGEN || oxygenFlame) out[1]++;
    if (id === E.CO2) out[2]++;
    if (kind === C_AIR || kind === C_GAS) out[3]++;
  }
  return out;
}

/** A packet's surroundings: its host's six faces (each { core, bank }, null outside the grid), the
 * three its host's block pairs it with this tick, the face behind it, and whether its host lies on
 * the box's solid floor (which V1 react.js counts as a surface: contactReference floorAt). */
export function nearOf(faces, cell, offset, velocity, onFloor = 0) {
  return { faces, inBlock: inBlockFaces(cell, offset), trailing: trailingFace(velocity), onFloor };
}
/** Open air at the scene's default ambient all round, the partition offset 0 and moving +x: a
 * packet's surroundings by default. */
export const openNear = (ambient = CONTACT_DEFAULT_MODES.ambient) =>
  nearOf(Array.from({ length: 6 }, () => makeMaterial(E.EMPTY, ambient, 0)), [0, 0, 0], [0, 0, 0], [1, 0, 0]);

/**
 * One tick of a flying packet in its host cell with the six cells around it. packet, host: { core, bank };
 * seed: i32; near: nearOf(...); modes: the scene's ambient and ambientHeat.
 * @returns {{ state: number, particle: {core,bank}, host: {core,bank}, faces: ({core,bank}|null)[], source: bigint, sink: bigint, requests: number }}
 *   requests: the host slot's request bits (native-contract.md: 1 detonate, 2 gas, 4 neutron), and
 *   above them the GAS request's puff (contact.js ctPuff: the largest of the packet's and its partners')
 */
export function airborneReference(packet, host, seed, near = openNear(), modes = CONTACT_DEFAULT_MODES, charge = AIRBORNE_NO_CHARGE) {
  const { faces, inBlock, trailing, onFloor = 0 } = near;
  const refused = { state: AIRBORNE.REFUSED, particle: packet, host, faces, source: 0n, sink: 0n, requests: 0 };
  const carrier0 = BigInt(AIR_CAPACITY_Q) * BigInt(cTq(packet.core));
  try {
    let v = unpackContact(packet.core, packet.bank);
    // its partners, one an axis: the host where it stands in the face, else the face (none outside the grid)
    const ps = inBlock.map(f => (f === trailing ? unpackContact(host.core, host.bank) : faces[f] ? unpackContact(faces[f].core, faces[f].bank) : null));
    const ambientQ = contactAmbientQ(modes.ambient), airHeat = +!!modes.ambientHeat;
    // (its outside, frozen before any pair runs, as the support pass freezes a cell's)
    const outside = outsideOf(inBlock.map(f => (f ^ 1) === trailing ? host.core : faces[f ^ 1]?.core));
    for (let a = 0; a < 3; a++) {
      let b = ps[a]; if (!b) continue;
      const s = seed ^ (AIRBORNE.PAIR_SALT << a);
      let flux = ctConducts(v, b, airHeat) ? ctFlux(v, b) : 0;
      if (flux !== 0) flux = -ctHeatRoom(b, -ctHeatRoom(v, flux));
      if (flux !== 0) { v = ctHeat(v, flux); b = ctHeat(b, -flux); v.busy = 1; b.busy = 1; }
      let pair = ctReaction(v, b, s);
      if (!pair.changed) pair = ctAcid(pair.a, pair.b, s);
      if (!pair.changed) { const rev = ctAcid(pair.b, pair.a, s); pair = ctPairValue(rev.b, rev.a, rev.changed); }
      if (!pair.changed) pair = ctSwallow(pair.a, pair.b, s);
      if (!pair.changed) { const rev = ctSwallow(pair.b, pair.a, s); pair = ctPairValue(rev.b, rev.a, rev.changed); }
      v = pair.a; ps[a] = pair.b;
    }
    // V1's electricity on the flying cell, its steps a tick (contact.js ctElecAirborne), with its six
    // contacts as V1's mover's six neighbours: its partners as the pairs left them, its host in the face
    // behind it, the other faces as they are (none beyond the box)
    const none = { ...ctNew(E.EMPTY, 0, 65536), valid: 0 };
    const contacts = FACE6.map((_, f) => {
      const a = inBlock.indexOf(f);
      if (a >= 0) return ps[a] ?? none;
      if (f === trailing) return unpackContact(host.core, host.bank);
      return faces[f] ? unpackContact(faces[f].core, faces[f].bank) : none;
    });
    v = ctElecAirborne(v, contacts, seed);
    const ns = ps.map(b => (b ? { ...b } : none));
    v = ctStepAtmosphere(v, ns, seed, ...outside, onFloor, ambientQ);
    for (let a = 0; a < 3; a++) {
      if (!ps[a]) continue;
      let pair = ctResolvePhase(v, ps[a]);
      if (!pair.changed) { const rev = ctResolvePhase(pair.b, pair.a); pair = ctPairValue(rev.b, rev.a, rev.changed); }
      v = pair.a; ps[a] = pair.b;
    }
    if (ctHotFuel(v)) {
      // smothered as its own step saw the gas around it (ctStepAtmosphere fullCo2, fullGas: its partners then)
      let co2 = outside[2], gas = outside[3];
      for (const b of ps) if (b) { co2 += +(b.id === E.CO2); gas += +(ctRow(b.id).kind === C_AIR || ctRow(b.id).kind === C_GAS); }
      const smothered = ctSmothered(co2, gas);
      for (let a = 0; a < 3; a++) if (ps[a]) ps[a] = ctLick(ps[a], 1, ctRow(v.id).flameQ, smothered, seed ^ (AIRBORNE.PLUME_SALT << a));
    }
    if (v.id !== E.EMPTY) v = ctAmbient(v, ambientQ, airHeat);
    let source = v.source, sink = v.sink, asked = 0, hm = host;
    const out = [...faces];
    ps.forEach((b, a) => {
      if (!b) return;
      source += b.source; sink += b.sink;
      const f = inBlock[a];
      if (f === trailing) { hm = packContact(b, host.core); asked |= b.request & AIRBORNE_LANDED_REQUESTS; }
      else { out[f] = packContact(b, faces[f].core); asked |= b.request & AIRBORNE_FACE_REQUESTS; }
    });
    const hostId = cid(hm.core);
    // still the charge it was: set off by a hit, or a dust cloud lit, with the air among its six
    // contacts as its own step counted it (ctStepAtmosphere fullAir: its partners then, its outside)
    const charge0 = packet.core[0] & 255;
    if (v.id === charge0 && ctRow(v.id).blast !== 0 && charge.setOff) v.request = v.request | 1;
    const air = outside[0] + ns.filter(b => b.valid !== 0 && (b.id === E.EMPTY || (b.id === E.FIRE && b.ctype !== E.OXYGEN))).length;
    if (v.id === E.DUST && charge0 === E.DUST && charge.speed >= DUST_MIN_FALL_SPEED && charge.dust >= CONTACT_DUST_MEC_NB &&
      air >= CONTACT_DUST_RICH_AIR && (v.tq >= ctRow(E.DUST).igniteQ || charge.hot > 0 || charge.fire > 0 || hostId === E.FIRE)) v.request = v.request | 1;
    asked |= v.request & AIRBORNE_LANDED_REQUESTS;
    // a puff rides with its GAS request (bit 1, posted flying or landed): V1's pressure from gas a
    // packet sets free in flight (a drop boiling, a reaction at one of its faces) is its cell's, as on
    // the grid, the largest of its own and its partners' (contact.js ctPuff, ctMergeRequest)
    const puff = Math.max(...[v, ...ps.filter(Boolean)].map(c => Math.floor(c.request / CONTACT_PUFF_UNIT))) * CONTACT_PUFF_UNIT;
    const requests = landed => (asked & (landed ? AIRBORNE_LANDED_REQUESTS : AIRBORNE_FLYING_REQUESTS)) | puff;
    const vm = packContact(v, packet.core);
    const ev = energyOf(vm), eh = energyOf(hm);
    if (v.id === E.EMPTY) {
      const he = eh + ev - carrier0;
      if (!energyFits(hm, he)) return refused;
      return { state: AIRBORNE.GONE, particle: packet, host: withEnergy(hm, he), faces: out, source, sink, requests: requests(false) };
    }
    if ((v.request & 1) !== 0 && hostId === E.EMPTY) {
      const le = ev + eh - carrier0;
      if (!energyFits(vm, le)) return refused;
      return { state: AIRBORNE.LANDED, particle: packet, host: withEnergy(vm, le), faces: out, source, sink, requests: requests(true) };
    }
    if ((v.request & 1) !== 0 && ELEMENTS[hostId].kind === K.GAS) {
      // in a gas (a charge in the flames that set it off): it lands, and the gas it displaces flies
      // on in its place, as a gas packet that hands itself back to the next empty cell it crosses
      const hostCarrier = BigInt(AIR_CAPACITY_Q) * BigInt(cTq(hm.core));
      const le = ev - carrier0 + hostCarrier, ge = eh - hostCarrier;
      if (!energyFits(vm, le) || !packetEnergyFits(hm, ge)) return refused;
      return { state: AIRBORNE.DISPLACED, particle: withPacketEnergy(hm, ge), host: withEnergy(vm, le), faces: out, source, sink, requests: requests(true) };
    }
    const carrier1 = BigInt(AIR_CAPACITY_Q) * BigInt(cTq(vm.core));
    const pe = ev - carrier1, he = eh + carrier1 - carrier0;
    if (!packetEnergyFits(vm, pe) || !energyFits(hm, he)) return refused;
    return { state: AIRBORNE.FLYING, particle: withPacketEnergy(vm, pe), host: withEnergy(hm, he), faces: out, source, sink, requests: requests(false) };
  } catch (error) {
    if (error instanceof RangeError || /unrepresentable|overflow/.test(error?.message ?? '')) return refused;
    throw error;
  }
}
