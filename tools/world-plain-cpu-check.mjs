// CPU interpreter/factory/Naga evidence only: no driver, visual or performance claim.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { WgslExec, WgslParser, VectorData, ScalarData, TypedData } from 'wgsl_reflect/wgsl_reflect.module.js';
import { gridDims, prelude, tablesBuffer } from '../src/shaders/common.js';
import { meshWGSL, drawWGSL, sunWGSL, blockPipelines } from '../src/shaders/blocks.js';
import { volumeFrag, pickFrag, PickParams, PICK_BATCH, VOLUME_LAYOUTS, PICK_LAYOUTS, WORLD_PLAIN_PHASES, worldPlainPipelines } from '../src/shaders/render.js';
import { materialsGLSL } from '../src/gfx/materials.js';
import { ddaGLSL } from '../src/shaders/gfx/core.js';
import { presentationNearWGSL } from '../src/shaders/gfx/presentation.js';
import { worldPlainFaceWGSL, worldPlainClassesWGSL, worldPlainSpanWGSL, worldPlainWalkWGSL } from '../src/shaders/worldPlain.js';
import { blockLookHelpersWGSL, blockLookWGSL } from '../src/shaders/blockPlainShared.js';
import { checkPipeline } from './check-sampler-budget.mjs';
import { E, ELEMENTS } from '../src/elements.js';
import { isLive, packSpark, SPARK_BORN } from '../src/electricity.js';
import { nagaSpawn } from './naga.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const near=(a,b,e=3e-6)=>assert.ok(Math.abs(a-b)<=e*Math.max(1,Math.abs(b)),`${a} != ${b}`);
// CPU model of the actual fixed-function target descriptors, not Plain shading.
function blendTarget(blend,src,dst){
  if(!blend)return Array.from(src);
  const factor=(name,k)=>({zero:0,one:1,src:src[k],'one-minus-src-alpha':1-src[3]})[name];
  return Array.from({length:4},(_,k)=>{const b=k===3?blend.alpha:blend.color;assert.equal(b.operation??'add','add');return src[k]*factor(b.srcFactor,k)+dst[k]*factor(b.dstFactor,k);});
}
function naga(code,name){const r=nagaSpawn(code, `${name}.wgsl`, {encoding:'utf8'});assert.equal(r.status,0,`${name}: ${r.stdout}\n${r.stderr}`);}
function fn(code,name){const start=code.indexOf(`fn ${name}(`);assert.ok(start>=0,name);let end=code.indexOf('{',start),d=1;while(d&&++end<code.length){if(code[end]==='{')d++;if(code[end]==='}')d--;}return code.slice(start,end+1);}
// IEEE binary16 RNE. wgsl_reflect1.6.0 truncates pack2x16float instead.
function half(v){const b=new ArrayBuffer(4),d=new DataView(b);d.setFloat32(0,v,true);const x=d.getUint32(0,true),sign=x>>>16&0x8000,e=(x>>>23&255)-127,m=x&0x7fffff;if(e>15)return sign|0x7c00;if(e< -25)return sign;const sig=e< -14?m|0x800000:m,shift=e< -14?-e-1:13;let q=sig>>>shift,tail=sig-q*2**shift,mid=2**(shift-1);if(tail>mid||tail===mid&&(q&1))q++;return sign|(e< -14?q:(e+15)*1024+q);}
const pair=(a,b)=>(half(a)|half(b)<<16)>>>0;
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
    if(node.name==='pack2x16float'){const v=this.evalExpression(node.args[0],context).data;return new ScalarData(pair(v[0],v[1]),this.getTypeInfo('u32'));}
    // textureLoad otherwise tags integer pixels as vec4f, breaking packed HDR.
    if(node.name==='textureLoad'){const t=this.evalExpression(node.args[0],context);if(t.format?.endsWith('uint')){const p=this.evalExpression(node.args[1],context).data,array=t.typeInfo.name.includes('array'),layer=array?this.evalExpression(node.args[2],context).value:0,mip=this.evalExpression(node.args[array?3:2],context).value;return new VectorData(new Uint32Array(t.getPixel(p[0],p[1],layer,mip)),this.getTypeInfo('vec4u'));}}
    return super._callBuiltinFunction(node,context);
  }
  _callConstructorVec(node,context){const type=this.getTypeInfo(node.type),format=type.format?.name;if(!['u32','i32'].includes(format))return super._callConstructorVec(node,context);const n=Number(type.name.at(-1));let values=[];if(node.isVector)values=Array.from(node.vectorValue);else if(node.args)for(const arg of node.args){const v=this.evalExpression(arg,context);values.push(...(v.data&&v.data.length>1?Array.from(v.data):[v.value]));}if(!values.length)values=Array(n).fill(0);if(values.length===1)values=Array(n).fill(values[0]);return new VectorData(format==='u32'?new Uint32Array(values.slice(0,n)):new Int32Array(values.slice(0,n)),type).getSubData(this,node.postfix,context);}
  _makeCwiseData(values,type){if(type.name.startsWith('vec')&&['u32','i32'].includes(type.format?.name))return new VectorData(type.format.name==='u32'?new Uint32Array(values):new Int32Array(values),type);return super._makeCwiseData(values,type);}
  _call(node,context){const f=context.getFunction(node.name);if(!f)return super._call(node,context);const values=node.args.map(a=>this.evalExpression(a,context)),scope=context.clone();scope.currentFunctionName=node.name;f.node.args.forEach((a,i)=>scope.createVariable(a.name,values[i],a));this._execStatements(f.node.body,scope);}
}
const g={nx:3072,ny:384,nz:1024};
const TB=new Uint32Array(tablesBuffer());
function execute(code,n,bindings){return new ShaderExec(new WgslParser().parse(code)).dispatchWorkgroups('main',n,{0:{0:TB,1:new Int32Array(8)},...bindings});}

// Fixture baseline: fetched origin/main b85d26e977b53a95eb02fcc14d6c3179938a281b, re-pinned at the V2
// merge to V2 tip 7f9b2f1c's emissions, which the merge reproduces byte for byte.
// Receipt: independent detached production worktree; Buffer.equals verified all
// nine mesh/draw/sun emissions at gridDims cubic sizes 32, 64 and 128.
test('all nine independent production BOX Plain mesh/draw/sun hashes remain identical',()=>{
  const hashes=JSON.parse(readFileSync(new URL('./fixtures/world-plain-box-shaders.json',import.meta.url)));
  for(const n of [32,64,128])for(const [key,f]of Object.entries({mesh:meshWGSL,draw:drawWGSL,sun:sunWGSL}))assert.equal(hash(f(gridDims({nx:n,ny:n,nz:n}))),hashes[key+n]);
  assert.throws(()=>volumeFrag(g,{view:'plain'}),/no view plain/);
  assert.equal(pickFrag(g,{view:'plain'}),pickFrag(g));
});
test('actual full-world Plain factories, both presentations/heights/artwork flags, Naga and unchanged reader budgets',()=>{
  let count=0;
  for(const ny of [128,384])for(const sourceAppearance of [false,true]){
    const grid={...g,ny,sourceAppearance,sourceGrid:[384,16,128]};
    for(const curved of [false,true]){
      const code=volumeFrag(grid,{backend:'world',view:'plain',curved}),groups=VOLUME_LAYOUTS({backend:'world'});
      assert.deepEqual(checkPipeline({code,groups,kind:'render'}).problems,[]);
      assert.equal(groups.flat().filter(e=>e.texture).length,16);assert.equal(groups.flat().filter(e=>e.buffer?.type.includes('storage')).length,5);
      assert.doesNotMatch(code,/fn (farBeyond|farCasterDepth|farShadeMaterial|sourcePair)\(|pos\.x & 1023|FU\.far != 0u/);
      assert.match(code,/plain_look\(plainFace/);assert.match(code,/worldEndQuery\(\); if \(worldQueryIncomplete\(\)\)/);
      assert.ok(code.includes('(*acc).trans*=k.tr;(*acc).scatter+=k.e;'));
      const phases=worldPlainPipelines({curved}),box=blockPipelines();
      assert.deepEqual(Object.keys(phases),WORLD_PLAIN_PHASES);
      for(const phase of WORLD_PLAIN_PHASES){
        const p=phases[phase];assert.match(code,new RegExp(`@fragment fn ${p.fragment.entry}\\(`));
        assert.deepEqual(p.fragment.targets,box[phase].fragment.targets);
        assert.deepEqual(p.depthStencil,box[phase].depthStencil);
        assert.equal(p.primitive.topology,curved?'triangle-list':'triangle-strip');
      }
      assert.doesNotMatch(code,/@fragment fn fs\(/,'single-over WORLD Plain entry must not be selectable');
      naga(code,`plain-${ny}-${sourceAppearance}-${curved}`);count++;
    }
    const code=pickFrag(grid,{backend:'world',view:'plain'}),groups=PICK_LAYOUTS({backend:'world'});
    assert.deepEqual(checkPipeline({code,groups,kind:'compute'}).problems,[]);naga(code,`plain-pick-${ny}-${sourceAppearance}`);count++;
    assert.equal(groups.flat().filter(e=>e.buffer?.type.includes('storage')).length,6);
    assert.doesNotMatch(code,/PICK_FACE_FLOOR|worldPos\(p: vec3f\).*H.origin/);
  }
  console.log(`Naga: ${count} actual WORLD Plain modules; 16 sampled / <=8 storage / four groups`);
});

const facePreamble=`${prelude(g,{state:false,backend:'world'})}${materialsGLSL()}
struct TestFrame {sun:vec3f,sunCol:vec3f,skyUp:vec3f,ground:vec3f,caveAmbient:vec3f,time:f32,shadows:u32}
var<private> FU:TestFrame;
struct Sun {depth:vec4f} var<private> WS:Sun;
var<private> current:vec4f;var<private> C:vec3i;var<private> sideTest:u32;var<private> mask:u32;
fn fetchA(q:vec3i)->vec4f {
 if(all(q==C)){return current;}
 let axis=sideTest>>1u;var d=vec3i(0);d[axis]=select(-1,1,(sideTest&1u)==1u);
 let r=q-C-d;let u=r[(axis+1u)%3u];let v=r[(axis+2u)%3u];
 if(r[axis]==0&&abs(u)<=1&&abs(v)<=1){let bit=u32((u+1)+3*(v+1));if((mask&(1u<<bit))!=0u){return vec4f(f32(E_WALL),20.0,1.0,0.5);}}
 return vec4f(0.0);
}
fn worldSunProject(p:vec3f)->vec3f{return p;}
fn worldSunTap(p:vec2i)->vec4f{return vec4f(1e5,1e5,1e5,0.0);}
fn shadowTexelAtt(s:vec4f,d:f32)->vec3f{return vec3f(1.0);}
fn wk0(o:vec2i,w:vec2f)->f32{return select(1.0-w.x,w.x,o.x==1)*select(1.0-w.y,w.y,o.y==1);}
${worldPlainFaceWGSL}
${blockLookHelpersWGSL({prefix:'box_',input:'PlainFace'})}
fn boxSun(p:vec3f,n:vec3f)->f32{return 1.0;}
${blockLookWGSL({prefix:'box_',input:'PlainFace',sun:'boxSun'})}
`;
test('executed shared face metadata, half heat/life, actual neighbor corner AO and original look over all classes',()=>{
  const cases=[];
  for(const id of [E.WALL,E.METAL,E.WATER,E.GLASS,E.SMOKE,E.STEAM,E.FIRE,E.LAVA,E.LAMP])for(const side of [0,1,2,3,4,5]){
    const ctype=id===E.METAL?packSpark(SPARK_BORN,12):id===E.LAMP?packSpark(0,20):0;
    const i=cases.length;cases.push({id,side,a:[id,i%2?950.3:20.03,i%3?.3333:.9999,ctype+[.001,.499,.999][i%3]],mask:[0,1,511,69,325][i%5],uv:[[0,0],[1,0],[0,1],[1,1],[.3,.7]][i%5]});
  }
  const code=`${facePreamble}
@group(1)@binding(0)var<storage,read> input:array<vec4f>;
@group(1)@binding(1)var<storage,read_write> words:array<vec4u>;
@group(1)@binding(2)var<storage,read_write> output:array<vec4f>;
@compute@workgroup_size(1)fn main(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x;current=input[3u*i];let opt=input[3u*i+1u];let uv=input[3u*i+2u].xy;
 C=vec3i(1536,383,512);sideTest=u32(opt.x);mask=u32(opt.y);
 FU.sun=normalize(vec3f(.3,.8,.4));FU.sunCol=vec3f(1.1,.9,.7);FU.skyUp=vec3f(.2,.3,.4);FU.ground=vec3f(.05,.06,.07);FU.caveAmbient=vec3f(.01);FU.time=1.25;FU.shadows=0u;
 let axis=sideTest>>1u;var p=vec3f(C);p[axis]+=select(0.0,1.0,(sideTest&1u)==1u);p[(axis+1u)%3u]+=uv.x;p[(axis+2u)%3u]+=uv.y;
 let f=plainFace(C,sideTest,p);words[i]=vec4u(f.info,f.heat,0u,0u);
 let w=plain_look(f,false);let b=box_look(f,false);
 output[4u*i]=vec4f(w.e,w.a);output[4u*i+1u]=vec4f(b.e,b.a);output[4u*i+2u]=vec4f(w.tr,plain_faceAO(f.info,uv));output[4u*i+3u]=vec4f(b.tr,0.0);
}`;
  naga(code,'plain-face-executed');
  const input=new Float32Array(cases.flatMap(c=>[...c.a,c.side,c.mask,0,0,...c.uv,0,0])),words=new Uint32Array(cases.length*4),output=new Float32Array(cases.length*16);
  execute(code,cases.length,{1:{0:input,1:words,2:output}});
  const ao=(a,b,c)=>a&&b?0:3-a-b-c;
  cases.forEach((c,i)=>{
    const a=c.a.map(Math.fround),tint=Math.trunc(Math.min(.999,((a[3]%1)+1)%1)*256);
    let glow=isLive(c.id,Math.floor(a[3]))?1:0;if(c.id===E.LAMP&&Math.floor(a[3])/9>=1)glow=2;
    assert.equal(words[4*i]&7,c.side);assert.equal(words[4*i]>>>19&255,tint);assert.equal(words[4*i]>>>27,glow);assert.equal(words[4*i+1],pair(a[1],a[2]));
    const cls=ELEMENTS[c.id].render;const shaded=cls===1||cls===2;
    // Above the true world top y384 all AO samples are air, regardless of fixture mask.
    const occ=(u,v)=>{const axis=c.side>>1,d=c.side&1?1:-1,q=[1536,383,512];q[axis]+=d;q[(axis+1)%3]+=u;q[(axis+2)%3]+=v;if(q[1]>=384)return 0;return(c.mask>>((u+1)+3*(v+1)))&1;};
    const corners=shaded?[ao(occ(-1,0),occ(0,-1),occ(-1,-1)),ao(occ(1,0),occ(0,-1),occ(1,-1)),ao(occ(-1,0),occ(0,1),occ(-1,1)),ao(occ(1,0),occ(0,1),occ(1,1))]:[3,3,3,3];
    const packed=corners.reduce((a,n,j)=>a|(n<<(2*j)),0);assert.equal(words[4*i]>>>11&255,packed,`AO ${c.id}/${c.side}`);
    for(let k=0;k<4;k++)near(output[16*i+k],output[16*i+4+k]);
    for(let k=0;k<3;k++)near(output[16*i+8+k],output[16*i+12+k]);
    const [u,v]=c.uv;near(output[16*i+11],((corners[0]*(1-u)+corners[1]*u)*(1-v)+(corners[2]*(1-u)+corners[3]*u)*v)/3);
  });
});

test('executed original class-interface visibility, four-corner AO truth table, colored optical hook and order-free composition',()=>{
  const production=volumeFrag(g,{backend:'world',view:'plain'});
  const code=`${facePreamble}
@group(1)@binding(0)var<storage,read_write> result:array<vec4f>;
@compute@workgroup_size(1)fn main(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x;
 if(i<36u){result[i]=vec4f(select(0.0,1.0,shows(i/6u,i%6u)),0.0,0.0,0.0);}
 if(i<8u){result[36u+i]=vec4f(f32(cornerAO(i&1u,(i>>1u)&1u,(i>>2u)&1u)),0.0,0.0,0.0);}
 if(i==0u){
  var a=PlainAccum(vec3f(1.0),vec3f(0.0),1.0,false);
  var b=a;
  let water=plain_Look(vec3f(.6,.8,.9),.6,vec3f(.12,.24,.36));
  let glass=plain_Look(vec3f(.9,.7,.95),.22,vec3f(.02,.03,.04));
  plainAdd(&a,water);plainAdd(&a,glass);plainAdd(&a,water);plainAdd(&a,glass);
  plainAdd(&b,glass);plainAdd(&b,water);plainAdd(&b,glass);plainAdd(&b,water);
  result[44]=plainAbsorb(a);
  result[45]=plainAbsorb(b);
  result[46]=plainScatter(a);
  result[47]=plainScatter(b);
 }
}`;
  naga(code,'plain-compose-executed');const out=new Float32Array(48*4);execute(code,36,{1:{0:out}});
  const visible=(me,nb)=>me===1?nb!==1:me===2?[0,3,4,5].includes(nb):me===3?nb!==1&&nb!==3:me===4?nb===0:me===5?nb===0||nb===4:false;
  for(let me=0;me<6;me++)for(let nb=0;nb<6;nb++)assert.equal(out[(me*6+nb)*4],Number(visible(me,nb)));
  for(let i=0;i<8;i++){const a=i&1,b=i>>1&1,c=i>>2&1;assert.equal(out[(36+i)*4],a&&b?0:3-a-b-c);}
  const tr=[.6*.9*.6*.9,.8*.7*.8*.7,.9*.95*.9*.95],scatter=[.28,.54,.8];
  for(let k=0;k<3;k++){near(out[44*4+k],tr[k]);near(out[45*4+k],out[44*4+k]);near(out[46*4+k],scatter[k]);near(out[47*4+k],out[46*4+k]);}
  near(out[44*4+3],1-.4*.78*.4*.78);assert.equal(out[46*4+3],0);
  // Execute the REAL fixed-world optical tap hook with the actual original
  // attenuation decoder and material sigma; no lighting/reference rewrite.
  const hook=`${prelude(g,{state:false,backend:'world'})}${materialsGLSL()}
const SHADOW_TINT_ID_SCALE:f32=256.0;const BK_SHADOW_NORMAL:f32=1.5;const BK_SHADOW_BIAS:f32=.03;
struct F{shadows:u32,sun:vec3f}var<private> FU:F;
struct S{depth:vec4f}var<private> WS:S;
var<private> missed:bool;
fn worldSunProject(p:vec3f)->vec3f{return p;}
fn worldSunTap(p:vec2i)->vec4f{if(p.x==11){missed=true;}return vec4f(100.0,2.0,8.0,f32(E_GLASS)*256.0+1.2);}
${fn(production,'wk0')}
${fn(production,'meanSigma')}
${fn(production,'shadowTexelAtt')}
${fn(production,'plainSun')}
@group(1)@binding(0)var<storage,read_write> out:array<vec4f>;
@compute@workgroup_size(1)fn main(){FU.shadows=1u;FU.sun=vec3f(0.0,1.0,0.0);WS.depth=vec4f(0.0,0.0,.416531224,0.0);let a=plainSun(vec3f(10.7,3.0,10.0),vec3f(0.0,1.0,0.0));out[0]=vec4f(a,select(0.0,1.0,missed));out[1]=vec4f(shadowTexelAtt(worldSunTap(vec2i(10,3)),10.0),0.0);out[2]=vec4f(wk0(vec2i(0),vec2f(.2,.3)),0.0,0.0,0.0);out[3]=vec4f(SIGMA(E_GLASS),meanSigma(E_GLASS));}`;
  naga(hook,'plain-optical-executed');const optical=new Float32Array(16);execute(hook,1,{1:{0:optical}});
  const sigma=ELEMENTS[E.GLASS].sigma,mean=sigma.reduce((a,b)=>a+b,0)/3;
  const qz=10,frac=(qz-2)/(8-2);for(let k=0;k<3;k++)near(optical[k],Math.exp(-sigma[k]/mean*1.2*Math.min(1,frac)),.002);
  assert.equal(optical[3],1,'secondary optical tap misses must remain observable');
  for(let k=0;k<3;k++){near(optical[4+k],optical[k]);near(optical[12+k],sigma[k]);}near(optical[8],.56);near(optical[15],mean);
});

const pickProduction=pickFrag(g,{backend:'world',view:'plain'});
const rawPreamble=`${prelude(g,{state:false,backend:'world'})}${materialsGLSL()}
${ddaGLSL(g,{backend:'world'})}
${presentationNearWGSL({skip:false})}
@group(1)@binding(0)var<storage,read> raw:array<vec4f>;
@group(1)@binding(1)var<storage,read_write> worldRequests:array<atomic<u32>>;
@group(2)@binding(0)var<uniform> testState:vec4i;
var<private> worldIncomplete:bool;
struct Query {feedback:vec4u}var<private> WA:Query;
fn worldBeginQuery(){worldIncomplete=false;}
fn worldQueryIncomplete()->bool{return worldIncomplete;}
fn worldEndQuery(){if(worldQueryIncomplete()){atomicOr(&worldRequests[0],1u);}}
fn fetchA(q:vec3i)->vec4f{
 if(q.x==testState.z){worldIncomplete=true;return vec4f(0.0);}
 if(q.y==testState.x&&q.z==testState.y&&q.x>=0&&q.x<NX){return raw[q.x];}
 return vec4f(0.0);
}
fn fetchB(q:vec3i)->vec4f{return vec4f(0.0,0.0,0.0,3.25);}
`;
test('executed actual Plain picker walks global 4/32/1536 boundaries, height384, signed-zero/tiny axes, curves and sticky unknowns',()=>{
  const code=`${rawPreamble}${PickParams.wgsl}
@group(3)@binding(0)var<uniform> P:PickParams;
@group(3)@binding(6)var<storage,read_write> picks:array<vec4f>;
struct Pick{at:vec4f,what:vec4f}
${worldPlainClassesWGSL}${worldPlainSpanWGSL}
${worldPlainWalkWGSL({prefix:'plainFlat'})}${worldPlainWalkWGSL({curved:true,prefix:'plainCurve'})}
${fn(pickProduction,'plainFlatPick')}${fn(pickProduction,'plainCurvePick')}
@compute@workgroup_size(${PICK_BATCH})${fn(pickProduction,'main')}`;
  naga(code,'plain-pick-executed');const ast=new WgslParser().parse(code);
  const cases=[
    {x:4,ro:[3.99995,383.5,512.5],rd:[1,0,0],expected:4,face:1},
    {x:3,ro:[4.00005,383.5,512.5],rd:[-1,0,0],expected:3,face:0},
    {x:32,ro:[31.99995,383.5,512.5],rd:[1,-0,0],expected:32,face:1},
    {x:31,ro:[32.00005,383.5,512.5],rd:[-1,0,-0],expected:31,face:0},
    ...[3,4,31,32,1536,3071].map(x=>({x,ro:[-.5,383.5,512.5],rd:[1,0,-0],expected:x,face:1})),
    {x:1536,ro:[.5,383.5,512.5],rd:[1,-1e-12,-0],expected:1536,face:1},
    {x:1536,ro:[3072.5,383.5,512.5],rd:[-1,-0,-1e-9],expected:1536,face:0},
    {x:1536,ro:[1536.5,383.5,1024.5],rd:[-1e-12,0,-1],expected:1536,face:4},
    {x:1536,ro:[1536.5,384.5,512.5],rd:[0,-1,0],expected:1536,face:2},
    {x:1536,ro:[3072,383.5,512.5],rd:[0,-1,0],expected:-1},
    {x:1536,ro:[1534.5,383.5,512.5],rd:[1,0,0],curve:-.001,expected:1536,face:1},
    {x:1536,ro:[1534.5,383.5,512.5],rd:[1,0,0],unknown:1535,expected:-2},
    {x:1536,ro:[1534.5,383.5,512.5],rd:[1,0,0],id:E.WATER,skip:true,expected:-1},
    {x:1536,ro:[1534.5,383.5,512.5],rd:[1,0,0],id:E.WATER,expected:1536,face:1},
    {x:1536,ro:[1534.5,383.5,512.5],rd:[1,0,0],id:E.SMOKE,expected:-1},
    {x:1536,ro:[1536.5,383.5,512.5],rd:[1,0,0],id:E.WATER,expected:1536,face:0},
    {x:1536,ro:[1536.5,383.5,512.5],rd:[1,0,0],id:E.WALL,expected:-1},
  ];
  for(const c of cases){
    const raw=new Float32Array(g.nx*4);raw.set([c.id??E.WALL,250.25,.75,.25],c.x*4);
    const flags=new Uint32Array(1),out=new Float32Array(8*PICK_BATCH);
    const packed=PickParams.pack({ro:[[...c.ro,c.curve??0]],rd:[[...c.rd,c.skip?1:0]],warp:[[1534.5,512.5,1,0]],slot:[[0,0,0,0]],n:1});
    new ShaderExec(ast).dispatchWorkgroups('main',1,{0:{0:TB,1:new Int32Array(8)},1:{0:raw,1:flags},2:{0:new Int32Array([383,512,c.unknown??-1,0])},3:{0:new Uint8Array(packed),6:out}});
    if(c.expected<0)assert.equal(out[3],c.expected,JSON.stringify(c));else{
      assert.equal(out[0],c.expected,JSON.stringify(c));assert.equal(out[1],383);assert.equal(out[2],512);assert.equal(out[3],c.face,JSON.stringify(c));assert.deepEqual([...out.subarray(4,8)],[c.id??E.WALL,250.25,3.25,.75]);
    }
    assert.equal(flags[0],c.expected===-2?1:0);
  }
  console.log(`CPU: ${cases.length} production Plain picker rays, including x3071 / y383 and rejected unknown`);
});

test('executed production Plain traces agree with original face passes through covered HDR meshes, opaque cells and unknown AO',()=>{
  for(const curved of [false,true]){
  const production=volumeFrag(g,{backend:'world',view:'plain',curved});
  // (the production module reads its world's size at run time, shaders/common.js WORLD_RUNTIME_GRID: here g's)
  const code=`${rawPreamble}
fn worldMaxSteps()->i32{return MAX_STEPS;}
fn worldGrid()->vec3i{return GRID;}
struct TestFrame {sun:vec3f,sunCol:vec3f,skyUp:vec3f,ground:vec3f,caveAmbient:vec3f,time:f32,shadows:u32}var<private> FU:TestFrame;
struct Sun {depth:vec4f}var<private> WS:Sun;
struct Params {meshCut:u32,marchNear:f32}var<private> P:Params;
var<private> gFragCoord:vec2f;
fn worldSunProject(p:vec3f)->vec3f{return p;}
fn worldSunTap(p:vec2i)->vec4f{return vec4f(1e5,1e5,1e5,0.0);}
fn shadowTexelAtt(s:vec4f,d:f32)->vec3f{return vec3f(1.0);}
${fn(production,'wk0')}
${worldPlainFaceWGSL}${worldPlainSpanWGSL}${worldPlainWalkWGSL({curved})}
struct WorldMesh {color:vec4f,depth:f32,coverageFlags:u32}
@group(1)@binding(3)var worldPackedMesh:texture_2d<u32>;
${fn(production,'worldMeshAt')}
struct VolumeHit {color:vec4f,depth:f32,hit:bool}
fn volumeDepth(p:vec3f)->f32{return p.x/3072.0;}
${fn(production,'traceView')}
@group(1)@binding(2)var<storage,read_write> out:array<vec4f>;
@group(1)@binding(4)var<storage,read> faces:array<vec4i>;
@group(2)@binding(1)var<uniform> config:vec4f;
@compute@workgroup_size(1)fn main(){
 FU.sun=normalize(vec3f(.3,.8,.4));FU.sunCol=vec3f(1.1,.9,.7);FU.skyUp=vec3f(.2,.3,.4);FU.ground=vec3f(.05,.06,.07);FU.caveAmbient=vec3f(.01);FU.time=1.25;FU.shadows=0u;
 P.meshCut=u32(config.x);P.marchNear=config.y;gFragCoord=vec2f(.5);
 warpUse(${curved?'-.0001':'0.0'},vec2f(1534.5,512.5),vec2f(1.0,0.0));
 let ro=vec3f(1534.5,10.5,10.5);let rd=vec3f(1.0,0.0,0.0);
 worldBeginQuery();let h=traceView(ro,rd,0.0,boxHit(ro,rd),1u);
 let opaque=traceView(ro,rd,0.0,boxHit(ro,rd),0u);let scatter=traceView(ro,rd,0.0,boxHit(ro,rd),2u);worldEndQuery();
 out[0]=h.color;out[1]=vec4f(h.depth,select(0.0,1.0,opaque.hit),select(0.0,1.0,worldQueryIncomplete()),select(0.0,1.0,h.hit));
 out[18]=scatter.color;out[19]=opaque.color;out[20]=vec4f(opaque.depth,select(0.0,1.0,scatter.hit),0.0,0.0);
 for(var j=0u;j<8u;j++){
  let f=faces[j];if(f.w==0){continue;}let cell=vec3i(f.x,10,10);let side=u32(f.y);let axis=side>>1u;
  var p=vec3f(cell)+.5;p[axis]=f32(cell[axis])+select(0.0,1.0,(side&1u)==1u);
  let look=plain_look(plainFace(cell,side,p),f.z!=0);
  out[2u+j]=vec4f(look.e,look.a);out[10u+j]=vec4f(look.tr,0.0);
 }
}`;
  naga(code,`plain-trace-executed-${curved}`);const ast=new WgslParser().parse(code);
  const cases=[
    {ids:[E.GLASS],flags:0,meshX:1538.5,faces:[[1536,0,0],[1536,1,1]],coloredBackground:true},
    {ids:[E.WATER,E.GLASS],flags:1,meshX:1538.5,faces:[[1536,0,0],[1536,1,1],[1537,0,0],[1537,1,1]]},
    {ids:[E.WATER,E.GLASS],flags:0,meshX:1538.5,faces:[[1536,0,0],[1536,1,1],[1537,0,0],[1537,1,1]]},
    {start:1535,ids:[E.WATER,E.WATER,E.GLASS],flags:1,meshX:1538.5,faces:[[1535,0,0],[1536,1,1],[1537,0,0],[1537,1,1]]},
    {ids:[E.WATER,E.GLASS,E.WALL],flags:1,meshX:1540.5,faces:[[1536,0,0],[1536,1,1],[1537,0,0]],opaque:[1538,0,0]},
    {ids:[E.WATER,E.GLASS,E.WALL],flags:0,meshX:1540.5,faces:[[1536,0,0],[1536,1,1],[1537,0,0]],opaque:[1538,0,0]},
    {ids:[E.WATER,E.GLASS],flags:1,meshX:1535.5,faces:[],noHit:true},
    {ids:[E.WATER,E.GLASS],flags:1,meshX:1538.5,faces:[[1536,0,0],[1536,1,1],[1537,0,0],[1537,1,1]],unknown:1535},
  ];
  for(const c of cases){
    const raw=new Float32Array(g.nx*4);c.ids.forEach((id,k)=>raw.set([id,20,.75,.25],((c.start??1536)+k)*4));
    const listed=[...c.faces,...(c.opaque?[c.opaque]:[])],faces=new Int32Array(32);listed.forEach((f,i)=>faces.set([...f,1],i*4));
    const words=new Uint32Array([pair(2,1),pair(.5,1),0,c.flags]);new Float32Array(words.buffer)[2]=c.meshX/3072;
    const out=new Float32Array(21*4),feedback=new Uint32Array(1);
    new ShaderExec(ast).dispatchWorkgroups('main',1,{0:{0:TB,1:new Int32Array(8)},1:{0:raw,1:feedback,2:out,3:{texture:[words.buffer],descriptor:{size:[1,1,1],format:'rgba32uint'}},4:faces},2:{0:new Int32Array([10,10,c.unknown??-1,0]),1:new Float32Array([1,0,0,0])}});
    if(c.unknown!==undefined){assert.equal(out[6],1);assert.equal(feedback[0],1);continue;}
    assert.equal(out[6],0);assert.equal(feedback[0],0);
    assert.equal(out[5],c.opaque?1:0,'only raw opaque faces may overwrite opaque HDR/depth/coverage');
    assert.equal(out[7],c.noHit?0:1);assert.equal(out[81],out[7]);
    if(c.noHit)continue;
    const trans=[1,1,1],scatter=[0,0,0];let uncovered=1;
    for(let j=0;j<c.faces.length;j++){for(let k=0;k<3;k++){trans[k]*=out[(10+j)*4+k];scatter[k]+=out[(2+j)*4+k];}uncovered*=1-out[(2+j)*4+3];}
    for(let k=0;k<3;k++){near(out[k],trans[k]);near(out[72+k],scatter[k]);}
    near(out[3],1-uncovered);assert.equal(out[75],0);
    if(c.coloredBackground){
      assert.ok(Math.max(...trans)-Math.min(...trans)>.005,'actual glass must attenuate RGB unequally');
      // A nonuniform HDR destination (or a hypothetical HDR sky) needs three
      // gains. Actual BOX/WORLD CSS sky is deferred by Post, using the original
      // scalar coverage; this test does not move that sky into the HDR target.
      const skies=[[.1,.4,2],[3,.2,.07]];
      const rendered=skies.map(s=>blendTarget(worldPlainPipelines().scatter.fragment.targets[0].blend,out.subarray(72,76),blendTarget(worldPlainPipelines().absorb.fragment.targets[0].blend,out.subarray(0,4),[...s,0])));
      const gains=trans.map((_,k)=>(rendered[1][k]-rendered[0][k])/(skies[1][k]-skies[0][k]));
      gains.forEach((x,k)=>near(x,trans[k]));assert.ok(Math.max(...gains)-Math.min(...gains)>.005);
    }
    if(c.opaque)for(let k=0;k<3;k++)near(out[76+k],out[(2+c.faces.length)*4+k]);
    // Native packed mesh is not re-emitted by opaque; uncovered packed HDR is
    // ignored for stopping. The nonuniform HDR backgrounds below are numerical
    // target probes, not a claim that Post puts the CSS sky in this target.
    for(const sky of [[.1,.4,2],[3,.2,.07]]){
      const base=c.opaque?[...out.subarray(76,80)]:c.flags?[2,1,.5,1]:[...sky,0];
      const phases=worldPlainPipelines();
      const composed=blendTarget(phases.scatter.fragment.targets[0].blend,out.subarray(72,76),blendTarget(phases.absorb.fragment.targets[0].blend,out.subarray(0,4),base));
      for(let k=0;k<3;k++)near(composed[k],base[k]*trans[k]+scatter[k]);
      near(composed[3],c.opaque||c.flags?1:1-uncovered);
    }
    near(out[4],c.opaque?c.opaque[0]/3072:c.flags?c.meshX/3072:1);
  }
  }
});

test('CPU adapter itself preserves private bool members and genuine short-circuit evaluation',()=>{
  const code=`struct V{v:vec3f,f:bool} @group(1)@binding(0)var<storage,read_write>out:array<vec4f>;
var<private> seen:u32;fn sideEffect()->bool{seen++;return true;}
@compute@workgroup_size(1)fn main(){var v=V(vec3f(2.0,3.0,4.0),true);let no=false&&sideEffect();let yes=true||sideEffect();out[0]=vec4f(v.v,select(0.0,1.0,v.f));out[1]=vec4f(f32(seen),select(0.0,1.0,no),select(0.0,1.0,yes),bitcast<f32>(0x3f000000u));}`;
  naga(code,'plain-cpu-adapter-control');const out=new Float32Array(8);execute(code,1,{1:{0:out}});assert.deepEqual([...out],[2,3,4,1,0,0,1,.5]);
});
