import * as THREE from 'three';
import { quadVert } from '../shaders/common.js';
import { traceFrag, handoffFrag, TRACE, TRACE_MISS, TRACE_FACE_FLOOR } from '../shaders/povTrace.js';
import { ELEMENTS, E, K } from '../elements.js';
import { PHYS as ENGINE } from '../physics.js';
import { CELL_METERS } from './vitals.js';
import { povEvents } from './events.js';

// Ballistic rounds: the gun's shots fly outside the sim, with real ballistics,
// and become sim matter only where they strike.
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
//   2. Trace. One small GPU pass (shaders/povTrace.js traceFrag) marches each
//      round's path a little ahead of it, LOOKAHEAD frames past the readback
//      latency, through the grid and reports the first liquid, powder or solid
//      on it. Several readbacks stay in flight, like the player's probe, so an
//      answer lands every frame. The world keeps moving for the frame or two
//      an answer takes; that's the price of not stalling the GPU.
//   3. Impact. When a round reaches a reported hit it hands off: handoffFrag
//      writes one SCRAP cell into the air just in front of the struck face, at
//      the fastest velocity along the round's heading the sim can hold, and the
//      engine's impact rules (react.js, move.js) do the rest: glass shatters,
//      metal holds, a keg's wood breaks into hot sawdust and the powder goes
//      off, water slows it down.
//      The sim caps that slug's energy along any axis, which is what the
//      impact rules test, at ½·DENS[SCRAP]·V_MAX² = ½·78·1² = 39 (ROUND.ENERGY):
//      a real 360 m/s round carries far more. That is deliberate. It is the
//      honest limit of the sim, not a fake: the energy a cell can carry is all
//      the engine can break things with.
//      A round that runs out through the sides or top of the box is gone.
//
// Units: grid cells, seconds, cells/s (cells/step for the sim's velocities).
//
// Events (docs/pov.md): round:move every frame per round, round:end, impact.

const G_EARTH = 9.8;                    // m/s²
const MUZZLE_SPEED_MS = 360;            // m/s, a subsonic pistol round
const SIM_GRAVITY_REF = 0.025;          // cells/step², the sim's default gravity (sim.js GRAVITY_DEFAULT)
export const ROUND_SPEED = MUZZLE_SPEED_MS / CELL_METERS;   // cells/s (1200)
export const ROUND_GRAVITY = G_EARTH / CELL_METERS;        // cells/s² (≈ 33) at the default sim gravity; the setting scales it
export const ROUND_SLUG = E.SCRAP;                         // what a round becomes at impact
// ½·DENS·V_MAX²: the most kinetic energy the slug carries along one axis in the sim
export const ROUND_ENERGY = 0.5 * ELEMENTS[ROUND_SLUG].dens * ENGINE.V_MAX * ENGINE.V_MAX;
export const MAX_ROUNDS = TRACE.ROUNDS;                    // rounds the trace pass can follow at once

const TRACE_INFLIGHT = 3;               // trace readbacks in flight at once
const LATENCY_INIT = 0.05;              // s, readback latency assumed before the first one lands
const LATENCY_EASE = 0.2;               // share of each new latency sample in the running estimate
const LOOKAHEAD_FRAMES = 2;             // frames of flight traced beyond the latency
const FRAME_INIT = 1 / 60;              // s, frame time assumed before one is measured
const SEGMENT_SAG_MAX = 0.1;            // cells: a traced chord strays at most this far from the arc (g·T²/8)
const TRACE_RGBA = 4;
const OFF = -1;                         // texel slot of a round not traced this pass

const KIND = ELEMENTS.map((e) => e.kind);
const HARD = ELEMENTS.map((e) => e.hard);
const BREAKS = ELEMENTS.map((e) => !!e.breakInto);
const NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];   // face code → outward normal (−step)

function rawMat(frag, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader: frag, uniforms,
    depthTest: false, depthWrite: false,
  });
}

// The fastest velocity along unit heading d the sim can hold: the engine caps
// each component at V_MAX (react.js clamps per axis), so the largest one is
// set to V_MAX. Along the main axis, which a face struck head on lies across,
// the slug then carries ROUND_ENERGY.
export function slugVelocity(d, out = new THREE.Vector3()) {
  const m = Math.max(Math.abs(d.x), Math.abs(d.y), Math.abs(d.z));
  return out.copy(d).multiplyScalar(m > 0 ? ENGINE.V_MAX / m : 0);
}

export function createBallistics({ renderer }) {
  const rounds = [];                     // in flight, oldest first
  let nextId = 1;
  let latency = LATENCY_INIT, frameTime = FRAME_INIT;
  let mats = null, simId = -1;

  const slots = [...Array(TRACE_INFLIGHT)].map(() => ({
    target: new THREE.WebGLRenderTarget(TRACE.ROUNDS, TRACE.ROWS, {
      type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    }),
    buf: new Float32Array(TRACE.ROUNDS * TRACE.ROWS * TRACE_RGBA), busy: false,
  }));

  function ensureMats(sim) {
    if (sim.id === simId) return;
    mats?.trace.dispose(); mats?.handoff.dispose();
    const from = [...Array(TRACE.ROUNDS)].map(() => new THREE.Vector4());
    const to = [...Array(TRACE.ROUNDS)].map(() => new THREE.Vector3());
    mats = {
      trace: rawMat(traceFrag(sim.g), {
        tA: { value: null }, tB: { value: null }, tBrick: { value: null }, tBrickDist: { value: null }, tLight: { value: null },
        uFrom: { value: from }, uTo: { value: to },
      }),
      handoff: rawMat(handoffFrag(sim.g), {
        tA: { value: null }, tB: { value: null },
        uEntry: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() },
        uReach: { value: 0 }, uLo: { value: new THREE.Vector3() }, uHi: { value: new THREE.Vector3() },
      }),
    };
    simId = sim.id;
    // rounds of a replaced world are gone with it
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
    povEvents.emit('round:end', { id: r.id });
  }

  // origin, dir: grid cells and unit heading. gravityScale: sim.gravity / default.
  // Returns the round's id, or 0 if MAX_ROUNDS are already in flight.
  function fire(origin, dir, gravityScale = 1) {
    if (rounds.length >= MAX_ROUNDS) return 0;
    const r = {
      id: nextId++, alive: true,
      p0: origin.clone(), v0: dir.clone().normalize().multiplyScalar(ROUND_SPEED),
      g: new THREE.Vector3(0, -ROUND_GRAVITY * gravityScale, 0),
      t: 0,              // s of flight so far
      tTraced: 0,        // s of path the traces requested cover
      pending: [],       // start times of traces in flight over this round's path
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
    const slot = slots.find((s) => !s.busy);
    if (!slot) return;
    const u = mats.trace.uniforms;
    const jobs = [];
    const want = latency + LOOKAHEAD_FRAMES * frameTime;
    for (let i = 0; i < TRACE.ROUNDS; i++) u.uFrom.value[i].w = 0;
    rounds.forEach((r, i) => {
      if (i >= TRACE.ROUNDS || r.hit) return;
      const from = posAt(r, r.tTraced);
      if (!inBox(from, sim.g)) return;   // the rest of its path is outside: nothing to strike
      const tTo = Math.min(r.t + want, r.tTraced + chordTime(r));
      if (tTo <= r.tTraced) return;
      u.uFrom.value[i].set(from.x, from.y, from.z, 1);
      posAt(r, tTo, u.uTo.value[i]);
      jobs.push({ r, slot: i, tFrom: r.tTraced, tTo });
      r.pending.push(r.tTraced);
      r.tTraced = tTo;
    });
    if (!jobs.length) return;
    u.tA.value = sim.stateA;
    u.tB.value = sim.stateB;
    u.tBrick.value = sim.brick.texture;
    u.tBrickDist.value = sim.brickDistTexture;
    sim.run(mats.trace, slot.target);
    slot.busy = true;
    const t0 = performance.now(), mySim = simId;
    renderer.readRenderTargetPixelsAsync(slot.target, 0, 0, TRACE.ROUNDS, TRACE.ROWS, slot.buf).then(() => {
      slot.busy = false;
      latency += ((performance.now() - t0) / 1000 - latency) * LATENCY_EASE;
      if (mySim !== simId) return;
      for (const j of jobs) land(j, slot.buf);
    }).catch(() => {
      slot.busy = false;
      for (const j of jobs) j.r.pending.splice(j.r.pending.indexOf(j.tFrom), 1);
    });
  }

  // a trace's answer for one round
  function land({ r, slot, tFrom, tTo }, buf) {
    r.pending.splice(r.pending.indexOf(tFrom), 1);
    if (!r.alive) return;
    const row = (k) => (k * TRACE.ROUNDS + slot) * TRACE_RGBA;
    const a = row(0), b = row(1), c = row(2);
    const face = Math.round(buf[a + 3]);
    if (face === TRACE_MISS) return;
    const tHit = tFrom + (tTo - tFrom) * buf[c + 3];
    if (r.hit && r.hit.t <= tHit) return;
    r.hit = {
      t: tHit,
      cell: new THREE.Vector3(buf[a], buf[a + 1], buf[a + 2]),
      face,
      prev: buf[b] >= 0 ? new THREE.Vector3(buf[b], buf[b + 1], buf[b + 2]) : null,
      id: Math.round(buf[b + 3]),
      point: new THREE.Vector3(buf[c], buf[c + 1], buf[c + 2]),
    };
  }

  // The round strikes: announce it and hand it to the sim.
  function strike(sim, r) {
    const h = r.hit;
    povEvents.emit('round:move', { id: r.id, from: r.shown.clone(), to: h.point.clone() });
    const dir = velAt(r, h.t).normalize();
    const vel = slugVelocity(dir);
    const normal = new THREE.Vector3(...NORMALS[h.face]);
    // what the engine will test: ½·DENS·vn², vn the slug's speed into the face
    const vn = Math.abs(vel.dot(normal));
    const energy = 0.5 * ELEMENTS[ROUND_SLUG].dens * vn * vn;
    const id = h.id;
    const broke = KIND[id] === K.SOLID ? BREAKS[id] && energy >= HARD[id] : null;
    povEvents.emit('impact', { source: 'gun', point: h.point.clone(), normal, id, energy, broke });
    handoff(sim, r, h, dir, vel);
    lastImpact = { id: r.id, point: h.point.clone(), normal, hitId: id, cell: h.cell.clone(), prev: h.prev?.clone() ?? null,
      energy, broke, vel: vel.clone(), flight: h.t };
    end(r);
  }

  function handoff(sim, r, h, dir, vel) {
    // never walk back past the muzzle: the cells behind it are the shooter's
    const reach = h.point.distanceTo(r.p0);
    const u = mats.handoff.uniforms;
    u.uEntry.value.copy(h.point);
    u.uDir.value.copy(dir);
    u.uVel.value.copy(vel);
    u.uReach.value = reach;
    const back = h.point.clone().addScaledVector(dir, -Math.min(reach, TRACE.HANDOFF_WALK + 1));
    u.uLo.value.copy(h.point).min(back).floor().subScalar(1);
    u.uHi.value.copy(h.point).max(back).floor().addScalar(1);
    sim.pass(mats.handoff);
  }

  let lastImpact = null;

  return {
    fire,
    // ctx: { sim, dt, stepsPerFrame } (see docs/pov.md); stepsPerFrame 0 = paused
    update({ sim, dt, stepsPerFrame }) {
      ensureMats(sim);
      if (!rounds.length || stepsPerFrame === 0 || !(dt > 0)) return;
      frameTime = dt;
      for (const r of [...rounds]) {
        r.t += dt;
        if (r.hit && r.t >= r.hit.t && !r.pending.some((t0) => t0 < r.hit.t)) { strike(sim, r); continue; }
        const at = posAt(r, r.hit ? Math.min(r.t, r.hit.t) : r.t);
        povEvents.emit('round:move', { id: r.id, from: r.shown.clone(), to: at.clone() });
        r.shown.copy(at);
        // out of the box, with every trace of its path back and clear
        if (!r.hit && !inBox(at, sim.g) && !r.pending.length
          && (r.tTraced >= r.t || !inBox(posAt(r, r.tTraced), sim.g))) end(r);
      }
      if (rounds.length) requestTrace(sim);
    },
    get count() { return rounds.length; },
    get rounds() { return rounds; },
    get lastImpact() { return lastImpact; },   // for checks
    clear() { while (rounds.length) end(rounds[0]); },
    dispose() {
      while (rounds.length) end(rounds[0]);
      slots.forEach((s) => s.target.dispose());
      mats?.trace.dispose(); mats?.handoff.dispose();
      mats = null; simId = -1;
    },
  };
}
