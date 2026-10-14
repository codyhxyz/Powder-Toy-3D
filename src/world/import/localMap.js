import { MAPS } from '../../maps.js';
import { WORLD_SCENES } from '../scenes/index.js';
import { loadImportedMap } from '../scenes/importedMap.js';
import { CRUELTY_PROFILES, crueltyProfile } from './crueltyProfiles.js';

// Called only through a DEV-only dynamic import in main.js. Missing/invalid
// assets never register substitute geometry. Each profile is independently local.
async function installProfile(profile) {
  const url = `/local-maps/${profile.id}.json`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cannot inspect local ${profile.name} (${response.status})`);
  const scene = await loadImportedMap(url, { key: `${profile.id}Local`, label: `${profile.name} (VOXEL PREVIEW)` });
  if (scene.importManifest.id !== profile.id) throw new Error(`Local source profile mismatch: ${profile.id}`);
  if (MAPS.some((m) => m.key === profile.id) || WORLD_SCENES.some((s) => s.key === scene.key)) throw new Error(`Duplicate local map registration: ${profile.id}`);
  const omitted = scene.mission.placementFailures.filter((p) => p.role === 'guard').length;
  const map = { key: profile.id, name: `${profile.name} (VOXEL PREVIEW; ${omitted} guards omitted)`, size: 'world', scene: scene.key, dims: scene.size, modes: scene.mission.available === false ? [] : ['crueltySquad'], mission: scene.mission,
    desc: `Full Level${profile.level} embedded geometry. ${omitted} obstructed guards omitted; ${scene.mission.available === false ? 'mission unavailable: obstructed spawn/target; Sandbox geometry comparison only' : 'clearance-checked NPC adaptation, not full original AI'}. Local-only; external props/scripts not imported.` };
  WORLD_SCENES.push(scene); MAPS.push(map);
  return map;
}
export const installLocalParadise = () => installProfile(crueltyProfile('paradise'));
export async function installLocalCrueltyMaps() {
  const maps = [];
  for (const profile of CRUELTY_PROFILES.filter((p) => !p.blocked)) {
    try { const map = await installProfile(profile); if (map) maps.push(map); }
    catch (error) { console.error(`Local ${profile.name} import failed; map not registered`, error); }
  }
  return maps;
}
