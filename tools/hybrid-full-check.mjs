// One guarded native slot. No performance conclusion from this correctness test.
import assert from 'node:assert/strict';
import { launchBrowser,newTestPage,ready,gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { watchFailures,validateFixture } from './harness/hybrid-full.js';
validateFixture(); // pure preconditions must fail before taking a GPU slot
const args=process.argv.slice(2);
const flags=new Set(args);
const modes=['--readback-only','--readback-controls','--mixed-readback-controls'];
assert(flags.size===args.length&&args.every(arg=>[...modes,'--gpudebug'].includes(arg))
  &&modes.filter(mode=>flags.has(mode)).length<=1,
  'Usage: node tools/hybrid-full-check.mjs [--readback-only | --readback-controls | --mixed-readback-controls] [--gpudebug]');
const readbackOnly=flags.has('--readback-only'),mixed=flags.has('--mixed-readback-controls');
const controls=mixed||flags.has('--readback-controls'),debug=flags.has('--gpudebug');
const vite=await startVite({port:58476,harness:true});
let browser,started,diagnosticPage;
let errors=[],offlineRelay=[];
const phase=message=>console.log(`[hybrid correctness] ${message}`);
try{
  phase('browser startup');
  started=Date.now();browser=await launchBrowser({lifetimeMs:25000,
    browserLog:line=>console.error(`[native browser] ${line}`)});
  if(controls){
    const results=[];
    for(const renderer of ['legacy','hybrid']){
      phase(`${mixed?'mixed-scene':'empty-frame'} readback control: ${renderer}`);
      const page=await newTestPage(browser,{mode:'manual',viewport:{width:800,height:600}});
      const failures=watchFailures(page);({errors,offlineRelay}=failures);
      try{
        await page.routeWebSocket(/.*/,()=>{});
        await failures.check(page.goto(vite.url(`/?renderer=${renderer}&test=manual&view=realistic&size=128&preset=empty&paused=1${debug?'&gpudebug=1':''}`)));
        await failures.check(ready(page));
        const result=await failures.check(page.evaluate(async mixed=>{
          const h=await import('/tools/harness/hybrid-full.js');return h.sceneReadbackControl(window.__app,mixed);
        },mixed));
        assert.equal(result.hybrid,renderer==='hybrid');
        assert.equal(errors.length,0,errors.join('\n'));
        results.push({renderer,...result});
      }finally{await page.close();}
    }
    console.log(JSON.stringify({passed:true,debug,validation:`${mixed?'mixed-scene':'empty-render'} readback controls only`,results},null,2));
  }else{
  const page=await newTestPage(browser,{mode:'manual',viewport:{width:800,height:600}});
  diagnosticPage=page;
  const failures=watchFailures(page);
  ({errors,offlineRelay}=failures);
  page.on('console',m=>{
    if(m.text().startsWith('[hybrid correctness]'))console.log(m.text());
  });
  await page.routeWebSocket(/.*/,()=>{});
  phase('page navigation');
  await failures.check(page.goto(vite.url(`/?renderer=hybrid&test=manual&view=realistic&size=128&preset=empty&paused=1${debug?'&gpudebug=1':''}`)));
  phase('app initialization');
  await failures.check(ready(page));
  const result=await failures.check(page.evaluate(async only=>{
    const h=await import('/tools/harness/hybrid-full.js'),a=window.__app;
    if(only){a.test.park();await a.test.ready();return{readback:await h.verifyReadback(a.gpu)};}
    return h.run(a);
  },readbackOnly));
  let snapshot,fallback;
  if(!readbackOnly){
    snapshot=`/tmp/tpt-hybrid-full-${process.pid}.png`;
    phase('diagnostic screenshot (not converged visual acceptance) and data-view regression');
    await failures.check(page.screenshot({path:snapshot}));
    fallback=await failures.check(page.evaluate(async()=>{
      const a=window.__app;a.setView(1);await a.test.ready();await a.test.renderOnce();
      return{enabled:a.hybrid.enabled,split:a.sim.derived.particleSplit,reason:a.hybrid.stats.reason,steps:a.sim.frame};
    }));
    assert(!fallback.enabled&&!fallback.split&&fallback.steps===result.steps,JSON.stringify(fallback));
  }
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({passed:true,debug,validation:readbackOnly?'readback only':'numerical scene (not converged visual acceptance)',
    result,fallback,snapshot,offlineRelay,adapter:await gpuInfo(page)},null,2));
  }
}catch(error){
  if(errors.length)console.error(errors.join('\n'));
  if(diagnosticPage&&!diagnosticPage.isClosed()&&!readbackOnly){
    const snapshot=`/tmp/tpt-hybrid-failed-${process.pid}.png`;
    try{
      await diagnosticPage.screenshot({path:snapshot,timeout:1000});
      console.error(`Failure diagnostic screenshot (not converged acceptance): ${snapshot}`);
    }catch(snapshotError){console.error(`Failure screenshot unavailable: ${snapshotError.message}`);}
  }
  throw error;
}finally{
  await browser?.close();await vite.close();
  if(started)console.log(`Total player-check/startup/compilation/assertions/cleanup occupancy: ${Date.now()-started} ms`);
}
