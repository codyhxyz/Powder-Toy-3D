import route from './terrainRoute.json' with { type: 'json' };
import { createTerrainScene } from './terrainScenes.js';

// Small boot-time manifest only. Native rasters load lazily on prepare().
export const NOITA_SOURCE_SCENES = route.regions.map((region) => createTerrainScene(route, region));
