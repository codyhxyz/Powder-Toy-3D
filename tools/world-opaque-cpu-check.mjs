// Native recording/lifetime and production leaf evidence, not GPU parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {WgslParser,WgslExec,WgslReflect,VectorData} from 'wgsl_reflect/wgsl_reflect.module.js';
import {createWorldOpaqueCapture} from '../src/gfx/worldOpaque.js';
import {worldOpaqueWGSL,worldOpaqueLayout} from '../src/shaders/worldOpaque.js';
import { nagaSpawn } from './naga.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const turn=()=>new Promise(r=>setImmediate(r));
// The interpreter constructs integer vectors through Float32Array and loses
// packed low bits. Preserve actual integer components; WGSL stays intact.
class PixelExec extends WgslExec {
  _callConstructorVec(node,context) {
    const type=this.getTypeInfo(node.type);
    if(type.format?.name!=='u32')return super._callConstructorVec(node,context);
    const values=node.args.flatMap(a=>{
      const v=this.evalExpression(a,context);return v.data?.length>1?[...v.data]:[v.value];
    });
    return new VectorData(new Uint32Array(values),type).getSubData(this,node.postfix,context);
  }
}
function fixture() {
  const compilation=deferred(),completion=deferred(),buffers=[],groups=[],events=[];
  const device={
    queue:{onSubmittedWorkDone(){events.push('fence');return completion.promise;}},
    createBuffer(d){const bytes=new ArrayBuffer(d.size),b={bytes,dead:false,getMappedRange:()=>bytes,unmap(){},destroy(){b.dead=true;}};buffers.push(b);return b;},
    createBindGroupLayout:d=>d,createPipelineLayout:d=>d,createShaderModule:d=>d,
    createComputePipelineAsync:()=>compilation.promise,
    createBindGroup(d){groups.push(d);return d;},
  };
  const frame={direct(){return{beginComputePass(){events.push('begin');return{
    setPipeline(){},setBindGroup(){},dispatchWorkgroups(...n){events.push(n);},end(){events.push('end');},
  };}};}};
  const gpu={device,frame},capture=createWorldOpaqueCapture(gpu);
  const texture=(format,usage)=>({format,usage,width:17,height:9,createView(){return{texture:this};}});
  const options={color:texture('rgba16float',4),depth:texture('depth32float',4),output:texture('rgba32uint',12),submitted:deferred().promise};
  return{capture,gpu,device,compilation,completion,buffers,groups,events,options};
}
test('opaque capture validates native WGSL/resource layout and exact original half HDR/depth/coverage leaf',()=>{
  const n=nagaSpawn(worldOpaqueWGSL, 'world-opaque.wgsl', {encoding:'utf8'});
  assert.equal(n.status,0,n.stderr);
  const reflection=new WgslReflect(worldOpaqueWGSL);assert.equal(reflection.uniforms[0].size,32);
  assert.equal(worldOpaqueLayout.length,4);assert.equal(worldOpaqueLayout[2].storageTexture.format,'rgba32uint');
  const start=worldOpaqueWGSL.indexOf('fn packOpaque('),end=worldOpaqueWGSL.indexOf('\n}',start)+2;
  const code=`
@group(0) @binding(0) var<storage,read> colors:array<vec4f>;
@group(0) @binding(1) var<storage,read> depths:array<f32>;
@group(0) @binding(2) var<storage,read_write> results:array<vec4u>;
${worldOpaqueWGSL.slice(start,end)}
@compute @workgroup_size(1,1,1) fn main(@builtin(global_invocation_id) id:vec3u) {
  results[id.x]=packOpaque(colors[id.x],depths[id.x]);
}`;
  const colors=new Float32Array([.25,.5,4,1,12.5,-.125,65504,.5,.25,.5,0,0]);
  const depths=new Float32Array([.25,.5,1]),out=new Uint32Array(12);
  new PixelExec(new WgslParser().parse(code)).dispatchWorkgroups('main',3,{0:{0:colors,1:depths,2:out}});
  assert.deepEqual([...out],[0x38003400,0x3c004400,0x3e800000,1,0xb0004a40,0x38007bff,0x3f000000,1,0x38003400,0,0x3f800000,0]);
});
test('normal Frame recorder prewarms, freezes async native inputs, dispatches once and never submits',async()=>{
  const f=fixture(),s=deferred(),options={...f.options,submitted:s.promise};
  assert.equal(f.capture.recordReady(f.gpu.frame,options),false);assert.equal(f.events.length,0);
  const pending=f.capture.record(f.gpu.frame,options),original=options.color;
  options.color=null;options.output=null;options.drew=false;
  f.compilation.resolve({});assert.equal(await pending,true);
  assert.equal(f.groups[0].entries[0].resource.texture,original);
  assert.equal(new Uint32Array(f.groups[0].entries[3].resource.buffer.bytes)[0],1);
  assert.deepEqual(f.events,['begin',[3,2,1],'end']);
  s.resolve();await turn();f.completion.resolve();f.capture.dispose();await turn();
  assert(f.buffers.every(b=>b.dead));
});
test('bad formats, extents, tickets and pass scope reject before any encoding; empty opaque selection is explicit',async()=>{
  const f=fixture();f.compilation.resolve({});await f.capture.ready;
  for(const options of [
    {...f.options,submitted:null},{...f.options,drew:null},
    {...f.options,color:{...f.options.color,format:'rgba8unorm'}},
    {...f.options,depth:{...f.options.depth,width:16}},
    {...f.options,output:{...f.options.output,usage:4}},
  ])assert.throws(()=>f.capture.recordReady(f.gpu.frame,options),TypeError);
  f.gpu.frame._passKind='render';assert.throws(()=>f.capture.recordReady(f.gpu.frame,f.options),/render pass/);
  f.gpu.frame._passKind=null;assert.equal(f.events.length,0);
  const s=deferred();assert(f.capture.recordReady(f.gpu.frame,{...f.options,submitted:s.promise,drew:false}));
  assert.equal(new Uint32Array(f.groups[0].entries[3].resource.buffer.bytes)[0],0);
  s.resolve();await turn();f.completion.resolve();f.capture.dispose();await turn();
});
test('discarded final boundary still fences prefixes before recorder resources retire',async()=>{
  const f=fixture(),s=deferred();f.compilation.resolve({});await f.capture.ready;
  f.capture.recordReady(f.gpu.frame,{...f.options,submitted:s.promise});
  f.capture.dispose();s.reject(new Error('discarded final encoder'));await turn();
  assert(f.events.includes('fence'));assert(f.buffers.every(b=>!b.dead));
  f.completion.resolve();await turn();assert(f.buffers.every(b=>b.dead));
  assert.throws(()=>f.capture.recordReady(f.gpu.frame,f.options),/disposed/);
});
