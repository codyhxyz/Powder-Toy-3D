// Native identity/lifetime/transport evidence, NOT numerical GPU parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CellTestGPU } from './cell-adapter-test-gpu.mjs';
import { WorldRenderAtlas, READY, lightTexel } from '../src/world/renderAtlas.js';
import { createWorldLightingInputs, createWorldFeedbackProvider } from '../src/gfx/worldLightingInputs.js';
import { tableLayout } from '../src/shaders/common.js';
import { worldVolumeLayouts } from '../src/shaders/worldRenderBackend.js';
import { worldSunWriterLayouts } from '../src/shaders/worldSunWriter.js';
import { completeLightingBatch } from '../src/gfx/worldLightingBatch.js';
import { WorldSunParams } from '../src/world/worldSun.js';
const external = () => Object.fromEntries(['sunDepth','sunOptical','mediaNoise','sourceAppearance','packedMesh'].map(n => [n, { name: n }]));
const drain = async gpu => { gpu.finish(); await new Promise(r => setTimeout(r, 0)); gpu.finish(); };
const light = (atlas, brick, revision = 1) => {
  const job = atlas.allocateLight(brick, { sourceRevision: revision, sourceTick: 3, giTick: 2, glowTick: 1, readyBits: READY.LIGHT });
  atlas.updateLight(job, { source: new Uint32Array([11,22,33,44]), ...Object.fromEntries(['gi0','gi1','gi2','gi3','glow'].map((n,i) => [n, new Uint16Array([i+1,2,3,4])])) });
  atlas.publish([job]); return job;
};
test('real Atlas exact native texture borrowing and retained old LIGHT survives repeated pool growth', async () => {
  const gpu = new CellTestGPU(), atlas = new WorldRenderAtlas(gpu, { worldSize: [8,8,8], initialCapacity: 1, initialLightCapacity: 1, initialProbeCapacity: 1 });
  light(atlas, [0,0,0]); await drain(gpu);
  const old = atlas.snapshot(), held = old.retain(), original = old.textures();
  atlas.publish({ invalidations: [{ brick: [0,0,0], channels: READY.LIGHT }] });
  atlas.growPool('cell', 2); atlas.growPool('light', 2); atlas.growPool('probe', 2); atlas.growPool('cell', 4);
  await drain(gpu);
  const current = atlas.snapshot(), feedback = gpu.createBuffer({ size: atlas.feedbackBytes });
  const groups = atlas.producerBindings(current, old, external(), feedback);
  assert.equal(groups[0][2].resource.buffer, old.lightBook);
  assert.equal(groups[1][5].resource, current.views.aux);
  assert.equal(groups[2][0].resource, current.views.gi0);
  const tex = current.textures().aux, p = lightTexel(0,4,current.layout);
  const offset = (p[0]+tex.size[0]*(p[1]+tex.size[1]*p[2]))*4;
  assert.deepEqual([...new Uint32Array(tex.bytes).slice(offset,offset+4)], [11,22,33,44]);
  assert.equal(old.textures().aux, original.aux);
  assert.notEqual(current.textures().aux, original.aux);
  old.release(); assert.throws(() => old.textures(), /released/);
  assert.throws(() => atlas.producerBindings(current, old, external(), feedback), /live/);
  assert.equal(held.textures().aux, original.aux);
  const foreign = new WorldRenderAtlas(gpu, { worldSize: [8,8,8] }), f = foreign.snapshot();
  assert.throws(() => atlas.producerBindings(current, f, external(), feedback), /live/);
  atlas.reset(); assert.throws(() => current.textures(), /epoch/);
  current.release(); held.release(); f.release(); atlas.dispose(); foreign.dispose(); await drain(gpu);
});
test('concrete lean Sun and full GI providers bind actual immutable tables/header/frame/Atlas and Sun', async () => {
  const gpu = new CellTestGPU(); gpu.device.createSampler = d => d;
  const atlas = new WorldRenderAtlas(gpu, { worldSize: [8,8,8], feedbackExtraWords: 1 });
  const snapshot = atlas.snapshot(), tables = gpu.createBuffer({ size: tableLayout().Tables.size }), ext = external();
  const provider = createWorldLightingInputs(gpu, { atlas, tables, frameValues: { cam: [1,2,3] }, physicsOrigin: [32,0,0], external: ext });
  const lean = provider.sun({ atlas: snapshot });
  assert.deepEqual(lean.map(g => g.length), [5,6]); assert.equal(lean[0][0].resource.buffer,tables);
  assert.equal(lean[0][3].resource.buffer,snapshot.params);
  assert.equal(lean[1][0].resource,snapshot.views.stateA);
  const params = { worldToLight: new Array(16).fill(0), depth: [1,0,1,1], tiles: [0,0,1,1], physical: [256,8,64,1], version: [1,1,1,atlas.bookLayout.sunWord] };
  const book = gpu.createBuffer({ size: 32 }), sun = { bindings: () => ({ params, book, sun0: ext.sunOptical, sun1: ext.sunDepth }) };
  const feedback = gpu.createBuffer({ size: atlas.feedbackBytes });
  const full = provider.reader({ atlas: snapshot, previousAtlas: snapshot, feedback, sun });
  assert.deepEqual(full.map(g => g.length), [6,6,10,6]);
  for(const [groups,layouts] of [[lean,worldSunWriterLayouts().slice(0,2)],[full,worldVolumeLayouts()]]) {
    groups.forEach((entries,i)=>{
      assert.deepEqual(entries.map(e=>e.binding),layouts[i].map(e=>e.binding));
      for(const e of entries){const descriptor=layouts[i].find(d=>d.binding===e.binding);if(descriptor.buffer)assert(e.resource.buffer.size >= (descriptor.buffer.minBindingSize??0));}
    });
  }
  assert.equal(full[0][5].resource.buffer,snapshot.lightBook); assert.equal(full[2][5].resource,ext.sunDepth);
  assert.equal(full[3].find(e => e.binding===5).resource.buffer,book);
  assert.equal(full[3].find(e => e.binding===4).resource.buffer.size,WorldSunParams.size);
  provider.release(); assert.throws(() => provider.sun({ atlas: snapshot }), /released/);
  snapshot.release(); atlas.dispose(); await drain(gpu);
});
test('normal Frame final tickets settle final flush, typed six planes + Sun + exact job statuses', async () => {
  const gpu = new CellTestGPU(), atlas = new WorldRenderAtlas(gpu, { worldSize: [8,8,8] });
  gpu.device.createBuffer = desc => { const buffer = gpu.createBuffer(desc); buffer.mapAsync = () => gpu.queue.onSubmittedWorkDone(); return buffer; };
  const provider = createWorldFeedbackProvider(gpu, { book: atlas.bookLayout, sunTileCount: 33 });
  const layout = provider.layout({ jobCount: 3 });
  assert.equal(layout.requestWordOffset,7); assert.equal(layout.reservedWords,9); assert.equal(layout.wordCount,12);
  const words = new Uint32Array(12); words[0]=1; words[7]=2; words[9]=1;
  const decoded = layout.decode(words); assert(decoded.incomplete); assert.deepEqual(decoded.sun,[1]); assert.deepEqual(decoded.requirements,[{index:0,brick:[0,0,0],channels:1}]);
  const buffer = gpu.createBuffer({ size:48 }), ticket = provider.reserve(gpu.frame);
  const read = ticket.record(gpu.frame,buffer); await ticket.submitted; await drain(gpu); assert.equal((await read).length,12);
  assert.throws(() => ticket.record(gpu.frame,buffer), /consumed/);
  const failure = provider.reserve(gpu.frame), flush = gpu.flush;
  gpu.flush = () => { flush.call(gpu); throw new Error('final rejection'); };
  await assert.rejects(failure.record(gpu.frame,buffer),/final rejection/); await assert.rejects(failure.submitted,/final rejection/);
  gpu.flush=flush; gpu.flush(); atlas.dispose(); await drain(gpu);
});
test('closed-suffix rejection fences a surviving automatic prefix; open-suffix failure retains ticket and blocks retry', async () => {
  const gpu = new CellTestGPU(), atlas = new WorldRenderAtlas(gpu, { worldSize:[8,8,8] });
  gpu.device.createBuffer = desc => { const buffer=gpu.createBuffer(desc); buffer.mapAsync=()=>gpu.queue.onSubmittedWorkDone(); return buffer; };
  const provider=createWorldFeedbackProvider(gpu,{book:atlas.bookLayout,sunTileCount:1}), buffer=gpu.createBuffer({size:32}), original=gpu.flush.bind(gpu);
  let released=false;
  gpu.flush=()=>{original();throw new Error('closed suffix rejected');};
  const completion=completeLightingBatch({frame:gpu.frame,queue:gpu.queue,feedbackBuffer:buffer,wordCount:8,submissionProvider:provider,
    encode(){gpu.frame.clear(buffer);original();},finish(){throw new Error('must not publish');}}).finally(()=>{released=true;});
  completion.catch(()=>{});await Promise.resolve();await Promise.resolve();assert.equal(released,false);
  gpu.flush=original;await drain(gpu);await assert.rejects(completion,/closed suffix/);assert.equal(released,true);
  gpu.flush=()=>{throw new Error('recordable suffix');};
  const ticket=provider.reserve(gpu.frame);const read=ticket.record(gpu.frame,buffer,8);
  let settled=false;ticket.submitted.then(()=>{settled=true;},()=>{settled=true;});read.then(()=>{settled=true;},()=>{settled=true;});
  await Promise.resolve();await new Promise(r=>setTimeout(r,0));
  assert.equal(gpu.frame.open,true);assert.equal(ticket.status,'blocked');assert.equal(settled,false);
  assert.match(provider.failure.message,/recordable suffix/);assert.throws(()=>provider.reserve(gpu.frame),/blocked/);
  // Test teardown only: the checkpoint intentionally has no orphan-recovery
  // API. A future owner must retire graphics, not retry/admit over this suffix.
  gpu.flush=original;gpu.flush();await drain(gpu);assert.equal(settled,false);
  atlas.dispose();await drain(gpu);
});
