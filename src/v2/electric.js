// CPU twin of the electric pass (shaders/v2/electric.js): the same scalar rules
// (v2/contact.js ctElecStep, ctElecApply, emitted to WGSL from these very
// functions) in the same order, over a small grid of native cores. Each tick
// is ELEC_STEPS of V1's steps (src/electricity.js; react.js electric), each a
// gather of every listed cell from the last step's cores and six faces, then a
// commit; step 0 gathers the awake bricks and lists the 3³ of those it changed,
// later steps run over that list alone, as the GPU's do.
import { CONTACT_CONSTANTS, ctElecMaterial, ctElecStep, ctElecApply, ctNew, ctRoll, unpackContact, packContact } from './contact.js';
import { E } from '../elements.js';

export const ELEC_STEPS = CONTACT_CONSTANTS.CT_ELEC_STEPS[1];
const ELEC_SALT = CONTACT_CONSTANTS.CT_ELEC_SALT[1];
const BRICK = 4;   // shaders/common.js BS
// shaders/v2/electric.js face6: +x, -x, +y, -y, +z, -z
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// shaders/v2/contact.js ctSeed
export const elecSeed = (x, y, z, tick) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(tick, 2654435761)) | 0;

/**
 * A grid of native cells for the twin: dims [nx, ny, nz], cores (4 words a cell) and banks, cell
 * x + nx·(y + ny·z). Bricks are BRICK³ from the origin (the last ones may be partial).
 */
export function electricGrid(nx, ny, nz) {
  return { dims: [nx, ny, nz], cores: new Uint32Array(nx * ny * nz * 4), banks: new Int32Array(nx * ny * nz) };
}
export const gridIndex = ({ dims: [nx, ny] }, x, y, z) => x + nx * (y + ny * z);
export function gridCell(grid, x, y, z) {
  const i = gridIndex(grid, x, y, z);
  return unpackContact(grid.cores.subarray(4 * i, 4 * i + 4), grid.banks[i]);
}
export function setGridCell(grid, x, y, z, c) {
  const i = gridIndex(grid, x, y, z), out = packContact(c, grid.cores.subarray(4 * i, 4 * i + 4));
  grid.cores.set(out.core, 4 * i); grid.banks[i] = out.bank;
}

/**
 * One tick of the pass on `grid` (in place). awake: the brick ids (bx + BX·(by + BY·bz)) the
 * activity pass listed, or null for all. Returns the energy it declared as a source, the bricks it
 * marked busy, the bricks it listed after step 0 and the cells each step changed.
 */
export function electricTick(grid, tick, { awake = null } = {}) {
  const [nx, ny, nz] = grid.dims, B = grid.dims.map(n => Math.ceil(n / BRICK));
  const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz;
  const brickOf = (x, y, z) => Math.floor(x / BRICK) + B[0] * (Math.floor(y / BRICK) + B[1] * Math.floor(z / BRICK));
  const cellsOf = function* (b) {
    const bx = b % B[0], by = Math.floor(b / B[0]) % B[1], bz = Math.floor(b / (B[0] * B[1]));
    for (let z = bz * BRICK; z < bz * BRICK + BRICK; z++) for (let y = by * BRICK; y < by * BRICK + BRICK; y++) for (let x = bx * BRICK; x < bx * BRICK + BRICK; x++) {
      if (inside(x, y, z)) yield [x, y, z];
    }
  };
  const all = Array.from({ length: B[0] * B[1] * B[2] }, (_, b) => b);
  let listed = [];
  let source = 0n;
  const busy = new Set(), changed = [];
  for (let step = 0; step < ELEC_STEPS; step++) {
    const words = new Map(), touched = new Set();
    for (const b of step === 0 ? (awake ? [...awake] : all) : listed) for (const [x, y, z] of cellsOf(b)) {
      const i = gridIndex(grid, x, y, z);
      if (!ctElecMaterial(grid.cores[4 * i] & 255)) continue;
      const ns = FACES.map(([dx, dy, dz]) => {
        const [qx, qy, qz] = [x + dx, y + dy, z + dz];
        if (inside(qx, qy, qz)) return gridCell(grid, qx, qy, qz);
        const out = ctNew(E.EMPTY, 0, 65536); out.valid = 0; return out;
      });
      const word = ctElecStep(gridCell(grid, x, y, z), ns, ctRoll(elecSeed(x, y, z, tick), ELEC_SALT + step));
      if (word !== 0) { words.set(i, [x, y, z, word]); touched.add(b); }
    }
    if (step === 0) {
      const claim = new Set();
      for (const b of touched) {
        const bx = b % B[0], by = Math.floor(b / B[0]) % B[1], bz = Math.floor(b / (B[0] * B[1]));
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const [cx, cy, cz] = [bx + dx, by + dy, bz + dz];
          if (cx >= 0 && cy >= 0 && cz >= 0 && cx < B[0] && cy < B[1] && cz < B[2]) claim.add(cx + B[0] * (cy + B[1] * cz));
        }
      }
      listed = [...claim];
    }
    const commit = new Set(listed);
    for (const [x, y, z, word] of words.values()) {
      // the GPU commits over the list only: a change outside it would be lost there
      if (!commit.has(brickOf(x, y, z))) throw Error(`electric change at ${x},${y},${z} outside the listed bricks`);
      const c = ctElecApply(gridCell(grid, x, y, z), word);
      setGridCell(grid, x, y, z, c);
      source += c.source;
      busy.add(brickOf(x, y, z));
    }
    changed.push(words.size);
  }
  return { source, busy, listed, changed };
}
