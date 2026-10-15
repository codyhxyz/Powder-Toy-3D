import { E } from '../../src/elements.js';
import { LOOK } from '../../src/gfx/materials.js';
import { prelude,STATE_OPTS } from '../../src/shaders/common.js';
import { frameBindings } from '../../src/shaders/bindings.js';
import { uniformStruct } from '../../src/gpu/params.js';

const ProbeParams=uniformStruct('ProbeParams',{clipToGrid:'mat4x4f'});
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
  if(z<0.999999&&inGrid(cell)&&eid(fetchA(cell))==E_METAL){atomicAdd(&counts[7],1u);}
  if(z<0.999999&&inGrid(cell)&&cell.y>=35&&eid(fetchA(cell))==E_WATER){atomicAdd(&counts[8],1u);}
}`;

export async function run(a){
  const assert=(v,why)=>{if(!v)throw new Error(why);};
  a.test.park();a.settings.paused=true;a.settings.upscale='native';
  a.autoRes.enabled=false;a.autoRes.scale=1;
  a.day.fixed={az:215,el:38};
  const {gpu,hybrid,post}=a,V=a.THREE.Vector3;
  const steps=a.sim.frame;
  let inputs;
  const setter=post.setTemporalInputs;
  post.setTemporalInputs=function(v){inputs=v;return setter.call(this,v);};
  let counts;
  try{
    a.loadPreset('empty',false);
    const cube=(id,p,r)=>a.sim.paint({tool:id,center:new V(...p),radius:r,shape:1,rate:1,replace:true});
    for(const [id,p,r]of[
      [E.WALL,[44,20,65],7],[E.SAND,[64,15,65],8],[E.WOOD,[85,20,65],8],
      [E.WATER,[67,20,84],7],[E.GLASS,[45,20,84],5],[E.SMOKE,[85,25,84],5],
      [E.METAL,[64,37,70],5],[E.SAND,[57.5,34.5,82.5],.3],[E.WOOD,[61.5,34.5,82.5],.3],
      [E.WATER,[73.5,36.5,85.5],.3],[E.LAVA,[80,12,75],3],[E.FIRE,[85,33,83],2],
    ])cube(id,p,r);
    a.volume.updateMatrixWorld();
    const display=p=>new V(...p).applyMatrix4(a.volume.matrixWorld);
    a.camera.position.copy(display([64,52,122]));
    a.controls.target.copy(display([64,22,77]));
    a.camera.lookAt(a.controls.target);a.camera.updateMatrixWorld();
    await a.test.ready();await a.test.render();await gpu.readback.idle();
    assert(hybrid.enabled&&!gpu.failure,JSON.stringify(hybrid.stats));
    assert(a.sim.derived.particleSplit,'Derived must remove instanced cells from smooth fields');
    assert(hybrid.smooth.stats.requiredVertices>0&&!hybrid.smooth.stats.flags,'cached smooth vertices required');
    assert(hybrid.particles.stats.count>0&&!hybrid.particles.stats.overflow,'disjoint isolated instances required');
    assert(hybrid.particles.stats.droplets>0,'liquid droplets must be GPU-instanced, not left in fullscreen traversal');
    assert(hybrid.optics.stats.draws>0&&hybrid.media.stats.draws>0,'dedicated optics/media must actually record');
    assert(inputs?.motion&&inputs?.reactive&&hybrid.motion.stats.frames>1,'motion must reach real post frames');
    assert(LOOK[E.METAL].rough<.3,'fixture must exercise selective reflection gating');
    const builds=hybrid.geometry.stats.builds,shadows=hybrid.shadows.stats.reuses;
    await a.test.renderOnce();await gpu.readback.idle();
    assert(hybrid.geometry.stats.builds===builds,'camera-only draw must reuse opaque geometry');
    assert(hybrid.shadows.stats.reuses>shadows,'camera-only draw must reuse raster shadow');
    counts=gpu.createBuffer({label:'hybrid full probe',size:36,usage:128|4});
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
    const group=gpu.bindGroup(layout,[...textures.map((t,binding)=>({binding,resource:t.createView()})),
      {binding:7,resource:{buffer:counts}}]);
    const fu=gpu._frameUniforms.last;
    const inverse=new a.THREE.Matrix4().multiplyMatrices(fu.viewProj,fu.model).invert();
    probe.dispatch(gpu.frame,[Math.ceil(post.inSize[0]/8),Math.ceil(post.inSize[1]/8),1],
      {bind:[gpu._frameUniforms.group,a.sim.bindRO,group],header:a.sim.header(),params:{clipToGrid:inverse}});
    const read=gpu.readback.buffer(counts,0,36),gate=gpu.readback.buffer(hybrid.legacyIndirect.buffer,0,64);
    gpu.flush('hybrid full numerical readback');
    const [pixelBuffer,gateBuffer]=await Promise.all([read,gate]);
    const pixels=[...new Uint32Array(pixelBuffer)],acceptance=[...new Uint32Array(gateBuffer)];
    assert(pixels[0]===post.inSize[0]*post.inSize[1],'probe extent');
    assert(pixels[1]>0&&pixels[2]>0,'visible optical entry and smoke required');
    assert(pixels[3]>0&&pixels[5]>0,'both reusable motion and reactive pixels required');
    assert(pixels[4]===0&&pixels[6]===0,'no nonfinite HDR or routine optical fallback pixels');
    assert(pixels[7]>0,'glossy metal must be visible, not merely painted offscreen');
    assert(pixels[8]>0,'instanced optical droplet must write visible entry/depth pixels');
    assert(acceptance[0]===0&&acceptance[5]===1&&acceptance[9]===0,'normal hybrid scene must execute ZERO legacy volume instances');
    assert(acceptance[12]===6&&acceptance[13]===0,'normal hybrid scene must execute ZERO exceptional droplet instances');
    cube(-2,[44.5,20.5,65.5],1);
    await a.test.render();await gpu.readback.idle();
    assert(hybrid.geometry.stats.rebuiltBricks===0,'temperature-only edit must rebuild zero bricks');
    const stats=structuredClone(hybrid.stats);
    assert(a.sim.frame===steps,'rendering must not step physics');
    return{pixels,acceptance,stats,steps,sceneSize:post.inSize};
  }finally{
    a.test.park();post.setTemporalInputs=setter;
    gpu.flush('hybrid full cleanup');counts?.destroy();
  }
}
