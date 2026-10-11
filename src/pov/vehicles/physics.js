import { CELL_M } from '../../scale.js';
import { E, K } from '../../elements.js';

// The vehicles' rigid-body world: Rapier (@dimforge/rapier3d-simd, pinned:
// the WASM SIMD build, which every browser in Vite's default target runs),
// loaded on the first vehicle so it never weighs on boot. Its WASM is a file
// of its own (3.3 MB, ~0.84 MB brotli), compiled as it streams in
// (vite-plugin-wasm, vite.config.js), not a base64 string decoded on the main
// thread as the -compat builds ship it.
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
//
// The sync is incremental (a Minecraft chunk's remesh, not the world's): a
// region that moves only reads the cells entering it and empties the ones
// that left every region; a new readback re-reads each covered cell once
// (overlapping regions aren't walked twice); a vehicle's ray ground is rebuilt
// only when its window moved or a column top under it changed. The result is
// the same collider a full rebuild makes (tools/vehicles-terrain-check.mjs).

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
// Rapier, initialised (its WASM compiled: the module's top-level await), once per page
export function loadRapier() {
  rapierPromise ??= import('@dimforge/rapier3d-simd').then((m) => m.default ?? m);
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
  let dims = [0, 0, 0], seenVersion = -1;
  // the mirror covers the grid plus one cell of wall on each side and the floor below
  const pad = 1;
  let mx = 0, my = 0, mz = 0;
  const mi = (x, y, z) => ((y + pad) * mz + (z + pad)) * mx + (x + pad);
  // per mirror cell: is its voxel set in the collider, and how many regions cover it
  // (a voxel is set only where some region covers it: have[k] = 1 ⇒ cover[k] > 0)
  let have = null, cover = null;
  let boxes = [];   // the regions last filled: { x0, x1, y0, y1, z0, z1, cx, cy, cz } in cells (inclusive)
  const grounds = new Map();   // vehicle key → its rays' ground: { collider, x0, z0, yS, yE, r, liquid, top }
  // a filter for Rapier's ray queries: only this vehicle's ground
  const groundFilter = (key) => (c) => grounds.get(key)?.collider.handle === c.handle;

  function resetTerrain() {
    if (terrain) world.removeCollider(terrain, false);
    terrain = world.createCollider(R.ColliderDesc.voxels(new Int32Array(0), { x: CELL_M, y: CELL_M, z: CELL_M })
      .setFriction(TERRAIN_FRICTION));
    dims = [...cells.dims];
    [mx, my, mz] = [dims[0] + 2 * pad, dims[1] + pad, dims[2] + 2 * pad];
    have = new Uint8Array(mx * my * mz);
    cover = new Uint8Array(mx * my * mz);   // ≤ 255 overlapping regions
    boxes = [];
    for (const g of grounds.values()) world.removeCollider(g.collider, false);
    grounds.clear();
    seenVersion = -1;
  }

  // the rays' ground around (cx, cy, cz): column tops (with liquids', floating), dilated by radius r (m)
  const n = 2 * GROUND_HALF, top = new Float32Array((n + 1) * (n + 1)), heights = new Float32Array((n + 1) * (n + 1));
  const floats = (x, y, z) => { const i = cells.id(x, y, z); return i !== E.EMPTY && i >= 0 && KIND_OF(i) === K.LIQUID; };
  // Rebuilds `g` (this vehicle's last ground, or undefined) only if what it
  // samples changed: its corner, or a column's top (re-read when its window
  // moved, or after a readback, `fresh`). Returns the ground, rebuilt or not.
  function buildGround({ x: cx, y: cy, z: cz, r, liquid }, g, fresh) {
    liquid = !!liquid;
    const rC = r / CELL_M;
    const x0 = Math.floor(cx) - GROUND_HALF, z0 = Math.floor(cz) - GROUND_HALF;
    const yS = Math.floor(cy + GROUND_UP), yE = Math.floor(cy - GROUND_DOWN);
    if (!fresh && g && g.x0 === x0 && g.z0 === z0 && g.yS === yS && g.yE === yE && g.r === r && g.liquid === liquid) return g;   // the same window over the same cells
    for (let i = 0; i <= n; i++) for (let k = 0; k <= n; k++) {
      let t = yE - NOWHERE;
      for (let y = yS; y >= Math.max(yE, -1); y--) if (stops(x0 + i, y, z0 + k) || (liquid && floats(x0 + i, y, z0 + k))) { t = y + 1; break; }
      top[i * (n + 1) + k] = t;
    }
    // the heightfield is a function of its corner, r and the tops alone
    if (g && g.x0 === x0 && g.z0 === z0 && g.r === r && sameTops(g.top)) return Object.assign(g, { yS, yE, liquid });
    const { di, dk, rise } = tyre(rC);
    for (let i = 0; i <= n; i++) for (let k = 0; k <= n; k++) {
      const h0 = top[i * (n + 1) + k];
      let h = h0;
      for (let j = 0; j < rise.length; j++) {
        const ii = i + di[j], kk = k + dk[j];
        if (ii < 0 || kk < 0 || ii > n || kk > n) continue;
        const t = top[ii * (n + 1) + kk];
        if (t <= h || t - h0 > rC) continue;                  // lower, or a wall (higher than the tyre's radius)
        h = Math.max(h, t + rise[j] - rC);
      }
      heights[k + i * (n + 1)] = h * CELL_M;                 // Rapier's order: row (z) + column (x) · (rows + 1)
    }
    if (g) world.removeCollider(g.collider, false);
    else g = { top: new Float32Array(top.length) };
    g.collider = world.createCollider(R.ColliderDesc.heightfield(n, n, heights, { x: n * CELL_M, y: 1, z: n * CELL_M })
      .setTranslation((x0 + 0.5 + n / 2) * CELL_M, 0, (z0 + 0.5 + n / 2) * CELL_M)
      .setCollisionGroups(GHOST_GROUPS).setSolverGroups(GHOST_GROUPS));
    Object.assign(g, { x0, z0, yS, yE, r, liquid });
    g.top.set(top);
    return g;
  }
  const sameTops = (was) => { for (let i = 0; i < top.length; i++) if (top[i] !== was[i]) return false; return true; };
  // a tyre of radius rC (cells): the neighbouring columns whose step edge it
  // reaches (di, dk), and how high on it it rides over each, √(rC² − d²)
  const tyres = new Map();
  function tyre(rC) {
    let o = tyres.get(rC);
    if (o) return o;
    const reach = Math.ceil(rC + 0.5), di = [], dk = [], rise = [];
    for (let a = -reach; a <= reach; a++) for (let b = -reach; b <= reach; b++) {
      const d = Math.max(0, Math.hypot(a, b) - 0.5);          // to the step's edge, between the columns
      if ((!a && !b) || d >= rC) continue;
      di.push(a); dk.push(b); rise.push(Math.sqrt(rC * rC - d * d));
    }
    o = { di: Int32Array.from(di), dk: Int32Array.from(dk), rise: Float64Array.from(rise) };
    tyres.set(rC, o);
    return o;
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
  const sameCells = (a, b) => a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1 && a.z0 === b.z0 && a.z1 === b.z1;

  // The voxels to toggle, queued (x, y, z, on) while the regions are walked and
  // handed to Rapier after: a call into Rapier inside the walks kept V8
  // deoptimising them (~40 ns a cell instead of ~3).
  let queue = new Int32Array(4 * 4096), queued = 0, toggled = 0;
  function setVoxel(k, x, y, z, on) {
    have[k] = on;
    if (queued === queue.length) { const q = new Int32Array(2 * queue.length); q.set(queue); queue = q; }
    queue[queued] = x; queue[queued + 1] = y; queue[queued + 2] = z; queue[queued + 3] = on;
    queued += 4;
  }
  function flush() {
    for (let i = 0; i < queued; i += 4) terrain.setVoxel(queue[i], queue[i + 1], queue[i + 2], queue[i + 3] === 1);
    toggled += queued / 4;
    queued = 0;
  }
  // a region added: its cells entering every region read from the copy (if `read`)
  function coverBox(b, read) {
    for (let y = b.y0; y <= b.y1; y++)
      for (let z = b.z0; z <= b.z1; z++)
        for (let x = b.x0, k = mi(x, y, z); x <= b.x1; x++, k++)
          if (cover[k]++ === 0 && read && stops(x, y, z)) setVoxel(k, x, y, z, 1);
  }
  // a region dropped: its cells no region covers any more emptied
  function uncoverBox(b) {
    for (let y = b.y0; y <= b.y1; y++)
      for (let z = b.z0; z <= b.z1; z++)
        for (let x = b.x0, k = mi(x, y, z); x <= b.x1; x++, k++)
          if (--cover[k] === 0 && have[k] === 1) setVoxel(k, x, y, z, 0);
  }
  // every cell the regions cover, read from the copy once: each row of a
  // region minus the stretches an earlier region already walked
  function reread(list) {
    for (let j = 0; j < list.length; j++) {
      const b = list[j];
      for (let y = b.y0; y <= b.y1; y++)
        for (let z = b.z0; z <= b.z1; z++) {
          let x = b.x0;
          while (x <= b.x1) {
            let end = b.x1, skip = -Infinity;
            for (let i = 0; i < j; i++) {
              const o = list[i];
              if (y < o.y0 || y > o.y1 || z < o.z0 || z > o.z1 || o.x1 < x || o.x0 > end) continue;
              if (o.x0 <= x) skip = Math.max(skip, o.x1);     // x is in o: walked already, jump past it
              else end = o.x0 - 1;                            // o starts further on: stop before it
            }
            if (skip >= x) { x = skip + 1; continue; }
            for (let k = mi(x, y, z); x <= end; x++, k++) {
              const want = stops(x, y, z) ? 1 : 0;
              if (have[k] !== want) setVoxel(k, x, y, z, want);
            }
          }
        }
    }
  }

  // Fill the regions around `centers` (grid cells, + { key, r (m), liquid }
  // for each vehicle's ray ground) from the copy, toggling only the voxels
  // that differ; cells of regions left behind are emptied. Runs after a
  // readback (or `force`), or once a vehicle has moved REGION_RESYNC from its
  // region's centre (then every region is re-centred). Returns whether it ran.
  function syncTerrain(centers, force = false) {
    if (!cells.ready) return false;
    const d = cells.dims;
    if (!terrain || d[0] !== dims[0] || d[1] !== dims[1] || d[2] !== dims[2]) resetTerrain();
    // a readback with new ids (only ids are read here: a model that counts them
    // apart from temperatures has idVersion, which a temperature-only one skips)
    const version = cells.idVersion ?? cells.version;
    const fresh = force || version !== seenVersion;
    let moved = centers.length !== boxes.length;
    for (let i = 0; !moved && i < centers.length; i++) {
      const c = centers[i], b = boxes[i];
      moved = Math.hypot(c.x - b.cx, c.y - b.cy, c.z - b.cz) > REGION_RESYNC;
    }
    if (!fresh && !moved) return false;
    seenVersion = version;
    const next = centers.map((c) => clampBox(c.x, c.y, c.z));
    toggled = 0;
    // the regions that changed: cover the new ones before uncovering the old,
    // so a cell in both never empties and refills
    const gone = boxes.slice(), added = [];
    for (const b of next) {
      const j = gone.findIndex((o) => sameCells(o, b));
      if (j >= 0) gone.splice(j, 1); else added.push(b);
    }
    for (const b of added) coverBox(b, !fresh);   // after a readback, reread() reads them below
    for (const b of gone) uncoverBox(b);
    boxes = next;
    if (fresh) reread(next);
    flush();
    // the rays' grounds
    const keep = new Set();
    for (const c of centers) {
      if (c.key == null) continue;
      keep.add(c.key);
      grounds.set(c.key, buildGround(c, grounds.get(c.key), fresh));
    }
    for (const [key, g] of grounds) if (!keep.has(key)) { world.removeCollider(g.collider, false); grounds.delete(key); }
    return true;
  }

  return {
    R, world,
    get terrain() { return terrain; },
    get toggled() { return toggled; },     // voxels the last sync changed (checks)
    get boxes() { return boxes; },         // the regions last filled (checks)
    ground: (key) => grounds.get(key)?.collider ?? null,   // a vehicle's ray ground (checks)
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
