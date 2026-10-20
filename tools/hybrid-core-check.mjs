// CPU-only. Source reflection and command recording are NOT GPU validation.
import assert from 'node:assert/strict';
import { Matrix4,PerspectiveCamera,Vector3 } from 'three';
import { execFileSync,spawnSync } from 'node:child_process';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { EventEmitter } from 'node:events';
import { createHybridGeometry } from '../src/gfx/hybrid/geometry.js';
import { createHybridRenderer, hybridEligibility } from '../src/gfx/hybrid/index.js';
import { buildHybridMaterialTable, buildHybridDetailAtlas, createHybridMaterials } from '../src/gfx/hybrid/materials.js';
import { hybridDetailLod, hybridMaterialsWGSL } from '../src/shaders/hybrid/materials.js';
import { drawWGSL, meshWGSL, compactWGSL, shadowWGSL, geometryCapacity } from '../src/shaders/hybrid/geometry.js';
import { gridDims,LAYOUT } from '../src/shaders/common.js';
import { E,ELEMENTS,R } from '../src/elements.js';
import { LOOK } from '../src/gfx/materials.js';
import { withVisibility } from '../src/gpu/kernels.js';
import { checkReadbackAfterRender } from './hybrid-readback-cpu-check.mjs';
import { probeWGSL,forceOverflowWGSL,producerProbeWGSL,readbackSentinelWGSL,motionWriteSentinelWGSL,motionProbeWGSL,watchFailures,resetFixture,checkedRead,verifyReadback,withFreshStaging,fixturePaintRate,sceneReadbackControl,validateFixture,renderCompleteFrames,paintFixture,GLOSSY_FIXTURE,FIXTURE_COMPONENTS } from './harness/hybrid-full.js';

globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 8 };
globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
const grids={32:[32,32,32],64:[64,64,64],128:[128,128,128],
  wide:[160,96,160],valley:[256,96,128],giant:[128,384,128]};
const gridName=process.argv[2]??'128';
assert(Object.hasOwn(grids,gridName)&&process.argv.length<=3,'Usage: node tools/hybrid-core-check.mjs [32|64|128|wide|valley|giant]');
const [nx,ny,nz]=grids[gridName],g = gridDims({nx,ny,nz});
await checkReadbackAfterRender();
validateFixture();
for(const component of ['all',...FIXTURE_COMPONENTS]){
  const painted=[];
  paintFixture({THREE:{Vector3},sim:{paint:p=>painted.push(p)},volume:{matrixWorld:new Matrix4(),updateMatrixWorld(){}},
    camera:new PerspectiveCamera(),controls:{target:new Vector3()}},{component});
  assert.equal(painted.length,{all:13,opaque:2,smooth:4,media:4,optics:5,particles:6}[component],'controls must not weaken the default fixture');
  assert(painted.some(p=>p.tool===E.WALL)&&painted.some(p=>p.tool===GLOSSY_FIXTURE));
  if(component==='all')for(const id of [E.SAND,E.WOOD,E.WATER,E.GLASS,E.SMOKE,E.LAVA,E.FIRE])assert(painted.some(p=>p.tool===id));
  if(component==='all'){
    const negative=[];
    paintFixture({THREE:{Vector3},sim:{paint:p=>negative.push(p)},volume:{matrixWorld:new Matrix4(),updateMatrixWorld(){}},
      camera:new PerspectiveCamera(),controls:{target:new Vector3()}},{isolatedEmitter:false});
    assert.deepEqual(negative,painted.filter(p=>p.tool!==E.LAVA||p.radius>=1),'negative control removes only the isolated emitter');
  }
  if(component==='opaque')assert.deepEqual(painted.map(p=>p.tool),[E.WALL,GLOSSY_FIXTURE]);
  if(component==='particles')assert(painted.filter(p=>p.radius<1).length===4);
}
{
  let attempts=0,ready=false,nativeError=false;
  const scopes=[];
  const device={pushErrorScope:type=>scopes.push(type),popErrorScope:async()=>{
    const type=scopes.pop();return nativeError&&type==='internal'?{message:'render command failed'}:null;
  }};
  const a={gpu:{device},view:{volumeDrawn:false},test:{
    ready:async()=>{ready=true;},
    renderOnce:async()=>{assert(ready,'wait for cold requests before the next attempt');ready=false;a.view.volumeDrawn=++attempts>2;},
  }};
  assert.equal(await renderCompleteFrames(a),4,'skipped cold frames do not count as presented scenes');
  assert(ready,'finish pipeline preparation before numerical probes');
  attempts=0;a.test.renderOnce=async()=>{attempts++;a.view.volumeDrawn=false;};
  await assert.rejects(renderCompleteFrames(a),/within six attempts/);
  assert.equal(attempts,6,'cold preparation remains bounded');
  attempts=0;a.view.volumeDrawn=true;
  a.hybrid={enabled:true,stats:{compositions:0},motion:{stats:{frames:0}}};
  a.post={temporalInputs:{motion:{},reactive:{}}};
  a.test.renderOnce=async()=>{
    if(++attempts>2){a.hybrid.stats.compositions++;a.hybrid.motion.stats.frames++;}
  };
  assert.equal(await renderCompleteFrames(a),4,'a retained volume flag cannot count stale hybrid outputs');
  nativeError=true;
  await assert.rejects(renderCompleteFrames(a),/Scene GPU error: internal: render command failed/);
  assert.deepEqual(scopes,[],'all scene error scopes are popped on success and failure');
}
for(const id of [E.SAND,E.WOOD,E.WATER,E.LAVA,E.SMOKE,E.FIRE]){
  assert(ELEMENTS[id].spawn*fixturePaintRate(id)>=1,'required fixture cells cannot depend on random spawn acceptance');
}
assert.equal(fixturePaintRate(-2),1,'temperature tool must keep its normal rate');
{
  let opened=0,closed=0,validation=null;
  const gpu={device:{pushErrorScope(type){assert(['validation','internal','out-of-memory'].includes(type));opened++;},
    async popErrorScope(){closed++;return validation;}},flush(label){assert.equal(label,'probe');return true;}};
  assert.equal(await checkedRead(gpu,'probe',()=>42),42);
  validation={message:'invalid copy destination'};
  await assert.rejects(checkedRead(gpu,'probe',()=>0),/probe: invalid copy destination/);
  validation=null;
  await assert.rejects(checkedRead(gpu,'probe',()=>{throw Error('record failed');}),/record failed/);
  await assert.rejects(checkedRead(gpu,'probe',()=>Promise.reject(Error('mapping failed'))),/mapping failed/);
  gpu.flush=()=>false;
  await assert.rejects(checkedRead(gpu,'probe',()=>0),/readback recorded no submission/);
  gpu.flush=()=>true;
  gpu.failure=Error('graphics stopped');
  await assert.rejects(checkedRead(gpu,'probe',()=>0),/graphics stopped/);
  assert.equal(opened,closed,'every diagnostic error scope must be balanced');
  delete gpu.failure;
  let destroyed=0,stale=false,bytes;
  gpu.flush=()=>true;
  gpu.createBuffer=()=>({destroy(){destroyed++;}});
  gpu.write=(_buffer,offset,data)=>{assert.equal(offset,0);bytes=data.buffer.slice(0);};
  gpu.readback={buffer:async(_buffer,offset,size)=>stale?new ArrayBuffer(size):bytes.slice(offset,offset+size)};
  gpu.layout=()=>({});gpu.bindGroup=()=>({});
  gpu.kernel=({code})=>{assert.equal(code,readbackSentinelWGSL);return{ready:Promise.resolve(),dispatch(){
    new Uint32Array(bytes).forEach((word,i,a)=>{a[i]=word^0x55555555;});
  }};};
  assert.equal((await verifyReadback(gpu)).upload[0],0x12345678);
  stale=true;
  await assert.rejects(verifyReadback(gpu),/Readback upload sentinel mismatch/,'zero or stale reads must fail before scene assertions');
  assert.equal(destroyed,2);
  const pool=new Map([[256,[{}]]]),staging=()=>{assert.equal(gpu.readback.pool.size,0);return 23;};
  gpu.readback.pool=pool;gpu.readback._staging=staging;
  assert.equal(await withFreshStaging(gpu,async()=>gpu.readback._staging(16)),23);
  assert.equal(gpu.readback.pool,pool);assert.equal(gpu.readback._staging,staging);
  await assert.rejects(withFreshStaging(gpu,()=>{throw Error('fresh probe failed');}),/fresh probe failed/);
  assert.equal(gpu.readback.pool,pool);assert.equal(gpu.readback._staging,staging);
  stale=false;gpu.frameNo=0;gpu.readback.idle=async()=>{};
  let seeded=false;gpu.fence=async()=>{seeded=true;};
  const control={gpu,settings:{},autoRes:{},day:{},loadPreset:()=>true,sim:{frame:77},view:{volumeDrawn:true},
    post:{inSize:[800,600],temporalInputs:{motion:{},reactive:{}}},hybrid:{enabled:true,stats:{compositions:0},motion:{stats:{frames:0}}},
    test:{park(){},ready:async()=>{},renderOnce:async()=>{assert(seeded);gpu.frameNo++;control.hybrid.stats.compositions++;control.hybrid.motion.stats.frames++;}}};
  assert.deepEqual(await sceneReadbackControl(control),{hybrid:true,frames:2,size:[800,600],steps:77});
  assert.equal(control.settings.upscale,'native');assert.equal(control.autoRes.enabled,false);
}
{
  const order=[];
  let ready=false,pendingClear,cleared=false;
  await resetFixture({test:{async ready(){
    order.push('ready');ready=true;pendingClear?.();
  }},loadPreset(name,undoable){
    assert(ready,'boot pipelines must settle before requesting the fixture scene');
    assert.equal(name,'empty');assert.equal(undoable,false);
    order.push('load');pendingClear=()=>{cleared=true;order.push('clear');};return true;
  }});
  assert(cleared,'deferred scene clearing must finish before fixture painting');
  assert.deepEqual(order,['ready','load','ready','clear']);
  await assert.rejects(resetFixture({test:{ready:async()=>{}},loadPreset:()=>false}),/Could not load/);
}
{
  const page=new EventEmitter(),reported=[],failures=watchFailures(page,message=>reported.push(message));
  page.emit('console',{type:()=> 'error',text:()=> 'net::ERR_CONNECTION_REFUSED',location:()=>({url:'http://127.0.0.1:8787/status'})});
  assert.equal(await failures.check(Promise.resolve(17)),17);
  assert.equal(failures.offlineRelay.length,1);
  const waiting=failures.check(new Promise(()=>{}));
  page.emit('console',{type:()=> 'warning',text:()=> 'WebGPU validation error',location:()=>({url:'gpu.js'})});
  await assert.rejects(waiting,/WebGPU validation error/,'GPU failures interrupt pending native startup immediately');
  await assert.rejects(failures.check(Promise.resolve()),/WebGPU validation error/,'errors before a phase cannot be hidden by an already resolved promise');
  assert.equal(reported.length,1);
  const scriptPage=new EventEmitter(),script=watchFailures(scriptPage,()=>{});
  scriptPage.emit('pageerror',new Error('app boot failed'));
  await assert.rejects(script.check(Promise.resolve()),/app boot failed/);
}
const capacity=geometryCapacity(g);
assert.equal(capacity.capacity,Math.min(384,Math.floor(128*1024**2/(g.nbricks*4))));
assert.equal(capacity.faceBytes,g.nbricks*capacity.capacity*4);
assert(capacity.faceBytes<=128*1024**2);
assert.equal(geometryCapacity(gridDims({nx:128,ny:128,nz:128})).faceBytes,48*1024**2);
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
  for(const code of [probeWGSL(g),forceOverflowWGSL,producerProbeWGSL,readbackSentinelWGSL,motionWriteSentinelWGSL,motionProbeWGSL]){
  new WgslReflect(code);
  if(semantic)execFileSync('naga',['--stdin-file-path','hybrid-full-check.wgsl'],{input:code,encoding:'utf8'});
}
const created=[],validated=new Set();
const pipe = desc => {
  assert.equal(desc.optional, true, `${desc.name}: Test-owned compilation must not destroy the shared device`);
  created.push(desc.name);
  const r=new WgslReflect(desc.code);
  if(semantic&&!validated.has(desc.code))execFileSync('naga',['--stdin-file-path',desc.name+'.wgsl'],{input:desc.code,encoding:'utf8'});
  validated.add(desc.code);
  for(const stage of ['compute','vertex','fragment'])for(const entry of r.entry[stage]){
    const storageTextures=entry.resources.filter(v=>v.type.name.startsWith('texture_storage_'));
    assert(storageTextures.length<=4,`${desc.name} ${entry.name} storage textures`);
    assert(entry.resources.filter(v=>r.storage.includes(v)&&!storageTextures.includes(v)).length<=8,`${desc.name} ${entry.name} storage buffers`);
    assert(entry.resources.filter(v=>r.textures.includes(v)).length<=16,`${desc.name} ${entry.name} textures`);
  }
  const stages=desc.entry||(r.entry.compute.length&&!r.entry.vertex.length)
    ? [['compute',4,desc.entry??'main']]
    : [['vertex',1,desc.vertex?.entry??'vs'],...(desc.fragment===null?[]:[['fragment',2,desc.fragment?.entry??'fs']])];
  for(const [stage,mask,name] of stages){
    const entry=r.entry[stage].find(e=>e.name===name);
    assert(entry,`${desc.name}: missing ${stage} entry ${name}`);
    let storage=0,textures=0,storageTextures=0;
    for(const layout of desc.layouts){
      const entries=(Array.isArray(layout)?layout:layout?.entries)??[];
      for(const e of entries.filter(e=>e.visibility&mask)){
        storage+=/storage/.test(e.buffer?.type??'')?1:0;
        textures+=e.texture?1:0;
        storageTextures+=e.storageTexture?1:0;
      }
    }
    assert(storage<=8&&textures<=16&&storageTextures<=4,`${desc.name} ${stage}: explicit layout limits`);
    for(const v of entry.resources.filter(v=>v.group<desc.layouts.length)){
      const layout=desc.layouts[v.group],entries=(Array.isArray(layout)?layout:layout?.entries)??[];
      const binding=entries.find(e=>e.binding===v.binding);
      assert(binding?.visibility&mask,`${desc.name} ${name}: group ${v.group} binding ${v.binding} lacks ${stage} visibility`);
    }
  }
  return { name: desc.name, state: 'ready', ready: Promise.resolve(),
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
  readHeader() { return { ...this.header(), format: 0 }; },
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
const complete=(frame,passes=[{kind:'render',gpu:25}])=>gpu.timing.onFrame({frame,coverage:{complete:true},passes});
assert.equal(renderer.prepare(input),true);
assert.equal(renderer.update(input), true);
assert(calls.length > composed, 'all producers and shared shadows record real commands');
assert(renderer.drawOpaque(post));
const opaqueCopy=calls.find(c=>c.name==='copy'&&c.args[0].texture===depth);
assert(opaqueCopy,'opaque depth is captured before legacy volume can overwrite transmitting depth');
const recordMedia=renderer.media.record;
renderer.media.record=input=>{
  const color=recordMedia(input);
  gpu.frame.encoder={}; // legal automatic submission within the same app frame
  return color;
};
assert(renderer.compose(post));
renderer.media.record=recordMedia;
assert.equal(calls.find(c=>c.name==='hybrid optics').bind[2].entries.find(e=>e.binding===1).resource.texture,
  opaqueCopy.args[1].texture,'optical cut remains opaque-only, not legacy gas/glass depth');
assert.equal(post.inputs,undefined,'temporal capture waits for transparent meshes');
assert(renderer.temporalFrame(post,{...input,transparentMeshes:true}));
assert.equal(calls.findLast(c=>/motion.*vectors/.test(c.name)).params.untracked,1,'visible transparent meshes reject and capture coverage');
assert(renderer.temporalFrame(post,input));
assert.equal(calls.findLast(c=>/motion.*vectors/.test(c.name)).params.untracked,0);
for(const pattern of [/scene acceptance/,/smooth.*build/,/particles.*finish/,/optics droplets/,/optics droplet depth/,/media integrate/,/motion.*vectors/,/scene composite/])
  assert(calls.some(c=>pattern.test(c.name)),`missing production path ${pattern}`);
assert(post.inputs.motion&&post.inputs.reactive,'real motion and coverage reach post');
assert.equal(renderer.stats.compositions,1);
assert.equal(calls.find(c=>/scene composite/.test(c.name)).bind[2].entries.find(e=>e.binding===3).resource.buffer,
  renderer.legacyIndirect.buffer,'composition masks the complete optical layer against the same GPU fallback predicate');
complete(1);
assert.equal(samples.at(-1).stable,false,'first workload has no comparable baseline');
gpu.frameNo=1;renderer.update(input);complete(2,[{kind:'render',gpu:25},
  {kind:'compute',name:renderer.optics.computePassName,gpu:7},{kind:'compute',name:'physics/extraction',gpu:999}]);
assert.equal(samples.at(-1).stable,true,'held camera and producer workload are comparable');
assert.equal(samples.at(-1).gpuMs,32,'isolated optics compute counts; mixed physics/extraction does not');
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
// Every pass that binds the box's read group gets the header that names its representation (V1: format 0).
const stateCalls=(from,group)=>calls.slice(from).filter(c=>c.bind?.[1]===group);
assert(stateCalls(0,sim.bindRO).length&&stateCalls(0,sim.bindRO).every(c=>c.header?.format===0),'V1 readers see format 0');
assert(!created.some(n=>/format2/.test(n)),'a V1 box builds no V2 smooth draw');

// Physics V2 owns the box: sim.bindRO is V2's own cells (src/sim.js), so every reader must be told
// format 2 (sim.readHeader), and the smooth draw's vertex stage must read V2's cells, not V1's
// legacy copies (only a cache under V2). Same producers, layouts and production shading, under Naga.
{
  const owner={isReady:true,cells:{label:'v2 cells'},sync(){}};
  const v2Read={label:'v2 read group'};
  const nativeSim={...sim,bindRO:v2Read,compact:owner,compactOwner:owner,state:{A:{label:'v1 A'},B:{label:'v1 B'}},
    readHeader(){return {...this.header(),format:2};}};
  const from=calls.length;
  const native=createHybridRenderer(gpu,nativeSim,{post});
  await native.ready;
  assert(created.includes('hybrid.smooth.draw.format2')&&created.includes('hybrid.smooth.shadow.format2'),'a V2 box builds its smooth draw with the rest');
  assert.equal(native.prepare(input),true);
  assert(native.update(input));
  assert(native.drawOpaque(post));
  assert(native.compose(post));
  assert(native.temporalFrame(post,input));
  const readers=stateCalls(from,v2Read);
  for(const pattern of [/geometry compare/,/geometry mesh/,/smooth.extract/,/smooth.build/,/particles.compact/,/optics/,/motion/])
    assert(readers.some(c=>pattern.test(c.name)),`V2 reader missing: ${pattern}`);
  for(const c of readers)assert.equal(c.header?.format,2,`${c.name} reads V2's cells as format 2`);
  const draws=calls.slice(from).filter(c=>/^hybrid\.smooth\.(draw|shadow)/.test(c.name));
  assert(draws.length&&draws.every(c=>/format2$/.test(c.name)&&c.header.format===2),'V2 smooth surfaces use the format-2 draw');
  assert(draws.every(c=>c.bind[1].entries[0].resource.buffer===owner.cells&&c.bind[1].entries[1].resource.buffer===nativeSim.state.B),
    'the smooth vertex stage reads V2 cells beside the legacy B, never the stale legacy A');
  native.dispose();
}
console.log(`PASS hybrid core @${gridName}: material bytes/mips/LOD, exact-change recording, actual entry/layout stage masks, allocation bounds, ALL scene producers/composition, transparent coverage, workload/pause timing metadata, thumbnail ownership and fallback/lifecycle, V2 cells (format 2) in every state reader and the smooth draw; CPU only. Naga ${semantic?'passed':'unavailable'}.`);
