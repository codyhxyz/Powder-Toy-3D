// CPU check of the body in liquids (water, oil, lava, drowning), a blast and hot
// gas, in node, no GPU and no server: the real body (src/pov/player.js) over a
// mock sim whose probe (its POV GPU work stood in for: pov/gpu.js setPovGpu, as
// perks-cpu-check's) reads still pools from a voxel function, with their
// temperature, and a pressure field. It is pov-player-check's long scenes'
// witness in the container, where the GPU run of water, oil, drown, lava,
// blast and fire keeps the 64³ box awake for minutes each
// (tools/pov-player-check.mjs --all): the same basins and spawns, the body's
// own floating, sinking, breath, burning, throw and skin heat, without the
// sim's waves, blast front or fire (the probe's reads of cells, temperature
// and pressure, cell for cell, are pov-gpu-check's probes stage; the body
// pushing water, its edits stage's povCouple).
// usage: node tools/pov-body-cpu-check.mjs
import * as THREE from 'three';
import { createPlayer } from '../src/pov/player.js';
import { createPerkSet } from '../src/pov/perks.js';
import { E, ELEMENTS } from '../src/elements.js';
import { PROBE, PROBE_CELLS } from '../src/shaders/povBody.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { BODY_HEIGHT } from '../src/pov/constants.js';

const STEPS = 4;            // sim steps a frame (the app's default)
const DT = 0.05;            // s a frame (pov-player-check's BODY_DT)
const AMBIENT = 20;
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`); };

// A still basin as pov-player-check builds it (its old 128³ coordinates less 32): `wall` from
// x, z 8..56 and y 0..top, hollow inside from 9..55, filled with `liquid` below `surface`.
const basin = (liquid, surface, wall = E.GLASS, top = 22, inset = 1) => (x, y, z) => {
  if (x < 8 || x >= 57 || z < 8 || z >= 57 || y >= top) return E.EMPTY;
  if (y === 0 || x < 8 + inset || x >= 57 - inset || z < 8 + inset || z >= 57 - inset) return wall;
  return y < surface ? liquid : E.EMPTY;
};

// the mock sim: its probe answered from cell() (the box at boxLo, x fastest, then z, then y), T
// each element's own (ambient air) unless temp(id, t) says, pressure from P(x, y, z, t) (t: the
// body's seconds), its edits taken, its transfers not issued (a wound's bleed isn't spilled: as
// while the transfer's kernel builds)
function makeBody(cell, { temp = null, P = null } = {}, n = [64, 64, 64]) {
  let body = null;
  const sim = { g: { nx: n[0], ny: n[1], nz: n[2] }, frame: 0, gravity: 0.025, touchCentres(lo, hi) { return { lo, hi }; }, paint() {} };
  setPovGpu(sim, {
    ready: true,
    edit: () => true,
    transfer: () => null,
    probe(name, { boxLo: b }) {
      const buf = new Float32Array(PROBE_CELLS * 4);
      for (let ly = 0; ly < PROBE.Y; ly++) for (let lz = 0; lz < PROBE.Z; lz++) for (let lx = 0; lx < PROBE.X; lx++) {
        const i = ((ly * PROBE.Z + lz) * PROBE.X + lx) * 4;
        const cx = b[0] + lx, cy = b[1] + ly, cz = b[2] + lz;
        const out = cx < 0 || cz < 0 || cy < 0 || cx >= n[0] || cz >= n[2] || cy >= n[1];
        const id = out ? -1 : cell(cx, cy, cz), t = body?.t ?? 0;
        buf[i] = id; buf[i + 1] = temp?.(id, t) ?? (id > 0 ? ELEMENTS[id].temp : AMBIENT);
        buf[i + 2] = out || !P ? 0 : P(cx, cy, cz, t); buf[i + 3] = 0;
      }
      return Promise.resolve(buf.buffer);
    },
  });
  body = createPlayer({ renderer: {}, getSim: () => sim, quiet: true, perks: createPerkSet() });   // (renderer: the transfer's key)
  body.events = [];
  for (const k of ['hurt', 'death']) body.on(k, (d) => body.events.push([k, d?.cause ?? '']));
  body.t = 0;
  const run = async (secs, input = {}, each = null) => {
    for (let t = 0; t < secs; t += DT) {
      sim.frame += STEPS;
      body.update(DT, input);
      body.t += DT;
      each?.(body);
      await new Promise((r) => setImmediate(r));
    }
  };
  return { body, run };
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---- water: a plunge from 10 cells over the surface, then floating, then swimming up
{
  const SURFACE = 16, { body, run } = makeBody(basin(E.WATER, SURFACE));
  body.spawn(V(32, 26, 32));
  let minY = 99;
  await run(4, {}, (b) => { minY = Math.min(minY, b.pos.y); });
  const plunge = { minFeetY: +minY.toFixed(2), after4s: +body.pos.y.toFixed(2) };
  check('water: a plunge goes under, then comes back up', minY < SURFACE - 2 && body.pos.y > minY + 1, plunge);
  body.spawn(V(32, 9, 32));
  const ys = [];
  await run(10, {}, (b) => ys.push(b.pos.y));
  const tail = ys.slice(-60), mean = tail.reduce((a, y) => a + y, 0) / tail.length;
  const float = { meanFeetY: +mean.toFixed(2), headTopMinusSurface: +(mean + BODY_HEIGHT - SURFACE).toFixed(2), range: +(Math.max(...tail) - Math.min(...tail)).toFixed(2) };
  // (the body, 9.8 against water's 10, floats with about 2% of it out: its head at the surface)
  check('water: left alone it floats, the head at the surface, settled', Math.abs(float.headTopMinusSurface) < 1.5 && float.range < 1 && body.inLiquid, float);
  let out = null;
  const t0 = body.t;
  await run(3, { jump: true }, (b) => { if (out === null && !b.headInLiquid) out = { after: +(b.t - t0).toFixed(2), feetY: +b.pos.y.toFixed(2) }; });   // (held on, the jetpack takes over: the flight after is not what's checked)
  check('water: swimming up puts the head out', out !== null, out ?? {});
}

// ---- oil: lighter than the body (8 against 9.8), so it sinks to the floor
{
  const { body, run } = makeBody(basin(E.OIL, 16));
  body.spawn(V(32, 17, 32));
  await run(6);
  check('oil: the body sinks through it to the floor', body.pos.y < 2 && body.liquidId === E.OIL && body.headInLiquid, { feetY: +body.pos.y.toFixed(2), liquid: ELEMENTS[body.liquidId]?.key });
}

// ---- drowning: diving at the floor of a deep pool, breath runs out after BREATH_TIME, then it hurts
{
  const { body, run } = makeBody(basin(E.WATER, 24, E.GLASS, 30));
  body.spawn(V(32, 5, 32));
  let firstHurt = null, breath10 = null;
  await run(24, { down: true }, (b) => {
    if (breath10 === null && b.t > 10) breath10 = +b.breath.toFixed(3);
    if (firstHurt === null && b.health < 1) firstHurt = +b.t.toFixed(2);
  });
  const r = { breathAt10s: breath10, firstHurtAt: firstHurt, health: +body.health.toFixed(3), dead: body.dead, cause: body.cause };
  check('drown: held breath runs 15 s, then the water hurts', breath10 > 0.2 && breath10 < 0.5 && firstHurt > 14.5 && firstHurt < 16.5 && body.health < 1, r);
}

// ---- lava: dense enough to float on (25), and it kills
{
  const { body, run } = makeBody(basin(E.LAVA, 8, E.WALL, 10, 2));
  body.spawn(V(32, 14, 32));
  let deathAt = null;
  await run(6, {}, (b) => { if (b.dead && deathAt === null) deathAt = +b.t.toFixed(2); });
  check('lava: falling in kills, the lava the cause', deathAt !== null && /lava/i.test(body.cause ?? ''), { deathAt, cause: body.cause, feetY: +body.pos.y.toFixed(2) });
}

// ---- a blast: a pressure peak 6 cells off on +x for a fifth of a second throws the body away from
// it, pushed no faster than PRESSURE_MAX_SPEED, and over BLAST_HURT_P it hurts
{
  const BLAST = [38, 2, 32], PEAK = 40, R = 12, PULSE = 0.2;
  let at = Infinity;   // the body's second the blast goes off
  const P = (x, y, z, t) => (t >= at && t < at + PULSE ? PEAK * Math.max(0, 1 - Math.hypot(x + 0.5 - BLAST[0], y + 0.5 - BLAST[1], z + 0.5 - BLAST[2]) / R) : 0);
  const { body, run } = makeBody((x, y) => (y === 0 ? E.ROCK : E.EMPTY), { P });
  body.spawn(V(32, 1, 32));
  await run(0.5);
  at = body.t;
  let maxSpeed = 0, minVx = 0;
  await run(1.5, {}, (b) => { maxSpeed = Math.max(maxSpeed, b.vel.length()); minVx = Math.min(minVx, b.vel.x); });
  const r = { maxSpeed: +maxSpeed.toFixed(1), minVx: +minVx.toFixed(1), thrownX: +(32 - body.pos.x).toFixed(2), health: +body.health.toFixed(3) };
  // (PRESSURE_MAX_SPEED, 60 cells/s, caps the push: gravity adds to the speed after it)
  check('blast: thrown away from it, pushed to at most PRESSURE_MAX_SPEED, and hurt', minVx < -5 && minVx >= -60 - 1e-6 && body.pos.x < 31 && body.health < 1, r);
}

// ---- hot gas: a second in 200 °C steam warms the skin past SKIN_BURN_T and burns (air itself,
// 0.0005 against the skin's 0.03, hardly carries heat); back in the open the skin cools to where it
// was before (blood at 37 °C against the 20 °C rock underfoot). (Not checked: the cause, which names
// the contact with the largest flux either way, by then the cool rock: vitals.js heatCause.)
{
  let hot = false;
  const { body, run } = makeBody((x, y) => (y === 0 ? E.ROCK : hot ? E.STEAM : E.EMPTY), { temp: (id) => (id === E.STEAM ? 200 : undefined) });
  body.spawn(V(32, 1, 32));
  await run(10);
  const before = +body.skinT.toFixed(1);
  hot = true;
  await run(1);
  const r = { before, skinT: +body.skinT.toFixed(1), health: +body.health.toFixed(3) };
  hot = false;
  await run(10);
  r.skinAfter = +body.skinT.toFixed(1);
  check('heat: hot steam warms the skin past 48 °C and burns; it cools back after', r.skinT > 48 && r.health < 1 && !body.dead && Math.abs(r.skinAfter - before) < 0.5, r);
}

console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
