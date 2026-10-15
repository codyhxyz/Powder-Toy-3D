import route from './terrainRoute.json' with { type: 'json' };
import { createFold } from './terrainFold.js';

const fold = createFold(route.fold);
export const DESCENT_LEVELS = route.regions.map((region) => {
  const toWorld = (source) => fold.forward(source, region.sourceTop, region.sourceHeight);
  const spawnSource = region.key === route.startScene ? route.startSource : region.spawnSource;
  const theta = route.fold.angleStart + (spawnSource[0]-route.fold.sourceMinX)*route.fold.cellScale/fold.radius;
  return {
    key: region.key, name: region.label, sectionIndex: region.sectionIndex,
    sourceRegion: region, fold: route.fold, nativePortals: route.nativePortals,
    spawnSource, spawn: toWorld(spawnSource), spawnYaw: Math.PI-theta,
    toWorld, toSource: (point) => fold.inverse(point, region.sourceTop, region.sourceHeight),
  };
});
export const levelByScene = (key) => DESCENT_LEVELS.find((l) => l.key === key) ?? null;
export const nextLevel = (key) => {
  const i = DESCENT_LEVELS.findIndex((l) => l.key === key);
  return i < 0 ? null : DESCENT_LEVELS[i + 1] ?? null;
};
export const inBox = (b, p) => p[0] >= b[0] && p[1] >= b[1] && p[2] >= b[2] && p[0] < b[3] && p[1] < b[4] && p[2] < b[5];
