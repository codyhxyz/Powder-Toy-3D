// The World's build-time bake (scripts/world-bake.mjs, shipped by the Vite
// plugin in scripts/world-bake-plugin.mjs as 'virtual:world-bake'): the
// default world's landform sites, its start and its structure records,
// computed in node at build time with this very code, so a visitor's device
// doesn't spend a second and a half on them at load.
//
// The plugin hands over a bake only when its key matches the sources the page
// was built from (the key hashes the seed, the size and every file the island
// scene and the structures layer import); the app passes it here
// (world/bakeClient.js). Without one (node tools, ?seed=, another size, an
// edit since the bake) everything is computed as before: the island's params on
// the main thread, the structures in a worker where there is one.

let baked = null;     // { key, size, seed, landforms, start, records }
let worker = null;    // (P) => Promise of structuresOf(P)'s list, computed off the main thread

export function useWorldBake(b) { baked = b ?? null; }
export function useStructureWorker(fn) { worker = fn; }

// The bake for a world of `size` and `seed`, or null.
export const bakeFor = (size, seed) =>
  (baked && baked.seed === seed >>> 0 && baked.size.length === size.length && baked.size.every((n, i) => n === size[i]) ? baked : null);
export const structureWorker = () => worker;
