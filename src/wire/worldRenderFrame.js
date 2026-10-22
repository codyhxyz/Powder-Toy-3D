// WORLD native/Post recording and the single pending normal-tick App driver.
import { Matrix4 } from 'three/webgpu';
import { frameUniformValues } from '../gfx/uniforms.js';
import { createWorldVolume, worldFrameValues, startWorldView } from '../gfx/worldVolume.js';
import { SOURCE_APPEARANCE_ENABLED } from '../gfx/sourceAppearance.js';
import { WORLD_APPEARANCE_GRID } from '../gfx/worldAppearance.js';
import { createWorldOpaqueCapture } from '../gfx/worldOpaque.js';
import { createWorldFeedbackProvider } from '../gfx/worldLightingInputs.js';
import { createNativeWorldMeshLightContext, guardMeshes } from '../gfx/meshLight.js';
import { renderViewmodels } from '../pov/viewmodel.js';
import { queryWorldPick, worldPickNotReady } from './worldPick.js';
import { READY } from '../world/renderAtlas.js';
import { WORLD_NATIVE } from '../shaders/gfx/liquidDetail.js';
import { viewKey } from '../views.js';
import { gateVariants } from '../gfx/detailGate.js';

const array = v => Array.from(v?.elements ?? (v?.toArray ? v.toArray() : v));
const requireReady = (ok, message) => { if (!ok) throw new Error(message); };
const complete = f => f?.incomplete === false && !f.requirements.length && !f.sun.length;

// A real CELL publication bootstraps the subsequent eye/scene feedback loop.
// Outside-world views seed the nearest valid brick, not an assumed empty page.
export function worldInitialCellDemand(position, size) {
  const p=array(position);
  if(p.length!==3 || size?.length!==3 || !p.every(Number.isFinite) ||
    !Array.from(size).every(n=>Number.isInteger(n)&&n>0))throw new RangeError('finite world eye and dimensions required');
  return [{brick:p.map((v,i)=>Math.floor(Math.max(0,Math.min(size[i]-1,v))/4)),channels:READY.CELL}];
}

// Only replace projection-dependent values under Post's ACTUAL jittered camera.
// Owned data frame values are plain arrays, not Three Matrix4/Vector3 objects.
export function worldSceneValues(values, camera, jitter) {
  const model = new Matrix4().fromArray(array(values.model));
  const captured = frameUniformValues({camera, model});
  return {...values, model:array(model), viewProj:array(captured.viewProj),
    invViewProj:array(captured.invViewProj), cam:array(captured.cam), jitter:[...jitter]};
}
export function worldSceneParams(params, values, inSize) {
  return {...params, meshInv:new Matrix4().fromArray(values.viewProj)
    .multiply(new Matrix4().fromArray(values.model)).invert().toArray(),
  meshRes:[...inSize], meshCut:1}; // actual pack; pack-none has explicit empty coverage
}
export function mergeWorldFrameFeedback(...feedback) {
  const requirements = new Map(), sun = new Set();
  for (const f of feedback) {
    if (!f || !Array.isArray(f.requirements) || !Array.isArray(f.sun)) throw new TypeError('decoded whole-reader feedback required');
    for (const r of f.requirements) {
      const key=r.index ?? r.brick.join(',');
      const old=requirements.get(key);
      requirements.set(key,{...r,channels:(old?.channels??0)|r.channels});
    }
    f.sun.forEach(i => sun.add(i));
  }
  return {incomplete:feedback.some(f => f.incomplete) || !!requirements.size || !!sun.size,
    requirements:[...requirements.values()], sun:[...sun]};
}

// The caller holds candidate and returned native consumers through LAST use.
function nativeCandidate(state, data, values, params, packedMesh) {
  return state.volume.prepare({snapshot:data.snapshot.retain(), tableBuffer:data.tables.buffer,
    appearance:data.appearance, frameUniforms:values, physicsOrigin:data.frame.physicsOrigin, params,
    lighting:data.lighting, external:{...data.frame.external, packedMesh}});
}
function meshPublication(data) {
  const pin = data.retain(), t = data.snapshot.textures();
  return {identity:data.identity, atlas:data.snapshot,
    sun:{...data.lighting, textures:() => data.sunTextures},
    textures:{aux:t.aux, gi:[t.gi0,t.gi1,t.gi2,t.gi3], glow:t.glow}, release:() => pin.release()};
}
function meshContext(app, state, data, native, values, noise) {
  return createNativeWorldMeshLightContext(app.gpu, {publication:meshPublication(data),
    worldSize:app.win.size, frameValues:worldFrameValues(values, data.frame.physicsOrigin),
    feedback:native.feedback, noise,
    isCompatible:() => app.win?.render === state.data && data.identity.epoch === app.win.renderSource.epoch});
}

/** Install AFTER actual data owner, loaded Source/Producer and immutable noise.
 * This allocates a real, stable 1x1 packed binding for QUERY LAYOUT ONLY. Scene
 * geometry always binds the bounded Post target's packedOpaque instead.
 */
export async function createWorldFrameState(app, data, noise) {
  requireReady(app.win?.loaded && app.win.render === data, 'loaded actual WORLD data owner required');
  await Promise.all([noise.ready, app.post.sceneReady]);
  requireReady(!app.gpu.failure && !app.gpu.lost, 'WORLD graphics unavailable');
  let unused,opaque,boundary,emptyArtwork;
  try {
    unused=app.gpu.device.createTexture({label:'world unused query packed binding',
      size:[1,1],format:'rgba32uint',usage:4|2});
    app.gpu.device.queue.writeTexture({texture:unused},new Uint32Array([0,0,0x3f800000,0]),{},[1,1]);
    opaque=createWorldOpaqueCapture(app.gpu);
    boundary=app.gpu.device.createBuffer({label:'WORLD presentation final boundary',size:16,usage:4|8});
    emptyArtwork=app.gpu.device.createTexture({label:'WORLD absent artwork binding',size:[1,1,1],dimension:'3d',format:'rgba16uint',usage:6});
    app.gpu.device.queue.writeTexture({texture:emptyArtwork},new Uint16Array(4),{},[1,1,1]);
    await opaque.ready;
    return {data,noise,unused,boundary,emptyArtwork,opaque,volume:null,uses:new Set(),dead:false};
  } catch(error) {
    opaque?.dispose();
    // Private initialization uploads may already be queued. No consumer has
    // recorded these resources, but those uploads must finish before disposal.
    try {await app.gpu.device.queue.onSubmittedWorkDone();} catch {}
    unused?.destroy();boundary?.destroy();emptyArtwork?.destroy();throw error;
  }
}
export async function prewarmWorldFrame(app, state, data, {view,detail={},curved=false}) {
  requireReady(!state.dead && data.tables?.buffer && data.sunTextures, 'pinned WORLD native inputs required');
  state.volume ??= createWorldVolume(app.gpu, {g:{nx:app.win.size[0],ny:app.win.size[1],nz:app.win.size[2],
    sourceAppearance:!!data.appearance,sourceGrid:data.appearance?.sourceGrid}, atlas:state.data.atlas, tables:data.tables.buffer});
  // (and V2's packet pipe for World's light, gfx/nativeParticles.js worldPipe: none under V1)
  await Promise.all([state.volume.viewReady(view,detail,curved), state.volume.pointReady,
    state.volume.signsReady, state.opaque.ready, app.post.sceneReady, app.sim?.compact ? app.nativeParticles?.worldReady() : null]);
  requireReady(!state.dead && app.win?.render===state.data, 'WORLD preparation retired while awaiting pipelines');
}

// Real native point readback. Both feedback and all 80 output bytes belong to
// this exact native publication. No BOX probe or outside-window substitute.
export async function probeWorldFrameEye(app, state, data, frozenView = null) {
  requireReady(!state.dead && app.win?.render===state.data, 'WORLD eye request retired');
  const values = frozenView ? {...data.frame.values,...frozenView.values} : data.frame.values;
  const {gpu}=app, ticket=createWorldFeedbackProvider(gpu,{}).reserve(gpu.frame), pin=data.retain();
  let native,output,combined,count,read,recordingError;
  try {
    native=nativeCandidate(state,data,values,data.frame.params,state.unused.createView());
    output=gpu.device.createBuffer({label:'world eye output',size:80,usage:128|4});
    count=native.feedback.size/4;
    combined=gpu.device.createBuffer({label:'world eye and complete feedback',size:native.feedback.size+80,usage:4|8});
    requireReady(native.recordPointReady(gpu.frame,{position:values.cam,output}), 'WORLD point pipeline not ready');
    const encoder = gpu.frame.direct();
    encoder.copyBufferToBuffer(native.feedback,0,combined,0,native.feedback.size);
    encoder.copyBufferToBuffer(output,0,combined,native.feedback.size,80);
  } catch(error) {recordingError=error;} finally {
    // Even partial encoding closes the real normal-Frame final boundary.
    read = ticket.record(gpu.frame,combined??state.boundary);
  }
  const result=read.then(words => {
    if(recordingError)throw recordingError;
    return Object.freeze({publication:native.publication, position:Object.freeze([...values.cam]),
      words:new Float32Array(words.slice(count).buffer), feedback:native.decodeFeedback(words.subarray(0,count))});
  });
  // Register immediately: disposal also waits a blocked/unfinished read, not
  // merely already completed queries. Decode precedes native destruction.
  retireWorldUse(state,gpu,Promise.allSettled([ticket.submitted,result]),
    () => {native?.release();output?.destroy();combined?.destroy();pin.release();});
  return result;
}
function retireWorldUse(state,gpu,submitted,release) {
  const done = Promise.resolve(submitted).catch(() => {}).then(() => gpu.device.queue.onSubmittedWorkDone()).finally(release);
  state.uses.add(done);done.then(() => state.uses.delete(done),() => state.uses.delete(done));
  return done;
}

/** Records real Three opaque -> pack -> sky -> full volume -> transparent -> overlays.
 * Caller supplies the real App threeMeshes/draw-overlay methods, not services
 * or readiness callbacks. Frozen view/settings, but then-current actors: this
 * entire SceneAttempt is synchronous after preparation. No pass yields.
 * stillTarget uses the same scene readers, but no MAIN eye/VM/sign/UI readers.
 */
export function recordWorldFrame(app, state, data, {camera, view, detail={}, curved=false,
  eye, identity, order, signRequest=null, dt=0, frozenView=null, preflight=null, stillTarget=null}) {
  requireReady(!state.dead && app.win?.loaded && app.win.render===state.data, 'live WORLD frame required');
  requireReady(['threeMeshes','writeWorldFrame','drawWorldSky','drawWorldAfter','drawWorldOverlay'].every(k=>typeof app[k]==='function'),
    'actual App opaque/after/overlay functions must be connected before recording');
  requireReady(stillTarget || (complete(eye.feedback) && eye.words.length===20 && eye.words[19]===1), 'complete native eye required before hands');
  if(stillTarget)signRequest=null;
  requireReady(state.volume.pipelineState(view,detail,curved).state==='ready', 'prewarm WORLD view before recording');
  requireReady(preflight && preflightWorldMeshes(app, preflight, camera), 'WORLD mesh preparation required before hands');
  const values=frozenView ? {...data.frame.values,...frozenView.values} : data.frame.values, {gpu,post}=app;
  const params={...data.frame.params,...frozenView?.params};
  const worldLighting=stillTarget ? null : {publication:eye.publication,position:eye.position,
    frame:{identity,scene:data.frame.sceneVersion,epoch:data.identity.epoch,domain:'world',order,time:values.time,
      sunDirection:values.sun,sunColor:values.sunCol,keyLight:values.keyLight,
      settings:{exposure:post.settings.exposure,raw:post.settings.raw}},
    sample:{identity:eye,publication:eye.publication,frameIdentity:identity,position:eye.position,words:eye.words}};
  const ticket=createWorldFeedbackProvider(gpu,{}).reserve(gpu.frame), feedbackIdentity=Object.freeze({identity});
  let hands;
  try {hands=stillTarget ? {ready:true} : app.presentation.neutral(() => renderViewmodels(app.renderer,app.scene,camera,post,{
    worldLighting,onReady:()=>app.wakeLoop(),onPending:work=>trackWorldCompilation(app,preflight,work)}));}
  catch(error) {
    const pin=data.retain(),read=ticket.record(gpu.frame,state.boundary);read.catch(()=>{});
    retireWorldUse(state,gpu,Promise.allSettled([ticket.submitted,read]),()=>pin.release());throw error;
  }
  if(!hands?.ready){
    const read=ticket.record(gpu.frame,state.boundary);read.catch(()=>{});
    retireWorldUse(state,gpu,Promise.allSettled([ticket.submitted,read]),()=>{});return null;
  }
  let native, context, signFrame, signOutput, sceneTicket, drew=false, submittedRead, combined, recordingError;
  const pin=data.retain(), postPublication=data.retain(), model=new Matrix4().fromArray(values.model);
  let transferred=false;
  try {
    requireReady(!hands.images || hands.images.isCurrent(), 'viewmodel image replaced before Post copy');
    sceneTicket=post.recordScene({
      prepare(p) {
        const fv=worldSceneValues(values,camera,p.jitter);
        app.writeWorldFrame(fv,camera);
        if(!stillTarget)app.prepareWorldAfter(fv,camera);
        native=nativeCandidate(state,data,fv,worldSceneParams(params,fv,p.inSize),p.sceneTarget.packedOpaque.createView());
        context=meshContext(app,state,data,native,fv,state.noise.texture);context.bind();
        requireReady(guardMeshes(app.scene,camera,{skip:o=>o.name==='pov-viewmodel',onReady:()=>app.wakeLoop()})===0,
          'native WORLD material graphs must be prewarmed before scene');
        if (signRequest) {
          signFrame=app.signs.captureWorldFrame({request:signRequest,camera,model,publication:native.publication,identity,
            presentation:{k:params.warpK??0,anchor:params.warpAnchor??[0,0],dir:params.warpDir??[0,1]}});
          signOutput=gpu.device.createBuffer({label:'world frame signs',size:2048,usage:128|4});
          requireReady(native.recordSignsReady(gpu.frame,{camera:signFrame.camera,anchors:signRequest.anchors,cells:signRequest.cells,
            count:signRequest.count,presentation:signFrame.presentation,output:signOutput}), 'WORLD signs not ready');
        }
      },
      opaque(p) {drew=app.threeMeshes(p,false,camera);return drew;},
      capture(p) {requireReady(state.opaque.recordReady(gpu.frame,{color:p.sceneTarget.color,depth:p.sceneTarget.depth,
        output:p.sceneTarget.packedOpaque,drew,submitted:ticket.submitted}), 'WORLD opaque capture not ready');},
      draw(rp) {app.drawWorldSky(rp,view);requireReady(native.recordDraw(rp,{view,detail,curved}), 'WORLD synchronous volume unavailable');if(!stillTarget)app.drawWorldAfter(rp,context.particleLight);},
      meshes(p) {app.threeMeshes(p,true,camera);},
      overlay:stillTarget ? undefined : rp=>app.drawWorldOverlay(rp),
    },camera,{identity:data.identity,publication:postPublication,feedbackIdentity,submission:ticket,worldModel:model,cameraIdentity:frozenView?.cameraIdentity??camera,
      onPublicationTransferred:()=>{transferred=true;},dt,viewmodel:hands.viewmodel,glow:hands.glow,
      ...(stillTarget ? {still:true,target:stillTarget} : {})});
    if (!sceneTicket) hands.lighting?.discard();
  } catch(error) {
    hands.lighting?.discard();
    recordingError=error;
  } finally {
    if (!transferred) postPublication.release();
    if (native) {
      // Copy signs after ALL scene readers, then close ONE actual final suffix.
      const bytes=native.feedback.size+(signOutput?2048:0);
      try {
        combined=gpu.device.createBuffer({label:'world scene feedback and signs',size:bytes,usage:4|8});
        const encoder=gpu.frame.direct();encoder.copyBufferToBuffer(native.feedback,0,combined,0,native.feedback.size);
        if(signOutput)encoder.copyBufferToBuffer(signOutput,0,combined,native.feedback.size,2048);
      } catch(error) {recordingError??=error;} finally {
        submittedRead=ticket.record(gpu.frame,combined??state.boundary);
      }
    } else {
      // Even Post pool backpressure follows a VM draw. Close that suffix too.
      submittedRead=ticket.record(gpu.frame,state.boundary);
    }
  }
  let settleLastUse;
  const lastUse=new Promise(resolve=>{settleLastUse=resolve;});
  context?.retireAfter(lastUse).catch(()=>{});
  const retirement=retireWorldUse(state,gpu,lastUse,
    ()=>{native?.release();signOutput?.destroy();combined?.destroy();pin.release();});
  const releaseAfter=submitted => {settleLastUse(submitted);return retirement;};
  if(recordingError || !sceneTicket) {
    releaseAfter(ticket.submitted);
    submittedRead.catch(()=>{});
    if(recordingError)throw recordingError;
    return null;
  }
  return {data,sceneTicket,feedbackIdentity,hands,native,signFrame,signRequest,stillTarget,
    submitted:ticket.submitted,releaseAfter,read:submittedRead};
}

// This gate executes against actual Post tickets. Only confirmed final pixels
// may advance data history, VM smoothing or DOM. A miss never calls TAA.
export async function finishWorldFrame(app, state, recorded, eyeFeedback) {
  const {data,sceneTicket,feedbackIdentity,hands,native,signFrame,signRequest}=recorded;
  let accepted=false, finalSubmission=recorded.submitted;
  const retiredStill=()=>recorded.stillTarget && (app.win?.render!==state.data ||
    app.win?.renderSource?.epoch!==data.identity.epoch);
  try {
    const words=await recorded.read, count=native.feedback.size/4;
    if(state.dead || retiredStill()) {app.post.discardScene(sceneTicket);return {accepted:false,feedback:{incomplete:false,requirements:[],sun:[]},restage:true};}
    const merged=mergeWorldFrameFeedback(eyeFeedback,native.decodeFeedback(words.subarray(0,count)));
    // (budget-dropped misses are settled before the signs' own readiness: worldRender.js settle)
    const feedback={...(state.data.settle?.(merged)??merged)};
    const signs=signRequest ? new Float32Array(words.slice(count).buffer).slice(0,signRequest.count*8) : null;
    if(signs)for(let i=0;i<signRequest.count;i++)if(signs[i*8+4]!==1)feedback.incomplete=true;
    if(!complete(feedback)) {app.post.discardScene(sceneTicket);return {accepted:false,feedback};}
    if(signRequest && !app.signs._matchesWorldRequest(signRequest)) {app.post.discardScene(sceneTicket);return {accepted:false,feedback,restage:true};}
    if(hands.lighting && !hands.lighting.canCommit()) {app.post.discardScene(sceneTicket);return {accepted:false,feedback,restage:true};}
    const final=createWorldFeedbackProvider(app.gpu,{}).reserve(app.gpu.frame);
    let committed;
    finalSubmission=final.submitted;
    try {
      committed=app.post.commitScene(sceneTicket,{feedbackIdentity,feedback,submission:final});
    } finally {
      // Always close tentative Post work, including exceptions and prefix failures.
      await final.record(app.gpu.frame,native.feedback);
    }
    if(!committed) {
      app.post.discardScene(sceneTicket);return {accepted:false,feedback,restage:true};
    }
    if(retiredStill())return {accepted:false,feedback,restage:true};
    accepted=await state.data.accept(data,{feedback,feedbackIdentity,postTicket:sceneTicket});
    if(accepted && !state.dead) {
      requireReady(!hands.lighting || hands.lighting.commit(), 'accepted WORLD hands baseline changed');
      if(signFrame) app.signs.commitWorldFrame({frame:signFrame,results:signs,publication:native.publication,
        identity:signFrame.identity,feedback,completed:true,accepted:true});
    }
    return {accepted,feedback};
  } finally {
    if(!accepted) {hands.lighting?.discard();app.post.discardScene(sceneTicket);}
    await recorded.releaseAfter(finalSubmission);
  }
}
// A preflight owns the actual native graph bindings until every compilation
// (including repeated checks of an already parked mesh) and queued use settles.
export function createWorldMeshPreflight(app,state,data,frozenView) {
  const values={...data.frame.values,...frozenView.values};
  const native=nativeCandidate(state,data,values,data.frame.params,state.unused.createView());
  let context;
  try { context=meshContext(app,state,data,native,values,state.noise.texture); }
  catch(error) {native.release();throw error;}
  return {native,context,pending:new Set(),failure:null,dead:false};
}
function trackWorldCompilation(app,p,work) {
  if(p.pending.has(work))return;
  p.pending.add(work);
  work.then(()=>{p.pending.delete(work);app.wakeLoop();},error=>{p.failure=error;app.wakeLoop();});
}
export function preflightWorldMeshes(app,p,camera) {
  requireReady(!p.dead && !p.failure, p.failure?.message ?? 'retired WORLD preflight');
  p.context.bind();
  app.presentation.install(app.scene,camera);
  const n=guardMeshes(app.scene,camera,{skip:o=>o.name==='pov-viewmodel',
    target:app.post.sceneTarget.rt,onReady:()=>app.wakeLoop(),onPending:work=>trackWorldCompilation(app,p,work)});
  if(n && !p.pending.size)throw new Error('WORLD parked mesh has no live compilation');
  return n===0 && p.pending.size===0;
}
export async function releaseWorldMeshPreflight(app,p) {
  if(!p || p.dead)return;
  p.dead=true;
  await Promise.allSettled([...p.pending]);
  await p.context.retireAfter(Promise.resolve());
  p.native.release();
}

// Capture VIEW only. Publication-owned time/lighting/artwork/physics-origin are
// deliberately not copied from current globals after the point readback.
// The view's detail, plus WORLD_NATIVE while V2 runs the box: its live copies then carry V2's foam
// (world/renderSource.js liveSource), and the World programs compile native foam as Box's format-2 do.
export const worldViewDetail=(sim,detail={})=>sim?.compact ? {...detail,[WORLD_NATIVE]:true} : {...detail};
// The view a World frame asks for, as app.js captureWorldRequest freezes it (the settings'
// view, every detail feature they switch on: updateFrameDetail; the gamemode's bend:
// warpNow), for gfx/worldVolume.js startWorldView before the world exists.
export const worldViewOf=app=>({view:viewKey(app.settings.view),detail:worldViewDetail(app.sim,gateVariants(app.settings).near),
  curved:!!(app.presentation?.active && app.presentation.parameters?.k)});
/** Starts the World view pipeline a big map of `scene` draws first (gfx/worldVolume.js
 * startWorldView), before its world exists: wire/world.js attach, in the map's build, so the
 * cold compile runs beside the world's generation and streaming. Its module is the same for
 * every world size. A wrong guess (the view changed meanwhile) only costs a build, and a
 * failure here only the head start: the first frame's own request still builds and reports.
 * @returns {Promise<unknown> | null} its readiness
 */
export function startWorldFrameView(app, scene) {
  try {
    return startWorldView(app.gpu, {...worldViewOf(app), sourceGrid:WORLD_APPEARANCE_GRID,
      sourceAppearance:SOURCE_APPEARANCE_ENABLED && !!scene?.importManifest?.appearance});
  } catch(error) {console.warn('World view pipeline could not start early',error);return null;}
}
export function freezeWorldView(app,values,{view,detail={},curved=false}={}) {
  app.camera.updateMatrixWorld();
  const camera=app.camera.clone(false);camera.parent=null;
  camera.matrix.copy(app.camera.matrixWorld);camera.matrixWorld.copy(app.camera.matrixWorld);
  camera.matrixWorldInverse.copy(app.camera.matrixWorldInverse);
  camera.matrix.decompose(camera.position,camera.quaternion,camera.scale);
  const v=worldSceneValues(values,camera,[0,0]);
  const p=app.presentation;
  return {camera,cameraIdentity:app.camera,view,detail:worldViewDetail(app.sim,detail),curved,values:{model:[...v.model],cam:[...v.cam],viewProj:[...v.viewProj],invViewProj:[...v.invViewProj],
      ...Object.fromEntries(['view','materialStyle','sourceStyle','bevel','glints','matDetail'].filter(k=>values[k]!==undefined).map(k=>[k,values[k]]))},
    params:{marchNear:app.pov?.marchNear??0,warpK:p.parameters.k,warpAnchor:[...p.parameters.anchor],warpDir:[...p.parameters.dir]},
    settings:{...app.settings},post:{...app.post.settings},presentation:{parameters:structuredClone(p.parameters),
      sceneToWorld:p.sceneToWorld.clone(),worldToScene:p.worldToScene.clone(),
      k:p.uniforms.uWarpK.value,anchor:p.uniforms.uWarpAnchor.value.clone(),dir:p.uniforms.uWarpDir.value.clone()}};
}
export function withWorldView(app,view,fn) {
  const camera=app.camera,settings={...app.settings};
  app.camera=view.camera;Object.assign(app.settings,view.settings);
  const p=app.presentation, saved={post:{...app.post.settings},parameters:Object.getOwnPropertyDescriptor(p,'parameters'),
    sceneToWorld:p.sceneToWorld.clone(),worldToScene:p.worldToScene.clone(),k:p.uniforms.uWarpK.value,
    anchor:p.uniforms.uWarpAnchor.value.clone(),dir:p.uniforms.uWarpDir.value.clone()};
  const apply=(v)=>{Object.assign(app.post.settings,v.post);p.sceneToWorld.copy(v.presentation.sceneToWorld);
    p.worldToScene.copy(v.presentation.worldToScene);p.uniforms.uWarpK.value=v.presentation.k;
    p.uniforms.uWarpAnchor.value.copy(v.presentation.anchor);p.uniforms.uWarpDir.value.copy(v.presentation.dir);};
  apply(view);Object.defineProperty(p,'parameters',{configurable:true,get:()=>view.presentation.parameters});
  try{return fn();}finally{apply({post:saved.post,presentation:saved});Object.defineProperty(p,'parameters',saved.parameters);app.camera=camera;Object.assign(app.settings,settings);}
}

/** One pending data transaction. Promises only store results/wake; actors are
 * selected and encoded exclusively by tick() after normal App afterStep work.
 * Reserving derived/view counts occurs only when this slot is empty. */
export function createWorldFrameDriver(app,state,execution={}) {
  // CPU fixtures replace native math/scenegraph encoding, never the data owner
  // or accepted-history protocol. Production always uses these concrete paths.
  const {prewarm=prewarmWorldFrame,probe=probeWorldFrameEye,createPreflight=createWorldMeshPreflight,
    preflight=preflightWorldMeshes,record=recordWorldFrame,releasePreflight=releaseWorldMeshPreflight}=execution;
  let pending=null, dead=false, order=0, accepted=null, failure=null, retirement=null;
  let displayedMainFrame=null, blockedPick=null, preferMain=false;
  const pickDemands=new Map(), stills=[];
  const emptyFeedback=()=>({incomplete:false,requirements:[],sun:[]});
  const retiredStill=()=>app.win?.render!==state.data || (app.win?.renderSource &&
    app.win.renderSource.epoch!==displayedMainFrame?.data.identity.epoch);
  // A failed target cannot be returned to the UI while an encoded prefix or
  // asynchronous native material compilation can still use it.
  const rejectStill=(p,error)=>{
    if(!p?.job || p.rejectionDrain)return;
    p.rejectionDrain=drain(p)
      .then(()=>p.job.reject(error));
  };
  const drain=async p=>{
    await Promise.allSettled([p.work,p.preparing,state.volume?.compilationSettled,
      state.opaque.ready,app.post.sceneSettled]);
    await Promise.allSettled([releasePreflight(app,p.preflight)]);
    await Promise.allSettled([...state.uses]);
  };
  const queueStill=({view,target})=>{
    if(dead || failure || !accepted || !displayedMainFrame)return Promise.reject(failure??new Error('WORLD still not ready'));
    if(retiredStill())return Promise.reject(new Error('reset WORLD owner before requesting stills'));
    if(!view?.camera || !target)return Promise.reject(new TypeError('frozen WORLD view and owned still target required'));
    return new Promise((resolve,reject)=>{stills.push({view,target,resolve,reject});wake();});
  };
  const wake=()=>app.wakeLoop();
  const queuePickDemand=(feedback,display)=>{
    if(dead || display!==displayedMainFrame)return false;
    if(feedback.sun.length)throw new Error('raw WORLD pick must not demand Sun');
    blockedPick=display;
    for(const r of feedback.requirements){
      const key=r.brick.join(','),old=pickDemands.get(key);
      pickDemands.set(key,{brick:[...r.brick],channels:(old?.channels??0)|r.channels});
    }
    wake();return true;
  };
  const fail=(p,error)=>{
    if(dead || pending!==p || failure)return;
    failure=error;p.phase='failed';rejectStill(p,error);
    for(const job of stills.splice(0))job.reject(error);
    wake();
  };
  const wait=(p,work,next)=>{p.phase='waiting';p.waitTarget=next;p.work=Promise.resolve(work).then(value=>{
    if(dead || failure || pending!==p){value?.release?.();return;}
    p.result=value;p.phase=next;wake();
  },error=>fail(p,error));};
  // Eye misses extend the same cut while its full-view warm continues. Only
  // preparation is asynchronous; preflight/actor selection still belong to tick.
  const prepare=async(p,work)=>{
    let data=await work;
    while(!dead && !failure && pending===p) {
      p.data=data;if(!data)throw new Error('WORLD request retired');
      if(!p.preparing){p.preparing=Promise.resolve(prewarm(app,state,data,p.view));p.preparing.catch(error=>fail(p,error));}
      if(p.job)p.eye={feedback:emptyFeedback()};
      else {
        requireReady(state.volume?.pointReady?.then,'WORLD point readiness required');
        await state.volume.pointReady;
        if(dead || failure || pending!==p)return;
        p.eye=await probe(app,state,data,p.view);
        if(dead || failure || pending!==p)return;
        p.eye={...p.eye,feedback:state.data.settle?.(p.eye.feedback)??p.eye.feedback};   // (budget-dropped misses: worldRender.js settle)
        if(!complete(p.eye.feedback)){data=await extend(p,p.eye.feedback);continue;}
      }
      await p.preparing;return;
    }
    data?.release?.();
  };
  const extend=(p,feedback)=>{
    const old=p.data;p.data=null;
    const preflight=p.preflight;p.preflight=null;
    return Promise.allSettled([state.data.extend(old,feedback),releasePreflight(app,preflight)]).then(([data,released])=>{
      if(data.status==='rejected')throw data.reason;
      if(released.status==='rejected'){data.value?.release();throw released.reason;}
      return data.value;
    }).finally(()=>old.release());
  };
  return {
    get phase(){return pending ? pending.phase+(pending.phase==='waiting'?':'+pending.waitTarget:'') : 'idle';},
    get preparation(){const v=state.volume;return Object.freeze({views:v?.pipelineStates,
      point:v?.pointState?.state,signs:v?.signsState?.state,pick:v?.pickState?.state,
      post:app.post.isReady,uses:state.uses?.size});},
    get busy(){return !!pending || !!pickDemands.size || !!stills.length;},get failure(){return failure;},get accepted(){return accepted;},
    queueStill,requestStill:queueStill,
    get displayedMainFrame(){return displayedMainFrame;},queuePickDemand,
    pick(options){
      const display=displayedMainFrame;
      if(dead || !display || blockedPick===display)return Promise.resolve(worldPickNotReady());
      return queryWorldPick(app,state,display,options,d=>!dead&&displayedMainFrame===d,queuePickDemand);
    },
    presentLast(){
      if(dead || !displayedMainFrame)return false;
      const ticket=createWorldFeedbackProvider(app.gpu,{}).reserve(app.gpu.frame);
      try{return app.post.presentLast({submission:ticket});}finally{
        const read=ticket.record(app.gpu.frame,state.boundary);read.catch(()=>{});
        retireWorldUse(state,app.gpu,Promise.allSettled([ticket.submitted,read]),()=>{});
      }
    },
    tick({present,reserve,capture,dt=0}) {
      if(dead)return false;if(failure)throw failure;
      try {
      if((pending?.job || stills.length) && retiredStill())throw new Error('reset WORLD owner before requesting stills');
      if(!pending && stills.length && !preferMain) {
        const job=stills.shift();
        pending={phase:'new',job,view:job.view,data:null,preflight:null,eye:null,work:null};
        wait(pending,prepare(pending,state.data.request({...accepted.frame,advance:false},
          worldInitialCellDemand(job.view.values.cam,app.win.size))),'prepared');
      }
      if(!pending && (present || pickDemands.size)) {
        const reservation={...reserve()};
        if(pickDemands.size)reservation.runView=true;
        if(reservation.runView){
          const request=capture(reservation,state);
          const requirements=mergeWorldFrameFeedback({requirements:request.requirements??[],sun:[]},
            {requirements:[...pickDemands.values()],sun:[]}).requirements;
          pickDemands.clear();
          pending={phase:'new',view:request.view,reservation,data:null,preflight:null,eye:null,work:null};
          wait(pending,prepare(pending,state.data.request(request.frame,requirements)),'prepared');
        }
      }
      if(!pending && preferMain) {preferMain=false;wake();}
      const p=pending;if(!p)return false;
      if(p.phase==='prepared') {
        p.result=null;p.preflight=createPreflight(app,state,p.data,p.view);p.phase='scene';
      }
      if(p.phase==='scene') {
        const attempt=()=>withWorldView(app,p.view,()=>{
          if(!preflight(app,p.preflight,p.view.camera))return null;
          app.post.setSceneIdentity(p.data.identity);
          p.frameIdentity=Object.freeze({order:++order});
          return record(app,state,p.data,{...p.view,frozenView:p.view,preflight:p.preflight,
            eye:p.eye,identity:p.frameIdentity,order,dt,
            stillTarget:p.job?.target??null,
            signRequest:p.job ? null : app.signs?.worldRequest(app.win.size)??null});
        });
        const recorded=p.job ? app.presentation.neutral(attempt) : attempt();
        if(recorded)wait(p,finishWorldFrame(app,state,recorded,p.eye.feedback),'finished');
      }
      if(p.phase==='finished') {
        const result=p.result;p.result=null;
        if(!result.accepted){
          if(!complete(result.feedback)){wait(p,prepare(p,extend(p,result.feedback)),'prepared');return false;}
          p.phase='scene';wake();return false;
        }
        if(!p.job) {
          accepted={frame:p.data.frame,reservation:p.reservation};
          const old=displayedMainFrame;
          const pin=p.data.retain();
          displayedMainFrame=Object.freeze({data:pin,view:p.view,frameIdentity:p.frameIdentity});
          old?.data.release();
        }
        p.data.release();p.data=null;
        wait(p,releasePreflight(app,p.preflight),'released');
      }
      if(p.phase==='released'){
        pending=null;preferMain=!!p.job;
        if(p.job)p.job.resolve(true);
        wake();return !p.job;
      }
      return false;
      } catch(error) {
        failure=error;
        if(pending){pending.phase='failed';rejectStill(pending,error);}
        for(const job of stills.splice(0))job.reject(error);
        throw error;
      }
    },
    dispose(){
      return retirement??=(async()=>{
        dead=true;state.dead=true;const p=pending;pending=null;
        const error=new Error('WORLD still driver disposed');
        for(const job of stills.splice(0))job.reject(error);
        if(p){await drain(p);p.result?.release?.();await p.rejectionDrain;p.data?.release();}
        displayedMainFrame?.data.release();displayedMainFrame=null;pickDemands.clear();
        await Promise.allSettled([...state.uses]);
        p?.job?.reject(error);
        await state.data.dispose();
        await disposeWorldFrame(state);
      })();
    },
  };
}

export async function disposeWorldFrame(state) {
  state.dead=true;state.volume?.dispose();state.opaque.dispose();
  await Promise.allSettled([...state.uses]);state.unused.destroy();state.boundary.destroy();state.emptyArtwork.destroy();
}
