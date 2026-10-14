import { SPELL_BY_ID } from './catalog.js';
import { compileWand } from './compiler.js';
import { starterWand, bombWand } from './generate.js';
import { createEmitter } from '../events.js';

// A Descent run's wands and spells (docs/descent-contract.md, B): Noita's
// inventory, four wand slots and a bag of loose spells, kept across the
// levels (this module outlives a scene load). Plain state, no rendering:
// loot.js draws the pickups, tools/index.js puts the wands in the hotbar,
// the Holy Mountain's shop (agent C) gives through descentWands.give / giveSpell.

export const WAND_SLOTS = 4;   // Noita: four wand slots in the inventory
export const BAG_MAX = 64;     // spells carried loose (Noita: 16 inventory slots; ours holds a run's worth)
export const POTION_SLOTS = 4; // Noita: four item slots beside the wands; ours hold potion flasks only

const events = createEmitter('descentWands');   // 'change', 'drop', 'refresh', 'place', 'reset' (descentWands.on)
const emit = events.emit;
const copyWand = (w) => ({ ...w, cards: [...w.cards], config: { ...w.config }, ...(w.look ? { look: { ...w.look } } : {}) });

// potions: the run's flasks, { id, material (element key it was found with), name, cells: [[id, T, life, seed]] }
// (descent/flasks.js makeFlask); the flask tool pours, drinks and throws the one in hand (tools/index.js)
const run = { wands: [], bag: [], potions: [], held: -1, inTemple: false, taken: new Set(), seed: 0 };
const copyFlask = (f) => ({ ...f, cells: f.cells.map((c) => [...c]) });

export const descentWands = {
  get wands() { return run.wands; },
  get bag() { return run.bag; },
  // the wand slot in hand (−1: none); tools/index.js sets it as the player switches
  get held() { return run.held; },
  set held(i) { run.held = Number.isInteger(i) && i >= 0 && i < run.wands.length ? i : -1; },
  get inTemple() { return run.inTemple; },
  set inTemple(v) { run.inTemple = !!v; },
  get full() { return run.wands.length >= WAND_SLOTS; },
  // loot sites already taken this run ('levelKey:index'), so a reloaded level doesn't refill them
  taken: (id) => run.taken.has(id),
  markTaken(id) { run.taken.add(id); },

  // A new run: Noita's two starting wands (starting_wand.lua's Bolt staff and the bomb wand), an empty bag.
  reset(seed = Date.now()) {
    run.seed = seed;
    run.wands = [starterWand(seed), bombWand(seed)];
    run.bag = []; run.potions = []; run.held = 0; run.inTemple = false; run.taken.clear();
    emit('change');
    emit('reset');
  },

  // Give wand `wand` ({ id, name, cards, config, ... }, generate.js's shape).
  // With a free slot it goes there; with all four full it takes the held one's
  // slot (or the first), and the old wand is dropped (the 'drop' listeners put
  // it at the player's feet). Returns { slot, dropped }, or null for a bad wand.
  give(wand) {
    if (!wand || !Array.isArray(wand.cards) || !wand.config || compileWand(wand.cards, wand.config).errors.length) return null;
    const w = copyWand(wand);
    let slot = run.wands.findIndex((x) => x.id === w.id);
    let dropped = null;
    if (slot < 0 && run.wands.length < WAND_SLOTS) slot = run.wands.push(w) - 1;
    else {
      if (slot < 0) slot = run.held >= 0 ? run.held : 0;
      dropped = run.wands[slot] ?? null;
      run.wands[slot] = w;
    }
    emit('change', { slot });
    if (dropped && dropped.id !== w.id) emit('drop', dropped);
    return { slot, dropped };
  },
  // put spell `id` in the bag; false when it's not a spell or the bag is full
  giveSpell(id) {
    if (!Object.hasOwn(SPELL_BY_ID, id) || run.bag.length >= BAG_MAX) return false;
    run.bag.push(id);
    emit('change');
    return true;
  },
  // Every carried wand back to full mana and ready (Noita's spell refresher; the temple's, agent C's).
  refresh() { emit('refresh'); },
  // the editor saved wand `slot` with these cards, and the bag holds what's left
  edit(slot, cards, bag) {
    const w = run.wands[slot];
    if (!w) return false;
    run.wands[slot] = { ...w, cards: [...cards] };
    run.bag = [...bag];
    emit('change', { slot });
    return true;
  },
  // take wand slot `slot` out (it's being dropped); returns the wand
  remove(slot) {
    const [w] = run.wands.splice(slot, 1);
    if (run.held >= run.wands.length) run.held = run.wands.length - 1;
    emit('change');
    return w ?? null;
  },
  // ---- potions: Noita's item slots (POTION_SLOTS), flasks found lying about or in chests
  get potions() { return run.potions; },
  get potionsFull() { return run.potions.length >= POTION_SLOTS; },
  // take flask `flask` (flasks.js makeFlask's shape): its slot, or -1 with every item slot full
  givePotion(flask) {
    if (!flask?.cells || run.potions.length >= POTION_SLOTS) return -1;
    const slot = run.potions.push(copyFlask(flask)) - 1;
    emit('change', { potion: slot });
    return slot;
  },
  // the flask in slot `slot` now holds `cells` (poured, drunk, scooped into): kept quietly, no 'change'
  setPotionCells(slot, cells) {
    const f = run.potions[slot];
    if (!f) return false;
    f.cells = cells.map((c) => [...c]);
    return true;
  },
  // flask `slot` is gone (thrown: its glass broke); returns it
  removePotion(slot) {
    const [f] = run.potions.splice(slot, 1);
    if (f) emit('change', { potion: -1 });
    return f ?? null;
  },
  // put a wand or spell pickup at a world point (a chest's spill): { kind: 'wand' | 'spell', wand?, spell?, world: [x, y, z], site }
  place(item) { emit('place', item); },
  // listen: 'change' (wands, bag or potions), 'drop' (a wand left the inventory), 'refresh', 'place', 'reset' (a new run); returns an unsubscribe
  on: events.on,
};
