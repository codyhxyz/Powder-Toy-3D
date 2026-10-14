import { MAPS } from '../../maps.js';
import { WORLD_SCENES } from '../scenes/index.js';
import { loadImportedMap } from '../scenes/importedMap.js';

// Called only through a DEV-only dynamic import in main.js. An absent asset
// never produces a fake Paradise entry or a fallback procedural map.
export async function installLocalParadise() {
  const response = await fetch('/local-maps/paradise.json');
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cannot inspect local Paradise (${response.status})`);
  const scene = await loadImportedMap('/local-maps/paradise.json');
  if (MAPS.some((m) => m.key === 'paradise') || WORLD_SCENES.some((s) => s.key === scene.key)) throw new Error('Duplicate local Paradise registration');
  const map = {
    key: 'paradise', name: 'Paradise (local source)', size: 'world', scene: scene.key,
    dims: scene.size, modes: ['crueltySquad'], mission: scene.mission,
    desc: 'Original Level2 embedded geometry, translated into physical voxels. Local user-supplied assets only; external props/scripts not imported.',
  };
  WORLD_SCENES.push(scene);
  MAPS.push(map);
  return map;
}
