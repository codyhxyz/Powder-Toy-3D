// The Holy Mountain's one seam with the other Descent agents (docs/descent-contract.md):
// A's level data, B's wand generator and B's descentWands API (look + E is the
// shell's interact.js, passed in by pov/index.js). Each is looked up
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
