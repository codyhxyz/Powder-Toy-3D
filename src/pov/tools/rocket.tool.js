import * as THREE from 'three';
import { CELL_METERS } from '../vitals.js';
import { rocketFrag, toolPass } from '../../shaders/povTools.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { trigger } from './action.js';
import { gear } from './catalog.js';
import { muzzleCell } from './transfer.js';

// Rocket launcher: Team Fortress 2's (the Soldier's): a rocket a click, 0.8 s
// apart, that flies dead straight at 1100 HU/s (≈ 21 m/s: slow enough to see
// and to dodge) on the shared projectiles (ballistics.js, no gravity) and goes
// off where it strikes: a cell, or a body (an NPC). The blast is one pass
// (shaders/povTools.js rocketFrag): a crater, a fireball and a wave of air
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
    const pass = toolPass(rocketFrag, () => ({ uCenter: { value: new THREE.Vector3() }, uFrame: { value: 0 } }));
    const button = trigger(REFIRE);
    let lastBlast = null, frame = 0;

    // rockets in flight, drawn where the shared projectiles say they are (also while the launcher isn't held)
    const flying = new Map();   // round id → model, for the rockets this one fired
    const mine = new Set();     // their ids (another toolbelt's are its own to draw)
    const world = new THREE.Group();
    world.name = 'pov-rockets';
    env.scene.add(world);
    const toWorld = (g, out) => out.copy(g).multiplyScalar(env.getScale()).add(env.getVolume().position);
    const fwd = new THREE.Vector3(0, 0, -1), heading = new THREE.Vector3();
    const offs = [
      povEvents.on('round:move', ({ id, kind, from, to }) => {
        if (kind !== KIND || !mine.has(id)) return;
        let m = flying.get(id);
        if (!m) { m = attachModel(world, 'rocket', null, { arm: false }); flying.set(id, m); }
        m.obj.scale.setScalar(env.getScale());
        toWorld(to, m.obj.position);
        if (heading.subVectors(to, from).lengthSq() > 0) m.obj.quaternion.setFromUnitVectors(fwd, heading.normalize());
        globalThis.__app?.requestRender?.();
      }),
      povEvents.on('round:end', ({ id, kind }) => {
        if (kind !== KIND || !mine.has(id)) return;
        mine.delete(id);
        flying.get(id)?.dispose();
        flying.delete(id);
      }),
    ];

    // the blast, STANDOFF cells out of the struck face (or where it met a body)
    function explode({ sim, hit, normal }) {
      const center = hit.point.clone().addScaledVector(normal, STANDOFF);
      const mat = pass(sim);
      mat.uniforms.uCenter.value.copy(center);
      mat.uniforms.uFrame.value = ++frame;
      sim.pass(mat);
      lastBlast = { point: center.clone(), id: hit.id };
      povEvents.emit('blast', { point: center.clone() });
    }

    function fire(ctx) {
      const sim = ctx.sim ?? env.getSim();
      const dir = ctx.dir.clone().normalize();
      const m = muzzleCell(ctx.eye, dir, ctx.player.pos, sim.g);
      if (!m) { env.feedback?.refuse('No room to fire'); return false; }
      const origin = ctx.eye.clone().addScaledVector(dir, m.t);
      const id = env.ballistics.fire(origin, dir, 0, { speed: SPEED, kind: KIND, onStrike: explode, bodies: true });
      if (!id) return false;
      mine.add(id);
      rig.hit(HIT.ROCKET);
      muzzle.updateWorldMatrix(true, false);
      povEvents.emit('tool:action', { tool: 'rocket', action: 'fire' });
      povEvents.emit('gun:fire', { origin: origin.clone(), dir: dir.clone(), muzzleWorld: muzzle.getWorldPosition(new THREE.Vector3()), gun: 'ROCKET', sound: { voice: 'swoosh', rate: 0.6, gain: 1.6, thump: 1.5 } });
      return true;
    }

    return {
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
        if (button.ready(ctx) && fire(ctx)) button.fire();
      },
      deselect() { hand.visible = false; button.reset(); },
      status: () => null,
      get lastBlast() { return lastBlast; },   // for checks
      windowShifted(dx, dz) { if (lastBlast) { lastBlast.point.x -= dx; lastBlast.point.z -= dz; } },   // (docs/scaling.md D11)
      dispose() {
        offs.forEach((off) => off());
        flying.forEach((m) => m.dispose());
        world.removeFromParent();
        pass.dispose();
        heldMesh.dispose();
        hand.removeFromParent();
      },
    };
  },
};
