// CPU only: numerical oracles, generated WGSL reflection, resource contracts.
// Includes Naga semantic compilation, not GPU execution or visual validation.
import assert from 'node:assert/strict';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { gridDims } from '../src/shaders/common.js';
import { opticsShader, opticsBindings, opticsFieldBindings, OPTICS_STATE_LAYOUT, dropDepthWGSL, fallbackDropletWGSL, fallbackDropletBindings } from '../src/shaders/hybrid/optics.js';
import { interfaceEnergy, opticalTransmission, walkOpticalCells, traceOpticalReference,
  opticalFieldDensity, opticalFieldSegment, validateOpticsLimits, validateOpticsResources,
  createHybridOptics } from '../src/gfx/hybrid/optics.js';
const close = (a, b, tol = 1e-8) => assert(Math.abs(a - b) < tol, `${a} != ${b}`);
const white = a => a.forEach(v => close(v, 1));
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
  if (fieldBinding !== null) { assert.match(code, /segment = opticsFieldSegment/); assert.match(code, /textureLoad\(opticsThin/); }
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
assert.match(boundedCode,/if \(!forced && opticalBounds.count == 0u\) \{ return out; \}/);
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
assert.equal(optics.drawFallbackDroplets(),false,'optional fallback disabled');
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

// Exceptional capacity fallback: never sample scene attachments or read counts.
const fallbackReflect = new WgslReflect(fallbackDropletWGSL);
assert.equal(fallbackReflect.textures.length,2);
assert.equal(fallbackReflect.storage.length,2);
for (const [stage, bit] of [['vertex',1],['fragment',2]]) {
  for (const entry of fallbackReflect.entry[stage]) for (const resource of entry.resources) {
    if (resource.group !== 2) continue;
    assert(fallbackDropletBindings.find(e=>e.binding===resource.binding).visibility & bit,
      `${stage} binding ${resource.binding} visibility`);
  }
}
assert(!fallbackReflect.entry.vertex[0].resources.some(r=>r.name==='fallbackGate'));
assert(fallbackReflect.entry.fragment[0].resources.some(r=>r.name==='fallbackGate'));
assert.match(fallbackDropletWGSL,/if \(fallbackGate\[0\] == 0u\) \{ discard; \}/);
assert.match(fallbackDropletWGSL,/roots.y <= 0.0 \|\| roots.x > roots.y/);
assert.match(fallbackDropletWGSL,/first >= 1.0 \|\| abs\(first-depth\) > 0.000001/);
assert.match(fallbackDropletWGSL,/0.0,entry == 0.0/); // camera-inside depth agrees with metadata
assert.match(fallbackDropletWGSL,/FallbackDropOutput\(textureLoad\(resolved,vec2i\(v.position.xy\),0\),depth\)/);
// Numerical coverage/depth oracle for rejected fragments: legacy stays intact.
const fallbackPixel = ({gate=1, origin=[-1,0.5,0.5], first=0.1, scene=1}={}) => {
  if (!gate) return null;
  const roots=opticalParticleInterval(origin,[1,0,0],[0,0,0]);
  if (!roots || roots[1]<=0) return null;
  // Synthetic orthographic depth, sufficient to test the mask/depth contract.
  const depth=Math.max(0,roots[0])*0.1;
  return first>=1 || Math.abs(first-depth)>0.000001 || depth>scene ? null : depth;
};
assert.equal(fallbackPixel(),0.1);
assert.equal(fallbackPixel({gate:0}),null,'accepted normal scene suppressed');
assert.equal(fallbackPixel({origin:[-1,0.01,0.01]}),null,'billboard corners preserve scene');
assert.equal(fallbackPixel({first:0.05}),null,'nearer bulk interface cannot be copied');
assert.equal(fallbackPixel({first:1}),null,'no optical coverage');
assert.equal(fallbackPixel({scene:0.05}),null,'legacy foreground depth wins');
assert.equal(fallbackPixel({origin:[0.5,0.5,0.5],first:0}),0,'camera-inside entry');
const { readFileSync } = await import('node:fs');
const producer=readFileSync(new URL('../src/shaders/hybrid/particles.js',import.meta.url),'utf8');
assert.match(producer,/opticalArgs\[1\] = vec4u\(6u, select\(n, 0u, overflow\), 0u, 0u\)/);
const gate = {};
const fallbackStart = pipelines.length;
const fallback = createHybridOptics(gpu,sim,{particles:resources,fallbackGate:gate,
  lighting:{hooks:{worldHit:'fn opticsWorldHit(h: OpticalHit) -> vec3f { return vec3f(1); }'}}});
const target = {color:fakeTexture({size:[16,16],format:'rgba16float',usage:16}),
  depth:fakeTexture({size:[16,16],format:'depth32float',usage:16})};
assert.equal(fallback.drawFallbackDroplets(target),false,'no output before record');
// The added pipeline participates in readiness, not just the transport pipelines.
pipelines[fallbackStart+3].state='pending';
assert.equal(fallback.isReady,false); assert.equal(fallback.record(frame),false);
assert.equal(fallback.drawFallbackDroplets(target),false);
pipelines[fallbackStart+3].state='ready'; await fallback.ready;
gpu.frame.encoder={}; fallback.record(frame);
assert.throws(()=>fallback.drawFallbackDroplets({...target,color:fallback.output.color}),/alias/);
assert.throws(()=>fallback.drawFallbackDroplets({...target,depth:fallback.output.metadata}),/alias/);
assert.throws(()=>fallback.drawFallbackDroplets({...target,color:frame.color}),/invalid/);
const beforeFallback=calls.length;
assert(fallback.drawFallbackDroplets(target));
const fallbackCalls=calls.slice(beforeFallback);
assert.deepEqual(fallbackCalls.map(c=>c.name),['render','draw']);
const fallbackDraw=fallbackCalls[1];
assert.deepEqual(fallbackDraw.args.indirect,{buffer:resources.opticalArgs,offset:16}); // producer six vertices, GPU live count
assert.equal(fallbackDraw.args.count,undefined);
assert.equal(fallbackDraw.pipeline.depthStencil.depthCompare,'less-equal');
assert.equal(fallbackDraw.pipeline.depthStencil.depthWriteEnabled,true);
assert.equal(fallbackCalls[0].desc.colorAttachments[0].loadOp,'load');
assert.equal(fallbackCalls[0].desc.depthStencilAttachment.depthLoadOp,'load');
const entries=fallbackDraw.args.bind[2].entries;
assert.equal(entries[0].resource.texture,fallback.output.color);
assert.equal(entries[1].resource.texture,fallback.output.metadata);
assert.equal(entries[2].resource.buffer,resources.instances); assert.equal(entries[3].resource.buffer,gate);
assert.equal(fallbackDraw.args.params.size[0],16);
const oldOutput=Object.values(fallback.output);
const larger={color:fakeTexture({size:[32,32],format:'rgba16float',usage:4}),depth:fakeTexture({size:[32,32],format:'depth32float',usage:4})};
fallback.record(larger);
assert.throws(()=>fallback.drawFallbackDroplets(target),/invalid/);
const largerTarget={color:fakeTexture({size:[32,32],format:'rgba16float',usage:16}),depth:fakeTexture({size:[32,32],format:'depth32float',usage:16})};
assert(fallback.drawFallbackDroplets(largerTarget));
assert.equal(calls.at(-1).args.bind[2].entries[0].resource.texture,fallback.output.color);
assert.equal(calls.at(-1).args.params.size[0],32);
assert(oldOutput.every(t=>t.destroyed===0));
gpu.frame.flush();
assert(oldOutput.every(t=>t.destroyed===1));
assert.throws(()=>fallback.drawFallbackDroplets(largerTarget),/same-frame/);
fallback.dispose(); assert.equal(fallback.isReady,false);
assert.throws(()=>fallback.drawFallbackDroplets(target),/disposed/);
assert.equal(target.color.destroyed,0); assert.equal(largerTarget.depth.destroyed,0);
assert.equal(resources.instances.destroyed,undefined); assert.equal(gate.destroyed,undefined);
console.log('Fallback droplets: gate stage visibility/suppression, analytic coverage/inside/depth agreement, indirect offset/count ownership, load/depth test, no aliases, readiness/resize/disposal passed (CPU only)');

{
  const { spawnSync } = await import('node:child_process');
  for (const [name, code] of [['bounds',boundsCode], ['field-optics',boundedCode],
    ['cell-optics',opticsShader(grid,{boundsBinding:2})], ['droplets',dropCode],
    ['drop-depth',dropDepthWGSL], ['fallback-droplets',fallbackDropletWGSL], ['split-bounds',opticsBoundsShader(grid,{particles:true,world:true})]]) {
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
