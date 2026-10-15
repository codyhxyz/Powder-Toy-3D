import { liquidTransportWGSL, nativeDynamicsHead, V2_DYNAMICS_LAYOUT, SUB, TICK_HZ } from '../v2.js';
import { dynamicsCommon, DynamicParams, storageLayout, main64, main1 } from './particles.js';
import { SPAWN_PREFIX } from './blasts.js';
export { DynamicParams };
export const JETS_LAYOUT = storageLayout(4);
export const JET_STAGES = ['candidate','count','allocate','spawn'];
function head(g) {
  return `${dynamicsCommon(g,nativeDynamicsHead)}
@group(1) @binding(0) var<storage, read_write> liquidScratch: array<vec4u>;
@group(1) @binding(1) var<storage, read_write> jetMask: array<atomic<u32>>;
@group(1) @binding(2) var<storage, read_write> particles: array<DParticle>;
@group(1) @binding(3) var<storage, read_write> control: array<atomic<u32>>;
const J_PREFIX: u32 = ${SPAWN_PREFIX}u;
const J_COUNTS: u32 = J_PREFIX + D_BRICKS;
fn liquidFlux(s: u32) -> vec3f { return qOf(loadCore(s)); }
${liquidTransportWGSL}
fn jetSpeed(p: vec3i, face: u32) -> f32 {
  return max(0.0, faceQ(p,face)) * D_CELL * ${SUB*TICK_HZ}.0 / FULLF;
}
fn jetMaterial(p: vec3i, face: u32) -> Material {
  let src = snapshot(slotOf(p)); let packet = sendOf(p,face);
  var m = Material(vec4u(src.core.x, (src.core.y & 0xff000000u) | packet.amount, 0u,
    select(packet.fuel, payloadOf(src.core), conductsNative(cid(src.core))) << 16u), 0);
  // Keep the source temperature/phase code: the flight ABI defines enthalpy as
  // energyOf minus this exact stationary carrier, not withEnergy's new carrier.
  m.bank = bitcast<i32>(energySub(packet.heat, dParticleEnergy(m)).x);
  return m;
}
fn jetCandidate(p: vec3i, face: u32) -> bool {
  if (face/2u == 1u || !awakeCell(p)) { return false; }
  let q = mEdge(p+face6(i32(face))); let below = mEdge(q+vec3i(0,-1,0));
  if (!inGrid(q) || !inGrid(below) || !awakeCell(q)) { return false; }
  // Sideways transfer into air above air, never a falling grid column.
  if (cid(snapshot(slotOf(q)).core)!=0u || cid(loadCore(slotOf(below)))!=0u || jetSpeed(p,face)<=1.0) { return false; }
  let packet=sendOf(p,face); if (packet.amount==0u) { return false; }
  // Refuse unrepresentable particle banks without changing ordinary transport.
  return all(dParticleEnergy(jetMaterial(p,face)) == packet.heat);
}
`;
}
export function jetsWGSL(g,stage) {
  const h=head(g);
  if(stage==='candidate') return h+main64(`
    if(t>=D_SLOTS || !inGrid(cellOf(t)) || !awakeCell(cellOf(t))) { return; }
    var mask=atomicLoad(&jetMask[t])&0xff000000u;
    for(var f=0u;f<6u;f++) { if(jetCandidate(cellOf(t),f)) { mask|=1u<<(f+8u); } }
    atomicStore(&jetMask[t],mask);
  `);
  if(stage==='count') return h+`
var<workgroup> brickDemand: array<u32,64>;
`+main64(`
    var count=0u;
    if(t<D_BRICKS) {
      for(var s=t*64u;s<(t+1u)*64u;s++) {
        if(inGrid(cellOf(s)) && awakeCell(cellOf(s))) { count+=countOneBits((atomicLoad(&jetMask[s])>>8u)&63u); }
      }
    }
    // Padding lanes contribute zero without skipping the barrier.
    brickDemand[li]=count; workgroupBarrier();
    var prefix=0u; for(var lane=0u;lane<li;lane++) { prefix+=brickDemand[lane]; }
    if(t<D_BRICKS) { atomicStore(&control[J_PREFIX+t],prefix); }
    if(li==63u) { atomicStore(&control[J_COUNTS+t/64u],prefix+count); }
  `);
  if(stage==='allocate') return h+main1(`
    let free=atomicLoad(&control[4]); var requested=0u;
    for(var group=0u;group<(D_BRICKS+63u)/64u;group++) {
      let count=atomicLoad(&control[J_COUNTS+group]);
      atomicStore(&control[J_COUNTS+group],requested); requested+=count;
    }
    atomicStore(&control[5],requested);
    if(requested>free) { atomicAdd(&control[7],requested-free); }
  `);
  if(stage==='spawn') return h+main64(`
    if(t>=D_SLOTS || !inGrid(cellOf(t)) || !awakeCell(cellOf(t))) { return; }
    let p=cellOf(t); let candidates=(atomicLoad(&jetMask[t])>>8u)&63u;
    var rank=atomicLoad(&control[J_PREFIX+t/64u])+atomicLoad(&control[J_COUNTS+t/4096u]);
    for(var s=t/64u*64u;s<t;s++) { rank+=countOneBits((atomicLoad(&jetMask[s])>>8u)&63u); }
    var accepted=0u;
    for(var f=0u;f<6u;f++) {
      if((candidates&(1u<<f))==0u) { continue; }
      if(rank<atomicLoad(&control[4])) {
        let dest=atomicLoad(&control[D_FREE+rank]); let direction=vec3f(face6(i32(f)));
        particles[dest]=dParticle(vec3f(p+P.origin)+0.5+direction*0.501,
          direction*jetSpeed(p,f),dId(p,0x4a000u+P.substep*8u+f),jetMaterial(p,f));
        atomicStore(&control[D_HELD+dest],0u); atomicAdd(&control[0],1u);
        accepted|=1u<<f; dWake(p);
      }
      rank++;
    }
    // Preserve candidate bits for neighbour rank reads; only owned low bits change.
    atomicStore(&jetMask[t],(atomicLoad(&jetMask[t])&~63u)|accepted);
  `);
  throw new Error(`Unknown jet stage ${stage}`);
}
export const WGSL_CHECK=JET_STAGES.map(stage=>({name:`v2jets_${stage}`,kind:'compute',code:g=>jetsWGSL(g,stage),layouts:()=>[V2_DYNAMICS_LAYOUT,JETS_LAYOUT,'EMPTY'],tool:true}));
