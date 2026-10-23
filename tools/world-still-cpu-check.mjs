// CPU only. Actual single-slot driver, Source/data owner, final provider and
// Post; native scene math/Three traversal explicitly replaced at transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three/webgpu';
import {fixture as postFixture} from './world-render-frame-cpu-check.mjs';
import {setup as ownerFixture} from './world-render-owner-cpu-check.mjs';
import {createWorldFrameDriver,freezeWorldView,recordWorldFrame,createWorldMeshPreflight,preflightWorldMeshes,releaseWorldMeshPreflight} from '../src/wire/worldRenderFrame.js';
import {createWorldFeedbackProvider} from '../src/gfx/worldLightingInputs.js';
import {createPresentation} from '../src/gfx/presentation.js';
import {frameUniformValues} from '../src/gfx/uniforms.js';
import {useWebGPUCamera} from '../src/gpu/three.js';
import {READY} from '../src/world/renderAtlas.js';
const turn=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const complete=()=>({incomplete:false,requirements:[],sun:[]});
async function setup() {
  const f=await ownerFixture(),p=postFixture();await p.post.sceneReady;
  const values=frameUniformValues({camera:p.camera,model:new THREE.Matrix4(),sun:new THREE.Vector3(1,1,1)});
  f.frame.values=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,v?.toArray?v.toArray():v]));
  const presentation=createPresentation(),app={gpu:f.gpu,post:p.post,camera:p.camera,presentation,settings:{view:0},win:f.win,wakeLoop(){}};
  const state={data:f.owner,uses:new Set(),volume:{dispose(){}},opaque:{dispose(){}},unused:{destroy(){}},boundary:{destroy(){}},emptyArtwork:{destroy(){}}};
  const seen=[],controls={gate:null,pointGate:null,probeGate:null,eyeMiss:false,miss:false,compileError:null,nativeStill:false},counts={reserve:0,probe:0,vm:0,sign:0,main:0,prewarm:0,preflight:0},cuts=[];
  const phases=[];
  // Explicit native scene transport only: the real frame helper owns layout
  // bindings, opaque pack, whole feedback, Post transfer and final retirement.
  app.scene=new THREE.Scene();f.gpu.three={renderer:{backend:{get:()=>({})}}};
  state.noise={texture:f.gpu.createTexture({size:[1,1,1],format:'rgba8unorm'})};
  state.unused.createView=()=>({});state.opaque.recordReady=()=>{phases.push('pack');return true;};
  app.threeMeshes=(_p,transparent)=>{phases.push(transparent?'transparent':'opaque');return true;};
  app.writeWorldFrame=()=>phases.push('frame');app.drawWorldSky=()=>phases.push('sky');
  app.drawWorldBrush=()=>assert.fail('still must not draw MAIN brush');
  app.frameWires={beforeView:()=>assert.fail('still must not prepare MAIN wires'),compute:()=>assert.fail('still must not run MAIN wire upkeep'),
    sceneBelow:()=>assert.fail('still must not draw MAIN wires'),sceneAbove:()=>assert.fail('still must not draw MAIN wires'),
    overlay:()=>assert.fail('still must not draw MAIN gizmos')};
  state.volume.pipelineState=()=>({state:'ready'});
  state.volume.prepare=input=>{
    const feedback=f.gpu.createBuffer({size:f.owner.atlas.feedbackBytes,usage:128|4|8});
    return {feedback,publication:{},recordDraw(){phases.push('volume');return true;},feedbackWords:feedback.size/4,readFeedback:async()=>complete(),
      recordFeedback(encoder,dst,offset=0){encoder.copyBufferToBuffer(feedback,0,dst,offset,feedback.size);},
      release(){input.snapshot.release();feedback.destroy();}};
  };
  app.signs={worldRequest(){counts.sign++;return null;}};
  const driver=createWorldFrameDriver(app,state,{idlePerBusy:0,
    async prewarm(_app,_state,_data){counts.prewarm++;state.volume.pointReady=controls.pointGate?.promise??Promise.resolve();if(controls.gate)await controls.gate.promise;},
    async probe(_app,_state,data){counts.probe++;cuts.push(data.cut);if(controls.probeGate)await controls.probeGate.promise;
      const miss=controls.eyeMiss;controls.eyeMiss=false;return {feedback:miss?{incomplete:true,requirements:[{brick:[1,0,0],channels:READY.GLOW}],sun:[]}:complete()};},
    createPreflight:(_app,_state,data,view)=>{counts.preflight++;return controls.nativeStill?createWorldMeshPreflight(app,state,data,view):{};},
    preflight(_app,p,camera){if(controls.compileError)throw controls.compileError;return controls.nativeStill?preflightWorldMeshes(app,p,camera):true;},
    releasePreflight:(_app,p)=>controls.retireError?Promise.reject(controls.retireError):p?.native?releaseWorldMeshPreflight(app,p):Promise.resolve(),
    record(_app,_state,data,options){
      if(controls.nativeStill)return recordWorldFrame(app,state,data,options);
      const still=!!options.stillTarget,submission=createWorldFeedbackProvider(f.gpu,{}).reserve(f.gpu.frame),feedbackIdentity={};
      const feedback=f.gpu.createBuffer({size:4,usage:128|4|8});
      const miss=still&&controls.miss;controls.miss=false;
      // Explicit scene transport writes a miss word, read through normal final.
      if(miss)new Uint32Array(feedback.bytes)[0]=READY.GLOW;
      const sceneTicket=p.post.recordScene({draw(){if(still)options.stillTarget.encodes=(options.stillTarget.encodes??0)+1;}},app.camera,
        {identity:data.identity,publication:data.retain(),feedbackIdentity,submission,
          ...(still?{still:true,target:options.stillTarget}:{})});
      seen.push({still,cut:data.cut,identity:data.identity,view:options.frozenView,target:options.stillTarget,sign:options.signRequest});
      return {data,sceneTicket,feedbackIdentity,hands:still?{}:{lighting:{canCommit:()=>true,commit(){counts.vm++;return true;},discard(){}}},
        native:{feedback,feedbackWords:1,readFeedback:async words=>words[0]?{incomplete:true,requirements:[{brick:[1,0,0],channels:words[0]}],sun:[]}:complete(),publication:{}},
        read:submission.record(f.gpu.frame,feedback),submitted:submission.submitted,releaseAfter:async()=>feedback.destroy()};
    },
  });
  const view=(x=0)=>{const v=freezeWorldView(app,{...f.frame.values,model:new THREE.Matrix4().toArray()},{view:'realistic'});v.values.cam=[x,0,0];return v;};
  const tick=(present=false)=>{const main=driver.tick({present,reserve:()=>{counts.reserve++;return {runView:true,runDerived:true};},
    capture:()=>({view:view(2),frame:f.frame,requirements:[{brick:[0,0,0],channels:READY.CELL}]})});if(main)counts.main++;return main;};
  const pump=async(until,fn=()=>tick())=>{for(let i=0;i<500&&!until();i++){f.gpu.finish();await p.completeAll();if(!until())fn();}assert(until(),'driver/final queue did not settle');};
  const boot=async()=>{tick(true);await pump(()=>!!driver.accepted);await pump(()=>!driver.busy);};
  const close=async()=>{const done=driver.dispose();for(let i=0;i<20;i++){f.gpu.finish();await p.completeAll();}await done;p.post.dispose();await p.completeAll();presentation.dispose();await f.finish();};
  return {f,p,app,state,driver,seen,controls,counts,cuts,phases,view,tick,pump,boot,close};
}

test('asynchronous preparation completes without another tick but cannot select actors or record',async()=>{
  const t=await setup();t.tick(true);
  for(let i=0;i<500&&t.driver.phase!=='prepared';i++){t.f.gpu.finish();await t.p.completeAll();}
  assert.equal(t.driver.phase,'prepared');assert.equal(t.counts.prewarm,1);assert.equal(t.counts.probe,1);
  assert.equal(t.counts.preflight,0);assert.equal(t.seen.length,0);assert.equal(t.driver.accepted,null);
  t.tick();assert.equal(t.counts.preflight,1);assert.equal(t.seen.length,1);
  await t.pump(()=>!!t.driver.accepted);await t.close();
});

test('point-ready MAIN extends same frozen cut before full warm, but complete eye cannot select actors or record',async()=>{
  const t=await setup(),warm=deferred(),point=deferred();t.controls.gate=warm;t.controls.pointGate=point;t.controls.eyeMiss=true;
  t.tick(true);await t.pump(()=>t.counts.prewarm===1);
  assert.equal(t.counts.probe,0);point.resolve();await t.pump(()=>t.counts.probe===2);
  await turn();assert.equal(t.driver.phase,'waiting:prepared');
  assert.equal(t.cuts[0],t.cuts[1]);assert.equal(t.counts.prewarm,1);assert.equal(t.counts.reserve,1);
  assert.equal(t.counts.preflight,0);assert.equal(t.counts.vm,0);assert.equal(t.seen.length,0);assert.equal(t.driver.accepted,null);
  warm.resolve();await t.pump(()=>!!t.driver.accepted);assert.equal(t.counts.preflight,1);await t.close();
});

test('prewarm failure during actual same-cut extension releases late publication and never resurrects progress',async()=>{
  const t=await setup(),warm=deferred(),extension=deferred();t.controls.gate=warm;t.controls.eyeMiss=true;
  const extend=t.f.owner.extend.bind(t.f.owner);let entered=false,releases=0;
  // Observe only the return transport; the actual owner still performs extension.
  t.state.data={...t.f.owner,extend:async(...args)=>{const data=await extend(...args);entered=true;await extension.promise;
    return {...data,release(){releases++;data.release();}};}};
  t.tick(true);await t.pump(()=>entered);const error=Error('full warm failed');warm.reject(error);await turn();
  assert.equal(t.driver.failure,error);assert.equal(t.driver.phase,'failed');assert.throws(()=>t.tick(),e=>e===error);
  extension.resolve();await turn();await turn();assert.equal(releases,1);assert.equal(t.driver.phase,'failed');
  assert.equal(t.counts.preflight,0);assert.equal(t.seen.length,0);await t.close();
});

test('prewarm rejection is immediate while point pending; disposal drains point and actual compilation settlement',async()=>{
  const t=await setup();await t.boot();const probes=t.counts.probe,prewarms=t.counts.prewarm;
  const warm=deferred(),point=deferred(),native=deferred();t.controls.gate=warm;t.controls.pointGate=point;
  t.state.volume.compilationSettled=native.promise;t.tick(true);await t.pump(()=>t.counts.prewarm===prewarms+1);
  let queuedRejected=false;
  const queued=assert.rejects(t.driver.queueStill({view:t.view(),target:{}}),/view rejected while point pending/).then(()=>{queuedRejected=true;});
  const error=Error('view rejected while point pending');warm.reject(error);await turn();assert.equal(t.driver.failure,error);
  await queued;assert(queuedRejected,'queued jobs reject without waiting for point/native settlement');
  let disposed=false;const done=t.driver.dispose().then(()=>{disposed=true;});await turn();assert.equal(disposed,false);
  point.resolve();await turn();assert.equal(t.counts.probe,probes);assert.equal(disposed,false);
  native.resolve();for(let i=0;i<20;i++){t.f.gpu.finish();await t.p.completeAll();}await done;await t.close();
});

test('disposal drains in-flight point readback, preparation and registered queue use independently',async()=>{
  const t=await setup(),warm=deferred(),read=deferred(),use=deferred();t.controls.gate=warm;t.controls.probeGate=read;
  t.tick(true);await t.pump(()=>t.counts.probe===1);t.state.uses.add(use.promise);
  let disposed=false;const done=t.driver.dispose().then(()=>{disposed=true;});warm.resolve();await turn();assert.equal(disposed,false);
  read.resolve();await turn();assert.equal(disposed,false);use.resolve();t.state.uses.delete(use.promise);
  for(let i=0;i<20;i++){t.f.gpu.finish();await t.p.completeAll();}await done;assert.equal(t.counts.preflight,0);await t.close();
});

test('still remains full-prewarm gated and never issues MAIN eye query',async()=>{
  const t=await setup();await t.boot();const warm=deferred();t.controls.gate=warm;
  const probes=t.counts.probe,preflight=t.counts.preflight,prewarms=t.counts.prewarm;let finished=false;
  const job=t.driver.queueStill({view:t.view(),target:t.p.gpu.createTexture({size:[320,200],format:'rgba8unorm'})}).then(()=>{finished=true;});
  t.tick();await t.pump(()=>t.counts.prewarm===prewarms+1);
  for(let i=0;i<5;i++){await turn();t.tick();}
  assert.equal(finished,false);assert.equal(t.counts.probe,probes);assert.equal(t.counts.preflight,preflight);
  warm.resolve();await t.pump(()=>finished);await job;assert.equal(t.counts.probe,probes);await t.close();
});

test('off-camera still extends same cut before target confirmation, preserves MAIN identity/TAA/VM/sign/waiters; fairness services picks and normal work between two targets',async()=>{
  const t=await setup();await t.boot();
  const display=t.driver.displayedMainFrame,accepted=t.driver.accepted,offset=t.p.node._jitterIndex,taa=t.p.events.filter(x=>x==='taa').length;
  assert(Number.isInteger(offset),'inspect actual committed Three jitter index');
  const vm=t.counts.vm,sign=t.counts.sign,main=t.counts.main,reserves=t.counts.reserve,probes=t.counts.probe;
  const target1=t.p.gpu.createTexture({size:[320,200],format:'rgba8unorm'}),target2=t.p.gpu.createTexture({size:[320,200],format:'rgba8unorm'});
  let first=false,second=false;t.controls.miss=true;
  const a=t.driver.queueStill({view:t.view(12),target:target1}).then(()=>{first=true;}),b=t.driver.requestStill({view:t.view(15),target:target2}).then(()=>{second=true;});
  t.tick();assert.equal(t.counts.reserve,reserves);
  t.driver.queuePickDemand({incomplete:true,requirements:[{brick:[2,0,0],channels:READY.AUX}],sun:[]},display);
  await t.pump(()=>first);await a;
  assert.equal(second,false);assert.equal(target1.encodes,2);assert.equal(target2.encodes,undefined);
  const stills=t.seen.filter(x=>x.still);assert.equal(stills.length,2);assert.equal(stills[0].cut,stills[1].cut);
  assert.equal(stills[0].view,stills[1].view);assert.equal(stills[0].view.values.cam[0],12);
  assert.equal(t.driver.accepted,accepted);assert.equal(t.driver.displayedMainFrame,display);
  const current=t.f.owner.current();assert.notEqual(current.identity,display.data.identity);current.release();
  assert.equal(t.f.owner.metadata.derivedTick,0);assert.equal(t.counts.reserve,reserves);assert.equal(t.counts.probe,probes);
  assert.equal(t.p.node._jitterIndex,offset);assert.equal(t.p.events.filter(x=>x==='taa').length,taa);
  assert.equal(t.counts.vm,vm);assert.equal(t.counts.sign,sign);assert.equal(t.counts.main,main);
  // Coalesced pick demand forces the normal request before the second card.
  t.tick();await t.pump(()=>t.driver.displayedMainFrame!==display);await t.pump(()=>second);await b;
  assert.equal(target1.encodes,2);assert.equal(target2.encodes,1);
  assert.deepEqual(t.seen.map(x=>x.still),[false,true,true,false,true]);
  assert.equal(t.counts.main,main+1);assert.equal(t.counts.vm,vm+1);assert.equal(t.counts.sign,sign+1);
  assert.equal(t.f.owner.metadata.derivedTick,1);
  await t.close();
});

test('disposal rejects queued targets immediately but active target waits outstanding preparation and queue resources',async()=>{
  const t=await setup();await t.boot();const gate=deferred(),use=deferred();t.controls.gate=gate;t.state.uses.add(use.promise);
  let active=false,queued=false;
  const a=assert.rejects(t.driver.queueStill({view:t.view(),target:{}}),/disposed/).then(()=>{active=true;});
  const b=assert.rejects(t.driver.queueStill({view:t.view(),target:{}}),/disposed/).then(()=>{queued=true;});
  t.tick();await t.pump(()=>t.f.owner.state==='probe-ready');t.tick();
  const done=t.driver.dispose();await turn();assert(queued);assert.equal(active,false);
  gate.resolve();await turn();assert.equal(active,false);use.resolve();
  for(let i=0;i<20;i++){t.f.gpu.finish();await t.p.completeAll();}await done;await Promise.all([a,b]);assert(active);
  t.p.post.dispose();await t.p.completeAll();t.app.presentation.dispose();await t.f.finish();
});

test('rejected preflight retirement still drains queue uses before rejecting active still',async()=>{
  const t=await setup();await t.boot();const use=deferred();t.state.uses.add(use.promise);
  t.controls.compileError=Error('scene preflight failed');t.controls.retireError=Error('retirement rejected');let rejected=false;
  const job=assert.rejects(t.driver.queueStill({view:t.view(),target:{}}),/scene preflight failed/).then(()=>{rejected=true;});
  t.tick();for(let i=0;i<100&&!t.driver.failure;i++){t.f.gpu.finish();await t.p.completeAll();try{t.tick();}catch{}}
  await turn();assert(t.driver.failure);assert.equal(rejected,false);use.resolve();t.state.uses.delete(use.promise);
  await job;await t.close();
});

test('native preflight failure rejects both UI jobs only after active prefix resources drain',async()=>{
  const t=await setup();await t.boot();const use=deferred();t.state.uses.add(use.promise);t.controls.compileError=Error('native compilation failed');
  let active=false;const a=assert.rejects(t.driver.queueStill({view:t.view(),target:{}}),/native compilation failed/).then(()=>{active=true;});
  const b=assert.rejects(t.driver.queueStill({view:t.view(),target:{}}),/native compilation failed/);
  t.tick();for(let i=0;i<100&&!t.driver.failure;i++){t.f.gpu.finish();await t.p.completeAll();try{t.tick();}catch{}}
  assert(t.driver.failure);assert.equal(active,false);use.resolve();await Promise.all([a,b]);await t.close();
});

function extract(source,name) {const start=source.indexOf(`async function ${name}(`),brace=source.indexOf('{',start);let depth=1,i=brace+1;for(;depth;i++){if(source[i]==='{')depth++;else if(source[i]==='}')depth--;}return source.slice(start,i);}
test('actual App WORLD thumbnail hook executes own-camera queue, readback, unpremultiply, and target retirement; BOX body unchanged',async()=>{
  const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
  const gate=deferred(),events=[],camera=useWebGPUCamera(new THREE.PerspectiveCamera());camera.add(new THREE.Object3D());
  const rig=new THREE.Group();rig.position.x=20;rig.add(camera);rig.updateMatrixWorld(true);
  const presentation=createPresentation(),post={settings:{}},settings={view:0},model=new THREE.Matrix4();let job;
  const driver={accepted:{frame:{values:{model:model.toArray()}}},displayedMainFrame:{},queueStill(j){job=j;events.push('queue');return gate.promise;}};
  const win={renderFrame:{driver}},target={destroy(){events.push('destroy');}},gpu={createTexture:()=>target,
    readback:{async texture(t){assert.equal(t,target);events.push('read');return new Uint8Array([20,10,5,128]);}},
    device:{queue:{async onSubmittedWorkDone(){events.push('fence');}}}};
  const run=new Function('win','graphicsFailure','coreReady','THREE','useWebGPUCamera','camera','THUMB_SIZE','viewKeyOf','isMaterialView','gateVariants','settings','post','selectedMode','frameUniformValues','presentation','freezeWorldView','pov','gpu','GPUTextureUsage','volume','sim',
    `${extract(source,'renderWorldThumb')};return renderWorldThumb;`)(win,false,true,THREE,useWebGPUCamera,camera,[1,1],()=> 'realistic',()=>true,()=>({base:{}}),settings,post,'sandbox',frameUniformValues,presentation,freezeWorldView,null,gpu,{RENDER_ATTACHMENT:16,COPY_SRC:1},{matrixWorld:model},{origin:new THREE.Vector3()});
  let image;const out={dataset:{},getContext:()=>({createImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData:i=>image=i})};
  const result=run(0,out);assert.deepEqual(events,['queue']);assert.notEqual(job.view.camera,camera);assert.equal(job.view.camera.children.length,0);assert.equal(job.view.curved,false);assert.equal(job.view.values.cam[0],20,'detached thumbnail retains POV rig world pose');
  gate.resolve(true);assert.equal(await result,true);assert.deepEqual(events,['queue','read','fence','destroy']);assert.equal(out.dataset.rendered,'1');assert.deepEqual([...image.data],[40,20,10,128]);
  assert.match(extract(source,'renderThumb'),/if\(win\)return renderWorldThumb\(viewId,out\)/);
  presentation.dispose();
});

test('actual shared native frame helper records opaque → pack → sky → full volume → transparent STILL with real context/feedback/final retirement and no hands or overlays',async()=>{
  const t=await setup();await t.boot();t.controls.nativeStill=true;
  const display=t.driver.displayedMainFrame,offset=t.p.node._jitterIndex,vm=t.counts.vm;
  const target=t.p.gpu.createTexture({size:[320,200],format:'rgba8unorm'});let done=false;
  const job=t.driver.queueStill({view:t.view(12),target}).then(()=>{done=true;});t.tick();await t.pump(()=>done);await job;
  assert.deepEqual(t.phases,['frame','opaque','pack','sky','volume','transparent']);
  assert.equal(t.driver.displayedMainFrame,display);assert.equal(t.p.node._jitterIndex,offset);assert.equal(t.counts.vm,vm);
  assert.equal(t.state.uses.size,0);await t.close();
});

test('source epoch/schema retirement rejects queued stills before native recording without replacing displayed MAIN',async()=>{
  const t=await setup();await t.boot();const display=t.driver.displayedMainFrame;
  const a=assert.rejects(t.driver.queueStill({view:t.view(),target:{}}),/reset WORLD owner/);
  const b=assert.rejects(t.driver.queueStill({view:t.view(),target:{}}),/reset WORLD owner/);
  t.f.source.reset();assert.throws(()=>t.tick(),/reset WORLD owner/);await Promise.all([a,b]);
  assert.equal(t.driver.displayedMainFrame,display);assert.equal(t.seen.filter(x=>x.still).length,0);await t.close();
});

test('actual STILL opaque-pack prefix failure closes normal final ticket and retains target while final resources remain uncertain',async()=>{
  const t=await setup();await t.boot();t.controls.nativeStill=true;
  const display=t.driver.displayedMainFrame,taa=t.p.events.filter(x=>x==='taa').length;
  t.state.opaque.recordReady=()=>{throw Error('opaque pack prefix failed');};
  const use=deferred();t.state.uses.add(use.promise);let rejected=false;
  const job=assert.rejects(t.driver.queueStill({view:t.view(),target:t.p.gpu.createTexture({size:[320,200],format:'rgba8unorm'})}),/opaque pack prefix failed/).then(()=>{rejected=true;});
  t.tick();for(let i=0;i<100&&!t.driver.failure;i++){t.f.gpu.finish();await t.p.completeAll();try{t.tick();}catch{}}
  assert(t.driver.failure);assert(t.state.uses.size>1,'real native prefix registered before throwing');assert.equal(rejected,false);
  assert.equal(t.driver.displayedMainFrame,display);assert.equal(t.p.events.filter(x=>x==='taa').length,taa);
  use.resolve();for(let i=0;i<20;i++){t.f.gpu.finish();await t.p.completeAll();}await job;await t.close();
});

test('epoch change during asynchronous still preparation withholds target until compilation drains',async()=>{
  const t=await setup();await t.boot();const gate=deferred();t.controls.gate=gate;let rejected=false;
  const job=assert.rejects(t.driver.queueStill({view:t.view(),target:{}}),/reset WORLD owner/).then(()=>{rejected=true;});
  t.tick();await t.pump(()=>t.f.owner.state==='probe-ready');t.tick();
  t.f.source.reset();assert.throws(()=>t.tick(),/reset WORLD owner/);await turn();assert.equal(rejected,false);
  gate.resolve();await job;assert.equal(t.seen.filter(x=>x.still).length,0);await t.close();
});
