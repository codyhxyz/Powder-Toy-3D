// Actual WorldVolume + normal GpuFrame + whole-feedback final provider.
// Native compute writes explicit hit words: this is transport, NOT DDA/GPU proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Matrix4,PerspectiveCamera,Ray,Vector3} from 'three/webgpu';
import {readFileSync} from 'node:fs';
import {fixture} from './world-volume-consumers-cpu-check.mjs';
import {GpuFrame} from '../src/gpu/frame.js';
import {queryWorldPick,displayedWorldRay,transportWorldRay,localWorldHover} from '../src/wire/worldPick.js';
import {PickParams} from '../src/shaders/render.js';
import {tableLayout} from '../src/shaders/common.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup({unknown=false,reject=false}={}) {
  const f=fixture(),queue=deferred(),device=f.device;let pins=0,dispatches=0,captured;
  const create=device.createBuffer;
  device.createBuffer=d=>{const b=create(d);b.getMappedRange=()=>b.data.buffer;b.mapAsync=()=>Promise.resolve();b.unmap=()=>{};return b;};
  device.createCommandEncoder=()=>{const ops=[];return {
    beginComputePass(){let groups=[];return {setPipeline(){},setBindGroup(i,g){groups[i]=g;},dispatchWorkgroups(){dispatches++;
      const buf=b=>groups[3].entries.find(e=>e.binding===b).resource.buffer;
      captured=new DataView(buf(0).data.buffer);
      ops.push(()=>{new Float32Array(buf(6).data.buffer).set([3071,383,1023,unknown?-2:4,27,123,9,.5]);
        if(unknown)new Uint32Array(buf(1).data.buffer)[0]=1;});},end(){}};},
    copyBufferToBuffer(s,so,d,to,n){ops.push(()=>d.data.set(s.data.subarray(so,so+n),to));},finish(){return ops;}};};
  device.queue.submit=cmd=>{for(const ops of cmd)for(const op of ops)op();};
  device.queue.onSubmittedWorkDone=()=>queue.promise;
  const gpu={device,queue:device.queue,stats:{bytesUploaded:0,flushes:0},paramRing:{upload:()=>0},
    readback:{_beforeSubmit(){},_afterSubmit(){}},flush(){const result=this.frame.flush();if(reject)throw Error('closed suffix');return result;}};
  gpu.frame=new GpuFrame(gpu);
  const camera=new PerspectiveCamera();camera.position.set(8,7,6);camera.updateMatrixWorld();
  const I=new Matrix4().toArray(),frame={values:{cam:[8,7,6],model:I,viewProj:I},physicsOrigin:[2048,0,512],params:{},external:{mediaNoise:{},sourceAppearance:{}}};
  const data={frame,snapshot:f.candidate.snapshot,tables:{buffer:f.device.createBuffer({size:tableLayout().Tables.size})},lighting:f.lighting,appearance:null,
    retain(){pins++;return {release(){pins--;}};}};
  const displayed={data,view:{camera,values:frame.values,view:'realistic',params:{},presentation:{parameters:{k:.002,anchor:[8,6],dir:[0,1]}}},frameIdentity:{order:1}};
  const state={volume:f.volume,unused:{createView:()=>({stable:true})},uses:new Set(),boundary:device.createBuffer({size:16})};
  return {...f,gpu,state,displayed,queue,get pins(){return pins;},get dispatches(){return dispatches;},get captured(){return captured;}};
}

test('delayed compilation freezes global/high-Y curved ray, skipLiquids, table/appearance and slot; complete output retained through queue',async()=>{
 const f=setup(),ray=new Ray(new Vector3(3071,383,1023),new Vector3(-1,0,0));
 const work=queryWorldPick({gpu:f.gpu},f.state,f.displayed,{ray,skipLiquids:true},()=>true,()=>assert.fail('complete query demands'));
 assert.equal(f.pins,1);assert.equal(f.state.uses.size,1);assert.equal(f.dispatches,0);
 ray.origin.set(1,2,3);f.displayed.view.presentation.parameters.k=0;f.displayed.view.presentation.parameters.anchor[0]=999;
 f.settle();const hit=await work;
 assert.equal(f.captured.getFloat32(PickParams.offsets.ro,true),3071);
 assert.equal(f.captured.getFloat32(PickParams.offsets.ro+4,true),383);
 assert.equal(f.captured.getFloat32(PickParams.offsets.ro+12,true),Math.fround(.002));
 assert.equal(f.captured.getFloat32(PickParams.offsets.rd+12,true),1);
 assert.equal(f.captured.getFloat32(PickParams.offsets.warp,true),8);
 assert.equal(hit.valid,true);assert.deepEqual(hit.cell,[3071,383,1023]);assert.equal(hit.raw.byteLength,32);
 assert.equal(hit.T,123);assert.equal(hit.P,9);assert.equal(hit.life,.5);assert.equal(hit.frameIdentity,f.displayed.frameIdentity);
 assert.equal(f.pins,1);assert.equal(f.state.uses.size,1);
 f.queue.resolve();await Promise.all([...f.state.uses]);assert.equal(f.pins,0);f.release();
});

test('whole unknown feedback invalidates apparent hit and queues typed requirements only after final read',async()=>{
 const f=setup({unknown:true});let demand;
 const work=queryWorldPick({gpu:f.gpu},f.state,f.displayed,{ray:new Ray()},()=>true,(fb,d)=>{demand=fb;assert.equal(d,f.displayed);});
 f.settle();const hit=await work;assert.equal(hit.ready,false);assert.equal(hit.code,'WORLD_PICK_INCOMPLETE');
 assert.equal(demand.requirements[0].channels,1);assert.deepEqual(demand.requirements[0].brick,[0,0,0]);
 f.queue.resolve();await Promise.all([...f.state.uses]);f.release();
});

test('obsolete/disposed compile never dispatches; rejected closed suffix pins drain only after queue',async()=>{
 for(const mode of ['obsolete','dispose','reject']){
 const f=setup({reject:mode==='reject'});
 const work=queryWorldPick({gpu:f.gpu},f.state,f.displayed,{ray:new Ray()},()=>mode!=='obsolete',()=>{});
 if(mode==='dispose')f.state.dead=true;
 f.settle();if(mode==='reject')await assert.rejects(work,/closed suffix/);else assert.equal((await work).code,'WORLD_PICK_OBSOLETE');
 assert.equal(f.dispatches,mode==='reject'?1:0);assert.equal(f.pins,1);
 f.queue.resolve();await Promise.all([...f.state.uses]);assert.equal(f.pins,0);f.release();
 }
});

test('displayed ray ignores live camera; legacy transport and origin-shift physical guards never clip global validity',()=>{
 const camera=new PerspectiveCamera();camera.position.set(2,3,4);camera.updateMatrixWorld();
 const display={view:{camera:camera.clone(),values:{model:new Matrix4().makeTranslation(-10,0,0).toArray()}}};
 camera.position.set(999,999,999);camera.updateMatrixWorld();
 assert.equal(displayedWorldRay(display,[0,0]).origin.x,12);
 const ray=transportWorldRay(display,new Vector3(999,999,999),new Vector3(0,0,-1),new Matrix4(),camera);
 assert.equal(ray.origin.x,12);
 const identity={},hover={valid:true,globalCell:new Vector3(100,383,100),cell:new Vector3(),frameIdentity:identity};
 const inside=c=>c.x>=0&&c.x<32&&c.y>=0&&c.y<512&&c.z>=0&&c.z<32;
 assert.equal(localWorldHover(hover,new Vector3(),inside,i=>i===identity),false);assert.equal(hover.valid,true);
 assert.equal(localWorldHover(hover,new Vector3(96,0,96),inside,i=>i===identity),true);assert.deepEqual(hover.cell.toArray(),[4,383,4]);
 assert.equal(localWorldHover(hover,new Vector3(128,0,128),inside,i=>i===identity),false);assert.equal(hover.valid,true);
 assert.equal(localWorldHover(hover,new Vector3(),inside,()=>false),false);assert.equal(hover.valid,false);
});

test('actual App mutation entry points refuse outside/stale global hover after origin shifts',()=>{
 const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
 const extract=name=>{
   const start=source.indexOf(`function ${name}(`),brace=source.indexOf('{',start);let depth=1,i=brace+1;
   for(;depth;i++){if(source[i]==='{')depth++;else if(source[i]==='}')depth--;}
   return source.slice(start,i);
 };
 const identity={},hover={valid:true,globalCell:new Vector3(4,5,4),cell:new Vector3(),frameIdentity:identity,worldToken:'tool'};
 const sim={origin:new Vector3()},win={renderFrame:{driver:{displayedMainFrame:{frameIdentity:identity}}}};
 const inWindow=c=>c.x>=0&&c.x<32&&c.y>=0&&c.y<32&&c.z>=0&&c.z<32;
 const sync=new Function('win','hover','sim','inWindow','localWorldHover','worldPickToken',`${extract('syncWorldHover')};return syncWorldHover;`)(win,hover,sim,inWindow,localWorldHover,()=> 'tool');
 assert.equal(sync(),true);sim.origin.set(32,0,32);
 for(const name of ['fillAt','clickTool']){
   const action=new Function('win','syncWorldHover',`${extract(name)};return ${name};`)(win,sync);
   assert.doesNotThrow(()=>action(),'must return before reaching ANY physical subsystem');
   assert.equal(hover.valid,true,'physical refusal must not erase global visual validity');
 }
 assert.deepEqual(hover.cell.toArray(),[-28,5,-28]);
 win.renderFrame.driver.displayedMainFrame={frameIdentity:{}};
 assert.equal(sync(),false);assert.equal(hover.valid,false);
 // Brush guards run in both actual update paths before BOX-only clamps.
 assert.match(extract('updateBrush'),/if\(win && brushValid && !inWindow\(brushCenter\)\)brushValid=false/);
 assert.match(extract('updateGunBrush'),/if\(win && brushValid && !inWindow\(brushCenter\)\)brushValid=false/);
 assert.match(source,/painting && brushValid && \(!win \|\| \(inWindow\(brushCenter\)/);
});
