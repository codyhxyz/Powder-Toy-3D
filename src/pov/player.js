import * as THREE from 'three';
import { ELEMENTS, E, K } from '../elements.js';
import { PHYS } from '../physics.js';
import { quadVert } from '../shaders/common.js';
import { povProbeFrag, povCouplingFrag, PROBE, PROBE_OUTSIDE } from '../shaders/povBody.js';
import { BODY_HEIGHT, BODY_WIDTH, EYE_HEIGHT, BODY_DENS } from './constants.js';
import { createVitals, CELL_METERS, SAFE_FALL_M, LETHAL_FALL_M } from './vitals.js';

// The first-person body: an upright AABB (BODY_WIDTH × BODY_HEIGHT × BODY_WIDTH
// cells) moving through the voxel grid in real time.
//
// Every frame a small GPU pass (shaders/povBody.js) copies the cells around the
// body into a PROBE-sized target that is read back asynchronously, so the body
// always sees the world a frame or two late. From those cells it collides
// (solids and powders block, with an automatic step up 1-cell ledges), floats
// by Archimedes, feels drag in liquids the way move.js does, gets thrown by
// pressure gradients with the sim's own a = −∇P·P_ACCEL/ρ, and hands what it
// touches to vitals.js. A second pass pushes loose matter out of the body's way.
//
// Units: positions in grid cells (feet = bottom centre of the box), velocities
// in cells/s, time in s. The sim runs on its own, much faster clock: about 240
// steps/s, with V_MAX = 1 cell/step (240 cells/s) and gravity 0.025 cells/step²
// (≈ 1440 cells/s², 44× this body's). Where the body meets the sim (pressure,
// the coupling pass) it converts with the measured step rate.

// ---- body ----
const HW = BODY_WIDTH / 2;             // cells, half the footprint
const H = BODY_HEIGHT;
const EPS = 1e-4;                      // cells: faces this close to a cell boundary don't overlap it

// ---- gravity and moving ----
const G_EARTH = 9.8;                   // m/s²
const GRAVITY_FEEL = 1.3;              // × real gravity: a touch snappier than life, so jumps don't float
const GRAVITY = G_EARTH * GRAVITY_FEEL / CELL_METERS;   // cells/s² (≈ 42) at the default sim gravity...
const SIM_GRAVITY_REF = 0.025;         // ...which is this many cells/step² (sim.js GRAVITY_DEFAULT); the setting scales it
const WALK_SPEED = 1.5 / CELL_METERS;  // cells/s (1.5 m/s)
const SPRINT_SPEED = 4.5 / CELL_METERS; // cells/s (4.5 m/s)
const GROUND_ACCEL = 80;               // cells/s², speeding up and braking on the ground
const AIR_ACCEL = 12;                  // cells/s², steering in the air
const JUMP_HEIGHT = 1.6;               // cells (≈ 0.5 m) at the default gravity
const JUMP_SPEED = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);   // cells/s
const STEP_HEIGHT = 1.1;               // cells: ledges up to this are stepped onto (1 cell + slack)
const STEP_DOWN = 1.1;                 // cells: walking off a ledge this low follows the ground down
const MAX_SPEED = 90;                  // cells/s (27 m/s): faster than any fall the grid allows
const SUBSTEP = 0.4;                   // cells: longest move per collision substep
const MAX_DT = 0.1;                    // s: longer frames are simulated as this long

// ---- liquids ----
const WADE_SHARE = 0.15;               // submerged share of the body that counts as "in" liquid
const SWIM_SHARE = 0.5;                // submerged share from which you swim rather than walk
const LIQUID_DRAG = 4;                 // 1/s damping when fully submerged, × (1 − move.js dragF)
const SWIM_SPEED = 3;                  // cells/s, horizontal swimming
const SWIM_ACCEL = 15;                 // cells/s²
const SWIM_UP = 0.35;                  // × GRAVITY, thrust of swimming up (jump)...
const SWIM_DOWN = 0.35;                // ...and down (down)
const HEAD_LIQUID_SHARE = 0.5;         // liquid share around the eye that puts the head under
const BURY_SHARE = 0.6;                // share of the head's cells holding powder or solid that buries it

// ---- pressure ----
const RHO_BODY = Math.max(BODY_DENS * PHYS.RHO_SCALE, PHYS.RHO_MIN);   // the sim's inertia for the body's density
const PRESSURE_MAX_SPEED = 60;         // cells/s (18 m/s): a blast throws you this fast at most

// ---- body → sim coupling (shaders/povBody.js) ----
const DISPLACE_PUSH_FLUID = 0.5;       // cells/step outward on liquids and gases in the body, at full speed...
const DISPLACE_FULL_SPEED = 6;         // ...reached at this body speed (cells/s); a body standing still is porous to liquid
const DISPLACE_PUSH_POWDER = 0.3;      // cells/step outward on grains in the body, always (a leg and a grain can't share a cell)
const DISPLACE_LIFT = 1;               // upward share of the push per unit of downward heading (a body landing in water throws it up)

// ---- probe ----
const LATENCY_INIT = 0.05;             // s, readback latency assumed before the first one lands
const LATENCY_EASE = 0.2;              // share of each new latency sample in the running estimate
const DT_EASE = 0.1;                   // share of each frame in the smoothed frame time (step rate)
const CONTACT_REACH = 0.5;             // cells beyond the body's faces that count as touching it
const UNKNOWN = -2;                    // id of a cell outside the probed box

// ---- events ----
const LAND_EVENT_SPEED = 3;            // cells/s: softer touchdowns aren't reported as 'land'

const KIND = ELEMENTS.map((e) => e.kind);
const DENS = ELEMENTS.map((e) => e.dens);
const fallSpeed = (m) => Math.sqrt(2 * GRAVITY * m / CELL_METERS);   // cells/s after falling m metres
const SAFE_IMPACT = fallSpeed(SAFE_FALL_M);
const LETHAL_IMPACT = fallSpeed(LETHAL_FALL_M);

// move.js dragF: moving through a liquid is slower the closer the densities are.
function dragF(dBody, dLiquid) {
  return PHYS.DRAG_LIQUID_MIN + PHYS.DRAG_LIQUID_SPAN
    * Math.min(1, Math.max(0, PHYS.DRAG_LIQUID_DENS * Math.abs(dBody - dLiquid) / Math.max(dBody, dLiquid)));
}

const solidId = (id) => id === PROBE_OUTSIDE || id === UNKNOWN || (id >= 0 && KIND[id] === K.SOLID);
const blocks = (id) => solidId(id) || (id >= 0 && KIND[id] === K.POWDER);
const isLiquid = (id) => id >= 0 && KIND[id] === K.LIQUID;

function rawMat(frag, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader: frag, uniforms,
    depthTest: false, depthWrite: false,
  });
}

export function createPlayer({ renderer, getSim }) {
  const listeners = {};
  const emit = (name, data) => (listeners[name] || []).forEach((fn) => fn(data));
  const vitals = createVitals(emit);

  const PN = PROBE.X * PROBE.Y * PROBE.Z;
  const target = new THREE.WebGLRenderTarget(PROBE.X, PROBE.Y * PROBE.Z, {
    type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  // the probe being read into, and the last one that landed
  let readBuf = new Float32Array(PN * 4);
  let probe = { buf: new Float32Array(PN * 4), origin: [0, 0, 0], valid: false };
  let pending = false, generation = 0;
  let latency = LATENCY_INIT;

  let mats = null, matKey = '';
  let lastSim = null, lastFrame = 0, dtSmooth = 1 / 60;

  const contactId = new Int32Array(PN), contactT = new Float32Array(PN);
  const env = { contactId, contactT, contactN: 0, headInLiquid: false, liquidId: E.WATER, buriedId: -1, pressure: 0 };

  const p = {
    pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    onGround: false, inLiquid: false, headInLiquid: false, liquidId: -1,
    submerged: 0,                 // share of the body under liquid, 0..1
    get health() { return vitals.health; },
    get breath() { return vitals.breath; },
    get feel() { return vitals.feel; },
    get dead() { return vitals.dead; },
    get cause() { return vitals.cause; },
    get skinT() { return vitals.skinT; },
    stepRate: 0,                  // sim steps/s, as measured
  };
  let apexY = 0;
  const impulse = new THREE.Vector3();

  // ---------------------------------------------------------------- probe
  function ensureMats(sim) {
    const g = sim.g;
    const key = `${g.nx}x${g.ny}x${g.nz}`;
    if (key === matKey) return;
    mats?.probe.dispose();
    mats?.couple.dispose();
    mats = {
      probe: rawMat(povProbeFrag(g), { tA: { value: null }, tB: { value: null }, uOrigin: { value: new THREE.Vector3() } }),
      couple: rawMat(povCouplingFrag(g), {
        tA: { value: null }, tB: { value: null }, uFrame: { value: 0 },
        uMin: { value: new THREE.Vector3() }, uMax: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() },
        uPushFluid: { value: 0 }, uPushPowder: { value: 0 }, uLift: { value: 0 },
      }),
    };
    matKey = key;
  }

  function requestProbe(sim) {
    if (pending) return;
    // centre the box where the body will be when the result lands
    const cx = p.pos.x + p.vel.x * latency, cy = p.pos.y + p.vel.y * latency, cz = p.pos.z + p.vel.z * latency;
    const origin = [Math.round(cx) - PROBE.X / 2, Math.floor(cy) - 2, Math.round(cz) - PROBE.Z / 2];
    const u = mats.probe.uniforms;
    u.tA.value = sim.stateA;
    u.tB.value = sim.stateB;
    u.uOrigin.value.set(...origin);
    sim.run(mats.probe, target);
    pending = true;
    const gen = generation, t0 = performance.now();
    renderer.readRenderTargetPixelsAsync(target, 0, 0, PROBE.X, PROBE.Y * PROBE.Z, readBuf).then(() => {
      pending = false;
      if (gen !== generation) return;
      latency += ((performance.now() - t0) / 1000 - latency) * LATENCY_EASE;
      const old = probe.buf;
      probe = { buf: readBuf, origin, valid: true };
      readBuf = old;
    }).catch(() => { pending = false; });
  }

  let g = null;   // grid layout of the current sim
  function local(x, y, z) {
    const o = probe.origin;
    const lx = x - o[0], ly = y - o[1], lz = z - o[2];
    if (lx < 0 || ly < 0 || lz < 0 || lx >= PROBE.X || ly >= PROBE.Y || lz >= PROBE.Z) return -1;
    return ((ly * PROBE.Z + lz) * PROBE.X + lx) * 4;
  }
  function idAt(x, y, z) {
    if (y < 0 || x < 0 || z < 0 || x >= g.nx || z >= g.nz) return PROBE_OUTSIDE;   // floor and box walls
    if (y >= g.ny) return E.EMPTY;                                                 // open above the box
    const i = local(x, y, z);
    return i < 0 ? UNKNOWN : Math.round(probe.buf[i]);
  }
  const field = (x, y, z, c, dflt) => { const i = local(x, y, z); return i < 0 ? dflt : probe.buf[i + c]; };
  const tAt = (x, y, z) => field(x, y, z, 1, PHYS.AMBIENT);
  const pAt = (x, y, z) => field(x, y, z, 2, 0);

  // Cell index range a span [lo, hi] overlaps.
  const c0 = (lo) => Math.floor(lo + EPS);
  const c1 = (hi) => Math.ceil(hi - EPS) - 1;

  // Is the body's box (and a cell around it) inside the probed box?
  function covered() {
    if (!probe.valid) return false;
    const o = probe.origin;
    return c0(p.pos.x - HW) - 1 >= o[0] && c1(p.pos.x + HW) + 1 < o[0] + PROBE.X
      && c0(p.pos.z - HW) - 1 >= o[2] && c1(p.pos.z + HW) + 1 < o[2] + PROBE.Z
      && c0(p.pos.y) - 1 >= o[1] && c1(p.pos.y + H) + 1 < o[1] + PROBE.Y;
  }

  // ---------------------------------------------------------------- collision
  const lo = [0, 0, 0], hi = [0, 0, 0];
  function bounds() {
    lo[0] = p.pos.x - HW; hi[0] = p.pos.x + HW;
    lo[1] = p.pos.y; hi[1] = p.pos.y + H;
    lo[2] = p.pos.z - HW; hi[2] = p.pos.z + HW;
  }
  const cell = [0, 0, 0];
  // Is any cell of layer i (along axis) across the body's cross-section blocking?
  function layerHit(axis, i) {
    const u = (axis + 1) % 3, w = (axis + 2) % 3;
    for (let a = c0(lo[u]); a <= c1(hi[u]); a++)
      for (let b = c0(lo[w]); b <= c1(hi[w]); b++) {
        cell[axis] = i; cell[u] = a; cell[w] = b;
        const id = idAt(cell[0], cell[1], cell[2]);
        if (blocks(id)) return id;
      }
    return null;
  }
  // Move along one axis by up to d, stopping at the first blocking layer.
  // Returns the distance moved and what stopped it (null if nothing).
  const hit = { d: 0, id: null };
  function sweep(axis, d) {
    bounds();
    hit.d = d; hit.id = null;
    if (d > 0) {
      for (let i = Math.ceil(hi[axis] - EPS), last = Math.ceil(hi[axis] + d - EPS) - 1; i <= last; i++) {
        const id = layerHit(axis, i);
        if (id !== null) { hit.d = Math.max(0, i - hi[axis]); hit.id = id; break; }
      }
    } else if (d < 0) {
      for (let i = Math.floor(lo[axis] + EPS) - 1, last = Math.floor(lo[axis] + d + EPS); i >= last; i--) {
        const id = layerHit(axis, i);
        if (id !== null) { hit.d = Math.min(0, i + 1 - lo[axis]); hit.id = id; break; }
      }
    }
    return hit;
  }
  const comp = ['x', 'y', 'z'];

  // A blocked horizontal move: step up onto a ledge up to STEP_HEIGHT high
  // if the body fits there. Returns true if it stepped.
  function tryStep(axis, d) {
    const top = Math.floor(p.pos.y + EPS) + 1;
    const lift = top - p.pos.y;
    if (lift > STEP_HEIGHT) return false;
    if (sweep(1, lift).id !== null) return false;   // no headroom
    const y0 = p.pos.y;
    p.pos.y = top;
    const s = sweep(axis, d);
    if (Math.abs(s.d) < EPS) { p.pos.y = y0; return false; }
    p.pos[comp[axis]] += s.d;
    return true;
  }

  // Powder piling up around the feet (or stale cells) lifts the body out of it,
  // if only the bottom STEP_HEIGHT holds blocking cells and there's headroom.
  function rise() {
    bounds();
    let topBlock = -Infinity;
    for (let y = c0(lo[1]); y <= c1(hi[1]); y++)
      for (let x = c0(lo[0]); x <= c1(hi[0]); x++)
        for (let z = c0(lo[2]); z <= c1(hi[2]); z++) {
          const id = idAt(x, y, z);
          if (id !== UNKNOWN && blocks(id)) topBlock = Math.max(topBlock, y);
        }
    if (topBlock === -Infinity) return;
    const lift = topBlock + 1 - p.pos.y;
    if (lift > STEP_HEIGHT) return;   // buried, not standing in it
    if (sweep(1, lift).id === null) p.pos.y += lift;
  }

  // ---------------------------------------------------------------- environment
  const liqCount = new Float32Array(ELEMENTS.length);
  const env2 = { sub: 0, buoy: 0, densL: 0, gx: 0, gy: 0, gz: 0, pMean: 0, loose: false };
  function sense() {
    bounds();
    const bx0 = c0(lo[0]), bx1 = c1(hi[0]), bz0 = c0(lo[2]), bz1 = c1(hi[2]);
    const by0 = c0(lo[1]), by1 = c1(hi[1]);
    liqCount.fill(0);
    let sub = 0, buoy = 0, densSum = 0, liqN = 0;
    // liquid per layer, over the footprint and a ring around it: the coupling
    // pass pushes liquid out of the body itself, into the ring
    for (let y = by0; y <= by1; y++) {
      const h = Math.min(y + 1, hi[1]) - Math.max(y, lo[1]);
      if (h <= 0) continue;
      let open = 0, liq = 0, dens = 0;
      for (let x = bx0 - 1; x <= bx1 + 1; x++)
        for (let z = bz0 - 1; z <= bz1 + 1; z++) {
          const id = idAt(x, y, z);
          if (solidId(id)) continue;
          open++;
          if (isLiquid(id)) { liq++; dens += DENS[id]; liqCount[id]++; }
        }
      if (!open) continue;
      sub += h * liq / open;
      buoy += h * dens / open;
      densSum += dens; liqN += liq;
    }
    env2.sub = sub / H;
    env2.buoy = buoy / (H * BODY_DENS);
    env2.densL = liqN ? densSum / liqN : 0;
    let best = -1;
    for (let i = 0; i < liqCount.length; i++) if (liqCount[i] > 0 && (best < 0 || liqCount[i] > liqCount[best])) best = i;
    p.liquidId = best;

    // head: liquid around the eye, or powder/solid in the eye's own cells
    const ye = Math.floor(p.pos.y + EYE_HEIGHT);
    let open = 0, liq = 0, n = 0, buried = 0;
    const buriedCount = {};
    for (let x = bx0 - 1; x <= bx1 + 1; x++)
      for (let z = bz0 - 1; z <= bz1 + 1; z++) {
        const id = idAt(x, ye, z);
        if (id === UNKNOWN) continue;
        if (!solidId(id)) { open++; if (isLiquid(id)) liq++; }
        if (x >= bx0 && x <= bx1 && z >= bz0 && z <= bz1) {
          n++;
          if (blocks(id) && id !== PROBE_OUTSIDE) { buried++; buriedCount[id] = (buriedCount[id] || 0) + 1; }
        }
      }
    env.headInLiquid = open > 0 && liq / open >= HEAD_LIQUID_SHARE && p.liquidId >= 0;
    env.liquidId = p.liquidId;
    env.buriedId = -1;
    if (n && buried / n >= BURY_SHARE) {
      env.buriedId = +Object.keys(buriedCount).reduce((a, b) => (buriedCount[a] >= buriedCount[b] ? a : b));
    }

    // pressure over the body: mean (blast damage) and mean gradient (push);
    // solids reflect pressure, as in react.js
    let pn = 0, pSum = 0, gx = 0, gy = 0, gz = 0;
    let loose = false;
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++)
        for (let z = bz0; z <= bz1; z++) {
          const id = idAt(x, y, z);
          if (id >= 0 && id !== E.EMPTY && KIND[id] !== K.SOLID) loose = true;
          if (solidId(id)) continue;
          const P0 = pAt(x, y, z);
          const q = (dx, dy, dz) => (solidId(idAt(x + dx, y + dy, z + dz)) ? P0 : pAt(x + dx, y + dy, z + dz));
          gx += 0.5 * (q(1, 0, 0) - q(-1, 0, 0));
          gy += 0.5 * (q(0, 1, 0) - q(0, -1, 0));
          gz += 0.5 * (q(0, 0, 1) - q(0, 0, -1));
          pSum += P0; pn++;
        }
    env2.gx = pn ? gx / pn : 0; env2.gy = pn ? gy / pn : 0; env2.gz = pn ? gz / pn : 0;
    env.pressure = pn ? pSum / pn : 0;
    env2.loose = loose;

    // contact: cells touching or inside the body
    let cn = 0;
    for (let y = c0(lo[1] - CONTACT_REACH); y <= c1(hi[1] + CONTACT_REACH); y++)
      for (let x = c0(lo[0] - CONTACT_REACH); x <= c1(hi[0] + CONTACT_REACH); x++)
        for (let z = c0(lo[2] - CONTACT_REACH); z <= c1(hi[2] + CONTACT_REACH); z++) {
          const id = idAt(x, y, z);
          if (id < 0) continue;
          contactId[cn] = id;
          contactT[cn] = tAt(x, y, z);
          cn++;
        }
    env.contactN = cn;
  }

  // ---------------------------------------------------------------- coupling
  function couple(sim, stepRate) {
    if (!env2.loose || stepRate <= 0) return;
    const u = mats.couple.uniforms;
    bounds();
    u.uMin.value.set(lo[0], lo[1], lo[2]);
    u.uMax.value.set(hi[0], hi[1], hi[2]);
    u.uVel.value.copy(p.vel).divideScalar(stepRate).clampScalar(-PHYS.V_MAX, PHYS.V_MAX);
    const speed = p.vel.length();
    u.uPushFluid.value = DISPLACE_PUSH_FLUID * Math.min(1, speed / DISPLACE_FULL_SPEED);
    u.uPushPowder.value = DISPLACE_PUSH_POWDER;
    u.uLift.value = speed > EPS ? DISPLACE_LIFT * Math.max(0, -p.vel.y) / speed : 0;
    u.uFrame.value = sim.frame;
    sim.pass(mats.couple);
  }

  // ---------------------------------------------------------------- update
  const wish = new THREE.Vector2();
  function update(dtIn, input = {}) {
    const sim = getSim();
    if (!sim) return;
    const dt = Math.min(Math.max(dtIn, 0), MAX_DT);
    if (sim !== lastSim) {
      lastSim = sim; lastFrame = sim.frame;
      g = sim.g;
      generation++; probe.valid = false;
      ensureMats(sim);
    }
    // sim steps since last frame → step rate (0 while paused)
    const steps = Math.max(0, sim.frame - lastFrame);
    lastFrame = sim.frame;
    if (dt > 0) dtSmooth += (dt - dtSmooth) * DT_EASE;
    const stepRate = steps / dtSmooth;
    p.stepRate = stepRate;

    const ready = covered();
    requestProbe(sim);
    if (!ready || dt === 0) return;

    sense();
    const alive = !vitals.dead;
    const sub = env2.sub;
    p.submerged = sub;
    const wasIn = p.inLiquid;
    p.inLiquid = sub >= WADE_SHARE;
    p.headInLiquid = env.headInLiquid;
    if (p.inLiquid && !wasIn) emit('splash', { speed: p.vel.length() });

    const v = p.vel;
    const grav = GRAVITY * sim.gravity / SIM_GRAVITY_REF;
    const swimming = sub >= SWIM_SHARE;

    // controls
    wish.set(alive ? input.move?.x ?? 0 : 0, alive ? input.move?.z ?? 0 : 0);
    if (wish.length() > 1) wish.normalize();
    const vh = new THREE.Vector2(v.x, v.z);
    if (p.onGround && !swimming) {
      const target = wish.clone().multiplyScalar(alive && input.sprint ? SPRINT_SPEED : WALK_SPEED);
      const diff = target.sub(vh);
      const max = GROUND_ACCEL * dt;
      if (diff.length() > max) diff.setLength(max);
      vh.add(diff);
      if (alive && input.jump) { v.y = JUMP_SPEED; p.onGround = false; }
    } else if (wish.lengthSq() > 0) {
      // accelerate toward the wished speed, never brake (air control, strokes)
      const speed = swimming ? SWIM_SPEED : (input.sprint ? SPRINT_SPEED : WALK_SPEED);
      const dir = wish.clone().normalize();
      const add = Math.min(Math.max(speed * wish.length() - vh.dot(dir), 0), (swimming ? SWIM_ACCEL : AIR_ACCEL) * dt);
      vh.addScaledVector(dir, add);
    }
    v.x = vh.x; v.z = vh.y;
    if (alive && p.inLiquid) {
      if (input.jump && swimming) v.y += SWIM_UP * GRAVITY * dt;
      if (input.down) v.y -= SWIM_DOWN * GRAVITY * dt;
    }

    // gravity and buoyancy (Archimedes over the submerged share)
    v.y += (env2.buoy - 1) * grav * dt;
    // drag in liquid: move.js dragF, scaled by how much of the body is in it
    if (sub > 0 && env2.densL > 0) v.multiplyScalar(Math.exp(-LIQUID_DRAG * (1 - dragF(BODY_DENS, env2.densL)) * sub * dt));

    // pressure: a = −∇P·P_ACCEL/ρ per step², for each step the sim took
    if (steps > 0) {
      const k = -PHYS.P_ACCEL / RHO_BODY * steps * stepRate;   // (cells/step² per unit ∇P) × steps × (steps/s) → cells/s
      const before = v.length();
      v.x += env2.gx * k; v.y += env2.gy * k; v.z += env2.gz * k;
      const after = v.length();
      if (after > PRESSURE_MAX_SPEED && after > before) v.setLength(Math.max(PRESSURE_MAX_SPEED, before));
    }
    v.add(impulse); impulse.set(0, 0, 0);
    if (v.length() > MAX_SPEED) v.setLength(MAX_SPEED);

    // move, with collisions
    const wasGround = p.onGround;
    const jumped = v.y > 0 && wasGround;
    rise();
    p.onGround = false;
    let landSpeed = 0, landId = -1, slam = 0, slamId = -1;
    const n = Math.max(1, Math.ceil(v.length() * dt / SUBSTEP));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      const vy = v.y;
      const ry = sweep(1, vy * h);
      p.pos.y += ry.d;
      if (ry.id !== null && ry.id !== UNKNOWN) {
        if (vy < 0) { p.onGround = true; landSpeed = Math.max(landSpeed, -vy); landId = ry.id; }
        else { slam = Math.max(slam, vy); slamId = ry.id; }
        v.y = 0;
      }
      for (const axis of [0, 2]) {
        const c = comp[axis];
        const d = v[c] * h;
        if (!d) continue;
        const r = sweep(axis, d);
        if (r.id === null) { p.pos[c] += d; continue; }
        if (r.id === UNKNOWN) { p.pos[c] += r.d; continue; }
        const id = r.id, moved = r.d;
        p.pos[c] += moved;
        if ((p.onGround || wasGround || p.inLiquid) && tryStep(axis, d - moved)) continue;
        if (Math.abs(v[c]) > slam) { slam = Math.abs(v[c]); slamId = id; }
        v[c] = 0;
      }
    }
    // follow the ground down small ledges
    if (!p.onGround && wasGround && !jumped && !swimming) {
      const r = sweep(1, -STEP_DOWN);
      if (r.id !== null && r.id !== UNKNOWN) { p.pos.y += r.d; p.onGround = true; v.y = Math.min(v.y, 0); }
    }

    // landing and impacts
    if (p.onGround && !wasGround && landSpeed > LAND_EVENT_SPEED) emit('land', { speed: landSpeed });
    if (p.onGround || p.inLiquid) {
      if (landSpeed > 0) vitals.impact(landSpeed, SAFE_IMPACT, LETHAL_IMPACT, Math.max(0, apexY - p.pos.y), landId);
      apexY = p.pos.y;
    } else {
      apexY = Math.max(apexY, p.pos.y);
    }
    if (slam > 0) vitals.impact(slam, SAFE_IMPACT, LETHAL_IMPACT, 0, slamId >= 0 ? slamId : -1);

    vitals.update(dt, env);
    couple(sim, stepRate);
  }

  function spawn(feet) {
    p.pos.copy(feet);
    p.vel.set(0, 0, 0);
    impulse.set(0, 0, 0);
    p.onGround = false; p.inLiquid = false; p.headInLiquid = false; p.liquidId = -1; p.submerged = 0;
    apexY = feet.y;
    vitals.reset();
  }

  function dispose() {
    generation++;
    target.dispose();
    mats?.probe.dispose();
    mats?.couple.dispose();
    mats = null; matKey = '';
    for (const k in listeners) delete listeners[k];
  }

  return Object.assign(p, {
    spawn, update, dispose,
    applyImpulse(dv) { impulse.add(dv); },
    on(name, fn) {
      (listeners[name] ??= []).push(fn);
      return () => { listeners[name] = listeners[name].filter((f) => f !== fn); };
    },
  });
}
