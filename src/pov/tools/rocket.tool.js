import * as THREE from 'three';
import { CELL_METERS } from '../vitals.js';
import { ROCKET } from '../../shaders/povTools.js';
import { povGpu } from '../gpu.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { trigger, launcher } from './action.js';
import { gear } from './catalog.js';
import { haloSplash } from '../frag.js';
import { haloMatch, wu, HALO_HEALTH, HALO_SHIELD } from '../halo.js';

// Rocket launcher: Team Fortress 2's (the Soldier's): a rocket a click, 0.8 s
// apart, that flies dead straight at 1100 HU/s (≈ 21 m/s: slow enough to see
// and to dodge) on the shared projectiles (ballistics.js, no gravity) and goes
// off where it strikes: a cell, or a body (an NPC). The blast is one edit
// (shaders/povTools.js rocketWGSL): a crater, a fireball and a wave of air
// pressure the engine carries from there, which throws loose matter and
// bodies, yours included, and hurts them (vitals.js, as a bomb does). Nothing
// is added to the world.
//
// Events: tool:action 'fire'; blast { point } where it goes off (sound,
// shake, fireball); round:move / round:end with kind 'rocket' while it flies
// (vfx.js draws its smoke trail; this tool draws the rocket).

const SPEED = 21 / CELL_METERS;         // cells/s (TF2's 1100 HU/s)
const REFIRE = 0.8;                     // s between rockets (TF2's rocket launcher)
const KIND = 'rocket';
const STANDOFF = 1;                     // cells out of the struck face the blast is centred: in the air in front of it
// In a Halo match a rocket also does Halo's splash (frag.js haloSplash): Halo 3's rocket kills a
// full-shielded Spartan it lands beside and pops shields farther out. Halopedia has no figures for
// it ("H3:Rocket Launcher" is a stub), so the radii are by eye, and the damage is just enough for that.
const HALO_SPLASH = {
  inner: HALO_HEALTH + HALO_SHIELD,     // points: a kill from a full shield...
  outer: HALO_SHIELD,                   // ...falling to a shield pop at the edge
  rInner: wu(0.75), rOuter: wu(2),      // cells (≈ 7.6 and 20: 2.3 m and 6 m)
  vs: 1,
  cause: 'Blown up',                    // as the blast's own (vitals.js), so the feed reads the same
};

// viewmodel, in cells (camera space: +x right, +y up, −z forward): on the shoulder
const HELD_POS = [0.62, -0.55, -1.6];
const MUZZLE = [0, 0.15, -0.63];        // cells from the model's centre to the tube's mouth

export default {
  ...gear('ROCKET'),
  create(env) {
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(...MUZZLE);
    hand.add(muzzle);
    const heldMesh = attachModel(hand, 'rpg');
    const button = trigger(REFIRE);
    let lastBlast = null, frame = 0;

    // rockets in flight, drawn where the shared projectiles say they are (also while the launcher isn't held),
    // pointed along their flight
    const fwd = new THREE.Vector3(0, 0, -1), heading = new THREE.Vector3();
    const launch = launcher(env, {
      kind: KIND, model: 'rocket', refuse: 'No room to fire', rig, hit: HIT.ROCKET, action: 'fire', hand, button, tumble: 0,
      onMove({ model }, { from, to }) {
        if (heading.subVectors(to, from).lengthSq() > 0) model.obj.quaternion.setFromUnitVectors(fwd, heading.normalize());
      },
    });

    // the blast, STANDOFF cells out of the struck face (or where it met a body)
    function explode({ sim, hit, normal }) {
      const center = hit.point.clone().addScaledVector(normal, STANDOFF);
      const r = ROCKET.PULSE_RADIUS;   // the farthest the blast reaches
      povGpu(sim).edit('povRocket', sim.touchCentres([center.x - r, center.y - r, center.z - r], [center.x + r, center.y + r, center.z + r]), {
        center, frame: ++frame,
      });
      lastBlast = { point: center.clone(), id: hit.id };
      povEvents.emit('blast', { point: center.clone() });
      if (haloMatch()) haloSplash(center, HALO_SPLASH);
    }

    function fire(ctx) {
      const shot = launch.fire(ctx, { speed: SPEED, onStrike: explode, bodies: true });
      if (!shot) return false;
      const { origin, dir } = shot;
      muzzle.updateWorldMatrix(true, false);
      const muzzleWorld = env.getMuzzleWorld?.('ROCKET')
        ?? (povEvents.actor ? null : muzzle.getWorldPosition(new THREE.Vector3()));
      povEvents.emit('gun:fire', { origin: origin.clone(), dir: dir.clone(), muzzleWorld, gun: 'ROCKET', sound: { voice: 'swoosh', rate: 0.6, gain: 1.6, thump: 1.5 } });
      return true;
    }

    return {
      update: (ctx) => launch.update(ctx, fire),
      deselect: launch.deselect,
      status: () => null,
      get lastBlast() { return lastBlast; },   // for checks
      windowShifted(dx, dz) { if (lastBlast) { lastBlast.point.x -= dx; lastBlast.point.z -= dz; } },   // (docs/scaling.md D11)
      dispose() {
        launch.dispose();
        heldMesh.dispose();
        hand.removeFromParent();
      },
    };
  },
};
