// The first-person body falls the same under both physics engines: the real player
// (src/pov/player.js) over a CPU floor probe, once on a V1 sim and once on a V2 one
// (sim.compact set). Jump, jet, pogo, Cruelty Squad's flight, swimming, gravity off and
// TPT's radial gravity must give the same motion, at Noita's gravity (player.xml, 5.4 g),
// not the grid's 2 g (docs/v2.md §5.1). No browser or GPU.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlayer, PX } from '../src/pov/player.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { PROBE, PROBE_CELLS } from '../src/shaders/povBody.js';
import { E } from '../src/elements.js';
import { GRAV } from '../src/simModes.js';

const FPS = 60;
const NOITA_GRAVITY = 350 * PX;        // cells/s²: player.js GRAVITY (Noita's pixel_gravity, by body height)
const NOITA_JUMP = 95 * PX;            // cells/s: player.js JUMP_SPEED (jump_velocity_y)
const GRID_2G = 19.6 / 0.3;            // cells/s²: the grid's 2 g (src/v2/modes.js GRAVITY_MS2 / CELL_M), what V2 gave the body
const SAME = 1e-9;                     // cells: the two engines' paths agree to rounding
const APEX_SLACK = 0.1;                // share: a 60 Hz step takes a frame's gravity before it moves (~6% of v²/2g)
const WATER_TOP = 20;                  // cells: the pool's surface in the swim case

function fixture({ v2, gravityMode = GRAV.VERTICAL, gravity = 0.025, floor = true, water = false }) {
  const sim = { g: { nx: 128, ny: 128, nz: 128 }, frame: 0, gravity, gravityMode, touchCentres: () => [], paint() {} };
  if (v2) sim.compact = {};
  if (gravityMode === GRAV.OFF) sim.gravity = 0;   // (sim.js: the gravity getter reads 0 with the mode off)
  setPovGpu(sim, {
    ready: true, edit: () => true, transfer: () => null,
    probe(name, { boxLo: lo }) {
      const buf = new Float32Array(PROBE_CELLS * 4);
      for (let y = 0; y < PROBE.Y; y++) for (let z = 0; z < PROBE.Z; z++) for (let x = 0; x < PROBE.X; x++) {
        const i = ((y * PROBE.Z + z) * PROBE.X + x) * 4;
        buf[i] = floor && lo[1] + y <= 0 ? E.WALL : water && lo[1] + y < WATER_TOP ? E.WATER : E.EMPTY;
        buf[i + 1] = 20;
      }
      return Promise.resolve(buf.buffer);
    },
  });
  const body = createPlayer({ renderer: {}, getSim: () => sim, quiet: true });
  const step = async (input = {}, pogo = false) => {
    if (pogo) body.holdPogo();
    sim.frame += 4; body.update(1 / FPS, input);
    await new Promise(resolve => setImmediate(resolve));
  };
  return { body, sim, step };
}

// one scenario on one engine: the body's height (and velocity) every frame
async function trace(v2, { spawn = [64, 1, 64], settle = 12, frames, input, pogo = false, ...opts }) {
  const { body, step } = fixture({ v2, ...opts });
  try {
    body.spawn(new THREE.Vector3(...spawn));
    for (let i = 0; i < settle; i++) await step({}, pogo);
    const path = [];
    for (let i = 0; i < frames; i++) {
      await step(typeof input === 'function' ? input(i) : input ?? {}, pogo);
      path.push({ pos: body.pos.clone(), vel: body.vel.clone(), ground: body.onGround });
    }
    return path;
  } finally { body.dispose(); }
}
const apexOf = (path, from) => Math.max(...path.map(f => f.pos.y)) - from;
async function same(name, scenario) {
  const [a, b] = [await trace(false, scenario), await trace(true, scenario)];
  a.forEach((f, i) => {
    assert.ok(f.pos.distanceTo(b[i].pos) < SAME, `${name}: V2 leaves V1's path at frame ${i} (${f.pos.toArray()} vs ${b[i].pos.toArray()})`);
    assert.ok(f.vel.distanceTo(b[i].vel) < SAME, `${name}: V2's velocity differs at frame ${i}`);
  });
  return a;
}

// a plain jump from the floor: the same apex, Noita's v²/2g, not the grid's
const jump = await same('jump', { frames: 90, input: i => ({ jump: i < 2 }) });
const apex = apexOf(jump, 1), noitaApex = NOITA_JUMP ** 2 / (2 * NOITA_GRAVITY);
assert.ok(Math.abs(apex - noitaApex) < noitaApex * APEX_SLACK, `jump apex ${apex} != Noita's ${noitaApex}`);
assert.ok(apex < NOITA_JUMP ** 2 / (2 * GRID_2G) / 2, 'the body does not jump at the grid\'s 2 g');
console.log(`jump: apex ${apex.toFixed(3)} cells on both engines (Noita ${noitaApex.toFixed(3)}; at the grid's 2 g it was ${(NOITA_JUMP ** 2 / (2 * GRID_2G)).toFixed(3)})`);

// a jump that turns into the jet, held; then the fall back down
const jet = await same('jet', { frames: 150, input: i => ({ jump: i < 60 }) });
console.log(`jet: climbs ${apexOf(jet, 1).toFixed(3)} cells on both engines`);

// the pogo stick's bounces with timed presses (its bounce speeds read the body's gravity)
const pogo = await same('pogo', { frames: 240, pogo: true, input: i => ({ jump: i % 20 === 0 }) });
console.log(`pogo: tops out ${apexOf(pogo, 1).toFixed(3)} cells on both engines`);

// Cruelty Squad's flight (the source game's gravity, the setting scaling it the same way)
const cruelty = await same('cruelty', { frames: 90, input: i => ({ cruelty: true, jump: i < 2 }) });
console.log(`cruelty jump: apex ${apexOf(cruelty, 1).toFixed(3)} cells on both engines`);

// a mode's lower gravity (Animal Crossing's 0.5, maps.js gravityScale) scales both alike
const half = await same('half gravity', { frames: 120, gravity: 0.0125, input: i => ({ jump: i < 2 }) });
assert.ok(Math.abs(apexOf(half, 1) - 2 * apex) < 2 * apex * APEX_SLACK, 'half the gravity, twice the apex');

// swimming up through water, then floating
await same('swim', { frames: 180, spawn: [64, 2, 64], water: true, input: i => ({ jump: i < 90 }) });
console.log('swim: the same strokes and float on both engines');

// gravity off: a body let go in the air stays put
const off = await same('gravity off', { frames: 60, spawn: [64, 40, 64], settle: 0, floor: false, gravityMode: GRAV.OFF });
assert.ok(Math.abs(off.at(-1).pos.y - 40) < SAME, 'nothing pulls with gravity off');

// radial: toward the box's centre at Noita's strength, on both engines. Above the centre the pull is
// all vertical; beside it, sideways (where Noita's air ease also eases the body's sideways speed)
const above = await same('radial above', { frames: 6, spawn: [64, 100, 64], settle: 0, floor: false, gravityMode: GRAV.RADIAL });
const pull = above[5].vel.clone().sub(above[4].vel).multiplyScalar(FPS);
assert.ok(Math.abs(pull.x) < SAME && Math.abs(pull.z) < SAME, `radial pulls toward the centre (${pull.toArray()})`);
assert.ok(Math.abs(-pull.y - NOITA_GRAVITY) < NOITA_GRAVITY * APEX_SLACK, `radial pull ${-pull.y} != Noita's ${NOITA_GRAVITY}`);
const beside = await same('radial beside', { frames: 6, spawn: [20, 64, 64], settle: 0, floor: false, gravityMode: GRAV.RADIAL });
assert.ok(beside[5].vel.x > 0 && Math.abs(beside[5].vel.y) < SAME, `beside the centre it pulls sideways (${beside[5].vel.toArray()})`);
console.log(`radial: ${(-pull.y).toFixed(1)} cells/s² toward the centre on both engines`);
console.log('Body gravity: V1 and V2 give the same jump, jet, pogo, Cruelty, swim, off and radial motion');
