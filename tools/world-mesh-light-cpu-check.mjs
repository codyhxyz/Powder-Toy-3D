// Actual Three node assembly/Naga and CPU execution, NOT GPU/visual evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {WGSLNodeBuilder,WebGPURenderer,Scene,PerspectiveCamera,Mesh,SkinnedMesh,Bone,Skeleton,BoxGeometry,Float32BufferAttribute,Uint16BufferAttribute,MeshBasicNodeMaterial,MeshStandardNodeMaterial,AmbientLight,DataTexture,RGBAFormat,FloatType,Matrix4,Vector3} from 'three/webgpu';
import {vec3,texture,normalWorld,positionWorld,faceDirection,uv,vec2} from 'three/tsl';
import {litColor,figNormalMappedFn,meshLightWGSL,meshLight,createNativeWorldMeshLightContext,setMeshLightDomain,meshLightDomain,prepareMesh,guardMeshes,setMeshGpu,PENDING_MASK} from '../src/gfx/meshLight.js';
import {externalStorageAttribute} from '../src/gpu/three.js';
import {figureMaterial,figureUniforms} from '../src/pov/figure.js';
import {worldAtlasLayout,worldBookLayout,LIGHT_RECORDS} from '../src/world/renderAtlas.js';
import {worldMeshLightWGSL,worldMeshSunWGSL,worldMeshAmbientWGSL} from '../src/shaders/worldMeshLight.js';
import {WgslParser,WgslExec,VectorData,ScalarData} from 'wgsl_reflect/wgsl_reflect.module.js';
import {ELEMENTS,E,R} from '../src/elements.js';
import { nagaSpawn } from './naga.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function renderer(){const r=new WebGPURenderer({canvas:{addEventListener(){},removeEventListener(){},style:{}}});r.hasFeature=()=>false;r.backend.device={limits:{maxUniformBufferBindingSize:65536,maxStorageBufferBindingSize:128*1024**2,maxTextureDimension2D:8192}};return r;}
const nativeTexture=(format,width=1,height=1,depthOrArrayLayers=1,dimension='2d')=>({format,width,height,depthOrArrayLayers,dimension});
function fixture(r=renderer()){
  const size=[64,32,64],book=worldBookLayout(size),layout=worldAtlasLayout(16,{},16,16),done=deferred();let pins=1,compatible=true,completions=0;
  const S={book:{size:32},sun0:{},sun1:{},params:{worldToLight:new Matrix4().toArray(),depth:[0,0,.416531224,2.4],tiles:[0,0,1,1],physical:[256,8,64,1],version:[1,1,1,book.sunWord]}};
  const publication={identity:{scene:1},release(){assert.equal(pins,1);pins--;},atlas:{abi:2,epoch:1,generation:1,layout,lightBook:{size:book.count*4},sunManifest:{...S,epoch:1}},sun:S,
    textures:{aux:nativeTexture('rgba32uint'),gi:Array.from({length:4},()=>nativeTexture('rgba16float')),glow:nativeTexture('rgba16float'),sunOptical:nativeTexture('rgba32float',2048,2048)}};
  const gpu={device:{limits:{},queue:{onSubmittedWorkDone(){completions++;return done.promise;}}},three:{renderer:r}};
  const frameValues={model:new Matrix4().makeTranslation(5,6,7),sun:[0,1,0],sunCol:[1,.8,.6],caveAmbient:[.1,.2,.3],cloudShift:[2,3],shadows:true,time:7,lightGain:2,caustics:true,wandLightCount:1,wandLightPosition:[[1,2,3,4]],wandLightColor:[[1,.5,.1,2]]};
  const options={publication,worldSize:size,frameValues,feedback:{size:(book.sunWord+1)*4},noise:nativeTexture('rgba8unorm',1,1,1,'3d'),isCompatible:()=>compatible};
  return {r,gpu,options,done,frameValues,publication,get pins(){return pins;},get completions(){return completions;},invalidate(){compatible=false;}};
}
function material(mapped=false,artwork=false,pbr=false){
  const m=pbr?new MeshStandardNodeMaterial():new MeshBasicNodeMaterial();m.lights=pbr;
  const tex=()=>new DataTexture(new Float32Array([.5,.5,1,1]),1,1,RGBAFormat,FloatType),normal=tex();
  const n=mapped?figNormalMappedFn({n:normalWorld,face:faceDirection,wp:positionWorld,uv:uv(),m0:texture(normal).xyz,scale:vec2(1)}):normalWorld;
  let albedo=vec3(.7,.4,.2);const maps=Array.from({length:3},tex);if(artwork)for(const map of maps)albedo=albedo.mul(texture(map).rgb);
  if(pbr){m.normalMap=normal;m.roughnessMap=maps[1];m.metalnessMap=maps[1];m.emissiveMap=maps[2];m.emissive.set(0xffffff);}
  m.colorNode=litColor({albedo,n});return m;
}
function meshFor(variant,m){
  const g=new BoxGeometry();
  if(variant.includes('morph')){g.morphAttributes.position=[g.attributes.position.clone()];g.morphAttributes.normal=[g.attributes.normal.clone()];g.morphTargetsRelative=true;}
  if(variant.includes('skin')){
    const n=g.attributes.position.count;g.setAttribute('skinIndex',new Uint16BufferAttribute(new Uint16Array(n*4),4));
    const w=new Float32Array(n*4);for(let i=0;i<n;i++)w[i*4]=1;g.setAttribute('skinWeight',new Float32BufferAttribute(w,4));
    const mesh=new SkinnedMesh(g,m),bone=new Bone();mesh.add(bone);mesh.bind(new Skeleton([bone]));return mesh;
  }return new Mesh(g,m);
}
function build(mesh,r){const b=new WGSLNodeBuilder(mesh,r);b.scene=new Scene();if(mesh.material.isMeshStandardNodeMaterial)b.scene.add(new AmbientLight());b.camera=new PerspectiveCamera();b.build();return b;}
function naga(code,name){const p=nagaSpawn(code, name+'.wgsl', {encoding:'utf8'});assert.equal(p.status,0,p.stderr);}
const hash=s=>createHash('sha256').update(s).digest('hex');
test('original BOX lighting WGSL byte-for-byte matches pre-edit base',async()=>{
  const old=execFileSync('git',['show','5a860d61:src/gfx/meshLight.js'],{encoding:'utf8'}).replace(/from '([^']+)'/g,(_m,p)=>`from '${p.startsWith('.')?new URL(p,new URL('../src/gfx/meshLight.js',import.meta.url)).href:import.meta.resolve(p)}'`);
  const original=await import('data:text/javascript;base64,'+Buffer.from(old).toString('base64'));assert.equal(hash(meshLightWGSL),hash(original.meshLightWGSL));
});
test('actual existing normal/artwork/skinned/morph Three graphs switch BOX/WORLD/BOX; Naga and default limits',async()=>{
  let modules=0;
  for(const variant of ['plain','normal','artwork','skin','morph','skin-morph-artwork','pbr-skin-morph-artwork']){
    const r=renderer(),f=fixture(r),m=material(variant!=='plain',variant.includes('artwork'),variant.includes('pbr')),mesh=meshFor(variant,m);
    setMeshLightDomain();const box=build(mesh,r);assert.doesNotMatch(box.fragmentShader,/fn wmlSun\s*\(/);
    const c=createNativeWorldMeshLightContext(f.gpu,f.options);setMeshLightDomain(c);
    const world=build(mesh,r);assert.match(world.fragmentShader,/fn wmlSun\s*\(/);assert.match(world.fragmentShader,/fn wmlNormal\s*\(/);
    const fragment=world.fragmentShader,sampled=[...fragment.matchAll(/var \w+\s*:\s*texture_(?!storage)/g)].length;
    const storage=[...fragment.matchAll(/var<storage,/g)].length;
    assert(sampled<=16,`${variant}: ${sampled} sampled`);assert(storage<=8,`${variant}: ${storage} storage`);
    const groups=[...new Set([...world.vertexShader.matchAll(/@group\(\s*(\d+)\s*\)/g),...fragment.matchAll(/@group\(\s*(\d+)\s*\)/g)].map(m=>m[1]))];assert(groups.length<=4&&Math.max(...groups.map(Number))<4);
    for(const shader of [world.vertexShader,fragment]){assert([...shader.matchAll(/var<storage,/g)].length<=8);assert([...shader.matchAll(/var \w+\s*:\s*texture_(?!storage)/g)].length<=16);assert([...shader.matchAll(/var \w+\s*:\s*sampler/g)].length<=16);}
    assert.equal(storage,3,'only LIGHT book + SunBook + atomic feedback');assert.doesNotMatch(fragment,/var .*texture_3d.*\n.*gi/);
    for(const [name,b]of [['box',box],['world',world]])for(const stage of ['vertex','fragment']){naga(b[stage+'Shader'],`${variant}.${name}.${stage}`);modules++;}
    setMeshLightDomain();const again=build(mesh,r);assert.doesNotMatch(again.fragmentShader,/fn wmlSun\s*\(/);assert.match(again.fragmentShader,/fn figSun\s*\(/);
    setMeshLightDomain(c);assert.match(build(mesh,r).fragmentShader,/fn wmlSun\s*\(/);setMeshLightDomain();
    const submitted=deferred(),retired=c.retireAfter(submitted.promise);submitted.resolve();f.done.resolve();await retired;
    m.dispose();mesh.geometry.dispose();
  }console.log(`Naga: ${modules} actual BOX/WORLD native shaders, normal/artwork/skin/morph; <=16 sampled, <=8 storage, <=4 groups`);
});
test('external uint buffers are adopted, not uploaded or copied, and actual native bindings follow attribute identity',()=>{
  const r=renderer(),a={size:64},b={size:128},first=externalStorageAttribute(r,a,16),second=externalStorageAttribute(r,b,32);
  assert.equal(r.backend.get(first).buffer,a);assert.equal(r.backend.get(second).buffer,b);assert.equal(first.array.length,1);assert.equal(first.count,16);
  assert.throws(()=>externalStorageAttribute(r,a,17),/extent/);
});
test('actual existing figure uniforms cannot retain a local grid matrix, and built native bindings repoint to the next owned publication',async()=>{
  const r=renderer(),f=fixture(r),next=fixture(r),u=figureUniforms(),m=figureMaterial({albedo:[.6,.4,.2],u}),mesh=meshFor('plain',m);
  u.worldToGrid.value.makeTranslation(999,0,0);
  const c=createNativeWorldMeshLightContext(f.gpu,f.options);c.bind();
  const b=build(mesh,r),bindings=b.getBindings().flatMap(g=>g.bindings),binding=bindings.find(v=>v.isStorageBuffer&&r.backend.get(v.attribute).buffer===f.publication.atlas.lightBook);
  assert(binding);const old=binding.attribute;
  const uniforms=b.uniforms.fragment.map(v=>v.node.value);assert(!uniforms.includes(u.worldToGrid.value),'WORLD figure uses captured global matrix instead');
  const second=createNativeWorldMeshLightContext(next.gpu,next.options);second.bind();assert.notEqual(binding.attribute,old);assert.equal(r.backend.get(binding.attribute).buffer,next.publication.atlas.lightBook);
  setMeshLightDomain();const box=build(mesh,r);assert(box.uniforms.fragment.some(v=>v.node.value===u.worldToGrid.value),'BOX restores supplied figure matrix');
  for(const [context,x]of [[c,f],[second,next]]){const p=context.retireAfter(Promise.resolve());x.done.resolve();await p;}
  m.dispose();mesh.geometry.dispose();
});
test('height384 world book extent is legal without allocating a CPU mirror',()=>{
  const f=fixture(),size=[3072,384,1024],book=worldBookLayout(size);f.options.worldSize=size;f.publication.atlas.lightBook.size=book.count*4;
  f.publication.sun.params.version[3]=book.sunWord;f.options.feedback.size=(book.sunWord+1)*4;
  const c=createNativeWorldMeshLightContext(f.gpu,f.options);assert.equal(f.publication.atlas.lightBook.size,72*1024**2);c.cancel();assert.equal(f.pins,0);
});
test('private SOURCE/previous-GI snapshots cannot become native scene lighting',()=>{
  const f=fixture();f.publication.atlas.producerOnly=true;
  assert.throws(()=>createNativeWorldMeshLightContext(f.gpu,f.options),/private producer/);
  assert.equal(f.pins,0);
});
test('contexts own frozen values and pins through final submit AND completion including rejected prefixes, and reject old scene/epoch',async()=>{
  for(const reject of [false,true]){
    const f=fixture(),c=createNativeWorldMeshLightContext(f.gpu,f.options);f.frameValues.sun.fill(99);f.frameValues.model.elements.fill(99);f.frameValues.wandLightPosition[0].fill(99);
    c.bind();assert.deepEqual(meshLight.sun.value.toArray(),[0,1,0,1]);assert.deepEqual(meshLight.worldToGrid.value.elements,new Matrix4().makeTranslation(-5,-6,-7).elements);
    assert.deepEqual(Array.from(meshLight.wand.value.image.data.slice(0,4)),[1,2,3,4]);
    f.invalidate();assert.throws(()=>c.bind(),/incompatible/);setMeshLightDomain();
    const ticket=deferred(),p=c.retireAfter(ticket.promise);const checked=reject?assert.rejects(p,/discarded/):p;
    if(reject)ticket.reject(new Error('final discarded after prefix'));else ticket.resolve();
    await Promise.resolve();await Promise.resolve();assert.equal(f.completions,1);assert.equal(f.pins,1);assert.equal(c.released,false);
    f.done.resolve();await checked;assert.equal(f.pins,0);assert(c.released);
  }
  const f=fixture();f.publication.sun={...f.publication.sun,book:{size:32}};assert.throws(()=>createNativeWorldMeshLightContext(f.gpu,f.options),/one publication/);assert.equal(f.pins,0);
});
test('backend revisions invalidate already-prepared materials and stale asynchronous compiles cannot certify the new domain',async()=>{
  const f=fixture(),m=material(),mesh=meshFor('plain',m),scene=new Scene(),camera=new PerspectiveCamera();scene.add(mesh);let pending=[];
  f.gpu.three.defaults={scene,camera,target:null};f.r.info={calls:0};f.gpu.three.prepare=()=>{const d=deferred();pending.push(d);return d.promise;};setMeshGpu(f.gpu);
  setMeshLightDomain();const p=prepareMesh(mesh);const boxKey=m.customProgramCacheKey();
  const c=createNativeWorldMeshLightContext(f.gpu,f.options);setMeshLightDomain(c);assert.notEqual(m.customProgramCacheKey(),boxKey);
  pending.shift().resolve();await p;assert.equal(guardMeshes(scene,camera),1);assert.equal(mesh.layers.mask,PENDING_MASK);
  pending.shift().resolve();await Promise.resolve();await Promise.resolve();assert.equal(guardMeshes(scene,camera),0);
  setMeshLightDomain();assert.equal(guardMeshes(scene,camera),1);pending.shift().resolve();await Promise.resolve();await Promise.resolve();
  assert.equal(guardMeshes(scene,camera),0);setMeshGpu(null);const retired=c.retireAfter(Promise.resolve());f.done.resolve();await retired;m.dispose();mesh.geometry.dispose();
});

// Interpreter adapters only correct documented uint constructor / void scope
// deficiencies. Resource accesses and production leaf arithmetic remain intact.
class Exec extends WgslExec {
  _callBuiltinFunction(node,context){
    // 1.6.0 types vector select from its boolean condition, truncating weights.
    if(node.name==='select'){const [a,b,c]=node.args.map(x=>this.evalExpression(x,context));if(a.data?.length>1)return new VectorData(new a.data.constructor(Array.from(a.data,(v,i)=>(c.data[i]??c.value)?b.data[i]:v)),a.typeInfo);return new ScalarData((c.value??c.data[0])?b.value:a.value,a.typeInfo);}
    return super._callBuiltinFunction(node,context);
  }
  _makeCwiseData(values,type){if(type.name.startsWith('vec')&&['u32','i32'].includes(type.format?.name))return new VectorData(type.format.name==='u32'?new Uint32Array(values):new Int32Array(values),type);return super._makeCwiseData(values,type);}
  _call(node,context){const fn=context.getFunction(node.name);if(!fn)return super._call(node,context);const values=node.args.map(a=>this.evalExpression(a,context)),scope=context.clone();scope.currentFunctionName=node.name;fn.node.args.forEach((a,i)=>scope.createVariable(a.name,values[i],a));this._execStatements(fn.node.body,scope);}
  _callConstructorVec(node,context){const type=this.getTypeInfo(node.type),format=type.format?.name;if(!['u32','i32'].includes(format))return super._callConstructorVec(node,context);const n=Number(type.name.at(-1));let v=[];if(node.isVector)v=Array.from(node.vectorValue);else for(const a of node.args??[]){const q=this.evalExpression(a,context);v.push(...(q.data?.length>1?Array.from(q.data):[q.value]));}if(!v.length)v=Array(n).fill(0);if(v.length===1)v=Array(n).fill(v[0]);return new VectorData(format==='u32'?new Uint32Array(v.slice(0,n)):new Int32Array(v.slice(0,n)),type).getSubData(this,node.postfix,context);}
}
const texBinding=(data,size,format='rgba32float',dimension='2d')=>({texture:[data.buffer],descriptor:{size,format,dimension}});
const near=(a,b,e=3e-5)=>assert.ok(Math.abs(a-b)<=e*Math.max(1,Math.abs(b)),`${a} != ${b}`);
test('executed production global trilinear LIGHT leaf crosses 4/32 boundaries and physical IDs, edge clamp and sticky typed misses',()=>{
  const dims=[18,2,2],count=dims.reduce((a,b)=>a*b),auxW=128,base=132,auxH=Math.ceil((base+count*LIGHT_RECORDS)/auxW),probeW=16,probeH=Math.ceil(count/probeW),book=new Uint32Array(count),aux=new Uint32Array(auxW*auxH*4),band=new Float32Array(probeW*probeH*4);
  for(let i=0;i<count;i++){
    const id=count-1-i;book[i]=id+1;aux.set([48,1,1,1],(base+id*LIGHT_RECORDS)*4);aux.set([i+1,i+1,0,0],(base+id*LIGHT_RECORDS+1)*4);aux.set([0,0,2,7],(base+id*LIGHT_RECORDS+3)*4);
    const x=i%dims[0],y=Math.floor(i/dims[0])%2,z=Math.floor(i/(dims[0]*2));band.set([x+2*y+3*z,2*x-y,.5*z,1],i*4);
  }
  const points=[[3.9,2,2],[4.1,3,4],[31.9,3,3],[32.1,3,3],[-10,-1,-4],[100,8,20]],plane=Math.ceil(count/32),status=plane*6;
  const leaf=worldMeshLightWGSL(meshLightWGSL,{book:'book',sunBook:'sunBook',requests:'requests'}),source=`${leaf}\n${worldMeshAmbientWGSL}
@group(0) @binding(0) var<storage,read> book:array<u32>; @group(0) @binding(1) var<storage,read_write> requests:array<atomic<u32>>;
@group(0) @binding(2) var aux:texture_2d_array<u32>; @group(0) @binding(3) var band:texture_2d_array<f32>;
@group(0) @binding(4) var<storage,read> points:array<vec4f>; @group(0) @binding(5) var<storage,read_write> out:array<vec4f>;
@group(0) @binding(6) var<storage,read> sunBook:array<u32>;@group(0) @binding(7) var wand:texture_2d<f32>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
  let world=vec4u(18,2,2,1);let light=vec4u(132,${count},${count},7);let geometry=vec4u(${auxW},${auxH},${probeW},${probeH});let fb=vec4u(${plane},${status},${status+1},2);
  out[id.x]=wmlProbe(band,points[id.x].xyz,16u,aux,world,light,geometry,fb);
  out[id.x+${points.length}u]=vec4f(wmlAmbient(points[id.x].xyz,points[id.x].xyz,normalize(vec3f(.3,.4,.8)),band,band,band,band,band,aux,world,light,geometry,fb,wand,0.0,vec4f(1,1,1,2),vec4f(.1,.2,.3,0)),1.0);
}`;
  naga(source,'probe.numeric');const req=new Uint32Array(status+2),output=new Float32Array(points.length*8),inputs=new Float32Array(points.flatMap(p=>[...p,0]));
  const execute=()=>new Exec(new WgslParser().parse(source)).dispatchWorkgroups('main',points.length,{0:{0:book,1:req,2:texBinding(aux,[auxW,auxH,1],'rgba32uint'),3:texBinding(band,[probeW,probeH,1]),4:inputs,5:output,7:texBinding(new Float32Array(4),[1,1,1])}});
  execute();assert(req.every(v=>v===0),`unexpected feedback ${Array.from(req)}; values ${Array.from(output)}`);
  points.forEach((p,i)=>{const q=p.map((v,k)=>Math.max(0,Math.min(dims[k]-1,v/4-.5)));near(output[i*4],q[0]+2*q[1]+3*q[2]);near(output[i*4+1],2*q[0]-q[1]);near(output[i*4+2],.5*q[2]);});
  const coefficient=name=>meshLightWGSL.match(new RegExp(`const FIG_${name}: f32 = ([^;]+);`))[1].split('/').map(Number).reduce((a,b)=>a/b);
  const n=[.3,.4,.8],sum=n.reduce((a,b)=>a+b)/Math.hypot(...n),factor=coefficient('SH_Y0')+coefficient('SH_COS1')*coefficient('SH_Y1')*sum;
  for(let i=0;i<points.length;i++)for(let c=0;c<3;c++)near(output[(i+points.length)*4+c],Math.max(0,output[i*4+c]*factor)+[.1,.2,.3][c]+output[i*4+c]*2);
  book[7]=0;execute();assert.equal(req[status],1);assert(req[4*plane]&(1<<7),'typed GI bit uses logical brick, not physical descriptor');
});
test('executed world optical Sun crosses virtual tiles: colored glass, water caustics, clouds once and sticky unknown tiles',()=>{
  const leaf=worldMeshLightWGSL(meshLightWGSL,{book:'book',sunBook:'sunBook',requests:'requests'}),source=`${leaf}\n${worldMeshSunWGSL}
@group(0) @binding(0) var<storage,read> book:array<u32>;@group(0) @binding(1) var<storage,read> sunBook:array<u32>;
@group(0) @binding(2) var<storage,read_write> requests:array<atomic<u32>>;@group(0) @binding(3) var sm:texture_2d_array<f32>;
@group(0) @binding(4) var sig:texture_2d<f32>;@group(0) @binding(5) var noise:texture_3d<f32>;@group(0) @binding(6) var rep:sampler;
@group(0) @binding(7) var<storage,read> config:array<vec4f>;@group(0) @binding(8) var<storage,read_write> out:array<vec4f>;
@compute @workgroup_size(1) fn main(){
  let p=vec3f(255.75,.5,6);let sun=vec4f(0,1,0,1);let origin=vec4f(0,0,0,7);let cloud=vec4f(config[0].y,0,0,0);
  let light=wmlSun(p,sm,sig,noise,rep,vec4u(18,2,2,1),vec4u(3,18,19,2),mat4x4f(vec4f(1,0,0,0),vec4f(0,1,0,0),vec4f(0,0,1,0),vec4f(0,0,0,1)),vec4f(0,0,.416531224,2.4),vec4i(0,0,2,1),vec4u(256,8,64,1),vec4u(1,1,1,19),sun,vec4f(1),origin,vec4f(0,0,0,config[0].x),cloud);
  out[0]=vec4f(light,figCausticGain(p,4.0,sun.xyz,origin));out[1]=vec4f(figCloudShadow(p,sun.xyz,noise,rep,cloud));
}`;
  naga(source,'sun.numeric');
  const optical=new Float32Array(2048*2048*4),sigmas=new Float32Array(ELEMENTS.length*4),sunBook=new Uint32Array(16),requests=new Uint32Array(20),out=new Float32Array(8),config=new Float32Array(4);
  ELEMENTS.forEach((e,i)=>sigmas.set([...(e.sigma??[0,0,0]),e.render===R.LIQUID?1:0],i*4));
  sunBook.set([0,1,1,1,0,0,1,0]);sunBook.set([1,1,1,1,0,0,1,0],8);
  const setOptical=(id,tau)=>{for(const x of [255,256])for(const y of [0,1])optical.set([20,2,8,id*256+tau],(x+2048*y)*4);};
  const execute=()=>new Exec(new WgslParser().parse(source)).dispatchWorkgroups('main',1,{0:{0:new Uint32Array(1),1:sunBook,2:requests,3:texBinding(optical,[2048,2048,1]),4:texBinding(sigmas,[ELEMENTS.length,1,1]),5:texBinding(new Float32Array([.8,.8,.8,.8]),[1,1,1],'rgba32float','3d'),6:{sampler:{}},7:config,8:out}});
  const tint=(id,tau)=>{const sigma=ELEMENTS[id].sigma,mean=sigma.reduce((a,b)=>a+b)/3,quantized=Math.fround(id*256+tau)-id*256;return sigma.map(s=>Math.exp(-s/Math.max(mean,1e-4)*quantized*4/6));};
  setOptical(E.GLASS,1.25);execute();assert(requests.every(v=>!v));tint(E.GLASS,1.25).forEach((v,i)=>near(out[i],v));assert.notEqual(out[0],out[1]);
  const water=ELEMENTS[E.WATER].sigma,tau=water.reduce((a,b)=>a+b)/3*6;setOptical(E.WATER,tau);config[0]=1;execute();
  tint(E.WATER,tau).forEach((v,i)=>near(out[i],v*out[3]));assert(out[3]>.0);
  config[0]=0;config[1]=1;execute();tint(E.WATER,tau).forEach((v,i)=>near(out[i],v*out[4]));assert(out[4]>=0&&out[4]<=1);
  config[1]=0;sunBook[14]=0;requests.fill(0);execute();assert.equal(requests[18],1);assert(requests[19]&2);
  sunBook[14]=1;sunBook[1]=2;requests.fill(0);execute();assert.equal(requests[18],1);assert(requests[19]&1);
});
