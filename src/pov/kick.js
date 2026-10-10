import * as THREE from 'three';
import { ELEMENTS, E, K } from '../elements.js';
import { PHYS } from '../physics.js';
import { CELL_M } from '../scale.js';
import { kickFrag, KICK, kickWeight } from '../shaders/povKick.js';
import { toolPass } from '../shaders/povTools.js';
import { PROBE_OUTSIDE } from '../shaders/povBody.js';
import { povEvents } from './events.js';
import { rayTarget, PLAYER } from './targets.js';
import { gravityScale } from './ballistics.js';
import { BODY_MASS_KG, cellKg, split, brace } from './tug.js';
import { viewmodelRig, heldMaterial } from './viewmodel.js';
import { swing } from './tools/action.js';
import { sharedTransfer, cellsNear, outsideBody, persistentLoad, ownedKey } from './tools/transfer.js';

// The kick: Cruelty Squad's, always on its own key, no hotbar slot. A body
// ability (player.js body.kick(dir)), so an NPC's body has it too.
//
// A short blow from the hip along the aim. What it meets, first along the way:
// - a body (targets.js: an NPC, or the player when an NPC kicks): it takes
//   Noita's kick damage and the pair are shoved apart;
// - a cell, read from the body's own probe (the cells it already reads back
//   around itself): over Noita's kick radius (shaders/povKick.js KICK) the
//   boot breaks the weak solids (glass, ice, plants: the axe's energy rule,
//   povTools.js blowFrag) and shoves the fresh debris; loose matter (powder,
//   liquid) under the sole is carried off (below);
// - nothing within reach: a miss.
// How hard each side moves is momentum conservation (pov/tug.js): the foot
// drives the pair apart at KICK_SPEED, split by inverse mass. A body weighs
// BODY_MASS_KG, the struck lump what its cells weigh (for sand or water, the
// cell under the boot: loose grains don't drag the heap along), and a solid
// the boot doesn't break (or the floor) is anchored: infinite. So kicking a
// wall or the floor at an angle throws YOU back along the kick: Cruelty
// Squad's kick-jump falls out of Newton's third law, while kicked sand flies. Standing,
// the ground takes the sideways and downward part (tug.js brace), as it takes
// the gun's recoil; in the air you get all of it.
//
// It fits the body's Noita movement (player.js) the way the gun's recoil and
// a rocket's blast do: one impulse (body.applyImpulse), which the per-frame
// ease then works on like any other speed: kept while you're faster than a
// run with no keys held in the air, eased toward what you ask for otherwise.
//
// Events: kick { point, normal, dir, hit: 'cell'|'body'|null, id, broke, dv, mass }
// on every kick (dv your Δv in cells/s, mass the struck kg or Infinity), and an
// impact (source 'kick') when it meets something.

export const KICK_KEY = 'KeyF';      // F: free in the body (V god view, F5 first/third, Z zoom, C crouch, Q tools, E vehicles, digits slots)

const KICK_SPEED = 14 / CELL_M;      // cells/s (47, a Noita jump's speed): a martial artist's front kick, ≈ 14 m/s at the foot
const KICK_HIP = 2.6;                // cells above the feet the leg swings from (figure.js HIP_Y)
const KICK_REACH = 1.2 / CELL_M;     // cells from the hip: thigh, shin and foot (≈ 0.9 m) and the lean into it
export const KICK_REFIRE = 0.5;      // s between kicks
const KICK_DAMAGE = 0.04;            // health a kick takes from a body: Noita's kick_damage (KickComponent, 1/25)
const KICK_CAUSE = 'Kicked';
const KICK_POSE_S = KICK_REFIRE;     // s the figure's kick runs (chamber, extend, retract)
const MARCH_MAX = Math.ceil(KICK_REACH * 3) + 3;   // safety: most cells a reach ray can cross

// Loose matter has no cohesion: the boot carries off only the grains under its
// sole, never the heap behind them. They leave it at their share of the boot's
// speed, thrown up at the angle sand splashes out of a bed (a boot driven into
// a heap throws it up and forward, not into the ground), and fly as a
// projectile (ballistics.js: real speed, real 1 g) until they land, where
// they go back into the sim at the speed they arrive with. On the sim's own
// fast clock (≈ 44 g in real time) a real kick's few m/s would stop within a
// cell. They're taken out and put back through the cell transfer, as the
// shovel and the hook move matter, so none is lost or made. Without a
// projectile engine (an NPC's body) they're set down at the end of the boot's
// reach instead.
const SOLE_CELLS = 1;                       // cells the boot carries: the one under the sole (a 30 cm cell is a boot's length)
const SOLE_RADIUS = 0.5;                    // cells around the struck cell's centre: that cell alone (its neighbours are 1 away)
const CARRY_MIN = 1;                        // cells: the least it carries them (struck at full reach, the boot still follows through)
const SPLASH_ANGLE = 50 * Math.PI / 180;    // rad above level: splashed sand leaves its bed at 40-60° (aeolian saltation measurements)
const PUT_RADIUS = 1.5;                     // cells around the landing spot to find room in (the hook's set-down)
const PUT_TRIES = 6;                        // tries there before setting them down where they were taken from
const SURFACE_REACH = 3;                    // cells up the struck column the boot's lift reaches (shin and boot, ≈ 1 m): the grains on it rise, the top one flies
const LAUNCH_CLEAR = 0.5;                   // cells back along its flight from what a landing clump hit: the open cell before it
const BOOT_GAP = 0.05;                      // cells short of the struck face: where the boot is when the clump leaves it (in air the
                                            // reach ray crossed; the taken cell itself may already have been filled by the heap slumping)
const GRAIN_KIND = 'grain';                 // ballistics.js kind of a kicked clump (vfx.js draws its dust off kick:grain)
const EPS = 1e-6;

const isLoose = (id) => id >= 0 && (ELEMENTS[id].kind === K.POWDER || ELEMENTS[id].kind === K.LIQUID);
const isSolid = (id) => id === PROBE_OUTSIDE || (id >= 0 && ELEMENTS[id].kind === K.SOLID);
const breaksAt = (id, w) => id >= 0 && ELEMENTS[id].kind === K.SOLID && !!ELEMENTS[id].breakInto && KICK.ENERGY * w >= ELEMENTS[id].hard;
const debrisOf = (id) => E[ELEMENTS[id].breakInto];

// body: the player.js body (pos, onGround, dead, stepRate, applyImpulse); owner:
// its id (an NPC's), which keeps its boot's load apart from the player's.
// cellAt(x, y, z): the element id the body's probe holds there, `unknown`
// outside it, PROBE_OUTSIDE for the box's floor and walls.
export function createKick({ body, owner = null, renderer, getSim, cellAt, unknown }) {
  const pass = toolPass(kickFrag, () => ({ uCenter: { value: new THREE.Vector3() }, uShove: { value: new THREE.Vector3() } }));
  const transfer = () => sharedTransfer({ renderer, getSim });
  const load = persistentLoad(ownedKey('KICK', owner), SOLE_CELLS);   // grains on the boot (kept if a mode or scene change comes mid-kick)
  let carried = null;   // { from, splash, speed, at, vel, tries, flying, flew, round } while grains are on their way
  let flight = null;    // the projectile engine kicked grains fly in (ballistics.js), set by the shell
  const lastCarry = { from: null, took: -1, round: 0, landedAt: null, putTries: 0 };   // for checks: how the last kicked clump went
  const offs = [
    povEvents.on('round:move', ({ id, to }) => {
      if (!carried || id !== carried.round) return;
      carried.last = to.clone();
      povEvents.emit('kick:grain', { to: to.clone(), id: load.cells[0]?.[0] ?? -1 });
    }),
    // it left the box or the engine was cleared mid-flight: set it down where it was last seen
    povEvents.on('round:end', ({ id }) => {
      if (!carried || id !== carried.round || !carried.flying) return;
      carried.flying = false;
      carried.at = carried.last ?? carried.from;
    }),
  ];
  let wait = 0, poseT = Infinity;
  const walked = [];   // for checks: the cells the last reach ray crossed, [x, y, z, id]
  const hip = new THREE.Vector3(), dir = new THREE.Vector3(), center = new THREE.Vector3();

  // The first cell along hip + t·dir that isn't air or gas, within reach
  // (Amanatides & Woo's voxel walk): { cell, t, id, normal }, or null.
  function march() {
    const o = [hip.x, hip.y, hip.z], d = [dir.x, dir.y, dir.z];
    const c = o.map(Math.floor);
    const step = d.map(Math.sign);
    const tDelta = d.map((v) => (v === 0 ? Infinity : Math.abs(1 / v)));
    const tMax = d.map((v, k) => (v === 0 ? Infinity : ((v > 0 ? c[k] + 1 : c[k]) - o[k]) / v));
    let t = 0, axis = -1;
    walked.length = 0;
    for (let i = 0; i < MARCH_MAX && t <= KICK_REACH; i++) {
      const id = cellAt(c[0], c[1], c[2]);
      walked.push([...c, id]);
      if (id === unknown) return null;
      if (axis >= 0 && (isSolid(id) || isLoose(id))) {
        const normal = new THREE.Vector3();
        normal.setComponent(axis, -step[axis]);
        return { cell: new THREE.Vector3(...c), t, id, normal };
      }
      axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      t = tMax[axis];
      c[axis] += step[axis];
      tMax[axis] += tDelta[axis];
    }
    return null;
  }

  // The struck lump around a cell: its mass (kg, Infinity when anchored) and
  // what the boot does there. Breakable solids break over the patch and their
  // debris goes with the boot (each cell weighted by the patch's w). Loose
  // matter has no cohesion, so only the grains under the sole move
  // (KICK.SOLE_RADIUS: the struck cell): you kick the bit of the heap in front
  // of your foot, never the whole heap.
  function lump(cell) {
    center.copy(cell).addScalar(0.5);
    const span = Math.ceil(KICK.RADIUS);
    let kg = 0, breaks = false;
    for (let z = -span; z <= span; z++)
      for (let y = -span; y <= span; y++)
        for (let x = -span; x <= span; x++) {
          const w = kickWeight(Math.hypot(x, y, z));
          if (w <= 0) continue;
          const id = cellAt(cell.x + x, cell.y + y, cell.z + z);
          if (breaksAt(id, w)) { breaks = true; kg += w * cellKg(debrisOf(id)); }
        }
    const id = cellAt(cell.x, cell.y, cell.z);
    const loose = isLoose(id);
    if (loose) kg += cellKg(id);
    const anchored = isSolid(id) && !breaksAt(id, 1);
    return { kg: anchored ? Infinity : kg, breaks, loose, broke: isSolid(id) ? !anchored : null };
  }

  function kick(dirIn) {
    const sim = getSim();
    if (!sim || wait > 0 || body.dead) return null;
    wait = KICK_REFIRE;
    poseT = 0;
    dir.copy(dirIn).normalize();
    hip.set(body.pos.x, body.pos.y + KICK_HIP, body.pos.z);
    const struck = march();
    const who = rayTarget(hip, dir, struck ? struck.t : KICK_REACH, povEvents.actor?.id ?? PLAYER);
    let res = { hit: null, point: null, normal: null, id: -1, broke: null, mass: 0 };
    if (who) {
      const kg = who.target.mass ?? BODY_MASS_KG;
      const [, share] = split(BODY_MASS_KG, kg);
      who.target.hurt(KICK_DAMAGE, KICK_CAUSE, null);   // null: no knockback of its own, the shove below is it
      who.target.shove?.(dir.clone().multiplyScalar(KICK_SPEED * share));
      res = { hit: 'body', point: who.point, normal: dir.clone().negate(), id: -1, broke: null, mass: kg };
      povEvents.emit('impact', { source: 'kick', point: who.point, normal: res.normal, id: -1, energy: KICK.ENERGY, broke: null, body: true });
    } else if (struck) {
      const l = lump(struck.cell);
      const [, share] = split(BODY_MASS_KG, l.kg);
      if (l.loose && share > 0) carry(struck, share);
      if (l.breaks) {
        const mat = pass(sim);
        mat.uniforms.uCenter.value.copy(center);
        // the lump's speed on the sim's clock (cells/step, as player.js's coupling converts)
        const v = body.stepRate > 0 ? KICK_SPEED * share / body.stepRate : 0;
        mat.uniforms.uShove.value.copy(dir).multiplyScalar(Math.min(v, PHYS.V_MAX));
        const r = KICK.RADIUS;
        sim.touchCentres([center.x - r, center.y - r, center.z - r], [center.x + r, center.y + r, center.z + r]);
        sim.pass(mat);
      }
      res = { hit: 'cell', point: center.clone(), normal: struck.normal, id: struck.id, broke: l.broke, mass: l.kg };
      if (struck.id >= 0) povEvents.emit('impact', { source: 'kick', point: res.point, normal: struck.normal, id: struck.id, energy: KICK.ENERGY, broke: l.broke });
    }
    // Newton's third law: the body's share, the other way
    const [mine] = res.hit ? split(BODY_MASS_KG, res.mass) : [0];
    const dv = brace(dir.clone().multiplyScalar(-KICK_SPEED * mine), body.onGround);
    if (dv.lengthSq() > 0) body.applyImpulse(dv);
    res.dv = dv;
    povEvents.emit('kick', { ...res, point: res.point?.clone() ?? null, dir: dir.clone(), dv: dv.clone() });
    return res;
  }

  // Take the grains under the sole onto the boot; they're set down in update().
  function carry(struck, share) {
    const sim = getSim();
    if (!sim || carried || load.busy || load.cells.length) return;
    // a boot driven under a heap lifts what rests on it: the clump that flies is the column's top one,
    // with open air above it (one cell either way, so the mass is the same)
    const top = struck.cell.clone();
    for (let i = 0; i < SURFACE_REACH && isLoose(cellAt(top.x, top.y + 1, top.z)); i++) top.y++;
    const from = top.addScalar(0.5);
    const splash = new THREE.Vector3();
    const flat = Math.hypot(dir.x, dir.z);
    if (flat < EPS) splash.set(0, 1, 0);   // kicked straight down: they can only come up
    else if (Math.atan2(dir.y, flat) >= SPLASH_ANGLE) splash.copy(dir);
    else splash.set(dir.x / flat * Math.cos(SPLASH_ANGLE), Math.sin(SPLASH_ANGLE), dir.z / flat * Math.cos(SPLASH_ANGLE));
    const speed = KICK_SPEED * share;   // cells/s
    const at = from.clone().addScaledVector(splash, Math.max(KICK_REACH - struck.t, CARRY_MIN));
    const p = transfer().take(load, { cells: cellsNear(from, SOLE_RADIUS, sim.g), kinds: [K.POWDER, K.LIQUID], limit: SOLE_CELLS });
    Object.assign(lastCarry, { from: from.toArray(), took: p ? -1 : -2, round: 0, landedAt: null, putTries: 0 });
    p?.then((got) => { lastCarry.took = got.length; });
    const boot = hip.clone().addScaledVector(dir, Math.max(struck.t - BOOT_GAP, 0));
    if (p) carried = { from, boot, splash, speed, at, vel: stepVel(splash, speed), tries: 0, flying: false, flew: false, round: 0, last: null };
  }

  // a velocity (unit dir × cells/s) on the sim's clock, cells/step (as player.js's coupling converts)
  const stepVel = (d, speed) => d.clone().multiplyScalar(body.stepRate > 0 ? Math.min(speed / body.stepRate, PHYS.V_MAX) : 0);

  // the clump lands: back into the sim in the open cell before what it hit, at the speed it arrives with
  function land({ hit, dir }) {
    if (!carried) return;
    carried.flying = false;
    carried.at = hit.point.clone().addScaledVector(dir, -LAUNCH_CLEAR);
    lastCarry.landedAt = carried.at.toArray().map((v) => +v.toFixed(2));
    carried.vel = stepVel(dir, carried.speed);
  }

  function setDown() {
    const sim = getSim();
    if (!carried || !sim || load.busy || carried.flying) return;
    if (!load.cells.length) { carried = null; return; }   // landed (or the load was emptied: a scene change)
    if (flight && !carried.flew) {
      carried.flew = true;
      carried.round = flight.fire(carried.boot, carried.splash, gravityScale(sim), { speed: carried.speed, kind: GRAIN_KIND, onStrike: land });
      lastCarry.round = carried.round;
      if (carried.round) { carried.flying = true; return; }
    }
    const spot = carried.tries < PUT_TRIES ? carried.at : carried.from;
    const p = transfer().put(load, { cells: cellsNear(spot, PUT_RADIUS, sim.g, outsideBody(body.pos)), vel: carried.vel });
    if (p) { carried.tries++; lastCarry.putTries = carried.tries; }
  }

  return {
    kick,
    update(dt) {
      wait = Math.max(0, wait - dt);
      poseT += dt;
      setDown();
    },
    get pose() { return poseT < KICK_POSE_S ? poseT / KICK_POSE_S : null; },
    get ready() { return wait === 0; },
    get walked() { return walked.map((c) => [...c]); },   // for checks
    get carrying() { return { on: !!carried, load: load.count, busy: load.busy, tries: carried?.tries ?? 0, flying: !!carried?.flying }; },   // for checks
    get lastCarry() { return { ...lastCarry, engine: !!flight }; },   // for checks
    set ballistics(b) { flight = b; },   // the shell hands over the toolbelt's projectile engine
    dispose() { pass.dispose(); offs.forEach((off) => off()); },   // (grains still on the boot stay in its load: tool loads persist)
  };
}

// ---------------------------------------------------------------- the leg in first person

// The kicking leg in the viewmodel: a shin and boot swung up from below the
// view about the hip, eased the way the melee tools swing (tools/action.js
// swing): it stops short where the boot lands and follows through on a miss.
// Camera space, cells (+x right, +y up, −z forward). Drawn higher than a real
// hip so the boot comes into the frame, as first-person legs are.
const LEG_HIP = [0.4, -0.9, 0.3];    // cells: the pivot, below and just behind the eye
const LEG_LENGTH = 2.0;              // cells, hip to sole
const LEG_WIDTH = 0.34;              // cells
const BOOT = [0.42, 0.3, 0.8];       // cells: width, height, length (toward −z)
const LEG_COLOR = '#3b2a4a';         // the wizard's robe
const BOOT_COLOR = '#2a1d14';        // leather
const LEG_REST = 0;                  // rad: hanging down, out of view
const LEG_HIT = 1.6;                 // rad: the boot landed (level, ahead)
const LEG_MISS = 1.95;               // rad: a miss follows through, higher
const LEG_STRIKE = 0.08;             // s for the boot to come up

export function createKickLeg(env) {
  const rig = viewmodelRig(env);
  const hand = rig.hand(LEG_HIP);
  const pivot = new THREE.Group();
  hand.add(pivot);
  const legMat = heldMaterial(LEG_COLOR), bootMat = heldMaterial(BOOT_COLOR);
  const shin = new THREE.Mesh(new THREE.BoxGeometry(LEG_WIDTH, LEG_LENGTH, LEG_WIDTH), legMat);
  shin.position.y = -LEG_LENGTH / 2;
  const boot = new THREE.Mesh(new THREE.BoxGeometry(...BOOT), bootMat);
  boot.position.set(0, -LEG_LENGTH, (LEG_WIDTH - BOOT[2]) / 2);
  pivot.add(shin, boot);
  const pose = swing({ rest: LEG_REST, hit: LEG_HIT, miss: LEG_MISS, strike: LEG_STRIKE, settle: KICK_REFIRE });
  let t = Infinity;
  return {
    start(landed) { pose.start(landed); t = 0; hand.visible = true; },
    update(dt) {
      if (t === Infinity) return;
      t += dt;
      pivot.rotation.x = pose.angle(dt);
      if (t >= KICK_REFIRE) { hand.visible = false; t = Infinity; pose.stop(); }
      globalThis.__app?.requestRender?.();
    },
    dispose() {
      shin.geometry.dispose(); boot.geometry.dispose(); legMat.dispose(); bootMat.dispose();
      hand.removeFromParent();
    },
  };
}
