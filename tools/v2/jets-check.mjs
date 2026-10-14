import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { E } from '../../src/elements.js';
import { FULL, MAX_FILL, makeMaterial, withPayload, energyOf, cTq, cFill, ctypeOf, payloadOf, share, isConductor, energyPacketFits } from '../../src/v2/layout.js';
import { FOAM_ROWS, decayFoam, impactFoam } from '../../src/v2/foam.js';
import { gridLayout } from '../../src/sim.js';
import { CONTROL } from '../../src/shaders/v2/particles.js';
import { jetsWGSL, JET_STAGES } from '../../src/shaders/v2/jets.js';
import { v2GatherWGSL, v2LimitWGSL, v2FoamWGSL, liquidTransportWGSL, SUB, TICK_HZ } from '../../src/shaders/v2.js';

// Independent BigInt conservation oracle for the packet/allocator contract.
// No second WGSL energy implementation: all quantization uses foundation helpers.
function packets(src, amounts, free) {
  let prefix=0, rank=0;
  return amounts.map(amount=>{
    const heat=share(energyOf(src)-BigInt(FULL*cTq(src.core)),prefix,amount,cFill(src.core));
    const fuel=isConductor(src.core[0]&255)?0:Number(share(payloadOf(src.core),prefix,amount,cFill(src.core)));
    prefix+=amount;
    const core=new Uint32Array([src.core[0],(src.core[1]&0xff000000)|amount,0,(isConductor(src.core[0]&255)?payloadOf(src.core):fuel)<<16]);
    const m={core,bank:0};m.bank=Number(heat-(energyOf(m)-BigInt(FULL*cTq(core))));
    const allocated=rank++<free && m.bank>=-2147483648 && m.bank<=2147483647;
    return {amount,heat,fuel,m,allocated};
  });
}
test('partial, dry, conductive sparks, dtype and max-fill packets retain exact material enthalpy',()=>{
  for(const id of [E.WATER,E.OIL,E.MERCURY,E.LAVA]) for(const fill of [1,12347,FULL,MAX_FILL]) {
    let src=makeMaterial(id,30,fill,id===E.LAVA?E.IRON:0);
    src=withPayload(src,isConductor(id)?3608:Math.min(65535,fill));src.bank=-1234567;
    if(id===E.OIL)src.core[1]|=0x80000000;
    const amounts=[Math.floor(fill/3),fill-Math.floor(fill/3)];
    for(const free of [0,1,65536]) {
      const ps=packets(src,amounts,free);
      let gridEnergy=energyOf(src),particleEnergy=0n,gridFill=fill,particleFill=0,gridFuel=isConductor(id)?0:payloadOf(src.core),particleFuel=0;
      for(const p of ps) {
        assert.equal(ctypeOf(p.m.core),ctypeOf(src.core));
        if(isConductor(id))assert.equal(payloadOf(p.m.core),3608);
        if(id===E.OIL)assert.equal(p.m.core[1]>>>31,1);
        assert.equal(energyOf(p.m)-BigInt(FULL*cTq(p.m.core)),p.heat);
        // Ordinary accepted outflow always leaves source. Refusal routes exactly
        // that packet into the destination; successful allocation suppresses it.
        gridEnergy-=p.heat;gridFill-=p.amount;gridFuel-=p.fuel;
        if(p.allocated){particleEnergy+=p.heat;particleFill+=p.amount;particleFuel+=p.fuel;}
        else {gridEnergy+=p.heat;gridFill+=p.amount;gridFuel+=p.fuel;}
      }
      assert.equal(gridEnergy+particleEnergy,energyOf(src));assert.equal(gridFill+particleFill,fill);
      assert.equal(gridFuel+particleFuel,isConductor(id)?0:payloadOf(src.core));
      if(free>=2) assert.equal(gridEnergy,BigInt(FULL*cTq(src.core)));
    }
  }
});
test('allocation is canonical prefix, honest overflow, actual accepted face gate',()=>{
  const code=jetsWGSL(gridLayout(32,32,32),'allocate');
  assert.equal(CONTROL.FREE_LIST,32);
  assert.match(code,/const D_FREE: u32 = 32u/);
  assert.match(code,/requested-free/);assert.match(code,/control\[D_FREE\+free\],i/);
  const spawn=jetsWGSL(gridLayout(32,32,32),'spawn');
  assert.match(spawn,/rank<atomicLoad\(&control\[4\]\)/);assert.match(spawn,/accepted\|=1u<<f/);
  assert.match(liquidTransportWGSL,/energyPacketFits\(src, dst, heat, n\)/);
  const src=makeMaterial(E.WATER,20,FULL),dst=makeMaterial(0,20);
  assert.equal(energyPacketFits(src,dst,share(energyOf(src)-BigInt(FULL*cTq(src.core)),0,1000,FULL),1000),true);
});
test('gather burn follows actual mass, immutable snapshot, no racy full-core flux loads',()=>{
  const g=gridLayout(32,32,32),limit=v2LimitWGSL(g),gather=v2GatherWGSL(g);
  assert.match(limit,/\(c.y & 0xff000000u\)/);
  assert.match(gather,/cFill\(src.core\) > sent/);assert.match(gather,/incoming.amount != 0u/);
  assert.match(gather,/atomicLoad\(&jetMask\[slotOf\(q\)\]\)/);
  assert.doesNotMatch(liquidTransportWGSL,/loadCore\(s\)/);
  assert.match(limit,/atomicStore\(&jetMask\[s\], c.x & 0xff000000u\)/);
  // Sleeping cells have no current snapshot: faceQ must reject them first.
  assert.ok(liquidTransportWGSL.indexOf('!awakeCell(p)')<liquidTransportWGSL.indexOf('!isOpenC(snapshot'));
  assert.match(liquidTransportWGSL,/mEdge\(p \+ face6\(i32\(face\)\)\)/);
  const candidate=jetsWGSL(g,'candidate');
  assert.match(candidate,/!awakeCell\(q\)/);
  assert.match(candidate,/mEdge\(p\+face6\(i32\(face\)\)\)/);
});
test('foam accepts impacts once, preserves incoming, all liquids participate, reaches zero on native clock',()=>{
  assert.equal(impactFoam({incoming:143,amount:FULL,speed2:0}),143);
  assert.equal(impactFoam({incoming:0,amount:FULL,speed2:1}),0);
  assert.ok(impactFoam({amount:FULL,speed2:100})>0);
  for(const id of [E.WATER,E.SALTWATER,E.OIL,E.MERCURY,E.LAVA]) {
    assert.equal(FOAM_ROWS[id].gain,1);
    let foam=255;for(let tick=1;tick<6000;tick++)foam=decayFoam(foam,tick,19,id);
    assert.equal(foam,0);assert.equal(decayFoam(0,6001,19,id),0);
  }
  const physics=readFileSync('src/v2/physics.js','utf8');
  assert.ok(physics.indexOf('run(k.v2limit,')<physics.indexOf('this.jets?.advance'));
  assert.ok(physics.indexOf('this.jets?.advance')<physics.indexOf('run(k.v2gather,'));
  assert.ok(physics.indexOf('run(k.v2foam,')>physics.indexOf('run(k.v2gather,'));
  assert.equal(TICK_HZ,60);assert.equal(SUB,3); // actual production clock, not assumed240Hz
  assert.match(v2FoamWGSL(gridLayout(32,32,32)),/if \(cAge\(after\) != 0u\) \{ markBusy/);
  const renderer=readFileSync('src/shaders/gfx/liquidDetail.js','utf8');
  assert.match(renderer,/fetchNativeAeration\(c\)/);
  assert.match(readFileSync('src/shaders/common.js','utf8'),/f32\(core.x >> 24u\) \/ 255.0/);
});
test('generated square and rectangular WGSL validates with <=8 storage bindings',()=>{
  const dir=mkdtempSync(join(tmpdir(),'jets-check-'));
  try {for(const dims of [[32,32,32],[48,16,32]]) {
    const g=gridLayout(...dims);
    for(const [name,source] of [...JET_STAGES.map(s=>[s,jetsWGSL(g,s)]),['gather',v2GatherWGSL(g)],['limit',v2LimitWGSL(g)],['foam',v2FoamWGSL(g)]]) {
      assert.ok([...source.matchAll(/var<storage,/g)].length<=8,name);
      const path=join(dir,`${name}.wgsl`);writeFileSync(path,source);
      const result=spawnSync('naga',[path],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    }
  }} finally {rmSync(dir,{recursive:true,force:true});}
});
