// Airborne matter takes part, as V1's moving cells did. V1 had no flying state: a splash, a
// blast's ejecta or a thrown clump were ordinary cells, so V1's react pass (src/shaders/react.js)
// conducted, burnt, boiled and reacted them every one of its 240 steps a second. V2 keeps them as
// particles (src/shaders/v2/particles.js), so once a 60 Hz tick (src/v2/host.js HOST_HZ) each
// flying packet and the cell it is passing through run V2's native contact rules
// (src/v2/contact.js, already converted from V1's per-step rates to per-tick ones) as one
// in-block pair, in contactBlock's order:
//   conduction    ctFlux, the harmonic-mean face exchange (4 legacy steps a tick, half the faces)
//   reactions     ctReaction (elements.js REACTIONS: a water drop through caustic gas turns acid),
//                 ctAcid, ctSwallow, both ways round
//   own step      ctStepAtmosphere: ignition and burning with the host as its flame and air (fuel
//                 spent at burnRate, heat up to the flame ceiling, CO2/ASH exhaust), fire's and
//                 smoke's life, phases (boil, melt, freeze, condense: phase.js latent heat)
//   phases        ctResolvePhase, a change waiting on its partner's heat
//   plume         ctPlume: a burning packet's flame and smoke go into the air it flies through
// Energy is exact. A packet owns no air carrier (layout.js packetCapacityQ), so it is seen as a
// cell with a virtual carrier at its own temperature, and whatever that carrier gains or loses
// meanwhile is the host air's at the end. A packet that is used up (burnt to nothing) leaves all
// it held in the host. A detonation is a cell's event (native-contract.md requests bit 0), so a
// charge set off in flight lands where it is (displacing a gas there, which flies on in its place)
// and the block pass after it sets it off.
// Anything that cannot be represented leaves both exactly as they were for the next tick.
import { E, ELEMENTS, K } from '../elements.js';
import { AIR_CAPACITY_Q, cTq, energyOf, withEnergy, energyFits, withPacketEnergy, packetEnergyFits } from './layout.js';
import { unpackContact, packContact, ctNew, ctFlux, ctHeat, ctReaction, ctAcid, ctSwallow, ctStepAtmosphere,
  ctResolvePhase, ctPlume, ctPairValue } from './contact.js';

export const AIRBORNE = Object.freeze({
  // the flight record's kind for a react claim (particles.js kinds: 1 hit, 2-4 neutron, 5 photon)
  KIND: 6,
  // the claim key's salt, so a react election never reuses an integrate one's order
  SALT: 0x52454143,
  // contactBlock seeds a pair's plume with its partner's index; a packet's partner is its host
  PLUME_SALT: 1,
  // what became of a packet: unchanged (refused), still flying, used up, landed in its host's air,
  // landed in its host's gas (which flies on in the packet's place)
  REFUSED: 0, FLYING: 1, GONE: 2, LANDED: 3, DISPLACED: 4,
});

/** The packet's outside as contactBlock counts it: [air, oxygen, CO2, gas] among the host's faces. */
export function outsideOf(cores) {
  const out = [0, 0, 0, 0];
  for (const c of cores) {
    const id = c[0] & 255, kind = ELEMENTS[id].kind;
    if (id === E.EMPTY) out[0]++;
    if (id === E.OXYGEN || (id === E.FIRE && ((c[1] >>> 16) & 255) === E.OXYGEN)) out[1]++;
    if (id === E.CO2) out[2]++;
    if (kind === K.EMPTY || kind === K.GAS) out[3]++;
  }
  return out;
}

/**
 * One tick of a flying packet in its host cell. packet, host: { core, bank }; seed: i32;
 * outside: [air, oxygen, CO2, gas] among the host's six faces.
 * @returns {{ state: number, particle: {core,bank}, host: {core,bank}, source: bigint, sink: bigint }}
 */
export function airborneReference(packet, host, seed, outside = [0, 0, 0, 0]) {
  const refused = { state: AIRBORNE.REFUSED, particle: packet, host, source: 0n, sink: 0n };
  const carrier0 = BigInt(AIR_CAPACITY_Q) * BigInt(cTq(packet.core));
  try {
    let v = unpackContact(packet.core, packet.bank);
    let h = unpackContact(host.core, host.bank);
    const none = { ...ctNew(E.EMPTY, h.tq, 65536), valid: 0 };
    const flux = ctFlux(v, h);
    if (flux !== 0) { v = ctHeat(v, flux); h = ctHeat(h, -flux); v.busy = 1; h.busy = 1; }
    let pair = ctReaction(v, h, seed);
    if (!pair.changed) pair = ctAcid(pair.a, pair.b, seed);
    if (!pair.changed) { const rev = ctAcid(pair.b, pair.a, seed); pair = ctPairValue(rev.b, rev.a, rev.changed); }
    if (!pair.changed) pair = ctSwallow(pair.a, pair.b, seed);
    if (!pair.changed) { const rev = ctSwallow(pair.b, pair.a, seed); pair = ctPairValue(rev.b, rev.a, rev.changed); }
    v = pair.a; h = pair.b;
    v = ctStepAtmosphere(v, [h, none, none], seed, ...outside);
    pair = ctResolvePhase(v, h);
    if (!pair.changed) { const rev = ctResolvePhase(pair.b, pair.a); pair = ctPairValue(rev.b, rev.a, rev.changed); }
    v = pair.a; h = pair.b;
    pair = ctPlume(v, h, seed ^ AIRBORNE.PLUME_SALT, 1);
    v = pair.a; h = pair.b;
    const source = v.source + h.source, sink = v.sink + h.sink;
    const vm = packContact(v, packet.core), hm = packContact(h, host.core);
    const ev = energyOf(vm), eh = energyOf(hm);
    if (v.id === E.EMPTY) {
      const he = eh + ev - carrier0;
      if (!energyFits(hm, he)) return refused;
      return { state: AIRBORNE.GONE, particle: packet, host: withEnergy(hm, he), source, sink };
    }
    if ((v.request & 1) !== 0 && h.id === E.EMPTY) {
      const le = ev + eh - carrier0;
      if (!energyFits(vm, le)) return refused;
      return { state: AIRBORNE.LANDED, particle: packet, host: withEnergy(vm, le), source, sink };
    }
    if ((v.request & 1) !== 0 && ELEMENTS[h.id].kind === K.GAS) {
      // in a gas (a charge in the flames that set it off): it lands, and the gas it displaces flies
      // on in its place, as a gas packet that hands itself back to the next empty cell it crosses
      const hostCarrier = BigInt(AIR_CAPACITY_Q) * BigInt(cTq(hm.core));
      const le = ev - carrier0 + hostCarrier, ge = eh - hostCarrier;
      if (!energyFits(vm, le) || !packetEnergyFits(hm, ge)) return refused;
      return { state: AIRBORNE.DISPLACED, particle: withPacketEnergy(hm, ge), host: withEnergy(vm, le), source, sink };
    }
    const carrier1 = BigInt(AIR_CAPACITY_Q) * BigInt(cTq(vm.core));
    const pe = ev - carrier1, he = eh + carrier1 - carrier0;
    if (!packetEnergyFits(vm, pe) || !energyFits(hm, he)) return refused;
    return { state: AIRBORNE.FLYING, particle: withPacketEnergy(vm, pe), host: withEnergy(hm, he), source, sink };
  } catch (error) {
    if (error instanceof RangeError || /unrepresentable|overflow/.test(error?.message ?? '')) return refused;
    throw error;
  }
}
