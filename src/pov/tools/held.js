import * as THREE from 'three';
import { attachModel } from '../models.js';
import { viewmodelRig } from '../viewmodel.js';

// The small shared part of a held tool's lifecycle (Roblox Tool's equipped,
// update, unequipped, cleanup): own one hand/model, not the shared rig. Tool
// actions, resources and public getters remain in the tool, not a plugin API.
// update's visibility override keeps scoped guns hidden without skipping rig
// motion. Works for NPC viewmodels too: no HUD, camera or DOM required.
export function heldModel(env, { model, pos, pivot = false }) {
  const rig = viewmodelRig(env);
  const hand = rig.hand(pos);
  const mount = pivot ? new THREE.Group() : hand;
  if (pivot) hand.add(mount);
  const mesh = attachModel(mount, model);
  let disposed = false;
  return {
    rig, hand, pivot: mount, mesh,
    update(ctx, visible = true) {
      if (disposed) return;
      hand.visible = visible;
      rig.update(ctx);
    },
    deselect() { hand.visible = false; },
    dispose() {
      if (disposed) return;
      disposed = true;
      hand.visible = false;
      mesh.dispose();
      rig.releaseHand(hand);
    },
  };
}
