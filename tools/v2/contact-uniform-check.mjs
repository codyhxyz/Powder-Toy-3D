// CPU-only runtime ABI recorder. No WebGPU adapter/device, browser or server.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Gpu } from '../../src/gpu/device.js';
import { Kernel } from '../../src/gpu/kernels.js';
import { gridLayout } from '../../src/sim.js';
import { LAYOUT } from '../../src/shaders/common.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { CONTACT_ROW_UNIFORM } from '../../src/v2/contactTable.js';
import { contactWGSL, contactUniformWGSL } from '../../src/shaders/v2/contact.js';
import { v2BlockWGSL, v2BlockUniformWGSL, v2BlockCompactLayout, V2_KERNELS, ARGS2, V2Params } from '../../src/shaders/v2.js';

const g=gridLayout(16,16,16), tail=v2BlockCompactLayout(g);
const hash=s=>createHash('sha256').update(s).digest('hex');
for(const [source,expected] of [
  [contactWGSL,'44e16d8d8ffb54f350671b7ccfc96cb4b835d170adc9d2b9e490a13bf51245ec'],
  [v2BlockWGSL(g),'39bcb120ec5cb62d0882e682750e82391481791c241d5c809c689d571e001c6c'],
  [v2BlockWGSL(g,contactWGSL),'dcec26cec674cb6fe7d06ea461c1a51c88f2fa020a50b7395196a5d8ca030f7d'],
  [v2BlockWGSL(g,contactWGSL,true),'5126d0b0b1fe5d18b3ec11ec111c1345b2783f99042f9d914d55affba66c2bc1'],
  [v2BlockWGSL(g,'fn contactBlock() {}',true),'97c03a5430fc1b2c421d86997076ad3851c5225196f33ff4978e4c1504b0cd80'],
]) assert.equal(hash(source),expected,'pre-change default/custom/canonical emission hash');
for(const compact of [false,true]) {
  const storage=v2BlockWGSL(g,contactWGSL,compact), uniform=v2BlockUniformWGSL(g,compact);
  assert.equal(uniform.replace(contactUniformWGSL,contactWGSL),storage,'full non-contact source unchanged');
  assert.equal(uniform.split(contactUniformWGSL).length,2);
  assert.equal((uniform.match(/var<storage,/g)||[]).length,7);
  assert.equal((uniform.match(/var<uniform>/g)||[]).length,3);
}
let maxStorage=0;
for(const k of V2_KERNELS) {
  const count=k.layouts(g).flatMap(l=>typeof l==='string'?LAYOUT[l]??[]:l).filter(e=>e?.buffer?.type?.includes('storage')).length;
  assert(count<=8,k.name); maxStorage=Math.max(maxStorage,count);
}
assert.equal(maxStorage,8);

globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4,INDIRECT:8,UNIFORM:16};
const limits={maxStorageBufferBindingSize:134217728,maxBufferSize:268435456,
  minUniformBufferOffsetAlignment:256,maxUniformBufferBindingSize:16384,
  maxUniformBuffersPerShaderStage:12,maxBindGroups:4,maxBindingsPerBindGroup:1000,maxStorageBuffersPerShaderStage:8};
function recorder(overrides={},existing=null) {
  const buffers=[],uploads=[],compiled=[],commands=[],layouts=[];
  const gpu={
    device:{limits:{...limits,...overrides},
      createBindGroupLayout(d){layouts.push(d);return d;},
      createBindGroup(d){return d;},
    },
    _layoutEntries:new Map(),_uniformLayouts:new Set(),_ourGroups:new WeakSet(),_groupReads:new WeakMap(),
    _assertLive:Gpu.prototype._assertLive,layout:Gpu.prototype.layout,bindGroup:Gpu.prototype.bindGroup,
    L:{EMPTY:{entries:[]}},emptyGroup:{empty:true},
    createBuffer(d){const b={...d,destroy(){this.destroyed=true;}};buffers.push(b);return b;},
    queue:{writeBuffer(...a){uploads.push(a);}},write(...a){uploads.push(a);},flush(){},
    kernel(d){compiled.push(d);return {...d,groups:d.layouts,pipeline:{},ready:Promise.resolve(),
      gpu,dispatch(frame,size,data){
        const pass={setPipeline(){},setBindGroup(i,group){state[i]=group;}};
        // Actual shared binding code resets all groups at every transition.
        Kernel.prototype.bind.call(this,frame,pass,data.bind,data.header,data.params);
        commands.push({name:d.name,size,data,state:[...state]});
      }};},
    frame:{clear(){},_noteGroup(){},_params(header,params){assert.equal(params,V2Params);return {group:'group3-unchanged',offsets:[0,256]};}},
  };
  const state=[];
  if(existing)gpu._v2Table=existing;
  const sim=()=>({gpu,g,id:1,version:0,wholeWrites:0,state:{A:{},B:{},F:{}},marks:{},tables:{},
    L:{STATE_RO:{entries:[0,1]},TABLES:{entries:LAYOUT.TABLES}},header:()=>({}),ready:Promise.resolve()});
  return {gpu,sim,buffers,uploads,compiled,commands,layouts};
}
async function record({contact=contactWGSL,overrides={},existing=null,uniform=true,compact=true}={}) {
  const r=recorder(overrides,existing),engine=new PhysicsV2(r.sim(),{contactWGSL:contact});await engine.ready;
  const {gpu,buffers,uploads,compiled,commands,layouts}=r;
  engine._tick();
  assert.equal(!!engine.blockCompact,compact);
  assert.equal(!!engine.groups.rowUniform,uniform);
  const block=compiled.find(k=>k.name==='v2block');
  assert.equal(compiled.filter(k=>k.name==='v2block').length,1,'one heavy pipeline');
  assert.equal(compiled.filter(k=>k.build==='now').length,1);
  assert.equal(block.code,uniform?v2BlockUniformWGSL(g,compact):v2BlockWGSL(g,contact,compact));
  assert.equal(compiled.filter(k=>k.code.includes('fn contactBlock(')).length,contact?1:0);
  assert.equal(compiled.length,V2_KERNELS.length+(compact?2:0));
  assert.equal(engine.kernels.v2block.params,V2Params);
  assert.equal(block.layouts[0],engine.sim.L.TABLES);
  assert.equal(block.layouts[2],engine.groups.contact.layout);
  if(uniform) {
    assert.equal(block.layouts[1],engine.groups.rowUniform.layout);
    assert.deepEqual(block.layouts[1].entries,[{binding:0,visibility:4,buffer:{type:'uniform',hasDynamicOffset:false,minBindingSize:14656}}]);
    assert.deepEqual(engine.groups.rowUniform.entries,[{binding:0,resource:{buffer:gpu._v2Table,offset:2816,size:14656}}]);
    assert(gpu._uniformLayouts.has(block.layouts[1]));assert(gpu._ourGroups.has(engine.groups.rowUniform));
    assert(!gpu._groupReads.has(engine.groups.rowUniform),'no shared/per-frame upload mechanism');
  } else {
    assert.equal(block.layouts[1],gpu.L.EMPTY);
    assert(!layouts.some(l=>l.label==='V2_CONTACT_ROW_UNIFORM'));
  }
  for(const c of commands) {
    assert.equal(c.state[1],c.name==='v2block'&&uniform?engine.groups.rowUniform:
      ['v2externalEvents','v2invalidate'].includes(c.name)?engine.groups.invalidate:
      c.name==='v2import'?engine.groups.import:gpu.emptyGroup,`${c.name}: no retained group1 state`);
    assert.equal(c.state[3],'group3-unchanged');
  }
  const dispatch=commands.find(c=>c.name==='v2block');
  assert.equal(dispatch.size.offset,(compact?ARGS2.COMPACT:ARGS2.BLOCKS)*4);
  assert.equal(dispatch.size.indirect,engine.args);
  assert.equal(buffers.length,existing?7:8,'no new table/view allocation');
  assert.equal(uploads.length,existing?1:2,'only original table and quiet initialization uploads');
  const table=gpu._v2Table;
  if(existing)assert.equal(table,existing,'old/HMR object retained');
  else {
    assert.equal(table.size,18144);assert.equal(table.usage,1|4|16);
    assert.equal(uploads.filter(u=>u[0]===table).length,1);
  }
  const before={buffers:buffers.length,uploads:uploads.length,compiled:compiled.length};
  const second=new PhysicsV2(r.sim(),{contactWGSL:contact});await second.ready;second._tick();
  assert.equal(gpu._v2Table,table);assert.equal(buffers.length-before.buffers,7,'second engine reuses allocation');
  assert.equal(uploads.length-before.uploads,1,'second engine never reuploads table');
  assert.equal(compiled.length-before.compiled,V2_KERNELS.length+(compact?2:0));
  assert.equal(!!second.groups.rowUniform,uniform);
  // Dispose retains the device-scoped table, including old storage-only ones.
  engine.sim.compact=null;engine.dispose();second.sim.compact=null;second.dispose();
  assert(!table.destroyed);
  return {buffers:before.buffers,uploads:before.uploads};
}
const normal=await record();
const fallback=await record({overrides:{maxUniformBufferBindingSize:14655},uniform:false});assert.deepEqual(normal,fallback);
await record({overrides:{maxStorageBufferBindingSize:g.slots*16},compact:false});
await record({overrides:{maxStorageBufferBindingSize:g.slots*16,maxUniformBufferBindingSize:14655},uniform:false,compact:false});
for(const overrides of [
  {minUniformBufferOffsetAlignment:512},{minUniformBufferOffsetAlignment:undefined},
  {maxUniformBuffersPerShaderStage:2},{maxBindGroups:3},{maxBindingsPerBindGroup:6},{maxStorageBuffersPerShaderStage:6},
])await record({overrides,uniform:false});
for(const existing of [
  {size:18144,usage:1|4}, {size:CONTACT_ROW_UNIFORM.offset+CONTACT_ROW_UNIFORM.size-1,usage:1|4|16},
])await record({existing,uniform:false});
for(const contact of ['',contactWGSL+'\n','fn contactBlock() {}'])await record({contact,uniform:false,compact:false});
console.log('Runtime compact/noncompact/custom/capability/HMR matrix; actual layout/bindGroup/bind APIs; exact range, group transitions, one heavy, no new buffer/upload; stable hashes; no GPU');
