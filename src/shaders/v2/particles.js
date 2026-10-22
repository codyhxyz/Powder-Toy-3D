import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../v2.js';
import { MODE_FIELDS } from '../../v2/modes.js';
import { specialContactWGSL } from './contact.js';
import { impactFoamWGSL } from '../../v2/foam.js';
import { uniformStruct } from '../../gpu/params.js';
import { STAGE } from '../../gpu/kernels.js';
import { TERMINAL_MS } from '../../v2/gravity.js';
import { dynamicsRows, PARTICLE_CAP, CELL_M, DT, GRAVITY, AIR, NEUTRON_TAG, SHOCK_THROW_MS, PACKET_SHOCK_LANDINGS, PACKET_GRAIN_ODDS, LEGACY_PRESSURE_PA, legacyPressureToPa,
  RAY_STEPS_PER_TICK, RAY_NEUTRON_FAST_MS, PACKET_KEEP } from '../../v2/dynamics-reference.js';
import { V1_STEP_MS, STEPS_PER_TICK, STEP_S } from '../../v2/gravity.js';
import { NUCLEAR, sigmas, RAYS } from '../../rays.js';
import { ELEMENTS, E, R } from '../../elements.js';
import { PHYS } from '../../physics.js';
import { contactRulesWGSL, withContactTable, airborneReactWGSL, airborneClaimWGSL } from './airborne.js';
import { AIRBORNE_BITS_SHIFT, AIRBORNE, AIRBORNE_LANDED_REQUESTS } from '../../v2/airborne.js';
import { CONTACT_PUFF_UNIT } from '../../v2/contact.js';
import { packetTouchWGSL } from './state.js';
export { PARTICLE_CAP };
export const DynamicParams = uniformStruct('DynamicParams', {
  tick: 'u32', busyIn: 'u32', busyOut: 'u32', mode: 'u32', origin: 'vec3i', sequence: 'u32',
  center: 'vec3f', radius: 'f32', vector: 'vec3f', strength: 'f32', shift: 'vec3i', substep: 'u32', nativeJets: 'u32', ...MODE_FIELDS,
  blastEnd:'vec3f', blastGrow:'vec3f', blastShape:'u32', blastFilter:'i32', blastMasked:'u32', blastMaskOrigin:'vec3i', blastFade:'u32', blastBounded:'u32', blastLo:'vec3i', blastHi:'vec3i',
  boxMax: 'vec3f', bodyPushPowder: 'f32', bodyAhead: 'vec2f', bodyLift: 'f32', bodyOnly: 'i32', boxStart: 'vec3i', boxSize: 'vec3u',
  // the react stage's block partition offset and colour (src/v2/airborne.js packAirborne)
  airborne: 'u32',
});
export const storageLayout = (count, readonly = []) => Array.from({ length: count }, (_, binding) =>
  ({ binding, visibility: STAGE.COMPUTE, buffer: { type: readonly.includes(binding) ? 'read-only-storage' : 'storage' } }));
export const PARTICLES_LAYOUT = storageLayout(5, [3]);
// RAYS: the rays the tick's first V1 step moved (integrate), for the gate of its later steps (blasts.js rayGate)
export const CONTROL = Object.freeze({ LIVE: 0, AIR: 1, PENDING: 2, BLAST: 3, FREE: 4, SPAWNS: 5, ENERGY: 6,
  OUTFLOW: 16, RAYS: 31, FREE_LIST: 32, PREFIX: 32 + PARTICLE_CAP });
export const shockBase = g => 32 + 2 * PARTICLE_CAP + 3 * g.nbricks + 64;
// The shock words' unit: Pa a count, added to the brick's pressure by the air source (air.js), as a puff's Pa is.
export const SHOCK_UNIT_PA = 1;
// V1 rays.js FISSION_P, legacy pressure a fission adds to its cell (react.js: Pr = spread + rayDep.y), in Pa
export const FISSION_PA = legacyPressureToPa(RAYS.FISSION_P);
export const heldBase = g => shockBase(g) + g.nbricks;
// the airborne requests (src/v2/airborne.js): a count, then a word a particle slot (the host slot
// and its request bits), which the react stage writes and blasts.js airborneEvents posts to events
export const airborneBase = g => heldBase(g) + PARTICLE_CAP;
// then each slot's puff (Pa, contact.js ctPuff), beside its request word: the slot word keeps
// only the request bits, and airborneEvents merges the two into the host's request
export const airbornePuffBase = g => airborneBase(g) + 1 + PARTICLE_CAP;
// a hit's shock (dShockHit): a count, then a word a particle slot for a charge it set off in the grid (posted
// as airborneBase's are), then a word a slot holding the id of a flying charge it set off, until that lands
export const shockPostBase = g => airbornePuffBase(g) + PARTICLE_CAP;
export const setOffBase = g => shockPostBase(g) + 1 + PARTICLE_CAP;
const f = n => Number.isInteger(n) && Math.abs(n)<1e21 ? `${n}.0` : String(n);
const table = (name, type, field, fallback) => `fn ${name}(id: u32) -> ${type} { switch id {\n${dynamicsRows.filter(r => r[field] !== fallback).map(r =>
  `case ${r.id}u: { return ${type === 'f32' ? f(r[field]) : `${r[field]}${type === 'u32' ? 'u' : 'i'}`}; }`).join('\n')}\ndefault: { return ${type === 'f32' ? f(fallback) : `${fallback}${type === 'u32' ? 'u' : 'i'}`}; } } }`;
// an f32 row's table, its elements grouped by value (one case a value: V1's terminal speeds repeat by kind and drag)
const groupedTable = (name, field, fallback) => {
  const groups = new Map();
  for (const r of dynamicsRows) if (r[field] !== fallback) groups.set(r[field], [...(groups.get(r[field]) ?? []), r.id]);
  return `fn ${name}(id: u32) -> f32 { switch id {\n${[...groups].map(([v, ids]) => `case ${ids.map(i => `${i}u`).join(', ')}: { return ${f(v)}; }`).join('\n')}\ndefault: { return ${f(fallback)}; } } }`;
};
// V1 react.js setOff counts blast.air (BLAST_LIT) with the crush: an explosive that needs air goes off
// only touching it. No explosive with a crushP needs air (elements.js: propane, the one that does, has
// none), so the crush reads here and in src/v2/airborne.js are V1's whole rule.
if (ELEMENTS.some(e => e.blast?.crushP && e.blast.air)) throw new Error('particles.js: an explosive with a crushP that needs air needs V1\'s blastAir in its crush');
const crushTable = dynamicsRows.filter(r => r.crush > 0).map(r => `case ${r.id}u: { return ${f(r.crush)}; }`).join('\n');
// The air pressure on a cell as V1 reads it, its parts as blasts.js's head holds them: the crush table, the
// cell reads (pressureCellWGSL: dBrickPressure, dPressureCell, dOpenPressure) and V1's pOn on them
// (pressureOnWGSL: dPressureOn). Each brick's pressure comes from `brick` (WGSL statements returning it from
// p, the brick's clamped cell) under names ending in suffix: the air binding's own has none; a blast that
// adds its pressure later in its tick reads the field it will leave (blasts.js damagePlan).
export const crushWGSL = `fn dCrush(id: u32) -> f32 { switch id { ${crushTable} default: { return 0.0; } } }`;
export const pressureCellWGSL = (suffix = '', brick = 'return air[brickOfCell(p)].vp.w;') => /* wgsl */ `// V1 keeps pressure per cell (react.js b.w); v2 keeps it per 4³ brick. A cell's
// pressure is the brick field read trilinearly between brick centres, as V1's
// own pressure sampler reads its field (render.js pressureAt), with V1's local
// singularity rule on top: its cell holds its vacuum, an open cell touching one
// SING_RING of it (air.js source holds the brick at those cells' mean).
fn dBrickPressure${suffix}(b0: vec3i) -> f32 {
  let p=clamp(mEdge(b0*4),vec3i(0),vec3i(NX-1,NY-1,NZ-1)); ${brick}
}
fn dPressureCell${suffix}(p: vec3i) -> f32 {
  let x=(vec3f(p)+0.5)*0.25-0.5; let i0=vec3i(floor(x)); let w1=x-vec3f(i0); var s=0.0;
  for (var k=0u;k<8u;k++) {
    let o=vec3i(i32(k&1u),i32((k>>1u)&1u),i32((k>>2u)&1u)); let w=mix(1.0-w1,w1,vec3f(o));
    s+=dBrickPressure${suffix}(i0+o)*w.x*w.y*w.z;
  }
  let core=loadMaterial(slotOf(p)).core;
  if (cid(core)==${E.SINGULARITY}u) { return contactVacuum(core)*${f(LEGACY_PRESSURE_PA)}; }
  // (only beside a singularity: V1 react.js takes the min for a SINGULARITY neighbour alone, so every
  // other cell keeps its pressure, a blast's included)
  for (var a=0u;a<3u;a++) { for (var side=-1;side<=1;side+=2) {
    let q=mEdge(p+dAxis(a)*side);
    if (inGrid(q)) { let n=loadMaterial(slotOf(q)).core;
      if (cid(n)==${E.SINGULARITY}u) { s=min(s,${f(PHYS.SING_RING)}*contactVacuum(n)*${f(LEGACY_PRESSURE_PA)}); } }
  } }
  return s;
}
// What V1 reads as a neighbour's pressure (react.js): 0 past the grid and in a solid (it holds no air).
fn dOpenPressure${suffix}(p0: vec3i) -> f32 {
  let p=mEdge(p0); if (!inGrid(p) || !mAirPressure() || cls(cid(loadMaterial(slotOf(p)).core))==1u) { return 0.0; }
  return dPressureCell${suffix}(p);
}
`;
export const pressureOnWGSL = (suffix = '') => /* wgsl */ `// V1 react.js pOn: the highest air pressure on a cell, its own (a solid holds none) or an open neighbour's.
fn dPressureOn${suffix}(p: vec3i, k: u32) -> f32 {
  var on=-1e30; if (k!=1u) { on=dPressureCell${suffix}(p); }
  for (var a=0u;a<3u;a++) { on=max(on,max(dOpenPressure${suffix}(p+dAxis(a)),dOpenPressure${suffix}(p-dAxis(a)))); }
  return on;
}
`;
// All of it, for an explosive's crushP (V1 react.js setOff) on a flying packet in its host cell (the react
// stage: src/v2/airborne.js charge.pressure), as blasts.js reads it on a resident cell (couplePlan,
// damageCharges). It reads its family's air binding.
export const airPressureWGSL = `\n${crushWGSL}\n${pressureCellWGSL()}${pressureOnWGSL()}`;
export function dynamicsCommon(g, nativeHead) {
  return /* wgsl */ `
${DynamicParams.wgsl}
@group(3) @binding(1) var<uniform> P: DynamicParams;
${nativeHead(g, { busyOut: true })}
${specialContactWGSL}
const D_CAP: u32 = ${PARTICLE_CAP}u;
const D_SLOTS: u32 = ${g.slots}u;
const D_BRICKS: u32 = ${g.nbricks}u;
const D_SWEEP_MAX: u32 = ${g.nx+g.ny+g.nz+3}u;
const D_WINDOWED: bool = ${!!g.windowed};
const D_NONE: u32 = 0xffffffffu;
const D_CELL: f32 = ${f(CELL_M)};
const D_DT: f32 = ${f(DT)};
const D_G: f32 = ${f(GRAVITY)};
const D_NEUTRON: u32 = ${NEUTRON_TAG}u;
const D_PHOTON: u32 = 254u;
// a ray's flight a stage runs: one V1 step (src/v2/dynamics-reference.js RAY_STEPS_PER_TICK a tick)
const D_RAY_DT: f32 = ${f(DT / RAY_STEPS_PER_TICK)};
const D_RAYS: u32 = ${CONTROL.RAYS}u;
const D_FREE: u32 = ${CONTROL.FREE_LIST}u;
const D_PREFIX: u32 = ${CONTROL.PREFIX}u;
const D_COUNTS: u32 = D_PREFIX + D_BRICKS;
const D_SHOCK: u32 = ${shockBase(g)}u;
const D_HELD: u32 = ${heldBase(g)}u;
const D_SHOCK_COUNT: u32 = ${shockPostBase(g)}u;
const D_SET_OFF: u32 = ${setOffBase(g)}u;
const D_AIRBORNE_POSTS: u32 = ${airborneBase(g) + 1}u;
const D_REQUEST_SHIFT: u32 = ${AIRBORNE_BITS_SHIFT}u;
const D_DUST: u32 = ${E.DUST}u;
struct DParticle { position: vec3f, id: u32, velocity: vec3f, c0: u32, tail: vec4u }
struct DAir { vp: vec4f, thermal: vec4f } // m/s, Pa; excess K, gas fraction, quiet ticks, reserved
${table('dMass', 'f32', 'mass', 0.001)}
${table('dToughness', 'f32', 'toughness', 1e30)}
${table('dStrength', 'f32', 'strength', 1e30)}
${table('dBreak', 'i32', 'breakInto', -1)}
${table('dShockKE', 'f32', 'shockKE', 0)}
// V1 common.js hitKE: closing at speed² u2, the mover i's mass against a solid j, else the reduced mass
fn dHitKE(mi: f32, mj: f32, jSolid: bool, u2: f32) -> f32 { return 0.5 * select(mi * mj / (mi + mj), mi, jSolid) * u2; }
// V1's cap on a speed (cells/step), and its cells/step per m/s of a throw (dynamics-reference.js SHOCK_THROW_MS)
const D_V_MAX: f32 = ${f(PHYS.V_MAX)};
const D_SHOCK_THROW: f32 = ${f(1 / SHOCK_THROW_MS)};
${groupedTable('dTerminal', 'terminal', TERMINAL_MS)}
${table('dLift', 'f32', 'lift', 12)}
fn dConductive(id: u32) -> bool { switch id {
${ELEMENTS.filter(e=>e.elec>0).map(e=>`case ${e.id}u: { return true; }`).join('\n')}
default: { return false; } } }
fn dHash(x0: u32) -> u32 { var x = x0; x = (x ^ (x >> 16u)) * 0x7feb352du; x = (x ^ (x >> 15u)) * 0x846ca68bu; return x ^ (x >> 16u); }
fn dId(p: vec3i, rule: u32) -> u32 { let w = vec3u(p + P.origin); return max(1u, dHash((w.x * 73856093u) ^ (w.y * 19349663u) ^ (w.z * 83492791u) ^ (P.tick * 2654435761u) ^ rule)); }
fn dKey(id: u32) -> u32 { return dHash(id ^ (P.tick * 2654435761u)); }
fn dRandom(id: u32, salt: u32) -> f32 { return f32(dHash(id ^ (P.tick * 2654435761u) ^ salt) >> 8u) / 16777216.0; }
fn dDir(id: u32) -> vec3f { let z = 2.0 * dRandom(id, 51u) - 1.0; let a = dRandom(id, 91u) * 6.283185307; let r = sqrt(max(0.0, 1.0-z*z)); return vec3f(r*cos(a), z, r*sin(a)); }
fn dSameLiquid(a: vec4u, b: vec4u) -> bool {
  return isLiq(a) && isLiq(b) && cid(a)==cid(b) && (cid(a)!=${E.LAVA}u || ctypeOf(a)==ctypeOf(b));
}
fn dMaterial(p: DParticle) -> Material { return Material(vec4u(p.c0, p.tail.xyz), bitcast<i32>(p.tail.w)); }
fn dParticle(position: vec3f, velocity: vec3f, id: u32, m: Material) -> DParticle { return DParticle(position, id, velocity, m.core.x, vec4u(m.core.yzw, bitcast<u32>(m.bank))); }
fn dEmpty() -> Material { return makeMaterial(0u, 20.0, 0u, 0u); }
fn dCarrier(m: Material) -> Material { return makeMaterial(0u,f32(cTq(m.core))*0.25-273.25,0u,0u); }
fn dParticleEnergy(m: Material) -> vec2u { return packetOwnedEnergy(m); }
fn dHeatEnergy(m: Material, heat: f32) -> vec2u {
  // One legacy cap*C = FULL*64*4 native energy units; fission's 150
  // exceeds signed32, so multiply/add in the foundation's signed64 pair.
  let amount = energyMul(u32(round(abs(heat)*256.0)),65536u);
  if (heat < 0.0) { return energySub(energyOf(m),amount); }
  return energyAdd(energyOf(m),amount);
}
fn dAddHeat(m: Material, heat: f32) -> Material { return withEnergy(m,dHeatEnergy(m,heat)); }
fn dWake(p: vec3i) {
  // New sources must wake the old and new neighbourhood, even across a brick boundary.
  for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let q = p + 4 * vec3i(x,y,z); if (inGrid(q)) { markBusy(q); }
  } } }
}
fn dThread(wg: vec3u, nwg: vec3u, li: u32) -> u32 { return (wg.x + wg.y * nwg.x) * 64u + li; }
fn dAxis(a: u32) -> vec3i { var v = vec3i(0); v[a] = 1; return v; }
fn dOpen(p0: vec3i) -> bool { let p=mEdge(p0); if (!inGrid(p)) { return P.edge==1u; } let k = cls(cid(loadMaterial(slotOf(p)).core)); return k == 0u || k == 4u; }
fn dWrap(p: vec3f) -> vec3f { let n=vec3f(f32(NX),f32(NY),f32(NZ)); if(P.edge==2u) { return p-n*floor(p/n); } return p; }
fn dOutflow(p: vec3i, m: Material) {
  let e=dParticleEnergy(m);
  if ((e.y&0x80000000u)==0u) { noteEnergySink(p,e); } else { noteEnergySource(p,energyNeg(e)); }
}
fn dAmount(m: Material) -> f32 { if (cls(cid(m.core)) == 3u) { return f32(cFill(m.core)) / 65536.0; } return 1.0; }
`;
}
export const main64 = (body,index='dThread(wg,nwg,li)') => /* wgsl */ `@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
 let t = ${index}; ${body}
}`;
export const main1 = body => `@compute @workgroup_size(1) fn main() { ${body} }`;
// Family: native3 + particles/scratch/claims/air/control5 = eight storage buffers.
function head(g, nativeHead) {
  const nuclear = ELEMENTS.filter(e => NUCLEAR[e.key]).map(e => {
    const s = sigmas(e.key), n = NUCLEAR[e.key];
    return `case ${e.id}u: { return DNuclear(vec3f(${s.slice(0,3).map(f)}), vec3f(${s.slice(3).map(f)}), ${f(n.h)}, ${f(n.A)}, ${f(n.nuF)}, ${f(n.nuT)}); }`;
  }).join('\n');
  return /* wgsl */ `${dynamicsCommon(g, nativeHead)}
${impactFoamWGSL}
struct DFlight { destination: vec4u, effect: vec4f } // hit, deposit, kind, key; energy/direction data
struct DNuclear { fast: vec3f, thermal: vec3f, h: f32, A: f32, nuF: f32, nuT: f32 }
@group(1) @binding(0) var<storage, read_write> particles: array<DParticle>;
@group(1) @binding(1) var<storage, read_write> flight: array<DFlight>;
@group(1) @binding(2) var<storage, read_write> claims: array<atomic<u32>>;
@group(1) @binding(3) var<storage, read> air: array<DAir>;
@group(1) @binding(4) var<storage, read_write> control: array<atomic<u32>>;
fn dNuclear(id: u32) -> DNuclear { switch id { ${nuclear} default: { return DNuclear(vec3f(0), vec3f(0), 0.0, 1.0, 0.0, 0.0); } } }
fn dOptical(id: u32) -> vec4f { switch id {
${ELEMENTS.map(e => `case ${e.id}u: { return vec4f(${(e.sigma ?? [0,0,0]).map(f).join(',')},${f(e.render === R.OPAQUE ? -(1+(e.reflect ?? 0)) : 0)}); }`).join('\n')}
default: { return vec4f(0); } } }
fn dPhotonEnergy(p: DParticle) -> vec3f { return bitcast<vec3f>(p.tail.xyz); }
// A photon after its V1 step: travelled, the share of its step's flight it made (short of a face it stops at);
// flip, the axis it reflects across (3: none); light, its RGB.
fn dPhotonMoved(p: DParticle, light: vec3f, travelled: f32, flip: u32) -> DParticle {
  var q = p; let delta = p.velocity * D_RAY_DT / D_CELL;
  if (travelled >= 1.0) { q.position = p.position + delta; }
  else { q.position = p.position + delta * max(0.0, travelled - 0.00001 / max(length(delta), 0.00001)); }
  if (flip < 3u) { q.velocity[flip] = -p.velocity[flip]; }
  q.tail = vec4u(bitcast<vec3u>(light), p.tail.w);
  return q;
}
fn dLiquidStreamPasses(cell: vec3i, incoming: vec4u, resident: vec4u) -> bool {
  if (!dSameLiquid(incoming,resident)) { return false; }
  let down = mDown(vec3f(cell)+0.5);
  if (all(down==vec3i(0))) { return false; }
  if (cFill(resident)<FULLU/2u) { return true; }
  let below = mEdge(cell+down);
  if (!inGrid(below)) { return D_WINDOWED || P.edge==1u; }
  let support = loadCore(slotOf(below)); let kind = cls(cid(support));
  return !(kind==1u || kind==2u || (isLiq(support) && cFill(support)>=FULLU));
}
// One elected sender owns the full receiver headroom (not gather's six-way share).
struct DDeposit { material: Material, accepted: bool }
fn dDeposit(before: Material, incoming: Material, kinetic: f32) -> DDeposit {
  let wet=dSameLiquid(incoming.core,before.core);
  if (cid(before.core)!=0u && !wet) { return DDeposit(before,false); }
  var after=incoming; var fill=0u;
  if (wet) {
    fill=cFill(before.core); let amount=cFill(incoming.core);
    if (amount>MAX_FILL-min(fill,MAX_FILL)) { return DDeposit(before,false); }
    var fuel=max(payloadOf(before.core),payloadOf(incoming.core));
    if (!conductsNative(cid(incoming.core))) {
      fuel=payloadOf(before.core)+payloadOf(incoming.core);
      if (fuel>65535u) { return DDeposit(before,false); }
    }
    after=before;
    after.core.y=(before.core.y&0xff000000u)|(fill+amount);
    if (MATERIAL_BURNS[cid(incoming.core)]) { after.core.y |= incoming.core.y&0x80000000u; }
    after.core=withPayload(after.core,fuel);
  }
  let combined=energyAdd(energyOf(before),dParticleEnergy(incoming));
  if (!energyFits(after,combined)) { return DDeposit(before,false); }
  after=withEnergy(after,combined);
  if (cls(cid(incoming.core))==3u) {
    let speed2=2.0*kinetic/max(dMass(cid(incoming.core))*dAmount(incoming),0.000001);
    let foam=impactFoam(incoming.core.x>>24u,select(0u,before.core.x>>24u,wet),cFill(incoming.core),fill,speed2);
    after.core.x=(after.core.x&0x00ffffffu)|(foam<<24u);
  }
  // Resting powder must not replay its launch-time fall state.
  if (cls(cid(after.core))==2u) { after.core=setFall(after.core,0.0,0.0); }
  return DDeposit(after,true);
}
fn dRecover(start: vec3i, local: vec3f, incoming: Material, kinetic: f32) -> u32 {
  let embedded=loadMaterial(slotOf(start));
  // A refused liquid or OTHER at the start is also a barrier. Compatible
  // liquid admission has already been tried before invoking recovery.
  if (cls(cid(incoming.core))!=2u || cid(embedded.core)!=cid(incoming.core)) { return D_NONE; }
  var cell=start;
  // Native bricks are four cells wide; this is local settlement, not a scan.
  for (var step=0u;step<4u;step++) {
    var direction=-mDown(vec3f(cell)+0.5);
    if (all(direction==vec3i(0))) {
      let fraction=fract(local); var nearest=2.0;
      for (var face=0;face<6;face++) {
        let axis=face>>1; let distance=select(1.0-fraction[axis],fraction[axis],(face&1)!=0);
        if (distance<nearest) { nearest=distance; direction=face6(face); }
      }
    }
    cell=mEdge(cell+direction);
    if (!inGrid(cell) || all(cell==start)) { return D_NONE; }
    let s=slotOf(cell); let before=loadMaterial(s);
    if (cid(before.core)==0u || dSameLiquid(incoming.core,before.core)) {
      if (dDeposit(before,incoming,kinetic).accepted) { return s; }
      return D_NONE; // Refused liquid/AIR is a barrier, never a partial transfer.
    }
    if (cls(cid(incoming.core))!=2u || cid(before.core)!=cid(incoming.core)) { return D_NONE; }
  }
  return D_NONE;
}
// Claim words are 0 when free, so a zeroed buffer is an empty table and no
// per-cell clear runs. The key word holds ~key: atomicMax(~key) keeps the
// minimum key. The election word holds index+1. Each (cell, kind) elects one
// claimant, and that winner frees both words once it has read them (dFree).
// flight[D_SWEEP] holds the live count that clear saw before its recount:
// zero means every pool sweep of this tick has no slot to visit.
const D_SWEEP: u32 = D_CAP;
fn dPoolEmpty() -> bool { return flight[D_SWEEP].destination.x == 0u; }
fn dClaim(s: u32, kind: u32, key: u32) { if (s != D_NONE) { atomicMax(&claims[s * 4u + kind * 2u], ~key); } }
fn dWon(s: u32, kind: u32, index: u32) -> bool { return s != D_NONE && atomicLoad(&claims[s*4u+kind*2u+1u]) == index + 1u; }
fn dFree(s: u32, kind: u32) { atomicStore(&claims[s*4u+kind*2u],0u); atomicStore(&claims[s*4u+kind*2u+1u],0u); }
fn dBefore(a: DParticle,b: DParticle) -> bool {
  let ap=bitcast<vec3u>(a.position);let av=bitcast<vec3u>(a.velocity);
  let bp=bitcast<vec3u>(b.position);let bv=bitcast<vec3u>(b.velocity);
  let aa=array<u32,12>(ap.x,ap.y,ap.z,a.id,av.x,av.y,av.z,a.c0,a.tail.x,a.tail.y,a.tail.z,a.tail.w);
  let bb=array<u32,12>(bp.x,bp.y,bp.z,b.id,bv.x,bv.y,bv.z,b.c0,b.tail.x,b.tail.y,b.tail.z,b.tail.w);
  for(var i=0u;i<12u;i++) { if(aa[i]!=bb[i]) { return aa[i]<bb[i]; } } return false;
}
fn dElect(s: u32,kind: u32,index: u32) {
  let at=s*4u+kind*2u+1u;
  loop {
    let old=atomicLoad(&claims[at]);
    if(old!=0u && !dBefore(particles[index],particles[old-1u])) { return; }
    if(atomicCompareExchangeWeak(&claims[at],old,index+1u).exchanged) { return; }
  }
}
// A flying dust packet's dust faces (V1 react.js dust clouds: nFuel), read in reactDust, before react's
// walkers clear the notes: another dust packet in its own cell, and each face cell holding dust, settled or flying
// (reactClaim notes a flying one in its host's kind-1 key word, free by then: deposit freed every one).
fn dDustFaces(s: u32) -> i32 {
  let p = cellOf(s);
  var n = select(0, 1, atomicLoad(&claims[s * 4u + 2u]) > 1u);
  for (var f = 0; f < 6; f++) {
    let q = mEdge(p + face6(f));
    if (!inGrid(q)) { continue; }
    let r = slotOf(q);
    if (cid(loadCore(r)) == D_DUST || atomicLoad(&claims[r * 4u + 2u]) != 0u) { n++; }
  }
  return n;
}
`;
}
// A packet's flight and hits on V1's laws (V1's units; react.js, move.js): the shock (dShockHit, dShockWall), breaking,
// landing heat and knocks (impact), its flight (integrate). Only those two stages read them, so the other particle
// stages, react's above all (its cold compile), don't carry them.
const packetHitsWGSL = /* wgsl */ `
// V1's density of a cell of id (elements.js dens; common.js densityOf for matter) and its collision rule's numbers
// (react.js shatter, move.js collide: PHYS.RESTITUTION past PHYS.COLLIDE_V cells/step)
const D_RESTITUTION: f32 = ${f(PHYS.RESTITUTION)};
const D_COLLIDE_V: f32 = ${f(PHYS.COLLIDE_V)};
fn dDens(id: u32) -> f32 { switch id {
${[...ELEMENTS.reduce((m, e) => e.dens ? m.set(e.dens, [...(m.get(e.dens) ?? []), e.id]) : m, new Map())].map(([d, ids]) => `case ${ids.map(i => `${i}u`).join(', ')}: { return ${f(d)}; }`).join('\n')}
default: { return 0.0; } } }
// V1's keep a step (react.js forces: 1 - DRAG; none for a liquid in free fall, as a flying liquid packet is):
// dynamics-reference.js PACKET_KEEP
fn dKeep(id: u32) -> f32 { switch id {
${[...PACKET_KEEP.reduce((m, k, id) => k !== 1 ? m.set(k, [...(m.get(k) ?? []), id]) : m, new Map())].map(([k, ids]) => `case ${ids.map(i => `${i}u`).join(', ')}: { return ${f(k)}; }`).join('\n')}
default: { return 1.0; } } }
const D_V1_STEP: f32 = ${f(1 / V1_STEP_MS)};
const D_PULL_STEP: f32 = ${f(STEP_S * STEP_S / CELL_M)};
const D_STEPS: u32 = ${STEPS_PER_TICK}u;
// A packet's tick on V1's law, a V1 step at a time (dynamics-reference.js packetStep, its twin along the pull): each
// step it moves along each axis, pace(|u|) = |u|/(2-|u|) cells for matter on its block's random draws (V1's Margolus
// move: gravity.js v1PaceRate, the grid grains' fall.js fallSteps) and |u| for a liquid (its R3 draws carry it as
// fast as its speed: dynamics-reference.js v1LiquidArrival), then takes the step's pull and its drag toward the air
// it is in (react.js forces), to V_MAX on each component. In V1's cells/step; m/s and m/s² in and out.
struct DPacketFlight { moved: vec3f, velocity: vec3f }
fn dPacketFlight(v0: vec3f, wind: vec3f, pull: vec3f, keep: f32, paced: bool) -> DPacketFlight {
  var out = DPacketFlight(vec3f(0), vec3f(0));
  for (var a = 0u; a < 3u; a++) {
    let w = wind[a] * D_V1_STEP; let g = pull[a] * D_PULL_STEP; var u = v0[a] * D_V1_STEP; var d = 0.0;
    for (var k = 0u; k < D_STEPS; k++) {
      let pace = min(abs(u), D_V_MAX); d += sign(u) * select(pace, pace / (2.0 - pace), paced);
      u = clamp(w + (u - w + g) * keep, -D_V_MAX, D_V_MAX);
    }
    out.moved[a] = d; out.velocity[a] = u / D_V1_STEP;
  }
  return out;
}
// V1 react.js shock from the charge's side (me): it and the matter j closing at V1's v (cells/step) set it
// off with hitKE past its blast.shock, a solid charge taking the mover's mass, a loose one its own against
// a solid and the reduced mass otherwise (common.js hitKE: V1's densities a cell each, dShockKE in dMass's
// units, dynamics-reference.js).
fn dShockActs(me: u32, j: u32, v: f32) -> bool {
  let m = dMass(me); let mj = dMass(j);
  return select(dHitKE(m, mj, cls(j) == C_SOLID, v * v), dHitKE(mj, m, true, v * v), cls(me) == C_SOLID) >= dShockKE(me);
}
// A hit on the face across axis of cell c at velocity: a landing when it moves down the pull's axis there
// (modes.js mDown; none without gravity), else a throw (dynamics-reference.js: the speed maps).
fn dLanding(c: vec3i, axis: u32, velocity: vec3f) -> bool {
  let down = mDown(vec3f(c)+0.5);
  return down[axis] != 0 && velocity[axis] * f32(down[axis]) > 0.0;
}
// V1's heat capacity of a cell (elements.js cap), for move.js impactHeat's share
fn dCap(id: u32) -> f32 { switch id {
${[...ELEMENTS.reduce((m, e) => (e.cap ?? 1) !== 1 ? m.set(e.cap, [...(m.get(e.cap) ?? []), e.id]) : m, new Map())].map(([c, ids]) => `case ${ids.map(i => `${i}u`).join(', ')}: { return ${f(c)}; }`).join('\n')}
default: { return 1.0; } } }
const D_LAND_KEEP: f32 = ${f(PHYS.LAND_POWDER_KEEP)};
const D_LAND_SCATTER: f32 = ${f(PHYS.LAND_POWDER_SCATTER)};
// V1 move.js impactHeat: a grain stopped by a solid faster than COLLIDE_V across the face loses its KE (½·dens·u², V1's
// units: landing, V1's land() keeps LAND_POWDER_KEEP of its sideways speed and scatters LAND_POWDER_SCATTER of the
// impact; a side hit stops its component: bounceR 0), shared by capacity, so both warm alike (ΔT = E·KE_TO_HEAT /
// (cap_i + cap_j)). [the packet's share, the solid's], cap·°C (dHeatEnergy's unit). dynamics-reference.js impactHeat.
fn dImpactHeat(pid: u32, tid: u32, velocity: vec3f, axis: u32, c: vec3i) -> vec2f {
  let u = min(abs(velocity) * D_SHOCK_THROW, vec3f(D_V_MAX)); let un = u[axis]; var out = vec2f(0.0);
  if (cls(pid) == C_POWDER && cls(tid) == C_SOLID && un > D_COLLIDE_V) {
    var lost = 0.5 * dDens(pid) * un * un;
    if (dLanding(c, axis, velocity)) { lost = 0.5 * dDens(pid) * (un * un * (1.0 - D_LAND_SCATTER * D_LAND_SCATTER) + (dot(u, u) - un * un) * (1.0 - D_LAND_KEEP * D_LAND_KEEP)); }
    let heat = lost * ${f(PHYS.KE_TO_HEAT)}; let share = dCap(pid) / (dCap(pid) + dCap(tid));
    out = vec2f(heat * share, heat * (1.0 - share));
  }
  return out;
}
// V1 move.js collide (MV-12): a grain hitting a resting grain faster than COLLIDE_V across the face passes its
// momentum on with RESTITUTION, so a blow travels through a pile like a Newton's cradle: the struck grain flies on
// from its cell at (1+R)·m_i/(m_i+m_j) of the closing speed (to V_MAX); the mover, left (m_i-R·m_j)/(m_i+m_j) of
// it, rests where it was (lands in the cell before: its slot flies the struck grain on, its cell keeps its carrier,
// energy exact as a whole-cell launch's). Only a hit whose landing this thread also won (deposit's claim), never a
// charge's (dShockHit) nor a held packet. dynamics-reference.js packetKnock is its twin.
// Intentional (decided under the user's delegation, 2026-10-22): the mover rests rather than keeping V1's
// (m_i-R·m_j)/(m_i+m_j) of its speed, and liquids flow on as runs rather than knock: a packet slot holds one cell.
struct DKnock { done: bool, packet: DParticle, cell: Material }
fn dKnock(t: u32, s: u32, p: DParticle, before: Material, axis: u32, landing: u32) -> DKnock {
  var out = DKnock(false, p, before);
  let pid = p.c0 & 255u; let tid = cid(before.core); let un = min(D_V_MAX, abs(p.velocity[axis]) * D_SHOCK_THROW);
  if (cls(pid) == C_POWDER && cls(tid) == C_POWDER && dShockKE(tid) <= 0.0 && un > D_COLLIDE_V &&
      atomicLoad(&control[D_HELD+t]) == 0u && dWon(landing, 1u, t)) {
    // (a grain into air: dDeposit's admission without its liquid merge, foam or a second inlined copy of it)
    let prev = loadMaterial(landing); let mover = dMaterial(p); let combined = energyAdd(energyOf(prev), dParticleEnergy(mover));
    if (cid(prev.core) == 0u && energyFits(mover, combined)) {
      var rests = withEnergy(mover, combined); rests.core = setFall(rests.core, 0.0, 0.0);
      storeMaterial(landing, prev, rests); setDeco(landing, particleDecoOf(t)); dWake(cellOf(landing)); dFree(landing, 1u);
      let mi = dDens(pid); let mj = dDens(tid);
      var q = dParticle(vec3f(cellOf(s) + P.origin) + 0.5, vec3f(0), p.id, before);
      q.velocity[axis] = sign(p.velocity[axis]) * min(D_V_MAX, (1.0 + D_RESTITUTION) * mi / (mi + mj) * un) / D_SHOCK_THROW;
      setParticleDeco(t, decoOf(s)); setDeco(s, 0u);
      out = DKnock(true, q, dCarrier(before));
    }
  }
  return out;
}
// a charge's V1 cells/step per m/s of its own landing (dynamics-reference.js shockFall: V1's own fall), here
// with its one reader, not the shared head, so its calibration rebuilds the particle stages alone
${table('dShockFall', 'f32', 'shockFall', 0)}
// a packet of matter landing on a charge: the speed (m/s) past which it sets it off (PACKET_SHOCK_LANDINGS); 0
// never. With its one reader too, so V1's landing laws rebuild the particle stages alone
fn dShockLand(mover: u32, charge: u32) -> f32 { switch (mover * 256u + charge) {
${PACKET_SHOCK_LANDINGS.map(r => `case ${r.faller * 256 + r.charge}u: { return ${f(r.speed)}; }`).join('\n')}
default: { return 0.0; } } }
// a grain packet landing on a charge at u (m/s): V1's odds of its fall setting it off (dynamics-reference.js
// PACKET_GRAIN_ODDS: v1GrainOdds by the fall its speed is in; BL-7), rolled once a hit (D_GRAIN_SALT)
const D_GRAIN_SALT: u32 = 0x6772616eu;
// (the bins as data, one loop over the pair's: a table compiles as one load, not a branch a bin)
const D_GRAIN_BINS = array<vec2f, ${PACKET_GRAIN_ODDS.reduce((n, r) => n + r.bins.length, 0)}>(${PACKET_GRAIN_ODDS.flatMap(r => r.bins.map(b => `vec2f(${f(b.speed)},${f(b.odds)})`)).join(',')});
fn dShockOdds(mover: u32, charge: u32, u: f32) -> f32 {
  var bins = vec2u(0u);
  switch (mover * 256u + charge) {
${(() => { let at = 0; return PACKET_GRAIN_ODDS.map(r => { const c = `    case ${r.faller * 256 + r.charge}u: { bins = vec2u(${at}u, ${r.bins.length}u); }`; at += r.bins.length; return c; }).join('\n'); })()}
    default: { }
  }
  var odds = 0.0;
  for (var i = 0u; i < bins.y; i++) { let b = D_GRAIN_BINS[bins.x + i]; if (u >= b.x) { odds = b.y; } }
  return odds;
}
// V1 react.js shock on a packet's hit (dynamics-reference.js packetShock is its CPU twin): matter and a
// charge closing at u (m/s, the packet's speed across the face it hits, axis) set it off as V1's hit at
// the V1 speed the same motion had, never by its own element or a gas (shockActs, isGasLike). A throw is
// V2's throws' map (D_SHOCK_THROW, V1's cap D_V_MAX); a landing is a fall: matter onto a charge past the
// pair's fall speed (dShockLand), a charge by its own fall (dShockFall), a solid's a throw. The charge
// hit is in the grid: its detonation is posted at s (blasts.js airborneEvents). The charge hitting is in
// flight: it is set off until it lands, with its detonation, where it is (deposit, react).
fn dShockHit(t: u32, s: u32, p: DParticle, hit: Material, axis: u32) {
  let pid = cid(dMaterial(p).core); let tid = cid(hit.core);
  if (pid == tid || cls(pid) == C_GAS || cls(tid) == C_GAS) { return; }
  let u = abs(p.velocity[axis]);
  let landing = dLanding(cellOf(s), axis, p.velocity);
  let thrown = min(D_V_MAX, u * D_SHOCK_THROW);
  if (dShockKE(tid) > 0.0) {
    var fires = dShockActs(tid, pid, thrown);
    if (landing && (cls(pid) == C_POWDER || cls(pid) == C_LIQUID)) { let on = dShockLand(pid, tid); fires = on > 0.0 && u >= on; }
    if (landing && cls(pid) == C_POWDER) { fires = dRandom(p.id, D_GRAIN_SALT) < dShockOdds(pid, tid, u); }
    if (fires) { atomicStore(&control[D_SHOCK_COUNT + 1u + t], s | (1u << D_REQUEST_SHIFT)); atomicAdd(&control[D_SHOCK_COUNT], 1u); }
  }
  if (dShockKE(pid) > 0.0) {
    var v = thrown;
    if (landing && dShockFall(pid) > 0.0) { v = min(D_V_MAX, u * dShockFall(pid)); }
    if (dShockActs(pid, tid, v)) { atomicStore(&control[D_SET_OFF + t], p.id); }
  }
}
// A charge landing on the box's solid edge (V1 react.js: past a solid edge a face is WALL, a solid), at u
// across it: as any hit on a WALL (dShockHit). Set off, it lands with its detonation as from any hit.
fn dShockWall(t: u32, pid: u32, u: f32, landing: bool, particleId: u32) {
  if (dShockKE(pid) <= 0.0) { return; }
  var v = min(D_V_MAX, u * D_SHOCK_THROW);
  if (landing && dShockFall(pid) > 0.0) { v = min(D_V_MAX, u * dShockFall(pid)); }
  if (dShockActs(pid, ${E.WALL}u, v)) { atomicStore(&control[D_SET_OFF + t], particleId); }
}
`;
// V1 shaders/rays.js raysAdvanceFrag, a photon's step (a stage runs one V1 step: D_RAY_DT). It flies straight on
// through clear matter (V1 has no refraction: EL-4), losing exp(-sigma·path) of its light to it (Beer-Lambert with the
// renderer's extinction; by a liquid's fill, EL-9), and stops at opaque matter: a metal keeps its reflectance share and
// reflects off the face it came in across, anything else takes it all. Its step's heat goes to the last cell it lost
// light to (V1's dep). Out of the grid it is gone, past a loop edge too (V1 !inGrid: EL-5). It fades at the end of its
// life, its light taking no cell. A step that heats a cell is that cell's one winner's to make (impact); a loser
// makes it the next step.
const photonStepWGSL = /* wgsl */ `
const D_PHOTON_HEAT: f32 = ${f(RAYS.PHOTON_HEAT / 3)};
const D_PHOTON_E_MIN: f32 = ${f(RAYS.PHOTON_E_MIN)};
// the cells a V1 step's flight (RAY_V_MAX cells) crosses at most, with the one it starts in
const D_PHOTON_CELLS: u32 = ${3 * Math.ceil(RAYS.RAY_V_MAX) + 1}u;
struct DPhotonStep { light: vec3f, heat: f32, cell: u32, travelled: f32, flip: u32, gone: bool }
fn dPhotonStep(local: vec3f, delta: vec3f, light0: vec3f) -> DPhotonStep {
  var out = DPhotonStep(light0, 0.0, D_NONE, 1.0, 3u, false);
  var cell = vec3i(floor(local)); var next = vec3f(1e30); var stride = vec3f(1e30); let step = vec3i(sign(delta));
  for (var a = 0u; a < 3u; a++) { if (delta[a] != 0.0) {
    stride[a] = abs(1.0 / delta[a]); next[a] = (f32(cell[a] + select(0,1,delta[a]>0.0)) - local[a]) / delta[a];
  } }
  let len = length(delta); var entry = 0.0; var entryAxis = 3u; var done = false;
  for (var crossed = 0u; crossed < D_PHOTON_CELLS && !done; crossed++) {
    var axis = 0u; if (next.y < next.x) { axis = 1u; } if (next.z < next[axis]) { axis = 2u; }
    if (!inGrid(cell)) { out.gone = true; out.travelled = entry; done = true; }
    else {
      let slot = slotOf(cell); let m = loadMaterial(slot); let optics = dOptical(cid(m.core));
      if (optics.w < 0.0) {
        let r = max(0.0, -optics.w - 1.0);
        out.heat += dot(out.light, vec3f(D_PHOTON_HEAT)) * (1.0 - r); out.light *= r; out.cell = slot; out.travelled = entry;
        if (max(out.light.x, max(out.light.y, out.light.z)) < D_PHOTON_E_MIN) {
          out.heat += dot(out.light, vec3f(D_PHOTON_HEAT)); out.light = vec3f(0); out.gone = true;
        } else { out.flip = entryAxis; }
        done = true;
      } else {
        let exit = min(1.0, next[axis]);
        if (any(optics.xyz > vec3f(0))) {
          let left = out.light * exp(-optics.xyz * dAmount(m) * max(0.0, exit - entry) * len);
          out.heat += dot(out.light - left, vec3f(D_PHOTON_HEAT)); out.light = left; out.cell = slot;
          if (max(left.x, max(left.y, left.z)) < D_PHOTON_E_MIN) {
            out.heat += dot(left, vec3f(D_PHOTON_HEAT)); out.light = vec3f(0); out.gone = true; out.travelled = exit; done = true;
          }
        }
        if (!done && next[axis] > 1.0) { done = true; }
        if (!done) { entry = next[axis]; entryAxis = axis; cell[axis] += step[axis]; next[axis] += stride[axis]; }
      }
    }
  }
  return out;
}
fn dPhotonIntegrate(t: u32, particle0: DParticle, local: vec3f) {
  if (particle0.id == 0u) { return; } // (integrate calls it on a live record alone: particle-live-check's rule)
  var particle = particle0;
  let life = (particle.c0 >> 8u) & 65535u;
  if (life <= 1u) { particles[t].id = 0u; atomicSub(&control[0],1u); noteDead(t); return; }
  particle.c0 = (particle.c0 & 0xff0000ffu) | ((life - 1u) << 8u);
  let s = dPhotonStep(local, particle.velocity * D_RAY_DT / D_CELL, dPhotonEnergy(particle));
  if (s.heat > 0.0 && s.cell != D_NONE) {
    particles[t] = particle;
    let packed = 5u | (min(s.flip, 3u) << 8u) | (select(0u, 1u, s.gone) << 10u) | (u32(round(clamp(s.travelled, 0.0, 1.0) * 65535.0)) << 16u);
    flight[t] = DFlight(vec4u(s.cell, D_NONE, packed, dKey(particle.id)), vec4f(s.light, s.heat));
    dClaim(s.cell, 0u, dKey(particle.id));
    return;
  }
  if (s.gone) { particles[t].id = 0u; atomicSub(&control[0],1u); noteDead(t); return; }
  particles[t] = dPhotonMoved(particle, s.light, s.travelled, min(s.flip, 3u));
}
`;
export function particlesWGSL(g, nativeHead, stage) {
  const h = head(g, nativeHead);
  // control[0] counts live slots exactly (spawns add, retirements subtract,
  // restore recounts); the particle renderer already gates on it.
  if (stage === 'clear') return h + main1(`
    flight[D_SWEEP] = DFlight(vec4u(atomicLoad(&control[0]),0u,0u,0u),vec4f(0));
    atomicStore(&control[0],0u); atomicStore(&control[18],0u); atomicStore(&control[D_RAYS],0u);
    atomicStore(&control[D_SHOCK_COUNT],0u); // this tick's shock posts (blasts.js airborneEvents drains them)
  `);
  if (stage === 'integrate') return h + packetHitsWGSL + photonStepWGSL + main64(/* wgsl */ `
    // Later stages read flight only for live slots, so dead slots skip it.
    if (t >= D_CAP || dPoolEmpty() || !slotLive(t) || particles[t].id == 0u) { return; }
    var particle = particles[t]; flight[t] = DFlight(vec4u(D_NONE,D_NONE,0u,0u),vec4f(0));
    // V1 steps a ray RAY_STEPS_PER_TICK times a tick, at most one interaction a step (shaders/rays.js): the ray stages
    // run once a V1 step (P.substep, dynamics.js advanceParticles); matter moves once a tick, at sub-step 0. The
    // first counts the live slots and the rays, which open the later steps' gate (blasts.js rayGate).
    let ray = (particle.c0 & 255u) >= D_PHOTON;
    if (P.substep != 0u && !ray) { return; }
    if (P.substep == 0u) { atomicAdd(&control[0],1u); if (ray) { atomicAdd(&control[D_RAYS],1u); } }
    let local = dWrap(particle.position - vec3f(P.origin));
    // Test in float BEFORE the i32 conversion: high-speed outflow may exceed
    // i32 coordinates, and conversion must not wrap it back into the grid.
    if (any(local<vec3f(0)) || any(local>=vec3f(${g.nx}.0,${g.ny}.0,${g.nz}.0))) {
      // (a ray out of the grid is gone: V1 shaders/rays.js !inGrid, a window's edge too)
      if (ray) { particles[t].id=0u; atomicSub(&control[0],1u); noteDead(t); }
      return;
    }
    let startCell = vec3i(floor(local));
    // World-window exits are retained, not deleted. A later shift can bring them back.
    dWake(startCell);
    let m = dMaterial(particle); let id = cid(m.core); let neutron = id == D_NEUTRON; let photon = id == D_PHOTON;
    var v = particle.velocity; var acceleration = mGravity(local);
    if (photon) { dPhotonIntegrate(t, particle, local); return; }
    // (a neutron's flight is its V1 step's, D_RAY_DT; matter's a tick's on V1's law, below)
    var travel = v * D_RAY_DT / D_CELL;
    if (neutron) {
      if ((particle.c0>>8u)!=0u) {
        let slot=slotOf(startCell); let pendingKind=particle.c0>>8u;
        flight[t]=DFlight(vec4u(slot,D_NONE,pendingKind,dKey(particle.id)),vec4f(f32(particle.tail.z+1u),0,0,0));
        dClaim(slot,0u,dKey(particle.id)); return; // exact deferred capture/fission, no re-roll or ageing
      }
      // pending children: the allocator must account for every one, once a tick
      // Intentional (decided under the user's delegation, 2026-10-22): a parent waits for its children, born at the
      // tick's allocation, so it skips the rest of that tick's V1 steps (V1 spawns them the same step)
      if (particle.tail.z > 0u) { if (P.substep == 0u) { atomicAdd(&control[18],particle.tail.z); } return; }
      if (particle.tail.x == 0u) { particles[t].id = 0u; atomicSub(&control[0],1u); noteDead(t); return; }
      particle.tail.x -= 1u; acceleration = vec3f(0);
    } else {
      let wind = select(vec3f(0),air[brickOfCell(startCell)].vp.xyz,mAirVelocity());
      if (cls(id) == 4u || atomicLoad(&control[D_HELD+t])!=0u) { acceleration = vec3f(0); }
      // V1's fall and flight, its steps a tick (dPacketFlight): so a packet lands when V1's cell would, as the grid
      // grains do. The sweep below runs straight to where they take it, its velocity going linearly from v to theirs
      // across the tick (the hit's speed at its share of the tick).
      let flown = dPacketFlight(v, wind, acceleration, dKeep(id), cls(id) != C_LIQUID);
      travel = flown.moved; acceleration = (flown.velocity - v) / D_DT;
    }
    let end = local + travel;
    particle.velocity = v + acceleration * D_DT;
    let delta = end - local; var cell = startCell; var previous = startCell;
    var next = vec3f(1e30); var stride = vec3f(1e30); let step = vec3i(sign(delta));
    for (var a = 0u; a < 3u; a++) { if (delta[a] != 0.0) {
      stride[a] = abs(1.0 / delta[a]);
      next[a] = (f32(cell[a] + select(0,1,delta[a]>0.0)) - local[a]) / delta[a];
    } }
    var hit = D_NONE; var deposit = D_NONE; var hitT = 1.0; var kind = 0u; var energy = 0.0;
    var entry = 0.0; var entryAxis = 1u; var optical = vec3f(0);
    var boundary=false; var crossed=0u;
    loop {
      // A straight segment crosses at most nx+ny+nz faces inside this box.
      // The bound detects non-progress; it never skips a wall or clips speed.
      let crossedLimit=select(f32(D_SWEEP_MAX),ceil(abs(delta.x))+ceil(abs(delta.y))+ceil(abs(delta.z))+6.0,P.edge==2u);
      if (f32(crossed)>crossedLimit || crossed==0xffffffffu) { atomicAdd(&control[19],1u); return; } crossed++;
      // (a neutron leaving the box is gone, past a loop edge too: V1 shaders/rays.js !inGrid)
      if (P.edge==2u && !neutron) { cell=mEdge(cell); }
      if (!inGrid(cell)) {
        if (neutron) { particles[t].id=0u; atomicSub(&control[0],1u); noteDead(t); atomicAdd(&control[16],1u); return; }
        if (!D_WINDOWED) {
          if (P.edge==1u) {
            dOutflow(previous,m);
            particles[t].id=0u; atomicSub(&control[0],1u); noteDead(t); atomicAdd(&control[16],1u); return;
          }
          boundary=true;let velocityAtHit=v+acceleration*(D_DT*entry);
          energy=0.5*dMass(id)*dAmount(m)*dot(velocityAtHit,velocityAtHit);
          dShockWall(t,id,abs(velocityAtHit[entryAxis]),dLanding(previous,entryAxis,velocityAtHit),particle.id);
          particle.velocity=vec3f(0); particle.position=vec3f(previous+P.origin)+0.5;
          if (cid(loadMaterial(slotOf(previous)).core)==0u) { deposit=slotOf(previous); }
        }
        break;
      }
      let slot = slotOf(cell); let destination = loadMaterial(slot); let targetId = cid(destination.core);
      var axis = 0u; if (next.y < next.x) { axis = 1u; } if (next.z < next[axis]) { axis = 2u; }
      let exit = min(1.0,next[axis]);
      if (neutron) {
        let materialId = contactNuclearMaterial(destination.core);
        let n = dNuclear(materialId); let e = bitcast<f32>(particle.tail.y);
        let fast = clamp(log(max(e,${f(RAYS.NEUT_E_THERMAL)})/${f(RAYS.NEUT_E_THERMAL)}) / log(${f(RAYS.NEUT_E_FAST/RAYS.NEUT_E_THERMAL)}),0.0,1.0);
        let inverseSpeed = sqrt(${f(RAYS.NEUT_E_THERMAL)}/max(e,${f(RAYS.NEUT_E_THERMAL)}));
        let cross = vec3f(mix(n.thermal.x,n.fast.x,fast),max(n.fast.y,n.thermal.y*inverseSpeed),max(n.fast.z,n.thermal.z*inverseSpeed))*dAmount(destination); let total = cross.x+cross.y+cross.z;
        let segment = max(0.0,exit-entry)*length(delta);
        if (total > 0.0 && dRandom(particle.id,slot ^ 511u) < 1.0-exp(-total*segment)) {
          hit = slot; hitT = entry; let choice = dRandom(particle.id,slot ^ 1231u)*total;
          if (choice < cross.x) { kind = 2u; } else if (choice < cross.x+cross.y) { kind = 3u; } else { kind = 4u; }
          energy = mix(n.nuT,n.nuF,fast); break;
        }
      } else if (targetId != 0u && cls(targetId) != 4u && !dLiquidStreamPasses(cell,m.core,destination.core)) {
        hit = slot; hitT = entry; kind = 1u; optical.x = f32(entryAxis); // the face it hits (dShockHit)
        particle.velocity=v+acceleration*(D_DT*entry);
        energy = 0.5*dMass(id)*dAmount(m)*dot(particle.velocity,particle.velocity);
        if (inGrid(previous) && cid(loadMaterial(slotOf(previous)).core) == 0u) { deposit = slotOf(previous); }
        else if (dSameLiquid(m.core,destination.core) && dDeposit(destination,m,energy).accepted) { deposit=slot; }
        else if (inGrid(previous)) {
          let before=loadMaterial(slotOf(previous));
          if (dSameLiquid(m.core,before.core) && dDeposit(before,m,energy).accepted) { deposit=slotOf(previous); }
        }
        if (deposit==D_NONE && entry==0.0 && atomicLoad(&control[D_HELD+t])==0u) {
          deposit=dRecover(startCell,local,m,energy);
        }
        break;
      }
      if (next[axis] > 1.0) { break; }
      previous = cell; entry = next[axis]; entryAxis=axis; cell[axis] += step[axis]; next[axis] += stride[axis];
    }
    if (hit == D_NONE) {
      if (!boundary) { particle.position = end + vec3f(P.origin); }
      // Gas packets hand back to an empty destination after each cell crossing.
      if (!neutron && cls(id) == 4u && inGrid(cell) && any(cell != startCell) && cid(loadMaterial(slotOf(cell)).core) == 0u) { deposit = slotOf(cell); }
    } else {
      particle.position = local + delta * max(0.0,hitT - 0.00001 / max(length(delta),0.00001)) + vec3f(P.origin);
    }
    particle.position=dWrap(particle.position-vec3f(P.origin))+vec3f(P.origin);
    particles[t] = particle;
    flight[t] = DFlight(vec4u(hit,deposit,kind,dKey(particle.id)), vec4f(energy,optical));
    dClaim(hit,0u,dKey(particle.id));
    if(atomicLoad(&control[D_HELD+t])!=0u) { flight[t].destination.y=D_NONE; } else { dClaim(deposit,1u,dKey(particle.id)); }
  `);
  if (stage === 'elect') return h + main64(`
    if (t >= D_CAP || dPoolEmpty() || !slotLive(t) || particles[t].id == 0u) { return; }
    let f = flight[t];
    for (var kind = 0u; kind < 2u; kind++) { let s = f.destination[kind];
      if (s != D_NONE && atomicLoad(&claims[s*4u+kind*2u]) == ~f.destination.w) { dElect(s,kind,t); }
    }
  `);
  // Impact reads only kind-0 election words and deposit only kind-1 words, so
  // a winner may free its claim at once: every other claimant loses either way.
  if (stage === 'impact') return h + packetHitsWGSL + main64(/* wgsl */ `
    if (t >= D_CAP || dPoolEmpty() || !slotLive(t) || particles[t].id == 0u) { return; }
    let f = flight[t]; let s = f.destination.x; if (!dWon(s,0u,t)) { return; }
    dFree(s,0u);
    var p = particles[t]; let before = loadMaterial(s); var after = before;
    if (f.destination.z == 1u) {
      let axis = u32(f.effect.y);
      dShockHit(t,s,p,before,axis);
      let id = cid(before.core); let cost = dToughness(id);
      // V1 react.js breaking, in V1's units (dynamics-reference.js impact, its twin): a mover breaks a breakable solid
      // it hits with ½·ρ·vn² of at least its hard, ρ its V1 density (its share of a cell, a liquid's fill) and vn
      // its closing speed across the face, cells/step to V_MAX (a packet's m/s as the throws' map reads it)
      let rho = dDens(p.c0 & 255u) * dAmount(dMaterial(p));
      let un = min(D_V_MAX, abs(p.velocity[axis]) * D_SHOCK_THROW);
      if (dBreak(id) >= 0 && 0.5 * rho * un * un >= cost) {
        after.core.x = (before.core.x & 0xffffff00u) | u32(dBreak(id));
        if (cid(after.core)!=id && cls(cid(after.core))==2u) { after.core=setFall(after.core,0.0,0.0); }
        // V1 react.js: the debris takes the fracture work as heat, KE_TO_HEAT
        // cap·°C per unit of toughness (a declared source; physics.js KE_TO_HEAT:
        // a shot keg's wood → sawdust ~200 °C, past gunpowder's ignition).
        let warm=dHeatEnergy(before,cost*${f(PHYS.KE_TO_HEAT)});
        if (!energyFits(after,warm)) { particles[t].velocity=vec3f(0); return; }
        after=withEnergy(after,warm); noteEnergySource(cellOf(s),energySub(warm,energyOf(before)));
        // V1 react.js shatter: the fracture takes hard of its KE along the face, then it hits the loose debris head
        // on (move.js collide: RESTITUTION past COLLIDE_V, else the debris just supports it). Stop at the first
        // face; what is left flies on for the next swept segment.
        let u1 = sqrt(max(un * un - 2.0 * cost / max(rho, 0.000001), 0.0)); var kept = u1;
        if (u1 > D_COLLIDE_V) { let debris = dDens(u32(dBreak(id))); kept = u1 * (rho - D_RESTITUTION * debris) / (rho + debris); }
        p.velocity[axis] = sign(p.velocity[axis]) * kept / D_SHOCK_THROW;
        if (dWon(f.destination.y,1u,t)) { dFree(f.destination.y,1u); } // deposit will not see it
        flight[t].destination.y=D_NONE; // fracture is not a landing: retain unspent KE
      } else {
        // a grain struck hard passes the blow on (dKnock; MV-12)
        let knock = dKnock(t, s, p, before, axis, f.destination.y);
        if (knock.done) { p = knock.packet; after = knock.cell; flight[t].destination.y = D_NONE; }
        // a grain stopped by a solid warms both (dImpactHeat; TH-10): the packet's share rides it to where it lands
        let warmth = dImpactHeat(p.c0 & 255u, id, p.velocity, axis, cellOf(s));
        if (warmth.y > 0.0 && energyFits(before, dHeatEnergy(before, warmth.y))) {
          after = dAddHeat(before, warmth.y); noteEnergySource(cellOf(s), energySub(energyOf(after), energyOf(before)));
        }
        let m = dMaterial(p); let owned = energyAdd(dParticleEnergy(m), energyMul(u32(round(warmth.x * 256.0)), 65536u));
        if (warmth.x > 0.0 && packetEnergyFits(m, owned)) {
          let warm = withPacketEnergy(m, owned); p.c0 = warm.core.x; p.tail = vec4u(warm.core.yzw, bitcast<u32>(warm.bank));
          noteEnergySource(cellOf(s), energySub(owned, dParticleEnergy(m)));
        }
        if (!knock.done) { p.velocity = vec3f(0); }
      }
    } else if ((f.destination.z & 255u) == 5u) {
      // a photon's V1 step with heat for this cell (dPhotonIntegrate): the cell takes its heat (V1 raysDepositFrag, a
      // declared source; past what its energy holds the rest is lost, as V1 clamps a cell's T at CELL_TEMP_MAX), the
      // photon its step
      let heat = f.effect.w;
      if (energyFits(before,dHeatEnergy(before,heat))) { after = dAddHeat(before,heat); }
      p = dPhotonMoved(p, f.effect.xyz, f32(f.destination.z >> 16u) / 65535.0, (f.destination.z >> 8u) & 3u);
      if (((f.destination.z >> 10u) & 1u) != 0u) { p.id=0u; atomicSub(&control[0],1u); noteDead(t); }
    } else if (f.destination.z == 2u) {
      let id = contactNuclearMaterial(before.core);
      let n = dNuclear(id); let alpha = pow((n.A-1.0)/(n.A+1.0),2.0);
      let r = dRandom(p.id,415u); let keep = select(alpha+(1.0-alpha)*r,r,dRandom(p.id,416u)<n.h);
      let e = max(${f(RAYS.NEUT_E_THERMAL)},bitcast<f32>(p.tail.y)*keep); p.tail.y = bitcast<u32>(e);
      // V1 shaders/rays.js neutSpeed (cells/step, to RAY_V_MAX), in m/s at V1's step rate (dynamics-reference.js rayNeutronMS)
      let speed = ${f(V1_STEP_MS)} * clamp(${f(RAYS.NEUT_V)}*sqrt(e/${f(RAYS.NEUT_E_FAST)}),${f(RAYS.NEUT_V_THERMAL)},${f(RAYS.RAY_V_MAX)});
      p.velocity = dDir(p.id)*speed;
    } else {
      // Native energy-bank helper is supplied by the thermal foundation.
      let heat=select(${f(RAYS.CAPTURE_HEAT)},${f(RAYS.FISSION_HEAT)},f.destination.z==4u);
      if (!energyFits(before,dHeatEnergy(before,heat))) {
        p.c0=D_NEUTRON|(f.destination.z<<8u); p.position=vec3f(cellOf(s)+P.origin)+0.5;
        if (f.destination.z==4u) { p.tail.z=u32(floor(f.effect.x-1.0))+select(0u,1u,dRandom(p.id,761u)<fract(f.effect.x-1.0)); }
        particles[t]=p; return;
      }
      after = dAddHeat(before,heat); p.c0=D_NEUTRON;
      if (f.destination.z == 4u) {
        p.tail.x = ${RAYS.NEUT_LIFE}u;
        p.tail.y = bitcast<u32>(${f(RAYS.NEUT_E_FAST)});
        // V1: FISSION_P legacy (3459 Pa) on its cell, the prompt energy that throws a runaway lump apart (EL-6)
        atomicAdd(&control[D_SHOCK+brickOfCell(cellOf(s))],${Math.round(FISSION_PA / SHOCK_UNIT_PA)}u);
        p.tail.z = u32(floor(f.effect.x-1.0)) + select(0u,1u,dRandom(p.id,761u)<fract(f.effect.x-1.0));
        atomicAdd(&control[18],p.tail.z);
        p.velocity = dDir(p.id)*${f(RAY_NEUTRON_FAST_MS)};
      } else { p.id = 0u; atomicSub(&control[0],1u); noteDead(t); }
    }
    if (f.destination.z>=3u) { noteEnergySource(cellOf(s),energySub(energyOf(after),energyOf(before))); }
    storeMaterial(s,before,after); dWake(cellOf(s)); particles[t] = p;
  `);
  if (stage === 'deposit') return h + main64(`
    if (t >= D_CAP || dPoolEmpty() || !slotLive(t) || particles[t].id == 0u) { return; }
    let s = flight[t].destination.y; if (!dWon(s,1u,t)) { return; }
    dFree(s,1u); if (atomicLoad(&control[D_HELD+t])!=0u) { return; }
    let before = loadMaterial(s);
    let admitted=dDeposit(before,dMaterial(particles[t]),flight[t].effect.x);
    if (!admitted.accepted) { return; }
    // landing in air, it brings its decoration back to the grid; merging into its own liquid, the
    // receiver keeps its paint, as a column move's does (columns.js colMove)
    if (cid(before.core)==0u) { setDeco(s,particleDecoOf(t)); }
    storeMaterial(s,before,admitted.material); dWake(cellOf(s));
    // a charge a hit set off (dShockHit) lands with its detonation, posted as a flying packet's are
    if (atomicLoad(&control[D_SET_OFF+t])==particles[t].id) {
      atomicStore(&control[D_AIRBORNE_POSTS+t],s|(1u<<D_REQUEST_SHIFT)); atomicAdd(&control[D_SHOCK_COUNT],1u);
    }
    particles[t].id = 0u; atomicSub(&control[0],1u); noteDead(t);
  `);
  if(stage==='bodyCouple') return h+main64(`
    if(t>=D_CAP || !slotLive(t) || particles[t].id==0u) { return; }var p=particles[t];let id=p.c0&255u;
    if(id>=D_PHOTON || cls(id)==1u || any(p.position<P.center) || any(p.position>P.boxMax) || (P.bodyOnly>=0 && id!=u32(P.bodyOnly))) { return; }
    let radial=p.position.xz-(P.center.xz+P.boxMax.xz)*0.5;var outward=vec2f(0);
    if(length(radial)>0.000001) { outward=normalize(radial); }
    else { let angle=dRandom(p.id,31u)*6.283185307;outward=vec2f(cos(angle),sin(angle)); }
    let direction=vec3f(outward.x+P.bodyAhead.x,P.bodyLift,outward.y+P.bodyAhead.y);
    let push=select(P.strength,P.bodyPushPowder,cls(id)==2u);
    p.velocity=P.vector+direction/max(length(direction),0.000001)*push;
    particles[t]=p;
  `);
  if (stage === 'holdSelect') return h + main64(`
    if (t>=D_CAP || !slotLive(t) || particles[t].id==0u || (particles[t].c0&255u)>=D_PHOTON) { return; }
    if (distance(particles[t].position,P.center)<=P.radius) { atomicStore(&control[D_HELD+t],P.sequence); }
  `);
  if (stage === 'holdCOM') return h + main1(`
    var mass=0.0; var offset=vec3f(0); var velocity=vec3f(0); var count=0u;
    // Only _hold records holdCOM, after this tick's clear: an empty pool skips the scan.
    let scanned=select(D_CAP,0u,dPoolEmpty());
    // Ascending slots, as the f32 sums require, but only those with a live bit: a word at a time,
    // its set bits lowest first (cost ∝ live particles, not the pool).
    for (var w=0u;w<scanned/32u;w++) {
      var live=atomicLoad(&act2[V2_PLIVE+w]);
      while (live!=0u) {
        let i=w*32u+firstTrailingBit(live); live&=live-1u;
        let p=particles[i]; if (p.id==0u || atomicLoad(&control[D_HELD+i])!=P.sequence) { continue; }
        let m=dMass(p.c0&255u)*dAmount(dMaterial(p));
        mass+=m; offset+=(p.position-P.center)*m; velocity+=p.velocity*m; count++;
      }
    }
    var center=P.center; if (mass>0.0) { center+=offset/mass; velocity/=mass; }
    for(var a=0u;a<3u;a++) { atomicStore(&control[8u+a],bitcast<u32>(center[a])); atomicStore(&control[12u+a],bitcast<u32>(velocity[a])); }
    atomicStore(&control[11],bitcast<u32>(mass)); atomicStore(&control[15],count);
  `);
  if (stage === 'holdApply') return h + main64(`
    // Mode 9 comes only from _hold, after this tick's clear; tool calls between ticks never gate.
    if (t>=D_CAP || (P.mode==9u && dPoolEmpty()) || !slotLive(t) || particles[t].id==0u || (particles[t].c0&255u)>=D_PHOTON) { return; }
    let held=atomicLoad(&control[D_HELD+t]); var p=particles[t];
    if (P.mode==9u) {
      if (held!=P.sequence) { return; }
      var center=vec3f(0); var mean=vec3f(0);
      for(var a=0u;a<3u;a++) { center[a]=bitcast<f32>(atomicLoad(&control[8u+a])); mean[a]=bitcast<f32>(atomicLoad(&control[12u+a])); }
      // GMod-style physgun: a critically damped COM spring, with relative
      // velocity damping. It attracts to a point, rather than repeatedly
      // kicking all matter in one arbitrary direction. Fixed60Hz, no gravity
      // while held; collisions still use the ordinary swept DDA.
      let omega=clamp(P.strength,1.0,60.0); let dt=clamp(P.radius,0.0,0.1);
      let error=(center-P.center)*D_CELL; let decay=exp(-omega*dt);
      let relative=mean-P.vector;
      let desired=P.vector+(relative-omega*(relative+omega*error)*dt)*decay;
      p.velocity=desired+(p.velocity-mean)*exp(-2.0*omega*dt);
    } else {
      let selected=select(distance(p.position,P.center)<=P.radius,held==P.sequence,P.sequence!=0u);
      if (!selected) { return; }
      if (P.mode!=12u) { p.velocity+=P.vector; }
      atomicStore(&control[D_HELD+t],0u);
    }
    particles[t]=p; let local=vec3i(floor(p.position))-P.origin; if (inGrid(local)) { dWake(local); }
  `);
  // ---- airborne matter takes part (src/v2/airborne.js): after the tick's landings, each flying
  // packet joins its cell's list (the claim's key word holds the last to join, its election word how
  // many have, each flight record the one before it), and the react stage, once a colour (src/v2/airborne.js AIRBORNE_COLOURS: no two cells
  // of one colour share a footprint), has the list's head take the cell's packets in their order.
  if (stage === 'reactClaim') return h + airborneClaimWGSL + main64(/* wgsl */ `
    // the posted requests' count starts over (blasts.js airborneEvents read last tick's)
    if (t == 0u) { atomicStore(&control[${airborneBase(g)}u],0u); }
    if (t >= D_CAP || dPoolEmpty() || !slotLive(t) || particles[t].id == 0u) { return; }
    let particle = particles[t];
    flight[t] = DFlight(vec4u(D_NONE,D_NONE,0u,0u),vec4f(0));
    if ((particle.c0 & 255u) >= D_PHOTON) { return; }
    let local = dWrap(particle.position - vec3f(P.origin));
    if (any(local<vec3f(0)) || any(local>=vec3f(${g.nx}.0,${g.ny}.0,${g.nz}.0))) { return; }
    let s = slotOf(vec3i(floor(local))); let kind = cls(cid(loadCore(s)));
    // only through air and gas: a packet inside other matter lands or strikes it this tick or the next
    if (kind != C_AIR && kind != C_GAS) { return; }
    // (impact freed every kind-0 word it elected on: the cell's word is free here)
    let next = atomicExchange(&claims[s*4u],t+1u); atomicAdd(&claims[s*4u+1u],1u);
    flight[t] = DFlight(vec4u(s,next,D_REACT_KIND,dKey(particle.id ^ D_REACT_SALT)),vec4f(f32(dReactHash(particle)),0,0,0));
    // a dust packet notes itself in its cell's kind-1 key word (deposit freed every one), for its
    // neighbours' clouds (dDustFaces, reactDust); the cell's walker clears it (react)
    if ((particle.c0 & 255u) == D_DUST) { atomicAdd(&claims[s*4u+2u],1u); }
  `);
  // a flying dust packet's dust faces, once every packet has joined its cell's list and before any
  // walker clears the notes (dDustFaces): a stage of its own, so every cloud counts the same notes
  if (stage === 'reactDust') return h + airborneClaimWGSL + main64(/* wgsl */ `
    if (t >= D_CAP || dPoolEmpty() || !slotLive(t) || particles[t].id == 0u) { return; }
    let f = flight[t];
    if (f.destination.z != D_REACT_KIND || (particles[t].c0 & 255u) != D_DUST) { return; }
    flight[t].effect.y = f32(dDustFaces(f.destination.x));
  `);
  if (stage === 'react') {
    const rh = head(g, (grid, o) => withContactTable(nativeHead(grid, o)));
    return rh + contactRulesWGSL('i32(min(3u,arrayLength(&flight)))') + airborneReactWGSL + packetTouchWGSL(PARTICLE_CAP) + airPressureWGSL + /* wgsl */ `
// Is packet a after packet b in its cell's order (src/v2/airborne.js airborneOrder)?
fn dReactAfter(a: u32, b: u32) -> bool {
  if (b == D_NONE) { return true; }
  let fa = flight[a]; let fb = flight[b];
  if (fa.destination.w != fb.destination.w) { return fa.destination.w > fb.destination.w; }
  if (fa.effect.x != fb.effect.x) { return fa.effect.x > fb.effect.x; }
  return a > b;
}
// One packet of the cell at p (slot s), with the host and faces the one before it left. False once
// the host is no longer air or gas: the rest land or strike it next tick.
fn dReactOne(t: u32, s: u32, p: vec3i) -> bool {
  // (a list holds the packets live at the claim, and only this thread retires them)
  if (!slotLive(t) || particles[t].id == 0u) { return true; }
  let before = loadMaterial(s); let kind = cls(cid(before.core));
  if (kind != C_AIR && kind != C_GAS) { return false; }
  var faces: array<Material, 6>; var slots: array<u32, 6>; var valid = 0u;
  for (var f = 0u; f < 2u * dAxes(); f++) {
    let q = mEdge(p + face6(i32(f))); slots[f] = D_NONE;
    if (inGrid(q)) { slots[f] = slotOf(q); faces[f] = loadMaterial(slots[f]); valid |= 1u << f; }
  }
  var particle = particles[t];
  let onFloor = select(0, 1, p.y == 0 && P.edge == D_REACT_SOLID_EDGE);
  let inBlock = dInBlock(p); let trailing = dTrailing(particle.velocity);
  // what sets it off besides its own rules: a hit's mark (dShockHit), a dust cloud's speed, dust, flame
  // and hot faces (reactDust, dReactDustFaces)
  var charge = DReactCharge(atomicLoad(&control[D_SET_OFF+t]) == particle.id, length(particle.velocity) * D_DT / D_CELL, i32(flight[t].effect.y), 0, 0, 0.0, particle.velocity * D_DT / D_CELL);
  if ((particle.c0 & 255u) == D_DUST) { let dust = dReactDustFaces(p); charge.fire = dust.x; charge.hot = dust.y; }
  // and the air pressure on a charge with a crushP (dReact compares them): V1 react.js pOn, the highest of
  // its cell's (it flies in its host's air; a solid holds none) and its host's open faces' (dOpenPressure),
  // as couplePlan reads a resident cell's (dPressureOn). The faces in a loop bound at run time (dAxes), so
  // their read is inlined once.
  let chargeId = particle.c0 & 255u;
  if (dCrush(chargeId) > 0.0 && mAirPressure()) {
    // its own cell first (k 0, none in a solid), then each face's open pressure (dOpenPressure), all
    // through one dPressureCell call site (cold compile)
    var on = -1e30;
    for (var k = 0u; k < 1u + 2u * dAxes(); k++) {
      var q = p; var holds = cls(chargeId) != C_SOLID; var value = -1e30;
      if (k > 0u) {
        q = mEdge(p + face6(i32(k) - 1)); value = 0.0;
        holds = inGrid(q) && cls(cid(loadMaterial(slotOf(q)).core)) != 1u;
      }
      if (holds) { value = dPressureCell(q); }
      on = max(on, value);
    }
    charge.pressure = on;
  }
  let r = dReact(dMaterial(particle), before, faces, valid, inBlock, trailing, onFloor, bitcast<i32>(flight[t].destination.w), charge);
  // the cells beside it see it this tick, as V1's react saw a moving neighbour: its touch on each, for
  // its own step in the block pass and, a fuse's, in the electric pass (contact.js ctPacketTouch)
  for (var f = 0u; f < 2u * dAxes(); f++) { if (r.touch[f] != 0) { notePacketTouch(slots[f], r.touch[f]); } }
  if (r.state == D_REACT_REFUSED) { return true; }
  if (any(r.source != vec2u(0u))) { noteEnergySource(p,r.source); }
  if (any(r.sink != vec2u(0u))) { noteEnergySink(p,r.sink); }
  // the decoration follows the matter (shaders/move.js): a charge that lands brings its paint, a gas it
  // displaces takes the cell's into flight, and air, or matter made in air, holds none (the block
  // pass's rule: shaders/v2.js v2BlockWGSL)
  let paint = particleDecoOf(t);
  if (r.state == D_REACT_LANDED) { setDeco(s,paint); }
  else if (r.state == D_REACT_DISPLACED) { setParticleDeco(t,decoOf(s)); setDeco(s,paint); }
  else if (cid(before.core) != cid(r.host.core) && (cid(before.core) == 0u || cid(r.host.core) == 0u)) { setDeco(s,0u); }
  storeMaterial(s,before,r.host);
  // its partners beside it (the face its host stands in is the host's, written above)
  for (var a = 0u; a < dAxes(); a++) {
    let f = inBlock[a];
    if (f == trailing || ((valid >> f) & 1u) == 0u) { continue; }
    let was = faces[f]; let now = r.partners[a];
    if (all(was.core == now.core) && was.bank == now.bank) { continue; }
    if (cid(was.core) != cid(now.core) && (cid(was.core) == 0u || cid(now.core) == 0u)) { setDeco(slots[f],0u); }
    storeMaterial(slots[f],was,now);
  }
  dWake(p);
  if (r.requests != 0u) {
    atomicStore(&control[${airborneBase(g) + 1}u+t],s|((r.requests&${AIRBORNE_LANDED_REQUESTS}u)<<${AIRBORNE_BITS_SHIFT}u)); atomicAdd(&control[${airborneBase(g)}u],1u);
    atomicStore(&control[${airbornePuffBase(g)}u+t],r.requests/${CONTACT_PUFF_UNIT}u);
  }
  // a set-off charge has landed: the gas it displaced flies on in its slot, under the same id, not set off
  if (r.state == D_REACT_LANDED || r.state == D_REACT_DISPLACED) { atomicStore(&control[D_SET_OFF+t],0u); }
  if (r.state == D_REACT_FLYING || r.state == D_REACT_DISPLACED) {
    particle.c0 = r.particle.core.x; particle.tail = vec4u(r.particle.core.yzw,bitcast<u32>(r.particle.bank));
    particles[t] = particle; return true;
  }
  // used up, or landed in air: the packet's death as the particle lane writes it, no hold surviving it
  particles[t].id = 0u; atomicSub(&control[0],1u); noteDead(t); atomicStore(&control[D_HELD+t],0u);
  return true;
}
` + main64(/* wgsl */ `
    if (t >= D_CAP || dPoolEmpty() || !slotLive(t) || particles[t].id == 0u) { return; }
    let f = flight[t]; let s = f.destination.x;
    if (f.destination.z != D_REACT_KIND || s == D_NONE) { return; }
    let p = cellOf(s);
    // this dispatch's colour, and the cell's list's head: one thread a cell
    if (dReactColour(p) != (P.airborne >> D_REACT_OFFSET_BITS) || atomicLoad(&claims[s*4u]) != t+1u) { return; }
    // (the walk takes exactly as many as joined: nothing past this tick's list is ever read)
    let count = atomicLoad(&claims[s*4u+1u]);
    // (and its dust notes: reactDust has read every one)
    atomicStore(&claims[s*4u],0u); atomicStore(&claims[s*4u+1u],0u); atomicStore(&claims[s*4u+2u],0u);
    // the cell's packets, each after the one before in their order (a pass over the list for each)
    var last = D_NONE;
    loop {
      var best = D_NONE; var at = t+1u;
      for (var k = 0u; k < count && at != 0u; k++) {
        let i = at-1u;
        if (dReactAfter(i,last) && (best == D_NONE || dReactAfter(best,i))) { best = i; }
        at = flight[i].destination.y;
      }
      if (best == D_NONE || !dReactOne(best,s,p)) { break; }
      last = best;
    }
  `);
  }
  throw new Error(`Unknown particles stage ${stage}`);
}
export const PARTICLE_STAGES = ['clear','integrate','elect','impact','deposit','holdSelect','holdCOM','holdApply','bodyCouple','reactClaim','reactDust','react'];

export const WGSL_CHECK = PARTICLE_STAGES.map(stage => ({ name: `v2particles_${stage}`, kind: 'compute',
  code: g => particlesWGSL(g,nativeDynamicsHead,stage), layouts: () => [V2_DYNAMICS_LAYOUT,PARTICLES_LAYOUT,'EMPTY'], tool: true }));
