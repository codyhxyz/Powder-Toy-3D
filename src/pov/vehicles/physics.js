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
// The ground a vehicle's rays see (the jeep's wheels, the hoverbike's fans):
// not the voxels' stairs (a raycast wheel sees only the ground straight under
// its axle, so a 0.3 m riser is a wall it bottoms out on), but the surface a
// rigid tyre of radius r actually rides on them: each column's top, dilated by
// the tyre's circle (a wheel touches a step's edge up to √(r² − (r − h)²)
// ahead of its axle). A step higher than the radius is a wall, left to the
// voxels. It's a heightfield per vehicle, around it, that collides with
// nothing; only that vehicle's rays query it. A hover vehicle's counts liquid
// tops as ground (it skims them).
const GROUND_HALF = 20;                   // cells around the vehicle the wheels' heightfield covers
const GROUND_UP = 1;                      // cells above the vehicle's middle a column's top may be
const GROUND_DOWN = 16;                   // cells below it the search for a top goes
const NOWHERE = 1000;                     // cells below the search: a column with no ground
const GHOST_GROUPS = 0x00020000;          // Rapier collision groups: member of group 2, interacts with none
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
  let acc = 0, clock = 0;

  // ---- terrain
  let terrain = null;
  let dims = [0, 0, 0], have = null, seenVersion = -1;
  // the mirror covers the grid plus one cell of wall on each side and the floor below
  const pad = 1;
  let mx = 0, my = 0, mz = 0;
  const mi = (x, y, z) => ((y + pad) * mz + (z + pad)) * mx + (x + pad);
  let boxes = [];   // the regions last filled: { x0, x1, y0, y1, z0, z1, cx, cy, cz } in cells (inclusive)
  const grounds = new Map();   // vehicle key → the heightfield its rays see
  // a filter for Rapier's ray queries: only this vehicle's ground
  const groundFilter = (key) => (c) => grounds.get(key)?.handle === c.handle;

  function resetTerrain() {
    if (terrain) world.removeCollider(terrain, false);
    terrain = world.createCollider(R.ColliderDesc.voxels(new Int32Array(0), { x: CELL_M, y: CELL_M, z: CELL_M })
      .setFriction(TERRAIN_FRICTION));
    dims = [...cells.dims];
    [mx, my, mz] = [dims[0] + 2 * pad, dims[1] + pad, dims[2] + 2 * pad];
    have = new Uint8Array(mx * my * mz);
    boxes = [];
    for (const gc of grounds.values()) world.removeCollider(gc, false);
    grounds.clear();
    seenVersion = -1;
  }

  // the rays' ground around (cx, cy, cz): column tops (with liquids', floating), dilated by radius r (m)
  const n = 2 * GROUND_HALF, top = new Float32Array((n + 1) * (n + 1)), heights = new Float32Array((n + 1) * (n + 1));
  const floats = (x, y, z) => { const i = cells.id(x, y, z); return i !== E.EMPTY && i >= 0 && KIND_OF(i) === K.LIQUID; };
  function buildGround({ x: cx, y: cy, z: cz, r, liquid }) {
    const rC = r / CELL_M, reach = Math.ceil(rC + 0.5);
    const x0 = Math.floor(cx) - GROUND_HALF, z0 = Math.floor(cz) - GROUND_HALF;
    const yS = Math.floor(cy + GROUND_UP), yE = Math.floor(cy - GROUND_DOWN);
    for (let i = 0; i <= n; i++) for (let k = 0; k <= n; k++) {
      let t = yE - NOWHERE;
      for (let y = yS; y >= Math.max(yE, -1); y--) if (stops(x0 + i, y, z0 + k) || (liquid && floats(x0 + i, y, z0 + k))) { t = y + 1; break; }
      top[i * (n + 1) + k] = t;
    }
    for (let i = 0; i <= n; i++) for (let k = 0; k <= n; k++) {
      const h0 = top[i * (n + 1) + k];
      let h = h0;
      for (let di = -reach; di <= reach; di++) for (let dk = -reach; dk <= reach; dk++) {
        const ii = i + di, kk = k + dk;
        if ((!di && !dk) || ii < 0 || kk < 0 || ii > n || kk > n) continue;
        const t = top[ii * (n + 1) + kk];
        if (t <= h || t - h0 > rC) continue;                  // lower, or a wall (higher than the tyre's radius)
        const d = Math.max(0, Math.hypot(di, dk) - 0.5);      // to the step's edge, between the columns
        if (d >= rC) continue;
        h = Math.max(h, t + Math.sqrt(rC * rC - d * d) - rC);
      }
      heights[k + i * (n + 1)] = h * CELL_M;                 // Rapier's order: row (z) + column (x) · (rows + 1)
    }
    const gc = world.createCollider(R.ColliderDesc.heightfield(n, n, heights, { x: n * CELL_M, y: 1, z: n * CELL_M })
      .setTranslation((x0 + 0.5 + n / 2) * CELL_M, 0, (z0 + 0.5 + n / 2) * CELL_M)
      .setCollisionGroups(GHOST_GROUPS).setSolverGroups(GHOST_GROUPS));
    return gc;
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

  // Fill the regions around `centers` (grid cells, + { key, r (m), liquid }
  // for each vehicle's ray ground) from the copy, toggling only the voxels
  // that differ; cells of regions left behind are emptied.
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
    for (const gc of grounds.values()) world.removeCollider(gc, false);
    grounds.clear();
    for (const c of centers) if (c.key != null) grounds.set(c.key, buildGround(c));
  }

  return {
    R, world,
    get terrain() { return terrain; },
    get toggled() { return toggled; },     // voxels the last sync changed (checks)
    stops,
    syncTerrain,
    groundFilter,                        // (key) → a ray filter that sees only that vehicle's ground
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
      clock += n * STEP_S;
      return n;
    },
    get clock() { return clock; },       // s of simulated time so far (checks: rates that don't depend on the frame rate)
    reset() { resetTerrain(); },
  };
}
