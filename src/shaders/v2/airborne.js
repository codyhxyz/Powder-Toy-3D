import { contactWGSL, specialContactWGSL } from './contact.js';
import { v2Table } from '../v2.js';
import { AIR_CAPACITY_Q } from '../../v2/layout.js';
import { AIRBORNE, AIRBORNE_FLYING_REQUESTS, AIRBORNE_LANDED_REQUESTS, AIRBORNE_FACE_REQUESTS, AIRBORNE_OFFSET_BITS,
  AIRBORNE_COLOUR_TABLE } from '../../v2/airborne.js';
import { EDGE } from '../../simModes.js';

// Airborne matter takes part (docs/v2/native-contract.md "Contact module"): V1 had no flying
// state, its splashes and ejecta were ordinary cells, so its react pass (shaders/react.js) heated,
// burnt, boiled and reacted them with their six face neighbours every step. V2's particle lane runs
// the same native contact rules on a flying packet as the block pass would on its host cell: its
// host's six faces (the one behind it holding its host), the three the block pairs that cell with
// this tick as its partners and the rest as its outside, in contactBlock's order (conduction,
// reactions, the packet's own atmosphere step, pending phases, the burning plume).
// The CPU twin, every rule and number, is src/v2/airborne.js airborneReference.

// The contact rule bodies, without contactBlock's storage: the block's events/liquidScratch and
// its runtime neighbour count (three owned faces, a packet's three partners). count: the WGSL
// expression for it, at run time where the caller can (the react stage's flight records), so the
// backend need not unroll each rule's neighbour loop three times.
const RULES_END = 'fn contactNuclearMaterial(';
const NEIGHBOURS = 'fn ctNeighborCount()->i32 { return i32(min(3u,arrayLength(&events))); }';
export function contactRulesWGSL(count = '3') {
  const end = contactWGSL.indexOf(RULES_END);
  if (end < 0 || !contactWGSL.includes(NEIGHBOURS) || !specialContactWGSL.includes(RULES_END)) {
    throw new Error('shaders/v2/contact.js no longer has the layout the airborne rules slice');
  }
  return contactWGSL.slice(0, end).replace(NEIGHBOURS, `fn ctNeighborCount()->i32 { return ${count}; }`);
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
const D_REACT_OFFSET_BITS: u32 = ${AIRBORNE_OFFSET_BITS}u;
// The 4-periodic colouring in which cells within two faces of each other differ (v2/airborne.js).
const D_REACT_COLOURS = array<u32, 64>(${AIRBORNE_COLOUR_TABLE.map(c => `${c}u`).join(',')});
fn dReactColour(p: vec3i) -> u32 { return D_REACT_COLOURS[u32(p.x & 3) + 4u * u32(p.y & 3) + 16u * u32(p.z & 3)]; }
// The packet's contents as they were at its claim, for the order its cell takes its packets in
// (airborneOrder): 24 bits, so the flight record's f32 holds it exactly.
fn dReactHash(p: DParticle) -> u32 {
  let w = array<u32, 12>(bitcast<u32>(p.position.x), bitcast<u32>(p.position.y), bitcast<u32>(p.position.z), p.id,
    bitcast<u32>(p.velocity.x), bitcast<u32>(p.velocity.y), bitcast<u32>(p.velocity.z), p.c0, p.tail.x, p.tail.y, p.tail.z, p.tail.w);
  var h = 0u; for (var i = 0u; i < 12u; i++) { h = dHash(h ^ w[i]); }
  return h >> 8u;
}
`;
export const airborneReactWGSL = /* wgsl */ `${airborneClaimWGSL}
const D_REACT_PAIR_SALT: i32 = ${AIRBORNE.PAIR_SALT};
const D_REACT_PLUME_SALT: i32 = ${AIRBORNE.PLUME_SALT};
const D_CARRIER_Q: u32 = ${AIR_CAPACITY_Q}u;
const D_REACT_REFUSED: u32 = ${AIRBORNE.REFUSED}u;
const D_REACT_FLYING: u32 = ${AIRBORNE.FLYING}u;
const D_REACT_GONE: u32 = ${AIRBORNE.GONE}u;
const D_REACT_LANDED: u32 = ${AIRBORNE.LANDED}u;
const D_REACT_DISPLACED: u32 = ${AIRBORNE.DISPLACED}u;
const D_REACT_FLYING_REQUESTS: u32 = ${AIRBORNE_FLYING_REQUESTS}u;
const D_REACT_LANDED_REQUESTS: u32 = ${AIRBORNE_LANDED_REQUESTS}u;
const D_REACT_FACE_REQUESTS: u32 = ${AIRBORNE_FACE_REQUESTS}u;
const D_REACT_HOST: u32 = 6u;   // the contacts' host entry, after the six faces
const D_REACT_SOLID_EDGE: u32 = ${EDGE.SOLID}u;
struct DReact { particle: Material, host: Material, partners: array<Material, 3>, state: u32, source: vec2u, sink: vec2u, requests: u32 }
// Three, at run time, so the backend need not unroll the contact rules once for each axis
// (contactBlock's ctNeighborCount).
fn dAxes() -> u32 { return min(3u, arrayLength(&flight)); }
// The three faces the block pass pairs the host cell at p with this tick (v2/airborne.js inBlockFaces).
fn dInBlock(p: vec3i) -> vec3u {
  let o = vec3i(i32(P.airborne & 1u), i32((P.airborne >> 1u) & 1u), i32((P.airborne >> 2u) & 1u));
  return vec3u(0u, 2u, 4u) + select(vec3u(1u), vec3u(0u), ((p + o) & vec3i(1)) == vec3i(1));
}
// The face behind it (v2/airborne.js trailingFace): against its fastest axis, ties to the lower one.
fn dTrailing(v: vec3f) -> u32 {
  var a = 0u; if (abs(v.y) > abs(v.x)) { a = 1u; } if (abs(v.z) > abs(v[a])) { a = 2u; }
  return 2u * a + select(0u, 1u, v[a] >= 0.0);
}
// [air, oxygen, CO2, gas]: a face as the support pass counts a cell's out-of-block faces
// (shaders/v2.js v2SupportWGSL); one outside the grid is the box's wall and counts as none.
fn dReactCount(n: vec4u, present: bool) -> vec4i {
  if (!present) { return vec4i(0); }
  let id = cid(n); let kind = clsOf(n); let oxygenFlame = id == u32(CT_FIRE) && ctypeOf(n) == u32(CT_OXYGEN);
  return vec4i(select(0, 1, id == u32(CT_EMPTY) || (id == u32(CT_FIRE) && !oxygenFlame)), select(0, 1, id == u32(CT_OXYGEN) || oxygenFlame),
    select(0, 1, id == u32(CT_CO2)), select(0, 1, kind == C_AIR || kind == C_GAS));
}
// The packet seen as a cell: the same words, with a virtual air carrier at its own temperature
// (a packet owns none: layout.js packetCapacityQ). What the carrier gains or loses meanwhile is the
// air's, so it is the host's at the end; a packet that is used up leaves all it held there.
// faces: its host's six (valid: a bit each, inside the grid); inBlock: its partners' faces, x y z;
// trailing: the face its host stands in. Its partners come back in inBlock's order (the host's
// own, where it is one, in host).
fn dReact(packet: Material, host: Material, faces: array<Material, 6>, valid: u32, inBlock: vec3u, trailing: u32, onFloor: i32, seed: i32) -> DReact {
  let refused = DReact(packet, host, array<Material, 3>(faces[inBlock.x], faces[inBlock.y], faces[inBlock.z]), D_REACT_REFUSED, vec2u(0u), vec2u(0u), 0u);
  let carrier0 = energyMul(D_CARRIER_Q, cTq(packet.core));
  var v = ctUnpack(packet.core, packet.bank);
  // its partners, one an axis: the host where it stands in the face, else the face (none outside the grid)
  var ps: array<CTCell, 3>; var originals: array<vec4u, 3>;
  for (var a = 0u; a < dAxes(); a++) {
    let f = inBlock[a];
    if (f == trailing) { ps[a] = ctUnpack(host.core, host.bank); originals[a] = host.core; }
    else if (((valid >> f) & 1u) != 0u) { ps[a] = ctUnpack(faces[f].core, faces[f].bank); originals[a] = faces[f].core; }
    else { ps[a] = ctNew(0, 0, 65536); ps[a].valid = 0; }
  }
  let ambientQ = i32(clamp(round((P.ambient + 273.25) * 4.0), 0.0, 65535.0)); let airHeat = i32(P.ambientHeat);
  // its outside, frozen before any pair runs, as the support pass freezes a cell's
  var outside = vec4i(0);
  for (var a = 0u; a < dAxes(); a++) {
    let f = inBlock[a] ^ 1u;
    if (f == trailing) { outside += dReactCount(host.core, true); } else { outside += dReactCount(faces[f].core, ((valid >> f) & 1u) != 0u); }
  }
  for (var a = 0u; a < dAxes(); a++) {
    if (ps[a].valid == 0) { continue; }
    let s = seed ^ (D_REACT_PAIR_SALT << a);
    var b = ps[a];
    var flux = 0;
    if (ctConducts(v, b, airHeat)) { flux = ctFlux(v, b); }
    if (flux != 0) { flux = -ctHeatRoom(b, -ctHeatRoom(v, flux)); }
    if (flux != 0) { v = ctHeat(v, flux); b = ctHeat(b, -flux); v.busy = 1; b.busy = 1; }
    var pair = ctReaction(v, b, s);
    if (pair.changed == 0) { pair = ctAcid(pair.a, pair.b, s); }
    if (pair.changed == 0) { let rev = ctAcid(pair.b, pair.a, s); pair = ctPairValue(rev.b, rev.a, rev.changed); }
    if (pair.changed == 0) { pair = ctSwallow(pair.a, pair.b, s); }
    if (pair.changed == 0) { let rev = ctSwallow(pair.b, pair.a, s); pair = ctPairValue(rev.b, rev.a, rev.changed); }
    v = pair.a; ps[a] = pair.b;
  }
  v = ctStepAtmosphere(v, ps, seed, outside.x, outside.y, outside.z, outside.w, onFloor, ambientQ);
  for (var a = 0u; a < dAxes(); a++) {
    if (ps[a].valid == 0) { continue; }
    var pair = ctResolvePhase(v, ps[a]);
    if (pair.changed == 0) { let rev = ctResolvePhase(pair.b, pair.a); pair = ctPairValue(rev.b, rev.a, rev.changed); }
    v = pair.a; ps[a] = pair.b;
  }
  // a burning packet's flames lick into the air beside it (V1 react.js nBurning, ctLick), smothered
  // as its own step saw the gas around it (ctStepAtmosphere fullCo2, fullGas: its partners then)
  if (ctHotFuel(v)) {
    var co2 = outside.z; var gas = outside.w;
    for (var a = 0u; a < dAxes(); a++) {
      if (ps[a].valid == 0) { continue; }
      if (ps[a].id == CT_CO2) { co2++; }
      if (ctRow(ps[a].id).kind == 0 || ctRow(ps[a].id).kind == 4) { gas++; }
    }
    let smothered = ctSmothered(co2, gas);
    for (var a = 0u; a < dAxes(); a++) {
      if (ps[a].valid == 0) { continue; }
      ps[a] = ctLick(ps[a], 1, ctRow(v.id).flameQ, smothered, seed ^ (D_REACT_PLUME_SALT << a));
    }
  }
  if (v.id != 0) { v = ctAmbient(v, ambientQ, airHeat); }
  var source = v.source; var sink = v.sink;
  var asked = u32(v.request) & D_REACT_LANDED_REQUESTS;
  var hm = host; var partners = refused.partners;
  for (var a = 0u; a < dAxes(); a++) {
    if (ps[a].valid == 0) { continue; }
    source = energyAdd(source, ps[a].source); sink = energyAdd(sink, ps[a].sink);
    let m = Material(ctPack(ps[a], originals[a]), ps[a].bank);
    if (inBlock[a] == trailing) { hm = m; asked |= u32(ps[a].request) & D_REACT_LANDED_REQUESTS; }
    else { partners[a] = m; asked |= u32(ps[a].request) & D_REACT_FACE_REQUESTS; }
  }
  let hostId = i32(cid(hm.core));
  let flyingRequests = asked & D_REACT_FLYING_REQUESTS;
  let vm = Material(ctPack(v, packet.core), v.bank);
  let ev = energyOf(vm); let eh = energyOf(hm);
  if (v.id == 0) {
    let he = energyAdd(eh, energySub(ev, carrier0));
    if (!energyFits(hm, he)) { return refused; }
    return DReact(packet, withEnergy(hm, he), partners, D_REACT_GONE, source, sink, flyingRequests);
  }
  // A detonation is a cell's event (requests bit 0): a charge set off in flight lands in the air it
  // is in, one carrier for the two, and the block pass after this sets it off there.
  if ((v.request & 1) != 0 && hostId == 0) {
    let le = energySub(energyAdd(ev, eh), carrier0);
    if (!energyFits(vm, le)) { return refused; }
    return DReact(packet, withEnergy(vm, le), partners, D_REACT_LANDED, source, sink, asked);
  }
  if ((v.request & 1) != 0 && ctRow(hostId).kind == 4) {
    // in a gas (a charge in the flames that set it off): it lands, and the gas it displaces flies
    // on in its place, as a gas packet that hands itself back to the next empty cell it crosses
    let hostCarrier = energyMul(D_CARRIER_Q, cTq(hm.core));
    let le = energyAdd(energySub(ev, carrier0), hostCarrier); let ge = energySub(eh, hostCarrier);
    if (!energyFits(vm, le) || !packetEnergyFits(hm, ge)) { return refused; }
    return DReact(withPacketEnergy(hm, ge), withEnergy(vm, le), partners, D_REACT_DISPLACED, source, sink, asked);
  }
  let carrier1 = energyMul(D_CARRIER_Q, cTq(vm.core));
  let pe = energySub(ev, carrier1);
  let he = energyAdd(eh, energySub(carrier1, carrier0));
  if (!packetEnergyFits(vm, pe) || !energyFits(hm, he)) { return refused; }
  return DReact(withPacketEnergy(vm, pe), withEnergy(hm, he), partners, D_REACT_FLYING, source, sink, flyingRequests);
}
`;
