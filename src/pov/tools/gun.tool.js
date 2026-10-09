import * as THREE from 'three';
import { BODY_WIDTH, BODY_HEIGHT } from '../constants.js';
import { createBallistics, ROUND_SPEED, MAX_ROUNDS } from '../ballistics.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig } from '../viewmodel.js';

// Gun: fires a round that flies with real ballistics (360 m/s, 1 g) outside
// the sim and becomes a SCRAP slug, a sim cell, where it strikes (ballistics.js).
// From then on it is the engine's: what it hits is decided by the impact
// rules, a pool slows it, and it settles as scrap.
//
// The round leaves the muzzle: the first cell along the aim ray outside the
// body box. The trigger only clicks (gun:dry) when that cell, or one between
// the eye and it, is matter: the pick under the crosshair is that close.
//
// Recoil conserves momentum: Δv_body = m_round·v_round / m_body, v the
// round's muzzle speed. The masses are a real pistol bullet's and a person's,
// not the slug cell's: the cell the round becomes at impact is a 30 cm block
// of metal, and kicking the body with that much momentum (~600 cells/s,
// clamped only by player.js MAX_SPEED) threw the player across the box with
// every shot. A real round nudges you by ~4 cm/s. Standing, the ground takes it
// the way it takes any impact: friction the sideways part, the floor the
// downward part, so only an upward kick or a shot fired in the air or water
// moves you, and then barely.
//
// Events (docs/pov.md): gun:fire, gun:dry here; round:move, round:end and
// impact from ballistics.js.

const FIRE_INTERVAL = 0.35;        // s between shots
const SPAWN_SEARCH = 16;           // cells walked along the ray looking for the muzzle cell
const MUZZLE_NUDGE = 1e-3;         // cells past the muzzle cell's entry face the round starts
const ROUNDS_IN_FLIGHT_MAX = MAX_ROUNDS;   // rounds the gun keeps in the air at once (the trace pass's width)
const ROUND_MASS_KG = 0.008;        // kg, a 9 mm pistol bullet (the 360 m/s round of ballistics.js)
const BODY_MASS_KG = 70;           // kg, the player
const SIM_GRAVITY_REF = 0.025;     // cells/step², the sim's default gravity (sim.js GRAVITY_DEFAULT): rounds fall at 1 g there
const MS_PER_S = 1000;

// viewmodel, in cells (camera space: +x right, +y up, −z forward). The recoil
// is the viewmodel rig's spring (viewmodel.js), thrown by gun:fire and gun:dry.
const GUN_POS = [0.5, -0.45, -1.5];
const MUZZLE = [0, 0.1, -0.66];    // cells from the model's centre to the end of the bore
const DRY_TOAST_INTERVAL = 1.5;    // s between "blocked" toasts

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
<path d="M3 8h15l1-2h2v5h-6l-1 2h-3l-1 5H5l1-5H3z"/></svg>`;

// The held gun: the Kenney model (models.js, async) on a hand of the
// viewmodel rig and a muzzle point at the end of its bore. The flash is vfx.js's,
// drawn at gun:fire's muzzleWorld.
function buildModel(env) {
  const rig = viewmodelRig(env);
  const hand = rig.hand(GUN_POS);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(...MUZZLE);
  hand.add(muzzle);
  const mesh = attachModel(hand, 'gun');
  return {
    rig, hand, muzzle,
    // the muzzle in world space (for gun:fire's muzzleWorld); valid before the mesh arrives
    muzzleWorld: (out = new THREE.Vector3()) => { muzzle.updateWorldMatrix(true, false); return muzzle.getWorldPosition(out); },
    dispose() { mesh.dispose(); hand.removeFromParent(); },
  };
}

// First cell along eye + t·dir that doesn't overlap the body box (feet at
// pos, BODY_WIDTH square, BODY_HEIGHT tall), by grid DDA: { cell, t, path },
// t the ray distance at which it enters that cell and path every cell from
// the eye's to it. null if none within SPAWN_SEARCH cells or it is outside
// the grid.
export function muzzleCell(eye, dir, pos, g) {
  const half = BODY_WIDTH / 2;
  const lo = [pos.x - half, pos.y, pos.z - half], hi = [pos.x + half, pos.y + BODY_HEIGHT, pos.z + half];
  const o = [eye.x, eye.y, eye.z], d = [dir.x, dir.y, dir.z];
  const c = o.map(Math.floor);
  const step = d.map(Math.sign);
  const tDelta = d.map((v) => (v === 0 ? Infinity : Math.abs(1 / v)));
  const tMax = d.map((v, k) => (v === 0 ? Infinity : ((v > 0 ? c[k] + 1 : c[k]) - o[k]) / v));
  const overlaps = () => c.every((v, k) => v < hi[k] && v + 1 > lo[k]);
  const path = [];
  let t = 0;
  for (let i = 0; i < SPAWN_SEARCH; i++) {
    path.push(new THREE.Vector3(...c));
    if (!overlaps()) {
      const inGrid = c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < g.nx && c[1] < g.ny && c[2] < g.nz;
      return inGrid ? { cell: new THREE.Vector3(...c), t, path } : null;
    }
    const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
    t = tMax[k];
    c[k] += step[k];
    tMax[k] += tDelta[k];
  }
  return null;
}

export default {
  key: 'GUN', name: 'Gun', slot: 4, icon: ICON,
  desc: 'Fires a metal round that flies fast, drops a little and smashes what it hits.',
  create(env) {
    const model = buildModel(env);
    const ballistics = createBallistics({ renderer: env.renderer });
    ballistics.prepare(env.getSim());
    let time = 0, nextFire = 0, nextDryToast = 0;
    let lastShot = null;
    // While the gun is put away the toolbelt stops calling update, but rounds
    // already in the air keep flying: this drives them until they land, at the
    // last frame's step rate (a round lives a fraction of a second).
    let selected = false, lastSteps = 0, raf = 0, rafAt = 0;

    const dry = () => {
      povEvents.emit('gun:dry', {});
      if (time >= nextDryToast) { env.hud?.toast?.('Click. The muzzle is blocked.'); nextDryToast = time + DRY_TOAST_INTERVAL; }
    };

    // the muzzle in world space: the viewmodel's muzzle while it's shown, else the eye
    function muzzleWorld(eye) {
      if (model.hand.visible) return model.muzzleWorld();
      const vol = env.getVolume();
      return eye.clone().multiplyScalar(env.getScale()).add(vol.position);
    }

    function fire(ctx) {
      const sim = ctx.sim ?? env.getSim();
      const dir = ctx.dir.clone().normalize();
      const m = muzzleCell(ctx.eye, dir, ctx.player.pos, sim.g);
      // the pick under the crosshair is on the way to the muzzle: matter there
      const aim = ctx.aim;
      if (!m || (aim?.valid && aim.cell && m.path.some((c) => c.equals(aim.cell)))) { dry(); return; }
      if (ballistics.count >= ROUNDS_IN_FLIGHT_MAX) return;
      const origin = ctx.eye.clone().addScaledVector(dir, m.t + MUZZLE_NUDGE);
      const id = ballistics.fire(origin, dir, sim.gravity / SIM_GRAVITY_REF);
      // momentum: the round's at its muzzle speed (cells/s)
      const dv = dir.clone().multiplyScalar(-ROUND_MASS_KG * ROUND_SPEED / BODY_MASS_KG);
      if (ctx.player.onGround) dv.set(0, Math.max(dv.y, 0), 0);
      ctx.player.applyImpulse(dv);
      lastShot = { id, origin: origin.clone(), dir: dir.clone(), cell: m.cell.clone(), dv: dv.clone() };
      povEvents.emit('gun:fire', { origin: origin.clone(), dir: dir.clone(), muzzleWorld: muzzleWorld(ctx.eye) });
    }

    function drive(now) {
      raf = 0;
      if (selected || !ballistics.count) return;
      const dt = rafAt ? (now - rafAt) / MS_PER_S : 0;
      rafAt = now;
      ballistics.update({ sim: env.getSim(), dt, stepsPerFrame: lastSteps });
      raf = requestAnimationFrame(drive);
    }

    return {
      update(ctx) {
        selected = true;
        time += ctx.dt;
        lastSteps = ctx.stepsPerFrame;
        model.hand.visible = true;
        model.rig.update(ctx);
        if (ctx.primaryPressed && time >= nextFire) {
          nextFire = time + FIRE_INTERVAL;
          fire(ctx);
        }
        ballistics.update(ctx);
      },
      deselect() {
        model.hand.visible = false;
        selected = false;
        if (ballistics.count && !raf) { rafAt = 0; raf = requestAnimationFrame(drive); }
      },
      status: () => null,
      // for checks: the last shot ({ id, origin, dir, cell (muzzle), dv (recoil) }) and the rounds
      get lastShot() { return lastShot; },
      get ballistics() { return ballistics; },
      get muzzle() { return model.muzzle; }, // the viewmodel's muzzle point (Object3D)
      muzzleWorld: model.muzzleWorld,        // (out?) → its world position now
      dispose() {
        if (raf) cancelAnimationFrame(raf);
        ballistics.dispose();
        model.dispose();
      },
    };
  },
};
