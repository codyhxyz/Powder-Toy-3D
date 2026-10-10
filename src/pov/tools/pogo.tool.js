import { HIT, viewmodelRig } from '../viewmodel.js';
import { attachModel } from '../models.js';

// Pogo stick: a movement tool. While it's in hand the body bounces on every
// landing, and a press of jump timed to the landing bounces it a step higher,
// three steps to the top (Commander Keen 4's pogo, Super Mario 64's triple
// jump: player.js holds the physics and its numbers). It doesn't bounce off
// liquid; the spring takes its own landings. Holding jump still flies the
// jetpack.
//
// The tool only holds the stick: every frame it's selected it tells the body
// so (ctx.player.holdPogo()), and the body does the rest, so an NPC's body
// pogoes by the same rules. The hands jolt with each bounce (viewmodel.js HIT.POGO).

export default {
  key: 'POGO', name: 'Pogo stick', slot: 12, model: 'pogo',
  desc: 'Hold it to bounce. Press jump just as you land to bounce higher, three times in a row to the top. Hold jump to fly.',
  create(env) {
    const rig = viewmodelRig(env);
    // the held stick, in cells (camera space): the handlebar low in front, the stick down out of view
    const hand = rig.hand([0.2, -1.45, -1.7]);
    const mesh = attachModel(hand, 'pogo');
    hand.visible = false;
    let wasGround = false;
    return {
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
        ctx.player?.holdPogo?.();
        // a landing (the bounce leaves on the next frame): the stick's jolt in the hands
        const ground = !!ctx.player?.onGround;
        if (ground && !wasGround) rig.hit(HIT.POGO);
        wasGround = ground;
      },
      deselect() { hand.visible = false; wasGround = false; },
      status: () => null,
      dispose() { mesh.dispose(); hand.removeFromParent(); },
    };
  },
};
