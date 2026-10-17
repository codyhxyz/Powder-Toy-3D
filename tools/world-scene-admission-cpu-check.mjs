// Actual Post + Three TAAU offset hooks, fake native GPU. No GPU execution.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {PerspectiveCamera,Matrix4,Vector3,Texture,DepthTexture,WebGPUCoordinateSystem} from 'three/webgpu';
import {texture as textureNode} from 'three/tsl';
import TAAUNode from 'three/addons/tsl/display/TAAUNode.js';
import {createPost} from '../src/gfx/post.js';
import {reserveTemporalJitter} from '../src/gpu/three.js';
import {frameUniformValues,writeFrameUniforms,worldModelMatrix,FrameUniformsStruct,gfxUniforms} from '../src/gfx/uniforms.js';
import {worldFrameValues} from '../src/gfx/worldVolume.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({limit=3}={}) {
  const events=[],textures=[],done=[],copies=[],resolved=[],draws=[];
  const texture=({label='',size=[64,32],format='rgba16float',usage=31}={})=>{
    const t={label,width:size[0],height:size[1],format,usage,dead:false,createView(){return{texture:t};},destroy(){t.dead=true;events.push(`destroy:${label}`);}};
    textures.push(t);return t;
  };
  const pipe=desc=>({state:'ready',ready:Promise.resolve(),draw(pass,args){assert.ok(!pass.closed);events.push(desc.name);draws.push({name:desc.name,params:args?.params?Object.fromEntries(Object.entries(args.params).map(([k,v])=>[k,v?.clone?v.clone():Array.isArray(v)?[...v]:v])):null});},dispatch(){events.push(desc.name);}});
  const queue={onSubmittedWorkDone(){const d=deferred();done.push(d);return d.promise;}};
  const gpu={queue,device:{queue,createSampler:()=>({})},layout:label=>({label}),renderPipeline:pipe,kernel:pipe,createTexture:texture,
    createBuffer:()=>({destroy(){events.push('destroy:buffer');}}),bindGroup:()=>({}),flush(){events.push('flush');},
    readback:{ring:()=>({buffer:{},next:()=>0,read:async()=>new ArrayBuffer(32)})},
    frame:{render(desc,name){events.push(`pass:${name}`);return{closed:false,end(){assert.ok(!this.closed);this.closed=true;events.push(`end:${name}`);}};},
      compute(name){events.push(`compute:${name}`);},direct(){return{copyTextureToTexture(a,b,size){assert.notEqual(a.texture,b.texture);copies.push({a,b,size});events.push('copy');}};}}};
  const presenter={canvas:{width:64,height:32},format:'rgba8unorm',hdrActive:false,texture:()=>texture({format:'rgba8unorm'}),attachment:()=>({})};
  const camera=new PerspectiveCamera();camera.coordinateSystem=WebGPUCoordinateSystem;camera.updateProjectionMatrix();camera.updateMatrixWorld();
  const node=new TAAUNode(textureNode(new Texture()),textureNode(new DepthTexture()),textureNode(new Texture()),camera);
  const temporal={currentWeight:.025,reserveJitter:(...args)=>reserveTemporalJitter(node,...args),jitter(){throw Error('must reserve, not legacy jitter');},
    inputs:()=>({velocity:texture(),color:texture()}),resolve(c){events.push('taa');resolved.push(c.matrixWorld.clone());return texture();},dispose(){events.push('dispose:temporal');node.dispose();}};
  const presentation={active:false,key:'flat',worldToScene:new Matrix4(),sceneToWorld:new Matrix4(),parameters:{k:0,anchor:[0,0],dir:[0,1]},dispose(){events.push('dispose:presentation');}};
  const post=createPost(gpu,{presenter,temporal,presentation,maxPendingScenes:limit});
  post.settings.adapt=false;post.settings.bloom=0;post.settings.meter=false;
  const identity={epoch:1,sceneToken:'scene',configVersion:1};
  function submission(){const d=deferred();return{submitted:d.promise,resolve:d.resolve,reject:d.reject};}
  function options(extra={}){let releases=0;const s=submission();return{identity,feedbackIdentity:{buffer:'feedback'},publication:{release(){releases++;},get releases(){return releases;}},submission:s,...extra};}
  function record(opts=options(),hooks={}){return{ticket:post.recordScene(hooks,camera,opts),opts};}
  async function submit(opts){opts.submission.resolve();await turn();}
  async function completeAll(){for(const d of done.splice(0))d.resolve();await turn();}
  function admit({ticket,opts},extra={}){const s=submission();const accepted=post.commitScene(ticket,{feedbackIdentity:opts.feedbackIdentity,feedback:{incomplete:false},submission:s,...extra});return{accepted,s};}
  return{post,gpu,presenter,camera,node,events,textures,copies,resolved,draws,identity,presentation,options,record,submit,completeAll,admit,submission};
}
test('WORLD opaque destination is lazy, per leased scene target, and survives rejected prefixes until reuse is safe',async()=>{
  const f=fixture({limit:1});await f.post.sceneReady;
  assert(!f.textures.some(t=>t.format==='rgba32uint'),'BOX/default allocates no world destination');
  let packed;
  const a=f.record(f.options(),{prepare(p){packed=p.sceneTarget.packedOpaque;assert.equal(p.sceneTarget.packedOpaque,packed);}});
  assert.equal(packed.format,'rgba32uint');assert.equal(packed.usage,13);assert.equal(packed.width,64);
  f.presenter.canvas.width=80;assert.equal(f.record().ticket,null);assert(!packed.dead);
  a.opts.submission.reject(new Error('discarded final scene after prefix'));await turn();
  assert(!packed.dead);await f.completeAll();
  let next;
  const b=f.record(f.options(),{prepare(p){next=p.sceneTarget.packedOpaque;}});
  assert(b.ticket);assert(packed.dead);assert.notEqual(next,packed);assert.equal(next.width,80);
  f.post.discardScene(b.ticket);await f.submit(b.opts);await f.completeAll();
  f.post.dispose();await turn();assert(next.dead);
});
test('frozen camera clones preserve TAA history only with their stable presentation camera identity',async()=>{
  for(const stable of [false,true]){
    const f=fixture();await f.post.sceneReady;f.post.settings.taa=true;
    for(let i=0;i<2;i++){
      const opts=f.options(stable?{cameraIdentity:f.camera}:{});
      const ticket=f.post.recordScene({},f.camera.clone(),opts);
      await f.submit(opts);const final=f.admit({ticket,opts});assert(final.accepted);
      final.s.resolve();await turn();await f.completeAll();
    }
    assert.equal(f.draws.filter(d=>d.name==='motion').at(-1).params.historyValid,stable);
    f.post.dispose();await f.completeAll();
  }
});
test('real TAAU reservation restores camera, original matrices, offset and committed index; acceptance alone advances',()=>{
  const f=fixture(),c=f.camera;
  c.setViewOffset(64,32,1,2,64,32);const p=c.projectionMatrix.clone(),view={...c.view};
  const original=f.node._originalProjectionMatrix.clone(),index=f.node._jitterIndex,offset=f.node._jitterOffset.value.clone();
  const sample=reserveTemporalJitter(f.node,c,64,32);assert.notDeepEqual(c.projectionMatrix.elements,p.elements);
  sample.restore();assert.deepEqual(c.projectionMatrix.elements,p.elements);assert.deepEqual(c.view,view);
  assert.equal(f.node._jitterIndex,index);assert.deepEqual(f.node._originalProjectionMatrix.elements,original.elements);assert.deepEqual(f.node._jitterOffset.value.toArray(),offset.toArray());
  sample.commit(c.clone());assert.equal(f.node._jitterIndex,index+1);assert.throws(()=>sample.commit(c),/already committed/);f.post.dispose();
});
test('rejected scenes record full synchronous order but never mutate committed TAA/history/presentation/callback state',async()=>{
  const f=fixture();await f.post.sceneReady;
  let callbacks=0;const opts=f.options({onCommit(){callbacks++;}}),p=f.camera.projectionMatrix.clone(),world=f.camera.matrixWorld.clone();
  const {ticket}=f.record(opts,Object.fromEntries(['prepare','compute','opaque','capture','draw','meshes','overlay'].map(k=>[k,()=>f.events.push(`hook:${k}`)])));
  assert.ok(ticket);assert.equal(typeof ticket.then,'undefined');
  assert.deepEqual(f.events.filter(e=>e.startsWith('hook:')),['hook:prepare','hook:compute','hook:opaque','hook:capture','hook:draw','hook:meshes','hook:overlay']);
  assert.ok(f.events.indexOf('hook:capture')<f.events.indexOf('pass:scene'));assert.ok(f.events.indexOf('end:scene')<f.events.indexOf('hook:meshes'));
  assert.equal(f.node._jitterIndex,0);assert.deepEqual(f.camera.projectionMatrix.elements,p.elements);assert.deepEqual(f.camera.matrixWorld.elements,world.elements);
  assert.equal(f.events.includes('taa'),false);assert.equal(f.events.some(e=>e.startsWith('composite')),false);assert.equal(callbacks,0);
  await f.submit(opts);const result=f.admit({ticket,opts},{feedback:{incomplete:true}});assert.equal(result.accepted,false);assert.equal(ticket.status,'discarded');
  assert.equal(f.node._jitterIndex,0);assert.equal(callbacks,0);assert.equal(opts.publication.releases,0);
  await f.completeAll();assert.equal(opts.publication.releases,1);assert.equal(await f.post.presentLast(),false);f.post.dispose();
});
test('accepted snapshots survive newer camera/physics; only monotonic complete tickets enter TAA and retained composite',async()=>{
  const f=fixture();await f.post.sceneReady;let callbacks=0;
  const a=f.record(f.options({onCommit(){callbacks++;}}));
  f.camera.position.x=12;f.camera.updateMatrixWorld();const b=f.record();
  f.camera.position.x=24;f.camera.updateMatrixWorld();
  await f.submit(a.opts);await f.submit(b.opts);
  const accepted=f.admit(b);assert.equal(accepted.accepted,true);assert.equal(f.node._jitterIndex,1);
  assert.equal(f.resolved[0].elements[12],12);assert.equal(f.camera.position.x,24);assert.equal(f.camera.matrixWorld.elements[12],24);
  assert.equal(f.admit(a).accepted,false);assert.equal(callbacks,0);assert.equal(f.node._jitterIndex,1);
  const taaCount=f.events.filter(e=>e==='taa').length;
  assert.equal(b.ticket.status,'admitted');assert.equal(f.post.presentLast(),false);
  accepted.s.resolve();assert.equal(await b.ticket.confirmation,true);
  const re=f.submission();assert.equal(f.post.presentLast({submission:re}),true);
  assert.equal(f.events.filter(e=>e==='taa').length,taaCount,'presentLast never resolves or meters again');
  assert.ok(f.events.includes('blit rgba8unorm'));
  assert.equal(b.opts.publication.releases,0);re.resolve();await turn();await f.completeAll();
  assert.equal(b.opts.publication.releases,1);f.post.dispose();await turn();
});
test('bounded target pool and copied viewmodel/glow stay pinned through final submitted use and queue completion',async()=>{
  const f=fixture({limit:1});await f.post.sceneReady;
  const vm=f.gpu.createTexture({label:'external vm'}),glow=f.gpu.createTexture({label:'external glow'});
  const a=f.record(f.options({viewmodel:vm,glow}));assert.equal(f.copies.length,2);
  const pinned=f.copies.map(c=>c.b.texture);assert.notEqual(pinned[0],vm);
  assert.equal(f.record().ticket,null);await f.submit(a.opts);const result=f.admit(a);assert.ok(result.accepted);
  await f.completeAll();assert.equal(a.opts.publication.releases,0);assert.ok(pinned.every(t=>!t.dead));assert.equal(f.record().ticket,null);
  result.s.resolve();await turn();await f.completeAll();assert.equal(a.opts.publication.releases,1);assert.ok(pinned.every(t=>t.dead));
  const b=f.record();assert.ok(b.ticket);f.post.discardScene(b.ticket);await f.submit(b.opts);await f.completeAll();f.post.dispose();await turn();
});
test('identity/reset/resize/disposal and discarded submissions reject late feedback without freeing queued references',async()=>{
  for(const change of ['identity','reset','resize','dispose','discarded-submit']) {
    const f=fixture();await f.post.sceneReady;const a=f.record();
    if(change==='identity')f.post.setSceneIdentity({...f.identity,epoch:2});
    if(change==='reset')f.post.reset();
    if(change==='resize')f.presenter.canvas.width++;
    if(change==='dispose')f.post.dispose();
    assert.equal(a.opts.publication.releases,0);
    if(change==='discarded-submit'){a.opts.submission.reject(new Error('encoder discarded'));await turn();}
    else await f.submit(a.opts);
    assert.equal(f.admit(a).accepted,false);
    assert.equal(f.events.includes('taa'),false);assert.equal(f.node._jitterIndex,0);
    await f.completeAll();assert.equal(a.opts.publication.releases,1);f.post.dispose();await turn();
  }
});
test('staged stills validate before tone mapping, skip temporal state, and asynchronous hooks are rejected before invocation',async()=>{
  const f=fixture();await f.post.sceneReady;
  let called=0;assert.throws(()=>f.record(f.options(),{draw:async()=>{called++;}}),/synchronous/);assert.equal(called,0);
  const target=f.gpu.createTexture({format:'rgba8unorm'}),opts=f.options();
  const t=f.post.recordStill({draw(){f.events.push('still draw');},compute(){throw Error('still must not derive');}},f.camera,target,opts);
  assert.ok(t);assert.equal(f.events.some(e=>e.startsWith('composite')),false);await f.submit(opts);
  const s=f.submission();assert.ok(f.post.commitStill(t,{feedbackIdentity:opts.feedbackIdentity,feedback:{incomplete:false},submission:s}));
  assert.ok(f.events.includes('composite rgba8unorm'));assert.equal(f.events.includes('taa'),false);assert.equal(f.node._jitterIndex,0);
  s.resolve();await turn();await f.completeAll();f.post.dispose();await turn();
});
test('a rejected scene after admission changes neither previous matrices nor last image; next accepted motion uses last accepted camera',async()=>{
  const f=fixture();await f.post.sceneReady;let callbacks=0;
  const a=f.record(f.options({onCommit(){callbacks++;}}));await f.submit(a.opts);const first=f.admit(a);assert.ok(first.accepted);assert.equal(callbacks,0);
  first.s.resolve();assert.equal(await a.ticket.confirmation,true);assert.equal(callbacks,1);await f.completeAll();
  const originalProjection=f.camera.projectionMatrix.clone();
  f.camera.position.x=.01;f.camera.updateMatrixWorld();const b=f.record();await f.submit(b.opts);
  assert.equal(f.admit(b,{feedback:{incomplete:true}}).accepted,false);assert.equal(f.node._jitterIndex,1);assert.equal(callbacks,1);
  const before=f.draws.filter(d=>d.name==='motion').length;
  f.camera.position.x=.02;f.camera.updateMatrixWorld();const c=f.record();await f.submit(c.opts);const result=f.admit(c);assert.ok(result.accepted);
  const motions=f.draws.filter(d=>d.name==='motion');assert.equal(motions.length,before+1);assert.equal(motions.at(-1).params.historyValid,true);
  const previous=new Matrix4().multiplyMatrices(originalProjection,new Matrix4());
  const cameraAtC=f.camera.clone();const sample=f.post.jitter;
  const aspect=cameraAtC.aspect;cameraAtC.setViewOffset(64,32,...sample,64,32);cameraAtC.aspect=aspect;cameraAtC.updateProjectionMatrix();
  const current=new Matrix4().multiplyMatrices(cameraAtC.projectionMatrix,cameraAtC.matrixWorldInverse);
  const expected=new Matrix4().multiplyMatrices(previous,current.invert());
  motions.at(-1).params.reproj.elements.forEach((n,i)=>assert.ok(Math.abs(n-expected.elements[i])<1e-10));
  assert.equal(f.node._jitterIndex,2);result.s.resolve();await turn();await f.completeAll();f.post.dispose();await turn();
});
test('partial native hook errors close the pass, restore jitter and retain orphan inputs through final completion',async()=>{
  const f=fixture();await f.post.sceneReady;const opts=f.options();
  assert.throws(()=>f.record(opts,{draw(){throw Error('partial record fixture');}}),/partial record/);
  assert.ok(f.events.includes('end:scene'));assert.equal(f.node._jitterIndex,0);assert.equal(f.events.includes('taa'),false);
  assert.equal(opts.publication.releases,0);await f.submit(opts);assert.equal(opts.publication.releases,0);
  await f.completeAll();assert.equal(opts.publication.releases,1);f.post.dispose();await turn();
});
test('discarded scene submissions retain copied images and publication pins until the automatic prefix finishes',async()=>{
  const f=fixture();await f.post.sceneReady;
  const a=f.record(f.options({viewmodel:f.gpu.createTexture()})),image=f.copies[0].b.texture;
  a.opts.submission.reject(new Error('final scene encoder discarded'));await turn();
  assert.equal(a.ticket.status,'failed');assert(f.gpu.queue);assert.equal(a.opts.publication.releases,0);
  assert.equal(image.dead,false);await f.completeAll();
  assert.equal(a.opts.publication.releases,1);assert.equal(image.dead,true);f.post.dispose();await turn();
});
test('final post rejection preserves the previous complete image, blocks dependent admission and invalidates tentative TAA',async()=>{
  const f=fixture();await f.post.sceneReady;let callbacks=0;
  const a=f.record(f.options({onCommit(){callbacks++;}}));await f.submit(a.opts);
  const first=f.admit(a);first.s.resolve();assert.equal(await a.ticket.confirmation,true);await f.completeAll();
  const oldImage=f.post.allTargets.at(-1);
  const b=f.record(f.options({onCommit(){callbacks+=100;}}));await f.submit(b.opts);const second=f.admit(b);
  assert(second.accepted);assert.equal(b.ticket.status,'admitted');assert.equal(f.post.allTargets.at(-1),oldImage);
  const c=f.record();await f.submit(c.opts);assert.equal(f.admit(c).accepted,false,'no TAA dependency on an unconfirmed final encoder');
  second.s.reject(new Error('final post encoder discarded'));assert.equal(await b.ticket.confirmation,false);
  assert.equal(b.ticket.status,'failed');assert.match(b.ticket.error.message,/discarded/);assert.equal(callbacks,1);
  assert.equal(f.post.allTargets.at(-1),oldImage);assert.equal(oldImage.dead,false);
  const show=f.submission();assert(f.post.presentLast({submission:show}));show.resolve();
  const retry=f.admit(c);assert(retry.accepted);
  assert.equal(f.draws.filter(d=>d.name==='motion').at(-1).params.historyValid,false);
  retry.s.resolve();assert.equal(await c.ticket.confirmation,true);await f.completeAll();
  assert.equal(b.opts.publication.releases,1);f.post.dispose();await turn();
});
test('old-epoch submission rejection cannot clear a new-epoch pending admission or its temporal history',async()=>{
  const f=fixture();await f.post.sceneReady;
  const a=f.record();await f.submit(a.opts);const old=f.admit(a);
  const identity={...f.identity,epoch:2};f.post.setSceneIdentity(identity);
  const b=f.record(f.options({identity}));await f.submit(b.opts);const fresh=f.admit(b);assert(fresh.accepted);
  old.s.reject(new Error('old epoch discarded'));assert.equal(await a.ticket.confirmation,false);
  const c=f.record(f.options({identity}));await f.submit(c.opts);assert.equal(f.admit(c).accepted,false);
  fresh.s.resolve();assert.equal(await b.ticket.confirmation,true);
  const next=f.admit(c);assert(next.accepted);assert.equal(f.draws.filter(d=>d.name==='motion').at(-1).params.historyValid,true);
  next.s.resolve();await c.ticket.confirmation;await f.completeAll();f.post.dispose();await turn();
});
test('a cache callback error does not discard a successfully submitted composite or its valid temporal history',async()=>{
  const f=fixture();await f.post.sceneReady;
  const a=f.record();await f.submit(a.opts);const first=f.admit(a);first.s.resolve();await a.ticket.confirmation;await f.completeAll();
  const callbackError=new Error('cache callback failure'),b=f.record(f.options({onCommit(){throw callbackError;}}));
  await f.submit(b.opts);const second=f.admit(b);second.s.resolve();
  assert.equal(await b.ticket.confirmation,true);assert.equal(b.ticket.status,'committed');
  assert.equal(b.ticket.error,undefined);assert.equal(b.ticket.callbackError,callbackError);
  const show=f.submission();assert(f.post.presentLast({submission:show}));show.resolve();
  const c=f.record();await f.submit(c.opts);const third=f.admit(c);assert(third.accepted);
  assert.equal(f.draws.filter(d=>d.name==='motion').at(-1).params.historyValid,true);
  third.s.resolve();await c.ticket.confirmation;await f.completeAll();f.post.dispose();await turn();
});
test('shared Post work remains resize-protected through reset, identity replacement and partial failure until queue completion',async()=>{
  for(const mode of ['reset','identity','partial-error']){
    const f=fixture();await f.post.sceneReady;
    const a=f.record();await f.submit(a.opts);let final;
    if(mode==='partial-error'){
      final=f.submission();const finish=f.post.finish;f.post.finish=()=>{throw new Error('partial post encoding');};
      assert.throws(()=>f.post.commitScene(a.ticket,{feedbackIdentity:a.opts.feedbackIdentity,feedback:{incomplete:false},submission:final}),/partial post/);
      f.post.finish=finish;assert.equal(a.ticket.status,'failed');
    }else final=f.admit(a).s;
    const identity=mode==='identity'?{...f.identity,epoch:2}:f.identity;
    if(mode==='identity')f.post.setSceneIdentity(identity);
    if(mode==='reset')f.post.reset();
    f.presenter.canvas.width=96;
    const b=f.record(f.options({identity}));await f.submit(b.opts);
    assert.equal(f.admit(b).accepted,false,`${mode}: unresolved final encoder still owns shared targets`);
    final.reject(new Error('discarded final encoder'));await turn();
    assert.equal(f.admit(b).accepted,false,`${mode}: rejected ticket still owns automatic prefixes`);
    await f.completeAll();
    const retry=f.admit(b);assert(retry.accepted,`${mode}: resize is available after old work finishes`);
    retry.s.resolve();await b.ticket.confirmation;await f.completeAll();f.post.dispose();await turn();
  }
});
test('WORLD admission clears prior immediate motion, but recording and rejection leave it alone',async()=>{
  const f=fixture();await f.post.sceneReady;f.post.setSceneIdentity(f.identity);
  const motion=f.gpu.createTexture({label:'prior hybrid motion'});
  f.post.settings.taa=false;
  f.post.render({prepare(post){post.setTemporalInputs({motion});}},f.camera);
  assert.equal(f.post.temporalInputs.motion,motion);
  f.post.settings.taa=true;
  const rejected=f.record();assert.equal(f.post.temporalInputs.motion,motion);
  await f.submit(rejected.opts);assert.equal(f.admit(rejected,{feedback:{incomplete:true}}).accepted,false);
  assert.equal(f.post.temporalInputs.motion,motion);
  const accepted=f.record();await f.submit(accepted.opts);motion.destroy();
  const result=f.admit(accepted);assert(result.accepted);
  assert.equal(f.post.temporalInputs.motion,null);
  assert.equal(f.draws.filter(d=>d.name==='motion').at(-1).params.explicitMotion,false);
  result.s.resolve();await accepted.ticket.confirmation;await f.completeAll();f.post.dispose();await f.completeAll();
});
test('BOX frame packing matches the pre-edit 2cafd380 byte fixture',()=>{
  const camera=new PerspectiveCamera(60,1.5,.25,4096);camera.coordinateSystem=WebGPUCoordinateSystem;
  camera.position.set(3,4,5);camera.updateProjectionMatrix();camera.updateMatrixWorld();
  const frame={camera,model:new Matrix4().makeTranslation(10,0,20),sun:new Vector3(1,0,0),shadowRes:512,time:1.25,view:0,jitter:[.25,-.125]};
  const bytes=FrameUniformsStruct.pack(frameUniformValues(frame));
  assert.equal(bytes.byteLength,1168);
  assert.equal(createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),'639ff16a95ada95d48d340b56115f7145a9b494a6ab1f1bd663a6c8e8ac979a2');
});
test('pure frame values own every mutable input; global model/camera and local lights convert exactly once',()=>{
  const camera=new PerspectiveCamera();camera.position.set(3,4,5);camera.updateMatrixWorld();
  const model=new Matrix4().makeTranslation(10,0,20),origin=[1536,0,512],sun=new Vector3(1,0,0);
  const global=worldModelMatrix(model,origin),values=frameUniformValues({camera,model:global,sun});
  assert.deepEqual(global.elements.slice(12,15),[-1526,0,-492]);assert.deepEqual(values.cam.toArray(),[1529,4,497]);
  const moved=worldFrameValues({...values,lampPos:[[1,2,3,4]],wandLightPosition:[[4,5,6,7]],digMin:[1,2,3,4],beacon:[9,8,7,6]},origin);
  assert.deepEqual(moved.lampPos[0],[1537,2,515,4]);assert.deepEqual(moved.digMin,[1537,2,515,4]);assert.deepEqual(moved.beacon,[9,8,7,6]);
  const bytes=FrameUniformsStruct.pack(values);sun.x=0;model.elements[12]=99;gfxUniforms.uLampPos.value[0]=99;
  assert.deepEqual(FrameUniformsStruct.pack(values),bytes);gfxUniforms.uLampPos.value[0]=0;
  let written;const last={viewProj:new Matrix4(),invViewProj:new Matrix4(),model:new Matrix4(),eye:new Vector3()};
  const gpu={_frameUniforms:{uniforms:{write(v){written=FrameUniformsStruct.pack(v);}},last}};
  const frame={camera,model:new Matrix4(),sun};const expected=FrameUniformsStruct.pack(frameUniformValues(frame));
  writeFrameUniforms(gpu,frame);assert.deepEqual(written,expected);assert.equal(last.written,true);
});
