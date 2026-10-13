import { GEAR, gearByKey } from './catalog.js';
import { createEmitter } from '../events.js';

// What the player carries: every tool in the catalog, in its slot, from the
// first drop-in (Garry's Mod gives you every weapon). give() is the palette's
// Tools group (GMod's spawn menu, Q in first person): it puts the tool in
// hand. It lives outside the toolbelt, which only exists after the first
// drop-in: a tool given from the god view is in hand when you drop in.
//
//   inventory.give('SNIPER')   → false (it was carried already); holds it
//   inventory.owned            → keys, in catalog order
//   inventory.on((key) => {})  → called on every give (key the tool to hold); returns an off()

const events = createEmitter('inventory');
let pending = null;   // the tool to hold when the toolbelt next looks (given before it existed)

export const inventory = {
  has: (key) => !!gearByKey(key),
  get owned() { return GEAR.map((g) => g.key); },
  give(key) {
    if (!gearByKey(key)) return false;
    pending = key;
    events.emit('give', key);
    return false;
  },
  // the tool given last that nobody has picked up yet (the toolbelt takes it once)
  takePending() { const k = pending; pending = null; return k; },
  on: (fn) => events.on('give', fn),
};
