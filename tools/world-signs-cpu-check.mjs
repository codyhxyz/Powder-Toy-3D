// CPU/fake-native, actual WGSL interpreter and Naga only; no driver/browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {WgslExec,WgslParser,ScalarData,TypedData,VectorData} from 'wgsl_reflect/wgsl_reflect.module.js';
import * as THREE from 'three/webgpu';
import {createWorldVolume} from '../src/gfx/worldVolume.js';
import {WorldRenderAtlas,BOOK_LIGHT_SHIFT,BOOK_READY_SHIFT} from '../src/world/renderAtlas.js';
import {worldSunProjection,worldSunFeedbackWords} from '../src/world/worldSun.js';
import {tableLayout,prelude,tablesBuffer} from '../src/shaders/common.js';
import {materialsGLSL} from '../src/gfx/materials.js';
import {ddaGLSL} from '../src/shaders/gfx/core.js';
import {presentationNearWGSL} from '../src/shaders/gfx/presentation.js';
import {worldSignsWGSL,worldSignsLayouts,worldSignsArithmetic,worldSignsEntry,WorldSignsParams,WORLD_SIGNS_BYTES} from '../src/shaders/worldSigns.js';
import {SignParams,SIGN_LAYOUT} from '../src/shaders/probe.js';
import {checkPipeline} from './check-sampler-budget.mjs';
import {E} from '../src/elements.js';
import { nagaSpawn } from './naga.mjs';
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function fixture() {
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
  const volume=createWorldVolume(gpu,{g,atlas,tables:device.createBuffer({size:tableLayout().Tables.size}),lighting});
  const frameUniforms={cam:[99,20,30],model:I,viewProj:I};
  const prepare=()=>volume.prepare({frameUniforms,physicsOrigin:[1536,0,512],params:{meshInv:I,meshRes:[1,1]},external:{mediaNoise:{},sourceAppearance:{},packedMesh:{}}});
  const candidate=prepare();
  function settle(test=()=>true,error) {for(const p of pending.splice(0)){if(test(p.d))error?p.reject(error):p.resolve();else pending.push(p);}}
  const log=[],pass={setPipeline:p=>log.push(['pipeline',p]),setBindGroup:(i,g)=>log.push(['group',i,g]),draw:n=>log.push(['draw',n])};
  const encoder={beginComputePass(d){log.push(['begin',d.label]);return {...pass,dispatchWorkgroups:n=>log.push(['dispatch',n]),end:()=>log.push(['end'])};}};
  return {device,buffers,render,compute,pending,g,atlas,volume,candidate,prepare,publish,settle,log,pass,encoder,frameUniforms,
    release(){candidate.release();volume.dispose();atlas.dispose();}};
}
const tick=()=>Promise.resolve();
const rays=()=>({ro:[[3071,383,1023,0]],rd:[[-1,0,0,0]],warp:[[0,0,0,1]],slot:[[1,0,0,0]],n:1});
test('native sign gate, immutable pre-await arrays, exact binding and synchronous pass',async()=>{
 const f=fixture();try {
  const output=f.device.createBuffer({size:WORLD_SIGNS_BYTES*2,usage:128});
  const options={camera:[99,20,30],anchors:[[127,127,127]],cells:[[127,127,127]],slot:1,output};
  assert.equal(f.volume.signsState.state,'pending');assert.equal(f.candidate.recordSignsReady(f.encoder,options),false);assert.deepEqual(f.log,[]);
  const work=f.candidate.recordSigns(f.encoder,options);
  options.camera[0]=2;options.anchors[0][0]=3;options.cells[0][0]=4;options.slot=0;options.output={size:1};
  f.settle();await f.volume.signsReady;assert.equal(await work,true);
  assert.deepEqual(f.log.filter(x=>['begin','dispatch','end'].includes(x[0])),[['begin','world signs'],['dispatch',1],['end']]);
  const group=f.log.find(x=>x[0]==='group'&&x[1]===3)[2],params=group.entries.find(e=>e.binding===0).resource.buffer;
  const dv=new DataView(params.data.buffer);assert.equal(dv.getFloat32(0,true),99);assert.equal(dv.getUint32(WorldSignsParams.offsets.slot,true),1);
  assert.equal(dv.getFloat32(WorldSignsParams.offsets.anchors,true),127);assert.equal(dv.getFloat32(WorldSignsParams.offsets.cells,true),127);
  assert.equal(group.entries.find(e=>e.binding===6).resource.size,WORLD_SIGNS_BYTES*2);
  for(const change of [{slot:-1},{slot:1.2},{count:65},{cells:[]},{camera:[NaN,0,0]},{camera:[0,0,0]},{anchors:[[1e100,2,3]]},{cells:[[1.5,2,3]]},{output:{size:WORLD_SIGNS_BYTES-1,usage:128}},{output:{size:WORLD_SIGNS_BYTES,usage:64}},{presentation:{k:1,anchor:[0,0],dir:[0,0]}}])
   assert.throws(()=>f.candidate.recordSignsReady(f.encoder,{camera:[99,20,30],anchors:[[1,2,3]],cells:[[1,2,3]],output,...change}));
  f.frameUniforms.cam[0]=100;
  assert.throws(()=>f.candidate.recordSignsReady(f.encoder,{camera:[100,20,30],anchors:[],cells:[],output}),/candidate frame/);
  assert.equal(f.candidate.recordSignsReady(f.encoder,{camera:[99,20,30],anchors:[],cells:[],output}),true);
  f.candidate.release();assert.equal(output.dead,undefined);assert.equal(params.dead,true);
  assert.throws(()=>f.candidate.recordSignsReady(f.encoder,{}),/released/);
 }finally{f.settle();f.release();}
});
test('sign failures and reset while queued never open passes',async()=>{
 for(const reset of [false,true]){const f=fixture();try{
  const w=f.candidate.recordSigns(f.encoder,{camera:[99,20,30],anchors:[],cells:[],output:f.device.createBuffer({size:WORLD_SIGNS_BYTES,usage:128})});
  if(reset){f.atlas.reset();f.settle();}else f.settle(d=>d.label==='world signs',new Error('compile failed'));
  await assert.rejects(w,reset?/stale/:/compile failed/);assert.deepEqual(f.log,[]);
 }finally{f.settle();f.release();}}
});
test('full native factories Naga, four groups /16 sampled /six storage; BOX unchanged',()=>{
 for(const ny of [128,384])for(const sourceAppearance of [false,true]){
  const code=worldSignsWGSL({nx:3072,ny,nz:1024,sourceAppearance,sourceGrid:[128,0,128]}),groups=worldSignsLayouts();
  assert.deepEqual(checkPipeline({code,groups,kind:'compute'}).problems,[]);
  assert.equal(groups.length,4);assert.equal(groups.flat().filter(e=>e.texture).length,16);assert.equal(groups.flat().filter(e=>e.buffer?.type.includes('storage')).length,6);
  const r=nagaSpawn(code, `world-signs-${ny}-${sourceAppearance}.wgsl`, {encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }
 const old=spawnSync('git',['show','HEAD:src/shaders/probe.js'],{encoding:'utf8'}).stdout;assert.equal(readFileSync('src/shaders/probe.js','utf8'),old);
 assert.equal(SignParams.size,32);assert.deepEqual(SIGN_LAYOUT.map(e=>e.binding),[0,1,2]);
 console.log('Naga: four native WORLD sign modules; BOX probe byte-identical');
});
// The interpreter omits bool from function-local struct layouts (offset0,
// size0) and returns struct bool members as TypedData rather than scalars.
// Supply private CPU storage, not a WGSL rewrite or a claimed GPU layout.
const typedSubData=TypedData.prototype.getSubData;
TypedData.prototype.getSubData=function(...args){const r=typedSubData.apply(this,args);return r?.typeInfo.name==='bool'?new ScalarData(new Int32Array(r.buffer,r.offset,1),r.typeInfo,r):r;};
class ShaderExec extends WgslExec {
  constructor(ast){super(ast);this.getTypeInfo('bool').size=4;const done=new Set();const fix=t=>{if(!t.members||done.has(t))return;done.add(t);let end=0;for(const m of t.members)if(m.type.name!=='bool'){fix(m.type);m.size=m.type.size;end=Math.max(end,m.offset+m.size);}for(const m of t.members)if(m.type.name==='bool'){end=Math.ceil(end/4)*4;m.offset=end;m.size=4;end+=4;}t.size=Math.max(t.size,Math.ceil(end/(t.align??4))*(t.align??4));};for(const t of this.reflection.structs)fix(t);}
  // The interpreter eagerly evaluates &&/||; WGSL short-circuits them.
  _evalBinaryOp(node,context){if(node.operator==='&&'||node.operator==='||'){const a=this.evalExpression(node.left,context).value;const value=node.operator==='&&'?(a?this.evalExpression(node.right,context).value:0):(a?1:this.evalExpression(node.right,context).value);return new ScalarData(value?1:0,this.getTypeInfo('bool'));}return super._evalBinaryOp(node,context);}
  _dispatchWorkgroup(fn,id,context){for(const a of fn.node.attributes??[])if(a.name==='workgroup_size'&&typeof a.value==='string')a.value=[a.value];return super._dispatchWorkgroup(fn,id,context);}
  _callBuiltinFunction(node,context){
    // textureLoad otherwise tags integer pixels as vec4f, breaking packed HDR.
    if(node.name==='textureLoad'){const t=this.evalExpression(node.args[0],context);if(t.format?.endsWith('uint')){const p=this.evalExpression(node.args[1],context).data,array=t.typeInfo.name.includes('array'),layer=array?this.evalExpression(node.args[2],context).value:0,mip=this.evalExpression(node.args[array?3:2],context).value;return new VectorData(new Uint32Array(t.getPixel(p[0],p[1],layer,mip)),this.getTypeInfo('vec4u'));}}
    return super._callBuiltinFunction(node,context);
  }
  _callConstructorVec(node,context){const type=this.getTypeInfo(node.type),format=type.format?.name;if(!['u32','i32'].includes(format))return super._callConstructorVec(node,context);const n=Number(type.name.at(-1));let values=[];if(node.isVector)values=Array.from(node.vectorValue);else if(node.args)for(const arg of node.args){const v=this.evalExpression(arg,context);values.push(...(v.data&&v.data.length>1?Array.from(v.data):[v.value]));}if(!values.length)values=Array(n).fill(0);if(values.length===1)values=Array(n).fill(values[0]);return new VectorData(format==='u32'?new Uint32Array(values.slice(0,n)):new Int32Array(values.slice(0,n)),type).getSubData(this,node.postfix,context);}
  _makeCwiseData(values,type){if(type.name.startsWith('vec')&&['u32','i32'].includes(type.format?.name))return new VectorData(type.format.name==='u32'?new Uint32Array(values):new Int32Array(values),type);return super._makeCwiseData(values,type);}
  _call(node,context){const f=context.getFunction(node.name);if(!f)return super._call(node,context);const values=node.args.map(a=>this.evalExpression(a,context)),scope=context.clone();scope.currentFunctionName=node.name;f.node.args.forEach((a,i)=>scope.createVariable(a.name,values[i],a));this._execStatements(f.node.body,scope);}
}
const grid={nx:3072,ny:384,nz:1024};
const cpuCode=`${prelude(grid,{state:false,backend:'world'})}${materialsGLSL()}${ddaGLSL(grid,{backend:'world'})}
${presentationNearWGSL()}
struct BrickInfo {emit:vec3f,info:u32}
var<private> worldIncomplete:bool;
fn worldBeginQuery(){worldIncomplete=false;}
fn worldQueryIncomplete()->bool{return worldIncomplete;}
fn worldEndQuery(){}
fn brickDistAt(b:vec3i)->i32{return 0;}
fn brickMatter(w:u32)->bool{return w!=0u;}
fn brickAt(b:vec3i)->BrickInfo {if(P.cells[1].w<0.0 && b.x==8){worldIncomplete=true;}return BrickInfo(vec3f(0),1u);}
fn fetchA(c:vec3i)->vec4f {if(c.x==i32(P.cells[1].x) && (P.cells[2].w==0.0 || c.y==i32(P.cells[2].y))){return vec4f(P.cells[1].y,73.25,0,0);}return vec4f(0,21.5,0,0);}
fn fetchB(c:vec3i)->vec4f{return vec4f(0,0,0,2.75);}
${WorldSignsParams.wgsl}
@group(3) @binding(0) var<uniform> P:WorldSignsParams;
@group(3) @binding(6) var<storage,read_write> signOut:array<vec4f>;
${worldSignsArithmetic}${worldSignsEntry}`;
function cpu({camera=[0.5,383.5,0.5],anchor=[3071,383.5,0.5],cell=[3071,383,0],wall=3000,id=E.WALL,k=0,unknown=false,wallY=null}={}){
 const out=new Float32Array(512),exec=new ShaderExec(new WgslParser().parse(cpuCode));
 exec.dispatchWorkgroups('main',1,{0:{0:new Uint32Array(tablesBuffer()),1:new Int32Array(8)},3:{0:WorldSignsParams.pack({cam:camera,count:1,slot:0,k,anchor:[0,0],dir:[1,0],anchors:[[...anchor,0]],cells:[[...cell,0],[wall,id,0,unknown?-1:0],[0,wallY??0,0,wallY===null?0:1]]}),6:out}});
 return out;
}
test('actual native entry/arithmetic: far wall, glass, gas, unknown, own face, outside slabs, high rows and signed axes',()=>{
 assert.equal(cpu()[0],0);
 const glass=cpu({id:E.GLASS});assert.ok(glass[0]>0&&glass[0]<1);assert.equal(glass[4],1);
 assert.equal(cpu({id:E.SMOKE})[0],1);assert.equal(cpu({id:E.FIRE})[0],1);
 assert.equal(cpu({unknown:true,wall:4000})[4],-1);
 assert.equal(cpu({wall:3071})[0],1);
 assert.equal(cpu({camera:[3071.5,383.5,.5],wall:3071})[0],0); // stops .02 before attached face
 const own=cpu({wall:3071,cell:[3071,383,0]});assert.equal(own[1],E.WALL);assert.equal(own[2],73.25);assert.equal(own[3],2.75);
 for(const y of [127.5,383.5]) for(const z of [0,-0,.0001,-.0001]) assert.equal(cpu({camera:[-50,y,.5],anchor:[3071,y,.5+z]})[0],0);
 assert.equal(cpu({camera:[3072,383.5,0.5],anchor:[3072,383.5,900],wall:3072})[0],1); // parallel max-face exterior
 const curved=cpu({camera:[0.5,100,.5],anchor:[63,100,.5],cell:[63,100,0],wall:32,k:1/2048});assert.equal(curved[0],0);assert.equal(curved[4],1);
 const bend={camera:[.5,100,.5],anchor:[63,100,.5],cell:[63,100,0],wall:32,wallY:99};
 assert.equal(cpu(bend)[0],1);assert.equal(cpu({...bend,k:1/2048})[0],0);
 assert.equal(cpu({camera:[5.5,5,5.5],anchor:[5.5,0,5.5],cell:[5,0,5],wall:4000})[3],2.75);
});

class Node {
 constructor(){this.style={setProperty(k,v){this[k]=v;}};this.children=[];this.dataset={};this.handlers={};this.classes=new Set();this.classList={add:k=>this.classes.add(k),remove:k=>this.classes.delete(k),toggle:(k,b)=>{if(b)this.classes.add(k);else this.classes.delete(k);}};this.offsetWidth=100;this.offsetHeight=24;this.value='';}
 appendChild(n){this.children.push(n);return n;} append(...n){this.children.push(...n);} setAttribute(){} addEventListener(k,f){this.handlers[k]=f;} remove(){} contains(n){return this===n||this.children.includes(n);} focus(){} blur(){} setSelectionRange(){}
 getBoundingClientRect(){return {left:0,top:0,width:800,height:600};}
}
async function signsFixture(){
 globalThis.document={createElement:()=>new Node()};globalThis.addEventListener=()=>{};globalThis.removeEventListener=()=>{};globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
 const code=readFileSync('src/signs.js','utf8').replace("import './signs.css';",'').replace(/from '(\.[^']+)'/g,(_,p)=>`from '${pathToFileURL(new URL('../src/',import.meta.url).pathname+p.slice(2)).href}'`).replace("from 'three/webgpu'",`from '${import.meta.resolve('three/webgpu')}'`);
 const {Signs}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const camera=new THREE.PerspectiveCamera(60,4/3,.1,1e5);camera.position.set(100,20,100);camera.lookAt(100,20,0);camera.updateMatrixWorld();
 const sim={origin:new THREE.Vector3(64,0,64),g:{nx:128,ny:128,nz:128}};
 const volume=new THREE.Object3D(), signs=new Signs({renderer:{domElement:new Node()},camera,container:new Node(),getSim:()=>sim,getVolume:()=>volume});
 return {signs,sim,camera,volume};
}
test('actual Signs DOM: default BOX behavior, immutable request, accepted-only captured camera/model and origin-independent live pixels',async()=>{
 const {signs,sim,camera,volume}=await signsFixture();try{
  const s=signs.add({cell:{x:100,y:20,z:0},normal:{x:0,y:0,z:1},world:true,text:'{t} {p} {e}',edit:false});
  assert.equal(s.inside,false);assert.equal(signs.probeInterval,100);assert.equal(s.dom.shown,false);
  signs.setWorldOwner();signs._ensureProbe=()=>assert.fail('world must not probe BOX');
  const request=signs.worldRequest([3072,384,1024]);assert.deepEqual(request.anchors[0],[100.5,20.5,1]);assert.deepEqual(request.cells[0],[100,20,0]);
  assert.throws(()=>request.anchors[0][0]=0,TypeError);
  const publication=Object.freeze({epoch:1}),identity=Object.freeze({frame:1});
  const frame=signs.captureWorldFrame({request,camera,model:new THREE.Matrix4(),publication,identity});
  const results=new Float32Array([.9,E.WATER,73.25,2.75,1,0,0,0]);
  const envelope={frame,results,publication,identity,feedback:{incomplete:false},completed:true,accepted:true};
  signs.update();assert.equal(s.live,null);
  assert.equal(signs.commitWorldFrame({...envelope,accepted:false}),false);assert.equal(signs.commitWorldFrame({...envelope,publication:{}}),false);
  const incomplete=results.slice();incomplete[4]=-1;assert.equal(signs.commitWorldFrame({...envelope,results:incomplete}),false);assert.equal(s.live,null);
  camera.position.x+=1000;camera.updateMatrixWorld();volume.position.x=2000;sim.origin.x=3000;
  assert.equal(signs.commitWorldFrame(envelope),true);assert.equal(s.dom.shown,true);assert.equal(s.live.T,73.25);assert.equal(s.dom.vals[0].el.textContent,'73.3°C');
  const transform=s.dom.root.style.transform;
  sim.origin.set(0,0,0);camera.position.z=-1000;camera.updateMatrixWorld();signs.update();assert.equal(s.dom.root.style.transform,transform);assert.equal(s.live.P,2.75);
  results[2]=1;assert.equal(s.live.T,73.25);assert.equal(signs.commitWorldFrame(envelope),false);
  const req2=signs.worldRequest([3072,384,1024]),id2={},f2=signs.captureWorldFrame({request:req2,camera,model:new THREE.Matrix4().makeTranslation(10,0,0),publication,identity:id2});
  assert.equal(f2.camera[0],camera.position.x-10); // global conversion once
  s.text='changed';assert.equal(signs.commitWorldFrame({...envelope,frame:f2,identity:id2}),false);assert.equal(s.live.T,73.25);
  const newSign=signs.add({cell:{x:3071,y:383,z:1023},normal:{x:1,y:0,z:0},world:true,text:'new',edit:true});assert.equal(signs.editing,true);assert.equal(newSign.dom.shown,true);
  assert.equal(signs.commitWorldFrame({...envelope,frame:f2,identity:id2}),false);
  signs.clear();assert.equal(signs.commitWorldFrame(envelope),false);
  const floor=signs.add({cell:{x:5,y:-1,z:5},normal:{x:0,y:1,z:0},world:true,text:'floor',edit:false});
  assert.deepEqual(signs.worldRequest([3072,384,1024]).cells[0],[5,0,5]);assert.equal(floor.world.y,-1);
 }finally{signs.dispose();}
});
test('WORLD to BOX handback relocates signs even when the physics origin has not moved',async()=>{
 const {signs,sim}=await signsFixture();try{
  signs.setWorldOwner();
  const s=signs.add({cell:{x:100,y:20,z:0},normal:{x:0,y:0,z:1},world:true,text:'world',edit:false});
  signs.at.copy(sim.origin);
  assert.deepEqual(s.cell.toArray(),[0,0,0]);
  signs._ensureProbe=()=>{};signs.pending=true;
  signs.setWorldOwner(false);signs.update();
  assert.deepEqual(s.cell.toArray(),[36,20,-64]);assert.equal(s.inside,false);
  assert.equal(signs.dataDirty,true);assert.equal(s.dom.shown,false);
 }finally{signs.dispose();}
});
test('new non-edit WORLD signs wait for their own accepted result, including after the editor closes',async()=>{
 const {signs,camera}=await signsFixture();try{
  signs.setWorldOwner();
  signs.add({cell:{x:100,y:20,z:0},normal:{x:0,y:0,z:1},world:true,text:'first',edit:false});
  const publication={},identity={},request=signs.worldRequest([3072,384,1024]);
  const frame=signs.captureWorldFrame({request,camera,model:new THREE.Matrix4(),publication,identity});
  const envelope={frame,publication,identity,results:new Float32Array([1,E.WATER,20,1,1,0,0,0]),feedback:{incomplete:false},completed:true,accepted:true};
  assert.equal(signs.commitWorldFrame(envelope),true);
  const second=signs.add({cell:{x:101,y:20,z:0},normal:{x:0,y:0,z:1},world:true,text:'second',edit:false});
  assert.equal(second.dom.shown,false);assert.equal(second.live,null);
  signs.update();assert.equal(second.dom.shown,false);
  const editor=signs.add({cell:{x:102,y:20,z:0},normal:{x:0,y:0,z:1},world:true,text:'editor',edit:true});
  assert.equal(editor.dom.shown,true);
  signs._commit(editor);
  assert.equal(signs.editing,false);assert.equal(editor.dom.shown,false);
  const next=signs.captureWorldFrame({request:signs.worldRequest([3072,384,1024]),camera,model:new THREE.Matrix4(),publication,identity:{}});
  assert.equal(signs.commitWorldFrame({...envelope,frame:next,identity:next.identity,results:new Float32Array(Array(3).fill([1,E.WATER,20,1,1,0,0,0]).flat())}),true);
  assert.equal(second.dom.shown,true);assert.equal(editor.dom.shown,true);
 }finally{signs.dispose();}
});
test('actual typed world page/request/brick reader rejects missing RAW/FIELD/AUX for entire sign query',async()=>{
 const {worldAccessWGSL}=await import('../src/shaders/worldAccess.js');
 const source=worldAccessWGSL({backend:'world'});
 const fn=name=>{const a=source.indexOf(`fn ${name}(`);let b=source.indexOf('{',a),depth=1;while(depth&&++b<source.length){if(source[b]==='{')depth++;if(source[b]==='}')depth--;}return source.slice(a,b+1);};
 const start=cpuCode.indexOf('fn brickAt('),end=cpuCode.indexOf('\nfn fetchA',start);
 const readers=`
 const WORLD_ABI:u32=2u; const WORLD_RAW:u32=1u; const WORLD_FIELD:u32=2u; const WORLD_AUX:u32=4u;
 const WORLD_BOOK_READY:u32=${BOOK_READY_SHIFT}u; const WORLD_BOOK_LIGHT:u32=${BOOK_LIGHT_SHIFT}u; const WORLD_BOOK_PAGE:u32=${2**BOOK_READY_SHIFT-1}u;
 struct Meta {world:vec4u,tiles:vec4u,feedback:vec4u}
 @group(2)@binding(0)var<uniform> WA:Meta;
 @group(2)@binding(1)var<storage,read> worldBook:array<u32>;
 @group(2)@binding(2)var<storage,read_write> worldRequests:array<atomic<u32>>;
 fn worldBrickInBounds(b:vec3i)->bool{return all(b>=vec3i(0));}
 fn worldBookIndex(b:vec3i)->u32{return u32(b.x);}
 fn worldPageMeta(pid:u32,record:u32)->vec4u {return vec4u(0u,0u,0u,1u);}
 struct WorldBrickInfo {emit:vec3f,info:u32}
 ${fn('worldRequest')}${fn('worldPage')}${fn('worldBrickInfo')}
 fn brickAt(b:vec3i)->BrickInfo{let r=worldBrickInfo(b);return BrickInfo(r.emit,r.info);}
 `;
 const code=(cpuCode.slice(0,start)+readers+cpuCode.slice(end)).replace('fn worldEndQuery(){}','fn worldEndQuery(){if(worldQueryIncomplete()){atomicOr(&worldRequests[192],1u);}}');
 for(const ready of [0,1,3,7]){
  const out=new Float32Array(512),requests=new Uint32Array(193),book=new Uint32Array(768).fill((1|ready<<BOOK_READY_SHIFT)>>>0),meta=new Uint32Array([3072,384,1024,1,1,1,1,2,32,192,0,0]);
  const exec=new ShaderExec(new WgslParser().parse(code));
  exec.dispatchWorkgroups('main',1,{0:{0:new Uint32Array(tablesBuffer()),1:new Int32Array(8)},2:{0:meta,1:book,2:requests},3:{0:WorldSignsParams.pack({cam:[.5,383.5,.5],count:1,anchors:[[33,383.5,.5,0]],cells:[[33,383,0,0],[4000,0,ready,0]],dir:[1,0],anchor:[0,0]}),6:out}});
  assert.equal(out[4],ready===7?1:-1);assert.equal(requests[192],ready===7?0:1);
  for(let plane=0;plane<3;plane++)assert.equal(requests[plane*32]!==0,(ready&(1<<plane))===0);
 }
});
