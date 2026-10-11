// The Holy Mountain's one seam with the other Descent agents (docs/descent-contract.md):
// A's level data, B's wand generator and B's descentWands API. Each is looked up
// by an optional glob, so this builds before they land and picks them up the
// moment they do; anything missing falls back to a stand-in. Integration is
// this one file.

import * as stubs from './stubs.js';

const one = (mods) => Object.values(mods)[0] ?? null;

// A: src/world/scenes/descent/levels.js { DESCENT_LEVELS, levelByScene }
const levelsMod = one(import.meta.glob('../../world/scenes/descent/levels.js', { eager: true }));
export const DESCENT_LEVELS = levelsMod?.DESCENT_LEVELS ?? [];
export const levelByScene = levelsMod?.levelByScene ?? ((key) => DESCENT_LEVELS.find((l) => l.key === key) ?? null);

// B: src/pov/wands/generate.js { generateWand, randomSpell, wandPrice, spellPrice }
const genMod = one(import.meta.glob('../wands/generate.js', { eager: true }));
export const generator = {
  generateWand: genMod?.generateWand ?? stubs.generateWand,
  randomSpell: genMod?.randomSpell ?? stubs.randomSpell,
  wandPrice: genMod?.wandPrice ?? stubs.wandPrice,
  spellPrice: genMod?.spellPrice ?? stubs.spellPrice,
};
export const generatorIsStub = !genMod?.generateWand;

// Look + E (Noita's rule: look at an item, read its name, price and text, press E to
// take or buy it). The shared helper is src/pov/interact.js (coordinator, on main):
//   interact.register({ id, position: () => Vector3 (grid cells), radius,
//                       label: () => ({ title, lines }), onUse: () => bool }) → unregister
// Until it lands, a stand-in with the same register(): the nearest item within its
// radius of the body's chest is the one looked at (fallbackPick), its label goes up
// as a toast, and E uses it (createDescent drives it).
const interactMod = one(import.meta.glob('../interact.js', { eager: true }));
const fallbackItems = new Map();
export const interact = interactMod?.interact ?? interactMod?.default ?? {
  stub: true,
  register(spec) { fallbackItems.set(spec.id, spec); return () => fallbackItems.delete(spec.id); },
};
export const interactIsStub = !!interact.stub;
// the stand-in's pick: the registered item nearest `at` (grid cells) within its radius, or null
export function fallbackPick(at) {
  let best = null, bestD = Infinity;
  for (const s of fallbackItems.values()) {
    const p = s.position();
    if (!p) continue;
    const d = p.distanceTo(at);
    if (d <= s.radius && d < bestD) { best = s; bestD = d; }
  }
  return best;
}

// B: descentWands { give(wand), giveSpell(id), refresh() }, exported by one of its
// modules or hung on the toolbelt. Until then: a bought wand goes straight into
// the hand (toolbelt.equipWand), a spell is only announced, and the refresher
// does nothing beyond its toast.
const wandMods = import.meta.glob(['../wands/loot.js', '../wands/generate.js'], { eager: true });
export function descentWands(toolbelt) {
  const api = toolbelt?.descentWands ?? Object.values(wandMods).find((m) => m?.descentWands)?.descentWands ?? null;
  if (api) return api;
  return {
    stub: true,
    give: (wand) => !!toolbelt?.equipWand?.(wand),
    giveSpell: () => false,
    refresh: () => false,
  };
}
