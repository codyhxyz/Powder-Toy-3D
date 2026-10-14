import { attachModel, jagexColor } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { gear } from './catalog.js';

// Tool gun: Garry's Mod's gmod_tool. Whatever the spawn menu (Q) picked last,
// an element, a brush tool, a construction or a spawner, it does what a click
// does in the god view, at the crosshair instead of the cursor. The doing is
// the app's (app.js toolGun: the same code as the god view's click), so the two
// never drift apart; this is the gun in your hand and its buttons.
//
//   left (hold)   spawn: an element pours while held, a construction or a spawner is set per click
//   right (hold)  erase: The Powder Toy's right button draws its secondary
//                 element, which starts as nothing (an eraser)
//   middle        pick up what you aim at (Minecraft creative's pick block): app.js
//
// An NPC's kit (createKit) has no env.toolGun: the gun is carried but does nothing.

const HELD_POS = [0.6, -0.45, -1.45];   // cells, camera space: the physgun's pose (GMod holds both alike)

export default {
  ...gear('TOOLGUN'),
  create(env) {
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    hand.visible = false;
    let screen = null, shown = null;
    const mesh = attachModel(hand, 'toolgun', (obj) => {
      screen = obj.getObjectByName('screen');
      if (screen) screen.material = screen.material.clone();   // its own: the models' materials are shared
    });
    const gun = env.toolGun ?? null;
    let down = null;   // the button holding a stroke ('primary' or 'secondary'), or null

    function letGo() {
      if (down) gun?.release();
      down = null;
    }

    return {
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
        if (!gun) return;
        gun.aim();   // the brush and the construction ghost follow the crosshair this frame
        const item = gun.item;
        if (screen && item && item.color !== shown) { screen.material.color.copy(jagexColor(item.color)); shown = item.color; }
        if (down && !ctx[down]) letGo();
        if (down) return;
        const button = ctx.primaryPressed ? 'primary' : ctx.secondaryPressed ? 'secondary' : null;
        if (!button) return;
        const r = gun.press({ erase: button === 'secondary' });
        if (!r) return;
        if (r === 'stroke') down = button;
        rig.hit(HIT.DRY);
        env.feedback?.act('fire');
      },
      // what it holds, by the crosshair (GMod's tool gun shows its mode on its screen and the HUD)
      readout() {
        const item = gun?.item;
        return item ? { name: item.name, color: item.color, note: 'Q to change' } : null;
      },
      deselect() { hand.visible = false; letGo(); },
      worldReplaced() { letGo(); },
      dispose() { letGo(); screen?.material.dispose(); mesh.dispose(); hand.removeFromParent(); },
    };
  },
};
