// What each dock tile holds. Every tile is a small box run by the engine port
// (engine.js), so the only choices made here are the starting arrangement and
// the boundaries. Layout follows the element's kind, so new elements need
// nothing here.
//   powders, liquids, solids: the material fills the box up to HEADSPACE rows
//     of air. A brim-full box can't move (grains don't pass through grains),
//     so the air gap is what lets anything happen.
//   gases: two soft blobs, sampled as gas cells. The Erase tool is held
//     over a hidden row above the box, so gas rises out instead of filling it.
//   a battery: under a plate of metal (BATTERY_PLATE rows), which it sparks.
import { K, E } from '../../elements.js';
import { World } from './engine.js';

export const TILE = 44;               // tile edge, CSS px
export const CELL = 2;                // cell edge, CSS px
export const COLS = TILE / CELL;      // 22
export const ROWS = TILE / CELL;      // visible rows
export const HEADSPACE = {             // rows of air above the material
  [K.POWDER]: 5,                      // room for grains to be thrown and land
  [K.LIQUID]: 5,                      // room to splash
  [K.SOLID]: 3,                       // air for burning surfaces
};
const GAS_HIDDEN_ABOVE = 1;           // erased row
const BATTERY_PLATE = 3;              // rows of metal on top of a battery tile's battery

// the flat tile textures (formerly CSS), used to lay out the starting cells
export const SPECKS = [               // powder dots: background cell size (px), dot centre in it
  { size: 9, fx: 0.2, fy: 0.3 },
  { size: 11, fx: 0.7, fy: 0.6 },
  { size: 7, fx: 0.45, fy: 0.8 },
];
export const BLOBS = [                // gas: elliptical gradients, centre/radii as tile fractions
  { cx: 0.35, cy: 0.30, rx: 0.70, ry: 0.60, alpha: 0.35, fade: 0.7 },
  { cx: 0.75, cy: 0.80, rx: 0.60, ry: 0.50, alpha: 0.18, fade: 0.7 },
];
export const GAS_FILL = 0.9;          // chance a cell holds gas at the brightest point of a blob

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// blob brightness at a tile point, 0..1 relative to the brightest blob
export function blobAlpha(px, py) {
  let a = 0;
  for (const b of BLOBS) {
    const dx = (px - b.cx * TILE) / (b.rx * TILE), dy = (py - b.cy * TILE) / (b.ry * TILE);
    const r = Math.hypot(dx, dy) / b.fade;
    if (r < 1) a = a + b.alpha * (1 - r) - a * b.alpha * (1 - r);
  }
  return a / BLOBS[0].alpha;
}

export function makeScene(item, seed) {
  const rand = rng(seed);
  const gas = item.kind === K.GAS;
  const ny = gas ? ROWS + GAS_HIDDEN_ABOVE : ROWS;
  const w = new World(COLS, ny);
  const y0 = 0; // world row of the bottom visible row
  const rowOf = (r) => y0 + (ROWS - 1 - r); // r = visible row from the top
  for (let r = 0; r < ROWS; r++)
    for (let x = 0; x < COLS; x++) {
      const y = rowOf(r);
      if (gas) {
        const p = blobAlpha((x + 0.5) * CELL, (r + 0.5) * CELL) * GAS_FILL;
        if (rand() < p) w.put(x, y, item.id, { seed: rand() });
      } else if (r >= HEADSPACE[item.kind]) {
        const plate = item.id === E.BATTERY && r < HEADSPACE[item.kind] + BATTERY_PLATE;
        w.put(x, y, plate ? E.METAL : item.id, { seed: rand() });
      }
    }
  if (item.kind === K.POWDER) {
    SPECKS.forEach((s, li) => {
      for (let px = s.fx * s.size; px < TILE; px += s.size)
        for (let py = s.fy * s.size; py < TILE; py += s.size) {
          const r = (py / CELL) | 0;
          if (r >= HEADSPACE[item.kind]) w.mark[w.idx((px / CELL) | 0, rowOf(r))] = li + 1;
        }
    });
  }
  if (gas) w.sinkRow = ny - 1;
  return { world: w, rest: w.clone(), y0, gas, item };
}
