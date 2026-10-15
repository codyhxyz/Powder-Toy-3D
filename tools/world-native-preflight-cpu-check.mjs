// CPU only: actual r186 Pipelines cache + WebGPUBackend/PipelineUtils;
// native device and renderer traversal are stubs, not a GPU rendering claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Scene, PerspectiveCamera, Mesh, BoxGeometry, MeshBasicNodeMaterial} from 'three/webgpu';
import Pipelines from 'three/src/renderers/common/Pipelines.js';
import WebGPUBackend from 'three/src/renderers/webgpu/WebGPUBackend.js';
import {trackNativeRenderPipelines} from '../src/gpu/three.js';
import {prepareMesh, guardMeshes, setMeshGpu, PENDING_MASK} from '../src/gfx/meshLight.js';
import {releaseWorldMeshPreflight} from '../src/wire/worldRenderFrame.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const turn=()=>new Promise(r=>setImmediate(r));
function fixture({tracked=true,validationError=null,diagnostics=null}={}) {
  const creation=deferred(),queue=deferred(),scene=new Scene(),camera=new PerspectiveCamera();
  const mesh=new Mesh(new BoxGeometry(),new MeshBasicNodeMaterial());scene.add(mesh);
  let allocations=0,compilations=0;
  const backend=new WebGPUBackend();
  backend.device={createPipelineLayout:()=>({}),pushErrorScope(){},popErrorScope:async()=>validationError,
    createRenderPipelineAsync(){allocations++;return creation.promise;}};
  backend.utils={getCurrentColorFormat:()=> 'rgba16float',getCurrentDepthStencilFormat:()=> 'depth32float',getSampleCountRenderContext:()=>1,getPrimitiveTopology:()=> 'triangle-list'};
  backend.attributeUtils={createShaderVertexBuffers:()=>[]};
  backend.createProgram=p=>{backend.get(p).module={module:{async getCompilationInfo(){await diagnostics?.promise;return {messages:[]};}}};};
  backend.getRenderCacheKey=()=> 'same-native-layout';backend.needsRenderUpdate=()=>false;
  const pipelines=new Pipelines(backend,{}, {createProgram(){},destroyProgram(){}});
  // Minimal RenderObject contract at the traversal boundary. All cache/stage/
  // native creation logic below is actual installed Three, not a facsimile.
  const renderObject=()=>({object:mesh,geometry:mesh.geometry,material:mesh.material,
    context:{textures:null,depth:false,stencil:false},getBindings:()=>[],
    getNodeBuilderState:()=>({vertexShader:'vertex',fragmentShader:'fragment'})});
  const renderer={backend,_pipelines:pipelines,info:{calls:0},async compileAsync(){
    compilations++;const pending=[];pipelines.getForRender(renderObject(),pending);await Promise.all(pending);
  }};
  if(tracked)trackNativeRenderPipelines(renderer);
  const gpu={three:{renderer,defaults:{scene,camera,target:null},prepare:()=>renderer.compileAsync()}};
  setMeshGpu(gpu);
  return {creation,queue,scene,camera,mesh,backend,pipelines,renderer,renderObject,
    get allocations(){return allocations;},get compilations(){return compilations;},
    dispose(){setMeshGpu(null);mesh.geometry.dispose();mesh.material.dispose();}};
}
test('baseline actual Three cache hit resolves before original native creation (regression reproduction)',async()=>{
  const f=fixture({tracked:false});const first=f.renderer.compileAsync();
  await f.renderer.compileAsync();assert.equal(f.allocations,1);
  f.creation.resolve({nativeHandle:true});await first;f.dispose();
});
test('concurrent cache hit awaits ORIGINAL native creation; only a real backend handle certifies preparedWith',async()=>{
  const f=fixture();let firstDone=false,secondDone=false;
  const first=prepareMesh(f.mesh,{rejectOnFailure:true}).then(()=>{firstDone=true;});
  const second=prepareMesh(f.mesh,{rejectOnFailure:true}).then(()=>{secondDone=true;});
  await turn();assert.equal(firstDone,false);assert.equal(secondDone,false);assert.equal(f.allocations,1);
  const handle={nativeHandle:true};f.creation.resolve(handle);await Promise.all([first,second]);
  assert.equal(f.backend.get([...f.pipelines.caches.values()][0]).pipeline,handle);
  assert.equal(guardMeshes(f.scene,f.camera),0);f.dispose();
});
test('actual backend swallows native rejection, strict preparation rejects actionable missing-handle error and never certifies mesh',async()=>{
  const f=fixture(),work=prepareMesh(f.mesh,{rejectOnFailure:true});
  const checked=assert.rejects(work,/native mesh pipeline unavailable.*WebGPUBackend may have swallowed/);
  f.creation.reject(Error('device native rejection'));await checked;
  const pending=[];assert.equal(guardMeshes(f.scene,f.camera,{onPending:p=>pending.push(p)}),1);
  await assert.rejects(pending[0],/native mesh pipeline unavailable/);
  assert.equal(f.mesh.layers.mask,PENDING_MASK);assert.equal(f.allocations,1);f.dispose();
});
test('default pending then strict upgrades record, retains same rejected promise without recompilation; default promise still warns/resolves',async()=>{
  const f=fixture(),legacy=prepareMesh(f.mesh);let ready=0;const pending=new Set();
  assert.equal(guardMeshes(f.scene,f.camera,{onReady:()=>ready++}),1);
  const strict={onPending:p=>pending.add(p)};
  guardMeshes(f.scene,f.camera,strict);guardMeshes(f.scene,f.camera,strict);
  assert.equal(pending.size,1);const original=[...pending][0];
  const checked=assert.rejects(original,/native mesh pipeline unavailable/);
  f.creation.reject(Error('native failure'));await legacy;await checked;
  const count=f.compilations;
  for(let i=0;i<3;i++)assert.equal(guardMeshes(f.scene,f.camera,strict),1);
  assert.equal([...pending][0],original);assert.equal(pending.size,1);
  assert.equal(f.compilations,count);assert.equal(f.allocations,1);assert.equal(ready,0);
  assert.equal(f.mesh.layers.mask,PENDING_MASK);f.dispose();
});
test('default-only guard preserves legacy warning/resolve and layer restoration',async()=>{
  const f=fixture();let ready=0;const mask=f.mesh.layers.mask;
  guardMeshes(f.scene,f.camera,{onReady:()=>ready++});f.creation.reject(Error('legacy native failure'));
  await turn();assert.equal(ready,1);assert.equal(f.mesh.layers.mask,mask);f.dispose();
});
test('repeated pending cache-hit preflight detach holds publication/context until native compile AND queue retire',async()=>{
  const f=fixture(),pending=new Set();let releases=0;
  const first=prepareMesh(f.mesh,{rejectOnFailure:true});
  const opts={onPending:p=>pending.add(p)};
  guardMeshes(f.scene,f.camera,opts);guardMeshes(f.scene,f.camera,opts);assert.equal(pending.size,1);
  const preflight={pending,context:{async retireAfter(){await f.queue.promise;releases++;}},native:{release(){releases++;}}};
  const retired=releaseWorldMeshPreflight({},preflight);await turn();assert.equal(releases,0);
  f.creation.resolve({nativeHandle:true});await first;await turn();assert.equal(releases,0);
  f.queue.resolve();await retired;assert.equal(releases,2);assert.equal(f.allocations,1);f.dispose();
});
test('actual backend validation error fails closed even when native handle exists',async()=>{
  const f=fixture({validationError:{message:'validation rejected'}}),work=prepareMesh(f.mesh,{rejectOnFailure:true});
  const checked=assert.rejects(work,/native mesh pipeline unavailable/);
  f.creation.resolve({nativeHandle:true});await checked;f.dispose();
});
test('unchanged RenderObject cache branch enrolls same native completion; bridge installation is idempotent',async()=>{
  const f=fixture(),object=f.renderObject(),first=[],second=[];
  trackNativeRenderPipelines(f.renderer);
  assert.equal(f.pipelines.getForRender(object,first),f.pipelines.getForRender(object,second));
  assert.equal(first.length,1);assert.equal(second.length,1);assert.equal(first[0],second[0]);
  let done=false;const wait=Promise.all(second).then(()=>{done=true;});await turn();assert.equal(done,false);
  f.creation.resolve({nativeHandle:true});await wait;assert.equal(f.allocations,1);f.dispose();
});
test('failed detach waits actual backend settlement (including diagnostics), then queue; never restores strict mesh',async()=>{
  const diagnostics=deferred(),f=fixture({diagnostics}),pending=new Set();let releases=0;
  guardMeshes(f.scene,f.camera,{onPending:p=>pending.add(p)});
  const checked=assert.rejects([...pending][0],/native mesh pipeline unavailable/);
  const retired=releaseWorldMeshPreflight({}, {pending,
    context:{async retireAfter(){await f.queue.promise;releases++;}},native:{release(){releases++;}}});
  f.creation.reject(Error('native failure'));await turn();assert.equal(releases,0);
  diagnostics.resolve();await checked;await turn();assert.equal(releases,0);
  assert.equal(f.mesh.layers.mask,PENDING_MASK);
  f.queue.resolve();await retired;assert.equal(releases,2);assert.equal(f.allocations,1);f.dispose();
});
