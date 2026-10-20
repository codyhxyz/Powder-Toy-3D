import { contactWGSL, specialContactWGSL } from './contact.js';
import { v2Table } from '../v2.js';
import { AIR_CAPACITY_Q } from '../../v2/layout.js';
import { AIRBORNE, AIRBORNE_FLYING_REQUESTS, AIRBORNE_LANDED_REQUESTS } from '../../v2/airborne.js';

// Airborne matter takes part (docs/v2/native-contract.md "Contact module"): V1 had no flying
// state, its splashes and ejecta were ordinary cells, so its react pass (shaders/react.js) heated,
// burnt, boiled and reacted them every step. V2's particle lane runs the same native contact rules
// on a flying packet and the cell it passes through, as one in-block pair (contactBlock's order:
// conduction, reactions, the packet's own atmosphere step, pending phases, the burning plume).
// The CPU twin, every rule and number, is src/v2/airborne.js airborneReference.

// The contact rule bodies, without contactBlock's storage: the block's events/liquidScratch and
// its runtime neighbour count (three owned faces: the packet's are its host and two absent ones).
const RULES_END = 'fn contactNuclearMaterial(';
const NEIGHBOURS = 'fn ctNeighborCount()->i32 { return i32(min(3u,arrayLength(&events))); }';
export function contactRulesWGSL() {
  const end = contactWGSL.indexOf(RULES_END);
  if (end < 0 || !contactWGSL.includes(NEIGHBOURS) || !specialContactWGSL.includes(RULES_END)) {
    throw new Error('shaders/v2/contact.js no longer has the layout the airborne rules slice');
  }
  return contactWGSL.slice(0, end).replace(NEIGHBOURS, 'fn ctNeighborCount()->i32 { return 3; }');
}
// The native dynamics head keeps only the element prefix of the element rows (v2.js
// nativeDynamicsHead); the contact rules read the table's immutable tail too (contact.js ctRow).
const EV_CONST = /const EV = array<vec4u, \d+>\([^;]*\);/;
export function withContactTable(head) {
  if (!EV_CONST.test(head)) return head; // a test double's head has no table at all
  const words = new Uint32Array(v2Table().buffer);
  const rows = Array.from({ length: Math.ceil(words.length / 4) }, (_, i) =>
    `vec4u(${Array.from({ length: 4 }, (_, k) => `${words[i * 4 + k] ?? 0}u`).join(',')})`);
  return head.replace(EV_CONST, `const EV = array<vec4u, ${rows.length}>(${rows.join(',')});`);
}

// The claim's words, for both the claim stage and the rule stage.
export const airborneClaimWGSL = /* wgsl */ `
const D_REACT_KIND: u32 = ${AIRBORNE.KIND}u;
const D_REACT_SALT: u32 = ${AIRBORNE.SALT}u;
`;
export const airborneReactWGSL = /* wgsl */ `${airborneClaimWGSL}
const D_REACT_PLUME_SALT: i32 = ${AIRBORNE.PLUME_SALT};
const D_CARRIER_Q: u32 = ${AIR_CAPACITY_Q}u;
const D_REACT_REFUSED: u32 = ${AIRBORNE.REFUSED}u;
const D_REACT_FLYING: u32 = ${AIRBORNE.FLYING}u;
const D_REACT_GONE: u32 = ${AIRBORNE.GONE}u;
const D_REACT_LANDED: u32 = ${AIRBORNE.LANDED}u;
const D_REACT_DISPLACED: u32 = ${AIRBORNE.DISPLACED}u;
const D_REACT_FLYING_REQUESTS: u32 = ${AIRBORNE_FLYING_REQUESTS}u;
const D_REACT_LANDED_REQUESTS: u32 = ${AIRBORNE_LANDED_REQUESTS}u;
struct DReact { particle: Material, host: Material, state: u32, source: vec2u, sink: vec2u, requests: u32 }
// [air, oxygen, CO2, gas] among the host cell's six faces: the packet's outside, as the
// support pass counts a cell's out-of-block faces for contactBlock (shaders/v2.js v2SupportWGSL).
fn dReactOutside(p: vec3i) -> vec4i {
  var out = vec4i(0);
  for (var f = 0; f < 6; f++) {
    let n = cellAt(mEdge(p + face6(f))); let id = cid(n); let kind = clsOf(n);
    if (id == u32(CT_EMPTY)) { out.x++; }
    if (id == u32(CT_OXYGEN) || (id == u32(CT_FIRE) && ctypeOf(n) == u32(CT_OXYGEN))) { out.y++; }
    if (id == u32(CT_CO2)) { out.z++; }
    if (kind == C_AIR || kind == C_GAS) { out.w++; }
  }
  return out;
}
// The packet seen as a cell: the same words, with a virtual air carrier at its own temperature
// (a packet owns none: layout.js packetCapacityQ). What the carrier gains or loses meanwhile is the
// air's, so it is the host's at the end; a packet that is used up leaves all it held there.
fn dReact(packet: Material, host: Material, outside: vec4i, seed: i32) -> DReact {
  let refused = DReact(packet, host, D_REACT_REFUSED, vec2u(0u), vec2u(0u), 0u);
  let carrier0 = energyMul(D_CARRIER_Q, cTq(packet.core));
  var v = ctUnpack(packet.core, packet.bank);
  var h = ctUnpack(host.core, host.bank);
  var none = ctNew(0, h.tq, 65536); none.valid = 0;
  let ambientQ = i32(clamp(round((P.ambient + 273.25) * 4.0), 0.0, 65535.0)); let airHeat = i32(P.ambientHeat);
  var flux = 0;
  if (ctConducts(v, h, airHeat)) { flux = ctFlux(v, h); }
  if (flux != 0) { flux = -ctHeatRoom(h, -ctHeatRoom(v, flux)); }
  if (flux != 0) { v = ctHeat(v, flux); h = ctHeat(h, -flux); v.busy = 1; h.busy = 1; }
  var pair = ctReaction(v, h, seed);
  if (pair.changed == 0) { pair = ctAcid(pair.a, pair.b, seed); }
  if (pair.changed == 0) { let rev = ctAcid(pair.b, pair.a, seed); pair = ctPairValue(rev.b, rev.a, rev.changed); }
  if (pair.changed == 0) { pair = ctSwallow(pair.a, pair.b, seed); }
  if (pair.changed == 0) { let rev = ctSwallow(pair.b, pair.a, seed); pair = ctPairValue(rev.b, rev.a, rev.changed); }
  v = pair.a; h = pair.b;
  // V1's electricity on the flying cell (contact.js ctElecAirborne); (a flying packet is on no floor)
  v = ctElecAirborne(v, array<CTCell, 6>(h, none, none, none, none, none), seed);
  v = ctStepAtmosphere(v, array<CTCell, 3>(h, none, none), seed, outside.x, outside.y, outside.z, outside.w, 0, ambientQ);
  pair = ctResolvePhase(v, h);
  if (pair.changed == 0) { let rev = ctResolvePhase(pair.b, pair.a); pair = ctPairValue(rev.b, rev.a, rev.changed); }
  v = pair.a; h = pair.b;
  // the packet is in its host: a burning packet's flames lick into it (V1 react.js, ctLick)
  if (ctHotFuel(v)) { h = ctLick(h, 1, ctRow(v.id).flameQ, ctSmothered(outside.z, outside.w), seed ^ D_REACT_PLUME_SALT); }
  if (v.id != 0) { v = ctAmbient(v, ambientQ, airHeat); }
  let source = energyAdd(v.source, h.source); let sink = energyAdd(v.sink, h.sink);
  let asked = u32(v.request | h.request) & D_REACT_LANDED_REQUESTS;
  let flyingRequests = asked & D_REACT_FLYING_REQUESTS;
  let vm = Material(ctPack(v, packet.core), v.bank);
  let hm = Material(ctPack(h, host.core), h.bank);
  let ev = energyOf(vm); let eh = energyOf(hm);
  if (v.id == 0) {
    let he = energyAdd(eh, energySub(ev, carrier0));
    if (!energyFits(hm, he)) { return refused; }
    return DReact(packet, withEnergy(hm, he), D_REACT_GONE, source, sink, flyingRequests);
  }
  // A detonation is a cell's event (requests bit 0): a charge set off in flight lands in the air it
  // is in, one carrier for the two, and the block pass after this sets it off there.
  if ((v.request & 1) != 0 && h.id == 0) {
    let le = energySub(energyAdd(ev, eh), carrier0);
    if (!energyFits(vm, le)) { return refused; }
    return DReact(packet, withEnergy(vm, le), D_REACT_LANDED, source, sink, asked);
  }
  if ((v.request & 1) != 0 && ctRow(h.id).kind == 4) {
    // in a gas (a charge in the flames that set it off): it lands, and the gas it displaces flies
    // on in its place, as a gas packet that hands itself back to the next empty cell it crosses
    let hostCarrier = energyMul(D_CARRIER_Q, cTq(hm.core));
    let le = energyAdd(energySub(ev, carrier0), hostCarrier); let ge = energySub(eh, hostCarrier);
    if (!energyFits(vm, le) || !packetEnergyFits(hm, ge)) { return refused; }
    return DReact(withPacketEnergy(hm, ge), withEnergy(vm, le), D_REACT_DISPLACED, source, sink, asked);
  }
  let carrier1 = energyMul(D_CARRIER_Q, cTq(vm.core));
  let pe = energySub(ev, carrier1);
  let he = energyAdd(eh, energySub(carrier1, carrier0));
  if (!packetEnergyFits(vm, pe) || !energyFits(hm, he)) { return refused; }
  return DReact(withPacketEnergy(vm, pe), withEnergy(hm, he), D_REACT_FLYING, source, sink, flyingRequests);
}
`;
