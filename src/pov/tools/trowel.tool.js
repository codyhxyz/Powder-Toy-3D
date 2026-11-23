import * as THREE from 'three';
import { ELEMENTS } from '../../elements.js';
import { HAND_REACH } from '../constants.js';
import { pack, packContents, aimInReach, outsideBody } from './transfer.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { trigger, swing, toolDt } from './action.js';
import { gear } from './catalog.js';
import { createMaterialPicker } from './materialPicker.js';
import { boxCells, biteBox, biteSize, wheelBite, bitesByWheel, WHEEL_USE, biteStatus, markBite, clearMark, withSurface } from './dig.js';   // the shovel's and pickaxe's bite: the lattice's 0.9 m block (Minecraft's 1 m), or smaller on the crosshair (the wheel)

// Trowel: builds with what the shovel dug up. Left-click sets a block
// of the chosen material from the pack (transfer.js) against the face you aim
// at; hold to keep building. Right-click opens the pack's material picker.
//
// Blocks are Minecraft's: a 1 m cube (BLOCK cells a side) on a fixed lattice
// so a block set on top of another lines up with it, placed at Minecraft's
// right-click rate (4 ticks), and never inside your own body. Sized down with
// the wheel (dig.js biteSize: any size to one cell) a block leaves the lattice
// and sits against the face where the crosshair is. Where it would go is
// outlined on the surface, as a dig's bite is (dig.js markBite). They are the
// pack's own cells, put back exactly (element, temperature, life), and from
// then on they're the engine's: a sand block slumps into a heap, a sawdust one
// burns. Cells of the block that aren't empty stay as they are and the cells
// meant for them go back into the pack.
//
// Events: tool:action 'place' (cells landed), 'refuse' (nothing to build with,
// or the block would be inside you), with the element, the point and the count.

const REFIRE = 0.2;          // s between blocks while held (Minecraft's 4-tick place delay)
const DAB_TIME = 0.05;       // s for the dab forward
const DAB_PITCH = 0.35;      // rad the blade dips setting a block

// viewmodel, in cells (camera space); the model's origin is the end of the handle
const HELD_POS = [0.5, -0.5, -1.2];
const REST_PITCH = 0.15;     // rad, blade tipped up toward the crosshair
const REST_YAW = 0.25;       // rad, in toward the crosshair

export default {
  ...gear('TROWEL'),
  create(env) {
    const load = pack(env.owner);
    const transfer = env.transfer;
    const button = trigger(REFIRE);
    const next = trigger(REFIRE, { hold: false, button: 'secondary' });
    const pose = swing({ rest: REST_PITCH, hit: REST_PITCH - DAB_PITCH, miss: REST_PITCH - DAB_PITCH, strike: DAB_TIME, settle: REFIRE });
    let chosen = -1;             // element id to build with (-1: whatever the pack holds most of)
    let lastBlock = null;        // for checks: { min, max, size, id, landed }

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
    const picker = env.owner ? null : createMaterialPicker({
      load, material, choose: (id) => { chosen = id; },
      onOpenChange(open) {
        button.reset(); next.reset();
        env.onEditorOpenChange?.(open);
      },
      requestLock: env.requestLock,
    });

    // the block against the aimed face (dig.js biteBox: the lattice's, or the wheel's size on the crosshair)
    const blockAt = (ctx, aim) => biteBox(aim.cell, aim.face, biteSize(env.owner), ctx.eye, ctx.dir, true);
    // its outline on the surface it would stand on: the player's only (an NPC's is unseen)
    let shown = false;
    function show(ctx) {
      const aim = env.owner == null && !picker?.open ? aimInReach(ctx, HAND_REACH) : null;
      if (aim) markBite(withSurface(blockAt(ctx, aim), aim.face, aim.face % 2 === 0 ? -1 : 1), aim.face);   // back to the surface it is built on
      else if (shown) clearMark();
      shown = !!aim;
    }

    function place(ctx) {
      const aim = aimInReach(ctx, HAND_REACH);
      if (!aim) return false;
      const mat = material();
      if (!mat) { env.feedback?.refuse('Your pack is empty: dig with the shovel first'); return false; }
      const { lo, hi, min, max } = blockAt(ctx, aim);
      const inGrid = boxCells(min, max, ctx.sim.g);   // bottom up
      if (!inGrid.length) return false;
      const feet = ctx.player?.pos;
      if (feet) {
        const clear = outsideBody(feet);
        if (!inGrid.every(([x, y, z]) => clear(x, y, z))) { env.feedback?.refuse("You're standing there", { id: mat[0] }); return false; }
      }
      const [id] = mat;
      const p = transfer.put(load, { cells: inGrid, max: inGrid.length, id });
      if (!p) return false;
      const point = lo.clone().add(hi).multiplyScalar(0.5);
      lastBlock = { min: min.clone(), max: max.clone(), size: biteSize(env.owner), id, landed: null };
      const block = lastBlock;
      p.then((landed) => {
        block.landed = landed;
        if (landed) env.feedback?.act('place', { id, point, amount: landed });
      });
      rig.hit(HIT.PLACE);
      return true;
    }

    return {
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
        picker?.setVisible(true);
        if (!picker?.open) wheelBite(env, ctx);
        show(ctx);
        if (picker?.open) return;
        if (button.ready(ctx) && place(ctx)) { button.fire(); pose.start(true); }
        if (next.ready(ctx)) {
          next.fire();
          if (picker) picker.show();
          else {
            const have = packContents(load);
            const cur = have.findIndex(([id]) => id === material()?.[0]);
            if (have.length) chosen = have[(cur + 1) % have.length][0];
          }
        }
        pivot.rotation.x = pose.angle(toolDt(ctx));
      },
      deselect() { picker?.setVisible(false); hand.visible = false; button.reset(); next.reset(); pose.stop(); if (shown) { clearMark(); shown = false; } },
      status() {
        const mat = material();
        return biteStatus(env, mat ? `${ELEMENTS[mat[0]].abbr} ×${mat[1]}` : null);
      },
      readout() {
        const mat = material();
        if (!mat) return { name: 'Pack empty', color: 'transparent', note: 'dig with the shovel or pickaxe' };
        return { name: `${ELEMENTS[mat[0]].name} ×${mat[1]}`, color: ELEMENTS[mat[0]].color, note: 'right-click: materials' };
      },
      wantsWheel: () => bitesByWheel(env), wheelUse: WHEEL_USE,   // the wheel sizes the block (dig.js)
      get lastBlock() { return lastBlock; },
      worldReplaced() { picker?.setVisible(false); chosen = -1; },
      dispose() { if (shown) clearMark(); picker?.dispose(); mesh.dispose(); hand.removeFromParent(); },
    };
  },
};
