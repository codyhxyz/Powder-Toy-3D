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
  { key: 'volcanoWorld', name: 'Volcano Isles', size: 'world', scene: 'volcanoWorld', dims: WORLD_DIMS,
    desc: 'An archipelago of live volcanoes in open sea, lava pouring down to the water.' },
  { key: 'labWorld', name: 'Lab Complex', size: 'world', scene: 'labWorld', dims: WORLD_DIMS,
    desc: 'An endless research facility: room after room of tanks, lava pits, towers and hanging sand.' },
  // (a world three times as tall: world/scenes/giantVolcano.js VOLC_SIZE, app.js checks)
  { key: 'giantVolcano', name: 'Giant Volcano', size: 'world', scene: 'giantVolcano', dims: [1024, 384, 1024],
    desc: 'The Volcano blown up: one cone 105 m tall in the sea, lava pouring from its summit, snow on top, forest below.' },
  // Noita's main path, three levels deep: world/scenes/descent (docs/descent-contract.md). It starts on its
  // first level's scene; the others are its too (scenes), each its own 512×256×512 world (descent/scenes.js DS_WORLD)
  { key: 'descent', name: 'Descent', size: 'world', scene: 'descentMines', scenes: ['descentMines', 'descentCoal', 'descentSnow'],
    dims: [512, 256, 512],
    desc: 'Down through the Mines, the Coal Pits and the Snowy Depths, with a Holy Mountain at the bottom of each. Find wands on the way.' },
  { key: 'damValley', name: 'Dam Valley', size: 'valley', preset: 'damValley', dims: [256, 96, 128], modes: TEAM_MODES,
    desc: 'Two bases across a dammed river, with vehicles and shrines. Blow the sluice gate to flood the tunnel.' },
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
  { key: 'slayer', name: 'Team Slayer', team: true, desc: 'Red against blue with bots on both sides. First to the kill limit wins.' },
  { key: 'ctf', name: 'Capture the Flag', team: true, desc: 'Take their flag from its stand and bring it home while yours is there.' },
  { key: 'koth', name: 'King of the Hill', team: true, desc: 'Hold the hill alone to score. It moves every minute.' },
  { key: 'infection', name: 'Infection', team: true, desc: 'One starts infected. Whoever they kill joins them. Survive the clock.' },
  { key: 'siege', name: 'Siege', team: true, desc: 'TF2 attack/defend: take the control points in turn before time runs out, or hold them.' },
];

// One-click Play: the start menu's top bar (ui/menu.js), a gamemode on the map
// built for it, with the team picked for you (src/game auto-balance). Halo 3
// matchmaking's way: you pick a playlist, not a map and a side. Shown only in
// builds with the team games (src/main.js). ?mode=<a team mode> without ?map=
// boots into its entry here too.
//   key          its id (the button's data-play)
//   mode, map    a GAMEMODES key, a MAPS key that lists it
//   name, desc   the button's label and its line
export const QUICK_PLAY = [
  { key: 'slayer', mode: 'slayer', map: 'damValley', name: 'Play', desc: 'Team Slayer · Dam Valley' },
  // (the Lab: on Dam Valley the attackers' bots don't reach point A up on the dam's end yet, docs/modes.md)
  { key: 'siege', mode: 'siege', map: 'lab', name: 'Siege', desc: 'Classes · attack and defend · Lab' },
];

export const mapByKey = (key) => MAPS.find((m) => m.key === key) ?? null;
export const mapsFor = (mode) => (mode === 'sandbox' ? MAPS : MAPS.filter((m) => m.modes?.includes(mode)));
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
