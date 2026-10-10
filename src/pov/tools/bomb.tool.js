import * as THREE from 'three';
import { ELEMENTS, E } from '../../elements.js';
import { CELL_M } from '../../scale.js';
import { SEED_MAX } from '../../shaders/common.js';
import { gravityScale } from '../ballistics.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { trigger } from './action.js';
import { Load, cellsNear, ballRadius, muzzleCell } from './transfer.js';

// Bomb (slot 9): left-click throws a pipe bomb. It flies on the shared
// projectiles (ballistics.js) at a real overhand throw's speed, plus yours, and
// falls at 1 g; where it strikes it becomes its charge: CHARGE cells of
// GUNPOWDER packed into the air in front of the struck face, with its detonator
// (the cell nearest the middle) at the powder's ignition point. From there it's
// the engine's blast (react.js): the detonator goes off, its neighbours catch
// from it, and the burn runs through the charge as a wave whose blasts stack.
// That wave is what makes it strong: set every cell off in the same step and
// each adds only its own GUNPOWDER_P (60), less than wood's 100 (the CPU port,
// ui/tiles/engine.js, shows no wood breaking that way and the wave breaking
// it). A 5³ charge peaks near 200 at its edge and is still ~100 four cells out
// (physics.js, P_BREAK_PER_HARD): it smashes wood and glass around it, chips
// rock right beside it, and metal holds.
//
// Events: tool:action 'throw'; blast { point } when the charge is set (sound,
// shake); round:move / round:end with kind 'bomb' while it flies.

export const THROW_SPEED = 18 / CELL_M; // cells/s: a good overhand throw (18 m/s)
const REFIRE = 0.8;                     // s between throws while held
const CHARGE = 125;                     // cells of gunpowder (a 5³ charge)
const CHARGE_SLACK = 2.5;               // candidate cells per charge cell (some are full)
const KIND = 'bomb';
const TUMBLE = 0.4;                     // rad the thrown bomb turns per frame it's drawn

// viewmodel, in cells (camera space)
const HELD_POS = [0.6, -0.55, -1.3];
const HELD_YAW = 0.5;                   // rad, turned across the view

export default {
  key: 'BOMB', name: 'Bomb', slot: 9, model: 'bomb',
  desc: 'Throws a pipe bomb that goes off where it lands: breaks wood and glass, shoves and burns.',
  create(env) {
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    const held = new THREE.Group();
    held.rotation.y = HELD_YAW;
    hand.add(held);
    const heldMesh = attachModel(held, 'bomb');
    const button = trigger(REFIRE);
    let lastBlast = null;

    // bombs in flight, drawn where the shared projectiles say they are (also while the bomb isn't held)
    const flying = new Map();   // round id → model, for the bombs this one threw
    const mine = new Set();     // ids of the bombs this one threw (another toolbelt's are its own to draw)
    const world = new THREE.Group();
    world.name = 'pov-bombs';
    env.scene.add(world);
    const toWorld = (g, out) => out.copy(g).multiplyScalar(env.getScale()).add(env.getVolume().position);
    const offs = [
      povEvents.on('round:move', ({ id, kind, to }) => {
        if (kind !== KIND || !mine.has(id)) return;
        let m = flying.get(id);
        if (!m) { m = attachModel(world, 'bomb', null, { arm: false }); flying.set(id, m); }
        m.obj.scale.setScalar(env.getScale());
        toWorld(to, m.obj.position);
        m.obj.rotation.x += TUMBLE;
        globalThis.__app?.requestRender?.();
      }),
      povEvents.on('round:end', ({ id, kind }) => {
        if (kind !== KIND || !mine.has(id)) return;
        mine.delete(id);
        flying.get(id)?.dispose();
        flying.delete(id);
      }),
    ];

    // the charge: CHARGE cells of gunpowder at its ignition point, in the air in front of the struck face
    function detonate({ hit, normal }) {
      const charge = new Load(CHARGE);
      const powder = ELEMENTS[E.GUNPOWDER];
      // put() places the newest cell nearest the middle: the detonator goes in last
      for (let i = 0; i < CHARGE; i++) {
        const T = i === CHARGE - 1 ? powder.ignite : powder.temp;
        charge.cells.push([E.GUNPOWDER, T, powder.life, Math.random() * SEED_MAX]);
      }
      const r = ballRadius(CHARGE);
      const center = hit.point.clone().addScaledVector(normal, r);
      const sim = env.getSim();
      const blast = { point: center.clone(), id: hit.id, landed: null };
      lastBlast = blast;
      const p = env.transfer.put(charge, { cells: cellsNear(center, ballRadius(CHARGE * CHARGE_SLACK), sim.g), vel: new THREE.Vector3() });
      if (p) p.then((n) => { blast.landed = n; });
      else blast.landed = 0;
      povEvents.emit('blast', { point: center.clone() });
    }

    function throwBomb(ctx) {
      const sim = ctx.sim ?? env.getSim();
      const dir = ctx.dir.clone().normalize();
      const m = muzzleCell(ctx.eye, dir, ctx.player.pos, sim.g);
      if (!m) { env.feedback?.refuse('No room to throw'); return false; }
      const origin = ctx.eye.clone().addScaledVector(dir, m.t);
      const id = env.ballistics.fire(origin, dir, gravityScale(sim), {
        speed: THROW_SPEED, carry: ctx.player.vel, kind: KIND, onStrike: detonate,
      });
      if (!id) return false;
      mine.add(id);
      rig.hit(HIT.THROW);
      povEvents.emit('tool:action', { tool: 'bomb', action: 'throw' });
      return true;
    }

    return {
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
        if (button.ready(ctx) && throwBomb(ctx)) button.fire();
        heldMesh.obj.visible = button.waiting <= 0;   // a fresh one in hand once you can throw again
      },
      deselect() { hand.visible = false; button.reset(); },
      get lastBlast() { return lastBlast; },   // for checks
      dispose() {
        offs.forEach((off) => off());
        flying.forEach((m) => m.dispose());
        world.removeFromParent();
        heldMesh.dispose();
        hand.removeFromParent();
      },
    };
  },
};
