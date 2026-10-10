import { CELL_M } from '../../scale.js';
import { E, K } from '../../elements.js';

// The vehicles' rigid-body world: Rapier (@dimforge/rapier3d-compat, pinned),
// loaded on the first vehicle so it never weighs on boot (its WASM is ~1.4 MB
// gzipped, inlined as base64 by the -compat build, which loads under Vite with
// no plugin).
//
// Units: Rapier works in metres, kilograms and seconds, so its default
// tolerances and every borrowed tuning number (Bullet's raycast vehicle, real
// masses) mean what they say. Grid cells convert at CELL_M: a cell (x, y, z)
// is the box [x, x+1]·CELL_M, which is exactly Rapier's voxel (x, y, z) at a
// voxel size of CELL_M (checked: a voxel at index i spans [i·size, (i+1)·size]).
//
// Terrain: one Voxels collider (Rapier ≥ 0.19's sparse voxel shape) holds the
// cells that stop a vehicle, solids and powders, read from a CPU copy of the
// cells (ai/world.js: the multiplayer packer's readback, ≤ 0.5 s old). Only a
// region around each vehicle is kept filled, and only the cells that changed
// are toggled (setVoxel), so a dug pit or a fresh wall shows up within one
// readback, and a 128³ box never costs a full voxelisation. Liquids aren't
// voxels: the vehicles float, wade and skim on them themselves (buoyancy,
// drag, the hoverbike's springs). The box's side walls and floor (outside the
// grid) are solid voxels too, as they are for the player's body.

export const GRAVITY = 9.81;              // m/s², real gravity: vehicles are rigid bodies in real units
export const STEP_S = 1 / 60;             // s, Rapier's fixed step (its default timestep)
const MAX_STEPS = 4;                      // fixed steps per frame at most (a long frame is slowed down, not exploded)
// The terrain region kept around each vehicle, in cells. Half-extents cover
// the vehicle (a jeep is 15 cells long) plus a resync's worth of travel.
const REGION_HALF_XZ = 24;                // cells (7.2 m)
const REGION_HALF_Y = 14;                 // cells (4.2 m)
const REGION_RESYNC = 5;                  // cells a vehicle moves before its region is refilled from the copy
// What the chassis rubs on when it bottoms out or rolls: steel and rubber on
// dirt and rock, μ ≈ 0.6 (Engineering Toolbox, friction coefficients).
const TERRAIN_FRICTION = 0.6;

let rapierPromise = null;
// Rapier, initialised (its WASM compiled), once per page
export function loadRapier() {
  rapierPromise ??= import('@dimforge/rapier3d-compat').then(async (m) => {
    const R = m.default ?? m;
    await R.init();
    return R;
  });
  return rapierPromise;
}

export const toM = (cells) => cells * CELL_M;
export const toCells = (m) => m / CELL_M;

// The rigid-body world and its voxel terrain. world = ai/world.js's model.
export function createPhysics(R, cells) {
  const world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
  world.timestep = STEP_S;
  let acc = 0;

  // ---- terrain
  let terrain = null;
  let dims = [0, 0, 0], have = null, seenVersion = -1;
  // the mirror covers the grid plus one cell of wall on each side and the floor below
  const pad = 1;
  let mx = 0, my = 0, mz = 0;
  const mi = (x, y, z) => ((y + pad) * mz + (z + pad)) * mx + (x + pad);
  let boxes = [];   // the regions last filled: { x0, x1, y0, y1, z0, z1, cx, cy, cz } in cells (inclusive)

  function resetTerrain() {
    if (terrain) world.removeCollider(terrain, false);
    terrain = world.createCollider(R.ColliderDesc.voxels(new Int32Array(0), { x: CELL_M, y: CELL_M, z: CELL_M })
      .setFriction(TERRAIN_FRICTION));
    dims = [...cells.dims];
    [mx, my, mz] = [dims[0] + 2 * pad, dims[1] + pad, dims[2] + 2 * pad];
    have = new Uint8Array(mx * my * mz);
    boxes = [];
    seenVersion = -1;
  }

  // What stops a vehicle: solids and powders (as for the player's body).
  const KIND_OF = (i) => cells.kind(i);
  function stops(x, y, z) {
    const i = cells.id(x, y, z);
    if (i === E.EMPTY) return false;
    const k = KIND_OF(i);
    return k === K.SOLID || k === K.POWDER;
  }

  const clampBox = (cx, cy, cz) => {
    const [nx, ny, nz] = dims;
    const c = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    return {
      x0: c(Math.floor(cx - REGION_HALF_XZ), -pad, nx), x1: c(Math.floor(cx + REGION_HALF_XZ), -pad, nx),
      y0: c(Math.floor(cy - REGION_HALF_Y), -pad, ny - 1), y1: c(Math.floor(cy + REGION_HALF_Y), -pad, ny - 1),
      z0: c(Math.floor(cz - REGION_HALF_XZ), -pad, nz), z1: c(Math.floor(cz + REGION_HALF_XZ), -pad, nz),
      cx, cy, cz,
    };
  };
  const inside = (b, x, y, z) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1;

  // Fill the regions around `centers` (grid cells) from the copy, toggling
  // only the voxels that differ; cells of regions left behind are emptied.
  let toggled = 0;
  function syncTerrain(centers, force = false) {
    if (!cells.ready) return;
    const d = cells.dims;
    if (!terrain || d[0] !== dims[0] || d[1] !== dims[1] || d[2] !== dims[2]) resetTerrain();
    const fresh = cells.version !== seenVersion;
    const moved = centers.length !== boxes.length
      || centers.some((c, i) => Math.hypot(c.x - boxes[i].cx, c.y - boxes[i].cy, c.z - boxes[i].cz) > REGION_RESYNC);
    if (!force && !fresh && !moved) return;
    seenVersion = cells.version;
    const next = centers.map((c) => clampBox(c.x, c.y, c.z));
    toggled = 0;
    for (const b of [...boxes, ...next]) {
      for (let y = b.y0; y <= b.y1; y++)
        for (let z = b.z0; z <= b.z1; z++)
          for (let x = b.x0; x <= b.x1; x++) {
            const want = next.some((n) => inside(n, x, y, z)) && stops(x, y, z) ? 1 : 0;
            const k = mi(x, y, z);
            if (have[k] === want) continue;
            have[k] = want;
            terrain.setVoxel(x, y, z, want === 1);
            toggled++;
          }
    }
    boxes = next;
  }

  return {
    R, world,
    get terrain() { return terrain; },
    get toggled() { return toggled; },     // voxels the last sync changed (checks)
    stops,
    syncTerrain,
    // Advance in fixed steps; before(h) runs ahead of each (forces, the vehicle controllers).
    step(dt, before) {
      acc = Math.min(acc + dt, MAX_STEPS * STEP_S);
      let n = 0;
      while (acc >= STEP_S) {
        before(STEP_S);
        world.step();
        acc -= STEP_S;
        n++;
      }
      return n;
    },
    reset() { resetTerrain(); },
  };
}
