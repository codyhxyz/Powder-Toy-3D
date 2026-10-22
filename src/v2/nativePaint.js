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

// The brush tools whose V1 rule replaces a cell with another cell's or a new
// type's contents, run on the native cells themselves: TPT's Mix (MIX.cpp: a
// swap with a cell of its own kind) and the Property tool's type (PropertyTool:
// the particle keeps everything but its type). Through V1's projection and the
// owned-cell import they would come back FULL, with no bank or flux: a stirred
// puddle would grow. Here the rule is V1's own text (passes.js paintUpdateWGSL),
// evaluated on a frozen physical view of the native cells (the weather/force
// adapters' evaluate, nativeWeather.js); only the commit is native: a Mix swap
// moves the partner's exact core and bank (fill, flux, fall, latent heat), and a
// new type keeps a liquid's fill when it stays a liquid. No legacy A/B write,
// no import. Every chunk is evaluated before any commits: Mix pairs read each
// other, so the stroke reads the state before it (V1's two-phase paint, D6).
const binding = (n, read = false) => ({ binding: n, visibility: STAGE.COMPUTE, buffer: { type: read ? 'read-only-storage' : 'storage' } });
export const NATIVE_PAINT_EVAL_LAYOUT = [...PAINT_LAYOUT, binding(1), binding(2, true)];
export const NATIVE_PAINT_COMMIT_LAYOUT = [binding(0, true)];
export const NATIVE_PAINT_PARTICLE_LAYOUT = [binding(0, true), binding(1), binding(2)];
export const NATIVE_PAINT_RESULT_BYTES = 48;
export const NATIVE_PAINT_FLAG = Object.freeze({ SWAP: 1, TYPE: 2 });
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
const updateHeadWGSL = (g, params) => `${prelude(g, STATE_OPTS.STATE_RO)}
${params.wgsl}
@group(3) @binding(1) var<uniform> P: ${params.name};
${modeWGSL}
${fallWGSL}
${paintDeclsWGSL(g)}
var<private> paintOwned: bool;
var<private> paintPartner: vec3i;
fn ownLegacy(s: u32) { paintOwned = true; }
${nativePaintUpdateWGSL()}`;
export function nativePaintUpdateWGSL() {
  const parts = paintUpdateWGSL.split(MIX_PARTNER);
  if (parts.length !== 2) throw new Error('passes.js mixCell no longer computes its partner as expected');
  return parts.join(`${MIX_PARTNER}\n  paintPartner = q;`);
}
export const nativePaintParams = () => nativeWeatherParams('nativePaint', { params: PaintParams });
export function nativePaintWGSL(g, params, stage) {
  if (stage === 'particleEvaluate') return `${updateHeadWGSL(g, params)}
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
  if (stage === 'evaluate') return `${updateHeadWGSL(g, params)}
${resultWGSL}
@group(2) @binding(1) var<storage, read_write> results: array<PaintResult>;
@group(2) @binding(2) var<storage, read> paintBanks: array<i32>;
${boxWGSL}
${weatherMain(`if(i>=weatherCount()) { return; }
let p=weatherCell(i); let a=fetchA(p); let b=fetchB(p);
var outA=a; var outB=b; paintOwned=false; paintPartner=p;
update(p,a,b,&outA,&outB);
var r=PaintResult(vec4u(0u),outA,0,0u,vec2u(0u));
if(P.tool==T_MIX) {
 if(paintOwned) { r.core=fetchNativeCore(paintPartner); r.bank=paintBanks[slotOf(paintPartner)]; r.flags=${NATIVE_PAINT_FLAG.SWAP}u; }
} else if(any(outA!=a)) { r.flags=${NATIVE_PAINT_FLAG.TYPE}u; }
results[i]=r;`)}
`;
  if (stage === 'commit') return `${params.wgsl}
@group(3) @binding(1) var<uniform> P: ${params.name};
${nativeDynamicsHead(g)}
${resultWGSL}
@group(1) @binding(0) var<storage, read> results: array<PaintResult>;
${boxWGSL}
${weatherMain(`if(i>=weatherCount()) { return; }
let r=results[i]; if(r.flags==0u) { return; }
let p=weatherCell(i); let s=slotOf(p); let before=loadMaterial(s);
var m=before;
if(r.flags==${NATIVE_PAINT_FLAG.SWAP}u) {
 // Mutual by construction (both cells test the same pair and coin): energy moves, none is made.
 m=Material(r.core,r.bank);
} else {
 let id=u32(r.after.x);
 if(id==cid(before.core)) { return; }
 // the weather adapter's new-source rule (nativeWeather.js), but a liquid that
 // stays a liquid keeps its amount: PropertyTool changes the type, not the mass
 var amount=FULLU;
 if(isLiq(before.core) && cls(id)==C_LIQUID) { amount=cFill(before.core); }
 m=makeMaterial(id,r.after.y,amount,u32(floor(r.after.w)));
 m.core=withLife(m.core,r.after.z);
 if(!isLiq(m.core)) { m.core.w=u32(fract(r.after.w)/${SEED_MAX / 65536})<<16u; }
 noteEnergySource(p,energySub(energyOf(m),energyOf(before)));
}
if(all(m.core==before.core) && m.bank==before.bank) { return; }
// V1's brush scrubs the decoration of every cell it gives a new element (sim.edit { scrub: true },
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
  const o = sim.compactOwner, d = o?.dynamics, gpu = sim.gpu;
  if (!d) throw new Error('nativePaint: native dynamics unavailable');
  const params = nativePaintParams();
  const layout = (name, entries) => gpu.layout(name, entries);
  const evalLayout = layout('nativePaintEvaluate', NATIVE_PAINT_EVAL_LAYOUT), commitLayout = layout('NATIVE_PAINT_COMMIT', NATIVE_PAINT_COMMIT_LAYOUT);
  const particleLayout = layout('NATIVE_PAINT_PARTICLE', NATIVE_PAINT_PARTICLE_LAYOUT);
  const make = (name, stage, layouts) => gpu.kernel({ name, params, code: nativePaintWGSL(sim.g, params, stage), layouts });
  const evaluate = make('nativePaintEvaluate', 'evaluate', [sim.L.TABLES, sim.L.STATE_RO, evalLayout]);
  const commit = make('nativePaintCommit', 'commit', [o.nativeDynamics.layout, commitLayout]);
  const particleEvaluate = make('nativePaintParticleEvaluate', 'particleEvaluate', [sim.L.TABLES, sim.L.STATE_RO, evalLayout]);
  const particleCommit = make('nativePaintParticleCommit', 'particleCommit', [o.nativeDynamics.layout, particleLayout]);
  const kernels = [evaluate, commit, particleEvaluate, particleCommit];
  // Its own kernels only: it records none of the dynamics' (it writes their buffers: the flying
  // matter's records, which it edits as V1's brush did its moving cells), so the brush paints from the
  // first frame while their kernels still build (src/v2/physics.js dynamicsReady).
  const ready = Promise.all(kernels.map(k => k.ready)); ready.catch(() => {});
  const built = () => kernels.every(k => k.state === 'ready') && !d.disposed;
  /** box: grid cells; values: PaintParams; mask: a fill's bytes; grid: run the
   * cell rule here (Mix, Property type); particles: apply the rule to the flying matter too
   * (empty, retype, heat, life, ctype: particleCommit). */
  function run(box, values, mask, { grid = true, particles = false } = {}) {
    if (!built() || sim.disposed || o.disposed || sim.compactOwner !== o || !box) return false;
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
    const source = mask ? sim._paintMask(mask) : sim.noMask;
    const entries = (buffers, start = 0) => buffers.map((buffer, i) => ({ binding: start + i, resource: { buffer } }));
    const p = b => ({ ...nativeModes(sim), ...values, editLo: b.lo, editHi: b.hi, tick: o.tick + 1 });
    const dispatch = (k, n, bind, header, b) => {
      k.dispatch(gpu.frame, fold(Math.ceil(n / 64)), { bind, header, params: p(b) });
      sim.onPass?.(k.name, { kind: 'compute', gpuMs: null });
    };
    const evalGroup = (scratch, read) => gpu.bindGroup(evalLayout, [{ binding: 0, resource: { buffer: source } }, ...entries([scratch, read], 1)], 'native paint');
    for (const c of chunks) {
      c.scratch = gpu.createBuffer({ label: 'native paint results', size: c.count * NATIVE_PAINT_RESULT_BYTES, usage: GPUBufferUsage.STORAGE });
      dispatch(evaluate, c.count, [sim.tables, sim.bindPhysicalRO, evalGroup(c.scratch, o.aux)], sim.readHeader({ physical: true }), c.box);
    }
    for (const c of chunks) {
      dispatch(commit, c.count, [o.nativeDynamics.group, gpu.bindGroup(commitLayout, entries([c.scratch]), 'native paint commit')], sim.header(), c.box);
      sim._retire(c.scratch);
    }
    if (particles) {
      // (after the grid's commit: a particle's cell rule reads the stroke's grid as V1's moving cells did)
      const results = gpu.createBuffer({ label: 'native paint particle results', size: PARTICLE_CAP * NATIVE_PAINT_PARTICLE_RESULT_BYTES, usage: GPUBufferUsage.STORAGE });
      dispatch(particleEvaluate, PARTICLE_CAP, [sim.tables, sim.bindPhysicalRO, evalGroup(results, d.particles)], sim.readHeader({ physical: true }), box);
      dispatch(particleCommit, PARTICLE_CAP, [o.nativeDynamics.group, gpu.bindGroup(particleLayout, entries([results, d.particles, d.control]), 'native paint particles')], sim.header(), box);
      sim._retire(results);
    }
    o.legacyPending = o.writtenSinceTick = true;
    sim.version++; o.seenVersion = sim.version; sim.changedAll = true;
    d._externalWork(); sim.wake();
    return true;
  }
  return { ready, get isReady() { return built(); }, run };
}
