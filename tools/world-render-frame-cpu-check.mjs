// Actual Post + Three TAAU offset hooks, fake native GPU. No GPU execution.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {PerspectiveCamera,Matrix4,Vector3,Texture,DepthTexture,WebGPUCoordinateSystem} from 'three/webgpu';
import {texture as textureNode} from 'three/tsl';
import TAAUNode from 'three/addons/tsl/display/TAAUNode.js';
import {finishWorldFrame,worldSceneValues,worldSceneParams,mergeWorldFrameFeedback} from '../src/wire/worldRenderFrame.js';
import {createPost} from '../src/gfx/post.js';
import {reserveTemporalJitter} from '../src/gpu/three.js';
import {frameUniformValues,writeFrameUniforms,worldModelMatrix,FrameUniformsStruct,gfxUniforms} from '../src/gfx/uniforms.js';
import {worldFrameValues} from '../src/gfx/worldVolume.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
export function fixture({limit=3,pipeGates=null}={}) {
  const events=[],textures=[],done=[],copies=[],resolved=[],draws=[];
  const texture=({label='',size=[64,32],format='rgba16float',usage=31}={})=>{
    const t={label,width:size[0],height:size[1],format,usage,dead:false,createView(){return{texture:t};},destroy(){t.dead=true;events.push(`destroy:${label}`);}};
    textures.push(t);return t;
  };
  const pipe=desc=>{const ready=pipeGates?deferred():null,leaf=pipeGates?deferred():null;if(pipeGates)pipeGates.push({ready,leaf});
    return {state:'ready',ready:ready?.promise??Promise.resolve(),compilationSettled:leaf?.promise??Promise.resolve(),draw(pass,args){assert.ok(!pass.closed);events.push(desc.name);draws.push({name:desc.name,params:args?.params?Object.fromEntries(Object.entries(args.params).map(([k,v])=>[k,v?.clone?v.clone():Array.isArray(v)?[...v]:v])):null});},dispatch(){events.push(desc.name);}};};
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

test('actual Post readiness rejection does not settle unfinished native sibling compilation',async()=>{
  const gates=[],f=fixture({pipeGates:gates});let drained=false;
  const ready=f.post.sceneReady,settled=f.post.sceneSettled.then(()=>{drained=true;});
  gates[0].ready.reject(Error('Post pipeline failed'));await assert.rejects(ready,/Post pipeline failed/);
  for(const gate of gates.slice(1))gate.ready.resolve();await turn();assert.equal(drained,false);
  for(const gate of gates.slice(0,-1))gate.leaf.resolve();await turn();assert.equal(drained,false);
  gates.at(-1).leaf.resolve();await settled;assert(drained);f.post.dispose();await f.completeAll();
});

test('frame values use actual jittered camera while preserving frozen settings/coordinates',()=>{
  const c=new PerspectiveCamera(65,2,.1,500);c.position.set(12,18,30);c.updateMatrixWorld();
  const model=new Matrix4().makeTranslation(-40,0,-80);
  const initial=frameUniformValues({camera:c,model,time:23,sourceAppearance:[2,3,4,5]});
  const values=Object.fromEntries(Object.entries(initial).map(([k,v])=>[k,v?.elements?Array.from(v.elements):v?.toArray?v.toArray():v]));
  c.setViewOffset(100,50,.3,-.2,100,50);
  const fv=worldSceneValues(values,c,[.3,-.2]);
  assert.notDeepEqual(fv.viewProj,values.viewProj);assert.deepEqual(fv.cam,values.cam);
  assert.equal(fv.time,23);assert.equal(fv.sunCol,values.sunCol);assert.equal(fv.sourceAppearance,values.sourceAppearance);
  const p=worldSceneParams({deco:1},fv,[100,50]);
  const product=new Matrix4().fromArray(fv.viewProj).multiply(model).multiply(new Matrix4().fromArray(p.meshInv));
  product.elements.forEach((n,i)=>assert.ok(Math.abs(n-(i%5===0?1:0))<1e-9));
  assert.deepEqual(p.meshRes,[100,50]);assert.equal(p.meshCut,1);
});
test('typed frame feedback preserves all channel/Sun misses',()=>{
  const a={incomplete:true,requirements:[{index:4,brick:[0,1,0],channels:1}],sun:[3]};
  const b={incomplete:true,requirements:[{index:4,brick:[0,1,0],channels:8}],sun:[3,6]};
  assert.deepEqual(mergeWorldFrameFeedback(a,b),{incomplete:true,requirements:[{index:4,brick:[0,1,0],channels:9}],sun:[3,6]});
});
test('actual staged Post: scene/point/sign misses discard before TAA and data acceptance',async()=>{
  const f=fixture();await f.post.sceneReady;
  for(const kind of ['scene','point','sign']) {
    const item=f.record();await f.submit(item.opts);
    const complete={incomplete:false,requirements:[],sun:[]};
    const missing={incomplete:true,requirements:[{index:1,channels:1}],sun:[]};
    let released=0,discarded=0;
    const recorded={data:{},sceneTicket:item.ticket,feedbackIdentity:item.opts.feedbackIdentity,
      hands:{lighting:{discard(){discarded++;},canCommit(){return true;}}},
      native:{feedback:{size:4},decodeFeedback:()=>kind==='scene'?missing:complete,publication:{}},
      signRequest:kind==='sign'?{count:1}:null,
      read:Promise.resolve(new Uint32Array(1+(kind==='sign'?8:0))),
      submitted:item.opts.submission.submitted,releaseAfter:async()=>{released++;}};
    const result=await finishWorldFrame({post:f.post,gpu:f.gpu},
      {data:{accept(){assert.fail('miss cannot accept');}}},recorded,kind==='point'?missing:complete);
    assert.equal(result.accepted,false);assert.equal(item.ticket.status,'discarded');
    assert.equal(released,1);assert.equal(discarded,1);assert.ok(!f.events.includes('taa'));
  }
  await f.completeAll();f.post.dispose();await f.completeAll();
});
test('actual Post final normal ticket confirms before owner/hands commit',async()=>{
  const f=fixture();await f.post.sceneReady;
  const item=f.record();await f.submit(item.opts);
  const originalDirect=f.gpu.frame.direct;
  f.gpu.frame.direct=()=>({...originalDirect(),copyBufferToBuffer(a,ao,b,bo,n){new Uint8Array(b.bytes,bo,n).set(new Uint8Array(a.bytes,ao,n));}});
  f.gpu.device.createBuffer=({size})=>{const bytes=new ArrayBuffer(size);return {size,bytes,mapAsync:async()=>{},getMappedRange:()=>bytes,unmap(){},destroy(){}};};
  const complete={incomplete:false,requirements:[],sun:[]};let accepts=0,commits=0,discards=0,releases=0;
  const native={feedback:{size:4,bytes:new ArrayBuffer(4)},decodeFeedback:()=>complete,publication:{}};
  const recorded={data:{identity:{}},sceneTicket:item.ticket,feedbackIdentity:item.opts.feedbackIdentity,
    hands:{lighting:{canCommit:()=>true,commit(){assert.equal(item.ticket.status,'committed');commits++;return true;},discard(){discards++;}}},
    native,read:Promise.resolve(new Uint32Array(1)),submitted:item.opts.submission.submitted,releaseAfter:async()=>{releases++;}};
  const result=await finishWorldFrame({post:f.post,gpu:f.gpu},{data:{async accept(data,{postTicket,feedbackIdentity}){
    assert.equal(await postTicket.confirmation,true);assert.equal(postTicket.status,'committed');
    assert.equal(feedbackIdentity,item.opts.feedbackIdentity);accepts++;return true;
  }}},recorded,complete);
  assert.equal(result.accepted,true);assert.equal(accepts,1);assert.equal(commits,1);
  assert.equal(discards,0);assert.equal(releases,1);assert.equal(f.events.filter(e=>e==='taa').length,1);
  await f.completeAll();f.post.dispose();await f.completeAll();
});
