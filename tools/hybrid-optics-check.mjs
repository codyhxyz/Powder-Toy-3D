// CPU only: numerical oracles, generated WGSL reflection, resource contracts.
// Includes Naga semantic compilation, not GPU execution or visual validation.
import assert from 'node:assert/strict';
import { rewriteOpticsDiagnostic } from './harness/hybrid-optics-diagnostic.js';
import { WgslReflect, WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { gridDims } from '../src/shaders/common.js';
import { opticsShader, opticsBindings, opticsFieldBindings, OPTICS_STATE_LAYOUT, dropDepthWGSL, opticsProbeWGSL, opticsRefractionWGSL } from '../src/shaders/hybrid/optics.js';
import { interfaceEnergy, opticalTransmission, walkOpticalCells, traceOpticalReference,
  opticalFieldDensity, opticalFieldSegment, opticalProbe, validateOpticsLimits, validateOpticsResources,
  createHybridOptics } from '../src/gfx/hybrid/optics.js';
const close = (a, b, tol = 1e-8) => assert(Math.abs(a - b) < tol, `${a} != ${b}`);
const white = a => a.forEach(v => close(v, 1));
{
  const critical=0.3950336277484894,eta=1.0885341167449951;
  const rows=[[eta,1,critical,0]],iors=[1,eta,1.33,1.47,1.5];
  for(const from of iors)for(const to of iors){
    for(const cosine of [0,.1,critical,.5,.9,1])rows.push([from,to,cosine,0]);
    if(from>to){
      const bits=new Uint32Array(new Float32Array([Math.sqrt(1-(to/from)**2)]).buffer)[0];
      for(let ulp=-2;ulp<=2;ulp++)rows.push([from,to,new Float32Array(new Uint32Array([bits+ulp]).buffer)[0],0]);
    }
  }
  const input=new Float32Array(rows.flat()),output=new Float32Array(rows.length*8);
  const code=`${opticsRefractionWGSL}
@group(0) @binding(0) var<storage,read> input:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid:vec3u){
  let a=input[gid.x];let n=vec3f(0,1,0);
  let d=vec3f(sqrt(max(0.0,1.0-a.z*a.z)),-a.z,0);
  let r=opticsRefraction(d,n,a.x,a.y);
  output[gid.x*2u]=vec4f(r.direction,r.reflected);
  let eta=a.x/a.y;var oldF=1.0;
  if(eta*eta*(1.0-a.z*a.z)<1.0){oldF=0.5;}
  output[gid.x*2u+1u]=vec4f(normalize(refract(d,n,eta)),oldF);
}`;
  new WgslExec(new WgslParser().parse(code)).dispatchWorkgroups('main',rows.length,{0:{0:input,1:output}});
  assert.equal(output[7],.5,'old TIR check selects transmission at the counterexample');
  assert([...output.slice(4,7)].some(Number.isNaN),'old builtin refract disagrees and normalizes zero');
  for(let i=0;i<rows.length;i++){
    const r=output.slice(i*8,i*8+4);
    assert(r.every(Number.isFinite),'critical-angle transport must stay finite');
    assert(r[3]>=0&&r[3]<=1);
    if(r[3]<1){close(Math.hypot(...r.slice(0,3)),1,2e-6);assert(r[1]<=1e-6);}
  }
  console.log(`PASS ${rows.length} executed WGSL refractions: critical-angle ULPs, finite transmission/TIR, old NaN reproduced.`);
}
const water = { id: 1, ior: 1.33, sigma: [0, 0, 0] };
const oil = { id: 2, ior: 1.47, sigma: [0, 0, 0] };
const glass = { id: 3, ior: 1.5, sigma: [0, 0, 0] };
for (const from of [1, 1.33, 1.47, 1.5]) for (const to of [1, 1.33, 1.47, 1.5]) {
  for (const cosine of [0, 0.1, 0.5, 1]) { const e = interfaceEnergy(cosine, from, to); close(e.reflected + e.transmitted, 1); }
}
assert.equal(interfaceEnergy(0.1, 1.5, 1).reflected, 1);
assert.deepEqual(opticalTransmission([0, 1, 2], 2), [1, Math.exp(-2), Math.exp(-4)]);
let cells = [];
const dda = walkOpticalCells([-1, 0.5, 0.5], [1, 0, 0], [12, 1, 1], { visit: (c, a, b) => { cells.push(c[0]); close(b-a, 1); } });
assert.deepEqual(cells, Array.from({ length: 12 }, (_, i) => i)); assert(!dda.exhausted);
assert(walkOpticalCells([-1, 0.5, 0.5], [1, 0, 0], [12, 1, 1], { maxSteps: 2 }).exhausted);
cells = [];
walkOpticalCells([0, 0, 0], [1, 1, 1], [3, 3, 3], { visit: c => { cells.push(c); } });
assert.deepEqual(cells, [[0,0,0], [1,1,1], [2,2,2]]);
{
  // Execute the production probe in Float32, not just a double-precision oracle.
  const rays = [];
  for (const face of [64, 128, 384, 1024, 2048]) for (const sign of [-1, 1]) {
    for (let axis = 0; axis < 3; axis++) {
      const p = [10.25, 10.25, 10.25], d = [0, 0, 0];
      p[axis] = face - sign * 0.001;
      d[axis] = sign * 0.01; d[(axis + 1) % 3] = Math.sqrt(0.9999);
      rays.push([p, d]);
      rays.push([p.map((v, i) => i === axis ? face : v), d]);
    }
  }
  const input = new Float32Array(rays.flatMap(([p, d]) => [...p, 0, ...d, 0]));
  const march = probe => {
    const code = `const OPTICS_EPS: f32 = 0.0001;
${probe}
@group(0) @binding(0) var<storage,read> rays: array<vec4f>;
@group(0) @binding(1) var<storage,read_write> result: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x; var p = rays[2u*i].xyz; let rd = rays[2u*i+1u].xyz;
  result[i*6u] = vec4f(opticsProbe(p,rd),0);
  for (var step=0u;step<4u;step++) {
    let cell = floor(opticsProbe(p,rd)); var exits = vec3f(1e20);
    for (var axis=0;axis<3;axis++) {
      if (abs(rd[axis])>1e-8) {
        let face = cell[axis]+select(0.0,1.0,rd[axis]>0.0);
        exits[axis] = max(0.0,(face-p[axis])/rd[axis]);
      }
    }
    let segment = min(exits.x,min(exits.y,exits.z));
    result[i*6u+step+1u] = vec4f(cell,segment);
    p += rd*segment;
  }
  result[i*6u+5u] = vec4f(p,0);
}`;
    const result = new Float32Array(rays.length * 24);
    new WgslExec(new WgslParser().parse(code)).dispatchWorkgroups('main', rays.length, {0:{0:input,1:result}});
    return result;
  };
  const old = march('fn opticsProbe(p:vec3f,rd:vec3f)->vec3f{return p+rd*OPTICS_EPS;}');
  assert.equal(old[11], 0, 'old Float32 tracer stalls at x=64 on its second segment');
  const result = march(opticsProbeWGSL);
  for (let i = 0; i < rays.length; i++) {
    const [p, d] = rays[i];
    assert.deepEqual([...result.slice(i*24,i*24+3)], opticalProbe(p,d));
    for (let step = 0; step < 4; step++) {
      const length = result[i*24+(step+1)*4+3];
      assert(length > 0 && Number.isFinite(length), `ray ${i}, segment ${step} must advance`);
    }
  }
  for (const p of [[0,0,0],[-64,-128,-384],[0.5,64.5,384.5]]) {
    for (const d of [[0,0,0],[0.01,-0.01,0],[1e-6,0,-1e-6]]) {
      const q = opticalProbe(p,d);
      q.forEach((v,i) => assert(d[i] === 0 ? v === p[i] : (v-p[i])*d[i] > 0));
    }
  }
}
const run = (extra = {}, origin = [-1, 0.5, 0.5], direction = [1, 0, 0]) => traceOpticalReference(origin, direction, [8, 1, 1], {
  sample: ([x]) => x === 1 ? water : x === 2 ? oil : x === 3 ? glass : null, ...extra,
});
let r = run(); assert.equal(r.termination, 'escape'); assert.equal(r.interfaces, 4); close(r.thickness, 3); white(r.color);
r = run({}, [1.25, 0.5, 0.5]); assert.equal(r.interfaces, 3); close(r.thickness, 2.75); white(r.color);
r = run({ sample: () => water }); assert.equal(r.interfaces, 2); close(r.thickness, 8); white(r.color);
r = run({ sample: () => water }, [1.25, 0.5, 0.5]); assert.equal(r.interfaces, 1); close(r.thickness, 6.75); white(r.color);
for (const budget of [{ maxSteps: 1 }, { maxInterfaces: 1 }]) { r = run(budget); assert.equal(r.termination, 'budget'); white(r.color); }
// The optical budget must not hide distant cells before the first interface.
r = traceOpticalReference([-1,0.5,0.5], [1,0,0], [384,1,1], {
  sample: ([x]) => x === 380 ? water : null, maxSteps: 4,
});
assert(r.interfaces >= 1); assert(r.segments.some(s => s.id === water.id));
white(r.color);
// Beer-Lambert, both submerged and exiting; no interface reflection for IOR=1.
r = run({ sample: () => ({ ...water, ior: 1, sigma: [0.1,0.2,0.3] }) }, [0,0.5,0.5]);
r.color.forEach((v, i) => close(v, Math.exp(-(i+1)*0.1*8)));
let hidden = 0;
r = run({ sample: ([x]) => x === 1 ? water : x === 3 ? { id: 8, opaque: true } : null,
  worldHit: () => { hidden++; return [0.2,0.3,0.4]; } });
assert.equal(hidden, 1); assert.equal(r.termination, 'opaque'); assert(r.color.every(v => v > 0 && v < 1));
const media = [];
run({ mediaSegment: (p, d, length) => { media.push({ p: [...p], length }); return [0,0,0,0]; } });
assert(media.length > 0); assert(media.every(({p}) => p[0] >= 4), 'pre-entry segment belongs to screen media');
// TIR follows reflected direction; opaque hit callback is still available.
r = traceOpticalReference([1.5,0.8,0.5], [1,0.2,0], [8,1,1], { sample: () => glass, maxInterfaces: 1 });
assert.equal(r.termination, 'budget'); assert.equal(r.interfaces, 1); white(r.color);
assert(r.segments.some(s => s.direction[1] < 0), 'TIR must reflect into the medium');
// Field is affine within each tetra, and roots are not cell-boundary geometry.
const field = ([x]) => x === 0 ? 0.2 : x === 1 ? 1 : 0;
close(opticalFieldDensity([0.75,0.75,0.75], field), 0.4);
const root = opticalFieldSegment([0.5,0.75,0.75], [1,0,0], 0.5, field);
// First event is a tetra diagonal; next event is the iso crossing at x=.875.
close(root, 0.25);
const iso = opticalFieldSegment([0.75,0.75,0.75], [1,0,0], 0.25, field);
close(iso, 0.125); close(opticalFieldDensity([0.75+iso,0.75,0.75], field), 0.5);
for (let n = 0; n < 100; n++) {
  const p = [0.51 + n * 0.003, 0.65, 0.82], d = [0.6,0.2,-0.1];
  const len = opticalFieldSegment(p, d, 0.18, field);
  assert(len > 0 && len <= 0.18);
  const a = opticalFieldDensity(p, field), b = opticalFieldDensity(p.map((v,i) => v+d[i]*len), field);
  const mid = opticalFieldDensity(p.map((v,i) => v+d[i]*len*0.5), field); close(mid, (a+b)*0.5);
}
const g = gridDims({ nx: 32, ny: 32, nz: 32 });
for (const fieldBinding of [null, 2, 14]) {
  const code = opticsShader(g, { fieldBinding });
  const reflection = new WgslReflect(code);
  assert.equal(reflection.textures.length, fieldBinding === null ? 2 : 4);
  assert.equal(reflection.storage.length, 3); assert.equal(reflection.uniforms.length, 3);
  const layout = [...opticsBindings(), ...(fieldBinding === null ? [] : opticsFieldBindings(fieldBinding))];
  for (const t of reflection.textures) { const e = layout.find(e => e.binding === t.binding); assert(e); assert.equal(t.group, 2); }
  assert.equal(OPTICS_STATE_LAYOUT.filter(e => e.buffer?.type === 'read-only-storage').length, 2);
  assert.doesNotMatch(code, /out\.fallback\s*[|]?=\s*(1|2|4|32|64|256)u/, 'ordinary transport cannot require legacy');
  assert.match(code, /sum \+= transmission \* opticsWorldHit\(h\)/);
  assert.match(code, /sum \+= transmission \* opticsEnvironment\(p, rd, 1\.0\)/);
  assert.match(code, /floor\(a\.w\)/); assert.match(code, /incandescence\(a\.y\)/);
  assert.match(code, /let probe = opticsProbe\(p, rd\);\s*let cell = vec3i\(floor\(probe\)\)/);
  if (fieldBinding !== null) {
    assert.match(code, /segment = opticsFieldSegment/); assert.match(code, /textureLoad\(opticsThin/);
    assert.match(code,/if \(all\(density < vec4f\(0\.5\)\)\) \{ return source; \}/);
    assert(code.indexOf('all(density < vec4f(0.5))')<code.indexOf('for (var z = -2'),'empty support must return before source queries');
  }
}
validateOpticsLimits({}, opticsFieldBindings());
assert.throws(() => validateOpticsLimits({maxSampledTexturesPerShaderStage:32}, Array.from({length:15}, (_,i) => ({binding:i+2, texture:{}}))), /maxSampledTextures/);
assert.throws(() => validateOpticsLimits({}, Array.from({length: 15}, (_,i) => ({binding:i+2, texture:{}}))), /maxSampledTextures/);
assert.throws(() => validateOpticsLimits({}, Array.from({length: 6}, (_,i) => ({binding:i+2, buffer:{type:'read-only-storage'}}))), /maxStorageBuffers/);
assert.throws(() => validateOpticsLimits({}, [{binding:2, buffer:{type:'storage'}}]), /read-only/);
assert.throws(() => createHybridOptics({}, {}), /worldHit/);
const texture = format => ({format, width:16, height:16, usage:20, createView(){ return {}; }});
const color = texture('rgba16float'), depth = texture('depth32float');
const output = {color:texture('rgba16float'), metadata:texture('rgba32float'), fallback:texture('r32uint')};
validateOpticsResources({color, depth}, output);
assert.throws(() => validateOpticsResources({color, depth}, {...output,color}), /alias/);
assert.throws(() => validateOpticsResources({color, depth}, {...output,metadata:texture('rgba16float')}), /metadata/);
console.log('hybrid optics CPU: energy, submerged/mixed/TIR/Beer paths, bounded tails, opaque/media hooks, tetra roots, WGSL/layout reflection and resource limits passed (no GPU validation)');

// Complete ownership, including ordinary liquids absent from the old six-ID list.
const { ELEMENTS, R } = await import('../src/elements.js');
const { LOOK, CHANNELS } = await import('../src/gfx/materials.js');
const { opticsClass, OPTICS_IDS, opticalBounds, opticalBoundsInterval,
  opticalFieldNormal, opticalFieldSource, opticalParticleInterval } = await import('../src/gfx/hybrid/optics.js');
const { opticsBoundsShader, opticsBoundsLayout, OpticsParams } = await import('../src/shaders/hybrid/optics.js');
for (const e of ELEMENTS) {
  const channel = CHANNELS[LOOK[e.id].ch]?.key;
  const expected = channel === 'MOLTEN' ? 2 : channel === 'LIQUID' || e.render === R.GLASS ? 1 : 0;
  assert.equal(opticsClass(e.id), expected, e.key);
  assert.equal(OPTICS_IDS.includes(e.key), expected !== 0, e.key);
}
assert(OPTICS_IDS.includes('BLOOD')); assert(OPTICS_IDS.length > 6);
const id = key => ELEMENTS.find(e => e.key === key).id;
const bounds = opticalBounds([{cell:[10,5,6], id:id('BLOOD')}, {cell:[30,0,31], id:id('LAVA')}, {cell:[0,0,0], id:id('SAND')}], [32,32,32]);
assert.deepEqual(bounds, {count:2,lo:[8,0,4],hi:[32,8,32]});
assert.equal(opticalBoundsInterval([0,0,0],[1,0,0],bounds), null);
assert.equal(opticalBoundsInterval([0,5,6],[1,0,0],bounds,7), null);
assert.deepEqual(opticalBoundsInterval([0,5,6],[1,0,0],bounds), [8,32]);
assert.equal(opticalBoundsInterval([0,5,6],[1,0,0],opticalBounds([], [32,32,32])), null);
// Every channel uses the identical tetra interval and gradient, including hidden
// granular/organic and molten. A root is not rounded to a cell-box face.
for (let ch=0; ch<4; ch++) {
  const channels = q => [0,0,0,0].map((v,i) => i===ch ? field(q) : v);
  const fetch = q => channels(q)[ch];
  close(opticalFieldSegment([0.75,0.75,0.75],[1,0,0],0.25,fetch),0.125);
  assert.deepEqual(opticalFieldNormal([0.8,0.7,0.6],fetch),[-1,0,0]);
}
const sand = {id:id('SAND'), state:[id('SAND'),180,0,0.37]};
const sourceAt = q => q.join() === '1,1,1' ? sand : null;
assert.equal(opticalFieldSource([1.2,1.3,1.4],[0,0,1,0],sourceAt),sand);
assert.equal(opticalFieldSource([1.2,1.3,1.4],[0,0,1,0],sourceAt,() => true),null);
assert.equal(opticalFieldSource([1.2,1.3,1.4],[0,0,1,0],() => null),null);
assert.equal(opticalFieldSource([1.2,1.3,1.4],[0,0,0.49,0],sourceAt),null);
let sourceReads=0;
const countedSource=q=>{sourceReads++;return sourceAt(q);};
for(let ch=0;ch<4;ch++){
  const density=[0,0,0,0];density[ch]=0.499999;
  assert.equal(opticalFieldSource([1.2,1.3,1.4],density,countedSource),null);
}
assert.equal(sourceReads,0,'sub-iso support cannot select a source in any channel');
assert.equal(opticalFieldSource([1.2,1.3,1.4],[0,0,0.5,0],countedSource),sand,'exact iso boundary must still select live matter');
assert(sourceReads>0);
sourceReads=0;
assert.equal(opticalFieldSource([1.2,1.3,1.4],[0,0,1,0],countedSource),sand);
assert.equal(sourceReads,1,'eligible cell interior has a unique nearest source');
const neighbor={...sand,state:[sand.id,900,0,.2]};
const tied=q=>q.join()==='0,1,1'?neighbor:sourceAt(q);
assert.equal(opticalFieldSource([1,1.3,1.4],[0,0,1,0],tied),neighbor,'cell-face tie order must not change');
const sourceIds=['WATER','LAVA','SAND','WOOD'].map(id);
const sources=new Map();
for(let z=0;z<7;z++)for(let y=0;y<7;y++)for(let x=0;x<7;x++){
  const n=(x*7+y*13+z*17)%5;
  if(n<4)sources.set([x,y,z].join(),{id:sourceIds[n]});
}
const sample=q=>sources.get(q.join())??null;
const excluded=q=>(q[0]*3+q[1]*5+q[2])%17===0;
const bruteSource=(p,density,exclude=excluded,fetch=sample)=>{
  const base=p.map(Math.floor);let best=Infinity,chosen=null;
  for(let z=-2;z<=2;z++)for(let y=-2;y<=2;y++)for(let x=-2;x<=2;x++){
    const q=base.map((v,i)=>v+[x,y,z][i]),a=fetch(q),ch=LOOK[a?.id]?.ch;
    const d=q.reduce((s,v,i)=>s+(v+.5-p[i])**2,0);
    if(ch>=0&&ch<4&&density[ch]>=.5&&d<best&&!exclude(q)){best=d;chosen=a;}
  }
  return chosen;
};
let fastCases=0;
const checkedPositions=new Set();
for(let n=0;n<500;n++){
  const p=[0,1,2].map(i=>Math.fround(1+(n*(i+1))%5+((n*(i*14+3))%251)/251));
  checkedPositions.add(p.join());
  const density=[0,1,2,3].map(i=>[0,.49,.5,.9][(n+i)%4]);
  let reads=0;
  assert.equal(opticalFieldSource(p,density,q=>{reads++;return sample(q);},excluded),bruteSource(p,density),'fast source selection must match the complete search');
  if(reads===1)fastCases++;
}
assert(fastCases>25,'differential cases must exercise the interior shortcut, not only its fallback');
assert.equal(checkedPositions.size,500);
for(const base of [3,128,384,2047])for(let axis=0;axis<3;axis++)for(const f of [0,1e-7,5e-7,1e-6,2e-6,.999998,.999999]){
  const p=[base+.5,base+.5,base+.5];p[axis]=Math.fround(base+f);
  const shifted=q=>sample(q.map(v=>v-base+3));
  assert.equal(opticalFieldSource(p,[1,1,1,1],shifted),bruteSource(p,[1,1,1,1],()=>false,shifted),'Float32 margin/face selection must match the original search');
}
{
  const p=[3.2,3.3,3.4],own=p.map(Math.floor),exclude=q=>q.every((v,i)=>v===own[i]);
  const result=opticalFieldSource(p,[1,1,1,1],sample,exclude);
  assert.notEqual(result,sample(own),'an excluded current source cannot take the shortcut');
  assert.equal(result,bruteSource(p,[1,1,1,1],exclude));
}
assert.deepEqual(opticalParticleInterval([-1,0.5,0.5],[1,0,0],[0,0,0]),[1,2]);
assert.equal(opticalParticleInterval([-1,0.01,0.01],[1,0,0],[0,0,0]),null, 'voxel corner is not sphere');
const sphereHit = opticalParticleInterval([-1,0.8,0.5],[1,0,0],[0,0,0]);
close(sphereHit[0],1.1); close(sphereHit[1],1.9);
// Sphere entry normal (-.8,.6,0), not the cell's (-1,0,0).
close((-1+sphereHit[0]-0.5)/0.5,-0.8);
close((0.8-0.5)/0.5,0.6);
const grid = gridDims({nx:32,ny:32,nz:32});
const boundedCode = opticsShader(grid,{fieldBinding:2,boundsBinding:4});
const boundedReflection = new WgslReflect(boundedCode);
assert.equal(boundedReflection.storage.length,4); assert.equal(boundedReflection.textures.length,4);
assert.match(boundedCode,/if \(!forced && !opticsFallbackMode\(\) && opticalBounds.count == 0u\) \{ return out; \}/);
assert(boundedCode.indexOf('if (interval.x >= cut)') < boundedCode.indexOf('previous = opticsFieldState'));
assert.match(boundedCode,/optical == 0 && bent/);
assert.doesNotMatch(boundedCode,/if \(!covered\) \{ return out; \}/);
assert.match(boundedCode,/SURFCH\(id\) == CH_LIQUID \|\| RCLASS\(id\) == R_GLASS/);
assert.equal((boundedCode.match(/const CH_LIQUID:/g) ?? []).length,1);
const boundsCode = opticsBoundsShader(grid), boundsReflect = new WgslReflect(boundsCode);
assert.equal(boundsReflect.entry.compute.length,2);
assert.doesNotMatch(boundsCode,/atomic/);
assert.equal(boundsReflect.storage.length,5); // tables, A/B, two bounds buffers
assert(opticsBoundsLayout.every(e => e.visibility === 4 && e.buffer.type === 'storage'));
// Budget with parent-style material/light/media additions: 16 sampled, 8 storage.
const extras = [...opticsFieldBindings(),{binding:4,buffer:{type:'read-only-storage'}},
  ...Array.from({length:12},(_,i) => ({binding:5+i,texture:{}})),
  ...Array.from({length:4},(_,i) => ({binding:17+i,buffer:{type:'read-only-storage'}}))];
validateOpticsLimits({},extras);
assert.throws(() => validateOpticsLimits({},[...extras,{binding:21,texture:{}}]),/maxSampled/);
assert.throws(() => validateOpticsLimits({},[...extras,{binding:21,buffer:{type:'read-only-storage'}}]),/maxStorage/);

// Fake recording proves dependency order, cache identity, initialization and
// ownership without creating a device, launching a browser, or reading counts.
const { Matrix4 } = await import('three/webgpu');
const calls = [], buffers = [], textures = [], pipelines = [];
const fakeTexture = d => {
  const t = {width:d.size[0],height:d.size[1],format:d.format,usage:d.usage,destroyed:0,
    createView(){ assert.equal(this.destroyed,0); return {texture:this}; },destroy(){ this.destroyed++; }};
  textures.push(t); return t;
};
const gpu = {
  _frameUniforms:{layout:{},group:{},last:{written:true,viewProj:new Matrix4(),model:new Matrix4()}},
  layout:(name,entries) => ({name,entries}),
  bindGroup(layout,entries){ assert.deepEqual(entries.map(e=>e.binding).sort(),layout.entries.map(e=>e.binding).sort()); return {layout,entries}; },
  createBuffer(d){ assert.equal(d.usage,128); const b={...d,destroyed:0,destroy(){this.destroyed++;}}; buffers.push(b); return b; },
  createTexture:fakeTexture,
  kernel(d){ const k={state:'ready',ready:Promise.resolve(),dispatch(frame,size,args){ calls.push({name:d.name,frame,size,args}); }}; pipelines.push(k); return k; },
  renderPipeline(d){ const p={state:'ready',ready:Promise.resolve(),draw(pass,args){
    assert(!pass.ended); if (args.params) OpticsParams.pack(args.params,new DataView(new ArrayBuffer(OpticsParams.size)),0);
    calls.push({name:'draw',args,pipeline:d});
  }}; pipelines.push(p); return p; },
  frame:{render(desc){ calls.push({name:'render',desc}); return {ended:false,end(){this.ended=true;}}; }},
};
const sim = {g:grid,L:{TABLES:{},STATE_RO:{}},tables:{},bindRO:{},header:()=>({}),version:1,cur:0,origin:{x:0,y:0,z:0},
  derived:{world:true,fieldSurf:{},fieldThin:{},views:{fieldSurf:{},fieldThin:{}}}};
const optics = createHybridOptics(gpu,sim,{lighting:{hooks:{worldHit:'fn opticsWorldHit(h: OpticalHit) -> vec3f { return vec3f(1); }'}}});
const frame = {color:fakeTexture({size:[16,16],format:'rgba16float',usage:4}),depth:fakeTexture({size:[16,16],format:'depth32float',usage:4})};
pipelines[1].state='pending'; assert.equal(optics.isReady,false); assert.equal(optics.update(frame),false); assert.equal(optics.record(frame),false); assert.equal(calls.length,0);
pipelines[1].state='ready'; await optics.ready;
assert(optics.record(frame)); // record initializes even without a successful update
assert.deepEqual(calls.map(c=>c.name),['hybrid.optics.bounds','hybrid.optics.bounds.finish','render','draw']);
assert.equal(calls[0].frame,gpu.frame); assert.equal(calls[1].frame,gpu.frame);
assert.deepEqual(calls[0].size,[grid.nbricks,1,1]); assert.equal(buffers[0].size,grid.nbricks*32); assert.equal(buffers[1].size,32);
assert.equal(calls.at(-1).args.params.world,1);
assert.equal(optics.drawFallbackDroplets,undefined,'private fallback API removed');
assert.deepEqual(Object.keys(optics.output),['color','metadata','fallback']);
optics.update({...frame,cameraRevision:2}); optics.record(); assert.equal(optics.stats.boundsBuilds,1);
for (const change of [()=>sim.version++,()=>sim.cur=1,()=>sim.origin.x++]) {
  const before=calls.length; change(); optics.update(frame);
  assert.deepEqual(calls.slice(before).map(c=>c.name),['hybrid.optics.bounds','hybrid.optics.bounds.finish']);
  optics.record();
}
assert.equal(optics.stats.boundsBuilds,4);
optics.update({...frame,revision:'external-edit'}); optics.record(); assert.equal(optics.stats.boundsBuilds,5);
const attachments=Object.values(optics.output);
assert(attachments.every(t=>t.usage===20));
optics.dispose(); optics.dispose(); assert(buffers.every(b=>b.destroyed===1)); assert(attachments.every(t=>t.destroyed===1));
assert.equal(frame.color.destroyed,0); assert.equal(frame.depth.destroyed,0); assert.equal(optics.isReady,false);
assert.throws(()=>optics.update(frame),/disposed/);
console.log(`hybrid optics follow-up: ${ELEMENTS.length} IDs; bounds support/miss/occlusion; four-channel intervals, normals, live sources and sphere geometry; WG64 layouts; 16/8 budgets; same-frame recording/cache/disposal passed (CPU only)`);

const dropCode = opticsShader(grid,{fieldBinding:2,boundsBinding:4,particleBinding:5});
const dropReflect = new WgslReflect(dropCode);
for (const vs of dropReflect.entry.vertex) assert(!vs.resources.some(resource=>resource.name==='TB'));
assert.equal(dropReflect.textures.length,4); // no added sampled resources
assert.equal(dropReflect.storage.length,5);
assert.match(dropCode,/opticsTrace\(OpticsVertex\(v.position\),true,d.a,entry\)/);
assert.match(dropCode,/!forced && !bent/);
assert.match(dropCode,/@builtin\(frag_depth\)/);
assert.deepEqual(opticalParticleInterval([0.5,0.5,0.5],[1,0,0],[0,0,0]),[-0.5,0.5]);
assert(opticalParticleInterval([-2,0.5,0.5],[1,0,0],[0,0,0])[0] > 1); // opaque at t=1 wins
// The same sphere roots remain available to secondary rays behind glass.
assert.match(dropCode,/let particle = opticsParticleOwns/);
const resources = {instances:{},opticalArgs:{}};
const drops = createHybridOptics(gpu,sim,{particles:resources,
  lighting:{hooks:{worldHit:'fn opticsWorldHit(h: OpticalHit) -> vec3f { return vec3f(1); }'}}});
assert.throws(()=>drops.record(frame),/particleSplit/);
sim.derived.particleSplit=true;
gpu.frame.encoder={};
gpu.frame.flush=function(){ this.encoder=null; };
const start=calls.length;
drops.record(frame);
const recorded=calls.slice(start);
assert.deepEqual(recorded.filter(c=>c.name==='draw').map(c=>c.args.indirect?.offset),[undefined,0,16]);
const passes=recorded.filter(c=>c.name==='render');
assert(passes[2].desc.colorAttachments.every(a=>a.loadOp==='load'));
assert.equal(passes[1].desc.depthStencilAttachment.depthLoadOp,'clear');
assert.equal(passes[2].desc.depthStencilAttachment.depthLoadOp,'load');
const dropAttachments=[...Object.values(drops.output),passes[2].desc.depthStencilAttachment.view.texture];
drops.dispose();
assert(dropAttachments.every(t=>t.destroyed===0),'encoded resources must survive until encoder submission');
gpu.frame.flush();
assert(dropAttachments.every(t=>t.destroyed===1),'retire exactly once after encoder changes');

// Capacity fallback is the full solver, not a billboard overlay.
const fallbackCode = opticsShader(grid,{fieldBinding:2,boundsBinding:4,particleBinding:5,fallbackBinding:6});
const fallbackReflect = new WgslReflect(fallbackCode);
for (const vs of fallbackReflect.entry.vertex) assert(!vs.resources.some(r=>r.name==='fallbackGate'));
for (const fs of fallbackReflect.entry.fragment) assert(fs.resources.some(r=>r.name==='fallbackGate'));
assert.match(dropCode,/fn opticsFallbackMode\(\) -> bool \{ return false;/);
assert.match(fallbackCode,/!forced && !opticsFallbackMode\(\) && opticalBounds.count == 0u/);
assert.match(fallbackCode,/if \(opticsFallbackMode\(\)\) \{ interval = opticsBox\(FU.cam, rd, vec3f\(0\), vec3f\(vec3i\(NX, NY, NZ\)\)\);/);
assert.match(fallbackCode,/!forced && !bent && !opticsFallbackMode\(\)/);
assert.match(fallbackCode,/fn opticsSnapshot[^]*?if \(opticsFallbackMode\(\)\) \{ return vec4f\(-1.0\);/);
assert.match(fallbackCode,/if \(interval.x >= cut\) \{ return out; \}/);
assert.match(fallbackCode,/if \(!bent\) \{ segment = min\(segment, max\(0.0, cut - traveled\)\);/);
assert.match(fallbackCode,/if \(!opticsFallbackMode\(\) \|\| out.metadata.x == 1.0\)/,'molten preserves first refracted interface');
assert.match(fallbackCode,/fn dropFS[^]*?if \(opticsFallbackMode\(\)\) \{ discard; \}/);
assert.match(fallbackCode,/opticsFallbackMode\(\) && !bent && optical == 0 && id != E_EMPTY\s*&& RCLASS\(id\) == R_OPAQUE && MEDIACH\(id\) < 0\) \{ return out; \}/,
  'overflow world surfaces absent from raster depth still occlude primary optical paths');
// Numeric refracted transport through glass/water into an isolated sphere.
for (const front of [glass,water]) for (const molten of [false,true]) for (const opaque of [false,true]) {
  let hits=0;
  const result=run({fallbackMode:true, sample:([x]) => x===1 ? front : x===3 ?
    { ...oil, isolated:true, opaque:molten } : x===5 && opaque ? {id:9,opaque:true} : null,
    worldHit:()=>{hits++;return [2,1,0.5];}});
  assert.equal(result.termination,molten || opaque ? 'opaque' : 'escape');
  assert.equal(hits,molten || opaque ? 1 : 0);
  assert(result.interfaces>=2);
  if (!molten) assert(result.segments.some(s=>s.id===oil.id));
}
for (const fallbackMode of [false,true]) {
  const result=run({fallbackMode,sample:([x])=>x===3 ? {...water,isolated:true} : null});
  assert.equal(result.interfaces,fallbackMode?2:0);
}
const foreground=run({fallbackMode:true,sample:([x])=>x===1?{id:9,opaque:true}:x===3?glass:null});
assert.equal(foreground.termination,'opaque');
assert.equal(foreground.interfaces,0,'optics behind an opaque foreground must not replace legacy foreground');
const standaloneMolten=run({fallbackMode:true,sample:([x])=>x===3?{...oil,isolated:true,opaque:true}:null});
assert.equal(standaloneMolten.termination,'opaque','isolated molten requires optical coverage even with zero interfaces');
const gate={};
const fallback=createHybridOptics(gpu,sim,{particles:resources,fallbackGate:gate,
  lighting:{hooks:{worldHit:'fn opticsWorldHit(h: OpticalHit) -> vec3f { return vec3f(1); }'}}});
await fallback.ready;
gpu.frame.encoder={}; fallback.record(frame);
const fullDraw=calls.filter(c=>c.name==='draw' && c.pipeline.name==='hybrid optics').at(-1);
const gateEntry=fullDraw.args.bind[2].entries.at(-1);
assert.equal(gateEntry.resource.buffer,gate);
assert.equal(fullDraw.args.bind[2].layout.entries.at(-1).visibility,2);
assert.equal(fullDraw.args.bind[2].layout.entries.at(-1).buffer.type,'read-only-storage');
assert.equal(fallback.drawFallbackDroplets,undefined);
const oldOutput=Object.values(fallback.output);
// Auto-submit A; external compose consumes old output in B, without advancing frameNo.
gpu.frame.flush(); gpu.frame.encoder={};
const larger={color:fakeTexture({size:[32,32],format:'rgba16float',usage:4}),depth:fakeTexture({size:[32,32],format:'depth32float',usage:4})};
assert.doesNotThrow(()=>fallback.record(larger));
assert(oldOutput.every(t=>t.destroyed===0),'current consumer encoder protects old output');
gpu.frame.flush(); assert(oldOutput.every(t=>t.destroyed===1));
gpu.frame.encoder={};
const lastOutput=Object.values(fallback.output);
fallback.dispose(); fallback.dispose();
assert(lastOutput.every(t=>t.destroyed===0));
gpu.frame.flush(); assert(lastOutput.every(t=>t.destroyed===1));
assert.equal(gate.destroyed,undefined); assert.equal(resources.instances.destroyed,undefined);
console.log('Fallback full solver: gate, bounds bypass, primary spheres, no snapshot reuse, opaque cut, encoder replacement/resize/disposal passed (CPU only)');

// Full root composition, including actual material/light/media hooks and ABI.
const { createHybridShading } = await import('../src/gfx/hybrid/shading.js');
const { hybridMaterialsWGSL,hybridMaterialLayoutEntries,hybridMaterialEntries } = await import('../src/shaders/hybrid/materials.js');
const { shadowBindingDescriptors } = await import('../src/shaders/hybrid/shadows.js');
const { hybridMediaSegmentWGSL,MEDIA_FIELD_LAYOUT } = await import('../src/shaders/hybrid/media.js');
const { readFileSync } = await import('node:fs');
const rootSource=readFileSync(new URL('../src/gfx/hybrid/index.js',import.meta.url),'utf8');
const rootShade=createHybridShading({device:{createSampler:()=>({})}},
  {g:grid,derived:{views:{gi:[{},{},{},{}],light:{}}}}, {
  binding:2,controls:{buffer:{}},
  materials:{shader:hybridMaterialsWGSL,layoutEntries:hybridMaterialLayoutEntries,
    entries:opts=>hybridMaterialEntries({table:{},albedo:{},normal:{},sampler:{}},opts)},
  shadows:{bindingDescriptors:shadowBindingDescriptors,bindings:({binding})=>[{}, {}, {buffer:{}}].map((resource,i)=>({binding:binding+i,resource}))},
});
const hooks=Object.fromEntries(['worldHit','environment','body','mediaSegment'].map(key=>{
  const match=rootSource.match(new RegExp(key+':`([^`]+)`')); assert(match,`root ${key} hook`);return [key,match[1]];
}));
const rootWGSL=rootShade.wgsl+'\nfn hybridMediaSun(p:vec3f)->f32{return hybridSunVisibility(p,vec3f(0.0));}\n'+
  hybridMediaSegmentWGSL({fieldGroup:2,fieldBinding:16,paramsGroup:2,paramsBinding:23,declareFrame:false,declareHeader:false,sunWGSL:'',sunVisibility:'hybridMediaSun'});
const rootExtras=[...rootShade.layout,...MEDIA_FIELD_LAYOUT.map(e=>({...e,binding:e.binding+16})),
  {binding:23,visibility:2,buffer:{type:'uniform'}},...opticsFieldBindings(24),
  {binding:26,visibility:2,buffer:{type:'read-only-storage'}},
  {binding:27,visibility:3,buffer:{type:'read-only-storage'}},
  {binding:28,visibility:2,buffer:{type:'read-only-storage'}}];
validateOpticsLimits({},rootExtras);
assert.equal(rootExtras.filter(e=>((e.visibility??7)&2)&&e.buffer?.type==='read-only-storage').length+3,8);
assert.equal(rootExtras.filter(e=>((e.visibility??7)&2)&&e.texture).length+2,16);
const rootCodes=[null,28].map(fallbackBinding=>opticsShader(grid,{fieldBinding:24,boundsBinding:26,particleBinding:27,fallbackBinding,wgsl:rootWGSL,hooks}));
for (const code of rootCodes) {
  const reflection=new WgslReflect(code);
  for (const [stage,bit] of [['vertex',1],['fragment',2]]) for (const entry of reflection.entry[stage]) {
    const storage=entry.resources.filter(r=>reflection.storage.some(s=>s.group===r.group && s.binding===r.binding));
    const sampled=entry.resources.filter(r=>reflection.textures.some(s=>s.group===r.group && s.binding===r.binding));
    assert(storage.length<=8); assert(sampled.length<=16);
    if (stage==='fragment') { assert(storage.length>=5); assert(sampled.length>=14); console.log(`Selected ${entry.name}: ${storage.length} storage / ${sampled.length} textures`); }
    for (const resource of entry.resources.filter(r=>r.group===2)) {
      assert(([...opticsBindings(),...rootExtras].find(e=>e.binding===resource.binding)?.visibility??7)&bit,`${entry.name} binding ${resource.binding}`);
    }
  }
}
console.log('Root selected-entry masks/layout: fragment storage 8, sampled textures 16; gate binding 28 fragment-only');
{
  const { spawnSync } = await import('node:child_process');
  for (const [name, code] of [['bounds',boundsCode], ['field-optics',boundedCode],
    ['cell-optics',opticsShader(grid,{boundsBinding:2})], ['droplets',dropCode],
['root-normal',rootCodes[0]], ['root-fallback',rootCodes[1]], ['root-point-diagnostic',rewriteOpticsDiagnostic(rootCodes[0],'steps')],
['root-limited-diagnostic',rewriteOpticsDiagnostic(rootCodes[0],'steps',64)],
['root-exit-diagnostic',rewriteOpticsDiagnostic(rootCodes[0],'steps',64,true)],
['root-runtime-gi-diagnostic',rewriteOpticsDiagnostic(rootCodes[0],'runtime-gi')],
['root-unlit-surfaces-diagnostic',rewriteOpticsDiagnostic(rootCodes[0],'unlit-surfaces')],
    ['drop-depth',dropDepthWGSL], ['fallback-optics',fallbackCode], ['split-bounds',opticsBoundsShader(grid,{particles:true,world:true})]]) {
    const result = spawnSync('naga',['--stdin-file-path',`${name}.wgsl`],{input:code,encoding:'utf8'});
    assert.equal(result.status,0,`${name}: ${result.error ?? ''}${result.stdout}${result.stderr}`);
  }
  console.log('Naga CPU semantic validation: bounds WG64 kernels and field/cell optics passed (no GPU execution)');
}
// Oblique hidden-surface gradient and nearest eligible source, retaining seed/temp.
const affine = ([x,y,z]) => 0.2*x+0.3*y+0.4*z;
const n = opticalFieldNormal([0.8,0.7,0.6],affine);
[-0.2,-0.3,-0.4].forEach((v,i) => close(n[i],v/Math.hypot(0.2,0.3,0.4)));
const fartherSand = {id:id('SAND'),state:[id('SAND'),900,0,0.91]};
const twoSources = q => q.join() === '2,1,1' ? fartherSand : sourceAt(q);
assert.equal(opticalFieldSource([1.2,1.3,1.4],[0,0,1,0],twoSources),sand);
assert.equal(opticalFieldSource([1.2,1.3,1.4],[0,0,1,0],twoSources,q=>q.join()==='1,1,1'),fartherSand);
assert.match(boundedCode,/\+ 64 \* \(NX \+ NY \+ NZ\)/,'four channels cannot consume the distant-entry budget');
