import { createHotbar, HOTBAR_SLOTS, slotKey } from './hotbar.js';
import { GEAR, gearByKey } from './catalog.js';
import { inventory } from './inventory.js';
import { sharedTransfer, emptyLoads } from './transfer.js';
import { povEvents } from '../events.js';
import { createBallistics } from '../ballistics.js';
import * as THREE from 'three';
import { PRESETS } from '../wands/catalog.js';
import { createWandRuntime } from '../wands/runtime.js';
import { createWandEditor } from '../wands/editor.js';
import { createDescentLoot, descentWands, wandLines } from '../wands/loot.js';
import { levelByScene } from '../wands/descentSites.js';
import { viewmodelRig, heldMaterial, HIT, VIEWMODEL_GLOW_LAYER } from '../viewmodel.js';
import { wandLook } from '../wands/look.js';

export { emptyLoads };

// The POV toolbelt: finds every ./*.tool.js, carries the ones the inventory
// holds (inventory.js) in their catalog slots (catalog.js), and drives the one
// in hand. See docs/pov.md, "The tool contract" and "Inventory".
//
// Number key k picks slot k: the tool last held in it, or, if a tool of that
// slot is already in hand, the next one in it. The wheel steps through every
// tool carried, in catalog order.
//
// Wands (src/pov/wands/, docs/wands.md) exist only in the Noita gamemode (the
// Descent map), and there they are all you carry: the run's wands sit in the
// Guns slot and are picked like tools (the number key and the wheel cycle them,
// as HL2 cycles a slot's weapons); B edits one at a Holy Mountain. Every other
// map has the tools and no wands.
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
// the body holding the tools has a status that takes its hands (status.js noTools: Polymorph);
// the player's ctx carries its body as ctx.player.body, an NPC's ctx.player is its body
const noHands = (ctx) => !!(ctx.player?.body?.status ?? ctx.player?.status)?.noTools;
const WAND = 'WAND';              // selectedKey while a wand is in hand
const WAND_KEY = 'WAND:';
const DESCENT_ID = 'descent:';    // a Descent wand's row id: DESCENT_ID + its inventory slot (wands/descentRun.js)
const DESCENT_SLOT = 2;           // Descent's wands are its guns: the Guns slot, ahead of its tools         // a wand's row key in the hotbar stack: WAND_KEY + preset id (or 'custom')
const WAND_COLOR = '#b994ff';
// The held wand, in cells along the hand (−z forward): pommel, wrapped handle, collar, a shaft
// tapering to a capped gem that glows in the wand's main spell's colour (wands/look.js) and
// flares on each cast, as Noita's wands show their spell. Casts are drawn from the gem.
const WAND_PARTS = {
  pommel: { radius: 0.07, z: 0.3, color: '#c9a14a' },
  handle: { radius: 0.058, length: 0.42, z: 0.06, color: '#3b2618' },
  collar: { radius: 0.078, length: 0.07, z: -0.18, color: '#c9a14a' },
  shaft: { back: 0.05, front: 0.028, length: 0.78, z: -0.6, color: '#6b4526' },
  cap: { radius: 0.042, length: 0.06, z: -1.0, color: '#c9a14a' },
  gem: { radius: 0.085, z: -1.09 },
  halo: { radius: 0.15, opacity: 0.35 },   // an additive glow round the gem (the hands' pass has no bloom: it goes on the glow layer)
};
const WAND_SIDES = 10;                // sides on the wand's round parts
const GEM_GLOW = 1.6;                 // the gem's colour × this at rest (above 1 it reads as lit from within)
const GEM_FLASH_GAIN = 2.5;           // on a cast its brightness rises by this × the flash...
const GEM_FLASH_GROW = 0.6;           // ...and its size by this share...
const GEM_FLASH_DECAY = 8;            // ...falling off at this rate (1/s, exponential)

export function createToolbelt(env) {
  const hotbar = createHotbar((i) => pressSlot(i), (key) => select(key));
  const transfer = sharedTransfer(env);
  const wandRuntime = createWandRuntime({ ...env, transfer });
  const wandRig = viewmodelRig(env);
  const wandHand = wandRig.hand([0.5, -0.4, -1.2]);
  wandHand.name = 'held-wand';
  wandHand.visible = false;
  const P = WAND_PARTS;
  const along = (geometry, color, z) => {   // a round part laid along the hand's −z
    const mesh = new THREE.Mesh(geometry, heldMaterial(color));
    mesh.rotation.x = Math.PI / 2; mesh.position.z = z;
    return mesh;
  };
  const wandParts = [
    along(new THREE.SphereGeometry(P.pommel.radius, WAND_SIDES, WAND_SIDES / 2), P.pommel.color, P.pommel.z),
    along(new THREE.CylinderGeometry(P.handle.radius, P.handle.radius, P.handle.length, WAND_SIDES), P.handle.color, P.handle.z),
    along(new THREE.CylinderGeometry(P.collar.radius, P.collar.radius, P.collar.length, WAND_SIDES), P.collar.color, P.collar.z),
    along(new THREE.CylinderGeometry(P.shaft.back, P.shaft.front, P.shaft.length, WAND_SIDES), P.shaft.color, P.shaft.z),
    along(new THREE.CylinderGeometry(P.cap.radius, P.cap.radius, P.cap.length, WAND_SIDES), P.cap.color, P.cap.z),
  ];
  const gem = new THREE.Mesh(new THREE.IcosahedronGeometry(P.gem.radius, 0), new THREE.MeshBasicMaterial({ color: '#efcf79' }));
  gem.position.z = P.gem.z;
  const halo = new THREE.Mesh(new THREE.IcosahedronGeometry(P.halo.radius, 1), new THREE.MeshBasicMaterial({
    color: '#efcf79', transparent: true, opacity: P.halo.opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.userData.vmLayer = VIEWMODEL_GLOW_LAYER;   // light round the gem goes on the glow pass (viewmodel.js), as the torch's flame does
  gem.add(halo);
  wandHand.add(...wandParts, gem);
  let gemFlash = 0, gemCards = null, gemLook = wandLook([]);
  const vTip = new THREE.Vector3();
  // where a cast is drawn from (wands/runtime.js update's view): the gem in first person,
  // the body's right hand in third (env.handWorld), else nothing (the eye)
  function wandView() {
    let world = null;
    if (env.viewmodel?.visible) { gem.updateWorldMatrix(true, false); world = gem.getWorldPosition(vTip); }
    else world = env.handWorld?.(vTip) ?? null;
    if (!world) return null;
    const tip = world.clone().sub(env.getVolume().position).divideScalar(env.getScale());
    return { tip, tipWorld: world.clone() };
  }
  // the gem's colour (the wand's main spell) and its flare after a cast
  function updateGem(dt) {
    const cards = wandRuntime.definition?.cards ?? null;
    if (cards !== gemCards) { gemCards = cards; gemLook = wandLook(cards ?? []); }
    gemFlash *= Math.exp(-GEM_FLASH_DECAY * dt);
    const glow = GEM_GLOW * (1 + GEM_FLASH_GAIN * gemFlash);
    gem.material.color.copy(gemLook.color).multiplyScalar(glow);
    halo.material.color.copy(gemLook.color).multiplyScalar(glow);
    gem.scale.setScalar(1 + GEM_FLASH_GROW * gemFlash);
  }
  let wandSelected = false, wandSlot = 0, wandId = null, custom = null;
  const editor = createWandEditor({
    runtime: wandRuntime, toast: (text) => env.hud?.toast?.(text),
    onOpenChange(open) {
      env.onEditorOpenChange?.(open);
      if (open) putAway();
      else if (wandSelected && wandRuntime.definition) wandRuntime.equip(wandRuntime.definition);
    },
    onSave(def) {
      custom = { ...def, slot: clampSlot(def.slot ?? wandSlot + 1) + 1, name: def.name.trim() || 'Custom wand' };
      wandSlot = custom.slot - 1;
      wandSelected = true; wandId = 'custom';
      lastIn[wandSlot] = WAND_KEY + wandId;
      refresh(); hotbar.select(wandSlot);
      env.requestRender?.();
    },
  });
  const ballistics = createBallistics({ renderer: env.renderer });
  ballistics.prepare(env.getSim());
  // Hidden (out of POV, dead) the toolbelt isn't updated, but what's in the air
  // keeps flying until it lands, at the last frame's step rate.
  let shown = false, lastSteps = 0, raf = 0, rafAt = 0, lastCtx = null;
  function drive(now) {
    raf = 0;
    if (shown || (!ballistics.count && !wandRuntime.active)) return;
    const dt = rafAt ? (now - rafAt) / MS_PER_S : 0;
    rafAt = now;
    const ctx = { ...lastCtx, sim: env.getSim(), dt, stepsPerFrame: env.getStepsPerFrame?.() ?? lastSteps,
      primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0 };
    ballistics.update(ctx);
    if (lastCtx) wandRuntime.tick(ctx);
    env.requestRender?.();
    if (ballistics.count || wandRuntime.active) raf = requestAnimationFrame(drive);
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

  // The Noita gamemode (Descent's levels) puts wands in hand and nothing else; every other map has
  // the tools and no wands (the user's call, 2026-10-11)
  const carried = () => (descentLevel ? [] : inventory.owned.filter((k) => tools.has(k)));
  const inSlot = (i) => carried().filter((k) => tools.get(k).slot === i);
  const lastIn = Array(HOTBAR_SLOTS).fill(null);   // per slot, the tool last in hand there
  let selected = null;
  let readout = null;   // the selected tool's readout?.(ctx) from the last update

  const clampSlot = (slot) => Math.max(0, Math.min(HOTBAR_SLOTS - 1, (Number.isInteger(slot) ? slot : 1) - 1));
  // slot i's wand rows: on Descent (wands/descentRun.js) the run's four wand slots, in the Guns slot;
  // anywhere else none (no presets, no custom wand: wands are the Noita gamemode's)
  let descentLevel = null, descentKey;
  const wandRows = (i) => (descentLevel && i === DESCENT_SLOT ? descentWands.wands.map((w, j) => ({ key: WAND_KEY + DESCENT_ID + j,
    name: `Wand ${j + 1}: ${w.name}`, desc: wandLines(w).join(' · '), color: WAND_COLOR })) : []);

  // slot i's row keys: its carried tools, then its wands (only in a slot that carries a tool, so a class's empty slots stay empty)
  const slotKeys = (i) => {
    const keys = inSlot(i), wands = wandRows(i).map((r) => r.key);
    if (descentLevel) return [...wands, ...keys];
    return keys.length ? [...keys, ...wands] : [];
  };
  const rowDef = (k) => (k.startsWith(WAND_KEY) ? wandRows(wandSlotOf(k)).find((r) => r.key === k) : tools.get(k).def);
  const wandSlotOf = (k) => {
    const id = k.slice(WAND_KEY.length);
    if (id.startsWith(DESCENT_ID)) return DESCENT_SLOT;
    return clampSlot((id === 'custom' ? custom : PRESETS.find((p) => p.id === id))?.slot);
  };
  const slotOf = (k) => (k?.startsWith(WAND_KEY) ? wandSlotOf(k) : tools.get(k)?.slot);
  const heldKey = () => (wandSelected ? WAND_KEY + wandId : selected);
  // every row key, slot by slot (the wheel's order)
  const allKeys = () => [...Array(HOTBAR_SLOTS).keys()].flatMap(slotKeys);

  // the bar from the inventory: each slot's tools (then its wands) and the one it holds now
  function refresh() {
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const keys = slotKeys(i);
      if (!keys.includes(lastIn[i])) lastIn[i] = keys[0] ?? null;
      hotbar.setSlot(i, keys.map(rowDef), keys.indexOf(lastIn[i]));
    }
  }

  // put away whatever is in hand (the tool, or the wand: its flights keep going)
  function putAway() {
    wandHand.visible = false;
    if (wandSelected) wandRuntime.deselect();
    else tools.get(selected)?.inst.deselect?.();
  }

  // hold wand `definition` (a preset id, or { name, cards, config, slot? })
  function equipWand(definition) {
    if (!descentLevel) return false;   // wands are the Noita gamemode's
    const def = typeof definition === 'string' ? PRESETS.find((p) => p.id === definition) : definition;
    if (!def) return false;
    putAway();
    wandRuntime.equip(def);
    wandSlot = clampSlot(def.slot ?? wandSlot + 1);
    const run = descentLevel ? descentWands.wands.findIndex((w) => w.id === def.id) : -1;
    if (run >= 0) {
      wandSlot = DESCENT_SLOT; wandSelected = true; wandId = DESCENT_ID + run; descentWands.held = run;
      lastIn[wandSlot] = WAND_KEY + wandId;
      refresh(); hotbar.select(wandSlot);
      env.releaseInput?.(); env.requestRender?.();
      return true;
    }
    const preset = PRESETS.some((p) => p.id === def.id);
    if (!preset) custom = { ...def, slot: wandSlot + 1, name: def.name?.trim?.() || 'Custom wand' };
    wandSelected = true; wandId = preset ? def.id : 'custom';
    lastIn[wandSlot] = WAND_KEY + wandId;
    refresh(); hotbar.select(wandSlot);
    env.releaseInput?.(); env.requestRender?.();
    return true;
  }

  // hold tool `key` (or, given a number, the carried tool at that place in catalog order; a wand's row key equips it)
  function select(key) {
    if (typeof key === 'string' && key.startsWith(WAND_KEY)) {
      if (key === heldKey()) { hotbar.select(wandSlot); return true; }   // already in hand
      const id = key.slice(WAND_KEY.length);
      if (id.startsWith(DESCENT_ID)) return equipWand(descentWands.wands[Number(id.slice(DESCENT_ID.length))]);
      return equipWand(id === 'custom' ? custom : id);
    }
    if (typeof key === 'number') key = carried()[key];
    const t = tools.get(key);
    if (!t || !inventory.has(key) || descentLevel) return false;
    if (wandSelected) { putAway(); wandSelected = false; wandId = null; descentWands.held = -1; }
    else if (key !== selected) tools.get(selected)?.inst.deselect?.();
    selected = key;
    lastIn[t.slot] = key;
    refresh();
    hotbar.select(t.slot);
    env.requestRender?.();
    return true;
  }

  // slot i's key: the tool (or wand) last held there, or the next one if it's in hand already
  function pressSlot(i) {
    const keys = slotKeys(i);
    if (!keys.length) { hotbar.shake(i); return; }
    const cur = slotOf(heldKey()) === i ? keys.indexOf(heldKey()) : -1;
    select(cur >= 0 ? keys[(cur + 1) % keys.length] : (lastIn[i] ?? keys[0]));
  }

  // the wheel: the next (+1) or previous (−1) tool or wand carried, across slots
  function step(dir) {
    const keys = allKeys();
    if (!keys.length) return;
    const i = keys.indexOf(heldKey());
    select(keys[(((i < 0 ? 0 : i + dir) % keys.length) + keys.length) % keys.length]);
  }

  refresh();
  select(inventory.takePending() ?? DEFAULT_TOOL);
  // a tool given while carried (the palette, Q in first person) goes in its slot and in hand
  const offGive = inventory.on((key) => { refresh(); if (inventory.takePending() === key) select(key); });

  // the number keys (1 to HOTBAR_SLOTS) pick a slot while in POV (and don't reach the god view's hotkeys)
  function onKey(e) {
    if (editor.open || !env.isActive?.() || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.code === 'KeyB' && descentLevel) {   // edit the wand (the Noita gamemode's)
      e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) openEditor(); return;
    }
    const i = e.key.length === 1 ? [...Array(HOTBAR_SLOTS).keys()].find((j) => slotKey(j) === e.key) : undefined;
    if (i === undefined) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) pressSlot(i);
  }
  addEventListener('keydown', onKey, { capture: true });

  // B: the editor. On Descent, Noita's rule: only inside a Holy Mountain, only the wand in
  // hand, and only with the spells you carry (the bag); off it, the free sandbox editor.
  function openEditor() {
    if (!descentLevel) return;   // no wands off the Noita gamemode
    if (!descentWands.inTemple) { env.hud?.toast?.('Edit wands at a Holy Mountain'); return; }
    const slot = wandSelected && wandId?.startsWith(DESCENT_ID) ? Number(wandId.slice(DESCENT_ID.length)) : -1;
    if (slot < 0 || !descentWands.wands[slot]) { env.hud?.toast?.('Hold a wand to edit it'); return; }
    editor.show({ bag: descentWands.bag, commit: (def, bag) => { descentWands.edit(slot, def.cards, bag); } });
  }

  // Descent (docs/descent-contract.md): the run's wands follow the level loaded; its loot
  // floats at the level's sites (wands/loot.js) and is taken with look + E (env.interact).
  const loot = createDescentLoot({ scene: env.scene, getSim: env.getSim, getVolume: env.getVolume, getScale: env.getScale,
    interact: env.interact, toast: (text) => env.hud?.toast?.(text),
    getFeet: () => (lastCtx?.player?.pos ? { feet: lastCtx.player.pos.clone(), dir: lastCtx.dir ?? null } : null) });
  const offTemple = povEvents.on('descent:temple', ({ inside }) => { descentWands.inTemple = inside; });
  const offRun = [
    descentWands.on('change', () => {
      if (!descentLevel) return;
      // the wand in hand changed under it (a swap, an edit): hold its new self
      if (wandSelected && wandId?.startsWith(DESCENT_ID)) {
        const w = descentWands.wands[Number(wandId.slice(DESCENT_ID.length))];
        if (w) wandRuntime.equip(w);
      }
      refresh();
    }),
    descentWands.on('refresh', () => wandRuntime.refill()),
  ];
  function syncDescent() {
    const key = env.getScene?.() ?? null;
    if (key === descentKey) return;
    const was = descentLevel;
    descentKey = key;
    descentLevel = levelByScene(key);
    // a new run starts when you arrive on Descent from elsewhere (A carries it between its levels)
    if (descentLevel && !was) descentWands.reset();
    descentWands.inTemple = false;
    loot.setLevel(descentLevel);
    // in or out of the Noita gamemode: what was in hand may not be carried there
    if (!allKeys().includes(heldKey())) {
      putAway();
      wandSelected = false; wandId = null; descentWands.held = -1; selected = null;
      const keys = allKeys();
      if (keys.length) select(keys[0]); else if (!descentLevel) select(DEFAULT_TOOL);
    }
    refresh();
  }

  const held = () => (wandSelected ? null : tools.get(selected)?.inst);
  let wasHelpless = false;
  return {
    get selected() { return wandSelected ? WAND : selected; },
    get selectedKey() { return wandSelected ? WAND : selected; },   // the held tool's key ('GUN', ...; 'WAND')
    get wantsWheel() { return !!held()?.wantsWheel?.(); },
    get zoom() { return held()?.zoom?.() ?? 1; },   // the held tool's view zoom (the sniper's scope): FOV ÷ this
    get transfer() { return transfer; },
    get ballistics() { return ballistics; },
    get readout() { return readout; },
    get mana() { return wandSelected ? wandRuntime.mana : null; },   // the held wand's { mana, manaMax } (the HUD's bar), else null
    get carried() { return carried(); },
    wandRuntime, editor, equipWand,
    openEditor,
    // a tool by key (or, given a number, the carried tool at that place), carried or not
    tool: (key) => tools.get(typeof key === 'number' ? carried()[key] : key)?.inst ?? null,
    select,
    pressSlot,
    update(ctx) {
      lastCtx = ctx;
      syncDescent();
      if (loot.update()) env.requestRender?.();
      const cur = held();
      // a status that leaves no hands (Polymorph, potions.js): the tool in hand is put away while it lasts,
      // and a wand is drawn again when it ends (putting it away stopped its casting)
      const helpless = noHands(ctx);
      if (helpless && !wasHelpless) putAway();
      else if (!helpless && wasHelpless && wandSelected && wandRuntime.definition) wandRuntime.equip(wandRuntime.definition);
      wasHelpless = helpless;
      if (!editor.open && ctx.wheel && !cur?.wantsWheel?.()) step(Math.sign(ctx.wheel));
      const wandInHand = wandSelected && !editor.open && !helpless;
      wandHand.visible = wandInHand;
      if (wandInHand) {
        wandRig.update(ctx);
        const casts = wandRuntime.stats.casts;
        wandRuntime.update(ctx, wandView());
        if (wandRuntime.stats.casts > casts) { wandRig.hit(HIT.WAND); gemFlash = 1; }
        updateGem(ctx.dt ?? 0);
      } else {
        wandRuntime.tick(ctx);   // flights and fields keep going while a tool is in hand
        if (!helpless && !editor.open) held()?.update(ctx);
      }
      tools.forEach((t) => t.inst.tick?.(ctx));   // what every tool keeps doing, held or not (a torch lying lit)
      readout = wandSelected ? { name: wandRuntime.definition?.name ?? 'Wand', color: WAND_COLOR, note: String(wandRuntime.status() ?? '') }
        : held()?.readout?.(ctx) ?? null;
      lastSteps = ctx.stepsPerFrame;
      ballistics.update(ctx);
      for (let i = 0; i < HOTBAR_SLOTS; i++) hotbar.setStatus(i, tools.get(lastIn[i])?.inst.status?.() ?? '');
    },
    // a click in play: true when it closed the slot selector instead (hotbar.js confirm)
    confirmSelection: () => hotbar.confirm(),
    setVisible(v) {
      hotbar.setVisible(v);
      shown = v;
      if (v && wandSelected && wandRuntime.definition) wandRuntime.equip(wandRuntime.definition);
      if (v && raf) { cancelAnimationFrame(raf); raf = 0; }
      if (!v && (ballistics.count || wandRuntime.active) && !raf) { rafAt = 0; raf = requestAnimationFrame(drive); }
      if (!v) { editor.close(); putAway(); readout = null; }
    },
    // The window moved over the world by (dx, 0, dz) cells (docs/scaling.md
    // D11): every tool, selected or not, moves the grid positions it keeps.
    windowShifted(dx, dz) { tools.forEach((t) => t.inst.windowShifted?.(dx, dz)); wandRuntime.windowShifted(dx, dz); },
    // the world was replaced (a scene load, undo, a new grid): what tools left in it is gone
    worldReplaced() { tools.forEach((t) => t.inst.worldReplaced?.()); wandRuntime.resetWorld(); },
    dispose() {
      removeEventListener('keydown', onKey, { capture: true });
      loot.dispose(); offTemple(); offRun.forEach((off) => off());
      offGive();
      if (raf) cancelAnimationFrame(raf);
      ballistics.dispose();
      editor.dispose(); wandRuntime.dispose();
      wandHand.removeFromParent();
      for (const mesh of [...wandParts, gem, halo]) { mesh.geometry.dispose(); mesh.material.dispose(); }
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
      if (noHands(ctx)) { tools.get(held)?.deselect?.(); held = null; return; }
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
