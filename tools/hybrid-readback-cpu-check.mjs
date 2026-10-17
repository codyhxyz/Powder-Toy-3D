// Actual frame/readback classes, memory-backed device. No native GPU execution.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { GpuFrame } from '../src/gpu/frame.js';
import { Readback } from '../src/gpu/readback.js';

export async function checkReadbackAfterRender(){
  const oldUsage=globalThis.GPUBufferUsage,oldMap=globalThis.GPUMapMode;
  globalThis.GPUBufferUsage={MAP_READ:1,COPY_SRC:4,COPY_DST:8,STORAGE:128};
  globalThis.GPUMapMode={READ:1};
  try{
    let allocations=0,renderWork;
    const submissions=[];
    const device={
      createBuffer({size}){
        allocations++;
        const bytes=new Uint8Array(size);
        let mapped=false;
        return{size,bytes,destroy(){},async mapAsync(){
          assert(!mapped,'staging cannot be leased or mapped twice');mapped=true;
        },getMappedRange(offset,length){
          assert(mapped);return bytes.buffer.slice(offset,offset+length);
        },unmap(){assert(mapped);mapped=false;}};
      },
      createCommandEncoder(){
        const ops=[];
        return{beginRenderPass(){
          const work=renderWork;ops.push({name:'render',run:work});return{end(){}};
        },copyBufferToBuffer(src,offset,dst,at,size){
          ops.push({name:'copy',run:()=>dst.bytes.set(src.bytes.subarray(offset,offset+size),at)});
        },finish(){return ops;}};
      },
    };
    const gpu={label:'CPU readback',device,createBuffer:desc=>device.createBuffer(desc),frameNo:0,inFlight:0,debug:false,
      stats:{bytesAllocated:0,bytesReadBack:0,bytesUploaded:0,submits:0,flushes:0,renderPasses:0},
      paramRing:{free:Infinity,upload:()=>0},timing:{_endFrame(){}},
      queue:{submit(buffers){
        gpu.stats.submits++;
        for(const ops of buffers){submissions.push(ops.map(op=>op.name));for(const op of ops)op.run();}
      },onSubmittedWorkDone:()=>Promise.resolve()},
    };
    gpu.frame=new GpuFrame(gpu);gpu.readback=new Readback(gpu);
    const source=device.createBuffer({size:96}),ring=gpu.readback.ring('smooth stand-in',16,2);
    let firstAllocations;
    for(let round=0;round<3;round++){
      const expected=Uint32Array.from({length:24},(_,i)=>1000*round+i+1),slot=ring.next();
      renderWork=()=>{
        source.bytes.set(new Uint8Array(expected.buffer));
        new Uint32Array(ring.buffer.bytes.buffer,slot*16,4).set([0,31660,94980,32768]);
      };
      const pass=gpu.frame.render({colorAttachments:[]},'CPU emulated status writer');
      gpu.frame._commandDone('CPU emulated draw');pass.end();gpu.frame.endFrame();
      assert.deepEqual([...new Uint32Array(await ring.read(slot))],[0,31660,94980,32768]);
      await gpu.readback.idle();
      const reads=Array.from({length:6},(_,i)=>gpu.readback.buffer(source,i*16,16));
      const pending=gpu.readback.pending;
      assert.equal(new Set(pending.map(p=>p.staging)).size,6,'concurrent copies need distinct staging');
      assert(gpu.frame.flush('CPU copies after rendered frame'));
      const actual=(await Promise.all(reads)).flatMap(bytes=>[...new Uint32Array(bytes)]);
      assert.deepEqual(actual,[...expected],'state copies must not publish earlier ring bytes');
      await gpu.readback.idle();
      if(round===0)firstAllocations=allocations;
      else assert.equal(allocations,firstAllocations,'later rounds must exercise actual staging reuse');
    }
    assert(submissions.some(ops=>ops[0]==='render'&&ops.includes('copy')));
    assert(submissions.some(ops=>ops.length===6&&ops.every(name=>name==='copy')));
  }finally{
    if(oldUsage===undefined)delete globalThis.GPUBufferUsage;else globalThis.GPUBufferUsage=oldUsage;
    if(oldMap===undefined)delete globalThis.GPUMapMode;else globalThis.GPUMapMode=oldMap;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  await checkReadbackAfterRender();
  console.log('PASS real frame/render/flush/readback lifecycle and concurrent staging reuse (CPU stand-in only)');
}
