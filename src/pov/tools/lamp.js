import * as THREE from 'three';
import { HAND_REACH } from '../constants.js';
import { torchFireFrag, toolPass, TORCH_FIRE } from '../../shaders/povTools.js';
import { gravityScale } from '../ballistics.js';
import { THROW_SPEED } from './bomb.tool.js';
import { lamps } from '../lamps.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { createFlame } from '../flame.js';
import { viewmodelRig, HIT, VIEWMODEL_GLOW_LAYER } from '../viewmodel.js';
import { trigger, toolDt } from './action.js';
import { faceNormal, muzzleCell } from './transfer.js';

// A lamp you carry (the torch, the lantern): it lights the world around you
// (a point light with traced shadows, pov/lamps.js → shaders/gfx/lighting.js
// lampLight), and right-click throws it. It flies on the shared projectiles at
// the bomb's overhand throw, lit all the way, and lies where it lands, still
// lit; a fresh one is in hand once you can throw again. At most PROPS_MAX lie
// about per lamp tool (the oldest goes first).
//
// In hand, its light hangs at your side, not at your eye (a light at the eye
// lights everything flat and casts no shadow you can see), but inside the
// body's box, so it is never inside a wall you're facing.
//
// spec.burn: a burning lamp (the torch). Its flame is alive (flame.js): it
// rises whichever way the torch is held, trails when you swing it or run,
// flickers with the light, lights the hand that holds it and throws off embers
// (vfx.js, event 'torch:burn'). Lying, it burns for burn.seconds, its flame's
// heat (shaders/povTools.js TORCH_FIRE) going into what it's stuck in and what
// touches its head, which lights wood and plants; held, left-click touches the
// flame to what you aim at within reach. Without burn (the lantern) it never goes out
// or breaks, and left-click switches it off and on.
//
// Events (tool = key in lower case): tool:action 'throw', 'land' (point),
// 'toggle'; round:move / round:end with kind = tool while it flies;
// 'torch:burn' { at (world), vel (world units/s), dt } for each flame drawn.
//
//   export default lampTool({ ...gear(KEY), light: { color, intensity, range, flicker },
//     burn: { seconds } | null, pose: { pos, yaw } });

const THROW_REFIRE = 0.8;      // s between throws (the bomb's)
const TOUCH_REFIRE = 0;        // s: holding left-click keeps the torch's flame on what it touches
const PROPS_MAX = 6;           // lamps lying about per tool
const PROP_LIFT = 0.5;         // cells off the struck face a landed lamp sits (in the air in front of it)
const PROP_EMBED = 1.5;        // cells back from a lying torch, into what it's stuck in, its flame starts
const LIGHT_LIFT = 0.6;        // cells above a landed lamp its light hangs (its head, not its foot)
// where the held lamp's light hangs from the eye, in cells: right, up, forward (level with the ground).
// Within BODY_WIDTH / 2 (0.8) of the eye sideways, so it's inside the body's box.
const HELD_LIGHT = [0.55, 0.25, 0.45];
const FIRE_INTERVAL = 0.15;    // s between a lying torch's flame passes
const TUMBLE = 0.4;            // rad a thrown lamp turns per frame it's drawn
const MS_PER_S = 1000;
const UP = new THREE.Vector3(0, 1, 0);
// the live flame on the torch's head, in model units (models.js: the head is about 0.2 across)
const FLAME_WIDTH = 0.16;      // half-width at its widest
const FLAME_HEIGHT = 0.85;
const FLAME_HEART = 0.3;       // share of the flame's height its light and embers come from
const WIND_FOLLOW = 9;         // 1/s: how fast the flame's lean follows its motion
// The flame lights the torch and the fist that holds it (the viewmodel pass's own point light). They
// sit inside the soft core of its light (lampLight gives about 2 × its colour there), but three's point
// light has no core: hung right at the flame it burns the head's parts under it white. So it hangs a
// cell toward the eye, which keeps every part at about the same distance and lights the sides you see.
const HAND_LIGHT_BACK = 1;     // cells toward the eye from the flame's heart
const HAND_LIGHT = 0.45;       // irradiance at that distance, × the lamp's colour (what lampLight gives at LAMP_UNIT)
const LIGHT_SCALE = Math.PI;   // the viewmodel pass's lights are × π (viewmodel.js LIGHT_SCALE)
let instances = 0;             // lamp tools made (the player's and each NPC kit's): their lamps' keys stay apart

// A flame's flicker: smooth value noise (no allocations), two octaves, mean 1, about ±share,
// with now and then a deeper gutter, as a real flame dips when the air catches it.
const FLICKER_RATE = 9;        // noise cells/s of the main octave
const FLICKER_FINE = 2.7;      // the second octave's rate, × the first's
const GUTTER_RATE = 0.7;       // noise cells/s of the gutters
const GUTTER_DEPTH = 1.5;      // a full gutter dips this many shares
const hash1 = (i) => { const x = Math.sin(i * 127.1) * 43758.5453; return x - Math.floor(x); };
const noise1 = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash1(i) * (1 - u) + hash1(i + 1) * u; };
const flickerAt = (t, share) => {
  const n = 0.65 * noise1(t * FLICKER_RATE) + 0.35 * noise1(t * FLICKER_RATE * FLICKER_FINE + 31);
  const gutter = Math.max(0, noise1(t * GUTTER_RATE + 7) - 0.75) * 4;   // 0 most of the time, up to 1
  return 1 + share * (2 * (n - 0.5) - GUTTER_DEPTH * gutter);
};

export function lampTool({ key, name, model: modelKey, desc, light, burn = null, pose }) {
  const tool = key.toLowerCase();
  const color = light.color.map((c) => c * light.intensity);

  return {
    key, name, model: modelKey, desc,
    create(env) {
      const drawn = !env.owner;   // an NPC kit's tools are never drawn (npc.js): no flames or embers for them
      const rig = viewmodelRig(env);
      const hand = rig.hand(pose.pos);
      const held = new THREE.Group();
      held.rotation.y = pose.yaw ?? 0;
      hand.add(held);
      const heldMesh = attachModel(held, modelKey);
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
      const vA = new THREE.Vector3(), vB = new THREE.Vector3();

      // ---- the live flame: a flame.js card at the foot of the model's cone (hidden: it's the icon's flame)
      function lightModel(m, mode) {
        const cone = m.obj.getObjectByName('flame');
        if (!burn || !cone) return null;
        cone.visible = false;
        const f = createFlame({ width: FLAME_WIDTH, height: FLAME_HEIGHT, mode });
        f.obj.position.copy(cone.position).y -= cone.geometry.parameters.height / 2;
        if (mode === 'overlay') f.meshes.forEach((mesh) => { mesh.userData.vmLayer = VIEWMODEL_GLOW_LAYER; });
        cone.parent.add(f.obj);
        const heart = new THREE.Object3D();   // where its light and embers come from
        heart.position.y = FLAME_HEIGHT * FLAME_HEART;
        f.obj.add(heart);
        return { ...f, heart, last: new THREE.Vector3(), vel: new THREE.Vector3(), fresh: true };
      }
      // follow the flame's motion (world): its lean, and the embers it throws
      function burnFlame(f, dt, flicker, seen = true) {
        if (!f) return;
        f.heart.getWorldPosition(vA);
        if (!f.fresh && dt > 0) {
          vB.subVectors(vA, f.last).divideScalar(dt);
          f.vel.lerp(vB, 1 - Math.exp(-WIND_FOLLOW * dt));
        }
        f.fresh = false;
        f.last.copy(vA);
        f.setWind(vB.copy(f.vel).negate());
        f.setFlicker(flicker);
        if (drawn && seen) povEvents.emit('torch:burn', { at: vA, vel: f.vel, dt });
      }
      const heldFlame = drawn ? lightModel(heldMesh, 'overlay') : null;
      // the flame lights the hand that holds it (the viewmodel pass's lights; the world's is lamps.js)
      const handLight = new THREE.PointLight(0xffffff, 0, 0, 2);
      if (heldFlame) heldFlame.heart.add(handLight);
      else handLight.visible = false;

      const flickerNow = (offset = 0) => (light.flicker ? flickerAt(performance.now() / MS_PER_S + offset, light.flicker) : 1);
      const shine = (k, pos, f, held_ = false) => {
        for (let i = 0; i < 3; i++) lightColor[i] = color[i] * f;
        lamps.set(k, { pos, range: light.range, color: lightColor, held: held_ });
      };

      // ---- in flight: drawn and lit where the shared projectiles say
      const world = new THREE.Group();
      world.name = `pov-${tool}s`;
      env.scene.add(world);
      const toWorld = (g, out) => out.copy(g).multiplyScalar(env.getScale()).add(env.getVolume().position);
      const flying = new Map();   // round id → { model, flame }
      const props = [];           // lying lamps: { id, pos, normal, model, flame, until, timer }
      let lastFlight = performance.now();
      const offs = [
        povEvents.on('round:move', ({ id, kind, to }) => {
          if (kind !== tool || !flying.has(id)) return;
          let m = flying.get(id);
          if (!m) {
            const model = attachModel(world, modelKey, null, { arm: false });
            m = { model, flame: drawn ? lightModel(model, 'world') : null };
            flying.set(id, m);
          }
          m.model.obj.scale.setScalar(env.getScale());
          toWorld(to, m.model.obj.position);
          m.model.obj.rotation.x += TUMBLE;
          const now = performance.now();
          const f = flickerNow(id);
          burnFlame(m.flame, (now - lastFlight) / MS_PER_S, f);
          lastFlight = now;
          if (on) shine(`${tag}:fly:${id}`, to, f);
        }),
        povEvents.on('round:end', ({ id, kind }) => {
          if (kind !== tool || !flying.has(id)) return;
          const m = flying.get(id);
          m?.flame?.dispose();
          m?.model.dispose();
          flying.delete(id);
          lamps.remove(`${tag}:fly:${id}`);
        }),
      ];

      // ---- lying where it landed
      function removeProp(p) {
        const i = props.indexOf(p);
        if (i >= 0) props.splice(i, 1);
        clearTimeout(p.timer);
        p.flame?.dispose();
        p.model.dispose();
        lamps.remove(`${tag}:prop:${p.id}`);
      }
      function placeProp(p) {
        toWorld(p.pos, p.model.obj.position);
        p.model.obj.scale.setScalar(env.getScale());
        // a torch stands out of the face it stuck in; a lantern sits upright
        p.model.obj.quaternion.setFromUnitVectors(UP, burn ? p.normal : UP);
        p.light = p.pos.clone().addScaledVector(burn ? p.normal : UP, LIGHT_LIFT);
        if (p.lit) shine(`${tag}:prop:${p.id}`, p.light, flickerNow(p.id));
        if (p.flame) p.flame.fresh = true;   // moved, not swung: no lean from the jump
      }
      function land({ hit, normal }) {
        const model = attachModel(world, modelKey, null, { arm: false });
        const p = {
          id: nextProp++, pos: hit.point.clone().addScaledVector(normal, PROP_LIFT), normal: normal.clone(),
          model, flame: drawn ? lightModel(model, 'world') : null, lit: on, timer: 0,
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

      // the held lamp's light: at your side (HELD_LIGHT), turned with the look but level
      const heldLightPos = (ctx) => {
        const f = scratch.set(ctx.dir.x, 0, ctx.dir.z);
        if (f.lengthSq() < 1e-8) f.set(0, 0, -1);
        f.normalize();
        return vB.copy(ctx.eye).addScaledVector(f, HELD_LIGHT[2])
          .add(vA.set(-f.z, 0, f.x).multiplyScalar(HELD_LIGHT[0])).add(vA.set(0, HELD_LIGHT[1], 0));
      };

      return {
        update(ctx) {
          hand.visible = true;
          rig.update(ctx);
          if (thrower.ready(ctx) && throwIt(ctx)) thrower.fire();
          const inHand = thrower.waiting <= 0;   // a fresh one once you can throw again
          heldMesh.obj.visible = inHand;
          if (!burn && ctx.primaryPressed) { on = !on; povEvents.emit('tool:action', { tool, action: 'toggle' }); }
          const f = flickerNow();
          if (inHand && on) shine(heldKey, heldLightPos(ctx), f, true);
          else lamps.remove(heldKey);
          if (heldFlame) {
            if (inHand) burnFlame(heldFlame, ctx.dt, f, env.viewmodel.visible);   // (no embers off a hidden hand: third person)
            else heldFlame.fresh = true;
            heldFlame.heart.getWorldPosition(vA);
            env.viewmodel.getWorldPosition(vB).sub(vA)   // (the viewmodel sits at the eye)
              .setLength(HAND_LIGHT_BACK * env.getScale()).add(vA);
            handLight.position.copy(heldFlame.heart.worldToLocal(vB));
            const d = env.getScale() * HAND_LIGHT_BACK;
            handLight.color.setRGB(...light.color);
            handLight.intensity = light.intensity * f * LIGHT_SCALE * HAND_LIGHT * d * d;
          }
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
          for (const p of props) {
            const f = flickerNow(p.id);
            burnFlame(p.flame, ctx.dt, f);
            if (p.lit) shine(`${tag}:prop:${p.id}`, p.light, f);
          }
          fireWait -= ctx.dt;
          if (fireWait > 0) return;
          fireWait = FIRE_INTERVAL;
          const sim = ctx.sim ?? env.getSim();
          // from inside what it's stuck in, so the flame heats that as well as licking out of it
          for (const p of props) flame(sim, scratch.copy(p.pos).addScaledVector(p.normal, -PROP_EMBED), p.normal, TORCH_FIRE.LENGTH + PROP_EMBED, FIRE_INTERVAL);
        },
        deselect() { hand.visible = false; thrower.reset(); lamps.remove(heldKey); if (heldFlame) heldFlame.fresh = true; },
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
          flying.forEach((m, id) => { m?.flame?.dispose(); m?.model.dispose(); lamps.remove(`${tag}:fly:${id}`); });
          lamps.remove(heldKey);
          world.removeFromParent();
          fire?.dispose();
          heldFlame?.dispose();
          heldMesh.dispose();
          hand.removeFromParent();
        },
      };
    },
  };
}
