// Bounded real-GPU follow-up; not part of CPU checks.
// node tools/presentation-check.mjs --port 54939 --out /tmp/presentation-check
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
const args=process.argv.slice(2), option=(key,fallback)=>args.includes(`--${key}`)?args[args.indexOf(`--${key}`)+1]:fallback;
const out=option('out','/tmp/presentation-check'); mkdirSync(out,{recursive:true});
const browser=await launchBrowser({lifetimeMs:300000});
try {
  const page=await newTestPage(browser,{mode:'ui',viewport:{width:1100,height:750}}), errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
  await page.goto(`http://localhost:${option('port','54939')}/?map=willowCove&mode=animalCrossing&paused=1`);
  await ready(page);
  await page.waitForFunction(()=>{
    const a=window.__app;
    return a?.presentation.active && a.win?.loaded && a.win.far.ready && !a.win.far.queue.length;
  },null,{timeout:180000,polling:250});
  await page.evaluate(()=>{
    const a=window.__app; a.test.park(); a.autoRes.enabled=false;
    a.day.fixed={az:35,el:32};
  });
  await render(page); await page.screenshot({path:join(out,'home-curved.png')});
  const baseline=await page.evaluate(async()=>{
    const a=window.__app;
    window.__presentationSim=a.sim;
    return {current:a.current(),version:a.sim.version,running:a.pov.game.running,pov:a.pov.active};
  });
  assert.equal(baseline.current.mode,'animalCrossing'); assert.equal(baseline.running,false); assert.equal(baseline.pov,false);
  await page.evaluate(()=>window.__app.setMode('sandbox'));
  await render(page); await page.screenshot({path:join(out,'home-flat.png')});
  assert(await page.evaluate(v=>window.__app.sim===window.__presentationSim && window.__app.sim.version===v,baseline.version));
  await page.evaluate(()=>window.__app.setMode('animalCrossing'));
  const pick=await page.evaluate(async()=>{
    const a=window.__app,{E}=await import('/src/elements.js'),{warp}=await import('/src/gfx/presentationMath.js');
    // Regression: Metal rounded the 31st cell exit differently when re-solved,
    // making this visible target miss. Traversal must retain its crossed face.
    const target=new a.THREE.Vector3(82.5,95.5,82.5),eye=new a.THREE.Vector3(50,110,30);
    a.sim.paint({center:target,radius:1,shape:1,tool:E.WALL,rate:1,replace:true});
    a.camera.position.copy(eye).multiplyScalar(a.scale).add(a.volume.position);
    a.camera.lookAt(target.clone().multiplyScalar(a.scale).add(a.volume.position));
    a.camera.updateMatrixWorld(); a.test.render();
    const world=target.clone().add(a.sim.origin);
    const displayed=new a.THREE.Vector3().fromArray(warp(world.toArray(),a.presentation.parameters)).sub(a.sim.origin);
    const direction=displayed.sub(eye).normalize();
    const visible=await a.pickScreenRay(eye,direction);
    const physicalDirection=target.clone().sub(eye).normalize();
    const physical=await a.pickRay(eye,physicalDirection);
    const version=a.sim.version;
    a.setMode('sandbox'); a.test.render();
    const after=await a.pickRay(eye,physicalDirection);
    a.setMode('animalCrossing'); a.test.render();
    return {visible:{valid:visible.valid,id:visible.id,cell:visible.cell.toArray()},physical:physical.cell.toArray(),after:after.cell.toArray(),wall:E.WALL,unchanged:version===a.sim.version};
  });
  assert(pick.visible.valid); assert.equal(pick.visible.id,pick.wall);
  assert.deepEqual(pick.physical,pick.after); assert(pick.unchanged);
  await render(page); await page.screenshot({path:join(out,'target-curved.png')});
  // Moving the anchor exercises current inverse -> previous forward reprojection,
  // not resetting history on each camera step. Capture after a short bounded walk.
  await page.evaluate(()=>{
    const a=window.__app;
    for(let i=0;i<8;i++) {a.camera.position.x+=a.scale; a.camera.updateMatrixWorld(); a.test.render();}
  });
  await page.screenshot({path:join(out,'moving-anchor.png')});
  await page.evaluate(()=>window.__app.openMap('lab','animalCrossing'));
  await render(page);
  const switched=await page.evaluate(async()=>{
    const a=window.__app;
    return {current:a.current(),active:a.presentation.active,box:a.volume.geometry===a.volume.userData.boxGeometry};
  });
  assert.deepEqual(switched,{current:{map:'lab',mode:'sandbox'},active:false,box:true});
  assert.deepEqual(errors.filter(error=>!error.includes('ERR_CONNECTION_REFUSED')),[]);
  console.log(`presentation GPU checks passed; inspect A/B, water/depth/meshes and moving history at ${out}`);
} finally {await browser.close();}
