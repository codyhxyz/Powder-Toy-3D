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
  const seen=[],controls={gate:null,miss:false,compileError:null,nativeStill:false},counts={reserve:0,probe:0,vm:0,sign:0,main:0};
  const phases=[];
  // Explicit native scene transport only: the real frame helper owns layout
  // bindings, opaque pack, whole feedback, Post transfer and final retirement.
  app.scene=new THREE.Scene();f.gpu.three={renderer:{backend:{get:()=>({})}}};
  state.noise={texture:f.gpu.createTexture({size:[1,1,1],format:'rgba8unorm'})};
  state.unused.createView=()=>({});state.opaque.recordReady=()=>{phases.push('pack');return true;};
  app.threeMeshes=(_p,transparent)=>{phases.push(transparent?'transparent':'opaque');return true;};
  app.prepareWorldAfter=()=>assert.fail('still must not prepare MAIN wires');
  app.drawWorldAfter=()=>assert.fail('still must not draw MAIN wires');
  app.drawWorldOverlay=()=>assert.fail('still must not draw MAIN gizmos');
  state.volume.pipelineState=()=>({state:'ready'});
  state.volume.prepare=input=>{
    const feedback=f.gpu.createBuffer({size:f.owner.atlas.feedbackBytes,usage:128|4|8});
    return {feedback,publication:{},recordDraw(){phases.push('volume');return true;},decodeFeedback:()=>complete(),
      release(){input.snapshot.release();feedback.destroy();}};
  };
  app.signs={worldRequest(){counts.sign++;return null;}};
  const driver=createWorldFrameDriver(app,state,{
    async prewarm(_app,_state,_data){if(controls.gate)await controls.gate.promise;},
    async probe(){counts.probe++;return {feedback:complete()};},
    createPreflight:(_app,_state,data,view)=>controls.nativeStill?createWorldMeshPreflight(app,state,data,view):{},
    preflight(_app,p,camera){if(controls.compileError)throw controls.compileError;return controls.nativeStill?preflightWorldMeshes(app,p,camera):true;},
    releasePreflight:(_app,p)=>p?.native?releaseWorldMeshPreflight(app,p):Promise.resolve(),
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
        native:{feedback,decodeFeedback:words=>words[0]?{incomplete:true,requirements:[{brick:[1,0,0],channels:words[0]}],sun:[]}:complete(),publication:{}},
        read:submission.record(f.gpu.frame,feedback),submitted:submission.submitted,releaseAfter:async()=>feedback.destroy()};
    },
  });
  const view=(x=0)=>{const v=freezeWorldView(app,{...f.frame.values,model:new THREE.Matrix4().toArray()},{view:'realistic'});v.values.cam=[x,0,0];return v;};
  const tick=(present=false)=>{const main=driver.tick({present,reserve:()=>{counts.reserve++;return {runView:true,runDerived:true};},
    capture:()=>({view:view(2),frame:f.frame,requirements:[{brick:[0,0,0],channels:READY.CELL}]})});if(main)counts.main++;return main;};
  const pump=async(until,fn=()=>tick())=>{for(let i=0;i<500&&!until();i++){f.gpu.finish();await p.completeAll();if(!until())fn();}assert(until(),'driver/final queue did not settle');};
  const boot=async()=>{tick(true);await pump(()=>!!driver.accepted);await pump(()=>!driver.busy);};
  const close=async()=>{const done=driver.dispose();for(let i=0;i<20;i++){f.gpu.finish();await p.completeAll();}await done;p.post.dispose();await p.completeAll();presentation.dispose();await f.finish();};
  return {f,p,app,state,driver,seen,controls,counts,phases,view,tick,pump,boot,close};
}

test('off-camera still extends same cut before target confirmation, preserves MAIN identity/TAA/VM/sign/waiters; fairness services picks and normal work between two targets',async()=>{
  const t=await setup();await t.boot();
  const display=t.driver.displayedMainFrame,accepted=t.driver.accepted,offset=t.p.node._sampleIndex,taa=t.p.events.filter(x=>x==='taa').length;
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
  assert.equal(t.p.node._sampleIndex,offset);assert.equal(t.p.events.filter(x=>x==='taa').length,taa);
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
  const presentation=createPresentation(),post={settings:{}},settings={view:0},model=new THREE.Matrix4();let job;
  const driver={accepted:{frame:{values:{model:model.toArray()}}},displayedMainFrame:{},queueStill(j){job=j;events.push('queue');return gate.promise;}};
  const win={renderFrame:{driver}},target={destroy(){events.push('destroy');}},gpu={createTexture:()=>target,
    readback:{async texture(t){assert.equal(t,target);events.push('read');return new Uint8Array([20,10,5,128]);}},
    device:{queue:{async onSubmittedWorkDone(){events.push('fence');}}}};
  const run=new Function('win','graphicsFailure','coreReady','THREE','useWebGPUCamera','camera','THUMB_SIZE','viewKeyOf','isMaterialView','gateVariants','settings','post','selectedMode','frameUniformValues','presentation','freezeWorldView','pov','gpu','GPUTextureUsage','volume','sim',
    `${extract(source,'renderWorldThumb')};return renderWorldThumb;`)(win,false,true,THREE,useWebGPUCamera,camera,[1,1],()=> 'realistic',()=>true,()=>({base:{}}),settings,post,'sandbox',frameUniformValues,presentation,freezeWorldView,null,gpu,{RENDER_ATTACHMENT:16,COPY_SRC:1},{matrixWorld:model},{origin:new THREE.Vector3()});
  let image;const out={dataset:{},getContext:()=>({createImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData:i=>image=i})};
  const result=run(0,out);assert.deepEqual(events,['queue']);assert.notEqual(job.view.camera,camera);assert.equal(job.view.camera.children.length,0);assert.equal(job.view.curved,false);
  gate.resolve(true);assert.equal(await result,true);assert.deepEqual(events,['queue','read','fence','destroy']);assert.equal(out.dataset.rendered,'1');assert.deepEqual([...image.data],[40,20,10,128]);
  assert.match(extract(source,'renderThumb'),/if\(win\)return renderWorldThumb\(viewId,out\)/);
  presentation.dispose();
});

test('actual shared native frame helper records opaque → pack → full volume → transparent STILL with real context/feedback/final retirement and no hands or overlays',async()=>{
  const t=await setup();await t.boot();t.controls.nativeStill=true;
  const display=t.driver.displayedMainFrame,offset=t.p.node._sampleIndex,vm=t.counts.vm;
  const target=t.p.gpu.createTexture({size:[320,200],format:'rgba8unorm'});let done=false;
  const job=t.driver.queueStill({view:t.view(12),target}).then(()=>{done=true;});t.tick();await t.pump(()=>done);await job;
  assert.deepEqual(t.phases,['opaque','pack','volume','transparent']);
  assert.equal(t.driver.displayedMainFrame,display);assert.equal(t.p.node._sampleIndex,offset);assert.equal(t.counts.vm,vm);
  assert.equal(t.state.uses.size,0);await t.close();
});
