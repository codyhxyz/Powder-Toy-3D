import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { HAND_REACH } from '../constants.js';
import {
  persistentLoad, cellsNear, outsideBody, bodyExit, toStepVelocity, aimInReach, faceNormal, recolor,
} from './transfer.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, heldMaterial } from '../viewmodel.js';

// Bucket (slot 2). Left-click dips it into the liquid you aim at; hold to keep
// dipping until it's full. Hold right-click to pour a stream out in front of
// you. A bucket holds one liquid at a time, at the temperature it was scooped
// (a bucket of lava stays at 1,600 °C).
//
// Events: tool:action 'scoop' (cells came up), 'pour' (once per press, when
// the stream first lands) and 'refuse' (wrong liquid, or full), with the
// element, the point and the cell count.

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

// held item, in cells (camera space; the viewmodel rig scales it by the world's
// cell size). The model (models.js 'bucket') is upright and centred; the
// liquid's surface is a disc inside it, placed by shares of the model's size.
const HELD_POS = [1.1, -1.0, -2.1];  // right, down, ahead of the eye
const HELD_TILT = 0.2;               // radians, the rim tips toward the eye
const PAIL_FLOOR = 0.04;             // the pail's floor, as a share of the model's height from its bottom...
const PAIL_RIM = 0.6;                // ...and its rim (the bail rises above it)
const PAIL_BASE_R = 0.36;            // the pail's inner radius at the floor, as a share of the model's width...
const PAIL_RIM_R = 0.46;             // ...and at the rim
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

    // held item: the pail on a hand of the viewmodel rig, and the liquid's surface in it
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    const held = new THREE.Group();
    held.rotation.x = HELD_TILT;
    hand.add(held);
    const surface = new THREE.Mesh(new THREE.CircleGeometry(1, SEGMENTS).rotateX(-Math.PI / 2), heldMaterial('#ffffff'));
    surface.visible = false;
    const pail = { floor: 0, rim: 0, baseR: 0, rimR: 0 };   // cells, from the model once it loads
    let surfaceVersion = -1, pourHeard = false;
    const mesh = attachModel(held, 'bucket', (obj, { size }) => {
      pail.floor = size.y * (PAIL_FLOOR - 0.5);
      pail.rim = size.y * (PAIL_RIM - 0.5);
      pail.baseR = size.x * PAIL_BASE_R;
      pail.rimR = size.x * PAIL_RIM_R;
      held.add(surface);
      surfaceVersion = -1;
    });
    const act = (action, extra) => povEvents.emit('tool:action', { tool: 'bucket', action, ...extra });

    function refuse(text, id) {
      if (clock - lastRefuse < REFUSE_TOAST_INTERVAL) return;
      lastRefuse = clock;
      env.feedback?.toast(text);
      env.feedback?.shake();
      act('refuse', { id });
    }

    function scoop(ctx, aim) {
      scoopWait -= ctx.dt;
      if (scoopWait > 0 || !aim || aim.id < 0 || ELEMENTS[aim.id].kind !== K.LIQUID) return;
      const holds = load.cells.length ? load.mainId : -1;
      if (holds >= 0 && holds !== aim.id) { refuse(`The bucket holds ${ELEMENTS[holds].name.toLowerCase()}`, aim.id); return; }
      if (load.free <= 0) { if (!load.busy && ctx.primaryPressed) refuse('The bucket is full', aim.id); return; }
      const center = aim.cell.clone().addScalar(0.5).addScaledVector(faceNormal(aim.face), -DIP_SINK);
      const p = transfer.take(load, { cells: cellsNear(center, SCOOP_RADIUS, ctx.sim.g), kinds: [K.LIQUID], want: aim.id });
      if (p) {
        scoopWait = SCOOP_INTERVAL;
        const id = aim.id;
        p.then((got) => { if (got.length) act('scoop', { id, point: center, amount: got.length }); });
      }
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
      const id = load.mainId;
      const p = transfer.put(load, { cells, max: n, vel: toStepVelocity(v, ctx) });
      if (p) {
        pour -= n;
        p.then((landed) => {
          if (!landed || pourHeard) return;
          pourHeard = true;
          act('pour', { id, point: spout, amount: landed });
        });
      }
    }

    return {
      load,
      update(ctx) {
        clock += ctx.dt;
        hand.visible = true;
        rig.update(ctx);
        if (load.version !== surfaceVersion) {
          surfaceVersion = load.version;
          const fill = load.cells.length / BUCKET_CAPACITY;
          surface.visible = fill > 0;
          if (fill > 0) recolor(surface, ELEMENTS[load.mainId].color);
          surface.position.y = THREE.MathUtils.lerp(pail.floor, pail.rim, fill);
          surface.scale.setScalar(THREE.MathUtils.lerp(pail.baseR, pail.rimR, fill));
        }
        if (ctx.primary) scoop(ctx, aimInReach(ctx, HAND_REACH));
        else scoopWait = 0;
        if (ctx.secondary) pourOut(ctx);
        else { pour = 0; pourHeard = false; }
      },
      deselect() { hand.visible = false; pour = 0; },
      status: () => load.status(),
      dispose() {
        mesh.dispose();
        hand.removeFromParent();
        surface.geometry.dispose();
        surface.material.dispose();
      },
    };
  },
};
