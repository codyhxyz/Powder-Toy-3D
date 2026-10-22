// CPU only: V2's air (air.js step, its twin dynamics-reference.js airStepReference) behaves as V1's
// (src/shaders/react.js "air pressure" and "forces" on an EMPTY cell, src/shaders/passes.js tools).
// V1's per-cell rule runs here as written there, at its 240 Hz step; V2's brick twin at its 60 Hz
// tick, with a tool's paint committed as nativeWeather.js's air stage does (the brick's mean of the
// per-cell deltas). Cases: a blast's pressure in a sealed and in an open box (it decays at P_DECAY
// either way), a held Pressure and Vacuum brush (TOOL_PRESSURE a paint, decaying to V1's level), and a
// wind stroke's draft (EMPTY's drag). Each fails on the acoustic air it replaced (sealed pressure
// kept, the brush radiated away, the draft kept).
import assert from 'node:assert/strict';
import { PHYS } from '../../src/physics.js';
import { ELEMENTS, E } from '../../src/elements.js';
import { AIR, AIR_CELLS, V1_AIR, LEGACY_PRESSURE_PA } from '../../src/v2/pressure.js';
import { airStepReference } from '../../src/v2/dynamics-reference.js';
import { LEGACY_STEPS_PER_TICK, LEGACY_STEP_HZ, HOST_HZ } from '../../src/v2/host.js';
import { CELL_M } from '../../src/scale.js';

const N = 32, B = N / AIR_CELLS;   // a 32³-cell box: 8³ bricks
const cell = (x, y, z) => x + N * (z + N * y), brick = (x, y, z) => x + B * (z + B * y);
const inBox = c => c.every(v => v >= 0 && v < N);
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// V1 react.js air pressure for an all-air box: pn is an open neighbour's pressure, or past the box a
// wall's (the cell's own: pressure-reflecting) or a void's (0: open, still air); spread =
// max(P0 + P_DIFFUSE·lap, front·P_FRONT)·P_DECAY, clamped to [P_MIN, P_MAX] (react.js outB).
function v1Step(P, open) {
  const out = new Float64Array(P.length);
  for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const i = cell(x, y, z), P0 = P[i];
    let lap = 0, front = -Infinity;
    for (const f of FACES) {
      const q = [x + f[0], y + f[1], z + f[2]];
      const pn = inBox(q) ? P[cell(...q)] : open ? 0 : P0;
      lap += pn - P0; front = Math.max(front, pn);
    }
    out[i] = Math.min(PHYS.P_MAX, Math.max(PHYS.P_MIN, Math.max(P0 + PHYS.P_DIFFUSE * lap, front * PHYS.P_FRONT) * PHYS.P_DECAY));
  }
  return out;
}
// V2's brick twin (sealed box: airStepReference's walls). An open box's void faces: the step reads a
// still, empty neighbour there (air.js aFace/virtual), as V1's void edge does; the fixture adds a
// ring of bricks held at zero to stand for it.
function v2Tick(state, open) {
  const dims = open ? [B + 2, B + 2, B + 2] : [B, B, B];
  let s = state;
  for (let k = 0; k < AIR.substeps; k++) {
    s = airStepReference(s, dims, { substep: k });
    if (open) s = s.map((a, i) => { const x = i % (B + 2), z = Math.floor(i / (B + 2)) % (B + 2), y = Math.floor(i / (B + 2) ** 2);
      return [x, y, z].some(c => c === 0 || c === B + 1) ? { velocity: [0, 0, 0], pressure: 0, heat: 0, gas: 0 } : a; });
  }
  return s;
}
const blank = n => Array.from({ length: n }, () => ({ velocity: [0, 0, 0], pressure: 0, heat: 0, gas: 0 }));
const pad = open => (x, y, z) => open ? x + 1 + (B + 2) * (z + 1 + (B + 2) * (y + 1)) : brick(x, y, z);
const v2Pressure = (s, open, x, y, z) => s[pad(open)(x, y, z)].pressure / LEGACY_PRESSURE_PA;

// passes.js update: the brush's smoothstep falloff, full inside TOOL_FALLOFF of the radius
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const falloff = (p, c, r) => { const d = Math.hypot(...p.map((v, a) => v + 0.5 - c[a])); return d > r ? 0 : 1 - smooth(r * PHYS.TOOL_FALLOFF, r + 0.001, d); };

function close(actual, expected, tolerance, what) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.abs(expected), `${what}: V2 ${actual.toFixed(3)} vs V1 ${expected.toFixed(3)} (±${tolerance * 100}%)`);
}
const ticks = s => Math.round(s * HOST_HZ);

// 1. A blast's pressure: one brick of the box at gunpowder's blast.P (V1: its cells), sealed and open.
//    V1 keeps P_DECAY a step whatever the walls do; V2 must too (acoustic air kept a sealed box's).
for (const open of [false, true]) {
  const P0 = ELEMENTS[E.GUNPOWDER].blast.P, c0 = 3 * AIR_CELLS;
  let v1 = new Float64Array(N ** 3);
  for (let y = c0; y < c0 + AIR_CELLS; y++) for (let z = c0; z < c0 + AIR_CELLS; z++) for (let x = c0; x < c0 + AIR_CELLS; x++) v1[cell(x, y, z)] = P0;
  let v2 = blank(open ? (B + 2) ** 3 : B ** 3); v2[pad(open)(3, 3, 3)].pressure = P0 * LEGACY_PRESSURE_PA;
  const v1Sum = () => v1.reduce((s, p) => s + p, 0) / AIR_CELLS ** 3;
  const v2Sum = () => { let t = 0; for (let y = 0; y < B; y++) for (let z = 0; z < B; z++) for (let x = 0; x < B; x++) t += v2Pressure(v2, open, x, y, z); return t; };
  let tick = 0;
  for (const at of [0.05, 0.1, 0.2, 0.3]) {
    for (; tick < ticks(at); tick++) { for (let k = 0; k < LEGACY_STEPS_PER_TICK; k++) v1 = v1Step(v1, open); v2 = v2Tick(v2, open); }
    // the source's own pressure: V1's cells of that brick, averaged
    let src1 = 0; for (let y = c0; y < c0 + AIR_CELLS; y++) for (let z = c0; z < c0 + AIR_CELLS; z++) for (let x = c0; x < c0 + AIR_CELLS; x++) src1 += v1[cell(x, y, z)] / AIR_CELLS ** 3;
    let nb1 = 0; for (let y = c0; y < c0 + AIR_CELLS; y++) for (let z = c0; z < c0 + AIR_CELLS; z++) for (let x = c0 + AIR_CELLS; x < c0 + 2 * AIR_CELLS; x++) nb1 += v1[cell(x, y, z)] / AIR_CELLS ** 3;
    close(v2Pressure(v2, open, 3, 3, 3), src1, 0.25, `${open ? 'open' : 'sealed'} box, the blast's brick at ${at} s`);
    // A front hop of a brick keeps P_FRONT^AIR_CELLS, V1's over AIR_CELLS cells: the far field's reach.
    // The brick next to the source holds the mean of cells 1-4 cells out in V1, so it reads ~20-30% low.
    close(v2Pressure(v2, open, 4, 3, 3), nb1, 0.3, `${open ? 'open' : 'sealed'} box, the next brick at ${at} s`);
    close(v2Sum(), v1Sum(), 0.5, `${open ? 'open' : 'sealed'} box, all the pressure at ${at} s`);
  }
  // gone in ~0.3 s, sealed or not (react.js P_DECAY), as V1's
  assert.ok(v2Pressure(v2, open, 3, 3, 3) < 0.15 * P0, `${open ? 'open' : 'sealed'} box: the blast's pressure decays (${v2Pressure(v2, open, 3, 3, 3).toFixed(2)})`);
  // and the front reached the far corner, V1's distance law (P_FRONT a cell)
  const far1 = v1[cell(N - 2, N - 2, N - 2)], far2 = v2Pressure(v2, open, B - 1, B - 1, B - 1);
  assert.ok(far2 > 0 && far1 > 0, 'the front crossed the box');
}

// 2. A held Pressure / Vacuum brush (passes.js T_BLAST, T_VACUUM: ±TOOL_PRESSURE·falloff a paint, once
//    a frame, V1 clamps Vacuum at P_MIN), radius 6 at the box's centre, held 1 s.
for (const sign of [1, -1]) {
  const c = [N / 2, N / 2, N / 2], r = 6;
  let v1 = new Float64Array(N ** 3), v2 = blank(B ** 3);
  for (let t = 0; t < HOST_HZ; t++) {
    const delta = new Float64Array(B ** 3);
    for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const f = falloff([x, y, z], c, r); if (!f) continue;
      const i = cell(x, y, z), before = v1[i];
      v1[i] = sign > 0 ? before + PHYS.TOOL_PRESSURE * f : Math.max(before - PHYS.TOOL_PRESSURE * f, PHYS.P_MIN);
      // nativeWeather.js air: the brick gets its cells' mean, the V1 rule run on the brick's own pressure
      const b = brick(x >> 2, y >> 2, z >> 2), pb = v2[b].pressure / LEGACY_PRESSURE_PA;
      delta[b] += ((sign > 0 ? pb + PHYS.TOOL_PRESSURE * f : Math.max(pb - PHYS.TOOL_PRESSURE * f, PHYS.P_MIN)) - pb) * LEGACY_PRESSURE_PA / AIR_CELLS ** 3;
    }
    v2 = v2.map((a, i) => ({ ...a, pressure: a.pressure + delta[i] }));
    for (let k = 0; k < LEGACY_STEPS_PER_TICK; k++) v1 = v1Step(v1, false);
    v2 = v2Tick(v2, false);
  }
  let centre1 = 0; for (let y = 12; y < 20; y++) for (let z = 12; z < 20; z++) for (let x = 12; x < 20; x++) centre1 += v1[cell(x, y, z)] / 512;
  let centre2 = 0; for (const y of [3, 4]) for (const z of [3, 4]) for (const x of [3, 4]) centre2 += v2[brick(x, y, z)].pressure / LEGACY_PRESSURE_PA / 8;
  console.log(`${sign > 0 ? 'Pressure' : 'Vacuum'} brush held 1 s, its middle: V1 ${centre1.toFixed(2)}, V2 ${centre2.toFixed(2)} (V1 units)`);
  // V1's vacuum refills at once from its rim (the front spreads only the strongest neighbour), so a
  // held Vacuum stays near 0 in both: compare on TOOL_PRESSURE's scale there.
  if (sign > 0) close(centre2, centre1, 0.3, 'Pressure brush held 1 s, the brush\'s middle');
  else assert.ok(Math.abs(centre2 - centre1) < 0.05 * PHYS.TOOL_PRESSURE, `Vacuum brush held 1 s: V2 ${centre2} vs V1 ${centre1}`);
}

// 3. A wind stroke's draft (passes.js T_WIND pushed(): an air cell takes dv in full, ρ = RHO_MIN) then
//    V1's drag on air, DRAG(EMPTY) a step: the draft's speed after 0.1 s.
{
  const dv = 20, keep = (1 - ELEMENTS[E.EMPTY].drag) ** (0.1 * LEGACY_STEP_HZ);
  let v2 = blank(B ** 3); v2[brick(4, 4, 4)].velocity = [dv, 0, 0];
  for (let t = 0; t < ticks(0.1); t++) v2 = v2Tick(v2, false);
  let momentum = 0; for (const a of v2) momentum += a.velocity[0];
  close(momentum, dv * keep, 0.1, 'a wind stroke\'s draft after 0.1 s');
  assert.ok(V1_AIR.vMax === PHYS.V_MAX * LEGACY_STEP_HZ * CELL_M, 'air speed caps at V_MAX');
}
// 4. EL-8: a bolt's strike (src/shaders/lightning.js: the open cells within strikeR + STRIKE_P_REACH take
//    STRIKE_P) cracks the rock under it in V1 (react.js: dP 160 > ROCK's hard·P_BREAK_PER_HARD 150). Folded
//    into V2's bricks as a mean (nativeWeather.js air) it never reaches that; read per cell at the commit
//    (V1_PRESSURE_BREAK_WGSL), as V1's next step reads it, it does.
{
  const { BOLT, STORM } = await import('../../src/bolt.js');
  const { V1_PRESSURE_BREAK_WGSL, nativeWeatherCommitWGSL, nativeWeatherParams } = await import('../../src/v2/nativeWeather.js');
  const { nativeForceCommitWGSL } = await import('../../src/v2/nativeForcing.js');
  const { gridLayout } = await import('../../src/sim.js');
  const rock = ELEMENTS[E.ROCK], floor = 10, strike = [16.5, floor + 0.5, 16.5], reach = STORM.STRIKE_R + BOLT.STRIKE_P_REACH;   // a natural strike
  const struck = new Map(); // open cells the strike sets, by brick
  for (let y = floor; y < N; y++) for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    if (Math.hypot(x + 0.5 - strike[0], y + 0.5 - strike[1], z + 0.5 - strike[2]) >= reach) continue;
    const b = brick(x >> 2, y >> 2, z >> 2); struck.set(b, (struck.get(b) ?? 0) + 1);
  }
  const strength = rock.hard * PHYS.P_BREAK_PER_HARD, brickMax = Math.max(...struck.values()) * BOLT.STRIKE_P / AIR_CELLS ** 3;
  assert.ok(brickMax < strength, `a strike folded into bricks stays under rock's ${strength} (${brickMax.toFixed(1)}): the gap EL-8 found`);
  // V1's rule on the strike's own cells: the rock cell under the strike, open above at STRIKE_P, rock below
  assert.ok(BOLT.STRIKE_P - 0 > strength, 'V1 cracks the rock under a strike');
  const breakP = new RegExp(`case ${E.ROCK}u: \\{ return ${strength.toFixed(4)}; \\}`);
  assert.match(V1_PRESSURE_BREAK_WGSL, breakP, 'the commit breaks rock at V1\'s hard·P_BREAK_PER_HARD');
  assert.match(V1_PRESSURE_BREAK_WGSL, new RegExp(`case ${E.ROCK}u: \\{ return ${E[rock.breakInto]}; \\}`), 'into its V1 debris');
  const g = gridLayout(16, 16, 16), params = nativeWeatherParams('bolt', { params: { strikeR: 'f32' } });
  assert.match(nativeWeatherCommitWGSL(g, params, 'material'), /let broke=wPressureBreak\(p,r\);/, 'the weather commit (a bolt) breaks per cell');
  assert.match(nativeForceCommitWGSL(g, params, 'plan'), /let broke=wPressureBreak\(p,r\); if\(broke>=0\) \{ flags=2u/, 'the force commit (a wand, the Pressure tool) plans the fracture');
  // V1's front goes on through the layers it breaks (a rocket's PULSE_P broke 191 cells of a wood wall in V1, 106
  // under V2 when only the face broke: tools/v2/blast-damage-browser-check.mjs rocket). V1's per-cell law on a wall
  // of layers behind a written slab of open cells, against the commit's walk (writerLayersBroken, its twin).
  const { writerLayersBroken, WRITER_LAYERS, WRITER_LAYER_KEEP } = await import('../../src/v2/nativeWeather.js');
  const v1Layers = (open, key, width = 4, layers = 20) => {
    const n = width + layers, hard = ELEMENTS[E[key]].hard * PHYS.P_BREAK_PER_HARD;
    let P = new Float64Array(n).fill(open, 0, width), solid = new Uint8Array(n).fill(1, width);
    for (let t = 0; t < 300; t++) {
      const out = new Float64Array(n), next = new Uint8Array(solid);
      for (let x = 0; x < n; x++) {
        const own = P[x], open1 = i => i >= 0 && i < n && !solid[i];
        if (solid[x]) { if (Math.abs((open1(x - 1) ? P[x - 1] : 0) - (open1(x + 1) ? P[x + 1] : 0)) > hard) next[x] = 0; continue; }
        const l = open1(x - 1) ? P[x - 1] : own, r = open1(x + 1) ? P[x + 1] : own;   // (its slab's other faces: its own)
        out[x] = Math.min(PHYS.P_MAX, Math.max(own + PHYS.P_DIFFUSE * (l + r - 2 * own), Math.max(own, l, r) * PHYS.P_FRONT) * PHYS.P_DECAY);
      }
      P = out; solid = next;
    }
    let broken = 0; for (let x = width; x < n; x++) broken += 1 - solid[x];
    return broken;
  };
  for (const [open, key] of [[140, 'WOOD'], [140, 'BRICK'], [160, 'ROCK'], [200, 'GLASS'], [120, 'GLASS'], [100, 'LAMP'], [200, 'BRICK']]) {
    const v1 = v1Layers(open, key), v2 = writerLayersBroken(open, Array(20).fill(ELEMENTS[E[key]].hard * PHYS.P_BREAK_PER_HARD));
    assert.equal(v2, v1, `a writer's ${open} on ${key}: V1 breaks ${v1} layers, the commit ${v2}`);
  }
  const breakWGSL = V1_PRESSURE_BREAK_WGSL;
  assert.ok(breakWGSL.includes(`const W_LAYERS: i32 = ${WRITER_LAYERS};`) && breakWGSL.includes(`const W_LAYER_KEEP: f32 = ${WRITER_LAYER_KEEP};`) &&
    breakWGSL.includes('through=through && open*pow(W_LAYER_KEEP,f32(j-1-k))>wLayerP(mEdge(p+d*k));'), 'the commit walks the layers as writerLayersBroken');
}
// 5. MV-6: couplePlan pushes a loose cell down the pressure gradient by V1's law (react.js forces: a =
//    -∇P·P_ACCEL/ρ, ρ = max(dens·RHO_SCALE, RHO_MIN), its drag), at V1's chance of moving, not only past
//    the wind's lift.
{
  const { blastsWGSL } = await import('../../src/shaders/v2/blasts.js');
  const { nativeDynamicsHead } = await import('../../src/shaders/v2.js');
  const { gridLayout } = await import('../../src/sim.js');
  const plan = blastsWGSL(gridLayout(16, 16, 16), nativeDynamicsHead, 'couplePlan'), sand = ELEMENTS[E.SAND];
  const row = `case ${E.SAND}u: { return vec2f(${Math.max(sand.dens * PHYS.RHO_SCALE, PHYS.RHO_MIN)},${sand.drag}); }`;
  assert.ok(plan.includes(row), 'sand pushed at V1\'s ρ and drag');
  assert.match(plan, /let push=dV1Push\(p,id\); if \(any\(push!=vec3f\(0\)\)\) \{ plan\.flags=1u; plan\.velocity=push; \}/, 'loose cells take V1\'s push');
  // V1's move: an axis walled in by matter moves none (a buried bed's surface pushed along itself stays: the rocket
  // GPU scene, tools/v2/blast-damage-browser-check.mjs, had its whole sand floor stripped)
  assert.ok(plan.includes('if (v[k]!=0.0 && dOpen(p+dAxis(k)*select(-1,1,v[k]>0.0))) { free[k]=v[k]; }') && plan.includes('return free*'), 'the push moves only along free axes');
  // a held Pressure brush's edge (case 2: ~4 V1 units a cell) moves sand at V1's speed, well under V_MAX
  const a = 4 / 2 * 2 * PHYS.P_ACCEL / Math.max(sand.dens * PHYS.RHO_SCALE, PHYS.RHO_MIN), v = Math.min(PHYS.V_MAX, a * (1 - sand.drag) / sand.drag);
  assert.ok(v > 0.1 && v <= PHYS.V_MAX, `sand at a held brush's edge moves (${v.toFixed(2)} cells/step)`);
}
console.log('air V1 law CPU: sealed and open blast decay, held Pressure and Vacuum, wind draft drag match V1 react.js (no GPU)');
