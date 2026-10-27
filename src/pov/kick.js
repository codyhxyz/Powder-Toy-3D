import * as THREE from 'three';
import { ELEMENTS, E, K } from '../elements.js';
import { beforeControlContact } from './electronicsInteractions.js';
import { PHYS, NOMINAL_STEP_RATE } from '../physics.js';
import { CELL_M } from '../scale.js';
import { KICK, kickWeight } from '../shaders/povKick.js';
import { povGpu } from './gpu.js';
import { PROBE_OUTSIDE } from '../shaders/povBody.js';
import { povEvents } from './events.js';
import { rayTarget, dealtScale, PLAYER } from './targets.js';
import { gravityScale } from './ballistics.js';
import { BODY_MASS_KG, cellKg, split, brace } from './tug.js';
import { viewmodelRig, heldMaterial } from './viewmodel.js';
import { strikePose, sampleKickPose } from './strikePose.js';
import { sharedTransfer, cellsNear, outsideBody, persistentLoad, ownedKey } from './tools/transfer.js';
import { behind } from './tools/knife.tool.js';
import { voxelWalk, isLoose } from './grid.js';
import { haloMatch, points, wu, CAUSE } from './halo.js';

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
// In a Halo match (halo.js haloMatch) the same key and the same body ability
// are Halo 3's melee: a body within the lunge (MELEE_LUNGE, along the aim from
// the eye, no wall between) takes Halo's blow and you lunge into it; with none
// there the boot does what it always does to the cells. From the front the
// blow is Halo 3's 70 points: one pops a full 70-point shield, the second kills
// the 45 health under it (Halopedia, "Melee": "two blows to a normally-shielded
// opponent's body were sufficient to kill"). From behind (the knife's backstab
// test, TF2's: knife.tool.js behind) it is Halo's assassination: it kills
// outright, through any shield ("A melee from behind ... is sufficient to kill
// virtually any enemy"). The bots melee the same way (npc.js), and their
// knockback is the blow's own (npc.js, pov/index.js hurt's dir).
//
// Events: kick { point, normal, dir, hit: 'cell'|'body'|null, id, broke, dv, mass,
// melee?, assassination? } on every kick (dv your Δv in cells/s, mass the struck
// kg or Infinity; melee: it was Halo's), and an impact (source 'kick') when it
// meets something.

export const KICK_KEY = 'KeyF';      // F: free in the body (V god view, F5 first/third, Z zoom, C crouch, Q tools, E vehicles, digits slots); Halo's melee in a Halo match

const KICK_SPEED = 14 / CELL_M;      // cells/s (47, a Noita jump's speed): a martial artist's front kick, ≈ 14 m/s at the foot
const KICK_HIP = 2.6;                // cells above the feet the leg swings from (figure.js HIP_Y)
const KICK_REACH = 1.2 / CELL_M;     // cells from the hip: thigh, shin and foot (≈ 0.9 m) and the lean into it
export const KICK_REFIRE = 0.5;      // s between kicks
const KICK_DAMAGE = 0.04;            // health a kick takes from a body: Noita's kick_damage (KickComponent, 1/25)
const KICK_CAUSE = 'Kicked';
const KICK_POSE_S = KICK_REFIRE;     // s the figure's kick runs (chamber, extend, retract)

// Halo 3's melee, in a Halo match. Halopedia gives the damage ("H3:Melee": Strike 70, against
// "Energy shielding"'s 70 shield and 45 health) but no lunge range or recovery: those are by eye
// from play, a standard weapon's lunge (well under the Energy Sword's).
const MELEE_DAMAGE = 70;             // points (halo.js: base lives = points / 45)
export const MELEE_LUNGE = wu(0.8);  // cells (≈ 8, 2.4 m) from the eye a body is reached within (by eye)
const MELEE_REFIRE = 0.8;            // s between blows: Halo 3's swing and recovery (by eye)
const LUNGE_SPEED = 8 / CELL_M;      // cells/s: the lunge carries you into a body farther than the boot's reach (by eye)
const MELEE_ENERGY = 60;             // the impact's energy for the shake and hitmarker: the knife's backstab (a full blow)
const WALL_STEP = 0.5;               // cells between the samples of the lunge's way for a wall
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

const isSolid = (id) => id === PROBE_OUTSIDE || (id >= 0 && ELEMENTS[id].kind === K.SOLID);
const breaksAt = (id, w) => id >= 0 && ELEMENTS[id].kind === K.SOLID && !!ELEMENTS[id].breakInto && KICK.ENERGY * w >= ELEMENTS[id].hard;
const debrisOf = (id) => E[ELEMENTS[id].breakInto];

// body: the player.js body (pos, onGround, dead, stepRate, applyImpulse); owner:
// its id (an NPC's), which keeps its boot's load apart from the player's.
// cellAt(x, y, z): the element id the body's probe holds there, `unknown`
// outside it, PROBE_OUTSIDE for the box's floor and walls.
export function createKick({ body, owner = null, renderer, getSim, cellAt, unknown }) {
  const transfer = () => sharedTransfer({ renderer, getSim });
  const load = persistentLoad(ownedKey('KICK', owner), SOLE_CELLS);   // grains on the boot (kept if a mode or scene change comes mid-kick)
  // The steps a second a cells/step speed is on: the body's measured rate, or under V2 V1's own
  // (the native kick and put read V1's cells/step as m/s: v2/nativeForcing.js, shaders/v2/transfer.js;
  // V2's 60 ticks a second would make every kick and landing clump four times as fast)
  const speedRate = (sim) => (sim?.compact ? NOMINAL_STEP_RATE : body.stepRate);
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
  let wait = 0, poseT = Infinity, generation = 0, disposed = false;
  const walked = [];   // for checks: the cells the last reach ray crossed, [x, y, z, id]
  const hip = new THREE.Vector3(), dir = new THREE.Vector3(), center = new THREE.Vector3();

  // The first cell along hip + t·dir that isn't air or gas, within reach
  // (Amanatides & Woo's voxel walk): { cell, t, id, normal }, or null.
  function march() {
    walked.length = 0;
    return voxelWalk(hip, dir, KICK_REACH, (x, y, z, t, axis, step) => {
      const id = cellAt(x, y, z);
      walked.push([x, y, z, id]);
      if (id === unknown) return null;
      if (axis >= 0 && (isSolid(id) || isLoose(id))) {
        const normal = new THREE.Vector3();
        normal.setComponent(axis, -step);
        return { cell: new THREE.Vector3(x, y, z), t, id, normal };
      }
    }, MARCH_MAX) ?? null;
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

  // Halo's melee on the body in the lunge along dir, or null (none there: the boot kicks as ever)
  const eye = new THREE.Vector3(), toward = new THREE.Vector3(), lo = new THREE.Vector3(), hi = new THREE.Vector3();
  function melee() {
    const me = povEvents.actor?.id ?? PLAYER;
    eye.set(body.pos.x, body.pos.y + body.eyeHeight, body.pos.z);
    const who = rayTarget(eye, dir, MELEE_LUNGE, me);
    if (!who) return null;
    // a wall between (what the body's probe holds; beyond it, open)
    for (let t = WALL_STEP; t < who.dist; t += WALL_STEP) {
      if (isSolid(cellAt(Math.floor(eye.x + dir.x * t), Math.floor(eye.y + dir.y * t), Math.floor(eye.z + dir.z * t)))) return null;
    }
    const foe = who.target;
    const assassination = behind({ player: body, dir }, foe);
    // the lunge: on into a body beyond the boot's reach, along the ground
    let dv = new THREE.Vector3();
    foe.box(lo, hi);
    toward.set((lo.x + hi.x) / 2 - body.pos.x, 0, (lo.z + hi.z) / 2 - body.pos.z);
    if (who.dist > KICK_REACH && toward.lengthSq() > EPS) {
      dv = toward.normalize().multiplyScalar(LUNGE_SPEED);
      body.applyImpulse(dv);
    }
    if (assassination) foe.hurt(1, CAUSE.ASSASSINATION, dir.clone(), { lethal: true, exact: true });
    else foe.hurt(points(MELEE_DAMAGE) * dealtScale(povEvents.actor?.id), CAUSE.MELEE, dir.clone(), { exact: true });
    const normal = dir.clone().negate();
    povEvents.emit('impact', { source: 'kick', point: who.point, normal, id: -1, energy: MELEE_ENERGY, broke: null, body: true, backstab: assassination });
    const res = { hit: 'body', point: who.point, normal, id: -1, broke: null, mass: foe.mass ?? BODY_MASS_KG, dv, melee: true, assassination };
    povEvents.emit('kick', { ...res, point: who.point.clone(), dir: dir.clone(), dv: dv.clone() });
    return res;
  }

  function kick(dirIn) {
    const sim = getSim();
    // (its kernels still building, B5: the kick waits, as a tool's use does)
    if (disposed || !sim || wait > 0 || body.dead || !povGpu(sim).ready) return null;
    const halo = haloMatch();
    wait = halo ? MELEE_REFIRE : KICK_REFIRE;
    poseT = 0;
    dir.copy(dirIn).normalize();
    hip.set(body.pos.x, body.pos.y + KICK_HIP, body.pos.z);
    if (halo) { const m = melee(); if (m) return m; }
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
      const carryContact = { ...struck, cell: struck.cell.clone(), normal: struck.normal.clone() };
      const contactCenter = center.clone(), contactDir = dir.clone(), contactHip = hip.clone();
      const mine = generation;
      const valid = () => !disposed && generation === mine && getSim() === sim;
      const v = body.stepRate > 0 ? KICK_SPEED * share / speedRate(sim) : 0;
      const applyBlow = (shift = contactCenter.clone().set(0, 0, 0)) => {
        if (!valid()) return;
        contactCenter.add(shift); carryContact.cell.add(shift); contactHip.add(shift);
        if (l.loose && share > 0) carry(carryContact, share, contactHip, contactDir);
        if (!l.breaks) return;
        const r = KICK.RADIUS, c = contactCenter;
        povGpu(sim).edit('povKick', sim.touchCentres([c.x - r, c.y - r, c.z - r], [c.x + r, c.y + r, c.z + r]), {
          center: c, shove: contactDir.clone().multiplyScalar(Math.min(v, PHYS.V_MAX)),
        });
      };
      if (!beforeControlContact(sim, struck, 'melee', applyBlow, { valid })) applyBlow();
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
  function carry(struck, share, hip, dir) {
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
    const mine = generation;
    p?.then((got) => { if (!disposed && generation === mine) lastCarry.took = got.length; });
    const boot = hip.clone().addScaledVector(dir, Math.max(struck.t - BOOT_GAP, 0));
    if (p) carried = { from, boot, splash, speed, at, vel: stepVel(splash, speed), tries: 0, flying: false, flew: false, round: 0, last: null };
  }

  // a velocity (unit dir × cells/s) on the sim's clock, cells/step (as player.js's coupling converts)
  const stepVel = (d, speed) => d.clone().multiplyScalar(body.stepRate > 0 ? Math.min(speed / speedRate(getSim()), PHYS.V_MAX) : 0);

  // the clump lands: back into the sim in the open cell before what it hit, at the speed it arrives with
  function land({ hit, dir }) {
    if (disposed || !carried) return;
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
      if (disposed) return;
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
    dispose() { disposed = true; generation++; offs.forEach((off) => off()); },   // (grains still on the boot stay in its load: tool loads persist)
  };
}

// ---------------------------------------------------------------- the leg in first person

// The kicking leg in the viewmodel: a shin and boot swung up from below the
// view about the hip and knee, using the same chamber/snap as the body.
// Camera space, cells (+x right, +y up, −z forward). Drawn higher than a real
// hip so the boot comes into the frame, as first-person legs are.
const LEG_HIP = [0.4, -0.9, 0.3];    // cells: the pivot, below and just behind the eye
const LEG_LENGTH = 2.0;              // cells, hip to sole
const LEG_WIDTH = 0.34;              // cells
const BOOT = [0.42, 0.3, 0.8];       // cells: width, height, length (toward −z)
const LEG_COLOR = '#ae8058';         // his bare skin: the realistic body's albedo map, averaged over the shin
const BOOT_COLOR = LEG_COLOR;        // and he kicks barefoot

export function createKickLeg(env) {
  const rig = viewmodelRig(env);
  const hand = rig.hand(LEG_HIP);
  const pivot = new THREE.Group();
  pivot.name = 'kick-hip';
  hand.add(pivot);
  const knee = new THREE.Group();
  knee.name = 'kick-knee'; knee.position.y = -LEG_LENGTH / 2; pivot.add(knee);
  const legMat = heldMaterial(LEG_COLOR), bootMat = heldMaterial(BOOT_COLOR);
  const geometry = new THREE.BoxGeometry(LEG_WIDTH, LEG_LENGTH / 2, LEG_WIDTH);
  const thigh = new THREE.Mesh(geometry, legMat), shin = new THREE.Mesh(geometry, legMat);
  thigh.position.y = shin.position.y = -LEG_LENGTH / 4;
  const boot = new THREE.Mesh(new THREE.BoxGeometry(...BOOT), bootMat);
  boot.name = 'kick-boot';
  boot.position.set(0, -LEG_LENGTH / 2, (LEG_WIDTH - BOOT[2]) / 2);
  pivot.add(thigh); knee.add(shin, boot);
  const pose = strikePose(), follow = new THREE.Quaternion(), axis = new THREE.Vector3(1, 0, 0);
  let t = Infinity, landed = true;
  return {
    start(hit) {
      landed = hit; t = 0; hand.visible = true;
      pivot.quaternion.identity(); knee.quaternion.identity();
    },
    update(dt) {
      if (t === Infinity) return;
      t += dt;
      const p = Math.min(1, t / KICK_REFIRE);
      sampleKickPose(p, pose);
      pivot.quaternion.copy(pose.hip); knee.quaternion.copy(pose.knee);
      if (!landed) pivot.quaternion.premultiply(follow.setFromAxisAngle(axis, 0.15 * Math.sin(Math.PI * p)));
      if (t >= KICK_REFIRE) { hand.visible = false; t = Infinity; pivot.quaternion.identity(); knee.quaternion.identity(); }
      globalThis.__app?.requestRender?.();
    },
    dispose() {
      geometry.dispose(); boot.geometry.dispose(); legMat.dispose(); bootMat.dispose();
      rig.releaseHand(hand);
    },
  };
}
