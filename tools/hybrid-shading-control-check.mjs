import assert from 'node:assert/strict';
import { WgslParser, WgslExec } from 'wgsl_reflect/wgsl_reflect.module.js';
import { createHybridShading } from '../src/gfx/hybrid/shading.js';
import { hybridReflectionsWGSL } from '../src/shaders/hybrid/reflections.js';
import { hybridLightingWGSL } from '../src/shaders/hybrid/lighting.js';
import { ddaGLSL } from '../src/shaders/gfx/core.js';
function extract(source,name) {
  const start=source.indexOf(`fn ${name}(`);
  assert(start>=0,`missing ${name}`);
  let end=source.indexOf('{',start),depth=1;
  while(depth && ++end<source.length) { if(source[end]==='{') depth++; if(source[end]==='}') depth--; }
  assert.equal(depth,0,`unbalanced ${name}`);
  return source.slice(start,end+1);
}
const g={nx:16,ny:8,nz:8};
const generated=createHybridShading({device:{createSampler:()=>({})}},
  {g,derived:{views:{gi:[{},{},{},{}],light:{}}}}, {
    materials:{shader:()=>'',layoutEntries:()=>[],entries:()=>[]},
    shadows:{bindingDescriptors:()=>[],bindings:()=>[]},controls:{buffer:{}}}).wgsl;
const opaque=extract(generated,'hybridOpaqueShade');
assert.equal((opaque.match(/\bhybridShadeSpecular\s*\(/g)||[]).length,1,'one syntactic lighting site in opaque function');
// Literal pre-refactor baseline (51ec8a34); no git dependency in shallow CI checkouts.
const reference=`
fn referenceReflection(p:vec3f,incident:vec3f,normal:vec3f,rough:f32,pixels:f32,f0:vec3f,budget:u32)->vec3f {
  if (!hrFinite3(incident) || dot(incident,incident)<1e-12 || !hrFinite3(normal)
      || dot(normal,normal)<1e-12 || !hrFinite3(p)) {
    return hrColor(skyColor(vec3f(0,1,0)))*clamp(hrColor(f0),vec3f(0),vec3f(1));
  }
  let d=normalize(incident); var n=normalize(normal);
  if(dot(d,n)>0.0){n=-n;}
  let r=normalize(reflect(d,n));
  let base=clamp(hrColor(f0),vec3f(0),vec3f(1));
  let F=base+(vec3f(1)-base)*pow(1.0-clamp(-dot(d,n),0.0,1.0),5.0);
  let env=hrColor(skyColor(r));
  let w=hrGate(rough,pixels,max(F.x,max(F.y,F.z)),budget);
  if(w<=0.0){return hrColor(env*F);}
  let hit=hrTrace(p+n*HR_BIAS,r,env,budget);
  return hrColor(mix(env,hit,w)*F);
}
fn referenceOpaque(id:i32,a:vec4f,p:vec3f,ng:vec3f,footprint:f32)->vec4f {
  let m=hybridMaterialStateLod(id,fract(a.w),p,ng,a.y,i32(floor(a.w)),hybridMaterialFootprintLod(id,footprint));
  var reflected=vec4f(0);
  if(m.roughness<0.3 && HC.reflectionSteps>0u){
    let pixels=1.0/max(footprint*footprint,1e-8);
    reflected=vec4f(referenceReflection(p,p-FU.cam,ng,m.roughness,pixels,m.f0,HC.reflectionSteps),1);
  }
  return hybridShadeSpecular(m,p,ng,m.normal,FU.cam-p,vec3f(hybridSunVisibility(p,ng)),1.0,reflected);
}`;
const header=`
const NX=16; const NY=8; const NZ=8; const E_EMPTY=0; const R_GLASS=3;
struct Header{origin:vec3i} const H=Header(vec3i(0));
struct Frame{cam:vec3f} var<private> FU:Frame;
struct Controls{reflectionSteps:u32} var<private> HC:Controls;
struct HybridMaterial{baseColor:vec3f,roughness:f32,metalness:f32,emission:vec3f,opacity:f32,normal:vec3f,f0:vec3f}
@group(0) @binding(0) var<storage,read> input:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
var<private> materialCount:u32; var<private> shadeCount:u32;
fn eid(a:vec4f)->i32{return i32(a.x);}
fn SURFCH(id:i32)->i32{return select(-1,0,id==2);}
fn MEDIACH(id:i32)->i32{return -1;}
fn RCLASS(id:i32)->i32{return select(0,3,id==3);}
fn fetchA(cell:vec3i)->vec4f{return select(vec4f(0),vec4f(input[1].y,input[1].z,0,input[1].w),cell.x==3);}
fn skyColor(d:vec3f)->vec3f{return vec3f(.25,.5,.75);}
fn hybridMaterialFootprintLod(id:i32,footprint:f32)->f32{return f32(id)*.01+footprint*2.0;}
fn hybridMaterialStateLod(id:i32,seed:f32,p:vec3f,n:vec3f,temp:f32,ctype:i32,lod:f32)->HybridMaterial {
  let at=2u+materialCount*2u; materialCount++;
  output[at]=vec4f(f32(id),seed,temp,f32(ctype)); output[at+1u]=vec4f(p,lod);
  return HybridMaterial(vec3f(f32(id),seed,temp*.001),input[0].z,f32(ctype),vec3f(temp,seed,lod),.6,n*.75+vec3f(.02,.03,.04),input[2].xyz);
}
fn hybridSunVisibility(p:vec3f,n:vec3f)->f32{return .4+p.x*.01+n.x*.02;}
fn hybridShadeSpecular(m:HybridMaterial,p:vec3f,ng:vec3f,n:vec3f,view:vec3f,sun:vec3f,ao:f32,reflected:vec4f)->vec4f {
  let at=6u+shadeCount*8u; shadeCount++;
  output[at]=vec4f(m.baseColor,m.roughness); output[at+1u]=vec4f(m.emission,m.metalness);
  output[at+2u]=vec4f(p,m.opacity); output[at+3u]=vec4f(ng,ao); output[at+4u]=vec4f(n,0);
  output[at+5u]=vec4f(view,0); output[at+6u]=vec4f(sun,0); output[at+7u]=reflected;
  if(m.baseColor.x==4.0){return vec4f(input[3].xyz,m.opacity);}
  let color=m.baseColor+m.emission*.01+vec3f(m.metalness)+p*.1+ng*.03+n*.07+view*.02+sun*.04+vec3f(ao*.05);
  return vec4f((color+mix(vec3f(7,8,9),reflected.rgb,reflected.a))*m.opacity,m.opacity);
}`;
const common=header+ddaGLSL(g)+hybridReflectionsWGSL()
  +['hybridHitRadiance','hybridReflectionShade'].map(n=>extract(generated,n)).join('\n')
  +extract(hybridLightingWGSL(),'hybridShade');
function program(body,entry){return common+body+`
@compute @workgroup_size(1) fn main(){
  let p=vec3f(input[0].x,1.5,1.5);
  FU.cam=p-vec3f(input[0].y,input[2].w,0); HC.reflectionSteps=u32(input[1].x);
  output[0]=${entry}(9,vec4f(9,321,0,6.625),p,vec3f(1,0,0),input[0].w);
  output[1]=vec4f(f32(materialCount),f32(shadeCount),0,0);
}`;}
const actual=new WgslExec(new WgslParser().parse(program(opaque,'hybridOpaqueShade')));
const baseline=new WgslExec(new WgslParser().parse(program(reference,'referenceOpaque')));
const cases=[
  {name:'hit'}, {name:'negative reflection',x:6,dir:1}, {name:'miss',id:0,sky:true},
  {name:'budget zero',budget:0,off:true}, {name:'roughness boundary',rough:.3,off:true},
  {name:'roughness above',rough:.6,off:true}, {name:'roughness blend',rough:.2},
  {name:'area four',pixels:4,sky:true}, {name:'area partial',pixels:9}, {name:'area full',pixels:16},
  {name:'low F0',f0:[.01,.015,.02],sky:true}, {name:'partial F0',f0:[.03,.04,.05]},
  {name:'smooth unsupported',id:2,sky:true}, {name:'glass unsupported',id:3,sky:true},
  {name:'current cell',x:3.5,sky:true}, {name:'exhausted budget',budget:1,sky:true},
  {name:'live state changed',temp:1234,packed:8.875}, {name:'oblique Fresnel',slope:.3},
  {name:'NaN entire-vector fallback',id:4,bad:[NaN,23,31],sky:true,hit:true},
  {name:'infinite entire-vector fallback',id:4,bad:[2,Infinity,31],sky:true,hit:true},
];
function close(a,b,label){assert.equal(a.length,b.length);a.forEach((v,i)=>assert(Math.abs(v-b[i])<=2e-5,`${label}[${i}]: ${v} != ${b[i]}`));}
for(const c of cases){
  const v={x:1,dir:-1,rough:.1,pixels:100,budget:8,id:1,temp:777,packed:4.375,f0:[.2,.3,.4],slope:0,...c};
  const footprint=1/Math.sqrt(v.pixels);
  const input=new Float32Array([v.x,v.dir,v.rough,footprint,v.budget,v.id,v.temp,v.packed,...v.f0,v.slope,...(v.bad||[0,0,0]),0]);
  const run=exec=>{const out=new Float32Array(88);exec.dispatchWorkgroups('main',1,{0:{0:input,1:out}});return out;};
  const out=run(actual);close(out,run(baseline),c.name);
  const hit=c.hit||(!c.sky&&!c.off); const primary=6+(hit?8:0);
  close(out.slice(4,6),[hit?2:1,hit?2:1],`${c.name} counts`);
  close(out.slice(8,12),[9,.625,321,6],`${c.name} primary material`);
  close(out.slice(12,16),[v.x,1.5,1.5,.09+footprint*2],`${c.name} primary LOD`);
  close(out.slice(primary*4,primary*4+3),[9,.625,.321],`${c.name} primary last`);
  assert(Math.abs(out[(primary+2)*4+3]-.6)<2e-5);
  if(hit){
    close(out.slice(16,20),[v.id,v.packed%1,v.temp,Math.floor(v.packed)],`${c.name} live hit material`);
    assert.equal(out[23],0,'hit material LOD zero'); assert.equal(out[35],1,'hit opaque');
    const normal=v.dir<0?-1:1;
    close(out.slice(36,40),[normal,0,0,1],`${c.name} hit normal/AO`);
    close(out.slice(52,56),[0,0,0,0],`${c.name} hit reflection disabled`);
    if(!v.slope) close(out.slice(44,47),[v.dir,0,0],`${c.name} opposite incident view`);
  }
  const reflected=out.slice((primary+7)*4,(primary+8)*4);
  if(c.off) close(reflected,[0,0,0,0],`${c.name} SH fallback`);
  if(c.sky) close(reflected,[.25*v.f0[0],.5*v.f0[1],.75*v.f0[2],1],`${c.name} sky not SH / whole-vector fallback`);
}
console.log(`PASS hybrid shading control: ${cases.length} actual-WGSL old/new comparisons, call order/arguments and single lighting site; CPU only.`);
