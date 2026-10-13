import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { HAND_REACH } from '../constants.js';
import {
  pack, cellsNear, outsideBody, bodyExit, toStepVelocity, faceNormal, ballRadius, pinned,
} from './transfer.js';
import { povEvents } from '../events.js';
import { trigger, swing, toolDt } from './action.js';
import { digger, BLOCK } from './dig.js';
import { attachModel, MODELS } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { gear } from './catalog.js';

// Shovel. Digs like Minecraft's shovel (dig.js): click, or hold, and the
// outlined bite you aim at comes up whole into the pack, at Minecraft's
// iron-shovel-on-dirt pace. Loose ground only: powder, and soil (grass and
// plants, moss and fungus, as their debris). Wood is the axe's and rock the pickaxe's: they ring
// off the blade, and a toast names the tool (Minecraft's shovel blocks).
// Liquids run off the blade. Right-click
// throws a block's worth (the newest BLADE_LOAD cells) where you aim, or in
// front of you; hold to keep throwing. The pack (transfer.js) is the inventory
// the trowel builds from.
//
// Events: tool:action 'dig' (cells came up), 'chip' (a dig cracked a solid),
// 'dump' (cells landed) and 'refuse' (won't break, or full), with the element,
// the point and the cell count.

const REFIRE = 0.15;                 // s between digs while held: Minecraft's iron shovel on dirt (minecraft.wiki/w/Shovel)
const THROW_REFIRE = 0.2;            // s between throws while held: Minecraft's 4-tick use delay (the trowel's)
const POWER = 6;                     // hardness one dig beats: soil (moss, fungus: 6) in one
const DIGS = ['loose', 'soil'];      // dig.js materials: Minecraft's shovel blocks (dirt, sand, gravel, snow, grass) and plants; wood is the axe's, rock the pickaxe's
const BLADE_LOAD = BLOCK ** 3;       // cells one throw takes from the pack: one dug block
const THROW_SPEED = 8;               // cells/s along the aim, on top of the body's velocity
const DUMP_REACH = 2.5;              // cells from the eye where a load lands when nothing is aimed at
const DUMP_SLACK = 2.5;              // candidate cells per cell dumped (some are full or behind the surface)
const BODY_CLEARANCE = 0.3;          // cells kept clear around the body when dumping

// held item, in cells (camera space; the viewmodel rig scales it by the world's
// cell size). The model (models.js 'shovel') lies blade forward, its origin at
// the end of the handle, in the hand.
const HELD_POS = [0.85, -1.15, -0.75]; // right, down, ahead of the eye
const HELD_PITCH = 0.12, HELD_YAW = 0.3;   // radians: the blade reaches up and in toward the crosshair

// the dig: a jab, the blade driven forward and down into the ground and back
// (Lethal Company's shovel reaches contact in 0.13 s of its 0.78 s; ours has
// to fit Minecraft's 0.15 s refire, so the contact comes in a third of it)
const JAB_STRIKE = 0.05;             // s for the blade to bite
const JAB_PITCH = 0.35;              // rad the blade dips as it bites
const JAB_THRUST = 0.5;              // cells the blade drives forward
const JAB_MISS = 1.5;                // a jab into air follows through this much further
// the throw: the blade flicks up
const FLICK_STRIKE = 0.06;           // s
const FLICK_PITCH = 0.5;             // rad up

// the load on the blade: a smooth heap in the colours of what's on it
const HEAP_R = 0.25;                 // cells: radius of a full load's heap on the blade
const HEAP_MIN = 0.3;                // a nearly empty load still shows this share of it
const HEAP_ALONG = 0.18;             // the heap's centre, as a share of the model's length behind its tip (mid-blade)
const HEAP_SEGMENTS = [16, 8];       // around, down the dome: smooth
const HEAP_SHADE = 0.12;             // ± brightness between neighbouring grains, at an element's `var` of 1
const GRAIN_HASH = 2654435761;       // Knuth's multiplicative hash: which carried cell colours each vertex

export default {
  ...gear('SHOVEL'),
  create(env) {
    const load = pack(env.owner);
    const transfer = env.transfer;
    const digs = trigger(REFIRE);
    const throws = trigger(THROW_REFIRE, { button: 'secondary' });
    const dig = digger(env, { power: POWER, digs: DIGS, reach: HAND_REACH });
    const tilt = swing({ rest: 0, hit: -JAB_PITCH, miss: -JAB_PITCH * JAB_MISS, strike: JAB_STRIKE, settle: REFIRE });
    const thrust = swing({ rest: 0, hit: JAB_THRUST, miss: JAB_THRUST * JAB_MISS, strike: JAB_STRIKE, settle: REFIRE });
    const flick = swing({ rest: 0, hit: FLICK_PITCH, miss: FLICK_PITCH, strike: FLICK_STRIKE, settle: THROW_REFIRE });

    // held item: the shovel on a hand of the viewmodel rig, the load heaped on its blade
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    // the dig and the throw seen from outside (held.js: holds.js GESTURES on the body, the arms with them)
    hand.userData.gesture = { name: 'dig', since: Infinity, span: REFIRE };
    const gesture = (name, span) => Object.assign(hand.userData.gesture, { name, since: 0, span });
    const held = new THREE.Group();
    held.rotation.set(HELD_PITCH, HELD_YAW, 0);
    hand.add(held);
    const heapGeo = new THREE.SphereGeometry(HEAP_R, ...HEAP_SEGMENTS, 0, Math.PI * 2, 0, Math.PI / 2);
    heapGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(heapGeo.attributes.position.count * 3), 3));
    const heap = new THREE.Mesh(heapGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    heap.visible = false;
    const mesh = attachModel(held, 'shovel', (obj, { size }) => {
      // on the blade's top face: the blade is the model's thickest part, so its top is the box's
      heap.position.set(0, size.y * (1 - MODELS.shovel.anchor[1]), size.z * (HEAP_ALONG - MODELS.shovel.anchor[2]));
      held.add(heap);
    });
    let heapVersion = -1;
    const act = (action, extra) => povEvents.emit('tool:action', { tool: 'shovel', action, ...extra });
    const refuse = (text, id) => env.feedback?.refuse(text, { id });
    const full = (id) => { if (!load.busy) refuse('Your pack is full: build with the trowel or right-click to throw', id); };

    // the heap in the colours of the top of the load (what a throw takes next), grain by grain
    const tint = new THREE.Color();
    function paintHeap() {
      const top = load.cells.slice(-BLADE_LOAD);
      const colors = heapGeo.attributes.color;
      for (let v = 0; v < colors.count; v++) {
        const h = Math.imul(v + 1, GRAIN_HASH) >>> 0;
        const el = ELEMENTS[top[h % top.length][0]];
        const shade = 1 + ((h >>> 16) / 0xffff - 0.5) * 2 * HEAP_SHADE * (el.var ?? 1);
        tint.set(el.color).multiplyScalar(shade);
        colors.setXYZ(v, tint.r, tint.g, tint.b);
      }
      colors.needsUpdate = true;
    }

    // One dig on the aimed block t; true if the blade bit into something.
    function strike(ctx, t) {
      if (!t) return false;
      const point = t.aim.cell.clone().addScalar(0.5);
      const r = dig.blow(ctx, t, load, transfer);
      if (!r) {
        // liquids run off the blade; wood, rock and the like ring off it, and say which tool they want
        const why = dig.refusal(t.id, 'shovel');
        if (!why) return false;
        refuse(why, t.id);
        return true;
      }
      rig.hit(HIT.SHOVEL);
      if (r.taken) {
        const at = pinned(point, ctx.sim), id = t.id;
        r.taken.then((got) => { if (got.length) act('dig', { id, point: at(), amount: got.length }); });
      } else if (r.hits < r.need) {
        act('chip', { id: t.id, point });
      } else if (load.free <= 0) full(t.id);
      return true;
    }

    function dump(ctx, aim) {
      const n = Math.min(load.cells.length, BLADE_LOAD);
      if (!n) return false;
      const feet = ctx.player?.pos;
      const clear = feet ? outsideBody(feet, BODY_CLEARANCE) : null;
      const r = ballRadius(n);
      let center, keep = clear;
      if (aim) {
        // a heap on the face you aim at, never behind it
        const nrm = faceNormal(aim.face);
        const c = aim.cell;
        center = c.clone().addScalar(0.5).addScaledVector(nrm, 0.5 + r);
        keep = (x, y, z) => (x - c.x) * nrm.x + (y - c.y) * nrm.y + (z - c.z) * nrm.z >= 1 && (!clear || clear(x, y, z));
      } else {
        const t = Math.max(DUMP_REACH, feet ? bodyExit(ctx.eye, ctx.dir, feet, BODY_CLEARANCE) + r : 0);
        center = ctx.eye.clone().addScaledVector(ctx.dir, t);
      }
      const cells = cellsNear(center, ballRadius(n * DUMP_SLACK), ctx.sim.g, keep);
      const v = ctx.dir.clone().multiplyScalar(THROW_SPEED);
      if (ctx.player?.vel) v.add(ctx.player.vel);
      const id = load.cells.at(-1)[0], at = pinned(center, ctx.sim);   // the dump's sound stays where it happened (D11)
      const p = transfer.put(load, { cells, max: n, vel: toStepVelocity(v, ctx) });
      p?.then((landed) => { if (landed) act('dump', { id, point: at(), amount: landed }); });
      return !!p;
    }

    return {
      load,
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
        const dt = toolDt(ctx);
        hand.userData.gesture.since += dt;
        if (load.version !== heapVersion) {
          heapVersion = load.version;
          heap.visible = load.cells.length > 0;
          if (heap.visible) paintHeap();
          heap.scale.setScalar(Math.max(HEAP_MIN, Math.min(1, load.cells.length / BLADE_LOAD)));
        }
        const t = dig.target(ctx);
        if (digs.ready(ctx)) {
          digs.fire();
          const bit = strike(ctx, t);
          gesture('dig', REFIRE);
          tilt.start(bit);
          thrust.start(bit);
        }
        if (throws.ready(ctx) && dump(ctx, t?.aim ?? null)) {
          throws.fire();
          flick.start(true);
          gesture('toss', THROW_REFIRE);
          rig.hit(HIT.THROW);
        }
        held.rotation.x = HELD_PITCH + tilt.angle(dt) + flick.angle(dt);
        held.position.z = -thrust.angle(dt);
      },
      deselect() {
        hand.visible = false;
        dig.hide();
        digs.reset(); throws.reset();
        tilt.stop(); thrust.stop(); flick.stop();
      },
      status: () => load.status(),
      get lastBlow() { return dig.lastBlow; },   // for checks
      dispose() {
        dig.dispose();
        mesh.dispose();
        hand.removeFromParent();
        heapGeo.dispose();
        heap.material.dispose();
      },
    };
  },
};
