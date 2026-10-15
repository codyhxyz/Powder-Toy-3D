import route from './sourceRoute.json' with { type: 'json' };
import { createImportedMapScene } from '../importedMap.js';

// Manifests are boot-time data; only prepare() fetches the sparse geometry.
// No Cruelty profile/mission installer or legacy Wang bake.
export const NOITA_SOURCE_SCENES = route.map((map, descentLevel) => ({
  ...createImportedMapScene(map, null, { key: map.id, label: map.name,
    dataURL: `/local-maps/${map.dataFile}` }),
  descentLevel,
  torches: () => map.torches,
  view: { dir: [-11, 7, 6], dist: 95, lift: 0 },
}));
