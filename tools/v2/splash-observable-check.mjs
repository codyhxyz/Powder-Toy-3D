// CPU observer regression only, not physics evidence. Real splash.run via runTest;
// fake in-memory readbacks retain the original 32x16x32 / 3104-mass fixture.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { splash } from '../outcomes/tests/liquids.js';
import { runTest } from '../outcomes/run.js';
import { at, stepClock } from '../outcomes/engine.js';
import { OUTCOMES } from '../outcomes/thresholds.js';

function fake({ ratio = .25, legacy = false, overlay = false, level = false, resident, packet } = {}) {
  const clock = stepClock(60), boxes = [];
  const e = {
    name: 'fake-observer', info: { velocity: true, stepsPerSecond: 60, gravity: 19.6 },
    id: name => name === 'WATER' ? 1 : null,
    async create(size) { assert.deepEqual(size, [32,16,32]); clock.reset(); },
    box(lo, hi, name) { boxes.push([lo, hi, name]); },
    async advance(dt) { clock.take(dt); },
    get time() { return clock.time; }, get steps() { return clock.steps; },
    async dispose() {},
    async read() {
      assert.deepEqual(boxes, [[[0,0,0],[31,2,31],'WATER'], [[14,9,14],[17,10,17],'WATER']]);
      const g = { nx:32, ny:16, nz:32, id:new Int32Array(16384), amount:new Float32Array(16384),
        vel:new Float32Array(49152), particles:[] };
      if (!legacy) g.velocityKnown = new Uint8Array(16384).fill(1);
      for (let y=0; y<3; y++) for (let z=0; z<32; z++) for (let x=0; x<32; x++) {
        const i=at(g,x,y,z); g.id[i]=1; g.amount[i]=1;
      }
      // Initial rest; incoming fall; contact; then the unchanged 0.75s window.
      const post=clock.steps>=3, foot=clock.steps===0 ? 9 : clock.steps===1 ? 5 : clock.steps===2 ? 3 : 4;
      const vy=clock.steps===0 ? 0 : clock.steps<=2 ? -2 : 2*Math.sqrt(ratio);
      for (let y=foot; y<foot+2; y++) for (let z=14; z<=17; z++) for (let x=14; x<=17; x++) {
        const i=at(g,x,y,z); g.id[i]=1; g.amount[i]=1; g.vel[3*i+1]=vy;
        // thrown level and already falling a tick later (V2's crown packets): sideways at the same speed
        if (level && post) { g.vel[3*i]=vy; g.vel[3*i+1]=-.5; }
        if (overlay) {
          g.velocityKnown[i]=0; g.vel[3*i]=NaN; g.vel[3*i+1]=NaN;
          g.particles.push({x:x+.5,y:y+.5,z:z+.5,vx:0,vy,vz:0,mass:1,id:1});
        }
      }
      if (post && resident) resident(g,at(g,14,foot,14));
      if (post && packet) {
        if (!g.particles.length) g.particles.push({x:14.5,y:4.5,z:14.5,vx:0,vy:1,vz:0,mass:0,id:1});
        packet(g.particles[0]);
      }
      return g;
    },
  };
  return e;
}

test('unchanged fixture, timing and criteria: a .25 crown passes, >.3 or none fails, legacy complete vectors work', async () => {
  assert.deepEqual(splash.size,[32,16,32]);
  assert.equal(OUTCOMES.splash.keRatio,.3); assert.equal(OUTCOMES.splash.seconds,.75);
  for (const legacy of [false,true]) {
    const r=await runTest(splash,fake({legacy}));
    assert.equal(r.status,'pass'); assert.ok(Math.abs(r.numbers.ratio-.25)<1e-6);
    assert.equal(r.numbers.incoming,128); assert.equal(r.gameSeconds,.783); assert.equal(r.steps,47);
    assert.equal(r.criteria[1].ok,true);
  }
  // (V1's level throw, 2.48 of the incoming, is past the crown's bound; no splash at all throws no crown)
  for (const ratio of [.36,2.48,0]) {
    const r=await runTest(splash,fake({ratio}));
    assert.equal(r.status,'fail'); assert.equal(r.criteria[1].ok,true);
  }
});

test('a drop thrown level counts its throw though it already falls (V2\'s crown a tick after it left), as V1\'s sliding cell', async () => {
  const r=await runTest(splash,fake({level:true}));
  assert.equal(r.status,'pass'); assert.ok(Math.abs(r.numbers.ratio-.25)<1e-6);
});

test('unknown finite resident vectors and every nonfinite component are setup errors postcontact', async () => {
  const unknown=await runTest(splash,fake({resident:(g,i)=>{g.velocityKnown[i]=0;}}));
  assert.equal(unknown.status,'error'); assert.match(unknown.reason,/setup:.*unknown resident-water/);
  for (const value of [NaN,Infinity,-Infinity]) for (const axis of [0,1,2]) {
    const r=await runTest(splash,fake({resident:(g,i)=>{g.vel[3*i+axis]=value;}}));
    assert.equal(r.status,'error'); assert.match(r.reason,/setup:.*nonfinite resident-water/);
  }
});

test('matter packets validate all position/velocity/mass components before classification', async () => {
  for (const key of ['x','y','z','vx','vy','vz','mass']) for (const value of [NaN,Infinity,-Infinity]) {
    const r=await runTest(splash,fake({packet:p=>{p[key]=value;}}));
    assert.equal(r.status,'error',`${key} ${value}`); assert.match(r.reason,/setup:.*invalid matter packet/);
  }
  const r=await runTest(splash,fake({packet:p=>{p.mass=-1;}}));
  assert.equal(r.status,'error'); assert.match(r.reason,/setup:.*invalid matter packet/);
});

test('pure binned flight overlay with zero resident mass ignores unknown cell mask and NaNs', async () => {
  const r=await runTest(splash,fake({overlay:true}));
  assert.equal(r.status,'pass'); assert.ok(Math.abs(r.numbers.ratio-.25)<1e-6); assert.equal(r.criteria[1].ok,true);
});

test('finite packet inputs cannot overflow energy into a false pass', async () => {
  const r=await runTest(splash,fake({packet:p=>{p.vx=Number.MAX_VALUE;}}));
  assert.equal(r.status,'error'); assert.match(r.reason,/setup:.*nonfinite kinetic energy/);
});

test('actual native capability makes splash expressible, before create or GPU access', async () => {
  // Older production modules use /src imports. Resolve those paths only while
  // importing the actual adapter; no browser, device or replacement model.
  const hooks=registerHooks({resolve(specifier,context,nextResolve) {
    return nextResolve(specifier.startsWith('/src/') ? new URL(`../../${specifier.slice(1)}`,import.meta.url).href : specifier,context);
  }});
  let createEngine;
  try { ({createEngine}=await import('../outcomes/engine-v2.js')); } finally { hooks.deregister(); }
  const gpu=new Proxy({adapterInfo:{}},{get(target,key){assert.equal(key,'adapterInfo');return target[key];}});
  const e=createEngine(gpu);
  // column-run water defines resident liquid motion (native-grid.js columnLiquidVelocity)
  assert.equal(e.info.velocity,true); assert.match(e.info.velocityDetails,/column runs/);
  e.create=()=>{ throw new Error('expressible: create reached'); };
  const r=await runTest(splash,e);
  assert.notEqual(r.status,'n/a'); assert.match(r.reason ?? JSON.stringify(r),/create reached/);
});

test('in-memory removal of new guards reproduces false pass for NaN postcontact numerator', async () => {
  const url=new URL('../outcomes/tests/liquids.js',import.meta.url);
  let source=await readFile(url,'utf8');
  // Source adaptation: remove only the new setup guards, resolve imports for a
  // data URL. No energy formula, sampling, fixture, or criteria are rewritten.
  const guards=[
    /        setup\(Number\.isFinite\(p\.x\)[\s\S]*?'splash: invalid matter packet position, velocity or mass'\);\n/,
    /        setup\(!g\.velocityKnown[^\n]+\n/,
    /        setup\(Number\.isFinite\(vx\)[^\n]+\n/,
    /      setup\(Number\.isFinite\(all\)[^\n]+\n/,
  ];
  for (const guard of guards) { assert.match(source,guard); source=source.replace(guard,''); }
  source=source.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,url).href}'`);
  const mutant=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const options={ratio:1,resident:g=>{for(let i=0;i<g.id.length;i++) if(g.id[i]===1 && i>=3*32*32) g.vel[3*i+1]=NaN;}};
  const fixed=await runTest(splash,fake(options)), broken=await runTest(mutant.splash,fake(options));
  assert.equal(fixed.status,'error'); assert.match(fixed.reason,/setup:.*nonfinite resident-water/);
  assert.notEqual(broken.status,'error'); assert.equal(broken.numbers.ratio,0);
  assert.ok(Number.isNaN(broken.numbers.peakAll));
});
