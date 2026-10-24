// Everything that differs between small maps and big maps, in one table.
//
// A small map (a box scene: maps.js `preset`) is simulated whole in one grid and
// drawn by app.js's own frame. A big map (a world scene: maps.js `scene`) is a
// window of cells that follows the player over a world too big to simulate at
// once (docs/scaling.md D11), drawn by the WORLD renderer (wire/worldRender.js).
// Every tool, element, look and rule not listed here is the same on both
// (CLAUDE.md, "Same features in every world").
//
// Code that acts differently on a big map reads its row here (app.js and the
// wires: `app.mapKind.presets`; elsewhere `kindOf(big).camSpeedMax`), never a test
// of its own on `win`, `worldMode`, `g.windowed` or `isWorld(m)`. A new
// difference is a new row, with who decided it and why: `// Intentional (...)`
// (a deviation the player sees), or `// Same look (...)` (different code that
// looks and plays the same). tools/check-frame-wires.mjs reports a big/small
// test anywhere else (the WORLD renderer's own files, src/world and the shaders aside).
import { EDGE } from './simModes.js';

// WASD over a big map: no faster than the window can follow the orbit target
// (one WIN_STEP move every few frames), in scene units per second
export const WORLD_CAM_SPEED_MAX = 9;
// cells: the level a small map's clouds and weather count their height from
// (shaders/gfx/clouds.js CLOUD.baseM above it; elementWeather.js's cloud band):
// its floor, a box having no sea of its own
export const BOX_SEA_LEVEL = 0;

//                     small map        big map
const DIFFERENCES = {
  // --- What the player is told ---
  // Intentional (user request, 2026-10-20, plain words): the menu and loading screen
  // say which kind a map is: a big map loads around you, a small one is simulated whole.
  label:            ['Small map', 'Big map'],
  blurb:            ['simulated whole, loads quickly', 'loads around you as you explore'],
  icon:             ['box', 'world'],   // its menu emblem (ui/modeicons.js)
  buildStep:        ['Filling {cells} cells', 'Setting up the simulation around you'],   // the loading screen's build line
  generateStep:     [false, true],      // ...and its "Generating the world" step (a save brings its own cells)
  footprintTag:     [false, true],      // its size tag: a world at a box's height shows its footprint, 1024×1024 (maps.js sizeTag)

  // --- How the map is held ---
  // Intentional (docs/scaling.md D11): a big map is a window over its world, moved
  // as the player goes. Its upkeep keys off this: picks, strokes and fills act only
  // inside the window, the god view homes over it, the HUD counts the world's cells,
  // co-op sends its window's place (wire/mp.js metadata).
  streamed:         [false, true],
  // Intentional (the map's content): a small map's cells come from a box preset
  // (presets.js) the Scene row swaps in place: the Lab brings an enemy spawner, an
  // arena its layout and grid, the Quarry its starter machines and drop point. A big
  // map's come from its world scene (world/scenes), generated as you explore.
  presets:          [true, false],
  // Intentional (user, 2026-10-23: keep; a world is generated around you, never one grid's snapshot): Undo
  // takes back a small map's scene load; a big map has no whole-map snapshot to restore.
  sceneUndo:        [true, false],
  // Intentional (user, 2026-10-23: keep; the map's content): a box is a room at PHYS.AMBIENT; a world scene
  // sets its own air temperature (scene airT).
  sceneAir:         [false, true],
  // Same look (each map's own sea): a box has no sea, so its clouds and weather count
  // from its floor (BOX_SEA_LEVEL); a world's count from its scene's sea (null: wire/world.js attach).
  seaLevel:         [BOX_SEA_LEVEL, null],
  // Same look (each map's own sea): a box's sea past its walls is read from its cells
  // at each load (gfx/edgeSea.js boxEdgeSea); a world's from its scene (app.js worldSea).
  edgeSeaFromCells: [true, false],
  // Intentional (user, 2026-10-23: big maps only; a world has room to walk to one, a box
  // is a sandbox you build in): every world gets a shrine in a felled clearing near
  // its start (wire/world.js worldShrine); a small map's shrines are its preset's.
  autoShrine:       [false, true],
  // Intentional (gamemode: Factory): machines are built only in Factory, on the Quarry, a
  // small map; no big map lists Factory (maps.js), and machine records are box-coordinate
  // (src/industry/index.js).
  industry:         [true, false],

  // --- Tools and camera ---
  // Intentional (a window has no walls): a small map's brush stops at its walls; past a
  // big map's window there is nothing simulated to paint, so there's no brush.
  clampBrush:       [true, false],
  // Intentional (a window has no walls): a fill reaching a box's wall stops there; one
  // reaching a window's edge would run on past what's simulated, so it's refused
  // (editing.js runFill openSides).
  fillOpenSides:    [false, true],
  // Intentional (simModes.js edge): a window's edge is the store's boundary, not the
  // world's, so it stays solid whatever Edge mode is picked (null: the picked one).
  edgeMode:         [null, EDGE.SOLID],
  // Intentional (the window must keep up): WASD in the god view is capped over a big map.
  camSpeedMax:      [Infinity, WORLD_CAM_SPEED_MAX],

  // --- Drawing ---
  // Same look (wire/worldRender.js): the WORLD renderer draws a big map's frame, its
  // lighting, distance detail, picks and stills; a small map draws through app.js's own
  // frame (src/wire/frameWires.js runs the same wire hooks in both). The rows below
  // are what that renderer does its own way. One more it brings: Intentional (decided under
  // the user's delegation, 2026-10-22): flying particles cast no sun shadows on a big map
  // (wire/rays.js; its sun map is published read-only tiles).
  worldRenderer:    [false, true],
  // Intentional (a box stands on a floor): the floor grid, the box's edge lines, the
  // blocks floor and the lit sky behind the box are a small map's; a world has its own ground and sky.
  boxFrame:         [true, false],
  // Same look (the WORLD renderer lights itself): the box volume's shadow map, its GI
  // probes (derived.prepareGI) and close-up detail's distance gate (gfx/detailGate.js)
  // are a small map's; the WORLD renderer shades, lights and enables every selected
  // detail feature itself (gateVariants near).
  volumeShadows:    [true, false],
  boxGI:            [true, false],
  detailGate:       [true, false],
  // Same look (world/worldLightingHistory.js): a big map's lighting history settles over
  // shaders/gi.js GI_SETTLE frames more before the loop sleeps.
  settleWorldGI:    [false, true],
  // Same look (the WORLD renderer draws Plain): the Plain view's blocks renderer
  // (gfx/blocks.js) draws a small map's grid.
  plainBlocks:      [true, false],

  // --- Loading ---
  // Intentional (user request, 2026-10-20, "MAKE IT LOAD FAST"): a big map's World load and
  // first frame go on while the simulation's step kernels build (cold, move alone took
  // 5.4 s: 2026-10-22, Island); a small map waits for them.
  stepKernelsLater: [false, true],

  // --- Co-op ---
  // Intentional (gamemode: team modes are built for their own maps; user decision
  // 2026-10-20): co-op on a big map runs only Sandbox.
  coopSandboxOnly:  [false, true],
  // Intentional (user, 2026-10-23: a known gap, left for now, no big jobs; co-op on a
  // big map shares terrain and exploring bodies): signs,
  // decoration, NPCs, vehicles, weapons, perks and progression are solo there
  // (net/multiplayer.js guardEntities, pov/index.js coop).
  coopEntities:     [true, false],
  // Intentional (user, 2026-10-23: a known gap, left for now, no big jobs; a guest holds
  // only the host's window): when the session ends a small
  // map's guest plays on alone; a big map's guest is frozen till it reloads or picks a map.
  guestPlaysOn:     [true, false],
};

const column = (i) => Object.freeze(Object.fromEntries(Object.entries(DIFFERENCES).map(([k, v]) => [k, v[i]])));
export const SMALL_MAP = column(0);
export const BIG_MAP = column(1);

/** The rows for a big map (true) or a small one. */
export const kindOf = (big) => (big ? BIG_MAP : SMALL_MAP);
/** A map's (maps.js MAPS entry): a box scene (`preset`) is a small map, a world scene a big one. */
export const kindOfMap = (m) => kindOf(!m.preset);
/** A simulation grid's (sim.g): a window of a larger world is a big map's. */
export const kindOfGrid = (g) => kindOf(!!g?.windowed);
