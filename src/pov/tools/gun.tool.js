import * as THREE from 'three';
import { ELEMENTS } from '../../elements.js';
import { BODY_WIDTH, BODY_HEIGHT, BODY_DENS } from '../constants.js';
import { glowTexture } from '../../shaders/povTools.js';
import { createBallistics, ROUND_SPEED, ROUND_SLUG, MAX_ROUNDS } from '../ballistics.js';
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
// Recoil conserves momentum: Δv_body = m_round·v_round / m_body, masses on the
// element table's density scale (DENS × cells), v the round's muzzle speed in
// cells/s. A one-cell round is a 30 cm block of metal at 360 m/s, so that kick
// is enormous; the player's speed cap (player.js MAX_SPEED) clamps what it
// does to the body. Standing, the ground takes it the way it takes any impact
// (solids are immovable in the sim): friction the sideways part, the floor the
// downward part. Only an upward kick (shooting at your feet: a rocket jump) or
// a shot fired in the air or water moves you.
//
// Events (docs/pov.md): gun:fire, gun:dry here; round:move, round:end and
// impact from ballistics.js.

const FIRE_INTERVAL = 0.35;        // s between shots
const SPAWN_SEARCH = 16;           // cells walked along the ray looking for the muzzle cell
const MUZZLE_NUDGE = 1e-3;         // cells past the muzzle cell's entry face the round starts
const ROUNDS_IN_FLIGHT_MAX = MAX_ROUNDS;   // rounds the gun keeps in the air at once (the trace pass's width)
const ROUND_CELLS = 1;             // a round is one cell of slug
const ROUND_MASS = ELEMENTS[ROUND_SLUG].dens * ROUND_CELLS;
const BODY_MASS = BODY_DENS * BODY_WIDTH * BODY_WIDTH * BODY_HEIGHT;
const SIM_GRAVITY_REF = 0.025;     // cells/step², the sim's default gravity (sim.js GRAVITY_DEFAULT): rounds fall at 1 g there
const MS_PER_S = 1000;

// viewmodel, in cells (camera space: +x right, +y up, −z forward). The recoil
// is the viewmodel rig's spring (viewmodel.js), thrown by gun:fire and gun:dry.
const GUN_POS = [0.5, -0.45, -1.5];
const MUZZLE = [0, 0.1, -0.66];    // cells from the model's centre to the end of the bore
const FLASH_TIME = 0.06;           // s the muzzle flash shows
const FLASH_SIZE = 0.7;            // cells
const FLASH_COLOR = 0xffc870;
const FLASH_SPIN = 22;            // rad/s the flash sprite turns, so no two flashes look alike
const DRY_TOAST_INTERVAL = 1.5;    // s between "blocked" toasts

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
<path d="M3 8h15l1-2h2v5h-6l-1 2h-3l-1 5H5l1-5H3z"/></svg>`;

// The held gun: the Kenney model (models.js, async) on a hand of the
// viewmodel rig, a muzzle point at the end of its bore and the flash there.
function buildModel(env) {
  const rig = viewmodelRig(env);
  const hand = rig.hand(GUN_POS);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(...MUZZLE);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: FLASH_COLOR, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  flash.scale.setScalar(FLASH_SIZE);
  flash.visible = false;
  muzzle.add(flash);
  hand.add(muzzle);
  const mesh = attachModel(hand, 'gun');
  return {
    rig, hand, muzzle, flash,
    // the muzzle in world space (for gun:fire's muzzleWorld); valid before the mesh arrives
    muzzleWorld: (out = new THREE.Vector3()) => { muzzle.updateWorldMatrix(true, false); return muzzle.getWorldPosition(out); },
    dispose() { mesh.dispose(); flash.material.map.dispose(); flash.material.dispose(); hand.removeFromParent(); },
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
  desc: 'Fires a metal round that flies fast, drops a little and smashes what it hits. Kicks back hard.',
  create(env) {
    const model = buildModel(env);
    const ballistics = createBallistics({ renderer: env.renderer });
    ballistics.prepare(env.getSim());
    let time = 0, nextFire = 0, flashUntil = -1, nextDryToast = 0;
    let lastShot = null;
    // While the gun is put away the toolbelt stops calling update, but rounds
    // already in the air keep flying: this drives them until they land, at the
    // last frame's step rate (a round lives a fraction of a second).
    let selected = false, lastSteps = 0, raf = 0, rafAt = 0;

    const dry = () => {
      povEvents.emit('gun:dry', {});
      if (time >= nextDryToast) { env.hud?.toast?.('Click. The muzzle is blocked.'); nextDryToast = time + DRY_TOAST_INTERVAL; }
    };

    // the muzzle in world space: the viewmodel's muzzle (or flash) if it has one, else the eye
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
      const dv = dir.clone().multiplyScalar(-ROUND_MASS * ROUND_SPEED / BODY_MASS);
      if (ctx.player.onGround) dv.set(0, Math.max(dv.y, 0), 0);
      ctx.player.applyImpulse(dv);
      flashUntil = time + FLASH_TIME;
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
        // the flash (the rig's spring does the kick, thrown by gun:fire)
        model.flash.visible = time < flashUntil;
        model.flash.material.rotation = time * FLASH_SPIN;
      },
      deselect() {
        model.hand.visible = false; model.flash.visible = false;
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
