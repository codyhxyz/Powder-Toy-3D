// Concrete WORLD native/Post frame recording. Deliberately not activated until
// App's frozen-pose and accepted-clock scheduler is connected (see handoff).
import { Matrix4 } from 'three/webgpu';
import { frameUniformValues } from '../gfx/uniforms.js';
import { createWorldVolume, worldFrameValues } from '../gfx/worldVolume.js';
import { createWorldOpaqueCapture } from '../gfx/worldOpaque.js';
import { createWorldFeedbackProvider } from '../gfx/worldLightingInputs.js';
import { createNativeWorldMeshLightContext, guardMeshes } from '../gfx/meshLight.js';
import { renderViewmodels } from '../pov/viewmodel.js';

const array = v => Array.from(v?.elements ?? (v?.toArray ? v.toArray() : v));
const requireReady = (ok, message) => { if (!ok) throw new Error(message); };
const complete = f => f?.incomplete === false && !f.requirements.length && !f.sun.length;

// Only replace projection-dependent values under Post's ACTUAL jittered camera.
// Owned data frame values are plain arrays, not Three Matrix4/Vector3 objects.
export function worldSceneValues(values, camera, jitter) {
  const model = new Matrix4().fromArray(values.model);
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
    frameUniforms:values, physicsOrigin:data.frame.physicsOrigin, params,
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
  const unused = app.gpu.device.createTexture({label:'world unused query packed binding',
    size:[1,1], format:'rgba32uint', usage:4|2});
  app.gpu.device.queue.writeTexture({texture:unused}, new Uint32Array([0,0,0x3f800000,0]), {}, [1,1]);
  const opaque = createWorldOpaqueCapture(app.gpu);
  // sourceGrid is taken from each actual cut's appearance, not Far.grid.
  const state = {data, noise, unused, opaque, volume:null, uses:new Set(), dead:false};
  try {await opaque.ready;} catch(error) {opaque.dispose();unused.destroy();throw error;}
  return state;
}
export async function prewarmWorldFrame(app, state, data, {view,detail={},curved=false}) {
  requireReady(!state.dead && data.tables?.buffer && data.sunTextures, 'pinned WORLD native inputs required');
  state.volume ??= createWorldVolume(app.gpu, {g:{nx:app.win.size[0],ny:app.win.size[1],nz:app.win.size[2],
    sourceAppearance:!!data.appearance}, atlas:state.data.atlas, tables:data.tables.buffer, appearance:data.appearance});
  await Promise.all([state.volume.viewReady(view,detail,curved), state.volume.pointReady,
    state.volume.signsReady, state.opaque.ready, app.post.sceneReady]);
}

// Real native point readback. Both feedback and all 80 output bytes belong to
// this exact native publication. No BOX probe or outside-window substitute.
export async function probeWorldFrameEye(app, state, data) {
  const {gpu} = app, native = nativeCandidate(state,data,data.frame.values,data.frame.params,state.unused.createView());
  const output = gpu.device.createBuffer({label:'world eye output',size:80,usage:128|4});
  const count = native.feedback.size/4;
  const combined = gpu.device.createBuffer({label:'world eye and complete feedback',size:native.feedback.size+80,usage:4|8});
  const provider = createWorldFeedbackProvider(gpu,{}), ticket = provider.reserve(gpu.frame);
  const pin = data.retain();
  let read, recordingError;
  try {
    requireReady(native.recordPointReady(gpu.frame,{position:data.frame.values.cam,output}), 'WORLD point pipeline not ready');
    const encoder = gpu.frame.direct();
    encoder.copyBufferToBuffer(native.feedback,0,combined,0,native.feedback.size);
    encoder.copyBufferToBuffer(output,0,combined,native.feedback.size,80);
  } catch(error) {recordingError=error;} finally {
    // Even partial encoding closes the real normal-Frame final boundary.
    read = ticket.record(gpu.frame,combined);
  }
  const result=read.then(words => {
    if(recordingError)throw recordingError;
    return Object.freeze({publication:native.publication, position:Object.freeze([...data.frame.values.cam]),
      words:new Float32Array(words.slice(count).buffer), feedback:native.decodeFeedback(words.subarray(0,count))});
  });
  // Register immediately: disposal also waits a blocked/unfinished read, not
  // merely already completed queries. Decode precedes native destruction.
  retireWorldUse(state,gpu,Promise.allSettled([ticket.submitted,result]),
    () => {native.release();output.destroy();combined.destroy();pin.release();});
  return result;
}
function retireWorldUse(state,gpu,submitted,release) {
  const done = Promise.resolve(submitted).catch(() => {}).then(() => gpu.device.queue.onSubmittedWorkDone()).finally(release);
  state.uses.add(done);done.then(() => state.uses.delete(done),() => state.uses.delete(done));
  return done;
}

/** Records real Three opaque -> pack -> full volume -> transparent -> overlays.
 * Caller supplies the real App threeMeshes/draw-overlay methods, not services
 * or readiness callbacks. Camera/actor pose and Post settings MUST already be
 * frozen by the main-frame scheduler. No pass contains async recording.
 */
export function recordWorldFrame(app, state, data, {camera, view, detail={}, curved=false,
  eye, identity, order, signRequest=null, dt=0}) {
  requireReady(!state.dead && app.win?.loaded && app.win.render===state.data, 'live WORLD main frame required');
  requireReady(['threeMeshes','drawWorldAfter','drawWorldOverlay'].every(k=>typeof app[k]==='function'),
    'actual App opaque/after/overlay functions must be connected before recording');
  requireReady(complete(eye.feedback) && eye.words.length===20 && eye.words[19]===1, 'complete native eye required before hands');
  requireReady(state.volume.pipelineState(view,detail,curved).state==='ready', 'prewarm WORLD view before recording');
  const values=data.frame.values, {gpu,post}=app;
  const worldLighting={publication:eye.publication,position:eye.position,
    frame:{identity,scene:data.frame.sceneVersion,epoch:data.identity.epoch,domain:'world',order,time:values.time,
      sunDirection:values.sun,sunColor:values.sunCol,keyLight:values.keyLight,
      settings:{exposure:post.settings.exposure,raw:post.settings.raw}},
    sample:{identity:eye,publication:eye.publication,frameIdentity:identity,position:eye.position,words:eye.words}};
  const hands=app.presentation.neutral(() => renderViewmodels(app.renderer,app.scene,camera,post,{worldLighting}));
  if (!hands?.ready) return null;
  const ticket=createWorldFeedbackProvider(gpu,{}).reserve(gpu.frame), feedbackIdentity=Object.freeze({identity});
  let native, context, signFrame, signOutput, sceneTicket, drew=false, submittedRead, combined, recordingError;
  const pin=data.retain(), postPublication=data.retain(), model=new Matrix4().fromArray(values.model);
  try {
    requireReady(!hands.images || hands.images.isCurrent(), 'viewmodel image replaced before Post copy');
    sceneTicket=post.recordScene({
      prepare(p) {
        const fv=worldSceneValues(values,camera,p.jitter);
        native=nativeCandidate(state,data,fv,worldSceneParams(data.frame.params,fv,p.inSize),p.sceneTarget.packedOpaque.createView());
        context=meshContext(app,state,data,native,fv,state.noise.texture);context.bind();
        requireReady(guardMeshes(app.scene,camera,{skip:o=>o.name==='pov-viewmodel',onReady:()=>app.requestRender()})===0,
          'native WORLD material graphs must be prewarmed before scene');
        if (signRequest) {
          signFrame=app.signs.captureWorldFrame({request:signRequest,camera,model,publication:native.publication,identity,
            presentation:{k:data.frame.params.warpK??0,anchor:data.frame.params.warpAnchor??[0,0],dir:data.frame.params.warpDir??[0,1]}});
          signOutput=gpu.device.createBuffer({label:'world frame signs',size:2048,usage:128|4});
          requireReady(native.recordSignsReady(gpu.frame,{camera:signFrame.camera,anchors:signRequest.anchors,cells:signRequest.cells,
            count:signRequest.count,presentation:signFrame.presentation,output:signOutput}), 'WORLD signs not ready');
        }
      },
      opaque(p) {drew=app.threeMeshes(p,false,camera);return drew;},
      capture(p) {requireReady(state.opaque.recordReady(gpu.frame,{color:p.sceneTarget.color,depth:p.sceneTarget.depth,
        output:p.sceneTarget.packedOpaque,drew,submitted:ticket.submitted}), 'WORLD opaque capture not ready');},
      draw(rp) {requireReady(native.recordDraw(rp,{view,detail,curved}), 'WORLD synchronous volume unavailable');app.drawWorldAfter(rp);},
      meshes(p) {app.threeMeshes(p,true,camera);},
      overlay:rp=>app.drawWorldOverlay(rp),
    },camera,{identity:data.identity,publication:postPublication,feedbackIdentity,submission:ticket,worldModel:model,
      dt,viewmodel:hands.viewmodel,glow:hands.glow});
    if (!sceneTicket) {postPublication.release();hands.lighting?.discard();}
  } catch(error) {
    hands.lighting?.discard();
    recordingError=error;
  } finally {
    if (native) {
      // Copy signs after ALL scene readers, then close ONE actual final suffix.
      const bytes=native.feedback.size+(signOutput?2048:0);
      combined=gpu.device.createBuffer({label:'world scene feedback and signs',size:bytes,usage:4|8});
      try {
        const encoder=gpu.frame.direct();encoder.copyBufferToBuffer(native.feedback,0,combined,0,native.feedback.size);
        if(signOutput)encoder.copyBufferToBuffer(signOutput,0,combined,native.feedback.size,2048);
      } catch(error) {recordingError??=error;} finally {
        submittedRead=ticket.record(gpu.frame,combined);

      }
    } else {
      // Even Post pool backpressure follows a VM draw. Close that suffix too.
      combined=gpu.device.createBuffer({label:'world unused final boundary',size:16,usage:4|8});
      submittedRead=ticket.record(gpu.frame,combined);
    }
  }
  let settleLastUse;
  const lastUse=new Promise(resolve=>{settleLastUse=resolve;});
  context?.retireAfter(lastUse).catch(()=>{});
  const retirement=retireWorldUse(state,gpu,lastUse,
    ()=>{native?.release();signOutput?.destroy();combined.destroy();pin.release();});
  const releaseAfter=submitted => {settleLastUse(submitted);return retirement;};
  if(recordingError || !sceneTicket) {
    releaseAfter(ticket.submitted);
    submittedRead.catch(()=>{});
    if(recordingError)throw recordingError;
    return null;
  }
  return {data,sceneTicket,feedbackIdentity,hands,native,signFrame,signRequest,
    submitted:ticket.submitted,releaseAfter,read:submittedRead};
}

// This gate executes against actual Post tickets. Only confirmed final pixels
// may advance data history, VM smoothing or DOM. A miss never calls TAA.
export async function finishWorldFrame(app, state, recorded, eyeFeedback) {
  const {data,sceneTicket,feedbackIdentity,hands,native,signFrame,signRequest}=recorded;
  let accepted=false, finalSubmission=recorded.submitted;
  try {
    const words=await recorded.read, count=native.feedback.size/4;
    const feedback=mergeWorldFrameFeedback(eyeFeedback,native.decodeFeedback(words.subarray(0,count)));
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
    accepted=await state.data.accept(data,{feedback,feedbackIdentity,postTicket:sceneTicket});
    if(accepted) {
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
export async function disposeWorldFrame(state) {
  state.dead=true;state.volume?.dispose();state.opaque.dispose();
  await Promise.allSettled([...state.uses]);state.unused.destroy();
}
