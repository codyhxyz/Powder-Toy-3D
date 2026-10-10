// World structures: built-in constructions made for the World island
// (docs/structures.md says where each one stands and why). They are ordinary
// built-ins, in the palette like the house and the tree and written in the
// same API (runtime.js); they live apart from builtins.js because that file is
// the AI system prompt's worked examples, and these would only lengthen it.
//
// Every one is built to the human scale (shared.js HUMAN) at T = 1: the
// first-person body walks into each, up every stair and out along every deck.
// And every one is stable as generated (docs/structures.md, Stability): no
// lit fire, no CLONE, no ice, no loose powder, no water touching plants.

import { HUMAN, MASONRY, TAU, odd } from './shared.js';

const frac = (x) => x - Math.floor(x);

// ---------------------------------------------------------------- stairs

// A spiral stair: single-cell treads round a newel, rising pitch cells a turn
// counterclockwise from angle a0 (radians from +x toward +z), from tread
// height y0 up to y1. A tread's height is its angle's share of the turn, so a
// step is at most one cell wherever the inner radius is at least
// pitch / 2π cells; a turn of pitch cells leaves pitch - 1 clear above every
// tread. Returns tread(x, z): the highest tread height under a column (or -1).
const STAIR = {
  PITCH: 12,      // cells a turn: 11 clear above a tread (HUMAN.HEADROOM is 7), one cell a step from radius 1.9 out
  NEWEL: 1.5,     // the newel's radius: a 3 × 3 column
  CLEAR_R: 4.3,   // the stair's clear radius at least: past the diagonal cell (3, 3), so the body's
                  // 2-cell-wide footprint gets round between the newel and the wall
  STRIDE: 2,      // the body stands on the highest tread under its footprint: up to this many steps
                  // above the one under a given column
};

function spiral({ put }, { rIn, rOut, y0, y1, a0, pitch, el }) {
  const R = Math.ceil(rOut);
  const top = new Map();
  for (let z = -R; z <= R; z++)
    for (let x = -R; x <= R; x++) {
      const d = Math.hypot(x, z);
      if (d <= rIn || d > rOut) continue;
      const u = frac((Math.atan2(z, x) - a0) / TAU);
      for (let y = y0 + Math.floor(u * pitch); y <= y1; y += pitch) {
        put(x, y, z, el);
        top.set(`${x},${z}`, y);
      }
    }
  return (x, z) => top.get(`${x},${z}`) ?? -1;
}

// The floor a spiral stair comes up through at height F: solid over the
// stair's columns except where the last turn's treads are within HEADROOM
// (and a stride) below it: the stairwell. Solid over the newel.
function landing({ put }, { tread, rOut, F, el }) {
  const R = Math.ceil(rOut);
  for (let z = -R; z <= R; z++)
    for (let x = -R; x <= R; x++) {
      if (Math.hypot(x, z) > rOut) continue;
      const t = tread(x, z);
      if (t < F && t > F - HUMAN.HEADROOM - STAIR.STRIDE) continue;
      put(x, F, z, el);
    }
}

// ---------------------------------------------------------------- dock

// A wooden pier from the shore out over the sea, its deck a step above the
// water on posts. The posts are the only cells on the base row, so the stamp's
// footing grows each into a stilt down to the sea floor (shaders/stamp.js)
// rather than a solid wall. 'hut' puts a fisher's shack on its head.
const DOCK = {
  LEN: 30,          // the pier's length from the shore, cells at T = 1 (9 m)
  W: 5,             // deck width (1.5 m)
  POST_EVERY: 4,    // posts along each edge, every this many cells
  HEAD: [13, 9],    // the T-shaped head: width and length
  BOLLARD: 2,       // bollards: cells above the deck at the head's corners
  HUT: [9, 7],      // the shack on the head: width and depth
  HUT_ROOF: 'METAL',// a tin roof
  FOOT: 30,         // stilts reach this far down to the sea floor
};

export function dock({ put, box, footing, T }, variant) {
  const L = Math.round(DOCK.LEN * T), hw = (odd(DOCK.W * T) - 1) / 2, every = Math.max(2, Math.round(DOCK.POST_EVERY * T));
  const [HW, HL] = [(odd(DOCK.HEAD[0] * T) - 1) / 2, Math.round(DOCK.HEAD[1] * T)];
  const deck = 1;    // the deck's row: the base row holds only posts
  footing(DOCK.FOOT);

  // a step up from the shore, then the deck and its posts
  box(-hw, 0, -1, hw, 0, 0, 'WOOD');
  box(-hw, deck, 0, hw, deck, L, 'WOOD');
  for (let z = every; z <= L; z += every) for (const x of [-hw, hw]) put(x, 0, z, 'WOOD');
  // the head, wider, with a post at every corner and edge and bollards at its seaward corners
  const z0 = L - HL + 1;
  box(-HW, deck, z0, HW, deck, L, 'WOOD');
  for (let z = z0; z <= L; z += every) for (let x = -HW; x <= HW; x += every) put(x, 0, z, 'WOOD');
  for (const x of [-HW, HW]) { put(x, 0, L, 'WOOD'); box(x, deck + 1, L, x, deck + DOCK.BOLLARD, L, 'WOOD'); }
  if (variant === 'hut') hut(z0);

  // a plank shack on the head: its door to the shore, a window to the sea
  function hut(zb) {
    const [w, dp] = DOCK.HUT.map((n) => odd(n * T)), a = (w - 1) / 2, b = (dp - 1) / 2;
    const cz = zb + b + 1, H = Math.round(HUMAN.ROOM_H * T), dh = Math.round(HUMAN.DOOR_H * T);
    for (let y = deck + 1; y <= deck + H; y++)
      for (let z = cz - b; z <= cz + b; z++)
        for (let x = -a; x <= a; x++)
          put(x, y, z, Math.abs(x) === a || Math.abs(z - cz) === b ? 'WOOD' : 'AIR');
    const dw = (odd(HUMAN.DOOR_W * T) - 1) / 2;
    box(-dw, deck + 1, cz - b, dw, deck + dh, cz - b, 'AIR');
    const sill = deck + 1 + Math.round(HUMAN.SILL_H * T);
    box(-1, sill, cz + b, 1, sill + Math.round(HUMAN.WINDOW_H * T) - 1, cz + b, 'GLASS');
    // a lean-to roof, high over the door and sloping to the sea, overhanging by a cell
    for (let z = cz - b - 1; z <= cz + b + 1; z++) {
      const y = deck + H + 1 + Math.round((cz + b + 1 - z) / 3);
      box(-a - 1, y, z, a + 1, y, z, DOCK.HUT_ROOF);
      for (let yy = deck + H + 1; yy < y; yy++) for (const x of [-a, a]) if (Math.abs(z - cz) <= b) put(x, yy, z, 'WOOD');
    }
  }
}

// ---------------------------------------------------------------- towers

// A tower you climb for the view: a spiral stair round a newel inside, a
// landing at the top. 'lighthouse' is striped masonry on a cliff, with a glass
// lantern (unlit: a lamp that burns would churn a loaded world) and a railed
// gallery round it; 'watch' a timber frame on a hilltop with a roofed
// platform; 'ruin' a broken stone keep whose stair still climbs to its
// broken top.
const TOWER = {
  LIGHT: {
    R: [7.5, 6], WALL: 1.5,  // the shaft's radius at its foot and top, and its wall: STAIR.CLEAR_R inside at the top
    TURNS: 3, STRIPE: 6,     // its height in stair turns; its stripes' height
    GALLERY: 3.5,            // the gallery reaches this far past the shaft (2 cells to walk round the lantern)
    LANTERN_R: 6, LANTERN_H: 8, DOME: 0.6, LAMP: 3, // the lantern: radius (clear of the stairwell), height, dome squash, the lamp's drop from its roof
    SLITS: 4, SLIT_H: 3,     // slit windows a turn, and their height
  },
  WATCH: { HALF: 5, POST: 1, TURNS: 2, DECK: 7, ROOF_H: 8, BRACE_EVERY: 6 },
  RUIN: {
    R: 8, WALL: 2,          // the keep: radius and wall thickness
    H: 15, H_JITTER: 7,     // its broken top wanders this far round this height...
    WAVES: [[1, 0.6], [2, 0.3], [5, 0.25]], // ...in these waves round the keep (per turn, weight)
    LOW: 3,                 // ...never below this (stumps)
    GAPS: 0.06,             // blocks missing from the wall above the stumps
    STAIR_W: 2.5,           // the stair's width inside the wall...
    STAIR_RISE: 18,         // ...and its rise a turn (it climbs most of one: 0.8 cells a step at its inside)
    CURTAIN: 14, CURTAIN_H: 0.6, CURTAIN_FALL: 1.2, // a curtain wall: length, height (share of H), and how it falls away
    RUBBLE: [5, 8], RUBBLE_R: [1, 2.2], RUBBLE_D: [1, 4], RUBBLE_SY: 0.7, RUBBLE_BED: 0.8, // fallen blocks: count, size, distance out, squash, bedded in this share
    DOOR_CLEAR: 0.7,        // no rubble where the sine of its angle (toward the door, +z) is above this
  },
  DOOR_TURN: 0.12,   // the stair starts this share of a turn past the door, so the doorway has the full headroom
  T_MAX: 2,          // size scale cap: a lighthouse at T = 2 is 95 cells tall, and the box is 128
};

export function tower(api, variant) {
  api = { ...api, T: Math.min(api.T, TOWER.T_MAX) };
  if (variant === 'watch') watchtower(api);
  else if (variant === 'ruin') ruin(api);
  else lighthouse(api);
}

const DOOR_ANGLE = Math.PI / 2;   // +z, the front

function lighthouse(api) {
  const { put, box, disc, footing, T } = api;
  const S = TOWER.LIGHT, pitch = Math.round(STAIR.PITCH * T);
  const [Rb, Rt] = S.R.map((r) => r * T), wall = S.WALL * Math.max(1, T);
  const F = 1 + S.TURNS * pitch;                   // the landing's height
  const rOut = Rt - wall, rIn = STAIR.NEWEL;
  footing();
  // the shaft: a tapering striped shell over a slab, and the newel up its middle
  const B = Math.ceil(Rb) + 1;
  for (let y = 0; y < F; y++) {
    const R = Rb + (Rt - Rb) * (y / F), band = Math.floor(y / Math.round(S.STRIPE * T)) % 2 ? 'METAL' : MASONRY;
    for (let z = -B; z <= B; z++)
      for (let x = -B; x <= B; x++) {
        const d = Math.hypot(x, z);
        if (d > R + 0.35) continue;
        if (y === 0 || d <= rIn) put(x, y, z, MASONRY);
        else put(x, y, z, d > R - wall ? band : 'AIR');
      }
  }
  door(api, Rb, wall);
  const tread = spiral(api, { rIn, rOut, y0: 1, y1: F - 1, a0: DOOR_ANGLE + TOWER.DOOR_TURN * TAU, pitch, el: MASONRY });
  slits(api, { R: (y) => Rb + (Rt - Rb) * (y / F), wall, F, pitch, n: S.SLITS, h: Math.round(S.SLIT_H * T) });
  // the gallery: a floor past the shaft with a railing, and the landing over the stairwell
  const G = Rt + S.GALLERY * T;
  disc(0, F, 0, G, MASONRY);
  for (let z = -Math.ceil(G); z <= Math.ceil(G); z++)
    for (let x = -Math.ceil(G); x <= Math.ceil(G); x++) {
      const d = Math.hypot(x, z);
      if (d <= rOut + 0.35) put(x, F, z, 'AIR');             // landing() lays this part
      else if (d > G - 1 && d <= G) box(x, F + 1, z, x, F + HUMAN.RAIL_H, z, 'METAL');
    }
  landing(api, { tread, rOut: rOut + 0.35, F, el: MASONRY });
  // the lantern: glass on a metal frame round the landing, a door onto the gallery, a dome
  const LR = S.LANTERN_R * T, LH = Math.round(S.LANTERN_H * T), dw = (odd(HUMAN.DOOR_W * T) - 1) / 2;
  for (let y = F + 1; y <= F + LH; y++)
    for (let z = -Math.ceil(LR) - 1; z <= Math.ceil(LR) + 1; z++)
      for (let x = -Math.ceil(LR) - 1; x <= Math.ceil(LR) + 1; x++) {
        const d = Math.hypot(x, z);
        if (d > LR + 0.35 || d <= LR - 1.15) continue;
        const door = z > 0 && Math.abs(x) <= dw && y <= F + Math.round(HUMAN.DOOR_H * T);
        put(x, y, z, door ? 'AIR' : y === F + LH || (x === 0 || z === 0) ? 'METAL' : 'GLASS');
      }
  // a metal dome over it, and the lamp's glass lens on a stand on the newel
  const DR = LR + 0.5, DH = Math.ceil(DR * S.DOME);
  for (let i = 0; i <= DH; i++) disc(0, F + LH + i, 0, DR * Math.sqrt(Math.max(0, 1 - (i / (DR * S.DOME)) ** 2)), 'METAL');
  const lamp = F + LH - Math.round(S.LAMP * T);
  box(0, F + 1, 0, 0, lamp - 1, 0, 'METAL');
  box(-1, lamp, -1, 1, lamp + 1, 1, 'GLASS');
}

function watchtower(api) {
  const { put, box, rod, vec, footing, T } = api;
  const S = TOWER.WATCH, pitch = Math.round(STAIR.PITCH * T);
  const h = Math.round(S.HALF * T), post = Math.max(0, Math.round(S.POST * T));
  const F = 1 + S.TURNS * pitch, D = Math.round(S.DECK * T);
  footing();
  // a plank floor, the corner posts up to the roof, and X braces on the sides (the front left open)
  box(-h, 0, -h, h, 0, h, 'WOOD');
  const top = F + Math.round(HUMAN.DOOR_H * T) + 1;
  const brace = Math.round(S.BRACE_EVERY * T);
  for (let y = 1; y + brace <= F; y += brace)
    for (const [a, b] of [[[-h, -h], [h, -h]], [[-h, -h], [-h, h]], [[h, -h], [h, h]]]) {
      rod(vec(a[0], y, a[1]), vec(b[0], y + brace, b[1]), 0.5, 'WOOD');
      rod(vec(b[0], y, b[1]), vec(a[0], y + brace, a[1]), 0.5, 'WOOD');
    }
  box(-1, 1, -1, 1, F - 1, 1, 'WOOD'); // the newel
  const rOut = Math.max(h - post - 0.5, STAIR.CLEAR_R);
  const tread = spiral(api, { rIn: STAIR.NEWEL, rOut, y0: 1, y1: F - 1, a0: DOOR_ANGLE + TOWER.DOOR_TURN * TAU, pitch, el: 'WOOD' });
  // the platform overhangs the frame, railed, round the stairwell
  box(-D, F, -D, D, F, D, 'WOOD');
  box(-h + post + 1, F, -h + post + 1, h - post - 1, F, h - post - 1, 'AIR');
  landing(api, { tread, rOut: rOut + 1, F, el: 'WOOD' });
  for (let z = -D; z <= D; z++)
    for (let x = -D; x <= D; x++) if (Math.max(Math.abs(x), Math.abs(z)) === D) box(x, F + 1, z, x, F + HUMAN.RAIL_H, z, 'WOOD');
  // a hipped roof, one cell thick, with the corner posts running up into it
  for (let i = 0; i <= D; i++) {
    box(-D + i, top + i, -D + i, D - i, top + i, D - i, 'WOOD');
    if (i < D) box(-D + i + 1, top + i, -D + i + 1, D - i - 1, top + i, D - i - 1, 'AIR');
  }
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) box(sx * h, 1, sz * h, sx * (h - post), top + D - h, sz * (h - post), 'WOOD');
}

function ruin(api) {
  const { put, box, ball, footing, rnd, T } = api;
  const S = TOWER.RUIN;
  const R = S.R * T, wall = S.WALL * Math.max(1, T), ri = R - wall;
  const phase = S.WAVES.map(() => rnd() * TAU);
  // the broken top: the wall's height wanders round the keep, down to stumps
  const crest = (a) => Math.max(S.LOW, Math.round(T * (S.H + S.H_JITTER * S.WAVES.reduce((sum, [k, wt], i) => sum + wt * Math.sin(k * a + phase[i]), 0))));
  footing();
  const B = Math.ceil(R) + 1, dw = (odd(HUMAN.DOOR_W * T) - 1) / 2, dh = Math.round(HUMAN.DOOR_H * T);
  for (let z = -B; z <= B; z++)
    for (let x = -B; x <= B; x++) {
      const d = Math.hypot(x, z);
      if (d > R + 0.35) continue;
      put(x, 0, z, MASONRY);
      if (d <= ri) continue;
      const hTop = crest(Math.atan2(z, x));
      for (let y = 1; y <= hTop; y++) {
        const doorway = z > 0 && Math.abs(x) <= dw && y <= dh;
        if (!doorway && !(y > S.LOW && rnd() < S.GAPS)) put(x, y, z, MASONRY);
      }
    }
  // a solid stair hugging the wall inside, one turn up to where the wall still stands highest
  const rIn = ri - Math.max(2, S.STAIR_W * T), a0 = DOOR_ANGLE + TOWER.DOOR_TURN * TAU;
  for (let z = -B; z <= B; z++)
    for (let x = -B; x <= B; x++) {
      const d = Math.hypot(x, z);
      if (d <= rIn || d > ri + 0.35) continue;
      const u = frac((Math.atan2(z, x) - a0) / TAU);
      if (u > 1 - TOWER.DOOR_TURN * 2) continue; // stop short of the doorway
      box(x, 1, z, x, Math.floor(u * S.STAIR_RISE * T) + 1, z, MASONRY);
    }
  // a curtain wall running off to one side, broken off
  const cl = Math.round(S.CURTAIN * T);
  for (let x = Math.round(R) - 1; x <= Math.round(R) + cl; x++) {
    const hTop = Math.max(S.LOW, Math.round(T * S.H * S.CURTAIN_H * (1 - (x - R) / (cl * S.CURTAIN_FALL)) + rnd.range(-1, 1)));
    box(x, 0, -1, x, 0, 1, MASONRY);
    box(x, 1, -1, x, hTop, 1, MASONRY);
    if ((x & 1) === 0) box(x, hTop + 1, -1, x, hTop + 1, 1, MASONRY); // crenels
  }
  // fallen blocks: rough boulders of rock round the base
  for (let i = rnd.int(...S.RUBBLE); i > 0; i--) {
    const a = rnd() * TAU, d = R + rnd.range(...S.RUBBLE_D) * T, r = rnd.range(...S.RUBBLE_R) * T;
    if (Math.sin(a) > S.DOOR_CLEAR) continue; // keep the way to the door clear
    ball(Math.cos(a) * d, r * S.RUBBLE_SY * S.RUBBLE_BED, Math.sin(a) * d, r, 'ROCK', { sy: S.RUBBLE_SY, rough: 0.5 });
  }
}

// a doorway through a round shell of radius R toward +z
function door({ box, T }, R, wall) {
  const dw = (odd(HUMAN.DOOR_W * T) - 1) / 2, dh = Math.round(HUMAN.DOOR_H * T);
  box(-dw, 1, Math.floor(R - wall - 0.5), dw, dh, Math.ceil(R) + 1, 'AIR');
}

// glass slit windows up a round shell, a few to a turn of the stair
function slits({ box }, { R, wall, F, pitch, n, h }) {
  for (let y = pitch; y + h < F; y += pitch)
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5 + (y / pitch) * 0.25) / n * TAU, r = R(y) - wall / 2;
      const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
      if (z > 0 && Math.abs(x) <= HUMAN.DOOR_W) continue; // not over the door
      box(x, y, z, x, y + h - 1, z, 'GLASS');
    }
}

// ---------------------------------------------------------------- stones

// A ring of standing stones round a low altar on a hilltop: natural rock, so
// the pickaxe can quarry it, and the altar a place for a perk shrine.
const STONES = {
  R: 15,               // the ring's radius, cells at T = 1 (9 m across)
  COUNT: [9, 12],
  H: [7, 11],          // a stone's height (2.1 to 3.3 m)...
  W: [2.5, 3.5],       // ...width along the ring...
  THICK: [1.5, 2],     // ...and thickness across it
  TAPER: 0.3,          // stones narrow by this share toward the top
  LEAN: 0.12,          // ...and lean by up to this many cells per cell of height
  FALLEN: 0.15,        // chance a stone lies fallen
  GAP: 0.35,           // radians of jitter in a stone's place round the ring
  ALTAR: [5, 3, 2],    // the altar slab: width, depth, height
};

export function stones({ put, box, footing, rnd, T }) {
  const R = STONES.R * T, n = rnd.int(...STONES.COUNT), a0 = rnd() * TAU;
  footing(8);
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU + rnd.range(-STONES.GAP, STONES.GAP) / 2;
    const h = rnd.range(...STONES.H) * T, w = rnd.range(...STONES.W) * T / 2, t = rnd.range(...STONES.THICK) * T / 2;
    const lean = rnd.range(-STONES.LEAN, STONES.LEAN), fallen = rnd() < STONES.FALLEN;
    const cx = Math.cos(a) * R, cz = Math.sin(a) * R, ux = -Math.sin(a), uz = Math.cos(a); // u: along the ring
    if (fallen) { slab(cx, cz, ux, uz, h / 2, t, w); continue; }
    const S = Math.ceil(Math.max(w, t) + h * Math.abs(lean)) + 1;
    for (let y = 0; y < h; y++) {
      const k = 1 - STONES.TAPER * (y / h) ** 2, ox = cx + ux * lean * y, oz = cz + uz * lean * y;
      for (let z = Math.floor(cz - S); z <= Math.ceil(cz + S); z++)
        for (let x = Math.floor(cx - S); x <= Math.ceil(cx + S); x++) {
          const dx = x - ox, dz = z - oz, u = dx * ux + dz * uz, v = dx * Math.cos(a) + dz * Math.sin(a);
          if (Math.abs(u) <= w * k && Math.abs(v) <= t * k) put(x, y, z, 'ROCK');
        }
    }
  }
  const [aw, ad, ah] = STONES.ALTAR.map((s) => Math.round(s * T));
  box(-(aw >> 1), 0, -(ad >> 1), aw >> 1, ah - 1, ad >> 1, 'ROCK');

  // a fallen stone: lying along the ring, half its height long
  function slab(cx, cz, ux, uz, l, t, w) {
    const S = Math.ceil(l + w) + 1;
    for (let y = 0; y < 2 * t; y++)
      for (let z = Math.floor(cz - S); z <= Math.ceil(cz + S); z++)
        for (let x = Math.floor(cx - S); x <= Math.ceil(cx + S); x++) {
          const dx = x - cx, dz = z - cz, u = dx * ux + dz * uz, v = dx * uz - dz * ux;
          if (Math.abs(u) <= l && Math.abs(v) <= w) put(x, y, z, 'ROCK');
        }
  }
}

// ---------------------------------------------------------------- well

// A village well: a stone parapet round a sealed shaft of water (on its own
// stone floor, so the water touches no ground cover and nothing grows into
// it), a windlass on two posts and a little roof.
const WELL = {
  R: 3.3,          // the parapet's outer radius, cells at T = 1 (2 m across)
  BAND: 1.5,       // its thickness: a liquid-tight round wall
  H: 3,            // its height above the stone floor (0.9 m)
  WATER: 2,        // water depth: its surface a cell below the parapet's top
  POSTS_H: 9,      // the windlass posts' height above the parapet's base (the axle at 2.4 m)
  ROPE: 3,         // the rope down from the axle to the bucket
};

export function well({ put, box, footing, T }) {
  const R = WELL.R * T, ri = R - WELL.BAND, H = Math.round(WELL.H * T), B = Math.ceil(R) + 1;
  const ph = Math.round(WELL.POSTS_H * T), px = Math.round(R);
  footing();
  for (let z = -B; z <= B; z++)
    for (let x = -B; x <= B; x++) {
      const d = Math.hypot(x, z);
      if (d > R + 0.35) continue;
      put(x, 0, z, MASONRY);
      for (let y = 1; y <= H; y++) put(x, y, z, d > ri ? MASONRY : y <= WELL.WATER ? 'WATER' : 'AIR');
    }
  // windlass: posts on the parapet, an axle across, a rope and a bucket
  const rz = Math.ceil(R / 2) + 1;   // the roof's half-depth: its ridge rz cells above the eaves
  for (const s of [-1, 1]) box(s * px, H + 1, 0, s * px, ph + rz - 1, 0, 'WOOD');
  box(-px + 1, ph - 1, 0, px - 1, ph - 1, 0, 'WOOD');
  box(0, ph - 1 - WELL.ROPE, 0, 0, ph - 2, 0, 'WOOD');
  box(0, ph - 2 - WELL.ROPE, 0, 0, ph - 2 - WELL.ROPE, 0, 'METAL');
  // a gable roof along x over the posts
  for (let i = 0; i <= rz; i++) {
    box(-px - 1, ph + i, -(rz - i), px + 1, ph + i, -(rz - i), 'WOOD');
    box(-px - 1, ph + i, rz - i, px + 1, ph + i, rz - i, 'WOOD');
  }
}

// ---------------------------------------------------------------- mine

// A drift mine's mouth: a timber portal and a gallery driven straight into the
// hillside behind it (the construction carves its own tunnel, so it works on
// any slope steep enough to bury it), timber sets holding the roof, rails on
// a plank floor running out to a loaded cart. Placed facing out of a slope;
// in the box it stands as a timber gallery in the open.
const MINE = {
  LEN: 24,        // the gallery's length into the hill, cells at T = 1 (7 m)
  W: 5,           // clear width between the posts (1.5 m)
  SET_EVERY: 4,   // timber sets along the gallery
  SPUR: 9,        // rails run out past the portal this far, to a buffer (room to turn in past the cart)
  CART: [3, 3, 4],// the cart: width, height, length
  CRATE: 2,       // crates (0.6 m) at the gallery's end: two stacked on the left, one on the right
};

export function mine({ put, box, footing, T }) {
  const L = Math.round(MINE.LEN * T), w = (odd(MINE.W * T) - 1) / 2, h = Math.round(HUMAN.DOOR_H * T);
  const every = Math.max(2, Math.round(MINE.SET_EVERY * T)), spur = Math.round(MINE.SPUR * T);
  const x0 = w + 1;   // the posts' and the gallery walls' x
  footing();
  // the gallery: carved out above a plank floor with rails, a timber set every few cells
  box(-x0, 1, -L, x0, h + 1, 0, 'AIR');
  box(-w, 0, -L, w, 0, spur, 'WOOD');
  for (const x of [-1, 1]) box(x, 0, -L, x, 0, spur, 'METAL');
  for (let z = 0; z >= -L; z -= every) {
    for (const s of [-1, 1]) box(s * x0, 1, z, s * x0, h, z, 'WOOD');
    box(-x0, h + 1, z, x0, h + 1, z, 'WOOD');
  }
  // the portal: heavier posts and a header with a little gable over it
  for (const s of [-1, 1]) box(s * x0, 0, 0, s * (x0 + 1), h + 1, 1, 'WOOD');
  box(-x0 - 2, h + 2, 0, x0 + 2, h + 2, 1, 'WOOD');
  for (let i = 0; i <= x0 + 1; i++) box(-x0 - 1 + i, h + 3 + i, 0, x0 + 1 - i, h + 3 + i, 0, 'WOOD');
  // the spur's buffer stop, and a cart of rubble on the rails
  box(-w, 1, spur, w, 2, spur, 'WOOD');
  const [cw, ch, cl] = MINE.CART.map((n) => Math.round(n * T)), cz = spur - cl;
  box(-(cw >> 1), 1, cz, cw >> 1, ch, cz + cl - 1, 'METAL');
  box(-(cw >> 1) + 1, 2, cz + 1, (cw >> 1) - 1, ch, cz + cl - 2, 'STONE');
  // crates at the end of the gallery, against the face
  const c = Math.max(1, Math.round(MINE.CRATE * T));
  box(-w, 1, -L, -w + c - 1, 2 * c, -L + c - 1, 'WOOD');
  box(w - c + 1, 1, -L, w, c, -L + c - 1, 'WOOD');
}

// ---------------------------------------------------------------- wreck

// A ship's hull cast up on a beach: heeled over and half sunk into the sand
// (cells below the base are dropped, so the stamp leaves the beach there),
// her stern stove in to bare ribs, a broken mast and her anchor on the sand.
const WRECK = {
  LEN: 38,          // length, beam and depth of hold, cells at T = 1 (11.4 × 3.6 × 2.4 m)
  BEAM: 12,
  DEPTH: 8,
  SHEER: 4,         // the gunwale rises this much toward bow and stern
  SHELL: 1.5,       // hull planking thickness: no diagonal gaps
  HEEL: [0.15, 0.3], // radians she lies over
  SINK: 1,          // cells of her keel under the sand
  STOVE: 0.3,       // the stern's share of her length broken to ribs...
  RIB_EVERY: 3,     // ...one rib (and one deck beam) every this many cells
  GASH: [0.35, 0.75, 0.3], // planking torn off her high side: from and to these shares of her depth, this share of her length either side of midships
  PLANK_GAPS: 0.04, // planks sprung from the hull elsewhere
  BOW: 0.6,         // her plan's fullness toward the bow (lower is finer)...
  STERN: 4,         // ...and toward the stern (higher is blunter)
  MAST_AT: 0.1,     // the mast stands this share of her length ahead of midships...
  MAST: 0.6,        // ...its stump this share of the beam tall
  SPAR: [-0.25, 0.2], // the rest of it lies on the sand beside her, from and to these shares of her length
  SPAR_OFF: 3,      // ...this many cells off her side
  ANCHOR: 5,        // the anchor off her bow: its shank...
  ANCHOR_OFF: 3,    // ...this far out
  FLUKE: [2, 2.6],  // ...its arms' reach at the crown and at their tips
  T_MAX: 2,         // size scale cap: she is 90 cells long with her anchor at T = 2, and the box is 128
};

export function wreck({ put, rod, vec, footing, rnd, T: size }) {
  const T = Math.min(size, WRECK.T_MAX);
  const L = WRECK.LEN * T, B = WRECK.BEAM * T, D = WRECK.DEPTH * T, sh = WRECK.SHELL;
  const heel = rnd.range(...WRECK.HEEL) * (rnd() < 0.5 ? -1 : 1), sink = WRECK.SINK * T;
  const c = Math.cos(heel), s = Math.sin(heel);
  footing(6);
  // the hull's half-width at height y above the keel, at z along her length (bow +z): a blunt
  // stern, a fine bow, round bilges; and her deck's height there
  const half = (y, z) => {
    const t = (2 * z) / L, plan = t > 0 ? Math.max(0, 1 - t * t) ** WRECK.BOW : Math.sqrt(Math.max(0, 1 - t ** WRECK.STERN));
    return (B / 2) * plan * Math.sqrt(Math.max(0, y / D));
  };
  const deck = (z) => D + WRECK.SHEER * T * ((2 * z) / L) ** 2;
  const inside = (hx, hy, z, inset) => hy >= inset && hy <= deck(z) && Math.abs(hx) <= half(hy, z) - inset
    && Math.abs(z) <= L / 2 - inset;
  const stern = -L / 2 + WRECK.STOVE * L;
  const side = heel > 0 ? 1 : -1;   // her high side (she lies over toward -x when heel > 0)
  const [gash0, gash1, gashZ] = [WRECK.GASH[0] * D, WRECK.GASH[1] * D, WRECK.GASH[2] * L];
  const X = Math.ceil(B / 2 + D) + 1, Y = Math.ceil(D + WRECK.SHEER * T + B / 2);
  for (let z = Math.floor(-L / 2); z <= Math.ceil(L / 2); z++)
    for (let y = 0; y <= Y; y++)
      for (let x = -X; x <= X; x++) {
        // the cell in the hull's frame: heeled over by `heel` about her keel, sunk by `sink`
        const Yw = y + sink, hx = x * c + Yw * s, hy = -x * s + Yw * c;
        if (!inside(hx, hy, z, 0)) continue;
        const shell = !inside(hx, hy, z, sh), top = hy > deck(z) - 1;
        const rib = ((z % WRECK.RIB_EVERY) + WRECK.RIB_EVERY) % WRECK.RIB_EVERY === 0;
        if (!shell && !(top && rib)) continue;    // the deck is gone but for its beams
        const gash = hx * side > 0 && hy > gash0 && hy < gash1 && Math.abs(z) < gashZ;
        if ((z < stern || gash) && !rib) continue; // stove in or torn open: ribs only
        if (rnd() < WRECK.PLANK_GAPS) continue;
        put(x, y, z, 'WOOD');
      }
  // the mast: a stump on the deck, heeled with her; the rest of it on the sand beside
  // (the hull's frame to the world's: x = hx c - hy s, y = hx s + hy c - sink)
  const zm = WRECK.MAST_AT * L, dk = deck(zm) - 1;
  const up = vec(-s, c, 0), base = vec(-dk * s, dk * c - sink, zm);
  rod(base, base.clone().addScaledVector(up, B * WRECK.MAST), 1, 'WOOD');
  // the rest of the mast on the sand, off her high side
  const mx = side * (B / 2 + WRECK.SPAR_OFF * T);
  rod(vec(mx, 0, WRECK.SPAR[0] * L), vec(mx + side * 2, 0, WRECK.SPAR[1] * L), 0.5, 'WOOD');
  // her anchor off the bow, lying flat: a shank with a ring, a crown and two arms
  const az = L / 2 + WRECK.ANCHOR_OFF * T, al = WRECK.ANCHOR * T, [f0, f1] = WRECK.FLUKE.map((f) => f * T);
  rod(vec(0, 0, az), vec(0, 0, az + al), 0.5, 'METAL');
  rod(vec(-f0, 0, az + 1), vec(f0, 0, az + 1), 0.5, 'METAL');
  for (const sx of [-1, 1]) rod(vec(sx * f0, 0, az + 1), vec(sx * f1, 0, az - 1), 0.5, 'METAL');
  put(0, 1, az + al, 'METAL');
}

export const STRUCTURES = { DOCK: dock, TOWER: tower, STONES: stones, WELL: well, MINE: mine, WRECK: wreck };
