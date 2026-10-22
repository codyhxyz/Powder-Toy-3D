// CPU only: canonical fixtures and real PhysicsV2/NativeDynamics recording spies.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { gridLayout } from '../../src/sim.js';
import { cellSlot } from '../../src/shaders/common.js';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { makeMaterial, FULL } from '../../src/v2/layout.js';
import { setFall } from '../../src/v2/fall.js';
import { packContact, unpackContact } from '../../src/v2/contact.js';
import { packParticle, ballistic, packetStep, DT, GRAVITY, CELL_M, dynamicsRows } from '../../src/v2/dynamics-reference.js';
import { toGrid, nativeTally, nativeFlight, nativeFall, readNativeState } from './native-grid.js';
import { at } from './engine.js';

function fixture(ny = 8) {
  const layout = gridLayout(16, ny, 8), cells = new Uint32Array(layout.slots * 4), banks = new Int32Array(layout.slots);
  for (let s = 0; s < layout.slots; s++) cells.set(makeMaterial(E.EMPTY).core, s * 4);
  return { layout, origin: [100, 0, -32], cells: cells.buffer, banks: banks.buffer,
    air: new Float32Array(layout.nbricks * 8).buffer, particles: new ArrayBuffer(0) };
}
function put(f, p, m) {
  const s = cellSlot(f.layout, ...p); new Uint32Array(f.cells).set(m.core, s * 4); new Int32Array(f.banks)[s] = m.bank;
}
const engine = { nameOf: id => ELEMENTS[id].key, kindOf: id => ['air','solid','powder','liquid','gas'][ELEMENTS[id].kind] };
test('canonical fields, current brick air units, mixed cells and outside-window packets', () => {
  const f = fixture(), oil = unpackContact(makeMaterial(E.OIL, 100, FULL / 2).core, -123);
  oil.burning = 1; oil.ctype = E.WOOD; oil.life = 777;
  put(f, [2, 3, 4], packContact(oil));
  const brick = cellSlot(f.layout, 2, 3, 4) >> 6;
  new Float32Array(f.air).set([1, -2, 3, 400], brick * 8);
  const particle = (id, pos, mass = FULL) => ({ id: id + 1, position: pos, velocity: [3, -4, 5], ...makeMaterial(id, 50, mass) });
  const ps = [particle(E.WATER, [102.5, 3.5, -27.5], FULL / 4), particle(E.WATER, [99.5, 3.5, -27.5], FULL / 2),
    particle(E.SAND, [102.5, 3.5, -27.5]), particle(E.EMPTY, [102.5, 3.5, -27.5]),
    { ...particle(E.SAND, [102.5, 3.5, -27.5]), core: [254, 0, 0, 0] },
    { ...particle(E.SAND, [102.5, 3.5, -27.5]), core: [255, 0, 0, 0] },
    { ...particle(E.WATER, [102.5, 3.5, -27.5]), id: 0 }];
  f.particles = new Uint8Array(ps.length * 48).buffer;
  ps.forEach((p, i) => new Uint8Array(f.particles).set(new Uint8Array(packParticle(p)), i * 48));
  const g = toGrid(f), i = at(g, 2, 3, 4);
  assert.equal(g.id[i], E.OIL); assert.equal(g.amount[i], .75); assert.equal(g.gridAmount[i], .5);
  assert.equal(g.T[i], 100); assert.equal(g.bank[i], -123); assert.equal(g.burning[i], 1);
  assert.equal(g.ctype[i], E.WOOD); assert.equal(g.life[i], 777 / 2048); assert.equal(g.pressure[i], 400);
  assert.deepEqual([...g.airVel.slice(i * 3, i * 3 + 3)], [1, -2, 3]);
  assert.equal(g.particles.length, 3); assert.equal(g.particles[1].x, -.5);
  assert.equal(g.particles[0].vx, 3); assert.equal(g.particles[0].mass, .25);
  const census = nativeTally(g, engine);
  assert.equal(census.liquid.OIL, .5); assert.equal(census.liquid.WATER, .75);
  assert.deepEqual(census.particles, { WATER: .75, SAND: 1 });
});
test('flight reuses production packet law (the pull, then drag to terminal), not bare gravity; no invented liquid grid fall', () => {
  // straight down from rest: production's CPU twin of a packet's tick (dynamics-reference.js packetStep), tick by tick
  let speed = 0, fell = 0;
  for (let i = 0; i < 30; i++) { const s = packetStep(E.SAND, speed); fell += s.fell; speed = s.v; }
  const [dropX, dropY] = nativeFlight(E.SAND, [0, 0], 30 * DT);
  assert.equal(dropX, 0); assert.ok(Math.abs(dropY + fell / CELL_M) < 1e-9, `dropped ${dropY} cells, packetStep ${-fell / CELL_M}`);
  // thrown sideways, one tick (shaders/v2/particles.js integrate): the tick's pull, then implicit drag on the whole
  // velocity, whose fixed point is the terminal speed; the position takes the tick's mean velocity
  const v = [30 * CELL_M, 0], vt = dynamicsRows[E.SAND].terminal, drag = GRAVITY / (vt * (vt + GRAVITY * DT));
  const rel = [v[0], v[1] - GRAVITY * DT], after = rel.map(c => c / (1 + drag * Math.hypot(...rel) * DT));
  const thrown = nativeFlight(E.SAND, [30, 0], DT), law = v.map((c, a) => 0.5 * (c + after[a]) * DT / CELL_M);
  thrown.forEach((c, a) => assert.ok(Math.abs(c - law[a]) < 1e-12, `axis ${a}: ${c} against ${law[a]}`));
  // the drag acts (bare gravity would carry it the whole 30 cells/s)
  assert.ok(thrown[0] < ballistic([0, 0, 0], [...v, 0]).position[0]);
  assert.equal(nativeFlight(E.WALL, [1, 0], 1), null);
  assert.equal(nativeFall(E.WATER, 1), null);
  assert.ok(nativeFall(E.SAND, 1) > 0);
});
test('native grid readback decodes stored powder velocity, not its fractional age byte', () => {
  const f=fixture(), sand=makeMaterial(E.SAND);
  sand.core=setFall(sand.core,3.92,0.625);
  put(f,[2,3,4],sand);
  const g=toGrid(f), i=at(g,2,3,4);
  assert.ok(Math.abs(g.vel[i*3+1]+3.92)<1e-6);
});

function spyGPU() {
  globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
  const calls = [], kernels = [], buffers = [];
  const copy = (b, offset, source) => new Uint8Array(b.bytes).set(source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength), offset);
  const gpu = { adapterInfo: {}, L: { EMPTY: {} },
    createBuffer({ size, label }) { const b = { size, label, bytes: new ArrayBuffer(size), destroy() {} }; buffers.push(b); return b; },
    queue: { writeBuffer: copy }, write: copy, layout: (_n, l) => l, bindGroup: (_l, b) => b,
    kernel(d) { kernels.push(d); return { ready: Promise.resolve(), dispatch: (_f, size, opts) => calls.push({ name: d.name, size, opts }) }; },
    frame: { clear: (b, offset = 0, n = b.size - offset) => new Uint8Array(b.bytes, offset, n).fill(0), copy() {} },
    readback: { buffer(b, offset, n) { calls.push({ read: b.label }); return Promise.resolve(b.bytes.slice(offset, offset + n)); } }, flush() {} };
  return { gpu, calls, kernels, buffers };
}
test('adapter constructs actual contact and dynamics, checks velocity allocation instead of pretending', async () => {
  const { gpu, calls, kernels } = spyGPU();
  let sim;
  globalThis.OutcomeSimulationSpy = class {
    constructor(gpu, nx, ny, nz) { sim = this; Object.assign(this, { gpu, g: gridLayout(nx,ny,nz), origin: {x:0,y:0,z:0}, id:1, version:0, wholeWrites:0,
      ready: Promise.resolve(), L: {}, state: {}, marks: {}, tables: {} }); }
    editKernel() { return { ready: Promise.resolve() }; }
    edit() { this.version++; }
    header() { return {}; }
    noteWrite() {}
    gpuSync() { return Promise.resolve(); }
    dispose() {}
  };
  // Only Simulation is a spy. Production PhysicsV2, NativeDynamics,
  // shader generators and the adapter's constructor call run unchanged.
  const url = new URL('./engine-v2.js', import.meta.url);
  let source = await readFile(url, 'utf8');
  source = source.replace("import { Simulation } from '../../src/sim.js';", 'const Simulation = globalThis.OutcomeSimulationSpy;')
    .replace(/from '([^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  const { createEngine } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const e = createEngine(gpu);
  try {
    const kernel = gpu.kernel;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    gpu.kernel = d => { const k = kernel(d); if (d.name === 'v2particles_integrate') k.ready = gate; return k; };
    let ready = false;
    const creation = e.create([16,8,8]).then(() => { ready = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready, false); release(); await creation;
    const owner = sim.compactOwner;
    assert.equal(owner.constructor.name, 'PhysicsV2'); assert.equal(owner.dynamics.constructor.name, 'NativeDynamics');
    assert.ok(owner.contactReady && owner.dynamics);
    assert.match(kernels.find(k => k.name === 'v2block').code, /fn contactBlock/);
    assert.ok(kernels.some(k => k.name === 'v2particles_integrate'));
    assert.ok(kernels.some(k => k.name === 'v2air_step'));
    owner.dynamics.airIndex = 1;
    const before = calls.length, pending = readNativeState(owner);
    assert.deepEqual(calls.slice(before).filter(c => c.read).map(c => c.read), [owner.cells.label, owner.aux.label, owner.dynamics.particles.label, owner.dynamics.air[1].label]);
    await pending;
    assert.deepEqual([e.info.velocity,e.info.pressure,e.info.burning,e.info.airCell], [true,true,true,4]);
    assert.throws(() => e.box([1,1,1],[1,1,1], 'WATER', {pressure: 1}), /unsupported/);
    e.box([2,3,4],[3,3,4], 'SAND', {v: [9,0,0]});
    const plan = calls.find(c => c.name === 'v2blasts_bodyPlan');
    assert.deepEqual(plan.opts.params.vector, [9,0,0]); assert.deepEqual(plan.opts.params.boxSize, [2,1,1]);
    assert.equal(plan.opts.params.bodyOnly, E.SAND); assert.equal(plan.opts.params.bodyPushPowder, 0);
    await assert.rejects(e.advance(1/60), /allocator did not accept/); assert.equal(e.steps, 0);
    // Simulate accepted GPU allocation in the authoritative pool, not metadata.
    for (let x=2; x<=3; x++) gpu.write(owner.dynamics.particles, (x-2)*48, packParticle({id:x, position:[x+.5,3.5,4.5], velocity:[9,0,0], ...makeMaterial(E.SAND)}));
    const g = await e.read(); assert.equal(g.particles.length, 2);
  } finally { await e.dispose(); delete globalThis.OutcomeSimulationSpy; }
});
test('app compatibility uses canonical census and cannot certify particle-only activity idle', async () => {
  const f = fixture(), buffers = ['cells','banks','particles','air'].map(k => ({ size: f[k].byteLength, bytes: f[k] }));
  f.particles = packParticle({id:1, position:[99,2,-30], velocity:[2,0,0], ...makeMaterial(E.WATER,20,FULL/2)});
  buffers[2] = {size:f.particles.byteLength, bytes:f.particles};
  const d = {isReady:true, isIdle:false, particles:buffers[2], air:[buffers[3]], airIndex:0, readActivity:async()=>{}};
  const sim = {g:f.layout, origin:{x:100,y:0,z:-32}, stepsPerSecond:60};
  const v2 = {sim, g:f.layout, isReady:true, contactReady:true, dynamics:d, cells:buffers[0], aux:buffers[1],
    unwrittenSinceTick:true, sync(){}, readStats:async()=>({awake:0,units:16,tick:4,lastBusy:1}),
    gpu:{readback:{buffer:async b=>b.bytes}}};
  globalThis.window = {__app:{sim, physics:{active:true,mode:'v2',v2}, settings:{steps:4},
    test:{ready:async()=>{},park(){},elements:ELEMENTS}}};
  globalThis.document = {getElementById:()=>null};
  globalThis.OutcomePageSpy = {on(){},goto:async()=>{},waitForFunction:async()=>{},evaluate:async(fn,arg)=>fn(arg),close:async()=>{}};
  const url = new URL('./engine-app.js', import.meta.url);
  let source = await readFile(url,'utf8');
  source = source.replace("import { newTestPage } from '../browser.mjs';", 'const newTestPage = async () => globalThis.OutcomePageSpy;')
    .replace(/from '([^']+)'/g, (_, path) => `from '${new URL(path,url).href}'`);
  const {createEngine} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const app = createEngine({}, {base:'http://cpu-spy.invalid',expectedPhysics:'v2'});
  try {
    await app.create(null,{url:'/'});
    assert.equal(app.info.velocity,false); assert.match(app.info.velocityDetails,/No complete cell velocities/);
    assert.equal(app.info.pressure,true); assert.equal(app.info.burning,true);
    const c = await app.census(); assert.equal(c.particles.WATER,.5); assert.equal(c.liquid.WATER,.5);
    assert.equal((await app.activity()).idle,false);
    d.isIdle = true; assert.equal((await app.activity()).idle,true);
    v2.contactReady=false; await assert.rejects(app.create(null,{url:'/'}),/integration is unavailable/);
  } finally { await app.dispose(); delete globalThis.window; delete globalThis.document; delete globalThis.OutcomePageSpy; }
});
// Column-run water defines resident motion (native-grid.js columnLiquidVelocity): a face segment's lane is
// its depth-averaged flux, a falling run's bottom y lane its fall speed, a supported run no vertical motion.
const LANE_MS = 60 * 0.3 / FULL;
test('a face lane reads as its segment\'s depth-averaged velocity at every row it spans (MAC mean)', () => {
  const f = fixture();
  for (let x = 0; x < 16; x++) for (let z = 0; z < 8; z++) put(f, [x, 0, z], makeMaterial(E.WALL));
  const a = makeMaterial(E.WATER); a.core[2] |= 0x3c00;   // f16 1.0 in the x lane of the segment's bottom
  put(f, [1, 1, 1], a); put(f, [1, 2, 1], makeMaterial(E.WATER)); put(f, [2, 1, 1], makeMaterial(E.WATER));
  const saved = new Uint8Array(f.cells).slice(), g = toGrid(f);
  for (const p of [[1, 1, 1], [1, 2, 1], [2, 1, 1]]) {
    const i = at(g, ...p);
    assert.equal(g.velocityKnown[i], 1, `${p} known`);
    assert.ok(Math.abs(g.vel[3 * i] - (p[0] === 1 && p[1] === 2 ? 0.5 : 0.5) * LANE_MS) < 1e-12, `${p}: vx ${g.vel[3 * i]}`);
    assert.equal(g.vel[3 * i + 1], 0, 'a supported run holds no vertical momentum');
  }
  assert.deepEqual(new Uint8Array(f.cells), saved, 'observation does not change packed state');
});
test('a falling run reports its fall speed; a supported run\'s stale y lane is not motion', () => {
  const f = fixture();
  for (let x = 0; x < 16; x++) for (let z = 0; z < 8; z++) put(f, [x, 0, z], makeMaterial(E.WALL));
  const falling = makeMaterial(E.WATER); falling.core[2] |= 0x3c000000;   // f16 1.0 cells a tick in the y lane
  put(f, [3, 5, 3], falling); put(f, [3, 6, 3], makeMaterial(E.WATER));
  const resting = makeMaterial(E.WATER); resting.core[2] |= 0x3c000000; put(f, [6, 1, 6], resting);
  const g = toGrid(f);
  for (const y of [5, 6]) { const i = at(g, 3, y, 3); assert.equal(g.velocityKnown[i], 1); assert.ok(Math.abs(g.vel[3 * i + 1] + 60 * 0.3) < 1e-9); assert.equal(g.vel[3 * i], 0); }
  const i = at(g, 6, 1, 6); assert.equal(g.velocityKnown[i], 1); assert.equal(g.vel[3 * i + 1], 0);
});
test('fresh and restored zero-flux bytes read as known rest; a launch mark is unknown', () => {
  const fresh = fixture();
  put(fresh, [2, 2, 2], makeMaterial(E.WATER));
  const restored = { ...fresh, cells: fresh.cells.slice(0), banks: fresh.banks.slice(0) };
  for (const f of [fresh, restored]) {
    const g = toGrid(f), i = at(g, 2, 2, 2);
    assert.equal(g.velocityKnown[i], 1);
    assert.deepEqual([...g.vel.subarray(i * 3, i * 3 + 3)], [0, 0, 0]);
    assert.equal(g.moving, null, 'the motion mask stays unpublished');
    assert.equal(g.gridAmount[i], 1);
  }
  const marked = fixture(), m = makeMaterial(E.WATER); m.core[2] |= 0xbc000000;   // f16 -1.0: JET_MARK
  put(marked, [4, 3, 4], m);
  const g = toGrid(marked), i = at(g, 4, 3, 4);
  assert.equal(g.velocityKnown[i], 0); assert([...g.vel.subarray(i * 3, i * 3 + 3)].every(Number.isNaN));
});
test('real hole-profile mouth observation preserves unknown, known zero and known motion', async () => {
  const source = await readFile(new URL('../v2/boot-profile.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const mouth=[];'), end = source.indexOf("note({stage:'hole-state'", start);
  assert(start >= 0 && end > start, 'exercise the actual profiler block, without launching its browser');
  const mouthOf = new Function('g', 'engine', source.slice(start, end) + 'return mouth;');
  const f = fixture(16);
  put(f, [7,13,3], makeMaterial(E.WATER));
  const g = toGrid(f), mouth = mouthOf(g, engine);
  assert.equal(mouth.length, 9);
  assert.equal(mouth[0].id, 'WATER'); assert.equal(mouth[0].mass, 1);
  assert.equal(mouth[0].moving, null);
  assert.equal(JSON.parse(JSON.stringify(mouth))[0].moving, null, 'unknown remains explicit in JSONL');
  g.moving = new Uint8Array(g.id.length);
  assert.equal(mouthOf(g, engine)[0].moving, 0, 'known zero must not become unknown');
  g.moving[at(g, 7,13,3)] = 1;
  assert.equal(mouthOf(g, engine)[0].moving, 1);
});
