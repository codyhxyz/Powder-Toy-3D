import { createHotbar, HOTBAR_SLOTS, slotKey } from './hotbar.js';
import { GEAR, gearByKey } from './catalog.js';
import { inventory } from './inventory.js';
import { sharedTransfer, emptyLoads } from './transfer.js';
import { povEvents } from '../events.js';
import { createBallistics } from '../ballistics.js';

export { emptyLoads };

// The POV toolbelt: finds every ./*.tool.js, carries the ones the inventory
// holds (inventory.js) in their catalog slots (catalog.js), and drives the one
// in hand. See docs/pov.md, "The tool contract" and "Inventory".
//
// Number key k picks slot k: the tool last held in it, or, if a tool of that
// slot is already in hand, the next one in it. The wheel steps through every
// tool carried, in catalog order.
//
// Tools get the shell's env plus:
//   env.transfer   the shared exact cell transfer (transfer.js)
//   env.ballistics the shared projectiles (ballistics.js: the guns' rounds, the bomb, the rocket): the toolbelt
//                  flies them every frame whichever tool is held, and on its own clock while hidden
//   env.feedback   the shared "can't" responses, the same for every tool:
//                    toast(text)         a toast
//                    notice(text)        a toast, at most once per NOTICE_INTERVAL per tool
//                    shake()             a shake of the tool's slot
//                    refuse(text, extra) a notice, a shake and tool:action 'refuse' (extra: { id, point })

const modules = import.meta.glob('./*.tool.js', { eager: true });
// every tool's definition, with where it came from, in catalog order
const toolDefs = () => Object.entries(modules).map(([path, mod]) => ({ path, def: mod.default }))
  .filter(({ path, def }) => {
    if (!def?.create) return false;
    if (gearByKey(def.key)) return true;
    console.warn(`toolbelt: ${path} (${def.key}) has no catalog entry`);
    return false;
  })
  .sort((a, b) => GEAR.indexOf(gearByKey(a.def.key)) - GEAR.indexOf(gearByKey(b.def.key)));
const DEFAULT_TOOL = GEAR[0].key;   // in hand first (the shovel)
const NOTICE_INTERVAL = 1.5;   // s between repeats of a tool's notice and refuse toasts
const MS_PER_S = 1000;

export function createToolbelt(env) {
  const hotbar = createHotbar((i) => pressSlot(i), (key) => select(key));
  const transfer = sharedTransfer(env);
  const ballistics = createBallistics({ renderer: env.renderer });
  ballistics.prepare(env.getSim());
  // Hidden (out of POV, dead) the toolbelt isn't updated, but what's in the air
  // keeps flying until it lands, at the last frame's step rate.
  let shown = false, lastSteps = 0, raf = 0, rafAt = 0;
  function drive(now) {
    raf = 0;
    if (shown || !ballistics.count) return;
    const dt = rafAt ? (now - rafAt) / MS_PER_S : 0;
    rafAt = now;
    ballistics.update({ sim: env.getSim(), dt, stepsPerFrame: lastSteps });
    raf = requestAnimationFrame(drive);
  }
  const tools = new Map();   // key → { def, inst, slot }, every tool (carried or not), in catalog order

  for (const { path, def } of toolDefs()) {
    const slot = gearByKey(def.key).slot;
    let lastNotice = -Infinity;
    const feedback = {
      toast: (text) => env.hud?.toast?.(text),
      shake: () => hotbar.shake(slot),
      notice(text) {
        const now = performance.now() / MS_PER_S;
        if (now - lastNotice < NOTICE_INTERVAL) return false;
        lastNotice = now;
        feedback.toast(text);
        return true;
      },
      refuse(text, extra) {
        if (!feedback.notice(text)) return;
        feedback.shake();
        povEvents.emit('tool:action', { tool: def.key.toLowerCase(), action: 'refuse', ...extra });
      },
    };
    try {
      tools.set(def.key, { def, slot, inst: def.create({ ...env, transfer, ballistics, feedback }) });
    } catch (err) { console.error(`toolbelt: ${path} failed to start`, err); }
  }

  const carried = () => inventory.owned.filter((k) => tools.has(k));
  const inSlot = (i) => carried().filter((k) => tools.get(k).slot === i);
  const lastIn = Array(HOTBAR_SLOTS).fill(null);   // per slot, the tool last in hand there
  let selected = null;
  let readout = null;   // the selected tool's readout?.(ctx) from the last update

  // the bar from the inventory: each slot's tools and the one it holds now
  function refresh() {
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const keys = inSlot(i);
      if (!keys.includes(lastIn[i])) lastIn[i] = keys[0] ?? null;
      hotbar.setSlot(i, keys.map((k) => tools.get(k).def), keys.indexOf(lastIn[i]));
    }
  }

  // hold tool `key` (or, given a number, the carried tool at that place in catalog order)
  function select(key) {
    if (typeof key === 'number') key = carried()[key];
    const t = tools.get(key);
    if (!t || !inventory.has(key)) return false;
    if (key !== selected) tools.get(selected)?.inst.deselect?.();
    selected = key;
    lastIn[t.slot] = key;
    refresh();
    hotbar.select(t.slot);
    env.requestRender?.();
    return true;
  }

  // slot i's key: the tool last held there, or the next one if it's in hand already
  function pressSlot(i) {
    const keys = inSlot(i);
    if (!keys.length) { hotbar.shake(i); return; }
    const cur = tools.get(selected)?.slot === i ? keys.indexOf(selected) : -1;
    select(cur >= 0 ? keys[(cur + 1) % keys.length] : (lastIn[i] ?? keys[0]));
  }

  // the wheel: the next (+1) or previous (−1) tool carried, across slots
  function step(dir) {
    const keys = carried();
    const i = keys.indexOf(selected);
    select(keys[(((i < 0 ? 0 : i + dir) % keys.length) + keys.length) % keys.length]);
  }

  refresh();
  select(inventory.takePending() ?? DEFAULT_TOOL);
  // a tool given while carried (the palette, Q in first person) goes in its slot and in hand
  const offGive = inventory.on((key) => { refresh(); if (inventory.takePending() === key) select(key); });

  // the number keys (1 to HOTBAR_SLOTS) pick a slot while in POV (and don't reach the god view's hotkeys)
  function onKey(e) {
    if (!env.isActive?.() || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const i = e.key.length === 1 ? [...Array(HOTBAR_SLOTS).keys()].find((j) => slotKey(j) === e.key) : undefined;
    if (i === undefined) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) pressSlot(i);
  }
  addEventListener('keydown', onKey, { capture: true });

  const held = () => tools.get(selected)?.inst;
  return {
    get selected() { return selected; },
    get selectedKey() { return selected; },   // the held tool's key ('GUN', ...)
    get wantsWheel() { return !!held()?.wantsWheel?.(); },
    get zoom() { return held()?.zoom?.() ?? 1; },   // the held tool's view zoom (the sniper's scope): FOV ÷ this
    get transfer() { return transfer; },
    get ballistics() { return ballistics; },
    get readout() { return readout; },
    get carried() { return carried(); },
    // a tool by key (or, given a number, the carried tool at that place), carried or not
    tool: (key) => tools.get(typeof key === 'number' ? carried()[key] : key)?.inst ?? null,
    select,
    pressSlot,
    update(ctx) {
      const cur = held();
      if (ctx.wheel && !cur?.wantsWheel?.()) step(Math.sign(ctx.wheel));
      held()?.update(ctx);
      tools.forEach((t) => t.inst.tick?.(ctx));   // what every tool keeps doing, held or not (a torch lying lit)
      readout = held()?.readout?.(ctx) ?? null;
      lastSteps = ctx.stepsPerFrame;
      ballistics.update(ctx);
      for (let i = 0; i < HOTBAR_SLOTS; i++) hotbar.setStatus(i, tools.get(lastIn[i])?.inst.status?.() ?? '');
    },
    setVisible(v) {
      hotbar.setVisible(v);
      shown = v;
      if (!v && ballistics.count && !raf) { rafAt = 0; raf = requestAnimationFrame(drive); }
      if (!v) { held()?.deselect?.(); readout = null; }
    },
    // The window moved over the world by (dx, 0, dz) cells (docs/scaling.md
    // D11): every tool, selected or not, moves the grid positions it keeps.
    windowShifted(dx, dz) { tools.forEach((t) => t.inst.windowShifted?.(dx, dz)); },
    // the world was replaced (a scene load, undo, a new grid): what tools left in it is gone
    worldReplaced() { tools.forEach((t) => t.inst.worldReplaced?.()); },
    dispose() {
      removeEventListener('keydown', onKey, { capture: true });
      offGive();
      if (raf) cancelAnimationFrame(raf);
      ballistics.dispose();
      tools.forEach((t) => { t.inst.deselect?.(); t.inst.dispose?.(); });
      hotbar.dispose();
    },
  };
}

// An NPC's tools (npc.js): every tool the player has, headless. The same tool
// code, so the same physics and rules; its own pack and bucket (env.owner); the
// shared projectiles (env.ballistics, the player's toolbelt's, which flies them);
// no hotbar and no toasts. Held models hang on env.viewmodel, a group nobody
// draws. A refusal (no room to throw, nothing to build with) is kept as
// lastRefusal, so the brain can tell a tool failed and try something else.
//
// Run tools inside povEvents.as(actor, ...) (npc.js does), so what they emit is
// the NPC's.
export function createKit(env) {
  const transfer = sharedTransfer(env);
  let lastRefusal = null;
  const feedback = {
    toast() {}, shake() {},
    notice() { return false; },
    refuse(text) { lastRefusal = { text, at: performance.now() / MS_PER_S }; },
  };
  const tools = new Map();
  for (const { path, def } of toolDefs()) {
    try {
      tools.set(def.key, def.create({ ...env, transfer, feedback, hud: null, isActive: () => false }));
    } catch (err) { console.error(`kit: ${path} failed to start`, err); }
  }
  let held = null;
  return {
    get keys() { return [...tools.keys()]; },
    tool: (key) => tools.get(key) ?? null,
    get held() { return held; },
    get lastRefusal() { return lastRefusal; },
    // run tool `key` this frame with ctx (the one held before is put away first)
    use(key, ctx) {
      if (held !== key) { tools.get(held)?.deselect?.(); held = key; }
      tools.get(key)?.update(ctx);
    },
    putAway() { tools.get(held)?.deselect?.(); held = null; },
    dispose() {
      tools.forEach((t) => { t.deselect?.(); t.dispose?.(); });
      tools.clear();
    },
  };
}
