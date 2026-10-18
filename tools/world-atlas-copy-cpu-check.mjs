// Numerical transport checks only: fake native byte copies, no rendering claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldRenderAtlas, READY, AUX_RECORDS, LIGHT_RECORDS, auxTexel, lightTexel, pageTexel, probeTexel, packWorldAux} from '../src/world/renderAtlas.js';
import {CellTestGPU} from './cell-adapter-test-gpu.mjs';
const read=(texture,p,Type,n)=>new Type(texture.bytes,(p[0]+texture.size[0]*(p[1]+texture.size[1]*p[2]))*n*Type.BYTES_PER_ELEMENT,n).slice();
for(const maxDim of [32,48,8192])test(`exact AUX row-run growth copies preserve all packets with texture limit ${maxDim}`,async()=>{
  const gpu=new CellTestGPU();gpu.device.limits.maxTextureDimension2D=maxDim;
  const copies=[],encoder=gpu.encoder.bind(gpu);
  gpu.encoder=(...args)=>{const e=encoder(...args),copy=e.copyTextureToTexture.bind(e);
    e.copyTextureToTexture=(s,d,extent)=>{copies.push({s,d,extent});return copy(s,d,extent);};return e;};
  const atlas=new WorldRenderAtlas(gpu,{worldSize:[16,16,16],initialCapacity:1,initialLightCapacity:3,initialProbeCapacity:3});
  const job=atlas.allocate([0,0,0],{sourceRevision:1});
  const rawA=Uint32Array.from({length:256},(_,i)=>(Math.imul(i+1,0x9e3779b1))>>>0),rawB=rawA.map(v=>~v);
  const fields=Array.from({length:3},(_,j)=>Uint16Array.from({length:256},(_,i)=>(i*997+j*12345)&65535));
  const aux=packWorldAux({epoch:atlas.epoch,sourceRevision:1,
    brickInfo:new Uint32Array([0x7fc12345,0xffffffff,0x80000000,0x01020304]),
    flow:Uint32Array.from({length:128},(_,i)=>i*19+7),aeration:Uint32Array.from({length:128},(_,i)=>~(i*23)),
    deco:Uint32Array.from({length:64},(_,i)=>i*0x01010101)});
  atlas.update(job,{stateA:rawA,stateB:rawB,field0:fields[0],field1:fields[1],field2:fields[2],aux});
  const lightJobs=[];
  for(let i=0;i<3;i++){
    const j=atlas.allocateLight([i+1,0,0],{sourceRevision:1,readyBits:READY.GLOW});
    atlas.updateLight(j,{glow:new Uint16Array([0x7c01+i,0x8000+i,0xfc00-i,0x7e55+i])});lightJobs.push(j);
  }
  atlas.publish([job,...lightJobs]);gpu.finish();
  const original=atlas.resources,pin=atlas.snapshot();
  const cellWords=Array.from({length:AUX_RECORDS},(_,r)=>read(original.textures.aux,auxTexel(job.physicalPageID,r,original.layout),Uint32Array,4));
  const lightWords=lightJobs.map(j=>Array.from({length:LIGHT_RECORDS},(_,r)=>read(original.textures.aux,lightTexel(j.lightDescriptorID,r,original.layout),Uint32Array,4)));
  for(const capacity of [2,8,32]){
    const previous=atlas.resources;copies.length=0;atlas.growPool('cell',capacity);gpu.finish();
    const current=atlas.resources,auxCopies=copies.filter(c=>c.s.texture===previous.textures.aux);
    assert.equal(auxCopies.reduce((n,c)=>n+c.extent[0],0),AUX_RECORDS+3*LIGHT_RECORDS,'same exact texels, no padding or omissions');
    assert(auxCopies.length<AUX_RECORDS+3*LIGHT_RECORDS,'contiguous records coalesce');
    for(const {s,d,extent} of auxCopies){
      assert.deepEqual(extent.slice(1),[1,1]);
      assert(s.origin[0]+extent[0]<=s.texture.size[0]);assert(d.origin[0]+extent[0]<=d.texture.size[0]);
    }
    for(let r=0;r<AUX_RECORDS;r++){
      assert.deepEqual(read(current.textures.aux,auxTexel(job.physicalPageID,r,current.layout),Uint32Array,4),cellWords[r]);
      assert.deepEqual(read(original.textures.aux,auxTexel(job.physicalPageID,r,original.layout),Uint32Array,4),cellWords[r],'pinned old bytes unchanged');
    }
    for(let i=0;i<lightJobs.length;i++)for(let r=0;r<LIGHT_RECORDS;r++)
      assert.deepEqual(read(current.textures.aux,lightTexel(lightJobs[i].lightDescriptorID,r,current.layout),Uint32Array,4),lightWords[i][r],'descriptor base movement exact');
    for(let s=0;s<64;s++){
      const p=pageTexel(job.physicalPageID,s,current.layout);
      assert.deepEqual(read(current.textures.stateA,p,Uint32Array,4),rawA.slice(s*4,s*4+4));
      assert.deepEqual(read(current.textures.stateB,p,Uint32Array,4),rawB.slice(s*4,s*4+4));
      for(let c=0;c<3;c++)assert.deepEqual(read(current.textures['field'+c],p,Uint16Array,4),fields[c].slice(s*4,s*4+4));
    }
    for(let i=0;i<lightJobs.length;i++){
      const id=atlas.light.pages.get(lightJobs[i].lightDescriptorID).probeID;
      assert.deepEqual(read(current.textures.glow,probeTexel(id,current.layout),Uint16Array,4),new Uint16Array([0x7c01+i,0x8000+i,0xfc00-i,0x7e55+i]));
    }
  }
  pin.release();atlas.dispose();gpu.finish();await Promise.resolve();gpu.finish();
});
