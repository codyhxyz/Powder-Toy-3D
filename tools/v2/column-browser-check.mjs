// GPU: the production R1 kernel, not the full engine. Same fixture as slab.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';

const outputIndex=process.argv.indexOf('--out');
const output=outputIndex<0?null:process.argv[outputIndex+1];
if(outputIndex>=0 && (!output || output.startsWith('--'))) throw new Error('--out needs a path');
const vite=await startVite({harness:true,port:19621});
let browser;
try {
  browser=await launchBrowser();
  const errors=[];
  const page=await openHarness(browser,vite,'/tools/harness/outcomes.html?engine=v2',{errors});
  const result=await page.evaluate(async()=>{
    const {gridLayout}=await import('/src/sim.js');
    const {E}=await import('/src/elements.js');
    const {LAYOUT,tablesBuffer,cellSlot,slotCell}=await import('/src/shaders/common.js');
    const {v2ColumnWGSL,V2Params,V2_CONTACT_LAYOUT,v2ActLayout,v2Table}=await import('/src/shaders/v2.js');
    const {makeMaterial}=await import('/src/v2/layout.js');
    const {nativeFall}=await import('/tools/outcomes/native-grid.js');
    const gpu=window.__harness.gpu,g=gridLayout(32,32,32),a=v2ActLayout(g),buffers=[];
    const buffer=(name,size,data)=>{
      const b=gpu.createBuffer({label:name,size:Math.max(16,size),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
      buffers.push(b); if(data) gpu.queue.writeBuffer(b,0,data); return b;
    };
    try {
      const initial=new Uint32Array(g.slots*4),empty=makeMaterial(E.EMPTY).core,sand=makeMaterial(E.SAND).core;
      for(let s=0;s<g.slots;s++) initial.set(empty,s*4);
      for(let x=4;x<=27;x++) for(let z=4;z<=27;z++) initial.set(sand,cellSlot(g,x,28,z)*4);
      const active=new Uint32Array(a.words),columns=g.nx/4*g.nz/4;
      active[a.count+4]=columns;
      for(let c=0;c<columns;c++) active[a.cols+c]=c;
      const cells=buffer('R1 cells',initial.byteLength,initial);
      const act=buffer('R1 activity',active.byteLength,active);
      const ev=v2Table(),legacy=tablesBuffer();
      const entries=[
        [0,cells],[1,act],[2,buffer('R1 elements',ev.byteLength,ev)],
        [4,buffer('R1 banks',g.slots*4)],[6,buffer('R1 events',g.slots*4)],
      ].map(([binding,buffer])=>({binding,resource:{buffer}}));
      const tables=gpu.layout('R1 tables',LAYOUT.TABLES),material=gpu.layout('R1 material',V2_CONTACT_LAYOUT);
      const bind=[
        gpu.bindGroup(tables,[{binding:0,resource:{buffer:buffer('R1 legacy tables',legacy.byteLength,legacy)}}]),
        gpu.emptyGroup,gpu.bindGroup(material,entries),
      ];
      const kernel=gpu.kernel({name:'R1 runtime slab',code:v2ColumnWGSL(g),params:V2Params,
        layouts:[tables,gpu.L.EMPTY,material],workgroupSize:[64,1,1]});
      await kernel.ready;
      const rows=[];
      for(let tick=1;tick<=180;tick++) {
        kernel.dispatch(gpu.frame,[Math.ceil(columns*16/64),1,1],{bind,params:{
          tick,busyIn:0,busyOut:g.nbricks,full:0,offset:[0,0,0],preserveLegacyMarks:0,
          gravMode:0,edge:0,airMode:0,ambientHeat:0,gravity:19.6,ambient:20,
        }});
        if(tick%30===0) {
          await gpu.fence();
          const raw=new Uint32Array(await gpu.readback.buffer(cells,0,initial.byteLength));
          let n=0,sum=0,lo=Infinity,hi=-Infinity,floor=0;
          for(let s=0;s<g.slots;s++) if((raw[s*4]&255)===E.SAND) {
            const y=slotCell(g,s)[1]; n++; sum+=y; lo=Math.min(lo,y);hi=Math.max(hi,y);floor+=+(y===0);
          }
          rows.push({tick,n,thickness:hi-lo+1,floor,fallen:28-sum/n,ideal:Math.min(28,nativeFall(E.SAND,tick/60))});
        }
      }
      return {scope:'production R1 only',ticks:180,fixture:[32,32,32],grains:576,rows,failures:[...window.__harness.failures]};
    } finally { for(const b of buffers) b.destroy(); }
  });
  result.errors=errors;
  if(output && output!=='--out') writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  assert.deepEqual(errors,[]);
  assert.deepEqual(result.failures,[]);
  for(const r of result.rows) {
    assert.equal(r.n,576,'mass retained');
    assert.equal(r.thickness,1,'slab remains one layer');
    assert(Math.abs(r.fallen-r.ideal)<=1,`fall law at tick ${r.tick}: ${r.fallen} versus ${r.ideal}`);
  }
  assert.equal(result.rows.at(-1).floor,576,'all grains land');
  console.log(JSON.stringify(result,null,2));
} finally {
  await browser?.close();
  await vite.close();
}
