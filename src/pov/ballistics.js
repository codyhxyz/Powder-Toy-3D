import * as THREE from 'three';
import { quadVert, stateUniforms } from '../shaders/common.js';
import { traceFrag, strikeFrag, TRACE, TRACE_MISS, STRIKE } from '../shaders/povTrace.js';
import { ELEMENTS, K } from '../elements.js';
import { CELL_METERS } from './vitals.js';
import { povEvents } from './events.js';
import { segmentTarget, PLAYER } from './targets.js';

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
//   2. Trace. One small GPU pass (shaders/povTrace.js traceFrag) marches each
//      round's path a little ahead of it, LOOKAHEAD frames past the readback
//      latency, through the grid and reports the first liquid, powder or solid
//      on it. Several readbacks stay in flight, like the player's probe, so an
//      answer lands every frame. The world keeps moving for the frame or two
//      an answer takes; that's the price of not stalling the GPU.
//   3. Impact. When a round reaches a reported hit, strikeFrag spends the
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

export function createBallistics({ renderer }) {
  const rounds = [];                     // in flight, oldest first
  let nextId = 1;
  // grid cells the window has moved over the world in all (docs/scaling.md
  // D11): a trace answers in the grid it was asked in, this much back
  const shifted = new THREE.Vector3();
  // readback latency in frames (what matters is how far a round flies before
  // an answer lands), and the last frame's length
  let latency = LATENCY_INIT, frameTime = FRAME_INIT, frameNo = 0;
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
    mats?.trace.dispose(); mats?.strike.dispose();
    const from = [...Array(TRACE.ROUNDS)].map(() => new THREE.Vector4());
    const to = [...Array(TRACE.ROUNDS)].map(() => new THREE.Vector3());
    mats = {
      trace: rawMat(traceFrag(sim.g), {
        tA: { value: null }, tB: { value: null }, tBrick: { value: null }, tBrickDist: { value: null }, tLight: { value: null },
        uFrom: { value: from }, uTo: { value: to },
      }),
      strike: rawMat(strikeFrag(sim.g), {
        ...stateUniforms(),
        uEntry: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() },
        uEnergy: { value: 0 }, uDepth: { value: 0 }, uLo: { value: new THREE.Vector3() }, uHi: { value: new THREE.Vector3() },
      }),
    };
    simId = sim.id;
    // rounds of a replaced world are gone with it
    while (rounds.length) end(rounds[0]);
    // compile in the background (KHR_parallel_shader_compile), then draw once
    const built = mats;
    const keep = sim.quad.material;
    Promise.all([mats.trace, mats.strike].map((m) => {
      sim.quad.material = m;
      return renderer.compileAsync(sim.scene, sim.camera);
    })).then(() => { if (mats === built && sim.id === simId) warm(sim); }).catch(() => {});
    sim.quad.material = keep;
  }

  // Draw both passes once, doing nothing, so the pipelines a first draw builds
  // (on Metal) are ready before the first shot rather than stalling it: an
  // idle trace into a trace target, and a strike with an empty walk box into
  // a one-texel target shaped like the state.
  function warm(sim) {
    const tu = mats.trace.uniforms;
    tu.uFrom.value.forEach((v) => { v.w = 0; });
    tu.tA.value = sim.stateA; tu.tB.value = sim.stateB;
    tu.tBrick.value = sim.brick.texture; tu.tBrickDist.value = sim.brickDistTexture;
    sim.run(mats.trace, slots[0].target);
    const scratch = sim.makeStateTarget(1, 1);
    const hu = mats.strike.uniforms;
    hu.tA.value = sim.stateA; hu.tB.value = sim.stateB; hu.tF.value = sim.stateF;
    hu.uLo.value.setScalar(Infinity); hu.uHi.value.setScalar(-Infinity);
    sim.run(mats.strike, scratch);
    scratch.dispose();
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
    const slot = slots.find((s) => !s.busy);
    if (!slot) return;
    const u = mats.trace.uniforms;
    const jobs = [];
    const want = (latency + LOOKAHEAD_FRAMES) * frameTime;
    for (let i = 0; i < TRACE.ROUNDS; i++) u.uFrom.value[i].w = 0;
    rounds.forEach((r, i) => {
      if (i >= TRACE.ROUNDS || r.hit) return;
      const from = posAt(r, r.tTraced);
      if (!inBox(from, sim.g)) return;   // the rest of its path is outside: nothing to strike
      const tTo = Math.min(r.t + want, r.tTraced + chordTime(r));
      if (tTo <= r.tTraced) return;
      u.uFrom.value[i].set(from.x, from.y, from.z, 1);
      posAt(r, tTo, u.uTo.value[i]);
      const job = { r, slot: i, tFrom: r.tTraced, tTo, done: false };
      jobs.push(job);
      r.pending.push(job);
      r.tTraced = tTo;
    });
    if (!jobs.length) return;
    u.tA.value = sim.stateA;
    u.tB.value = sim.stateB;
    u.tBrick.value = sim.brick.texture;
    u.tBrickDist.value = sim.brickDistTexture;
    sim.run(mats.trace, slot.target);
    slot.busy = true;
    const f0 = frameNo, mySim = simId, asked = shifted.clone();
    renderer.readRenderTargetPixelsAsync(slot.target, 0, 0, TRACE.ROUNDS, TRACE.ROWS, slot.buf).then(() => {
      slot.busy = false;
      latency += (frameNo - f0 - latency) * LATENCY_EASE;
      if (mySim !== simId) return;
      const back = asked.sub(shifted);   // its grid → today's
      for (const j of jobs) land(j, slot.buf, back);
    }).catch(() => {
      slot.busy = false;
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

  // The round strikes: announce it and spend it on the cells (strikeFrag).
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
    const u = mats.strike.uniforms;
    u.uEntry.value.copy(h.point);
    u.uDir.value.copy(dir);
    u.uEnergy.value = r.energy;
    u.uDepth.value = r.depth;
    const far = h.point.clone().addScaledVector(dir, r.depth + 1);
    u.uLo.value.copy(h.point).min(far).floor().subScalar(1);
    u.uHi.value.copy(h.point).max(far).floor().addScalar(1);
    sim.pass(mats.strike);
  }

  // one round's frame: strike, or fly on (and hit a body on the way)
  function fly(sim, r) {
    r.t += frameTime;
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
      body.target.hurt(r.damage, 'Shot', dir);
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
    prepare(sim) { if (sim) ensureMats(sim); },   // build the passes ahead of the first shot
    // ctx: { sim, dt, stepsPerFrame } (see docs/pov.md); stepsPerFrame 0 = paused
    update({ sim, dt, stepsPerFrame }) {
      ensureMats(sim);
      frameNo++;
      if (!rounds.length || stepsPerFrame === 0 || !(dt > 0)) return;
      frameTime = dt;
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
    dispose() {
      while (rounds.length) end(rounds[0]);
      slots.forEach((s) => s.target.dispose());
      mats?.trace.dispose(); mats?.strike.dispose();
      mats = null; simId = -1;
    },
  };
}
