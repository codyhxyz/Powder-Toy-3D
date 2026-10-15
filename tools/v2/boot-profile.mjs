// GPU: durable pipeline-ready timing for a full native engine cold start.
import { appendFileSync, writeFileSync } from 'node:fs';
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';
import { select } from '../outcomes/tests/index.js';

const i=process.argv.indexOf('--out'),output=i<0?null:process.argv[i+1];
if(!output || output.startsWith('--')) throw new Error('--out needs a JSONL path');
const ti=process.argv.indexOf('--test');
const testName=ti>=0?process.argv[ti+1]:process.argv.includes('--slab')?'slab':null;
if(ti>=0 && (!testName || testName.startsWith('--'))) throw new Error('--test needs an outcome name');
if(testName) select({tests:testName});
writeFileSync(output,'');
const vite=await startVite({harness:true,port:19623});
let browser;
try {
  browser=await launchBrowser();
  const errors=[];
  const page=await openHarness(browser,vite,'/tools/harness/outcomes.html?engine=v2',{errors});
  page.on('console',m=>{
    if(m.text().startsWith('NATIVE_BOOT ')) {
      const line=m.text().slice('NATIVE_BOOT '.length);
      appendFileSync(output,line+'\n');
      console.log(line);
    }
  });
  const result=await page.evaluate(async(testName)=>{
    const gpu=window.__harness.gpu,start=performance.now(),original=gpu.kernel.bind(gpu);
    const note=row=>console.info('NATIVE_BOOT '+JSON.stringify({ms:Math.round(performance.now()-start),...row}));
    const compile=gpu.device.createComputePipelineAsync.bind(gpu.device);
    gpu.device.createComputePipelineAsync=desc=>{
      note({stage:'backend-start',name:desc.label});
      return compile(desc).then(value=>{note({stage:'backend-ready',name:desc.label});return value;});
    };
    gpu.kernel=desc=>{
      note({stage:desc.build==='manual'?'deferred':'queued',name:desc.name});
      const k=original(desc);
      if(desc.build==='idle' || desc.build==='manual') {
        const build=k.build.bind(k);
        k.build=()=>{if(k.state==='idle')note({stage:'building',name:desc.name});return build();};
      } else note({stage:'building',name:desc.name});
      k.ready.then(()=>note({stage:'ready',name:desc.name}),e=>note({stage:'failed',name:desc.name,error:String(e)}));
      return k;
    };
    const {createEngine}=await import('/tools/outcomes/engine-v2.js');
    const engine=createEngine(gpu);
    try {
      if(testName) {
        const create=engine.create.bind(engine);
        engine.create=async(...args)=>{const value=await create(...args);note({stage:'engine-ready'});return value;};
        const {runTest}=await import('/tools/outcomes/run.js');
        for(const method of ['read','advance']) {
          const original=engine[method].bind(engine);
          engine[method]=async(...args)=>{
            note({stage:method+'-start',args});
            const value=await original(...args);
            note({stage:method+'-ready',steps:engine.steps});
            return value;
          };
        }
        const {byName}=await import('/tools/outcomes/tests/index.js');
        const outcome=await runTest(byName(testName),engine,{seed:1});
        note({stage:'outcome',result:outcome});
        return {outcome,failures:[...window.__harness.failures]};
      }
      await engine.create([32,32,32]);
      note({stage:'engine-ready'});
      return {ready:true,failures:[...window.__harness.failures]};
    } finally { await engine.dispose();gpu.kernel=original;gpu.device.createComputePipelineAsync=compile; }
  },testName);
  appendFileSync(output,JSON.stringify({result,errors})+'\n');
  if(errors.length || result.failures.length) throw new Error('GPU boot validation failed; see report');
  if(result.outcome && result.outcome.status!=='pass') throw new Error(`Native ${testName} ${result.outcome.status}; see report`);
} finally {
  await browser?.close();
  await vite.close();
}
