// CPU-only recorder: production PhysicsV2/NativeDynamics/NativeJets, no GPU.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridLayout, Simulation } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { GRAV, AIR, EDGE } from '../../src/simModes.js';
import { nativeModes } from '../../src/v2/modes.js';
import { SUB, v2LiquidListLayout } from '../../src/shaders/v2.js';

globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4,INDIRECT:8};
function recorder(ready = () => Promise.resolve()) {
  const commands=[], buffers=[];
  const gpu={
    createBuffer(d){const b={...d,destroys:0,destroy(){this.destroys++;}};buffers.push(b);return b;},
    queue:{writeBuffer(){}},write(){},flush(){},
    layout:(name,entries)=>({name,entries}),L:{EMPTY:{entries:[]}},emptyGroup:{},
    bindGroup(layout,entries){assert.equal(layout.entries.length,entries.length);return {layout,entries};},
    kernel(d){assert.ok(d.layouts.reduce((n,l)=>n+l.entries.length,0)<=8);return {...d,ready:ready(d.name),dispatch(frame,size,data){d.params.pack(data.params);commands.push({name:d.name,size,...data});}};},
    frame:{clear(buffer){commands.push({clear:buffer});},copy(){}},
    readback:{buffer:(b,o,n)=>Promise.resolve(new ArrayBuffer(n))},
  };
  const sim={gpu,g:gridLayout(32,16,48),id:1,version:0,wholeWrites:0,frame:0,paints:0,origin:[32,0,-48],
    state:{A:{},B:{},F:{}},marks:{},tables:{},L:{STATE_RO:{entries:[0,1]},TABLES:{entries:[0]}},header:()=>({format:0}),noteWrite(){}};
  return {sim,commands,buffers};
}

test('real driver shares canonical pool and records every jet stage between snapshot and gather',async()=>{
  const {sim,commands,buffers}=recorder();
  const owner=new PhysicsV2(sim,{Dynamics:NativeDynamics});await owner.ready;owner.ticks(1);
  assert.equal('nativeJets' in owner._params(1),false);
  assert.equal(owner.dynamics._params(1).nativeJets,1);
  assert.equal(owner.jets.group.entries[2].resource.buffer,owner.dynamics.particles);
  assert.equal(owner.jets.group.entries[3].resource.buffer,owner.dynamics.control);
  assert.equal(owner.dynamics.particles.size,48*65536);
  assert.equal(owner.jetMask.size,v2LiquidListLayout(sim.g).words*4);
  const names=commands.map(c=>c.name);
  const support=commands.findIndex(c=>c.name==='v2support'),block=commands.findIndex(c=>c.name==='v2block');
  assert.equal(block,support+1,'Support snapshot immediately precedes block');
  assert.equal(commands[support].bind[2],owner.groups.contact);
  assert.equal(commands[block].bind[2],owner.groups.contact);
  assert.equal(owner.groups.contact.entries.find(e=>e.binding===5).resource.buffer,owner.liquidScratch);
  assert.equal(owner.groups.liquid.entries.find(e=>e.binding===5).resource.buffer,owner.liquidScratch,'same scratch allocation reused');
  for(let substep=0;substep<SUB;substep++) {
    const candidate=commands.findIndex(c=>c.name==='v2jets_candidate'&&c.params.substep===substep);
    assert.deepEqual(names.slice(candidate-1,candidate+8),['v2limit','v2jets_candidate','v2jets_count','v2blasts_freeCount','v2blasts_freeScan','v2blasts_freeScatter','v2jets_allocate','v2jets_spawn','v2gather']);
    const jet=commands[candidate];assert.equal(jet.bind[0],owner.nativeDynamics.group);assert.equal(jet.bind[1],owner.jets.group);
    assert.deepEqual(jet.params.origin,sim.origin);
  }
  assert.equal(commands.find(c=>c.name==='v2blasts_couplePlan').params.nativeJets,1);
  assert.equal(names.filter(n=>n==='v2foam').length,1);assert.equal(names.includes('v2bridge'),false);
  assert.equal(Simulation.prototype.readHeader.call(sim).format,2);
  assert.equal(Simulation.prototype.readHeader.call(sim,{physical:true}).format,3);
  // Modes, periodic edges, and world-window clamping reach actual jet uniforms.
  for(const gravityMode of Object.values(GRAV)) for(const airMode of Object.values(AIR)) for(const edgeMode of Object.values(EDGE)) {
    Object.assign(sim,{gravityMode,airMode,edgeMode,ambientHeat:false});commands.length=0;owner.ticks(1);
    for(const c of commands.filter(c=>c.name?.startsWith('v2jets_'))) for(const [key,value] of Object.entries(nativeModes(sim))) assert.equal(c.params[key],value);
  }
  sim.g.windowed=true;sim.edgeMode=EDGE.LOOP;commands.length=0;owner.ticks(1);
  assert.equal(commands.find(c=>c.name==='v2jets_candidate').params.edge,EDGE.SOLID);
  owner.suspend();assert.equal(Simulation.prototype.readHeader.call(sim).format,0);
  owner.activate();commands.length=0;owner.restore({},{});
  for(const b of [owner.liquidScratch,owner.jetMask]) assert.ok(commands.some(c=>c.clear===b));
  commands.length=0;owner.ticks(1);
  assert.ok(commands.findIndex(c=>c.name==='v2limit')<commands.findIndex(c=>c.name==='v2jets_candidate'));
  owner.dispose();owner.dispose();
  for(const b of buffers.filter(b=>b!==sim.gpu._v2Table)) assert.equal(b.destroys,1,b.label);
  assert.equal(owner.jets.isReady,false);assert.throws(()=>owner.jets.advance(1,0),/not ready/);
});

test('pending and failed jet pipelines prevent owner ticks; disposed owner never revives',async()=>{
  for(const outcome of ['ready','failed','disposed']) {
    let resolve,reject;const gate=new Promise((a,b)=>{resolve=a;reject=b;});
    const {sim,commands,buffers}=recorder(name=>name==='v2jets_spawn'?gate:Promise.resolve());
    const owner=new PhysicsV2(sim,{Dynamics:NativeDynamics});
    assert.equal(owner.ticks(1),0);assert.equal(owner.jets.isReady,false);assert.equal(owner.isReady,false);
    if(outcome==='disposed') owner.dispose();
    if(outcome==='failed') {reject(new Error('jet compilation failed'));await assert.rejects(owner.ready,/jet compilation failed/);assert.equal(owner.ticks(1),0);}
    else {resolve();await owner.ready;assert.equal(owner.isReady,outcome==='ready');assert.equal(owner.jets.isReady,outcome==='ready');}
    assert.equal(commands.some(c=>c.name==='v2jets_candidate'),false);
    owner.dispose();owner.dispose();
    for(const b of buffers.filter(b=>b!==sim.gpu._v2Table)) assert.equal(b.destroys,1,b.label);
  }
});
