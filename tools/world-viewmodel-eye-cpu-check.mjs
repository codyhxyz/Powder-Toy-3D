// Actual pure lighting + actual viewmodel pass/guardMeshes with fake renderer.
// In-memory harness replaces only browser/model edges, never lighting or guard logic.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as THREE from 'three/webgpu';
import {captureWorldEye,createWorldEyeLighting,applyWorldEyeLighting,WorldEyeIncomplete} from '../src/pov/worldEyeLighting.js';
import {gfxUniforms} from '../src/gfx/uniforms.js';
import {guardMeshes,setMeshGpu,PENDING_MASK} from '../src/gfx/meshLight.js';
import {SH_Y0,SH_Y1} from '../src/shaders/gfx/lighting.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
function input(order=1, value=1, extra={}) {
  const publication=extra.publication??Object.freeze({epoch:1,generation:order});
  const frame={identity:{},scene:'scene',epoch:1,domain:'world',order,time:order*.1,sunDirection:[.2,.9,.1],sunColor:[2,3,4],keyLight:[.1,.2,.3],settings:{exposure:2,raw:true},...extra.frame};
  const position=extra.position??[50000,120,-60000];
  return {publication,position,frame,sample:{identity:{},publication,frameIdentity:frame.identity,position:[...position],words:[...Array.from({length:16},(_,i)=>value+i),.25,.5,.75,1],...extra.sample}};
}
test('all 16 point words preserved; original Three order and colored Sun basis applied once',()=>{
  const f=input(),t=createWorldEyeLighting(.3).stage(captureWorldEye(f));
  assert.deepEqual(t.bands,f.sample.words.slice(0,16));
  const sun=new THREE.DirectionalLight(),sky=new THREE.LightProbe();applyWorldEyeLighting(t,sun,sky);
  assert.deepEqual(sky.sh.coefficients.slice(0,4).map(v=>v.toArray()),[[1,2,3],[9,10,11],[13,14,15],[5,6,7]]);
  assert.deepEqual(sun.position.toArray(),f.frame.sunDirection);
  t.sunColor.forEach((v,i)=>near(v,[.05,.3,.9][i]));assert.equal(t.bands[15],16);
});
test('accepted-only easing, rejection, reversed callbacks, stale time/order; publication/origin never reset',()=>{
  const state=createWorldEyeLighting(.3),a=state.stage(captureWorldEye(input(1)));assert(a.commit());
  const rejected=state.stage(captureWorldEye(input(2,20)));rejected.discard();assert(!rejected.commit());
  const b=state.stage(captureWorldEye(input(3,30))),c=state.stage(captureWorldEye(input(4,40)));
  near(c.bands[0],1+(40-1)*(1-Math.exp(-.3/.3)));assert(c.commit());assert(!b.canCommit());assert(!b.commit());
  assert.throws(()=>state.stage(captureWorldEye(input(3))),WorldEyeIncomplete);
  const shifted=state.stage(captureWorldEye(input(5,80,{position:[-900000,40000,1]})));
  near(shifted.bands[0],c.bands[0]+(80-c.bands[0])*(1-Math.exp(-.1/.3)));
  const epoch=state.stage(captureWorldEye(input(6,90,{frame:{epoch:2}})));assert.equal(epoch.bands[0],90);epoch.discard();
  const domain=state.stage(captureWorldEye(input(7,100,{frame:{domain:'new-domain'}})));assert.equal(domain.bands[0],100);
  const older=state.stage(captureWorldEye(input(6,2)));assert(older.commit());assert(!domain.canCommit(),'must restage after another accepted baseline');
});
test('owned arrays/settings survive caller mutation while staged',()=>{
  const f=input(),t=createWorldEyeLighting(.3).stage(captureWorldEye(f));
  f.sample.words.fill(99);f.frame.sunColor.fill(99);f.frame.keyLight.fill(99);f.frame.sunDirection.fill(99);f.position.fill(99);f.frame.settings.exposure=99;
  assert.equal(t.bands[0],1);assert.deepEqual(t.frame.position,[50000,120,-60000]);assert.equal(t.frame.settings.exposure,2);near(t.sunColor[2],.9);assert(t.commit());
});
test('missing, malformed, incomplete and mismatched point metadata are explicit nonfatal signals',()=>{
  for(const mutate of [f=>f.sample=null,f=>f.sample.words.pop(),f=>f.sample.words[0]=NaN,f=>f.sample.words[1]=Infinity,f=>f.sample.words[19]=0,f=>f.sample.words[19]=-1,f=>f.sample.position[0]++,f=>f.sample.publication={},f=>f.sample.frameIdentity={},f=>f.frame.sunColor=[1],f=>f.frame.sunDirection=[0,0,0],f=>f.frame.time=NaN,f=>f.frame.order=-1,f=>f.frame.epoch=NaN,f=>{f.publication=1;f.sample.publication=1;}]) {
    const f=input();mutate(f);assert.throws(()=>captureWorldEye(f),e=>e.code==='WORLD_EYE_INCOMPLETE');
  }
});

let serial=0;
async function fixture({pending=false}={}) {
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();camera.position.set(50000,120,-60000);camera.updateMatrixWorld();
  const vm=new THREE.Group();vm.name='pov-viewmodel';scene.add(vm);
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshLambertMaterial());vm.add(mesh);
  const flameOverlay={exposure:{value:0},raw:{value:0}};
  const snapshots=[],promises=[];let draws=0,wakes=0,reads=0,current=null,alpha=1,clear=new THREE.Color(.2,.3,.4);
  const renderer={autoClear:false,getDrawingBufferSize:v=>v.set(8,4),getRenderTarget:()=>current,getClearAlpha:()=>alpha,getClearColor:v=>v.copy(clear),setClearColor:(c,a)=>{clear.set(c);alpha=a;},setRenderTarget:t=>{current=t;},render(s,c){draws++;snapshots.push({sun:s.children.find(o=>o.isDirectionalLight).color.toArray(),sh:s.children.find(o=>o.isLightProbe).sh.coefficients.slice(0,4).map(v=>v.toArray()),layer:c.layers.mask});}};
  const gpu={frameNo:7,three:{defaults:{scene,camera,target:null},renderer:{info:{calls:0}},prepare(){if(!pending)return Promise.resolve();return new Promise(resolve=>promises.push(resolve));}}};
  globalThis.__app={gpu,SUN:new THREE.Vector3(1,0,0),sim:{g:{nx:128,ny:128,nz:128},origin:{x:0,y:0,z:0}},volume:{worldToLocal:p=>p},derived:{readProbe(){reads++;return Promise.resolve(new Float32Array(16).fill(7));}},vol:{shadowState:'none'},requestRender(){wakes++;}};
  const deps={THREE,gfxUniforms,flameOverlay,guardMeshes,PENDING_MASK,useWebGPUCamera:x=>x,gpuTextureOf:(_,t)=>t};
  const key=`__worldEyeFixture${serial++}`;globalThis[key]=deps;
  const source=readFileSync(new URL('../src/pov/viewmodel.js',import.meta.url),'utf8').replace(/^import .* from '([^']+)';$/gm,(line,spec)=>{
    if(spec.endsWith('worldEyeLighting.js')||spec.endsWith('common.js')||spec.endsWith('gfx/lighting.js'))return line.replace(spec,new URL(spec,new URL('../src/pov/viewmodel.js',import.meta.url)).href);
    if(spec.endsWith('events.js'))return 'const povEvents={};';
    if(spec.endsWith('viewmodelArms.js'))return 'const updateViewmodelArms=()=>{};';
    if(spec.endsWith('flapPose.js'))return 'const createFlapAnimation=()=>{};';
    const names=spec==='three/webgpu'?['THREE']:spec.endsWith('uniforms.js')?['gfxUniforms']:spec.endsWith('flame.js')?['flameOverlay']:spec.endsWith('gpu/three.js')?['useWebGPUCamera','gpuTextureOf']:['guardMeshes','PENDING_MASK'];
    return `const {${names.join(',')}}=globalThis.${key};`;
  });
  const mod=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);delete globalThis[key];
  setMeshGpu(pending?gpu:null);
  return {scene,camera,vm,mesh,gpu,promises,flameOverlay,snapshots,get draws(){return draws;},get wakes(){return wakes;},get reads(){return reads;},draw:(f,post={settings:{exposure:99,raw:false}})=>mod.renderViewmodels(renderer,scene,camera,post,{worldLighting:f}),box:post=>mod.renderViewmodels(renderer,scene,camera,post)};
}
test('actual WORLD seam outside physics never reads BOX/hemisphere; frozen glow and Sun, cache publication/sample/camera identity',async()=>{
  const f=await fixture(),a=input();
  gfxUniforms.uSunCol.value=[90,90,90];gfxUniforms.uKeyLight.value=[90,90,90];
  const r=f.draw(a);assert.equal(r.ready,true);assert.equal(f.reads,0);assert.equal(f.draws,1);assert.equal(f.draw(a),r);
  assert.equal(f.flameOverlay.exposure.value,4);assert.equal(f.flameOverlay.raw.value,1);
  f.snapshots[0].sun.forEach((v,i)=>near(v,[.05,.3,.9][i]));assert.deepEqual(f.snapshots[0].sh[1],[9,10,11]);
  const b=input(2);assert(f.draw(b).ready);assert.equal(f.draws,2);assert(!r.images.isCurrent());
  b.sample.identity={};assert(f.draw(b).ready);assert.equal(f.draws,3);
  f.camera.position.x++;assert(f.draw(b).ready);assert.equal(f.draws,4);
  b.publication={epoch:1};b.sample.publication=b.publication;assert(f.draw(b).ready);assert.equal(f.draws,5);
  b.sample.words[19]=-1;assert.equal(f.draw(b).ready,false);assert.equal(f.draws,5);assert.equal(f.reads,0);
});
test('real guard pending blocks entire WORLD image, restores camera layer, wakes and retries without accepting easing',async()=>{
  const f=await fixture({pending:true}),a=input();f.mesh.userData.vmLayer=6;
  const r=f.draw(a);assert.equal(r.ready,false);assert.equal(f.draws,0);assert.equal(f.mesh.layers.mask,PENDING_MASK);assert.equal(f.mesh.visible,true);
  f.promises.splice(0).forEach(resolve=>resolve());await new Promise(resolve=>setImmediate(resolve));assert(f.wakes>0);
  const ready=f.draw(a); // Glow pass has a distinct target signature; guard may need one more compile.
  if(!ready.ready){f.promises.splice(0).forEach(resolve=>resolve());await new Promise(resolve=>setImmediate(resolve));}
  const final=f.draw(a);assert(final.ready);assert(final.lighting.commit());assert.equal(final.lighting.bands[0],1);setMeshGpu(null);
});
test('BOX default path retains local hemisphere arithmetic, scalar Sun, post settings and frame-only cache',async()=>{
  const f=await fixture();gfxUniforms.uSkyUp.value=[2,4,6];gfxUniforms.uGround.value=[1,2,3];gfxUniforms.uSunCol.value=[2,3,4];gfxUniforms.uKeyLight.value=[.1,.2,.3];
  const a=f.box({settings:{exposure:3,raw:false}});assert(a.viewmodel);assert.equal(a.ready,undefined);assert.equal(f.draws,1);assert.equal(f.reads,0);
  f.snapshots[0].sun.forEach((v,i)=>near(v,[.2,.6,1.2][i]));
  assert.equal(f.snapshots[0].sh[0][0],Math.fround(3/(2*SH_Y0)));assert.equal(f.snapshots[0].sh[1][0],Math.fround(3/(4*SH_Y1)));
  assert.equal(f.flameOverlay.exposure.value,8);assert.equal(f.flameOverlay.raw.value,0);assert.equal(f.box(),a);assert.equal(f.draws,1);
});
test('BOX local async probe and guard keep original partial-frame behavior',async()=>{
  const f=await fixture({pending:true});f.camera.position.set(5,5,5);f.camera.updateMatrixWorld();
  assert(f.box()?.viewmodel);assert.equal(f.draws,1);assert.equal(f.reads,1);assert.equal(f.mesh.layers.mask,PENDING_MASK);
  f.promises.splice(0).forEach(resolve=>resolve());await new Promise(resolve=>setImmediate(resolve));assert(f.wakes>0);setMeshGpu(null);
});
