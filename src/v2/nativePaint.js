import { fold, STAGE } from '../gpu/kernels.js';
import { prelude, STATE_OPTS, SEED_MAX } from '../shaders/common.js';
import { paintUpdateWGSL, PaintParams, paintDeclsWGSL, PAINT_LAYOUT } from '../shaders/passes.js';
import { nativeDynamicsHead } from '../shaders/v2.js';
import { modeWGSL } from '../shaders/v2/modes.js';
import { fallWGSL } from '../shaders/v2/fall.js';
import { nativeModes } from './modes.js';
import { nativeWeatherParams, boxWGSL, weatherMain, WEATHER_SPEED_SI } from './nativeWeather.js';
import { heldBase } from '../shaders/v2/particles.js';
import { PARTICLE_CAP } from './dynamics-reference.js';
import { PROP_TOOL } from '../elements.js';

// V1's cell writers that aren't steps (docs/webgpu.md D6: the brush, a construction stamp, an
// imported door), run on V2's own cells. Each writer's rule is V1's own text (its `update`: the
// brush's passes.js paintUpdateWGSL, shaders/construction.js buildStampUpdate, the doors' edits in
// pov/importedInteractions.js), evaluated on a frozen physical view of the native cells (the
// weather/force adapters' evaluate, nativeWeather.js); only the commit is native, and it touches
// only the cells the rule changed. Through V1's projection and the owned-cell import a write cost an
// export of every brick changed since the last one plus an import, and came back lossy: an owned
// cell FULL with its bank reset, the cells it didn't change re-merged from the projection. Here:
//   a move (TPT's Mix: MIX.cpp swaps with a cell of its own kind; a moving door leaf) takes the
//     source cell's exact core and bank (fill, flux, fall, latent heat);
//   a cell the rule replaced (V1's ownLegacy, or a change of element: noteLegacy's capture-2 rule)
//     is a new cell as V2's import makes one (shaders/v2.js importA: liquids FULL, their life, a
//     conductor's spark), except that the Property tool's type keeps a liquid's fill while it
//     stays a liquid (PropertyTool changes the type, not the mass);
//   a cell whose temperature, life or ctype the rule changed in place (Heat, Cool, Spark, Warm and
//     Cool air, the Property tool's temperature, life and ctype) merges them as V2's import merges
//     a cell it doesn't own (shaders/v2.js importProperties): sensible heat on its own bank, its
//     fill, flux and fall untouched.
// No legacy A/B write, no import. Every chunk is evaluated before any commits: Mix pairs and a
// stamp's footings read other cells, so the write reads the state before it (V1's two-phase edit, D6).
const binding = (n, read = false) => ({ binding: n, visibility: STAGE.COMPUTE, buffer: { type: read ? 'read-only-storage' : 'storage' } });
export const NATIVE_PAINT_EVAL_LAYOUT = [...PAINT_LAYOUT, binding(1), binding(2, true)];
export const NATIVE_PAINT_COMMIT_LAYOUT = [binding(0, true)];
export const NATIVE_PAINT_PARTICLE_LAYOUT = [binding(0, true), binding(1), binding(2)];
export const NATIVE_PAINT_RESULT_BYTES = 48;
// SWAP: a move (the result's core and bank are the source's); TYPE: a new cell; MERGE: properties
// merged in place, the result's pad.x the fields (NATIVE_PAINT_PARTICLE's TEMP/LIFE/CTYPE bits) and
// pad.y the temperature change in quarter degrees (the rule's own delta: a cell mid phase change
// keeps its latent heat, as importProperties adds sensible heat to the bank).
export const NATIVE_PAINT_FLAG = Object.freeze({ SWAP: 1, TYPE: 2, MERGE: 4 });
// What V1's brush rule changed on a flying cell (particleEvaluate), field by field, for the
// particle commit: KILL empties it, TYPE retypes it, TEMP/LIFE/CTYPE merge as importProperties does.
export const NATIVE_PAINT_PARTICLE = Object.freeze({ KILL: 1, TYPE: 2, TEMP: 4, LIFE: 8, CTYPE: 16 });
export const NATIVE_PAINT_PARTICLE_RESULT_BYTES = 32;
const resultWGSL = 'struct PaintResult { core: vec4u, after: vec4f, bank: i32, flags: u32, pad: vec2u }';
const particleResultWGSL = 'struct PaintParticleResult { after: vec4f, id: u32, changed: u32, pad: vec2u }';
const PF = NATIVE_PAINT_PARTICLE;
// mixCell's partner, recorded where V1 computes it; its ownLegacy call is the
// swap (passes.js: "a successful Mix swap replaces the selected cell").
const MIX_PARTNER = 'let q = p + lq - l;';
// V2 keeps airborne matter (splashes, ejecta, thrown cells) in its particle
// list, where V1 kept it in the grid: a brush whose V1 rule empties a cell
// (Erase, specific delete, Property type none) empties a flying one there too,
// and one that changes a cell's type, temperature, life or ctype (Heat, Cool,
// Spark, Property) changes a flying one the same way (particleCommit).
const particleWGSL = 'struct PaintParticle { position: vec3f, id: u32, velocity: vec3f, c0: u32, tail: vec4u }';
const updateHeadWGSL = (g, params, spec = paintSpec(g)) => `${prelude(g, STATE_OPTS.STATE_RO)}
${params.wgsl}
@group(3) @binding(1) var<uniform> P: ${params.name};
${modeWGSL}
${fallWGSL}
${spec.decls}
var<private> paintOwned: bool;
var<private> paintMoved: bool;
var<private> paintPartner: vec3i;
fn ownLegacy(s: u32) { paintOwned = true; }
${spec.update}`;
// A writer for createNativeEditKernel: its V1 update (the text a hook may extend: the move's source
// recorded where V1 computes it), decls and group-2 layout (binding 0 at most: the results and the
// banks take 1 and 2), params, which cells move (moved: a WGSL test after the update), which keep
// a liquid's fill when retyped (retype), and whether a move notes its energy (a door leaf moves
// one way; a Mix pair is mutual, so its energy moves and none is made).
export const paintSpec = g => ({ update: nativePaintUpdateWGSL(), decls: paintDeclsWGSL(g), layout: PAINT_LAYOUT, moved: 'P.tool==T_MIX && paintOwned', retype: `P.tool==${PROP_TOOL}`, particles: true });
export function nativeEditSpec({ update, decls = '', layout = [], hook = null, moved = 'false', retype = 'false', noteMoves = false }) {
  if (layout.some(e => e.binding !== 0)) throw new Error('nativeEditSpec: a writer binds binding 0 at most');
  let text = update;
  if (hook) {
    const parts = update.split(hook[0]);
    if (parts.length !== 2) throw new Error('nativeEditSpec: the writer no longer moves its source as expected');
    text = parts.join(hook[0] + hook[1]);
  }
  return { update: text, decls, layout, moved, retype, noteMoves, particles: false };
}
// A cell V1's writer made, as V2's import makes an owned one (shaders/v2.js importA: the element at
// its temperature, a liquid's life and ctype, a gas that fades given life, a conductor's ctype as its
// spark, the colour seed), holding amount of liquid.
const newCellWGSL = /* wgsl */ `
fn nativeNewCell(a: vec4f, amount: u32) -> Material {
 let id=u32(a.x); let k=cls(id);
 let legacy=u32(max(floor(a.w),0.0));
 var m=makeMaterial(id,a.y,amount,select(legacy&255u,0u,conductsNative(id)));
 if(k!=C_AIR) {
  var life=a.z;
  if(k==C_GAS && fadeOf(id)>0.0 && life<=0.0) { life=1.0; }
  m.core=withLife(m.core,life);
  if(k!=C_LIQUID) { m.core.w=u32(clamp(fract(a.w)/${SEED_MAX}*65536.0,0.0,65535.0))<<16u; }
 }
 if(conductsNative(id)) { m.core=withSpark(m.core,legacy); }
 return m;
}`;
// What V1's rule did to a cell it didn't move (a: before, outA: after, owned: it called ownLegacy):
// (flags, fields, temperature change in quarter degrees). Replaced (owned, or noteLegacy's change of
// element: its capture-2 rule): a new cell, as the import makes an owned one. Changed in place:
// importProperties's fields; a seed alone owns nothing.
const changeWGSL = /* wgsl */ `
fn nativeEditChange(a: vec4f, outA: vec4f, owned: bool) -> vec3u {
 if(all(outA==a)) { return vec3u(0u); }
 if(owned || eid(outA)!=eid(a)) { return vec3u(${NATIVE_PAINT_FLAG.TYPE}u,0u,0u); }
 var fields=0u; var dq=0;
 if(outA.y!=a.y) { fields|=${PF.TEMP}u; dq=i32(round((outA.y-a.y)*4.0)); }
 if(outA.z!=a.z) { fields|=${PF.LIFE}u; }
 if(floor(outA.w)!=floor(a.w)) { fields|=${PF.CTYPE}u; }
 if(fields==0u) { return vec3u(0u); }
 return vec3u(${NATIVE_PAINT_FLAG.MERGE}u,fields,bitcast<u32>(dq));
}`;
// The cell a result leaves (before: the cell as it is): a move takes its source's exact core and
// bank; a new cell is nativeNewCell, FULL unless a retype keeps a liquid's fill; a merge is V2's
// importProperties (shaders/v2.js bridgeWGSL) on the fields the rule changed: ctype, life, and the
// rule's own temperature change as sensible heat on the cell's bank. Fill, flux and fall are kept.
const commitWGSL = spec => /* wgsl */ `
fn nativeEditCommit(r: PaintResult, before: Material) -> Material {
 var m=before;
 if(r.flags==${NATIVE_PAINT_FLAG.SWAP}u) { m=Material(r.core,r.bank); }
 else if(r.flags==${NATIVE_PAINT_FLAG.TYPE}u) {
  let id=u32(r.after.x);
  var amount=FULLU;
  if(${spec.retype}) {
   if(id==cid(before.core)) { return before; }
   // a liquid that stays a liquid keeps its amount: PropertyTool changes the type, not the mass
   if(isLiq(before.core) && cls(id)==C_LIQUID) { amount=cFill(before.core); }
  }
  m=nativeNewCell(r.after,amount);
 } else {
  if((r.pad.x&${PF.CTYPE}u)!=0u) {
   let ct=u32(max(floor(r.after.w),0.0));
   if(conductsNative(cid(m.core))) { m.core=withSpark(m.core,ct); } else { m.core=withCtype(m.core,ct); }
  }
  if((r.pad.x&${PF.LIFE}u)!=0u && !(isLiq(m.core) && conductsNative(cid(m.core)))) { m.core=withLife(m.core,r.after.z); }
  if((r.pad.x&${PF.TEMP}u)!=0u) {
   let dq=bitcast<i32>(r.pad.y);
   let heat=energyMul(capacityQ(m.core),u32(abs(dq)));
   let edited=energyAdd(energyOf(m),select(heat,energyNeg(heat),dq<0));
   if(energyFits(m,edited)) { m=withEnergy(m,edited); }
  }
 }
 return m;
}`;
export function nativePaintUpdateWGSL() {
  const parts = paintUpdateWGSL.split(MIX_PARTNER);
  if (parts.length !== 2) throw new Error('passes.js mixCell no longer computes its partner as expected');
  return parts.join(`${MIX_PARTNER}\n  paintPartner = q;`);
}
export const nativePaintParams = () => nativeWeatherParams('nativePaint', { params: PaintParams });
export const nativeEditParams = (name, params) => nativeWeatherParams(name, { params });
export function nativePaintWGSL(g, params, stage, spec = paintSpec(g)) {
  if (stage === 'particleEvaluate') return `${updateHeadWGSL(g, params, spec)}
${particleWGSL}
${particleResultWGSL}
@group(2) @binding(1) var<storage, read_write> particleResults: array<PaintParticleResult>;
@group(2) @binding(2) var<storage, read> paintParticles: array<PaintParticle>;
${weatherMain(`if(i>=${PARTICLE_CAP}u) { return; }
particleResults[i]=PaintParticleResult(vec4f(0.0),0u,0u,vec2u(0u));
let particle=paintParticles[i]; if(particle.id==0u || (particle.c0&255u)>=254u) { return; }
let p=vec3i(floor(particle.position))-H.origin;
if(!inGrid(p) || any(p<P.editLo) || any(p>P.editHi)) { return; }
let a=compactProbeA(p,vec4u(particle.c0,particle.tail.xyz));
let b=vec4f(particle.velocity/${WEATHER_SPEED_SI},fetchB(p).w);
var outA=a; var outB=b; update(p,a,b,&outA,&outB);
var changed=0u;
if(eid(a)!=E_EMPTY && eid(outA)==E_EMPTY) { changed=${PF.KILL}u; }
else {
 if(eid(outA)!=eid(a)) { changed|=${PF.TYPE}u; }
 if(outA.y!=a.y) { changed|=${PF.TEMP}u; }
 if(outA.z!=a.z) { changed|=${PF.LIFE}u; }
 if(floor(outA.w)!=floor(a.w)) { changed|=${PF.CTYPE}u; }
}
if(changed!=0u) { particleResults[i]=PaintParticleResult(outA,particle.id,changed,vec2u(0u)); }`)}
`;
  if (stage === 'particleCommit') return `${params.wgsl}
@group(3) @binding(1) var<uniform> P: ${params.name};
${nativeDynamicsHead(g)}
${particleWGSL}
${particleResultWGSL}
@group(1) @binding(0) var<storage, read> particleResults: array<PaintParticleResult>;
@group(1) @binding(1) var<storage, read_write> paintParticles: array<PaintParticle>;
@group(1) @binding(2) var<storage, read_write> paintControl: array<atomic<u32>>;
${weatherMain(`if(i>=${PARTICLE_CAP}u) { return; }
let r=particleResults[i]; if(r.id==0u || paintParticles[i].id!=r.id) { return; }
var particle=paintParticles[i];
let p=vec3i(floor(particle.position))-H.origin;
if((r.changed&${PF.KILL}u)!=0u) {
 // a particle's death as the particle lane writes it (shaders/v2/particles.js), and no physgun hold survives it
 paintParticles[i].id=0u; atomicSub(&paintControl[0],1u); noteDead(i); atomicStore(&paintControl[${heldBase(g)}u+i],0u);
 markBusy(p); return;
}
// A flying cell is a packet: it owns no air carrier (layout.js packetCapacityQ), so every
// change is measured and re-encoded in packet energy, and what the tool added is a declared source.
let before=Material(vec4u(particle.c0,particle.tail.xyz),bitcast<i32>(particle.tail.w));
var m=before;
if((r.changed&${PF.TYPE}u)!=0u) {
 // the grid commit's retype (above): a liquid that stays a liquid keeps its amount
 let id=u32(r.after.x);
 var amount=FULLU;
 if(isLiq(before.core) && cls(id)==C_LIQUID) { amount=cFill(before.core); }
 m=makeMaterial(id,r.after.y,amount,u32(floor(r.after.w)));
 m.core=withLife(m.core,r.after.z);
 if(!isLiq(m.core)) { m.core.w=u32(fract(r.after.w)/${SEED_MAX / 65536})<<16u; }
} else {
 // V2's importProperties (shaders/v2.js bridgeWGSL), in packet capacity: ctype, life, sensible heat
 if((r.changed&${PF.CTYPE}u)!=0u) {
  let ct=u32(max(floor(r.after.w),0.0));
  if(conductsNative(cid(m.core))) { m.core=withSpark(m.core,ct); } else { m.core=withCtype(m.core,ct); }
 }
 if((r.changed&${PF.LIFE}u)!=0u && !(isLiq(m.core) && conductsNative(cid(m.core)))) { m.core=withLife(m.core,r.after.z); }
 if((r.changed&${PF.TEMP}u)!=0u) {
  let dq=i32(round(clamp((r.after.y+T_OFFSET)*4.0,0.0,41093.0)))-i32(cTq(m.core));
  let heat=energyMul(packetCapacityQ(m.core),u32(abs(dq)));
  let edited=energyAdd(packetOwnedEnergy(m),select(heat,energyNeg(heat),dq<0));
  if(packetEnergyFits(m,edited)) { m=withPacketEnergy(m,edited); }
 }
}
if(all(m.core==before.core) && m.bank==before.bank) { return; }
if(inGrid(p)) { noteEnergySource(p,energySub(packetOwnedEnergy(m),packetOwnedEnergy(before))); }
particle.c0=m.core.x; particle.tail=vec4u(m.core.yzw,bitcast<u32>(m.bank));
// a flying cell the brush gives a new element loses its paint, as the grid commit's (V1's scrub)
if(cid(m.core)!=cid(before.core)) { setParticleDeco(i,0u); }
paintParticles[i]=particle;
if(inGrid(p)) { markBusy(p); }`)}
`;
  if (stage === 'evaluate') return `${updateHeadWGSL(g, params, spec)}
${resultWGSL}
@group(2) @binding(1) var<storage, read_write> results: array<PaintResult>;
@group(2) @binding(2) var<storage, read> paintBanks: array<i32>;
${boxWGSL}
${changeWGSL}
${weatherMain(`if(i>=weatherCount()) { return; }
let p=weatherCell(i); let a=fetchA(p); let b=fetchB(p);
var outA=a; var outB=b; paintOwned=false; paintMoved=false; paintPartner=p;
update(p,a,b,&outA,&outB);
var r=PaintResult(vec4u(0u),outA,0,0u,vec2u(0u));
if(${spec.moved}) { r.core=fetchNativeCore(paintPartner); r.bank=paintBanks[slotOf(paintPartner)]; r.flags=${NATIVE_PAINT_FLAG.SWAP}u; }
else { let c=nativeEditChange(a,outA,paintOwned); r.flags=c.x; r.pad=c.yz; }
results[i]=r;`)}
`;
  if (stage === 'commit') return `${params.wgsl}
@group(3) @binding(1) var<uniform> P: ${params.name};
${nativeDynamicsHead(g)}
${resultWGSL}
@group(1) @binding(0) var<storage, read> results: array<PaintResult>;
${boxWGSL}
${newCellWGSL}
${commitWGSL(spec)}
${weatherMain(`if(i>=weatherCount()) { return; }
let r=results[i]; if(r.flags==0u) { return; }
let p=weatherCell(i); let s=slotOf(p); let before=loadMaterial(s);
let m=nativeEditCommit(r,before);
if(all(m.core==before.core) && m.bank==before.bank) { return; }
${spec.noteMoves ? '// (a door leaf moves one way: what arrives is a source here, what left a sink at its source, a new cell there)\nnoteEnergySource(p,energySub(energyOf(m),energyOf(before)));'
    : `// (a Mix pair is mutual by construction, both cells testing the same pair and coin: energy moves, none is made)\nif(r.flags!=${NATIVE_PAINT_FLAG.SWAP}u) { noteEnergySource(p,energySub(energyOf(m),energyOf(before))); }`}
// V1's edits scrub the decoration of every cell they give a new element (sim.edit { scrub: true },
// src/deco.js decoScrub: TPT's create_part resets dcolour); a Mix swap of equals keeps it in place
if(cid(m.core)!=cid(before.core)) { setDeco(s,0u); }
storeMaterial(s,before,m);
for(var z=-1;z<=1;z++) { for(var y=-1;y<=1;y++) { for(var x=-1;x<=1;x++) { markBusy(p+4*vec3i(x,y,z)); } } }`)}
`;
  throw new Error(`Unknown native paint stage ${stage}`);
}

// The driver: evaluate every chunk of the box, then commit every chunk; then,
// for a stroke that empties cells, the particle list (65536 slots, one pass each).
export function createNativePaintKernel(sim) {
  return createNativeEditKernel(sim, 'nativePaint', paintSpec(sim.g), nativePaintParams());
}
// name: its kernels' prefix; spec: paintSpec or nativeEditSpec; params: its nativeWeatherParams struct.
export function createNativeEditKernel(sim, name, spec, params) {
  const o = sim.compactOwner, d = o?.dynamics, gpu = sim.gpu;
  if (!d) throw new Error(`${name}: native dynamics unavailable`);
  const layout = (n, entries) => gpu.layout(n, entries);
  const evalLayout = layout(`${name}Evaluate`, [...spec.layout, binding(1), binding(2, true)]), commitLayout = layout('NATIVE_PAINT_COMMIT', NATIVE_PAINT_COMMIT_LAYOUT);
  const particleLayout = spec.particles ? layout('NATIVE_PAINT_PARTICLE', NATIVE_PAINT_PARTICLE_LAYOUT) : null;
  const make = (n, stage, layouts) => gpu.kernel({ name: n, params, code: nativePaintWGSL(sim.g, params, stage, spec), layouts });
  const evaluate = make(`${name}Evaluate`, 'evaluate', [sim.L.TABLES, sim.L.STATE_RO, evalLayout]);
  const commit = make(`${name}Commit`, 'commit', [o.nativeDynamics.layout, commitLayout]);
  const particleEvaluate = spec.particles ? make(`${name}ParticleEvaluate`, 'particleEvaluate', [sim.L.TABLES, sim.L.STATE_RO, evalLayout]) : null;
  const particleCommit = spec.particles ? make(`${name}ParticleCommit`, 'particleCommit', [o.nativeDynamics.layout, particleLayout]) : null;
  const kernels = [evaluate, commit, particleEvaluate, particleCommit].filter(Boolean);
  // Its own kernels only: it records none of the dynamics' (it writes their buffers: the flying
  // matter's records, which it edits as V1's brush did its moving cells), so the brush paints from the
  // first frame while their kernels still build (src/v2/physics.js dynamicsReady).
  const ready = Promise.all(kernels.map(k => k.ready)); ready.catch(() => {});
  const built = () => kernels.every(k => k.state === 'ready') && !d.disposed;
  /** box: grid cells; values: the params' fields; mask: a fill's bytes (the brush), or
   * source: the writer's own binding-0 buffer (a stamp's cells, a door's records); grid: run the
   * cell rule here; particles: apply the rule to the flying matter too (empty, retype, heat,
   * life, ctype: particleCommit; the brush only). */
  function run(box, values, mask, { grid = true, particles = false, source: own = null } = {}) {
    if (!built() || sim.disposed || o.disposed || sim.compactOwner !== o || !box) return false;
    if (particles && !spec.particles) throw new Error(`${name}: no particle stages`);
    const dims = [sim.g.nx, sim.g.ny, sim.g.nz];
    box = { lo: box.lo.map(v => Math.max(0, Math.ceil(v))), hi: box.hi.map((v, a) => Math.min(dims[a] - 1, Math.floor(v))) };
    if (box.lo.some((v, a) => v > box.hi[a])) return false;
    const limit = Math.min(gpu.limits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024, gpu.limits?.maxBufferSize ?? Infinity);
    const chunks = [];
    // Split at brick boundaries along the longest axis until each chunk's scratch fits one binding.
    if (grid) (function split(b) {
      const count = b.hi.reduce((n, v, a) => n * (v - b.lo[a] + 1), 1);
      if (count * NATIVE_PAINT_RESULT_BYTES <= limit) { chunks.push({ box: b, count }); return; }
      const span = b.hi.map((v, a) => v - b.lo[a]), a = span.indexOf(Math.max(...span));
      const cut = Math.floor((b.lo[a] + b.hi[a] + 1) / 8) * 4;
      if (cut <= b.lo[a] || cut > b.hi[a]) throw new RangeError('Native paint scratch cannot fit the binding limit');
      const left = { lo: [...b.lo], hi: [...b.hi] }, right = { lo: [...b.lo], hi: [...b.hi] };
      left.hi[a] = cut - 1; right.lo[a] = cut; split(left); split(right);
    })(box);
    o.sync();
    const source = own ?? (mask ? sim._paintMask(mask) : sim.noMask);
    const entries = (buffers, start = 0) => buffers.map((buffer, i) => ({ binding: start + i, resource: { buffer } }));
    const p = b => ({ ...nativeModes(sim), ...values, editLo: b.lo, editHi: b.hi, tick: o.tick + 1 });
    const dispatch = (k, n, bind, header, b) => {
      k.dispatch(gpu.frame, fold(Math.ceil(n / 64)), { bind, header, params: p(b) });
      sim.onPass?.(k.name, { kind: 'compute', gpuMs: null });
    };
    const evalGroup = (scratch, read) => gpu.bindGroup(evalLayout, [...(spec.layout.length ? [{ binding: 0, resource: { buffer: source } }] : []), ...entries([scratch, read], 1)], name);
    for (const c of chunks) {
      c.scratch = gpu.createBuffer({ label: `${name} results`, size: c.count * NATIVE_PAINT_RESULT_BYTES, usage: GPUBufferUsage.STORAGE });
      dispatch(evaluate, c.count, [sim.tables, sim.bindPhysicalRO, evalGroup(c.scratch, o.aux)], sim.readHeader({ physical: true }), c.box);
    }
    for (const c of chunks) {
      dispatch(commit, c.count, [o.nativeDynamics.group, gpu.bindGroup(commitLayout, entries([c.scratch]), `${name} commit`)], sim.header(), c.box);
      sim._retire(c.scratch);
    }
    if (particles) {
      // (after the grid's commit: a particle's cell rule reads the stroke's grid as V1's moving cells did)
      const results = gpu.createBuffer({ label: `${name} particle results`, size: PARTICLE_CAP * NATIVE_PAINT_PARTICLE_RESULT_BYTES, usage: GPUBufferUsage.STORAGE });
      dispatch(particleEvaluate, PARTICLE_CAP, [sim.tables, sim.bindPhysicalRO, evalGroup(results, d.particles)], sim.readHeader({ physical: true }), box);
      dispatch(particleCommit, PARTICLE_CAP, [o.nativeDynamics.group, gpu.bindGroup(particleLayout, entries([results, d.particles, d.control]), `${name} particles`)], sim.header(), box);
      sim._retire(results);
    }
    o.legacyPending = o.writtenSinceTick = true;
    sim.version++; o.seenVersion = sim.version; sim.changedAll = true;
    // a semantic write, as V1's sim.edit notes one (the World's render source)
    sim.worldRenderSource?.noteContentChange?.();
    d._externalWork(); sim.wake();
    return true;
  }
  return { ready, get isReady() { return built(); }, run };
}
