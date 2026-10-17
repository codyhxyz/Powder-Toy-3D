// CPU reference + real native driver recorder. No browser/GPU.
import assert from 'node:assert/strict';
import { nativeModes, modeSignature, gravityAt, gravityPotential, edgeCell, nativeBodyGravity, ballisticModes, GRAVITY_MS2 } from '../../src/v2/modes.js';
import { GRAV, AIR, EDGE } from '../../src/simModes.js';
import { CELL_M } from '../../src/scale.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { gridLayout } from '../../src/sim.js';
import { v2ActLayout, v2GatherWGSL, v2FluxWGSL, v2BlockWGSL, v2BoundaryWGSL } from '../../src/shaders/v2.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { makeMaterial, withEnergy, energyOf, cFill, FULL, advectReference } from '../../src/v2/layout.js';
import { E } from '../../src/elements.js';
const dims=[32,16,48], g=gridLayout(...dims), defaults={g,gravity:0.025,gravityMode:GRAV.VERTICAL,airMode:AIR.ON,ambientHeat:true,edgeMode:EDGE.SOLID,airT:20};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
assert.equal(nativeModes(defaults).gravity,GRAVITY_MS2);
for (const key of ['gravityMode','airMode','edgeMode']) assert.throws(()=>nativeModes({...defaults,[key]:999}),/Unknown native/);
assert.throws(()=>nativeModes({...defaults,gravity:NaN}),/gravity/);
assert.throws(()=>nativeModes({...defaults,gravity:-1}),/gravity/);
assert.throws(()=>nativeModes({...defaults,ambientHeat:0}),/boolean/);
for (const gravityMode of Object.values(GRAV)) for (const magnitude of [0,0.5,1,2]) {
  const sim={...defaults,gravityMode,gravity:0.025*magnitude}, p=nativeModes(sim), at=[4,5,6];
  const force=gravityAt(at,dims,p), body=nativeBodyGravity(sim,at);
  force.forEach((f,a)=>close(f,body[a]*CELL_M));
  close(Math.hypot(...force),gravityMode===GRAV.OFF?0:magnitude*GRAVITY_MS2);
  const motion=ballisticModes(at,[0,0,0],1/60,dims,p);
  motion.velocity.forEach((v,a)=>close(v,force[a]/60));
  motion.position.forEach((x,a)=>close(x-at[a],force[a]/(2*3600*CELL_M)));
  if (gravityMode===GRAV.RADIAL) assert.ok(force.every(f=>f>=0));
}
assert.deepEqual(gravityAt(dims.map(n=>n/2),dims,nativeModes({...defaults,gravityMode:GRAV.RADIAL})),[0,0,0]);
const vertical=nativeModes(defaults); let pos=[4,100,6],velocity=[0,0,0];
for(let tick=0;tick<60;tick++) ({position:pos,velocity}=ballisticModes(pos,velocity,1/60,dims,vertical));
close(velocity[1],-GRAVITY_MS2); close(pos[1],100-GRAVITY_MS2/(2*CELL_M));
for(const mode of [GRAV.VERTICAL,GRAV.RADIAL]) {
  const p=nativeModes({...defaults,gravityMode:mode}), at=[4,5,6], force=gravityAt(at,dims,p);
  for(let axis=0;axis<3;axis++) { const lo=[...at],hi=[...at];lo[axis]-=1e-4;hi[axis]+=1e-4;
    const gradient=(gravityPotential(hi,dims,p)-gravityPotential(lo,dims,p))/2e-4;
    assert.ok(Math.abs(gradient+force[axis]/GRAVITY_MS2)<1e-7);
  }
}
for (const p of [[-1,5,6],[32,5,6],[4,-1,6],[4,16,6],[4,5,-1],[4,5,48]]) {
  assert.equal(edgeCell(p,dims,EDGE.SOLID),null); assert.equal(edgeCell(p,dims,EDGE.VOID),null);
  assert.ok(edgeCell(p,dims,EDGE.LOOP).every((x,a)=>x>=0&&x<dims[a]));
}
assert.equal(nativeModes({...defaults,g:{...g,windowed:true},edgeMode:EDGE.LOOP}).edge,EDGE.SOLID);
// A periodic seam is an ordinary conservative claimant; exact bank/fill survive.
const wet=withEnergy(makeMaterial(E.WATER,85,FULL),energyOf(makeMaterial(E.WATER,85,FULL))+177n);
const empty=makeMaterial(E.EMPTY,20,0), after=advectReference([wet,empty],[{from:0,to:1,amount:12345}]);
assert.equal(after.reduce((s,m)=>s+energyOf(m),0n),energyOf(wet)+energyOf(empty));
assert.equal(after.reduce((s,m)=>s+cFill(m.core),0),FULL);
assert.equal(cFill(after[1].core),12345,'periodic claimant must actually receive material');
// Open ledger is in previously reserved count words, NOT an ABI/save resize.
const layout=v2ActLayout(g); assert.equal(layout.boundaryMass,layout.count+6); assert.equal(layout.boundaryMass+2,layout.legacy);
assert.match(v2FluxWGSL(g),/let q = mEdge\(p \+ face6\(i\)\)/);
assert.match(v2GatherWGSL(g),/mEdge\(p \+ face6\(i32\(face\)\)\)/);
assert.match(v2BoundaryWGSL(g),/noteBoundaryMass\(amount\); noteEnergySink/);
const block=v2BlockWGSL(g,contactWGSL);assert.match(block,/P.edge==1u && mAirHeat\(\)/);assert.match(block,/p.y==NY-1/);
// Real recorder proves certified-rest mode changes wake without importing cells,
// while repeated brush wake does not turn into all-brick activity writes.
globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4,INDIRECT:8};const commands=[];
const gpu={createBuffer:d=>({...d,destroy(){}}),queue:{writeBuffer(...a){commands.push(['write',...a]);}},
  write(...a){commands.push(['write',...a]);},layout:(name,entries)=>({name,entries}),bindGroup:(layout,entries)=>({layout,entries}),
  L:{EMPTY:{}},emptyGroup:{},kernel:d=>({...d,ready:Promise.resolve(),dispatch(frame,size,data){commands.push(['dispatch',d.name,data]);}}),
  readback:{buffer:(b,o,n)=>Promise.resolve(new ArrayBuffer(n))},frame:{clear(){},copy(){}},flush(){}};
const sim={...defaults,gpu,id:1,version:0,wholeWrites:0,frame:0,paints:0,state:{A:{},B:{},F:{}},marks:{},tables:{},L:{STATE_RO:{},TABLES:{}},header:()=>({}),noteWrite(){}};
const engine=new PhysicsV2(sim);await engine.ready;engine.sync();commands.length=0;
for(const [key,value] of [['gravityMode',GRAV.OFF],['gravityMode',GRAV.RADIAL],['gravity',0.05],['airMode',AIR.OFF],['ambientHeat',false],['airT',100],['edgeMode',EDGE.LOOP]]) {
  engine.certified=true;engine.acc=0.375;const beforeEpoch=engine.epoch;sim[key]=value;
  assert.equal(engine.asleep,false);engine._noteWrites();assert.equal(engine.certified,false);assert.equal(engine.acc,0.375);
  assert.ok(engine.epoch>beforeEpoch);assert.equal(engine.importFull,false);assert.equal(engine.importMarked,false);
  // busy0, busy1, every brick's cell note (edge and ambient enter the air source's cached faces)
  // and air note (the air masks)
  assert.equal(commands.length,4);assert.ok(commands.every(c=>c[0]==='write'&&c[1]===engine.act));
  assert.deepEqual([commands[2][2],commands[3][2]],[engine.layout.state*4,engine.layout.air*4]);
  assert.equal(engine.settingsSignature,modeSignature(nativeModes(sim)));commands.length=0;
  engine._noteWrites();assert.equal(commands.length,0);
}
engine.wake();engine.wake();engine._noteWrites();assert.equal(commands.length,0);
engine.ticks(1);assert.ok(!commands.some(c=>c[0]==='dispatch'&&c[1]==='v2import'));
assert.equal(commands.find(c=>c[0]==='dispatch'&&c[1]==='v2block')[2].params.gravMode,GRAV.RADIAL);
engine.dispose();console.log('native modes: strict settings, SI force/body/particle clocks, potential, wrapped claims, open ledger, certified-rest wake and brush isolation passed');
