import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../v2.js';
import { dynamicsCommon, DynamicParams, storageLayout, main64, main1, CONTROL, heldBase } from './particles.js';
import { dynamicsRows, CELL_M, AIR, DT, GRAVITY, PARTICLE_CAP, LEGACY_PRESSURE_PA } from '../../v2/dynamics-reference.js';
import { E } from '../../elements.js';
import { RAYS } from '../../rays.js';
import { PHYS } from '../../physics.js';
import { fold } from '../../gpu/kernels.js';
export { DynamicParams };
// Native cells/bank/activity3 + events, particles, air, control, plans5.
export const BLASTS_LAYOUT = storageLayout(5);
export const PLAN = Object.freeze({ SPAWN: 1, BREAK: 2, SOURCE: 4, NEUTRON: 8 });
export const CHILD_PREFIX = CONTROL.PREFIX;
export const SPAWN_PREFIX = CHILD_PREFIX + PARTICLE_CAP;
export const RAY_REQUEST_CAP = 64;
export const rayRequestBase = g => SPAWN_PREFIX + g.nbricks * 3;
export const controlWords = g => heldBase(g) + PARTICLE_CAP;
const f = n => Number.isInteger(n) ? `${n}.0` : String(n);
const blastTables = dynamicsRows.filter(r => r.energy > 0 || r.id===E.SINGULARITY).map(r => `case ${r.id}u: { return DExplosive(${f(r.energy)},${r.product}u,${f(r.productT)},${r.productCtype}u); }`).join('\n');
function head(g, nativeHead) {
  return /* wgsl */ `${dynamicsCommon(g,nativeHead)}
// 16B/cell: plan vector initially stores direction * received J, then velocity.
// bits0..3 actions, bits8..15 fracture product. Fits the128MiB binding at6.3M cells.
struct DPlan { velocity: vec3f, flags: u32 }
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
fn dEvaporates(m: Material) -> bool { return cid(m.core)==${E.SINGULARITY}u && payloadOf(m.core)==0u; }
fn dChargeEnergy(m: Material) -> f32 {
  if (cid(m.core)==${E.SINGULARITY}u) {
    if (dEvaporates(m)) { return 0.0; }
    let mass=f32(payloadOf(m.core))/256.0;
    let pressure=min(${f(PHYS.P_MAX)},mass*${f(PHYS.SING_BURST_P_PER_MASS)})*${f(LEGACY_PRESSURE_PA)};
    return pressure*pressure*${f(AIR.edge**3)}/(2.0*${f(AIR.rho*AIR.sound**2)}*0.25);
  }
  return dExplosive(cid(m.core)).energy*dAmount(m);
}
fn dProduct(m: Material) -> Material {
  if (dEvaporates(m)) { return dCarrier(m); }
  let e=dExplosive(cid(m.core));
  let temperature=select(e.temperature,max(e.temperature,f32(cTq(m.core))*0.25-273.25),cid(m.core)==${E.DUST}u);
  return makeMaterial(e.product,temperature,65536u,e.ctype);
}
fn dProductEnergy(m: Material) -> vec2u {
  // cap=1 is a 27-litre water cell: 27kg *4184J/(kg K). The reserved
  // quarter of scaled chemical energy heats products; all old energy remains.
  if (dEvaporates(m)) { return energyOf(dCarrier(m)); }
  let nativePerJ=16777216.0/${f(1000*CELL_M**3*4184)};
  return energyAdd(energyOf(m),vec2u(u32(round(dChargeEnergy(m)*0.25*nativePerJ)),0u));
}
fn dShielded(source: vec3i, destination: vec3i) -> bool {
  let delta = vec3f(destination-source);
  var cell = source; var next = vec3f(1e30); var stride = vec3f(1e30); let step = vec3i(sign(delta)); var crossed=0u;
  for (var a = 0u; a < 3u; a++) { if (delta[a] != 0.0) { stride[a] = abs(1.0/delta[a]); next[a] = 0.5*stride[a]; } }
  loop {
    if (crossed>D_SWEEP_MAX) { return true; } crossed++; // non-progress is shielded, never transparent
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
  atomicStore(&control[D_HELD+dest],select(0u,P.sequence,P.mode==9u));
  atomicAdd(&control[0],1u); dWake(p); return true;
}
`;
}
export function blastsWGSL(g,nativeHead,stage) {
  const h = head(g,nativeHead);
  if (stage === 'reset') return h + main1(`atomicStore(&control[2],0u); atomicStore(&control[3],D_NONE); atomicStore(&control[17],0u);`);
  if (stage === 'select') return h + main64(`
    if (t >= D_SLOTS || events[t] == 0u) { return; }
    atomicAdd(&control[2],1u); dWake(cellOf(t)); if ((events[t]&4u)!=0u) { atomicAdd(&control[17],1u); }
    let m=loadMaterial(t);
    if ((events[t]&1u) != 0u && (dChargeEnergy(m)>0.0 || dEvaporates(m)) && energyFits(dProduct(m),dProductEnergy(m))) { atomicMin(&control[3],t); }
  `);
  if (stage === 'workArgs') return h + main1(`
    let hasWork=atomicLoad(&control[3])!=D_NONE || atomicLoad(&control[17])>0u || atomicLoad(&control[18])>0u;
    atomicStore(&control[20],select(0u,${fold(Math.ceil(g.slots/64))[0]}u,hasWork));
    atomicStore(&control[21],${fold(Math.ceil(g.slots/64))[1]}u); atomicStore(&control[22],1u);
    atomicStore(&control[24],select(0u,${fold(Math.ceil(g.nbricks/64))[0]}u,hasWork));
    atomicStore(&control[25],${fold(Math.ceil(g.nbricks/64))[1]}u); atomicStore(&control[26],1u);
    atomicStore(&control[28],select(0u,1u,hasWork)); atomicStore(&control[29],1u); atomicStore(&control[30],1u);
  `);
  if (stage === 'plan') return h + main64(/* wgsl */ `
    if (t >= D_SLOTS) { return; }
    let p = cellOf(t); let m = loadMaterial(t); let id = cid(m.core); let k = cls(id);
    var plan = DPlan(vec3f(0),0u);
    let source = atomicLoad(&control[3]);
    if ((events[t]&4u)!=0u) { plan.flags = 9u; } // neutron request has its own immutable source
    if (source != D_NONE) {
      if (t == source) { plan.flags |= 4u; }
      else if (id != 0u && (events[t]&1u)==0u) {
        let sourcePos = cellOf(source); let explosionEnergy = dChargeEnergy(loadMaterial(source));
        let delta = vec3f(p-sourcePos); let r2 = max(0.25,dot(delta,delta));
        let received = explosionEnergy * 0.5 / (12.566370614359*r2);
        if (received >= 0.01 && !dShielded(sourcePos,p)) {
          plan.velocity = normalize(delta)*received;
        }
      }
    }
    plans[t] = plan;
  `);
  if (stage === 'toolPlan') return h + main64(/* wgsl */ `
    if (t >= D_SLOTS) { return; }
    var plan = DPlan(vec3f(0),0u);
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
    var plan = DPlan(vec3f(0),0u); let p = cellOf(t);
    let m = loadMaterial(t); let id = cid(m.core); let k = cls(id);
    if (id != 0u && (events[t]&1u)==0u) {
      let wind = air[brickOfCell(p)].vp.xyz;
      if (k==1u && dBreak(id)>=0) {
        var difference = 0.0;
        for (var a=0u;a<3u;a++) { difference = max(difference,abs(dPressureAt(p+dAxis(a)*4)-dPressureAt(p-dAxis(a)*4))); }
        if (difference > dStrength(id)) { plan.flags=2u|(u32(dBreak(id))<<8u); }
      } else if (k==2u || k==3u) {
        var exposed = false; for (var a=0u;a<3u;a++) { exposed = exposed || dOpen(p+dAxis(a)) || dOpen(p-dAxis(a)); }
        if (exposed && length(wind)>dLift(id)) { plan.flags=1u; plan.velocity=wind; }
        // §4.2: flux over an unsupported lip faster than 1m/s becomes a droplet.
        if (P.nativeJets==0u && k==3u && dOpen(p+vec3i(0,-1,0))) {
          let q=vec3f(unpack2x16float(m.core.z),unpack2x16float(m.core.w&65535u).x);
          let velocity=q * ${f(180*CELL_M/65536)};
          if (length(velocity.xz)>1.0) {
            let amount=min(cFill(m.core),u32(ceil((abs(q.x)+abs(q.z))*3.0)));
            if (amount>0u) { plan.flags=17u|(amount<<8u); plan.velocity=velocity; }
          }
        }
      }
    }
    plans[t]=plan;
  `);
  // Reduction is per brick in canonical slot order; source order is independent
  // of dispatch order. Never allocate with atomicAdd's unspecified arrival order.
  if (stage === 'sum') return h + main64(`
    if (t >= D_BRICKS) { return; } var energy=0.0;
    for (var s=t*64u;s<(t+1u)*64u;s++) { energy += length(plans[s].velocity); }
    atomicStore(&control[D_ENERGY_SUMS+t],bitcast<u32>(energy));
  `);
  if (stage === 'normalize') return h + main1(`
    var sum=0.0; for (var b=0u;b<D_BRICKS;b++) { sum += bitcast<f32>(atomicLoad(&control[D_ENERGY_SUMS+b])); }
    let source=atomicLoad(&control[3]); var scale=1.0;
    if (source!=D_NONE) { scale=min(1.0,dChargeEnergy(loadMaterial(source))*0.5/max(sum,0.000001)); }
    atomicStore(&control[6],bitcast<u32>(scale));
  `);
  if (stage === 'damagePlan') return h + main64(`
    if (t >= D_SLOTS) { return; } var plan=plans[t]; let m=loadMaterial(t); let id=cid(m.core); let k=cls(id);
    let energy=length(plan.velocity)*bitcast<f32>(atomicLoad(&control[6]));
    var kinetic=energy;
    if (energy>0.0 && k==1u) {
      var broken=m; broken.core.x=(broken.core.x&0xffffff00u)|u32(max(0,dBreak(id)));
      if (dBreak(id)>=0 && energy>=dToughness(id) && energyFits(broken,energyOf(m))) { plan.flags|=2u|(u32(dBreak(id))<<8u); kinetic-=dToughness(id); }
      else { kinetic=0.0; }
    }
    if (kinetic>0.0 && (k==2u || k==3u || (plan.flags&2u)!=0u) && (plan.flags&8u)==0u) {
      plan.flags|=1u; plan.velocity = normalize(plan.velocity)*sqrt(2.0*kinetic/max(dMass(id)*dAmount(m),0.000001));
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
    if ((plan.flags&2u)!=0u) {
      after.core.x=(after.core.x&0xffffff00u)|((plan.flags>>8u)&255u);
      if (!energyFits(after,energyOf(before))) { dWake(cellOf(t)); return; }
      after=withEnergy(after,energyOf(before));
    }
    if ((plan.flags&1u)!=0u) {
      let rank=dRank(t);
      if ((plan.flags&8u)!=0u) {
        let neutron=Material(vec4u(D_NEUTRON,${RAYS.NEUT_LIFE}u,bitcast<u32>(${f(RAYS.NEUT_E_FAST)}),0u),0i);
        if (dSpawn(t,rank,neutron,dDir(dId(cellOf(t),4u))*${f(RAYS.NEUT_V*60*CELL_M)},4u)) { events[t]&=~4u; }
        else { atomicAdd(&control[7],1u); }
      } else {
        var packet=after; var remainder=dCarrier(after);
        if ((plan.flags&16u)!=0u) {
          let total=cFill(after.core); let amount=min(total,plan.flags>>8u);
          if (amount>0u && amount<total) {
            packet.core.y=(packet.core.y&0xff000000u)|amount;
            var rest=after; rest.core.y=(rest.core.y&0xff000000u)|(total-amount);
            if (!dConductive(cid(after.core))) {
              let fuel=energyDiv(energyMul(payloadOf(after.core),amount),total).x;
              packet.core=withPayload(packet.core,fuel); rest.core=withPayload(rest.core,payloadOf(after.core)-fuel);
            }
            let share=energyShare(dParticleEnergy(after),0u,amount,total);
            let packetEnergy=energyAdd(share,energyMul(65536u,cTq(after.core)));
            if (!energyFits(packet,packetEnergy)) { dWake(cellOf(t)); return; }
            packet=withEnergy(packet,packetEnergy);
            let remainingEnergy=energySub(energyOf(after),dParticleEnergy(packet));
            if (!energyFits(rest,remainingEnergy)) { dWake(cellOf(t)); return; }
            remainder=withEnergy(rest,remainingEnergy);
          }
        }
        if (dSpawn(t,rank,packet,plan.velocity,P.sequence ^ 0x53504157u)) { after=remainder; }
        else { atomicAdd(&control[7],1u); } // authoritative grid fallback, never erase a failed launch
      }
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
      particles[dest]=born; atomicStore(&control[D_HELD+dest],0u); atomicAdd(&control[0],1u); n--;
    }
    particles[t].tail.z=n; atomicSub(&control[18],parent.tail.z-n);
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
      if (P.mode==7u) {
        let local=vec3i(floor(position))-P.origin; var medium=0u;
        if (inGrid(local)) { medium=cid(loadMaterial(slotOf(local)).core); }
        m=Material(vec4u(D_PHOTON|(${RAYS.PHOTON_LIFE}u<<8u)|(medium<<24u),bitcast<u32>(1.0),bitcast<u32>(1.0),bitcast<u32>(1.0)),0i);
      }
      var velocity=P.vector; if (length(velocity)<0.000001) { velocity=dDir(seed)*${f(RAYS.NEUT_V*60*CELL_M)}; }
      particles[slot]=dParticle(position,velocity,seed,m); atomicStore(&control[D_HELD+slot],0u); remaining--; atomicAdd(&control[0],1u);
      let local=vec3i(floor(position))-P.origin; if (inGrid(local)) { dWake(local); }
      if (remaining==0u) { break; }
    }
    atomicStore(&control[index],remaining);
  `);
  if (stage === 'finish') return h + main1(/* wgsl */ `
    let s=atomicLoad(&control[3]); if (s==D_NONE) { return; }
    let before=loadMaterial(s); let explosive=dExplosive(cid(before.core));
    if ((dChargeEnergy(before)<=0.0 && !dEvaporates(before)) || (events[s]&1u)==0u) { return; }
    let product=dProduct(before); let productEnergy=dProductEnergy(before);
    // select() gated this BEFORE any damage: retry cannot duplicate a blast.
    if (!energyFits(product,productEnergy)) { return; }
    let after=withEnergy(product,productEnergy);
    if (dEvaporates(before)) {
      let removed=energySub(energyOf(before),productEnergy);
      if ((removed.y&0x80000000u)==0u) { noteEnergySink(cellOf(s),removed); }
      else { noteEnergySource(cellOf(s),energyNeg(removed)); }
      storeMaterial(s,before,after); events[s]&=~1u; dWake(cellOf(s)); return;
    }
    noteEnergySource(cellOf(s),energySub(productEnergy,energyOf(before)));
    storeMaterial(s,before,after);
    let b=brickOfCell(cellOf(s)); var a=air[b];
    // 1/4 blast energy enters acoustic compression, 1/2 bounded damage/KE,
    // 1/4 hot products. Pressure energy p² V / (2 rho c²), not an arbitrary kick.
    let addedP2=2.0*${f(AIR.rho*AIR.sound**2)}*dChargeEnergy(before)*0.25/${f(AIR.edge**3)};
    a.vp.w=sqrt(a.vp.w*a.vp.w+addedP2); a.thermal.z=0.0; air[b]=a;
    events[s]&=~1u; dWake(cellOf(s));
  `);
  throw new Error(`Unknown blast stage ${stage}`);
}
export const BLAST_STAGES = ['reset','select','plan','sum','normalize','damagePlan','count','allocate','apply','children','finish','toolPlan','couplePlan','rayEmit','workArgs'];

export const WGSL_CHECK = BLAST_STAGES.map(stage => ({ name: `v2blasts_${stage}`, kind: 'compute',
  code: g => blastsWGSL(g,nativeDynamicsHead,stage), layouts: () => [V2_DYNAMICS_LAYOUT,BLASTS_LAYOUT,'EMPTY'], tool: true }));
