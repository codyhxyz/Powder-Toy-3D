// CPU-only execution of actual App startup/view boundaries; no browser or GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DETAIL,settingKey,detailDefines} from '../src/gfx/detail.js';
import {VIEWS,isMaterialView} from '../src/views.js';
import {createLoadWatch,LOAD_FLAG_MS} from '../src/loadWatch.js';
import {kindOf} from '../src/mapKind.js';
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
function appFunction(name,env){
  const start=source.indexOf(`function ${name}(`),brace=source.indexOf('{',start);
  assert(start>=0&&brace>start);let end=brace+1,depth=1;
  for(;depth;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
  const code=(source.slice(start-6,start)==='async '?'async ':'')+source.slice(start,end);
  return new Function(...Object.keys(env),`return ${code};`)(...Object.values(env));
}
function expression(code,env){return new Function(...Object.keys(env),`return (${code});`)(...Object.values(env));}
const view=VIEWS.find(v=>v.key==='realistic').id;
function renderMethod(env){
  const start=source.indexOf('async render() {'),brace=source.indexOf('{',start);
  assert(start>=0);let end=brace+1,depth=1;
  for(;depth;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
  return new Function(...Object.keys(env),`return async function render${source.slice(source.indexOf('(',start),end)};`)(...Object.values(env));
}
test('actual WORLD snapshot helper yields for native phases and counts confirmed images; BOX keeps synchronous pacing',async()=>{
  let ticks=0,accepted=0,fences=0;
  const driver={busy:true,displayedMainFrame:null},win={renderFrame:{driver}};
  const pacer={wake(){},get settled(){return accepted>=2;},settleLimit:4};
  const render=renderMethod({win,mapKind:kindOf(true),pacer,coreWait:Promise.resolve(),graphicsFailure:null,
    gpu:{async fence(){fences++;}},
    tick(){
      if(++ticks>20)throw Error('helper never converged');
      if(ticks>=8)setTimeout(()=>{driver.displayedMainFrame={frameIdentity:{accepted:++accepted}};driver.busy=false;},0);
    }});
  assert.equal(await render(),2);
  assert(ticks>=9,'pending native phases must not spend the four-image limit');
  assert(fences>=9);assert.equal(accepted,2);
  ticks=0;fences=0;
  const box=renderMethod({win:null,mapKind:kindOf(false),coreWait:Promise.resolve(),graphicsFailure:null,
    pacer:{wake(){},get settled(){return ticks>=2;},settleLimit:4},
    tick(){ticks++;},gpu:{async fence(){fences++;}}});
  assert.equal(await box(),2);assert.equal(ticks,2);assert.equal(fences,1);
});
test('WORLD snapshot rejects a no-image stall by elapsed time, not preparation tick count',async()=>{
  let wall=0,ticks=0;
  const render=renderMethod({mapKind:kindOf(true),win:{renderFrame:{driver:{busy:true,displayedMainFrame:null}}},
    coreWait:Promise.resolve(),graphicsFailure:null,performance:{now:()=>wall},
    pacer:{wake(){},settled:false,settleLimit:2},gpu:{async fence(){}},
    tick(){ticks++;wall+=2000;}});
  await assert.rejects(render(),/no MAIN image for 10 seconds/);
  assert.equal(ticks,5);
});

test('actual core startup retains physics/picks but never warms a BOX view for WORLD',()=>{
  // What a frame draws with (draw); the core adds the simulation's step kernels (s.ready).
  // A big map's first frame waits on draw alone (worldDrawWait), not on move/react.
  assert(source.includes('const core = coreWait = Promise.all([s.ready, ...draw])'));
  assert(source.includes('worldDrawWait = mapKind.stepKernelsLater ? Promise.all(draw) : core;'));
  const begin=source.indexOf('const draw = [')+'const draw = '.length;
  const code=source.slice(begin,source.indexOf('];\n',begin)+1);
  for(const worldMode of [{size:[1024,128,1024]},null]){
    const calls=[],physical=Promise.resolve('physics'),pick=Promise.resolve('pick');
    const vol={ready:pick,noiseReady:Promise.resolve(),viewReady(){calls.push('view');return Promise.resolve();}};
    const env={s:{ready:physical},derived:{ready:Promise.resolve()},vol,post:{ready:Promise.resolve()},
      overlays:{ready:Promise.resolve()},brush:{ready:Promise.resolve()},worldMode,mapKind:kindOf(!!worldMode),blocks:null,
      viewKeyOf:()=> 'realistic',settings:{view},baseDetail:()=>({}),warpNow:()=>null,nativeOwner:null};
    const draw=expression(code,env),waits=[env.s.ready,...draw];
    assert(!draw.includes(physical),'a frame never waits on the step kernels');
    assert(waits.includes(physical));assert(waits.includes(pick));assert(waits.includes(vol.noiseReady));
    assert.deepEqual(calls,worldMode?[]:['view']);
    const options=source.match(/vol = createVolume\(gpu, sim, (.*)\);/)[1];
    const opts=expression(options,{worldMode,mapKind:kindOf(!!worldMode),blocksOn:false,viewShadows:()=>true,viewKeyOf:()=> 'realistic',settings:{view},sceneByKey:()=>({})});
    assert.equal(opts.shadows,!worldMode);
  }
});

test('WORLD never requests legacy GI or block pipelines; BOX still does (no detail gate on either)',()=>{
  assert.match(source,/derived = mapKind\.boxDerived \? new Derived\(sim\) : null;/);
  for(const worldMode of [{size:[1024,128,1024]},null]){
    const calls=[],settings={view};
    // (build makes a big map no box derived passes: derived = mapKind.boxDerived ? new Derived(sim) : null)
    const env={worldMode,mapKind:kindOf(!!worldMode),blocksOn:false,settings,isMaterialView,
      derived:kindOf(!!worldMode).boxDerived?{prepareGI(){calls.push('GI');return Promise.resolve();}}:null,
      giWait:Promise.resolve(),giBuilt:0,wakeLoop(){},live:[],ctx:{},vol:{},detailVersion:0,
      post:{reset(){calls.push('reset');}}};
    appFunction('prepareGI',env)();appFunction('applyDetail',env)();
    assert.deepEqual(calls,worldMode?['reset']:['GI','reset']);
    let blocks=0;
    appFunction('setBlocks',{worldMode,mapKind:kindOf(!!worldMode),blocksOn:false,graphicsFailure:null,createBlocks(){blocks++;return {ready:Promise.resolve()};},
      gpu:{},sim:{},blocks:null,pacer:{wake(){}},post:{reset(){}}})(true);
    assert.equal(blocks,worldMode?0:1);
  }
});

test('WORLD view selection cannot build the retired shadow variant',()=>{
  for(const worldMode of [{size:[1024,128,1024]},null]){
    const calls=[],settings={view};
    appFunction('setView',{worldMode,mapKind:kindOf(!!worldMode),VIEWS,settings,isMaterialView,post:{reset(){}},meshFrames:{drop(){}},sim:{resetGI(){}},
      setBlocks(){},plainView:()=>false,prepareGI(){},viewKeyOf:()=> 'realistic',
      blocksOn:false,vol:{shadowState:'idle',shadowReady(){calls.push('shadow');return Promise.resolve();}},
      viewShadows:()=>true,pacer:{wake(){}},settingsPanel:{sync(){}},shaderPanel:{sync(){}},hud:{setLegend(){}},save(){}})(view);
    assert.deepEqual(calls,worldMode?[]:['shadow']);
  }
});

test('actual WORLD readiness waits core/queue without unrelated local view, GI or shadows',async()=>{
  for(const win of [{size:[1024,128,1024]},null]){
    const calls=[],sim={},vol={viewReady(){calls.push('view');return Promise.resolve();},shadowReady(){calls.push('shadow');return Promise.resolve();}};
    await appFunction('allReady',{win,mapKind:kindOf(!!win),sim,vol,coreWait:Promise.resolve(),coreReady:true,graphicsFailure:null,
      gpu:{async settled(){calls.push('queue');}},viewKeyOf:()=> 'realistic',settings:{view},blocksOn:false,blocks:null,
      warpNow:()=>null,viewShadows:()=>true,baseDetail:()=>({}),giWait:Promise.resolve(),physicsV2:null,
      // the BOX checkpoint's render resolution (syncRenderResolution): not under test here
      applyOutputRatio(){},syncRenderResolution(){},autoRes:{scale:1},isMaterialView,detailKey:d=>JSON.stringify(d)})();
    assert.deepEqual(calls,win?['queue']:['view','shadow','queue']);
  }
});

test('frame detail uses all selected defines on every map, never camera distance',()=>{
  // updateFrameDetail (app.js) returns it for the frame and the parked checkpoints alike;
  // there is no distance gate (2026-10-23): small and big maps draw one variant.
  const settings=Object.fromEntries(DETAIL.map(f=>[settingKey(f),true])),all=detailDefines(settings);
  settings.view=view;
  assert(Object.keys(all).length>0);
  assert.doesNotMatch(source,/detailGate|gateVariants/);
  const baseDetail=expression(source.match(/const baseDetail = (\(\) => .*);\n/)[1],{isMaterialView,settings,detailDefines});
  for(const win of [{size:[1024,128,1024]},null]){
    const volume={updateMatrixWorld(){},matrixWorld:{}},invVol={copy(){return {invert:()=>({})};}};
    const camGrid={copy(){return {applyMatrix4(){}};}},camera={position:{}};
    const frame=appFunction('updateFrameDetail',{volume,camGrid,camera,invVol,baseDetail,mapKind:kindOf(!!win)});
    assert.deepEqual(frame(),all,`${win?'WORLD':'BOX'}: every selected define`);
  }
});

test('loading never declares WORLD ready before a confirmed MAIN, even past old timeout',async()=>{
  let time=0,ready=0;const queued=[],win={loaded:true,renderFrame:{driver:{displayedMainFrame:null}}};
  // the real load watch, on this test's clock: a World that never shows MAIN is flagged, not left spinning
  const flags=[],timers=[];
  const loadWatch=createLoadWatch({now:()=>time,store:null,report:r=>flags.push(r),
    setTimer:(fn,ms)=>timers.push({fn,at:time+ms}),clearTimer:()=>{}});
  const fire=()=>{for(const t of timers.splice(0))if(t.at<=time)t.fn();else timers.push(t);};
  const launch={progress(){},ready(){ready++;}},env={win,mapKind:kindOf(true),launch,graphicsFailure:null,loadWatch,settings:{scene:'noitaTerrain05'},
    performance:{now:()=>time},requestAnimationFrame:fn=>queued.push(fn),setTimeout:fn=>queued.push(fn),
    READY_POLL_MS:100,READY_WAIT_MS:20000,MATCH_WAIT_MS:30000,mark(){},bootMap:null,coreReady:true};
  const quiet=console.error;console.error=()=>{};
  try{
    appFunction('bootReady',env)();
    await queued.shift()();await queued.shift()();
    assert.equal(ready,0);time=60000;await queued.shift()();assert.equal(ready,0);
    fire();
    assert.equal(flags.length,1,`past ${LOAD_FLAG_MS} ms without MAIN the load is flagged`);
    assert.equal(flags[0].kind,'slow');assert.equal(flags[0].map,'noitaTerrain05');assert.match(flags[0].step,/World renderer/);
    win.renderFrame.driver.displayedMainFrame={frameIdentity:{}};
    await queued.shift()();assert.equal(ready,1);
    assert.equal(loadWatch.active,false,'the screen coming down ends the watch');
  }finally{console.error=quiet;}
});

// A gamemode starting (Sandbox right after a big map's first frame) is render-only: the World
// owner's scene version must not follow modeEpoch, or every later frame is refused and the map
// freezes after loading (Island, 2026-10-22). One constant per window.
test('World frames keep one scene version per window, not the gamemode epoch',()=>{
  assert.match(source,/sceneVersion:WORLD_SCENE_VERSION,/);
  assert.doesNotMatch(source,/sceneVersion:\s*modeEpoch/);
  assert.match(source,/const WORLD_SCENE_VERSION = 1;/);
});
