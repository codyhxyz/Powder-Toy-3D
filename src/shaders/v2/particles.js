import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../v2.js';
import { MODE_FIELDS } from '../../v2/modes.js';
import { specialContactWGSL } from './contact.js';
import { impactFoamWGSL } from '../../v2/foam.js';
import { uniformStruct } from '../../gpu/params.js';
import { STAGE } from '../../gpu/kernels.js';
import { dynamicsRows, PARTICLE_CAP, CELL_M, DT, GRAVITY, AIR, NEUTRON_TAG } from '../../v2/dynamics-reference.js';
import { NUCLEAR, sigmas, RAYS } from '../../rays.js';
import { ELEMENTS, E, R } from '../../elements.js';
export { PARTICLE_CAP };
export const DynamicParams = uniformStruct('DynamicParams', {
  tick: 'u32', busyIn: 'u32', busyOut: 'u32', mode: 'u32', origin: 'vec3i', sequence: 'u32',
  center: 'vec3f', radius: 'f32', vector: 'vec3f', strength: 'f32', shift: 'vec3i', substep: 'u32', nativeJets: 'u32', ...MODE_FIELDS,
  blastEnd:'vec3f', blastGrow:'vec3f', blastShape:'u32', blastFilter:'i32', blastMasked:'u32', blastMaskOrigin:'vec3i', blastFade:'u32', blastBounded:'u32', blastLo:'vec3i', blastHi:'vec3i',
  boxMax: 'vec3f', bodyPushPowder: 'f32', bodyAhead: 'vec2f', bodyLift: 'f32', bodyOnly: 'i32', boxStart: 'vec3i', boxSize: 'vec3u',
});
export const storageLayout = (count, readonly = []) => Array.from({ length: count }, (_, binding) =>
  ({ binding, visibility: STAGE.COMPUTE, buffer: { type: readonly.includes(binding) ? 'read-only-storage' : 'storage' } }));
export const PARTICLES_LAYOUT = storageLayout(5, [3]);
export const CONTROL = Object.freeze({ LIVE: 0, AIR: 1, PENDING: 2, BLAST: 3, FREE: 4, SPAWNS: 5, ENERGY: 6,
  OUTFLOW: 16, FREE_LIST: 32, PREFIX: 32 + PARTICLE_CAP });
export const shockBase = g => 32 + 2 * PARTICLE_CAP + 3 * g.nbricks + 64;
export const heldBase = g => shockBase(g) + g.nbricks;
const f = n => Number.isInteger(n) && Math.abs(n)<1e21 ? `${n}.0` : String(n);
const table = (name, type, field, fallback) => `fn ${name}(id: u32) -> ${type} { switch id {\n${dynamicsRows.filter(r => r[field] !== fallback).map(r =>
  `case ${r.id}u: { return ${type === 'f32' ? f(r[field]) : `${r[field]}${type === 'u32' ? 'u' : 'i'}`}; }`).join('\n')}\ndefault: { return ${type === 'f32' ? f(fallback) : `${fallback}${type === 'u32' ? 'u' : 'i'}`}; } } }`;
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
const D_FREE: u32 = ${CONTROL.FREE_LIST}u;
const D_PREFIX: u32 = ${CONTROL.PREFIX}u;
const D_COUNTS: u32 = D_PREFIX + D_BRICKS;
const D_SHOCK: u32 = ${shockBase(g)}u;
const D_HELD: u32 = ${heldBase(g)}u;
struct DParticle { position: vec3f, id: u32, velocity: vec3f, c0: u32, tail: vec4u }
struct DAir { vp: vec4f, thermal: vec4f } // m/s, Pa; excess K, gas fraction, quiet ticks, reserved
${table('dMass', 'f32', 'mass', 0.001)}
${table('dToughness', 'f32', 'toughness', 1e30)}
${table('dStrength', 'f32', 'strength', 1e30)}
${table('dBreak', 'i32', 'breakInto', -1)}
${table('dTerminal', 'f32', 'terminal', 55)}
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
fn dIOR(id: u32) -> f32 { switch id {
case ${E.GLASS}u: { return 1.5; } case ${E.WATER}u: { return 1.333; } case ${E.ICE}u: { return 1.31; }
default: { return 1.0; } } }
fn dPhotonEnergy(p: DParticle) -> vec3f { return bitcast<vec3f>(p.tail.xyz); }
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
`;
}
export function particlesWGSL(g, nativeHead, stage) {
  const h = head(g, nativeHead);
  // control[0] counts live slots exactly (spawns add, retirements subtract,
  // restore recounts); the particle renderer already gates on it.
  if (stage === 'clear') return h + main1(`
    flight[D_SWEEP] = DFlight(vec4u(atomicLoad(&control[0]),0u,0u,0u),vec4f(0));
    atomicStore(&control[0],0u); atomicStore(&control[18],0u);
  `);
  if (stage === 'integrate') return h + main64(/* wgsl */ `
    // Later stages read flight only for live slots, so dead slots skip it.
    if (t >= D_CAP || dPoolEmpty() || !slotLive(t) || particles[t].id == 0u) { return; }
    var particle = particles[t]; flight[t] = DFlight(vec4u(D_NONE,D_NONE,0u,0u),vec4f(0));
    atomicAdd(&control[0],1u);
    let local = dWrap(particle.position - vec3f(P.origin));
    // Test in float BEFORE the i32 conversion: high-speed outflow may exceed
    // i32 coordinates, and conversion must not wrap it back into the grid.
    if (any(local<vec3f(0)) || any(local>=vec3f(${g.nx}.0,${g.ny}.0,${g.nz}.0))) { return; }
    let startCell = vec3i(floor(local));
    // World-window exits are retained, not deleted. A later shift can bring them back.
    dWake(startCell);
    let m = dMaterial(particle); let id = cid(m.core); let neutron = id == D_NEUTRON; let photon = id == D_PHOTON;
    var v = particle.velocity; var acceleration = mGravity(local);
    if (photon) {
      let life = (particle.c0 >> 8u)&65535u; particle.c0 = (particle.c0&0xff0000ffu) | ((max(1u,life)-1u)<<8u);
      acceleration = vec3f(0);
    } else if (neutron) {
      if ((particle.c0>>8u)!=0u) {
        let slot=slotOf(startCell); let pendingKind=particle.c0>>8u;
        flight[t]=DFlight(vec4u(slot,D_NONE,pendingKind,dKey(particle.id)),vec4f(f32(particle.tail.z+1u),0,0,0));
        dClaim(slot,0u,dKey(particle.id)); return; // exact deferred capture/fission, no re-roll or ageing
      }
      if (particle.tail.z > 0u) { atomicAdd(&control[18],particle.tail.z); return; } // pending children: allocator must account for every one
      if (particle.tail.x == 0u) { particles[t].id = 0u; atomicSub(&control[0],1u); noteDead(t); return; }
      particle.tail.x -= 1u; acceleration = vec3f(0);
    } else {
      let wind = select(vec3f(0),air[brickOfCell(startCell)].vp.xyz,mAirVelocity());
      if (cls(id) == 4u || atomicLoad(&control[D_HELD+t])!=0u) { acceleration = vec3f(0); }
      let relative = v - wind;
      // Implicit quadratic drag is stable at any speed; it is NOT a displacement cap.
      let drag = D_G / (dTerminal(id) * dTerminal(id));
      v = wind + relative / (1.0 + drag * length(relative) * D_DT);
    }
    let end = local + (v * D_DT + 0.5 * acceleration * D_DT * D_DT) / D_CELL;
    particle.velocity = v + acceleration * D_DT;
    let delta = end - local; var cell = startCell; var previous = startCell;
    var next = vec3f(1e30); var stride = vec3f(1e30); let step = vec3i(sign(delta));
    for (var a = 0u; a < 3u; a++) { if (delta[a] != 0.0) {
      stride[a] = abs(1.0 / delta[a]);
      next[a] = (f32(cell[a] + select(0,1,delta[a]>0.0)) - local[a]) / delta[a];
    } }
    var hit = D_NONE; var deposit = D_NONE; var hitT = 1.0; var kind = 0u; var energy = 0.0;
    var entry = 0.0; var entryAxis = select(1u,particle.tail.w&3u,photon); var optical = vec3f(0);
    var boundary=false; var crossed=0u;
    loop {
      // A straight segment crosses at most nx+ny+nz faces inside this box.
      // The bound detects non-progress; it never skips a wall or clips speed.
      let crossedLimit=select(f32(D_SWEEP_MAX),ceil(abs(delta.x))+ceil(abs(delta.y))+ceil(abs(delta.z))+6.0,P.edge==2u);
      if (f32(crossed)>crossedLimit || crossed==0xffffffffu) { atomicAdd(&control[19],1u); return; } crossed++;
      if (P.edge==2u) { cell=mEdge(cell); }
      if (!inGrid(cell)) {
        if (!D_WINDOWED) {
          if (neutron || photon || P.edge==1u) {
            if (!neutron && !photon) { dOutflow(previous,m); }
            particles[t].id=0u; atomicSub(&control[0],1u); noteDead(t); atomicAdd(&control[16],1u); return;
          }
          boundary=true;let velocityAtHit=v+acceleration*(D_DT*entry);
          energy=0.5*dMass(id)*dAmount(m)*dot(velocityAtHit,velocityAtHit);
          particle.velocity=vec3f(0); particle.position=vec3f(previous+P.origin)+0.5;
          if (cid(loadMaterial(slotOf(previous)).core)==0u) { deposit=slotOf(previous); }
        }
        break;
      }
      let slot = slotOf(cell); let destination = loadMaterial(slot); let targetId = cid(destination.core);
      var axis = 0u; if (next.y < next.x) { axis = 1u; } if (next.z < next[axis]) { axis = 2u; }
      let exit = min(1.0,next[axis]);
      if (photon) {
        let optics = dOptical(targetId); let segment = max(0.0,exit-entry)*length(delta);
        let priorId = select(cid(loadMaterial(slotOf(previous)).core),particle.c0>>24u,entry==0.0);
        if (((particle.c0>>8u)&65535u)==0u || optics.w<0.0 || any(optics.xyz>vec3f(0)) || dIOR(priorId)!=dIOR(targetId)) {
          hit=slot; hitT=entry; energy=segment; kind=5u;
          optical=vec3f(f32(entryAxis+axis*4u),dIOR(priorId)/dIOR(targetId),f32(step[entryAxis])); break;
        }
      } else if (neutron) {
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
        hit = slot; hitT = entry; kind = 1u;
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
      if (!neutron && !photon && cls(id) == 4u && inGrid(cell) && any(cell != startCell) && cid(loadMaterial(slotOf(cell)).core) == 0u) { deposit = slotOf(cell); }
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
  if (stage === 'impact') return h + main64(/* wgsl */ `
    if (t >= D_CAP || dPoolEmpty() || !slotLive(t) || particles[t].id == 0u) { return; }
    let f = flight[t]; let s = f.destination.x; if (!dWon(s,0u,t)) { return; }
    dFree(s,0u);
    var p = particles[t]; let before = loadMaterial(s); var after = before;
    if (f.destination.z == 1u) {
      let id = cid(before.core); let cost = dToughness(id);
      if (cls(p.c0 & 255u) != 3u && dBreak(id) >= 0 && f.effect.x >= cost) {
        after.core.x = (before.core.x & 0xffffff00u) | u32(dBreak(id));
        if (cid(after.core)!=id && cls(cid(after.core))==2u) { after.core=setFall(after.core,0.0,0.0); }
        if (!energyFits(after,energyOf(before))) { particles[t].velocity=vec3f(0); return; }
        after=withEnergy(after,energyOf(before));
        // Fracture spends KE, never manufactures heat. Stop at the first face;
        // remaining KE survives for the next swept segment.
        p.velocity *= sqrt(max(0.0,1.0-cost/max(f.effect.x,0.000001)));
        if (dWon(f.destination.y,1u,t)) { dFree(f.destination.y,1u); } // deposit will not see it
        flight[t].destination.y=D_NONE; // fracture is not a landing: retain unspent KE
      } else { p.velocity = vec3f(0); }
    } else if (f.destination.z == 5u) {
      let old = dPhotonEnergy(p); let optics = dOptical(cid(before.core)); var left = old;
      let direction = p.velocity/max(length(p.velocity),0.000001); var normal = vec3f(0); normal[u32(f.effect.y)&3u] = -f.effect.w;
      if (((p.c0>>8u)&65535u)==0u) { left=vec3f(0); }
      else if (optics.w<0.0) {
        left *= max(0.0,-optics.w-1.0); p.velocity=reflect(p.velocity,normal); p.position-=direction*0.0002;
      } else if (f.effect.z!=1.0) {
        // Snell's law, with total internal reflection; TPT GLASS/WATR optics.
        let bent=refract(direction,normal,f.effect.z);
        if (dot(bent,bent)<0.000001) { p.velocity=reflect(p.velocity,normal); p.position-=direction*0.0002; }
        else {
          p.velocity=normalize(bent)*length(p.velocity); p.position+=normalize(p.velocity)*0.0002;
          p.c0=(p.c0&0x00ffffffu)|(cid(before.core)<<24u);
        }
      } else {
        left *= exp(-optics.xyz*f.effect.x); p.position+=direction*(f.effect.x+0.0001);
        // Remember the medium AND crossed exit face: the next sweep must
        // refract on exit, even though attenuation advanced across that face.
        p.c0=(p.c0&0x00ffffffu)|(cid(before.core)<<24u); p.tail.w=(u32(f.effect.y)>>2u)&3u;
      }
      if (max(left.x,max(left.y,left.z))<${f(RAYS.PHOTON_E_MIN)}) { left=vec3f(0); }
      let heat=dot(old-left,vec3f(${f(RAYS.PHOTON_HEAT/3)}));
      if (!energyFits(before,dHeatEnergy(before,heat))) { return; } // retain all RGB energy for retry
      after=dAddHeat(before,heat);
      p.tail=vec4u(bitcast<vec3u>(left),p.tail.w);
      if (all(left==vec3f(0))) { p.id=0u; atomicSub(&control[0],1u); noteDead(t); }
    } else if (f.destination.z == 2u) {
      let id = contactNuclearMaterial(before.core);
      let n = dNuclear(id); let alpha = pow((n.A-1.0)/(n.A+1.0),2.0);
      let r = dRandom(p.id,415u); let keep = select(alpha+(1.0-alpha)*r,r,dRandom(p.id,416u)<n.h);
      let e = max(${f(RAYS.NEUT_E_THERMAL)},bitcast<f32>(p.tail.y)*keep); p.tail.y = bitcast<u32>(e);
      let speed = D_CELL * 60.0 * clamp(${f(RAYS.NEUT_V)}*sqrt(e/${f(RAYS.NEUT_E_FAST)}),${f(RAYS.NEUT_V_THERMAL)},${f(RAYS.NEUT_V)});
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
        atomicAdd(&control[D_SHOCK+brickOfCell(cellOf(s))],${Math.round(RAYS.FISSION_P*256)}u);
        p.tail.z = u32(floor(f.effect.x-1.0)) + select(0u,1u,dRandom(p.id,761u)<fract(f.effect.x-1.0));
        atomicAdd(&control[18],p.tail.z);
        p.velocity = dDir(p.id)*${f(RAYS.NEUT_V*60*CELL_M)};
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
  throw new Error(`Unknown particles stage ${stage}`);
}
export const PARTICLE_STAGES = ['clear','integrate','elect','impact','deposit','holdSelect','holdCOM','holdApply','bodyCouple'];

export const WGSL_CHECK = PARTICLE_STAGES.map(stage => ({ name: `v2particles_${stage}`, kind: 'compute',
  code: g => particlesWGSL(g,nativeDynamicsHead,stage), layouts: () => [V2_DYNAMICS_LAYOUT,PARTICLES_LAYOUT,'EMPTY'], tool: true }));
