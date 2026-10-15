// CPU only: actual Post, guard and frozen-view functions; no native GPU math.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Scene,Mesh,BoxGeometry,MeshBasicNodeMaterial,PerspectiveCamera,Matrix4} from 'three/webgpu';
import {fixture} from './world-render-frame-cpu-check.mjs';
import {setup as ownerFixture} from './world-render-owner-cpu-check.mjs';
import {READY} from '../src/world/renderAtlas.js';
import {createWorldFrameDriver} from '../src/wire/worldRenderFrame.js';
import {createWorldFeedbackProvider} from '../src/gfx/worldLightingInputs.js';
import {guardMeshes,setMeshGpu} from '../src/gfx/meshLight.js';
import {releaseWorldMeshPreflight,freezeWorldView,withWorldView} from '../src/wire/worldRenderFrame.js';
import {createPresentation} from '../src/gfx/presentation.js';
import {frameUniformValues} from '../src/gfx/uniforms.js';
const turn=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('actual Post transfer distinguishes validation, null pool, prepare failure and throwing notification; release waits rejected submit and queue',async()=>{
  for(const mode of ['validation','resize','backpressure','prepare','notification']){
    const f=fixture({limit:1});await f.post.sceneReady;let transfers=0;
    const opts=f.options({onPublicationTransferred(){transfers++;if(mode==='notification')throw Error('notification');}});
    let occupied;
    if(mode==='validation')opts.identity=null;
    if(mode==='resize')f.gpu.createTexture=()=>{throw Error('resize allocation');};
    if(mode==='backpressure')occupied=f.record();
    if(mode==='backpressure')assert.equal(f.post.recordScene({},f.camera,opts),null);
    else assert.throws(()=>f.post.recordScene(mode==='prepare'?{prepare(){throw Error('prepare');}}:{},f.camera,opts));
    if(['validation','resize','backpressure'].includes(mode)){
      assert.equal(transfers,0);opts.publication.release();assert.equal(opts.publication.releases,1);
    }else{
      assert.equal(transfers,1);assert.equal(opts.publication.releases,0);
      opts.submission.reject(Error('definite discarded suffix'));await turn();
      assert.equal(opts.publication.releases,0,'prefix resources retained until queue completion');
      await f.completeAll();assert.equal(opts.publication.releases,1);
    }
    if(occupied){f.post.discardScene(occupied.ticket);occupied.opts.submission.resolve();}
    f.post.dispose();await turn();await f.completeAll();
  }
});

test('actual guard exposes the identical pending compile on repeat; preflight detach waits compile and final queue',async()=>{
  const work=deferred(),queue=deferred();let compilations=0,releases=0;
  const scene=new Scene(),camera=new PerspectiveCamera(),mesh=new Mesh(new BoxGeometry(),new MeshBasicNodeMaterial());scene.add(mesh);
  setMeshGpu({three:{renderer:{info:{calls:0}},defaults:{scene,camera,target:null},prepare(){compilations++;return work.promise;}}});
  const pending=new Set(),onPending=p=>pending.add(p);
  assert.equal(guardMeshes(scene,camera,{onPending}),1);
  assert.equal(guardMeshes(scene,camera,{onPending}),1);
  assert.equal(pending.size,1);assert.equal(compilations,1);
  const p={pending,dead:false,context:{retireAfter:async()=>{await queue.promise;releases++;}},native:{release(){releases++;}}};
  const retired=releaseWorldMeshPreflight({},p);await turn();assert.equal(releases,0);
  work.resolve();await turn();assert.equal(releases,0);
  queue.resolve();await retired;assert.equal(releases,2);
  setMeshGpu(null);mesh.geometry.dispose();mesh.material.dispose();
});

test('WORLD guard exposes original rejected compile, remains parked on repeated checks, and drains rejection on disposal',async()=>{
  const work=deferred(),scene=new Scene(),camera=new PerspectiveCamera();
  const mesh=new Mesh(new BoxGeometry(),new MeshBasicNodeMaterial());scene.add(mesh);let count=0;
  setMeshGpu({three:{renderer:{info:{calls:0}},defaults:{scene,camera,target:null},prepare(){count++;return work.promise;}}});
  const pending=new Set(),onPending=p=>pending.add(p);
  guardMeshes(scene,camera,{onPending});guardMeshes(scene,camera,{onPending});
  const error=Error('native compile failed');work.reject(error);
  await assert.rejects([...pending][0],e=>e===error);
  assert.equal(guardMeshes(scene,camera,{onPending}),1);assert.equal(count,1);assert.equal(pending.size,1);
  let released=0;await releaseWorldMeshPreflight({}, {pending,context:{retireAfter:async()=>{released++;}},native:{release(){released++;}}});
  assert.equal(released,2);setMeshGpu(null);mesh.geometry.dispose();mesh.material.dispose();
});

test('independent frozen view eye/model and scoped scene settings never reread changed live camera',()=>{
  const camera=new PerspectiveCamera();camera.position.set(4,5,6);camera.updateMatrixWorld();
  const presentation=createPresentation(),app={camera,presentation,settings:{view:'realistic'},post:{settings:{exposure:2}},pov:null};
  const values=frameUniformValues({camera,model:new Matrix4().makeTranslation(-10,0,0),sun:[0,1,0]});
  const view=freezeWorldView(app,values,{view:'realistic'});
  assert.deepEqual(view.values.cam,[14,5,6]);
  camera.position.set(99,99,99);camera.updateMatrixWorld();app.post.settings.exposure=8;
  withWorldView(app,view,()=>{assert.equal(app.camera,view.camera);assert.equal(app.post.settings.exposure,2);assert.deepEqual(view.values.cam,[14,5,6]);});
  assert.equal(app.camera,camera);assert.equal(app.post.settings.exposure,8);presentation.dispose();
});

test('actual driver + actual owner + actual Post: pending/same-cut eye miss/accepted; movement does not consume reservations',async()=>{
  const f=await ownerFixture(),p=fixture();await p.post.sceneReady;
  const presentation=createPresentation();let wakes=0,reservations=0,captures=0,probes=0,commits=0,desired=1;
  const app={gpu:f.gpu,post:p.post,win:f.win,camera:p.camera,presentation,settings:{},scene:new Scene(),requestRender(){wakes++;}};
  const complete={incomplete:false,requirements:[],sun:[]},cuts=[];
  const state={data:f.owner,uses:new Set(),volume:{dispose(){}},opaque:{dispose(){}},unused:{destroy(){}},boundary:{destroy(){}},emptyArtwork:{destroy(){}}};
  const eyeGate=deferred();
  const driver=createWorldFrameDriver(app,state,{
    prewarm:async()=>{}, // Native kernel math and scenegraph encoding deliberately mocked.
    async probe(_app,_state,data,view){cuts.push(data.cut);probes++;if(probes===1)await eyeGate.promise;
      return {feedback:probes===1?{incomplete:true,requirements:[{brick:[0,0,0],channels:READY.GLOW}],sun:[]}:complete,position:view.values.cam};},
    createPreflight:()=>({}),preflight:()=>true,releasePreflight:async()=>{},
    record(_app,_state,data){
      const submission=createWorldFeedbackProvider(f.gpu,{}).reserve(f.gpu.frame),feedbackIdentity={};
      const sceneTicket=p.post.recordScene({},app.camera,{identity:data.identity,publication:data.retain(),feedbackIdentity,submission});
      const feedback=f.gpu.createBuffer({size:4,usage:128|4|8});
      const read=submission.record(f.gpu.frame,feedback);
      return {data,sceneTicket,feedbackIdentity,hands:{lighting:{canCommit:()=>true,commit(){commits++;return true;},discard(){}}},
        native:{feedback,decodeFeedback:()=>complete,publication:{}},read,submitted:submission.submitted,
        releaseAfter:async()=>feedback.destroy()};
    },
  });
  const capture=()=>{captures++;const values={...f.frame.values,model:new Matrix4().toArray()};
    const view=freezeWorldView(app,values,{view:'realistic'});view.values.cam=[desired,0,0];
    return {view,frame:f.frame,requirements:[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}]};};
  const tick=()=>driver.tick({present:true,reserve:()=>{reservations++;return {runView:true,runDerived:true};},capture});
  tick();for(let i=0;i<40;i++){f.gpu.finish();await p.completeAll();tick();}
  assert.equal(reservations,1);assert.equal(captures,1);assert.equal(f.owner.metadata.derivedTick,-1);assert.equal(commits,0);
  desired=9;eyeGate.resolve();let admitted=false;
  for(let i=0;i<300&&!admitted;i++){f.gpu.finish();await p.completeAll();admitted=tick();}
  assert(admitted);assert.equal(reservations,1);assert.equal(captures,1);assert.equal(probes,2);
  assert.equal(cuts[0],cuts[1],'same SourceCut extended despite latest desired movement');
  assert.equal(commits,1);assert.equal(f.owner.metadata.derivedTick,0);assert(wakes>0);
  const disposing=driver.dispose();for(let i=0;i<10;i++){f.gpu.finish();await p.completeAll();}await disposing;
  p.post.dispose();await p.completeAll();presentation.dispose();await f.finish();
});

test('actual App hooks select driver, reserve only inside callback, and suppress local WORLD consumers',()=>{
  const app=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
  assert.match(app,/driver\.tick\(\{present,dt/);assert.match(app,/capture:\(reservation,state\)=>captureWorldRequest/);
  assert.match(app,/if\(win\?\.render\)return; \/\/ WORLD/);
  for(const hook of ['threeMeshes','prepareWorldAfter','drawWorldAfter','drawWorldOverlay'])assert.match(app,new RegExp(hook));
  assert.match(app,/if\(win\)return false; \/\/ Explicit loading gate/);
  assert.match(app,/WORLD_CONSUMER_NOT_READY/);
});
