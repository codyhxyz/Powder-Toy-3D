// CPU-only. Source reflection and command recording are NOT GPU validation.
import assert from 'node:assert/strict';
import { Matrix4,PerspectiveCamera } from 'three';
import { execFileSync,spawnSync } from 'node:child_process';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { createHybridGeometry } from '../src/gfx/hybrid/geometry.js';
import { createHybridRenderer, hybridEligibility } from '../src/gfx/hybrid/index.js';
import { buildHybridMaterialTable, buildHybridDetailAtlas, createHybridMaterials } from '../src/gfx/hybrid/materials.js';
import { hybridDetailLod, hybridMaterialsWGSL } from '../src/shaders/hybrid/materials.js';
import { drawWGSL, meshWGSL, compactWGSL, shadowWGSL, geometryCapacity } from '../src/shaders/hybrid/geometry.js';
import { gridDims,LAYOUT } from '../src/shaders/common.js';
import { ELEMENTS,R } from '../src/elements.js';
import { LOOK } from '../src/gfx/materials.js';
import { withVisibility } from '../src/gpu/kernels.js';

globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 8 };
globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
const g = gridDims({ nx: 128, ny: 128, nz: 128 });
assert.equal(geometryCapacity(g).capacity, 384);
assert.equal(geometryCapacity(g).faceBytes, 48 * 1024 ** 2);
assert.equal(geometryCapacity(g, { maxBufferSize: 1 }).reason, 'device-buffer-limit');
assert.equal(geometryCapacity(g, {}, 1).guaranteed, false);
assert.throws(() => geometryCapacity(g, {}, 385), RangeError);
const rows = buildHybridMaterialTable();
assert.equal(rows.byteLength, ELEMENTS.length * 80);
assert(rows.every(Number.isFinite), 'material rows must be finite');
const atlas = buildHybridDetailAtlas({ size: 8 });
assert.equal(atlas.mipLevelCount, 4);
assert.deepEqual(atlas, buildHybridDetailAtlas({ size: 8 }), 'stable texture generation');
assert.notDeepEqual(atlas.layers[2], buildHybridDetailAtlas({ size: 8, seed: 17 }).layers[2]);
for (const layer of atlas.layers) {
  assert.deepEqual(layer.map(l => l.width), [8, 4, 2, 1]);
  for (const level of layer) assert.equal(level.albedoRoughness.length, level.width * level.height * 4);
}
assert.equal(hybridDetailLod(1, 1, 64, 7), 6);
assert.equal(hybridDetailLod(0, 1, 64, 7), 0);
assert.equal(hybridDetailLod(1 / 32, 1, 64, 7), 1);
assert.throws(() => hybridDetailLod(-1, 1, 64, 7));
assert.doesNotMatch(hybridMaterialsWGSL(), /textureSample\(/, 'divergent/compute-safe explicit LOD only');
for (const code of [meshWGSL(g), compactWGSL(g), shadowWGSL(g), drawWGSL(g, { shadingWGSL: hybridMaterialsWGSL({ binding: 1 }) })]) new WgslReflect(code);
for (const frame of [{ view: 'heat' }, { view: 'cozy' }, { sourceAppearance: true }, { decoration: true }, { warp: { k: 1 } }, { disabled: true }]) assert(hybridEligibility(frame));
assert.equal(hybridEligibility(), null);
assert.equal(hybridEligibility({world:true}),null,'straight world windows use the same producers');
for(const e of ELEMENTS.filter(e=>e.id)){
  const l=LOOK[e.id];
  const owners=[l.media>=0,l.ch===0||l.ch===1||e.render===R.GLASS,
    l.ch===2||l.ch===3,e.render===R.OPAQUE&&l.ch<0&&l.media<0];
  assert.equal(owners.filter(Boolean).length,1,`${e.key}: exactly one primary matter owner`);
}

const calls = [], buffers = [], textures = [], rings = [], layouts = new Map();
const resource = (desc, list) => {
  const r = { sampleCount:1,dimension:'2d',depthOrArrayLayers:desc.size?.[2]??1,mipLevelCount:1,
    width:desc.size?.[0],height:desc.size?.[1],...desc, createView() { return { texture: r }; }, destroy() { this.destroyed = true; } };
  list.push(r); return r;
};
const semantic=spawnSync('naga',['--version'],{encoding:'utf8'}).status===0;
const pipe = desc => {
  const r=new WgslReflect(desc.code);
  if(semantic)execFileSync('naga',['--stdin-file-path',desc.name+'.wgsl'],{input:desc.code,encoding:'utf8'});
  for(const stage of ['compute','vertex','fragment'])for(const entry of r.entry[stage]){
    assert(entry.resources.filter(v=>r.storage.includes(v)).length<=8,`${desc.name} ${entry.name} storage`);
    assert(entry.resources.filter(v=>r.textures.includes(v)).length<=16,`${desc.name} ${entry.name} textures`);
  }
  const stages=desc.entry||(r.entry.compute.length&&!r.entry.vertex.length)
    ? [['compute',4,desc.entry??'main']]
    : [['vertex',1,desc.vertex?.entry??'vs'],...(desc.fragment===null?[]:[['fragment',2,desc.fragment?.entry??'fs']])];
  for(const [stage,mask,name] of stages){
    const entry=r.entry[stage].find(e=>e.name===name);
    assert(entry,`${desc.name}: missing ${stage} entry ${name}`);
    let storage=0,textures=0;
    for(const layout of desc.layouts){
      const entries=(Array.isArray(layout)?layout:layout?.entries)??[];
      for(const e of entries.filter(e=>e.visibility&mask)){
        storage+=/storage/.test(e.buffer?.type??'')?1:0;
        textures+=e.texture?1:0;
      }
    }
    assert(storage<=8&&textures<=16,`${desc.name} ${stage}: explicit layout limits`);
    for(const v of entry.resources.filter(v=>v.group<desc.layouts.length)){
      const layout=desc.layouts[v.group],entries=(Array.isArray(layout)?layout:layout?.entries)??[];
      const binding=entries.find(e=>e.binding===v.binding);
      assert(binding?.visibility&mask,`${desc.name} ${name}: group ${v.group} binding ${v.binding} lacks ${stage} visibility`);
    }
  }
  return { state: 'ready', ready: Promise.resolve(),
    dispatch(_f, size, args) { calls.push({ name: desc.name, size, ...args }); },
    draw(_rp, args) { calls.push({ name: desc.name, ...args }); },
  };
};
const gpu = {
  emptyLayout:[],emptyGroup:{},
  device: { limits: { maxTextureDimension2D: 8192,maxBufferSize:128*1024**2,maxStorageBufferBindingSize:128*1024**2 }, createSampler: desc => ({ ...desc }) },
  queue: { writeBuffer() {}, writeTexture() {} },
  layout(name, entries) {
    entries=entries.map(withVisibility);
    if (layouts.has(name)) assert.deepEqual(entries, layouts.get(name).entries, `layout collision: ${name}`);
    else layouts.set(name, { name, entries });
    return layouts.get(name);
  },
  bindGroup: (layout, entries) => ({ layout, entries }),
  createBuffer: desc => resource(desc, buffers), createTexture: desc => resource(desc, textures),
  uniforms(_struct, name) { return { buffer: resource({ name, size: 4096 }, buffers), write() {} }; },
  kernel: pipe, renderPipeline: pipe, flush() {},
  frame: { encoder:{},render() { calls.push({ name: 'render' }); return { end() { calls.push({ name: 'end' }); } }; },
    direct(){return{copyTextureToTexture(...args){calls.push({name:'copy',args});}};} },
  readback: { ring() {
    let resolve; const read = new Promise(r => { resolve = r; });
    const ring = { buffer: {}, next: () => 0, read: () => read, resolve, close() { this.closed = true; } };
    rings.push(ring); return ring;
  } },
};
const sim = {
  id: 1, g, cur: 0, version: 1, state:{A:{},B:{}}, origin: { x: 0, y: 0, z: 0 }, tables: {}, bindRO: {},
  header() { return { origin: Object.values(this.origin), src: this.cur, dst: this.cur }; },
  derived: { views: { gi: [{}, {}, {}, {}], light: {} } },
};
const geometry = createHybridGeometry(gpu, sim);
await geometry.ready;
assert.equal(geometry.update(), true);
assert.deepEqual(calls.map(c => c.name.replace(/^.* geometry /, '')), ['compare', 'mesh', 'prepare', 'compact', 'finish']);
assert.equal(calls[0].params.force, 1);
assert.equal(geometry.update(), false, 'camera-only frames never compare or remesh');
sim.version++;
assert.equal(geometry.update(), true);
assert.equal(calls.at(-1).params.force, 0, 'state change uses exact GPU comparison');
sim.origin.x += 16;
geometry.update();
assert.equal(calls.at(-1).params.force, 1, 'window shift invalidates persistent slots');
assert.equal(geometry.drawOpaque({}), true);
assert.equal(calls.at(-1).indirect.buffer, geometry.resources.args);
assert.equal(geometry.update({ sourceAppearance: true }), false);
assert.equal(geometry.drawOpaque({}), false, 'known unsupported appearance cannot leak old surfaces');
geometry.dispose(); geometry.dispose();
assert.equal(geometry.isReady, false);
assert(rings[0].closed);

const materials = createHybridMaterials(gpu, sim, { size: 8 });
assert.deepEqual(materials.entries({ binding: 1 }).map(e => e.binding), [1, 2, 3, 4]);
materials.dispose(); materials.dispose();
assert.throws(() => materials.entries(), /disposed/);
// Exercise the actual app composition, including all owned shader modules.
sim.L={TABLES:LAYOUT.TABLES,STATE_RO:LAYOUT.STATE_RO};
sim.derived.frameNo=1;
sim.derived.world=null;
sim.derived.dlist={};
sim.derived.setParticleSplit=function(value){const changed=value!==this.particleSplit;this.particleSplit=value;return changed;};
for(const name of ['fieldSurf','fieldThin','fieldMedia']){
  sim.derived[name]={};sim.derived.views[name]={};
  sim[name]=sim.derived[name];
}
gpu._mediaNoise={view:{},ready:Promise.resolve()};
gpu._frameUniforms.last.written=true;
gpu._frameUniforms.last.viewProj=new Matrix4();
gpu._frameUniforms.last.model=new Matrix4();
const color=gpu.createTexture({size:[64,64],format:'rgba16float',usage:20});
const depth=gpu.createTexture({size:[64,64],format:'depth32float',usage:21});
let resets=0;
const post={settings:{upscale:1,taa:true,adaptive:false},inSize:[64,64],size:[64,64],
  get historyRevision(){return resets;},reset(){resets++;},setTemporalInputs(inputs){this.inputs=inputs;},
  withoutJitter:fn=>fn(),sceneTarget:{color,depth},sceneDescriptor:()=>({})};
gpu.frameNo=0;
gpu.timing={enabled:true,supported:true};
const renderer = createHybridRenderer(gpu, sim,{post});
await renderer.ready;
const composed = calls.length;
const input={sun:{x:0,y:1,z:0},model:new Matrix4(),camera:new PerspectiveCamera(),paused:false};
const samples=[],updateResolution=renderer.resolution.update;
renderer.resolution.update=f=>{samples.push(f);return updateResolution(f);};
const complete=frame=>gpu.timing.onFrame({frame,coverage:{complete:true},passes:[{kind:'render',gpu:25}]});
assert.equal(renderer.prepare(input),true);
assert.equal(renderer.update(input), true);
assert(calls.length > composed, 'all producers and shared shadows record real commands');
assert(renderer.drawOpaque(post));
assert(renderer.compose(post));
assert.equal(post.inputs,undefined,'temporal capture waits for transparent meshes');
assert(renderer.temporalFrame(post,{...input,transparentMeshes:true}));
assert.equal(calls.findLast(c=>/motion.*vectors/.test(c.name)).params.untracked,1,'visible transparent meshes reject and capture coverage');
assert(renderer.temporalFrame(post,input));
assert.equal(calls.findLast(c=>/motion.*vectors/.test(c.name)).params.untracked,0);
for(const pattern of [/scene acceptance/,/smooth.*build/,/particles.*finish/,/optics droplets/,/optics droplet depth/,/fallback droplets/,/media integrate/,/motion.*vectors/,/scene composite/])
  assert(calls.some(c=>pattern.test(c.name)),`missing production path ${pattern}`);
assert(post.inputs.motion&&post.inputs.reactive,'real motion and coverage reach post');
assert.equal(renderer.stats.compositions,1);
const fallbackDraw=calls.find(c=>/fallback droplets/.test(c.name));
assert.equal(fallbackDraw.indirect.buffer,renderer.legacyIndirect.buffer);
assert.equal(fallbackDraw.indirect.offset,48,'exceptional instances are GPU-gated, not shaded/discarded on normal frames');
assert.equal(calls.find(c=>/scene acceptance/.test(c.name)).bind[2].entries.find(e=>e.binding===3).resource.buffer,
  renderer.particles.resources.opticalArgs,'same-frame particle count feeds exceptional indirect arguments');
complete(1);
assert.equal(samples.at(-1).stable,false,'first workload has no comparable baseline');
gpu.frameNo=1;renderer.update(input);complete(2);
assert.equal(samples.at(-1).stable,true,'held camera and producer workload are comparable');
gpu.frameNo=2;renderer.update(input);
input.camera.position.x=1;
gpu.frameNo=3;renderer.update(input);complete(3);
assert.equal(samples.at(-1).stable,false,'late samples from another camera workload cannot certify trials');
complete(4);
assert.equal(samples.at(-1).stable,false,'new camera workload restarts evidence');
input.paused=true;gpu.frameNo=4;renderer.update(input);complete(5);
assert.equal(samples.at(-1).paused,true,'pause state belongs to the submitted frame');
const fields=[];
sim.updateBricks=()=>{fields.push(sim.derived.particleSplit);sim.derived.frameNo++;};
assert.equal(renderer.legacyStill(()=>{assert.equal(sim.derived.particleSplit,false);return 17;}),17);
assert.deepEqual(fields,[false,true],'thumbnail renders complete fields, then restores the split');
assert.equal(sim.derived.particleSplit,true);
assert.throws(()=>renderer.legacyStill(()=>{throw Error('thumbnail failed');}),/thumbnail failed/);
assert.equal(sim.derived.particleSplit,true,'failed thumbnails also restore ownership');
assert.equal(renderer.stats.legacyStills,2);
assert.equal(renderer.geometry.resources.status!==undefined,true);
assert.equal(renderer.legacyIndirect.offset,32);
assert.equal(renderer.prepare({view:'heat'}),true);
assert.equal(renderer.enabled, false);
assert.equal(sim.derived.particleSplit,false,'data view restores complete legacy fields');
renderer.dispose();
console.log(`PASS hybrid core: material bytes/mips/LOD, exact-change recording, actual entry/layout stage masks, allocation bounds, ALL scene producers/composition, transparent coverage, workload/pause timing metadata, thumbnail ownership and fallback/lifecycle; CPU only. Naga ${semantic?'passed':'unavailable'}.`);
