import * as THREE from 'three';
import { ROUND_SPEED, MAX_ROUNDS, gravityScale } from '../ballistics.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { trigger } from './action.js';
import { muzzleCell } from './transfer.js';

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

const FIRE_INTERVAL = 0.35;        // s between shots (one per click: action.js trigger, no hold)
const MUZZLE_NUDGE = 1e-3;         // cells past the muzzle cell's entry face the round starts
const ROUNDS_IN_FLIGHT_MAX = MAX_ROUNDS;   // rounds the gun keeps in the air at once (the trace pass's width)
const ROUND_MASS_KG = 0.008;        // kg, a 9 mm pistol bullet (the 360 m/s round of ballistics.js)
const BODY_MASS_KG = 70;           // kg, the player

// viewmodel, in cells (camera space: +x right, +y up, −z forward). The recoil
// is the viewmodel rig's spring and the view punch (viewmodel.js HIT.GUN, HIT.DRY).
const GUN_POS = [0.5, -0.45, -1.5];
const MUZZLE = [0, 0.094, -0.625];    // cells from the model's centre to the end of the bore

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
<path d="M3 8h15l1-2h2v5h-6l-1 2h-3l-1 5H5l1-5H3z"/></svg>`;

// The held gun: the model (models.js) on a hand of the
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

export default {
  key: 'GUN', name: 'Gun', slot: 4, icon: ICON,
  desc: 'Fires a metal round that flies fast, drops a little and smashes what it hits.',
  create(env) {
    const model = buildModel(env);
    const ballistics = env.ballistics;   // the toolbelt's: it keeps rounds flying after the gun is put away
    const button = trigger(FIRE_INTERVAL, { hold: false });
    let lastShot = null;

    const dry = () => {
      povEvents.emit('gun:dry', {});
      model.rig.hit(HIT.DRY);
      env.feedback?.notice('Click. The muzzle is blocked.');
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
      const id = ballistics.fire(origin, dir, gravityScale(sim));
      // momentum: the round's at its muzzle speed (cells/s)
      const dv = dir.clone().multiplyScalar(-ROUND_MASS_KG * ROUND_SPEED / BODY_MASS_KG);
      if (ctx.player.onGround) dv.set(0, Math.max(dv.y, 0), 0);
      ctx.player.applyImpulse(dv);
      lastShot = { id, origin: origin.clone(), dir: dir.clone(), cell: m.cell.clone(), dv: dv.clone() };
      model.rig.hit(HIT.GUN);
      povEvents.emit('gun:fire', { origin: origin.clone(), dir: dir.clone(), muzzleWorld: muzzleWorld(ctx.eye) });
    }

    return {
      update(ctx) {
        model.hand.visible = true;
        model.rig.update(ctx);
        if (button.ready(ctx)) {
          button.fire();
          fire(ctx);
        }
      },
      deselect() { model.hand.visible = false; },
      status: () => null,
      // rounds in the air keep flying where they are in the world (docs/scaling.md D11)
      windowShifted(dx, dz) {
        ballistics.windowShifted(dx, dz);
        for (const v of lastShot ? [lastShot.origin, lastShot.cell] : []) { v.x -= dx; v.z -= dz; }
      },
      // for checks: the last shot ({ id, origin, dir, cell (muzzle), dv (recoil) }) and the rounds
      get lastShot() { return lastShot; },
      get ballistics() { return ballistics; },
      get muzzle() { return model.muzzle; }, // the viewmodel's muzzle point (Object3D)
      muzzleWorld: model.muzzleWorld,        // (out?) → its world position now
      dispose() { model.dispose(); },
    };
  },
};
