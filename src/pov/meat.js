import * as THREE from 'three';
import { ELEMENTS, E, K } from '../elements.js';
import { PHYS } from '../physics.js';
import { SEED_MAX } from '../shaders/common.js';
import { BODY_WIDTH, BODY_HEIGHT, BODY_DENS } from './constants.js';
import { VITALS } from './vitals.js';
import { sharedTransfer, cellsNear, ballRadius, Load, TRANSFER_SLOTS } from './tools/transfer.js';

// Gibs and eating: Cruelty Squad's healing, where there is no regeneration and
// you heal by eating gibs cooked with fire. A body killed by overkill
// (vitals.js GIB_HEALTH) bursts into MEAT cells where it stands, and cooked
// meat touching a body is eaten, healing it (vitals.js EAT_HEAL). Both go
// through the exact cell transfer (tools/transfer.js), so matter is conserved:
// the body's mass becomes meat in the sim, and what is eaten leaves the sim.
// The player and the NPCs share it (player.js).

// The body's mass as the sim sees it: its box (BODY_WIDTH² × BODY_HEIGHT
// cells) at BODY_DENS, the box Archimedes floats and the coupling pass clears
// of loose matter. As meat at MEAT's density that's this many cells (13).
export const GIB_CELLS = Math.round(BODY_DENS * BODY_WIDTH ** 2 * BODY_HEIGHT / ELEMENTS[E.MEAT].dens);
const GIB_ROOM = 4;              // candidate cells per gib cell, first try: room around what's in the way...
const GIB_ROOM_GROWTH = 2;       // ...grown by this factor each frame some meat didn't fit
const GIB_TRIES = 6;             // frames a burst keeps placing meat that didn't fit (then it's buried: lost)
const GIB_CENTER = 0.5;          // share of the body's height its middle sits at: the burst's centre

// Eating: the cooked meat cells touching the body, taken a batch at a time.
export const EAT_CELLS_MAX = 64; // contact cells listed per take (≤ TRANSFER_SLOTS)

export function createMeat({ renderer, getSim }) {
  const transfer = () => sharedTransfer({ renderer, getSim });
  let burst = null;        // { load, center, vel, room, tries } while meat is being laid
  let eating = false;      // a take in flight
  const vel = new THREE.Vector3();

  // lay the body's meat: cells nearest its middle first, at its velocity in
  // the sim's units (the momentum it had goes into its meat)
  function placeBurst(sim) {
    const b = burst;
    if (b.busy) return;
    if (!b.load.cells.length || b.tries >= GIB_TRIES) { b.done?.(b.placed, b.load.cells.length); burst = null; return; }
    const room = Math.min(GIB_CELLS * b.room, TRANSFER_SLOTS);
    const cells = cellsNear(b.center, ballRadius(room), sim.g);
    const p = transfer().put(b.load, { cells, vel: b.vel });
    b.tries++;
    b.room *= GIB_ROOM_GROWTH;
    if (!p) return;
    b.busy = true;
    p.then((n) => { b.placed += n; b.busy = false; }, () => { b.busy = false; });
  }

  return {
    get busy() { return !!burst || eating; },
    // The body (feet `pos`, velocity `bodyVel` cells/s, the sim's `stepRate`
    // steps/s) bursts: GIB_CELLS of meat at the body's core temperature.
    // done(placed, lost) once laid.
    gib(pos, bodyVel, stepRate, done = null) {
      const load = new Load(GIB_CELLS);
      const meat = ELEMENTS[E.MEAT];
      for (let i = 0; i < GIB_CELLS; i++) load.cells.push([E.MEAT, VITALS.BODY_T, meat.life, Math.random() * SEED_MAX]);
      vel.copy(bodyVel).divideScalar(stepRate > 0 ? stepRate : Infinity).clampScalar(-PHYS.V_MAX, PHYS.V_MAX);
      burst = {
        load, center: new THREE.Vector3(pos.x, pos.y + BODY_HEIGHT * GIB_CENTER, pos.z), vel: vel.clone(),
        room: GIB_ROOM, tries: 0, placed: 0, busy: false, done,
      };
    },
    // Eat up to `want` of the cooked meat cells listed in `cells` ([x, y, z],
    // touching the body); eaten(n) with how many were. One batch at a time.
    eat(cells, want, eaten) {
      if (eating || want <= 0 || !cells.length) return;
      const load = new Load(want);
      const p = transfer().take(load, { cells, kinds: [K.POWDER], want: E.COOKED_MEAT, limit: want });
      if (!p) return;
      eating = true;
      p.then((got) => { eating = false; if (got.length) eaten(got.length); }, () => { eating = false; });
    },
    // every frame the body updates (it needs the sim)
    update() {
      const sim = getSim();
      if (sim && burst) placeBurst(sim);
    },
    // the window moved (dx, 0, dz) cells over the world (docs/scaling.md D11)
    windowShifted(dx, dz) { if (burst) { burst.center.x -= dx; burst.center.z -= dz; } },
    // the world was replaced (a scene load, undo): meat still to lay belongs to the old one
    reset() { burst = null; },
  };
}
