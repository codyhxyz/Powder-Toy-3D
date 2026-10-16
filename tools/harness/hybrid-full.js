import { E,ELEMENTS } from '../../src/elements.js';
import { LOOK } from '../../src/gfx/materials.js';
import { prelude,STATE_OPTS } from '../../src/shaders/common.js';
import { frameBindings } from '../../src/shaders/bindings.js';
import { uniformStruct } from '../../src/gpu/params.js';
import { REFLECTION_DEFAULTS } from '../../src/shaders/hybrid/reflections.js';

const ProbeParams=uniformStruct('ProbeParams',{clipToGrid:'mat4x4f'});
export const GLOSSY_FIXTURE=E.CLONE; // roughness .25; ordinary METAL is .32
export function validateFixture(){
  const m=LOOK[GLOSSY_FIXTURE];
  if(!(m.metal>.5&&m.rough<REFLECTION_DEFAULTS.roughnessStop))
    throw new Error('Fixture must include a material inside the actual traced-reflection gate');
}
// Paint normally samples spawn density (water: 35%). Fixture cells must exist.
export const fixturePaintRate=id=>id>=0?2/ELEMENTS[id].spawn:1;
export async function resetFixture(a){
  // loadPreset queues its clear while Sim.ready is pending; do not paint before it.
  await a.test.ready();
  if(!a.loadPreset('empty',false))throw new Error('Could not load the empty fixture scene');
  await a.test.ready();
}
export async function checkedRead(gpu,label,record){
  gpu.device.pushErrorScope('validation');
  let pending;
  try{
    pending=Promise.resolve(record());pending.catch(()=>{});
    if(!gpu.flush(label))throw new Error(`${label}: readback recorded no submission`);
  }catch(error){
    await gpu.device.popErrorScope();throw error;
  }
  const error=await gpu.device.popErrorScope();
  if(error)throw new Error(`${label}: ${error.message}`);
  const data=await pending;
  if(gpu.failure)throw gpu.failure;
  return data;
}
const sentinelWords=Uint32Array.from({length:24},(_,i)=>
  [0x12345678,0xabcdef01,0x76543210,0xfedcba98][i%4]^(i/4|0));
const computeWords=sentinelWords.map(word=>word^0x55555555);
export const readbackSentinelWGSL=`@group(0) @binding(0) var<storage,read_write> data:array<u32>;
@compute @workgroup_size(1) fn main(){
${[...computeWords].map((word,i)=>`data[${i}]=${word}u;`).join('\n')}
}`;
export async function withFreshStaging(gpu,probe){
  const rb=gpu.readback,own=Object.getOwnPropertyDescriptor(rb,'_staging'),staging=rb._staging;
  rb._staging=function(...args){
    const pool=this.pool;this.pool=new Map();
    try{return staging.apply(this,args);}finally{this.pool=pool;}
  };
  try{return await probe();}
  finally{if(own)Object.defineProperty(rb,'_staging',own);else delete rb._staging;}
}
export async function verifyReadback(gpu){
  const buffer=gpu.createBuffer({label:'hybrid readback sentinel',size:sentinelWords.byteLength,usage:128|4|8});
  const read=()=>Promise.all(Array.from({length:6},(_,i)=>gpu.readback.buffer(buffer,i*16,16)));
  const verify=(kind,data,expected)=>{
    const actual=data.flatMap(bytes=>[...new Uint32Array(bytes)]);
    if(actual.length!==expected.length||actual.some((word,i)=>word!==expected[i]))
      throw new Error(`Readback ${kind} sentinel mismatch: expected ${JSON.stringify([...expected])}; received ${JSON.stringify(actual)}`);
    return actual;
  };
  try{
    const upload=verify('upload',await checkedRead(gpu,'hybrid uploaded readback sentinel',()=>{
      gpu.write(buffer,0,sentinelWords);return read();
    }),sentinelWords);
    const layout=gpu.layout('HYBRID_READBACK_SENTINEL',[{binding:0,visibility:4,buffer:{type:'storage'}}]);
    const kernel=gpu.kernel({name:'hybrid computed readback sentinel',code:readbackSentinelWGSL,
      layouts:[layout],workgroupSize:[1,1,1]});
    await kernel.ready;
    const group=gpu.bindGroup(layout,[{binding:0,resource:{buffer}}]);
    const compute=verify('compute',await checkedRead(gpu,'hybrid computed readback sentinel',()=>{
      kernel.dispatch(gpu.frame,[1,1,1],{bind:[group]});return read();
    }),computeWords);
    return{upload,compute};
  }finally{buffer.destroy();}
}
export function paintFixture(a){
  const V=a.THREE.Vector3;
  const cube=(id,p,r)=>a.sim.paint({tool:id,center:new V(...p),radius:r,shape:1,rate:fixturePaintRate(id),replace:true});
  for(const [id,p,r]of[
    [E.WALL,[44,20,65],7],[E.SAND,[64,15,65],8],[E.WOOD,[85,20,65],8],
    [E.WATER,[67,20,84],7],[E.GLASS,[45,20,84],5],[E.SMOKE,[85,25,84],5],
    [GLOSSY_FIXTURE,[64,37,70],5],[E.SAND,[57.5,34.5,82.5],.3],[E.WOOD,[61.5,34.5,82.5],.3],
    [E.WATER,[73.5,36.5,85.5],.3],[E.LAVA,[80,12,75],3],[E.FIRE,[85,33,83],2],
    [E.LAVA,[43.5,17.5,76.5],.3], // isolated emitter behind the glass slab
  ])cube(id,p,r);
  a.volume.updateMatrixWorld();
  const display=p=>new V(...p).applyMatrix4(a.volume.matrixWorld);
  a.camera.position.copy(display([64,52,122]));
  a.controls.target.copy(display([64,22,77]));
  a.camera.lookAt(a.controls.target);a.camera.updateMatrixWorld();
  return cube;
}
// A manual tick can request a cold detail pipeline without presenting a scene.
// Wait for those requests between attempts; this is not image convergence.
export async function renderCompleteFrames(a,frames=2){
  await a.test.ready();
  let complete=0;
  for(let attempts=1;attempts<=6;attempts++){
    const prior=a.hybrid,before=prior?{compositions:prior.stats.compositions,motion:prior.motion.stats.frames}:null;
    await a.test.renderOnce();
    await a.test.ready();
    const h=a.hybrid,selected=a.post?.temporalInputs;
    const fresh=!h||(h.enabled&&h.stats.compositions>(h===prior?before.compositions:0)
      &&h.motion.stats.frames>(h===prior?before.motion:0)&&selected?.motion&&selected?.reactive);
    complete=a.view.volumeDrawn&&fresh?complete+1:0;
    if(complete===frames)return attempts;
  }
  throw new Error('Fixture did not present the requested complete scenes within six attempts');
}
export async function sceneReadbackControl(a,mixed=false){
  a.test.park();a.settings.paused=true;a.settings.upscale='native';
  a.autoRes.enabled=false;a.autoRes.scale=1;
  a.day.fixed={az:215,el:38};
  await resetFixture(a);
  if(mixed)paintFixture(a);
  await a.test.ready();
  await a.gpu.fence();
  await verifyReadback(a.gpu);
  const steps=a.sim.frame;
  await renderCompleteFrames(a);await a.gpu.readback.idle();
  await verifyReadback(a.gpu);
  if(a.sim.frame!==steps)throw new Error('Readback control stepped physics');
  return{hybrid:!!a.hybrid?.enabled,frames:a.gpu.frameNo,size:a.post.inSize,steps};
}
export function watchFailures(page,report=console.error){
  const errors=[],offlineRelay=[];
  let reject;
  const failed=new Promise((_,no)=>{reject=no;});failed.catch(()=>{});
  const record=message=>{errors.push(message);report(message);reject(new Error(message));};
  page.on('pageerror',error=>record(error.message));
  page.on('console',message=>{
    const location=message.location().url??'',text=message.text();
    if(message.type()==='error'&&/net::ERR_CONNECTION_REFUSED/.test(text)&&/^http:\/\/127\.0\.0\.1:8787\//.test(location))offlineRelay.push(location);
    else if(message.type()==='error'||message.type()==='warning'&&/WebGPU|GPU (validation|internal)/.test(text))record(`${text} (${location})`);
  });
  return{errors,offlineRelay,check:promise=>errors.length?Promise.reject(new Error(errors[0])):Promise.race([promise,failed])};
}
export const forceOverflowWGSL=`@group(0) @binding(0) var<storage,read_write> status:array<u32>;
@compute @workgroup_size(1) fn main(){status[0]=1u;}`;
const producerLengths=[8,4,4,8,5,12];
export const producerProbeWGSL=`${producerLengths.map((n,i)=>`@group(0) @binding(${i}) var<storage,read> source${i}:array<u32>;`).join('\n')}
@group(0) @binding(6) var<storage,read_write> result:array<u32>;
@compute @workgroup_size(1) fn main(){
${producerLengths.map((n,i)=>`for(var j=0u;j<${n}u;j++){result[${producerLengths.slice(0,i).reduce((a,b)=>a+b,0)}u+j]=source${i}[j];}`).join('\n')}
}`;
export const probeWGSL=g=>`${prelude(g,STATE_OPTS.STATE_RO)}
${frameBindings()}
${ProbeParams.wgsl}
@group(3) @binding(1) var<uniform> P:ProbeParams;
@group(2) @binding(0) var color:texture_2d<f32>;
@group(2) @binding(1) var optical:texture_2d<f32>;
@group(2) @binding(2) var media:texture_2d<f32>;
@group(2) @binding(3) var motion:texture_2d<f32>;
@group(2) @binding(4) var reactive:texture_2d<f32>;
@group(2) @binding(5) var fallback:texture_2d<u32>;
@group(2) @binding(6) var depth:texture_depth_2d;
@group(2) @binding(7) var<storage,read_write> counts:array<atomic<u32>>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid:vec3u){
  let size=textureDimensions(color);
  if(any(gid.xy>=size)){return;}
  let p=vec2i(gid.xy);let uv=(vec2f(gid.xy)+0.5)/vec2f(size);
  atomicAdd(&counts[0],1u);
  if(textureLoad(optical,p,0).x<0.999999){atomicAdd(&counts[1],1u);}
  let m=min(vec2i(uv*vec2f(textureDimensions(media))),vec2i(textureDimensions(media))-1);
  if(textureLoad(media,m,0).a>0.001){atomicAdd(&counts[2],1u);}
  if(textureLoad(motion,p,0).z>0.5&&textureLoad(reactive,p,0).r<0.5){atomicAdd(&counts[3],1u);}
  if(!all(abs(textureLoad(color,p,0))<=vec4f(65504.0))){atomicAdd(&counts[4],1u);}
  if(textureLoad(reactive,p,0).r>0.5){atomicAdd(&counts[5],1u);}
  if(textureLoad(fallback,p,0).r!=0u){atomicAdd(&counts[6],1u);}
  let z=textureLoad(depth,p,0);
  let h=P.clipToGrid*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,z,1.0);
  let q=h.xyz/h.w;
  let cell=vec3i(floor(q+normalize(q-FU.cam)*0.02));
  if(z<0.999999&&inGrid(cell)&&eid(fetchA(cell))==${GLOSSY_FIXTURE}){atomicAdd(&counts[7],1u);}
  if(z<0.999999&&inGrid(cell)&&cell.y>=35&&eid(fetchA(cell))==E_WATER){atomicAdd(&counts[8],1u);}
  let rgb=textureLoad(color,p,0).rgb;
  if(z<0.999999&&inGrid(cell)&&eid(fetchA(cell))==E_GLASS&&rgb.r>2.0&&rgb.r>2.0*rgb.g){atomicAdd(&counts[9],1u);}
}`;

export async function run(a){
  const assert=(v,why)=>{if(!v)throw new Error(why);};
  const phase=message=>console.info(`[hybrid correctness] ${message}`);
  phase('mixed-scene setup');
  a.test.park();a.settings.paused=true;a.settings.upscale='native';
  a.autoRes.enabled=false;a.autoRes.scale=1;
  a.day.fixed={az:215,el:38};
  phase('awaiting startup and empty-scene clear');
  await resetFixture(a);
  const {gpu,hybrid,post}=a;
  const steps=a.sim.frame;
  let counts,producerCounts;
  try{
    const cube=paintFixture(a);
    phase('awaiting mixed-scene pipelines');
    await a.test.ready();
    phase('waiting for fixture upload before numerical rendering');
    await gpu.fence();
    await verifyReadback(gpu);
    phase('awaiting two complete numerical scenes (bounded cold-pipeline preparation, no convergence)');
    const preparationAttempts=await renderCompleteFrames(a);
    const builds=hybrid.geometry.stats.builds;
    await renderCompleteFrames(a,1);await gpu.readback.idle();
    phase('verifying known-value concurrent readback after scene rendering');
    try{await verifyReadback(gpu);}
    catch(error){
      let diagnostic;
      try{await withFreshStaging(gpu,()=>verifyReadback(gpu));diagnostic='passed';}
      catch(freshError){diagnostic=freshError.message;}
      throw new Error(`${error.message}\nFresh-staging diagnostic (original test still failed): ${diagnostic}`);
    }
    assert(hybrid.geometry.stats.builds===builds,'unchanged state must reuse opaque geometry');
    assert(hybrid.enabled&&!gpu.failure,JSON.stringify(hybrid.stats));
    const inputs=post.temporalInputs;
    const recorded=hybrid.motion.resources;
    assert(recorded?.motion===inputs.motion&&recorded?.reactive===inputs.reactive,'probe must use the recorded motion outputs');
    assert(recorded?.opticalDepth===hybrid.optics.output.metadata,'probe must use the motion pass optical input');
    const cells=(await checkedRead(gpu,'hybrid fixture cells',()=>
      Promise.all([[64,15,65],[85,20,65],[73,36,85]].map(p=>a.sim.readCell(...p))))).map(([A])=>[...A]);
    phase(`fixture cells ${JSON.stringify(cells)}; CPU smooth ${JSON.stringify(hybrid.smooth.stats)}`);
    const sourceBuffers=[hybrid.smooth.resources.status,hybrid.smooth.resources.args,hybrid.particles.resources.args,
      hybrid.particles.resources.opticalArgs,hybrid.geometry.resources.status,hybrid.legacyIndirect.buffer];
    const producerLayout=gpu.layout('HYBRID_FULL_PRODUCERS',[
      ...sourceBuffers.map((_,binding)=>({binding,visibility:4,buffer:{type:'read-only-storage'}})),
      {binding:6,visibility:4,buffer:{type:'storage'}},
    ]);
    producerCounts=gpu.createBuffer({label:'hybrid producer probe',size:164,usage:128|4});
    const producerProbe=gpu.kernel({name:'hybrid producer diagnostics',code:producerProbeWGSL,layouts:[producerLayout],workgroupSize:[1,1,1]});
    await producerProbe.ready;
    const producerGroup=gpu.bindGroup(producerLayout,[...sourceBuffers.map((buffer,binding)=>({binding,resource:{buffer}})),
      {binding:6,resource:{buffer:producerCounts}}]);
    const readProducers=async()=>{
      const data=await checkedRead(gpu,'hybrid producer diagnostics',()=>{
        producerProbe.dispatch(gpu.frame,[1,1,1],{bind:[producerGroup]});
        return gpu.readback.buffer(producerCounts,0,164);
      });
      const producerWords=new Uint32Array(data);
      let offset=0;
      return Object.fromEntries(['smooth','smoothArgs','particleArgs','opticalArgs','geometry','gate']
        .map((name,i)=>{const words=[...producerWords.slice(offset,offset+producerLengths[i])];offset+=producerLengths[i];return[name,words];}));
    };
    const producers=await readProducers();
    phase(`GPU producers ${JSON.stringify(producers)}`);
    assert(cells[0][0]===E.SAND&&cells[1][0]===E.WOOD&&cells[2][0]===E.WATER,'mixed-material fixture must exist in actual state');
    assert(a.sim.derived.particleSplit,'Derived must remove instanced cells from smooth fields');
    assert(producers.smooth[2]>0&&producers.smooth[0]===0&&producers.smoothArgs[0]>0,`cached smooth vertices required: ${JSON.stringify(producers)}`);
    assert(producers.particleArgs[1]>0,'disjoint isolated instances required');
    assert(producers.opticalArgs[1]>0,'liquid droplets must be GPU-instanced, not left in fullscreen traversal');
    assert(hybrid.optics.stats.draws>0&&hybrid.media.stats.draws>0,'dedicated optics/media must actually record');
    assert(inputs?.motion&&inputs?.reactive&&hybrid.motion.stats.frames>1,'motion must reach real post frames');
    // The fields are still converging. Native cache reuse has its own check;
    // another app tick here legitimately changes the smooth caster revision.
    assert(hybrid.shadows.stats.passes>0,'actual scene must record raster shadow casters');
    counts=gpu.createBuffer({label:'hybrid full probe',size:40,usage:128|4|8});
    const layout=gpu.layout('HYBRID_FULL_PROBE',[
      ...[0,1,2,3,4].map(binding=>({binding,visibility:4,texture:{sampleType:'unfilterable-float'}})),
      {binding:5,visibility:4,texture:{sampleType:'uint'}},
      {binding:6,visibility:4,texture:{sampleType:'depth'}},
      {binding:7,visibility:4,buffer:{type:'storage'}},
    ]);
    const probe=gpu.kernel({name:'hybrid full numerical probe',code:probeWGSL(a.sim.g),
      layouts:[gpu._frameUniforms.layout,a.sim.L.STATE_RO,layout],params:ProbeParams,workgroupSize:[8,8,1]});
    await probe.ready;
    const textures=[post.sceneTarget.color,hybrid.optics.output.metadata,hybrid.media.resources.media,
      inputs.motion,inputs.reactive,hybrid.optics.output.fallback,post.sceneTarget.depth];
    phase(`probe extents ${JSON.stringify(textures.map(t=>[t.width,t.height]))}`);
    assert(textures.every((t,i)=>i===2||t.width===post.inSize[0]&&t.height===post.inSize[1]),'full-resolution probe inputs must match the scene');
    const group=gpu.bindGroup(layout,[...textures.map((t,binding)=>({binding,resource:t.createView()})),
      {binding:7,resource:{buffer:counts}}]);
    const readPixels=async()=>{
      const fu=gpu._frameUniforms.last;
      const inverse=new a.THREE.Matrix4().multiplyMatrices(fu.viewProj,fu.model).invert();
      const [pixelBuffer,gateBuffer]=await checkedRead(gpu,'hybrid full numerical readback',()=>{
        gpu.frame.direct().clearBuffer(counts);
        probe.dispatch(gpu.frame,[Math.ceil(post.inSize[0]/8),Math.ceil(post.inSize[1]/8),1],
          {bind:[gpu._frameUniforms.group,a.sim.bindRO,group],header:a.sim.header(),params:{clipToGrid:inverse}});
        return Promise.all([gpu.readback.buffer(counts,0,40),gpu.readback.buffer(hybrid.legacyIndirect.buffer,0,48)]);
      });
      return{pixels:[...new Uint32Array(pixelBuffer)],acceptance:[...new Uint32Array(gateBuffer)]};
    };
    phase('reading mixed-scene pixels');
    const {pixels,acceptance}=await readPixels();
    phase(`mixed-scene pixel counters ${JSON.stringify(pixels)}; gate ${JSON.stringify(acceptance)}`);
    assert(pixels[0]===post.inSize[0]*post.inSize[1],'probe extent');
    assert(pixels[1]>0&&pixels[2]>0,'visible optical entry and smoke required');
    assert(pixels[3]>0&&pixels[5]>0,'both reusable motion and reactive pixels required');
    assert(pixels[4]===0&&pixels[6]===0,'no nonfinite HDR or routine optical fallback pixels');
    assert(pixels[7]>0,'glossy metal must be visible, not merely painted offscreen');
    assert(pixels[8]>0,'instanced optical droplet must write visible entry/depth pixels');
    assert(pixels[9]>0,'isolated molten emitter must be visible through the glass');
    assert(acceptance[0]===0&&acceptance[5]===1&&acceptance[9]===0,'normal hybrid scene must execute ZERO legacy volume instances');
    // Fault injection exercises the actual GPU predicate without changing
    // physics, shrinking production capacities, or trusting async diagnostics.
    const forceLayout=gpu.layout('HYBRID_FULL_FAULT',[{binding:0,visibility:4,buffer:{type:'storage'}}]);
    const force=gpu.kernel({name:'hybrid full injected capacity flag',code:forceOverflowWGSL,
      layouts:[forceLayout],workgroupSize:[1,1,1]});
    await force.ready;
    const forceGroup=gpu.bindGroup(forceLayout,[{binding:0,resource:{buffer:hybrid.smooth.resources.status}}]);
    const smoothUpdate=hybrid.smooth.update;
    let fallback;
    hybrid.smooth.update=function(...args){
      const result=smoothUpdate.apply(this,args);
      force.dispatch(gpu.frame,[1,1,1],{bind:[forceGroup]});
      return result;
    };
    try{
      phase('rendering forced-capacity fallback');
      await a.test.renderOnce();await gpu.readback.idle();
      fallback=await readPixels();
      assert(fallback.acceptance[0]!==0&&fallback.acceptance[9]===1,'fault must activate legacy background in the same frame');
      assert(fallback.pixels[8]>0&&fallback.pixels[9]>0,'fallback must retain front droplets AND molten matter transmitted through glass');
      assert(fallback.pixels[4]===0,'fallback HDR must remain finite');
    }finally{
      hybrid.smooth.update=smoothUpdate;hybrid.smooth.invalidate();
    }
    phase('temperature-only edit regression');
    cube(-2,[44.5,20.5,65.5],1);
    await a.test.renderOnce();await gpu.readback.idle();
    const heated=await readProducers();
    assert(heated.geometry[1]===0,'temperature-only edit must rebuild zero bricks');
    const stats=structuredClone(hybrid.stats);
    assert(a.sim.frame===steps,'rendering must not step physics');
    return{pixels,acceptance,fallback,stats,producers,heated,steps,sceneSize:post.inSize,preparationAttempts,numericalOnly:true};
  }finally{
    a.test.park();
    gpu.flush('hybrid full cleanup');counts?.destroy();producerCounts?.destroy();
  }
}
