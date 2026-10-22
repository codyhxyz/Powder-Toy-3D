// CPU only: real public helpers and command-recording/memory GPU double.
import './world-atlas-copy-cpu-check.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as A from '../src/world/renderAtlas.js';
import * as V from '../src/world/worldViewRing.js';
import { worldAccessWGSL, worldPageWriterWGSL, worldPackedMeshWriterWGSL, worldShadowWriterWGSL, WGSL_CHECK } from '../src/shaders/worldAccess.js';
import { checkPipeline } from './check-sampler-budget.mjs';
import { giSrcWGSL } from '../src/shaders/gi.js';
import { cellSlot } from '../src/shaders/common.js';

function fakeGPU(limits = {}) {
  const buffers = [], textures = [], log = [], deferred = [];
  const bytes = data => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const device = {
    limits: { ...A.DEFAULT_WORLD_LIMITS, ...limits },
    createBuffer(d) { const b = { ...d, data: new Uint8Array(d.size), destroyed: false, destroy() { assert.ok(!this.destroyed, 'double destroy buffer'); this.destroyed = true; } }; buffers.push(b); return b; },
    createTexture(d) {
      const bpp = d.format === 'rgba16float' ? 8 : 16;
      const t = { ...d, bpp, data: new Map(), destroyed: false, createView(desc) { return { texture: t, ...desc }; }, destroy() { assert.ok(!this.destroyed, 'double destroy texture'); this.destroyed = true; },
        get(p) { return this.data.get(p.join(',')) ?? new Uint8Array(bpp); },
        set(p, v) { assert.ok(p.every((n, i) => n >= 0 && n < d.size[i]), `OOB ${p} ${d.size}`); this.data.set(p.join(','), v.slice()); },
      }; textures.push(t); return t;
    },
    createCommandEncoder(d = {}) {
      const ops = [];
      return { copyBufferToBuffer(src, so, dst, d0, size) { log.push(['copyBuffer', d.label, src.label, size]); ops.push(() => { assert.ok(!src.destroyed && !dst.destroyed, 'copy uses destroyed buffer'); dst.data.set(src.data.subarray(so, so + size), d0); }); },
        copyTextureToTexture(src, dst, size) { assert.notEqual(src.texture, dst.texture, 'copy must not alias'); log.push(['copy', d.label, src, dst, size]); ops.push(() => {
        assert.ok(!src.texture.destroyed && !dst.texture.destroyed, 'copy uses destroyed texture');
        for (let z=0;z<size[2];z++) for(let y=0;y<size[1];y++) for(let x=0;x<size[0];x++) {
          const off = [x,y,z]; dst.texture.set(dst.origin.map((v,i)=>v+off[i]), src.texture.get(src.origin.map((v,i)=>v+off[i])));
        }
      }); }, finish() { return ops; } };
    },
    queue: {
      // (a typed array's dataOffset and size count its elements, as WebGPU's do)
      writeBuffer(b, off, v, at = 0, n) { assert.ok(!b.destroyed); const e = v.BYTES_PER_ELEMENT ?? 1, all = bytes(v); b.data.set(all.subarray(at * e, n === undefined ? undefined : (at + n) * e), off); log.push(['writeBuffer', b.label, off, n === undefined ? all.byteLength - at * e : n * e]); },
      writeTexture(dst, v, layout, size) {
        assert.ok(!dst.texture.destroyed); const bpp = dst.texture.bpp, raw = bytes(v), row = layout.bytesPerRow ?? size[0]*bpp;
        for(let z=0;z<size[2];z++) for(let y=0;y<size[1];y++) for(let x=0;x<size[0];x++) {
          const start = z*row*size[1]+y*row+x*bpp;
          dst.texture.set(dst.origin.map((n,i)=>n+[x,y,z][i]), raw.subarray(start,start+bpp));
        }
        log.push(['writeTexture', dst.texture.label]);
      },
      submit(commands) { log.push(['submit']); commands.flat().forEach(op=>op()); },
      onSubmittedWorkDone() { return Promise.resolve(); },
    },
  };
  const retire = fn => deferred.push(fn);
  const flush = () => { while(deferred.length) deferred.shift()(); };
  return { device, buffers, textures, log, retire, flush };
}
function setup(options = {}, limits = {}) {
  const gpu = fakeGPU(limits);
  const atlas = new A.WorldRenderAtlas(gpu, { worldSize: [128, 128, 128], initialCapacity: 2, retire: gpu.retire, ...options });
  return { gpu, atlas };
}
function dataFor(job, seed = 0) {
  const out = {};
  // Full-range patterns, including signalling NaNs, infinities and signed zero.
  const bits = [0, 0x80000000, 0x7f800000, 0xff800000, 0x7f800001, 0x7fc12345, 0xffffffff, 0x12345678];
  for (const [name, [format, shape]] of Object.entries(A.PAGE_CHANNELS)) {
    const length = (name==='aux' ? 132 : shape==='cells' ? 64 : 1)*4;
    const d = format==='rgba32uint' ? new Uint32Array(length) : new Uint16Array(length);
    for(let i=0;i<length;i++) d[i] = bits[(i+seed)%bits.length] ^ seed;
    if (shape !== 'probes') out[name] = d;
  }
  out.aux = A.packWorldAux({ ...job, brickInfo: new Uint32Array([0x7f800001,0x80000000,0x7fc12345,0]), flow: new Uint32Array(128).fill(0x7c018000), aeration: new Uint32Array(128).fill(0xfe017fff), deco: new Uint32Array(64).fill(0xfefdfcff) });
  return out;
}
function readChannel(snapshot, name, pid) {
  const [,shape,stride] = A.PAGE_CHANNELS[name], n = name==='aux' ? 132 : shape==='cells' ? 64 : 1;
  const out = new Uint8Array(n*stride), t = snapshot.views[name].texture;
  for(let s=0;s<n;s++) {
    const p = name==='aux' ? A.auxTexel(pid,s,snapshot.layout) : shape==='cells' ? A.pageTexel(pid,s,snapshot.layout) : A.probeTexel(pid,snapshot.layout);
    out.set(t.get(p),s*stride);
  }
  return out;
}
const rawBytes = d => new Uint8Array(d.buffer,d.byteOffset,d.byteLength);

test('default layouts count exactly 16 sampled; all variants enforce default/device limits', () => {
  assert.equal(A.WORLD_ATLAS_ABI,2,'explicit ABI migration gate');
  const reader=A.worldReaderLayouts();
  assert.equal(reader.length,4); assert.equal(reader.flat().filter(e=>e.texture).length,16);
  assert.equal(reader.flat().filter(e=>e.buffer?.type.includes('storage')).length,3);
  for(const k of [...Object.keys(A.WRITER_CHANNELS),'shadow','mesh']) A.worldWriterLayouts(k);
  assert.throws(()=>A.worldReaderLayouts({maxSampledTexturesPerShaderStage:15}));
  assert.throws(()=>A.worldWriterLayouts('raw',{maxStorageTexturesPerShaderStage:2}));
  assert.throws(()=>A.assertWorldLayout([...reader,[]]));
  assert.throws(()=>A.assertWorldLayout([[{visibility:4,buffer:{type:'storage',minBindingSize:128*1024**2+4}}]]));
  assert.throws(()=>A.worldWriterLayouts('invalid'));
  for (const pipeline of WGSL_CHECK) assert.deepEqual(checkPipeline({code:pipeline.code(),groups:pipeline.layouts(),kind:pipeline.kind}).problems,[],pipeline.name);
});
test('global book sizes, signed bounds, overflow and 384 high world', () => {
  for(const [h,mib] of [[128,24],[384,72]]) {
    const b=A.worldBookLayout([3072,h,1024]);
    assert.equal(b.bytes,mib*1024**2); assert.equal(b.requestBytes,Math.ceil(b.count/32)*4*6);
    assert.equal(A.worldBrickIndex(b,b.bricks.map(n=>n-1)),b.count-1);
    assert.equal(A.worldCellAddress(b,b.worldSize.map(n=>n-1)).slot,63);
    for(const c of [[-1,0,0],[3072,0,0],[0,h,0],[0,0,1024],[0.5,0,0],[NaN,0,0]]) assert.throws(()=>A.worldCellAddress(b,c));
    assert.throws(()=>A.worldBrickIndex(b,[-1,0,0]));
    assert.throws(()=>A.worldBrickIndex(b,[b.bricks[0],0,0]));
  }
  for(const size of [[0,4,4],[-4,4,4],[5,4,4],[2**31,4,4],[2**30,2**30,2**30],[4096,4096,4096]]) assert.throws(()=>A.worldBookLayout(size));
  assert.throws(()=>A.worldBookLayout([3072,384,1024],{maxStorageBufferBindingSize:64*1024**2}));
});
test('a book is the current book copied plus its changed chunks: same bytes as a whole upload', () => {
  // 1024x256x1024 cells: a 16 MiB book (Descent's is 125 MiB)
  const {gpu,atlas}=setup({worldSize:[1024,256,1024]});
  assert.equal(atlas.bookLayout.bytes,16*1024**2);
  const book=s=>new Uint32Array(s.book.data.buffer,0,atlas.bookLayout.count), light=s=>new Uint32Array(s.lightBook.data.buffer,0,atlas.bookLayout.count);
  let mark=gpu.log.length;
  for(const brick of [[0,0,0],[255,63,255],[100,10,200]]){const j=atlas.allocate(brick,{sourceRevision:1});atlas.update(j,dataFor(j));atlas.publish(j);}
  const s=atlas.snapshot();
  assert.deepEqual(book(s),atlas.entries);assert.deepEqual(light(s),atlas.lightEntries);
  const sent=gpu.log.slice(mark).filter(e=>e[0]==='writeBuffer'&&/immutable (light )?book/.test(e[1]));
  assert.ok(sent.every(e=>e[3]<=16384*4),'only changed 64 KiB chunks are sent');
  assert.ok(gpu.log.slice(mark).some(e=>e[0]==='copyBuffer'&&e[1]==='world book copy'));
  // growth commits the same entries: the same books, shared, nothing sent or copied
  mark=gpu.log.length;atlas.growPool('cell');const g=atlas.snapshot();
  assert.equal(g.book,s.book);assert.equal(g.lightBook,s.lightBook);assert.deepEqual(book(g),atlas.entries);
  assert.equal(gpu.log.slice(mark).filter(e=>(e[0]==='writeBuffer'&&/immutable (light )?book/.test(e[1]))||e[0]==='copyBuffer').length,0);
  // a removal clears chunks; the old snapshot keeps its own book
  atlas.remove([[255,63,255]]);const r=atlas.snapshot();
  assert.deepEqual(book(r),atlas.entries);assert.equal(book(r)[A.worldBrickIndex(atlas.bookLayout,[255,63,255])],0);
  assert.notEqual(book(s)[A.worldBrickIndex(atlas.bookLayout,[255,63,255])],0);
  // a small book is made the same way (Island's is 8 MiB)
  const small=setup(),smallMark=small.gpu.log.length;
  const j=small.atlas.allocate([1,1,1],{sourceRevision:1});small.atlas.update(j,dataFor(j));small.atlas.publish(j);
  assert.ok(small.gpu.log.slice(smallMark).some(e=>e[0]==='copyBuffer'&&e[1]==='world book copy'));
  assert.ok(small.gpu.log.slice(smallMark).filter(e=>e[0]==='writeBuffer'&&/immutable (light )?book/.test(e[1])).every(e=>e[3]<=16384*4));
  const ss=small.atlas.snapshot();assert.deepEqual(new Uint32Array(ss.book.data.buffer,0,small.atlas.bookLayout.count),small.atlas.entries);ss.release();
  // a reset starts both books from zeros: nothing sent, nothing copied
  mark=gpu.log.length;atlas.reset();const z=atlas.snapshot();
  assert.ok(book(z).every(v=>v===0)&&light(z).every(v=>v===0));
  assert.equal(gpu.log.slice(mark).filter(e=>(e[0]==='writeBuffer'&&/immutable (light )?book/.test(e[1]))||e[0]==='copyBuffer').length,0);
  z.release();
  // a shared book outlives every snapshot but the last that holds it
  s.release();gpu.flush();assert.ok(!g.book.destroyed,'growth snapshot still reads the shared book');
  g.release();r.release();atlas.dispose();gpu.flush();
  assert.ok(gpu.buffers.filter(b=>/immutable (light )?book/.test(b.label)).every(b=>b.destroyed),'every book destroyed exactly once at the end');
});
test('original slot bijection, 32-core / page edges and array-layer geometry', () => {
  const slots=new Set();
  for(let z=0;z<4;z++) for(let y=0;y<4;y++) for(let x=0;x<4;x++) {
    const s=A.worldLocalSlot([x,y,z]); slots.add(s); assert.deepEqual(A.worldSlotCell(s),[x,y,z]);
    assert.equal(s,cellSlot({nx:128,ny:384,nz:128},x+32,y+124,z+64)&63);
  }
  assert.equal(slots.size,64);
  const book=A.worldBookLayout([128,384,128]);
  for(const p of [4,32,64]) for(const e of [-0.001,0,0.001]) assert.equal(A.worldCellAddress(book,[Math.floor(p+e),0,0]).brick[0],Math.floor((p+e)/4));
  for(const cap of [1,64,65,128,129,257]) {
    const l=A.worldAtlasLayout(cap,{maxTextureDimension2D:32,maxTextureArrayLayers:64},0,cap);
    const cells=new Set(), aux=new Set(), probes=new Set();
    for(let pid=0;pid<cap;pid++) {
      for(let s=0;s<64;s++) cells.add(A.pageTexel(pid,s,l).join(','));
      for(let r=0;r<132;r++) aux.add(A.auxTexel(pid,r,l).join(','));
      probes.add(A.probeTexel(pid,l).join(','));
    }
    assert.equal(cells.size,cap*64); assert.equal(aux.size,cap*132); assert.equal(probes.size,cap);
    assert.ok(l.cells.width<=32 && l.aux.layers<=64);
  }
  assert.throws(()=>A.worldAtlasLayout(2**32));
  assert.throws(()=>A.worldAtlasLayout(1024,{maxTextureDimension2D:8,maxTextureArrayLayers:1}));
  const webIDL=Object.create(Object.defineProperties({}, {
    maxTextureDimension2D:{get:()=>8}, maxTextureArrayLayers:{get:()=>1},
    maxStorageBufferBindingSize:{get:()=>1024}, maxSampledTexturesPerShaderStage:{get:()=>15},
  }));
  assert.throws(()=>A.worldAtlasLayout(64,webIDL));
  assert.throws(()=>A.worldBookLayout([128,128,128],webIDL));
  assert.throws(()=>A.worldReaderLayouts(webIDL));
});
test('aux ABI preserves complete BrickInfo, flow/aer half words and cell paint', () => {
  const job={epoch:17,sourceRevision:19,fieldTick:23,readyBits:7}, d=dataFor(job).aux;
  assert.equal(d.length,132*4); assert.deepEqual([...d.subarray(0,4)],[7,17,19,23]);
  assert.deepEqual([...d.subarray(4,8)],[0x7f800001,0x80000000,0x7fc12345,0]);
  for(let s=0;s<64;s++) assert.deepEqual([...d.subarray(16+s*8,24+s*8)],[0x7c018000,0x7c018000,0xfe017fff,0xfe017fff,0xfefdfcff,0,0,0]);
  assert.throws(()=>A.packWorldAux({...job,flow:new Uint32Array(64)}));
});
test('lossless uploads, immutable publication, replacement workspace, growth, snapshots, retirement', () => {
  const {gpu,atlas}=setup({}, {maxTextureDimension2D:32,maxTextureArrayLayers:64});
  assert.ok(gpu.textures.every(t=>t.usage===15 && t.dimension==='2d'),'copy/sample/storage flags on own array textures');
  const a=atlas.allocate([7,7,7],{sourceRevision:1}), data=dataFor(a);
  const before=atlas.snapshot(), generation=atlas.generation;
  atlas.update(a,{stateA:data.stateA});
  assert.throws(()=>atlas.publish(a),/partial/); assert.equal(atlas.generation,generation);
  assert.equal(atlas.lookup([7,7,7]).incomplete,true);
  atlas.update(a,data); atlas.publish(a);
  const first=atlas.snapshot(); assert.equal(atlas.lookup([7,7,7]).physicalPageID,0);
  assert.equal(new Uint32Array(before.book.data.buffer)[A.worldBrickIndex(atlas.bookLayout,[7,7,7])],0);
  for(const name of Object.keys(data)) assert.deepEqual(readChannel(first,name,0),rawBytes(data[name]));
  const replacement=atlas.allocate([7,7,7],{sourceRevision:2}); assert.notEqual(replacement.physicalPageID,a.physicalPageID);
  const d2=dataFor(replacement,1); atlas.update(replacement,d2);
  // Repack BOTH dimensions and array layers, while provider owns old outputs.
  atlas.grow(257); const grown=atlas.snapshot();
  assert.notEqual(first.views.stateA,grown.views.stateA);
  assert.equal(first.layout.capacity,2); assert.equal(grown.layout.capacity,257);
  for(const name of Object.keys(data)) assert.deepEqual(readChannel(grown,name,0),rawBytes(data[name]));
  atlas.publish(replacement); const last=atlas.snapshot();
  for(const name of Object.keys(data)) {
    assert.deepEqual(readChannel(first,name,0),rawBytes(data[name]));
    assert.deepEqual(readChannel(last,name,replacement.physicalPageID),rawBytes(d2[name]));
  }
  gpu.flush(); assert.ok(!first.views.stateA.texture.destroyed,'old snapshot owns resources');
  before.release(); grown.release(); last.release(); first.release(); gpu.flush();
  assert.ok(gpu.log.some(x=>x[0]==='copy'&&x[1]==='world pending repack'));
  assert.ok(gpu.log.some(x=>x[0]==='copy'&&x[1]==='world atlas growth'));
  atlas.dispose(); gpu.flush();
  assert.ok(gpu.textures.every(t=>t.destroyed)); assert.ok(gpu.buffers.every(b=>b.destroyed));
});
test('revisions, readiness, stale work, required/pending/snapshot protection and ownership', () => {
  const {gpu,atlas}=setup(); const j=atlas.allocate([0,0,0],{sourceRevision:9,fieldTick:8}); atlas.update(j,dataFor(j)); atlas.publish(j);
  assert.throws(()=>atlas.allocate([0,0,0],{sourceRevision:8}));
  assert.throws(()=>atlas.allocate([0,0,0],{sourceRevision:9,fieldTick:7}));
  assert.throws(()=>atlas.allocate([0,0,0],{sourceRevision:10,readyBits:A.READY.RAW}));
  atlas.require([[0,0,0]]); assert.throws(()=>atlas.remove([[0,0,0]]));
  atlas.require([]); const snap=atlas.snapshot(); atlas.remove([[0,0,0]]); gpu.flush();
  assert.ok(atlas.pages.has(j.physicalPageID),'snapshot pins old page'); snap.release(); gpu.flush(); assert.ok(!atlas.pages.has(j.physicalPageID));
  const pending=atlas.allocate([0,0,0],{sourceRevision:10});
  assert.throws(()=>atlas.remove([[0,0,0]])); assert.throws(()=>atlas.allocate([0,0,0],{sourceRevision:11}));
  const bad=dataFor(pending); bad.aux[2]++; assert.throws(()=>atlas.update(pending,bad),/metadata/);
  assert.equal(atlas.pages.get(pending.physicalPageID).written.size,0,'validation before ANY upload');
  assert.throws(()=>atlas.update(pending,{stateA:new Float32Array(256)}));
  atlas.reset(); assert.throws(()=>atlas.update(pending,dataFor(pending)),/stale/); assert.throws(()=>atlas.publish(j),/stale/);
  const raw=atlas.allocate([0,0,0],{sourceRevision:0,readyBits:A.READY.RAW}); const d=dataFor(raw);
  atlas.update(raw,{stateA:d.stateA,stateB:d.stateB,aux:d.aux}); atlas.publish(raw);
  assert.equal(atlas.lookup([0,0,0],A.READY.RAW).known,true); assert.equal(atlas.lookup([0,0,0],A.READY.FIELD).incomplete,true);
  const old=atlas.snapshot(), external=Object.fromEntries(['sunDepth','sunOptical','mediaNoise','sourceAppearance','packedMesh'].map(n=>[n,{external:n}]));
  const feedback=gpu.device.createBuffer({size:atlas.feedbackBytes,usage:128});
  const binding=old.bindings(external,feedback); assert.equal(binding.flat().length,20); assert.equal(binding[2][9].resource,external.packedMesh);
  assert.throws(()=>old.bindings({},feedback)); assert.throws(()=>old.bindings(external,{size:4}));
  atlas.dispose(); assert.throws(()=>atlas.snapshot(),/disposed/); assert.throws(()=>atlas.publish(raw),/disposed/);
  gpu.flush(); assert.ok(!old.views.stateA.texture.destroyed); old.release(); old.release(); gpu.flush();
  feedback.destroy(); assert.ok(gpu.textures.every(t=>t.destroyed)); assert.ok(gpu.buffers.every(b=>b.destroyed));
  assert.equal(external.packedMesh.destroyed,undefined,'no external ownership');
});
test('batch publication is all-or-nothing and old snapshot params stay stable', () => {
  const {atlas,gpu}=setup();
  const a=atlas.allocate([0,0,0],{sourceRevision:1}), b=atlas.allocate([1,0,0],{sourceRevision:1});
  const before=atlas.snapshot(), paramsBefore=before.params.data.slice(), generation=atlas.generation;
  atlas.update(a,dataFor(a));
  assert.throws(()=>atlas.publish([a,b]),/partial/);
  assert.equal(atlas.generation,generation); assert.equal(atlas.lookup([0,0,0]).known,false);
  atlas.update(b,dataFor(b)); atlas.publish([a,b]);
  assert.equal(atlas.generation,generation+1); assert.equal(atlas.lookup([0,0,0]).known,true); assert.equal(atlas.lookup([1,0,0]).known,true);
  assert.deepEqual(before.params.data,paramsBefore); assert.equal(before.generation,generation);
  atlas.reset(); assert.deepEqual(before.params.data,paramsBefore);
  before.release(); atlas.dispose(); gpu.flush();
});
test('publication/growth/reset allocation failures retain prior mapping, epoch and resources', () => {
  const {atlas,gpu}=setup(), j=atlas.allocate([0,0,0],{sourceRevision:1}); atlas.update(j,dataFor(j));
  const create=gpu.device.createBuffer;
  const fail=()=>{gpu.device.createBuffer=d=>{if(d.label==='world immutable params') throw new Error('injected allocation failure');return create(d);};};
  const generation=atlas.generation; fail();
  assert.throws(()=>atlas.publish(j),/injected/); assert.equal(atlas.generation,generation); assert.equal(atlas.lookup([0,0,0]).known,false);
  gpu.device.createBuffer=create; atlas.publish(j); const published=atlas.snapshot(), g=atlas.generation, epoch=atlas.epoch;
  fail(); assert.throws(()=>atlas.grow(128),/injected/); assert.equal(atlas.generation,g); assert.equal(atlas.resources.layout.capacity,2);
  assert.throws(()=>atlas.reset(),/injected/); assert.equal(atlas.epoch,epoch); assert.equal(atlas.lookup([0,0,0]).known,true);
  const unchanged=atlas.snapshot(); assert.equal(unchanged.views.stateA,published.views.stateA); unchanged.release();
  gpu.device.createBuffer=create; published.release(); atlas.dispose(); gpu.flush();
  assert.ok(gpu.textures.every(t=>t.destroyed)); assert.ok(gpu.buffers.every(b=>b.destroyed));
});
test('provider writer snapshots have private outputs; no partial publication from one writer', () => {
  const {atlas,gpu}=setup(); const job=atlas.allocate([0,0,0],{sourceRevision:1});
  assert.throws(()=>atlas.recordPageWrite(job,'raw',{auxMetadata:[0,0,0,0],record(){}}));
  const w=atlas.writerBindings(job,'raw'); assert.equal(w.outputs.length,3); assert.equal(w.params[0],job.physicalPageID);
  atlas.recordPageWrite(job,'raw',{auxMetadata:[job.readyBits,job.epoch,job.sourceRevision,job.fieldTick],record(encoder,bindings){ assert.equal(bindings.outputs.length,3); }});
  assert.throws(()=>atlas.publish(job),/partial/);
  atlas.cancel(job); assert.throws(()=>atlas.writerBindings(job,'raw'),/stale/); atlas.dispose(); gpu.flush();
});
test('provider write batch shares one submission and marks no channel before submission',()=>{
  const {atlas,gpu}=setup({initialCapacity:4}),jobs=[0,1].map(x=>atlas.allocate([x,0,0],{sourceRevision:1}));
  const pages=jobs.map(j=>atlas.cell.pages.get(j.physicalPageID)),encoders=new Set(),order=[];
  const submit=gpu.device.queue.submit.bind(gpu.device.queue);
  let submissions=0;gpu.device.queue.submit=commands=>{
    submissions++;assert(pages.every(p=>p.written.size===0));order.push('submit');submit(commands);
  };
  assert.deepEqual(atlas.recordPageWrites([]),[]);assert.equal(submissions,0);
  const writes=jobs.flatMap((job,i)=>['raw','fields'].map(kind=>({job,kind,
    auxMetadata:[job.readyBits,job.epoch,job.sourceRevision,job.fieldTick],
    record(encoder,bindings){encoders.add(encoder);order.push(`${i}:${kind}`);assert(pages.every(p=>p.written.size===0));
      if(kind==='fields')assert.equal(bindings.destinations.length,3);}
  })));
  assert.deepEqual(atlas.recordPageWrites(writes),writes.map(w=>w.job));
  assert.equal(encoders.size,1);assert.equal(submissions,1);
  assert.deepEqual(order,['0:raw','0:fields','1:raw','1:fields','submit']);
  assert(pages.every(p=>p.written.size===6));
  for(const job of jobs)atlas.cancel(job);atlas.dispose();gpu.flush();
});
test('provider batch recording or submission failure cannot mark an unpublished prefix ready',()=>{
  const {atlas,gpu}=setup(),job=atlas.allocate([0,0,0],{sourceRevision:1}),page=atlas.cell.pages.get(job.physicalPageID);
  const raw={job,kind:'raw',auxMetadata:[job.readyBits,job.epoch,job.sourceRevision,job.fieldTick],record(){}};
  const error=Error('batch prefix rejected'),submit=gpu.device.queue.submit.bind(gpu.device.queue);let submissions=0;
  gpu.device.queue.submit=commands=>{submissions++;submit(commands);};
  assert.throws(()=>atlas.recordPageWrites([raw,{job,kind:'fields',record(){throw error;}}]),e=>e===error);
  assert.equal(submissions,0);assert.equal(atlas.recording,false);assert.equal(page.written.size,0);
  assert.throws(()=>atlas.publish(job),/partial/);
  gpu.device.queue.submit=()=>{throw error;};
  assert.throws(()=>atlas.recordPageWrites([raw,{job,kind:'fields',record(){}}]),e=>e===error);
  assert.equal(page.written.size,0);assert.throws(()=>atlas.publish(job),/partial/);
  gpu.device.queue.submit=submit;atlas.cancel(job);atlas.dispose();gpu.flush();
});
test('known empty vs unknown and canonical feedback (including bit31)', () => {
  const {atlas,gpu}=setup(); const feedback=new Uint32Array(atlas.bookLayout.requestBytes/4);
  for(const c of [[0,0,0],[31,0,0],[0,1,0]]) { const miss=atlas.lookup(c); assert.equal(miss.known,false); A.requestMissing(feedback,miss.request); }
  assert.deepEqual(A.requestedBricks(feedback,atlas.bookLayout.count),[0,31,32]);
  const j=atlas.allocate([0,0,0],{sourceRevision:0}); const d=dataFor(j); d.aux.fill(0,4); atlas.update(j,d); atlas.publish(j);
  assert.equal(atlas.lookup([0,0,0]).known,true); assert.equal(atlas.lookup([1,0,0]).known,false);
  atlas.dispose(); gpu.flush();
});
// Independent nested-lerp and Sigg-fold references to EXISTING core.js.
function linearReference(fetch,p,size) {
  const q=p.map((v,i)=>Math.max(.5,Math.min(size[i]-.5,v))-.5), base=q.map(Math.floor), f=q.map((v,i)=>v-base[i]);
  const at=(x,y,z)=>fetch([x,y,z].map((v,i)=>Math.min(size[i]-1,base[i]+v)));
  const mix=(a,b,t)=>a*(1-t)+b*t;
  const row=(y,z)=>mix(at(0,y,z),at(1,y,z),f[0]);
  const plane=z=>mix(row(0,z),row(1,z),f[1]);
  return mix(plane(0),plane(1),f[2]);
}
function sigg(fetch,p,size) {
  const q=p.map((v,i)=>Math.max(0,Math.min(size[i]-1,v-.5))), base=q.map(Math.floor), f=q.map((v,i)=>v-base[i]);
  const w=f.map(t=>[(1-3*t+3*t*t-t*t*t)/6,(4-6*t*t+3*t*t*t)/6,(1+3*t+3*t*t-3*t*t*t)/6,t*t*t/6]), g=w.map(v=>[v[0]+v[1],v[2]+v[3]]);
  const positions=w.map((v,i)=>[base[i]-.5+v[1]/g[i][0],base[i]+1.5+v[3]/g[i][1]]);
  let out=0;
  for(let z=0;z<2;z++) for(let y=0;y<2;y++) for(let x=0;x<2;x++) out+=linearReference(fetch,[positions[0][x],positions[1][y],positions[2][z]],size)*g[0][x]*g[1][y]*g[2][z];
  return out;
}
test('8/64 tap interpolation + gradients independent of partitions/physical IDs; world-only edge clamp', () => {
  const size=[68,40,36], l=A.worldAtlasLayout(2048), book=A.worldBookLayout(size);
  const analytic=([x,y,z])=>Math.sin(x*.31)+Math.cos(y*.17)+z*z*.001;
  const map=new Map(), pageMap=new Map(); let id=0;
  for(let z=0;z<size[2];z++) for(let y=0;y<size[1];y++) for(let x=0;x<size[0];x++) {
    const c=[x,y,z], a=A.worldCellAddress(book,c);
    if(!pageMap.has(a.index)) pageMap.set(a.index,(id++*137)%2048);
    map.set(A.pageTexel(pageMap.get(a.index),a.slot,l).join(','),analytic(c));
  }
  const fetch=c=>{const a=A.worldCellAddress(book,c); return map.get(A.pageTexel(pageMap.get(a.index),a.slot,l).join(','));};
  const points=[];
  for(const e of [-.001,0,.001]) for(const edge of [4,32,64]) points.push([edge+e,7.2,19.6]);
  points.push([0,0,0],[68,40,36],[-5,8,7],[70,44,40]);
  for(const p of points) for(const cubic of [false,true]) {
    const actual=A.worldInterpolate(fetch,p,size,cubic), expected=cubic?sigg(analytic,p,size):linearReference(analytic,p,size);
    assert.ok(Math.abs(actual-expected)<1e-12,`${p}: ${actual} != ${expected}`);
    for(let axis=0;axis<3;axis++) {
      const h=.0001, a=[...p], b=[...p]; a[axis]-=h; b[axis]+=h;
      const gradient=(fn)=>(A.worldInterpolate(fn,b,size,cubic)-A.worldInterpolate(fn,a,size,cubic))/(2*h);
      const expectedGradient=((cubic?sigg:linearReference)(analytic,b,size)-(cubic?sigg:linearReference)(analytic,a,size))/(2*h);
      assert.ok(Math.abs(gradient(fetch)-expectedGradient)<1e-8);
    }
  }
  let taps=0; A.worldInterpolate(()=>{taps++;return 1;},[32.1,4.1,4.1],size); assert.equal(taps,8);
  taps=0; A.worldInterpolate(()=>{taps++;return 1;},[32.1,4.1,4.1],size,true); assert.equal(taps,64);
});
test('SH/probe and glow world-fixed spacing-four phase and edge extension', () => {
  const size=[128,384,128], f=([x,y,z])=>[x,y,z,x+y+z];
  assert.deepEqual(A.worldInterpolate(f,[2,2,2],size,false,4),[0,0,0,0]);
  assert.deepEqual(A.worldInterpolate(f,[6,6,6],size,false,4),[1,1,1,3]);
  assert.deepEqual(A.worldInterpolate(f,[4,4,4],size,false,4),[.5,.5,.5,1.5]);
  assert.deepEqual(A.worldInterpolate(f,[128,384,128],size,false,4),[31,95,31,157]);
  assert.deepEqual(A.worldInterpolate(f,[34,34,34],size,false,4),[8,8,8,24]);
});
test('packed mesh all half patterns + HDR/depth/coverage independent of colour/depth zero', () => {
  for(let h=0;h<65536;h++) {
    const halfWords=new Uint16Array([h,h^65535,0x7bff,0x8000]), depthBits=(h*65537)>>>0, coverageFlags=(h&1)?0xf0000001:0;
    assert.deepEqual(A.unpackMeshWords(A.packMeshWords(halfWords,depthBits,coverageFlags)),{halfWords,depthBits,coverageFlags});
  }
  assert.throws(()=>A.packMeshWords([65536,0,0,0],0,0));
});
test('Naga validates ACTUAL new reader and every writer assembly, no GPU', () => {
  const dir=mkdtempSync(join(tmpdir(),'world-atlas-wgsl-'));
  try {
    const reader=worldAccessWGSL()+giSrcWGSL+`
@fragment fn main() -> @location(0) vec4f {
 worldBeginQuery(); let c=vec3i(4,32,3); let p=vec3f(4.01,32.01,3.01);
 let a=worldFetchA(c)+worldFetchB(c)+vec4f(worldFlow(c),0.0)+worldAeration(c);
 let b=worldFieldLinear(worldField0,p)+worldFieldCubic(worldField1,p)+worldFieldCubic(worldField2,p);
 let source=worldGISource(c/4); let packedAir=giSrcPack(vec3f(0.0),vec3f(0.0),vec3f(0.0));
 let gi=worldProbe(p); let bi=worldBrickInfo(c/4); let occ=worldBrickOccupancy(c/4);
 let dist=worldBrickDistance(c/4); let mesh=worldMeshAt(vec2i(0));
 let imports=textureLoad(worldSourceAppearance,vec3i(0),0);
 let noise=textureLoad(worldMediaNoise,vec3i(0),0);
 let sun=textureLoad(worldSunDepth,vec2i(0),0,0)+textureLoad(worldSunOptical,vec2i(0),0,0);
 if(worldQueryIncomplete()) { discard; }
 return a+b+gi.c0+gi.cx+gi.cy+gi.cz+vec4f(worldLight(p),0.0)+vec4f(bi.emit,0.0)+mesh.color+noise+sun+vec4f(f32(worldDeco(c)+occ.x+imports.x+bi.info)+f32(dist));
}`;
    const modules={reader,mesh:worldPackedMeshWriterWGSL(),shadow:worldShadowWriterWGSL()+`\n@compute @workgroup_size(1) fn main(){worldStoreShadow(vec2i(0),0,1.0,0.0);}`,...Object.fromEntries([...Object.keys(A.WRITER_CHANNELS),'source'].map(k=>[k,worldPageWriterWGSL(k)]))};
    for(const [name,code] of Object.entries(modules)) {
      const path=join(dir,`${name}.wgsl`); writeFileSync(path,code);
      const result=spawnSync(process.env.NAGA??'naga',[path],{encoding:'utf8'});
      assert.equal(result.status,0,`${name}: ${result.error??''}\n${result.stdout}\n${result.stderr}`);
    }
    for(const fixture of WGSL_CHECK) {
      const path=join(dir,`${fixture.name}.wgsl`); writeFileSync(path,fixture.code());
      const result=spawnSync(process.env.NAGA??'naga',[path],{encoding:'utf8'});
      assert.equal(result.status,0,`${fixture.name}: ${result.error??''}\n${result.stdout}\n${result.stderr}`);
    }
    assert.equal((reader.match(/var world\w+: texture_/g)??[]).length,16);
    console.log(`Naga: ${Object.keys(modules).join(', ')} validated`);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

const AIR_SOURCE = new Uint32Array([0, 0, 0, 511 | (511 << 10) | (511 << 20)]);
function lightData(job, source = AIR_SOURCE) {
  const data = {};
  if (job.readyBits & A.READY.GI_SOURCE) data.source = source;
  if (job.readyBits & A.READY.GI) for (let i=0;i<4;i++) data[`gi${i}`] = new Uint16Array([0x3c00+i,0x8000,0x7bff,0x7e01]);
  if (job.readyBits & A.READY.GLOW) data.glow = new Uint16Array([0x4000,0x4200,0x4400,0]);
  return data;
}
function readDescriptor(snapshot, id, record) {
  return new Uint32Array(snapshot.views.aux.texture.get(A.lightTexel(id,record,snapshot.layout)).buffer);
}
test('source-only and light-only real factories allocate no cell channels; all three IDs genuinely differ',()=>{
  const {atlas,gpu}=setup({initialCapacity:0});
  const initial=atlas.snapshot(), cellViews=['stateA','stateB','field0','field1','field2'].map(k=>initial.views[k]);
  const source=atlas.allocateLight([1,0,0],{sourceRevision:3,sourceTick:11,readyBits:A.READY.GI_SOURCE});
  assert.equal(source.probePID,null); assert.throws(()=>atlas.updateLight(source,{stateA:new Uint32Array(256)}),/channel/); atlas.updateLight(source,lightData(source)); atlas.publish(source);
  assert.equal(atlas.cell.pages.size,0); assert.equal(atlas.probe.pages.size,0);
  assert.equal(atlas.resources.layout.capacity,0); assert.equal(atlas.resources.layout.probeCapacity,0);
  assert.deepEqual(['stateA','stateB','field0','field1','field2'].map(k=>atlas.resources.views[k]),cellViews);
  assert.equal(atlas.lookup([1,0,0],A.READY.GI_SOURCE).known,true);
  assert.equal(atlas.lookup([1,0,0],A.READY.GI|A.READY.GLOW).missingChannels,A.READY.GI|A.READY.GLOW);
  assert.throws(()=>atlas.updateLight(source,{glow:new Uint16Array(4)}),/stale/);
  const cell=atlas.allocate([2,0,0],{sourceRevision:3}); atlas.update(cell,dataFor(cell));
  const light=atlas.allocateLight([2,0,0],{sourceRevision:3,sourceTick:12,giTick:23,glowTick:34});
  // Descriptor1 and probe0 are independent. Allocate another source to make
  // the next descriptor2/probe1 distinct from cell0 as well.
  atlas.cancel(light); gpu.flush();
  const reserved=atlas.allocateLight([3,0,0],{sourceRevision:3,readyBits:A.READY.GI});
  const unequal=atlas.allocateLight([2,0,0],{sourceRevision:3,sourceTick:12,giTick:23,glowTick:34});
  assert.equal(new Set([cell.physicalPageID,unequal.lightDescriptorID,unequal.probePID]).size,3);
  atlas.updateLight(unequal,lightData(unequal));
  atlas.publish({cellJobs:[cell],lightJobs:[unequal]});
  const s=atlas.snapshot();
  assert.deepEqual([...readDescriptor(s,source.lightDescriptorID,4)],[...AIR_SOURCE]);
  const uniform=new Uint32Array(s.params.data.buffer);
  assert.equal(uniform.length,28);
  assert.deepEqual([...uniform.subarray(20,24)],[s.layout.descriptorBase,s.layout.lightCapacity,5,s.dependencies.version]);
  assert.deepEqual([...uniform.subarray(24,28)],[atlas.bookLayout.planeWords,atlas.bookLayout.statusWord,atlas.bookLayout.sunWord,0]);
  assert.equal(readDescriptor(s,unequal.lightDescriptorID,3)[3],s.generation);
  const refs=readDescriptor(s,unequal.lightDescriptorID,1);
  assert.deepEqual([...refs],[unequal.probePID+1,unequal.probePID+1,23,34]);
  assert.equal(atlas.lookup([2,0,0],A.READY.ALL).known,true);
  atlas.updateLight(reserved,lightData(reserved));atlas.publish(reserved);
  assert.equal(atlas.lookup([3,0,0],A.READY.GI).known,true);
  assert.equal(atlas.lookup([3,0,0],A.READY.GI_SOURCE|A.READY.GLOW).missingChannels,A.READY.GI_SOURCE|A.READY.GLOW);
  const glow=atlas.allocateLight([4,0,0],{sourceRevision:3,readyBits:A.READY.GLOW,glowTick:8});atlas.updateLight(glow,lightData(glow));atlas.publish(glow);
  const only=atlas.snapshot();
  assert.deepEqual([...readDescriptor(only,reserved.lightDescriptorID,1)],[reserved.probePID+1,0,0,0]);
  assert.deepEqual([...readDescriptor(only,glow.lightDescriptorID,1)],[0,glow.probePID+1,0,8]);
  assert.equal(atlas.lookup([4,0,0],A.READY.GLOW).known,true);
  assert.equal(atlas.lookup([4,0,0],A.READY.GI_SOURCE|A.READY.GI).missingChannels,A.READY.GI_SOURCE|A.READY.GI);
  only.release(); initial.release(); s.release(); atlas.dispose(); gpu.flush();
  assert.ok(gpu.textures.every(t=>t.destroyed));
});
test('independent pool growth/repack, pending old views, cross-pool replacement and per-pool retirement pins',()=>{
  const {atlas,gpu}=setup({initialCapacity:1},{maxTextureDimension2D:32,maxTextureArrayLayers:64});
  const c=atlas.allocate([0,0,0],{sourceRevision:1});atlas.update(c,dataFor(c));
  const l=atlas.allocateLight([0,0,0],{sourceRevision:1});const ld=lightData(l);atlas.updateLight(l,ld);
  atlas.publish({cellJobs:[c],lightJobs:[l]});const old=atlas.snapshot(), oldAux=readDescriptor(old,l.lightDescriptorID,4).slice();
  const c2=atlas.allocate([0,0,0],{sourceRevision:2});atlas.update(c2,dataFor(c2,8));
  const l2=atlas.allocateLight([0,0,0],{sourceRevision:2,sourceTick:4,giTick:5,glowTick:6});atlas.updateLight(l2,lightData(l2,new Uint32Array([1,2,3,4])));
  // Cell growth changes descriptorBase even if aux dimensions happen to match.
  const before=atlas.snapshot();atlas.grow(9);const cellsGrown=atlas.snapshot();
  assert.notEqual(before.views.aux,cellsGrown.views.aux);assert.equal(before.views.gi0,cellsGrown.views.gi0);
  atlas.growPool('light',13);const descGrown=atlas.snapshot();
  assert.equal(descGrown.views.stateA,cellsGrown.views.stateA);
  atlas.growPool('probe',129);const probesGrown=atlas.snapshot();
  assert.equal(probesGrown.views.aux,descGrown.views.aux);assert.notEqual(probesGrown.views.gi0,descGrown.views.gi0);
  for(const s of [before,cellsGrown,descGrown,probesGrown]) {
    assert.deepEqual([...readDescriptor(s,l.lightDescriptorID,4)],[...oldAux]);
    assert.deepEqual(readChannel(s,'gi2',l.probePID),rawBytes(ld.gi2));
  }
  const generation=atlas.generation;
  assert.throws(()=>atlas.publish(c2),/incompatible cell\/light/);assert.equal(atlas.generation,generation);
  atlas.publish({cellJobs:[c2],lightJobs:[l2]});const fresh=atlas.snapshot();
  assert.deepEqual([...readDescriptor(fresh,l2.lightDescriptorID,4)],[1,2,3,4]);
  assert.deepEqual([...readDescriptor(old,l.lightDescriptorID,4)],[...oldAux]);
  atlas.remove([[0,0,0]]);gpu.flush();
  assert.ok(atlas.cell.pages.has(c.physicalPageID));assert.ok(atlas.light.pages.has(l.lightDescriptorID));assert.ok(atlas.probe.pages.has(l.probePID));
  for(const s of [old,before,cellsGrown,descGrown,probesGrown])s.release();gpu.flush();
  assert.ok(!atlas.cell.pages.has(c.physicalPageID));assert.ok(!atlas.light.pages.has(l.lightDescriptorID));assert.ok(!atlas.probe.pages.has(l.probePID));
  assert.ok(atlas.probe.pages.has(l2.probePID));fresh.release();gpu.flush();assert.equal(atlas.probe.pages.size,0);
  atlas.dispose();gpu.flush();assert.ok(gpu.textures.every(t=>t.destroyed));assert.ok(gpu.buffers.every(b=>b.destroyed));
});
test('source/gi/glow readiness upgrade, independent clocks and dependency manifests publish atomically',()=>{
  const {atlas,gpu}=setup();const b=[0,0,0], dependencyToken={version:1,sets:[{id:9,version:2}]};
  const source=atlas.allocateLight(b,{sourceRevision:1,sourceTick:3,readyBits:A.READY.GI_SOURCE,dependencies:{source:{id:9,version:2}}});
  atlas.updateLight(source,lightData(source));assert.throws(()=>atlas.publish(source),/dependency/);
  atlas.publish({lightJobs:[source],dependencyToken});const old=atlas.snapshot();dependencyToken.sets[0].version=99;
  assert.equal(old.dependencies.sets[0].version,2);
  const requirements=atlas.require([{brick:b,channels:A.READY.ALL}]);
  assert.equal(requirements[0].channels,A.READY.CELL|A.READY.GI|A.READY.GLOW);
  assert.equal(atlas.require([{brick:b,channels:A.READY.GI_SOURCE}]).length,0);
  assert.throws(()=>atlas.allocateLight(b,{sourceRevision:2,sourceTick:2,readyBits:A.READY.GI_SOURCE}),/tick regression/);
  const upgrade=atlas.allocateLight(b,{sourceRevision:1,sourceTick:4,giTick:5,glowTick:6,dependencies:{source:{id:9,version:2},gi:{id:10,version:3},glow:{id:11,version:4}}});
  atlas.updateLight(upgrade,{source:AIR_SOURCE});assert.throws(()=>atlas.publish(upgrade),/partial/);
  atlas.updateLight(upgrade,lightData(upgrade));
  const gen=atlas.generation;assert.throws(()=>atlas.publish(upgrade),/dependency/);assert.equal(atlas.generation,gen);
  assert.throws(()=>atlas.publish({lightJobs:[upgrade],dependencyToken:{version:1,sets:[{id:9,version:2},{id:10,version:3},{id:11,version:4}]}}),/new manifest version/);
  atlas.publish({lightJobs:[upgrade],dependencyToken:{version:2,sets:[{id:9,version:2},{id:10,version:3},{id:11,version:4}]}});
  assert.equal(atlas.require([{brick:b,channels:A.READY.LIGHT}]).length,0);
  assert.throws(()=>atlas.publish({dependencyToken:{version:3,sets:[{id:9,version:200}]}}),/dependency/);
  const s=atlas.snapshot();assert.deepEqual([...readDescriptor(s,upgrade.lightDescriptorID,2)],[9,2,10,3]);
  assert.deepEqual([...readDescriptor(s,upgrade.lightDescriptorID,3)].slice(0,3),[11,4,A.WORLD_ATLAS_ABI]);
  old.release();s.release();atlas.dispose();gpu.flush();
});
test('light jobs delayed/cancel/reset/failure, non-reentrant synchronous source/GI/glow recorders',()=>{
  const {atlas,gpu}=setup();
  const j=atlas.allocateLight([0,0,0],{sourceRevision:1});
  assert.throws(()=>atlas.publish({cellJobs:[j]}),/kind mismatch/);
  assert.throws(()=>atlas.recordPageWrite(j,'raw',{record(){}}),/writer does not belong/);
  const w=atlas.writerBindings(j,'source');assert.equal(w.outputs[0].resource,atlas.resources.views.aux);
  assert.equal(w.params[12],atlas.resources.layout.descriptorBase+j.lightDescriptorID*A.LIGHT_RECORDS+4);
  assert.throws(()=>atlas.recordLightWrite(j,'source',{record(){atlas.reset();}}),/non-reentrant/);
  assert.throws(()=>atlas.recordLightWrite(j,'source',{record:async()=>{}}),/synchronous/);
  assert.throws(()=>atlas.recordLightWrite(j,'source',{record(){return Promise.resolve();}}),/synchronous/);
  assert.throws(()=>atlas.publish(j),/partial/);
  atlas.recordLightWrite(j,'source',{record(encoder,bindings){assert.equal(bindings.outputs.length,1);}});
  atlas.recordLightWrite(j,'gi',{record(encoder,bindings){assert.equal(bindings.params[0],j.probePID);assert.equal(bindings.outputs.length,4);}});
  atlas.recordLightWrite(j,'glow',{record(){}});
  const before=atlas.snapshot(), generation=atlas.generation, create=gpu.device.createBuffer;
  gpu.device.createBuffer=d=>{if(d.label==='world immutable light book')throw new Error('injected second-book failure');return create(d);};
  assert.throws(()=>atlas.publish(j),/injected/);assert.equal(atlas.generation,generation);assert.equal(atlas.lookup([0,0,0],A.READY.LIGHT).known,false);
  // a growth shares the current books, so it makes no light book to fail (params failures: the allocation-failure test)
  assert.throws(()=>atlas.reset(),/injected/);assert.equal(atlas.epoch,before.epoch);
  gpu.device.createBuffer=create;atlas.publish(j);const retained=atlas.snapshot();
  const createTexture=gpu.device.createTexture, generationBeforeViewFailure=atlas.generation;
  gpu.device.createTexture=d=>{const t=createTexture(d);if(d.label==='world gi1')t.createView=()=>{throw new Error('injected view failure');};return t;};
  assert.throws(()=>atlas.growPool('probe',129),/injected view failure/);
  assert.equal(atlas.generation,generationBeforeViewFailure);gpu.flush();
  assert.ok(!retained.views.gi0.texture.destroyed);assert.ok(!retained.views.stateA.texture.destroyed);
  gpu.device.createTexture=createTexture;
  const delayed=atlas.allocateLight([1,0,0],{sourceRevision:1,readyBits:A.READY.GI_SOURCE});
  atlas.reset();assert.throws(()=>atlas.recordLightWrite(delayed,'source',{record(){}}),/stale/);assert.throws(()=>atlas.publish(j),/stale/);
  const cancelled=atlas.allocateLight([1,0,0],{sourceRevision:0,readyBits:A.READY.GI_SOURCE});atlas.cancel(cancelled);assert.throws(()=>atlas.updateLight(cancelled,lightData(cancelled)),/stale/);
  assert.ok(atlas.probe.pages.has(j.probePID));before.release();retained.release();atlas.dispose();gpu.flush();
  assert.ok(gpu.textures.every(t=>t.destroyed));assert.ok(gpu.buffers.every(b=>b.destroyed));
});
test('six typed feedback planes preserve mixed/secondary reasons at high Y384, bit31 and globalN; sticky WGSL',()=>{
  const book=A.worldBookLayout([3072,384,1024]), words=new Uint32Array(book.sunWord+1);
  const index=A.worldBrickIndex(book,[767,95,255]);assert.equal(index,book.count-1);
  A.requestChannels(words,book,index,A.READY.GI_SOURCE|A.READY.GLOW);
  A.requestChannels(words,book,31,A.READY.RAW|A.READY.FIELD|A.READY.GI);
  A.requestChannels(words,book,index,A.READY.AUX);
  assert.deepEqual(A.requestedChannels(words,book),[
    {index:31,brick:[31,0,0],channels:A.READY.RAW|A.READY.FIELD|A.READY.GI},
    {index,brick:[767,95,255],channels:A.READY.AUX|A.READY.GI_SOURCE|A.READY.GLOW},
  ]);
  assert.equal(words[book.statusWord],0);assert.equal(words[book.sunWord],0);
  for(let p=0;p<6;p++)assert.equal(words[p*book.planeWords+(31>>5)]>>>31,[1,1,0,0,1,0][p]);
  const code=worldAccessWGSL();assert.equal((code.match(/worldIncomplete = false/g)||[]).length,1);
  assert.match(code,/plane < 6u/);assert.match(code,/worldRequest\(i, ready, have\)/);assert.match(code,/\(have & bit\) == 0u/);
  assert.match(code,/worldLightBook\[i\]/);assert.doesNotMatch(code,/worldPage\(b, WORLD_GI/);
});
test('CPU allocation accounting, independent rounded capacities and legal near-ceiling growth at both heights',()=>{
  for(const h of [128,384]) {
    const book=A.worldBookLayout([3072,h,1024]);assert.equal(book.requestBytes,book.bytes*6/32);
    const l=A.worldAtlasLayout(book.count,{},book.count,book.count), bytes=A.worldAllocationBytes(l);
    assert.ok(bytes.cells>=book.count*(2048+1536));assert.ok(bytes.aux>=book.count*(132+5)*16);assert.ok(bytes.probes>=book.count*40);
    assert.equal(bytes.total,bytes.cells+bytes.aux+bytes.probes);
    const near=A.worldAtlasLayout(2**24,{},1,1), max=A.worldPoolMax('cell',near);
    const next=A.worldPoolGrowth('cell',near,{},book.count>2**24?book.count:2**24+1);
    assert.equal(next,max);assert.ok(next>=book.count);assert.doesNotThrow(()=>A.worldAtlasLayout(next,{},1,1));
    assert.throws(()=>A.worldPoolGrowth('cell',near,{},max+1),/exhausted/);
  }
  const l=A.worldAtlasLayout(0,{},1000,0), bytes=A.worldAllocationBytes(l);
  assert.equal(bytes.cells,64*64*(16*2+8*3));assert.equal(bytes.probes,64*40); // minimum bound geometry only
  assert.ok(bytes.aux>=1000*A.LIGHT_RECORDS*16);
});
// The GPU memory budget (world/worldViewRing.js worldPageBudget): a growth
// stops at it, and a demand past it is refused, never allocated.
test('a pool never grows past the owner\'s page budget: growth clamps to it, a demand past it is refused',()=>{
  const l=A.worldAtlasLayout(1000,{},1,1), budget=1500;
  assert.equal(A.worldPoolGrowth('cell',l,{},1001,budget),budget);   // a doubling (2000) clamps to the budget
  assert.equal(A.worldPoolGrowth('cell',l,{},1400,budget),budget);
  assert.throws(()=>A.worldPoolGrowth('cell',l,{},budget+1,budget),new RegExp(A.WORLD_PAGE_BUDGET));
  assert.equal(A.worldPoolGrowth('cell',l,{},1001),2000);              // no budget: the old doubling
  const R=V.worldPageBudget({deviceMemoryGB:8});
  assert.equal(R.cell,Math.floor(8*1024**3*V.WORLD_GPU_MEMORY_SHARE/(V.WORLD_CELL_PAGE_BYTES+V.WORLD_LIGHT_PAGE_BYTES)));
  assert.equal(V.WORLD_CELL_PAGE_BYTES,64*(16*2+8*3)+A.AUX_RECORDS*16);
  assert.ok(R.cell>200000&&R.cell<449215,`the user's Mac budget ${R.cell} must sit under what Chrome held`);
  assert.equal(V.worldPageBudget({}).deviceMemoryGB,V.WORLD_DEVICE_MEMORY_FALLBACK_GB);
  assert.ok(V.worldPageBudget({deviceMemoryGB:8,limits:{maxBufferSize:2**20}}).cell<=2**20/1024);
  // the owner's demand cut: never more kept than the budget, the farthest go, their columns read as air
  const size=[256,64,256],dims=size.map(n=>n/4),brick=i=>[i%dims[0],Math.floor(i/dims[0])%dims[1],Math.floor(i/(dims[0]*dims[1]))];
  const tops={top:()=>8,sea:0},air=V.worldViewAirFloors({size,tops}),eye=[8,12,8],ids=new Set();
  for(let x=0;x<dims[0];x++)ids.add(x+dims[0]*(1+dims[1]*2));
  // (a near-ring brick is never dropped: 29 of the row lie within it)
  const r=V.worldBudgetDemand(ids,{budget:40,eye,brick,air});
  assert.equal(r.keep.size,40);assert.equal(r.dropped.length,ids.size-40);
  assert.equal(V.worldBudgetDemand(ids,{budget:10,eye,brick,air}).keep.size,[...ids].filter(i=>Math.hypot(...brick(i).map((n,k)=>(n+0.5)*4-eye[k]))<=V.WORLD_VIEW_NEAR_RADIUS).length);
  const far=Math.min(...r.dropped.map(i=>brick(i)[0])),kept=Math.max(...[...r.keep].map(i=>brick(i)[0]));
  assert.ok(far>kept,'the farthest bricks go first');
  for(const i of r.dropped)assert.ok(V.worldViewFarAir(eye,brick(i),r.air),'a dropped brick is air to the view');
  for(const i of r.keep)assert.ok(!V.worldViewFarAir(eye,brick(i),r.air)||!ids.has(i));
});
test('canonical original GI-source packing fixtures survive source-only descriptor transport, not reserved cell record3',()=>{
  // Inputs are already reduced giSourceFrag outputs, NOT material/profile aliases.
  // Half words are exact representable fixture values; the shared original
  // giSrcPack WGSL is Naga-compiled above (not GPU-executed by these CPU tests).
  const fixtures=[
    ['air',[0,0,0],[0,0,0],[0,0,0],[0,0,0,0x1ff7fdff]],
    ['water',[0,0,0],[.5,.5,.5],[0,0,0],[0,0x38000000,0x38003800,0x1ff7fdff]],
    ['smoke',[0,0,0],[.25,.25,.25],[0,0,0],[0,0x34000000,0x34003400,0x1ff7fdff]],
    ['covered opaque',[0,0,0],[1,1,1],[0,0,0],[0,0x3c000000,0x3c003c00,0x1ff7fdff]],
    ['crystal',[1,2,4],[.5,.5,.5],[1,0,-1],[0x40003c00,0x38004400,0x38003800,0x0007fffe]],
    ['emitter',[2,4,8],[1,.5,.25],[0,1,0],[0x44004000,0x3c004800,0x34003800,0x1ffff9ff]],
  ];
  const half=new Map([[0,0],[.25,0x3400],[.5,0x3800],[1,0x3c00],[2,0x4000],[4,0x4400],[8,0x4800]]);
  const pack=(a,b)=>(half.get(a)|(half.get(b)<<16))>>>0;
  const {atlas,gpu}=setup();
  fixtures.forEach(([name,rad,cov,dir,expected],i)=>{
    const q=dir.map(v=>Math.floor(v*511+511+.5));
    const packed=new Uint32Array([pack(rad[0],rad[1]),pack(rad[2],cov[0]),pack(cov[1],cov[2]),q[0]|(q[1]<<10)|(q[2]<<20)]);
    assert.deepEqual([...packed],expected,name);
    const j=atlas.allocateLight([i,0,0],{sourceRevision:0,readyBits:A.READY.GI_SOURCE});atlas.updateLight(j,{source:packed});atlas.publish(j);
    const c=atlas.allocate([i,0,0],{sourceRevision:0});const data=dataFor(c);assert.deepEqual([...data.aux.subarray(12,16)],[0,0,0,0]);atlas.update(c,data);atlas.publish(c);
    const s=atlas.snapshot();assert.deepEqual([...readDescriptor(s,j.lightDescriptorID,4)],expected,name);s.release();
  });
  assert.notDeepEqual([...AIR_SOURCE],[0,0,0,0]);
  atlas.dispose();gpu.flush();
});
