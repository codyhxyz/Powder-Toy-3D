import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { HAND_REACH } from '../constants.js';
import {
  persistentLoad, cellsNear, outsideBody, bodyExit, toStepVelocity, aimInReach, faceNormal, ballRadius,
  heldMesh, recolor,
} from './transfer.js';

// Shovel (slot 1). Hold left-click on a powder to scoop it up, a small blob at a
// time; on a breakable solid, the dig energy builds up until it beats the
// cell's hardness and the cell comes up as its debris (ROCK → STONE, WOOD →
// SAWDUST). WALL and CLONE don't break, and liquids run off the blade.
// Right-click throws the whole load where you aim, or in front of you.

const SHOVEL_CAPACITY = 30;          // cells one load holds
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
const REFUSE_TOAST_INTERVAL = 1.5;   // s between repeated "won't break" / "full" toasts

// held item, in cells (the viewmodel is scaled by the world's cell size)
const HELD_POS = [1.0, -0.95, -2.0]; // right, down, ahead of the eye
const HANDLE_LEN = 2.4, HANDLE_R = 0.05;
const BLADE_W = 0.55, BLADE_H = 0.65, BLADE_T = 0.05;
const HELD_PITCH = -0.35, HELD_YAW = 0.25;   // radians: the blade tips down and in toward the crosshair
const HEAP_R = 0.25;                 // cells: radius of a full load's heap on the blade
const HEAP_MIN = 0.3;                // a nearly empty load still shows this share of it
const HANDLE_COLOR = '#8a5a32', BLADE_COLOR = '#9aa1ab';

const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3.5l5.5 5.5M17.8 6.2L11 13"/>'
  + '<path d="M10.5 10.5l3 3-3.5 3.5c-1.6 1.6-4.4 2.5-6.5 3 .5-2.1 1.4-4.9 3-6.5z"/></svg>';

export default {
  key: 'SHOVEL', name: 'Shovel', slot: 1, icon: ICON, color: '#b08454',
  desc: 'Hold left-click to dig powder or break solids into debris. Right-click throws the load.',
  create(env) {
    const load = persistentLoad('SHOVEL', SHOVEL_CAPACITY);
    const transfer = env.transfer;
    let scoopWait = 0;
    let energy = 0, energyKey = '';
    let lastRefuse = -Infinity, clock = 0;

    // held item: a handle and a blade, with the load heaped on the blade
    const held = new THREE.Group();
    const handle = heldMesh(new THREE.CylinderGeometry(HANDLE_R, HANDLE_R, HANDLE_LEN, 8), HANDLE_COLOR);
    const blade = heldMesh(new THREE.BoxGeometry(BLADE_W, BLADE_T, BLADE_H), BLADE_COLOR);
    const heap = heldMesh(new THREE.SphereGeometry(HEAP_R, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#ffffff');
    handle.rotation.x = Math.PI / 2;
    handle.position.z = HANDLE_LEN / 2;
    blade.position.z = -BLADE_H / 2;
    heap.position.set(0, BLADE_T / 2, -BLADE_H / 2);
    held.add(handle, blade, heap);
    held.position.set(...HELD_POS);
    held.rotation.set(HELD_PITCH, HELD_YAW, 0);
    held.visible = false;
    env.viewmodel?.add(held);
    let heapVersion = -1;

    function refuse(text) {
      if (clock - lastRefuse < REFUSE_TOAST_INTERVAL) return;
      lastRefuse = clock;
      env.feedback?.toast(text);
      env.feedback?.shake();
    }

    function dig(ctx, aim) {
      if (!aim || aim.id < 0) { energy = 0; return; }   // nothing, or the floor
      const el = ELEMENTS[aim.id];
      const g = ctx.sim.g;
      const center = aim.cell.clone().addScalar(0.5);
      if (el.kind === K.POWDER) {
        center.addScaledVector(faceNormal(aim.face), -SCOOP_SINK);
        energy = 0;
        scoopWait -= ctx.dt;
        if (scoopWait > 0) return;
        if (load.free <= 0) { if (!load.busy) refuse('The shovel is full: right-click to throw the load'); return; }
        const p = transfer.take(load, { cells: cellsNear(center, SCOOP_RADIUS, g), kinds: [K.POWDER] });
        if (p) scoopWait = SCOOP_INTERVAL;
      } else if (el.kind === K.SOLID) {
        if (!el.breakInto) { energy = 0; refuse(`${el.name} won't break`); return; }
        const key = `${aim.id}`;
        if (key !== energyKey) { energy = 0; energyKey = key; }
        energy = Math.min(energy + DIG_POWER * ctx.dt, el.hard * BREAK_MAX);
        const n = Math.min(Math.floor(energy / el.hard), load.free);
        if (n < 1) { if (load.free <= 0 && !load.busy) refuse('The shovel is full: right-click to throw the load'); return; }
        const p = transfer.take(load, {
          cells: cellsNear(center, BREAK_RADIUS, g), kinds: [K.SOLID], want: aim.id, breakDebris: true, limit: n,
        });
        if (p) energy -= n * el.hard;
      } else {
        energy = 0;   // liquids run off the blade
      }
    }

    function dump(ctx, aim) {
      const n = load.cells.length;
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
      transfer.put(load, { cells, vel: toStepVelocity(v, ctx) });
    }

    return {
      load,
      update(ctx) {
        clock += ctx.dt;
        held.visible = true;
        held.scale.setScalar(env.getScale?.() ?? 1);
        if (load.version !== heapVersion) {
          heapVersion = load.version;
          heap.visible = load.cells.length > 0;
          if (heap.visible) recolor(heap, ELEMENTS[load.mainId].color);
          heap.scale.setScalar(Math.max(HEAP_MIN, load.cells.length / SHOVEL_CAPACITY));
        }
        const aim = aimInReach(ctx, HAND_REACH);
        if (ctx.primary) dig(ctx, aim);
        else { energy = 0; scoopWait = 0; }
        if (ctx.secondaryPressed) dump(ctx, aim);
      },
      deselect() { held.visible = false; energy = 0; },
      status: () => load.status(),
      dispose() {
        held.removeFromParent();
        held.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      },
    };
  },
};
