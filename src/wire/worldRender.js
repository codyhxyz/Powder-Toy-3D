// Explicit, inactive WORLD data owner. App owns drawing and staged Post.
import { WorldRenderAtlas, READY, worldBrickIndex } from '../world/renderAtlas.js';
import { WorldCellAtlasAdapter } from '../world/cellAtlasAdapter.js';
import { createWorldLightingHistory } from '../world/worldLightingHistory.js';
import { createWorldLightingRecords } from '../world/worldLightingRecords.js';
import { createWorldLightingInputs, createWorldFeedbackProvider } from '../gfx/worldLightingInputs.js';
import { createWorldGI } from '../gfx/worldGI.js';
import { createWorldGlow, worldGlowPlan } from '../gfx/worldGlow.js';
import { createWorldSunLighting } from '../gfx/worldSunLighting.js';
import { createLightingTransport, worldLightingNear } from '../gfx/worldLightingBatch.js';
import { createWorldAppearance } from '../gfx/worldAppearance.js';
import { worldSunProjection, WORLD_SUN_PITCH } from '../world/worldSun.js';
import { worldColumnTops, forecastSunCasters, forecastViewTiles, worldViewRays, forecastGatherSources, forecastSourceTiles } from '../world/worldSunForecast.js';
import { worldSunRings, worldCoarseCasters, WORLD_SUN_SHARPEN_TILES } from '../world/worldSunRings.js';
import { WORLD_GI_NEAR_RADIUS, worldGIReach } from '../world/worldGIRing.js';
import { worldViewAirFloors, worldViewAirWords, worldPageBudget, worldBudgetDemandSteps, worldFarthestSteps, WORLD_VIEW_NEAR_RADIUS } from '../world/worldViewRing.js';
import { createWorldResidency, worldResidentView, WORLD_RESIDENT_SHARE } from '../world/worldResidency.js';
import { worldGIGroundWords } from '../shaders/worldGI.js';
import { worldRunSync, worldRunSliced, worldSliceMeter, worldPause, WORLD_SLICE_COST as COST } from '../world/worldSlices.js';

const copy = v => v?.elements ? Array.from(v.elements) : typeof v?.toArray === 'function' ? v.toArray() : ArrayBuffer.isView(v) ? Array.from(v) : Array.isArray(v) ? v.map(copy) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k,copy(x)])) : v;
const frozen = v => { const c=copy(v); const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};return freeze(c); };
const complete = f => f?.incomplete === false && Array.isArray(f.requirements) && !f.requirements.length && Array.isArray(f.sun) && !f.sun.length;
const dep = token => ({id:token.dependencySetID,version:token.dependencyVersion});
function observedFeedback(gpu,options,wake) {
  const provider=createWorldFeedbackProvider(gpu,options);
  return Object.freeze({...provider,get failure(){return provider.failure;},reserve(frame){const ticket=provider.reserve(frame);return {submitted:ticket.submitted,record(...args){try{return ticket.record(...args);}finally{if(provider.failure)wake();}}};}});
}

// The atlas feedback's Sun-request suffix: one bit per Sun tile that can cover the
// world's diagonal. Shared with tools/check-world-fit.mjs, which builds the same atlas.
export const worldFeedbackExtraWords = (size) => {
  const bound=Math.ceil(Math.hypot(...size)/(256*WORLD_SUN_PITCH))+2;
  return Math.ceil(bound*bound/32);
};

/** No production call site. Installs only when Parent explicitly opts in.
 * Native tables/external resources remain caller-owned, with explicit pins.
 * request() captures the active cut synchronously; newer requests coalesce.
 */
// A load's CELL demand goes in batches of whole 32-cell cores (8^3 bricks),
// yielding between them: all of it in one synchronous batch froze the page
// for 3 s on Island and 6 s on Descent (2026-10-21). Every brick is still
// classified before the attempt goes on; a core is never split, so no core's
// fields are captured twice.
// The CELL pool headroom a first load reserves past its demand (worldClassify).
export const WORLD_LOAD_POOL_HEADROOM=0.5;
export const WORLD_CLASSIFY_BRICKS=2048;
// Source columns (64 cells square, the world's height) a batch produces per
// task before it packs: ~1-3 ms of JS each, and a load's first batches need
// ~100 apiece, their neighbours unproduced (Island, 2026-10-22).
export const WORLD_CLASSIFY_COLUMNS=16;
// Whole 32-cell cores (8^3 bricks) packed into batches of at most limit entries
// (a lone core may exceed it): CELL classification and the GI slabs share it.
export function worldCoreBatches(entries,limit,brickOf=e=>e) {
  const cores=new Map();
  for(const e of entries){const key=brickOf(e).map(n=>Math.floor(n/8)).join(',');if(!cores.has(key))cores.set(key,[]);cores.get(key).push(e);}
  const out=[];let batch=[];
  for(const core of cores.values()){if(batch.length&&batch.length+core.length>limit){out.push(batch);batch=[];}batch.push(...core);}
  if(batch.length)out.push(batch);
  return out;
}
export const worldClassifyBatches=(bricks,limit=WORLD_CLASSIFY_BRICKS)=>worldCoreBatches(bricks.map(b=>({brick:b,channels:READY.CELL})),limit,r=>r.brick);
// GI jobs in one SOURCE or gather dispatch. A slab per 32-cell core was ~900
// dispatches, each with its own 1.5 MB feedback readback, per SOURCE pass of an
// Island load (2026-10-22); 64 cores' worth keeps a dispatch bounded.
export const WORLD_GI_SLAB_JOBS=64*512;
// One GI stage's typed feedback, merged over all of its slabs: each requirement
// once with the union of its channels, each Sun tile once.
export function mergeWorldFeedback(list) {
  const channels=new Map(),sun=new Set();
  for(const f of list){for(const r of f.requirements??[])channels.set(r.index,(channels.get(r.index)??0)|r.channels);for(const i of f.sun??[])sun.add(i);}
  return Object.freeze({incomplete:true,requirements:Object.freeze([...channels].sort((a,b)=>a[0]-b[0]).map(([index,c])=>Object.freeze({index,channels:c}))),sun:Object.freeze([...sun].sort((a,b)=>a-b))});
}
// A brick's light can reach the picture only through a GI gather reading its
// SOURCE (shaders/worldGI.js worldGISourceRing is SOURCE's only reader), so
// a brick is a SOURCE candidate only if the eye, the scene or a gather asked
// for it, or it is one already. A brick asked for only as SUPPORT (a sun-map
// caster, a SOURCE's neighbour or lamp-shadow cells) is not: as a SOURCE it
// looked up the sun at its own lit faces, the tiles there needed casters of
// their own, and those became SOURCES in turn, so a load's sun set spread tile
// by tile over the whole island (Island, 2026-10-22: 1 -> 24 tiles, 39k ->
// 449k bricks over 17 attempts, every brick a SOURCE). A support brick a gather
// does read comes back as a typed SOURCE request, so every SOURCE the picture
// reads is still computed, and the same: only the unread ones are skipped.
// And of those only the ones a gather reads at full detail (reached: the eye's
// light-bounce ring and each gathered probe's, world/worldGIRing.js
// worldGIReach): a far brick the view asked for has its SOURCE read by no
// gather but a ray's far stride, which takes the ground twin past the ring
// (an earlier load's held SOURCE where there is one), so it is not computed
// (Island, 2026-10-22: ~78k SOURCES a restart, 20-28 s to publish). Small
// maps (Box) compute every brick's SOURCE (shaders/gi.js) and never get here.
// GPU completions budgetDemand and capacity() wait through for pages to come
// back to a full pool: a reclaimed page frees after one, a released snapshot's
// after two (its state, then its pages: renderAtlas.js _releaseSnapshot, _collect).
export const WORLD_RECLAIM_ROUNDS=3;
export const WORLD_SUPPORT_STAGES=Object.freeze(new Set(['forecast','sun','source']));
// A frame's misses that ask for nothing new: pages the transaction already requires (gone since, as
// a full CELL pool reclaims, or never published), bricks the budget dropped, an unresolved sign. Its
// attempt runs again for them this many times (extend); past that the frame is settled as complete
// as it can be and accepted, and the next transaction asks again. Before, extend() threw "WORLD scene
// feedback made no dependency progress" and the big map stopped drawing (Island, live 2026-10-23).
// An attempt's own unresolved asks (runRetry) that add nothing run it again as many times.
export const WORLD_IDLE_EXTENDS=2;
export function worldSourceEligible(i,{requirements,support,ownedSources,reached=null}) {
  return ownedSources.has(i)||requirements.has(i)&&!support.has(i)&&(!reached||reached(i));
}
// A lighting tick's GI records (history.begin): only the bricks the selection
// can pick, an owned SOURCE or probe or a brick the transaction asks to be
// one (worldSourceEligible, or a GI ask), and every SOURCE asked for by name
// (requestedSources: a plan's SOURCE that can be born a probe in place, which
// needs its record's declaration, sourceBirths). The selector skips every other
// record (selectWorldGI: sourceEligible and probeEligible false), so its plan,
// births and declarations are the same; but a record of every brick the
// metadata holds, 40k-450k of them, each tested against the change
// neighbourhood, was most of every tick's JS (real Chrome, 2026-10-22: 1.9-2.5
// s of begin() and 2.7-3.3 s of attempt() itself in 20 s). Also the probe
// births (never: asked for but not owned) and the SOURCES asked for anew. The
// batch's records are by book index, the metadata's own (worldLightingRecords).
// (worldGIRecordSteps: the same in slices, worldSlices.js; the batch's rows
// are read a slice at a time, its missing ones all reported together)
export const worldGIRecords=(batch,options)=>worldRunSync(worldGIRecordSteps(batch,options));
export function* worldGIRecordSteps(batch,{size,requirements,support,ownedSources,ownedProbes,reached=null},full=()=>false) {
  const eligible=[],rule={requirements,support,ownedSources,reached};
  for(const i of ownedSources){eligible.push(i);if(full(COST.member))yield;}
  for(const i of ownedProbes){if(!ownedSources.has(i))eligible.push(i);if(full(COST.member))yield;}
  for(const [i,bits] of requirements){if(!ownedSources.has(i)&&!ownedProbes.has(i)&&(bits&(READY.GI|READY.GI_SOURCE)||worldSourceEligible(i,rule)))eligible.push(i);if(full(COST.member))yield;}
  const nearChanged=worldLightingNear(size,batch.changes.changedBricks,2),records=new Array(eligible.length),never=[];
  let missing=null;const rows=full.limit?Math.max(1,Math.floor(full.limit/WORLD_RECORD_UNITS)):eligible.length;
  for(let k=0;k<eligible.length;){
    const end=Math.min(eligible.length,k+rows),part=k||end<eligible.length?eligible.slice(k,end):eligible;
    let read=null;
    try{read=batch.records(part);}catch(e){if(!e.requirements)throw e;(missing??=[]).push(e);}
    for(let j=0;read&&j<read.length;j++,k++){
      const r=read[j],i=eligible[k],probeEligible=ownedProbes.has(i)||!!(requirements.get(i)&READY.GI);
      records[k]={brick:r.brick,age:r.age,matter:r.matter,near:nearChanged(r.brick),probeEligible,sourceEligible:worldSourceEligible(i,rule)};
      if(probeEligible&&!ownedProbes.has(i))never.push(records[k]);
      if(full(WORLD_RECORD_UNITS))yield;
    }
    k=end;
  }
  if(missing){const e=missing[0];if(missing.length>1)e.requirements=missing.flatMap(m=>m.requirements);throw e;}
  const dims=size.map(n=>n/4),requestedSources=[];
  for(const [i,bits] of requirements){if(bits&READY.GI_SOURCE&&!ownedSources.has(i))requestedSources.push([i%dims[0],Math.floor(i/dims[0])%dims[1],Math.floor(i/(dims[0]*dims[1]))]);if(full(COST.member))yield;}
  return {records,never,requestedSources};
}
// A metadata row's units: read, then built into its GI record. One read takes
// a slice's worth of rows.
const WORLD_RECORD_UNITS=2*COST.record;
// ---- the CELL stage: the owner's field tick and packing (attempt()), at
// module level so tools/world-tick-repack-cpu-check.mjs runs them at a big
// map's scale ----
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
// One CELL adapter record and commit, its source columns first, a task's
// worth at a time.
async function recordCells(gpu,cells,options,label) {
  while(cells.recordSourceColumns(gpu.frame,options,WORLD_CLASSIFY_COLUMNS)){gpu.flush('WORLD Source columns');await pause();}
  // record() uses actual sourceDemand and cut.producer on the normal Frame.
  const h=cells.record(gpu.frame,options);
  gpu.flush(label);
  // No snapshot of the book before it: none is read, and one held through
  // the publish keeps the atlas from patching the book in place.
  cells.commitAfterSourceFlush(h,{previousLighting:false});
}
// A transaction's field tick, first: its cut's changes and the tick's
// advancing field owners reach the fields, and the CELL book drops every page
// they change, before any page is judged current (worldCellCurrent). A record
// of no bricks; nothing to do on a restart or a camera-only birth of the
// accepted cut. Whether it recorded.
// eye: the view's position in cells, or null: the cores nearest it advance
// first when the tick's field work is over its budget (world/fields.js _admit).
export async function worldAdvanceFields(gpu,cells,{fieldTick,smoothing=1,eye=null}) {
  if(!cells.behind(fieldTick))return false;
  await recordCells(gpu,cells,{fieldTick,requirements:[],smoothing,eye},'WORLD Fields tick');
  return true;
}
// A brick's CELL page is current while the book holds it: after
// worldAdvanceFields, every page the book holds is what a pack at this cut and
// field tick would write (renderAtlas.js cellRevision), so only bricks it
// lacks are packed. Packing every page not of this cut's source revision and
// field tick packed a big map's whole demand again on its second tick, on top
// of the old pages (Island 400k: a 9.75 s stall; Descent 650k: past the pool's
// 2^20 page cap, 2026-10-22), and a restart its unchanged pages (Island's
// sixth attempt: 35k of 134k, 2026-10-21).
export function worldCellCurrent(atlas,i) {const p=atlas.live.cell.get(i);return !!p&&(p.readyBits&READY.CELL)===READY.CELL;}
// Packs the bricks of ids (book indices) whose pages are not current, in
// batches of whole cores, yielding between them. How many it packed.
// paced (a map on screen): each batch first waits for the GPU to finish what
// went before. Unpaced, a load's new demand queued all its batches at once and
// every frame waited behind seconds of packing (Descent's view round, 182k
// bricks: 1.2 s stalls, real Chrome 2026-10-22). A first load is not paced:
// no frame waits on it, and waiting would only add idle gaps.
export async function worldClassify(gpu,cells,atlas,ids,{fieldTick,smoothing=1,full=worldSliceMeter(),paced=false},brick) {
  const stale=await worldRunSliced(worldStaleCellSteps(atlas,ids,brick,full));
  // One pool growth for the whole demand: a growth copies every public page.
  // A first load (unpaced) also reserves headroom while its loading screen is
  // up, so the pool doubles behind it rather than under the first frames: the
  // next tick's growth right after Island's first frame copied every page
  // (1.3 s, real Chrome 2026-10-22). Never past the page budget.
  const extra=paced?0:Math.ceil(stale.length*WORLD_LOAD_POOL_HEADROOM),room=(atlas.pageBudget?.cell??Infinity)-atlas.poolUsed('cell');
  atlas.reserve('cell',Math.max(stale.length,Math.min(stale.length+extra,room)));
  for(const [k,requirements] of worldClassifyBatches(stale).entries()){
    if(k)await (paced?(gpu.device??gpu).queue.onSubmittedWorkDone():pause());
    await recordCells(gpu,cells,{fieldTick,requirements,smoothing},'WORLD Source/Fields final capture');
  }
  return stale.length;
}
// ---- a transaction's scans over every brick it holds, in slices
// (worldSlices.js): each yields once a slice's work is done ----
// The bricks of ids whose CELL pages are not current (worldClassify).
export function* worldStaleCellSteps(atlas,ids,brick,full=()=>false) {
  const stale=[];for(const i of ids){if(!worldCellCurrent(atlas,i))stale.push(brick(i));if(full(COST.member))yield;}
  return stale;
}
// A transaction's demand (book indices): the lists' members, in their order.
export function* worldDemandIdSteps(lists,full=()=>false) {
  const ids=new Set();for(const list of lists)for(const i of list){ids.add(i);if(full(COST.member))yield;}
  return ids;
}
// How many of keys ids lacks (the CELL pages held outside the demand, budgetDemand).
export function* worldOutsideSteps(keys,ids,full=()=>false) {
  let outside=0;for(const i of keys){if(!ids.has(i))outside++;if(full(COST.member))yield;}
  return outside;
}
// list's members held outside skip (the owned ones a final publish restores).
export function* worldExceptSteps(list,skip,full=()=>false) {
  const out=[];for(const i of list){if(!skip.has(i))out.push(i);if(full(COST.member))yield;}
  return out;
}
// ids split by classify()'s rule (a current page is not packed again): {fresh, resident}.
export function* worldCurrentSplitSteps(ids,current,full=()=>false) {
  const fresh=new Set(),resident=new Set();
  for(const i of ids){(current(i)?resident:fresh).add(i);if(full(COST.member))yield;}
  return {fresh,resident};
}
// Set operations a budget drop or eviction does per brick (worldBudgetPass).
const WORLD_BUDGET_DROP_OPS=6;
// The GPU memory budget's pass over a transaction's demand ids (the owner's
// budgetDemand, installWorldRender; its rule is there). Every scan in slices
// (worldSlices.js, t.full), and every farthest-first rule a bucketed walk,
// not a sort (world/worldViewRing.js worldFarthestSteps): the same drops,
// evictions and kept demand as one synchronous sort a rule
// (tools/world-budget-slices-cpu-check.mjs, against d62feb64's). Descent sat
// over its budget, so every transaction ran this: 1.1 s in one task as a view
// round loaded ~96k bricks (real Chrome with the user's settings, 2026-10-22).
// What stays one call is atlas.remove (one commit for all of a rule's
// evictions: a commit a slice would be a new generation each).
// ctx: the owner's atlas, budget, cellCurrent, brick, owned SOURCE/probe/glow
// sets, viewAirFor, setViewAir(air) (a new set of floors), reclaim(kind,over)
// and pause (worldRunSliced's; a test's meter).
export async function worldBudgetPass(t,ids,{atlas,budget,cellCurrent,brick,ownedSources,ownedProbes,ownedGlow,viewAirFor,setViewAir,reclaim,pause=worldPause}) {
  const full=t.full??worldSliceMeter(),run=steps=>worldRunSliced(steps,{pause});
  const outside=await run(worldOutsideSteps(atlas.live.cell.keys(),ids,full));
  const limit=Math.max(0,budget.cell-outside),roomNow=()=>Math.max(0,budget.pool.cell-atlas.poolUsed('cell'));
  let room=roomNow();
  if(ids.size<=limit&&ids.size<=room)return;
  const {fresh,resident}=await run(worldCurrentSplitSteps(ids,cellCurrent,full));
  if(ids.size<=limit&&fresh.size<=room)return;
  const eye=t.frame.values?.cam,cam=eye&&Array.from(eye).length===3&&Array.from(eye).every(Number.isFinite)?Array.from(eye):null;
  const current=await viewAirFor();let air=current.air;
  const warn=what=>console.warn(`WORLD load over its GPU page budget (${budget.cell} pages, pool ${budget.pool.cell}): ${what}`);
  const drop=function*(r,why){
    // (and from resident: a dropped brick's page is outside the demand now, so the
    // last eviction never picks a page an earlier one already removed)
    for(const i of r.dropped){ids.delete(i);fresh.delete(i);resident.delete(i);t.requirements.delete(i);t.support.delete(i);t.dropped.add(i);if(full(WORLD_BUDGET_DROP_OPS))yield;}
    air=r.air;t.budgetDropped=t.dropped.size;
    warn(`${r.dropped.length} farthest bricks dropped${why}`);
  };
  // only bricks this load asked for may go: never a held page, a glow core's region, a record's brick or a pinned support brick
  const held=i=>!t.requirements.has(i)||t.pinned.has(i)||ownedSources.has(i)||ownedProbes.has(i)||ownedGlow.has(i);
  const r=await run(worldBudgetDemandSteps(ids,{budget:limit,eye:cam,brick,held,air,fresh,room,resident},full));
  if(r.dropped.length)await run(drop(r,''));
  if(fresh.size>room){await reclaim('cell',()=>fresh.size-roomNow());room=roomNow();}
  const keeps=i=>t.pinned.has(i)||t.squeezed.has(i)||ownedSources.has(i)||ownedProbes.has(i);
  // Pages kept resident (a load never evicts one), farthest first: the ones
  // outside this demand, then (past them) this demand's own; an evicted one
  // of the demand is dropped from it, its misses settled as a dropped brick's
  // (worldSettleFeedback). list: the pages, of which skip(i) are not candidates.
  const evict=async(list,skip)=>{
    const count=fresh.size-room,out=[];
    await run(worldFarthestSteps(list,{eye:cam??[0,0,0],brick,skip:i=>skip(i)||keeps(i),visit:i=>out.push(i)>=count},full));
    if(!out.length)return;
    atlas.remove(await run((function*(){const bricks=[];for(const i of out){bricks.push(brick(i));if(full(COST.member))yield;}return bricks;})()),READY.CELL);
    await run((function*(){for(const i of out){if(ids.has(i)){ids.delete(i);resident.delete(i);t.requirements.delete(i);t.support.delete(i);t.dropped.add(i);t.squeezed.add(i);}if(full(WORLD_BUDGET_DROP_OPS))yield;}})());
    t.budgetDropped=t.dropped.size;
    warn(`${out.length} farthest resident pages evicted`);
    await reclaim('cell',()=>fresh.size-roomNow());room=roomNow();
  };
  if(fresh.size>room)await evict(atlas.live.cell.keys(),i=>ids.has(i));
  if(fresh.size>room){
    const r2=await run(worldBudgetDemandSteps(ids,{budget:Infinity,eye:cam??[0,0,0],brick,held:keeps,air,fresh,room,resident,radius:0},full));
    await run((function*(){for(const i of r2.dropped){t.squeezed.add(i);if(full(COST.member))yield;}})());
    if(r2.dropped.length)await run(drop(r2,' (past the near ring rule: the pool is full)'));
  }
  if(fresh.size>room)await evict(resident,()=>false);
  if(air!==current.air)setViewAir(air);
}
// The bricks a transaction's metadata stage records (book indices): the
// committed rows a cut may have changed (worldLightingRecords stale), and the
// bricks of ids no row holds yet. ids holds every committed row's brick and
// those of extra (the requirements and glow regions); every owned SOURCE and
// probe has a committed row (its records were read when it was selected, and
// rows go only on a reset, with the owned sets), so extra need not list them.
// Bounded by the change, the cores and extra, not by the rows committed.
export function worldMetadataFresh(metadata,ids,{cut,captureOf,carry=null,carried=null,extra=[]}) {
  const out=[],seen=metadata.stale(cut,{captureOf,carry});
  for(const i of seen)out.push(i);
  for(const list of extra)for(const i of list)if(!seen.has(i)&&ids.has(i)&&!metadata.has(i)&&!carried?.has(i)){seen.add(i);out.push(i);}
  return out;
}
// The light pages a final publish allocates (book indices, of all): every one
// but those this attempt's public restore already made resident (resident:
// index -> its job and the SOURCE and probe tokens it restored) that the book
// still holds (live) with the very leases the publish would restore again
// (leases: index -> {source, gi}) and no new output (fresh). Such a page holds
// the bytes, readiness, ticks and dependencies the publish would write: the
// same retained outputs' slots, by the same tokens, at the same cut revision
// (shaders read a page by its book readiness, worldAccess.js
// worldLightDescriptor). A big map's publish restored every owned SOURCE and
// probe a second time, 90k-115k pages (2026-10-22).
export const worldRestoreResident=(all,options)=>worldRunSync(worldRestoreResidentSteps(all,options));
export function* worldRestoreResidentSteps(all,{resident,live,leases,fresh},full=()=>false) {
  if(!resident?.size)return all;
  const out=new Set();
  for(const i of all){
    const r=resident.get(i),held=leases.get(i);
    if(!r||fresh(i)||live.get(i)?.job!==r.job||(held?.source?.token??null)!==r.source||(held?.gi?.token??null)!==r.gi)out.add(i);
    if(full(COST.record))yield;
  }
  return out;
}
// The light pages an attempt's public restore can keep (wire/worldRender.js attempt): those the
// book still holds (live: index -> page) as the very job an earlier restore made (restored: index
// -> its job and the SOURCE and probe tokens it restored), at this cut's source revision, with the
// same retained outputs this restore's leases name. Such a page holds the bytes, readiness, ticks
// and provenance the restore would write again (worldRestoreResident's rule, one restore earlier).
// Every other page the book holds is invalidated, as every one was before: each attempt cleared
// the whole light book and restored every owned SOURCE and probe again, ~78k pages on Island,
// though within a transaction (one cut) they were the same. Only restored pages are kept: their
// channels are checked by provenance, never by a dependency manifest a later publish replaces.
// Returns {kept: index -> restored entry, invalidations}; restored loses every entry not kept.
export const worldLightKeep=(live,leases,options)=>worldRunSync(worldLightKeepSteps(live,leases,options));
export function* worldLightKeepSteps(live,leases,{restored,sourceRevision},full=()=>false) {
  const named=new Map(),kept=new Map(),invalidations=[];
  for(const l of leases){if(!named.has(l.index))named.set(l.index,{source:null,gi:null});named.get(l.index)[l.kind]=l.token;if(full(COST.member))yield;}
  for(const [i,page]of live){
    const r=restored.get(i),n=named.get(i);
    if(r&&n&&page.job===r.job&&r.job.sourceRevision===sourceRevision&&n.source===r.source&&n.gi===r.gi)kept.set(i,r);
    else{invalidations.push({brick:[...page.brick],channels:READY.LIGHT});restored.delete(i);}
    if(full(COST.record))yield;
  }
  for(const i of restored.keys()){if(!kept.has(i))restored.delete(i);if(full(COST.member))yield;}
  return {kept,invalidations};
}
// A frame's feedback whose only misses are budget-dropped bricks (and Sun tiles it
// already has), settled as complete; any other feedback unchanged (owner.settle).
// idle (past WORLD_IDLE_EXTENDS reruns): any feedback that asks for nothing new
// settles too: each miss dropped or already in requirements with its channels.
export function worldSettleFeedback(feedback,{dropped,sunTiles,index,requirements=null,idle=false}) {
  const req=feedback?.requirements??[],sun=feedback?.sun??[];
  if(!feedback||feedback.incomplete===false)return feedback;
  if(!idle&&(!dropped?.size||!(req.length||sun.length)))return feedback;
  for(const r of req){
    const i=index(r);
    if(dropped?.has(i))continue;
    const old=idle?requirements?.get(i):undefined;
    if(old===undefined||(old|r.channels)!==old)return feedback;
  }
  for(const i of sun)if(!sunTiles.has(i))return feedback;
  return Object.freeze({...feedback,incomplete:false,requirements:Object.freeze([]),sun:Object.freeze([])});
}
export function installWorldRender(win, {gpu=win.gpu,source=win.renderSource,producer=win.sourceProducer,tables=win.sim.tables,tableBuffer=gpu._simTables?.buffer,wake=()=>{},giSlabJobs=WORLD_GI_SLAB_JOBS,keepResident=true}={}) {
  if(win.render)throw new Error('WORLD data owner already installed');
  if(!source||!producer||source.win!==win||source.gpu!==gpu)throw new TypeError('actual WORLD Source/Producer required');
  if(!tables||Number.isInteger(tables.size)||!Number.isInteger(tableBuffer?.size)||tableBuffer.size<16)throw new TypeError('distinct TABLES bind group and native table buffer required');
  const size=[...win.size], dims=size.map(n=>n/4), g={nx:size[0],ny:size[1],nz:size[2],sourceAppearance:!!win.scene.appearanceWords};
  const atlas=new WorldRenderAtlas(gpu,{worldSize:size,feedbackExtraWords:worldFeedbackExtraWords(size)});
  while(atlas.epoch<source.epoch)atlas.reset();
  const cells=new WorldCellAtlasAdapter({gpu,source,producer,atlas,tables,worldBounds:{min:[0,0,0],max:size}});
  const metadataFeedback=observedFeedback(gpu,{},wake);
  const metadata=createWorldLightingRecords(gpu,{worldSize:size,sourceOwner:source,submissionProvider:metadataFeedback});
  const transport=createLightingTransport(gpu.device);
  let history=null, active=null, queued=null, accepted=null, dead=false, serial=0, failure=null, resetting=false, resetWork=null;
  // Sun-caster forecast (world/worldSunForecast.js): the scene's ground twin, and
  // the tiles whose casters were already asked for on this projection grid.
  const tops=worldColumnTops({size,scene:win.scene,P:win.P}), forecastTiles=new Set(), shellTiles=new Set();let forecastGrid=null;
  // Far sun tiles' coarse casters (world/worldSunRings.js): the same ground twin
  // as a heightfield, built once for the scene during the first load's CELL
  // stage (its slices yield between the CELL batches) and awaited by its sun.
  let coarseBuild=null;
  // The light bounce's near ring (world/worldGIRing.js): a gather asks for SOURCES
  // only within it of the eye, and reads the same ground twin, packed, past it.
  let giGround=null;
  const giRing=t=>{const eye=t.frame.values?.cam;return tops&&eye&&Array.from(eye).length===3&&Array.from(eye).every(Number.isFinite)?{eye:Array.from(eye),radius:WORLD_GI_NEAR_RADIUS}:null;};
  const giGroundFor=async()=>{if(!tops)return null;coarseBuild??=worldCoarseCasters({size,tops});giGround??=coarseBuild.then(c=>Object.freeze({words:worldGIGroundWords(c.heights),columns:[...c.dims]}));return giGround;};
  // The view's far-air floors (world/worldViewRing.js), from the same ground
  // twin, on the SunBook; the GPU memory budget lowers them where it drops
  // bricks (viewAir.id: a new set publishes a new book).
  let viewAir=null,viewAirBase=null,viewAirId=0;
  // the scene's own floors keep one id across loads, so an unchanged SunBook stays cached
  const viewAirFor=async()=>{if(viewAir)return viewAir;viewAirBase??=(async()=>{if(tops)coarseBuild??=worldCoarseCasters({size,tops});const air=worldViewAirFloors({size,tops,casters:tops?await coarseBuild:null});return Object.freeze({air,id:++viewAirId});})();return viewAirBase;};
  // The atlas's page budget for this device (world/worldViewRing.js): no load
  // allocates past it (renderAtlas.js setPageBudget); past it the farthest
  // requested bricks are dropped (attempt(), worldBudgetDemand).
  const budget=worldPageBudget({deviceMemoryGB:globalThis.navigator?.deviceMemory,limits:gpu.device?.limits??{}});
  atlas.setPageBudget(budget.pool);
  const ownedSources=new Set(),ownedProbes=new Set(),ownedGlow=new Set();
  // The book's light pages a restore wrote, by index: {job, source, gi} (worldLightKeep).
  const lightRestored=new Map();
  const brick=i=>[i%dims[0],Math.floor(i/dims[0])%dims[1],Math.floor(i/(dims[0]*dims[1]))];
  const index=b=>worldBrickIndex(atlas.bookLayout,b);
  const live=()=>{if(dead)throw new Error('WORLD data owner disposed');if(resetting)throw new Error('WORLD reset pending');const error=failure??metadataFeedback.failure??active?.feedback?.failure??gpu.failure??gpu.pipelines?.failure;if(error)throw error;};
  const releaseFrame=r=>r.pins.forEach(p=>p.release());
  function captureFrame(frame) {
    if(!frame||frame.sceneVersion==null||frame.schemaVersion==null||frame.configVersion==null||!(Array.isArray(frame.globalKey)||frame.globalKey instanceof Uint32Array)||!frame.sun)throw new TypeError('explicit frozen frame/settings identities required');
    const pins=[];
    try{for(const pin of frame.pins??[])pins.push(pin.retain());
      return {values:frozen(frame.values),physicsOrigin:frozen(frame.physicsOrigin),params:frozen(frame.params??{}),globalKey:frozen(frame.globalKey),lamps:frozen(frame.lamps??[]),sun:frozen(frame.sun),sceneVersion:frame.sceneVersion,schemaVersion:frame.schemaVersion,configVersion:frame.configVersion,advance:frame.advance!==false,external:{...frame.external},pins};
    }catch(e){pins.forEach(p=>p.release());throw e;}
  }
  // support: asked for by a stage that reads cells only to light a SOURCE or
  // write the sun map (WORLD_SUPPORT_STAGES); any other ask makes it demand.
  // shell: a coarse sun tile's surface forecast, which nothing but the view
  // reads; every other support brick (a full-detail tile's casters, a SOURCE's
  // neighbours) is pinned: the GPU memory budget never drops it.
  // view: the scene's own feedback (extend). A brick the budget dropped stays
  // dropped for the view and the shells (it reads as air there), but a
  // producer's ask (sun, SOURCE, gather: all inside their near rings) takes it
  // back, so no phase waits on a brick the budget will not load.
  function add(t,requirements=[],sun=[],support=false,shell=false,view=false) {
    let changed=false;
    for(const r of requirements){const i=index(r.brick??brick(r.index)),bits=r.channels;if(!Number.isInteger(bits)||bits<1||bits>READY.ALL||r.index!=null&&r.index!==i)throw new TypeError('canonical WORLD requirements required');if(t.dropped.has(i)){if(view||shell)continue;t.dropped.delete(i);}if(support&&!shell)t.pinned.add(i);const old=t.requirements.get(i);if(old===undefined&&support)t.support.add(i);else if(!support)t.support.delete(i);if(((old??0)|bits)!==old){t.requirements.set(i,(old??0)|bits);changed=true;}}
    const projection=worldSunProjection(size,t.frame.sun.direction),n=projection.tiles[2]*projection.tiles[3];
    for(const i of sun){if(!Number.isInteger(i)||i<0||i>=n)throw new RangeError('WORLD Sun tile');if(!t.sunTiles.has(i)){t.sunTiles.add(i);changed=true;}}
    return changed;
  }
  // Destruction is never a substitute for closing a recordable suffix.
  async function fence() {
    while(gpu.frame.open){if(gpu.failure||gpu.pipelines?.failure)throw new Error('WORLD blocked: recordable graphics-error suffix');await new Promise(resolve=>setTimeout(resolve,0));}
    if(gpu.failure||gpu.pipelines?.failure)throw new Error('WORLD blocked: graphics disposition unknown');
    await gpu.device.queue.onSubmittedWorkDone();
  }
  function dropResources(t) {
    if(!t.retired||t.bundlePins||t.cleaned)return;
    t.cleaned=true;t.inputs?.release();t.gi?.dispose();t.glow?.dispose();t.sun?.dispose();t.appearance?.dispose();t.feedbackBuffer?.destroy();t.cut.release();releaseFrame(t.frame);
  }
  // A restart keeps its completed metadata batch and SOURCE slabs for the next attempt to carry.
  async function clearAttempt(t,{keepRecords=false}={}) {
    t.bundle?.release();t.bundle=null;
    t.plan?.abort();t.plan=null;if(!keepRecords){t.batch?.discard();t.batch=null;}
    if(keepRecords)poolSources(t);else{for(const p of t.outputs.splice(0))p.release();for(const e of t.carry.splice(0))e.output.release();}
    for(const p of t.glows.splice(0))p.release();
    t.sunHandle?.release();t.sunHandle=null;
    t.privateSnapshot?.release();t.privateSnapshot=null;
    for(const job of t.privateJobs.splice(0))atlas.cancel(job);
    t.restore?.release();t.restore=null;
  }
  function dependency(t) {
    const p=cells.publication;
    return {version:atlas.generation+1,sets:[{id:p.dependencySetID,version:p.dependencyVersion}]};
  }
  const cellOptions=t=>({fieldTick:t.fieldTick,smoothing:t.frame.params.smoothing??1});
  async function advanceFields(t) {cells.bindCut(t.cut);const cam=t.frame.values?.cam,eye=cam&&Array.from(cam);await worldAdvanceFields(gpu,cells,{...cellOptions(t),eye:eye?.length===3&&eye.every(Number.isFinite)?eye:null});}
  const cellCurrent=i=>worldCellCurrent(atlas,i);
  const captureOf=b=>cells.classificationBuffer(b);
  async function classify(t,ids) {await worldClassify(gpu,cells,atlas,ids,{...cellOptions(t),full:t.full,paced:!!accepted},brick);}
  function captureInput(t,{previous=null,emission=null}={}) {
    const p=cells.acquire();
    return Object.freeze({...p,source:Object.freeze({...p.source,contentToken:t.cut.contentToken}),atlas:p.atlas,previous,emission,initialization:t.plan?.initialization,sourcePhaseToken:t.restore?.publication.sourcePhaseToken,
      previousAtlas:t.privateSnapshot??null,sun:t.sunHandle,feedback:t.feedbackBuffer,
      release(){previous?.release();p.release();}});
  }
  async function result(t,producer,candidate) {
    if(candidate.status==='cached'){const h=candidate.snapshot;return {output:h};}
    if(!candidate.record)throw new Error('WORLD producer lost frozen cut');
    const outcome=await candidate.record(gpu.frame);
    if(outcome.status==='published')return {output:producer.snapshot()};
    if(outcome.feedback)return {feedback:outcome.feedback,partial:outcome.partial??null};
    throw new Error(`WORLD producer ${outcome.status}: ${outcome.error??'unresolved jobs without typed feedback'}`);
  }
  function slabs(entries) {
    const max=Math.max(1,Math.min(giSlabJobs,Math.floor(Math.min(128*1024**2,gpu.device.limits.maxStorageBufferBindingSize??128*1024**2)/32),256*(gpu.device.limits.maxTextureDimension2D??8192)));
    // Whole 32-cell construction cores, NOT a distance/quality tier. A job's
    // result does not depend on its slab's other jobs. Every selected job is
    // still executed, with a global SOURCE phase barrier.
    return worldCoreBatches(entries,max,e=>e.brick??e).flatMap(jobs=>{const out=[];for(let i=0;i<jobs.length;i+=max)out.push(jobs.slice(i,i+max));return out;});
  }
  // Every slab of one GI phase, then their merged typed feedback (null when all
  // published). Stopping at the first slab with feedback found one core's demand
  // per attempt: an Island load restarted 19+ times, ~64 probes a time, from its
  // SOURCE stage (2026-10-22).
  async function giPhase(t,bricks,phase) {
    const feedback=[],ring=phase==='source'?null:giRing(t),ground=ring?await giGroundFor():null;
    for(const slab of slabs(bricks)){
      const r=await result(t,t.gi,await t.gi.prepare({lightingTick:t.tick,reset:t.tick===0,configVersion:t.frame.configVersion,initialization:t.plan.initialization,sourceBricks:phase==='source'?slab:[],gatherBricks:phase==='source'?[]:slab,shadows:t.frame.params.shadows!==false,ring,ground}));
      if(r.feedback){feedback.push(r.feedback);if(r.partial)t.carry.push({output:r.partial,sun:t.sunKinds});continue;}
      t.outputs.push(r.output);if(!feedback.length)t.plan.stage(r.output);
    }
    return feedback.length?mergeWorldFeedback(feedback):null;
  }
  // The GPU memory budget (world/worldViewRing.js worldPageBudget): a demand
  // over it, or one whose new pages the CELL pool has no room left for under
  // its cap (a re-pack holds a brick's old page until the new one publishes),
  // drops its farthest requested bricks past the view's near ring, and lowers
  // the columns' floors of those the atlas does not hold so the view reads
  // them, and everything over them, as air; a held one keeps its last page.
  // Logged: it is the degraded picture instead of a lost GPU device. Pages the
  // atlas already holds for bricks outside this demand count against it.
  // And it is an invariant: the pages classify() packs always fit the pool's
  // budget. The bricks that rule cannot drop (inside the near ring, a held
  // record's, a glow core's) are no bound: a big map's re-pack of what changed
  // needed a second page for each of them while the displayed frame's snapshot
  // held the first, past the cap (Descent, real Chrome 2026-10-22: "cell pool
  // of 1067442 pages past 1048576", a throw every transaction from then on). So
  // when the new pages still do not fit, the oldest snapshots' superseded pages
  // go back to the pool first (renderAtlas.js reclaim), then the farthest new
  // bricks of any kind but a producer's own ask (t.pinned) and the owned light
  // records, each at most once a transaction (t.squeezed): a producer that
  // asks for one again gets it, pinned, on its next attempt.
  // (worldBudgetPass: the pass, in slices)
  const budgetContext={atlas,budget,cellCurrent,brick,ownedSources,ownedProbes,ownedGlow,viewAirFor,setViewAir:air=>{viewAir={air,id:++viewAirId};},reclaim};
  const budgetDemand=(t,ids)=>worldBudgetPass(t,ids,budgetContext);
  // Old bricks out before the demand is built (world/worldResidency.js): every
  // brick a load asks for is a use; past WORLD_RESIDENT_SHARE of the budget, or
  // past what leaves the load's new asks their room, the least recently used
  // go from everywhere a brick is kept (its lighting row, its SOURCE and probe,
  // its CELL and LIGHT pages), unless the camera's frustum or near ring holds
  // it now, or this load or a glow region does. What the frame on screen asked
  // for (its shadow casters and light sources too) goes last, only for the
  // room this load's new asks need. Lumen's surface cache forgets
  // the same way; a forgotten brick the view asks for again is born again.
  // Only at a transaction's first attempt: no records batch or GI tick is
  // pending then, and a retry's demand is the same load's. (A first attempt
  // asks only for the view; the shadow casters and light sources it finds later.
  // Held only by this load, they were forgotten each time and built again, every
  // load: ~145k bricks and ~35 s each on Island with the camera still, 2026-10-23.)
  const residency=createWorldResidency({capacity:budget.pool.cell});
  async function forgetUnused(t){
    let asks=0;
    await worldRunSliced((function*(){for(const i of t.requirements.keys()){residency.touch(i);if(!metadata.has(i))asks++;if(t.full(COST.member))yield;}})());
    const room=metadata.size+asks-budget.cell,count=Math.max(metadata.size-Math.floor(budget.cell*WORLD_RESIDENT_SHARE),room);
    if(count<=0||t.attempts!==1||t.batch||t.plan||metadata.pending||history.pending)return;
    const view=worldResidentView(t.frame.values);if(!view)return;
    const regions=[];
    for(const i of ownedGlow){const c=brick(i).map(n=>Math.floor(n/8));regions.push(worldGlowPlan(size,c).input);}
    const inGlow=b=>regions.some(r=>b.every((n,k)=>n>=r.min[k]&&n<r.min[k]+r.size[k]));
    const held=i=>t.requirements.has(i)||t.pinned.has(i)||ownedGlow.has(i)||inGlow(brick(i)),seen=i=>view(brick(i));
    // The frame on screen's go last: only for the room this load's new asks need.
    const shown=accepted?.requirements,keep=i=>held(i)||!!shown?.has(i);
    const out=await worldRunSliced(residency.forgetSteps({count,held:keep,seen},t.full));
    if(out.length<room)out.push(...await worldRunSliced(residency.forgetSteps({count:room-out.length,held,seen},t.full)));
    // Still short: the rows in view go too, farthest first, never inside the near
    // ring. Looking along the ground (first person) the frustum holds most of the
    // island, so it kept every row, the budget found no room, and the pool-full
    // rule dropped the newest asks, the ground around the player: read as air,
    // black with the grey ground twin under it, following the player (Island,
    // live 2026-10-24). Past the ring the far field draws coarse land behind the
    // volume (world/far.js drawBehind), the virtual-texture pool's rule: farthest out first.
    if(out.length<room){
      const eye=Array.from(t.frame.values.cam),gone=new Set(out),far=[];
      await worldRunSliced(worldFarthestSteps(metadata.keys(),{eye,brick,radius:WORLD_VIEW_NEAR_RADIUS,skip:i=>gone.has(i)||held(i),visit:i=>far.push(i)>=room-out.length},t.full));
      residency.untrack(far);out.push(...far);
    }
    if(!out.length)return;
    metadata.forget(out);history.forget(out);
    for(const i of out){ownedSources.delete(i);ownedProbes.delete(i);}
    for(const [kind,channels] of [['cell',READY.CELL],['light',READY.LIGHT]]){
      const pages=out.filter(i=>atlas.live[kind].has(i)&&!atlas[kind].pending.has(i));
      if(pages.length)atlas.remove(pages.map(brick),channels);
    }
    t.forgotten=(t.forgotten??0)+out.length;
  }
  // SOURCE slabs a restart keeps (gfx/worldGI.js carry): the transaction's cut,
  // field tick, lighting tick, frame and config are a restart's too, so a
  // completed SOURCE job (a published slab's, or an incomplete slab's that read
  // nothing missing) is what a fresh pass would compute while the sun map it
  // read is unchanged: the same tiles, each as sharp or coarse (a tile's
  // texels are the cut's, given its kind: a full-detail pass publishes only
  // once every caster it walks to is resident). Island ran ~78k SOURCE jobs
  // on each of its restarts, the same each time (2026-10-22).
  function poolSources(t) {
    for(const o of t.outputs.splice(0)){if(!o.probes.length&&o.sources.length&&t.sunKinds)t.carry.push({output:o,sun:t.sunKinds});else o.release();}
  }
  const sunAgrees=(was,now)=>{for(const [i,coarse]of was)if(now.get(i)!==coarse)return false;return true;};
  // This attempt's SOURCE phase: the pool's jobs carried, the rest computed.
  async function carrySources(t,sources) {
    const from=t.carry.filter(e=>sunAgrees(e.sun,t.sunKinds)).map(e=>e.output);let rest=sources;
    try{
      if(from.length&&sources.length){
        const {output,carried}=await t.gi.carry({from,sourceBricks:sources,lightingTick:t.tick,configVersion:t.frame.configVersion,initialization:t.plan.initialization,reset:t.tick===0,shadows:t.frame.params.shadows!==false});
        if(output){t.outputs.push(output);t.plan.stage(output);const kept=new Set(carried);rest=sources.filter(b=>!kept.has(index(b)));}
      }
    }finally{for(const e of t.carry.splice(0))e.output.release();}
    t.carriedSources=sources.length-rest.length;t.sourceJobs=(t.sourceJobs??0)+rest.length;
    return rest.length?giPhase(t,rest,'source'):null;
  }
  // A SOURCE job reads its own brick's previous probe (gi.js giSourceFrag), so
  // the SOURCE phase's only GI demand is births of its own bricks: the restart
  // it used to take would rebuild the same records, plan and Sun and add them as
  // births (initialization.probeBricks). Returns those bricks when the feedback
  // holds nothing else; otherwise the attempt restarts.
  function sourceBirths(t,feedback) {
    if(feedback.sun.length||!feedback.requirements.length)return null;
    // (the plan's own selection, by book index: no set of its every SOURCE a pass)
    for(const r of feedback.requirements)if(r.channels!==READY.GI||!t.plan.selectsSource(r.index)||t.plan.selectsProbe(r.index)||ownedProbes.has(r.index))return null;
    return feedback.requirements.map(r=>brick(r.index));
  }
  // Until over() pages fit: the oldest snapshots' superseded pages taken back
  // (renderAtlas.js reclaim), and the pages already retiring (a cancelled
  // private closure's, a released snapshot's) waited for, a few GPU
  // completions at most (a released state's pages retire one completion after it).
  // The accepted frame's snapshot goes last: it is the one on screen, which the live
  // view draws again every frame (wire/worldRenderFrame.js recordLive), and an expired
  // one can't be drawn, so the camera waits for the next transaction again.
  async function reclaim(kind,over) {
    const shown=accepted?.bundle.snapshot;
    if(shown)for(let k=0;k<WORLD_RECLAIM_ROUNDS&&over()>0;k++)if(!await atlas.reclaim(kind,over(),shown))break;
    for(let k=0;k<WORLD_RECLAIM_ROUNDS&&over()>0;k++)await atlas.reclaim(kind,over());
  }
  // Room for count more pages of a pool, its oldest snapshots' superseded pages
  // reclaimed first when a growth would pass its budget (budgetDemand's rule).
  async function capacity(kind,count) {
    const key=kind==='cell'?'capacity':kind+'Capacity',pool=atlas[kind],over=atlas.poolUsed(kind)+count-budget.pool[kind];
    if(over>0&&kind!=='probe')await reclaim(kind,()=>atlas.poolUsed(kind)+count-budget.pool[kind]);
    while(pool.free.length+atlas.resources.layout[key]-pool.nextID<count)atlas.growPool(kind);
  }
  // (its per-page loops in slices, worldSlices.js: a restore covers every owned SOURCE)
  // kept (public only): the pages worldLightKeep kept, not restored again.
  async function restoreJobs(t,bundle,{privatePhase=false,kept=null}={}) {
    const byIndex=new Map(),full=t.full??worldSliceMeter();let probesHeld=0;
    for(const lease of bundle.leases){if(kept?.has(lease.index)){if(full(COST.member))await pause();continue;}if(!byIndex.has(lease.index))byIndex.set(lease.index,{});byIndex.get(lease.index)[lease.kind]=lease;if(lease.kind==='gi')probesHeld++;if(full(COST.member))await pause();}
    const jobs=[];
    await capacity('light',byIndex.size);await capacity('probe',probesHeld);
    try{
      for(const [i,leases]of byIndex){const s=leases.source,gi=leases.gi;const job=atlas.allocateLight(brick(i),{publication:bundle.publication,sourceRevision:t.cut.contentToken.sourceRevision,sourceTick:s?.token.lightingTick??0,giTick:gi?.token.lightingTick??0,readyBits:(s?READY.GI_SOURCE:0)|(gi?READY.GI:0),dependencies:{source:s&&dep(s.token),gi:gi&&dep(gi.token)}});jobs.push(job);if(full(COST.lease))await pause();}
      // Allocate the WHOLE closure first: growth changes pool/generation.
      const pairs=[];for(const job of jobs){for(const lease of Object.values(byIndex.get(index(job.brick))))pairs.push({job,lease});if(full(COST.member))await pause();}
      await transport.restore(gpu,atlas,pairs);
      if(privatePhase){t.privateJobs=jobs;t.privateSnapshot=atlas.prepareProducerSnapshot({lightJobs:jobs,sourcePhaseToken:bundle.publication.sourcePhaseToken,dependencyToken:dependency(t)});}
      else{atlas.publish({lightJobs:jobs,dependencyToken:dependency(t)});
        // what this attempt's public restore made resident, for publishFinal (worldRestoreResident)
        // and the next attempt's (worldLightKeep): the kept pages too
        t.resident=new Map(kept??[]);for(const job of jobs){const i=index(job.brick),l=byIndex.get(i),r={job,source:l.source?.token??null,gi:l.gi?.token??null};t.resident.set(i,r);lightRestored.set(i,r);}}
    }catch(e){for(const j of jobs)try{atlas.cancel(j);}catch{}throw e;}
  }
  // Before the CELL stage: ask for the casters of every sun tile in the demand
  // whose casters this grid has not forecast yet, and on a transaction's first
  // attempt for the tiles of the eye probe and of the whole view. A tile's
  // casters were found by its own blind sun pass, one restart per wave of tiles
  // (and through the ground to the floor); forecast, that pass finds them
  // resident. Only adds requests: the feedback still closes whatever the ground
  // twin missed. Casters are support, never SOURCES (worldSourceEligible).
  async function forecast(t) {
    if(!tops)return;
    const projection=worldSunProjection(size,t.frame.sun.direction),grid=projection.tiles.join(',');
    if(grid!==forecastGrid){forecastGrid=grid;forecastTiles.clear();shellTiles.clear();}
    if(!t.forecastEye){t.forecastEye=true;add(t,[],forecastViewTiles(projection,{cam:t.frame.values?.cam,rays:worldViewRays(t.frame.values,size),size,tops}));}
    // the SOURCES each new probe's gather asks for (inside the near ring), and the sun tiles they light in
    const probes=[...t.requirements].filter(([i,bits])=>bits&READY.GI&&!t.forecastProbes.has(i)).map(([i])=>i);
    if(probes.length){
      t.stage='forecast';
      const read=new Set();
      await forecastGatherSources({size,tops,probes:probes.map(brick),mark:i=>read.add(i),ring:giRing(t)});
      probes.forEach(i=>t.forecastProbes.add(i));
      add(t,[...read].filter(i=>!ownedSources.has(i)).map(i=>({brick:brick(i),channels:READY.GI_SOURCE})));
      add(t,[],forecastSourceTiles(projection,{size,tops,bricks:read}));
    }
    // Rings (world/worldSunRings.js): full-detail casters only for the tiles near
    // the eye, the ones already sharp, and on a load that follows a shown frame
    // WORLD_SUN_SHARPEN_TILES more inside the sharpen ring; every other tile is
    // drawn coarse from the ground twin, so no tile the view reads goes unlit
    // by a missing caster and none waits for one.
    coarseBuild??=worldCoarseCasters({size,tops});coarseBuild.catch(()=>{});
    const rings=worldSunRings(projection,t.frame.values?.cam,[...t.sunTiles],{sharp:forecastTiles,coarse:true,sharpen:accepted&&!t.sharpened?WORLD_SUN_SHARPEN_TILES:0});
    if(rings.sharpened.length)t.sharpened=true;
    t.coarseTiles=new Set(rings.coarse);
    // A coarse tile's surface only (FORECAST_SHELL_BRICKS), which the eye sees.
    for(const [list,shell,done] of [[rings.coarse.filter(i=>!shellTiles.has(i)),true,shellTiles],[rings.fine.filter(i=>!forecastTiles.has(i)),false,forecastTiles]]){
      if(!list.length)continue;
      t.stage='forecast';
      const bricks=new Set();
      await forecastSunCasters({size,direction:t.frame.sun.direction,tiles:list,tops,shell,mark:i=>bricks.add(i)});
      for(const i of list)done.add(i);
      t.forecastBricks=(t.forecastBricks??0)+bricks.size;
      add(t,[...bricks].map(i=>({brick:brick(i),channels:READY.CELL})),[],true,shell);
    }
  }
  async function attempt(t) {
    t.attempts=(t.attempts??0)+1;t.stage='cell';t.resident=null;
    // one slice meter over the attempt's steps (worldSlices.js): a slice ends at most every WORLD_SLICE_UNITS
    t.full=worldSliceMeter();
    await clearAttempt(t,{keepRecords:true});
    await forecast(t);t.stage='cell';
    await forgetUnused(t);
    const ids=await worldRunSliced(worldDemandIdSteps([metadata.keys(),ownedSources,ownedProbes,t.requirements.keys()],t.full));
    for(const i of ownedGlow)t.requirements.set(i,(t.requirements.get(i)??0)|READY.GLOW);
    const glowCores=new Map(),glowBricks=[];
    for(const [i,bits]of t.requirements)if(bits&READY.GLOW){const core=brick(i).map(n=>Math.floor(n/8));glowCores.set(core.join(','),core);}
    for(const core of glowCores.values()){const region=worldGlowPlan(size,core).input;for(let z=0;z<region.size[2];z++)for(let y=0;y<region.size[1];y++)for(let x=0;x<region.size[0];x++){const i=index([x+region.min[0],y+region.min[1],z+region.min[2]]);ids.add(i);glowBricks.push(i);}}
    if(!ids.size)throw new Error('WORLD requires explicit initial CELL demand');
    await advanceFields(t);
    await budgetDemand(t,ids);
    await classify(t,ids);
    t.stage='metadata';
    // Only the bricks the last attempt's records lack: the cut, clock and
    // baseline are the transaction's, so its rows would read back the same.
    // And of the committed rows only the stale ones (worldLightingRecords
    // stale: the rest read back what they hold).
    const carried=t.batch&&metadata.carryable(t.batch,{cut:t.cut,derivedTick:t.tick});
    if(!carried){t.batch?.discard();t.batch=null;}
    const fresh=worldMetadataFresh(metadata,ids,{cut:t.cut,captureOf,carry:carried?t.batch:null,carried,extra:[t.requirements.keys(),glowBricks]});
    t.metadataBricks=fresh.length;
    if(fresh.length||!t.batch){
      // (a transaction holds a batch even with nothing stale: its commit moves
      // the clock; one row read again reads back what it holds)
      const classification=cells.acquireClassification({bricks:(fresh.length?fresh:[ids.values().next().value]).map(brick)});
      try{t.batch=metadata.record(gpu.frame,{cut:t.cut,classification,derivedTick:t.tick,carry:carried?t.batch:null,captureOf});}catch(e){classification.release();throw e;}
      await t.batch.completion;
    }
    t.stage='history';
    // What this load's gathers read at full detail: the eye's ring and every probe's (no ring: everything)
    const ring=giRing(t),reach=ring&&worldGIReach(ring.eye,[...new Set([...ownedProbes,...[...t.requirements].filter(([,bits])=>bits&READY.GI).map(([i])=>i)])].map(brick),ring.radius);
    const reached=reach?i=>reach(brick(i)):null;
    // Reflective SOURCE self-reads discover GI demand through typed feedback.
    // Matter (including liquids), SOURCE and CELL alone do not imply a probe.
    const {records,never,requestedSources}=await worldRunSliced(worldGIRecordSteps(t.batch,{size,requirements:t.requirements,support:t.support,ownedSources,ownedProbes,reached},t.full));
    if(t.frame.advance)t.plan=await history.beginSliced({lightingTick:t.tick,globalKey:t.frame.globalKey,records,currentLamps:t.frame.lamps,mode:t.tick===0?2:0,initialization:{cutToken:t.cut.contentToken,sourceBricks:requestedSources,probeBricks:never.map(r=>r.brick),records}},{full:t.full});
    else t.plan=await history.beginBirthSliced({cutToken:t.cut.contentToken,sourceBricks:[...new Map([...requestedSources,...never.filter(r=>!ownedSources.has(index(r.brick))).map(r=>r.brick)].map(b=>[index(b),b])).values()],probeBricks:never.map(r=>r.brick),records},{full:t.full});
    // Every owned offscreen record remains a causal input. BUILDING is never
    // returned by probe(); the previous accepted bundle remains independently pinned.
    // The book's light pages cleared but those an earlier restore wrote as this one
    // would (worldLightKeep), and only the rest restored.
    const previousProbes=[...ownedProbes].filter(i=>t.frame.advance||history.birth(i)?.birthTick<t.tick);
    const previous=await t.plan.captureRestoreSliced({cut:t.cut,configVersion:t.frame.configVersion,sourceIndices:ownedSources,probeIndices:previousProbes},{full:t.full});
    try{
      if(!keepResident)lightRestored.clear();
      const {kept,invalidations}=await worldRunSliced(worldLightKeepSteps(atlas.live.light,previous.leases,{restored:lightRestored,sourceRevision:t.cut.contentToken.sourceRevision},t.full));
      atlas.publish({invalidations,sunManifest:null});
      t.lightKept=(t.lightKept??0)+kept.size;
      if(previous.leases.length)await restoreJobs(t,previous,{kept});
    }finally{previous.release();}
    t.stage='sun';
    // A tile the feedback added after this attempt's forecast (none is, with
    // the view's tiles forecast) is full detail, its casters asked for by its pass.
    const coarseTiles=[...(t.coarseTiles??[])].filter(i=>t.sunTiles.has(i)),coarseCasters=coarseTiles.length?await coarseBuild:null;
    const air=await viewAirFor();
    const sun=await result(t,t.sun,await t.sun.prepare({direction:t.frame.sun.direction,basisRevision:t.frame.sun.basisRevision,configVersion:t.frame.configVersion,sceneToken:t.frame.sceneVersion,receiverBounds:[],requestedTiles:[...t.sunTiles],coarseTiles,coarseCasters,viewAir:{words:worldViewAirWords(air.air),id:air.id},changedWorldBounds:t.batch.changes.changedBricks.map(b=>({min:b.map(n=>n*4),max:b.map(n=>n*4+4)}))}));
    if(sun.feedback)return sun.feedback;t.sunHandle=sun.output;
    // the tiles this sun map drew, each coarse or not: what a carried SOURCE was lit under
    {const coarse=new Set(coarseTiles);t.sunKinds=new Map([...t.sunTiles].map(i=>[i,coarse.has(i)]));}
    const sources=t.plan.sourceBricks;
    // GLOBAL barrier: all SOURCE slabs are submitted and staged before ANY gather.
    t.stage='source';
    for(;;){
      const feedback=await carrySources(t,sources);
      if(!feedback)break;
      const births=sourceBirths(t,feedback);
      if(!births)return feedback;
      // In place: the same plan, expanded by exactly the births a restart adds;
      // its completed SOURCE jobs carry into the next pass (a birth's own did not complete).
      add(t,feedback.requirements);
      poolSources(t);
      t.plan.expand({probeBricks:births});
      t.sourcePasses=(t.sourcePasses??0)+1;
    }
    t.full=worldSliceMeter();
    const restoreSources=await worldRunSliced(worldDemandIdSteps([ownedSources,(function*(){for(const b of sources)yield index(b);})()],t.full));
    t.restore=await t.plan.captureRestoreSliced({cut:t.cut,configVersion:t.frame.configVersion,sourceIndices:[...restoreSources],probeIndices:previousProbes,sourcePhase:true},{full:t.full});
    t.stage='restore';
    if(t.restore.leases.length)await restoreJobs(t,t.restore,{privatePhase:true});
    const gathers=t.plan.gatherBricks;
    t.stage='gather';
    {const feedback=await giPhase(t,gathers,'gather');if(feedback)return feedback;}
    t.privateSnapshot?.release();t.privateSnapshot=null;for(const job of t.privateJobs.splice(0))atlas.cancel(job);t.restore?.release();t.restore=null;
    t.stage='glow';
    for(const core of glowCores.values()){const r=await result(t,t.glow,await t.glow.prepare({core,lightingTick:t.tick,configVersion:t.frame.configVersion}));if(r.feedback)return r.feedback;t.glows.push(r.output);}
    t.stage='publish';await publishFinal(t);
    return null;
  }
  async function publishFinal(t) {
    const full=t.full=worldSliceMeter(),sourceOutputs=new Map(),probeOutputs=new Map();
    await worldRunSliced((function*(){for(const out of t.outputs){for(const i of out.sources){sourceOutputs.set(i,out);if(full(COST.member))yield;}for(const i of out.probes){probeOutputs.set(i,out);if(full(COST.member))yield;}}})());
    const sourceIndices=await worldRunSliced(worldExceptSteps(ownedSources,sourceOutputs,full)),probeIndices=await worldRunSliced(worldExceptSteps(ownedProbes,probeOutputs,full));
    const restore=history.captureRestore({cut:t.cut,configVersion:t.frame.configVersion,sourceIndices,probeIndices});
    const glowOf=b=>t.glows.find(o=>b.every((n,k)=>n>=o.plan.output.min[k]&&n<o.plan.output.max[k]));
    const leases=new Map();for(const l of restore.leases){if(!leases.has(l.index))leases.set(l.index,{});leases.get(l.index)[l.kind]=l;}
    const glows=[],jobs=[];for(const [i,bits]of t.requirements)if(bits&READY.GLOW)glows.push(i);
    const all=await worldRunSliced(worldDemandIdSteps([ownedSources,ownedProbes,sourceOutputs.keys(),probeOutputs.keys(),glows],full));
    const ids=await worldRunSliced(worldRestoreResidentSteps(all,{resident:keepResident?t.resident:null,live:atlas.live.light,leases,fresh:i=>sourceOutputs.has(i)||probeOutputs.has(i)||!!glowOf(brick(i))},full));
    t.residentKept=all.size-ids.size;
    await capacity('light',ids.size);await capacity('probe',ids.size);
    try{
      for(const i of ids){const held=leases.get(i)??{},s=sourceOutputs.get(i),gi=probeOutputs.get(i),b=brick(i),glow=glowOf(b);
        const st=s?.token??held.source?.token,gt=gi?.token??held.gi?.token,lt=glow?.token;
        const job=atlas.allocateLight(b,{publication:restore.publication,sourceRevision:t.cut.contentToken.sourceRevision,sourceTick:st?.lightingTick??0,giTick:gt?.lightingTick??0,glowTick:lt?.lightingTick??0,readyBits:(st?READY.GI_SOURCE:0)|(gt?READY.GI:0)|(lt?READY.GLOW:0),dependencies:{source:st&&dep(st),gi:gt&&dep(gt),glow:lt&&dep(lt)}});jobs.push(job);
        if(full(COST.lease))await pause();
      }
      const pairs=[];for(const job of jobs){for(const lease of Object.values(leases.get(index(job.brick))??{}))pairs.push({job,lease});if(full(COST.member))await pause();}
      await transport.restore(gpu,atlas,pairs);
      // One submission and one wait for every page: a wait per page was ~0.3 ms
      // each, 20-28 s for an Island load's ~78k SOURCES (2026-10-22).
      const writes=[];
      for(const job of jobs){const i=index(job.brick),s=sourceOutputs.get(i),gi=probeOutputs.get(i),b=brick(i),glow=glowOf(b);if(s)writes.push(s.atlasWrite(job,'source'));if(gi)writes.push(gi.atlasWrite(job,'gi'));if(glow)writes.push(glow.atlasWrite(job));if(full(COST.record))await pause();}
      await transport.writeAll(atlas,writes);
      const s=t.sunHandle.bindings(),token=t.sunHandle.token;
      atlas.publish({lightJobs:jobs,dependencyToken:dependency(t),sunManifest:{...token,...s,dependencySetID:cells.publication.dependencySetID,dependencyVersion:cells.publication.dependencyVersion}});
      const snapshot=atlas.snapshot();
      // a page wholly restored from held outputs is one a later restore can keep (worldLightKeep)
      for(const job of jobs){const i=index(job.brick),held=leases.get(i)??{};
        if(sourceOutputs.has(i)||probeOutputs.has(i)||glowOf(job.brick))lightRestored.delete(i);
        else lightRestored.set(i,{job,source:held.source?.token??null,gi:held.gi?.token??null});}
      // This is PROBE-READY, not scene-admitted: unknown scene dependencies
      // must still be checked by every real native consumer and staged Post.
      let refs=1;const sunPin=t.sun.snapshot();t.bundlePins++;
      const held={snapshot,lighting:s,sunTextures:sunPin.textures(),appearance:t.appearance,tables:t.cut.tables,frame:t.viewFrame,cut:t.cut.identity,lightingTick:t.tick,logicalFieldTick:t.fieldTick,identity:Object.freeze({epoch:source.epoch,sceneToken:t.frame.sceneVersion,configVersion:t.frame.configVersion,transaction:t.id}),
        retain(){if(!refs)throw new Error('released WORLD candidate');refs++;let released=false;return Object.freeze({...held,release(){if(!released){released=true;held.release();}}});},
        release(){if(refs&&!--refs){snapshot.release();sunPin.release();t.bundlePins--;dropResources(t);}}};
      t.bundle=Object.freeze(held);
    }catch(e){for(const j of jobs)try{atlas.cancel(j);}catch{}throw e;}finally{restore.release();}
  }
  async function run(t) {
    try{
      await Promise.all([cells.ready,metadata.ready]);
      const inputOptions={atlas,tables:t.cut.tables?.buffer??tableBuffer,frameValues:t.frame.values,physicsOrigin:t.frame.physicsOrigin,params:t.frame.params,external:t.frame.external};
      const words=t.cut.source.context.scene.appearanceWords;
      t.appearance=words?createWorldAppearance(gpu,{words}):null;
      const {pins,...captured}=t.frame;
      t.viewFrame=Object.freeze({...captured,values:frozen({...captured.values,...(t.appearance?{sourceAppearance:t.appearance.uniform}:{})}),external:Object.freeze({...captured.external,...(t.appearance?{sourceAppearance:t.appearance.view}:{})})});
      const grid={...g,sourceAppearance:!!t.appearance,sourceGrid:t.appearance?.sourceGrid};
      t.inputs=createWorldLightingInputs(gpu,{...inputOptions,appearance:t.appearance});
      const projection=worldSunProjection(size,t.frame.sun.direction);
      t.feedback=observedFeedback(gpu,{book:atlas.bookLayout,sunTileCount:projection.tiles[2]*projection.tiles[3]},wake);
      t.feedbackBuffer=gpu.device.createBuffer({label:'WORLD producer placeholder feedback',size:Math.max(16,atlas.feedbackBytes,t.feedback.layout().wordCount*4),usage:128|8});
      const provider={acquire:({probeIndices=[]}={})=>captureInput(t,{previous:t.plan.capturePrevious({indices:probeIndices})}),isCurrent:p=>cells.isCurrent(p)&&t.cut.isValid()};
      t.gi=createWorldGI(gpu,{g:grid,snapshotProvider:provider,readerBindingProvider:p=>t.inputs.reader(p),feedbackProvider:t.feedback});
      t.sun=createWorldSunLighting(gpu,{g:grid,sourceFieldSnapshotProvider:cells,readerBindingProvider:p=>t.inputs.sun(p),feedbackProvider:t.feedback});
      const emission={acquire({plan}){const bricks=[];for(let z=0;z<plan.input.size[2];z++)for(let y=0;y<plan.input.size[1];y++)for(let x=0;x<plan.input.size[0];x++)bricks.push([x+plan.input.min[0],y+plan.input.min[1],z+plan.input.min[2]]);const c=cells.acquireClassification({bricks});try{const e=c.recordEmission(gpu.frame,plan.input),p=captureInput(t);return Object.freeze({...p,emission:e,release(){p.release();c.release();}});}catch(e){c.release();throw e;}},isCurrent:provider.isCurrent};
      t.glow=createWorldGlow(gpu,{g:grid,emissionProvider:emission,submissionProvider:t.feedback});
      while(active===t&&!dead){
        let feedback;
        try{feedback=await attempt(t);}catch(e){if(e.requirements){feedback={requirements:e.requirements,sun:[],incomplete:true};}else throw e;}
        if(!feedback){t.state='probe-ready';wake();return t.bundle.retain();}
        if(!add(t,feedback.requirements,feedback.sun,WORLD_SUPPORT_STAGES.has(t.stage))&&(t.idleAttempts=(t.idleAttempts??0)+1)>WORLD_IDLE_EXTENDS)throw new Error('WORLD unresolved feedback made no dependency progress');
      }
      return null;
    }catch(error){rejected(t,error);throw error;}
  }
  function rejected(t,error) {
    t.error=error;
    if(gpu.failure||gpu.pipelines?.failure||gpu.frame.open||t.feedback?.failure){failure=error;t.state='blocked';}
    else t.state='rejected';
    wake();
  }
  function start(frame,requirements) {
    if(source.epoch!==atlas.epoch||history&&(source.cutConfiguration?.sceneVersion!==frame.sceneVersion||source.cutConfiguration?.configVersion!==frame.schemaVersion))throw new Error('reset WORLD owner before changing scene/epoch/schema');
    if(accepted&&(accepted.cut.identity.epoch!==source.epoch||frame.schemaVersion!==accepted.frame.schemaVersion||frame.sceneVersion!==accepted.frame.sceneVersion))throw new Error('reset WORLD owner before changing scene/epoch/schema');
    const same=!frame.advance;
    if(same&&(!accepted||JSON.stringify(frame.globalKey)!==JSON.stringify(accepted.frame.globalKey)||frame.configVersion!==accepted.frame.configVersion))throw new Error('camera-only births require the accepted lighting settings/cut');
    const cut=same?accepted.cut.retain():source.recordCut(gpu.frame,{previousCut:accepted?.cut,sceneVersion:frame.sceneVersion,configVersion:frame.schemaVersion});
    if(!history)history=createWorldLightingHistory({worldSize:size,epoch:source.epoch,sourceOwner:source,configuration:cut.configuration});
    const t={id:++serial,frame,cut,tick:same?history.lightingTick:history.lightingTick+1,fieldTick:same?accepted.fieldTick:(cells.fields.lastTick??-1)+1,state:'building',stage:'initializing',requirements:new Map(),support:new Set(),dropped:new Set(),squeezed:new Set(),pinned:new Set(),forecastProbes:new Set(),sunTiles:new Set(),outputs:[],carry:[],glows:[],privateJobs:[],bundle:null,bundlePins:0,retired:false,cleaned:false};
    try{add(t,requirements);}catch(e){cut.release();throw e;}
    viewAir=null;   // a transaction's budget drops are its own: the next starts from the scene's floors
    active=t;t.work=run(t);t.work.catch(()=>{});return t.work;
  }
  async function retire(t) {
    await fence();await clearAttempt(t);t.retired=true;dropResources(t);
  }
  function next() {if(queued&&!dead){const q=queued;queued=null;try{start(q.frame,q.requirements).then(q.resolve,q.reject);}catch(e){releaseFrame(q.frame);q.reject(e);}}wake();}
  const api={atlas,cells,metadata,
    // Passive counters only: inspecting readiness must never advance work.
    get progress(){const t=active;return t?Object.freeze({stage:t.state==='probe-ready'?t.state:t.stage,attempts:t.attempts??0,requirements:t.requirements.size,support:t.support.size,sunTiles:t.sunTiles.size,coarseTiles:t.coarseTiles?.size??0,budgetDropped:t.budgetDropped??0,pageBudget:budget.cell,forecastBricks:t.forecastBricks??0,sourcePasses:t.sourcePasses??0,sourceJobs:t.sourceJobs??0,carriedSources:t.carriedSources??0,metadataBricks:t.metadataBricks??0,residentKept:t.residentKept??0,lightKept:t.lightKept??0,forgotten:t.forgotten??0,sources:t.plan?.sourceBricks.length??0,gathers:t.plan?.gatherBricks.length??0,outputs:t.outputs.length,fieldOwners:cells.fields.history.owners.size,cellPages:atlas.cell.pages.size}):null;},
    get busy(){return !!active||!!queued;},get failure(){return failure??metadataFeedback.failure??active?.feedback?.failure??active?.error??null;},get state(){return dead?'disposed':resetting?'resetting':metadataFeedback.failure||active?.feedback?.failure?'blocked':active?.state??'idle';},
    request(frame,requirements=[]){live();const f=captureFrame(frame);if(active){if(queued){releaseFrame(queued.frame);queued.resolve(null);}return new Promise((resolve,reject)=>{queued={frame:f,requirements:frozen(requirements),resolve,reject};});}try{return start(f,requirements);}catch(e){releaseFrame(f);throw e;}},
    probe(){live();return active?.state==='probe-ready'?active.bundle.retain():null;},
    current(){live();return accepted?.bundle.retain()??null;},
    // A frame whose only misses are bricks the GPU page budget dropped (they read
    // as air in the view) is as complete as the budget allows: settled, it is
    // accepted instead of extend() refusing it for making no progress (Descent,
    // real Chrome 2026-10-22: "WORLD scene feedback made no dependency progress"
    // every frame once over budget). Any other miss, or a new Sun tile, stays.
    settle(feedback){const t=active;return t?worldSettleFeedback(feedback,{dropped:t.dropped,sunTiles:t.sunTiles,index:r=>index(r.brick??brick(r.index)),requirements:t.requirements,idle:(t.idleExtends??0)>=WORLD_IDLE_EXTENDS}):feedback;},
    async extend(candidate,feedback){live();const t=active;if(!t||t.state!=='probe-ready'||candidate.identity!==t.bundle.identity)throw new Error('foreign/out-of-order WORLD feedback');if(complete(feedback))return t.bundle.retain();if(!add(t,feedback.requirements,feedback.sun,false,false,true)){if((t.idleExtends??0)>=WORLD_IDLE_EXTENDS)throw new Error('WORLD scene feedback made no dependency progress');t.idleExtends=(t.idleExtends??0)+1;}t.state='building';t.work=runRetry(t);t.work.catch(()=>{});return t.work;},
    async accept(candidate,{feedback,feedbackIdentity,postTicket}={}){live();const t=active;if(!t||t.state!=='probe-ready'||candidate.identity!==t.bundle.identity||!complete(feedback)||!postTicket?.confirmation||postTicket.publication?.identity!==candidate.identity||feedbackIdentity==null||postTicket.feedbackIdentity!==feedbackIdentity||['epoch','sceneToken','configVersion'].some(k=>postTicket.identity?.[k]!==candidate.identity[k]))throw new Error('exact complete scene/native feedback and final Post ticket required');t.state='accepting';const confirmed=await postTicket.confirmation;if(active!==t||dead)return false;if(confirmed!==true||postTicket.status!=='committed'){t.state='probe-ready';wake();return false;}if(candidate.identity!==t.bundle.identity)throw new Error('WORLD publication changed during final Post');
      // In slices (worldSlices.js): a reset or disposal between two (the only
      // calls an accepting transaction admits) stops it, and clears what it adopted.
      const current=()=>active===t&&!dead;
      t.plan.seal({cutToken:t.cut.contentToken,feedback});if(!await t.plan.commitSliced({live:current}))return false;t.plan=null;metadataChanges(t);
      const full=worldSliceMeter();
      for(const out of t.outputs){for(const [list,owned] of [[out.sources,ownedSources],[out.probes,ownedProbes]])for(const i of list){owned.add(i);if(full(COST.member)){await pause();if(!current())return false;}}}
      for(const [i,bits]of t.requirements)if(bits&READY.GLOW)ownedGlow.add(i);
      const old=accepted;accepted={bundle:t.bundle.retain(),cut:t.cut.retain(),frame:t.frame,fieldTick:t.fieldTick,requirements:t.requirements};await retire(t);active=null;if(old){old.bundle.release();old.cut.release();}next();return true;},
    async retry(){live();const t=active;if(!t||t.state!=='rejected')throw new Error('only definitively rejected WORLD work can retry');t.state='retrying';try{await fence();}catch(e){rejected(t,e);throw e;}if(active!==t||dead)return null;t.error=null;t.state='building';t.work=runRetry(t);t.work.catch(()=>{});return t.work;},
    async discard(candidate=null){live();const t=active;if(t?.state==='accepting')throw new Error('wait for final Post confirmation before discarding WORLD');if(!t||!['probe-ready','rejected'].includes(t.state)||(t.bundle?candidate?.identity!==t.bundle.identity:t.state!=='rejected'))throw new Error('foreign WORLD discard');t.state='retiring';await retire(t);if(active!==t||dead)return;active=null;next();},
    reset({sceneVersion=active?.frame.sceneVersion??accepted?.frame.sceneVersion,schemaVersion=active?.frame.schemaVersion??accepted?.frame.schemaVersion}={}){
      live();if(source.epoch!==atlas.epoch+1||sceneVersion==null||schemaVersion==null)throw new Error('WORLD reset requires next authoritative Source epoch and explicit scene/schema identity');
      resetting=true;
      resetWork=(async()=>{
        if(queued){releaseFrame(queued.frame);queued.resolve(null);queued=null;}
        const t=active;active=null;if(t){await t.work.catch(()=>{});await retire(t);}await fence();
        accepted?.bundle.release();accepted?.cut.release();accepted=null;history?.dispose();history=null;metadata.reset();residency.clear();lightRestored.clear();ownedSources.clear();ownedProbes.clear();ownedGlow.clear();forecastTiles.clear();shellTiles.clear();forecastGrid=null;viewAir=null;
        const cut=source.recordCut(gpu.frame,{sceneVersion,configVersion:schemaVersion});
        try{gpu.flush('WORLD reset cut capture');await fence();cells.bindCut(cut);cells.reset();}finally{cut.release();}
        failure=null;wake();
      })().catch(error=>{failure=error;throw error;}).finally(()=>{resetting=false;resetWork=null;});
      return resetWork;
    },
    async dispose(){if(dead)return;dead=true;if(resetWork)await resetWork;if(queued){releaseFrame(queued.frame);queued.resolve(null);queued=null;}const t=active;active=null;if(t){await t.work.catch(()=>{});await retire(t);}await fence();accepted?.bundle.release();accepted?.cut.release();accepted=null;history?.dispose();metadata.dispose();cells.dispose();atlas.dispose();if(win.render===api)delete win.render;}
  };
  function metadataChanges(t){const changes=t.batch.commit();t.batch=null;history.noteChanged(changes.changedBricks,changes.derivedTick);}
  async function runRetry(t){try{while(active===t&&!dead){let feedback;try{feedback=await attempt(t);}catch(e){if(!e.requirements)throw e;feedback={requirements:e.requirements,sun:[]};}if(!feedback){t.state='probe-ready';wake();return t.bundle.retain();}if(!add(t,feedback.requirements,feedback.sun,WORLD_SUPPORT_STAGES.has(t.stage))&&(t.idleAttempts=(t.idleAttempts??0)+1)>WORLD_IDLE_EXTENDS)throw new Error('WORLD unresolved feedback made no dependency progress');}return null;}catch(e){rejected(t,e);throw e;}}
  win.render=Object.freeze(api);return win.render;
}
