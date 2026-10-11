// TPT's editing tools on the CPU (no GPU, no browser): src/editing.js's PROP
// parsing, the line and box geometry against a JS mirror of the paint pass's
// shape test (shaders/passes.js paintFrag), and the flood fill's region and
// mask on a made-up grid read through the real atlas layout (sim.js cellTexel).
// usage: node tools/editing-check.mjs
import { gridLayout, cellTexel } from '../src/sim.js';
import { E, ELEMENTS } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import * as THREE from 'three';
import {
  PROP, PROP_FIELDS, parseProp, parseElement, propRangeError, boxFromCorners, strokeDabs, RAY_DABS_MAX,
  floodRegion, regionMask, MASK_ON, FLOOD_MAX_CELLS, oneShotRate, runFill,
} from '../src/editing.js';

let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.log(`FAIL ${what}`); } else console.log(`ok   ${what}`); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- PROP ----
check(PROP_FIELDS.length === 8 && PROP.TYPE === 0 && PROP.PRESSURE === 7, 'eight properties, type first, pressure last');
for (const t of ['water', 'WATR', 'Water', 'WATER', String(E.WATER)]) {
  const r = parseProp(PROP.TYPE, t);
  check(r.ok && r.value === E.WATER && r.shown === 'Water', `type "${t}" is water`);
}
check(parseElement('liquid nitrogen') === E.LIQUID_NITROGEN && parseElement('ln2') === E.LIQUID_NITROGEN, 'names with spaces and abbreviations');
check(!parseProp(PROP.TYPE, 'unobtainium').ok, 'an unknown element is refused');
check(!parseProp(PROP.TYPE, String(ELEMENTS.length)).ok, 'an id past the last element is refused');
check(parseProp(PROP.TYPE, 'air').value === E.EMPTY, 'type AIR (erases, as TPT\'s NONE kills)');
check(parseProp(PROP.CTYPE, 'stne').value === E.STONE, 'ctype by abbreviation');
check(parseProp(PROP.CTYPE, '300').value === 300, 'ctype as a number');
check(!parseProp(PROP.CTYPE, '5000').ok && !parseProp(PROP.CTYPE, '1.5').ok, 'ctype past the max, or fractional, is refused');
check(parseProp(PROP.TEMP, '500').value === 500, 'temperature in °C by default');
check(near(parseProp(PROP.TEMP, '300K').value, 26.85, 1e-9), 'temperature in kelvin (TPT StringToTemperature)');
check(near(parseProp(PROP.TEMP, '212 F').value, 100, 1e-9), 'temperature in Fahrenheit');
check(parseProp(PROP.TEMP, '-40°C').value === -40, 'a °C suffix');
check(!parseProp(PROP.TEMP, '-300').ok && !parseProp(PROP.TEMP, '1e5').ok, 'temperatures past the sim\'s range are refused');
check(parseProp(PROP.LIFE, '120').value === 120 && !parseProp(PROP.LIFE, 'abc').ok, 'life is a number');
check(parseProp(PROP.VY, '-0.5').value === -0.5 && !parseProp(PROP.VX, '2').ok, `velocity within ±${PHYS.V_MAX}`);
check(parseProp(PROP.PRESSURE, '150').ok && !parseProp(PROP.PRESSURE, '300').ok && !parseProp(PROP.PRESSURE, '-60').ok, 'pressure within its range');
check(!parseProp(PROP.TEMP, '').ok && !parseProp(PROP.TEMP, '  ').ok, 'an empty value is refused');
check(propRangeError(PROP.TEMP, 20) === null && propRangeError(PROP.VX, Infinity) !== null && propRangeError(99, 1) !== null, 'the host\'s range check');

// ---- line and box: the paint pass's shape test (passes.js paintFrag), mirrored ----
function inBrush([x, y, z], { center, end = center, grow = [0, 0, 0], radius, shape }) {
  let d = [x + 0.5 - center.x, y + 0.5 - center.y, z + 0.5 - center.z];
  const s = [end.x - center.x, end.y - center.y, end.z - center.z];
  const ss = s[0] * s[0] + s[1] * s[1] + s[2] * s[2];
  const t = Math.min(Math.max((d[0] * s[0] + d[1] * s[1] + d[2] * s[2]) / Math.max(ss, 1e-6), 0), 1);
  d = d.map((v, k) => Math.max(Math.abs(v - s[k] * t) - grow[k], 0));
  const r = shape === 0 ? Math.hypot(...d) : Math.max(...d);
  return r <= radius;
}
const cellsIn = (brush, n = 40) => {
  const out = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) if (inBrush([x, y, z], brush)) out.push([x, y, z]);
  return out;
};
{
  const b = boxFromCorners({ x: 10.3, y: 6, z: 20.7 }, { x: 14.9, y: 6, z: 18.2 }, 3, [40, 40, 40]);
  check(b.lo.join() === '10,3,18' && b.hi.join() === '15,9,21', `box corners → cells [${b.lo}]..[${b.hi})`);
  const cells = cellsIn({ center: b.center, grow: b.grow, radius: 3, shape: 1 });
  const inside = (c) => c.every((v, k) => v >= b.lo[k] && v < b.hi[k]);
  check(cells.length === 5 * 6 * 3 && cells.every(inside), `box fills exactly its cells (${cells.length})`);
  const thin = boxFromCorners({ x: 5.5, y: 2, z: 5.5 }, { x: 5.5, y: 2, z: 5.5 }, 2, [40, 40, 40]);
  check(cellsIn({ center: thin.center, grow: thin.grow, radius: 2, shape: 1 }).length === 1 * 4 * 1, 'a click-sized box: one column, brush-tall');
  const clipped = boxFromCorners({ x: 1, y: 1, z: 1 }, { x: 50, y: 1, z: 3 }, 4, [40, 40, 40]);
  check(clipped.lo.join() === '1,0,1' && clipped.hi.join() === '40,5,4', 'a box is clipped to the grid');
}
{
  const dab = { center: { x: 20, y: 20, z: 20 }, radius: 4, shape: 0 };
  const old = cellsIn(dab).length;
  const sphere = (() => { let n = 0; for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) for (let z = 0; z < 40; z++) if (Math.hypot(x + 0.5 - 20, y + 0.5 - 20, z + 0.5 - 20) <= 4) n++; return n; })();
  check(old === sphere, `a dab is the old sphere (${old} cells)`);
  const cube = cellsIn({ ...dab, shape: 1 }).length;
  check(cube === 8 * 8 * 8, `a dab is the old cube (${cube} cells)`);
  const line = { center: { x: 5, y: 10, z: 10 }, end: { x: 30, y: 10, z: 22 }, radius: 2, shape: 0 };
  const cells = cellsIn(line);
  const segDist = ([x, y, z]) => {
    const p = [x + 0.5, y + 0.5, z + 0.5], a = [5, 10, 10], s = [25, 0, 12];
    const t = Math.min(Math.max(((p[0] - a[0]) * s[0] + (p[2] - a[2]) * s[2]) / (s[0] ** 2 + s[2] ** 2), 0), 1);
    return Math.hypot(p[0] - a[0] - s[0] * t, p[1] - a[1], p[2] - a[2] - s[2] * t);
  };
  check(cells.length > 0 && cells.every((c) => segDist(c) <= 2), `a line is the brush swept along it (${cells.length} cells)`);
  check(inBrush([5, 10, 10], line) && inBrush([29, 10, 21], line) && !inBrush([5, 10, 22], line), 'it reaches both ends and nothing off it');
}
check(strokeDabs({ x: 0, y: 0, z: 0 }).length === 1, 'particle tools: a dab is one dab');
check(strokeDabs({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, undefined, 2).length === 6, 'particle tools: a line is a dab every radius');
check(strokeDabs({ x: 0, y: 0, z: 0 }, undefined, [100, 0, 100], 1).length === RAY_DABS_MAX, 'particle tools: a box\'s dabs are capped');
check(oneShotRate(E.SAND, 1) * ELEMENTS[E.SAND].spawn >= 1 && oneShotRate(-2, 0.5) === 0.5, 'one-shot strokes spawn every cell; tools keep their rate');

// ---- flood fill ----
{
  const [nx, ny, nz] = [32, 16, 32];
  const g = gridLayout(nx, ny, nz);
  const texel = (x, y, z) => cellTexel(g, x, y, z);
  const a = new Float32Array(g.width * g.height * 4);
  const set = (x, y, z, id) => { a[texel(x, y, z) * 4] = id; };
  // a WALL bowl: floor at y = 0 and walls 6 high round x, z in [4, 12), open on top; a SAND block elsewhere
  for (let x = 4; x < 12; x++) for (let z = 4; z < 12; z++) for (let y = 0; y < 6; y++) {
    if (y === 0 || x === 4 || x === 11 || z === 4 || z === 11) set(x, y, z, E.WALL);
  }
  for (let x = 20; x < 24; x++) for (let y = 0; y < 3; y++) for (let z = 20; z < 25; z++) set(x, y, z, E.SAND);
  const inner = 6 * 6;   // the bowl's inside per layer
  const water = floodRegion(a, g, texel, [7, 1, 7], { id: E.EMPTY, maxY: 3 });
  check(!water.error && water.cells.length === inner * 3, `an element fill fills the bowl up to its level (${water.cells?.length} = ${inner * 3})`);
  const brim = floodRegion(a, g, texel, [7, 1, 7], { id: E.EMPTY, maxY: 5 });
  check(!brim.error && brim.cells.length === inner * 5, 'to the brim');
  const over = floodRegion(a, g, texel, [7, 1, 7], { id: E.EMPTY, maxY: 6 });
  const air = nx * nz * 7 - 8 * 8 * 6 + inner * 5 - 4 * 5 * 3;   // over the rim it joins the room's air up to y = 6
  check(!over.error && over.cells.length === air, `past the rim it runs out into the room (${over.cells?.length} = ${air})`);
  check(floodRegion(a, g, texel, [7, 1, 7], { id: E.EMPTY, maxY: 6, cap: 1000 }).error === 'cap', 'a region over the cap is refused');
  check(floodRegion(a, g, texel, [7, 1, 7], { id: E.EMPTY, maxY: 6, openSides: true }).error === 'edge', 'in a World window, reaching the edge is refused');
  check(floodRegion(a, g, texel, [7, 1, 7], { id: E.EMPTY, maxY: 3, openSides: true }).cells?.length === inner * 3, 'a closed bowl in a World window still fills');
  const sand = floodRegion(a, g, texel, [21, 1, 22], { id: E.SAND });
  check(!sand.error && sand.cells.length === 4 * 3 * 5 && sand.lo.join() === '20,0,20' && sand.hi.join() === '23,2,24', 'erase or PROP: the clicked element\'s connected cells, with their box');
  check(floodRegion(a, g, texel, [21, 1, 22], { id: E.WATER }).error === 'start', 'a start cell that changed is refused');
  check(floodRegion(a, g, texel, [7, 1, 7], { id: E.EMPTY, maxY: 0 }).error === 'start', 'a start above the level is refused');
  const m = regionMask(g, texel, sand.cells);
  const marked = m.data.reduce((n, v) => n + (v === MASK_ON), 0);
  check(m.count === 60 && marked === 60 && m.data[texel(20, 0, 20)] === MASK_ON && m.data[texel(19, 0, 20)] === 0, 'the mask marks exactly the region\'s texels');
  const moved = regionMask(g, texel, sand.cells, [-21, 0]);
  check(moved.count === 3 * 3 * 5 && moved.lo.join() === '0,0,20' && moved.data[texel(0, 0, 20)] === MASK_ON && moved.data[texel(3, 0, 20)] === 0, 'a moved window shifts the mask and drops what left it');
  check(FLOOD_MAX_CELLS === 64 ** 3, 'the cap is a 64³ cube');

  // runFill against a stand-in simulation: the readback, the region, the pass it asks for
  const fake = (shiftBy = null) => {
    const sim = {
      g, origin: new THREE.Vector3(), disposed: false, painted: [], snapshots: 0,
      cellTexel: (x, y, z) => cellTexel(g, x, y, z),
      readStateAAsync: async () => { if (shiftBy) sim.origin.x += shiftBy; return a; },
      paint(stroke) { sim.painted.push({ ...stroke, data: stroke.mask.texture.image.data.slice() }); },
    };
    return sim;
  };
  const stroke = { radius: 3, shape: 0, tool: E.WATER, rate: 4, replace: false, erase: false, prop: null };
  const sim = fake();
  const r = await runFill(sim, { cell: [7, 1, 7], id: E.EMPTY, maxY: 3, stroke }, { before: () => sim.snapshots++ });
  const p0 = sim.painted[0];
  check(r.count === inner * 3 && sim.snapshots === 1 && sim.painted.length === 1, 'runFill: one snapshot, one pass, the region\'s count');
  check(p0.filter === E.EMPTY && p0.tool === E.WATER && p0.mask.lo.join() === '5,1,5' && p0.mask.hi.join() === '10,3,10', 'runFill: filtered to the region\'s element, touching only its box');
  check(p0.data[texel(7, 2, 7)] === MASK_ON && p0.data[texel(7, 4, 7)] === 0 && p0.data[texel(4, 2, 7)] === 0, 'runFill: the mask holds the bowl to its level');
  const shifted = fake(8);
  const rm = await runFill(shifted, { cell: [7, 1, 7], id: E.EMPTY, maxY: 3, stroke });
  check(rm.count === 3 * 6 * 3 && shifted.painted[0].data[texel(0, 2, 7)] === MASK_ON && shifted.painted[0].data[texel(7, 2, 7)] === 0 && shifted.painted[0].mask.lo[0] === 0,
    'runFill: a window that moved during the read shifts the region with it');
  const gone = fake();
  gone.readStateAAsync = async () => { gone.disposed = true; return a; };
  check((await runFill(gone, { cell: [7, 1, 7], id: E.EMPTY, maxY: 3, stroke })).error === 'gone' && !gone.painted.length, 'runFill: a simulation replaced during the read is left alone');
  const big = fake();
  check((await runFill(big, { cell: [7, 1, 7], id: E.EMPTY, maxY: 6, stroke }, { openSides: true })).error === 'edge' && !big.painted.length, 'runFill: a refused region paints nothing');
}

console.log(failed ? `\n${failed} FAILED` : '\nall editing checks passed');
process.exit(failed ? 1 : 0);
