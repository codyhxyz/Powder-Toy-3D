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
import { worldColumnTops, forecastSunCasters, forecastEyeTiles } from '../world/worldSunForecast.js';

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
export const WORLD_CLASSIFY_BRICKS=2048;
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
export function installWorldRender(win, {gpu=win.gpu,source=win.renderSource,producer=win.sourceProducer,tables=win.sim.tables,tableBuffer=gpu._simTables?.buffer,wake=()=>{},giSlabJobs=WORLD_GI_SLAB_JOBS}={}) {
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
  const tops=worldColumnTops({size,scene:win.scene,P:win.P}), forecastTiles=new Set();let forecastGrid=null;
  const ownedSources=new Set(),ownedProbes=new Set(),ownedGlow=new Set();
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
  function add(t,requirements=[],sun=[]) {
    let changed=false;
    for(const r of requirements){const i=index(r.brick??brick(r.index)),bits=r.channels;if(!Number.isInteger(bits)||bits<1||bits>READY.ALL||r.index!=null&&r.index!==i)throw new TypeError('canonical WORLD requirements required');const old=t.requirements.get(i)??0;if((old|bits)!==old){t.requirements.set(i,old|bits);changed=true;}}
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
  // A restart keeps its completed metadata batch for the next attempt to carry.
  async function clearAttempt(t,{keepRecords=false}={}) {
    t.bundle?.release();t.bundle=null;
    t.plan?.abort();t.plan=null;if(!keepRecords){t.batch?.discard();t.batch=null;}
    for(const p of t.outputs.splice(0))p.release();
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
  async function classify(t,ids) {
    cells.bindCut(t.cut);
    // A restart (the Sun's casters or an eye miss widened the demand) packed
    // again every page it had just published: Island's sixth attempt of one
    // load packed 134k pages, 35k of them unchanged (2026-10-21). A page of
    // this cut's source revision and field tick is what a new pack would write.
    const sourceRevision=t.cut.contentToken.sourceRevision;
    const stale=[...ids].map(brick).filter(b=>{const l=atlas.lookup(b,READY.CELL);return !(l.known&&l.sourceRevision===sourceRevision&&l.fieldTick===t.fieldTick);});
    // One pool growth for the whole demand: a growth copies every public page.
    atlas.reserve('cell',stale.length);
    const batches=worldClassifyBatches(stale);
    for(const [k,requirements] of batches.entries()){
      if(k)await new Promise(resolve=>setTimeout(resolve,0));
      // record() uses actual sourceDemand and cut.producer on the normal Frame.
      const h=cells.record(gpu.frame,{fieldTick:t.fieldTick,requirements,smoothing:t.frame.params.smoothing??1});
      gpu.flush('WORLD Source/Fields final capture');
      const publication=cells.commitAfterSourceFlush(h);
      publication.previousLightingSnapshot.release();
    }
  }
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
    if(outcome.feedback)return {feedback:outcome.feedback};
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
    const feedback=[];
    for(const slab of slabs(bricks)){
      const r=await result(t,t.gi,await t.gi.prepare({lightingTick:t.tick,reset:t.tick===0,configVersion:t.frame.configVersion,initialization:t.plan.initialization,sourceBricks:phase==='source'?slab:[],gatherBricks:phase==='source'?[]:slab,shadows:t.frame.params.shadows!==false}));
      if(r.feedback){feedback.push(r.feedback);continue;}
      t.outputs.push(r.output);if(!feedback.length)t.plan.stage(r.output);
    }
    return feedback.length?mergeWorldFeedback(feedback):null;
  }
  // A SOURCE job reads its own brick's previous probe (gi.js giSourceFrag), so
  // the SOURCE phase's only GI demand is births of its own bricks: the restart
  // it used to take would rebuild the same records, plan and Sun and add them as
  // births (initialization.probeBricks). Returns those bricks when the feedback
  // holds nothing else; otherwise the attempt restarts.
  function sourceBirths(t,feedback) {
    if(feedback.sun.length||!feedback.requirements.length)return null;
    const sources=new Set(t.plan.sourceBricks.map(index)),probes=new Set(t.plan.gatherBricks.map(r=>index(r.brick)));
    for(const r of feedback.requirements)if(r.channels!==READY.GI||!sources.has(r.index)||probes.has(r.index)||ownedProbes.has(r.index))return null;
    return feedback.requirements.map(r=>brick(r.index));
  }
  function capacity(kind,count) {
    const key=kind==='cell'?'capacity':kind+'Capacity',pool=atlas[kind];
    while(pool.free.length+atlas.resources.layout[key]-pool.nextID<count)atlas.growPool(kind);
  }
  async function restoreJobs(t,bundle,{privatePhase=false}={}) {
    const byIndex=new Map();
    for(const lease of bundle.leases){if(!byIndex.has(lease.index))byIndex.set(lease.index,{});byIndex.get(lease.index)[lease.kind]=lease;}
    const jobs=[];
    capacity('light',byIndex.size);capacity('probe',[...byIndex.values()].filter(l=>l.gi).length);
    try{
      for(const [i,leases]of byIndex){const s=leases.source,gi=leases.gi;const job=atlas.allocateLight(brick(i),{publication:bundle.publication,sourceRevision:t.cut.contentToken.sourceRevision,sourceTick:s?.token.lightingTick??0,giTick:gi?.token.lightingTick??0,readyBits:(s?READY.GI_SOURCE:0)|(gi?READY.GI:0),dependencies:{source:s&&dep(s.token),gi:gi&&dep(gi.token)}});jobs.push(job);}
      // Allocate the WHOLE closure first: growth changes pool/generation.
      await transport.restore(gpu,atlas,jobs.flatMap(job=>Object.values(byIndex.get(index(job.brick))).map(lease=>({job,lease}))));
      if(privatePhase){t.privateJobs=jobs;t.privateSnapshot=atlas.prepareProducerSnapshot({lightJobs:jobs,sourcePhaseToken:bundle.publication.sourcePhaseToken,dependencyToken:dependency(t)});}
      else atlas.publish({lightJobs:jobs,dependencyToken:dependency(t)});
    }catch(e){for(const j of jobs)try{atlas.cancel(j);}catch{}throw e;}
  }
  // Before the CELL stage: ask for the casters of every sun tile in the demand
  // whose casters this grid has not forecast yet, and on a transaction's first
  // attempt for the eye probe's tiles. A tile's casters were found by its own
  // blind sun pass, one restart per wave of tiles (and through the ground to the
  // floor); forecast, that pass finds them resident. Only adds requests: the
  // feedback still closes whatever the ground twin missed.
  async function forecast(t) {
    if(!tops)return;
    const projection=worldSunProjection(size,t.frame.sun.direction),grid=projection.tiles.join(',');
    if(grid!==forecastGrid){forecastGrid=grid;forecastTiles.clear();}
    if(!t.forecastEye){t.forecastEye=true;add(t,[],forecastEyeTiles(projection,t.frame.values?.cam));}
    const tiles=[...t.sunTiles].filter(i=>!forecastTiles.has(i));
    if(!tiles.length)return;
    t.stage='forecast';
    const bricks=new Set();
    await forecastSunCasters({size,direction:t.frame.sun.direction,tiles,tops,mark:i=>bricks.add(i)});
    for(const i of tiles)forecastTiles.add(i);
    t.forecastBricks=(t.forecastBricks??0)+bricks.size;
    add(t,[...bricks].map(i=>({brick:brick(i),channels:READY.CELL})));
  }
  async function attempt(t) {
    t.attempts=(t.attempts??0)+1;t.stage='cell';
    await clearAttempt(t,{keepRecords:true});
    await forecast(t);t.stage='cell';
    const ids=new Set([...metadata.indices,...ownedSources,...ownedProbes,...t.requirements.keys()]);
    for(const i of ownedGlow)t.requirements.set(i,(t.requirements.get(i)??0)|READY.GLOW);
    const glowCores=new Map();
    for(const [i,bits]of t.requirements)if(bits&READY.GLOW){const core=brick(i).map(n=>Math.floor(n/8));glowCores.set(core.join(','),core);}
    for(const core of glowCores.values()){const region=worldGlowPlan(size,core).input;for(let z=0;z<region.size[2];z++)for(let y=0;y<region.size[1];y++)for(let x=0;x<region.size[0];x++)ids.add(index([x+region.min[0],y+region.min[1],z+region.min[2]]));}
    if(!ids.size)throw new Error('WORLD requires explicit initial CELL demand');
    await classify(t,ids);
    t.stage='metadata';
    // Only the bricks the last attempt's records lack: the cut, clock and
    // baseline are the transaction's, so its rows would read back the same.
    const carried=t.batch&&metadata.carryable(t.batch,{cut:t.cut,derivedTick:t.tick});
    if(!carried){t.batch?.discard();t.batch=null;}
    const fresh=carried?[...ids].filter(i=>!carried.has(i)):[...ids];
    t.metadataBricks=fresh.length;
    if(fresh.length){
      const classification=cells.acquireClassification({bricks:fresh.map(brick)});
      try{t.batch=metadata.record(gpu.frame,{cut:t.cut,classification,derivedTick:t.tick,carry:carried?t.batch:null});}catch(e){classification.release();throw e;}
      await t.batch.completion;
    }
    t.stage='history';
    const nearChanged=worldLightingNear(size,t.batch.changes.changedBricks,2);
    const records=t.batch.records([...ids]).map(r=>({...r,near:nearChanged(r.brick),probeEligible:ownedProbes.has(index(r.brick))||!!(t.requirements.get(index(r.brick))&READY.GI)}));
    // Reflective SOURCE self-reads discover GI demand through typed feedback.
    // Matter (including liquids), SOURCE and CELL alone do not imply a probe.
    const never=records.filter(r=>r.probeEligible&&!ownedProbes.has(index(r.brick)));
    const requestedSources=[...t.requirements].filter(([i,bits])=>bits&READY.GI_SOURCE&&!ownedSources.has(i)).map(([i])=>brick(i));
    if(t.frame.advance)t.plan=history.begin({lightingTick:t.tick,globalKey:t.frame.globalKey,records,currentLamps:t.frame.lamps,mode:t.tick===0?2:0,initialization:{cutToken:t.cut.contentToken,sourceBricks:requestedSources,probeBricks:never.map(r=>r.brick),records}});
    else t.plan=history.beginBirth({cutToken:t.cut.contentToken,sourceBricks:[...new Map([...requestedSources,...never.filter(r=>!ownedSources.has(index(r.brick))).map(r=>r.brick)].map(b=>[index(b),b])).values()],probeBricks:never.map(r=>r.brick),records});
    // Every owned offscreen record remains a causal input. BUILDING is never
    // returned by probe(); the previous accepted bundle remains independently pinned.
    const invalidations=atlas.bookPages('light').map(p=>({brick:[...p.brick],channels:READY.LIGHT}));
    atlas.publish({invalidations,sunManifest:null});
    const previousProbes=[...ownedProbes].filter(i=>t.frame.advance||history.birth(i)?.birthTick<t.tick);
    const previous=t.plan.captureRestore({cut:t.cut,configVersion:t.frame.configVersion,sourceIndices:[...ownedSources],probeIndices:previousProbes});
    try{if(previous.leases.length)await restoreJobs(t,previous);}finally{previous.release();}
    t.stage='sun';
    const sun=await result(t,t.sun,await t.sun.prepare({direction:t.frame.sun.direction,basisRevision:t.frame.sun.basisRevision,configVersion:t.frame.configVersion,sceneToken:t.frame.sceneVersion,receiverBounds:[],requestedTiles:[...t.sunTiles],changedWorldBounds:t.batch.changes.changedBricks.map(b=>({min:b.map(n=>n*4),max:b.map(n=>n*4+4)}))}));
    if(sun.feedback)return sun.feedback;t.sunHandle=sun.output;
    const sources=t.plan.sourceBricks;
    // GLOBAL barrier: all SOURCE slabs are submitted and staged before ANY gather.
    t.stage='source';
    for(;;){
      const feedback=await giPhase(t,sources,'source');
      if(!feedback)break;
      const births=sourceBirths(t,feedback);
      if(!births)return feedback;
      // In place: the same plan, expanded by exactly the births a restart adds.
      add(t,feedback.requirements);
      for(const p of t.outputs.splice(0))p.release();
      t.plan.expand({probeBricks:births});
      t.sourcePasses=(t.sourcePasses??0)+1;
    }
    t.restore=t.plan.captureRestore({cut:t.cut,configVersion:t.frame.configVersion,sourceIndices:[...new Set([...ownedSources,...sources.map(index)])],probeIndices:previousProbes,sourcePhase:true});
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
    const sourceOutputs=new Map(),probeOutputs=new Map();
    for(const out of t.outputs){for(const i of out.sources)sourceOutputs.set(i,out);for(const i of out.probes)probeOutputs.set(i,out);}
    const restore=history.captureRestore({cut:t.cut,configVersion:t.frame.configVersion,sourceIndices:[...ownedSources].filter(i=>!sourceOutputs.has(i)),probeIndices:[...ownedProbes].filter(i=>!probeOutputs.has(i))});
    const leases=new Map();for(const l of restore.leases){if(!leases.has(l.index))leases.set(l.index,{});leases.get(l.index)[l.kind]=l;}
    const ids=new Set([...ownedSources,...ownedProbes,...sourceOutputs.keys(),...probeOutputs.keys(),...[...t.requirements].filter(([,bits])=>bits&READY.GLOW).map(([i])=>i)]),jobs=[];
    capacity('light',ids.size);capacity('probe',ids.size);
    try{
      for(const i of ids){const held=leases.get(i)??{},s=sourceOutputs.get(i),gi=probeOutputs.get(i),b=brick(i),glow=t.glows.find(o=>b.every((n,k)=>n>=o.plan.output.min[k]&&n<o.plan.output.max[k]));
        const st=s?.token??held.source?.token,gt=gi?.token??held.gi?.token,lt=glow?.token;
        const job=atlas.allocateLight(b,{publication:restore.publication,sourceRevision:t.cut.contentToken.sourceRevision,sourceTick:st?.lightingTick??0,giTick:gt?.lightingTick??0,glowTick:lt?.lightingTick??0,readyBits:(st?READY.GI_SOURCE:0)|(gt?READY.GI:0)|(lt?READY.GLOW:0),dependencies:{source:st&&dep(st),gi:gt&&dep(gt),glow:lt&&dep(lt)}});jobs.push(job);
      }
      await transport.restore(gpu,atlas,jobs.flatMap(job=>Object.values(leases.get(index(job.brick))??{}).map(lease=>({job,lease}))));
      for(const job of jobs){const i=index(job.brick),s=sourceOutputs.get(i),gi=probeOutputs.get(i),b=brick(i),glow=t.glows.find(o=>b.every((n,k)=>n>=o.plan.output.min[k]&&n<o.plan.output.max[k]));if(s)await s.writeAtlas(atlas,job,'source');if(gi)await gi.writeAtlas(atlas,job,'gi');if(glow)await glow.writeAtlas(atlas,job);}
      const s=t.sunHandle.bindings(),token=t.sunHandle.token;
      atlas.publish({lightJobs:jobs,dependencyToken:dependency(t),sunManifest:{...token,...s,dependencySetID:cells.publication.dependencySetID,dependencyVersion:cells.publication.dependencyVersion}});
      const snapshot=atlas.snapshot();
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
        if(!add(t,feedback.requirements,feedback.sun))throw new Error('WORLD unresolved feedback made no dependency progress');
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
    const t={id:++serial,frame,cut,tick:same?history.lightingTick:history.lightingTick+1,fieldTick:same?accepted.fieldTick:(cells.fields.lastTick??-1)+1,state:'building',stage:'initializing',requirements:new Map(),sunTiles:new Set(),outputs:[],glows:[],privateJobs:[],bundle:null,bundlePins:0,retired:false,cleaned:false};
    try{add(t,requirements);}catch(e){cut.release();throw e;}
    active=t;t.work=run(t);t.work.catch(()=>{});return t.work;
  }
  async function retire(t) {
    await fence();await clearAttempt(t);t.retired=true;dropResources(t);
  }
  function next() {if(queued&&!dead){const q=queued;queued=null;try{start(q.frame,q.requirements).then(q.resolve,q.reject);}catch(e){releaseFrame(q.frame);q.reject(e);}}wake();}
  const api={atlas,cells,metadata,
    // Passive counters only: inspecting readiness must never advance work.
    get progress(){const t=active;return t?Object.freeze({stage:t.state==='probe-ready'?t.state:t.stage,attempts:t.attempts??0,requirements:t.requirements.size,sunTiles:t.sunTiles.size,forecastBricks:t.forecastBricks??0,sourcePasses:t.sourcePasses??0,metadataBricks:t.metadataBricks??0,sources:t.plan?.sourceBricks.length??0,gathers:t.plan?.gatherBricks.length??0,outputs:t.outputs.length,fieldOwners:cells.fields.history.owners.size,cellPages:atlas.cell.pages.size}):null;},
    get busy(){return !!active||!!queued;},get failure(){return failure??metadataFeedback.failure??active?.feedback?.failure??active?.error??null;},get state(){return dead?'disposed':resetting?'resetting':metadataFeedback.failure||active?.feedback?.failure?'blocked':active?.state??'idle';},
    request(frame,requirements=[]){live();const f=captureFrame(frame);if(active){if(queued){releaseFrame(queued.frame);queued.resolve(null);}return new Promise((resolve,reject)=>{queued={frame:f,requirements:frozen(requirements),resolve,reject};});}try{return start(f,requirements);}catch(e){releaseFrame(f);throw e;}},
    probe(){live();return active?.state==='probe-ready'?active.bundle.retain():null;},
    current(){live();return accepted?.bundle.retain()??null;},
    async extend(candidate,feedback){live();const t=active;if(!t||t.state!=='probe-ready'||candidate.identity!==t.bundle.identity)throw new Error('foreign/out-of-order WORLD feedback');if(complete(feedback))return t.bundle.retain();if(!add(t,feedback.requirements,feedback.sun))throw new Error('WORLD scene feedback made no dependency progress');t.state='building';t.work=runRetry(t);t.work.catch(()=>{});return t.work;},
    async accept(candidate,{feedback,feedbackIdentity,postTicket}={}){live();const t=active;if(!t||t.state!=='probe-ready'||candidate.identity!==t.bundle.identity||!complete(feedback)||!postTicket?.confirmation||postTicket.publication?.identity!==candidate.identity||feedbackIdentity==null||postTicket.feedbackIdentity!==feedbackIdentity||['epoch','sceneToken','configVersion'].some(k=>postTicket.identity?.[k]!==candidate.identity[k]))throw new Error('exact complete scene/native feedback and final Post ticket required');t.state='accepting';const confirmed=await postTicket.confirmation;if(active!==t||dead)return false;if(confirmed!==true||postTicket.status!=='committed'){t.state='probe-ready';wake();return false;}if(candidate.identity!==t.bundle.identity)throw new Error('WORLD publication changed during final Post');
      t.plan.seal({cutToken:t.cut.contentToken,feedback});t.plan.commit();t.plan=null;metadataChanges(t);
      for(const out of t.outputs){out.sources.forEach(i=>ownedSources.add(i));out.probes.forEach(i=>ownedProbes.add(i));}for(const [i,bits]of t.requirements)if(bits&READY.GLOW)ownedGlow.add(i);
      const old=accepted;accepted={bundle:t.bundle.retain(),cut:t.cut.retain(),frame:t.frame,fieldTick:t.fieldTick};await retire(t);active=null;if(old){old.bundle.release();old.cut.release();}next();return true;},
    async retry(){live();const t=active;if(!t||t.state!=='rejected')throw new Error('only definitively rejected WORLD work can retry');t.state='retrying';try{await fence();}catch(e){rejected(t,e);throw e;}if(active!==t||dead)return null;t.error=null;t.state='building';t.work=runRetry(t);t.work.catch(()=>{});return t.work;},
    async discard(candidate=null){live();const t=active;if(t?.state==='accepting')throw new Error('wait for final Post confirmation before discarding WORLD');if(!t||!['probe-ready','rejected'].includes(t.state)||(t.bundle?candidate?.identity!==t.bundle.identity:t.state!=='rejected'))throw new Error('foreign WORLD discard');t.state='retiring';await retire(t);if(active!==t||dead)return;active=null;next();},
    reset({sceneVersion=active?.frame.sceneVersion??accepted?.frame.sceneVersion,schemaVersion=active?.frame.schemaVersion??accepted?.frame.schemaVersion}={}){
      live();if(source.epoch!==atlas.epoch+1||sceneVersion==null||schemaVersion==null)throw new Error('WORLD reset requires next authoritative Source epoch and explicit scene/schema identity');
      resetting=true;
      resetWork=(async()=>{
        if(queued){releaseFrame(queued.frame);queued.resolve(null);queued=null;}
        const t=active;active=null;if(t){await t.work.catch(()=>{});await retire(t);}await fence();
        accepted?.bundle.release();accepted?.cut.release();accepted=null;history?.dispose();history=null;metadata.reset();ownedSources.clear();ownedProbes.clear();ownedGlow.clear();forecastTiles.clear();forecastGrid=null;
        const cut=source.recordCut(gpu.frame,{sceneVersion,configVersion:schemaVersion});
        try{gpu.flush('WORLD reset cut capture');await fence();cells.bindCut(cut);cells.reset();}finally{cut.release();}
        failure=null;wake();
      })().catch(error=>{failure=error;throw error;}).finally(()=>{resetting=false;resetWork=null;});
      return resetWork;
    },
    async dispose(){if(dead)return;dead=true;if(resetWork)await resetWork;if(queued){releaseFrame(queued.frame);queued.resolve(null);queued=null;}const t=active;active=null;if(t){await t.work.catch(()=>{});await retire(t);}await fence();accepted?.bundle.release();accepted?.cut.release();accepted=null;history?.dispose();metadata.dispose();cells.dispose();atlas.dispose();if(win.render===api)delete win.render;}
  };
  function metadataChanges(t){const changes=t.batch.commit();t.batch=null;history.noteChanged(changes.changedBricks,changes.derivedTick);}
  async function runRetry(t){try{while(active===t&&!dead){let feedback;try{feedback=await attempt(t);}catch(e){if(!e.requirements)throw e;feedback={requirements:e.requirements,sun:[]};}if(!feedback){t.state='probe-ready';wake();return t.bundle.retain();}if(!add(t,feedback.requirements,feedback.sun))throw new Error('WORLD unresolved feedback made no dependency progress');}return null;}catch(e){rejected(t,e);throw e;}}
  win.render=Object.freeze(api);return win.render;
}
