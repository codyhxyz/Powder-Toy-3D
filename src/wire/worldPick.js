// Visual queries read the retained MAIN image, never data.current() or BOX.
import {Matrix4, Ray, Raycaster, Vector2} from 'three/webgpu';
import {createWorldFeedbackProvider} from '../gfx/worldLightingInputs.js';

export const worldPickNotReady = (code='WORLD_PICK_NOT_READY', extra={}) => ({ready:false,valid:false,code,...extra});

export function displayedWorldRay(displayed, ndc) {
  const caster=new Raycaster();
  caster.setFromCamera(new Vector2(...ndc),displayed.view.camera);
  return caster.ray.clone().applyMatrix4(new Matrix4().fromArray(displayed.view.values.model).invert());
}

// A legacy local visible ray is transported through the caller's camera into
// the frozen displayed camera. This preserves logical, unjittered ray semantics.
export function transportWorldRay(displayed, ro, rd, localModel, camera) {
  const ray=new Ray(ro.clone(),rd.clone()).applyMatrix4(localModel)
    .applyMatrix4(camera.matrixWorldInverse).applyMatrix4(displayed.view.camera.matrixWorld);
  return ray.applyMatrix4(new Matrix4().fromArray(displayed.view.values.model).invert());
}

export function queryWorldPick(app,state,displayed,{ray,skipLiquids=false},isCurrent,queueDemand) {
  if(!displayed || state.dead)return Promise.resolve(worldPickNotReady());
  // Every argument and the publication pin is captured BEFORE compilation.
  const pin=displayed.data.retain(),data=displayed.data,view=displayed.view;
  const warp=structuredClone(view.presentation.parameters);
  const params={ro:[[...ray.origin.toArray(),warp.k??0]],rd:[[...ray.direction.toArray(),skipLiquids?1:0]],
    warp:[[...warp.anchor,...warp.dir]],slot:[[0,0,0,0],[0,0,0,0]],n:1};
  let native,output,combined,submitted=Promise.resolve();
  const work=(async()=>{
    await state.volume.pickPipelineState(view.view).ready;
    // A full page pool took the displayed snapshot's replaced pages back
    // (world/renderAtlas.js reclaim): obsolete, as a newer frame would make it.
    if(state.dead || !isCurrent(displayed) || data.snapshot.expired)return worldPickNotReady('WORLD_PICK_OBSOLETE');
    native=state.volume.prepare({snapshot:data.snapshot.retain(),tableBuffer:data.tables.buffer,appearance:data.appearance,
      frameUniforms:{...data.frame.values,...view.values},physicsOrigin:data.frame.physicsOrigin,
      params:{...data.frame.params,...view.params},lighting:data.lighting,
      external:{...data.frame.external,packedMesh:state.unused.createView()}});
    const {gpu}=app,ticket=createWorldFeedbackProvider(gpu,{}).reserve(gpu.frame);
    submitted=ticket.submitted;
    let error,read;
    try {
      output=gpu.device.createBuffer({label:'WORLD visual pick output',size:32,usage:128|4});
      combined=gpu.device.createBuffer({label:'WORLD visual pick whole feedback and output',size:native.feedback.size+32,usage:4|8});
      if(!native.recordPickReady(gpu.frame,{params,output,view:view.view}))throw Error('WORLD pick pipeline unavailable');
      // V2's flying matter (a V1 flying cell is a cell the march finds), as the Box pick finds it
      // (gfx/volume.js recordPicks): the nearer of the two, in world cells (shift: the window's origin)
      const sim=app.sim,o=sim?.origin;
      if(o)sim.compact?.dynamics?.drawAdapter?.recordPick?.(gpu.frame,{ring:output,ro:params.ro,rd:params.rd,slot:params.slot,n:1,
        origin:o,shift:[o.x,o.y,o.z],transient:true});
      const encoder=gpu.frame.direct();
      encoder.copyBufferToBuffer(native.feedback,0,combined,0,native.feedback.size);
      encoder.copyBufferToBuffer(output,0,combined,native.feedback.size,32);
    } catch(e){error=e;} finally {read=ticket.record(gpu.frame,combined??state.boundary);}
    const words=await read;if(error)throw error;
    const feedback=native.decodeFeedback(words.subarray(0,native.feedback.size/4));
    if(state.dead || !isCurrent(displayed))return worldPickNotReady('WORLD_PICK_OBSOLETE');
    // Raw picks do not read Sun. Never reapply old basis indices to a new cut.
    if(feedback.sun.length)throw Object.assign(Error('unexpected WORLD raw pick Sun dependency'),{code:'WORLD_PICK_UNEXPECTED_SUN'});
    const raw=new Float32Array(words.slice(native.feedback.size/4).buffer);
    if(feedback.incomplete || feedback.requirements.length || raw[3]===-2){
      queueDemand(feedback,displayed);
      return worldPickNotReady('WORLD_PICK_INCOMPLETE',{frameIdentity:displayed.frameIdentity,feedback});
    }
    return {ready:true,valid:raw[3]>=0,cell:[raw[0],raw[1],raw[2]],face:raw[3],id:Math.round(raw[4]),T:raw[5],P:raw[6],life:raw[7],raw,
      frameIdentity:displayed.frameIdentity,publication:native.publication};
  })();
  // Register NOW, including compilation, rejection and unfinished readback.
  const retirement=work.catch(()=>{}).then(()=>Promise.allSettled([submitted]))
    .then(()=>app.gpu.device.queue.onSubmittedWorkDone()).finally(()=>{
      native?.release();output?.destroy();combined?.destroy();pin.release();
    });
  state.uses.add(retirement);retirement.then(()=>state.uses.delete(retirement),()=>state.uses.delete(retirement));
  return work;
}

// Keep global visual validity separate from the current physical editing ABI.
export function localWorldHover(hover,origin,inWindow,isCurrent) {
  if(!hover.globalCell)return hover.valid;
  if(!isCurrent(hover.frameIdentity)){hover.valid=false;return false;}
  hover.cell.copy(hover.globalCell).sub(origin);
  return hover.valid && inWindow(hover.cell);
}
