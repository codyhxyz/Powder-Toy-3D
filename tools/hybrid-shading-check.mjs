import assert from 'node:assert/strict';
import './hybrid-shading-control-check.mjs';
import { WgslReflect, WgslParser, WgslExec } from 'wgsl_reflect/wgsl_reflect.module.js';
import { execFileSync,spawnSync } from 'node:child_process';
import { gridDims } from '../src/shaders/common.js';
import { drawWGSL } from '../src/shaders/hybrid/geometry.js';
import { hybridMaterialsWGSL,hybridMaterialLayoutEntries,hybridMaterialEntries } from '../src/shaders/hybrid/materials.js';
import { shadowBindingDescriptors } from '../src/shaders/hybrid/shadows.js';
import { createHybridShading } from '../src/gfx/hybrid/shading.js';
import { hybridProbeCoordinates,hybridProbeWeights,hybridEvaluateSH,hybridDirectReference } from '../src/gfx/hybrid/lighting.js';
import { reflectionEnergy,reflectionGate,traceReflectionReference } from '../src/gfx/hybrid/reflections.js';
import { smoothDrawWGSL } from '../src/shaders/hybrid/smooth.js';
import { particleDrawWGSL } from '../src/shaders/hybrid/particles.js';
import { hybridReflectionsWGSL } from '../src/shaders/hybrid/reflections.js';
import { ddaGLSL } from '../src/shaders/gfx/core.js';
const semantic=spawnSync('naga',['--version'],{encoding:'utf8'}).status===0;
const g=gridDims({nx:128,ny:128,nz:128});
const materials={shader:hybridMaterialsWGSL,layoutEntries:hybridMaterialLayoutEntries,
  entries:opts=>hybridMaterialEntries({table:{},albedo:{},normal:{},sampler:{}},opts)};
const shadows={bindingDescriptors:shadowBindingDescriptors,bindings:({binding})=>[{}, {}, {buffer:{}}].map((resource,i)=>({binding:binding+i,resource}))};
const gpu={device:{createSampler:()=>({})}};
const sim={g,derived:{views:{gi:[{},{},{},{}],light:{}}}};
for (const binding of [0,1,4]) for (const reflections of [false,true]) {
  const shader=createHybridShading(gpu,sim,{materials,shadows,controls:{buffer:{}},binding,reflections});
  assert.equal(new Set(shader.layout.map(e=>e.binding)).size,shader.layout.length);
  assert.deepEqual(shader.layout.map(e=>e.binding),shader.entries.map(e=>e.binding));
  const code=drawWGSL(g,{shadingWGSL:shader.wgsl,shade:'hybridOpaqueShade'});
  const sources=[code];
  if (binding===4) sources.push(smoothDrawWGSL(g,{shadingWGSL:shader.wgsl}));
  if (binding===0&&!reflections) sources.push(particleDrawWGSL(g,{shadeWGSL:shader.wgsl,shadeState:true}));
  for (const source of sources) {
    new WgslReflect(source);
    if (semantic) execFileSync('naga',['--stdin-file-path','hybrid-shading.wgsl'],{input:source,encoding:'utf8'});
  }
  assert.match(code,/hybridShadeSpecular/);
  assert.match(code,/m\.f0/,'direct and reflected energy use same material F0');
  assert.equal(code.includes('fn hrReflection'),reflections);
  assert.doesNotMatch(shader.wgsl,/marchVolume|shadeScene|diffuseWalk/,'hit lighting never calls the old renderer');
}
assert.deepEqual(hybridProbeCoordinates([-10,0,999],[32,32,32]),[.5/32,.5/32,31.5/32]);
const weights=hybridProbeWeights([64,64,64],[0,1,0],[32,32,32]);
assert(Math.abs(weights.reduce((s,t)=>s+t.weight,0)-1)<1e-8);
assert(weights.every(t=>t.weight>=0));
assert(hybridEvaluateSH([[1,1,1],[0,0,0],[0,0,0],[0,0,0]],[0,1,0]).every(v=>v>0));
assert(hybridDirectReference({baseColor:[.5,.5,.5],roughness:0,metalness:0,f0:[.04,.04,.04]},[0,1,0],[0,1,0],[0,1,0]).every(Number.isFinite));
assert.equal(reflectionGate({roughness:.8,projectedPixels:100,reflectance:.8,budget:32}),0);
assert.deepEqual(reflectionEnergy({incident:[0,-1,0],normal:[0,1,0],f0:[.5,.5,.5],roughness:.1,
  projectedPixels:100,budget:32,environment:[1,1,1],hit:[2,3,4]}),[1,1.5,2]);
const hit=traceReflectionReference({origin:[.5,1.5,1.5],direction:[1,0,0],grid:[16,8,8],budget:8,
  cellAt:c=>c[0]===3?'opaque':'empty'});
assert.equal(hit.reason,'hit'); assert.equal(hit.t,2.5);
assert.equal(traceReflectionReference({origin:[.5,1.5,1.5],direction:[1,0,0],grid:[16,8,8],budget:1,
  cellAt:()=> 'empty'}).reason,'budget');
{
  const reflection=hybridReflectionsWGSL();
  const trace=reflection.slice(reflection.indexOf('fn hrTrace('),reflection.indexOf('fn hrReflection('));
  assert(!trace.includes('for (') && trace.indexOf('hybridReflectionShade(')>trace.indexOf('if (eid(hit.state) == E_EMPTY)'),
    'full hit lighting must stay after traversal, not inside its loop');
  const cases=[
    {ro:-1,dir:1,budget:8,id:1,hit:3,normal:-1},
    {ro:.5,dir:1,budget:8,id:1,hit:3,normal:-1},
    {ro:10.5,dir:-1,budget:8,id:1,hit:4,normal:1},
    {ro:-1,dir:1,budget:0,id:1},
    {ro:-1,dir:1,budget:2,id:1},
    {ro:-1,dir:1,budget:8,id:2},
    {ro:-1,dir:1,budget:8,id:3},
    {ro:3.5,dir:1,budget:8,id:1},
    {ro:-1,dir:1,budget:8,id:4,nonfinite:true},
  ];
  const code=`
const NX=16;const NY=8;const NZ=8;const E_EMPTY=0;const R_GLASS=3;
struct Header {origin:vec3i}
const H=Header(vec3i(0));
@group(0) @binding(0) var<storage,read> input:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
var<private> caseIndex:u32;
fn SURFCH(id:i32)->i32{return select(-1,0,id==2);}
fn MEDIACH(id:i32)->i32{return -1;}
fn RCLASS(id:i32)->i32{return select(0,3,id==3);}
fn eid(a:vec4f)->i32{return i32(a.x);}
fn fetchA(cell:vec3i)->vec4f{
  return select(vec4f(0),vec4f(input[caseIndex].w,777,0,4.375),cell.x==3);
}
fn skyColor(d:vec3f)->vec3f{return vec3f(.25,.5,.75);}
fn hybridReflectionShade(id:i32,seed:f32,temperature:f32,p:vec3f,n:vec3f,incident:vec3f)->vec3f{
  output[caseIndex*2u+1u]+=vec4f(1,0,0,0);
  if(id==4){return vec3f(1e30);}
  return vec3f(p.x,temperature/1000.0+seed,n.x+2.0);
}
${ddaGLSL({nx:16,ny:8,nz:8})}
${reflection}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid:vec3u){
  caseIndex=gid.x;let v=input[caseIndex];
  output[caseIndex*2u]=vec4f(hrTrace(vec3f(v.x,1.5,1.5),vec3f(v.y,0,0),skyColor(vec3f(0)),u32(v.z)),0);
}`;
  const output=new Float32Array(cases.length*8);
  new WgslExec(new WgslParser().parse(code)).dispatchWorkgroups('main',cases.length,
    {0:{0:new Float32Array(cases.flatMap(c=>[c.ro,c.dir,c.budget,c.id])),1:output}});
  cases.forEach((c,i)=>{
    const expected=c.hit!=null?[c.hit,1.152,c.normal+2]:[.25,.5,.75];
    output.slice(i*8,i*8+3).forEach((v,j)=>assert(Math.abs(v-expected[j])<1e-6,`reflection case ${i}, channel ${j}`));
    assert.equal(output[i*8+4],c.hit!=null||c.nonfinite?1:0,'shade a supported hit exactly once, never a miss');
  });
}
console.log(`PASS shared hybrid shading: all binding offsets, primary/hit/reflection composition, material F0, GI weights and bounded reflection policy; CPU only. Naga semantic validation ${semantic?'passed':'unavailable'}.`);
