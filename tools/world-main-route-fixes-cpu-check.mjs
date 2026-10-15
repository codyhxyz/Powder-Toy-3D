// Actual WORLD owner/driver/Post/pacer and allocation faults. No browser/GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Scene,Matrix4} from 'three/webgpu';
import {setup} from './world-render-owner-cpu-check.mjs';
import {fixture} from './world-render-frame-cpu-check.mjs';
import {createWorldFrameState,createWorldFrameDriver,freezeWorldView,worldInitialCellDemand} from '../src/wire/worldRenderFrame.js';
import {createWorldFeedbackProvider} from '../src/gfx/worldLightingInputs.js';
import {createPresentation} from '../src/gfx/presentation.js';
import {createPacer} from '../src/gfx/pacing.js';
import {GI_SETTLE} from '../src/shaders/gi.js';
import {READY} from '../src/world/renderAtlas.js';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const complete={incomplete:false,requirements:[],sun:[]};
test('actual WORLD attachment never constructs or starts the retired Far/detail pipeline',()=>{
 const source=readFileSync(new URL('../src/wire/world.js',import.meta.url),'utf8');
 const start=source.indexOf('  attach(app) {'),brace=source.indexOf('{',start);let depth=1,end=brace+1;
 for(;depth;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
 const window={},sim={origin:{fromArray(v){this.value=v;}}},app={sim,worldMode:{size:[512,384,512]},settings:{scene:'island'},sceneByKey:k=>k};
 const Window=class{constructor(renderer,actualSim,options){assert.equal(actualSim,sim);assert.deepEqual(options.size,app.worldMode.size);return window;}};
 const attach=new Function('WorldWindow','world',`return ({${source.slice(start,end)}}).attach;`)(Window,{worldStart:()=>[32,0,64]});
 attach(app);assert.equal(app.win,window);assert.deepEqual(sim.origin.value,[32,0,64]);
 assert.equal(window.far,undefined);
});
async function pump(f,work,p=null){
  let done=false,result,error;
  work.then(value=>{result=value;done=true;},e=>{error=e;done=true;});
  for(let i=0;i<2000&&!done;i++){f.gpu.finish();await p?.completeAll();await turn();}
  assert(done,'actual transaction must settle');if(error)throw error;return result;
}
test('App bootstrap supplies an actual CELL demand, including outside-world and high-Y eyes',async()=>{
  assert.deepEqual(worldInitialCellDemand([-50,900,4],[16,384,8]),[{brick:[0,95,1],channels:READY.CELL}]);
  assert.throws(()=>worldInitialCellDemand([NaN,0,0],[16,8,8]),/finite world eye/);
  const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
  assert.match(source,/return \{frame,view,requirements:worldInitialCellDemand\(view\.values\.cam,win\.size\)\}/);
  const f=await setup(),candidate=await pump(f,f.owner.request(f.frame,worldInitialCellDemand([0,0,0],f.win.size)));
  assert.equal(f.owner.state,'probe-ready');assert.equal(f.owner.metadata.derivedTick,-1);
  await pump(f,f.owner.discard(candidate));candidate.release();await f.close();
});
test('derived settling can follow domain changes without changing fixed-count BOX behavior',()=>{
  let world=false;
  const p=createPacer({derivedSettle:()=>world?GI_SETTLE:22,viewSettle:8});
  let n=0;while(p.derived('box'))n++;assert.equal(n,22);assert.equal(p.settleLimit,34);
  world=true;n=0;while(p.derived('world'))n++;assert.equal(n,32);assert.equal(p.settleLimit,44);
  const fixed=createPacer({derivedSettle:22,viewSettle:8});
  n=0;while(fixed.derived('box'))n++;assert.equal(n,22);assert.equal(fixed.settleLimit,34);
});
test('actual driver/owner/Post reaches 32 accepted GI advances and then idles without completion refills',async()=>{
  const f=await setup(),p=fixture();await p.post.sceneReady;
  const presentation=createPresentation(),pacer=createPacer({derivedSettle:GI_SETTLE,viewSettle:8});
  let wakes=0,advances=0,accepted=0;
  const app={gpu:f.gpu,post:p.post,win:f.win,camera:p.camera,presentation,settings:{},scene:new Scene(),
    wakeLoop(){wakes++;},requestRender(){pacer.wake();}};
  const state={data:f.owner,uses:new Set(),volume:{dispose(){}},opaque:{dispose(){}},
    unused:{destroy(){}},boundary:{destroy(){}},emptyArtwork:{destroy(){}}};
  const driver=createWorldFrameDriver(app,state,{
    prewarm:async()=>{},probe:async()=>({feedback:complete}),createPreflight:()=>({}),preflight:()=>true,releasePreflight:async()=>{},
    record(_app,_state,data){
      const submission=createWorldFeedbackProvider(f.gpu,{}).reserve(f.gpu.frame),feedbackIdentity={};
      const sceneTicket=p.post.recordScene({},app.camera,{identity:data.identity,publication:data.retain(),feedbackIdentity,submission});
      const feedback=f.gpu.createBuffer({size:4,usage:128|4|8}),read=submission.record(f.gpu.frame,feedback);
      return {data,sceneTicket,feedbackIdentity,hands:{},native:{feedback,decodeFeedback:()=>complete},read,
        submitted:submission.submitted,releaseAfter:async()=>feedback.destroy()};
    },
  });
  const tick=()=>driver.tick({present:true,reserve(){
    const runDerived=pacer.derived('static world');if(runDerived)advances++;
    return {runDerived,runView:pacer.view('static view',runDerived)};
  },capture(reservation){
    const values={...f.frame.values,model:new Matrix4().toArray()};
    return {view:freezeWorldView(app,values,{view:'realistic'}),
      frame:{...f.frame,advance:reservation.runDerived},requirements:worldInitialCellDemand([0,0,0],f.win.size)};
  }});
  for(let i=0;i<8000;i++){
    if(tick())accepted++;
    f.gpu.finish();await p.completeAll();await turn();
    if(pacer.settled&&!driver.busy)break;
  }
  assert(!driver.busy);assert(pacer.settled);assert.equal(pacer.wakes,0);
  assert.equal(advances,GI_SETTLE);assert.equal(f.owner.metadata.derivedTick,GI_SETTLE-1);
  assert(accepted>=GI_SETTLE&&accepted<=GI_SETTLE+8);assert(wakes>0);
  const before=accepted;for(let i=0;i<10;i++)if(tick())accepted++;assert.equal(accepted,before);
  const disposing=driver.dispose();await pump(f,disposing,p);
  p.post.dispose();await p.completeAll();presentation.dispose();await f.finish();
});
test('WORLD initialization destroys every allocated resource at each native failure site',async()=>{
  for(let fail=1;fail<=15;fail++){
    let step=0;const resources=[];
    const check=()=>{if(++step===fail)throw Error(`injected ${fail}`);};
    const resource=desc=>{check();const r={...desc,dead:0,destroy(){this.dead++;}};resources.push(r);return r;};
    const device={queue:{writeTexture(){check();},async onSubmittedWorkDone(){}},
      createTexture:resource,createBuffer(desc){const r=resource(desc);return Object.assign(r,{
        getMappedRange(){check();return new ArrayBuffer(desc.size);},unmap(){check();}});},
      createBindGroupLayout(){check();return{};},createPipelineLayout(){check();return{};},
      createShaderModule(){check();return{};},async createComputePipelineAsync(){check();return{};}};
    const data={},app={win:{loaded:true,render:data},gpu:{device},post:{sceneReady:Promise.resolve()}};
    await assert.rejects(createWorldFrameState(app,data,{ready:Promise.resolve()}),new RegExp(`injected ${fail}`));
    await turn();assert(resources.every(r=>r.dead===1),`failure ${fail}: all resources retired once`);
  }
});
