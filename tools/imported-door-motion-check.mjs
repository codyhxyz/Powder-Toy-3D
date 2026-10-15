import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { E } from '../src/elements.js';
import { createImportedMapScene } from '../src/world/scenes/importedMap.js';
import { createImportedInteractions, IMPORTED_DOOR_MOTION_EDIT, WGSL_CHECK } from '../src/pov/importedInteractions.js';
import { doorCellPositions } from '../src/world/import/doorRuntime.js';
import { doorPose, transformDoorPoint } from '../src/world/import/doorMotion.js';
import { createDoorAppearance } from '../src/world/import/doorAppearance.js';
import { appearanceRegion, packAppearancePlanes, uploadAppearanceRange } from '../src/gfx/sourceAppearance.js';
import { gridLayout } from '../src/sim.js';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { appearanceFixture } from './appearance-fixture.mjs';
import { APPEARANCE_HEADER as H } from '../src/world/import/appearanceFormat.js';
import { createHash } from 'node:crypto';
import { Vector3 } from 'three';
import { WorldWindow } from '../src/world/window.js';
import { BrickStore } from '../src/world/store.js';
import { NativeBrickStore } from '../src/world/nativeStore.js';
import { createSaves } from '../src/saves/game.js';
import { decodeSave } from '../src/saves/format.js';
import { parseGodot3Scene } from '../src/world/import/godot3.js';
import { analyzeCrueltyDoors, crueltyInteractions } from '../src/world/import/crueltyInteractions.js';
import { voxelizeMeshes } from '../src/world/import/voxelize.js';
import { FarField } from '../src/world/far.js';

const key = p => p.join(',');
function fixture({ swing=false, duration=0.4, timer=null, points=[[10,4,10],[11,4,10],[12,4,10]], staticPoints=[] }={}) {
  const map={version:1,encoding:'sparse-brick-u8-v1',cellMeters:0.3,size:[32,16,32],brickDims:[4,2,4],plainHeight:0,dataFile:'test.binpack',dataCompression:'gzip',mission:{spawn:[1,1,1]}};
  const words=new Uint32Array(32+32*128);
  for(let i=0;i<32;i++) words[i]=32+i*128;
  const index=p=>p[0]+32*(p[1]+16*p[2]);
  function set(p,id) {
    const local=p[0]%8+8*(p[1]%8+8*(p[2]%8)), at=words[Math.floor(p[0]/8)+4*(Math.floor(p[1]/8)+2*Math.floor(p[2]/8))]+(local>>2),shift=(local&3)*8;
    words[at]=((words[at]&~(255<<shift))|(id<<shift))>>>0;
  }
  points.forEach(p=>set(p,E.WOOD)); staticPoints.forEach(p=>set(p,E.STONE));
  const door={sourcePath:'door',sourceResource:'res://Scripts/Door.gd',supported:true,kind:swing?'swing':'sliding',cells:points.flatMap(p=>[index(p),E.WOOD]),bounds:{min:[0,1,2].map(k=>Math.min(...points.map(p=>p[k]))),max:[0,1,2].map(k=>Math.max(...points.map(p=>p[k]))+1)},
    motion:{version:1,kind:swing?'swing':'sliding',pivot:[10,4,10],axis:[0,1,0],angleRadians:-Math.PI/2,translation:[-4,0,0],speed:2,durationSeconds:duration,autoCloseSeconds:timer,sweptBounds:{min:[4,3,9],max:[14,6,17]}}};
  map.interactions={version:1,doors:[door],ladders:[]};
  const scene=createImportedMapScene(map,words), gpuCells=new Map(points.map((p,i)=>[key(p),{id:E.WOOD,temp:333+i,life:55+i}]));
  staticPoints.forEach(p=>gpuCells.set(key(p),{id:E.STONE,temp:295}));
  const bodies=[], retired=[], reads=[], edits=[];
  let delayReady=Promise.resolve(), readHook=null;
  const sim={origin:{x:0,y:0,z:0},g:{nx:32,ny:16,nz:32},
    editKernel(name,desc) { assert.equal(desc,IMPORTED_DOOR_MOTION_EDIT); assert.equal(desc.reads,'neighbours'); return {ready:delayReady}; },
    gpu:{createBuffer:({size})=>({bytes:new Uint32Array(size/4)}),write:(buffer,at,data)=>buffer.bytes.set(data,at/4),
      readback:{async buffer(buffer,offset,size) { reads.push(size); await readHook?.(); return buffer.bytes.slice(offset/4,(offset+size)/4).buffer; }}},
    _retire:buffer=>retired.push(buffer),
    edit(kernel,box,p,{bind}) {
      edits.push(box);
      const data=bind[0].buffer.bytes, snapshot=new Map(gpuCells), outputs=new Map();
      for(let z=0;z<p.size[2];z++) for(let y=0;y<p.size[1];y++) for(let x=0;x<p.size[0];x++) {
        const dst=2*(x+p.size[0]*(y+p.size[1]*z)),pos=[x+p.at[0],y+p.at[1],z+p.at[2]],k=key(pos),actual=snapshot.get(k), own=data[dst]!==0&&actual?.id===data[dst];
        if(own) outputs.set(k,null);
        let link=data[dst+1],stampedID=0;
        while(link) {
          const s=p.sourceAt+(link-1)*12, old=snapshot.get(key([...data.subarray(s,s+3)])),expected=data[s+3],wasPlaced=!!data[s+5];
          const alive=!!data[s+4]&&(!wasPlaced||old?.id===expected);
          data[s+7]=+alive; data[s+9]=old?.id??0;
          const canPlace=alive&&(!actual||own)&&(!stampedID||stampedID===expected);
          data[s+8]=+canPlace;
          if(canPlace&&!stampedID) { outputs.set(k,wasPlaced?{...old}:{id:expected,temp:295,life:0}); stampedID=expected; }
          link=data[s+6];
        }
      }
      for(const [k,v] of outputs) if(v) gpuCells.set(k,v); else gpuCells.delete(k);
    }};
  const world={scene,P:{seed:1},pending:null}, app={getWorld:()=>world,getSim:()=>sim,requestRender(){}},runtime=createImportedInteractions({app,interact:{provide:()=>()=>{}},getBodies:()=>bodies});
  const state=()=>scene.interactionState.states.get('door');
  async function tick(dt=1/30) { runtime.update(dt); await world.pending; }
  async function finish() { for(let i=0;i<100&&state().progress!==state().desiredProgress;i++) await tick(); assert.equal(state().progress,state().desiredProgress); }
  return {map,door,scene,sim,world,app,runtime,gpuCells,bodies,retired,reads,edits,state,tick,finish,setCell:set,setReady:p=>{delayReady=p;},setReadHook:fn=>{readHook=fn;}};
}
function checkCanonical(f) {
  for(const [k,v] of f.gpuCells) assert.equal(f.scene.cell(...k.split(',').map(Number)),v.id,k);
  for(const p of doorCellPositions(f.map,f.door,f.state().progress)) if(f.state().placed.some(Boolean)) assert.equal(f.scene.cell(...p),f.gpuCells.get(key(p))?.id??0);
}

test('final converter ABI drives real runtime orchestration with reserved swept bricks',async()=>{
  const source=parseGodot3Scene('[gd_scene format=2]\n[ext_resource path="res://Scripts/Door.gd" type="Script" id=1]\n[node name="Root" type="Spatial"]\n[node name="Door" type="KinematicBody" parent="."]\nscript = ExtResource( 1 )\n[node name="Mesh" type="MeshInstance" parent="Door"]\n');
  const meshes=[{nodePath:'Door/Mesh',rawLocalBounds:{min:[-1,-1,-0.1],max:[1,1,0.1]},surfaces:[{positions:new Float64Array([-1,-1,0,1,-1,0,1,1,0,-1,1,0]),indices:new Uint32Array([0,1,2,0,2,3]),materialPath:'door'}]}];
  const analysis=analyzeCrueltyDoors(source,meshes),voxel=voxelizeMeshes(meshes,{door:E.WOOD},{cellMeters:0.3,ownerForMesh:analysis.ownerForMesh,reserveBounds:analysis.sweptBounds});
  const map={...voxel,dataFile:'fixture.binpack',dataCompression:'gzip',plainHeight:0,mission:{spawn:[1,1,1]}};
  map.interactions=crueltyInteractions(source,meshes,map,voxel.ownedCells,analysis);
  const scene=createImportedMapScene(map,voxel.words.slice()),door=map.interactions.doors[0],f=fixture();
  f.world.scene=scene; f.gpuCells.clear(); Object.assign(f.sim.g,{nx:map.size[0],ny:map.size[1],nz:map.size[2]});
  for(const p of doorCellPositions(map,door,0)) f.gpuCells.set(key(p),{id:E.WOOD,temp:350,life:70});
  await f.runtime.use(door);
  for(let i=0;i<30;i++) { f.runtime.update(1/30); await f.world.pending; }
  const s=scene.interactionState.states.get(door.sourcePath); assert.equal(s.progress,1); assert.ok(s.placed.some(Boolean));
  assert.deepEqual([...s.alive],Array(door.cells.length/2).fill(1));
  for(const p of doorCellPositions(map,door,1)) assert.equal(scene.cell(...p),f.gpuCells.get(key(p))?.id??0);
  scene.reset(); for(const p of doorCellPositions(map,door,0)) assert.equal(scene.cell(...p),E.WOOD);
});

test('actual moving leaf retains collision, thermal fields, deterministic endpoints, reverses current pose',async()=>{
  const f=fixture(); await f.runtime.use(f.door); assert.equal(f.runtime.timedDoor,true);
  await f.tick(); assert.ok(f.state().progress>0&&f.state().progress<1); checkCanonical(f);
  assert.ok([...f.gpuCells.values()].some(v=>v.temp===333&&v.life===55));
  const mid=f.state().progress; await f.runtime.use(f.door); await f.tick(); assert.ok(f.state().progress<mid);
  await f.finish(); assert.equal(f.state().progress,0);
  await f.runtime.use(f.door); await f.finish(); assert.equal(f.gpuCells.size,3,'open leaf remains physical'); checkCanonical(f);
  assert.ok(f.reads.every(n=>n===3*12*4)); assert.equal(f.retired.length,f.edits.length);
  assert.equal(f.runtime.timedDoor,false);
});

test('destroyed cells never resurrect; foreign old replacements and occluded destinations survive',async()=>{
  const f=fixture({staticPoints:[[8,4,10]]}); f.gpuCells.delete('10,4,10'); f.gpuCells.set('11,4,10',{id:E.STONE,temp:600});
  await f.runtime.use(f.door); await f.finish();
  assert.deepEqual([...f.state().alive],[0,0,1]); assert.equal(f.gpuCells.get('11,4,10').id,E.STONE); assert.equal(f.gpuCells.get('8,4,10').id,E.STONE);
  assert.deepEqual([...f.state().placed],[0,0,0],'occlusion is not destruction');
  await f.runtime.use(f.door); await f.finish(); assert.deepEqual([...f.state().alive],[0,0,1]); assert.equal(f.gpuCells.get('12,4,10').id,E.WOOD); assert.equal(f.gpuCells.has('10,4,10'),false);
  assert.equal(f.scene.cell(11,4,10),E.STONE,'canonical generator preserves replacement');
  const saved=f.scene.interactionState.snapshot(),canonical=f.scene.data().words.slice();
  f.scene.interactionState.restore(saved); assert.deepEqual(f.scene.data().words,canonical,'foreign canonical replacements survive save restore');
});

test('dug static cells along the moving path stay holes across save restore and restore on retry',async()=>{
  const f=fixture({staticPoints:[[9,4,10]]}); f.gpuCells.delete('9,4,10');
  await f.runtime.use(f.door); await f.finish();
  const before=f.scene.data().words.slice(),saved=f.scene.interactionState.snapshot();
  assert.equal(f.scene.cell(9,4,10),0); f.scene.interactionState.restore(saved);
  assert.deepEqual(f.scene.data().words,before); assert.equal(f.scene.cell(9,4,10),0,'save does not resurrect dug terrain traversed by the leaf');
  f.scene.reset(); assert.equal(f.scene.cell(9,4,10),E.STONE,'retry restores source terrain');
});

test('rotation coalescence keeps all logical source cells over repeated cycles',async()=>{
  const f=fixture({swing:true,points:[[12,4,13],[12,4,14],[11,4,10]]});
  let coalesced=false;
  await f.runtime.use(f.door);
  for(let i=0;i<12;i++) { await f.tick(); if(f.gpuCells.size<3) coalesced=true; }
  assert.equal(coalesced,true);
  await f.finish(); await f.runtime.use(f.door); await f.finish();
  assert.deepEqual([...f.state().alive],[1,1,1]); assert.equal(f.gpuCells.size,3);
  await f.runtime.use(f.door); await f.finish(); await f.runtime.use(f.door); await f.finish(); assert.equal(f.gpuCells.size,3);
});

test('occupied player/NPC path defers; timed wake, pending clock, bounded jumps, residency freeze/resume',async()=>{
  const outside=fixture(); outside.bodies.push({pos:{x:5,y:4,z:16},size:0.1,height:0.5});
  await outside.runtime.use(outside.door); await outside.tick(); assert.ok(outside.state().progress>0,'body elsewhere in full envelope does not block actual step path');
  const f=fixture({timer:5}); await f.runtime.use(f.door); await f.finish();
  assert.equal(await f.runtime.use(f.door),false,'manual timed close ignored');
  f.bodies.push({pos:{x:7,y:4,z:10},size:0.1,height:0.5});
  await f.tick(5); assert.equal(f.state().progress,1); assert.equal(f.state().desiredProgress,0);
  f.bodies.length=0; await f.tick(100); assert.ok(f.state().progress>=1-0.1/0.4-1e-10,'long dt does not teleport'); await f.finish();
  const g=fixture({timer:5}); await g.runtime.use(g.door); g.world.pending=Promise.resolve(); g.runtime.update(2); assert.equal(g.state().elapsed,2); g.world.pending=null;
  g.sim.origin.x=20; await g.tick(); assert.equal(g.state().progress,0); assert.equal(g.runtime.timedDoor,false); g.sim.origin.x=0; await g.tick(); assert.ok(g.state().progress>0);
});

test('midpose save v2, v1 migration, invalid-save atomicity, retry reset and art reset',async()=>{
  const f=fixture(); f.gpuCells.delete('10,4,10'); await f.runtime.use(f.door); await f.tick(); await f.tick();
  const saved=f.scene.interactionState.snapshot(),canonical=f.scene.data().words.slice();
  f.scene.interactionState.restore(saved); assert.deepEqual(f.scene.interactionState.snapshot(),saved); assert.deepEqual(f.scene.data().words,canonical);
  const before=f.scene.data().words.slice(),epoch=f.scene.interactionState.epoch;
  assert.throws(()=>f.scene.interactionState.restore({...saved,doors:[{...saved.doors[0],placed:[1,1,1]}]}),/Invalid saved door/);
  assert.deepEqual(f.scene.data().words,before); assert.equal(f.scene.interactionState.epoch,epoch);
  f.scene.reset(); assert.equal(f.scene.cell(10,4,10),E.WOOD); assert.equal(f.scene.interactionState.states.size,0);
  f.scene.interactionState.restore({version:1,doors:[{sourcePath:'door',open:true,alive:[0,1,1],elapsed:2}]});
  assert.equal(f.state().progress,1); assert.equal(f.state().elapsed,2); assert.deepEqual([...f.state().alive],[0,1,1]);
});

test('legacy-open saves keep logical survivors unplaced and close without clobbering endpoint terrain',async()=>{
  const f=fixture({staticPoints:[[6,4,10]]});
  for(const p of doorCellPositions(f.map,f.door,0)) f.gpuCells.delete(key(p));
  f.scene.interactionState.restore({version:1,doors:[{sourcePath:'door',open:true,alive:[1,1,1],elapsed:2}]});
  assert.equal(f.scene.cell(6,4,10),E.STONE);
  assert.deepEqual([...f.state().placed],[0,0,0],'v1 saved no physical open leaf');
  assert.equal(f.scene.cell(7,4,10),0);
  await f.runtime.use(f.door);
  await f.finish();
  assert.deepEqual([...f.state().alive],[1,1,1]);
  assert.deepEqual([...f.state().placed],[1,1,1]);
  assert.equal(f.gpuCells.get('6,4,10').id,E.STONE);
  assert.equal(f.scene.cell(6,4,10),E.STONE);
  checkCanonical(f);
});

test('independent doors share source time instead of waiting for the first leaf to finish',async()=>{
  const f=fixture({duration:1}),second=structuredClone(f.door);
  second.sourcePath='second';
  second.bounds.min[2]+=4; second.bounds.max[2]+=4;
  const points=doorCellPositions(f.map,f.door,0).map(p=>[p[0],p[1],p[2]+4]);
  second.cells=points.flatMap(p=>[p[0]+32*(p[1]+16*p[2]),E.WOOD]);
  f.map.interactions.doors.push(second);
  for(const p of points) { f.setCell(p,E.WOOD); f.gpuCells.set(key(p),{id:E.WOOD,temp:350,life:70}); }
  await f.runtime.use(f.door); await f.runtime.use(second);
  for(let i=0;i<15;i++) await f.tick();
  const other=f.scene.interactionState.states.get('second');
  assert.ok(f.state().progress>0.4 && other.progress>0.4);
  assert.ok(Math.abs(f.state().progress-other.progress)<=1/30+1e-9);
  for(let i=0;i<17;i++) await f.tick();
  assert.equal(f.state().progress,1); assert.equal(other.progress,1);
});

test('pending GPU work banks motion time, zero-dt renders stay parked, and reversal is accepted in flight',async()=>{
  const f=fixture({duration:1});
  await f.runtime.use(f.door);
  let release;
  const blocked=new Promise(r=>{release=r;});
  f.setReadHook(()=>blocked);
  f.runtime.update(1/30);
  for(let i=0;i<3;i++) f.runtime.update(1/30);
  release(); await f.world.pending; f.setReadHook(null);
  const before=f.state().progress,edits=f.edits.length;
  f.runtime.update(0);
  assert.equal(f.state().progress,before); assert.equal(f.edits.length,edits);
  await f.tick(); await f.tick();
  assert.ok(Math.abs(f.state().progress-0.2)<1e-9,'readback did not discard elapsed animation time');
  let arrived;
  const submitted=new Promise(r=>{arrived=r;});
  const again=new Promise(r=>{release=r;});
  f.setReadHook(()=>{arrived();return again;});
  f.runtime.update(1/30); await submitted;
  assert.equal(await f.runtime.use(f.door),true,'input need not wait for the GPU readback');
  release(); await f.world.pending; f.setReadHook(null);
  await f.finish();
  assert.equal(f.state().progress,0);
  checkCanonical(f);
});

test('real save codec preserves an in-flight pose, damage, logical direction and use timer before refill',async()=>{
  const f=fixture({timer:5}); f.gpuCells.delete('10,4,10'); await f.runtime.use(f.door); await f.tick(); await f.tick();
  const expected=f.scene.interactionState.snapshot(); assert.ok(expected.doors[0].progress>0&&expected.doors[0].progress<1);
  Object.assign(f.sim.g,gridLayout(32,16,32)); f.sim.origin=new Vector3();
  const blank=()=>[new Float32Array(f.sim.g.width*f.sim.g.height*4),new Float32Array(f.sim.g.width*f.sim.g.height*4)];
  Object.assign(f.sim,{rays:{active:false},prepare:async()=>{},readState:async()=>blank(),blankState:blank,load(){},dropHistory(){}});
  Object.assign(f.world,{sim:f.sim,loaded:true,epoch:0,size:f.map.size,
    historyReaders:0,historyIdentity:{},acquireReadLock:WorldWindow.prototype.acquireReadLock,
    store:new BrickStore([8,4,8]),nativeStore:new NativeBrickStore([8,4,8]),
    planted:new Uint8Array(64),loadSaved:WorldWindow.prototype.loadSaved});
  const saves=createSaves({settings:{},getSim:()=>f.sim,getWin:()=>f.world,header:()=>({map:'test',world:{scene:'test',seed:0}}),prepare:async()=>true,finish(){},onSettings(){}});
  const bytes=await saves.capture('midpose'); assert.deepEqual((await decodeSave(bytes)).sections.get('worldInteractions'),expected);
  assert.equal(f.world.historyReaders,0,'save preparation releases the actual world read lock');
  f.scene.reset(); await saves.apply(bytes); assert.deepEqual(f.scene.interactionState.snapshot(),expected);
});

test('epoch/world/dispose guards reject stale async commits and retire buffers',async()=>{
  for(const action of ['epoch','world','dispose']) {
    const f=fixture(); await f.runtime.use(f.door);
    let release; const blocked=new Promise(r=>{release=r;}); f.setReadHook(()=>blocked);
    f.runtime.update(1/30); const pending=f.world.pending; await Promise.resolve();
    if(action==='epoch') f.scene.reset(); else if(action==='world') f.app.getWorld=()=>null; else f.runtime.dispose();
    release(); await pending; assert.equal(f.world.pending,null); assert.equal(f.retired.length,1);
    if(action==='epoch') assert.equal(f.scene.interactionState.states.size,0); else assert.equal(f.state().progress,0);
  }
});

test('actor safety is rechecked after asynchronous edit-pipeline readiness',async()=>{
  const f=fixture(); let release; f.setReady(new Promise(r=>{release=r;}));
  await f.runtime.use(f.door); f.runtime.update(1/30); const pending=f.world.pending;
  f.bodies.push({pos:{x:10,y:4,z:10},size:0.1,height:0.5}); release(); await pending;
  assert.equal(f.state().progress,0); assert.equal(f.edits.length,0); assert.equal(f.world.pending,null);
});

test('door art rigid affine equivalence, immutable source records, sorted dirty coalescing, reset',()=>{
  const words=new Uint32Array(64+24*3),floats=new Float32Array(words.buffer); words[6]=64;
  for(let i=0;i<3;i++) {
    const at=64+i*24; floats.set([11,4,10],at); words[at+3]=0xdeadbeef;
    floats.set([1,0,0,-11, 0,1,0,-4, 0,0,1,10, 1,0,0,-11, 0,1,0,-4],at+4);
  }
  const original=words.slice(),ranges=[],art=createDoorAppearance({},words,(at,data)=>ranges.push([at,data.length]));
  const door={appearanceTriangleIndices:[2,0,1,1],motion:{kind:'swing',pivot:[10,4,10],axis:[0,1,0],angleRadians:-Math.PI/2}};
  for(const progress of [0.2,0.7,1,0.4]) {
    art.pose(door,progress); const matrix=doorPose(door.motion,progress),p=transformDoorPoint(matrix,[11.2,4.3,10]);
    for(const at of [64,88,112]) {
      assert.equal(words[at+3],0xdeadbeef);
      for(const [offset,expected] of [[4,0.2],[8,0.3],[16,0.2],[20,0.3]]) {
        const actual=floats[at+offset+3]+p.reduce((n,v,k)=>n+v*floats[at+offset+k],0); assert.ok(Math.abs(actual-expected)<2e-6);
      }
      assert.ok(Math.abs(p.reduce((n,v,k)=>n+v*floats[at+12+k],0)-floats[at+15])<2e-6);
    }
  }
  assert.ok(ranges.every(([at,count])=>at===64&&count===72)); art.reset(); assert.deepEqual(words,original);
});

test('scene creates art only after checksum, subscribes dirty ranges, and retry resets immutable art',async()=>{
  const f=fixture(),base=appearanceFixture(),words=new Uint32Array(base.words.length+31);
  words.set(base.words.subarray(0,64)); words.set(base.words.subarray(65),96);
  words[64]=96; words[H.totalWords]=words.length; words.set(f.map.brickDims,H.brickDims);
  for(const slot of ['trianglesAt','materialsAt','lightsAt','environmentAt']) words[H[slot]]+=31;
  words[words[H.materialsAt]]+=31;
  f.map.appearance={...base.map.appearance,totalWords:words.length,sha256:createHash('sha256').update(words).digest('hex')};
  f.door.appearanceTriangleIndices=[0];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(words.slice());
  try {
    const scene=createImportedMapScene(f.map,f.scene.data().words.slice()),before=words.slice();
    const ranges=[]; scene.subscribeAppearance((at,data)=>ranges.push([at,data.length]));
    await scene.prepare();
    const s=scene.interactionState.ensure(f.door);
    scene.interactionState.move(f.door,0.5,s.alive,s.placed,[E.WOOD,E.WOOD,E.WOOD]);
    assert.notDeepEqual(scene.appearanceWords,before); assert.deepEqual(ranges,[[words[H.trianglesAt],24]]);
    scene.reset(); assert.deepEqual(scene.appearanceWords,before);
    const bad=createImportedMapScene({...f.map,appearance:{...f.map.appearance,sha256:'0'.repeat(64)}},f.scene.data().words.slice());
    await assert.rejects(bad.prepare(),/checksum/); assert.equal(bad.appearanceWords,null);
  } finally { globalThis.fetch=originalFetch; }
});

test('range uploads preserve exact u32 pairs, neighbours/padding, X/Z/Y boundaries without whole palette upload',()=>{
  const words=Uint32Array.from({length:53},(_,i)=>(0xabcd0000+i)>>>0),region=appearanceRegion([3,2,2],words.length),full=packAppearancePlanes(words,region);
  for(const [from,count] of [[1,1],[5,20],[11,30],[52,1],[0,53],[7,0]]) {
    const dest=full.slice(),calls=[]; words.forEach((v,i)=>{if(i>=from&&i<from+count) words[i]=v^0xffffffff;});
    const gpu={queue:{writeTexture({origin},data,layout,size){ calls.push(size[0]); const [x,y,z]=origin; for(let i=0;i<size[0]*4;i++) dest[4*(x+region.size[0]*((y-region.uniform[0])+region.planes*z))+i]=data[i]; }}};
    uploadAppearanceRange(gpu,{},words,region,from,count); assert.deepEqual(dest,packAppearancePlanes(words,region));
    assert.ok(calls.every(n=>n<=3)); full.set(dest);
  }
  assert.throws(()=>uploadAppearanceRange({}, {},words,region,53,1),/Invalid/);
});

test('far scene builds upload fully once, stream only dirty art, replace subscriptions and unsubscribe on dispose',()=>{
  const calls=[],scene=()=>({appearanceWords:new Uint32Array(53),listeners:new Set(),subscribeAppearance(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}}),a=scene(),b=scene();
  const far={ready:true,detail:{reset(){},dispose(){}},L:{bricks:{n:[3,2,2]}},groups(){},appearance:appearanceRegion([3,2,2],53),scene:a,
    gpu:{queue:{writeTexture(...args){calls.push(args);}}},grid:{},region(){},k:{clear:{}},groupsFixed:{clear:{}},winMask:new Uint32Array(1),summarizeWindow(){},
    sim:{origin:{x:0,z:0},g:{nx:12,nz:8},_retire(){}},refresh(){},_dropUnder(){},disposeTreeMaps(){}};
  FarField.prototype.sceneBuild.call(far); assert.equal(calls.length,1); assert.deepEqual(calls[0][3],[3,far.appearance.planes,2]);
  const stale=[...a.listeners][0]; a.appearanceWords[5]=123; stale(5,a.appearanceWords.subarray(5,6)); assert.equal(calls.length,2); assert.deepEqual(calls[1][3],[1,1,1]);
  far.scene=b; stale(5,a.appearanceWords.subarray(5,6)); assert.equal(calls.length,2);
  FarField.prototype.sceneBuild.call(far); assert.equal(a.listeners.size,0); assert.equal(b.listeners.size,1);
  const last=[...b.listeners][0]; FarField.prototype.dispose.call(far); assert.equal(b.listeners.size,0);
  last(5,b.appearanceWords.subarray(5,6)); assert.equal(calls.length,3);
});

test('both WGSL edit modules reflect, fit eight storage buffers, and pass CPU Naga',()=>{
  const dir=mkdtempSync(join(tmpdir(),'door-wgsl-'));
  try {
    for(const check of WGSL_CHECK) {
      const code=check.code(gridLayout(32,32,32)),reflect=new WgslReflect(code);
      assert.ok(reflect.storage.length<=8);
      assert.equal(reflect.textures.length,0);
      const path=join(dir,check.name+'.wgsl'); writeFileSync(path,code);
      const result=spawnSync('naga',[path],{encoding:'utf8'});
      assert.equal(result.error,undefined,'Naga CLI required'); assert.equal(result.status,0,result.stderr||result.stdout);
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
