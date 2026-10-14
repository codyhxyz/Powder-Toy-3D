// The maps the start menu lists (ui/menu.js), and the gamemodes it files them
// under. Garry's Mod's way: a map is one place at one size, and a gamemode
// lists the maps built for it. Sandbox lists every map.
//
// A map is a box scene (presets.js, world/gpu.js loadIsland, presets.js
// ARENA_PRESETS) at its own grid size, or a world scene (world/scenes) in a
// world. Its size is part of the map: there is no separate grid size to pick.
//
// This file is plain data with no imports: the menu loads before anything
// heavy (src/main.js), so it must stay small. app.js checks it against its own
// tables (SIZES, WORLDS, WORLD_SCENES) when it boots.
//   key      the map's id (?map=key, public/maps/<key>.webp: tools/map-thumbs.mjs renders those)
//   name     its name on the menu
//   desc     one line under it
//   size     the grid: a SIZES key (a box) or a WORLDS key (a world) in app.js
//   dims     that grid's cells [x, y, z], for the size tag
//   preset   a box's scene (settings.preset); scene: a world's (settings.scene)
//   scenes   optional: every world scene that is this map (Descent's levels), scene the one it starts on
//   modes    the gamemodes it is built for besides Sandbox
export const WORLD_DIMS = [1024, 128, 1024];   // shaders/far.js WORLD_SIZE (app.js checks)
const TEAM_MODES = ['slayer', 'ctf', 'koth', 'infection', 'siege'];

export const MAPS = [
  { key: 'island', name: 'Island', size: 'world', scene: 'island', dims: WORLD_DIMS,
    desc: 'Beaches, forest, cliffs and caves, a lighthouse and old mines. The world loads around you as you go.' },
  { key: 'willowCove', aliases: ['tinkerCreek'], name: 'Tinker Creek', size: 'world', scene: 'willowCove', dims: [3072, 128, 1024], modes: ['animalCrossing'],
    desc: 'A wide island village with cottages, an orchard and a kilometre-long running circuit across river bridges. Inspired by Animal Crossing.' },
  { key: 'volcanoWorld', name: 'Volcano Isles', size: 'world', scene: 'volcanoWorld', dims: WORLD_DIMS,
    desc: 'An archipelago of live volcanoes in open sea, lava pouring down to the water.' },
  { key: 'labWorld', name: 'Lab Complex', size: 'world', scene: 'labWorld', dims: WORLD_DIMS,
    desc: 'An endless research facility: room after room of tanks, lava pits, towers and hanging sand.' },
  // (a world three times as tall: world/scenes/giantVolcano.js VOLC_SIZE, app.js checks)
  { key: 'giantVolcano', name: 'Giant Volcano', size: 'world', scene: 'giantVolcano', dims: [1024, 384, 1024],
    desc: 'A stratovolcano 100 m tall in the sea: lava pouring from a vent on its crater down a collapse scar, old basalt flows, side cones, snow on top, forest below.' },
  // Noita's main path, three levels deep: world/scenes/descent (docs/descent-contract.md). It starts on its
  // first level's scene; the others are its too (scenes), each its own 512×256×512 world (descent/scenes.js DS_WORLD)
  // the Noita gamemode's map (wands and nothing else in hand there), and a Sandbox map as every map is
  { key: 'descent', name: 'Descent', size: 'world', scene: 'descentMines', scenes: ['descentMines', 'descentCoal', 'descentSnow'],
    dims: [512, 256, 512], modes: ['noita'],
    desc: 'Down through the Mines, the Coal Pits and the Snowy Depths, with a Holy Mountain at the bottom of each. Find wands on the way.' },
  { key: 'damValley', name: 'Dam Valley', size: 'valley', preset: 'damValley', dims: [256, 96, 128], modes: TEAM_MODES,
    desc: 'Two bases across a dammed river, with vehicles and shrines. Blow the sluice gate to flood the tunnel.' },
  { key: 'quarry', name: 'Open-Cut Quarry', size: '128', preset: 'quarry', dims: [128, 128, 128], modes: ['factory'],
    desc: 'Sort gold-bearing sand, automate exposed ore faces, pump a finite reservoir and smelt metal. Physical grains, real spills.' },
  { key: 'lab', name: 'Lab', size: '128', preset: 'lab', dims: [128, 128, 128], modes: TEAM_MODES,
    desc: 'A water tank with an oil slick, a lava pit, a gunpowder tower and a sand pile about to fall.' },
  { key: 'volcano', name: 'Volcano', size: '128', preset: 'volcano', dims: [128, 128, 128],
    desc: 'A volcano island with a lava source on its summit, snow and trees on its flanks.' },
  { key: 'islet', name: 'Islet', size: '128', preset: 'island', dims: [128, 128, 128],
    desc: 'A piece of the Island\'s shore in a box.' },
  { key: 'empty', name: 'Empty', size: '128', preset: 'empty', dims: [128, 128, 128],
    desc: 'Nothing but air. Build from scratch.' },
];

// Sandbox first. Team modes follow src/game/rules.js MODES (names and order);
// the menu shows them only in builds that have src/game.
export const GAMEMODES = [
  { key: 'sandbox', name: 'Sandbox', desc: 'Pour, build, burn and blow it up. Every map.' },
  { key: 'factory', name: 'Factory', desc: 'Catch and sort real grains. Build miners, lifts, pumps and furnaces; ship gold and cooled metal to grow your quarry.' },
  { key: 'crueltySquad', name: 'Cruelty Squad', desc: 'Eliminate every designated target, then reach extraction. Death fails the mission; retry from the beginning.' },
  { key: 'noita', name: 'Noita', desc: 'Wands only. Go down through the Mines and the Holy Mountains, finding wands and spells on the way.' },
  { key: 'animalCrossing', name: 'Animal Crossing', defaultView: 'cozy', effect: 'rollingLog', gravityScale: 0.5, desc: 'Settle into a furnished home, arrange your furniture, and meet animal neighbors in Tinker Creek.' },
  { key: 'slayer', name: 'Team Slayer', team: true, desc: 'Red against blue with bots on both sides. First to the kill limit wins.' },
  { key: 'ctf', name: 'Capture the Flag', team: true, desc: 'Take their flag from its stand and bring it home while yours is there.' },
  { key: 'koth', name: 'King of the Hill', team: true, desc: 'Hold the hill alone to score. It moves every minute.' },
  { key: 'infection', name: 'Infection', team: true, desc: 'One starts infected. Whoever they kill joins them. Survive the clock.' },
  { key: 'siege', name: 'Siege', team: true, desc: 'TF2 attack/defend: take the control points in turn before time runs out, or hold them.' },
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
export const isWorld = (m) => !m.preset;

// The map a grid size and scene are (app.js settings), else null (a box size no map has: '64' with the lab is
// still the lab; only Empty is size-free).
export function mapOf({ size, preset, scene }) {
  if (size === 'world') return MAPS.find((m) => m.scene === scene || m.scenes?.includes(scene)) ?? null;
  return MAPS.find((m) => m.preset === preset) ?? null;
}

// '128^3' (a caret, not a superscript ³: too small to read on a tag), '256×96×128', '1024×1024' (a world: its footprint, when its height is a box's), '1024×384×1024'
export function sizeTag(m) {
  const [x, y, z] = m.dims;
  if (isWorld(m) && y === WORLD_DIMS[1]) return `${x}×${z}`;
  return x === y && y === z ? `${x}^3` : `${x}×${y}×${z}`;
}

// where a new player starts: laptops on the Island world, phones in the Lab box (app.js MOBILE_DEFAULTS)
export const DEFAULT_MAP = 'island';
export const MOBILE_MAP = 'lab';
