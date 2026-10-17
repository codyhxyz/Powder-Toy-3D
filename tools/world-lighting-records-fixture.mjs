// Actual Source/SceneGpu/Producer/CELL classes with delayed native commands.
// Synthetic generator/field execution is transport evidence, NOT GPU parity.
import { CellTestGPU } from './cell-adapter-test-gpu.mjs';
import { WorldRenderSource, SOURCE_GRID, SOURCE_RANK } from '../src/world/renderSource.js';
import { RawWorldSourceProducer, sourceTrees } from '../src/world/renderSourceProducer.js';
import { SceneGpu } from '../src/world/gpu.js';
import { sceneStruct, sceneHeadWGSL } from '../src/world/scenes/sceneGpu.js';
import { SharedUniforms } from '../src/gpu/params.js';
import { WorldCellAtlasAdapter } from '../src/world/cellAtlasAdapter.js';
import { WorldRenderAtlas, READY } from '../src/world/renderAtlas.js';
import { gridDims, atlasDims, cellSlot, brickIdOf } from '../src/shaders/common.js';
import { BrickStore, encodeBrick } from '../src/world/store.js';
import { setAeration, aerationForSource } from '../src/gfx/foam.js';
import { worldParams, treesIn } from '../src/world/generator.js';
import { createUnpacker } from '../src/net/codec.js';
const u32=b=>new Uint32Array(b.bytes),f32=b=>new Float32Array(b.bytes);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
export async function drain(gpu){for(let i=0;i<3;i++){gpu.finish();await tick();}}
export async function fixture({size=[96,8,8],pre=false,trees=false}={}) {
  const gpu=new CellTestGPU();
  globalThis.GPUBufferUsage={STORAGE:128,COPY_SRC:4,COPY_DST:8,UNIFORM:64,INDIRECT:256};
  gpu.stats={bytesUploaded:0,writeFlushes:0};
  gpu.uniforms=(s,label)=>new SharedUniforms(gpu,s,label);
  gpu.write=(b,o,v)=>{gpu.flush();gpu.queue.writeBuffer(b,o,v);};
  const g=gridDims({nx:32,ny:32,nz:32}),buffer=n=>gpu.createBuffer({size:n,usage:128|4|8});
  const sim={g,gpu,cur:0,version:0,origin:{x:0,y:0,z:0},L:{TABLES:gpu.layout('TABLES',[])},tables:{},marks:buffer(16),state:{A:buffer(g.slots*32),B:buffer(g.slots*32),F:buffer(g.slots*8)},flow:buffer(g.slots*8),decoPlane:{buffer:buffer(g.slots*4),offset:0},deco:{store:new Map()},
    _retire:b=>gpu.retire(b),header(){return {src:this.cur,dst:this.cur,origin:[this.origin.x,0,this.origin.z]};},onShift(){return ()=>{};},attachAeration(a){this.aeration=a;},wake(){}};
  for(let s=0;s<g.slots*2;s++){f32(sim.state.A).set([2,20,.5,.125],s*4);u32(sim.state.B).set([0x80000000,0x7fc12345,s,0x11223344],s*4);}
  for(let i=0;i<u32(sim.flow).length;i++)u32(sim.flow)[i]=(0x80000000+i*7919)>>>0;
  for(let i=0;i<u32(sim.decoPlane.buffer).length;i++)u32(sim.decoPlane.buffer)[i]=(0x7fc12345+i)>>>0;
  const listeners=new Set(),S=sceneStruct(pre?{uPreAt:'u32'}:{}),scene={key:'cut-fixture',uniformStruct:S,uniforms:()=>({uSceneSeed:13}),data:()=>({at:0,words:new Uint32Array([17,18,19,20])}),
    subscribeData(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    glsl:()=>sceneHeadWGSL(S,{data:true})+'fn sceneCell(p:vec3i)->SceneCell { return SceneCell(vec4f(2.0,20.0,0.5,f32(sdWord(0u))),vec4f(0.0)); }',
    ...(trees?{trees:{treesIn}}:{}),...(pre?{pre:{code:()=>'',margin:()=>[1,1,1]}}:{})};
  const wb=size.map(v=>v/4),P=trees?worldParams({size,seed:20261008}):{seed:13,size:[...size]},win={sim,gpu,size,wb,P,epoch:1,scene,loaded:true,planted:new Uint8Array(wb[0]*wb[2]),candidates:new Map(),store:new BrickStore(wb)};
  const resources=new SceneGpu(sim,scene,P,{regions:[[64,size[1],64]]});win.gen={res:resources,ready:resources.ready};await resources.ready;
  const source=new WorldRenderSource(win);win.renderSource=source;sim.worldRenderSource=source;
  const producer=win.sourceProducer=new RawWorldSourceProducer(win,source);await producer.ready;
  // Execute generation from its actual selected native SceneGpu buffer. The
  // source CellTestGPU's constant field is intentionally not shader execution.
  gpu._generate=({bind})=>{
    const data=bind[2].entries.find(e=>e.binding===1).resource.buffer,seed=u32(data)[0];
    const A=bind[1].entries.find(e=>e.binding===0).resource.buffer,B=bind[1].entries.find(e=>e.binding===1).resource.buffer;
    for(let s=0;s<A.size/16;s++){f32(A).set([2,20,.5,seed],s*4);u32(B).set([0x80000000,0x7fc12345,s,seed],s*4);}
  };
  const editScene=value=>{for(const fn of [...listeners])fn(0,new Uint32Array([value]));};
  const finish=async()=>{await drain(gpu);producer.dispose();source.dispose();resources.dispose();await drain(gpu);};
  return {gpu,sim,win,source,producer,resources,scene,editScene,finish};
}
export const cut=f=>f.source.recordCut(f.gpu.frame,{sceneVersion:'scene',configVersion:1});
