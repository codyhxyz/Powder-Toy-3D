// Import-order regression: real engine graphs, CPU only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CellTestGPU } from './cell-adapter-test-gpu.mjs';
import { WorldRenderAtlas, READY, lightTexel, probeTexel } from '../src/world/renderAtlas.js';
import { createLightingTransport } from '../src/gfx/worldLightingBatch.js';
test('Atlas/history/SourceCut imports have no WRITER_CHANNELS initialization cycle',()=>{
  const modules=['./src/world/renderAtlas.js','./src/world/worldLightingHistory.js','./src/world/sourceCut.js'];
  for(const order of [modules,[...modules].reverse(),[modules[1],modules[0],modules[2]]]){
    const run=spawnSync(process.execPath,['--input-type=module','-e',order.map(p=>`await import(${JSON.stringify(p)});`).join('')],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
  }
});
test('Glow transport copies existing half texels to a scoped grown Atlas page without scratch or pipelines', async () => {
  const gpu = new CellTestGPU(), atlas = new WorldRenderAtlas(gpu, { worldSize: [8, 8, 8], initialLightCapacity: 1, initialProbeCapacity: 1 });
  atlas.growPool('light', 3); atlas.growPool('probe', 3);
  const job = atlas.allocateLight([1, 0, 0], { sourceRevision: 1, glowTick: 2, readyBits: READY.GLOW, dependencies: { glow: { id: 3, version: 4 } } });
  const source = gpu.createTexture({ size: [256, 2, 1], format: 'rgba16float', usage: 1 }), expected = [0x8000, 0x0001, 0x7bff, 0x3c00];
  new Uint16Array(source.bytes, 257 * 8, 4).set(expected);
  gpu.device.createComputePipelineAsync = gpu.device.createShaderModule = gpu.device.createBindGroup = () => { throw new Error('transport must not compile or bind'); };
  const transport = createLightingTransport(gpu.device), resources = gpu.resources.length;
  let pins = 0; const retain = () => { pins++; return { release() { pins--; } }; };
  const done = transport.write({ atlas, job, kind: 'glow', token: { epoch: 1, sourceRevision: 1, lightingTick: 2, dependencySetID: 3, dependencyVersion: 4 }, source, origin: [1, 1, 0], retain });
  assert.equal(pins, 1); assert.equal(gpu.resources.length, resources);
  gpu.finish(); await done; assert.equal(pins, 0);
  atlas.publish({ lightJobs: [job], dependencyToken: { version: 1, sets: [{ id: 3, version: 4 }] } }); gpu.finish();
  const snap = atlas.snapshot(), texture = snap.textures().glow, p = probeTexel(job.probePID, snap.layout);
  const offset = (p[0] + texture.size[0] * (p[1] + texture.size[1] * p[2])) * 8;
  assert.deepEqual([...new Uint16Array(texture.bytes, offset, 4)], expected);
  assert.equal(gpu.trace.filter(t => t.name === 'texture copy').length, 1);
  assert.equal(gpu.trace.some(t => ['native half copy', 'native buffer copy', 'raw CELL dispatch'].includes(t.name)), false);
  snap.release(); source.destroy(); atlas.dispose(); gpu.finish();
});
test('SOURCE/GI transport uses exact native texels, nonzero ranges and fenced output pins without pipelines or scratch',async()=>{
  const gpu=new CellTestGPU(),atlas=new WorldRenderAtlas(gpu,{worldSize:[8,8,8],initialLightCapacity:1,initialProbeCapacity:1});
  gpu.device.createComputePipelineAsync=()=>{throw new Error('packed transport must not compile');};
  const transport=createLightingTransport(gpu.device);
  atlas.growPool('light',3);atlas.growPool('probe',3);
  const job=atlas.allocateLight([1,0,0],{sourceRevision:1,sourceTick:2,giTick:2,readyBits:READY.GI_SOURCE|READY.GI,dependencies:{source:{id:3,version:4},gi:{id:3,version:4}}});
  const source=gpu.createBuffer({size:96,usage:4}),words=new Uint32Array(source.bytes);
  words.set([0x80000000,0xffffffff,0x7fc12345,0x1ff7fdff],4);
  // Finite packed half values: signed zero, subnormals, normals and saturation.
  const bands=[0x80000000,0x00017bff,0xfbff3c00,0x04008001,0x3555b555,0x7bfffbff,0x3c003800,0x00000001];
  for(let k=0;k<4;k++)words.set(bands.slice(k*2,k*2+2),8+k*4);
  let pins=0;
  const retain=()=>{pins++;return {release(){pins--;}};};
  const token={epoch:1,sourceRevision:1,lightingTick:2,dependencySetID:3,dependencyVersion:4};
  for(const kind of ['source','gi']){
    const copies=kind==='source'?[{from:16,to:0,size:16}]:Array.from({length:4},(_,k)=>({from:32+k*16,to:k*8,size:8}));
    const done=transport.write({atlas,job,kind,token,source,copies,retain});
    await Promise.resolve();assert.equal(pins,1);gpu.finish();await done;assert.equal(pins,0);
  }
  atlas.publish({lightJobs:[job],dependencyToken:{version:1,sets:[{id:3,version:4}]}});gpu.finish();
  const snap=atlas.snapshot(),textures=snap.textures();
  const read=(texture,p,n)=>new Uint32Array(texture.bytes,(p[0]+texture.size[0]*(p[1]+texture.size[1]*p[2]))*(texture.format==='rgba32uint'?16:8),n);
  assert.deepEqual([...read(textures.aux,lightTexel(job.lightDescriptorID,4,snap.layout),4)],[...words.slice(4,8)]);
  for(let k=0;k<4;k++)assert.deepEqual([...read(textures['gi'+k],probeTexel(job.probePID,snap.layout),2)],bands.slice(k*2,k*2+2));
  assert.equal(gpu.trace.filter(t=>t.name==='native half copy').length,5);
  assert.equal(gpu.trace.some(t=>t.name==='native buffer copy'),false);
  snap.release();source.destroy();atlas.dispose();gpu.finish();
});
