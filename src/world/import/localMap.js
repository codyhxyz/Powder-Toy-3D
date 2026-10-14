import { MAPS } from '../../maps.js';
import { WORLD_SCENES } from '../scenes/index.js';
import { loadImportedMap } from '../scenes/importedMap.js';
import { CRUELTY_PROFILES } from './crueltyProfiles.js';

// The converted source levels live in public/local-maps and ship with the site.
// Only their manifests load at boot (the menu needs the names, sizes and modes);
// each map's geometry is fetched when it is opened. A missing or invalid asset
// never registers a substitute: the map is simply absent from the menu.
async function installProfile(profile) {
  const response = await fetch(`/local-maps/${profile.id}.json`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cannot read the converted ${profile.name} (${response.status})`);
  const scene = await loadImportedMap(`/local-maps/${profile.id}.json`, { response, key: `${profile.id}Local`, label: `${profile.name} (source import)` });
  if (scene.importManifest.id !== profile.id) throw new Error(`Converted map profile mismatch: ${profile.id}`);
  if (MAPS.some((m) => m.key === profile.id) || WORLD_SCENES.some((s) => s.key === scene.key)) throw new Error(`Duplicate map registration: ${profile.id}`);
  const omitted = scene.mission.placementFailures.filter((p) => p.role === 'guard').length;
  const blocked = scene.mission.available === false;
  const map = { key: profile.id, name: profile.name, size: 'world', scene: scene.key, dims: scene.size,
    modes: blocked ? [] : ['crueltySquad'], mission: scene.mission,
    desc: `The original Level ${profile.level} layout, converted into physical voxels. ${blocked
      ? 'Sandbox only: a target has no clear standing volume for this game\'s body. '
      : `${omitted ? `${omitted} obstructed guard${omitted === 1 ? '' : 's'} omitted. ` : ''}`}Characters are this game's NPCs, not the original AI. Ordinary doors retract with E; special gates need unsupported progression. Other script losses are inventoried in the manifest.` };
  WORLD_SCENES.push(scene); MAPS.push(map);
  return map;
}
export async function installLocalCrueltyMaps() {
  // One request per map, in parallel: each is small, and the menu waits for them.
  const installed = await Promise.all(CRUELTY_PROFILES.filter((p) => !p.blocked).map((profile) =>
    installProfile(profile).catch((error) => { console.error(`Converted ${profile.name} not registered`, error); return null; })));
  return installed.filter(Boolean);
}
