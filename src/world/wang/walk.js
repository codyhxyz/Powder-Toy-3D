import { passable, isLiquid } from './kit.js';

// Where a body can get to, walking, over a block of kit material codes (the
// CPU's check that a tiling, or a tile, is playable without digging; a scene
// can run it over wangCellJS to vet a site). The body is BODY_W × BODY_H cells
// (pov/constants.js: 1.6 × 5.5), steps up a cell and jumps JUMP (Noita's
// little hop), falls any height (Noita has no fall damage), and swims up in
// a liquid. It moves on standing places: cells whose body fits and that stand
// on something solid (or float in liquid).
export const BODY_W = 2;
export const BODY_H = 6;
export const JUMP = 2;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// cells: Uint8Array of codes, index x + RX (y + RY z); dims [RX, RY, RZ];
// starts: [[x, y, z], ...] (the body's low corner; each falls to where it lands).
// Outside x and z is rock; above the block is open; falling out of its
// bottom is recorded in fellOut (the [x, z] it left at) rather than standing.
// Returns { seen (Uint8Array: 1 at standing places reached), list (their indices), fellOut }.
export function walkFlood(cells, [RX, RY, RZ], starts) {
  const at = (x, y, z) => x + RX * (y + RY * z);
  const open = (x, y, z) => (x < 0 || z < 0 || x >= RX || z >= RZ ? false : y < 0 || y >= RY ? true : passable(cells[at(x, y, z)]));
  const fits = (x, y, z) => {
    for (let dz = 0; dz < BODY_W; dz++) for (let dx = 0; dx < BODY_W; dx++) for (let dy = 0; dy < BODY_H; dy++) if (!open(x + dx, y + dy, z + dz)) return false;
    return true;
  };
  const wet = (x, y, z) => {
    if (y < 0 || y >= RY) return false;
    for (let dz = 0; dz < BODY_W; dz++) for (let dx = 0; dx < BODY_W; dx++) if (isLiquid(cells[at(x + dx, y, z + dz)])) return true;
    return false;
  };
  const supported = (x, y, z) => {
    for (let dz = 0; dz < BODY_W; dz++) for (let dx = 0; dx < BODY_W; dx++) if (!open(x + dx, y - 1, z + dz)) return true;
    return wet(x, y, z);
  };
  const fellOut = [];
  const settle = (x, y, z) => {
    while (!supported(x, y, z)) { y--; if (y < 0) { fellOut.push([x, z]); return -1; } }
    return y;
  };
  const N = RX * RY * RZ, seen = new Uint8Array(N), q = new Int32Array(N);
  let qh = 0, qt = 0;
  const push = (x, y, z) => { if (y < 0 || y >= RY) return; const i = at(x, y, z); if (!seen[i]) { seen[i] = 1; q[qt++] = i; } };
  for (const [sx, sy, sz] of starts) {
    if (!fits(sx, sy, sz)) continue;
    const y = settle(sx, sy, sz);
    if (y >= 0) push(sx, y, sz);
  }
  while (qh < qt) {
    const i = q[qh++], x = i % RX, y = Math.floor(i / RX) % RY, z = Math.floor(i / (RX * RY));
    for (const [dx, dz] of DIRS) {
      for (let dy = 0; dy <= JUMP; dy++) {
        if (dy && !fits(x, y + dy, z)) break;                 // no headroom to rise
        if (fits(x + dx, y + dy, z + dz)) {
          const ny = settle(x + dx, y + dy, z + dz);
          if (ny >= 0) push(x + dx, ny, z + dz);
          break;
        }
      }
    }
    if (wet(x, y, z) && fits(x, y + 1, z)) push(x, y + 1, z);   // swim up
  }
  return { seen, list: q.subarray(0, qt), fellOut, fits };
}
