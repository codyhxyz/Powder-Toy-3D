// CPU-only BASE terrain/route acceptance. Composed overlays are independently
// checked by check-city-folk.mjs; pads are intentionally clear before buildings.
// Run: node tools/check-city-folk-terrain.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { E } from '../src/elements.js';
import { willowCove as scene, willowCoveTwin, CITY_FOLK_TERRAIN as C, WILLOW_LANDMARKS as M } from '../src/world/scenes/willowCove.js';

const P = scene.params({ size: scene.size, seed: 20261008 });
const T = willowCoveTwin(P);
const cell = (x, y, z) => T.cfTerrainCell(x, y, z);
const dry = id => [E.ROCK, E.WOOD, E.PLANKS, E.BRICK, E.SANDSTONE, E.PLANT, E.SAND].includes(id);
let walked = 0;
const visited = new Set();
function sample(x, z, previous) {
  assert(T.cfPath(x, z), `unprotected route ${x},${z}`);
  const h = T.cfHeight(x, z);
  if (previous !== undefined) assert(Math.abs(h - previous) <= 1, `cliff on route ${x},${z}: ${previous} -> ${h}`);
  let head = h;
  for (let dx = -3; dx < 3; dx++) for (let dz = -3; dz < 3; dz++) {
    const bh = T.cfHeight(x + dx, z + dz);
    assert(Math.abs(bh - h) <= 3, `body straddles cliff ${x},${z}`);
    assert(dry(cell(x + dx, bh - 1, z + dz)), `wet/unsupported route ${x + dx},${z + dz}`);
    head = Math.max(head, bh);
  }
  for (let dx = -3; dx < 3; dx++) for (let dz = -3; dz < 3; dz++) {
    for (let y = head; y < head + 11; y++) assert.equal(cell(x + dx, y, z + dz), E.EMPTY, `body clearance ${x},${y},${z}`);
  }
  visited.add(`${x},${z}`);
  walked++;
  return h;
}
function line(points) {
  let previous;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i];
    const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    for (let k = 0; k <= n; k++) previous = sample(Math.round(ax + (bx - ax) * k / n), Math.round(az + (bz - az) * k / n), previous);
  }
}
for (const r of C.routes) {
  if (r.points) line(r.points);
  else {
    let previous;
    const direction = Math.sign(r.to - r.from);
    for (let x = r.from; x !== r.to + direction; x += direction) previous = sample(x, T[r.curve](x), previous);
  }
}
line(M.runningLoop);
for (const x of [-760, -280, 240, 760]) for (let z = -112; z <= -40; z++) {
  for (let dx = -12; dx <= 12; dx++) {
    assert(T.cfPath(x + dx, z), 'entire 25-cell ramp width protected');
    assert.equal(T.cfHeight(x + dx, z), T.cfHeight(x, z), 'broad ramp has level treads');
  }
}
assert(T.cfPath(-64, 188), 'original dock protected from nature');
for (const [x, z] of M.cottages) assert(T.cfPath(x, z - 14), 'original cottage approach protected');
for (let x = -920; x <= 920; x++) for (const z of [-28, 36]) assert.equal(T.cfHeight(x, z), 24, 'both 552m straights are flat');

// The scenic route graph is actually connected to the circuit, rather than
// isolated lookouts. BFS operates on the published centreline samples.
const queue = ['-920,36'], reached = new Set(queue);
for (let i = 0; i < queue.length; i++) {
  const [x, z] = queue[i].split(',').map(Number);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const key = `${x + dx},${z + dz}`;
    if (visited.has(key) && !reached.has(key)) { reached.add(key); queue.push(key); }
  }
}
assert.equal(reached.size, visited.size, 'all exported scenic branches/shortcuts form one connected graph');
for (const [name, s] of Object.entries(C.sites)) {
  const [x, z] = s.at, [hx, hz] = s.half;
  for (let dz = -hz; dz <= hz; dz++) for (let dx = -hx; dx <= hx; dx++) {
    assert.equal(T.cfHeight(x + dx, z + dz), s.floor, `${name} pad level`);
    assert(dry(cell(x + dx, s.floor - 1, z + dz)), `${name} pad grounded`);
    assert.equal(cell(x + dx, s.floor, z + dz), E.EMPTY, `${name} pad clear`);
  }
  const [ex, ez] = s.entry;
  assert(T.cfPath(ex, ez), `${name} protected entry`);
  assert([...reached].some(key => { const [rx, rz] = key.split(',').map(Number); return Math.abs(rx - ex) <= 12 && Math.abs(rz - ez) <= 12; }), `${name} reachable entry`);
}
for (const b of C.landmarks.bridges) {
  const [x, z] = b.at;
  assert(T.cfRiver(x, z), `bridge crosses a watercourse ${x},${z}`);
  assert(T.cfBridge(x, z));
  assert.equal(cell(x, b.floor - 1, z), E.PLANKS, 'timber deck');
  assert.equal(cell(x, T.cfWater(x, z) - 1, z), E.WATER, 'river under bridge');
  assert(dry(cell(x - 20, T.cfHeight(x - 20, z) - 1, z)), 'west bank connection');
  assert(dry(cell(x + 20, T.cfHeight(x + 20, z) - 1, z)), 'east bank connection');
}
const [ix, iz] = C.landmarks.island;
assert(!T.cfRiver(ix, iz));
assert.equal(cell(ix, 23, iz), E.PLANT, 'dry small river island');
assert(T.cfRiver(T.cfRiverX(iz), iz) && T.cfRiver(T.cfForkX(iz), iz), 'both channels surround island');
assert(reached.has(`${ix},100`), 'island accessible from lower bridge loop');
for (const [x, z] of C.landmarks.ponds) {
  assert(T.cfPond(x, z));
  assert(!T.cfRiver(x, z), 'pond separated from rivers');
  assert.equal(cell(x, 19, z), E.WATER);
  for (const [dx, dz] of [[18, 0], [-18, 0], [0, 18], [0, -18]]) assert.equal(cell(x + dx, 19, z + dz), E.ROCK, 'closed pond banks');
}
// Continuous meanders, fork, mouth, and the vertical sheets at every fall.
for (let z = -132; z <= 176; z++) {
  const x = T.cfRiverX(z);
  assert(T.cfRiver(x, z));
  assert.equal(cell(x, T.cfWater(x, z) - 1, z), E.WATER, 'connected river reach');
  if (z > -132) assert(Math.abs(x - T.cfRiverX(z - 1)) <= 2, 'bounded meander');
  if (z >= 60) assert(T.cfRiver(T.cfForkX(z), z), 'connected fork');
}
assert.equal(C.landmarks.waterfalls.length, 3);
for (const [x, z] of C.landmarks.waterfalls) {
  assert(T.cfWater(x, z) > T.cfWater(T.cfRiverX(z + 2), z + 2), 'waterfall connects upstream/downstream levels');
  for (let y = T.cfBed(x, z); y < T.cfWater(x, z); y++) assert.equal(cell(x, y, z), E.WATER, 'continuous vertical fall sheet');
}
for (const [x, z] of C.landmarks.mouths) assert.equal(cell(x, 15, z), E.WATER, 'river mouth connects sea level');
for (const [x, z] of C.landmarks.coves) assert.equal(T.cfHeight(x, z), 18, 'cove has a dry beach');
for (const [x, z] of C.landmarks.meadows) {
  assert.equal(cell(x, T.cfHeight(x, z) - 1, z), E.PLANT, 'open grassy meadow');
  for (let y = T.cfHeight(x, z); y < 80; y++) assert.equal(cell(x, y, z), E.EMPTY, 'open sky');
}
// Rock-backed sand cannot topple off a lip; grassy banks never touch water.
for (let x = 200; x <= 1232; x += 3) for (let z = -176; z <= 176; z += 2) for (const side of [-1, 1]) {
  const xx = x * side, h = T.cfHeight(xx, z), id = cell(xx, h - 1, z);
  if (id === E.SAND) {
    assert(dry(cell(xx, h - 2, z)), 'supported beach sand');
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert(dry(cell(xx + dx, h - 2, z + dz)), 'rock lip supports every beach edge');
  }
  if (id === E.PLANT) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.notEqual(cell(xx + dx, h - 1, z + dz), E.WATER, 'grass separated from water');
}
const midEdges = new Set(), highEdges = new Set();
for (let x = 300; x <= 850; x++) { midEdges.add(T.cfMidEdge(x)); highEdges.add(T.cfHighEdge(x)); }
assert(midEdges.size > 10 && highEdges.size > 5, 'winding cliffs, not ruler-straight terraces');

// Full old authored region golden. Everywhere outside it was/is uniform sea;
// that region also covers original cottages, furniture sites and door routes.
const legacy = willowCoveTwin(scene.params({ size: scene.legacySize, seed: P.seed }));
// PLANKS counts as WOOD: sawn timber split off later (elements.js TIMBER), same cells, same physics.
const timber = (id) => (id === E.PLANKS ? E.WOOD : id);
const golden = new Uint16Array(401 * 401 * 80);
let i = 0;
for (let z = -200; z <= 200; z++) for (let x = -200; x <= 200; x++) for (let y = 0; y < 80; y++) golden[i++] = timber(legacy.wcCell(x + 512, y, z + 512));
assert.equal(createHash('sha256').update(new Uint8Array(golden.buffer)).digest('hex'), '1fbc36d0ba57628e816eba5c47336d988293c0d93fd5c8c0ea01ea122303bce2', 'EXACT old-save authored geometry');
for (let z = -512; z < 512; z += 19) for (let x = -512; x < 512; x += 17) {
  if (Math.abs(x) <= 200 && Math.abs(z) <= 200) continue;
  for (const y of [0, 3, 4, 15, 16, 24, 47, 79, 80, 127]) assert.equal(legacy.wcCell(x + 512, y, z + 512), y < 4 ? E.ROCK : y < 16 ? E.WATER : E.EMPTY, 'old-save exterior untouched');
}
for (const seed of [0, 1, 17, 0xffffffff]) {
  const twin = willowCoveTwin(scene.params({ size: scene.size, seed }));
  for (let z = -160; z < 176; z += 7) for (let x = -1100; x <= 1100; x += 19) {
    const h = T.cfHeight(x, z);
    for (const y of [h - 1, h, 20, 32, 44]) {
      assert.equal(twin.cfTerrainCell(x, y, z), cell(x, y, z), 'deterministic CPU base terrain');
      assert.equal(T.cfTerrainCell(x, y, z), cell(x, y, z), 'local API uses same generated cells');
    }
  }
}
const wgsl = scene.glsl();
for (const name of ['cfHeight', 'cfTerrainCell', 'cfPath', 'cfRiver', 'cfBridge']) assert.match(wgsl, new RegExp(`fn ${name}\\(`), 'shared-source WGSL API');
assert.doesNotMatch(wgsl, /\basync\b|\bawait\b/);
console.log(`City Folk terrain OK: ${walked} body-width route samples, ${reached.size} connected centreline cells, ${Object.keys(C.sites).length} grounded site pads, ${C.landmarks.bridges.length} bridges, 3 connected waterfalls, separate ponds, island/coves/meadows, 4 seeds, exact legacy golden, CPU/WGSL shared APIs.`);
