import * as THREE from 'three';
import { ELEMENTS } from '../../elements.js';
import { HAND_REACH } from '../constants.js';
import { pack, packContents, aimInReach, faceNormal, outsideBody } from './transfer.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { trigger, swing } from './action.js';

// Trowel (slot 6): builds with what the shovel dug up. Left-click sets a block
// of the chosen material from the pack (transfer.js) against the face you aim
// at; hold to keep building. Right-click picks the next material in the pack.
//
// Blocks are Minecraft's: a 1 m cube (BLOCK cells a side) on a fixed lattice,
// so a block set on top of another lines up with it, placed at Minecraft's
// right-click rate (4 ticks), and never inside your own body. They are the
// pack's own cells, put back exactly (element, temperature, life), and from
// then on they're the engine's: a sand block slumps into a heap, a sawdust one
// burns. Cells of the block that aren't empty stay as they are and the cells
// meant for them go back into the pack.
//
// Events: tool:action 'place' (cells landed), 'refuse' (nothing to build with,
// or the block would be inside you), with the element, the point and the count.

const BLOCK = 3;             // cells a side (0.9 m at 30 cm cells: Minecraft's 1 m block)
const REFIRE = 0.2;          // s between blocks while held (Minecraft's 4-tick place delay)
const DAB_TIME = 0.05;       // s for the dab forward
const DAB_PITCH = 0.35;      // rad the blade dips setting a block

// viewmodel, in cells (camera space); the model's origin is the end of the handle
const HELD_POS = [0.5, -0.5, -1.2];
const REST_PITCH = 0.15;     // rad, blade tipped up toward the crosshair
const REST_YAW = 0.25;       // rad, in toward the crosshair

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">'
  + '<path d="M4 20l7-3 7-7-4-4-7 7z"/><path d="M14 6l3-3M18 10l3-3"/></svg>';

export default {
  key: 'TROWEL', name: 'Trowel', slot: 6, icon: ICON, color: '#a88f6a',
  desc: 'Builds 1 m blocks out of what the shovel dug up. Right-click picks the material.',
  create(env) {
    const load = pack(env.owner);
    const transfer = env.transfer;
    const button = trigger(REFIRE);
    const next = trigger(REFIRE, { hold: false, button: 'secondary' });
    const pose = swing({ rest: REST_PITCH, hit: REST_PITCH - DAB_PITCH, miss: REST_PITCH - DAB_PITCH, strike: DAB_TIME, settle: REFIRE });
    let chosen = -1;             // element id to build with (-1: whatever the pack holds most of)
    let lastBlock = null;        // for checks: { min, id, landed }

    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    const pivot = new THREE.Group();
    pivot.rotation.y = REST_YAW;
    hand.add(pivot);
    const mesh = attachModel(pivot, 'trowel');

    // the material to build with: the chosen one while the pack has any, else its most
    function material() {
      const have = packContents(load);
      if (!have.length) return null;
      return have.find(([id]) => id === chosen) ?? have[0];
    }

    // the lattice block next to the aimed face: its cells, bottom up
    function blockAt(aim) {
      const c = aim.cell.clone().add(faceNormal(aim.face));
      const min = c.divideScalar(BLOCK).floor().multiplyScalar(BLOCK);
      const cells = [];
      for (let y = 0; y < BLOCK; y++) for (let z = 0; z < BLOCK; z++) for (let x = 0; x < BLOCK; x++) {
        cells.push([min.x + x, min.y + y, min.z + z]);
      }
      return { min, cells };
    }

    function place(ctx) {
      const aim = aimInReach(ctx, HAND_REACH);
      if (!aim) return false;
      const mat = material();
      if (!mat) { env.feedback?.refuse('Your pack is empty: dig with the shovel first'); return false; }
      const { min, cells } = blockAt(aim);
      const g = ctx.sim.g;
      const inGrid = cells.filter(([x, y, z]) => x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz);
      if (!inGrid.length) return false;
      const feet = ctx.player?.pos;
      if (feet) {
        const clear = outsideBody(feet);
        if (!inGrid.every(([x, y, z]) => clear(x, y, z))) { env.feedback?.refuse("You're standing there", { id: mat[0] }); return false; }
      }
      const [id] = mat;
      const p = transfer.put(load, { cells: inGrid, max: inGrid.length, id });
      if (!p) return false;
      const point = min.clone().addScalar(BLOCK / 2);
      lastBlock = { min: min.clone(), id, landed: null };
      const block = lastBlock;
      p.then((landed) => {
        block.landed = landed;
        if (landed) povEvents.emit('tool:action', { tool: 'trowel', action: 'place', id, point, amount: landed });
      });
      rig.hit(HIT.PLACE);
      return true;
    }

    return {
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
        if (button.ready(ctx) && place(ctx)) { button.fire(); pose.start(true); }
        if (next.ready(ctx)) {
          next.fire();
          const have = packContents(load);
          const cur = have.findIndex(([id]) => id === material()?.[0]);
          if (have.length) chosen = have[(cur + 1) % have.length][0];
        }
        pivot.rotation.x = pose.angle(ctx.dt);
      },
      deselect() { hand.visible = false; button.reset(); next.reset(); pose.stop(); },
      status() {
        const mat = material();
        return mat ? `${ELEMENTS[mat[0]].abbr} ×${mat[1]}` : null;
      },
      readout() {
        const mat = material();
        if (!mat) return { name: 'Pack empty', color: 'transparent', note: 'dig with the shovel' };
        const kinds = packContents(load).length;
        return { name: `${ELEMENTS[mat[0]].name} ×${mat[1]}`, color: ELEMENTS[mat[0]].color, note: kinds > 1 ? 'right-click: next' : '' };
      },
      get lastBlock() { return lastBlock; },
      dispose() { mesh.dispose(); hand.removeFromParent(); },
    };
  },
};
