import * as THREE from 'three';
import { TRACE, TRACE_MISS, TRACE_ROUND, STRIKE } from '../shaders/povTrace.js';
import { povGpu } from './gpu.js';
import { projectileSeconds } from '../v2/host.js';
import { ELEMENTS, K } from '../elements.js';
import { CELL_METERS } from './vitals.js';
import { povEvents } from './events.js';
import { segmentTarget, dealtScale, PLAYER } from './targets.js';

// Ballistic rounds: the guns' shots fly outside the sim, with real ballistics,
// and touch the sim only where they strike, adding nothing to it.
//
// Why: on the sim's clock a cell can't outrun V_MAX = 1 cell/step (≈ 240
// cells/s, 72 m/s), and its gravity is 0.025 cells/step² (≈ 44 g in real
// time), so a slug that is a cell from the muzzle drops into the ground ~20
// cells (6 m) away. A round instead leaves at a real muzzle speed and falls at
// a real 1 g, integrated on the CPU in real time, and covers a 128-cell world
// in a tenth of a second.
//
// Each frame:
//   1. Flight. A round's position is the closed form p0 + v0·t + ½·g·t² of its
//      flight time t, which advances by the frame's dt while the sim runs
//      (pausing the sim freezes rounds in the air).
//   2. Trace. One small GPU dispatch (shaders/povTrace.js traceFrag) marches each
//      round's path a little ahead of it, LOOKAHEAD frames past the readback
//      latency, through the grid and reports the first liquid, powder or solid
//      on it. Several readbacks stay in flight, like the player's probe, so an
//      answer lands every frame. The world keeps moving for the frame or two
//      an answer takes; that's the price of not stalling the GPU.
//   3. Impact. When a round reaches a reported hit, the strike (an edit) spends the
//      round's energy along its path from the struck face, by the engine's own
//      projectile rule (react.js: each solid it breaks costs it that solid's
//      hardness): glass shatters, wood breaks into sawdust, a pool or a pile
//      is shoved and slows it, metal stops it unless it carries more than
//      metal's hardness. Debris is the struck cells' own matter; no cell is
//      added. (Rounds used to become a SCRAP slug at the face, and the slugs
//      piled up and plugged the holes they made.)
//      A round's energy is in the sim's units (½·DENS·v², cells/step), the
//      gun's choice: the pistol's ROUND_ENERGY is what the old slug could
//      carry, ½·DENS[SCRAP]·V_MAX² = 39, and a sniper's is several times it.
//      A round that runs out through the sides or top of the box is gone.
//
// Units: grid cells, seconds, cells/s (cells/step for the sim's velocities).
//
// Other projectiles fly the same way: fire()'s options give a speed and an
// onStrike that does something else where it lands (the bomb's charge, the
// rocket's blast) instead of the strike.
//
// Events (docs/pov.md): round:move every frame per round, round:end (both with
// the projectile's kind), impact (rounds only, not onStrike projectiles).

const G_EARTH = 9.8;                    // m/s²
const MUZZLE_SPEED_MS = 360;            // m/s, a subsonic pistol round
const SIM_GRAVITY_REF = 0.025;          // cells/step², the sim's default gravity (sim.js GRAVITY_DEFAULT)
export const ROUND_SPEED = MUZZLE_SPEED_MS / CELL_METERS;   // cells/s (1200)
const BODY_ROUND_DAMAGE = 0.5;          // health a round takes from a body (an NPC) unless fire() says: two kill
const BODY_ROUND_ENERGY = 39;           // the impact's energy for the shake and hitmarker
export const ROUND_GRAVITY = G_EARTH / CELL_METERS;        // cells/s² (≈ 33) at the default sim gravity; the setting scales it
export const ROUND_ENERGY = 39;         // a round's energy at the face unless fire() says (sim KE units: breaks rock's 30, not metal's 60)
const ROUND_DEPTH = 8;                  // cells a round's strike walks on past the face unless fire() says
export const MAX_ROUNDS = TRACE.ROUNDS;
// fire()'s gravityScale for the sim's gravity setting: projectiles fall at 1 g at the default
export const gravityScale = (sim) => sim.gravity / SIM_GRAVITY_REF;                    // rounds the trace pass can follow at once

const TRACE_INFLIGHT = 3;               // trace readbacks in flight at once
const LATENCY_INIT = 2;                 // frames a readback is assumed to take before the first one lands
const LATENCY_EASE = 0.2;               // share of each new latency sample in the running estimate
const LOOKAHEAD_FRAMES = 2;             // frames of flight traced beyond the latency
const FRAME_INIT = 1 / 60;              // s, frame time assumed before one is measured
const SEGMENT_SAG_MAX = 0.1;            // cells: a traced chord strays at most this far from the arc (g·T²/8)
const TRACE_RGBA = 4;
const MAX_FLIGHT = 30;                 // seconds: even a stalled GPU readback cannot keep a projectile forever
const MAX_ROUND_FLIGHT = 2;            // a bullet crosses the active grid in a fraction of a second

const KIND = ELEMENTS.map((e) => e.kind);
const HARD = ELEMENTS.map((e) => e.hard);
const BREAKS = ELEMENTS.map((e) => !!e.breakInto);
const NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];   // face code → outward normal (−step)
let nextId = 1; // round events share one bus across player and NPC ballistic instances

export function createBallistics() {
  const rounds = [];                     // in flight, oldest first
  // grid cells the window has moved over the world in all (docs/scaling.md
  // D11): a trace answers in the grid it was asked in, this much back
  const shifted = new THREE.Vector3();
  // readback latency in frames (what matters is how far a round flies before
  // an answer lands), and the last frame's length
  let latency = LATENCY_INIT, frameTime = FRAME_INIT, frameNo = 0;
  let simId = -1, tracing = 0;   // the world the rounds fly in; traces awaiting their answer
  const starts = [...Array(TRACE.ROUNDS)].map(() => [0, 0, 0, 0]);
  const ends = [...Array(TRACE.ROUNDS)].map(() => [0, 0, 0, 0]);

  // A new world: rounds of a replaced one are gone with it.
  function ensureWorld(sim) {
    if (sim.id === simId) return;
    simId = sim.id;
    while (rounds.length) end(rounds[0]);
  }

  // position and velocity of round r at flight time t
  const posAt = (r, t, out = new THREE.Vector3()) =>
    out.copy(r.p0).addScaledVector(r.v0, t).addScaledVector(r.g, 0.5 * t * t);
  const velAt = (r, t, out = new THREE.Vector3()) => out.copy(r.v0).addScaledVector(r.g, t);

  function end(r) {
    const i = rounds.indexOf(r);
    if (i >= 0) rounds.splice(i, 1);
    r.alive = false;
    povEvents.emit('round:end', { id: r.id, kind: r.kind });
  }

  // origin, dir: grid cells and unit heading. gravityScale: sim.gravity / default.
  // opts: speed (cells/s, default the round's), carry (cells/s added: the
  // thrower's own velocity), kind (named in the events; 'round' draws a
  // tracer), energy and depth (the strike's, see strikeFrag), damage (health
  // taken from a body it hits), onStrike({ sim, hit, dir, normal }) to do
  // something else where it lands, bodies (an onStrike projectile strikes
  // bodies too, hit.id −1 and hit.body the target; otherwise it flies through them).
  // Returns the round's id, or 0 if MAX_ROUNDS are already in flight.
  function fire(origin, dir, gravityScale = 1, {
    speed = ROUND_SPEED, carry = null, kind = 'round', onStrike = null,
    energy = ROUND_ENERGY, depth = ROUND_DEPTH, damage = BODY_ROUND_DAMAGE, bodies = false,
  } = {}) {
    if (rounds.length >= MAX_ROUNDS) return 0;
    const v0 = dir.clone().normalize().multiplyScalar(speed);
    if (carry) v0.add(carry);
    const r = {
      id: nextId++, alive: true, kind, onStrike, bodies: !onStrike || bodies, energy, depth: Math.min(depth, STRIKE.DEPTH_MAX), damage,
      actor: povEvents.actor,   // who fired it (null: the player): its events carry that, and it never hits them
      p0: origin.clone(), v0,
      g: new THREE.Vector3(0, -ROUND_GRAVITY * gravityScale, 0),
      t: 0,              // s of flight so far
      tShown: 0,         // s of flight round:move has shown
      tTraced: 0,        // s of path the traces requested cover
      tClear: 0,         // s of path every trace has come back for: as far as it is shown flying
      pending: [],       // traces in flight over its path, in path order
      hit: null,         // the earliest reported strike
      shown: origin.clone(),   // where round:move last left it
    };
    rounds.push(r);
    return r.id;
  }

  // the longest chord a trace may take: its sagitta g·T²/8 stays under SEGMENT_SAG_MAX
  const chordTime = (r) => (r.g.y < 0 ? Math.sqrt(8 * SEGMENT_SAG_MAX / -r.g.y) : Infinity);

  function inBox(p, g) { return p.x >= 0 && p.y >= 0 && p.z >= 0 && p.x < g.nx && p.y < g.ny && p.z < g.nz; }

  function requestTrace(sim) {
    if (tracing >= TRACE_INFLIGHT) return;
    // its kernel still building (B5: a new grid while in POV): the rounds wait
    // untraced, shown no further than their last clear stretch, until it is
    if (!povGpu(sim).probeReady('povTrace')) return;
    const jobs = [];
    const want = (latency + LOOKAHEAD_FRAMES) * frameTime;
    for (let i = 0; i < TRACE.ROUNDS; i++) starts[i][3] = 0;
    rounds.forEach((r, i) => {
      if (i >= TRACE.ROUNDS || r.hit) return;
      const from = posAt(r, r.tTraced);
      if (!inBox(from, sim.g)) return;   // the rest of its path is outside: nothing to strike
      const tTo = Math.min(r.t + want, r.tTraced + chordTime(r));
      if (tTo <= r.tTraced) return;
      starts[i][0] = from.x; starts[i][1] = from.y; starts[i][2] = from.z; starts[i][3] = TRACE_ROUND;
      const to = posAt(r, tTo);
      ends[i][0] = to.x; ends[i][1] = to.y; ends[i][2] = to.z;
      const job = { r, slot: i, tFrom: r.tTraced, tTo, done: false };
      jobs.push(job);
      r.pending.push(job);
      r.tTraced = tTo;
    });
    if (!jobs.length) return;
    const read = povGpu(sim).probe('povTrace', { starts, ends });   // (built: probeReady above)
    tracing++;
    const f0 = frameNo, mySim = simId, asked = shifted.clone();
    read.then((bytes) => {
      tracing--;
      latency += (frameNo - f0 - latency) * LATENCY_EASE;
      if (mySim !== simId) return;
      const back = asked.sub(shifted);   // its grid → today's
      const buf = new Float32Array(bytes);
      for (const j of jobs) land(j, buf, back);
    }).catch(() => {
      tracing--;
      for (const j of jobs) settle(j);   // lost: its stretch counts as clear rather than stall the round
    });
  }

  // a trace is back: the round's clear path grows over every answer in order
  function settle(job) {
    job.done = true;
    const r = job.r;
    while (r.pending[0]?.done) r.tClear = r.pending.shift().tTo;
  }

  // a trace's answer for one round; back: from the grid it was asked in to today's
  function land(job, buf, back) {
    const { r, slot, tFrom, tTo } = job;
    settle(job);
    if (!r.alive) return;
    const row = (k) => (k * TRACE.ROUNDS + slot) * TRACE_RGBA;
    const a = row(0), b = row(1), c = row(2);
    const face = Math.round(buf[a + 3]);
    if (face === TRACE_MISS) return;
    const tHit = tFrom + (tTo - tFrom) * buf[c + 3];
    if (r.hit && r.hit.t <= tHit) return;
    r.hit = {
      t: tHit,
      cell: new THREE.Vector3(buf[a], buf[a + 1], buf[a + 2]).add(back),
      face,
      prev: buf[b] >= 0 ? new THREE.Vector3(buf[b], buf[b + 1], buf[b + 2]).add(back) : null,
      id: Math.round(buf[b + 3]),
      point: new THREE.Vector3(buf[c], buf[c + 1], buf[c + 2]).add(back),
    };
  }

  // The round strikes: announce it and spend it on the cells (the strike's edit).
  function strike(sim, r) {
    const h = r.hit;
    // (an answer that came late finds the round already past the hit: nothing left to show)
    if (h.t > r.tShown) povEvents.emit('round:move', { id: r.id, kind: r.kind, from: r.shown.clone(), to: h.point.clone() });
    const dir = velAt(r, h.t).normalize();
    const normal = new THREE.Vector3(...NORMALS[h.face]);
    if (r.onStrike) { r.onStrike({ sim, hit: h, dir, normal }); end(r); return; }
    const id = h.id, energy = r.energy;
    const broke = KIND[id] === K.SOLID ? BREAKS[id] && energy >= HARD[id] : null;
    povEvents.emit('impact', { source: 'gun', point: h.point.clone(), normal, id, energy, broke });
    pass(sim, r, h, dir);
    lastImpact = { id: r.id, point: h.point.clone(), normal, hitId: id, cell: h.cell.clone(), prev: h.prev?.clone() ?? null,
      energy, broke, dir: dir.clone(), flight: h.t };
    end(r);
  }

  function pass(sim, r, h, dir) {
    const far = h.point.clone().addScaledVector(dir, r.depth + 1);
    const lo = h.point.clone().min(far).floor().subScalar(1), hi = h.point.clone().max(far).floor().addScalar(1);
    // a two-phase edit over the walk's box (it changes nothing outside it)
    povGpu(sim).edit('povStrike', sim.touch(lo.toArray(), hi.toArray()), { entry: h.point, dir, energy: r.energy, depth: r.depth, lo, hi });
  }

  // one round's frame: strike, or fly on (and hit a body on the way)
  function fly(sim, r) {
    r.t += frameTime;
    if (r.t >= (r.kind === 'round' ? MAX_ROUND_FLIGHT : MAX_FLIGHT)) { end(r); return; }
    const striking = r.hit && r.t >= r.hit.t && r.tClear >= r.hit.t;
    // shown only as far as the traces have cleared: a round never flies through what it hit
    const tAt = striking ? r.hit.t : Math.min(r.t, r.tClear, r.hit ? r.hit.t : Infinity);
    const at = striking ? r.hit.point : posAt(r, tAt);
    // a body (the player, an NPC) on this frame's stretch of the path takes the round before the cells do
    const body = r.bodies ? segmentTarget(r.shown, at, r.actor?.id ?? PLAYER) : null;
    // it strikes once it has flown that far and every stretch before the hit is back clear
    if (striking && !body) { strike(sim, r); return; }
    if (body) {
      povEvents.emit('round:move', { id: r.id, kind: r.kind, from: r.shown.clone(), to: body.point.clone() });
      const dir = velAt(r, tAt).normalize();
      if (r.onStrike) {
        r.onStrike({ sim, hit: { point: body.point.clone(), id: -1, body: body.target }, dir, normal: dir.clone().negate() });
        end(r);
        return;
      }
      body.target.hurt(r.damage * dealtScale(r.actor?.id), 'Shot', dir);   // × the shooter's Berserk
      povEvents.emit('impact', { source: 'gun', point: body.point, normal: dir.clone().negate(), id: -1, energy: BODY_ROUND_ENERGY, broke: null, body: true });
      end(r);
      return;
    }
    povEvents.emit('round:move', { id: r.id, kind: r.kind, from: r.shown.clone(), to: at.clone() });
    r.shown.copy(at); r.tShown = tAt;
    // out of the box, with every trace of its path back and clear
    if (!r.hit && !inBox(at, sim.g) && !r.pending.length
      && (r.tTraced >= r.t || !inBox(posAt(r, r.tTraced), sim.g))) end(r);
  }

  let lastImpact = null;

  return {
    fire,
    prepare(sim) { if (sim) ensureWorld(sim); },   // (the kernels build on entering POV: src/pov/gpu.js prepare)
    // ctx: { sim, dt, stepsPerFrame } (see docs/pov.md); stepsPerFrame 0 = paused
    update({ sim, dt, stepsPerFrame }) {
      ensureWorld(sim);
      frameNo++;
      const t = projectileSeconds(sim, dt, stepsPerFrame);   // (V2: the ticks this frame ran)
      if (!rounds.length || stepsPerFrame === 0 || !(t > 0)) return;
      // the POV kernels still building (B5: a new grid while in POV): the rounds hold where they
      // are, as when paused, rather than strike or burst with no edit to do it
      if (!povGpu(sim).ready) return;
      frameTime = t;
      // each round's events are its shooter's (an NPC's carry by, events.js)
      for (const r of [...rounds]) povEvents.as(r.actor, () => fly(sim, r));
      if (rounds.length) requestTrace(sim);
    },
    // The window moved over the world by (dx, 0, dz) cells (docs/scaling.md
    // D11): the rounds keep flying where they are in the world.
    windowShifted(dx, dz) {
      shifted.x += dx;
      shifted.z += dz;
      const back = (v) => { if (v) { v.x -= dx; v.z -= dz; } };
      for (const r of rounds) {
        back(r.p0);
        back(r.shown);
        if (r.hit) { back(r.hit.cell); back(r.hit.prev); back(r.hit.point); }
      }
      if (lastImpact) { back(lastImpact.point); back(lastImpact.cell); back(lastImpact.prev); }
    },
    get count() { return rounds.length; },
    get rounds() { return rounds; },
    get lastImpact() { return lastImpact; },   // for checks
    get latency() { return latency; },         // frames a trace readback takes (running estimate)
    clear() { while (rounds.length) end(rounds[0]); },
    // take round `id` out of the air now (a frag whose fuse ran out mid-flight: frag.js); its round:end follows
    cancel(id) { const r = rounds.find((x) => x.id === id); if (r) end(r); },
    dispose() {
      while (rounds.length) end(rounds[0]);
      simId = -1;
    },
  };
}
