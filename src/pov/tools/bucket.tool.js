import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { HAND_REACH } from '../constants.js';
import {
  persistentLoad, cellsNear, outsideBody, bodyExit, toStepVelocity, aimInReach, faceNormal, heldMesh, recolor,
} from './transfer.js';

// Bucket (slot 2). Left-click dips it into the liquid you aim at; hold to keep
// dipping until it's full. Hold right-click to pour a stream out in front of
// you. A bucket holds one liquid at a time, at the temperature it was scooped
// (a bucket of lava stays at 1,600 °C).

const BUCKET_CAPACITY = 60;          // cells one bucket holds
const SCOOP_RADIUS = 3.5;            // cells: a dip takes the liquid nearest the aim cell, this far at most
const DIP_SINK = 1.5;                // cells: the bucket dips this far under the surface it hits
const SCOOP_INTERVAL = 0.3;          // s between dips while the button is held
const POUR_RATE = 30;                // cells/s in a stream
const POUR_BACKLOG = 4;              // cells: a stream that couldn't land doesn't build up more than this
const POUR_SPEED = 6;                // cells/s along the aim, on top of the body's velocity
const POUR_REACH = 1.5;              // cells from the eye to the spout
const SPOUT_RADIUS = 1.2;            // cells: the stream fills empty cells this close to the spout
const BODY_CLEARANCE = 0.3;          // cells kept clear around the body
const REFUSE_TOAST_INTERVAL = 1.5;   // s between repeated toasts

// held item, in cells (the viewmodel is scaled by the world's cell size)
const HELD_POS = [1.1, -1.0, -2.1];  // right, down, ahead of the eye
const HELD_TILT = 0.2;               // radians, the rim tips toward the eye
const RIM_R = 0.42, BASE_R = 0.32, PAIL_H = 0.7;
const HANDLE_R = 0.4, HANDLE_TUBE = 0.025;
const PAIL_COLOR = '#8e98a6';
const SEGMENTS = 18;

const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9h14l-1.6 10.2a1.5 1.5 0 0 1-1.5 1.3H8.1a1.5 1.5 0 0 1-1.5-1.3z"/>'
  + '<path d="M5 9c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/></svg>';

export default {
  key: 'BUCKET', name: 'Bucket', slot: 2, icon: ICON, color: '#7f8ea3',
  desc: 'Left-click scoops up liquid, hold right-click to pour it out. Lava is fine.',
  create(env) {
    const load = persistentLoad('BUCKET', BUCKET_CAPACITY);
    const transfer = env.transfer;
    let scoopWait = 0, pour = 0;
    let lastRefuse = -Infinity, clock = 0;

    // held item: an open pail, its handle, and the liquid's surface
    const held = new THREE.Group();
    const pail = heldMesh(new THREE.CylinderGeometry(RIM_R, BASE_R, PAIL_H, SEGMENTS, 1, true), PAIL_COLOR);
    pail.material.side = THREE.DoubleSide;
    const bottom = heldMesh(new THREE.CircleGeometry(BASE_R, SEGMENTS).rotateX(Math.PI / 2), PAIL_COLOR);
    bottom.position.y = -PAIL_H / 2;
    const handle = heldMesh(new THREE.TorusGeometry(HANDLE_R, HANDLE_TUBE, 6, SEGMENTS, Math.PI), PAIL_COLOR);
    handle.position.y = PAIL_H / 2;
    const surface = heldMesh(new THREE.CircleGeometry(1, SEGMENTS).rotateX(-Math.PI / 2), '#ffffff');
    held.add(pail, bottom, handle, surface);
    held.position.set(...HELD_POS);
    held.rotation.x = HELD_TILT;
    held.visible = false;
    env.viewmodel?.add(held);
    let surfaceVersion = -1;

    function refuse(text) {
      if (clock - lastRefuse < REFUSE_TOAST_INTERVAL) return;
      lastRefuse = clock;
      env.feedback?.toast(text);
      env.feedback?.shake();
    }

    function scoop(ctx, aim) {
      scoopWait -= ctx.dt;
      if (scoopWait > 0 || !aim || aim.id < 0 || ELEMENTS[aim.id].kind !== K.LIQUID) return;
      const holds = load.cells.length ? load.mainId : -1;
      if (holds >= 0 && holds !== aim.id) { refuse(`The bucket holds ${ELEMENTS[holds].name.toLowerCase()}`); return; }
      if (load.free <= 0) { if (!load.busy && ctx.primaryPressed) refuse('The bucket is full'); return; }
      const center = aim.cell.clone().addScalar(0.5).addScaledVector(faceNormal(aim.face), -DIP_SINK);
      const p = transfer.take(load, { cells: cellsNear(center, SCOOP_RADIUS, ctx.sim.g), kinds: [K.LIQUID], want: aim.id });
      if (p) scoopWait = SCOOP_INTERVAL;
    }

    function pourOut(ctx) {
      pour = Math.min(pour + POUR_RATE * ctx.dt, POUR_BACKLOG);
      const n = Math.min(Math.floor(pour), load.cells.length);
      if (n < 1) return;
      const feet = ctx.player?.pos;
      const t = Math.max(POUR_REACH, feet ? bodyExit(ctx.eye, ctx.dir, feet, BODY_CLEARANCE) + SPOUT_RADIUS : 0);
      const spout = ctx.eye.clone().addScaledVector(ctx.dir, t);
      const cells = cellsNear(spout, SPOUT_RADIUS, ctx.sim.g, feet ? outsideBody(feet, BODY_CLEARANCE) : null);
      const v = ctx.dir.clone().multiplyScalar(POUR_SPEED);
      if (ctx.player?.vel) v.add(ctx.player.vel);
      if (transfer.put(load, { cells, max: n, vel: toStepVelocity(v, ctx) })) pour -= n;
    }

    return {
      load,
      update(ctx) {
        clock += ctx.dt;
        held.visible = true;
        held.scale.setScalar(env.getScale?.() ?? 1);
        if (load.version !== surfaceVersion) {
          surfaceVersion = load.version;
          const fill = load.cells.length / BUCKET_CAPACITY;
          surface.visible = fill > 0;
          if (fill > 0) recolor(surface, ELEMENTS[load.mainId].color);
          surface.position.y = -PAIL_H / 2 + fill * PAIL_H;
          surface.scale.setScalar(BASE_R + (RIM_R - BASE_R) * fill);
        }
        if (ctx.primary) scoop(ctx, aimInReach(ctx, HAND_REACH));
        else scoopWait = 0;
        if (ctx.secondary) pourOut(ctx);
        else pour = 0;
      },
      deselect() { held.visible = false; pour = 0; },
      status: () => load.status(),
      dispose() {
        held.removeFromParent();
        held.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      },
    };
  },
};
