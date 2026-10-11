import { descentTwin, descentConstants, descentWang, DS_LEVEL_DEFS, DS_SEED } from './scenes.js';
import { pcg } from '../themedShared.js';
import { E, ELEMENTS, K } from '../../../elements.js';
import { MAT, GEOM } from '../../wang/index.js';
import { walkFlood } from '../../wang/walk.js';

// levels.js's data, computed from the scenes' JS twins (scenes.js):
// node scripts/check-descent-levels.mjs --write writes it, and without --write
// checks levels.js still matches it. Not imported by the game: levels.js is
// plain data, so the wand and Holy Mountain code read it without pulling in
// the generator.

// Loot per level (Noita's Mines hold a handful of wands and more spells and
// gold lying about; the contract's ~4–6 wands, ~6 spells, ~10 gold).
export const LOOT_COUNTS = { wand: 5, spell: 6, gold: 10 };
const LOOT_SPACING = { wand: 64, spell: 32, gold: 16 };   // cells from another site of its kind at least...
const LOOT_GAP = 10;              // ...and from any site
const LOOT_SPAWN_CLEAR = 24;      // cells from the spawn: nothing lies at your feet
const LOOT_RELS = [12, 36];       // where along a corridor segment a site may be (off its middle's lantern)
const SPAWN_MOUTH_BACK = 4;       // Mines: the spawn this far out of the cave mouth
const SPAWN_PIT_IN = 6;           // Coal, Snow: the spawn over the temple exit's middle above (its x)
const HEADROOM = 2;               // air cells a site needs over its feet
const SALT_LOOT = 0x2f61c3;
// Wang levels: which of the kit's sites (kits/*.js sites) each kind of loot prefers, first to last
const WANG_PICKS = { wand: ['wand', 'treasure', 'loot'], spell: ['loot', 'treasure'], gold: ['gold', 'loot'] };
const SITE_SETTLE = 4;            // a kit site's feet: the first standing place this far up from where the tile marks it
const WALK_TOP_OVER = 4;          // the walk's block reaches this far over the way in's highest roof

// something to stand on: a solid or a powder (not a liquid, not air)
const solidFloor = (id) => ELEMENTS[id].kind === K.SOLID || ELEMENTS[id].kind === K.POWDER;

// the feet over the floor at (x, z) in [y0, y1): the lowest air cell over a solid one with headroom, or null
export function feetAt(cell, x, z, y0, y1) {
  for (let y = y0; y < y1; y++) {
    if (cell(x, y, z) !== E.EMPTY || !solidFloor(cell(x, y - 1, z))) continue;
    let ok = true;
    for (let h = 1; h < HEADROOM; h++) if (cell(x, y + h, z) !== E.EMPTY) ok = false;
    if (ok) return y;
  }
  return null;
}

// The temple's sites (the same in every level: scenes.js's constants).
export function templeSites(C) {
  const tz0 = C.TZC - C.TZ_HALF, tz1 = C.TZC + C.TZ_HALF;
  return {
    box: [C.TX0, C.TY0, tz0, C.TX1, C.TY1, tz1],
    pool: [C.TX0 + C.POOL_REL0, C.TY0 - C.POOL_D, tz0 + C.POOL_INSET, C.TX0 + C.POOL_REL1, C.TY0, tz1 - C.POOL_INSET],
    altars: Array.from({ length: C.ALTAR_N }, (_, n) => [C.TX0 + C.ALTAR_REL0 + n * C.ALTAR_STEP, C.TY0, C.TZC]),
    shop: Array.from({ length: C.SHOP_N }, (_, n) => [C.TX0 + C.SHOP_REL0 + n * C.SHOP_STEP, C.TY0 + C.PED_H, C.TZC]),
    refresher: [C.TX0 + C.REFRESH_REL, C.TY0, C.TZC + C.REFRESH_DZ],
    exit: [C.TX0 + C.PIT_REL0, C.PIT_Y0, tz0, C.TX1, C.PIT_Y0 + C.EXIT_H, tz1],
  };
}

// The crossings of the tunnel lattice reachable from crossing `from` ([k, i, j]):
// along open segments, and down shafts (a fall: never back up). A Set of 'k,i,j'.
export function reachable(T, C, from) {
  const seen = new Set(), todo = [from];
  const key = (k, i, j) => `${k},${i},${j}`;
  while (todo.length) {
    const [k, i, j] = todo.pop();
    const id = key(k, i, j);
    if (seen.has(id)) continue;
    seen.add(id);
    if (T.dsSegX(k, j, i - 1)) todo.push([k, i - 1, j]);
    if (T.dsSegX(k, j, i)) todo.push([k, i + 1, j]);
    if (T.dsSegZ(k, i, j - 1)) todo.push([k, i, j - 1]);
    if (T.dsSegZ(k, i, j)) todo.push([k, i, j + 1]);
    if (T.dsShaft(k, i, j)) todo.push([k - 1, i, j]);
  }
  return seen;
}
// the lattice crossing nearest world column (x, z), and the layer whose floor is y0's
export const crossingOf = (C, x, z) => [Math.round((x - C.GRID_OFF) / C.GRID), Math.round((z - C.GRID_OFF) / C.GRID)];
export const layerFloor = (C, k) => C.BIOME_Y0 + k * C.LAYER_H;

// A Wang level's walk (wang/walk.js walkFlood: a body's moves, steps, jumps and
// falls) over the level from the spawn: a block over the tiled region's columns
// from the band's floor (the temple in it) to over the way in. Returns
// { reached(x, y, z): can the body stand with its feet in world cell (x, y, z)?
//   inTemple: did it reach the temple box?, count: standing places reached }.
const walks = new Map();
export function wangWalk(level, spawn) {
  const key = `${level}:${spawn}`;
  if (walks.has(key)) return walks.get(key);
  const C = descentConstants(level), W = descentWang(level), cell = descentTwin(level).dsCell, { U, H } = GEOM;
  const x0 = C.WANG_X0, z0 = C.WANG_Z0, y0 = C.FLOOR;
  const RX = C.WANG_NX * U, RZ = C.WANG_NZ * U;
  const RY = Math.max(level === 0 ? C.MOUTH_Y : C.WANG_TOP, spawn[1]) + C.TUN_H + WALK_TOP_OVER - y0;
  const wy0 = C.WANG_Y0 - y0, wy1 = C.WANG_TOP - y0;
  const codeOf = (id) => (id === E.EMPTY || ELEMENTS[id].kind === K.GAS ? MAT.AIR : ELEMENTS[id].kind === K.LIQUID ? MAT.WATER : MAT.ROCK);
  const cells = new Uint8Array(RX * RY * RZ);
  for (let z = 0; z < RZ; z++) for (let y = 0; y < RY; y++) {
    const row = RX * (y + RY * z), inWang = y >= wy0 && y < wy1;
    for (let x = 0; x < RX; x++) {
      const c = inWang ? W.wangCellJS(x + x0, y + y0, z + z0) : codeOf(cell(x + x0, y + y0, z + z0));
      cells[row + x] = c === MAT.AIR || c === MAT.ROCK ? c : passableCode(c);
    }
  }
  const { seen, list } = walkFlood(cells, [RX, RY, RZ], [[spawn[0] - x0, spawn[1] - y0, spawn[2] - z0]]);
  const at = (x, y, z) => (x < 0 || z < 0 || y < 0 || x >= RX || y >= RY || z >= RZ ? 0 : seen[x + RX * (y + RY * z)]);
  // the body's low corner is a standing place; it's 2 × 2, so feet at (x, z) are any of four corners
  const reached = (x, y, z) => {
    const [a, b, c] = [x - x0, y - y0, z - z0];
    return !!(at(a, b, c) || at(a - 1, b, c) || at(a, b, c - 1) || at(a - 1, b, c - 1));
  };
  const [tx0, ty0, tz0, tx1, ty1, tz1] = templeSites(C).box;
  let inTemple = false;
  for (let x = tx0; x < tx1 && !inTemple; x++) for (let z = tz0; z < tz1 && !inTemple; z++) for (let y = ty0; y < ty1; y++) if (reached(x, y, z)) { inTemple = true; break; }
  const out = { reached, inTemple, count: list.length };
  walks.set(key, out);
  return out;
}
// a kit code the walk keeps as is (liquids, timber, rubble...): passable ones stay, solid ones are ROCK
const passableCode = (c) => (c === MAT.WATER || c === MAT.OIL ? c : MAT.ROCK);

// A Wang level's loot candidates: the kit's sites the walk reaches, each kind's preferred first.
function wangCandidates(level, spawn, cell) {
  const W = descentWang(level), walk = wangWalk(level, spawn), out = [];
  for (const s of W.sites) {
    const y = feetAt(cell, s.x, s.z, s.y, s.y + SITE_SETTLE);
    if (y === null || !walk.reached(s.x, y, s.z)) continue;
    const h = pcg((pcg((pcg((DS_SEED + SALT_LOOT + level) >>> 0) + s.x) >>> 0) + s.z * 4096 + y) >>> 0);
    out.push({ x: s.x, y, z: s.z, h, kind: s.kind });
  }
  return out;
}

// Everything levels.js says about level `level`.
export function levelSites(level) {
  const T = descentTwin(level), C = descentConstants(level), def = DS_LEVEL_DEFS[level];
  const cell = T.dsCell;
  if (def.kit) return wangLevelSites(level, T, C, def);
  const top = C.LAYERS - 1;
  // the spawn, and the crossing it walks into
  let spawn, start;
  if (level === 0) {
    const x = C.MOUTH_X - SPAWN_MOUTH_BACK;
    spawn = [x, feetAt(cell, x, C.RAMP_ZC, C.APPROACH_Y0, C.WY), C.RAMP_ZC];
    start = [top, ...crossingOf(C, C.RAMP_X1, C.TZC)];
  } else {
    const x = C.TX0 + C.PIT_REL0 + SPAWN_PIT_IN;
    spawn = [x, feetAt(cell, x, C.TZC, layerFloor(C, top), layerFloor(C, top) + C.TUN_H), C.TZC];
    start = [top, ...crossingOf(C, x, C.TZC)];
  }
  const reach = reachable(T, C, start);
  // candidate loot sites: on reachable corridor segments, a couple per segment
  const cands = [];
  for (let k = 0; k < C.LAYERS; k++) {
    const y0 = layerFloor(C, k);
    for (let a = 0; a < Math.max(C.ROWS, C.COLS); a++) for (let s = 0; s < Math.max(C.ROWS, C.COLS) - 1; s++) {
      for (const along of ['x', 'z']) {
        const open = along === 'x' ? T.dsSegX(k, a, s) : T.dsSegZ(k, a, s);
        if (!open) continue;
        const ends = along === 'x' ? [[k, s, a], [k, s + 1, a]] : [[k, a, s], [k, a, s + 1]];
        if (!ends.some((e) => reach.has(e.join(',')))) continue;
        for (const rel of LOOT_RELS) {
          const c0 = C.GRID_OFF + s * C.GRID + rel, c1 = C.GRID_OFF + a * C.GRID;
          const [x, z] = along === 'x' ? [c0, c1] : [c1, c0];
          if (x < 0 || z < 0 || x >= C.WX || z >= C.WZ) continue;
          const y = feetAt(cell, x, z, y0, y0 + C.TUN_H);
          if (y === null) continue;
          const h = pcg((pcg((pcg((DS_SEED + SALT_LOOT + level) >>> 0) + x) >>> 0) + z * C.WY + y) >>> 0);
          cands.push({ x, y, z, h });
        }
      }
    }
  }
  cands.sort((p, q) => p.h - q.h || p.x - q.x || p.z - q.z);
  return { key: def.key, name: def.name, tier: def.tier, spawn, temple: templeSites(C), loot: pickLoot(cands, spawn, def, () => cands) };
}

// A Wang level: the spawn (the Mines' by the cave mouth; a deep level's in the
// entry hall, by the shaft), loot from the kit's sites the walk reaches.
const HALL_SPAWN_IN = 2;          // a deep level's spawn: this far in from the entry hall's west end
function wangLevelSites(level, T, C, def) {
  const cell = T.dsCell;
  const x = level === 0 ? C.MOUTH_X - SPAWN_MOUTH_BACK : C.EHALL_X0 + HALL_SPAWN_IN;
  const spawn = [x, feetAt(cell, x, C.RAMP_ZC, level === 0 ? C.APPROACH_Y0 : C.WANG_TOP, C.WY), C.RAMP_ZC];
  const cands = wangCandidates(level, spawn, cell);
  const order = (kind) => {
    const rank = (c) => { const r = WANG_PICKS[kind].indexOf(c.kind); return r < 0 ? Infinity : r; };
    return cands.filter((c) => rank(c) < Infinity).sort((p, q) => rank(p) - rank(q) || p.h - q.h || p.x - q.x || p.z - q.z);
  };
  return { key: def.key, name: def.name, tier: def.tier, spawn, temple: templeSites(C), loot: pickLoot(cands, spawn, def, order) };
}

// LOOT_COUNTS of each kind from candidates (order(kind): in the order to take them), spaced apart
function pickLoot(cands, spawn, def, order) {
  const loot = [];
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  const sp = { x: spawn[0], y: spawn[1], z: spawn[2] };
  for (const kind of Object.keys(LOOT_COUNTS)) {
    let n = 0;
    for (const c of order(kind)) {
      if (n >= LOOT_COUNTS[kind]) break;
      if (dist(c, sp) < LOOT_SPAWN_CLEAR) continue;
      if (loot.some((l) => dist(l, c) < LOOT_GAP || (l.kind === kind && dist(l, c) < LOOT_SPACING[kind]))) continue;
      loot.push({ x: c.x, y: c.y, z: c.z, kind, tier: def.tier });
      n++;
    }
  }
  return loot;
}
