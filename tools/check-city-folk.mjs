// CPU-only independent acceptance of the COMPOSED scene. No browser/GPU.
// node --test tools/check-city-folk.mjs (missing requirements FAIL, never skip).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { acceptCityBus } from './check-city-folk-bus-acceptance.mjs';
import { E, ELEMENTS, K } from '../src/elements.js';
import { CELL_M } from '../src/scale.js';
import { WORLD_SIZE } from '../src/shaders/farShared.js';
import { mapByKey, mapsFor, GAMEMODES, DEFAULT_MAP, MOBILE_MAP } from '../src/maps.js';
import { sceneByKey } from '../src/world/scenes/index.js';
import * as willow from '../src/world/scenes/willowCove.js';
import { prepareSave } from '../src/wire/saves.js';
import { HOMES, FLOOR, HOME_Z, HOME_ENTRY, DRESSER, initialState } from '../src/pov/village/state.js';

const scene = willow.willowCove, C = willow.WILLOW_COVE, M = willow.WILLOW_LANDMARKS;
const size = [3072, 128, 1024], seed = 20261008;
const P = scene.params({ size, seed }), twin = willow.willowCoveTwin(P);
const cell = (x, y, z) => twin.wcCell(x + size[0] / 2, y, z + size[2] / 2);
const dry = id => ELEMENTS[id]?.kind === K.SOLID || id === E.SAND;
const key = ([x, z]) => `${x},${z}`;
const records = v => Array.isArray(v) ? v : v ? Object.values(v) : [];
function need(value, name) { assert.ok(value !== undefined && value !== null, `missing required seam: ${name}`); return value; }
function at(p, label = 'point') {
  const v = need(Array.isArray(p) ? p : p?.at, label);
  assert.equal(v.length, 2, `${label}: local [x,z]`); assert(v.every(Number.isInteger), `${label}: integral coordinates`); return v;
}
async function moduleFor(name, symbol) {
  try { return need((await import(`../src/world/scenes/cityFolk/${name}.js`))[symbol], symbol); }
  catch (e) { assert.fail(`${symbol} must be installed and composed: ${e.message}`); }
}
const town = () => moduleFor('town', 'CITY_FOLK_TOWN');
const nature = () => moduleFor('nature', 'CITY_FOLK_NATURE');
const city = () => moduleFor('city', 'CITY_FOLK_CITY');
// Explicit metadata adapters: integration may adapt published names, NOT weaken
// assertions or replace composed geometry with isolated-helper results.
function terrain() {
  const raw = need(willow.CITY_FOLK_TERRAIN, 'willowCove export CITY_FOLK_TERRAIN'), l = need(raw.landmarks, 'terrain.landmarks');
  const rs = need(raw.routes, 'terrain.routes').map(r => {
    if (r.points) return r;
    const curve = need(twin[r.curve], `composed ${r.curve}`), points = [];
    for (let x = r.from; x !== r.to; x += Math.sign(r.to - r.from)) points.push([x, curve(x)]);
    points.push([r.to, curve(r.to)]); return { ...r, points };
  });
  const river = Array.from({ length: 309 }, (_, i) => [need(twin.cfRiverX, 'cfRiverX')(i - 132), i - 132]);
  const fork = Array.from({ length: 117 }, (_, i) => [need(twin.cfForkX, 'cfForkX')(i + 60), i + 60]);
  const ponds = l.ponds.map((p, i) => ({ at: at(p), radius: i ? 11 : 12,
    banks: [[p[0] - 22, p[1]], [p[0] + 22, p[1]], [p[0], p[1] - 22], [p[0], p[1] + 22]] }));
  const island = { at: l.island, water: [[twin.cfRiverX(110), 110], [twin.cfForkX(110), 110], [twin.cfRiverX(60), 60], [l.island[0], 180]] };
  return { routes: [{ name: 'core-access', points: [M.plaza, [C.PATH_X, C.PLAZA_Z], [C.PATH_X, C.LANE_Z]] },
    ...M.cottages.map(([x, z]) => ({ name: `original-door-${x}`, points: [[x, C.LANE_Z], [x, z - C.HOUSE_HALF]] })), ...rs], ramps: rs.filter(r => r.name.startsWith('ramp-')),
    loops: rs.filter(r => r.name.startsWith('lower-loop-')).map(r => [...r.points, r.points[0]]),
    shortcuts: rs.filter(r => r.name.includes('shortcut')), meadows: l.meadows, bridges: [...M.bridges, ...l.bridges],
    cliffs: [-840, -600, 840].map(x => ({ upper: [x, twin.cfHighEdge(x) - 2], lower: [x, twin.cfHighEdge(x) + 2] })),
    water: { river, fork, ponds, island, waterfalls: l.waterfalls, mouths: l.mouths, coves: l.coves, beaches: [[-900, 152], [900, 152]] } };
}
function townMetadata(raw, urban) {
  const l = need(raw.landmarks, 'town.landmarks'), b = need(urban.landmarks.townStop, 'city townStop');
  const approaches = need(l.approaches, 'town.approaches');
  // Published approach endpoints may meet the curved woods path a few cells
  // off its centerline. Sweep the intervening cells rather than infer access.
  const connectors = approaches.filter(r => r.at(-1)[0] > 0 && r.at(-1)[1] === -80)
    .map(r => { const p = r.at(-1); return [p, [p[0], need(twin.cfWoodsZ, 'cfWoodsZ')(p[0])]]; });
  return { ...l, busStop: b, walkways: [...approaches, ...connectors] };
}
function cityMetadata(raw) {
  const l = need(raw.landmarks, 'city.landmarks'), p = need(l.cityArrival, 'cityArrival');
  const shops = ['emporium', 'tailor', 'theatre'].map(n => need(l[n], `city.${n}`));
  return { ...l, arrival: { at: [p[0], p[2]], floor: p[1] }, shops,
    walkways: [[[p[0], p[2]], l.square.at], ...shops.map(r => [l.square.at, [r.entry[0], l.square.at[1]], r.entry])] };
}
function polylines(v, label) {
  const list = records(need(v, label)); assert(list.length > 0, `${label}: nonempty`);
  return list.map((r, i) => {
    const ps = Array.isArray(r) ? r : r.points ?? r.route;
    assert(ps?.length >= 2, `${label}[${i}]: at least two points`); return ps.map(p => at(p, label));
  });
}
function raster(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i], n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    for (let j = 1; j <= n; j++) out.push([Math.round(ax + (bx - ax) * j / n), Math.round(az + (bz - az) * j / n)]);
  }
  return out;
}
const floors = new Map();
function walkTop(x, z) {
  const k = key([x, z]); if (floors.has(k)) return floors.get(k);
  // First dry standable floor, not a roof/tree accepted as a route.
  for (let h = C.FLOOR; h <= size[1] - C.DOOR_H; h++) {
    if (!dry(cell(x, h - 1, z))) continue;
    let clear = true;
    for (let y = h; y < h + C.DOOR_H; y++) if (cell(x, y, z) !== E.EMPTY) { clear = false; break; }
    if (clear) { floors.set(k, h); return h; }
  }
  assert.fail(`no dry floor/headroom at ${x},${z}`);
}
function body(p, label = key(at(p))) {
  const [x, z] = at(p, label), hs = [];
  // Conservative six-cell village envelope, as in existing sprint acceptance.
  for (let dx = -3; dx < 3; dx++) for (let dz = -3; dz < 3; dz++) hs.push(walkTop(x + dx, z + dz));
  const h = Math.max(...hs); assert(h - Math.min(...hs) <= 5, `${label}: body straddles cliff`);
  for (let dx = -3; dx < 3; dx++) for (let dz = -3; dz < 3; dz++)
    for (let y = h; y < h + C.DOOR_H; y++) assert.equal(cell(x + dx, y, z + dz), E.EMPTY, `${label}: body blocked at ${x + dx},${y},${z + dz}`);
  return walkTop(x, z);
}
function route(points, label, protectedPath = true) {
  let last;
  for (const p of raster(points)) {
    const h = body(p, `${label}:${key(p)}`);
    if (last !== undefined) assert(Math.abs(h - last) <= 1, `${label}: non-unit slope at ${key(p)} (${last}->${h})`);
    if (protectedPath) assert(need(twin.cfPath, 'composed twin.cfPath')(...p), `${label}: unprotected ${key(p)}`);
    last = h;
  }
}
function graph(routes) {
  const nodes = new Set(routes.flatMap(r => raster(r).map(key)));
  return { nodes, reachable(start) {
    const open = [key(start)], seen = new Set(open); assert(nodes.has(open[0]), `route graph lacks root ${open[0]}`);
    for (let i = 0; i < open.length; i++) {
      const [x, z] = open[i].split(',').map(Number);
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const k = key([x + dx, z + dz]); if (nodes.has(k) && !seen.has(k)) { seen.add(k); open.push(k); }
      }
    }
    return seen;
  } };
}
function footprint(r, label, structure = true) {
  const [x, z] = at(r, label), [hx, hz] = need(r.half, `${label}.half`), h = need(r.floor, `${label}.floor`), ids = [];
  for (let dz = -hz; dz <= hz; dz++) for (let dx = -hx; dx <= hx; dx++)
    for (let y = h - 1; y < Math.min(h + 32, size[1]); y++) ids.push(cell(x + dx, y, z + dz));
  assert(ids.some(id => id !== E.EMPTY), `${label}: no authored geometry`);
  if (structure) {
    let above = false;
    for (let dx = -hx; dx <= hx && !above; dx++) for (let dz = -hz; dz <= hz && !above; dz++)
      for (let y = h; y < Math.min(h + 32, size[1]); y++) if (cell(x + dx, y, z + dz) !== E.EMPTY) { above = true; break; }
    assert(above, `${label}: missing above-ground structure (terrain alone is not a building)`);
  }
  return createHash('sha256').update(Uint16Array.from(ids)).digest('hex');
}
function entrance(r, label) {
  const p = at(need(r.entry, `${label}.entry`), `${label}.entry`);
  assert.equal(body(p, `${label} entrance`), need(r.floor, `${label}.floor`)); return p;
}

test('I01 identity, aliases, mode availability, world/window sizes and co-op acceptance', () => {
  assert.equal(scene.key, 'willowCove'); assert.equal(scene.label, 'Tinker Creek'); assert.equal(scene.shrine, false);
  assert.deepEqual(scene.size, size); assert.deepEqual(scene.legacySize, [1024, 128, 1024]); assert.deepEqual(WORLD_SIZE, [1024, 128, 1024]);
  const map = mapByKey(scene.key);
  assert.equal(mapByKey('tinkerCreek'), map); assert.equal(mapByKey('willowCove'), map); assert.deepEqual(map.dims, size);
  assert(mapsFor('animalCrossing').includes(map)); assert(mapsFor('sandbox').includes(map));
  for (const m of GAMEMODES.filter(m => !['animalCrossing', 'sandbox'].includes(m.key))) assert(!mapsFor(m.key).includes(map));
  assert.equal(DEFAULT_MAP, 'island'); assert.equal(MOBILE_MAP, 'lab'); assert.equal(sceneByKey(scene.key), scene);
  assert.equal(GAMEMODES.find(m => m.key === 'animalCrossing').effect, 'rollingLog');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function setGrid('), app.indexOf('// The cells of size')); assert(source.length > 100);
  const ctx = { replicaMap: null, win: null, sim: { g: { nx: 128, ny: 128, nz: 128 } }, SIZES: {}, WORLDS: { world: { size: WORLD_SIZE } }, sceneByKey,
    worldOf: (w, s) => ({ ...w, size: s.size ?? w.size }), settings: {}, presentation: { select() {} }, build() {}, gridFits: () => true };
  const setGrid = runInNewContext(`${source}; setGrid`, ctx);
  for (const dims of [scene.legacySize, size]) {
    assert.equal(setGrid([128, 128, 128], { id: `city-folk-${dims[0]}`, mode: 'world', scene: scene.key, size: dims, seed }), true);
    assert.deepEqual([...ctx.replicaMap.size], dims);
  }
  assert.equal(setGrid([128, 64, 128], { id: 'wrong-window', mode: 'world', scene: scene.key, size, seed }), false);
  assert.equal(setGrid([128, 128, 128], { id: 'unsupported', mode: 'world', scene: scene.key, size: [2048, 128, 1024], seed }), false);
});

test('I02 solo saves retain supported geometries, coordinates and reject unknown sizes', async () => {
  const builds = [], makeWorld = dims => ({ size: dims, whenReady: async () => {} });
  const app = { settings: { size: 'world', scene: scene.key }, win: makeWorld(size), worldSeed: seed,
    mp: { guard: () => false, guardWorld: () => false }, pov: { exit() {} }, WORLDS: { world: { size: WORLD_SIZE } }, sceneByKey,
    setSize(k, dims) { builds.push(dims); this.win = makeWorld(dims ?? scene.size); } };
  for (const dims of [scene.legacySize, size]) {
    const h = { size: 'world', world: { scene: scene.key, seed, size: [...dims], origin: [448, 0, 448] } }, before = structuredClone(h);
    assert.equal(await prepareSave(app, h), true); assert.deepEqual(app.win.size, dims); assert.deepEqual(h, before);
    const n = builds.length; assert.equal(await prepareSave(app, h), true); assert.equal(builds.length, n);
  }
  await assert.rejects(prepareSave(app, { size: 'world', world: { scene: scene.key, size: [1024, 256, 1024], seed } }), /different size/);
});

test('I03 exhaustive exact legacy cells against immutable pre-feature generator', async () => {
  const base = '1b43dcc4ae126a92834f12a16637d945d9719fb0';
  let src = execFileSync('git', ['show', `${base}:src/world/scenes/willowCove.js`], { encoding: 'utf8' });
  src = src.replace(/from '(\.\/[^']+)'/g, (_, p) => `from '${new URL(p, new URL('../src/world/scenes/willowCove.js', import.meta.url)).href}'`);
  const old = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  const dims = scene.legacySize, p = scene.params({ size: dims, seed });
  const expected = old.willowCoveTwin(p), actual = willow.willowCoveTwin(p);
  for (let z = 0; z < dims[2]; z++) for (let x = 0; x < dims[0]; x++) for (let y = 0; y < dims[1]; y++) {
    const a = actual.wcCell(x, y, z), b = expected.wcCell(x, y, z);
    if (a !== b) assert.fail(`legacy changed at ${x},${y},${z}: ${b}->${a}`);
  }
});

test('I04 original cottages, doors, furniture coordinates and village behavior', () => {
  assert.deepEqual(HOMES, [-96, -40, 64, 112]); assert.equal(FLOOR, 24); assert.equal(HOME_Z, 60); assert.deepEqual(HOME_ENTRY, { x: 0, z: -9 });
  assert.deepEqual(DRESSER, { id: 'dresser', kind: 'dresser', x: 6, z: 6, rotation: 0 });
  assert.deepEqual(initialState().placed, [
    { id: 'bed', kind: 'bed', x: -6, z: 5, rotation: 0 }, { id: 'table', kind: 'table', x: -6, z: -3, rotation: 0 },
    { id: 'chair', kind: 'chair', x: -6, z: -7, rotation: 0 }, { id: 'lamp', kind: 'lamp', x: 7, z: -6, rotation: 0 },
  ]);
  for (const x of HOMES) {
    for (let dx = -4; dx < 4; dx++) for (let dz = -12; dz < -10; dz++) for (let y = 24; y < 35; y++) assert.equal(cell(x + dx, y, HOME_Z + dz), E.EMPTY);
    assert.equal(cell(x - 12, 24, HOME_Z), E.WOOD); assert.equal(cell(x - 12, 28, HOME_Z), E.GLASS);
    entrance({ entry: [x, HOME_Z - 11], floor: 24 }, `original cottage ${x}`);
  }
  assert.match(execFileSync(process.execPath, ['tools/check-village-interactions.mjs'], { encoding: 'utf8' }), /OK|pass/i);
});

test('F06 flat dry body-clear 552m straights and entire closed 1.14km sprint circuit', () => {
  assert.equal(C.RUN_HALF * 2 * CELL_M, 552); const loop = M.runningLoop; assert.deepEqual(loop[0], loop.at(-1));
  const n = loop.slice(1).reduce((n, p, i) => n + Math.abs(p[0] - loop[i][0]) + Math.abs(p[1] - loop[i][1]), 0);
  assert.equal(n, 3808); assert(Math.abs(n * CELL_M - 1142.4) < 1e-8); route(loop, 'existing closed sprint circuit', false);
  for (let x = -920; x <= 920; x++) for (const z of [36, -28]) {
    assert.equal(body([x, z]), 24);
    for (let dx = -3; dx < 3; dx++) for (let dz = -3; dz < 3; dz++) assert.equal(walkTop(x + dx, z + dz), 24, 'flat across full body width');
  }
});

test('F01/F05/F07/F08 ramps, scenic branches, meadows, loops and shortcuts form one accessible network', () => {
  const t = terrain(), scenic = polylines(t.routes, 'terrain.routes'), ramps = polylines(t.ramps, 'terrain.ramps');
  assert(scenic.length >= 3, 'woods, riverside and cliff branches'); assert(ramps.length >= 2, 'upper and lower broad ramps');
  const loops = polylines(t.loops, 'terrain.loops'); assert(loops.length >= 2); loops.forEach(l => assert.deepEqual(l[0], l.at(-1)));
  const shortcuts = polylines(t.shortcuts, 'terrain.shortcuts'); assert(shortcuts.length >= 2);
  const paths = [M.runningLoop, ...scenic, ...ramps, ...loops, ...shortcuts]; paths.forEach((p, i) => route(p, `route ${i}`));
  for (const ramp of ramps) for (const [x, z] of raster(ramp)) {
    const h = walkTop(x, z);
    if (h > 24 && h < 48 && h !== 36) for (const dx of [-8, -4, 4, 8])
      assert.equal(body([x + dx, z], 'broad ramp tread'), h, 'rise remains level across a broad 22-cell usable tread');
  }
  const g = graph(paths); assert.equal(g.reachable(M.plaza).size, g.nodes.size, 'every route connected to spawn');
  const meadows = records(need(t.meadows, 'terrain.meadows')); assert(meadows.length >= 2);
  for (const m of meadows) {
    const [x, z] = at(m, 'meadow');
    for (let dx = -12; dx <= 12; dx += 3) for (let dz = -12; dz <= 12; dz += 3) body([x + dx, z + dz], 'open meadow');
  }
  const cliffs = records(need(t.cliffs, 'terrain.cliffs')); assert(cliffs.length >= 3); const zs = new Set();
  for (const cliff of cliffs) {
    const a = at(need(cliff.upper, 'cliff.upper')), b = at(need(cliff.lower, 'cliff.lower'));
    assert(twin.wcHeight(...a) - twin.wcHeight(...b) >= 6, 'physical cliff elevation'); zs.add(a[1]);
  }
  assert(zs.size >= 2, 'cliff edge winds, not one straight z');
});

test('F07 wooded, cliffside and longitudinal riverside branches have actual composed scenic context', () => {
  const routes = terrain().routes;
  const woods = routes.filter(r => r.name.includes('woods')), cliffs = routes.filter(r => r.name.includes('cliff'));
  const rivers = routes.filter(r => /river|riverside/.test(r.name));
  assert(woods.length && cliffs.length && rivers.length, 'publish woods/cliff/riverside branches, not just bridge crossings');
  const hasWood = p => {
    const [x, z] = p, h = twin.wcHeight(x, z);
    for (let dx = -24; dx <= 24; dx += 4) for (let dz = -24; dz <= 24; dz += 4)
      for (let y = h + 2; y < h + 28; y += 2) if (cell(x + dx, y, z + dz) === E.WOOD) return true;
    return false;
  };
  woods.forEach(r => assert(raster(r.points).filter((_, i) => i % 32 === 0).some(hasWood), `${r.name}: no nearby composed trees`));
  cliffs.forEach(r => assert(raster(r.points).some(([x, z]) => twin.wcHeight(x, z - 8) - twin.wcHeight(x, z + 28) >= 6), `${r.name}: no nearby physical cliff`));
  for (const r of rivers) {
    const ps = raster(r.points), zs = ps.map(p => p[1]); assert(Math.max(...zs) - Math.min(...zs) >= 24, 'river branch follows a reach, not merely crosses it');
    let near = 0;
    for (const [x, z] of ps) {
      let wet = false;
      for (let dx = -24; dx <= 24 && !wet; dx++) for (let y = 12; y < 48; y++) if (cell(x + dx, y, z) === E.WATER) { wet = true; break; }
      if (wet) near++;
    }
    assert(near >= 24, `${r.name}: branch is beside actual water`); route(r.points, r.name);
  }
});

test('F02/F03/F04 connected meander/fork/falls, river island, separate ponds, beach coves and mouths', () => {
  const w = need(terrain().water, 'terrain.water'), river = need(w.river, 'water.river').map(p => at(p)), fork = need(w.fork, 'water.fork').map(p => at(p));
  assert(river.length >= 3 && fork.length >= 3); assert(new Set(river.map(p => p[0])).size >= 3, 'river meanders');
  const wet = (p, label, bed = true) => {
    const [x, z] = at(p, label), ys = [];
    for (let y = C.FLOOR; y < 64; y++) if (cell(x, y, z) === E.WATER) ys.push(y);
    assert(ys.length, `${label}: no composed water at ${key(p)}`); if (bed) assert(dry(cell(x, ys[0] - 1, z)), `${label}: solid bed`); return ys;
  };
  const reaches = [raster(river), raster(fork)];
  for (const [i, reach] of reaches.entries()) {
    let prev;
    for (const p of reach) {
      const ys = wet(p, `water reach ${i}`);
      if (prev) assert(ys.some(y => prev.some(py => Math.abs(y - py) <= 1)), `water disconnected at ${key(p)}`); prev = ys;
    }
  }
  assert(reaches[0].some(a => reaches[1].some(b => key(a) === key(b))), 'fork joins main river');
  const island = need(w.island, 'water.island'), center = at(island); body(center, 'dry island');
  const ring = need(island.water, 'island.water'); assert(ring.length >= 4); ring.forEach(p => wet(p, 'island perimeter', false));
  assert(ring.some(p => p[0] < center[0]) && ring.some(p => p[0] > center[0]) && ring.some(p => p[1] < center[1]) && ring.some(p => p[1] > center[1]));
  // Geographic dry land, not bridge decks: a column with water below a deck is
  // still a river boundary. Flood-fill must close before any bounding edge.
  const minX = Math.min(...river.map(p => p[0])) - 24, maxX = Math.max(...fork.map(p => p[0])) + 24;
  const minZ = 50, maxZ = 190, mask = new Map();
  const land = ([x, z]) => {
    const k = key([x, z]); if (mask.has(k)) return mask.get(k);
    let dryColumn = true;
    for (let y = C.FLOOR; y < 60; y++) if (cell(x, y, z) === E.WATER) { dryColumn = false; break; }
    mask.set(k, dryColumn); return dryColumn;
  };
  assert(land(center), 'island sample is geographic land, not merely a bridge');
  const queue = [center], seen = new Set([key(center)]);
  for (let i = 0; i < queue.length; i++) {
    const [x, z] = queue[i]; assert(x > minX && x < maxX && z > minZ && z < maxZ, 'claimed island connects to mainland/bounding edge');
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const p = [x + dx, z + dz], k = key(p); if (!seen.has(k) && land(p)) { seen.add(k); queue.push(p); }
    }
  }
  assert(seen.size >= 36 && seen.size < 10000, 'bounded small physical river island');
  const ponds = records(need(w.ponds, 'water.ponds')); assert(ponds.length >= 2);
  for (const pond of ponds) {
    const p = at(pond); wet(p, 'pond'); const banks = need(pond.banks, 'pond.banks'); assert(banks.length >= 4); banks.forEach(b => body(at(b), 'pond clearing'));
    const radius = need(pond.radius, 'pond.radius'); assert(radius > 0 && radius <= 32);
    assert(reaches.every(r => r.every(q => Math.hypot(q[0] - p[0], q[1] - p[1]) > radius)), 'pond separate from river');
    const open = [p], visited = new Set([key(p)]);
    for (let i = 0; i < open.length; i++) {
      const [x, z] = open[i]; assert(Math.hypot(x - p[0], z - p[1]) <= radius + 2, 'pond water leaks outside its isolated small basin');
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const q = [x + dx, z + dz], k = key(q); if (visited.has(k)) continue;
        visited.add(k); if (!land(q)) open.push(q);
      }
    }
  }
  const falls = records(need(w.waterfalls, 'water.waterfalls')); assert(falls.length >= 2); falls.forEach(f => assert(wet(f, 'fall').length >= 8));
  const mouths = records(need(w.mouths, 'water.mouths')); assert(mouths.length >= 2); mouths.forEach(p => { assert(at(p)[1] > 120); wet(p, 'south mouth', false); });
  const beaches = records(need(w.beaches, 'water.beaches')); assert(beaches.length >= 2);
  beaches.forEach(p => { const [x, z] = at(p); assert(z > 120); assert.equal(cell(x, walkTop(x, z) - 1, z), E.SAND); body(p, 'dry beach'); });
  const coves = records(need(w.coves, 'water.coves')); assert(coves.length >= 2);
  const shore = x => {
    let last = 120;
    for (let z = 120; z < 192; z++) if (dry(cell(x, 17, z))) last = z;
    return last;
  };
  coves.forEach(p => { const [x, z] = at(p); assert(z >= 140); assert(shore(x) + 3 < Math.max(shore(x - 80), shore(x + 80)), 'physical cove indents southern coastline'); });
  const bridges = records(need(terrain().bridges, 'terrain.bridges')); assert(bridges.length > M.bridges.length);
  bridges.forEach(b => { const p = at(b), h = body(p, 'bridge'); assert.equal(cell(p[0], h - 1, p[1]), E.WOOD); });
});

test('F13-F18 all town identities, entrances, new homes and plots compose and connect to plaza', async () => {
  const l = townMetadata(await town(), await city()), hashes = new Map(), doors = [];
  for (const name of ['townHall', 'eventSquare', 'bulletinBoard', 'nookShop', 'ableShop', 'museum', 'cafe', 'gate', 'busStop']) {
    const r = need(l[name], `town.${name}`);
    if (['townHall', 'nookShop', 'ableShop', 'museum', 'cafe', 'gate'].includes(name)) doors.push(entrance(r, name));
    else body(at(r.entry ?? r), name);
    hashes.set(name, footprint(r, name, name !== 'eventSquare'));
  }
  assert.notEqual(hashes.get('nookShop'), hashes.get('ableShop'), 'distinct shop geometry'); assert.notEqual(hashes.get('museum'), hashes.get('townHall'));
  const cottages = records(need(l.cottages, 'town.cottages')); assert(cottages.length >= 4);
  assert(cottages.some(r => r.floor === 48) && cottages.some(r => r.floor === 24));
  cottages.forEach((r, i) => { doors.push(entrance(r, `new cottage ${i}`)); footprint(r, `new cottage ${i}`); });
  const plots = records(need(l.plots, 'town.plots')); assert(plots.length >= 2); plots.forEach(r => {
    const p = at(r); assert.equal(body(p, 'vacant plot'), r.floor); assert.equal(cell(p[0], r.floor - 1, p[1]), E.BRICK);
    footprint(r, 'vacant plot survey stakes'); doors.push(entrance(r, 'vacant plot'));
  });
  const access = polylines(l.walkways, 'town.walkways'); access.forEach((r, i) => route(r, `town walkway ${i}`));
  const g = graph([M.runningLoop, ...polylines(terrain().routes, 'terrain.routes'), ...polylines(terrain().ramps, 'terrain.ramps'), ...access]), reachable = g.reachable(M.plaza);
  doors.forEach(p => assert(reachable.has(key(p)), `entrance disconnected from plaza: ${key(p)}`));
  for (const name of ['eventSquare', 'busStop']) assert(reachable.has(key(at(l[name].entry ?? l[name]))), `${name} disconnected`);
  entrance({ entry: l.cafe.museumDoor, floor: l.cafe.floor }, 'cafe/museum adjoining doorway');
});

test('F09-F12 distinct composed nature, worn ground, buried discoveries and exclusion zones', async () => {
  const n = await nature(), l = need(n.landmarks, 'nature.landmarks'), shapes = new Map();
  for (const [type, name] of [['cedars', 'cedarWoods'], ['hardwoods', 'hardwoodGrove'], ['fruitTrees', 'nativeOrchard'], ['palms', 'beachPalms']]) {
    const r = need(l[name], `nature.${name}`), [cx, cz] = at(r), [hx, hz] = need(r.half, `${name}.half`), roots = [];
    const zs = type === 'palms' ? [cz] : Array.from({ length: hz * 2 + 1 }, (_, i) => cz - hz + i).filter(z => ((z - 16) % 32 + 32) % 32 === 0);
    for (let x = cx - hx; x <= cx + hx; x++) if (((x - 16) % 32 + 32) % 32 === 0) for (const z of zs) {
      const h = twin.wcHeight(x, z);
      if (type === 'fruitTrees' && (x < n.ints.ORCHARD_WEST || x > n.ints.ORCHARD_EAST)) continue;
      if (cell(x, h + 2, z) === E.WOOD) roots.push([x, z]);
    }
    assert(roots.length >= 2, `${name}: multiple real trees in the declared region`);
    if (type === 'cedars') assert(roots.filter(p => twin.wcHeight(...p) === 48).length >= 2, 'cedars actually occupy the upper neighborhood');
    for (const [i, [x, z]] of roots.entries()) {
      const h = twin.wcHeight(x, z); assert(!need(twin.cfPath, 'cfPath')(x, z) && !need(twin.cfTownReserved, 'cfTownReserved')(x, z));
      let wood = 0, leaves = 0, fruit = 0;
      for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) for (let y = h; y <= h + 30; y++) {
        const id = cell(x + dx, y, z + dz);
        if (id === E.WOOD) wood++; if ([E.PLANT, E.MOSS].includes(id) && y >= h + 6) leaves++; if (id === E.BRICK && y > h + 10) fruit++;
      }
      assert(wood > 0 && leaves > 0, `${type}: composed trunk/canopy missing`); if (i === 0) shapes.set(type, `${wood}/${leaves}`);
      if (type === 'cedars') assert(h >= 36); if (type === 'hardwoods') assert(h === 24); if (type === 'palms') assert(z >= 120);
      if (type === 'fruitTrees') assert(fruit > 0, 'native apple clusters actually present, not just renamed hardwoods');
    }
  }
  assert.notEqual(shapes.get('cedars'), shapes.get('hardwoods')); assert.notEqual(shapes.get('palms'), shapes.get('hardwoods'));
  for (const [name, material, offset] of [['flowerPatch', E.CERAMIC, 1], ['rocks', E.ROCK, 1], ['shells', E.CERAMIC, 0], ['discovery', E.LIMESTONE, -2], ['wornGround', E.SANDSTONE, -1]]) {
    const r = need(l[name], `nature.${name}`), [x, z] = at(r), h = twin.wcHeight(x, z);
    assert.equal(cell(x, h + offset, z), material, `${name}: actual authored landmark missing from composition`);
    if (name === 'discovery') assert(offset < 0, 'discovery is buried');
  }
  const t = terrain(), tl = townMetadata(await town(), await city());
  const routes = [M.runningLoop, ...polylines(t.routes, 'routes'), ...polylines(t.ramps, 'ramps'), ...polylines(t.loops, 'loops'), ...polylines(t.shortcuts, 'shortcuts'), ...polylines(tl.walkways, 'walkways')];
  routes.forEach((r, i) => route(r, `nature-excluded route ${i}`));
  Object.values(tl).flat().filter(r => r?.entry).forEach(r => entrance(r, 'nature-excluded entrance'));
  for (const r of tl.reservedFootprints) for (let x = r.min[0]; x <= r.max[0]; x += 3) for (let z = r.min[1]; z <= r.max[1]; z += 3) {
    const h = twin.wcHeight(x, z); assert(twin.cfTownReserved(x, z), 'every town footprint reserved');
    for (let y = h - 3; y <= h + 30; y++) for (const id of [E.EMPTY, E.BRICK])
      assert.equal(twin.cfNatureCell(x, y, z, h, id), id, 'nature must return incoming matter throughout town reservation');
  }
});

test('F19 separate city square, distinct facades and independently connected city entrances', async () => {
  const l = cityMetadata(await city()), square = need(l.square, 'city.square'), arrival = need(l.arrival, 'city.arrival');
  const [x, z] = at(square); assert(x >= -160 && x <= 160 && z >= -440 && z <= -280, 'separate agreed city district');
  body(at(square), 'city square'); body(at(arrival), 'city arrival');
  const shops = records(need(l.shops, 'city.shops')); assert(shops.length >= 3);
  const hashes = shops.map((r, i) => footprint(r, `city facade ${i}`)); assert.equal(new Set(hashes).size, hashes.length);
  const routes = polylines(l.walkways, 'city.walkways'); routes.forEach((r, i) => route(r, `city walkway ${i}`, false));
  const reachable = graph(routes).reachable(at(arrival)); assert(reachable.has(key(at(square))), 'arrival connects to square');
  shops.forEach((r, i) => assert(reachable.has(key(entrance(r, `city facade ${i}`))), `city entrance ${i} disconnected`));
});

test('F19/I06 bus arrival, cancellation, roundtrip, edit preservation and other-mode isolation', { timeout: 5000 }, async () => {
  await acceptCityBus({ scene, twin, size, seed });
});

test('I05 deterministic bounded generation, CPU ground and shared streaming/far-field source', () => {
  const edges = [-1, 0, 1, 127, 128, 255, 256, 511, 512, 1023, 1024, 1535, 1536, 2047, 2048, 3071, 3072];
  for (const s of [0, 1, seed, 0xffffffff]) {
    const p = scene.params({ size, seed: s }), a = willow.willowCoveTwin(p), b = willow.willowCoveTwin(structuredClone(p));
    for (const x of edges) for (const z of edges) for (const y of [-1, 0, 15, 23, 35, 47, 79, 127, 128]) {
      const id = a.wcCell(x, y, z); assert(Number.isInteger(id) && ELEMENTS[id]); assert.equal(id, b.wcCell(x, y, z));
      if (x < 0 || z < 0 || y < 0 || x >= size[0] || z >= size[2] || y >= size[1]) assert.equal(id, E.EMPTY);
    }
    for (let i = 0; i < 3000; i++) {
      const x = i * 97 % size[0], z = i * 193 % size[2]; let top = 0;
      for (let y = size[1] - 1; y >= 0; y--) if (a.wcCell(x, y, z) !== E.EMPTY) { top = y + 1; break; }
      assert.equal(scene.ground(x, z, p), top);
    }
  }
  const wgsl = scene.glsl();
  for (const fn of ['wcCell', 'cfPath', 'cfTerrainCell', 'cfNatureCell', 'cfTownCell', 'cfCityCell']) {
    assert.equal(typeof need(twin[fn], `composed twin.${fn}`), 'function'); assert.match(wgsl, new RegExp(`fn ${fn}\\(`));
  }
  const reflected = new WgslReflect(wgsl);
  assert(reflected.functions.some(f => f.name === 'sceneCell'), 'CPU WGSL parser sees composed scene entry');
});
