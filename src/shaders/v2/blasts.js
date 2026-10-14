import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../v2.js';
import { dynamicsCommon, DynamicParams, storageLayout, main64, main1, CONTROL } from './particles.js';
import { dynamicsRows, CELL_M, AIR, DT, GRAVITY, PARTICLE_CAP } from '../../v2/dynamics-reference.js';
import { E } from '../../elements.js';
import { RAYS } from '../../rays.js';
export { DynamicParams };
// Native cells/bank/activity3 + events, particles, air, control, plans5.
export const BLASTS_LAYOUT = storageLayout(5);
export const PLAN = Object.freeze({ SPAWN: 1, BREAK: 2, SOURCE: 4, NEUTRON: 8 });
export const CHILD_PREFIX = CONTROL.PREFIX;
export const SPAWN_PREFIX = CHILD_PREFIX + PARTICLE_CAP;
export const RAY_REQUEST_CAP = 64;
export const rayRequestBase = g => SPAWN_PREFIX + g.nbricks * 3;
export const controlWords = g => rayRequestBase(g) + RAY_REQUEST_CAP;
const f = n => Number.isInteger(n) ? `${n}.0` : String(n);
const blastTables = dynamicsRows.filter(r => r.energy > 0).map(r => `case ${r.id}u: { return DExplosive(${f(r.energy)},${r.product}u,${f(r.productT)},${r.productCtype}u); }`).join('\n');
function head(g, nativeHead) {
  return /* wgsl */ `${dynamicsCommon(g,nativeHead)}
struct DPlan { velocity: vec3f, flags: u32, energy: f32, broken: u32, pad: vec2u }
struct DExplosive { energy: f32, product: u32, temperature: f32, ctype: u32 }
@group(1) @binding(0) var<storage, read_write> events: array<u32>;
@group(1) @binding(1) var<storage, read_write> particles: array<DParticle>;
@group(1) @binding(2) var<storage, read_write> air: array<DAir>;
@group(1) @binding(3) var<storage, read_write> control: array<atomic<u32>>;
@group(1) @binding(4) var<storage, read_write> plans: array<DPlan>;
const D_CHILD_PREFIX: u32 = ${CHILD_PREFIX}u;
const D_SPAWN_PREFIX: u32 = ${SPAWN_PREFIX}u;
const D_SPAWN_COUNTS: u32 = D_SPAWN_PREFIX + D_BRICKS;
const D_ENERGY_SUMS: u32 = D_SPAWN_COUNTS + D_BRICKS;
fn dExplosive(id: u32) -> DExplosive { switch id { ${blastTables} default: { return DExplosive(0.0,0u,20.0,0u); } } }
fn dShielded(source: vec3i, destination: vec3i) -> bool {
  let delta = vec3f(destination-source);
  var cell = source; var next = vec3f(1e30); var stride = vec3f(1e30); let step = vec3i(sign(delta));
  for (var a = 0u; a < 3u; a++) { if (delta[a] != 0.0) { stride[a] = abs(1.0/delta[a]); next[a] = 0.5*stride[a]; } }
  loop {
    var a = 0u; if (next.y < next.x) { a = 1u; } if (next.z < next[a]) { a = 2u; }
    if (next[a] > 1.0) { return false; }
    cell[a] += step[a]; next[a] += stride[a];
    if (all(cell==destination)) { return false; }
    if (!inGrid(cell)) { return true; }
    if (cls(cid(loadMaterial(slotOf(cell)).core)) == 1u) { return true; }
  }
  return false;
}
fn dPressureAt(p: vec3i) -> f32 { if (!inGrid(p)) { return 0.0; } return air[brickOfCell(p)].vp.w; }
fn dRank(slot: u32) -> u32 {
  let b = slot / 64u; var rank = atomicLoad(&control[D_SPAWN_PREFIX+b]);
  for (var s = b*64u; s < slot; s++) { if ((plans[s].flags & 1u) != 0u) { rank++; } }
  return rank;
}
fn dSpawn(slot: u32, rank: u32, m: Material, v: vec3f, rule: u32) -> bool {
  if (rank >= atomicLoad(&control[4])) { return false; }
  let dest = atomicLoad(&control[D_FREE+rank]); let p = cellOf(slot);
  particles[dest] = dParticle(vec3f(p+P.origin)+0.5,v,dId(p,rule),m);
  atomicAdd(&control[0],1u); dWake(p); return true;
}
`;
}
export function blastsWGSL(g,nativeHead,stage) {
  const h = head(g,nativeHead);
  if (stage === 'reset') return h + main1(`atomicStore(&control[2],0u); atomicStore(&control[3],D_NONE); atomicStore(&control[7],0u);`);
  if (stage === 'select') return h + main64(`
    if (t >= D_SLOTS || events[t] == 0u) { return; }
    atomicAdd(&control[2],1u); dWake(cellOf(t));
    if ((events[t]&1u) != 0u && dExplosive(cid(loadMaterial(t).core)).energy > 0.0) { atomicMin(&control[3],t); }
  `);
  if (stage === 'plan') return h + main64(/* wgsl */ `
    if (t >= D_SLOTS) { return; }
    let p = cellOf(t); let m = loadMaterial(t); let id = cid(m.core); let k = cls(id);
    var plan = DPlan(vec3f(0),0u,0.0,0u,vec2u(0));
    let source = atomicLoad(&control[3]);
    if ((events[t]&4u)!=0u) { plan.flags = 9u; } // neutron request has its own immutable source
    if (source != D_NONE) {
      if (t == source) { plan.flags |= 4u; }
      else if (id != 0u && (events[t]&1u)==0u) {
        let sourcePos = cellOf(source); let explosion = dExplosive(cid(loadMaterial(source).core));
        let delta = vec3f(p-sourcePos); let r2 = max(0.25,dot(delta,delta));
        let received = explosion.energy * 0.5 / (12.566370614359*r2);
        if (received >= 0.01 && !dShielded(sourcePos,p)) {
          plan.energy = received;
          plan.velocity = normalize(delta);
        }
      }
    }
    plans[t] = plan;
  `);
  if (stage === 'toolPlan') return h + main64(/* wgsl */ `
    if (t >= D_SLOTS) { return; }
    var plan = DPlan(vec3f(0),0u,0.0,0u,vec2u(0));
    let p = cellOf(t); let m = loadMaterial(t); let k = cls(cid(m.core));
    let delta = vec3f(p + P.origin) + 0.5 - P.center; let r = length(delta);
    if (r <= P.radius && (k==2u || k==3u || k==4u) && (events[t]&1u)==0u) {
      let falloff = clamp(1.0-r/max(P.radius,0.001),0.0,1.0);
      plan.flags = 1u;
      // velocity/impulse is in m/s. Radial kick (mode1), directed throw (mode2).
      plan.velocity = P.vector + select(vec3f(0),normalize(delta+vec3f(0.000001))*P.strength,P.mode==1u);
      plan.velocity *= falloff;
    }
    plans[t] = plan;
  `);
  if (stage === 'couplePlan') return h + main64(/* wgsl */ `
    if (t >= D_SLOTS) { return; }
    var plan = DPlan(vec3f(0),0u,0.0,0u,vec2u(0)); let p = cellOf(t);
    let m = loadMaterial(t); let id = cid(m.core); let k = cls(id);
    if (id != 0u && (events[t]&1u)==0u) {
      let wind = air[brickOfCell(p)].vp.xyz;
      if (k==1u && dBreak(id)>=0) {
        var difference = 0.0;
        for (var a=0u;a<3u;a++) { difference = max(difference,abs(dPressureAt(p+dAxis(a)*4)-dPressureAt(p-dAxis(a)*4))); }
        if (difference > dStrength(id)) { plan.flags=2u; plan.broken=u32(dBreak(id)); }
      } else if (k==2u || k==3u) {
        var exposed = false; for (var a=0u;a<3u;a++) { exposed = exposed || dOpen(p+dAxis(a)) || dOpen(p-dAxis(a)); }
        if (exposed && length(wind)>dLift(id)) { plan.flags=1u; plan.velocity=wind; }
        // §4.2: flux over an unsupported lip faster than 1m/s becomes a droplet.
        if (k==3u && dOpen(p+vec3i(0,-1,0))) {
          let q=vec3f(unpack2x16float(m.core.z),unpack2x16float(m.core.w&65535u).x);
          let velocity=q * ${f(180*CELL_M/65536)};
          if (length(velocity.xz)>1.0) { plan.flags=1u; plan.velocity=velocity; }
        }
      }
    }
    plans[t]=plan;
  `);
  // Reduction is per brick in canonical slot order; source order is independent
  // of dispatch order. Never allocate with atomicAdd's unspecified arrival order.
  if (stage === 'sum') return h + main64(`
    if (t >= D_BRICKS) { return; } var energy=0.0;
    for (var s=t*64u;s<(t+1u)*64u;s++) { energy += plans[s].energy; }
    atomicStore(&control[D_ENERGY_SUMS+t],bitcast<u32>(energy));
  `);
  if (stage === 'normalize') return h + main1(`
    var sum=0.0; for (var b=0u;b<D_BRICKS;b++) { sum += bitcast<f32>(atomicLoad(&control[D_ENERGY_SUMS+b])); }
    let source=atomicLoad(&control[3]); var scale=1.0;
    if (source!=D_NONE) { scale=min(1.0,dExplosive(cid(loadMaterial(source).core)).energy*0.5/max(sum,0.000001)); }
    atomicStore(&control[6],bitcast<u32>(scale));
  `);
  if (stage === 'damagePlan') return h + main64(`
    if (t >= D_SLOTS) { return; } var plan=plans[t]; let m=loadMaterial(t); let id=cid(m.core); let k=cls(id);
    let energy=plan.energy*bitcast<f32>(atomicLoad(&control[6])); plan.energy=energy;
    var kinetic=energy;
    if (energy>0.0 && k==1u) {
      if (dBreak(id)>=0 && energy>=dToughness(id)) { plan.flags|=2u; plan.broken=u32(dBreak(id)); kinetic-=dToughness(id); }
      else { kinetic=0.0; }
    }
    if (kinetic>0.0 && (k==2u || k==3u || (plan.flags&2u)!=0u) && (plan.flags&8u)==0u) {
      plan.flags|=1u; plan.velocity *= sqrt(2.0*kinetic/max(dMass(id)*dAmount(m),0.000001));
    }
    plans[t]=plan;
  `);
  if (stage === 'count') return h + main64(`
    if (t >= D_BRICKS) { return; } var n=0u;
    for (var s=t*64u;s<(t+1u)*64u;s++) { if ((plans[s].flags&1u)!=0u) { n++; } }
    atomicStore(&control[D_SPAWN_COUNTS+t],n);
  `);
  if (stage === 'allocate') return h + main1(`
    var free=0u; var children=0u;
    for (var i=0u;i<D_CAP;i++) {
      if (particles[i].id==0u) { atomicStore(&control[D_FREE+free],i); free++; }
      atomicStore(&control[D_CHILD_PREFIX+i],D_NONE);
      if (particles[i].id!=0u && (particles[i].c0&255u)==D_NEUTRON && particles[i].tail.z>0u) {
        atomicStore(&control[D_CHILD_PREFIX+i],children); children+=particles[i].tail.z;
      }
    }
    atomicStore(&control[4],free); var total=0u;
    for (var b=0u;b<D_BRICKS;b++) { atomicStore(&control[D_SPAWN_PREFIX+b],total); total+=atomicLoad(&control[D_SPAWN_COUNTS+b]); }
    atomicStore(&control[5],total);
  `);
  if (stage === 'apply') return h + main64(/* wgsl */ `
    if (t >= D_SLOTS) { return; } let plan=plans[t]; if (plan.flags==0u) { return; }
    let before=loadMaterial(t); var after=before;
    if ((plan.flags&2u)!=0u) { after.core.x=(after.core.x&0xffffff00u)|plan.broken; }
    if ((plan.flags&1u)!=0u) {
      let rank=dRank(t);
      if ((plan.flags&8u)!=0u) {
        let neutron=Material(vec4u(D_NEUTRON,${RAYS.NEUT_LIFE}u,bitcast<u32>(${f(RAYS.NEUT_E_FAST)}),0u),0i);
        if (dSpawn(t,rank,neutron,dDir(dId(cellOf(t),4u))*${f(RAYS.NEUT_V*60*CELL_M)},4u)) { events[t]&=~4u; }
        else { atomicAdd(&control[7],1u); }
      } else if (dSpawn(t,rank,after,plan.velocity,P.sequence ^ 0x53504157u)) { after=dEmpty(); }
      else { atomicAdd(&control[7],1u); } // authoritative grid fallback, never erase a failed launch
    }
    storeMaterial(t,before,after); dWake(cellOf(t));
  `);
  if (stage === 'children') return h + main64(/* wgsl */ `
    if (t >= D_CAP) { return; } let offset=atomicLoad(&control[D_CHILD_PREFIX+t]); if (offset==D_NONE) { return; }
    var parent=particles[t]; var n=parent.tail.z;
    for (var child=0u;child<parent.tail.z;child++) {
      let rank=atomicLoad(&control[5])+offset+child;
      if (rank>=atomicLoad(&control[4])) { break; }
      let dest=atomicLoad(&control[D_FREE+rank]); let id=max(1u,dHash(parent.id ^ P.tick*2654435761u ^ (child+1u)*0x9e3779b9u));
      var born=parent; born.id=id; born.tail.z=0u; born.tail.x=${RAYS.NEUT_LIFE}u; born.velocity=dDir(id)*${f(RAYS.NEUT_V*60*CELL_M)};
      particles[dest]=born; atomicAdd(&control[0],1u); n--;
    }
    particles[t].tail.z=n;
  `);
  if (stage === 'rayEmit') return h + main1(/* wgsl */ `
    let index=${rayRequestBase(g)}u+P.substep; var remaining=atomicLoad(&control[index]);
    if (remaining==0u) { return; }
    for (var slot=0u;slot<D_CAP;slot++) {
      if (particles[slot].id!=0u) { continue; }
      let emitted=u32(P.strength)-remaining;
      let seed=max(1u,dHash(P.sequence ^ emitted*2654435761u ^ P.tick));
      let position=P.center+dDir(seed)*P.radius*pow(dRandom(seed,11u),1.0/3.0);
      var m=Material(vec4u(D_NEUTRON,${RAYS.NEUT_LIFE}u,bitcast<u32>(${f(RAYS.NEUT_E_FAST)}),0u),0i);
      if (P.mode==7u) { m=Material(vec4u(D_PHOTON|(${RAYS.PHOTON_LIFE}u<<8u),bitcast<u32>(1.0),bitcast<u32>(1.0),bitcast<u32>(1.0)),0i); }
      var velocity=P.vector; if (length(velocity)<0.000001) { velocity=dDir(seed)*${f(RAYS.NEUT_V*60*CELL_M)}; }
      particles[slot]=dParticle(position,velocity,seed,m); remaining--; atomicAdd(&control[0],1u);
      let local=vec3i(floor(position))-P.origin; if (inGrid(local)) { dWake(local); }
      if (remaining==0u) { break; }
    }
    atomicStore(&control[index],remaining);
  `);
  if (stage === 'finish') return h + main1(/* wgsl */ `
    let s=atomicLoad(&control[3]); if (s==D_NONE) { return; }
    let before=loadMaterial(s); let explosive=dExplosive(cid(before.core));
    if (explosive.energy<=0.0 || (events[s]&1u)==0u) { return; }
    var after=makeMaterial(explosive.product,explosive.temperature,65536u,explosive.ctype);
    after.bank=before.bank; // never discard a carried quantisation/latent remainder
    storeMaterial(s,before,after);
    let b=brickOfCell(cellOf(s)); var a=air[b];
    // 1/4 blast energy enters acoustic compression, 1/2 bounded damage/KE,
    // 1/4 hot products. Pressure energy p² V / (2 rho c²), not an arbitrary kick.
    let dp=sqrt(2.0*${f(AIR.rho*AIR.sound**2)}*explosive.energy*0.25/${f(AIR.edge**3)});
    a.vp.w += dp; a.thermal.z=0.0; air[b]=a;
    events[s]&=~1u; dWake(cellOf(s));
  `);
  throw new Error(`Unknown blast stage ${stage}`);
}
export const BLAST_STAGES = ['reset','select','plan','sum','normalize','damagePlan','count','allocate','apply','children','finish','toolPlan','couplePlan','rayEmit'];

export const WGSL_CHECK = BLAST_STAGES.map(stage => ({ name: `v2blasts_${stage}`, kind: 'compute',
  code: g => blastsWGSL(g,nativeDynamicsHead,stage), layouts: () => [V2_DYNAMICS_LAYOUT,BLASTS_LAYOUT,'EMPTY'], tool: true }));
