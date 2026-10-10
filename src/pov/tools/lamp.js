import * as THREE from 'three';
import { HAND_REACH } from '../constants.js';
import { torchFireFrag, toolPass, TORCH_FIRE } from '../../shaders/povTools.js';
import { gravityScale } from '../ballistics.js';
import { THROW_SPEED } from './bomb.tool.js';
import { lamps } from '../lamps.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { trigger, toolDt } from './action.js';
import { faceNormal, muzzleCell } from './transfer.js';

// A lamp you carry (the torch, the lantern): it lights the world around you
// (a point light with traced shadows, pov/lamps.js → shaders/gfx/lighting.js
// lampLight), and right-click throws it. It flies on the shared projectiles at
// the bomb's overhand throw, lit all the way, and lies where it lands, still
// lit; a fresh one is in hand once you can throw again. At most PROPS_MAX lie
// about per lamp tool (the oldest goes first).
//
// spec.burn: a burning lamp (the torch). Lying, it burns for burn.seconds and
// licks a small engine flame up off its head (shaders/povTools.js TORCH_FIRE),
// which lights wood and plants that touch it; held, left-click touches the
// flame to what you aim at within reach. Without burn (the lantern) it never
// goes out or breaks, and left-click switches it off and on.
//
// Events (tool = key in lower case): tool:action 'throw', 'land' (point),
// 'toggle'; round:move / round:end with kind = tool while it flies.
//
//   export default lampTool({ ...gear(KEY), light: { color, intensity, range, flicker },
//     burn: { seconds } | null, pose: { pos, yaw } });

const THROW_REFIRE = 0.8;      // s between throws (the bomb's)
const TOUCH_REFIRE = 0;        // s: holding left-click keeps the torch's flame on what it touches
const PROPS_MAX = 6;           // lamps lying about per tool
const PROP_LIFT = 0.5;         // cells off the struck face a landed lamp sits (in the air in front of it)
const PROP_EMBED = 1.5;        // cells back from a lying torch, into what it's stuck in, its flame starts
const LIGHT_LIFT = 0.6;        // cells above a landed lamp its light hangs (its head, not its foot)
const FIRE_INTERVAL = 0.15;    // s between a lying torch's flame passes
const TUMBLE = 0.4;            // rad a thrown lamp turns per frame it's drawn
const MS_PER_S = 1000;
const UP = new THREE.Vector3(0, 1, 0);
let instances = 0;             // lamp tools made (the player's and each NPC kit's): their lamps' keys stay apart

// A random flicker for a flame's light: a sum of incommensurate sines (no
// allocations, smooth frame to frame), mean 1, ±share.
const FLICKER_RATES = [7.3, 13.1, 23.7];
const flickerAt = (t, share) => 1 + share * FLICKER_RATES.reduce((s, r, i) => s + Math.sin(t * r + i * 1.7), 0) / FLICKER_RATES.length;

export function lampTool({ key, name, model: modelKey, desc, light, burn = null, pose }) {
  const tool = key.toLowerCase();
  const color = light.color.map((c) => c * light.intensity);

  return {
    key, name, model: modelKey, desc,
    create(env) {
      const rig = viewmodelRig(env);
      const hand = rig.hand(pose.pos);
      const held = new THREE.Group();
      held.rotation.y = pose.yaw ?? 0;
      hand.add(held);
      const heldMesh = attachModel(held, modelKey);
      const heldFlame = heldMesh.obj.getObjectByName('flame');
      const thrower = trigger(THROW_REFIRE, { button: 'secondary', hold: false });
      const toucher = trigger(TOUCH_REFIRE);
      const fire = burn ? toolPass(torchFireFrag, () => ({
        uNozzle: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() },
        uReach: { value: 0 }, uDt: { value: 0 }, uFrame: { value: 0 },
      })) : null;
      const tag = `${tool}${++instances}`;
      const heldKey = `${tag}:held`;
      let on = true, frame = 0, fireWait = 0, nextProp = 1;
      const scratch = new THREE.Vector3(), lightColor = [0, 0, 0];

      const shine = (k, pos, held_ = false) => {
        const f = light.flicker ? flickerAt(performance.now() / MS_PER_S + (held_ ? 0 : pos.x), light.flicker) : 1;
        for (let i = 0; i < 3; i++) lightColor[i] = color[i] * f;
        lamps.set(k, { pos, range: light.range, color: lightColor, held: held_ });
      };

      // ---- in flight: drawn and lit where the shared projectiles say
      const world = new THREE.Group();
      world.name = `pov-${tool}s`;
      env.scene.add(world);
      const toWorld = (g, out) => out.copy(g).multiplyScalar(env.getScale()).add(env.getVolume().position);
      const flying = new Map();   // round id → model
      const props = [];           // lying lamps: { id, pos, normal, model, until, timer }
      const offs = [
        povEvents.on('round:move', ({ id, kind, to }) => {
          if (kind !== tool || !flying.has(id)) return;
          let m = flying.get(id);
          if (!m) { m = attachModel(world, modelKey, null, { arm: false }); flying.set(id, m); }
          m.obj.scale.setScalar(env.getScale());
          toWorld(to, m.obj.position);
          m.obj.rotation.x += TUMBLE;
          if (on) shine(`${tag}:fly:${id}`, to);
        }),
        povEvents.on('round:end', ({ id, kind }) => {
          if (kind !== tool || !flying.has(id)) return;
          flying.get(id)?.dispose();
          flying.delete(id);
          lamps.remove(`${tag}:fly:${id}`);
        }),
      ];

      // ---- lying where it landed
      function removeProp(p) {
        const i = props.indexOf(p);
        if (i >= 0) props.splice(i, 1);
        clearTimeout(p.timer);
        p.model.dispose();
        lamps.remove(`${tag}:prop:${p.id}`);
      }
      function placeProp(p) {
        toWorld(p.pos, p.model.obj.position);
        p.model.obj.scale.setScalar(env.getScale());
        // a torch stands out of the face it stuck in; a lantern sits upright
        p.model.obj.quaternion.setFromUnitVectors(UP, burn ? p.normal : UP);
        p.light = p.pos.clone().addScaledVector(burn ? p.normal : UP, LIGHT_LIFT);
        if (p.lit) shine(`${tag}:prop:${p.id}`, p.light);
      }
      function land({ hit, normal }) {
        const p = {
          id: nextProp++, pos: hit.point.clone().addScaledVector(normal, PROP_LIFT), normal: normal.clone(),
          model: attachModel(world, modelKey, null, { arm: false }), lit: on, timer: 0,
        };
        // a torch burns out (and is gone); a lantern shines until it's one too many
        if (burn) p.timer = setTimeout(() => removeProp(p), burn.seconds * MS_PER_S);
        props.push(p);
        placeProp(p);
        while (props.length > PROPS_MAX) removeProp(props[0]);
        povEvents.emit('tool:action', { tool, action: 'land', point: p.pos.clone() });
      }

      // a flame pass: from `at` along `dir`, `reach` cells (the torch's head, lying or touched to something)
      function flame(sim, at, dir, reach, dt) {
        const mat = fire(sim);
        const u = mat.uniforms;
        u.uNozzle.value.copy(at);
        u.uDir.value.copy(dir);
        u.uReach.value = reach;
        u.uDt.value = dt;
        u.uFrame.value = ++frame;
        sim.pass(mat);
      }

      function throwIt(ctx) {
        const sim = ctx.sim ?? env.getSim();
        const dir = ctx.dir.clone().normalize();
        const m = muzzleCell(ctx.eye, dir, ctx.player.pos, sim.g);
        if (!m) { env.feedback?.refuse('No room to throw'); return false; }
        const origin = ctx.eye.clone().addScaledVector(dir, m.t);
        const id = env.ballistics.fire(origin, dir, gravityScale(sim), { speed: THROW_SPEED, carry: ctx.player.vel, kind: tool, onStrike: land });
        if (!id) return false;
        flying.set(id, null);
        rig.hit(HIT.THROW);
        povEvents.emit('tool:action', { tool, action: 'throw' });
        return true;
      }

      return {
        update(ctx) {
          hand.visible = true;
          rig.update(ctx);
          if (thrower.ready(ctx) && throwIt(ctx)) thrower.fire();
          const inHand = thrower.waiting <= 0;   // a fresh one once you can throw again
          heldMesh.obj.visible = inHand;
          if (heldFlame) heldFlame.scale.y = flickerAt(performance.now() / MS_PER_S, light.flicker ?? 0);
          if (!burn && ctx.primaryPressed) { on = !on; povEvents.emit('tool:action', { tool, action: 'toggle' }); }
          if (inHand && on) shine(heldKey, ctx.eye, true);
          else lamps.remove(heldKey);
          // the torch touched to what you aim at, within reach
          if (burn && inHand && toucher.ready(ctx) && ctx.primary && ctx.aim?.valid && ctx.aim.dist <= HAND_REACH && ctx.aim.cell.y >= 0) {
            const n = faceNormal(ctx.aim.face);
            flame(ctx.sim ?? env.getSim(), scratch.copy(ctx.aim.cell).addScalar(0.5).add(n), n.clone().negate(), 1, toolDt(ctx));
            toucher.fire();
          }
        },
        // every frame in first person, held or not: lying torches burn
        tick(ctx) {
          if (!burn || !props.length) return;
          fireWait -= ctx.dt;
          if (fireWait > 0) return;
          fireWait = FIRE_INTERVAL;
          const sim = ctx.sim ?? env.getSim();
          // from inside what it's stuck in, so the flame heats that as well as licking out of it
          for (const p of props) flame(sim, scratch.copy(p.pos).addScaledVector(p.normal, -PROP_EMBED), p.normal, TORCH_FIRE.LENGTH + PROP_EMBED, FIRE_INTERVAL);
        },
        deselect() { hand.visible = false; thrower.reset(); lamps.remove(heldKey); },
        status: () => null,
        // (docs/scaling.md D11) lying lamps stay put in the world
        windowShifted(dx, dz) { for (const p of props) { p.pos.x -= dx; p.pos.z -= dz; placeProp(p); } },
        // the world was replaced (a scene load, undo, a new grid): what lay in it is gone
        worldReplaced() { while (props.length) removeProp(props[0]); },
        get props() { return props; },   // for checks
        get on() { return on; },
        dispose() {
          offs.forEach((off) => off());
          while (props.length) removeProp(props[0]);
          flying.forEach((m, id) => { m?.dispose(); lamps.remove(`${tag}:fly:${id}`); });
          lamps.remove(heldKey);
          world.removeFromParent();
          fire?.dispose();
          heldMesh.dispose();
          hand.removeFromParent();
        },
      };
    },
  };
}
