// v2 "crisp" pitch evidence: how many voxel faces a raster renderer would draw.
// Builds the box presets on the CPU exactly as the app does (presets.js), then counts
// exposed faces per render class, surface bricks, and the faces that face the default
// god-view camera (per face, and per 16³-chunk direction bucket, which is what a GPU
// chunk-level direction cull would keep). No GPU.
// usage: node faces.mjs <repo> [n=128]
import { pathToFileURL } from 'node:url';
const R = process.argv[2];
const n = Number(process.argv[3] ?? 128);
const S = await import(pathToFileURL(`${R}/src/sim.js`));
const P = await import(pathToFileURL(`${R}/src/presets.js`));
const { ELEMENTS, R: RC, K } = await import(pathToFileURL(`${R}/src/elements.js`));

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const CH = 16;

function run(name, nx, ny, nz) {
  const g = S.gridLayout(nx, ny, nz);
  let A = null;
  const sim = { g, cellTexel: (x, y, z) => S.cellTexel(g, x, y, z), load: (a) => { A = a; } };
  sim.blankState = S.Simulation.prototype.blankState.bind(sim);
  P.buildPreset(name, sim);
  if (!A) { console.log(name, 'no state'); return; }
  const ids = new Uint8Array(nx * ny * nz);
  const at = (x, y, z) => x + nx * (z + nz * y);
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++)
    ids[at(x, y, z)] = A[S.cellTexel(g, x, y, z) * 4];
  // classes: 0 air, 1 opaque, 2 liquid, 3 glass, 4 gas/fire
  const cls = (id) => {
    const e = ELEMENTS[id];
    if (!e || e.kind === K.EMPTY) return 0;
    if (e.render === RC.LIQUID) return 2;
    if (e.render === RC.GLASS) return 3;
    if (e.render === RC.GAS || e.render === RC.FIRE) return 4;
    return 1;   // OPAQUE (lava is opaque in today's table)
  };
  const C = new Uint8Array(ids.length);
  for (let i = 0; i < ids.length; i++) C[i] = cls(ids[i]);
  const get = (x, y, z) => {
    if (y < 0) return 1;                 // the box floor: nothing below is visible
    if (x < 0 || z < 0 || x >= nx || z >= nz || y >= ny) return 0;   // open box sides and top
    return C[at(x, y, z)];
  };
  // default god view of a 128³ box (app.js: camera (11,12,13), target (0,2.5,0), box 10 units wide)
  const u = nx / 10;
  const cam = [(11 + 5) * u, 12 * u, (13 + 5) * u];
  const count = { cells: [0, 0, 0, 0, 0], opaque: 0, liquid: 0, glass: 0, opaqueFacing: 0, liquidFacing: 0 };
  const surfBricks = new Set();
  const buckets = new Map();   // chunk*6+dir -> faces
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const c = C[at(x, y, z)];
    count.cells[c]++;
    if (c === 0 || c === 4) continue;
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      const o = get(x + dx, y + dy, z + dz);
      let exposed = false;
      if (c === 1) exposed = o !== 1;
      else if (c === 2) exposed = o === 0 || o === 3 || o === 4;
      else if (c === 3) exposed = o !== 3 && o !== 1;
      if (!exposed) continue;
      const fc = [x + 0.5 + dx * 0.5, y + 0.5 + dy * 0.5, z + 0.5 + dz * 0.5];
      const facing = dx * (cam[0] - fc[0]) + dy * (cam[1] - fc[1]) + dz * (cam[2] - fc[2]) > 0;
      if (c === 1) { count.opaque++; if (facing) count.opaqueFacing++; surfBricks.add(((x >> 2) + (nx >> 2) * ((z >> 2) + (nz >> 2) * (y >> 2)))); }
      if (c === 2) { count.liquid++; if (facing) count.liquidFacing++; }
      if (c === 3) count.glass++;
      if (c === 1) {
        const ch = (x / CH | 0) + 64 * ((z / CH | 0) + 64 * (y / CH | 0));
        const key = ch * 6 + d;
        buckets.set(key, (buckets.get(key) || 0) + 1);
      }
    }
  }
  // chunk-bucket direction cull: keep a (chunk, dir) bucket unless the camera is behind the chunk's
  // farthest face plane in that direction (then no face of that direction in the chunk can face it)
  let kept = 0;
  for (const [key, f] of buckets) {
    const d = key % 6, ch = (key - d) / 6;
    const cx = ch % 64, cz = ((ch - cx) / 64) % 64, cy = Math.floor(ch / 4096);
    const lo = [cx * CH, cy * CH, cz * CH], hi = [lo[0] + CH, lo[1] + CH, lo[2] + CH];
    const [dx, dy, dz] = DIRS[d];
    const axis = dx ? 0 : dy ? 1 : 2, s = dx || dy || dz;
    // faces of direction +axis sit at most at hi[axis]; visible only if cam[axis] > plane for some face in range
    const visible = s > 0 ? cam[axis] > lo[axis] : cam[axis] < hi[axis];
    if (visible) kept += f;
  }
  const pct = (a, b) => (a / b * 100).toFixed(0) + '%';
  console.log(`${name} ${nx}x${ny}x${nz}: cells air ${count.cells[0]}, opaque ${count.cells[1]}, liquid ${count.cells[2]}, glass ${count.cells[3]}, gas ${count.cells[4]}`);
  console.log(`  exposed faces: opaque ${count.opaque}, liquid ${count.liquid}, glass ${count.glass}; surface bricks ${surfBricks.size} of ${(nx * ny * nz) >> 6}`);
  console.log(`  facing the god-view camera: opaque ${count.opaqueFacing} (${pct(count.opaqueFacing, count.opaque)}), liquid ${count.liquidFacing}; kept by a 16³-chunk direction cull: ${kept} (${pct(kept, count.opaque)})`);
  console.log(`  face instance bytes at 8 B (opaque) + 16 B (liquid/glass): ${((count.opaque * 8 + (count.liquid + count.glass) * 16) / 1e6).toFixed(2)} MB`);
}

run('lab', n, n, n);
run('volcano', n, n, n);
const [ax, ay, az] = P.ARENA_PRESETS.damValley.size;
run('damValley', ax, ay, az);
