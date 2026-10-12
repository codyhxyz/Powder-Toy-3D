// The shot list of the side-by-side sheet (docs/v2.md 11, Week 0): the stills
// and 5 s action clips every phase is judged on, against today's game, on the
// Mac and the iPhone. tools/side-by-side.mjs captures them from two builds;
// ?shot=<name> (src/shot.js) opens one in a player's page.
//
// A shot is data plus setup code, written against the engine API
// (tools/side-by-side/engine.mjs), never against the app:
//   name     its id (?shot=name, --shots name)
//   kind     'still' or 'clip'
//   title    one line for the sheet; look: what to judge in it, and why it's on the list
//   scene    { preset, size?, grid?, minBox? }  a box scene (presets.js), positions on a
//              `grid` (128) box and scaled to the box the page runs (none: as is, on a
//              box at least minBox);
//            { arena }                  an arena on its own grid (Dam Valley), cells as is;
//            { world, seed?, focus? }   a world scene, world cells; the window is centred
//              on focus ([x, z]) before the shot
//   seed     Math.random's seed before the scene loads (cell seeds, ids)
//   time     game seconds the scene runs before the camera is set (and a clip's setup)
//   camera   { pos, target, fov } in cells (fov 40 is the game's), or
//            { pov: { feet, yaw, pitch } }: first person, feet in cells, yaw 0 facing -z
//            and -π/2 facing +x, pitch up +
//   build(e) the scene's own cells, made right after it loads (a box shot's set)
//   setup(e) a clip's action: made at the end of `time`
//   clip     { start, seconds, keys }: the first frame `start` s after the setup;
//            keys held over [from, to) s after the setup ({ key: 'KeyW', from, to })
//
// The stills are the audit's cameras (docs/v2/evidence/audit-render.md 7.2)
// and tools/arena-check.mjs's; the action shots are judge 0's (judge-0.md 6.1:
// "Action shots, not still lifes"): a burning forest, a smoke-filled room, a
// buried charge mid-blast, a dam break, a pour from a hole, a sand avalanche,
// lava meeting water, a first-person swim.

/** Clip length, s (docs/v2.md 11: "stills and 5 s clips"). */
export const CLIP_SECONDS = 5;
const SEED = 12345;          // tools/regress.mjs's: same cells as its shots
const FOV = 40;              // the god view's (app.js camera)

// ---- builders shared by the box shots (cells of the 128 box; the engine scales them)
const add = (v, d) => v.map((x, i) => x + (Array.isArray(d) ? d[i] : d));
// fill a box of the shot's cells; returns it on this grid
function box(e, lo, hi, key, opts) {
  const [a, b] = e.span(lo, hi);
  e.fill(a, b, key, opts);
  return [a, b];
}
// a box on this grid shrunk by d cells on each side, per axis
const inset = ([a, b], d) => [add(a, d), add(b, d.map((x) => -x))];
// a tree: a 2×2 trunk h tall and a round crown of radius r, its foot at (x, y, z)
function tree(e, x, y, z, h, r) {
  box(e, [x, y, z], [x + 2, y + h, z + 2], 'WOOD');
  e.ball(e.cell([x + 1, y + h + r * 0.4, z + 1]), e.len(r), 'PLANT', { replace: false });
}
// rock floor over the whole box, `top` cells deep
const floor = (e, top, key = 'ROCK') => box(e, [0, 0, 0], [128, top, 128], key);

export const SHOTS = [
  // ---------------------------------------------------------------- stills
  {
    name: 'lab', kind: 'still', title: 'The lab, god view',
    look: 'the default box from the default camera: the tank, the lava pit, the wood tower, the sand that fell (audit-render 7.2: "flat clay primitives on a tiled floor in a dark void")',
    scene: { preset: 'lab', size: '128', grid: 128 }, seed: SEED, time: 1.25,
    camera: { pos: [204.8, 153.6, 230.4], target: [64, 32, 64], fov: FOV },   // the box's home view (app.js build)
  },
  {
    name: 'lab-tank', kind: 'still', title: 'The lab tank, through its glass',
    look: 'water, the oil slick and the ice from the side at eye height (audit-render 7.2: one teal haze, the oil an opaque plank, speckle at the oil/water line)',
    scene: { preset: 'lab', size: '128', grid: 128 }, seed: SEED, time: 1.25,
    camera: { pos: [36, 22, -14], target: [36, 16, 30], fov: FOV },   // the audit's tank camera
  },
  {
    name: 'volcano', kind: 'still', title: 'The volcano, god view',
    look: 'rock, snow cap, trees and the summit lava from the default camera (audit-render 7.2: "a smooth chocolate-pudding dome", "green lollipops")',
    scene: { preset: 'volcano', size: '128', grid: 128 }, seed: SEED, time: 2,
    camera: { pos: [204.8, 153.6, 230.4], target: [64, 32, 64], fov: FOV },
  },
  {
    name: 'volcano-flank', kind: 'still', title: 'The volcano flank, close',
    look: 'the closest god-view distance: rock pattern, trees and snow from a few metres (audit-render 7.2: "uniform worm-track" rock, "glossy green gumdrops")',
    scene: { preset: 'volcano', size: '128', grid: 128 }, seed: SEED, time: 2,
    camera: { pos: [64, 40, 4], target: [64, 26, 40], fov: FOV },   // the audit's flank camera
  },
  {
    name: 'dam-valley', kind: 'still', title: 'Dam Valley',
    look: 'the arena from over the red forest: the dam, the reservoir, the basin, trees on grass (docs/arenas-dam-valley.jpg: "broccoli trees, rounded walls")',
    scene: { arena: 'damValley' }, seed: SEED, time: 0.5,
    camera: { pos: [70, 58, 118], target: [128, 30, 70], fov: FOV },   // tools/arena-check.mjs '5-reservoir'
  },
  {
    name: 'island', kind: 'still', title: 'The island, god view',
    look: 'the World map players start on, from its first camera: shore, sea, forest, far field',
    scene: { world: 'island', seed: 20261008, focus: [460, 600] }, seed: SEED, time: 0.25,   // (world/generator.js WORLD_SEED)
    camera: { pos: [611.6, 162, 779.2], target: [460, 31, 600], fov: FOV },
  },
  {
    name: 'descent-corridor', kind: 'still', title: 'A Descent corridor',
    look: 'first-person scale in the Mines: a shored gallery on the top tunnel layer, lit by its own lanterns and torches',
    scene: { world: 'descentMines', focus: [211, 128] }, seed: SEED, time: 0.25,
    // a wand's site on the top layer (descent/levels.js), looking down the gallery (+z: 60 cells open)
    camera: { pos: [211.5, 123.5, 104], target: [211.5, 121.5, 140], fov: FOV },
  },

  // ---------------------------------------------------------------- action (5 s clips)
  {
    name: 'burning-forest', kind: 'clip', title: 'A burning forest',
    look: 'fire spreading tree to tree through grass and crowns: flames, smoke, glow on the ground (judge-0 6.1)',
    scene: { preset: 'empty', size: '128', grid: 128 }, seed: SEED, time: 0.25,
    camera: { pos: [130, 48, 150], target: [64, 12, 60], fov: FOV },
    build(e) {
      floor(e, 3);
      box(e, [0, 3, 0], [128, 4, 128], 'PLANT');   // grass that burns (Dam Valley's floor)
      // twelve trees on a jittered lattice, shortest at the burning (west) edge
      const at = [[30, 32], [34, 58], [28, 84], [50, 40], [54, 70], [48, 96], [72, 30], [70, 56], [76, 84], [94, 44], [92, 72], [98, 96]];
      at.forEach(([x, z], i) => tree(e, x, 4, z, 10 + (i % 3) * 2, 5));
    },
    setup(e) {
      // the west edge alight, as a player's fire brush would set it: the first column of trees
      // and the grass under them past their ignition point (PLANT 250 °C, WOOD 300 °C), flames over them
      const edge = e.span([22, 3, 22], [40, 26, 104]);
      e.heat(...edge, 450);
      box(e, [22, 4, 22], [40, 8, 104], 'FIRE', { replace: false, sparse: true });
    },
    clip: { start: 0.5 },
  },
  {
    name: 'smoke-room', kind: 'clip', title: 'A smoke-filled room',
    look: 'from inside a closed brick room: a wood fire, smoke banked under the ceiling, light from the door and window (judge-0 6.1)',
    scene: { preset: 'empty', size: '128', grid: 128 }, seed: SEED, time: 0.1,
    camera: { pos: [82, 10, 46], target: [62, 7, 70], fov: FOV },   // inside, by the door, at eye height
    build(e) {
      floor(e, 3);
      const room = box(e, [40, 3, 40], [88, 21, 88], 'BRICK');
      const inside = inset(room, [2, 0, 2]);
      e.erase(inside[0], add(inside[1], [0, -2, 0]));                 // hollow, a 2-cell roof
      e.erase(...e.span([86, 3, 58], [88, 12, 70]));                   // a door in the +x wall
      box(e, [52, 10, 86], [76, 15, 88], 'GLASS');                     // a window in the +z wall
      box(e, [60, 3, 60], [68, 6, 68], 'WOOD');                        // the fire's pile
    },
    setup(e) {
      e.heat(...e.span([60, 3, 60], [68, 6, 68]), 600);
      box(e, [58, 6, 58], [70, 10, 70], 'FIRE', { replace: false, sparse: true });
      box(e, [42, 12, 42], [86, 19, 86], 'SMOKE', { replace: false });   // smoke already banked under the roof
    },
    clip: { start: 0.25 },
  },
  {
    name: 'buried-charge', kind: 'clip', title: 'A buried charge mid-blast',
    look: 'a C-4 charge 8 cells under a sand bed going off: crater, ejecta, the shock, what settles (judge-0 6.1; docs/v2.md R10)',
    scene: { preset: 'empty', size: '128', grid: 128 }, seed: SEED, time: 0.25,
    camera: { pos: [120, 46, 130], target: [64, 18, 64], fov: FOV },
    build(e) {
      floor(e, 2);
      box(e, [0, 2, 0], [128, 22, 128], 'SAND');
      box(e, [62, 11, 62], [66, 14, 66], 'C4');
    },
    // set off by heat, as a fire or a fuse would (C-4 goes at 263 °C, elements.js)
    setup(e) { e.heat(...e.span([62, 11, 62], [66, 14, 66]), 400); },
    clip: { start: 0 },
  },
  {
    name: 'dam-break', kind: 'clip', title: 'A dam break',
    look: 'Dam Valley\'s dam breached across its middle: the reservoir surging into the spillway basin, then settling (judge-0 6.1; docs/v2.md P3 exit)',
    scene: { arena: 'damValley' }, seed: SEED, time: 0.5,
    camera: { pos: [160, 44, 8], target: [128, 20, 60], fov: FOV },   // downstream, over the basin
    // a breach 10 cells wide from the basin floor through the crest (arenas/damValley.js: dam z 52-68, crest 34)
    setup(e) { e.erase([123, 5, 50], [133, 40, 70]); },
    clip: { start: 0 },
  },
  {
    name: 'pour-hole', kind: 'clip', title: 'A pour from a hole',
    look: 'a full tank with a 1-cell hole 30 cells up: one arcing jet, or scattered cells (audit-liquids: "single cells scattered over 20 cells of floor"; the prototype: "one parabolic arc")',
    scene: { preset: 'empty', size: '128', grid: 128 }, seed: SEED, time: 0.25,
    camera: { pos: [52, 26, 108], target: [48, 14, 64], fov: FOV },   // the jet side-on
    // tools/whitewater-shots.mjs's tank: walls, water, a clone lid that keeps it full
    build(e) {
      const tank = box(e, [24, 0, 56], [40, 46, 72], 'WALL');
      const [lo, hi] = inset(tank, [1, 1, 1]);
      e.fill(lo, add(hi, [0, -1, 0]), 'WATER');
      e.fill([lo[0], hi[1] - 1, lo[2]], [hi[0], hi[1], hi[2]], 'CLONE', { ctype: 'WATER' });
    },
    setup(e) {
      const [, hi] = e.span([24, 0, 56], [40, 46, 72]);
      const y = Math.round(e.cell([0, 30, 0])[1]), z = Math.round(e.cell([0, 0, 64])[2]);
      e.erase([hi[0] - 1, y, z], [hi[0], y + 1, z + 1]);   // the hole, in the +x wall
    },
    clip: { start: 0.25 },
  },
  {
    name: 'sand-avalanche', kind: 'clip', title: 'A sand avalanche',
    look: 'a 48-cell cube of sand losing its retaining wall: the face slumps to the angle of repose, then stops (docs/v2.md R2: heaps at their own angle, then sleep)',
    scene: { preset: 'empty', size: '128', grid: 128 }, seed: SEED, time: 0.25,
    camera: { pos: [150, 50, 124], target: [80, 18, 60], fov: FOV },
    build(e) {
      floor(e, 2);
      const walls = box(e, [36, 2, 36], [84, 50, 84], 'WALL');
      e.fill(...inset(walls, [1, 0, 1]), 'SAND');
    },
    setup(e) {
      const [lo, hi] = e.span([36, 2, 36], [84, 50, 84]);
      e.erase([hi[0] - 1, lo[1], lo[2]], hi);   // the +x wall goes
    },
    clip: { start: 0 },
  },
  {
    name: 'lava-water', kind: 'clip', title: 'Lava meeting water',
    look: 'a lava flow off a rock shelf into a pool: steam, quench crust, what it cools into (judge-0 6.1)',
    scene: { preset: 'empty', size: '128', grid: 128 }, seed: SEED, time: 0.1,
    camera: { pos: [104, 44, 150], target: [52, 12, 64], fov: FOV },
    build(e) {
      floor(e, 2);
      box(e, [8, 2, 40], [48, 20, 88], 'ROCK');                    // the shelf
      const pool = box(e, [48, 2, 20], [120, 14, 108], 'WALL');
      const [lo, hi] = inset(pool, [1, 0, 1]);
      e.erase(lo, hi);
      e.fill(lo, add(hi, [0, -2, 0]), 'WATER');
    },
    setup(e) {
      // an endless source at the back of the shelf (the volcano's summit: a clone of lava), and a first flow
      box(e, [12, 20, 58], [18, 22, 70], 'CLONE', { ctype: 'LAVA' });
      box(e, [18, 20, 56], [30, 23, 72], 'LAVA');
    },
    clip: { start: 0.5 },
  },
  {
    name: 'pov-swim', kind: 'clip', title: 'A first-person swim',
    look: 'swimming forward at the surface, diving past rock pillars, coming back up: the water from inside (docs/v2.md 4.1: tinted by real depth)',
    // first person keeps its body's size: the pool is built at 64³ size in the box's low corner, unscaled
    scene: { preset: 'empty', size: '128', grid: null, minBox: 64 }, seed: SEED, time: 0.1,
    camera: { pov: { feet: [10, 17, 32], yaw: -Math.PI / 2, pitch: -0.15 } },
    build(e) {
      e.fill([4, 0, 4], [60, 26, 60], 'WALL');
      e.erase([5, 1, 5], [59, 26, 59]);
      e.fill([5, 1, 5], [59, 3, 59], 'SAND');
      e.fill([5, 3, 5], [59, 22, 59], 'WATER');
      for (const [x, z, h] of [[20, 20, 28], [36, 30, 24], [28, 44, 26], [46, 16, 20]]) e.fill([x, 3, z], [x + 4, h, z + 4], 'ROCK');
    },
    setup() {},
    clip: {
      start: 0,
      keys: [
        { key: 'KeyW', from: 0, to: CLIP_SECONDS },   // forward the whole clip
        { key: 'KeyC', from: 1, to: 2.5 },            // dive (pov/index.js: crouch swims down)
        { key: 'Space', from: 3.5, to: CLIP_SECONDS }, // back up
      ],
    },
  },
];

/** The shot called `name`, or null. */
export const shotByName = (name) => SHOTS.find((s) => s.name === name) ?? null;
