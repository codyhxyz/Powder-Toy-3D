import { GEAR, gearByKey } from './catalog.js';

// What the player carries: the catalog's start tools and every tool given
// since (the palette's Tools group, GMod's spawn menu). Kept in this browser,
// so a tool given once stays given. It lives outside the toolbelt, which only
// exists after the first drop-in: a tool given from the god view is there,
// and in hand, when you drop in.
//
//   inventory.give('SNIPER')   → true if it was new
//   inventory.owned            → keys, in catalog order
//   inventory.on((key) => {})  → called on every give (key the tool to hold); returns an off()

const STORE_KEY = 'tpt3d.pov.given';

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]').filter((k) => gearByKey(k)); }
  catch { return []; }
}

const given = new Set(load());
const listeners = new Set();
let pending = null;   // the tool to hold when the toolbelt next looks (given before it existed)

export const inventory = {
  has: (key) => !!gearByKey(key)?.start || given.has(key),
  get owned() { return GEAR.filter((g) => g.start || given.has(g.key)).map((g) => g.key); },
  give(key) {
    if (!gearByKey(key)) return false;
    const fresh = !inventory.has(key);
    if (fresh) {
      given.add(key);
      try { localStorage.setItem(STORE_KEY, JSON.stringify([...given])); } catch { /* storage blocked: kept for this visit */ }
    }
    pending = key;
    listeners.forEach((fn) => fn(key));
    return fresh;
  },
  // the tool given last that nobody has picked up yet (the toolbelt takes it once)
  takePending() { const k = pending; pending = null; return k; },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
