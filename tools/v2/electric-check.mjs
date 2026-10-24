// CPU-only: V2's electricity runs at V1's rate (shaders/v2/electric.js, its CPU
// twin v2/electric.js, the rules v2/contact.js ctElecStep/ctElecApply).
// V1's reference is ui/tiles/engine.js, the CPU port of react.js's electric
// step (tools/elec-check.mjs times it). Every circuit below is built in both;
// after each V2 tick the V2 cells must equal V1's after STEPS_PER_TICK steps:
//   1. a spark crosses a wire ELEC_STEPS cells a tick (V1: a cell a step), and
//      a battery's train is live SPARK_LIFE steps in every SPARK_CYCLE
//   2. PSCN/NSCN: P → N conducts, N → P blocks
//   3. switches: a live P turns them on, a live N off, through touching switches
//   4. the temperature sensor fires on a hotter neighbour and sparks its wire;
//      a lamp holds LAMP_HOLD steps after its wire is cut
//   5. Joule heat: every level spent is JOULE_PER_LEVEL cap·°C of native energy,
//      exactly the source the pass declares
//   6. cost goes where electricity is live: nothing listed without it, only
//      the 3³ of a live wire's bricks with it, and the same result as every brick
//   7. the driver records the pass: four gather/commit steps after the block pass
// usage: node tools/v2/electric-check.mjs
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { ELEC, SPARK_BORN, SPARK_CYCLE, CONDUCTS, packSpark, takesSpark, sparkPhase } from '../../src/electricity.js';
import { NOMINAL_STEP_RATE } from '../../src/physics.js';
const ns6 = (...cells) => [...cells, ...Array.from({ length: 6 }, () => ({ ...ctNew(E.EMPTY, Math.round(293.25 * 4), 65536), valid: 0 }))].slice(0, 6);
import { World } from '../../src/ui/tiles/engine.js';
import { electricGrid, setGridCell, gridCell, electricTick, ELEC_STEPS } from '../../src/v2/electric.js';
import { ctNew, ctWithLife, ctEnergy, ctLife, ctElecStep, ctElecApply, packContact, unpackContact, CT_ENERGY_PER_CAP_C, CONTACT_ROWS, CONTACT_CONSTANTS } from '../../src/v2/contact.js';
import { PHYS } from '../../src/physics.js';
import { airborneReference } from '../../src/v2/airborne.js';
import { airborneReactWGSL as airborneWGSL } from '../../src/shaders/v2/airborne.js';
import { TICK_HZ } from '../../src/shaders/v2.js';
import { gridLayout } from '../../src/sim.js';
import { WGSL_CHECK } from '../../src/shaders/v2/electric.js';
import { assertNaga } from './wgsl-grouping.mjs';

let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log(`ok ${name}`); }
const q = T => Math.round((T + 273.25) * 4);
const live = (id, spark) => CONDUCTS[id] && sparkPhase(spark) > ELEC.SPARK_REST;

await test('V2 runs V1\'s steps a tick', () => assert.equal(ELEC_STEPS, NOMINAL_STEP_RATE / TICK_HZ));

// One circuit in V1's tiles engine (2D, gravity off) and in the V2 twin (its z = 0 plane).
function circuit(nx, ny) {
  const w = new World(nx, ny); w.gravity = 0;
  const g = electricGrid(nx, ny, 1);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) setGridCell(g, x, y, 0, ctNew(E.EMPTY, q(20), 65536));
  let tick = 0;
  const api = {
    w, g,
    put(x, y, id, { life, T } = {}) {
      w.put(x, y, id, { ...(life !== undefined ? { life } : {}), ...(T !== undefined ? { T } : {}) });
      let c = ctNew(id, q(T ?? ELEMENTS[id].temp), 65536);
      if (life !== undefined) c = ctWithLife(c, life);
      setGridCell(g, x, y, 0, c);
    },
    // the Spark tool on one cell (electricity.js sparkCell)
    spark(x, y) {
      w.spark(w.idx(x, y));
      const c = gridCell(g, x, y, 0);
      if (takesSpark(c.id, ctLife(c)) && sparkPhase(c.spark) === 0) { c.spark = packSpark(SPARK_BORN, ELEC.SPARK_V); setGridCell(g, x, y, 0, c); }
    },
    setT(x, y, T) { w.T[w.idx(x, y)] = T; const c = gridCell(g, x, y, 0); c.tq = c.raw = q(T); c.bank = 0; setGridCell(g, x, y, 0, c); },
    // a V2 tick and V1's steps; then every electric cell must agree
    // (ids false: V1's gases move, the twin's cells don't; the caller checks its own cells)
    tick(exact = true, { ids = true } = {}) {
      for (let s = 0; s < ELEC_STEPS; s++) w.step();
      const out = electricTick(g, ++tick);
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const c = gridCell(g, x, y, 0), i = w.idx(x, y);
        if (!ids) continue;
        assert.equal(c.id, w.id[i], `tick ${tick} (${x},${y}) id`);
        if (CONDUCTS[c.id]) {
          if (exact) assert.equal(c.spark, w.ctype[i], `tick ${tick} (${x},${y}) ${ELEMENTS[c.id].key} spark`);
          else assert.equal(live(c.id, c.spark), live(c.id, w.ctype[i]), `tick ${tick} (${x},${y}) ${ELEMENTS[c.id].key} live`);
        }
        if (c.id === E.SWITCH || c.id === E.PCLN || c.id === E.TSNS) assert.equal(ctLife(c), w.life[i], `tick ${tick} (${x},${y}) ${ELEMENTS[c.id].key} life`);
      }
      return out;
    },
    liveAt: (x, y) => { const c = gridCell(g, x, y, 0); return live(c.id, c.spark); },
  };
  return api;
}

await test('1. a spark crosses a wire ELEC_STEPS cells a tick, exactly as V1 steps it', () => {
  const N = 41, c = circuit(N + 2, 3);
  c.put(0, 1, E.BATTERY);
  for (let x = 1; x <= N; x++) c.put(x, 1, E.METAL);
  const first = Array(N + 1).fill(-1);
  for (let t = 1; t <= 14; t++) {
    c.tick();
    for (let x = 1; x <= N; x++) if (first[x] < 0 && c.liveAt(x, 1)) first[x] = t;
  }
  // V1: cell k of the wire is first live at step k, so V2 tick ceil(k / ELEC_STEPS)
  for (let x = 1; x <= N; x++) assert.equal(first[x], Math.ceil(x / ELEC_STEPS), `wire cell ${x}`);
  // the train: live SPARK_LIFE steps in every SPARK_CYCLE, so over SPARK_CYCLE ticks a cell is
  // live at the end of SPARK_LIFE of them (every phase is sampled once: SPARK_CYCLE and ELEC_STEPS are coprime)
  let liveTicks = 0;
  for (let t = 0; t < SPARK_CYCLE; t++) { c.tick(); if (c.liveAt(20, 1)) liveTicks++; }
  assert.equal(liveTicks, ELEC.SPARK_LIFE);
});

await test('2. PSCN/NSCN: P → N conducts, N → P blocks, tick for tick with V1', () => {
  for (const [a, b, passes] of [[E.PSCN, E.NSCN, true], [E.NSCN, E.PSCN, false]]) {
    const c = circuit(10, 3);
    c.put(0, 1, E.BATTERY); c.put(1, 1, a); c.put(2, 1, b);
    for (let x = 3; x <= 8; x++) c.put(x, 1, E.METAL);
    let reached = false;
    for (let t = 0; t < 8; t++) { c.tick(false); reached ||= c.liveAt(8, 1); }
    assert.equal(reached, passes, `${ELEMENTS[a].key} → ${ELEMENTS[b].key}`);
  }
});

await test('3. switches: a live P turns them on, a live N off, tick for tick with V1', () => {
  const c = circuit(10, 4);
  c.put(1, 1, E.PSCN);
  for (let x = 2; x <= 4; x++) c.put(x, 1, E.SWITCH);
  for (let x = 5; x <= 8; x++) c.put(x, 1, E.METAL);
  c.put(3, 2, E.NSCN);
  c.spark(1, 1);
  for (let t = 0; t < 2; t++) c.tick(false);
  for (let x = 2; x <= 4; x++) assert.equal(ctLife(gridCell(c.g, x, 1, 0)), ELEC.SWITCH_ON, `switch ${x} on`);
  c.put(2, 0, E.BATTERY);
  let passed = false;
  for (let t = 0; t < 6; t++) { c.tick(false); passed ||= c.liveAt(8, 1); }
  assert.ok(passed, 'an on switch passes the battery\'s sparks');
  c.spark(3, 2);
  for (let t = 0; t < 12; t++) c.tick(false);
  for (let x = 2; x <= 4; x++) assert.equal(ctLife(gridCell(c.g, x, 1, 0)), 0, `switch ${x} off`);
});

await test('4. the sensor fires on a hotter neighbour and sparks its wire; a cut lamp holds LAMP_HOLD steps', () => {
  const c = circuit(8, 4);
  c.put(1, 1, E.TSNS);
  for (let x = 2; x <= 6; x++) c.put(x, 1, E.METAL);
  c.put(1, 2, E.STONE, { T: 20 });
  for (let t = 0; t < 4; t++) c.tick();
  assert.ok(!c.liveAt(6, 1), 'quiet at its own temperature');
  c.setT(1, 2, 120);
  let fired = -1;
  for (let t = 1; t <= 4 && fired < 0; t++) { c.tick(); if (c.liveAt(6, 1)) fired = t; }
  // V1: the sensor fires a step after the touch, the wire's far end 5 steps after that
  assert.equal(fired, Math.ceil((1 + 5) / ELEC_STEPS));
  // a wired lamp, its wire cut: V1 and V2 agree every tick while it runs down
  const l = circuit(8, 3);
  l.put(0, 1, E.BATTERY);
  for (let x = 1; x <= 4; x++) l.put(x, 1, E.METAL);
  l.put(5, 1, E.LAMP);
  for (let t = 0; t < 12; t++) l.tick();
  assert.ok(gridCell(l.g, 5, 1, 0).spark > 0, 'a wired lamp is lit');
  l.put(3, 1, E.EMPTY);
  for (let t = 0; t < 8; t++) l.tick();
  assert.equal(gridCell(l.g, 5, 1, 0).spark, 0, 'it goes out once its hold runs down');
  // on a battery it is lit and still: nothing to do, nothing listed
  const d = circuit(4, 3);
  d.put(0, 1, E.BATTERY); d.put(1, 1, E.LAMP);
  d.tick();
  const rest = d.tick();
  assert.equal(rest.listed.length, 0, 'a lamp on direct current rests');
});

await test('5. Joule heat: each level spent is JOULE_PER_LEVEL cap·°C, the declared source, exactly', () => {
  // battery → metal → fresh water (100 levels a cell: electricity.js SPARK_DROP / σ)
  const g = electricGrid(12, 3, 3);
  for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 12; x++) setGridCell(g, x, y, z, ctNew(E.WALL, q(20), 65536));
  setGridCell(g, 0, 1, 1, ctNew(E.BATTERY, q(20), 65536));
  for (let x = 1; x <= 3; x++) setGridCell(g, x, 1, 1, ctNew(E.METAL, q(20), 65536));
  for (let x = 4; x <= 10; x++) setGridCell(g, x, 1, 1, ctNew(E.WATER, q(20), 65536));
  const total = () => { let n = 0n; for (let x = 0; x < 12; x++) n += ctEnergy(gridCell(g, x, 1, 1)); return n; };
  const e0 = total();
  let source = 0n, maxSpark = Array(12).fill(0);
  for (let t = 1; t <= 60; t++) {
    source += electricTick(g, t).source;
    for (let x = 4; x <= 10; x++) maxSpark[x] = Math.max(maxSpark[x], Math.floor(gridCell(g, x, 1, 1).spark / SPARK_CYCLE));
  }
  assert.ok(source > 0n, 'the water warmed');
  assert.equal(total() - e0, source, 'the energy the cells gained is the source the pass declared, to the unit');
  // a full spark loses a quarter at every water cell: 300, 200, 100, then nothing
  assert.deepEqual(maxSpark.slice(4, 9), [300, 200, 100, 0, 0]);
  // per level: JOULE_PER_LEVEL cap·°C in native energy (CT_ENERGY_PER_CAP_C a cap·°C), floored
  const water = gridCell(g, 5, 1, 1), perLevel = ELEC.JOULE_PER_LEVEL * CT_ENERGY_PER_CAP_C;
  const one = electricGrid(3, 1, 1);
  setGridCell(one, 0, 0, 0, ctNew(E.METAL, q(20), 65536));
  const w0 = ctNew(E.WATER, q(20), 65536); setGridCell(one, 1, 0, 0, w0);
  const m = ctNew(E.METAL, q(20), 65536); m.spark = packSpark(SPARK_BORN, ELEC.SPARK_V); setGridCell(one, 0, 0, 0, m);
  const r = electricTick(one, 1);
  const spent = CONTACT_ROWS[E.WATER].cost;   // fresh water's whole cost, no fraction to draw
  assert.equal(Number.isInteger(spent), true);
  assert.equal(r.source, BigInt(Math.floor(spent * perLevel)), 'one crossing of fresh water');
  assert.equal(ctEnergy(gridCell(one, 1, 0, 0)) - ctEnergy(w0), r.source);
  // V1's ΔT for that crossing, spent·JOULE_PER_LEVEL / cap, in the matter's share of the cell's capacity
  const cap = ELEMENTS[E.WATER].cap, v1dT = spent * ELEC.JOULE_PER_LEVEL / cap;
  assert.ok(Math.abs(Number(r.source) / (CT_ENERGY_PER_CAP_C * Math.round(cap * 64) / 64) - v1dT) < 1e-6, 'V1\'s ΔT');
  void water;
});

await test('6. cost goes where electricity is live, and listing changes nothing', () => {
  const build = (battery) => {
    const g = electricGrid(32, 8, 32);
    for (let z = 0; z < 32; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 32; x++) setGridCell(g, x, y, z, ctNew(E.EMPTY, q(20), 65536));
    if (battery) setGridCell(g, 0, 1, 1, ctNew(E.BATTERY, q(20), 65536));
    for (let x = 1; x < 32; x++) setGridCell(g, x, 1, 1, ctNew(E.METAL, q(20), 65536));
    return g;
  };
  const quiet = build(false);
  for (let t = 1; t <= 3; t++) { const r = electricTick(quiet, t); assert.equal(r.listed.length, 0); assert.deepEqual(r.changed, [0, 0, 0, 0]); }
  const a = build(true), b = build(true);
  const wireBricks = new Set(Array.from({ length: 8 }, (_, bx) => bx));   // y = 1, z = 1: bricks (bx, 0, 0)
  for (let t = 1; t <= 12; t++) {
    const ra = electricTick(a, t, { awake: wireBricks }), rb = electricTick(b, t);
    // every listed brick touches the wire's bricks: (bx ± 1, 0..1, 0..1), never the box's 128
    assert.ok(ra.listed.length <= 8 * 4 && ra.listed.every(n => n % 8 < 8 && Math.floor(n / 8) % 2 < 2 && Math.floor(n / 16) < 2), `tick ${t} lists ${ra.listed.length}`);
    assert.deepEqual(a.cores, b.cores, `tick ${t}: listed and whole-box runs agree`);
    for (const n of ra.busy) assert.ok(ra.listed.includes(n), 'every change marks a listed brick busy');
  }
});

await test('7. the driver runs four gather/commit steps after the block pass, over the lists', async () => {
  const { PhysicsV2 } = await import('../../src/v2/physics.js');
  const { contactWGSL } = await import('../../src/shaders/v2/contact.js');
  const { ARGS2 } = await import('../../src/shaders/v2.js');
  const { GRAV, AIR, EDGE } = await import('../../src/simModes.js');
  globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
  const commands = [], g = gridLayout(16, 16, 16);
  const gpu = { createBuffer: d => ({ ...d, destroy() {} }), queue: { writeBuffer() {} }, write() {}, layout: (name, entries) => ({ name, entries }),
    bindGroup: (layout, entries) => ({ layout, entries }), L: { EMPTY: {} }, emptyGroup: {},
    kernel: d => ({ ...d, ready: Promise.resolve(), state: 'ready', dispatch(frame, size, data) { commands.push({ name: d.name, size, params: data.params, bind: data.bind }); } }),
    readback: { buffer: (b, o, n) => Promise.resolve(new ArrayBuffer(n)) }, frame: { clear() {}, copy() {} }, flush() {} };
  const sim = { g, gravity: 0.025, gravityMode: GRAV.VERTICAL, airMode: AIR.ON, ambientHeat: true, edgeMode: EDGE.SOLID, airT: 20,
    gpu, id: 1, version: 0, wholeWrites: 0, frame: 0, paints: 0, state: { A: {}, B: {}, F: {} }, marks: {}, tables: {}, L: { STATE_RO: {}, TABLES: {} },
    header: () => ({}), noteWrite() {}, origin: { x: 0, y: 0, z: 0 } };
  const engine = new PhysicsV2(sim, { contactWGSL }); await engine.ready;
  engine.sync(); engine._tick(); commands.length = 0; engine._tick();
  // (the heat pass, shaders/v2/heat.js, follows the block pass and its heat-only cubes' on even ticks: this is tick 2)
  const names = commands.map(c => c.name), block = names.indexOf('v2heatOnly'), at = block + 1;
  assert.equal(names[block - 1], 'v2block');
  assert.equal(names[at], 'v2heat');
  assert.deepEqual(names.slice(at + 1, at + 10), ['v2elecGather', 'v2elecArgs', 'v2elecCommit', 'v2elecGather', 'v2elecCommit', 'v2elecGather', 'v2elecCommit', 'v2elecGather', 'v2elecCommit']);
  const elec = commands.slice(at + 1, at + 10).filter(c => c.name !== 'v2elecArgs');
  assert.deepEqual(elec.map(c => c.params.elecStep), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual(elec.map(c => c.size.offset / 4), [ARGS2.BRICKS, ARGS2.ELEC, ARGS2.ELEC, ARGS2.ELEC, ARGS2.ELEC, ARGS2.ELEC, ARGS2.ELEC, ARGS2.ELEC]);
  // without the contact module (the foundation alone) there is no electric pass
  commands.length = 0;
  const bare = new PhysicsV2({ ...sim, compact: null }, {}); await bare.ready;
  bare.sync(); bare._tick();
  assert.ok(!commands.some(c => c.name.startsWith('v2elec')));
});

await test('9. the fuse: lit, its front crosses each cell in V1\'s steps on any face, its end spits and flames', () => {
  const N = 4, c = circuit(N + 2, 3);
  for (let x = 1; x <= N; x++) c.put(x, 1, E.FUSE);
  // lit by hand in both (V1: life 1 - FUSE_BURN, the lighting step's), so neither's heat lights it early
  c.w.life[c.w.idx(1, 1)] = Math.fround(1 - PHYS.FUSE_BURN);
  { const f = gridCell(c.g, 1, 1, 0); f.life = CONTACT_CONSTANTS.CT_FUSE_UNLIT[1] - 1; setGridCell(c.g, 1, 1, 0, f); }
  const H = CONTACT_CONSTANTS.CT_FUSE_HANDOFF_Q[1], UNLIT = CONTACT_CONSTANTS.CT_FUSE_UNLIT[1];
  const lit = Array(N + 1).fill(-1), out = Array(N + 1).fill(-1);
  for (let t = 1; t <= 1200 && out[N] < 0; t++) {
    c.tick(false, { ids: false });
    for (let x = 1; x <= N; x++) {
      const v1 = c.w.id[c.w.idx(x, 1)] === E.FUSE, v1life = c.w.life[c.w.idx(x, 1)], v2 = gridCell(c.g, x, 1, 0);
      assert.equal(v2.id === E.FUSE, v1, `tick ${t} fuse ${x} still fuse`);
      if (!v1) { if (out[x] < 0) out[x] = t; continue; }
      assert.equal(v2.life < UNLIT, v1life < 1, `tick ${t} fuse ${x} lit`);
      assert.equal(v2.life <= H, v1life <= PHYS.FUSE_HANDOFF, `tick ${t} fuse ${x} handed on`);
      if (lit[x] < 0 && v2.life < UNLIT) lit[x] = t;
    }
  }
  // the front: a cell every FUSE_STEPS_PER_CELL-odd steps, a quarter of that in ticks
  for (let x = 2; x <= N; x++) assert.ok(Math.abs((lit[x] - lit[x - 1]) * ELEC_STEPS - PHYS.FUSE_STEPS_PER_CELL) <= ELEC_STEPS, `fuse ${x} lit at tick ${lit[x]}`);
  // burnt out: smoke behind the front, a flame at its end (which spat gunpowder's heat first)
  for (let x = 1; x < N; x++) assert.equal(gridCell(c.g, x, 1, 0).id, E.SMOKE, `fuse ${x} leaves smoke`);
  assert.equal(gridCell(c.g, N, 1, 0).id, E.FIRE, 'the end leaves a flame');
  assert.ok(gridCell(c.g, N, 1, 0).tq >= q(ELEMENTS[E.GUNPOWDER].blast.T), 'the end spat gunpowder\'s heat');
  // a flame lights it at V1's chance a step (gunpowder's blast.flame); a lit fuse on the sixth face is no end
  const fuse = ctNew(E.FUSE, q(20), 65536), fire = ctNew(E.FIRE, q(800), 65536);
  const p = ELEMENTS[E.GUNPOWDER].blast.flame;
  assert.notEqual(ctElecStep(fuse, ns6(fire), p - 0.01), 0);
  assert.equal(ctElecStep(fuse, ns6(fire), p + 0.01), 0);
  const burning = { ...fuse, life: H }, ahead = { ...fuse, life: H + 50 };
  const endWord = ctElecStep(burning, ns6(), 0), notEnd = ctElecStep(burning, [...ns6().slice(0, 5), ahead], 0);
  assert.ok(ctElecApply(burning, endWord, 1).tq >= q(ELEMENTS[E.GUNPOWDER].blast.T), 'alone, it is the end: it spits');
  assert.equal(ctElecApply(burning, notEnd, 1).tq, burning.tq, 'a fuse that burns longer on the sixth face: not the end');
});

await test('10. a flying conductor\'s spark runs down at V1\'s steps a tick (its six contacts its neighbours: air all round)', () => {
  const metal = ctNew(E.METAL, q(20), 65536); metal.spark = packSpark(SPARK_BORN, ELEC.SPARK_V);
  const packet = packContact(metal), host = packContact(ctNew(E.EMPTY, q(20), 65536));
  const r = airborneReference(packet, host, 7);
  assert.equal(unpackContact(r.particle.core, r.particle.bank).spark, packSpark(SPARK_BORN - ELEC_STEPS, 0));
  // (its six contacts, as V1's mover's six neighbours: tools/v2/airborne-react-check.mjs)
  assert.match(airborneWGSL, /v = ctElecAirborne\(v, contacts, seed\);/);
});

await test('11. the pass\'s WGSL validates (Naga)', () => {
  for (const k of WGSL_CHECK) assertNaga(k.code(gridLayout(32, 32, 32)), k.name);
});

await test('12. an unlit fuse beside a flame gets V1\'s draw every step: four a tick, though nothing else is live', async () => {
  // V1 react.js FUSE: beside a flame it lights with gunpowder's blast.flame a step, so a tick (four
  // steps) lights it unless all four draws miss. Each fuse here is alone (two bricks from the next),
  // so only its own flame can list its bricks for steps 1-3 (ctFuseFlameNear), not a neighbour's change.
  const flame = ELEMENTS[E.GUNPOWDER].blast.flame, UNLIT = CONTACT_CONSTANTS.CT_FUSE_UNLIT[1];
  const SALT = CONTACT_CONSTANTS.CT_ELEC_SALT[1];
  const { elecSeed } = await import('../../src/v2/electric.js');
  const { ctRoll } = await import('../../src/v2/contact.js');
  const at = [];
  for (let z = 2; z < 64; z += 12) for (let x = 2; x < 64; x += 12) at.push([x, z]);
  let lit = 0, trials = 0, late = 0;
  for (let tick = 1; tick <= 24; tick++) {
    const g = electricGrid(64, 8, 64);
    for (let z = 0; z < 64; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 64; x++) setGridCell(g, x, y, z, ctNew(E.EMPTY, q(20), 65536));
    for (const [x, z] of at) { setGridCell(g, x, 1, z, ctNew(E.FUSE, q(20), 65536)); setGridCell(g, x, 2, z, ctNew(E.FIRE, q(800), 65536)); }
    electricTick(g, tick);
    for (const [x, z] of at) {
      const draws = Array.from({ length: ELEC_STEPS }, (_, step) => ctRoll(elecSeed(x, 1, z, tick), SALT + step));
      const v1 = draws.some(r => r < flame), on = gridCell(g, x, 1, z).life < UNLIT;
      assert.equal(on, v1, `tick ${tick} fuse (${x}, ${z}): lit as V1's four draws ${draws.map(r => r.toFixed(2))}`);
      trials++; lit += +on; late += +(on && !(draws[0] < flame));
    }
  }
  // V1's tick: 1 - (1 - flame)^4 ≈ 0.99, against one draw's 0.7
  assert.ok(lit / trials > 0.95 && late > 0, `${lit} of ${trials} lit, ${late} after step 0's draw missed`);
  // the GPU's gather lists such a fuse's bricks at step 0, as the twin does
  const gather = WGSL_CHECK.find(k => k.name === 'v2elecGather').code(gridLayout(32, 32, 32));
  assert.match(gather, /if \(awake && word == 0 && ctFuseFlameNear\(c, ns, touch\)\) \{ atomicStore\(&wgChanged, 1u\); \}/);
  assert.match(gather, /fn ctFuseFlameNear\(/);
});

console.log(`${checks} electric checks passed; no GPU launched`);
