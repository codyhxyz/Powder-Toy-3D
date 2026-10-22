// CPU-only: The Powder Toy's decoration layer (src/deco.js) rides Physics V2's moves as it rides V1's
// (shaders/move.js: a cell takes its content's source's paint, and air holds none). Pins
//   (1) the plane's ownership: V2 keeps it in its aux buffer beside the banks (shaders/v2/state.js
//       auxLayout), takes it from V1 when it starts or resumes and hands it back when it stops;
//       undo/saves of the banks leave it alone; the moves carry it only while the layer may hold paint;
//   (2) the block pass (topple, sink/float, gas swaps, reactions) and the column fall, by executing their
//       emitted WGSL deco statements on CPU twins;
//   (3) column-run water (falls, flow, drains), by executing the emitted col* bodies (column-wgsl.mjs);
//   (4) launches, flight and landings (jets, blasts, Factory machines through blasts' apply, particle
//       deposits), the brush's native retype/Mix and the POV transfer, as WGSL contracts (naga validates
//       the modules: dynamics-wgsl-check, compact-wgsl-check);
//   (5) flying paint survives dynamics snapshots (undo, saves, World shifts) and is drawn on particles.
// No GPU, browser or WebGPU execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { v2BlockWGSL, v2ColumnWGSL } from '../../src/shaders/v2.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { auxLayout, decoStorageWGSL } from '../../src/shaders/v2/state.js';
import { jetsWGSL } from '../../src/shaders/v2/jets.js';
import { blastsWGSL } from '../../src/shaders/v2/blasts.js';
import { particlesWGSL, PARTICLE_CAP } from '../../src/shaders/v2/particles.js';
import { nativeDynamicsHead } from '../../src/shaders/v2.js';
import { nativePaintWGSL, nativePaintParams } from '../../src/v2/nativePaint.js';
import { nativeTransferWGSL } from '../../src/shaders/v2/transfer.js';
import { airWGSL } from '../../src/shaders/v2/air.js';
import { v2BoundaryWGSL } from '../../src/shaders/v2.js';
import { nativeWeatherCommitWGSL, nativeWeatherParams, NATIVE_WEATHER_SCRUB } from '../../src/v2/nativeWeather.js';
import { validateDynamicState } from '../../src/v2/dynamics.js';
import { emptyDynamicState } from '../../src/v2/dynamicState.js';
import { NativeParticles } from '../../src/gfx/nativeParticles.js';
import { nativeParticleWGSL, NATIVE_PARTICLE_LAYOUT } from '../../src/shaders/v2/particleRender.js';
import { decoView } from '../../src/deco.js';
import { marksLayout } from '../../src/shaders/common.js';
import { ColumnGrid } from './column-wgsl.mjs';
import { E } from '../../src/elements.js';
import * as L from '../../src/v2/layout.js';
import { Matrix4, PerspectiveCamera, WebGPUCoordinateSystem } from 'three';

const RED = 0xff0000ff, BLUE = 0xffff0000, GREEN = 0xff00ff00, STALE = 0x80808080;

// ---------------------------------------------------------------- (1) ownership of the plane
globalThis.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100 };
const buffer = ({ size, ...desc }) => ({ ...desc, size, data: new Uint8Array(size), destroy() {} });
const words = (b, at = 0, n = b.size / 4 - at) => new Uint32Array(b.data.buffer, at * 4, n);
function fakeGPU() {
  return {
    testMode: true, L: { EMPTY: [] }, emptyGroup: {}, stats: { flushes: 0 },
    createBuffer: buffer, layout: (name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
    queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); } },
    write(b, at, data) { this.queue.writeBuffer(b, at, data); },
    frame: { copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); }, clear(b, at = 0, n = b.size - at) { b.data.fill(0, at, at + n); } },
    kernel: ({ name }) => ({ name, state: 'ready', ready: Promise.resolve(), dispatch() {} }),
    readback: { buffer: (b, at, n) => Promise.resolve(b.data.slice(at, at + n).buffer) },
    flush() {},
  };
}
function fakeSim(g) {
  const gpu = fakeGPU(), bytes = g.slots * 16;
  return Object.assign(Object.create(Simulation.prototype), {
    gpu, g, id: 1, origin: { x: 0, y: 0, z: 0 }, cur: 0, version: 0, wholeWrites: 0, frame: 0, paints: 0,
    L: { TABLES: [], STATE_RO: [], STATE_RW: [], UNDO: [], FLOW_SHIFT: [] }, tables: {}, marks: buffer({ size: marksLayout(g).words * 4 }),
    state: { A: buffer({ size: bytes * 2 }), B: buffer({ size: bytes * 2 }), F: buffer({ size: g.slots * 8 }) },
    _bindRO: {}, _bindRW: {}, _bindFlagsRO: {}, _bindAct: {}, history: [], flow: buffer({ size: g.slots * 8 }),
    _shiftListeners: [], wake() {}, _retire() {}, stillFlow() {}, noteWrite() {},
    // V1's decoration layer, attached and painted (src/sim.js attachDeco, _side: moveSrc's first plane)
    sideDeco: true, moveSrc: buffer({ size: g.slots * 4 }), deco: { active: true },
  });
}

test('V2 owns the plane while it runs: taken at start and resume, handed back at a stop; banks-only undo and saves', async () => {
  const g = gridLayout(16, 16, 16), sim = fakeSim(g);
  const v1 = words(sim.moveSrc);
  for (let s = 0; s < g.slots; s++) v1[s] = s % 5 ? 0 : (RED ^ s) >>> 0;
  const painted = v1.slice();
  const owner = new PhysicsV2(sim); await owner.ready;
  const a = auxLayout(g.slots, PARTICLE_CAP);
  assert.equal(owner.aux.size, a.words * 4, 'banks, then the grid\'s decoration, then the particle pool\'s');
  assert.deepEqual([a.banks, a.deco, a.particleDeco], [0, g.slots, 2 * g.slots]);
  assert.equal(sim.decoPlane.buffer, owner.aux, 'the deco tools, the volume and the World source read V2\'s plane');
  assert.equal(sim.decoPlane.offset, g.slots * 4); assert.equal(sim.decoPlane.size, g.slots * 4);
  assert.equal(sim.decoPlane.offset % 256, 0, 'a storage binding offset (minStorageBufferOffsetAlignment)');
  assert.deepEqual(words(owner.aux, a.deco, g.slots), painted, 'the paint V1 carried is V2\'s at its start');
  assert.equal(owner._params(1).deco, 1, 'the moves carry the plane while the layer may hold paint');
  sim.deco.active = false; assert.equal(owner._params(1).deco, 0, 'nothing painted: no move reads or writes it (V1\'s decoCarried)'); sim.deco.active = true;
  // the banks' undo and save words never touch the plane
  words(owner.aux, 0, g.slots).fill(7);
  owner.restore(buffer({ size: g.slots * 16 }), null);
  assert.ok(words(owner.aux, 0, g.slots).every(w => w === 0), 'a restore without banks clears the banks');
  assert.deepEqual(words(owner.aux, a.deco, g.slots), painted, '...and only the banks (the decoration has its own undo)');
  const saved = await owner.captureState('v2');
  const meta = JSON.parse(new TextDecoder().decode(saved.subarray(12, 12 + new DataView(saved.buffer).getUint32(8, true))));
  assert.equal(meta.hasAux, true);
  // (V2 presents the plane from its first activation on: a hand-back to V1's move went with V1)
  assert.equal(sim.decoPlane.buffer, owner.aux, 'the plane is V2\'s while it presents the grid');
});

// ---------------------------------------------------------------- (2) the block pass and the column fall, executed
const g16 = gridLayout(16, 16, 16);
function jsOf(wgsl) {
  return wgsl.replace(/\/\/[^\n]*/g, '').replace(/var (\w+): array<u32, 8>;/g, 'let $1 = [0, 0, 0, 0, 0, 0, 0, 0];')
    .replace(/\bvar\b/g, 'let').replace(/\b(\d+)u\b/g, '$1');
}
function between(text, from, to) {
  const a = text.indexOf(from); assert.ok(a >= 0, from);
  const b = text.indexOf(to, a); assert.ok(b > a, to);
  return text.slice(a, b);
}
const block = v2BlockWGSL(g16, contactWGSL);
const blockCarry = new Function('P', 'blockCount', 'positions', 'cs', 'orig', 'fromCell', 'decoOf', 'setDeco', 'slotOf', 'inGrid', 'cid', 'select',
  jsOf(between(block, '  if (P.deco != 0u) {\n    var dc', '  for (var i = 0u; i < blockCount; i++) {\n    let p = positions[i];')));

test('block pass: every swap moves its paint with the content; air and matter born in air hold none; reactions keep it', () => {
  // the five move rules swap fromCell beside the banks (topple, landing scatter, sink/float, the diagonal escape, gas jitter)
  assert.equal(block.match(/let bank = bs\[\w+\]; bs\[/g).length, 5);
  assert.equal(block.match(/let came = fromCell\[\w+\]; fromCell\[/g).length, 5, 'each bank swap is a paint swap');
  assert.ok(block.indexOf('if (P.deco != 0u) {\n    var dc') > block.indexOf('contactBlock(&cs'), 'after the contact rules: what they made is known');
  const id = (e) => new Uint32Array([e, 0, 0, 0]), cid = c => c[0] & 255;
  const plane = new Uint32Array(8), slotOf = p => p, positions = [0, 1, 2, 3, 4, 5, 6, 7];
  // 0 WATER under 4 SAND (sink: they swap); 1 stale paint on AIR; 2 AIR a reaction turned to FIRE; 3 WOOD
  // that burns in place; 5 GAS that diffuses into 6 AIR; 7 out of the grid
  plane.set([BLUE, STALE, STALE, GREEN, RED, BLUE, STALE, RED]);
  const orig = [id(E.WATER), id(0), id(0), id(E.WOOD), id(E.SAND), id(E.SMOKE), id(0), id(E.WALL)];
  const cs = [id(E.SAND), id(0), id(E.FIRE), id(E.FIRE), id(E.WATER), id(0), id(E.SMOKE), id(E.WALL)];
  const fromCell = [4, 1, 2, 3, 0, 6, 5, 7];
  const run = (deco) => {
    const out = plane.slice();
    blockCarry({ deco }, 8, positions, cs, orig, fromCell, s => out[s], (s, d) => { out[s] = d; }, slotOf, p => p !== 7, cid, (a, b, c) => (c ? b : a));
    return out;
  };
  assert.deepEqual([...run(1)], [RED, 0, 0, GREEN, BLUE, 0, BLUE, RED]);
  assert.deepEqual([...run(0)], [...plane], 'P.deco 0: the plane is untouched');
});

const column = v2ColumnWGSL(g16);
const columnCarry = new Function('P', 'p', 'q', 'o', 'decoOf', 'setDeco', 'slotOf', 'cid', 'select',
  jsOf(between(column, '      if (P.deco != 0u) { let d = decoOf(slotOf(p));', '\n')));

test('column fall: a falling grain takes its paint down; the air it leaves holds none; a gas it falls through keeps its own', () => {
  assert.ok(column.indexOf('if (P.deco != 0u) { let d = decoOf(slotOf(p));') < column.indexOf('storeMaterial(slotOf(q), destination, Material(c, source.bank));'));
  const fall = (o, below) => {
    const plane = [RED, below];
    columnCarry({ deco: 1 }, 0, 1, new Uint32Array([o, 0, 0, 0]), s => plane[s], (s, d) => { plane[s] = d; }, s => s, c => c[0] & 255, (a, b, c) => (c ? b : a));
    return plane;
  };
  assert.deepEqual(fall(0, STALE), [0, RED], 'into air: the grain\'s paint goes down, the air above holds none');
  assert.deepEqual(fall(E.SMOKE, BLUE), [BLUE, RED], 'through a painted gas: the two trade places with their paint');
});

// ---------------------------------------------------------------- (3) column-run water, executed
function walls(w) {
  for (let y = 0; y < w.ny; y++) for (let z = 0; z < w.nz; z++) for (let x = 0; x < w.nx; x++)
    if (y === 0 || x === 0 || z === 0 || x === w.nx - 1 || z === w.nz - 1) w.set(x, y, z, E.WALL);
}
function paintAll(w, colour, pick) {
  for (let i = 0; i < w.n; i++) if (pick(L.cid(w.cores[i]))) w.deco[i] = colour;
}
function census(w) {
  let wet = 0, painted = 0, airPaint = 0;
  for (let i = 0; i < w.n; i++) {
    const id = L.cid(w.cores[i]), liquid = L.isLiquid(id) && L.cFill(w.cores[i]) > 0;
    if (liquid) { wet++; if (w.deco[i] === RED) painted++; }
    if (id === 0 && w.deco[i]) airPaint++;
  }
  return { wet, painted, airPaint };
}

test('column water: a painted dam break, falling run and drain keep their paint on the water and none on air', () => {
  const w = new ColumnGrid(16, 16, 8, { deco: 1 });
  walls(w);
  // a dam of water at one end, and a slab held mid-air that falls as a run
  for (let y = 1; y < 9; y++) for (let z = 1; z < 7; z++) for (let x = 1; x < 4; x++) w.set(x, y, z, E.WATER);
  for (let z = 1; z < 7; z++) for (let x = 9; x < 12; x++) w.set(x, 12, z, E.WATER);
  paintAll(w, RED, id => id === E.WATER);
  const start = census(w);
  for (let t = 0; t < 240; t++) w.step();
  const end = census(w);
  assert.ok(end.wet > start.wet, `the dam spread (${start.wet} → ${end.wet} wet cells)`);
  assert.equal(end.painted, end.wet, 'every cell the paint\'s water reached holds its paint (receivers that were air take the source\'s)');
  assert.equal(end.airPaint, 0, 'every cell the water left holds none');
  // without the layer the moves carry nothing (the plane stays all 0)
  const off = new ColumnGrid(16, 16, 8, { deco: 0 });
  walls(off);
  for (let y = 1; y < 9; y++) for (let z = 1; z < 7; z++) for (let x = 1; x < 4; x++) off.set(x, y, z, E.WATER);
  for (let t = 0; t < 30; t++) off.step();
  assert.ok(off.deco.every(d => d === 0));
});

test('column water: two liquids keep their own paint where they meet; a receiver that holds liquid keeps its own', () => {
  const w = new ColumnGrid(16, 12, 8, { deco: 1 });
  walls(w);
  for (let y = 1; y < 3; y++) for (let z = 1; z < 7; z++) for (let x = 1; x < 15; x++) w.set(x, y, z, E.WATER);
  for (let y = 3; y < 9; y++) for (let z = 1; z < 7; z++) for (let x = 1; x < 4; x++) w.set(x, y, z, E.WATER);
  for (let i = 0; i < w.n; i++) if (L.cid(w.cores[i]) === E.WATER) {
    const y = Math.floor(i / (w.nx * w.nz));
    w.deco[i] = y < 3 ? BLUE : RED;
  }
  for (let t = 0; t < 120; t++) w.step();
  let blue = 0;
  for (let i = 0; i < w.n; i++) if (L.cid(w.cores[i]) === E.WATER && w.deco[i] === BLUE) blue++;
  assert.ok(blue > 0, 'the pool the dam fell into keeps its own paint');
  // (where red fill joins a blue cell it mixes by fill, columns.js colPaintMix: RX-3), never any other paint
  for (let i = 0; i < w.n; i++) if (L.cid(w.cores[i]) === E.WATER) { const d = w.deco[i]; assert.ok(d === BLUE || d === RED || ((d >>> 24) === 255 && ((d >>> 8) & 255) === 0 && Math.abs((d & 255) + ((d >>> 16) & 255) - 255) <= 2), `no water lost its paint (${d.toString(16)})`); }
});

// ---------------------------------------------------------------- (4) launches, flight, landings, tools
const statements = (code) => code.replace(/\/\/[^\n]*/g, '');
test('every particle spawn writes its slot\'s paint: a cell\'s own, none for rays', () => {
  const spawners = [jetsWGSL(g16, 'spawn'), ...['apply', 'children', 'rayEmit'].map(s => blastsWGSL(g16, nativeDynamicsHead, s))];
  for (const code of spawners) {
    for (const line of statements(code).split('\n').filter(l => /particles\[\w+\] ?= ?(dParticle|born)/.test(l))) {
      assert.match(line + statements(code).split(line)[1].split('\n').slice(0, 4).join('\n'), /setParticleDeco\(/, `a spawn without paint: ${line.trim()}`);
    }
  }
  const jets = statements(jetsWGSL(g16, 'spawn'));
  assert.match(jets, /setParticleDeco\(dest,decoOf\(t\)\); setDeco\(t,0u\);\s*storeMaterial\(t,before,withEnergy\(empty,rest\)\)/, 'a jet takes the cell\'s paint and leaves air unpainted');
  const apply = statements(blastsWGSL(g16, nativeDynamicsHead, 'apply'));
  assert.match(apply, /setParticleDeco\(dest,select\(decoOf\(slot\),0u,cid\(m\.core\)>=D_PHOTON\)\)/, 'blast/Factory launches carry the cell\'s paint (rays none)');
  assert.match(apply, /after=remainder; if \(cid\(after\.core\)==0u\) \{ setDeco\(t,0u\); \}/, 'a cell launched whole leaves unpainted air; a split liquid keeps its paint');
  assert.match(statements(blastsWGSL(g16, nativeDynamicsHead, 'children')), /setParticleDeco\(dest,0u\)/);
  assert.match(statements(blastsWGSL(g16, nativeDynamicsHead, 'rayEmit')), /setParticleDeco\(slot,0u\)/);
});

test('airborne reactions: a charge landing in flight brings its paint; a displaced gas flies off with the cell\'s; plumes in air are unpainted', () => {
  const react = statements(particlesWGSL(g16, nativeDynamicsHead, 'react'));
  assert.match(react, /let paint = particleDecoOf\(t\);\s*if \(r\.state == D_REACT_LANDED\) \{ setDeco\(s,paint\); \}\s*else if \(r\.state == D_REACT_DISPLACED\) \{ setParticleDeco\(t,decoOf\(s\)\); setDeco\(s,paint\); \}\s*else if \(cid\(before\.core\) != cid\(r\.host\.core\) && \(cid\(before\.core\) == 0u \|\| cid\(r\.host\.core\) == 0u\)\) \{ setDeco\(s,0u\); \}\s*storeMaterial\(s,before,r\.host\)/);
  // the cells beside it it changes: air, or matter made in air, holds no paint (the block pass's rule)
  assert.match(react, /if \(cid\(was\.core\) != cid\(now\.core\) && \(cid\(was\.core\) == 0u \|\| cid\(now\.core\) == 0u\)\) \{ setDeco\(slots\[f\],0u\); \}\s*storeMaterial\(slots\[f\],was,now\);/);
});

test('a landing brings the paint back to the grid: into air the particle\'s, into its own liquid the receiver\'s', () => {
  const deposit = statements(particlesWGSL(g16, nativeDynamicsHead, 'deposit'));
  assert.match(deposit, /if \(cid\(before\.core\)==0u\) \{ setDeco\(s,particleDecoOf\(t\)\); \}\s*storeMaterial\(s,before,admitted\.material\)/);
  // the deposit stage is the only place flying matter re-enters the grid
  for (const stage of ['integrate', 'elect', 'impact']) assert.doesNotMatch(statements(particlesWGSL(g16, nativeDynamicsHead, stage)), /storeMaterial\(s,before,admitted/);
});

test('the brush\'s native retype and Mix scrub as V1\'s brush does; POV transfer cargo is unpainted, as V1\'s', () => {
  const commit = statements(nativePaintWGSL(g16, nativePaintParams(), 'commit'));
  assert.match(statements(nativePaintWGSL(g16, nativePaintParams(), 'particleCommit')), /if\(cid\(m\.core\)!=cid\(before\.core\)\) \{ setParticleDeco\(i,0u\); \}\s*paintParticles\[i\]=particle;/,
    'a flying cell the brush retypes loses its paint too');
  assert.match(commit, /if\(cid\(m\.core\)!=cid\(before\.core\)\) \{ setDeco\(s,0u\); \}\s*storeMaterial\(s,before,m\)/);
  const transfer = statements(nativeTransferWGSL(g16));
  assert.match(transfer, /cores\[s\] = put; banks\[s\] = bitcast<i32>\(extra\.x\);\s*banks\[SLOTS \+ s\] = 0;/);
  assert.match(transfer, /banks\[s\] = 0; banks\[SLOTS \+ s\] = 0;/);
  // every family with material storage has the plane's accessors at the auxLayout offsets
  for (const code of [v2BlockWGSL(g16, contactWGSL), nativeDynamicsHead(g16)]) assert.ok(code.includes(decoStorageWGSL));
  assert.match(decoStorageWGSL, /fn decoOf\(slot: u32\) -> u32 \{ return bitcast<u32>\(banks\[SLOTS \+ slot\]\); \}/);
  assert.match(decoStorageWGSL, /fn particleDecoOf\(i: u32\) -> u32 \{ return bitcast<u32>\(banks\[2u \* SLOTS \+ i\]\); \}/);
});

test('wind moves a gas with its paint; open edges and weather leave or make unpainted cells', () => {
  const gas = statements(airWGSL(g16, nativeDynamicsHead, 'gas'));
  assert.match(gas, /let paint=decoOf\(sa\); setDeco\(sa,select\(decoOf\(sb\),0u,cid\(b\.core\)==0u\)\); setDeco\(sb,select\(paint,0u,cid\(a\.core\)==0u\)\);\s*storeMaterial\(sa,a,b\)/);
  assert.match(statements(airWGSL(g16, nativeDynamicsHead, 'gasBoundary')), /setDeco\(t,0u\);storeMaterial\(t,before,dCarrier\(before\)\)/);
  assert.match(statements(v2BoundaryWGSL(g16)), /setDeco\(s,0u\);\s*storeMaterial\(s,before,after\)/);
  assert.match(statements(nativeWeatherCommitWGSL(g16, nativeWeatherParams('decoCheck', { params: {} }), 'commit')), /if\(cid\(before\.core\)==0u && cid\(m\.core\)!=0u\) \{ setDeco\(s,0u\); \}\s*storeMaterial\(s,before,m\)/);
});

// V1's wave scrub (src/world/waveDemo.js: sim.edit { scrub: true };
// src/shaders/deco.js decoScrubFrag): executed from the native commit's emitted statement.
test('a wave scrubs as V1\'s does: retyped or empty cells of its box lose their paint, unchanged matter keeps it', () => {
  const commit = statements(nativeWeatherCommitWGSL(g16, nativeWeatherParams('decoCheck', { params: {} }), 'material'));
  const at = commit.indexOf(NATIVE_WEATHER_SCRUB);
  assert.ok(at > 0, 'the commit emits the scrub');
  assert.ok(at < commit.indexOf('if(any(m.core!=before.core) || m.bank!=before.bank)'), 'over every cell of the box, written or not (unchanged empty cells too, as V1\'s)');
  const scrub = new Function('P', 's', 'm', 'before', 'decoOf', 'setDeco', 'cid', jsOf(NATIVE_WEATHER_SCRUB));
  const id = e => ({ core: new Uint32Array([e, 0, 0, 0]) }), cid = c => c[0] & 255;
  // [before, after, paint]: water the wave pushes, stale paint on air it leaves air, water a wave's
  // trough empties, air its crest floods, wood a writer retypes to fire, unpainted air
  const cases = [[E.WATER, E.WATER, BLUE], [0, 0, STALE], [E.WATER, 0, RED], [0, E.WATER, STALE], [E.WOOD, E.FIRE, GREEN], [0, 0, 0]];
  const run = flag => cases.map(([b, a, paint]) => {
    const plane = [paint];
    scrub({ scrub: flag }, 0, id(a), id(b), s => plane[s], (s, d) => { plane[s] = d; }, cid);
    return plane[0];
  });
  assert.deepEqual(run(1), [BLUE, 0, 0, 0, 0, 0], 'V1 decoScrubFrag: id == E_EMPTY || id != work[s] loses it');
  assert.deepEqual(run(0), cases.map(c => c[2]), 'a write without scrub (rain, bolts) leaves the plane to the commit\'s own rule');
});

// ---------------------------------------------------------------- (5) snapshots and drawing
test('flying paint is part of the dynamics snapshot (undo, saves, World shifts); older snapshots have none', () => {
  const s = emptyDynamicState([16, 16, 16]);
  validateDynamicState(s, g16);
  validateDynamicState({ ...s, particleDeco: new Uint32Array(PARTICLE_CAP) }, g16);
  assert.throws(() => validateDynamicState({ ...s, particleDeco: new Uint32Array(4) }, g16), /Invalid native dynamics snapshot/);
});

test('particles are drawn with their paint while the layer is painted and shown', () => {
  assert.equal(NATIVE_PARTICLE_LAYOUT.length, 2);
  assert.match(nativeParticleWGSL(), /o\.paint = unpack4x8unorm\(particleDeco\[ii\]\)/);
  assert.match(nativeParticleWGSL(), /diffuse = mix\(diffuse, decoLinear\(paint\.rgb\), paint\.a\)/);
  const calls = [], pb = { size: PARTICLE_CAP * 48 }, control = { size: 16, words: new Uint32Array(4) }, aux = { size: 1 << 24 };
  const gpu = { frame: {}, _frameUniforms: { layout: {}, group: {} }, layout: (_n, l) => l, bindGroup: (l, entries) => ({ l, entries }),
    createBuffer: d => ({ size: d.size, words: new Uint32Array(d.size / 4), destroy() {} }), flush() {},
    // (the matter draw's light group: the stand-ins it binds where no Box volume lights it, nativeParticles.js lightGroup)
    createTexture: d => ({ ...d, createView: () => ({ texture: d.label }) }), device: { createSampler: d => ({ sampler: d?.label }) },
    renderPipeline: d => ({ state: 'ready', ready: Promise.resolve(), draw: (_rp, o) => calls.push(o) }),
    kernel: () => ({ state: 'ready', ready: Promise.resolve(), dispatch() {} }) };
  const range = { buffer: aux, offset: 2 * 4096 * 4, size: PARTICLE_CAP * 4 };
  const source = { isIdle: false, attachDrawAdapter() {}, ready: Promise.resolve(), active: true, decoActive: true,
    get renderState() { return { version: 1, particleBytes: 48, capacity: PARTICLE_CAP, position: 'world cells', particleIdOffset: 12, bankOffset: 44, liveCountOffset: 0,
      coreOffsets: [28, 32, 36, 40], particles: pb, control, ready: true, deco: range, decoActive: this.decoActive }; } };
  const view = new NativeParticles(gpu, source);
  const camera = new PerspectiveCamera(55, 1, 0.1, 100); camera.coordinateSystem = WebGPUCoordinateSystem; camera.position.set(0, 0, 10); camera.updateMatrixWorld();
  view.updateView(camera, 720, new Matrix4(), [0, 0, 0]);
  view.prepareDraw();
  assert.deepEqual(view.group.entries[1].resource, { buffer: aux, offset: range.offset, size: range.size }, 'the pool\'s paint words');
  view.draw({ frame: gpu.frame }, { width: 1, height: 1 });
  assert.equal(calls.at(-1).params.deco, 1);
  decoView.show = false; view.draw({ frame: gpu.frame }, { width: 1, height: 1 }); assert.equal(calls.at(-1).params.deco, 0, 'display off (Ctrl+B)'); decoView.show = true;
  source.decoActive = false; view.draw({ frame: gpu.frame }, { width: 1, height: 1 }); assert.equal(calls.at(-1).params.deco, 0, 'nothing painted');
});

