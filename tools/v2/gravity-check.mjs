// CPU only (no GPU, no browser): V2 falls as V1 does (user decision, 2026-10-21; src/v2/gravity.js). V1's law in its
// own units (react.js forces: SIM_GRAVITY cells/step² a step, DRAG, PHYS.V_MAX; move.js vertical: the Margolus move
// on a block's top half at its draws) against V2's in game time: the pull every V2 owner reads, a grain's fall on the
// column pass (v2/fall.js stepFall, the CPU twin fall-check.mjs holds op for op to the emitted WGSL), a packet's
// terminal speeds. A liquid run's fall is the executed column pass's, in shock-check.mjs ("a run falls on V1's fall").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ELEMENTS, E, K } from '../../src/elements.js';
import { SIM_GRAVITY, NOMINAL_STEP_RATE, PHYS } from '../../src/physics.js';
import { CELL_M } from '../../src/scale.js';
import { GRAVITY_MS2, TERMINAL_MS, STEPS_PER_TICK, v1PaceRate, v1TerminalMS } from '../../src/v2/gravity.js';
import { nativeModes, GRAVITY_MS2 as MODES_GRAVITY } from '../../src/v2/modes.js';
import { modeWGSL } from '../../src/shaders/v2/modes.js';
import { GRAVITY, dynamicsRows, particleFallSpeed, particleLandingSpeed, packetStep } from '../../src/v2/dynamics-reference.js';
import { PACE } from '../../src/shaders/move.js';
import { FALL_GRAVITY, fallTerminal, setFall, stepFall, fallVelocity, fallFraction } from '../../src/v2/fall.js';
import { G_MS2, fallCells } from '../../src/shaders/v2.js';
import { COLUMN } from '../../src/shaders/v2/columns.js';

test('every V2 owner pulls with V1\'s gravity and stops at V1\'s terminal speed', () => {
  // V1: 0.025 cells/step² at 240 steps/s of 0.3 m cells is 432 m/s²; V_MAX, a cell a step, 72 m/s
  assert.equal(GRAVITY_MS2, SIM_GRAVITY * NOMINAL_STEP_RATE ** 2 * CELL_M);
  assert.ok(Math.abs(GRAVITY_MS2 - 432) < 1e-9 && Math.abs(TERMINAL_MS - 72) < 1e-9);
  assert.equal(STEPS_PER_TICK, NOMINAL_STEP_RATE / 60);
  for (const g of [MODES_GRAVITY, GRAVITY, FALL_GRAVITY, G_MS2, COLUMN.G_MS2]) assert.equal(g, GRAVITY_MS2);
  assert.equal(COLUMN.G_STEP, SIM_GRAVITY);
  // the shallow-water faces at V1's pull, a pair step a V1 step: a face accelerates as if at most H_CAP deep, so g·h
  // (cells²/step²) stays at the explicit step's calibrated bound (lean-sim's 16 cells at 2 g a 60 Hz step, under the
  // 0.5 a one-step update is stable to)
  assert.equal(COLUMN.SUB, STEPS_PER_TICK);
  close(COLUMN.G_SUB, SIM_GRAVITY, 'a pair step\'s pull is V1\'s');
  close(COLUMN.G_SUB * COLUMN.H_CAP, 16 * 19.6 / CELL_M / 3600, 'deep face g·h');
  assert.ok(COLUMN.G_SUB * COLUMN.H_CAP < 0.5, `H_CAP ${COLUMN.H_CAP} cells at V1's pull`);
  // the gravity setting is V1's: its default is the reference pull, twice it twice the pull, off none
  assert.equal(nativeModes({ gravity: 0.025 }).gravity, GRAVITY_MS2);
  assert.equal(nativeModes({ gravity: 0.05 }).gravity, 2 * GRAVITY_MS2);
  assert.equal(nativeModes({ gravity: 0.025, gravityMode: 1 }).gravity, 0);
  // potentials are cells of height at the reference pull: no literal of another pull is left
  assert.match(modeWGSL, new RegExp(`const M_GRAVITY_REF: f32 = ${GRAVITY_MS2}\\.0;`));
  assert.doesNotMatch(modeWGSL, /19\.6|9\.8/);
  // V1's terminal speeds (react.js forces: g·(1-DRAG)/DRAG, to V_MAX; a falling liquid has no drag)
  close(v1TerminalMS(ELEMENTS[E.SAND]), 0.6 * 72, 'sand');
  close(v1TerminalMS(ELEMENTS[E.ASH]), 0.225 * 72, 'ash');
  for (const e of ELEMENTS) {
    if (e.kind === K.POWDER) close(fallTerminal(e.id), v1TerminalMS(e), e.key);
    if (e.kind === K.LIQUID) close(dynamicsRows[e.id].terminal, TERMINAL_MS, e.key);
    if (e.kind === K.POWDER) close(dynamicsRows[e.id].terminal, v1TerminalMS(e), e.key);
  }
  // a packet falls to its terminal speed (particles.js integrate: the tick's gravity, then implicit drag whose fixed
  // point is it; dynamics-reference.js packetStep, its twin), and keeps it
  for (const id of [E.SAND, E.ASH, E.WATER, E.SNOW, E.SCRAP]) {
    let v = 0;
    for (let t = 0; t < 600; t++) v = packetStep(id, v).v;
    close(v, dynamicsRows[id].terminal, `${ELEMENTS[id].key} packet`, 1e-3); // (its keep is f32, as the shader's table)
    close(particleFallSpeed(id, 400), dynamicsRows[id].terminal, `${ELEMENTS[id].key} packet after 400 m`, 1e-3);
  }
  // a fall's landing speed grows with its height (the velocity changes linearly across a tick)
  for (const id of [E.SCRAP, E.URANIUM, E.MERCURY, E.NITRO]) {
    let last = 0;
    for (let h = 0.05; h < 12; h += 0.05) { const u = particleLandingSpeed(id, h); assert.ok(u >= last - 1e-9, `${ELEMENTS[id].key} at ${h.toFixed(2)} m`); last = u; }
  }
});
function close(a, b, what, eps = 1e-6) { assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`); }

// V1's grain falls on its block's random stream: the chance it is a cell up on a top half or a bottom half before each
// step (dynamics-reference.js v1GrainOdds's chain), so its mean arrival step after falling h cells from rest, both
// phases alike, and its mean speed there (cells/step)
function v1GrainArrival(e, h) {
  const f32 = Math.fround, g = f32(SIM_GRAVITY * e.grav), keep = f32(1 - e.drag);
  let mean = 0, speed = 0;
  for (const phase of [0, 1]) {
    let top = new Float64Array(h + 1), bottom = new Float64Array(h + 1), v = 0;
    (phase === 0 ? top : bottom)[h] = 1;
    for (let n = 0; n < 20000; n++) {
      const after = Math.min(PHYS.V_MAX, f32(f32(v + g) * keep)), p = Math.min(1, v);
      const nextTop = new Float64Array(h + 1), nextBottom = new Float64Array(h + 1);
      let live = 0;
      for (let y = 1; y <= h; y++) {
        nextTop[y] += bottom[y];
        if (!top[y]) continue;
        if (y === 1) { mean += 0.5 * top[y] * p * (n + 1); speed += 0.5 * top[y] * p * v; } else nextTop[y - 1] += top[y] * p;
        nextBottom[y] += top[y] * (1 - p);
      }
      for (let y = 1; y <= h; y++) live += nextTop[y] + nextBottom[y];
      top = nextTop; bottom = nextBottom; v = after;
      if (live < 1e-9) break;
    }
  }
  return { step: mean, speed };
}
// V2's grain from rest (stepFall, at the reference pull): the tick its fall reaches h cells, its speed then (cells/step)
function v2GrainArrival(id, h) {
  let core = setFall(new Uint32Array([id, 0, 0, 0]), 0, 0), y = 0;
  for (let t = 1; t < 2000; t++) {
    const s = stepFall(core, GRAVITY_MS2); core = s.core; y += s.cells;
    if (y >= h) return { tick: t, speed: fallVelocity(core) / (NOMINAL_STEP_RATE * CELL_M) };
  }
  throw new Error('no landing');
}

test('a grain lands when V1\'s does, within a tick, and as fast', () => {
  // V1's Margolus pacing: a cell at u cells/step moves u/(2-u) a step on average
  close(v1PaceRate(0), 0, 'still'); close(v1PaceRate(0.6), 0.6 / 1.4, 'sand at its terminal speed'); close(v1PaceRate(1), 1, 'V_MAX');
  for (const key of ['SAND', 'STONE', 'SNOW', 'ASH', 'SAWDUST', 'SCRAP', 'URANIUM', 'DUST', 'CLAY']) {
    const e = ELEMENTS[E[key]];
    for (const h of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48]) {
      const v1 = v1GrainArrival(e, h), v2 = v2GrainArrival(e.id, h);
      // game time: V1's step n is in V2's tick ceil(n / 4) (four V1 steps a tick); V2 lands within a tick of it
      const tick = Math.ceil(v1.step / STEPS_PER_TICK);
      assert.ok(Math.abs(v2.tick - tick) <= 1, `${key} from ${h}: V2 tick ${v2.tick}, V1's mean step ${v1.step.toFixed(1)} (tick ${tick})`);
      // its speed: V1's mean at its landing, within the speed a tick of its fall gains
      assert.ok(Math.abs(v2.speed - v1.speed) <= STEPS_PER_TICK * SIM_GRAVITY + 0.02, `${key} from ${h}: ${v2.speed.toFixed(3)} vs V1 ${v1.speed.toFixed(3)} cells/step`);
    }
  }
  // the outcome bench's law is the column pass's own
  let core = setFall(new Uint32Array([E.SAND, 0, 0, 0]), 0, 0), cells = 0;
  for (let t = 0; t < 9; t++) { const s = stepFall(core, GRAVITY_MS2); core = s.core; cells += s.cells; }
  close(fallCells(E.SAND, 9), cells + fallFraction(core), 'fallCells');
});

// V1's lone liquid cell falling h cells at phase (dynamics-reference.js v1LiquidArrival's loop): the step it lands
function v1LiquidStep(h, phase) {
  const f32 = Math.fround, g = f32(SIM_GRAVITY), draw = n => { const w = Math.imul(n, PACE.Y) >>> 0; return f32(f32(f32((w >>> 8) * 256) + (w & 255)) * f32(2 ** -32)); };
  let y = h, v = 0, parity = (phase + h) & 1;
  for (let n = 0; n < 100000; n++) {
    parity ^= 1;
    if (v > 0 && ((y - parity) & 1) === 1) {
      const age = v < PHYS.V_MAX ? Math.floor(f32(f32(v / g) + 0.5)) : 0;
      if (v >= PHYS.V_MAX || draw(age) < v) { y -= 1; if (y === 0) return n + 1; }
    }
    v = Math.min(PHYS.V_MAX, f32(v + g));
  }
  throw new Error('no landing');
}
// a packet dropped from rest (dynamics-reference.js packetStep, particles.js dPacketFlight's twin): the tick it has
// fallen h cells
function packetArrival(id, h) {
  let v = 0, y = 0;
  for (let t = 1; t < 5000; t++) { const s = packetStep(id, v); y += s.fell; v = s.v; if (y >= h * CELL_M - 1e-9) return t; }
  throw new Error('no landing');
}
test('a packet lands when V1\'s cell does, within a tick, short drops and long (gravity leftover: V1\'s drag and move)', () => {
  // V1 react.js forces: a fixed drag a step (DRAG), V_MAX; move.js: a grain moves on its block's random draws (its
  // Margolus lag), a liquid on its R3 draws. V2's packets took a squared-speed drag and no lag: sand from 16 cells
  // landed 6 ticks early, ash from 16 cells 15
  for (const key of ['SAND', 'STONE', 'SCRAP', 'ASH', 'SNOW', 'URANIUM']) {
    const e = ELEMENTS[E[key]];
    for (const h of [2, 4, 8, 16, 32, 64]) {
      const v1 = Math.ceil(v1GrainArrival(e, h).step / STEPS_PER_TICK), v2 = packetArrival(e.id, h);
      assert.ok(Math.abs(v2 - v1) <= 1, `${key} packet from ${h}: tick ${v2}, V1 ${v1}`);
    }
  }
  for (const key of ['WATER', 'MERCURY', 'NITRO', 'LAVA']) {
    for (const h of [2, 4, 8, 16, 32, 64]) {
      const v1 = Math.ceil((v1LiquidStep(h, 0) + v1LiquidStep(h, 1)) / 2 / STEPS_PER_TICK), v2 = packetArrival(E[key], h);
      assert.ok(Math.abs(v2 - v1) <= 1, `${key} packet from ${h}: tick ${v2}, V1 ${v1}`);
    }
  }
});
