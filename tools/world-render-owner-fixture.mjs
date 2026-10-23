// The World data owner's CPU fixture: the actual owner (wire/worldRender.js
// installWorldRender) over the actual Source/Cut/Fields/CELL/Atlas/history/
// GI/Sun/Glow/records, with delayed native transport and synthetic lighting
// kernel MATH. Shared by tools/world-render-owner-cpu-check.mjs and
// tools/world-pool-budget-cpu-check.mjs.
import assert from 'node:assert/strict';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { fixture } from './world-lighting-records-fixture.mjs';
import { installWorldRender } from '../src/wire/worldRender.js';
import { READY } from '../src/world/renderAtlas.js';
import { tableLayout } from '../src/shaders/common.js';
import { worldGISource, worldGIBirthWGSL } from '../src/shaders/worldGI.js';
export const words=b=>new Uint32Array(b.bytes),bytes=b=>new Uint8Array(b.bytes);
export class Exec extends WgslExec {_dispatchWorkgroup(fn,id,c){for(const a of fn.node.attributes??[])if(a.name==='workgroup_size'&&typeof a.value==='string')a.value=[a.value];return super._dispatchWorkgroup(fn,id,c);}}
export const tick=()=>new Promise(r=>setTimeout(r,0));
// Execute the actual SOURCE early exits and self-read leaf. Classification,
// packing and lighting math remain synthetic; no native shader execution.
const sourceCode=worldGISource({nx:16,ny:8,nz:8});
function body(code,name){const start=code.indexOf(`fn ${name}(`);let end=code.indexOf('{',start),depth=1;while(depth&&++end<code.length){if(code[end]==='{')depth++;if(code[end]==='}')depth--;}return code.slice(start,end+1);}
export function selfMiss(kind,flags){
  const air=sourceCode.slice(sourceCode.indexOf('  if (!brickMatter(brickOcc(bc)))'),sourceCode.indexOf('  let l = vec3i'));
  const media=sourceCode.slice(sourceCode.indexOf('  let m = vec2u(head'),sourceCode.indexOf('  var rad = vec3f'));
  assert(air&&media,'production SOURCE classification leaves');
  const code=`${worldGIBirthWGSL}
struct Probe{a:vec4f,b:vec4f,c:vec4f,d:vec4f}
const WORLD_GI:u32=16u;const tGI0:u32=0u;const tGI1:u32=1u;const tGI2:u32=2u;const tGI3:u32=3u;
const BS:i32=4;const BRICK_CELLS:u32=64u;const FACE_CELLS:u32=16u;
@group(0)@binding(0)var<storage,read>worldGIJobs:array<vec4u>;
@group(0)@binding(1)var<storage,read_write>worldGISources:array<vec4u>;
@group(0)@binding(2)var<storage,read_write>miss:array<u32>;
fn worldProbeLoad(band:u32,bc:vec3i,channel:u32)->vec4f{miss[0]=channel;return vec4f(0.0);}
fn brickOcc(bc:vec3i)->u32{return ${kind==='air'?'0':'1'}u;}
fn brickMatter(occ:u32)->bool{return occ!=0u;}
fn giSrcPack(a:vec3f,b:vec3f,c:vec3f)->vec4u{return vec4u(0u);}
fn worldGIReport(job:u32){}
${body(sourceCode,'worldGIPreviousProbe')}
@compute@workgroup_size(1)fn main(){let job=0u;let li=0u;let bc=vec3i(0);${air}
let head=array<u32,7>(${kind==='opaque'?'1':'0'}u,0u,0u,0u,0u,0u,${kind==='crystal'?'1':'0'}u);${media}}
`;
  const miss=new Uint32Array(1);
  new Exec(new WgslParser().parse(code)).dispatchWorkgroups('main',1,{0:{0:new Uint32Array([0,flags,0,0]),1:new Uint32Array(4),2:miss}});
  return miss[0]===READY.GI;
}
export async function settle(gpu,promise){let done=false,error,result;promise.then(r=>{done=true;result=r;},e=>{done=true;error=e;});for(let i=0;i<2000&&!done;i++){gpu.finish();await tick();}assert(done,'native final boundary failed to settle');if(error)throw error;return result;}
export async function setup({size=[16,8,8],feedback=true,sourceKinds=null,ground=null,ownerOptions={}}={}) {
  const f=await fixture({size}),gpu=f.gpu,events=[],sources=[],histories=[],tablesUsed=[],giJobs=[];
  const tableBuffer=gpu.createBuffer({label:'real fixture tables',size:tableLayout().Tables.size,usage:128|4|8});
  const tableGroup=gpu.bindGroup(f.sim.L.TABLES,[{binding:0,resource:{buffer:tableBuffer}}],'fixture TABLES');
  f.sim.tables=tableGroup;gpu._simTables={buffer:tableBuffer,group:tableGroup};
  gpu.onDispatch=(_kernel,options)=>assert(options.bind?.[0]?.entries?.[0]?.resource.buffer.bytes instanceof ArrayBuffer,'normal kernels require TABLES bind group');
  const makeGroup=gpu.device.createBindGroup;
  gpu.device.createBindGroup=d=>{
    for(const entry of d.entries)if(entry.resource?.buffer)assert(entry.resource.buffer.bytes instanceof ArrayBuffer,'native binding requires a GPUBuffer, never a GPUBindGroup');
    return makeGroup(d);
  };
  gpu.device.createSampler=d=>d;
  gpu.device.createBuffer=d=>{const b=gpu.createBuffer(d);b.mapAsync=()=>gpu.queue.onSubmittedWorkDone();return b;};
  const original=gpu.encoder.bind(gpu);let owner;
  function dispatch(pipe,groups,n,push){
    const label=pipe.label??'',buf=(g,b)=>groups[g].entries.find(e=>e.binding===b).resource.buffer;
    if(['world GI source','world GI gather','full world optical sun'].includes(label))tablesUsed.push(buf(0,0));
    if(label.startsWith('world lighting delta'))return push(()=>new Exec(new WgslParser().parse(pipe.compute.module.code)).dispatchWorkgroups('main',[n,1,1],{0:Object.fromEntries(groups[0].entries.map(e=>[e.binding,e.resource.buffer.bytes]))}));
    if(label==='world CELL raw/AUX pack')return push(()=>gpu._pack(groups));
    if(label==='world CELL field pack')return push(()=>gpu._packFields(groups,n));
    if(label==='world GI source'||label==='world GI gather')return push(()=>{
      if(label==='world GI gather'){
        assert.deepEqual(groups[3].entries.map(e=>e.binding).sort((a,b)=>a-b),[0,1,2,3,4,5,6,7,8,9,10]);
        assert.doesNotMatch(pipe.compute.module.code,/worldGI[0-3]Out/);
      }
      if(sourceKinds&&label==='world GI gather')assert.match(pipe.compute.module.code,/const GI_RAYS: i32 = 32;/);
      events.push(label);const p=words(buf(3,7)),jobs=words(buf(3,8)),out=words(buf(3,9)),fb=words(buf(3,1)),sun=words(buf(3,5)),book=words(buf(0,5));
      const start=label==='world GI source'?0:p[0],count=label==='world GI source'?p[0]:p[1];
      let missing=false;
      if(feedback&&label==='world GI source'&&!sun[6]){fb[owner.atlas.bookLayout.sunWord]|=1;missing=true;events.push('unknown Sun');}
      if(feedback&&label==='world GI gather'&&!book[1]){const plane=owner.atlas.bookLayout.requestBytes/4/6;fb[plane*3]|=2;missing=true;events.push('unknown SOURCE');}
      for(let i=0;i<count;i++){
        const job=start+i,id=jobs[4*job],flags=jobs[4*job+1];let selfMissing=false;
        if(label==='world GI source'&&sourceKinds&&selfMiss(sourceKinds[id]??'air',flags)){
          const plane=owner.atlas.bookLayout.requestBytes/4/6;
          fb[plane*4+(id>>>5)]|=1<<(id&31);selfMissing=true;events.push('typed GI self-miss');
        }
        giJobs.push({phase:label,index:id,flags,tick:p[3]});
        fb[p[2]+job]=missing||selfMissing?3:1;if(label==='world GI source')out.set([id,p[3],101,202],i*4);
      }
      if(label==='world GI source')sources.push([...out]);else{const h=words(buf(3,10));histories.push([...h]);for(let i=0;i<h.length;i++)h[i]++;}
    });
    if(label==='full world optical sun')return push(()=>{
      events.push(label);const fb=words(buf(3,1)),job=words(buf(2,0)),book=words(buf(0,4));let missing=false;
      if(feedback&&!book[3]){fb[0]|=8;missing=true;events.push('unknown CELL');}fb[job[5]]=missing?3:1;
    });
    if(label==='world glow float'||label==='world glow half')return push(()=>{
      events.push(label);const p=words(buf(0,0));words(buf(0,3))[p[20]]=1;
      // Lighting math is synthetic, but final storage matches the real shader:
      // Five f32 intermediates; the final pass writes only outGlow.
      const values=label==='world glow float'?new Float32Array(buf(0,2).bytes):null;
      const half=label==='world glow half'?new Uint16Array(groups[0].entries.find(e=>e.binding===4).resource.texture.bytes):null;
      for(let i=0;i<p[15];i++){values?.set([0,0,0,1],i*4);half?.set([0,0,0,0x3c00],i*4);}
    });
    throw new Error(`unmocked native pipeline ${label}`);
  }
  gpu.encoder=(label,frame=false)=>{const e=original(label,frame),push=fn=>frame?gpu._push(fn):e.ops.push(fn);e.clearBuffer=(b,o=0,n=b.size-o)=>push(()=>bytes(b).fill(0,o,o+n));e.beginComputePass=()=>{let pipe;const groups=[];return {setPipeline:p=>pipe=p,setBindGroup:(i,g)=>groups[i]=g,dispatchWorkgroups:n=>dispatch(pipe,[...groups],n,push),end(){}};};return e;};
  gpu.frame._command=()=>{};gpu.frame._commandDone=()=>{};
  gpu.frame.compute=()=>{let pipe;const groups=[];return {setPipeline:p=>pipe=p,setBindGroup:(i,g)=>groups[i]=g,dispatchWorkgroups:n=>dispatch(pipe,groups,n,fn=>gpu._push(fn))};};
  // A ground twin (world/scenes/index.js ground) turns on the sun-caster forecast.
  if(ground)f.win.scene.ground=ground;
  owner=installWorldRender(f.win,ownerOptions);
  const frame={sceneVersion:'scene',schemaVersion:1,configVersion:1,values:{cam:[0,0,0]},physicsOrigin:[0,0,0],globalKey:[1],sun:{direction:[1,1,1],basisRevision:1},external:Object.fromEntries(['mediaNoise','packedMesh','sourceAppearance'].map(name=>[name,{name}]))};
  return {...f,owner,events,sources,histories,tablesUsed,giJobs,frame,async close(){await settle(gpu,owner.dispose());await f.finish();}};
}
export const complete={incomplete:false,requirements:[],sun:[]};
export function post(candidate,confirmation=Promise.resolve(true)){const feedbackIdentity={};return {feedbackIdentity,postTicket:{identity:candidate.identity,publication:candidate,feedbackIdentity,status:'committed',confirmation},feedback:complete};}
