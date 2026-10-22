// CPU only (no GPU, no browser): WS-D liquid runs against V1 (the V2 finish push), on the emitted column passes
// executed on the CPU (tools/v2/column-wgsl.mjs). Each test fails with its fix reverted. V1's numbers are measured
// on the GPU (tools/v2/runs-browser-check.mjs --v1, 2026-10-22) or read from V1's code, cited at each.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { E, ELEMENTS } from '../../src/elements.js';
import { PHYS, SIM_GRAVITY } from '../../src/physics.js';
import * as L from '../../src/v2/layout.js';
import { v2Rows } from '../../src/shaders/v2.js';
import { COLUMN, COLUMN_FLOW, COLUMN_SHOCK_ON } from '../../src/shaders/v2/columns.js';
import { v1PaceRate } from '../../src/v2/gravity.js';
import { ColumnGrid } from './column-wgsl.mjs';
import { OUTCOMES } from '../outcomes/thresholds.js';

const block = (w, id, [x0, y0, z0], [x1, y1, z1], opts) => { for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) w.set(x, y, z, id, opts); };
const columns = (w, id) => {
  let cols = 0, peak = 0;
  for (let z = 0; z < w.nz; z++) for (let x = 0; x < w.nx; x++) {
    let a = 0; for (let y = 0; y < w.ny; y++) { const c = w.cores[w.at(x, y, z)]; if (L.cid(c) === id) a += L.cFill(c) / L.FULL; }
    if (a > 1e-4) { cols++; peak = Math.max(peak, a); }
  }
  return { cols, peak };
};
const run = (w, ticks) => { for (let t = 0; t < ticks; t++) w.step(); };

test('MV-8: no yield stress, as V1: a 4³ block of mud levels to a cell, not a mound', () => {
  // V1 react.js has no yield: measured, mud is a cell deep over 64 columns within 1 s
  for (const key of ['MUD', 'LAVA', 'SLIME']) if (E[key] !== undefined) assert.equal(v2Rows()[E[key]].yieldHead, 0, `${key} has no yield`);
  const w = new ColumnGrid(20, 8, 20);
  block(w, E.MUD, [8, 0, 8], [11, 3, 11]);
  run(w, 120);
  const { peak, cols } = columns(w, E.MUD);
  assert.ok(peak <= 1, `mud stands ${peak.toFixed(2)} cells (V1: 1) over ${cols} columns`);
});

test('MV-13: a spill beads a cell deep as V1\'s whole cells do, and still pours off a ledge', () => {
  // V1: a 4³ block of water is one cell deep over 64 columns (its films on dry ground spend their flow: FILM_KEEP)
  const w = new ColumnGrid(32, 8, 32);
  block(w, E.WATER, [14, 0, 14], [17, 3, 17]);
  run(w, 120);
  const { peak, cols } = columns(w, E.WATER);
  // (V2's fills level where V1's whole cells bead: columns.js FILM_DRY's Intentional note)
  assert.ok(cols <= 220 && peak >= 0.3, `water: ${cols} columns, ${peak.toFixed(2)} deep (V1 64 columns, 1 deep; a 1/8-cell film was 572)`);
  // half a cell of water on a shelf by its edge pours off it (the dry film holds only at its own level)
  const s = new ColumnGrid(12, 8, 4);
  block(s, E.WALL, [0, 0, 0], [5, 3, 3]);
  block(s, E.WATER, [4, 4, 0], [5, 4, 3], { fill: L.FULL / 2 });
  run(s, 60);
  let below = 0;
  for (let i = 0; i < s.n; i++) { const c = s.cores[i], x = i % s.nx, y = Math.floor(i / (s.nx * s.nz)); if (L.cid(c) === E.WATER && (x > 5 || y < 4)) below += L.cFill(c); }
  for (const p of s.parts) below += L.cFill(p.m.core);
  assert.ok(below > L.FULL, `the shelf's film poured off it (${(below / L.FULL).toFixed(2)} cells below)`);
});

test('BL-10: mercury on nitroglycerin goes off from any fall, laid on it too (V1 measured from 0, 1 and 2 cells)', () => {
  assert.equal(COLUMN_SHOCK_ON.find(r => r.faller === E.MERCURY && r.charge === E.NITRO)?.fall, 0);
  for (const gap of [0, 1]) {
    const w = new ColumnGrid(8, 8, 8);
    block(w, E.NITRO, [2, 0, 2], [5, 1, 5]);
    block(w, E.MERCURY, [3, 2 + gap, 3], [4, 2 + gap, 4]);
    let off = false;
    for (let t = 0; t < 20 && !off; t++) { w.step(); off = w.events.some((e, i) => (e & 1) && L.cid(w.cores[i]) === E.NITRO); }
    assert.ok(off, `mercury ${gap} cells over nitroglycerin sets it off`);
  }
  // water on it never (V1: no hit water's mass carries is past its shock)
  const w = new ColumnGrid(8, 8, 8);
  block(w, E.NITRO, [2, 0, 2], [5, 1, 5]); block(w, E.WATER, [3, 3, 3], [4, 3, 4]);
  run(w, 20);
  assert.ok(!w.events.some(e => e & 1), 'water on nitroglycerin rests');
});

test('an open floor: a run falls through it from rest on V1\'s law, not at V1\'s terminal speed from its first tick', () => {
  const w = new ColumnGrid(8, 16, 8, { edge: 1 });
  block(w, E.WATER, [2, 0, 2], [5, 9, 5]);
  const m0 = w.totals().mass, out = [];
  for (let t = 0; t < 8; t++) { w.step(); out.push((m0 - w.totals().mass) / L.FULL / 16); }
  // V1 (react.js forces, move.js vertical): from rest it gains SIM_GRAVITY a step and moves on its draws; in its
  // first tick (4 steps) a cell at under 0.1 cells/step barely moves: no column loses a whole cell
  assert.ok(out[0] < 0.5, `first tick: ${out[0].toFixed(2)} cells a column out (V1's terminal speed is ${PHYS.V_MAX * COLUMN.STEPS})`);
  // it accelerates: each tick carries more out than the last until it nears V_MAX
  const per = out.map((v, k) => v - (out[k - 1] ?? 0));
  assert.ok(per[5] > per[1], `it speeds up: ${per.map(v => v.toFixed(2)).join(', ')}`);
  // and it all leaves, into the ledger with its energy
  run(w, 60);
  assert.equal(w.totals().mass, 0);
  assert.equal(w.boundary.mass, m0);
});

test('a face carries no more than V1\'s flow cap: its liquid\'s FLOW, paced as V1\'s move paces it', () => {
  // V1 react.js: a liquid's head-driven flow is at most FLOW (cells/step); move.js moves it u/(2-u) cells a step
  // (a pair step is a V1 step: COLUMN.SUB of them a tick)
  assert.equal(COLUMN.SUB, COLUMN.STEPS);
  assert.equal(COLUMN_FLOW[E.MUD].q, Math.floor(v1PaceRate(ELEMENTS[E.MUD].flow) * L.FULL));
  assert.equal(COLUMN_FLOW[E.WATER].q, Math.floor(v1PaceRate(ELEMENTS[E.WATER].flow) * L.FULL));
  assert.equal(COLUMN_FLOW[E.WATER].ms, Number((0.9 * 72).toPrecision(7)));
  // a deep mud face onto dry ground, already at the lane's Q_MAX: its next flux is V1's cap, no more
  const ctx = new ColumnGrid(4, 32, 4).ctx, rec = (r1, liq) => ctx.recMake(0, 32, r1, liq, 0, r1 * L.FULL, false, false);
  for (const [id, ok] of [[E.MUD, COLUMN_FLOW[E.MUD].q], [E.WATER, COLUMN_FLOW[E.WATER].q]]) {
    const v = ctx.colFlux(rec(30, id), rec(0, 0), 0, 30, COLUMN.Q_MAX, COLUMN.Q_MAX, { x: 0, y: 0 }, { x: 0, y: 0 }, 0, COLUMN.FILM_DRY, false, 0);
    assert.ok(v > 0 && v <= ok, `${ELEMENTS[id].key}: ${v} (V1's cap ${ok})`);
  }
});

test('RX-3: painted water poured into a pool keeps its colour there, mixed by fill, as V1\'s painted cells go with it', () => {
  const RED = 0xff0000ff;
  const w = new ColumnGrid(16, 8, 4, { deco: 1 });
  // a pool of half-filled cells, and a red column poured into it
  block(w, E.WATER, [0, 0, 0], [15, 0, 3], { fill: L.FULL / 2 });
  block(w, E.WATER, [0, 1, 0], [1, 6, 3]);
  for (let y = 1; y <= 6; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 2; x++) w.deco[w.at(x, y, z)] = RED;
  const red = () => { let m = 0; for (let i = 0; i < w.n; i++) { const c = w.cores[i]; if (L.cid(c) === E.WATER) m += L.cFill(c) / L.FULL * ((w.deco[i] >>> 24) / 255) * ((w.deco[i] & 255) / 255); } return m; };
  const r0 = red();
  run(w, 180);
  assert.ok(Math.abs(red() / r0 - 1) < 0.05, `the red water's paint is still on it: ${red().toFixed(2)} of ${r0.toFixed(2)} cells`);
  let painted = 0; for (let i = 0; i < w.n; i++) if (L.cid(w.cores[i]) === E.WATER && w.deco[i]) painted++;
  assert.ok(painted > 2 * 6 * 4, `the paint spread with the water into the pool (${painted} cells)`);
});

test('EL-10: a spark moves with a flowing conductor\'s cell, never copied into the cells a part of it reaches', () => {
  const w = new ColumnGrid(16, 8, 4);
  block(w, E.MERCURY, [0, 0, 0], [2, 5, 3]);
  // a live spark code in each cell of the dam (the payload of a conductor is its spark: shaders/v2/state.js)
  for (let i = 0; i < w.n; i++) if (L.cid(w.cores[i]) === E.MERCURY) w.cores[i] = L.withPayload({ core: w.cores[i], bank: 0 }, 0x123).core;
  const sparks = () => { let n = 0; for (let i = 0; i < w.n; i++) if (L.cid(w.cores[i]) === E.MERCURY && L.payloadOf(w.cores[i])) n++; return n; };
  const s0 = sparks();
  let most = s0;
  for (let t = 0; t < 120; t++) { w.step(); most = Math.max(most, sparks()); }
  assert.ok(most <= s0, `sparked cells: ${s0} at the start, at most ${most} as it flowed (a copy per receiver grows it)`);
});

test('TH-10, the liquid half: a liquid\'s landing makes no heat, as V1\'s (move.js impactHeat warms only a grain)', () => {
  // V1 shaders/move.js impactHeat: KIND == K_POWDER && speed > COLLIDE_V; a liquid's landing and collide make none
  const w = new ColumnGrid(8, 16, 8);
  block(w, E.WATER, [2, 12, 2], [5, 13, 5], { T: 20 });
  const e0 = w.totals().energy;
  run(w, 60);
  assert.equal(w.totals().energy, e0);
  for (let i = 0; i < w.n; i++) if (L.cid(w.cores[i]) === E.WATER) assert.ok(Math.abs(L.cTq(w.cores[i]) * 0.25 - 273.25 - 20) < 0.5, 'still 20 °C');
});

test('BL-8: a heavy liquid landing hard breaks the solid it lands on, as V1\'s (½·ρ·u² past its hard), its debris warmed', () => {
  // V1 react.js (a landing included: common.js impactActs): mercury breaks glass (hard 8) from a few cells, water
  // never (½·10·V_MAX² = 5) but a lamp (3) from far enough; the debris takes KE_TO_HEAT·hard of heat
  const drop = (liquid, solid, fall) => {
    const w = new ColumnGrid(8, 32, 8);
    block(w, solid, [2, 0, 2], [5, 0, 5]);
    block(w, liquid, [3, 1 + fall, 3], [4, 1 + fall, 4]);
    run(w, 60);
    let broke = 0; for (let z = 3; z <= 4; z++) for (let x = 3; x <= 4; x++) if (L.cid(w.cores[w.at(x, 0, z)]) !== solid) broke++;
    return { broke, heat: w.sources ?? 0n };
  };
  const hard = drop(E.MERCURY, E.GLASS, 12);
  assert.equal(hard.broke, 4, 'mercury from 12 cells breaks the glass under it');
  assert.ok(hard.heat === 4n * BigInt(Math.round(ELEMENTS[E.GLASS].hard * PHYS.KE_TO_HEAT * 256)) * 65536n, 'each piece KE_TO_HEAT·hard warmer, declared');
  assert.equal(drop(E.MERCURY, E.GLASS, 1).broke, 0, 'mercury set down a cell over it does not');
  assert.equal(drop(E.WATER, E.GLASS, 24).broke, 0, 'water never breaks glass');
  assert.equal(drop(E.WATER, E.LAMP, 24).broke, 4, 'water from far breaks a lamp');
});

test('RX-7, the liquid half: a cloned liquid starts falling at V1\'s SPAWN_DROP_V in its column lane', async () => {
  const C = await import('../../src/v2/contact.js');
  const { contactWGSL } = await import('../../src/shaders/v2/contact.js');
  // V1 react.js clone: the product (but a gas) starts with v.y = SPAWN_DROP_V cells/step
  const made = (id) => {
    const clone = C.ctNew(E.CLONE, 1172, 65536); clone.ctype = id;
    const air = () => C.ctNew(E.EMPTY, 1172, 65536);
    for (let s = 0; s < 4096; s++) { const c = C.ctStep(air(), [clone, air(), air()], s); if (c.id === id) return c; }
    throw new Error(`no ${ELEMENTS[id].key} made`);
  };
  assert.equal(made(E.WATER).fallSpeed, Math.fround(-PHYS.SPAWN_DROP_V * COLUMN.STEPS));
  assert.equal(made(E.MERCURY).fallSpeed, Math.fround(-PHYS.SPAWN_DROP_V * COLUMN.STEPS));
  // the WGSL packs it into a new liquid's y lane (the column pass's fall, cells a tick)
  assert.match(contactWGSL, /if\(c\.fallSpeed>0\.0 && c\.id!=i32\(original\.x&255u\)\)\{core\.z=\(core\.z&65535u\)\|\(pack2x16float\(vec2f\(0\.0,c\.fallSpeed\)\)&0xffff0000u\);\}/);
  // and the column pass falls it from that speed: further in its first tick than a cell from rest
  const fall = (lane) => {
    const w = new ColumnGrid(4, 16, 4);
    w.set(1, 12, 1, E.WATER);
    if (lane) w.cores[w.at(1, 12, 1)] = w.ctx.withLane(w.cores[w.at(1, 12, 1)], 1, lane);
    run(w, 2);
    let y = 0; while (L.cid(w.cores[w.at(1, y, 1)]) !== E.WATER) y++;
    return 12 - y;
  };
  assert.ok(fall(-PHYS.SPAWN_DROP_V * COLUMN.STEPS) > fall(0), `from V1's spawn speed ${fall(1.2)} cells in 2 ticks, from rest ${fall(0)}`);
});

test('the flow runs at V1\'s speed: a dam break\'s front and a spill\'s reach by time as V1\'s, the hole still drains as V1\'s', () => {
  // V1 (tools/v2/runs-browser-check.mjs --v1, 2026-10-22, 32³ boxes): a dam break (water 4 wide, 8 deep, across the
  // box) has its front 16 cells from the wall at 0.1 s and at the far wall (32) by 0.2 s; a 4³ spill reaches 9.5
  // cells from its middle at 0.1 s. One pair step a tick (before) had them at 8 at 0.1 s, 11 at 0.2 s and 5.5.
  const dam = new ColumnGrid(32, 12, 4);
  block(dam, E.WATER, [0, 0, 0], [3, 7, 3]);
  const front = () => { let f = 0; for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) for (let y = 0; y < 12; y++) if (L.cid(dam.cores[dam.at(x, y, z)]) === E.WATER) f = x + 1; return f; };
  run(dam, 6); const at01 = front();
  run(dam, 9); const at025 = front();
  assert.ok(at01 >= 13 && at01 <= 24, `dam front at 0.1 s: ${at01} cells (V1 16)`);
  assert.equal(at025, 32, `dam front at 0.25 s: ${at025} cells (V1 at the wall by 0.2 s)`);
  const spill = new ColumnGrid(32, 8, 32);
  block(spill, E.WATER, [14, 0, 14], [17, 3, 17]);
  run(spill, 6);
  let reach = 0;
  for (let i = 0; i < spill.n; i++) if (L.cid(spill.cores[i]) === E.WATER) { const x = i % 32, z = Math.floor(i / 32) % 32; reach = Math.max(reach, Math.abs(x - 15.5), Math.abs(z - 15.5)); }
  assert.ok(Math.abs(reach - 9.5) <= 1.5, `spill reach at 0.1 s: ${reach} cells (V1 9.5)`);
  // the hole tank (tests/liquids.js hole, runs-browser-check drain): drained within the outcome's tolerance of V1's
  const w = new ColumnGrid(16, 32, 8);
  block(w, E.WALL, [0, 0, 0], [8, 31, 7]);
  for (let y = 13; y <= 31; y++) for (let z = 1; z <= 6; z++) for (let x = 1; x <= 7; x++) w.set(x, y, z, 0);
  block(w, E.WATER, [1, 13, 1], [7, 30, 6]); w.set(8, 14, 3, 0);
  const tank = () => { let m = 0; for (let y = 13; y < 32; y++) for (let z = 1; z <= 6; z++) for (let x = 1; x <= 7; x++) { const c = w.cores[w.at(x, y, z)]; if (L.cid(c) === E.WATER) m += L.cFill(c) / L.FULL; } return m; };
  const { v1, checkpoints, drainTol } = OUTCOMES.hole;
  checkpoints.forEach((t, k) => {
    while (w.tick < t * COLUMN.TICK_HZ) w.step();
    const drained = 7 * 6 * 18 - tank();
    assert.ok(Math.abs(drained / v1.drained[k] - 1) <= drainTol, `drained by ${t} s: ${drained.toFixed(1)} cells (V1 ${v1.drained[k]})`);
  });
});

test('BL-9: a mercury flow running into C-4 or nitroglycerin sets it off as V1\'s, water\'s never', () => {
  // V1 (runs-browser-check --v1 sideways, 2026-10-22): mercury 4 wide and h tall a cell of floor from a wall of C-4
  // (h 8, 14) or a nitroglycerin pool (h 14) sets it off within a second (react.js shock: ½·μ·u², u its flow's
  // FLOW-capped orifice speed); water's ½·μ·u² is under either's shock at any speed
  const COLUMN_HIT_IDS = [E.C4, E.NITRO];
  for (const id of COLUMN_HIT_IDS) assert.ok(ELEMENTS[id].blast.shock > 0);
  const side = (liq, charge, h) => {
    const w = new ColumnGrid(20, 16, 24);
    const x1 = charge === E.C4 ? 10 : 14, y1 = charge === E.C4 ? h - 1 : 1;
    block(w, liq, [4, 0, 10], [7, h - 1, 13]); block(w, charge, [9, 0, 6], [x1, y1, 17]);
    for (let t = 0; t < 30; t++) { w.step(); if (w.events.some((e, i) => (e & 1) && L.cid(w.cores[i]) === charge)) return true; }
    return false;
  };
  assert.ok(side(E.MERCURY, E.C4, 8), 'mercury 8 tall into C-4');
  assert.ok(side(E.MERCURY, E.NITRO, 14), 'mercury 14 tall into nitroglycerin');
  assert.ok(!side(E.WATER, E.NITRO, 14), 'water 14 tall into nitroglycerin rests');
  assert.ok(!side(E.WATER, E.C4, 14), 'water 14 tall into C-4 rests');
});

test('T11, the liquid half: a painted liquid starts falling at V1\'s SPAWN_DROP_V, its import setting its column lane', async () => {
  // V1 passes.js paint: a loose tool's new cell gets B.y = SPAWN_DROP_V cells/step; V2 imports the painted cell from
  // V1's A/B, and the import keeps that fall in the column lane (colFall's cells a tick)
  const { v2ImportWGSL } = await import('../../src/shaders/v2.js');
  const { gridLayout } = await import('../../src/sim.js');
  assert.match(v2ImportWGSL(gridLayout(16, 8, 8)), /n = colImportFall\(n, select\(0\.0, vy, cls\(u32\(clamp\(eid\(a\), 0, NE - 1\)\)\) == C_LIQUID\)\);/);
  const fall = (vy) => {
    const w = new ColumnGrid(4, 16, 4);
    w.set(1, 12, 1, E.WATER);
    w.cores[w.at(1, 12, 1)] = Uint32Array.from(w.ctx.colImportFall(w.cores[w.at(1, 12, 1)], vy));
    const lane = w.ctx.laneOf(w.cores[w.at(1, 12, 1)], 1);
    run(w, 2);
    let y = 0; while (L.cid(w.cores[w.at(1, y, 1)]) !== E.WATER) y++;
    return { lane, fell: 12 - y };
  };
  const painted = fall(PHYS.SPAWN_DROP_V), still = fall(0);
  assert.equal(painted.lane, Math.f16round(-PHYS.SPAWN_DROP_V * COLUMN.STEPS));
  assert.equal(still.lane, 0);
  assert.ok(painted.fell > still.fell, `painted: ${painted.fell} cells in 2 ticks, from rest ${still.fell}`);
});
