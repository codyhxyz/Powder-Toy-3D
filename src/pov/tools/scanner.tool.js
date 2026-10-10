import * as THREE from 'three';
import { ELEMENTS } from '../../elements.js';
import { CELL_M } from '../../scale.js';
import { attachModel } from '../models.js';
import { viewmodelRig } from '../viewmodel.js';
import { gear } from './catalog.js';

// Scanner: reads out what's under the crosshair at any distance, the
// god view's hover readout (ui/hud.js showReadout) beside the crosshair: the
// material, its temperature and the air pressure there, and how far away it is.
// Gases don't stop the pick, so it reads the first liquid or solid or powder.
// It doesn't touch the world.

const HELD_POS = [0.55, -0.5, -1.5];
const HELD_PITCH = 0.3;      // rad, screen tipped up toward the eye
const DIST_DECIMALS = 1;     // m shown to this many decimals

export default {
  ...gear('SCANNER'),
  create(env) {
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    const held = new THREE.Group();
    held.rotation.x = HELD_PITCH;
    hand.add(held);
    const mesh = attachModel(held, 'scanner');

    return {
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
      },
      deselect() { hand.visible = false; },
      readout(ctx) {
        const a = ctx.aim;
        if (!a?.valid) return { name: 'Nothing in range', color: 'transparent', note: '' };
        const far = Number.isFinite(a.dist) ? ` · ${(a.dist * CELL_M).toFixed(DIST_DECIMALS)} m` : '';
        if (a.id < 0) return { name: `Floor${far}`, color: 'transparent', note: '' };
        const el = ELEMENTS[a.id];
        return { name: `${el.name}${far}`, color: el.color, T: a.T, P: a.P };
      },
      dispose() { mesh.dispose(); hand.removeFromParent(); },
    };
  },
};
