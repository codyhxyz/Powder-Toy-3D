// CPU-only check of the vehicles' terrain sync (src/pov/vehicles/physics.js
// syncTerrain): Rapier in node against a stand-in for the cells' copy built
// from Dam Valley, no browser or GPU. Six vehicles on their pads: the jeeps
// drive off, a hoverbike circles, the rest sit (jittering); the cells are dug,
// walled, sanded and flooded under them and far away, a readback (a version
// bump) at a time, and one vehicle is wrecked and another spawned. After
// every sync the incremental collider must equal a from-scratch one (a fresh
// physics synced once at the same centres): the same voxels, which are
// exactly the regions' cells that stop a vehicle, set without a wasted
// setVoxel call, and the same ray grounds. Then it times the syncs with six
// vehicles: a readback's with all parked and with all moving, and a move's.
// usage: node tools/vehicles-terrain-check.mjs
import RAPIER from './rapier-node.mjs';   // the game's @dimforge/rapier3d-simd, initialised
import { createPhysics } from '../src/pov/vehicles/physics.js';
import { JEEP } from '../src/pov/vehicles/jeep.js';
import { HOVERBIKE } from '../src/pov/vehicles/hoverbike.js';
import { buildDamValley, groundAt, ARENA_SIZE } from '../src/arenas/damValley.js';
import { E, K, ELEMENTS } from '../src/elements.js';

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };

// the cells' copy, with ai/world.js's interface as far as physics.js uses it
const N = ARENA_SIZE;
const KIND = ELEMENTS.map((e) => e.kind);
function copyOf(ids) {
  const at = (x, y, z) => (y * N[2] + z) * N[0] + x;
  const changes = [];
  return {
    ready: true, version: 1, dims: N, reads: 0,
    // A precise edit journal stands in for the model's conservative brick
    // revisions; world-model-node-check exercises those with real captures.
    hasIdChanges(b, since) {
      return since < 1 || changes.some(c => c.version > since &&
        c.x0 <= b.x1 && c.x1 >= b.x0 && c.y0 <= b.y1 && c.y1 >= b.y0 && c.z0 <= b.z1 && c.z1 >= b.z0);
    },
    id(x, y, z) {
      this.reads++;
      x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
      if (y >= N[1]) return E.EMPTY;
      if (x < 0 || z < 0 || y < 0 || x >= N[0] || z >= N[2]) return -1;
      return ids[at(x, y, z)];
    },
    kind: (i) => (i === -1 ? K.SOLID : KIND[i]),
    // [x0, x1) × [y0, y1) × [z0, z1), clipped to the grid
    fill(x0, y0, z0, x1, y1, z1, id) {
      changes.push({ x0, x1: x1 - 1, y0, y1: y1 - 1, z0, z1: z1 - 1, version: this.version + 1 });
      for (let y = Math.max(0, y0); y < Math.min(N[1], y1); y++)
        for (let z = Math.max(0, z0); z < Math.min(N[2], z1); z++)
          for (let x = Math.max(0, x0); x < Math.min(N[0], x1); x++) ids[at(x, y, z)] = id;
    },
  };
}
const { ids, layout } = buildDamValley();
const cells = copyOf(ids);

// A physics whose terrain keeps a shadow of its voxels: the set its setVoxel
// calls leave on, and how many calls changed nothing. (Rapier 0.21's own
// listing, coVoxelData, leaves out the voxels at index 119 and 239 of any axis
// at this voxel size, though they collide; it's checked against the shadow.)
const cellKey = (x, y, z) => ((y + 1) * (N[2] + 2) + z + 1) * (N[0] + 2) + x + 1;
function shadowed(source = cells) {
  const p = createPhysics(RAPIER, source);
  const on = new Set(), create = p.world.createCollider.bind(p.world);
  p.voxels = on;
  p.redundant = 0;
  p.world.createCollider = (desc, parent) => {
    const c = create(desc, parent);
    if (desc.shape.type !== RAPIER.ShapeType.Voxels) return c;
    on.clear();
    const set = c.setVoxel.bind(c);
    c.setVoxel = (x, y, z, v) => {
      const k = cellKey(x, y, z);
      if (v === on.has(k)) p.redundant++;
      if (v) on.add(k); else on.delete(k);
      set(x, y, z, v);
    };
    return c;
  };
  return p;
}
const sorted = (keys) => Float64Array.from(keys).sort();
const listed = (phys) => {   // Rapier's own listing
  const d = phys.terrain.colliderSet.raw.coVoxelData(phys.terrain.handle), out = new Float64Array(d.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = cellKey(d[3 * i], d[3 * i + 1], d[3 * i + 2]);
  return out.sort();
};
// a ground's corner and heights, read from Rapier's side (a collider's .shape
// is the description it was made from, whose heights array physics.js reuses)
const groundOf = (phys, key) => {
  const g = phys.ground(key);
  if (!g) return null;
  const t = g.translation();
  return { t: [t.x, t.y, t.z], h: g.colliderSet.raw.coHeightfieldHeights(g.handle) };
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameGround = (a, b) => (!a && !b) || (!!a && !!b && same(a.t, b.t) && same(a.h, b.h));
// the oracle for the voxels: every cell of the regions that stops a vehicle
function expected(phys) {
  const set = new Set();
  for (const b of phys.boxes)
    for (let y = b.y0; y <= b.y1; y++) for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++)
      if (phys.stops(x, y, z)) set.add(cellKey(x, y, z));
  return sorted(set);
}

// ---- the vehicles: centres in grid cells, as vehicles/index.js passes them
const MIDDLE = { jeep: 3.5, hoverbike: 3 };   // cells from the ground to a vehicle's middle, about
const specs = { jeep: JEEP, hoverbike: HOVERBIKE };
let serial = 0;
const parked = (v) => ({ key: `vehicle:${serial++}`, kind: v.kind, home: v.at, x: v.at[0] + 0.5, z: v.at[2] + 0.5 });
const center = (v) => ({ x: v.x, y: groundAt(Math.floor(v.x), Math.floor(v.z)) + MIDDLE[v.kind], z: v.z, key: v.key, ...specs[v.kind].GROUND });
const fleet = layout.vehicles.map(parked);
function move(v, t, i) {
  if (v.kind === 'jeep') v.x = v.home[0] + 0.5 + Math.sign(128 - v.home[0]) * Math.min(90, 40 * Math.max(0, t - 0.5));   // 12 m/s across the valley
  else if (i === 1) { v.x = v.home[0] + 10 + 9 * Math.cos(1.5 * t); v.z = v.home[2] + 9 * Math.sin(1.5 * t); }      // circling
  else { v.x = v.home[0] + 0.5 + 0.03 * Math.sin(40 * t + i); v.z = v.home[2] + 0.5 + 0.03 * Math.cos(33 * t + i); }   // sitting, jittering
}
// what a readback brings: the cells changed under and around the vehicles, and far away
function change(r) {
  const [a, b] = [fleet[r % fleet.length], fleet[(r * 7 + 3) % fleet.length]];
  const gx = Math.floor(a.x), gz = Math.floor(a.z), gy = groundAt(gx, gz);
  switch (r % 6) {
    case 0: cells.fill(gx - 4, gy - 3, gz + 2, gx + 3, gy, gz + 7, E.EMPTY); break;                // a pit ahead
    case 1: cells.fill(gx + 5, gy, gz - 6, gx + 7, gy + 5, gz + 6, E.ROCK); break;                 // a wall
    case 2: cells.fill(gx - 8, gy, gz - 8, gx + 8, gy + 1, gz + 8, E.SAND); break;                 // a layer of sand
    case 3: cells.fill(gx - 10, gy, gz - 10, gx + 10, gy + 2, gz + 10, E.WATER); break;            // a flood (the hoverbike's ground)
    case 4: cells.fill(Math.floor(b.x) - 20, 0, Math.floor(b.z) - 3, Math.floor(b.x) + 20, 40, Math.floor(b.z) + 3, E.EMPTY); break;   // a trench through the floor
    case 5: cells.fill(120, 30, 60, 136, 40, 70, E.ROCK); break;                                   // far from everyone
  }
  cells.version++;
}

// ---- incremental against from-scratch, after every sync
const phys = shadowed();
const STEP = 1 / 60, FRAMES = 540;
let syncs = 0, worst = 0, firstBad = null;
for (let f = 0; f < FRAMES; f++) {
  fleet.forEach((v, i) => move(v, f * STEP, i));
  if (f > 0 && f % 30 === 0) change(f / 30);                                 // a readback every 0.5 s
  if (f === 200) fleet.splice(4, 1);                                         // a wreck cleared away (vehicle:4)
  if (f === 320) fleet.push(parked(layout.vehicles[4]));                     // and a new one on its pad
  const centers = fleet.map(center);
  if (!phys.syncTerrain(centers)) continue;
  syncs++;
  const ref = shadowed();
  ref.syncTerrain(centers);
  const got = sorted(phys.voxels), want = sorted(ref.voxels), list = listed(phys);
  const bad = [];
  if (!same(got, want)) bad.push(`voxels (${got.length}, from scratch ${want.length})`);
  if (!same(got, expected(phys))) bad.push("voxels against the regions' cells");
  if (!same(list, listed(ref)) || list.some((k) => !phys.voxels.has(k))) bad.push("Rapier's voxels");
  if (phys.redundant) bad.push(`${phys.redundant} setVoxel calls that changed nothing`);
  for (const c of centers) if (!sameGround(groundOf(phys, c.key), groundOf(ref, c.key))) bad.push(`${c.key}'s ground`);
  if (f >= 200 && phys.ground('vehicle:4')) bad.push("the wreck's ground");
  if (bad.length && firstBad === null) { firstBad = f; console.log(`     frame ${f}: ${bad.join(', ')} differ`); }
  worst = Math.max(worst, got.length);
  ref.world.free();
}
check('incremental sync equals a from-scratch one (voxels and ray grounds)', firstBad === null,
  `${syncs} syncs over ${FRAMES} frames, up to ${worst} voxels`);

// ---- locality: exact results and cell-read counts, independent of timings
const local = copyOf(new Uint8Array(N[0] * N[1] * N[2]));
local.fill(0, 0, 0, ...N.map((v, i) => i === 1 ? 24 : v), E.ROCK);
local.version++;
const parkedCenters = [
  { key: 'near', x: 32, y: 27, z: 32, ...JEEP.GROUND },
  { key: 'overlap', x: 40, y: 27, z: 32, ...HOVERBIKE.GROUND },
  { key: 'far', x: 180, y: 27, z: 90, ...HOVERBIKE.GROUND },
];
const p = shadowed(local);
p.syncTerrain(parkedCenters);
const verify = (label, centers = parkedCenters) => {
  const ref = shadowed(local);
  ref.syncTerrain(centers);
  check(label, same(sorted(p.voxels), sorted(ref.voxels)) && centers.every(c => sameGround(groundOf(p, c.key), groundOf(ref, c.key))) && !p.redundant);
  ref.world.free();
};
const edit = (x, y, z, id) => { local.fill(x, y, z, x + 1, y + 1, z + 1, id); local.version++; };
local.reads = 0;
edit(120, 80, 65, E.ROCK);
p.syncTerrain(parkedCenters);
check('distant material edit: zero local voxel/ground cell reads and zero toggles', local.reads === 0 && p.toggled === 0, `${local.reads} reads`);
verify('distant edit preserves exact collider and grounds');
const farGround = p.ground('far');
edit(32, 23, 32, E.EMPTY);
local.reads = 0;
p.syncTerrain(parkedCenters);
check('nearby edit scans affected overlapping regions but retains distant ground', local.reads > 0 && p.toggled === 1 && p.ground('far') === farGround, `${local.reads} reads`);
verify('nearby edit matches full rebuild with overlapping regions');
edit(33, 23, 32, E.EMPTY);
edit(34, 24, 32, E.WATER); // liquid matters to hovering ground, not voxel solidity
edit(120, 81, 65, E.SAND); // latest capture is distant
p.syncTerrain(parkedCenters);
verify('nearby and liquid edits survive several skipped captures ending with a distant edit');
local.reads = 0;
p.syncTerrain(parkedCenters, true);
check('force rereads even when all revisions are unchanged', local.reads > 0);
verify('force retains exact results');
edit(120, 82, 65, E.ROCK);
const movedCenters = parkedCenters.map((c, i) => i === 0 ? { ...c, x: c.x + 8 } : c);
p.syncTerrain(movedCenters);
verify('movement on a distant-edit capture still fills newly covered cells', movedCenters);
// Ground samples extend below the voxel box; checking only that box loses this edit.
const high = [{ key: 'high', x: 32, y: 40, z: 32, ...HOVERBIKE.GROUND }];
p.syncTerrain(high, true);
const oldGround = groundOf(p, 'high');
edit(32, 24, 32, E.WATER);
p.syncTerrain(high);
check('liquid below voxel coverage still changes ray ground', !sameGround(oldGround, groundOf(p, 'high')) && p.toggled === 0);
verify('ground-only edit matches full rebuild', high);
local.idVersion = local.version;
local.version++; // a temperature-only capture does not advance material revision
local.reads = 0;
check('temperature-only capture does not sync or read terrain', !p.syncTerrain(high) && local.reads === 0);
delete local.idVersion;
// Test doubles and older model callers need no locality API.
delete local.hasIdChanges;
local.version++;
local.reads = 0;
p.syncTerrain(high);
check('models without locality metadata conservatively reread', local.reads > 0);
verify('fallback model matches full rebuild', high);
p.world.free();
phys.world.free();

// ---- time: syncs with six vehicles
function timeIt(label, { readback, drive }) {
  const six = layout.vehicles.map(parked);
  const p = createPhysics(RAPIER, cells);
  p.syncTerrain(six.map(center));
  const ms = [];
  let toggled = 0;
  for (let r = 0; r < 21; r++) {
    for (const v of six.slice(0, drive)) v.x += (readback ? 1.3 : 5.5) * Math.sign(128 - v.home[0]);
    if (readback) cells.version++;
    const t0 = performance.now();
    p.syncTerrain(six.map(center));
    ms.push(performance.now() - t0);
    toggled += p.toggled;
  }
  ms.sort((a, b) => a - b);
  console.log(`     ${label}: median ${ms[10].toFixed(2)} ms, max ${ms[20].toFixed(2)} ms (${(toggled / 21).toFixed(0)} voxels toggled)`);
  p.world.free();
}
timeIt("a readback's sync, 6 parked", { readback: true, drive: 0 });
timeIt("a readback's sync, 6 moving 1.3 cells", { readback: true, drive: 6 });
timeIt("a move's sync (no readback), 1 of 6 driving", { readback: false, drive: 1 });

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
