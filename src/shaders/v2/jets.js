import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../v2.js';
import { dynamicsCommon, DynamicParams, storageLayout, main64, main1 } from './particles.js';
import { SPAWN_PREFIX, coupleArgsBase, listWGSL, listControl } from './blasts.js';
import { COLUMN } from './columns.js';
export { DynamicParams };

// R14 jets on column runs. The pair stages pour a fast overfall into the receiver's cells at the face
// rows and mark each cell that was air (columns.js colPour, colMarkJet): its face lane holds its launch
// velocity (m/s: R14's sqrt(2 g H) from the exact launch head), its y lane JET_MARK (less a crown droplet's
// rise, columns.js colCrown), and its brick's jets word is set. These stages make every marked cell
// a particle carrying the whole cell (its fill, payload and carried energy; the stationary air carrier
// stays), in a deterministic order: count per brick, the shared allocator, spawn at prefix ranks. A cell
// the pool or the format refuses keeps its liquid and loses its mark: it falls as a run.
export const JETS_LAYOUT = storageLayout(2);
export const JET_STAGES = ['count', 'gate', 'allocate', 'spawn'];
// the hash rule of a jet particle's id (the retired per-face jets' base)
const JET_RULE = 0x4a000;
const f = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));

function head(g) {
  return `${dynamicsCommon(g, nativeDynamicsHead)}
@group(1) @binding(0) var<storage, read_write> particles: array<DParticle>;
@group(1) @binding(1) var<storage, read_write> control: array<atomic<u32>>;
${listWGSL(g)}
// the ticks' demand, every group's sum added by count (u32, so the order is free); the gate restarts it
const J_TOTAL: u32 = ${listControl(g).jetTotal}u;
const J_PREFIX: u32 = ${SPAWN_PREFIX}u;
const J_COUNTS: u32 = J_PREFIX + D_BRICKS;
const JET_MARK: f32 = ${f(COLUMN.JET_MARK)};
fn jetMarked(c: vec4u) -> bool { return isLiq(c) && cFill(c) != 0u && qOf(c).y <= JET_MARK; }
fn jetBrick(b: u32) -> bool { return b < D_BRICKS && atomicLoad(&act2[V2_JETS + b]) != 0u; }
// the whole cell as a flight packet: everything but the stationary air carrier (FULL at its temperature)
fn jetCarried(m: Material) -> vec2u { return energySub(energyOf(m), energyMul(FULLU, cTq(m.core))); }
fn jetMaterial(m: Material) -> Material {
  var out = Material(vec4u(m.core.x, m.core.y, 0u, payloadOf(m.core) << 16u), 0);
  out.bank = bitcast<i32>(energySub(jetCarried(m), dParticleEnergy(out)).x);
  return out;
}
`;
}

export function jetsWGSL(g, stage) {
  const h = head(g);
  if (stage === 'count') return h + `
var<workgroup> brickDemand: array<u32,64>;
` + main64(`
    var count=0u;
    // a flagged brick goes to spawn's list (spawn returns at once for any other)
    if(jetBrick(t)) { dAppend(LIST_JETS,t); for(var s=t*64u;s<(t+1u)*64u;s++) { if(jetMarked(loadCore(s))) { count++; } } }
    // Padding lanes contribute zero without skipping the barrier.
    brickDemand[li]=count; workgroupBarrier();
    var prefix=0u; for(var lane=0u;lane<li;lane++) { prefix+=brickDemand[lane]; }
    if(t<D_BRICKS) { atomicStore(&control[J_PREFIX+t],prefix); }
    if(li==63u) { atomicStore(&control[J_COUNTS+t/64u],prefix+count); if(prefix+count!=0u) { atomicAdd(&control[J_TOTAL],prefix+count); } }
  `);
  // The couple gate's protocol (blasts.js coupleGate): [work, 1, 1, 0, work] for the pool preparation and
  // the allocation's indirect args, so a tick that launches nothing never sweeps the particle pool.
  if (stage === 'gate') return h + main1(`
    // count's groups' sums, added as it wrote them: one word, not a loop over the groups
    let demand=atomicExchange(&control[J_TOTAL],0u);
    let work=select(0u,1u,demand>0u); let base=${coupleArgsBase(g)}u;
    atomicStore(&control[base],work); atomicStore(&control[base+1u],1u); atomicStore(&control[base+2u],1u);
    atomicStore(&control[base+3u],0u); atomicStore(&control[base+4u],work);
  `);
  if (stage === 'allocate') return h + main1(`
    let free=atomicLoad(&control[4]); var requested=0u;
    for(var group=0u;group<(D_BRICKS+63u)/64u;group++) {
      let count=atomicLoad(&control[J_COUNTS+group]);
      atomicStore(&control[J_COUNTS+group],requested); requested+=count;
    }
    atomicStore(&control[5],requested);
    if(requested>free) { atomicAdd(&control[7],requested-free); }
  `);
  if (stage === 'spawn') return h + `
var<workgroup> wgListed: u32;
var<workgroup> wgMarked: array<u32,64>;
` + main64(`
    // a workgroup a brick: the marks are read before any lane changes its cell
    let b=t/64u;
    if(li==0u) { wgListed=select(0u,1u,jetBrick(b)); }
    if(workgroupUniformLoad(&wgListed)==0u) { return; }
    let p=cellOf(t); let before=loadMaterial(t); let c=before.core;
    let marked=jetMarked(c);
    wgMarked[li]=select(0u,1u,marked); workgroupBarrier();
    var rank=atomicLoad(&control[J_PREFIX+b])+atomicLoad(&control[J_COUNTS+b/64u]);
    for(var lane=0u;lane<li;lane++) { rank+=wgMarked[lane]; }
    if(li==0u) { atomicStore(&act2[V2_JETS+b],0u); }
    if(!marked) { return; }
    let m=jetMaterial(before); let carried=jetCarried(before);
    let empty=Material(vec4u(c.x&0x00ffff00u,0u,0u,0u),before.bank);
    let rest=energySub(energyOf(before),carried);
    // the mark's y lane is JET_MARK less the upward speed (a crown droplet's; a jet's is level)
    let q=qOf(c); let velocity=vec3f(q.x,JET_MARK-q.y,q.z);
    if(rank<atomicLoad(&control[4]) && length(velocity)>0.0 && all(dParticleEnergy(m)==carried) && energyFits(empty,rest)) {
      let dest=atomicLoad(&control[D_FREE+rank]);
      particles[dest]=dParticle(vec3f(p+P.origin)+0.5-normalize(velocity)*0.499,velocity,dId(p,${JET_RULE}u),m); noteLive(dest);
      atomicStore(&control[D_HELD+dest],0u); atomicAdd(&control[0],1u);
      storeMaterial(t,before,withEnergy(empty,rest));
    } else {
      // refused: the liquid stays and falls as a run, from rest
      storeMaterial(t,before,Material(zeroQ(c),before.bank));
    }
    dWake(p);
  `,'dListedCell(LIST_JETS,wg,nwg,li)');
  throw new Error(`Unknown jet stage ${stage}`);
}
export const WGSL_CHECK = JET_STAGES.map(stage => ({ name: `v2jets_${stage}`, kind: 'compute', code: g => jetsWGSL(g, stage), layouts: () => [V2_DYNAMICS_LAYOUT, JETS_LAYOUT, 'EMPTY'], tool: true }));
