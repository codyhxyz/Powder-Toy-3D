// Descent's levels (agent A's src/world/scenes/descent/levels.js, docs/descent-contract.md)
// through a glob, so the wands build without them: until levels.js lands no
// scene is a Descent level and everything behaves as off the map.
const mods = import.meta.glob('../../world/scenes/descent/levels.js', { eager: true });
const levels = Object.values(mods)[0] ?? null;

// the Descent level loaded as world scene `key`, or null
export const levelByScene = (key) => (key && levels?.levelByScene?.(key)) || null;
// its loot sites: [{ x, y, z, kind, tier }] in world cells (a level may compute them: contract, "If a site is computed")
export function lootSites(level) {
  const loot = typeof level?.loot === 'function' ? level.loot() : level?.loot;
  return Array.isArray(loot) ? loot : [];
}
