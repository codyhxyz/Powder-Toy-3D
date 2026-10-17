// GPU: production R2–R5 kernel, not the full engine. Closed thermal fixture.
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync } from 'node:fs';
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';

const outputIndex=process.argv.indexOf('--out');
const output=outputIndex<0?null:process.argv[outputIndex+1];
if(outputIndex>=0 && (!output || output.startsWith('--'))) throw Error('--out needs a path');
const dumpIndex=process.argv.indexOf('--dump-shaders');
const dump=dumpIndex<0?null:process.argv[dumpIndex+1];
if(dumpIndex>=0 && (!dump || dump.startsWith('--')))throw Error('--dump-shaders needs a path');
if(dump)writeFileSync(dump,'');
const vite=await startVite({harness:true,port:19627});
let browser;
try {
  browser=await launchBrowser(dump ? {
    args:['--enable-dawn-features=dump_shaders,disable_symbol_renaming'],
    browserLog:line=>appendFileSync(dump,line+'\n'),
  } : {});
  const errors=[];
  const page=await openHarness(browser,vite,'/tools/harness/outcomes.html?engine=v2',{errors});
  page.on('console',m=>{if(m.text().startsWith('[contact-trace]'))console.log(m.text());});
  const result=await page.evaluate(async(fixedBounds)=>{
    const {gridLayout}=await import('/src/sim.js');
    const {E}=await import('/src/elements.js');
    const {LAYOUT,tablesBuffer,cellSlot}=await import('/src/shaders/common.js');
const {v2BlockWGSL,v2SupportWGSL,V2Params,V2_CONTACT_LAYOUT,v2ActLayout,v2Table}=await import('/src/shaders/v2.js');
    const {contactWGSL}=await import('/src/shaders/v2/contact.js');
    const {makeMaterial,energyOf}=await import('/src/v2/layout.js');
    const gpu=window.__harness.gpu,g=gridLayout(32,32,32),a=v2ActLayout(g),buffers=[];
    const traceStart=performance.now();
    const trace=(stage,extra={})=>console.log('[contact-trace] '+JSON.stringify({ms:performance.now()-traceStart,stage,...extra}));
    for(const key of ['createShaderModule','createPipelineLayout','popErrorScope','createComputePipelineAsync']) {
      const original=gpu.device[key].bind(gpu.device);
      gpu.device[key]=(...args)=>{
        trace(key+':start');
        const result=original(...args);
        if(result?.then)result.then(()=>trace(key+':ready'),e=>trace(key+':failed',{error:String(e)}));
        else trace(key+':returned');
        if(key==='createShaderModule')result.getCompilationInfo().then(
          info=>trace('shader-info',{messages:info.messages.map(m=>m.message)}),
          e=>trace('shader-info:failed',{error:String(e)}));
        return result;
      };
    }
    const buffer=(name,size,data)=>{
      const b=gpu.createBuffer({label:name,size:Math.max(16,size),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
      buffers.push(b);if(data)gpu.queue.writeBuffer(b,0,data);return b;
    };
    const total=(raw,banks)=>{
      let energy=0n,metal=0;
      for(let s=0;s<g.slots;s++) {
        const core=raw.subarray(s*4,s*4+4);
        energy+=energyOf({core,bank:banks[s]});
        metal+=+( (core[0]&255)===E.METAL );
      }
      return {energy:String(energy),metal};
    };
    try {
      const initial=new Uint32Array(g.slots*4),bankData=new Int32Array(g.slots);
      for(let s=0;s<g.slots;s++)initial.set(makeMaterial(E.EMPTY).core,s*4);
      const hot=cellSlot(g,7,7,7),cold=cellSlot(g,8,7,7);
      if(!Number.isInteger(E.METAL) || E.METAL===E.EMPTY)throw Error('invalid thermal fixture material');
      initial.set(makeMaterial(E.METAL,600).core,hot*4);
      initial.set(makeMaterial(E.METAL,20).core,cold*4);
      const before=total(initial,bankData);
      const beforeHot=String(energyOf({core:initial.subarray(hot*4,hot*4+4),bank:0}));
      const beforeCold=String(energyOf({core:initial.subarray(cold*4,cold*4+4),bank:0}));
      const active=new Uint32Array(a.words);
      active[a.count+3]=g.nbricks;
      for(let b=0;b<g.nbricks;b++)active[a.list+b]=b;
      const cells=buffer('contact cells',initial.byteLength,initial);
      const banks=buffer('contact banks',bankData.byteLength,bankData);
      const ev=v2Table(),legacy=tablesBuffer();
      const entries=[
        [0,cells],[1,buffer('contact activity',active.byteLength,active)],
        [2,buffer('contact elements',ev.byteLength,ev)],[4,banks],
        [5,buffer('contact atmosphere / liquid scratch',g.slots*16)],
        [6,buffer('contact events',g.slots*4)],
      ].map(([binding,buffer])=>({binding,resource:{buffer}}));
      const tables=gpu.layout('contact tables',LAYOUT.TABLES),material=gpu.layout('contact material',V2_CONTACT_LAYOUT);
      const bind=[gpu.bindGroup(tables,[{binding:0,resource:{buffer:buffer('contact legacy tables',legacy.byteLength,legacy)}}]),
        gpu.emptyGroup,gpu.bindGroup(material,entries)];
      const start=performance.now();
let code=v2BlockWGSL(g,contactWGSL);
      if(fixedBounds)for(const [before,after] of [
        ['let blockCount=min(8u,arrayLength(&events));','let blockCount=8u;'],
        ['let count=min(8u,arrayLength(&events));','let count=8u;'],
        ['fn ctNeighborCount()->i32 { return i32(min(3u,arrayLength(&events))); }','fn ctNeighborCount()->i32 { return 3; }'],
      ]) {
        if(code.split(before).length!==2)throw Error('fixed-bound diagnostic source drift');
        code=code.replace(before,after);
      }
      const kernel=gpu.kernel({name:'production contact thermal check',code,params:V2Params,
        layouts:[tables,gpu.L.EMPTY,material],workgroupSize:[64,1,1]});
      const support=gpu.kernel({name:'production contact support snapshot',code:v2SupportWGSL(g),params:V2Params,
        layouts:[tables,gpu.L.EMPTY,material],workgroupSize:[64,1,1]});
      await Promise.all([kernel.ready,support.ready]);
      const compileMs=performance.now()-start;
      for(let tick=1;tick<=32;tick++) {
        const params={tick,busyIn:0,busyOut:g.nbricks,full:0,offset:[0,0,0],preserveLegacyMarks:0,
          gravMode:1,edge:0,airMode:0,ambientHeat:0,gravity:0,ambient:20};
        support.dispatch(gpu.frame,[g.nbricks,1,1],{bind,params});
        kernel.dispatch(gpu.frame,[Math.ceil(g.nbricks/8),1,1],{bind,params});
      }
      await gpu.fence();
      const [rawBytes,bankBytes]=await Promise.all([
        gpu.readback.buffer(cells,0,initial.byteLength),gpu.readback.buffer(banks,0,bankData.byteLength),
      ]);
      const raw=new Uint32Array(rawBytes),afterBanks=new Int32Array(bankBytes);
      return {scope:'production R2–R5 runtime, noncompact fallback',
        variant:fixedBounds?'fixed-bound diagnostic':'production',
        ticks:32,fixture:[32,32,32],compileMs,before,after:total(raw,afterBanks),
        beforeHot,beforeCold,afterHot:String(energyOf({core:raw.subarray(hot*4,hot*4+4),bank:afterBanks[hot]})),
        afterCold:String(energyOf({core:raw.subarray(cold*4,cold*4+4),bank:afterBanks[cold]})),
        failures:[...window.__harness.failures]};
    } finally {for(const b of buffers)b.destroy();}
  },process.argv.includes('--fixed-bounds'));
  result.errors=errors;
  if(output)writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  assert.deepEqual(errors,[]);assert.deepEqual(result.failures,[]);
  assert.equal(result.before.metal,2,'valid two-cell thermal fixture');
  assert.equal(result.after.metal,2,'solid mass retained');
  assert.equal(result.after.energy,result.before.energy,'closed thermal energy conserved exactly');
  assert(BigInt(result.afterHot)<BigInt(result.beforeHot),'hot material loses heat');
  assert(BigInt(result.afterCold)>BigInt(result.beforeCold),'cold material receives heat');
  console.log(JSON.stringify(result,null,2));
} finally {await browser?.close();await vite.close();}
