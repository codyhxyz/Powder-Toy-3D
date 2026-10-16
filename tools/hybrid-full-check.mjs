// One guarded native slot. No performance conclusion from this correctness test.
import assert from 'node:assert/strict';
import { launchBrowser,newTestPage,ready,gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { watchFailures } from './harness/hybrid-full.js';
const vite=await startVite({port:58476,harness:true});
let browser,started;
let errors=[],offlineRelay=[];
const phase=message=>console.log(`[hybrid correctness] ${message}`);
try{
  phase('browser startup');
  started=Date.now();browser=await launchBrowser({lifetimeMs:25000});
  const page=await newTestPage(browser,{mode:'manual',viewport:{width:800,height:600}});
  const failures=watchFailures(page);
  ({errors,offlineRelay}=failures);
  page.on('console',m=>{
    if(m.text().startsWith('[hybrid correctness]'))console.log(m.text());
  });
  await page.routeWebSocket(/.*/,()=>{});
  phase('page navigation');
  await failures.check(page.goto(vite.url('/?renderer=hybrid&test=manual&view=realistic&size=128&preset=empty&paused=1')));
  phase('app initialization');
  await failures.check(ready(page));
  const result=await failures.check(page.evaluate(async()=>{const {run}=await import('/tools/harness/hybrid-full.js');return run(window.__app);}));
  const snapshot=`/tmp/tpt-hybrid-full-${process.pid}.png`;
  phase('screenshot and data-view regression');
  await failures.check(page.screenshot({path:snapshot}));
  const fallback=await failures.check(page.evaluate(async()=>{
    const a=window.__app;a.setView(1);await a.test.render();
    return{enabled:a.hybrid.enabled,split:a.sim.derived.particleSplit,reason:a.hybrid.stats.reason,steps:a.sim.frame};
  }));
  assert(!fallback.enabled&&!fallback.split&&fallback.steps===result.steps,JSON.stringify(fallback));
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({passed:true,result,fallback,snapshot,offlineRelay,adapter:await gpuInfo(page)},null,2));
}catch(error){
  if(errors.length)console.error(errors.join('\n'));
  throw error;
}finally{
  await browser?.close();await vite.close();
  if(started)console.log(`Total player-check/startup/compilation/assertions/cleanup occupancy: ${Date.now()-started} ms`);
}
