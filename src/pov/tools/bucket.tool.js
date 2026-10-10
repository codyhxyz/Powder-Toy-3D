import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { HAND_REACH } from '../constants.js';
import {
  persistentLoad, ownedKey, cellsNear, outsideBody, bodyExit, toStepVelocity, aimInReach, faceNormal, recolor, pinned,
} from './transfer.js';
import { povEvents } from '../events.js';
import { trigger, toolDt } from './action.js';
import { attachModel, BUCKET_SIDES } from '../models.js';
import { viewmodelRig, heldMaterial } from '../viewmodel.js';
import { gear } from './catalog.js';

// Bucket. Left-click dips it into the liquid you aim at; hold to keep
// dipping until it's full. Hold right-click to pour a stream out in front of
// you. A bucket holds one liquid at a time, at the temperature it was scooped
// (a bucket of lava stays at 1,600 °C). The player's is bottomless (an NPC's
// isn't, so the lava-pouring enemy runs dry): what it pours is copied, not
// spent, so one scoop pours forever, and dipping it into a different liquid
// tips out what it had and takes the new one.
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

// held item, in cells (camera space; the viewmodel rig scales it by the world's
// cell size). The model (models.js 'bucket') is upright and centred; the
// liquid's surface is a disc inside it, placed by shares of the model's size.
const HELD_POS = [0.8, -0.8, -1.8];  // right, down, ahead of the eye
const HELD_TILT = 0.35;              // radians, the rim tips toward the eye
const PAIL_FLOOR = 0.04;             // the pail's floor, as a share of the model's height from its bottom...
const PAIL_RIM = 0.6;                // ...and its rim (the bail rises above it)
const PAIL_BASE_R = 0.32;            // the pail's inner radius at the floor, as a share of the model's width...
const PAIL_RIM_R = 0.42;             // ...and at the rim
const SEGMENTS = BUCKET_SIDES;       // the pail's sides, so the disc's edge lies along its walls

export default {
  ...gear('BUCKET'),
  create(env) {
    const load = persistentLoad(ownedKey('BUCKET', env.owner), BUCKET_CAPACITY);
    const bottomless = !env.owner;
    const transfer = env.transfer;
    const dip = trigger(SCOOP_INTERVAL);   // dips, hold to repeat
    let pour = 0;

    // held item: the pail on a hand of the viewmodel rig, and the liquid's surface in it
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    const held = new THREE.Group();
    held.rotation.x = HELD_TILT;
    hand.add(held);
    const surface = new THREE.Mesh(new THREE.CircleGeometry(1, SEGMENTS).rotateX(-Math.PI / 2), heldMaterial('#ffffff'));
    surface.visible = false;
    const pail = { floor: 0, rim: 0, baseR: 0, rimR: 0 };   // cells, from the model once it loads
    let surfaceVersion = -1, pourPress = 0, pourHeard = -1;   // presses of right-click, and the last one announced
    const mesh = attachModel(held, 'bucket', (obj, { size }) => {
      pail.floor = size.y * (PAIL_FLOOR - 0.5);
      pail.rim = size.y * (PAIL_RIM - 0.5);
      pail.baseR = size.x * PAIL_BASE_R;
      pail.rimR = size.x * PAIL_RIM_R;
      held.add(surface);
      surfaceVersion = -1;
    });
    const act = (action, extra) => povEvents.emit('tool:action', { tool: 'bucket', action, ...extra });

    const refuse = (text, id) => env.feedback?.refuse(text, { id });

    function scoop(ctx, aim) {
      if (!aim || aim.id < 0 || ELEMENTS[aim.id].kind !== K.LIQUID) return;
      const holds = load.cells.length ? load.mainId : -1;
      if (holds >= 0 && holds !== aim.id) {   // a new liquid: a bottomless bucket tips out the old one
        if (!bottomless) { refuse(`The bucket holds ${ELEMENTS[holds].name.toLowerCase()}`, aim.id); return; }
        if (load.busy) return;
        load.cells.length = 0;
        load.version++;
      }
      if (load.free <= 0) { if (!load.busy && ctx.primaryPressed) refuse('The bucket is full', aim.id); return; }
      const center = aim.cell.clone().addScalar(0.5).addScaledVector(faceNormal(aim.face), -DIP_SINK);
      const p = transfer.take(load, { cells: cellsNear(center, SCOOP_RADIUS, ctx.sim.g), kinds: [K.LIQUID], want: aim.id });
      if (p) {
        dip.fire();
        const id = aim.id, at = pinned(center, ctx.sim);
        p.then((got) => { if (got.length) act('scoop', { id, point: at(), amount: got.length }); });
      }
    }

    function pourOut(ctx) {
      pour = Math.min(pour + POUR_RATE * toolDt(ctx), POUR_BACKLOG);
      const n = Math.min(Math.floor(pour), load.cells.length);
      if (n < 1) return;
      const feet = ctx.player?.pos;
      const t = Math.max(POUR_REACH, feet ? bodyExit(ctx.eye, ctx.dir, feet, BODY_CLEARANCE) + SPOUT_RADIUS : 0);
      const spout = ctx.eye.clone().addScaledVector(ctx.dir, t);
      const cells = cellsNear(spout, SPOUT_RADIUS, ctx.sim.g, feet ? outsideBody(feet, BODY_CLEARANCE) : null);
      const v = ctx.dir.clone().multiplyScalar(POUR_SPEED);
      if (ctx.player?.vel) v.add(ctx.player.vel);
      const id = load.mainId;
      const source = [...load.cells.at(-1)];   // what the bottomless bucket refills with
      const p = transfer.put(load, { cells, max: n, vel: toStepVelocity(v, ctx) });
      if (p) {
        pour -= n;
        const press = pourPress, at = pinned(spout, ctx.sim);
        p.then((landed) => {   // may land after the button is up: announce each press once
          if (bottomless && landed) {
            for (let i = 0; i < landed; i++) load.cells.push([...source]);
            load.version++;
          }
          if (!landed || pourHeard === press) return;
          pourHeard = press;
          act('pour', { id, point: at(), amount: landed });
        });
      }
    }

    return {
      load,
      update(ctx) {
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
        if (dip.ready(ctx) && ctx.primary) scoop(ctx, aimInReach(ctx, HAND_REACH));
        if (ctx.secondaryPressed) pourPress++;
        if (ctx.secondary) pourOut(ctx);
        else pour = 0;
      },
      deselect() { hand.visible = false; pour = 0; },
      status: () => (bottomless && load.cells.length ? `${ELEMENTS[load.mainId].abbr} ∞` : load.status()),
      dispose() {
        mesh.dispose();
        hand.removeFromParent();
        surface.geometry.dispose();
        surface.material.dispose();
      },
    };
  },
};
