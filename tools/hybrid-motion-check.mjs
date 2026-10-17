import assert from 'node:assert/strict';
import { Matrix4 } from 'three/webgpu';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { execFileSync,spawnSync } from 'node:child_process';
import { matchingParticleCell, createHybridMotion } from '../src/gfx/hybrid/motion.js';
import { motionWGSL, motionCaptureWGSL } from '../src/shaders/hybrid/motion.js';
import { gridDims } from '../src/shaders/common.js';
import { frameUniformsOf } from '../src/gfx/uniforms.js';

globalThis.GPUBufferUsage={STORAGE:0x80,COPY_DST:8};
const grid = gridDims({ nx:128,ny:128,nz:128 }), key = [10,123];
assert.deepEqual(matchingParticleCell([4,4,4],[128,128,128],key,q => q.join() === '3,4,4' ? key : [0,0]),[3,4,4]);
assert.equal(matchingParticleCell([4,4,4],[128,128,128],key,() => key),null,'ambiguous seed never invents motion');
assert.equal(matchingParticleCell([4,4,4],[128,128,128],key,() => [0,0]),null,'large jumps reject');
assert.deepEqual(matchingParticleCell([0,0,0],[128,128,128],key,q => q.join() === '0,0,0' ? key : [0,0]),[0,0,0]);
const semantic=spawnSync('naga',['--version'],{encoding:'utf8'}).status===0;
for (const code of [motionWGSL(grid),motionCaptureWGSL(grid)]) {
  new WgslReflect(code);
  if (semantic) execFileSync('naga',['--stdin-file-path','hybrid-motion.wgsl'],{input:code,encoding:'utf8'});
}
assert(motionWGSL(grid).indexOf('dpdx(z)') < motionWGSL(grid).indexOf('if (P.valid'),'derivatives precede divergent rejection');
const events=[],owned=[];
const resource = d => {
  const r={ ...d,width:d.size?.[0],height:d.size?.[1],destroy(){this.destroyed=true;},createView(){return {texture:r};} };
  owned.push(r); return r;
};
const pipeline = d => {
  new WgslReflect(d.code);
  return { state:'ready',ready:Promise.resolve(),draw(_rp,args){events.push(['draw',args]);},
    dispatch(_frame,_size,args){events.push(['capture',args]);} };
};
const gpu={
  layout:(_n,entries)=>({entries}),bindGroup:(layout,entries)=>({layout,entries}),
  createBuffer:resource,createTexture:resource,device:{},queue:{writeBuffer(){}},
  uniforms:()=>({buffer:resource({size:4096}),write(){}}),kernel:pipeline,renderPipeline:pipeline,
  flush(){events.push(['flush']);},
  frame:{encoder:{},render(){return {end(){events.push(['end']);}};},
    direct(){return {copyTextureToTexture(){events.push(['copy']);}};}},
};
const sim={id:1,g:grid,L:{TABLES:{},STATE_RO:{}},tables:{},bindRO:{},origin:{x:0,y:0,z:0},header:()=>({})};
frameUniformsOf(gpu).last.written=true;
const module=createHybridMotion(gpu,sim); await module.ready;
const depth=resource({size:[1280,800],format:'depth32float'});
const opticalDepth=resource({size:[1280,800],format:'rgba32float'});
const media=resource({size:[640,400],format:'rgba16float'});
const frame={depth,opticalDepth,media,model:new Matrix4(),
  camera:{projectionMatrix:new Matrix4(),matrixWorldInverse:new Matrix4()},
  post:{withoutJitter:fn=>fn()},revision:1};
const first=module.record(frame);
assert.deepEqual(module.resources,{...first,opticalDepth});
const inspected=module.resources;inspected.reactive=null;
assert.equal(module.resources.reactive,first.reactive,'inspection cannot replace recorded outputs');
assert.equal(first.motion.format,'rgba16float'); assert.equal(first.reactive.format,'r8unorm');
assert.equal(events.find(e=>e[0]==='draw')[1].params.valid,0);
assert.equal(module.stats.captures,1);
events.length=0;
module.record(frame);
assert.equal(events.find(e=>e[0]==='draw')[1].params.valid,1);
assert.equal(module.stats.captures,1,'camera-only frames do not scan state again');
frame.revision++; module.record(frame);
assert.equal(module.stats.captures,2);
assert.equal(events.some(e=>e[0]==='flush'),false,'record never submits or flushes');
sim.origin.x=16; events.length=0; module.record(frame);
assert.equal(events.find(e=>e[0]==='draw')[1].params.valid,0,'window shift rejects old identity coordinates');
const next={...frame,depth:resource({size:[640,400],format:'depth32float'}),opticalDepth:resource({size:[640,400],format:'rgba32float'})};
module.record(next);
assert.equal(first.motion.destroyed,undefined,'same-encoder resources retire only after submission');
gpu.frame.encoder={}; module.record(next);
assert.equal(first.motion.destroyed,true);
module.dispose(); module.dispose();
assert.equal(module.isReady,false);
assert.equal(module.resources,null,'disposed output inspection must not expose destroyed textures');
console.log(`PASS hybrid motion: exact/ambiguous particle identity, static camera/model recording, revision reuse, resize/shift rejection, deferred disposal and WGSL reflection; CPU only. Naga semantic validation ${semantic?'passed':'unavailable'}.`);
