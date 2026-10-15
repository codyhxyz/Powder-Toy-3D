// Descent's level switch (docs/descent-contract.md, "Events" and "D"). Every
// level is its own world scene with a Holy Mountain at its bottom; walking
// into the temple's exit loads the next level's scene in the same session (no
// page reload) and puts the player at its spawn, run and all. Noita's seam:
// biomes never touch, a Holy Mountain is always between.
//
// This file is plain logic, no three.js and no DOM, so a node check
// (scripts/check-descent-switch.mjs) runs it: the app injects what loads a
// scene, what drops the body in, the overlay and the menu (app.js
// createDescentRunner call). Positions are world cells (grid + sim.origin).

import { BODY_HEIGHT, BODY_WIDTH } from '../constants.js';

export const NAME_SHOW_S = 2;          // s the level's name stays up on arrival (Noita shows the biome's name on entry for about this)
export const WON_MENU_DELAY_S = 4;     // s "You reached the bottom" stays up before the map menu comes back
export const LOAD_POLL_MS = 100;       // ms between looks at whether the next level's window has filled
export const LOAD_WAIT_MS = 60000;     // ms it waits for that before giving up (a cold world compile takes 10-25 s: docs cold-shader-compile)

// Does the body standing with its feet at `feet` ({ x, y, z }) overlap `box`
// [x0, y0, z0, x1, y1, z1] (max inclusive)? The body is an upright box,
// BODY_WIDTH square, BODY_HEIGHT tall: the same test as the Holy Mountain's
// (pov/descent/index.js inBox), so the temple starts where its pool and shop do.
export function bodyInBox(feet, box, width = BODY_WIDTH, height = BODY_HEIGHT) {
  if (!feet || !box) return false;
  const [x0, y0, z0, x1, y1, z1] = box, hw = width / 2;
  return feet.x + hw >= x0 && feet.x - hw <= x1 && feet.y + height >= y0 && feet.y <= y1 && feet.z + hw >= z0 && feet.z - hw <= z1;
}

// The window's first column on a level: over its spawn (app.js worldStart).
export const spawnColumn = (level) => (level?.spawn ? [level.spawn[0], level.spawn[2]] : null);

// What a run carries from level to level, read off the live objects: for the
// check, and for a switch to compare before and after (the body, its perks and
// statuses, the toolbelt and the gold all outlive a scene load; nothing is
// rebuilt, so nothing is copied back). `gold` and `wands` are agent C's purse
// and agent B's descentWands, when they're there.
export function runSnapshot({ player, gold = null, wands = null } = {}) {
  return {
    health: player?.health ?? null,
    shield: player?.shield ?? null,
    perks: player?.perks?.list ? player.perks.list().map(({ perk, n }) => [perk.key, n]) : null,
    status: player?.status?.list ? player.status.list().map((s) => s.key) : null,
    gold,
    wands: wands ? wands.wands.map((w) => w.id) : null,
    bag: wands ? wands.bag.length : null,
    potions: wands?.potions ? wands.potions.map((p) => `${p.material}:${p.cells.length}`) : null,   // the run's flasks and how full
  };
}
// The fields that differ between two snapshots ([] when the run came through whole)
export function runLost(before, after) {
  return Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

// The per-frame part: which level the scene is, the temple's box and exit.
// emit(name, payload) is povEvents.emit. Payloads carry `level`: the index
// into `levels` (0 = the first).
export function createDescentSwitch({ levels, emit }) {
  let key, index = -1, inside = false, exited = false;
  const indexOf = (k) => levels.findIndex((l) => l.key === k);
  return {
    indexOf,
    get index() { return index; },
    get level() { return levels[index] ?? null; },
    get inside() { return inside; },
    // A frame: the scene loaded, the body's feet (world cells) and whether it's
    // alive in first person. Returns { from, next } (next null: that was the
    // last level) the frame the body enters the exit, else null. The exit fires
    // once per arrival.
    update({ key: k, feet, live }) {
      if (k !== key) { key = k; index = indexOf(k); inside = false; exited = false; }
      if (index < 0) return null;
      const t = levels[index].temple;
      const now = !!live && bodyInBox(feet, t?.box);
      if (now !== inside) { inside = now; emit('descent:temple', { level: index, inside }); }
      if (live && !exited && bodyInBox(feet, t?.exit)) {
        exited = true;
        emit('descent:exit', { level: index });
        return { from: index, next: levels[index + 1] ?? null };
      }
      return null;
    },
    // The body stands at level `k`'s spawn: a fresh temple state, and descent:level.
    arrive(k) {
      key = k; index = indexOf(k); exited = false;
      if (inside) { inside = false; emit('descent:temple', { level: index, inside: false }); }
      if (index >= 0) emit('descent:level', { level: index, key: k });
    },
  };
}

// The whole switch: the per-frame part, plus the sequence a level change runs.
// deps (the app's; check-descent-switch.mjs stubs them):
//   levels               DESCENT_LEVELS
//   emit(name, payload)  povEvents.emit
//   loadScene(key)       → Promise: the world scene `key` is loaded and its window filled (the body is out of it meanwhile)
//   enterAt(spawn)       → Promise: the body in first person with its feet at `spawn` (world cells), health, statuses and all kept
//   snapshot()           → runSnapshot(...) of the run now
//   overlay              { show(title, sub, seconds?), hide() }: Noita's biome-name card
//   toast(text)          a HUD toast
//   finish()             the run is won: out of the body, the map menu
//   wait(s)              → Promise after s seconds
//   loadId()             the loaded world's identity (frame's `load`), read once the body is in
export function createDescentRunner(deps) {
  const { levels, emit, overlay, toast = () => {}, wait } = deps;
  const sw = createDescentSwitch({ levels, emit });
  let busy = false, arrivedFor = null;   // arrivedFor: the load (window) whose arrival was announced

  async function descend(from, next) {
    busy = true;
    const before = deps.snapshot?.();
    try {
      overlay?.show('Descending…', `Leaving ${levels[from].name}`);
      await deps.loadScene(next.key);
      await deps.enterAt(next.spawn);
      arrivedFor = deps.loadId?.() ?? arrivedFor;
      sw.arrive(next.key);
      overlay?.show(next.name, `Level ${levels.indexOf(next) + 1}`, NAME_SHOW_S);
      const lost = before ? runLost(before, deps.snapshot()) : [];
      if (lost.length) console.warn('Descent: the level switch lost', lost, before);
      return true;
    } catch (err) {
      console.error('Descent: the next level failed to load', err);
      overlay?.hide();
      toast("The way down didn't open");
      return false;
    } finally {
      busy = false;
    }
  }

  async function win() {
    busy = true;
    const completion = sw.level?.completion;
    overlay?.show(completion?.title ?? 'You reached the bottom', completion?.subtitle ?? 'The run is won', WON_MENU_DELAY_S);
    toast('You reached the bottom');
    await wait(WON_MENU_DELAY_S);
    busy = false;
    deps.finish();
  }

  return {
    get busy() { return busy; },
    get level() { return sw.level; },
    get index() { return sw.index; },
    get inside() { return sw.inside; },
    indexOf: sw.indexOf,
    // A frame. `load` is the loaded world's identity (the window object): a new
    // one on a Descent scene that the body enters by hand (the map menu's
    // Descent, then F) gets its descent:level on its first live frame.
    // Returns the switch's promise when one starts, else null.
    frame({ key, feet, live, load }) {
      if (busy) return null;
      if (live && sw.indexOf(key) >= 0 && arrivedFor !== load) {
        arrivedFor = load;
        sw.arrive(key);
        const lv = levels[sw.index];
        overlay?.show(lv.name, `Level ${sw.index + 1}`, NAME_SHOW_S);
      }
      const go = sw.update({ key, feet, live });
      if (!go) return null;
      if (!go.next) return win();
      return descend(go.from, go.next);
    },
  };
}
