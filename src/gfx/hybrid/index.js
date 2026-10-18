import { createHybridGeometry } from './geometry.js';
import { createHybridMaterials } from './materials.js';
import { createHybridShadows } from './shadows.js';
import { createHybridSmooth } from './smooth.js';
import { createHybridParticles } from './particles.js';
import { createHybridOptics } from './optics.js';
import { createHybridMedia,HybridMediaParams } from './media.js';
import { createHybridMotion } from './motion.js';
import { createHybridFrame } from './frame.js';
import { createHybridTemporal } from './temporal.js';
import { createHybridResolution } from './resolution.js';
import { createHybridShading,HybridControls } from './shading.js';
import { shadowReceiverWGSL,shadowModel } from '../../shaders/hybrid/shadows.js';
import { MEDIA_FIELD_LAYOUT,hybridMediaSegmentWGSL } from '../../shaders/hybrid/media.js';

// These are exceptional presentation/appearance fallbacks, not matter owners.
// Ordinary granular, organic, optical and gaseous matter NEVER selects legacy.
export function hybridEligibility({ sourceAppearance=false,decoration=false,view='realistic',
  warp=null,disabled=false,model }={}) {
  if(disabled)return 'disabled';
  if(sourceAppearance)return 'source artwork integration pending';
  if(decoration)return 'decoration integration pending';
  if(view!=='realistic'&&view!=='test')return 'non-realistic view';
  if(warp?.k)return 'curved presentation';
  if(model)try{shadowModel(model);}catch(e){return e.message;}
  return null;
}

/** Full hybrid scene owner. prepare precedes Derived; compose follows sky/meshes.
 * Only exceptional capacity failures issue the GPU-indirect legacy draw.
 * The particle field split and particle draws remain paired in that fallback.
 */
export function createHybridRenderer(gpu,sim,{post,invalidateCaches=()=>{},onRead,
  world=false,sourceAppearance=false}={}) {
  const frame=createHybridFrame(gpu,sim);
  const materials=createHybridMaterials(gpu,sim);
  const shadows=createHybridShadows(gpu,sim);
  const controls=gpu.uniforms(HybridControls,'hybrid rendering controls');
  const mediaUniforms=gpu.uniforms(HybridMediaParams,'hybrid refracted media');
  controls.write({reflectionSteps:32});
  const shade=(binding,options={})=>createHybridShading(gpu,sim,{materials,shadows,controls,binding,...options});
  const crispShader=shade(1,{gate:frame.gate});
  const geometry=createHybridGeometry(gpu,sim,{world,onRead,shader:{
    shadingWGSL:crispShader.wgsl,shade:'hybridOpaqueShade',layout:crispShader.layout,entries:crispShader.entries,
  }});
  const smoothShader=shade(4,{gate:frame.gate});
  const smooth=createHybridSmooth(gpu,sim,{onRead,shader:{
    wgsl:smoothShader.wgsl,layout:smoothShader.layout,bind:smoothShader.entries,handlesAppearance:true,
  }});
  const particleShader=shade(0,{reflections:false});
  const particleLayout=gpu.layout('HYBRID_PARTICLE_MATERIAL',particleShader.layout);
  const particleBind=gpu.bindGroup(particleLayout,particleShader.entries);
  const particles=createHybridParticles(gpu,sim,{world,shader:{
    wgsl:particleShader.wgsl,shadeState:true,layout:particleLayout,bind:particleBind,handlesAppearance:true,
  }});
  const mediaSun='fn hybridMediaSun(p:vec3f)->f32{return hybridSunVisibility(p,vec3f(0.0));}';
  const media=createHybridMedia(gpu,sim,{sun:{
    wgsl:shadowReceiverWGSL({group:1,binding:7})+'\n'+mediaSun,visibility:'hybridMediaSun',
    layout:shadows.bindingDescriptors({binding:7}),entries:()=>shadows.bindings({binding:7}),
    textures:()=>[shadows.resource.texture],
  }});
  const opticalShader=shade(2);
  const segmentWGSL=hybridMediaSegmentWGSL({fieldGroup:2,fieldBinding:16,
    paramsGroup:2,paramsBinding:23,declareFrame:false,declareHeader:false,
    sunWGSL:'',sunVisibility:'hybridMediaSun'});
  // Keep full transport out of the failing Metal fragment path. See docs/test-metal-validation.md.
  const optics=createHybridOptics(gpu,sim,{world,particles:particles.resources,fallbackGate:frame.gate,bulkCompute:true,lighting:{
    wgsl:opticalShader.wgsl+'\n'+mediaSun+'\n'+segmentWGSL,
    bindings:[...opticalShader.layout,...MEDIA_FIELD_LAYOUT.map(e=>({...e,binding:e.binding+16})),
      {binding:23,visibility:2,buffer:{type:'uniform'}}],
    entries:()=>[...opticalShader.entries,...media.segment({binding:16}).entries.filter(e=>e.binding<23),
      {binding:23,resource:{buffer:mediaUniforms.buffer}}],
    textures:()=>[shadows.resource.texture],
    hooks:{
      worldHit:`fn opticsWorldHit(h:OpticalHit)->vec3f{
        return hybridHitRadiance(h.id,h.state,h.position,h.normal,h.view);}`,
      environment:`fn opticsEnvironment(p:vec3f,d:vec3f,rough:f32)->vec3f{
        let env=skyColor(d);
        if(rough>=0.3||HC.reflectionSteps==0u){return env;}
        return hrTrace(p+d*0.04,d,env,HC.reflectionSteps);}`,
      body:`fn opticsBody(p:vec3f,id:i32)->vec3f{
        let up=vec3f(0,1,0);let probe=hybridSurfaceProbe(p,up);
        return (hybridProbeIrradiance(probe,up)+hybridSkyAmbient(up)*hybridProbeSkyVisibility(probe,up)
          +FU.sunCol*FU.sunExt*hybridMediaSun(p)+hybridGlow(p))*FU.lightGain;}`,
      mediaSegment:`fn opticsMediaSegment(ro:vec3f,rd:vec3f,a:f32,b:f32)->vec4f{
        return hybridMediaSegment(ro,rd,a,b);}`,
    },
  }});
  const motion=createHybridMotion(gpu,sim,{gate:frame.gate});
  const temporal=createHybridTemporal(post,{invalidateCaches});
  const resolution=createHybridResolution(post.settings);
  const producers=[geometry,materials,smooth,particles,optics,media,motion,frame];
  let ready=false,enabled=false,disposed=false,current={},lastDerived,lastBudget=32;
  let configuration='',historyRevision=post.historyRevision,origin='',lastSampleTime;
  let workload='',workloadEpoch=0;
  const submitted=new Map(),timing=gpu.timing,oldTiming=timing?.onFrame,wasTiming=timing?.enabled;
  let enabledTiming=false;
  const stats={reason:'not updated',producer:'complete hybrid scene',frames:0,compositions:0,legacyStills:0,
    geometry:geometry.stats,smooth:smooth.stats,particles:particles.stats,shadows:shadows.stats,
    optics:optics.stats,media:media.stats,motion:motion.stats};
  const resetResolution=()=>{
    resolution.reset(post.settings);submitted.clear();lastSampleTime=undefined;
    historyRevision=post.historyRevision;
  };
  // Compare a held camera and completed producer diagnostics, not simulation
  // version (which also changes for heat). Camera motion holds the last accepted
  // allocation; it cannot certify a cheaper trial against a different view.
  const workloadKey=f=>{
    const camera=f.camera;
    camera?.updateMatrixWorld();
    const matrix=m=>m?.elements?.map(v=>Math.round(v*1e5));
    return JSON.stringify([matrix(camera?.matrixWorld),camera?.fov,camera?.aspect,camera?.zoom,
      matrix(f.model),sim.paints,Boolean(f.paused),Boolean(f.externalAnimated),
      geometry.stats.rebuiltBricks,smooth.stats.count,particles.stats.count,particles.stats.droplets]);
  };
  const onTiming=sample=>{
    oldTiming?.(sample);
    const meta=submitted.get(sample.frame);
    submitted.delete(sample.frame);
    if(disposed||!meta||!sample.coverage?.complete)return;
    // Optical compute is isolated; other compute can mix physics/extraction.
    const passes=sample.passes.filter(p=>p.kind==='render'||
      (p.kind==='compute'&&optics.computePassName!=null&&p.name===optics.computePassName));
    if(!passes.length||passes.some(p=>!Number.isFinite(p.gpu)||p.gpu<0))return;
    const now=meta.now;
    if(lastSampleTime!==undefined&&now<=lastSampleTime)return;
    const dt=lastSampleTime===undefined?1/60:now-lastSampleTime;
    lastSampleTime=now;
    resolution.update({now,dt,sampleId:sample.frame,sampleGeneration:meta.generation,
      gpuMs:passes.reduce((s,p)=>s+p.gpu,0),paused:meta.paused,
      stable:meta.stable&&meta.epoch===workloadEpoch&&meta.workload===workloadKey(current)});
  };
  if(timing)timing.onFrame=onTiming;
  const reasonFor=f=>hybridEligibility({...f,sourceAppearance})||
    (!particles.guaranteedCapacity?'device cannot hold the isolated-particle bound':null);
  const api={
    ready:Promise.all([...producers.map(p=>p.ready),shadows.ready]).then(()=>{ready=true;return api;}),
    get isReady(){return !disposed&&ready&&producers.every(p=>p.isReady);},
    get enabled(){return enabled&&!disposed;},
    get legacyIndirect(){return api.enabled?frame.legacyIndirect:null;},
    stats,geometry,materials,shadows,smooth,particles,optics,media,motion,resolution,
    eligibility:reasonFor,
    /** Call before sim.updateBricks so the exact isolated-cell split is current. */
    prepare(f={}){
      const was=enabled;
      stats.reason=reasonFor(f)??(api.isReady?null:'pipelines pending');
      enabled=!stats.reason;
      current=f;
      const changed=sim.derived.setParticleSplit(enabled);
      if(was!==enabled){motion.invalidate();temporal.reset();resetResolution();}
      return changed;
    },
    /** App calls before its view key and before post sizes the scene. */
    adapt(f={}){
      if(disposed||reasonFor(f))return null;
      const key=JSON.stringify([post.settings.upscale,post.settings.floor,post.settings.adaptive,post.settings.taa,post.size]);
      if(key!==configuration||historyRevision!==post.historyRevision){
        configuration=key;resetResolution();
      }
      if(resolution.metrics.adaptive&&timing?.supported&&!timing.enabled){timing.enabled=true;enabledTiming=true;}
      return resolution.resolutionScale;
    },
    recover(){return resolution.recover();},
    wake(){if(resolution.metrics.resting)resetResolution();},
    update(f=current){
      if(!api.enabled)return false;
      current=f;
      const nextOrigin=`${sim.origin.x},${sim.origin.y},${sim.origin.z}`;
      if(nextOrigin!==origin||historyRevision!==post.historyRevision){
        origin=nextOrigin;motion.invalidate();resetResolution();lastDerived=undefined;
      }
      const budget=Math.max(4,Math.round(32*(resolution.scales.reflections/resolution.scales.surface/.5)**2));
      if(budget!==lastBudget){controls.write({reflectionSteps:budget});lastBudget=budget;}
      geometry.update(f);
      const revision=sim.derived.frameNo;
      smooth.update({revision,previousRevision:lastDerived,incremental:lastDerived!==undefined&&revision===lastDerived+1,
        particleSplit:true,sourceStyle:false});
      lastDerived=revision;
      particles.update({size:post.inSize,sourceStyle:false});
      frame.evaluate(geometry,smooth);
      shadows.update({sun:f.sun,casters:[geometry,smooth,particles],model:f.model,
        revision:`${geometry.revision}|${smooth.revision}|${particles.revision}`});
      optics.update({revision:sim.version});
      const key=workloadKey(f),stable=!!f.camera&&key===workload&&!f.externalAnimated;
      if(key!==workload){workload=key;workloadEpoch++;}
      if(timing?.enabled)submitted.set(gpu.frameNo+1,{generation:resolution.generation,now:performance.now()/1000,
        workload:key,epoch:workloadEpoch,stable,paused:!!f.paused});
      // Bound metadata even if timing gets disabled externally before completion.
      while(submitted.size>16)submitted.delete(submitted.keys().next().value);
      stats.frames++;
      return true;
    },
    drawOpaque(p,{load=false}={}){
      if(!api.enabled)return false;
      const rp=gpu.frame.render(p.sceneDescriptor({load}),'hybrid opaque surfaces and particles');
      try{geometry.drawOpaque(rp);smooth.draw(rp);particles.draw(rp);}finally{rp.end();}
      // Legacy fallback writes transmitting/gas depth. It must not become
      // the optical solver's opaque cut or hide particles behind that layer.
      frame.snapshot(p.sceneTarget.depth);
      return true;
    },
    /** After opaque scene + sky, before transparent scene meshes and post TAA. */
    compose(p){
      if(!api.enabled)return false;
      const depth=frame.opaqueDepth;
      if(!depth)throw new Error('hybrid composition requires an opaque scene draw');
      const input={color:p.sceneTarget.color,depth,scale:resolution.scales.media/resolution.scales.surface};
      media.update(input);
      mediaUniforms.write(media.segment().params);
      const optical=optics.record({...input,revision:sim.version});
      if(!optical)throw new Error('hybrid optics unavailable in an accepted frame');
      const color=media.record({...input,color:optical.color,opticalDepth:optical.metadata});
      if(!color)throw new Error('hybrid media unavailable in an accepted frame');
      frame.compose(p,color,optical.metadata);
      stats.compositions++;
      return true;
    },
    /** After transparent Three meshes too: their blended footprint has no motion. */
    temporalFrame(p,{camera,transparentMeshes=false,...f}={}){
      if(!api.enabled)return false;
      const revision=`${sim.version}|${sim.cur}|${sim.origin.x},${sim.origin.y},${sim.origin.z}`;
      const vectors=motion.record({depth:p.sceneTarget.depth,opticalDepth:optics.output.metadata,media:media.resources.media,
        camera,post:p,model:f.model??current.model,revision,fieldRevision:sim.derived.frameNo,
        externalAnimated:transparentMeshes||!!(f.externalAnimated??current.externalAnimated),world});
      temporal.update({revision:`${revision}|${sim.derived.frameNo}`,...vectors});
      return true;
    },
    /** Synchronous legacy thumbnail draw with complete fields, then restore ownership. */
    legacyStill(draw){
      const split=sim.derived.particleSplit;
      try{
        if(split){sim.derived.setParticleSplit(false);sim.updateBricks();}
        return draw();
      }
      finally{
        if(split){
          sim.derived.setParticleSplit(true);sim.updateBricks();lastDerived=undefined;
          motion.invalidate();temporal.reset();resetResolution();stats.legacyStills++;
        }
      }
    },
    dispose(){
      if(disposed)return;disposed=true;enabled=false;
      if(timing?.onFrame===onTiming)timing.onFrame=oldTiming;
      if(enabledTiming&&!wasTiming&&!timing.split)timing.enabled=false;
      sim.derived.setParticleSplit(false);
      temporal.dispose();for(const p of producers)p.dispose();
      shadows.dispose();controls.buffer.destroy();mediaUniforms.buffer.destroy();submitted.clear();
    },
  };
  return api;
}
