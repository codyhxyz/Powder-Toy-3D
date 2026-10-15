import assert from 'node:assert/strict';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
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
console.log(`PASS shared hybrid shading: all binding offsets, primary/hit/reflection composition, material F0, GI weights and bounded reflection policy; CPU only. Naga semantic validation ${semantic?'passed':'unavailable'}.`);
