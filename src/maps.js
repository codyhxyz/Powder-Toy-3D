// The maps the start menu lists (ui/menu.js), and the gamemodes it files them
// under. Garry's Mod's way: a map is one place at one size, and a gamemode
// lists the maps built for it. Sandbox lists every map.
//
// A map is a box scene (presets.js, world/gpu.js loadIsland, presets.js
// ARENA_PRESETS) at its own grid size, or a world scene (world/scenes) in a
// world. Its size is part of the map: there is no separate grid size to pick.
//
// Only the small terrain manifest and pure fold math load with this menu.
// app.js checks it against its own
// tables (SIZES, WORLDS, WORLD_SCENES) when it boots.
//   key      the map's id (?map=key, public/maps/<key>.webp: tools/map-thumbs.mjs renders those)
//   name     its name on the menu
//   desc     one line under it
//   size     the grid: a SIZES key (a box) or a WORLDS key (a world) in app.js
//   dims     that grid's cells [x, y, z], for the size tag
//   preset   a box's scene (settings.preset); scene: a world's (settings.scene)
//   scenes   optional: every world scene that is this map (Descent's levels), scene the one it starts on
//   modes    the gamemodes it is built for besides Sandbox
//   defaultView optional authored shader, overriding the gamemode's starting view
//   viewPreviewVersion optional: its Shaders-menu previews are baked (public/views/<key>/, viewPreviewUrl)
import terrainRoute from './world/scenes/descent/terrainRoute.json' with { type: 'json' };
import { createFold } from './world/scenes/descent/terrainFold.js';
import { kindOfMap } from './mapKind.js';

export const WORLD_DIMS = [1024, 128, 1024];   // shaders/far.js WORLD_SIZE (app.js checks)
// Intentional (gamemode: team modes are built for their own maps; user decision 2026-10-20): only the
// small maps built for them (Lab, Dam Valley) list them; no big map does, and co-op there runs only Sandbox.
const TEAM_MODES = ['slayer', 'ctf', 'koth', 'infection', 'siege'];

export const MAPS = [
  { key: 'island', viewPreviewVersion: 1, name: 'Island', size: 'world', scene: 'island', dims: WORLD_DIMS,
    desc: 'Beaches, forest, cliffs and caves, a lighthouse and old mines. The world loads around you as you go.' },
  { key: 'willowCove', aliases: ['tinkerCreek'], name: 'Tinker Creek', size: 'world', scene: 'willowCove', dims: [3072, 128, 1024], modes: ['animalCrossing'], defaultView: 'cozy', previewVersion: 2,
    desc: 'A wide island village with cottages, an orchard and a kilometre-long running circuit across river bridges. Inspired by Animal Crossing.' },
  { key: 'volcanoWorld', viewPreviewVersion: 1, name: 'Volcano Isles', size: 'world', scene: 'volcanoWorld', dims: WORLD_DIMS,
    desc: 'An archipelago of live volcanoes in open sea, lava pouring down to the water.' },
  { key: 'labWorld', viewPreviewVersion: 1, name: 'Lab Complex', size: 'world', scene: 'labWorld', dims: WORLD_DIMS,
    desc: 'An endless research facility: room after room of tanks, lava pits, towers and hanging sand.' },
  // (a world three times as tall: world/scenes/giantVolcano.js VOLC_SIZE, app.js checks)
  { key: 'giantVolcano', viewPreviewVersion: 1, name: 'Giant Volcano', size: 'world', scene: 'giantVolcano', dims: [1024, 384, 1024],
    desc: 'A stratovolcano 100 m tall in the sea: lava pouring from a vent on its crater down a collapse scar, old basalt flows, side cones, snow on top, forest below.' },
  // Source-derived, folded 3D Noita main route. Legacy Wang scenes are not this map.
  { key: 'descent', viewPreviewVersion: 1, name: 'Descent', size: 'world', scene: terrainRoute.startScene,
    scenes: terrainRoute.regions.map((r) => r.key),
    dims: createFold(terrainRoute.fold).size, modes: ['noita'], defaultView: 'noita', previewVersion: 6,
    desc: 'A fresh Noita world folded into a continuous 3D arc, its caves rounded out in depth, from the start mountain and the Mines down to Kolmi. Original Holy Mountain portals connect the main biomes; vertical bands load around the player.' },
  { key: 'damValley', viewPreviewVersion: 2, name: 'Dam Valley', size: 'valley', preset: 'damValley', dims: [256, 96, 128], modes: TEAM_MODES,
    desc: 'Two bases across a dammed river, with vehicles and shrines. Blow the sluice gate to flood the tunnel.' },
  { key: 'quarry', viewPreviewVersion: 2, name: 'Open-Cut Quarry', size: '128', preset: 'quarry', dims: [128, 128, 128], modes: ['factory'],
    desc: 'Sort gold-bearing sand, automate exposed ore faces, pump a finite reservoir and smelt metal. Physical grains, real spills.' },
  { key: 'lab', viewPreviewVersion: 2, name: 'Lab', size: '128', preset: 'lab', dims: [128, 128, 128], modes: TEAM_MODES,
    desc: 'A water tank with an oil slick, a lava pit, a gunpowder tower and a sand pile about to fall.' },
  { key: 'volcano', viewPreviewVersion: 2, name: 'Volcano', size: '128', preset: 'volcano', dims: [128, 128, 128],
    desc: 'A volcano island with a lava source on its summit, snow and trees on its flanks.' },
  { key: 'islet', viewPreviewVersion: 2, name: 'Islet', size: '128', preset: 'island', dims: [128, 128, 128],
    desc: 'A piece of the Island\'s shore in a box.' },
  { key: 'empty', viewPreviewVersion: 2, name: 'Empty', size: '128', preset: 'empty', dims: [128, 128, 128],
    desc: 'Nothing but air. Build from scratch.' },
];

// Sandbox first. Team modes follow src/game/rules.js MODES (names and order);
// the menu shows them only in builds that have src/game.
//   beta     still being built: the menu lists it under "In testing" with a Beta chip, so a new
//            player starts on what works (Sandbox, the team modes) and knows what may be rough.
//            Intentional (Claude's call, 2026-10-22, for new players): Factory, Cruelty Squad, Noita,
//            Animal Crossing and Siege (Dam Valley's stalls) are beta; drop the flag once a mode is done.
export const GAMEMODES = [
  { key: 'sandbox', name: 'Sandbox', defaultView: 'realistic', desc: 'Pour, build, burn and blow it up. Every map.' },
  { key: 'factory', name: 'Factory', beta: true, desc: 'Catch and sort real grains. Build miners, lifts, pumps and furnaces; ship gold and cooled metal to grow your quarry.' },
  { key: 'crueltySquad', name: 'Cruelty Squad', beta: true, desc: 'Eliminate every designated target, then reach extraction. Death fails the mission; retry from the beginning.' },
  // Intentional (gamemode: Noita; user request, 2026-10-18): Noita mode and Descent open in the Noita view; key 8 shows it anywhere.
  { key: 'noita', name: 'Noita', beta: true, defaultView: 'noita', desc: 'Wands only. Explore the source-derived 3D Descent, with Holy Mountains between biomes. Ends at the Sampo platform; no boss combat yet.' },
  { key: 'animalCrossing', name: 'Animal Crossing', beta: true, defaultView: 'cozy', effect: 'rollingLog', gravityScale: 0.5, desc: 'Settle into a furnished home, arrange your furniture, and meet animal neighbors in Tinker Creek.' },
  { key: 'slayer', name: 'Team Slayer', team: true, desc: 'Red against blue with bots on both sides. First to the kill limit wins.' },
  { key: 'ctf', name: 'Capture the Flag', team: true, desc: 'Take their flag from its stand and bring it home while yours is there.' },
  { key: 'koth', name: 'King of the Hill', team: true, desc: 'Hold the hill alone to score. It moves every minute.' },
  { key: 'infection', name: 'Infection', team: true, desc: 'One starts infected. Whoever they kill joins them. Survive the clock.' },
  { key: 'siege', name: 'Siege', beta: true, team: true, desc: 'TF2 attack/defend: take the control points in turn before time runs out, or hold them.' },
];

// (aliases: a renamed map's new name also opens it; the key stays for saves and old links)
export const mapByKey = (key) => MAPS.find((m) => m.key === key || m.aliases?.includes(key)) ?? null;
export const modeByKey = (key) => GAMEMODES.find((m) => m.key === key) ?? null;
// Imported maps opt in with an authored mission, never by renaming existing geometry.
const point = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const weapons = new Set(['AXE', 'GUN', 'SMG', 'SNIPER', 'ROCKET', 'LASER']);
export function validMission(m) {
  if (!m || typeof m.id !== 'string' || !m.id || typeof m.name !== 'string' || !m.name || !point(m.spawn)) return false;
  if (m.spawnYaw != null && !Number.isFinite(m.spawnYaw)) return false;
  if (!Array.isArray(m.targets) || !m.targets.length || !Array.isArray(m.guards)) return false;
  const ids = new Set();
  for (const a of [...m.targets, ...m.guards]) {
    if (!a || typeof a.id !== 'string' || !a.id || ids.has(a.id) || typeof a.name !== 'string' || !a.name || !point(a.at)) return false;
    if (a.style != null && !['axeman', 'gunner'].includes(a.style)) return false;
    if (a.passive != null && typeof a.passive !== 'boolean') return false;
    if (a.weapons != null && (!Array.isArray(a.weapons) || !a.weapons.every((k) => weapons.has(k)))) return false;
    ids.add(a.id);
  }
  const validExit = e => !!e && point(e.at) && Number.isFinite(e.radius) && e.radius > 0
    && Number.isFinite(e.height) && e.height > 0
    && (!e.bounds || (point(e.bounds.min) && point(e.bounds.max) && e.bounds.max.every((n, i) => n > e.bounds.min[i])))
    && (e.axes == null || (!!e.bounds && Array.isArray(e.axes) && e.axes.length > 0 && e.axes.every(a =>
      point(a.normal) && a.normal.some(n => n !== 0) && Number.isFinite(a.min) && Number.isFinite(a.max) && a.max >= a.min)))
    && (e.points == null || (!!e.bounds && Array.isArray(e.points) && e.points.length >= 4 && e.points.every(point)));
  return validExit(m.extraction) && (m.extractions == null
    || (Array.isArray(m.extractions) && m.extractions.length > 0 && m.extractions.every(validExit)));
}

const eligible = (map, mode) => !!map?.modes?.includes(mode) && (mode !== 'crueltySquad' || validMission(map.mission));
// Public openMap, URL launch and the menu use the same eligibility rules.
export function resolveMode(map, mode = 'sandbox') {
  const m = modeByKey(mode);
  return m && (mode === 'sandbox' || eligible(map, mode)) ? m : GAMEMODES[0];
}
export const mapsFor = (mode) => (mode === 'sandbox' ? MAPS : MAPS.filter((m) => eligible(m, mode)));
export const isWorld = (m) => kindOfMap(m).streamed;   // (a big map: mapKind.js)
export function mapPreviewUrl(key) {
  const map = mapByKey(key), revision = map?.previewVersion;
  return `/maps/${map?.key ?? key}.webp${revision ? `?v=${revision}` : ''}`;
}
// The Shaders menu's preview of a map in a view (public/views/<key>/<view>.webp: tools/map-thumbs.mjs
// --views bakes them, then sets the map's viewPreviewVersion), or null for a map without them.
export function viewPreviewUrl(key, view) {
  const map = mapByKey(key), revision = map?.viewPreviewVersion;
  return revision ? `/views/${map.key}/${view}.webp?v=${revision}` : null;
}
export function mapLoadingUrl(key) {
  const map = mapByKey(key);
  return map?.loadingArtVersion ? `/maps/${map.key}-loading.webp?v=${map.loadingArtVersion}` : mapPreviewUrl(key);
}

// The map a grid size and scene are (app.js settings), else null (a box size no map has: '64' with the lab is
// still the lab; only Empty is size-free).
export function mapOf({ size, preset, scene }) {
  if (size === 'world') return MAPS.find((m) => m.scene === scene || m.scenes?.includes(scene)) ?? null;
  return MAPS.find((m) => m.preset === preset) ?? null;
}

// '128^3' (a caret, not a superscript ³: too small to read on a tag), '256×96×128', '1024×1024' (a world: its footprint, when its height is a box's), '1024×384×1024'
export function sizeTag(m) {
  const [x, y, z] = m.dims;
  if (kindOfMap(m).footprintTag && y === WORLD_DIMS[1]) return `${x}×${z}`;
  return x === y && y === z ? `${x}^3` : `${x}×${y}×${z}`;
}

// where a new player starts: Island in Sandbox, phones included (user request, 2026-10-22). Laptops pick
// it on the menu; phones skip the menu straight into it (src/main.js) on the plain look (app.js MOBILE_DEFAULTS).
export const DEFAULT_MAP = 'island';
export const MOBILE_MAP = DEFAULT_MAP;
