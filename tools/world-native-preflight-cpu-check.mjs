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
function fixture({tracked=true,validationError=null,diagnostics=null,validation=null,syncError=null}={}) {
  const creation=deferred(),queue=deferred(),scene=new Scene(),camera=new PerspectiveCamera();
  const mesh=new Mesh(new BoxGeometry(),new MeshBasicNodeMaterial());scene.add(mesh);
  let allocations=0,compilations=0;
  const backend=new WebGPUBackend(),scopeCalls=[],handle={nativeHandle:true},nativeQueue={};
  const device={
    get queue(){assert.equal(this,device);return nativeQueue;},
    createPipelineLayout(){assert.equal(this,device);assert.equal(this.queue,nativeQueue);return {};},
    pushErrorScope(kind){assert.equal(this,device);scopeCalls.push(['push',kind]);},
    popErrorScope(){assert.equal(this,device);scopeCalls.push(['pop']);return validation?.promise??Promise.resolve(validationError);},
    createRenderPipeline(){assert.equal(this,device);scopeCalls.push(['create']);allocations++;if(syncError)throw syncError;return handle;},
    createRenderPipelineAsync(){assert.equal(this,device);assert.equal(backend.device,device);allocations++;return creation.promise;},
  };
  backend.device=device;
  backend.utils={getCurrentColorFormat:()=> 'rgba16float',getCurrentDepthStencilFormat:()=> 'depth32float',getSampleCountRenderContext:()=>1,getPrimitiveTopology:()=> 'triangle-list'};
  backend.attributeUtils={createShaderVertexBuffers(){assert.equal(backend.device.queue,nativeQueue);return [];}};
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
  return {creation,queue,scene,camera,mesh,backend,pipelines,renderer,renderObject,device,nativeQueue,scopeCalls,handle,
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
test('sync-created cache hit waits existing validation; success reuses handle and one completion without recompilation',async()=>{
  const validation=deferred(),f=fixture({validation}),object=f.renderObject();
  const originalMethods={...Object.getOwnPropertyDescriptors(f.device)};
  const pipeline=f.pipelines.getForRender(object,null);
  assert.equal(pipeline instanceof Promise,false); // synchronous draw remains synchronous
  assert.equal(f.backend.device,f.device);assert.equal(f.device.queue,f.nativeQueue);
  assert.equal(f.backend.get(pipeline).pipeline,f.handle);
  assert.deepEqual(Object.getOwnPropertyDescriptors(f.device),originalMethods);
  assert.deepEqual(f.scopeCalls,[['push','validation'],['create'],['pop']]);
  const first=[],second=[];
  assert.equal(f.pipelines.getForRender(object,first),pipeline);
  assert.equal(f.pipelines.getForRender(f.renderObject(),second),pipeline);
  assert.equal(first.length,1);assert.equal(first[0],second[0]);
  let done=false;const prepared=prepareMesh(f.mesh,{rejectOnFailure:true}).then(()=>{done=true;});
  const pending=new Set();guardMeshes(f.scene,f.camera,{onPending:p=>pending.add(p)});
  await turn();assert.equal(done,false);assert.equal(f.mesh.layers.mask,PENDING_MASK);
  validation.resolve(null);await prepared;await Promise.all(pending);await Promise.all(first);
  assert.equal(guardMeshes(f.scene,f.camera),0);
  await prepareMesh(f.mesh,{rejectOnFailure:true});
  assert.equal(f.allocations,1);assert.equal(f.backend.get(pipeline).pipeline,f.handle);
  assert.equal(f.backend.get(pipeline).error,undefined);assert.equal(f.backend.device,f.device);
  assert.deepEqual(f.scopeCalls,[['push','validation'],['create'],['pop']]);f.dispose();
});
test('sync-created validation failure never certifies strict mesh; repeated cache hits retain rejected completion',async()=>{
  const validation=deferred(),f=fixture({validation}),object=f.renderObject();
  const pipeline=f.pipelines.getForRender(object,null),first=[],second=[];
  f.pipelines.getForRender(object,first);f.pipelines.getForRender(f.renderObject(),second);
  assert.equal(first[0],second[0]);assert.equal(f.backend.get(pipeline).pipeline,f.handle);
  const pending=new Set(),opts={onPending:p=>pending.add(p)};
  guardMeshes(f.scene,f.camera,opts);guardMeshes(f.scene,f.camera,opts);
  assert.equal(pending.size,1);const record=[...pending][0];
  const checked=assert.rejects(record,/native mesh pipeline unavailable/);
  let done=false;record.catch(()=>{done=true;});await turn();assert.equal(done,false);
  validation.resolve({message:'delayed sync validation failure'});await checked;
  assert.equal(f.backend.get(pipeline).error,true);
  const compilations=f.compilations;
  for(let i=0;i<3;i++)assert.equal(guardMeshes(f.scene,f.camera,opts),1);
  assert.equal(f.mesh.layers.mask,PENDING_MASK);assert.equal(pending.size,1);assert.equal([...pending][0],record);
  const third=[];f.pipelines.getForRender(object,third);assert.equal(third[0],first[0]);
  await assert.rejects(third[0],/native mesh pipeline unavailable/);
  assert.equal(f.compilations,compilations);assert.equal(f.allocations,1);assert.equal(f.backend.device,f.device);f.dispose();
});
test('sync-created validation failure preserves default warning/resolve semantics',async()=>{
  const validation=deferred(),f=fixture({validation}),mask=f.mesh.layers.mask;
  f.pipelines.getForRender(f.renderObject(),null);
  let ready=0;guardMeshes(f.scene,f.camera,{onReady:()=>ready++});
  await turn();assert.equal(ready,0);assert.equal(f.mesh.layers.mask,PENDING_MASK);
  validation.resolve({message:'default sync validation failure'});await turn();
  assert.equal(ready,1);assert.equal(f.mesh.layers.mask,mask);assert.equal(f.allocations,1);f.dispose();
});
test('sync native throw restores backend.device and preserves original scope order/throw identity',()=>{
  const failure=Error('synchronous native creation threw'),f=fixture({syncError:failure});
  const descriptor=Object.getOwnPropertyDescriptor(f.device,'createRenderPipeline');
  assert.throws(()=>f.pipelines.getForRender(f.renderObject(),null),e=>e===failure);
  assert.equal(f.backend.device,f.device);assert.equal(f.device.queue,f.nativeQueue);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.device,'createRenderPipeline'),descriptor);
  assert.deepEqual(f.scopeCalls,[['push','validation'],['create']]);f.dispose();
});
test('truly untracked cached handle is rejected rather than certified',async()=>{
  const validation=deferred(),f=fixture({tracked:false,validation}),object=f.renderObject();
  const pipeline=f.pipelines.getForRender(object,null);
  assert.equal(f.backend.get(pipeline).pipeline,f.handle);
  validation.resolve(null);await turn();trackNativeRenderPipelines(f.renderer);
  await assert.rejects(prepareMesh(f.mesh,{rejectOnFailure:true}),/no tracked completion/);
  const pending=new Set();assert.equal(guardMeshes(f.scene,f.camera,{onPending:p=>pending.add(p)}),1);
  await assert.rejects([...pending][0],/no tracked completion/);
  assert.equal(f.mesh.layers.mask,PENDING_MASK);assert.equal(f.allocations,1);f.dispose();
});
test('direct strict prepare rejects delayed sync validation without recording preparedWith',async()=>{
  const validation=deferred(),f=fixture({validation});
  f.pipelines.getForRender(f.renderObject(),null);
  const checked=assert.rejects(prepareMesh(f.mesh,{rejectOnFailure:true}),/native mesh pipeline unavailable/);
  validation.resolve({message:'direct strict sync validation failure'});await checked;
  // No previous guard record exists: a falsely recorded preparedWith would
  // make this first guard return zero rather than start/park strict work.
  const pending=new Set();assert.equal(guardMeshes(f.scene,f.camera,{onPending:p=>pending.add(p)}),1);
  await assert.rejects([...pending][0],/native mesh pipeline unavailable/);
  assert.equal(f.mesh.layers.mask,PENDING_MASK);assert.equal(f.allocations,1);f.dispose();
});
