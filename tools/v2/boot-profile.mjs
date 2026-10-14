// GPU: durable pipeline-ready timing for a full native engine cold start.
import { appendFileSync, writeFileSync } from 'node:fs';
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';

const i=process.argv.indexOf('--out'),output=i<0?null:process.argv[i+1];
if(!output || output.startsWith('--')) throw new Error('--out needs a JSONL path');
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
  const result=await page.evaluate(async()=>{
    const gpu=window.__harness.gpu,start=performance.now(),original=gpu.kernel.bind(gpu);
    const note=row=>console.info('NATIVE_BOOT '+JSON.stringify({ms:Math.round(performance.now()-start),...row}));
    gpu.kernel=desc=>{
      note({stage:desc.build==='manual'?'deferred':'queued',name:desc.name});
      const k=original(desc);
      k.ready.then(()=>note({stage:'ready',name:desc.name}),e=>note({stage:'failed',name:desc.name,error:String(e)}));
      return k;
    };
    const {createEngine}=await import('/tools/outcomes/engine-v2.js');
    const engine=createEngine(gpu);
    try {
      await engine.create([32,32,32]);
      note({stage:'engine-ready'});
      return {ready:true,failures:[...window.__harness.failures]};
    } finally { await engine.dispose();gpu.kernel=original; }
  });
  appendFileSync(output,JSON.stringify({result,errors})+'\n');
  if(errors.length || result.failures.length) throw new Error('GPU boot validation failed; see report');
} finally {
  await browser?.close();
  await vite.close();
}
