// CPU-only execution of actual App startup/view boundaries; no browser or GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gateVariants} from '../src/gfx/detailGate.js';
import {DETAIL,settingKey} from '../src/gfx/detail.js';
import {VIEWS,isMaterialView,isTestView} from '../src/views.js';
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
  const render=renderMethod({win,pacer,coreWait:Promise.resolve(),graphicsFailure:null,
    gpu:{async fence(){fences++;}},
    tick(){
      if(++ticks>20)throw Error('helper never converged');
      if(ticks>=8)setTimeout(()=>{driver.displayedMainFrame={frameIdentity:{accepted:++accepted}};driver.busy=false;},0);
    }});
  assert.equal(await render(),2);
  assert(ticks>=9,'pending native phases must not spend the four-image limit');
  assert(fences>=9);assert.equal(accepted,2);
  ticks=0;fences=0;
  const box=renderMethod({win:null,coreWait:Promise.resolve(),graphicsFailure:null,
    pacer:{wake(){},get settled(){return ticks>=2;},settleLimit:4},
    tick(){ticks++;},gpu:{async fence(){fences++;}}});
  assert.equal(await box(),2);assert.equal(ticks,2);assert.equal(fences,1);
});
test('WORLD snapshot rejects a no-image stall by elapsed time, not preparation tick count',async()=>{
  let wall=0,ticks=0;
  const render=renderMethod({win:{renderFrame:{driver:{busy:true,displayedMainFrame:null}}},
    coreWait:Promise.resolve(),graphicsFailure:null,performance:{now:()=>wall},
    pacer:{wake(){},settled:false,settleLimit:2},gpu:{async fence(){}},
    tick(){ticks++;wall+=2000;}});
  await assert.rejects(render(),/no MAIN image for 10 seconds/);
  assert.equal(ticks,5);
});

test('actual core startup retains physics/picks but never warms a BOX view for WORLD',()=>{
  const begin=source.indexOf('const core = coreWait = Promise.all(')+'const core = coreWait = Promise.all('.length;
  const code=source.slice(begin,source.indexOf(']).then(',begin)+1);
  for(const worldMode of [{size:[1024,128,1024]},null]){
    const calls=[],physical=Promise.resolve('physics'),pick=Promise.resolve('pick');
    const vol={ready:pick,noiseReady:Promise.resolve(),viewReady(){calls.push('view');return Promise.resolve();}};
    const env={s:{ready:physical},derived:{ready:Promise.resolve()},vol,post:{ready:Promise.resolve()},
      overlays:{ready:Promise.resolve()},brush:{ready:Promise.resolve()},hybridWait:Promise.resolve(),worldMode,blocks:null,
      viewKeyOf:()=> 'realistic',settings:{view},baseDetail:()=>({}),warpNow:()=>null};
    const waits=expression(code,env);
    assert(waits.includes(physical));assert(waits.includes(pick));assert(waits.includes(vol.noiseReady));
    assert.deepEqual(calls,worldMode?[]:['view']);
    const options=source.match(/vol = createVolume\(gpu, sim, (.*)\);/)[1];
    const opts=expression(options,{worldMode,blocksOn:false,viewShadows:()=>true,viewKeyOf:()=> 'realistic',settings:{view},sceneByKey:()=>({})});
    assert.equal(opts.shadows,!worldMode);
  }
});

test('WORLD never requests legacy GI, detail variants or block pipelines; BOX still does',()=>{
  for(const worldMode of [{size:[1024,128,1024]},null]){
    const calls=[],settings={view};
    const env={worldMode,blocksOn:false,settings,isMaterialView,derived:{prepareGI(){calls.push('GI');return Promise.resolve();}},
      giWait:Promise.resolve(),giBuilt:0,wakeLoop(){},live:[],ctx:{},vol:{},detailVersion:0,
      detailGate:{dispose(){calls.push('dispose gate');},configure(){calls.push('configure gate');}},
      post:{reset(){calls.push('reset');}}};
    appFunction('prepareGI',env)();appFunction('applyDetail',env)();
    assert.deepEqual(calls,worldMode?['dispose gate','reset']:['GI','configure gate','reset']);
    let blocks=0;
    appFunction('setBlocks',{worldMode,blocksOn:false,graphicsFailure:null,createBlocks(){blocks++;return {ready:Promise.resolve()};},
      gpu:{},sim:{},blocks:null,pacer:{wake(){}},post:{reset(){}}})(true);
    assert.equal(blocks,worldMode?0:1);
  }
});

test('WORLD view selection cannot build the retired shadow or detail variant',()=>{
  for(const worldMode of [{size:[1024,128,1024]},null]){
    const calls=[],settings={view};
    appFunction('setView',{worldMode,VIEWS,settings,isMaterialView,isTestView,hybridUnavailable:false,ensureHybrid(){},post:{reset(){}},meshFrames:{drop(){}},sim:{resetGI(){}},
      detailGate:{setView(){calls.push('detail');}},setBlocks(){},plainView:()=>false,prepareGI(){},viewKeyOf:()=> 'realistic',
      blocksOn:false,vol:{shadowState:'idle',shadowReady(){calls.push('shadow');return Promise.resolve();}},
      viewShadows:()=>true,pacer:{wake(){}},settingsPanel:{sync(){}},shaderPanel:{sync(){}},hud:{setLegend(){}},save(){}})(view);
    assert.deepEqual(calls,worldMode?[]:['detail','shadow']);
  }
});

test('actual WORLD readiness waits core/queue without unrelated local view, GI or shadows',async()=>{
  for(const win of [{size:[1024,128,1024]},null]){
    const calls=[],sim={},vol={viewReady(){calls.push('view');return Promise.resolve();},shadowReady(){calls.push('shadow');return Promise.resolve();}};
    await appFunction('allReady',{win,sim,vol,coreWait:Promise.resolve(),coreReady:true,graphicsFailure:null,hybridLoad:null,hybrid:null,hybridWait:Promise.resolve(),
      gpu:{async settled(){calls.push('queue');}},viewKeyOf:()=> 'realistic',settings:{view},blocksOn:false,blocks:null,
      warpNow:()=>null,viewShadows:()=>true,baseDetail:()=>({}),giWait:Promise.resolve(),physicsV2:null})();
    assert.deepEqual(calls,win?['queue']:['view','shadow','queue']);
  }
});

test('WORLD Test fallback never allocates unused local hybrid pipelines',()=>{
  for(const hybridOptIn of [false,true]){
    appFunction('ensureHybrid',{worldMode:{},hybridOptIn,isTestView,settings:{view:VIEWS.find(v=>v.key==='test').id},hybrid:null,
      hybridModule:{createHybridRenderer(){throw Error('WORLD must use its global data wire');}}})();
  }
});

test('WORLD frame detail uses all selected defines, never camera distance from physics',()=>{
  const code=source.match(/frameDetail = win \? .*;/)[0];
  const settings=Object.fromEntries(DETAIL.map(f=>[settingKey(f),true])),all=gateVariants(settings).near;
  assert(Object.keys(all).length>0);
  const detailGate={update(){throw Error('WORLD must not query the local detail gate');}};
  const actual=new Function('win','gateVariants','settings','detailGate','camera','camGrid','sim','canvas','post',
    `let frameDetail;${code}return frameDetail;`)({},gateVariants,settings,detailGate);
  assert.deepEqual(actual,all);
  const box={legacy:1};
  const result=new Function('win','gateVariants','settings','detailGate','camera','camGrid','sim','canvas','post',
    `let frameDetail;${code}return frameDetail;`)(null,gateVariants,settings,{update:()=>box},null,null,{g:{nx:128,ny:128,nz:128}},{height:200},{renderScale:1});
  assert.equal(result,box);
});

test('loading never declares WORLD ready before a confirmed MAIN, even past old timeout',async()=>{
  let time=0,ready=0;const queued=[],win={loaded:true,renderFrame:{driver:{displayedMainFrame:null}}};
  const launch={progress(){},ready(){ready++;}},env={win,launch,graphicsFailure:null,
    performance:{now:()=>time},requestAnimationFrame:fn=>queued.push(fn),setTimeout:fn=>queued.push(fn),
    READY_POLL_MS:100,READY_WAIT_MS:20000,MATCH_WAIT_MS:30000,mark(){},bootMap:null};
  appFunction('bootReady',env)();
  await queued.shift()();await queued.shift()();
  assert.equal(ready,0);time=60000;await queued.shift()();assert.equal(ready,0);
  win.renderFrame.driver.displayedMainFrame={frameIdentity:{}};
  await queued.shift()();assert.equal(ready,1);
});
