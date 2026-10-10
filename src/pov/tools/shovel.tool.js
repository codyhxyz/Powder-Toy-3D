import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { HAND_REACH } from '../constants.js';
import {
  pack, cellsNear, outsideBody, bodyExit, toStepVelocity, aimInReach, faceNormal, ballRadius, recolor, pinned,
} from './transfer.js';
import { povEvents } from '../events.js';
import { trigger, toolDt } from './action.js';
import { attachModel, MODELS } from '../models.js';
import { viewmodelRig, heldMaterial } from '../viewmodel.js';
import { gear } from './catalog.js';

// Shovel. Hold left-click on a powder to scoop it up, a small blob at a
// time; on a breakable solid, the dig energy builds up until it beats the
// cell's hardness and the cell comes up as its debris (ROCK → STONE, WOOD →
// SAWDUST). WALL and CLONE don't break, and liquids run off the blade.
// What comes up goes into the pack (transfer.js), the inventory the trowel
// builds from. Right-click throws a bladeful (the newest BLADE_LOAD cells) where
// you aim, or in front of you.
//
// Events: tool:action 'dig' (cells came up), 'dump' (cells landed) and 'refuse'
// (won't break, or full), with the element, the point and the cell count.

const BLADE_LOAD = 30;               // cells one throw takes from the pack (a bladeful)
const SCOOP_RADIUS = 1.8;            // cells: a scoop of powder comes from this close to the aim cell
const SCOOP_SINK = 1;                // cells: the blade bites this far under the surface it hits
const SCOOP_INTERVAL = 0.25;         // s between scoops while the button is held
const DIG_POWER = 60;                // hardness units per second of digging (ROCK, 30: two cells a second)
const BREAK_RADIUS = 1.5;            // cells: a break chips the aim cell, then its nearest like neighbours
const BREAK_MAX = 4;                 // cells one break may chip (the stored dig energy is capped at this many)
const THROW_SPEED = 8;               // cells/s along the aim, on top of the body's velocity
const DUMP_REACH = 2.5;              // cells from the eye where a load lands when nothing is aimed at
const DUMP_SLACK = 2.5;              // candidate cells per cell dumped (some are full or behind the surface)
const BODY_CLEARANCE = 0.3;          // cells kept clear around the body when dumping

// held item, in cells (camera space; the viewmodel rig scales it by the world's
// cell size). The model (models.js 'shovel') lies blade forward, its origin at
// the end of the handle, in the hand.
const HELD_POS = [0.85, -1.15, -0.75]; // right, down, ahead of the eye
const HELD_PITCH = 0.12, HELD_YAW = 0.3;   // radians: the blade reaches up and in toward the crosshair
const HEAP_R = 0.25;                 // cells: radius of a full load's heap on the blade
const HEAP_MIN = 0.3;                // a nearly empty load still shows this share of it
const HEAP_ALONG = 0.18;             // the heap's centre, as a share of the model's length behind its tip (mid-blade)
const HEAP_SEGMENTS = [6, 3];        // around, down the dome (low-poly, like the models)

export default {
  ...gear('SHOVEL'),
  create(env) {
    const load = pack(env.owner);
    const transfer = env.transfer;
    const scoop = trigger(SCOOP_INTERVAL);   // powder scoops, hold to repeat
    let energy = 0, energyKey = '';

    // held item: the shovel on a hand of the viewmodel rig, the load heaped on its blade
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    const held = new THREE.Group();
    held.rotation.set(HELD_PITCH, HELD_YAW, 0);
    hand.add(held);
    const heap = new THREE.Mesh(
      new THREE.SphereGeometry(HEAP_R, ...HEAP_SEGMENTS, 0, Math.PI * 2, 0, Math.PI / 2), heldMaterial('#ffffff'));
    heap.visible = false;
    const mesh = attachModel(held, 'shovel', (obj, { size }) => {
      // on the blade's top face: the blade is the model's thickest part, so its top is the box's
      heap.position.set(0, size.y * (1 - MODELS.shovel.anchor[1]), size.z * (HEAP_ALONG - MODELS.shovel.anchor[2]));
      held.add(heap);
    });
    let heapVersion = -1;
    const act = (action, extra) => povEvents.emit('tool:action', { tool: 'shovel', action, ...extra });

    const refuse = (text, id) => env.feedback?.refuse(text, { id });

    function dig(ctx, aim, go) {
      if (!aim || aim.id < 0) { energy = 0; return; }   // nothing, or the floor
      const el = ELEMENTS[aim.id];
      const g = ctx.sim.g;
      const center = aim.cell.clone().addScalar(0.5);
      if (el.kind === K.POWDER) {
        center.addScaledVector(faceNormal(aim.face), -SCOOP_SINK);
        energy = 0;
        if (!go) return;
        if (load.free <= 0) { if (!load.busy) refuse('Your pack is full: build with the trowel or right-click to throw', aim.id); return; }
        const p = transfer.take(load, { cells: cellsNear(center, SCOOP_RADIUS, g), kinds: [K.POWDER] });
        if (p) {
          scoop.fire();
          const at = pinned(center, ctx.sim), id = aim.id;
          p.then((got) => { if (got.length) act('dig', { id, point: at(), amount: got.length }); });
        }
      } else if (el.kind === K.SOLID) {
        if (!el.breakInto) { energy = 0; refuse(`${el.name} won't break`, aim.id); return; }
        const key = `${aim.id}`;
        if (key !== energyKey) { energy = 0; energyKey = key; }
        energy = Math.min(energy + DIG_POWER * toolDt(ctx), el.hard * BREAK_MAX);
        const n = Math.min(Math.floor(energy / el.hard), load.free);
        if (n < 1) { if (load.free <= 0 && !load.busy) refuse('Your pack is full: build with the trowel or right-click to throw', aim.id); return; }
        const p = transfer.take(load, {
          cells: cellsNear(center, BREAK_RADIUS, g), kinds: [K.SOLID], want: aim.id, breakDebris: true, limit: n,
        });
        if (p) {
          energy -= n * el.hard;
          const at = pinned(center, ctx.sim), id = aim.id;
          p.then((got) => { if (got.length) act('dig', { id, point: at(), amount: got.length }); });
        }
      } else {
        energy = 0;   // liquids run off the blade
      }
    }

    function dump(ctx, aim) {
      const n = Math.min(load.cells.length, BLADE_LOAD);
      if (!n) return;
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
      transfer.put(load, { cells, max: n, vel: toStepVelocity(v, ctx) })
        ?.then((landed) => { if (landed) act('dump', { id, point: at(), amount: landed }); });
    }

    return {
      load,
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
        if (load.version !== heapVersion) {
          heapVersion = load.version;
          heap.visible = load.cells.length > 0;
          if (heap.visible) recolor(heap, ELEMENTS[load.cells.at(-1)[0]].color);   // the newest, which a throw takes first
          heap.scale.setScalar(Math.max(HEAP_MIN, Math.min(1, load.cells.length / BLADE_LOAD)));
        }
        const aim = aimInReach(ctx, HAND_REACH);
        const go = scoop.ready(ctx);
        if (ctx.primary) dig(ctx, aim, go);
        else energy = 0;
        if (ctx.secondaryPressed) dump(ctx, aim);
      },
      deselect() { hand.visible = false; energy = 0; },
      status: () => load.status(),
      dispose() {
        mesh.dispose();
        hand.removeFromParent();
        heap.geometry.dispose();
        heap.material.dispose();
      },
    };
  },
};
