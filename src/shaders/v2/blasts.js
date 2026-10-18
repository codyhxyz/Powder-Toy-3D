import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../v2.js';
import { dynamicsCommon, DynamicParams, storageLayout, main64, main1, CONTROL, heldBase } from './particles.js';
import { dynamicsRows, CELL_M, AIR, DT, GRAVITY, PARTICLE_CAP, LEGACY_PRESSURE_PA } from '../../v2/dynamics-reference.js';
import { E } from '../../elements.js';
import { RAYS } from '../../rays.js';
import { PHYS } from '../../physics.js';
import { EXTERNAL_BLAST_CAP, blastHeatBudgetWGSL } from '../../v2/externalBlast.js';
import { strokeDistanceWGSL, atlasIndexWGSL } from '../passes.js';
import { atlasDims } from '../common.js';
import { fold } from '../../gpu/kernels.js';
export { DynamicParams };
// Native cells/bank/activity3 + events, particles, air, control, plans5.
export const BLASTS_LAYOUT = storageLayout(5);
export const PLAN = Object.freeze({ SPAWN: 1, BREAK: 2, SOURCE: 4, NEUTRON: 8 });
export const CHILD_PREFIX = CONTROL.PREFIX;
export const SPAWN_PREFIX = CHILD_PREFIX + PARTICLE_CAP;
export const RAY_REQUEST_CAP = 64;
export const rayRequestBase = g => SPAWN_PREFIX + g.nbricks * 3;
export const externalBlastBase = g => heldBase(g) + PARTICLE_CAP;
export const externalParticleBase = g => externalBlastBase(g) + EXTERNAL_BLAST_CAP;
export const externalAirBase = g => externalParticleBase(g) + PARTICLE_CAP*4;
export const externalMaskBase = g => externalAirBase(g) + g.nbricks + 1;
export const externalMaskWords = g => { const {width,height}=atlasDims(g);return Math.ceil(width*height/4); };
// Ephemeral allocation metadata follows every persisted/external range. Counts
// become exclusive bases in-place; never alias the final per-particle prefixes.
export const ALLOCATION_CHUNKS = PARTICLE_CAP / 64;
export const allocationScratchBase = g => externalMaskBase(g) + externalMaskWords(g);
export const controlWords = g => allocationScratchBase(g) + ALLOCATION_CHUNKS * 2;
// After every saved and scratch range: the couple gate's [work, 1, 1, 0, work], copied whole to
// the dispatch args at COUPLE_ARGS (allocate, freeScan) and COUPLE_ARGS + 16 (freeCount,
// freeScatter, children). The control buffer holds these words past controlWords.
export const coupleArgsBase = g => controlWords(g);
export const COUPLE_ARGS_WORDS = 5;
export const COUPLE_ARGS = 64;
// Brick lists the GPU builds each tick (air.js, the first select): source (bricks the air
// source must read), step (bricks the substeps reach), wind (bricks whose air or a face
// neighbour's may move: gas, couple, air activity), events (bricks noted as holding a
// request). Each is [use, count, bricks...]: builders append to count, listArgs moves it to
// use, writes the list's dispatch args at LIST_ARGS and zeroes count. Then the air reach
// words, one a brick (the substeps' start set and its dilation), all past controlWords.
// jets: bricks the jets' count found flagged (src/shaders/v2/jets.js spawn runs over them); reachX,
// reachY: bricks the air reach's x and y scatters reached (air.js reach).
export const LIST_NAMES = ['source', 'step', 'wind', 'events', 'jets', 'reachX', 'reachY'];
// The charges one batch serves at most (DYNAMICS_ABI.blastBatchMax): its per-charge words.
export const CHARGES_MAX = 64;
// After the reach words, the one batch a tick's charge words: select's serviceable masks (two a
// brick), pick's charges in slot order and their count, normalize's scales, and plan's per-charge
// per-brick energy sums (charge-major).
export function listControl(g) {
  let at = coupleArgsBase(g) + COUPLE_ARGS_WORDS; const lists = {};
  for (const name of LIST_NAMES) { lists[name] = at; at += 2 + g.nbricks; }
  const reach = at; at += g.nbricks;
  const charges = { masks: at, slots: at + 2 * g.nbricks, count: at + 2 * g.nbricks + CHARGES_MAX,
    scales: at + 2 * g.nbricks + CHARGES_MAX + 1, sums: at + 2 * g.nbricks + 2 * CHARGES_MAX + 1 };
  // the jets' count adds every group's demand here; their gate reads it once and restarts it
  const jetTotal = charges.sums + CHARGES_MAX * g.nbricks;
  return { lists, reach, charges, jetTotal, words: jetTotal + 1 };
}
// Dispatch args (bytes): a thread a listed brick, or a workgroup a listed brick (cells).
export const LIST_ARGS = { source: COUPLE_ARGS + 32, step: COUPLE_ARGS + 48, wind: COUPLE_ARGS + 64, windCells: COUPLE_ARGS + 80, eventCells: COUPLE_ARGS + 96,
  jetCells: COUPLE_ARGS + 112, reachX: COUPLE_ARGS + 128, reachY: COUPLE_ARGS + 144 };
export const DISPATCH_ARGS_BYTES = COUPLE_ARGS + 160;
// Which args each list writes: [byte offset, per-cell (a workgroup a brick) or a thread a brick].
export const LIST_DISPATCH = { source: [[LIST_ARGS.source, false]], step: [[LIST_ARGS.step, false]],
  wind: [[LIST_ARGS.wind, false], [LIST_ARGS.windCells, true]], events: [[LIST_ARGS.eventCells, true]],
  jets: [[LIST_ARGS.jetCells, true]], reachX: [[LIST_ARGS.reachX, false]], reachY: [[LIST_ARGS.reachY, false]] };
// The list words and helpers, for families that bind control as atomics (air, blasts).
export function listWGSL(g) {
  const L = listControl(g);
  return /* wgsl */ `
${LIST_NAMES.map(n => `const LIST_${n.toUpperCase()}: u32 = ${L.lists[n]}u;`).join('\n')}
const A_REACH: u32 = ${L.reach}u;
const D_SERVE_MASKS: u32 = ${L.charges.masks}u;
const D_CHARGES: u32 = ${L.charges.slots}u;
const D_CHARGE_COUNT: u32 = ${L.charges.count}u;
const D_CHARGE_SCALES: u32 = ${L.charges.scales}u;
const D_CHARGE_SUMS: u32 = ${L.charges.sums}u;
const D_CHARGES_MAX: u32 = ${CHARGES_MAX}u;
// The i-th brick of a list, or D_NONE past the length its listArgs published.
fn dListed(list: u32, i: u32) -> u32 { if (i >= atomicLoad(&control[list])) { return D_NONE; } return atomicLoad(&control[list + 2u + i]); }
fn dAppend(list: u32, b: u32) { atomicStore(&control[list + 2u + atomicAdd(&control[list + 1u], 1u)], b); }
// A thread a listed brick, or a workgroup a listed brick (its cells); out of range past the list.
fn dListedBrick(list: u32, wg: vec3u, nwg: vec3u, li: u32) -> u32 { let b = dListed(list, dThread(wg, nwg, li)); return select(b, D_BRICKS, b == D_NONE); }
fn dListedCell(list: u32, wg: vec3u, nwg: vec3u, li: u32) -> u32 { let b = dListed(list, wg.x + wg.y * nwg.x); return select(b * 64u + li, D_SLOTS, b == D_NONE); }
fn aLive(b: u32) -> bool { return atomicLoad(&act2[V2_AIR_LIVE + b]) != 0u; }
// A superset of where wind or a pressure difference can move matter (dCoupleActive, gas,
// air activity): a brick whose air is live or has a live face neighbour, else at rest with
// rest neighbours (zero velocity and pressure), or every brick where couplePlan reads cells.
fn dWindListed(b: u32) -> bool {
  if (P.gravMode==2u || P.edge!=0u || P.nativeJets==0u || aLive(b)) { return true; }
  let base=cellOf(b*64u);
  for (var a=0u;a<3u;a++) { for (var s=-1;s<=1;s+=2) { let p=mEdge(base+dAxis(a)*4*s); if (inGrid(p) && aLive(brickOfCell(p))) { return true; } } }
  return false;
}
`;
}
// The one-thread stages that write indirect args, in listArgs' two-buffer layout (control, dispatch
// args): each writes the args it decides directly, so no copy splits the tick's compute pass.
export const LISTS_STAGES = [...LIST_NAMES, 'workArgs', 'coupleGate', 'publishCouple'];
const listsHead = `${DynamicParams.wgsl}
@group(3) @binding(1) var<uniform> P: DynamicParams;
@group(1) @binding(0) var<storage, read_write> control: array<u32>;
@group(1) @binding(1) var<storage, read_write> args: array<u32>;
const D_NONE: u32 = 0xffffffffu;`;
export function listsStageWGSL(g, name) {
  if (LIST_NAMES.includes(name)) return listArgsWGSL(g, name);
  const [cells0, cells1] = fold(Math.ceil(g.slots / 64)), [bricks0, bricks1] = fold(Math.ceil(g.nbricks / 64));
  // A batch's work: a selected source, or (outside mode 14) a pending grid neutron or children. The
  // saved control words 20..30 keep the args; the dispatch args get them at 0, 16, 32 and 48.
  if (name === 'workArgs') return `${listsHead}
@compute @workgroup_size(1) fn main() {
  let hasWork=control[3]!=D_NONE || (P.mode!=14u && (control[17]>0u || control[18]>0u));
  let cells=select(0u,${cells0}u,hasWork); let bricks=select(0u,${bricks0}u,hasWork); let one=select(0u,1u,hasWork);
  control[20]=cells; control[21]=${cells1}u; control[22]=1u; control[24]=bricks; control[25]=${bricks1}u; control[26]=1u;
  control[28]=one; control[29]=1u; control[30]=1u;
  args[0]=cells; args[1]=${cells1}u; args[2]=1u; args[4]=bricks; args[5]=${bricks1}u; args[6]=1u;
  args[8]=one; args[9]=1u; args[10]=1u; args[12]=one;
}
`;
  // The air tick's couple run (dynamics.js _coupleAllocate), after count. With nothing requested
  // and no live particle, preparation would find every slot free and no neutron parent, and the
  // allocator turn all-zero counts into all-zero bases: write the totals they would, zero their args.
  if (name === 'coupleGate') return `${listsHead}
@compute @workgroup_size(1) fn main() {
  var demand=0u; for(var group=0u;group<${Math.ceil(g.nbricks/64)}u;group++) { demand+=control[${SPAWN_PREFIX + g.nbricks}u+group]; }
  let work=select(0u,1u,demand>0u || control[0]>0u);
  if(work==0u) { control[4]=${PARTICLE_CAP}u; control[5]=0u; }
  args[${COUPLE_ARGS / 4}u]=work; args[${COUPLE_ARGS / 4 + 1}u]=1u; args[${COUPLE_ARGS / 4 + 2}u]=1u; args[${COUPLE_ARGS / 4 + 4}u]=work;
}
`;
  // The jets' gate words ([work, 1, 1, 0, work] at coupleArgsBase) into the couple args.
  // The jets' gate words ([work, 1, 1, 0, work] at coupleArgsBase) into the couple args, and the jets'
  // brick list (their count appended it) with spawn's args: a workgroup a listed brick.
  if (name === 'publishCouple') { const jets = listControl(g).lists.jets; return `${listsHead}
const MAX_WG: u32 = 65535u;
@compute @workgroup_size(1) fn main() {
  for (var i=0u;i<${COUPLE_ARGS_WORDS}u;i++) { args[${COUPLE_ARGS / 4}u+i]=control[${coupleArgsBase(g)}u+i]; }
  let n = control[${jets + 1}u]; control[${jets}u] = n; control[${jets + 1}u] = 0u;
  let y = max(1u, (n + MAX_WG - 1u) / MAX_WG);
  args[${LIST_ARGS.jetCells / 4}u] = (n + y - 1u) / y; args[${LIST_ARGS.jetCells / 4 + 1}u] = y; args[${LIST_ARGS.jetCells / 4 + 2}u] = 1u;
}
`; }
  throw new Error(`Unknown lists stage ${name}`);
}
// One thread: a list's builders are done; publish its length and dispatch args, start it over.
export function listArgsWGSL(g, name) {
  const L = listControl(g), base = L.lists[name];
  return /* wgsl */ `
@group(1) @binding(0) var<storage, read_write> control: array<u32>;
@group(1) @binding(1) var<storage, read_write> args: array<u32>;
const MAX_WG: u32 = 65535u;
fn writeFold(at: u32, n: u32) { let y = max(1u, (n + MAX_WG - 1u) / MAX_WG); args[at] = (n + y - 1u) / y; args[at + 1u] = y; args[at + 2u] = 1u; }
@compute @workgroup_size(1) fn main() {
  let n = control[${base + 1}u]; control[${base}u] = n; control[${base + 1}u] = 0u;
${LIST_DISPATCH[name].map(([offset, cells]) => `  writeFold(${offset / 4}u, ${cells ? 'n' : '(n + 63u) / 64u'});`).join('\n')}
}
`;
}
export const ALLOCATION_STAGES = ['freeCount','freeScan','freeScatter'];
// The air tick's couplePlan → count → apply run. Allocation stages treat it as
// mode 0; only couplePlan/count/apply read it, to skip couple-quiet bricks.
export const COUPLE_MODE = 16;
const f = n => Number.isInteger(n) ? `${n}.0` : String(n);
// Durable-event count, lowest serviceable source, neutron requests: select's sums.
export const RESET_SELECTION = 'atomicStore(&control[2],0u); atomicStore(&control[3],D_NONE); atomicStore(&control[17],0u);';
// The weakest breakable row: a pressure difference at or under it fractures nothing.
const MIN_BREAK_STRENGTH = Math.min(...dynamicsRows.filter(r => r.breakInto >= 0).map(r => r.strength));
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
${listWGSL(g)}
const D_CHILD_PREFIX: u32 = ${CHILD_PREFIX}u;
const D_SPAWN_PREFIX: u32 = ${SPAWN_PREFIX}u;
const D_SPAWN_COUNTS: u32 = D_SPAWN_PREFIX + D_BRICKS;
const D_ENERGY_SUMS: u32 = D_SPAWN_COUNTS + D_BRICKS;
${strokeDistanceWGSL}
${atlasIndexWGSL(g)}
const D_EXTERNAL_PARTICLES:u32=${externalParticleBase(g)}u;
fn dSelected(position: vec3f,id: u32) -> f32 {
 if(P.blastBounded!=0u && (any(vec3i(floor(position))<P.blastLo) || any(vec3i(floor(position))>P.blastHi))) { return 0.0; }
 if(P.blastFilter>=0 && id!=u32(P.blastFilter)) { return 0.0; }
 var distance=0.0;
 if(P.blastMasked!=0u) {
  let p=vec3i(floor(position))-P.blastMaskOrigin;if(!inGrid(p)) { return 0.0; }
  let index=atlasIndex(p);let word=atomicLoad(&control[${externalMaskBase(g)}u+(index>>2u)]);
  if(((word>>((index&3u)*8u))&255u)<128u) { return 0.0; }
 } else { distance=strokeDistance(position,P.center,P.blastEnd,P.blastGrow,P.blastShape); }
 if(distance>P.radius) { return 0.0; }
 if(P.blastFade==0u) { return 1.0; }
 return 1.0-smoothstep(P.radius*${f(PHYS.TOOL_FALLOFF)},P.radius+0.001,distance);
}
fn dBudgetVelocity(v: vec3f, direction: vec3f, energy: f32, mass: f32) -> vec3f {
 if(energy<=0.0) { return v; }let along=dot(v,direction);
 return v+direction*(sqrt(along*along+2.0*energy/max(mass,0.000001))-along);
}
${blastHeatBudgetWGSL}
fn dExplosive(id: u32) -> DExplosive { switch id { ${blastTables} default: { return DExplosive(0.0,0u,20.0,0u); } } }
fn dEvaporates(m: Material) -> bool { return cid(m.core)==${E.SINGULARITY}u && payloadOf(m.core)==0u; }
fn dChargeEnergy(m: Material) -> f32 {
  if (cid(m.core)==${E.SINGULARITY}u || cid(m.core)==${E.DUST}u) {
    return contactSpecialExplosion(m.core,${f(dynamicsRows[E.GUNPOWDER].energy)}).x;
  }
  return dExplosive(cid(m.core)).energy*dAmount(m);
}
fn dProduct(m: Material) -> Material {
  if (dEvaporates(m)) { return dCarrier(m); }
  if(cid(m.core)==${E.SINGULARITY}u || cid(m.core)==${E.DUST}u) {
    let e=contactSpecialExplosion(m.core,${f(dynamicsRows[E.GUNPOWDER].energy)});
    return makeMaterial(u32(e.y),e.z,65536u,u32(e.w));
  }
  let e=dExplosive(cid(m.core));return makeMaterial(e.product,e.temperature,65536u,e.ctype);
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
  var cell = source; var next = vec3f(1e30); var stride = vec3f(1e30); let step = vec3i(sign(delta));
  for (var a = 0u; a < 3u; a++) { if (delta[a] != 0.0) { stride[a] = abs(1.0/delta[a]); next[a] = 0.5*stride[a]; } }
  for (var crossed = 0u; crossed <= D_SWEEP_MAX; crossed++) {
    var a = 0u; if (next.y < next.x) { a = 1u; } if (next.z < next[a]) { a = 2u; }
    if (next[a] > 1.0) { return false; }
    cell[a] += step[a]; next[a] += stride[a];
    if (all(cell==destination)) { return false; }
    if (!inGrid(cell)) { return true; }
    if (cls(cid(loadMaterial(slotOf(cell)).core)) == 1u) { return true; }
  }
  return true;   // non-progress is shielded, never transparent (the loop's old unreachable tail: Tint warned)
}
// Exact external source position (not the voxel centre) for DDA shielding.
fn dExternalShieldedPosition(endpoint: vec3f) -> bool {
  let destination=vec3i(floor(endpoint));
  let start=P.center-vec3f(P.origin);let delta=endpoint-start;
  var cell=vec3i(floor(start));var next=vec3f(1e30);var stride=vec3f(1e30);let step=vec3i(sign(delta));
  if(all(cell==destination)) { return false; }
  for(var a=0u;a<3u;a++) { if(delta[a]!=0.0) {
    stride[a]=abs(1.0/delta[a]);
    next[a]=(f32(cell[a])+select(0.0,1.0,delta[a]>0.0)-start[a])/delta[a];
  } }
  for(var crossed=0u;crossed<=D_SWEEP_MAX;crossed++) {
    var a=0u;if(next.y<next.x) { a=1u; } if(next.z<next[a]) { a=2u; }
    if(next[a]>1.0) { return false; }
    cell[a]+=step[a];next[a]+=stride[a];
    if(all(cell==destination)) { return false; }
    if(!inGrid(cell)) { return true; }
    if(cls(cid(loadMaterial(slotOf(cell)).core))==1u) { return true; }
  }
  return true;
}
fn dExternalShielded(destination: vec3i) -> bool { return dExternalShieldedPosition(vec3f(destination)+0.5); }
// A charge's received share at p (direction times J, or zero): plan's expressions for a grid source.
fn dChargeShare(source: u32, p: vec3i) -> vec3f {
  let sourcePos=cellOf(source); let explosionEnergy=dChargeEnergy(loadMaterial(source)); let delta=vec3f(p-sourcePos);
  let weight=1.0; let r2 = max(0.25,dot(delta,delta));
  let received = explosionEnergy * 0.5 * weight / (12.566370614359*r2);
  if (received >= 0.01 && !dShielded(sourcePos,p)) { return normalize(delta+vec3f(0.000001))*received; }
  return vec3f(0);
}
fn dPressureAt(p0: vec3i) -> f32 { let p=mEdge(p0); if (!inGrid(p) || !mAirPressure()) { return 0.0; } return air[brickOfCell(p)].vp.w; }
// A superset of the bricks where couplePlan can flag anything. The powder-fall
// and jet-less lip rules read cells, so their modes keep every brick. Otherwise
// a cell needs wind in its own brick (every lift is >0) or a face-neighbour
// pressure difference over the weakest strength; p±4 on an axis lands in the
// same neighbour brick for every cell of b under solid edges.
fn dCoupleActive(b: u32) -> bool {
  if (P.gravMode==2u || P.edge!=0u || P.nativeJets==0u) { return true; }
  if (mAirVelocity() && any(air[b].vp.xyz!=vec3f(0))) { return true; }
  let base=cellOf(b*64u);
  for (var a=0u;a<3u;a++) {
    if (!(abs(dPressureAt(base+dAxis(a)*4)-dPressureAt(base-dAxis(a)*4))<=${f(MIN_BREAK_STRENGTH)})) { return true; }
  }
  return false;
}
fn dUnsupported(start: vec3i) -> bool {
  var p=start;
  for(var n=0u;n<D_SWEEP_MAX;n++) {
    let down=mDown(vec3f(p)+0.5);if(all(down==vec3i(0))) { return false; }
    p=mEdge(p+down);if(!inGrid(p)) { return P.edge==1u; }
    let k=cls(cid(loadMaterial(slotOf(p)).core));
    if(k==0u || k==4u) { return true; } if(k!=2u || all(p==start)) { return false; }
  }
  return false;
}
fn dInBody(p: vec3i) -> bool {
  return all(p>=P.boxStart) && all(p<P.boxStart+vec3i(P.boxSize));
}
fn dPlanSlot(linear: u32) -> u32 {
  if(P.mode!=13u) { return linear; }
  let count=P.boxSize.x*P.boxSize.y*P.boxSize.z;if(linear>=count) { return D_NONE; }
  let p=P.boxStart+vec3i(i32(linear%P.boxSize.x),i32((linear/P.boxSize.x)%P.boxSize.y),i32(linear/(P.boxSize.x*P.boxSize.y)));
  return slotOf(p);
}
fn dRank(slot: u32) -> u32 {
  let b = slot / 64u; var rank = atomicLoad(&control[D_SPAWN_PREFIX+b])+atomicLoad(&control[D_SPAWN_COUNTS+b/64u]);
  for (var s = b*64u; s < slot; s++) { if ((plans[s].flags & 1u) != 0u && (P.mode!=13u || dInBody(cellOf(s)))) { rank++; } }
  return rank;
}
fn dSpawn(slot: u32, rank: u32, m: Material, v: vec3f, rule: u32) -> bool {
  if (rank >= atomicLoad(&control[4])) { return false; }
  let dest = atomicLoad(&control[D_FREE+rank]); let p = cellOf(slot);
  particles[dest] = dParticle(vec3f(p+P.origin)+0.5,v,dId(p,rule),m); noteLive(dest);
  atomicStore(&control[D_HELD+dest],select(0u,P.sequence,P.mode==9u));
  atomicAdd(&control[0],1u); dWake(p); return true;
}
`;
}
export function blastsWGSL(g,nativeHead,stage) {
  const h = head(g,nativeHead);
  if (stage === 'externalBegin') return h + main1(`
    let local=vec3i(floor(P.center))-P.origin;
    let pending=atomicLoad(&control[${externalBlastBase(g)}u+P.substep])==0u;
    atomicStore(&control[3],select(D_NONE,D_SLOTS,pending && inGrid(local)));
  `);
  if (stage === 'externalGate') return h + main1(`
    // Planning is read-only. Refuse the ENTIRE blast before fracture, launch,
    // or pressure if even one packet cannot fit. Retry keeps its full budget.
    if(atomicLoad(&control[5])>atomicLoad(&control[4])) {
      atomicStore(&control[3],D_NONE); atomicAdd(&control[7],1u);
    }
  `);
  if (stage === 'reset') return h + main1(RESET_SELECTION);
  // Bricks noted as holding a request (noteEvents), for the first select. Only clears follow
  // it until the next tick's grid passes, so later batches could use it too; they select
  // through the previous batch's args instead (zero without work).
  if (stage === 'eventList') return h + main64(`
    if (t < D_BRICKS && atomicLoad(&act2[V2_EVENTS+t]) != 0u) { dAppend(LIST_EVENTS,t); }
  `);
  // A workgroup a brick of the event list: the census, and each serviceable charge into its brick's mask.
  if (stage === 'select') return h + main64(`
    // A brick never noted as holding a request holds none (noteEvents): one word, not 64.
    if (t >= D_SLOTS || atomicLoad(&act2[V2_EVENTS+t/64u]) == 0u || events[t] == 0u) { return; }
    atomicAdd(&control[2],1u); dWake(cellOf(t)); if ((events[t]&4u)!=0u) { atomicAdd(&control[17],1u); }
    let m=loadMaterial(t);
    if ((events[t]&1u) != 0u && (dChargeEnergy(m)>0.0 || dEvaporates(m)) && energyFits(dProduct(m),dProductEnergy(m))) {
      atomicOr(&control[D_SERVE_MASKS+2u*(t/64u)+((t&63u)>>5u)],1u<<(t&31u));
    }
  `,'dListedCell(LIST_EVENTS,wg,nwg,li)');
  // One thread: the batch's charges, the P.substep lowest serviceable slots (the mask bits of the
  // event list's bricks, which it clears), in slot order. One batch a tick serves them together:
  // The Powder Toy's rule, a chain spreads one step a frame. A charge another one sets off this tick
  // (contact requests come from the next tick's block pass) waits for the next tick's batch.
  if (stage === 'pick') return h + main1(`
    // The Powder Toy: a chain spreads one step a frame; a charge set off this tick waits for the next.
    var picked: array<u32, ${CHARGES_MAX}>; var n=0u; let most=min(P.substep,D_CHARGES_MAX);
    let bricks=atomicLoad(&control[LIST_EVENTS]);
    for (var i=0u;i<bricks;i++) {
      let b=atomicLoad(&control[LIST_EVENTS+2u+i]);
      for (var w=0u;w<2u;w++) {
        var bits=atomicExchange(&control[D_SERVE_MASKS+2u*b+w],0u);
        while (bits!=0u) {
          let s=b*64u+w*32u+firstTrailingBit(bits); bits&=bits-1u;
          var j=n;
          if (n<most) { n++; } else if (most==0u || s>=picked[most-1u]) { continue; } else { j=most-1u; }
          while (j>0u && picked[j-1u]>s) { picked[j]=picked[j-1u]; j--; }
          picked[j]=s;
        }
      }
    }
    for (var k=0u;k<n;k++) { atomicStore(&control[D_CHARGES+k],picked[k]); }
    atomicStore(&control[D_CHARGE_COUNT],n);
    atomicStore(&control[3],select(D_NONE,picked[0],n>0u)); // the batch has work (workArgs)
  `);
  if (stage === 'plan') return h + main64(/* wgsl */ `
    if (t >= D_SLOTS) { return; }
    let p = cellOf(t); let m = loadMaterial(t); let id = cid(m.core); let k = cls(id);
    var plan = DPlan(vec3f(0),0u);
    let source = atomicLoad(&control[3]);
    if (P.mode!=14u && (events[t]&4u)!=0u) { plan.flags = 9u; } // neutron request has its own immutable source
    if (source != D_NONE) {
      if (t == source && P.mode!=14u) { plan.flags |= 4u; }
      else if (id != 0u && (events[t]&1u)==0u) {
        var sourcePos=vec3i(floor(P.center))-P.origin; var explosionEnergy=P.strength;
        var delta=vec3f(p+P.origin)+0.5-P.center;
        if(P.mode!=14u) { sourcePos=cellOf(source); explosionEnergy=dChargeEnergy(loadMaterial(source)); delta=vec3f(p-sourcePos); }
        var weight=1.0;if(P.mode==14u) { weight=dSelected(vec3f(p+P.origin)+0.5,id); }
        if(weight==0.0) { plans[t]=plan; return; } let r2 = max(0.25,dot(delta,delta));
        let received = explosionEnergy * 0.5 * weight / (12.566370614359*r2);
        var shielded=false;
        if(P.mode==14u) { shielded=dExternalShielded(p); } else { shielded=dShielded(sourcePos,p); }
        if (received >= 0.01 && !shielded) {
          plan.velocity = normalize(delta+vec3f(0.000001))*received;
        }
      }
    }
    plans[t] = plan;
  `);
  // ---- One batch a tick (dynamics.js consumeMaterialEvents): the picked charges planned together.
  // Each charge keeps its own shielded energy and its own normalisation: plan sums every charge's
  // received energy per brick (a workgroup a brick, lanes in slot order: sum's order), normalize
  // scales each charge to its own budget, damage adds the charges' scaled shares. One charge is
  // today's plan, sum, normalize and damagePlan bit for bit (tools/v2/blast-batch-check.mjs).
  // External blasts (mode 14) keep plan/sum/normalize/damagePlan/finish.
  if (stage === 'planCharges') return h + `
var<workgroup> wgEnergy: array<f32,64>;
var<workgroup> wgCharges: u32;
` + main64(/* wgsl */ `
    // the charge count, uniform across the workgroup for the barriers below
    if (li==0u) { wgCharges=min(atomicLoad(&control[D_CHARGE_COUNT]),D_CHARGES_MAX); }
    let n=workgroupUniformLoad(&wgCharges); let live=t<D_SLOTS;
    var plan=DPlan(vec3f(0),0u); var p=vec3i(0); var eligible=false;
    if (live) {
      p=cellOf(t); let id=cid(loadMaterial(t).core);
      if ((events[t]&4u)!=0u) { plan.flags = 9u; } // neutron request has its own immutable source
      eligible=id != 0u && (events[t]&1u)==0u;
      for (var k=0u;k<n;k++) { if (atomicLoad(&control[D_CHARGES+k])==t) { plan.flags |= 4u; eligible=false; } }
    }
    for (var k=0u;k<n;k++) {
      var velocity=vec3f(0);
      if (eligible) { velocity=dChargeShare(atomicLoad(&control[D_CHARGES+k]),p); }
      if (k==0u) { plan.velocity=velocity; }
      wgEnergy[li]=length(velocity); workgroupBarrier();
      if (li==0u) {
        var energy=0.0; for (var lane=0u;lane<64u;lane++) { energy += wgEnergy[lane]; }
        atomicStore(&control[D_CHARGE_SUMS+k*D_BRICKS+t/64u],bitcast<u32>(energy));
      }
      workgroupBarrier();
    }
    // One charge: damage reads its share from the plan, as before; more: damage adds them up.
    if (live) { if (n!=1u) { plan.velocity=vec3f(0); } plans[t] = plan; }
  `);
  if (stage === 'normalizeCharges') return h + main1(`
    let n=min(atomicLoad(&control[D_CHARGE_COUNT]),D_CHARGES_MAX);
    for (var k=0u;k<n;k++) {
      var sum=0.0; for (var b=0u;b<D_BRICKS;b++) { sum += bitcast<f32>(atomicLoad(&control[D_CHARGE_SUMS+k*D_BRICKS+b])); }
      let budget=dChargeEnergy(loadMaterial(atomicLoad(&control[D_CHARGES+k])));
      atomicStore(&control[D_CHARGE_SCALES+k],bitcast<u32>(min(1.0,budget*0.5/max(sum,0.000001))));
    }
    // control[6] is the first charge's scale (one charge: normalize's), 1 without one
    atomicStore(&control[6],select(bitcast<u32>(1.0),atomicLoad(&control[D_CHARGE_SCALES]),n>0u));
  `);
  if (stage === 'damageCharges') return h + main64(`
    if (t >= D_SLOTS) { return; } var plan=plans[t]; let m=loadMaterial(t); let id=cid(m.core); let k=cls(id);
    let n=min(atomicLoad(&control[D_CHARGE_COUNT]),D_CHARGES_MAX);
    var energy=length(plan.velocity)*bitcast<f32>(atomicLoad(&control[6]));
    var combined=vec3f(0);
    if (n>1u && id!=0u && (events[t]&1u)==0u && (plan.flags&4u)==0u) {
      // several charges: each one's share at its own scale, summed (energy) and as a direction
      energy=0.0; let p=cellOf(t);
      for (var c=0u;c<n;c++) {
        let share=dChargeShare(atomicLoad(&control[D_CHARGES+c]),p)*bitcast<f32>(atomicLoad(&control[D_CHARGE_SCALES+c]));
        energy+=length(share); combined+=share;
      }
    }
    var kinetic=energy;
    if (energy>0.0 && k==1u) {
      var broken=m; broken.core.x=(broken.core.x&0xffffff00u)|u32(max(0,dBreak(id)));
      if (dBreak(id)>=0 && energy>=dToughness(id) && energyFits(broken,energyOf(m))) { plan.flags|=2u|(u32(dBreak(id))<<8u); kinetic-=dToughness(id); }
      else { kinetic=0.0; }
    }
    if (kinetic>0.0 && (k==2u || k==3u || (plan.flags&2u)!=0u) && (plan.flags&8u)==0u) {
      plan.flags|=1u;
      {
        var incoming=vec3f(0);
        if(k==2u) { incoming=vec3f(0,-fallVelocity(m.core),0); }
        if(k==3u) {incoming=vec3f(unpack2x16float(m.core.z),unpack2x16float(m.core.w&65535u).x)*${f(180*CELL_M/65536)};}
        let into=select(id,(plan.flags>>8u)&255u,(plan.flags&2u)!=0u);
        let direction=select(normalize(plan.velocity),normalize(combined+vec3f(0.000001)),n>1u);
        plan.velocity=dBudgetVelocity(incoming,direction,kinetic,dMass(into)*dAmount(m));
        plan.flags|=32u; // Absolute budgeted velocity already includes incoming motion.
      }
    }
    plans[t]=plan;
  `);
  // One thread: every picked charge in slot order, as finish served one: products, ledger, air.
  if (stage === 'finishCharges') return h + main1(/* wgsl */ `
    let n=min(atomicLoad(&control[D_CHARGE_COUNT]),D_CHARGES_MAX);
    for (var c=0u;c<n;c++) {
      let s=atomicLoad(&control[D_CHARGES+c]);
      let before=loadMaterial(s);
      if ((dChargeEnergy(before)<=0.0 && !dEvaporates(before)) || (events[s]&1u)==0u) { continue; }
      let product=dProduct(before); let productEnergy=dProductEnergy(before);
      // select() gated this BEFORE any damage: retry cannot duplicate a blast.
      if (!energyFits(product,productEnergy)) { continue; }
      let after=withEnergy(product,productEnergy);
      if (dEvaporates(before)) {
        let removed=energySub(energyOf(before),productEnergy);
        if ((removed.y&0x80000000u)==0u) { noteEnergySink(cellOf(s),removed); }
        else { noteEnergySource(cellOf(s),energyNeg(removed)); }
        storeMaterial(s,before,after); events[s]&=~1u; dWake(cellOf(s)); continue;
      }
      noteEnergySource(cellOf(s),energySub(productEnergy,energyOf(before)));
      storeMaterial(s,before,after);
      let b=brickOfCell(cellOf(s)); var a=air[b];
      // 1/4 blast energy enters acoustic compression, 1/2 bounded damage/KE,
      // 1/4 hot products. Pressure energy p² V / (2 rho c²), not an arbitrary kick.
      let addedP2=2.0*${f(AIR.rho*AIR.sound**2)}*dChargeEnergy(before)*0.25/${f(AIR.edge**3)};
      if(mAirPressure()) { a.vp.w=sqrt(a.vp.w*a.vp.w+addedP2); } a.thermal.z=0.0; air[b]=a; noteAir(b);
      events[s]&=~1u; dWake(cellOf(s));
    }
  `);
  if(stage==='externalParticlePlan') return h+main64(`
    if(t>=D_CAP) { return; }let base=D_EXTERNAL_PARTICLES+t*4u;
    for(var a=0u;a<4u;a++) { atomicStore(&control[base+a],0u); }
    if(atomicLoad(&control[3])==D_NONE) { return; }
    if(!slotLive(t)) { return; } let particle=particles[t];let id=particle.c0&255u;
    if(particle.id==0u || id>=254u) { return; }
    let local=vec3i(floor(particle.position))-P.origin;if(!inGrid(local)) { return; }
    let weight=dSelected(particle.position,id);if(weight==0.0 || dExternalShieldedPosition(particle.position-vec3f(P.origin))) { return; }
    let delta=particle.position-P.center;let energy=P.strength*0.5*weight/(12.566370614359*max(0.25,dot(delta,delta)));
    if(energy<0.01) { return; }let impulse=normalize(delta+vec3f(0.000001))*energy;
    for(var a=0u;a<3u;a++) { atomicStore(&control[base+a],bitcast<u32>(impulse[a])); }
    atomicStore(&control[base+3u],particle.id);
  `);
  if(stage==='externalParticleApply') return h+main64(`
    if(t>=D_CAP || atomicLoad(&control[3])==D_NONE) { return; }
    if(!slotLive(t)) { return; } let base=D_EXTERNAL_PARTICLES+t*4u;var particle=particles[t];
    if(particle.id==0u || particle.id!=atomicLoad(&control[base+3u])) { return; }
    let impulse=vec3f(bitcast<f32>(atomicLoad(&control[base])),bitcast<f32>(atomicLoad(&control[base+1u])),bitcast<f32>(atomicLoad(&control[base+2u])));
    let received=length(impulse)*bitcast<f32>(atomicLoad(&control[6]));if(received<=0.0) { return; }
    let before=dMaterial(particle);var after=before;var kinetic=received;
    // One quarter of this packet's already-normalized share becomes heat;
    // retain the same total budget, never a second blast-energy grant.
    let heat=dQuantizedBlastHeat(received);
    let energy=energyAdd(packetOwnedEnergy(before),heat);
    if(packetEnergyFits(before,energy)) { after=withPacketEnergy(before,energy);kinetic=dBlastKineticRemainder(received,heat); }
    particle.velocity=dBlastBudgetVelocity(particle.velocity,normalize(impulse),kinetic,dMass(cid(before.core))*dAmount(before));
    particle.c0=after.core.x;particle.tail=vec4u(after.core.yzw,bitcast<u32>(after.bank));particles[t]=particle;
    let p=vec3i(floor(particle.position))-P.origin;noteEnergySource(p,energySub(packetOwnedEnergy(after),packetOwnedEnergy(before)));dWake(p);
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
  if (stage === 'bodyPlan') return h + main64(`
    if(t>=D_SLOTS) { return; }var plan=DPlan(vec3f(0),0u);let p=cellOf(t);
    let m=loadMaterial(t);let id=cid(m.core);let k=cls(id);
    if(dInBody(p) && k!=0u && k!=1u && (P.bodyOnly<0 || id==u32(P.bodyOnly)) && (events[t]&1u)==0u) {
      let center=vec3f(p+P.origin)+0.5;let radial=center.xz-(P.center.xz+P.boxMax.xz)*0.5;
      let length2=length(radial);var outward=vec2f(0);
      if(length2>0.000001) { outward=radial/length2; }
      else { let angle=dRandom(dId(p,0x424f4459u),31u)*6.283185307;outward=vec2f(cos(angle),sin(angle)); }
      // Preserve the intended outward XZ + lift Y, not legacy's xz->xy swizzle.
      let direction=vec3f(outward.x+P.bodyAhead.x,P.bodyLift,outward.y+P.bodyAhead.y);
      let push=select(P.strength,P.bodyPushPowder,k==2u);
      plan.velocity=P.vector+direction/max(length(direction),0.000001)*push;plan.flags=select(0u,1u,any(plan.velocity!=vec3f(0)));
    }
    plans[t]=plan;
  `,'dPlanSlot(dThread(wg,nwg,li))');
  if (stage === 'couplePlan') return h + main64(/* wgsl */ `
    // A quiet brick's plans would all be empty; count and apply skip it too.
    // A workgroup a wind-listed brick (dWindListed holds wherever dCoupleActive does).
    if (t >= D_SLOTS || !dCoupleActive(t/64u)) { return; }
    var plan = DPlan(vec3f(0),0u); let p = cellOf(t);
    let m = loadMaterial(t); let id = cid(m.core); let k = cls(id);
    if (id != 0u && (events[t]&1u)==0u) {
      let wind = select(vec3f(0),air[brickOfCell(p)].vp.xyz,mAirVelocity());
      if (k==1u && dBreak(id)>=0) {
        var difference = 0.0;
        for (var a=0u;a<3u;a++) { difference = max(difference,abs(dPressureAt(p+dAxis(a)*4)-dPressureAt(p-dAxis(a)*4))); }
        if (difference > dStrength(id)) { plan.flags=2u|(u32(dBreak(id))<<8u); }
      } else if (k==2u || k==3u) {
        var exposed = false; for (var a=0u;a<3u;a++) { exposed = exposed || dOpen(p+dAxis(a)) || dOpen(p-dAxis(a)); }
        // Column-run water has no radial columns (columns.js): there a liquid cell over open space
        // drips the same way, so liquids fall toward the centre; what lands spreads by columns.js RADIAL.
        let radialDrip = k==3u && P.gravMode==2u && P.gravity>0.0 && dUnsupported(p);
        if ((k==2u && (P.gravMode==2u || P.edge!=0u) && ((P.gravity>0.0 && P.gravMode!=1u && dUnsupported(p)) || fallVelocity(m.core)>0.0)) || radialDrip) {
          // Real SI flight replaces disabled radial/open/loop column falls.
          // Whole unsupported runs promote together; full capacity leaves every
          // unallocated source exact and busy for deterministic retry.
          plan.flags=1u;plan.velocity=vec3f(0);
        }
        if (exposed && length(wind)>dLift(id)) { plan.flags=1u; plan.velocity=wind; }
        // §4.2: flux over an unsupported lip faster than 1m/s becomes a droplet.
if (P.nativeJets==0u && k==3u && dOpen(p+mDown(vec3f(p)+0.5))) {
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
  `,'dListedCell(LIST_WIND,wg,nwg,li)');
  // Reduction is per brick in canonical slot order; source order is independent
  // of dispatch order. Never allocate with atomicAdd's unspecified arrival order.
  if (stage === 'sum') return h + main64(`
    if (t >= D_BRICKS) { return; } var energy=0.0;
    for (var s=t*64u;s<(t+1u)*64u;s++) { energy += length(plans[s].velocity); }
    atomicStore(&control[D_ENERGY_SUMS+t],bitcast<u32>(energy));
    if(P.mode==14u) {
      var weight=0.0;for(var s=t*64u;s<(t+1u)*64u;s++) {
        let p=cellOf(s);let selected=dSelected(vec3f(p+P.origin)+0.5,cid(loadMaterial(s).core));
        if(selected>0.0 && !dExternalShielded(p)) {weight+=selected;}
      }
      atomicStore(&control[${externalAirBase(g)}u+t],bitcast<u32>(weight));
    }
  `);
  if (stage === 'normalize') return h + main1(`
    var sum=0.0; for (var b=0u;b<D_BRICKS;b++) { sum += bitcast<f32>(atomicLoad(&control[D_ENERGY_SUMS+b])); }
    if(P.mode==14u) { for(var i=0u;i<D_CAP;i++) {
      let base=D_EXTERNAL_PARTICLES+i*4u;
      sum+=length(vec3f(bitcast<f32>(atomicLoad(&control[base])),bitcast<f32>(atomicLoad(&control[base+1u])),bitcast<f32>(atomicLoad(&control[base+2u]))));
    } }
    if(P.mode==14u) { var airWeight=0.0;for(var b=0u;b<D_BRICKS;b++) {airWeight+=bitcast<f32>(atomicLoad(&control[${externalAirBase(g)}u+b]));}
      atomicStore(&control[${externalAirBase(g)+g.nbricks}u],bitcast<u32>(airWeight));
    }
    let source=atomicLoad(&control[3]); var scale=1.0;
    if (source!=D_NONE) {
      var budget=P.strength; if(P.mode!=14u) { budget=dChargeEnergy(loadMaterial(source)); }
      scale=min(1.0,budget*0.5/max(sum,0.000001));
    }
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
      plan.flags|=1u;
      {
        var incoming=vec3f(0);
        if(k==2u) { incoming=vec3f(0,-fallVelocity(m.core),0); }
        if(k==3u) {incoming=vec3f(unpack2x16float(m.core.z),unpack2x16float(m.core.w&65535u).x)*${f(180*CELL_M/65536)};}
        let into=select(id,(plan.flags>>8u)&255u,(plan.flags&2u)!=0u);
        plan.velocity=dBudgetVelocity(incoming,normalize(plan.velocity),kinetic,dMass(into)*dAmount(m));
        plan.flags|=32u; // Absolute budgeted velocity already includes incoming motion.
      }
    }
    plans[t]=plan;
  `);
  if (stage === 'count') return h + `
var<workgroup> brickDemand: array<u32,64>;
` + main64(`
    var n=0u;
    if(t<D_BRICKS) {
      var selected=true;
      if(P.mode==13u) {
        let base=cellOf(t*64u)&vec3i(-4);
        selected=!(any(base+vec3i(3)<P.boxStart) || any(base>=P.boxStart+vec3i(P.boxSize)));
      }
      if(selected && (P.mode!=${COUPLE_MODE}u || (dWindListed(t) && dCoupleActive(t)))) {
        for(var s=t*64u;s<(t+1u)*64u;s++) { if((plans[s].flags&1u)!=0u && (P.mode!=13u || dInBody(cellOf(s)))) { n++; } }
      }
    }
    // Rejected and padding lanes must still participate in the barrier.
    brickDemand[li]=n; workgroupBarrier();
    var prefix=0u; for(var lane=0u;lane<li;lane++) { prefix+=brickDemand[lane]; }
    // dRank reads a brick's prefix only for a plan count counted there; the couple run skips the rest.
    if(t<D_BRICKS && (P.mode!=${COUPLE_MODE}u || n>0u)) { atomicStore(&control[D_SPAWN_PREFIX+t],prefix); }
    if(li==63u) { atomicStore(&control[D_SPAWN_COUNTS+t/64u],prefix+n); }
  `);
  if (stage === 'freeCount') return h + `
var<workgroup> freeMasks: array<atomic<u32>,2>;
var<workgroup> childSum: atomic<u32>;
` + main64(`
    // Exactly D_CAP/64 workgroups: every lane owns one canonical pool slot.
    if(li==0u) { atomicStore(&freeMasks[0],0u); atomicStore(&freeMasks[1],0u); atomicStore(&childSum,0u); }
    workgroupBarrier();
    // A clear live bit means ID 0 (v2ActLayout plive): read only the others, and clear the stale ones.
    var particle=DParticle(vec3f(0.0),0u,vec3f(0.0),0u,vec4u(0u));
    if(slotLive(t)) { particle=particles[t]; if(particle.id==0u) { noteDead(t); } }
    if(particle.id==0u) { atomicOr(&freeMasks[li/32u],1u<<(li&31u)); }
    if(particle.id!=0u && particle.c0==D_NEUTRON && particle.tail.z>0u) { atomicAdd(&childSum,particle.tail.z); }
    workgroupBarrier();
    if(li==0u) {
      let base=${allocationScratchBase(g)}u+(t/64u)*2u;
      atomicStore(&control[base],countOneBits(atomicLoad(&freeMasks[0]))+countOneBits(atomicLoad(&freeMasks[1])));
      atomicStore(&control[base+1u],atomicLoad(&childSum));
    }
  `);
  if (stage === 'freeScan') return h + main1(`
    var free=0u; var children=0u;
    for(var chunk=0u;chunk<${ALLOCATION_CHUNKS}u;chunk++) {
      let base=${allocationScratchBase(g)}u+chunk*2u;
      let freeCount=atomicLoad(&control[base]); let childCount=atomicLoad(&control[base+1u]);
      atomicStore(&control[base],free); atomicStore(&control[base+1u],children);
      free+=freeCount; children+=childCount; // Preserve the old u32 modular sum.
    }
    atomicStore(&control[4],free);
  `);
  if (stage === 'freeScatter') return h + `
var<workgroup> freeMasks: array<atomic<u32>,2>;
var<workgroup> childCounts: array<u32,64>;
` + main64(`
    if(li==0u) { atomicStore(&freeMasks[0],0u); atomicStore(&freeMasks[1],0u); }
    workgroupBarrier();
    var particle=DParticle(vec3f(0.0),0u,vec3f(0.0),0u,vec4u(0u)); if(slotLive(t)) { particle=particles[t]; }
    let eligible=particle.id!=0u && particle.c0==D_NEUTRON && particle.tail.z>0u;
    childCounts[li]=select(0u,particle.tail.z,eligible);
    if(particle.id==0u) { atomicOr(&freeMasks[li/32u],1u<<(li&31u)); }
    workgroupBarrier();
    let base=${allocationScratchBase(g)}u+(t/64u)*2u;
    if(particle.id==0u) {
      let before=(1u<<(li&31u))-1u;
      var rank=countOneBits(atomicLoad(&freeMasks[li/32u])&before);
      if(li>=32u) { rank+=countOneBits(atomicLoad(&freeMasks[0])); }
      atomicStore(&control[D_FREE+atomicLoad(&control[base])+rank],t);
    }
    var prefix=D_NONE;
    if(eligible) {
      prefix=atomicLoad(&control[base+1u]);
      for(var lane=0u;lane<li;lane++) { prefix+=childCounts[lane]; }
    }
    atomicStore(&control[D_CHILD_PREFIX+t],prefix);
  `);
  if (stage === 'allocate') return h + main1(`
    var total=0u;
    for(var group=0u;group<(D_BRICKS+63u)/64u;group++) {
      let count=atomicLoad(&control[D_SPAWN_COUNTS+group]);
      atomicStore(&control[D_SPAWN_COUNTS+group],total); total+=count;
    }
    atomicStore(&control[5],total);
  `);
  if (stage === 'apply') return h + main64(/* wgsl */ `
    if(P.mode==14u && atomicLoad(&control[3])==D_NONE) { return; }
    if (t >= D_SLOTS || (P.mode==${COUPLE_MODE}u && !dCoupleActive(t/64u))) { return; }
    let plan=plans[t]; if (plan.flags==0u) { return; }
    if(P.mode==15u && (events[t]&1u)!=0u) { atomicAdd(&control[7],1u); dWake(cellOf(t)); return; }
    let before=loadMaterial(t); var after=before;
    if ((plan.flags&2u)!=0u) {
      after.core.x=(after.core.x&0xffffff00u)|((plan.flags>>8u)&255u);
      if (cid(after.core)!=cid(before.core) && cls(cid(after.core))==2u) { after.core=setFall(after.core,0.0,0.0); }
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
            if (!packetEnergyFits(packet,share)) { dWake(cellOf(t)); return; }
            packet=withPacketEnergy(packet,share);
            let remainingEnergy=energySub(energyOf(after),dParticleEnergy(packet));
            if (!energyFits(rest,remainingEnergy)) { dWake(cellOf(t)); return; }
            remainder=withEnergy(rest,remainingEnergy);
          }
        }
        // Bounded forcing supplies absolute velocity; ordinary impulses add to falling motion.
        let incoming=select(vec3f(0,-fallVelocity(before.core),0),vec3f(0),P.mode==15u || (plan.flags&32u)!=0u);
        if (dSpawn(t,rank,packet,plan.velocity+incoming,P.sequence ^ 0x53504157u)) { after=remainder; }
        else { atomicAdd(&control[7],1u); if(P.mode==15u) { dWake(cellOf(t)); return; } } // authoritative grid fallback, never erase a failed launch
      }
    }
    storeMaterial(t,before,after); dWake(cellOf(t));
  `,`select(dPlanSlot(dThread(wg,nwg,li)),dListedCell(LIST_WIND,wg,nwg,li),P.mode==${COUPLE_MODE}u)`);
  if (stage === 'children') return h + main64(/* wgsl */ `
    if (t >= D_CAP) { return; } let offset=atomicLoad(&control[D_CHILD_PREFIX+t]); if (offset==D_NONE) { return; }
    var parent=particles[t]; var n=parent.tail.z;
    for (var child=0u;child<parent.tail.z;child++) {
      let rank=atomicLoad(&control[5])+offset+child;
      if (rank>=atomicLoad(&control[4])) { break; }
      let dest=atomicLoad(&control[D_FREE+rank]); let id=max(1u,dHash(parent.id ^ (P.tick*2654435761u) ^ ((child+1u)*0x9e3779b9u)));
      var born=parent; born.id=id; born.tail.z=0u; born.tail.x=${RAYS.NEUT_LIFE}u; born.velocity=dDir(id)*${f(RAYS.NEUT_V*60*CELL_M)};
      particles[dest]=born; noteLive(dest); atomicStore(&control[D_HELD+dest],0u); atomicAdd(&control[0],1u); n--;
    }
    particles[t].tail.z=n; atomicSub(&control[18],parent.tail.z-n);
  `);
  if (stage === 'rayEmit') return h + main1(/* wgsl */ `
    let index=${rayRequestBase(g)}u+P.substep; var remaining=atomicLoad(&control[index]);
    if (remaining==0u) { return; }
    for (var slot=0u;slot<D_CAP;slot++) {
      if (slotLive(slot) && particles[slot].id!=0u) { continue; }
      let emitted=u32(P.strength)-remaining;
      let seed=max(1u,dHash(P.sequence ^ (emitted*2654435761u) ^ P.tick));
      let position=P.center+dDir(seed)*P.radius*pow(dRandom(seed,11u),1.0/3.0);
      var m=Material(vec4u(D_NEUTRON,${RAYS.NEUT_LIFE}u,bitcast<u32>(${f(RAYS.NEUT_E_FAST)}),0u),0i);
      if (P.mode==7u) {
        let local=vec3i(floor(position))-P.origin; var medium=0u;
        if (inGrid(local)) { medium=cid(loadMaterial(slotOf(local)).core); }
        m=Material(vec4u(D_PHOTON|(${RAYS.PHOTON_LIFE}u<<8u)|(medium<<24u),bitcast<u32>(1.0),bitcast<u32>(1.0),bitcast<u32>(1.0)),0i);
      }
      var velocity=P.vector; if (length(velocity)<0.000001) { velocity=dDir(seed)*${f(RAYS.NEUT_V*60*CELL_M)}; }
      particles[slot]=dParticle(position,velocity,seed,m); noteLive(slot); atomicStore(&control[D_HELD+slot],0u); remaining--; atomicAdd(&control[0],1u);
      let local=vec3i(floor(position))-P.origin; if (inGrid(local)) { dWake(local); }
      if (remaining==0u) { break; }
    }
    atomicStore(&control[index],remaining);
  `);
  if (stage === 'finish') return h + main1(/* wgsl */ `
    let s=atomicLoad(&control[3]);
    // The selection's last reader starts the next batch's select, which runs
    // only after work; nothing below touches the selection words.
    if (P.mode!=14u && P.substep>0u) { ${RESET_SELECTION} }
    if (s==D_NONE) { return; }
    if(P.mode==14u) {
      let total=bitcast<f32>(atomicLoad(&control[${externalAirBase(g)+g.nbricks}u]));
      if(mAirPressure() && total>0.0) { for(var b=0u;b<D_BRICKS;b++) {
        let weight=bitcast<f32>(atomicLoad(&control[${externalAirBase(g)}u+b]));if(weight<=0.0) {continue;}
        var a=air[b];let addedP2=${f(AIR.rho*AIR.sound**2/AIR.edge**3)}*P.strength*weight/total;
        a.vp.w=sqrt(a.vp.w*a.vp.w+addedP2);a.thermal.z=0.0;air[b]=a;noteAir(b);dWake(cellOf(b*64u));
      } }
      atomicStore(&control[${externalBlastBase(g)}u+P.substep],1u);return;
    }
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
    if(mAirPressure()) { a.vp.w=sqrt(a.vp.w*a.vp.w+addedP2); } a.thermal.z=0.0; air[b]=a; noteAir(b);
    events[s]&=~1u; dWake(cellOf(s));
  `);
  throw new Error(`Unknown blast stage ${stage}`);
}
export const BLAST_STAGES = [...ALLOCATION_STAGES,'eventList','reset','select','pick','planCharges','normalizeCharges','damageCharges','finishCharges','plan','sum','normalize','damagePlan','count','allocate','apply','children','finish','toolPlan','couplePlan','rayEmit','bodyPlan','externalBegin','externalGate','externalParticlePlan','externalParticleApply'];

export const WGSL_CHECK = BLAST_STAGES.map(stage => ({ name: `v2blasts_${stage}`, kind: 'compute',
  code: g => blastsWGSL(g,nativeDynamicsHead,stage), layouts: () => [V2_DYNAMICS_LAYOUT,BLASTS_LAYOUT,'EMPTY'], tool: true }));
WGSL_CHECK.push(...LISTS_STAGES.map(name => ({ name: `v2lists_${name}`, kind: 'compute',
  code: g => listsStageWGSL(g, name), layouts: () => [V2_DYNAMICS_LAYOUT, storageLayout(2), 'EMPTY'], tool: true })));
