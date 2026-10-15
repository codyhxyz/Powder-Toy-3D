// CPU/fake-native recording and actual factory Naga only. No GPU or browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { createWorldVolume } from '../src/gfx/worldVolume.js';
import { WorldRenderAtlas } from '../src/world/renderAtlas.js';
import { worldSunProjection, worldSunFeedbackWords } from '../src/world/worldSun.js';
import { tableLayout } from '../src/shaders/common.js';
import { PickParams, worldPlainPipelines, WORLD_PLAIN_PHASES, volumeFrag, pickFrag, PICK_LAYOUTS, VOLUME_LAYOUTS } from '../src/shaders/render.js';
import { worldPlainWalkWGSL } from '../src/shaders/worldPlain.js';
import { WorldPointParams, WORLD_POINT_BYTES, worldPointWGSL, worldPointLayouts, WGSL_CHECK } from '../src/shaders/worldPoint.js';
import { worldQueryWGSL } from '../src/shaders/worldRenderBackend.js';
import { checkPipeline } from './check-sampler-budget.mjs';
import { FRAME_UNIFORM_FIELDS } from '../src/shaders/bindings.js';
import { uniformStruct } from '../src/gpu/params.js';

const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
export function fixture({appearance=null}={}) {
  const buffers=[], render=[], compute=[], pending=[];
  const device={limits:{},queue:{
    writeBuffer(b,off,raw){const a=raw instanceof ArrayBuffer?new Uint8Array(raw):new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength);b.data.set(a,off);},
    writeTexture(){},submit(){assert.fail('facade must not submit');},onSubmittedWorkDone:()=>Promise.resolve(),
  },
  createBuffer(d){const b={...d,data:new Uint8Array(d.size),destroy(){this.dead=true;}};buffers.push(b);return b;},
  createTexture(d){return {...d,createView:()=>({}),destroy(){}};},
  createBindGroupLayout:d=>d,createPipelineLayout:d=>d,createSampler:d=>d,createShaderModule:d=>d,
  createRenderPipelineAsync(d){render.push(d);return new Promise((resolve,reject)=>pending.push({d,resolve:()=>resolve(d),reject}));},
  createComputePipelineAsync(d){compute.push(d);return new Promise((resolve,reject)=>pending.push({d,resolve:()=>resolve(d),reject}));},
  createBindGroup(d){
    assert.deepEqual(d.entries.map(e=>e.binding).sort(),d.layout.entries.map(e=>e.binding).sort());
    for(const e of d.entries){const spec=d.layout.entries.find(s=>s.binding===e.binding);if(spec.buffer)assert.ok((e.resource.size??e.resource.buffer.size)>=(spec.buffer.minBindingSize??0));}
    return d;
  }};
  const gpu={device}, g={nx:128,ny:128,nz:128,sourceAppearance:true,sourceGrid:[128,0,128]};
  const sun=worldSunProjection([128,128,128],[1,.01,0]);
  const atlas=new WorldRenderAtlas(gpu,{worldSize:[128,128,128],initialCapacity:1,feedbackExtraWords:worldSunFeedbackWords(sun.tiles),retire:f=>f()});
  const lighting={params:{...sun,physical:[256,8,64,1],version:[1,1,1,atlas.bookLayout.requestBytes/4+1]},book:device.createBuffer({size:sun.tiles[2]*sun.tiles[3]*32}),sun0:{},sun1:{}};
  const publish=()=>atlas.publish({sunManifest:{epoch:1,basisRevision:1,publishRevision:1,dependencySetID:0,dependencyVersion:0,book:lighting.book,sun0:lighting.sun0,sun1:lighting.sun1,params:lighting.params}});
  publish();
  const volume=createWorldVolume(gpu,{g,atlas,tables:device.createBuffer({size:tableLayout().Tables.size}),lighting,appearance});
  const prepare=(overrides={})=>volume.prepare({frameUniforms:{cam:[99,20,30],model:I,viewProj:I},physicsOrigin:[1536,0,512],params:{meshInv:I,meshRes:[1,1]},external:{mediaNoise:{},sourceAppearance:{},packedMesh:{}},...overrides});
  const candidate=prepare();
  function settle(test=()=>true,error) {for(const p of pending.splice(0)){if(test(p.d))error?p.reject(error):p.resolve();else pending.push(p);}}
  const log=[],pass={setPipeline:p=>log.push(['pipeline',p]),setBindGroup:(i,g)=>log.push(['group',i,g]),draw:n=>log.push(['draw',n])};
  const encoder={beginComputePass(d){log.push(['begin',d.label]);return {...pass,dispatchWorkgroups:n=>log.push(['dispatch',n]),end:()=>log.push(['end'])};}};
  return {device,buffers,render,compute,pending,g,atlas,volume,candidate,prepare,publish,settle,log,pass,encoder,lighting,
    release(){candidate.release();volume.dispose();atlas.dispose();}};
}
const tick=()=>Promise.resolve();
const rays=()=>({ro:[[3071,383,1023,0]],rd:[[-1,0,0,0]],warp:[[0,0,0,1]],slot:[[1,0,0,0]],n:1});
function checkModule(code,groups,kind,name) {
  assert.deepEqual(checkPipeline({code,groups,kind}).problems,[],name);
  assert.equal(groups.flat().filter(e=>e.texture).length,16);
  assert.equal(groups.flat().filter(e=>e.buffer?.type.includes('storage')).length,kind==='render'?5:6);
  const n=spawnSync('naga',['--stdin-file-path',`${name}.wgsl`],{input:code,encoding:'utf8'});
  assert.equal(n.status,0,`${name}: ${n.stdout}\n${n.stderr}`);
}

test('flat WORLD DDA uses distinct pointer roots required by native WGSL validation',()=>{
  const code=worldPlainWalkWGSL();
  assert.match(code,/ddaStart\(ro,rd,w\.t,&step,&delta,&cell,&next\)/);
  assert.match(code,/ddaStep\(\(\*w\)\.step,\(\*w\)\.delta,&cell,&next\)/);
  assert.doesNotMatch(code,/dda(?:Start|Step)\([^;\n]*&(?:w\.|\(\*w\)\.)/);
  assert.match(code,/w\.step=step;w\.delta=delta;w\.cell=cell;w\.next=next/);
  assert.match(code,/\(\*w\)\.cell=cell;\(\*w\)\.next=next/);
});
test('actual Plain facade compiles exact three descriptors and gates one-pass ordered flat/curved recording',async()=>{
  const f=fixture();try {
    const state=f.volume.pipelineState('plain');assert.equal(state.state,'pending');assert.equal(f.render.length,3);
    assert.equal(f.candidate.recordDraw(f.pass,{view:'plain'}),false);assert.deepEqual(f.log,[]);
    const desc=worldPlainPipelines();
    for(const [i,phase] of WORLD_PLAIN_PHASES.entries()) {
      const d=f.render[i],expected=desc[phase];
      assert.equal(d.vertex.entryPoint,expected.vertex.entry);assert.equal(d.fragment.entryPoint,expected.fragment.entry);
      assert.deepEqual(d.fragment.targets,expected.fragment.targets);assert.deepEqual(d.primitive,expected.primitive);assert.deepEqual(d.depthStencil,expected.depthStencil);
      assert.equal(d.vertex.module,d.fragment.module);assert.equal(d.vertex.module,f.render[0].vertex.module);
      assert.equal(d.vertex.module.code,volumeFrag(f.g,{backend:'world',view:'plain',detail:{},curved:false}));
    }
    assert.doesNotMatch(f.render[0].fragment.module.code,/@fragment fn fs\(/);
    f.settle(d=>d.fragment?.entryPoint==='fsOpaque'||d.fragment?.entryPoint==='fsAbsorb');await tick();
    assert.equal(state.state,'pending');assert.equal(f.candidate.recordDraw(f.pass,{view:'plain'}),false);assert.deepEqual(f.log,[]);
    f.settle(d=>!!d.fragment);await tick();assert.equal(state.state,'pending','explicit Plain picker is also prewarmed before readiness');
    f.settle();const pipelines=await state.ready;assert.equal(pipelines.length,3);assert.equal(state.state,'ready');
    assert.equal(f.candidate.recordDraw(f.pass,{view:'plain'}),true);
    assert.deepEqual(f.log.filter(x=>x[0]==='pipeline').map(x=>x[1].fragment.entryPoint),['fsOpaque','fsAbsorb','fsScatter']);
    assert.deepEqual(f.log.filter(x=>x[0]==='draw').map(x=>x[1]),[14,14,14]);
    for(let phase=0;phase<3;phase++)assert.deepEqual(f.log.slice(phase*6+1,phase*6+5).map(x=>x[2]),f.candidate.groups);
    f.log.length=0;const options={view:'plain',detail:{},curved:true},drawing=f.candidate.draw(f.pass,options);
    options.view='heat';options.curved=false;options.detail.media=true;
    f.settle();await drawing;
    assert.deepEqual(f.log.filter(x=>x[0]==='draw').map(x=>x[1]),[3,3,3]);
    assert.ok(f.log.filter(x=>x[0]==='pipeline').every(x=>x[1].primitive.topology==='triangle-list'));
    assert.equal(f.log.filter(x=>x[0]==='begin').length,0,'no hidden pass or async callback');
    const failed=f.volume.pipelineState('plain',{},false);assert.equal(failed,state);
    const failure=f.volume.pipelineState('plain',{different:true});
    f.settle(d=>d.fragment?.entryPoint==='fsAbsorb',new Error('absorb failed'));
    await assert.rejects(failure.ready,/absorb failed/);assert.equal(failure.state,'failed');assert.match(failure.error.message,/absorb/);
    const before=f.log.length;assert.equal(f.candidate.recordDraw(f.pass,{view:'plain',detail:{different:true}}),false);assert.equal(f.log.length,before);
    f.settle();
  } finally {f.release();}
});

test('Plain/default picking caches actual different WGSL and freezes view/n/slots/all packed bytes before await',async()=>{
  const f=fixture();try {
    const plain=f.volume.pickPipelineState('plain'), realistic=f.volume.pickState;
    assert.notEqual(plain,realistic);assert.equal(f.volume.pickPipelineState('heat'),realistic);
    const pp=f.compute.find(d=>d.label==='world pick plain'),rp=f.compute.find(d=>d.label==='world pick');
    assert.equal(pp.compute.module.code,pickFrag(f.g,{backend:'world',view:'plain'}));
    assert.equal(rp.compute.module.code,pickFrag(f.g,{backend:'world'}));assert.notEqual(pp.compute.module.code,rp.compute.module.code);
    const params=rays(),output=f.device.createBuffer({size:64,usage:128}),options={view:'plain',params,output};
    const expected=new Uint8Array(PickParams.pack(params));
    assert.equal(f.candidate.recordPickReady(f.encoder,options),false);assert.deepEqual(f.log,[]);
    const work=f.candidate.recordPick(f.encoder,options);
    options.view='realistic';options.output=f.device.createBuffer({size:32});params.n=8;params.slot[0][0]=99;params.ro[0][0]=-100;params.warp[0][0]=4;
    f.settle(d=>d===pp);await work;
    assert.equal(realistic.state,'pending');assert.equal(f.log.find(x=>x[0]==='pipeline')[1],pp);
    const bytes=f.buffers.find(b=>b.label==='world pick params').data;assert.deepEqual(bytes,expected);
    const pg=f.log.find(x=>x[0]==='group'&&x[1]===3)[2];assert.equal(pg.entries.find(e=>e.binding===6).resource.buffer,output);
    assert.deepEqual(f.log.filter(x=>x[0]==='dispatch'),[['dispatch',1]]);assert.deepEqual(f.log.at(-1),['end']);
    f.settle();await f.volume.ready;
    f.log.length=0;assert.equal(f.candidate.recordPickReady({direct:()=>f.encoder},{params:rays(),output}),true);
    assert.equal(f.log.find(x=>x[0]==='pipeline')[1],rp);
    assert.equal(pg.entries.find(e=>e.binding===1).resource.buffer,f.candidate.feedback);
    f.candidate.release();assert.equal(output.dead,undefined,'caller output remains owned by caller');
  } finally {f.settle();f.release();}
});

test('cached factories bind each candidate table and artwork, never the previous cut inputs',async()=>{
 const oldView={},newView={},f=fixture({appearance:{view:oldView,uniform:[4,256,128,128],sourceGrid:[128,0,128]}});let c;try{
  f.settle();await f.volume.pointReady;
  const tableBuffer=f.device.createBuffer({size:tableLayout().Tables.size,usage:128});
  const uniform=[8,128,128,128];
  c=f.prepare({tableBuffer,appearance:{view:newView,uniform}});
  const output=f.device.createBuffer({size:80,usage:128});
  assert.equal(c.recordPointReady(f.encoder,{position:[99,20,30],output}),true);
  const entries=f.log.find(e=>e[0]==='group'&&e[1]===0)[2].entries;
  assert.equal(entries.find(e=>e.binding===0).resource.buffer,tableBuffer);
  const frame=entries.find(e=>e.binding===2).resource.buffer;
  assert.deepEqual([...new Uint32Array(frame.data.buffer,uniformStruct('FrameUniforms',FRAME_UNIFORM_FIELDS).offsets.sourceAppearance,4)],uniform);
  assert.equal(f.log.find(e=>e[0]==='group'&&e[1]===2)[2].entries.find(e=>e.binding===8).resource,newView);
  c.release();assert.equal(tableBuffer.dead,undefined);
  c=f.prepare({appearance:null});f.log.length=0;
  assert.equal(c.recordPointReady(f.encoder,{position:[99,20,30],output}),true);
  assert.notEqual(f.log.find(e=>e[0]==='group'&&e[1]===2)[2].entries.find(e=>e.binding===8).resource,oldView);
  tableBuffer.destroy();output.destroy();
 }finally{c?.release();f.settle();f.release();}
});

test('native point recording freezes global position/output, gates readiness, shares pinned groups and retains final-use ownership',async()=>{
  const f=fixture();try {
    const output=f.device.createBuffer({size:80,usage:128}),position=[3071.25,383,1023.5],options={position,output};
    assert.equal(f.volume.pointState.state,'pending');assert.equal(f.candidate.recordPointReady(f.encoder,options),false);assert.deepEqual(f.log,[]);
    const work=f.candidate.recordPoint({direct:()=>f.encoder},options);
    position[0]=1;options.output=f.device.createBuffer({size:80,usage:128});options.position=[2,3,4];
    f.settle(d=>d.label==='world point');await work;assert.equal(f.volume.pointState.state,'ready');
    const packed=new DataView(f.buffers.find(b=>b.label==='world point params').data.buffer);
    assert.equal(packed.getFloat32(WorldPointParams.offsets.position,true),3071.25,'not rebased by physicsOrigin');
    const groups=f.log.filter(x=>x[0]==='group').map(x=>x[2]);assert.deepEqual(groups.slice(0,3),f.candidate.groups.slice(0,3));
    const out=groups[3].entries.find(e=>e.binding===6).resource;assert.equal(out.buffer,output);assert.equal(out.offset,0);assert.equal(out.size,WORLD_POINT_BYTES);
    assert.equal(groups[3].entries.find(e=>e.binding===1).resource.buffer,f.candidate.feedback);
    assert.equal(groups[3].entries.find(e=>e.binding===5).resource.buffer,f.candidate.snapshot.sunManifest.book);
    assert.deepEqual(f.log.filter(x=>x[0]==='dispatch'),[['dispatch',1]]);assert.deepEqual(f.log.at(-1),['end']);
    const identity=f.candidate.publication;assert.ok(Object.isFrozen(identity));assert.equal(identity.generation,f.candidate.snapshot.generation);
    f.publish();assert.equal(f.candidate.publication,identity);
    const later=f.atlas.snapshot();assert.notEqual(later.generation,identity.generation);later.release();
    for(const bad of [[],[NaN,0,0],[Infinity,0,0],[1e100,0,0],[1,2,3,4]])assert.throws(()=>f.candidate.recordPointReady(f.encoder,{position:bad,output}),/global/);
    for(const bad of [{size:79},{size:82},{size:80,usage:4},{size:128*1024**2+4}])assert.throws(()=>f.candidate.recordPointReady(f.encoder,{position:[1,2,3],output:bad}),/80 bytes/);
    f.log.length=0;assert.equal(f.candidate.recordPointReady(f.encoder,{position:[1,2,3],output}),true);
    f.settle();await f.volume.pointReady;
    f.candidate.release();assert.equal(output.dead,undefined);assert.ok(f.buffers.filter(b=>b.label==='world point params').every(b=>b.dead));
    assert.throws(()=>f.candidate.recordPointReady(f.encoder,{position:[1,2,3],output}),/released/);
  } finally {f.settle();f.release();}
});

test('failed/stale/released/disposed point work records nothing, cleanup still releases transferred pins',async()=>{
  const f=fixture();try {
    const output=f.device.createBuffer({size:80,usage:128});
    f.settle(d=>d.label==='world point',new Error('point compile failed'));
    await assert.rejects(f.volume.pointReady,/compile failed/);assert.equal(f.volume.pointState.state,'failed');
    assert.equal(f.candidate.recordPointReady(f.encoder,{position:[1,2,3],output}),false);assert.deepEqual(f.log,[]);
    await assert.rejects(f.candidate.recordPoint(f.encoder,{position:[1,2,3],output}),/compile failed/);
    const supplied=f.atlas.snapshot();let releases=0;const transferred={...supplied,release(){releases++;supplied.release();}};
    f.volume.dispose();assert.throws(()=>f.volume.prepare({snapshot:transferred}),/disposed/);assert.equal(releases,1);
  } finally {f.settle();f.release();}
  const stale=fixture();try {
    const work=stale.candidate.recordPoint(stale.encoder,{position:[1,2,3],output:stale.device.createBuffer({size:80,usage:128})});
    stale.atlas.reset();stale.settle();await assert.rejects(work,/stale/);assert.deepEqual(stale.log,[]);
  } finally {stale.release();}
});

test('actual emitted Plain/point factories validate in Naga with default 16-texture/five-or-six-storage budgets',()=>{
  let count=0;
  for(const c of WGSL_CHECK()) {
    const code=c.code();checkModule(code,c.layouts(),'compute',c.name);count++;
    assert.match(code,/fn worldPos\(p: vec3f\) -> vec3f \{ return p; \}/);
    assert.match(code,/return worldProbeTex\(t,p,WORLD_GI\)/);
    assert.match(code,/let pr = probeAt\(p\);/);assert.match(code,/pointOut\[3\] = pr.cz;/);
    assert.equal((code.match(/let sun = sunShadowAt\(p\);/g)||[]).length,1);
    assert.match(code,/fn sunShadowAt\(p: vec3f\).*\{\s*let c = cloudShadow\(worldPos\(p\)\)/);
    assert.match(code,/worldEndQuery\(\);\s*\/\/ Keep/);
    assert.match(code,/select\(1.0, -1.0, worldQueryIncomplete\(\)\)/);
    assert.equal(c.layouts()[3].find(e=>e.binding===0).buffer.minBindingSize,16);
    assert.equal(c.layouts()[3].find(e=>e.binding===6).buffer.minBindingSize,80);
  }
  for(const ny of [128,384])for(const curved of [false,true]) {
    const g={nx:3072,ny,nz:1024,sourceAppearance:curved,sourceGrid:[128,0,128]};
    checkModule(volumeFrag(g,{backend:'world',view:'plain',curved}),VOLUME_LAYOUTS({backend:'world'}),'render',`consumer-plain-${ny}-${curved}`);count++;
    checkModule(pickFrag(g,{backend:'world',view:'plain'}),PICK_LAYOUTS({backend:'world'}),'compute',`consumer-pick-${ny}-${curved}`);count++;
  }
  console.log(`Naga: ${count} actual consumer modules passed`);
});

test('execute actual point entry: all 16 SH floats incl sky alpha, colored Sun once, incomplete flag and shared status',()=>{
  const emitted=worldPointWGSL({nx:128,ny:128,nz:128});
  // Only leaf lighting inputs are mocked. Execute the production entry/output
  // and production shared feedback status; full-reader assembly is Naga-checked above.
  const entry=emitted.slice(emitted.indexOf('@compute @workgroup_size(1) fn main()'));
  const code=`${WorldPointParams.wgsl}
@group(3) @binding(0) var<uniform> P: WorldPointParams;
@group(3) @binding(6) var<storage,read_write> pointOut: array<vec4f>;
struct Probe {c0:vec4f,cx:vec4f,cy:vec4f,cz:vec4f}
struct Meta {feedback:vec4u}
@group(0) @binding(0) var<uniform> WA:Meta;
@group(0) @binding(1) var<storage,read_write> worldRequests:array<atomic<u32>>;
var<private> incomplete:bool;
var<private> sunCalls:u32;
fn worldBeginQuery(){incomplete=false;sunCalls=0u;}
fn worldSunValidate(){}
fn worldQueryIncomplete()->bool{return incomplete;}
fn probeAt(p:vec3f)->Probe {
  incomplete=p.y<0.0;
  return Probe(vec4f(p,0.125),vec4f(-1.0,2.0,3.0,-0.25),vec4f(4.0,-5.0,6.0,0.5),vec4f(7.0,8.0,-9.0,-0.75));
}
fn sunShadowAt(p:vec3f)->vec3f {sunCalls+=1u;return vec3f(0.25,0.5,f32(sunCalls)*0.75);}
${worldQueryWGSL}
${entry}`;
  for(const y of [3,-1]) {
    const output=new Float32Array(20),requests=new Uint32Array(1);
    const exec=new WgslExec(new WgslParser().parse(code));
    // wgsl_reflect 1.6.0 expects the numeric workgroup attribute as an array.
    for(const node of exec.ast??[])for(const a of node.attributes??[])if(a.name==='workgroup_size'&&typeof a.value==='string')a.value=[a.value];
    exec.dispatchWorkgroups('main',1,{0:{0:new Uint32Array([0,0,0,0]),1:requests},3:{0:WorldPointParams.pack({position:[3071.25,y,1023.5,0]}),6:output}});
    assert.deepEqual(Array.from(output.slice(0,16)),[3071.25,y,1023.5,.125,-1,2,3,-.25,4,-5,6,.5,7,8,-9,-.75]);
    assert.deepEqual(Array.from(output.slice(16,19)),[.25,.5,.75]);
    assert.equal(output[19],y<0?-1:1);assert.equal(requests[0],y<0?1:0);
  }
});
