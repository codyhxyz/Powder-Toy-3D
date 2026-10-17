// CPU-only R14 witness for jets on column runs (src/shaders/v2/jets.js, columns.js colPour/colMarkJet).
// The pour, the launch head and the marks are the emitted col* bodies executed by tools/v2/column-wgsl.mjs;
// the spawn's custody is checked against an independent BigInt oracle on the production format helpers,
// and its WGSL is pinned where the twin cannot execute it (deterministic ranks, refusal, the allocator).
// Flight is the prototype's R4 in the twin, not the dynamics module. No GPU, browser or World variant.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { E, ELEMENTS, K } from '../../src/elements.js';
import * as L from '../../src/v2/layout.js';
import { gridLayout } from '../../src/sim.js';
import { COLUMN } from '../../src/shaders/v2/columns.js';
import { jetsWGSL, JET_STAGES } from '../../src/shaders/v2/jets.js';
import { ColumnGrid } from './column-wgsl.mjs';
import { assertNaga } from './wgsl-grouping.mjs';

const G_MS2 = COLUMN.G_MS2, CELL_M = COLUMN.CELL_M;
const liquids = ELEMENTS.filter(e => e.kind === K.LIQUID).map(e => e.id);

// a cell marked as colMarkJet leaves it: its lanes the launch velocity and JET_MARK, its brick listed
function marked(w, x, y, z, id, opts, v = [3, 0]) {
  w.set(x, y, z, id, opts);
  w.ctx.colMarkJet(x, y, z, 0, v[0]);
  if (v[1]) { const i = w.at(x, y, z); w.cores[i] = w.ctx.withLane(w.cores[i], 2, v[1]); }
}

test('spawn custody: a marked cell becomes one particle carrying all but its air carrier, exactly', () => {
  let n = 0;
  for (const id of liquids) for (const T of [-40, 20, 95, 1500]) for (const fill of [1, 4097, L.FULL, L.FULL + 12345, L.MAX_FILL]) {
    const w = new ColumnGrid(8, 8, 8);
    let m;
    try { m = L.makeMaterial(id, T, fill); } catch { continue; }
    marked(w, 3, 4, 3, id, { T, fill });
    const i = w.at(3, 4, 3), before = w.material(i), e0 = L.energyOf(before), mass0 = L.cFill(before.core), pay0 = L.payloadOf(before.core);
    w.jets();
    const after = w.material(i);
    if (w.parts.length) {
      const q = w.parts[0];
      assert.equal(L.cid(after.core), 0, 'the cell is air');
      assert.equal(L.cTq(after.core), L.cTq(before.core), 'at its own temperature');
      assert.equal(L.cFill(q.m.core), mass0); assert.equal(L.payloadOf(q.m.core), pay0);
      assert.equal(L.energyOf(after) + L.packetOwnedEnergy(q.m), e0, `${ELEMENTS[id].key} ${T} ${fill}: energy`);
      assert.equal(L.ctypeOf(q.m.core), L.ctypeOf(before.core));
      n++;
    } else {
      // refused by the format: the liquid stays, unmarked, to fall
      assert.equal(L.cFill(after.core), mass0); assert.equal(L.energyOf(after), e0); assert.equal(w.ctx.laneOf(after.core, 1), 0);
    }
    void m;
  }
  assert.ok(n > 100, `${n} launches`);
});

test('a full pool refuses: the rest keep their liquid, lose the mark and fall; mass stays exact', () => {
  const w = new ColumnGrid(8, 16, 8);
  for (let z = 1; z < 6; z++) marked(w, 3, 10, z, E.WATER, { T: 30 });
  w.poolCap = 2;
  const t0 = w.totals();
  w.jets();
  assert.equal(w.parts.length, 2);
  let left = 0;
  for (let z = 1; z < 6; z++) { const c = w.cores[w.at(3, 10, z)]; if (L.cid(c) === E.WATER) { left++; assert.equal(w.ctx.laneOf(c, 1), 0); } }
  assert.equal(left, 3);
  const t1 = w.totals();
  assert.equal(t1.mass, t0.mass); assert.equal(t1.energy, t0.energy); assert.equal(t1.fuel, t0.fuel);
  for (let k = 0; k < 30; k++) w.step();
  for (let z = 1; z < 6; z++) assert.notEqual(L.cid(w.cores[w.at(3, 10, z)]), E.WATER, 'a refused cell fell');
  assert.equal(w.totals().mass, t0.mass);
});

function holeScene() {
  const w = new ColumnGrid(48, 32, 8);
  const box = (a, b, id) => { for (let y = a[1]; y <= b[1]; y++) for (let z = a[2]; z <= b[2]; z++) for (let x = a[0]; x <= b[0]; x++) w.set(x, y, z, id); };
  box([0, 0, 0], [8, 31, 7], E.WALL); box([1, 13, 1], [7, 31, 6], E.EMPTY); box([1, 13, 1], [7, 30, 6], E.WATER); box([8, 14, 3], [8, 14, 3], E.EMPTY);
  return w;
}
const tankMass = (w) => { let m = 0; for (let y = 13; y < 32; y++) for (let z = 1; z < 7; z++) for (let x = 1; x < 8; x++) { const c = w.cores[w.at(x, y, z)]; if (L.isLiquid(L.cid(c))) m += L.cFill(c); } return m; };

test('the launch head is the reservoir\'s exact head; jets leave at sqrt(2gh) and discharge stays under A sqrt(2gh)', () => {
  const w = holeScene(), ctx = w.ctx, t0 = w.totals();
  for (let t = 0; t < 30; t++) w.step();
  let prev = tankMass(w);
  for (let window = 0; window < 4; window++) {
    for (let t = 0; t < 30; t++) w.step();
    const rA = ctx.colRec(7, 0, 3), etaA = ctx.colEta(rA), h = etaA - 14.5, torricelli = Math.sqrt(2 * G_MS2 * CELL_M * h);
    // the orifice cell's own head is far below its reservoir's: the launch head reads through it
    let k = 0, rB = ctx.colRec(8, k, 3); while (ctx.recY0(rB) !== 14) rB = ctx.colRec(8, ++k, 3);
    assert.ok(ctx.colEta(rB) < etaA - 10);
    assert.ok(Math.abs(ctx.colLaunchHead(8, 3, 9, 3, rB, 14) - etaA) < 1e-6, 'the launch head is the tank\'s');
    const jet = w.parts.filter(p => p.x < 9.2).map(p => Math.hypot(p.vx, p.vz) * CELL_M);
    assert.ok(jet.length > 0);
    for (const v of jet) assert.ok(Math.abs(v / torricelli - 1) < 0.02, `launch ${v} vs ${torricelli}`);
    const now = tankMass(w), discharge = (prev - now) / L.FULL * 2, ideal = torricelli / CELL_M;   // cells/s over 0.5 s
    prev = now;
    assert.ok(discharge / ideal > 0.9 && discharge / ideal <= 1, `discharge ${discharge.toFixed(2)} vs A sqrt(2gh) ${ideal.toFixed(2)}`);
  }
  const t1 = w.totals();
  assert.equal(t1.mass, t0.mass); assert.equal(t1.energy, t0.energy);
});

test('slow unsupported outflow falls from the face rows; it never lands at once', () => {
  // a 1-deep sheet on a shelf at y 6 next to a drop to the floor: under R14's 1 m/s it pours mid-air
  const w = new ColumnGrid(16, 16, 8);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 8; z++) w.set(x, 0, z, E.WALL);
  for (let y = 1; y <= 6; y++) for (let x = 0; x < 6; x++) for (let z = 0; z < 8; z++) w.set(x, y, z, E.WALL);
  for (let x = 0; x < 6; x++) for (let z = 0; z < 8; z++) w.set(x, 7, z, E.WATER, { fill: L.FULL >> 2 });
  let midAir = false;
  for (let t = 0; t < 120 && !midAir; t++) {
    w.step();
    for (let y = 2; y < 8; y++) if (L.cid(w.cores[w.at(6, y, 3)]) === E.WATER) midAir = true;
  }
  assert.ok(midAir, 'water appears at the face rows over the drop');
  assert.equal(w.parts.length, 0, 'too slow to launch');
});

test('the WGSL: deterministic ranks, refusal keeps the liquid, the allocator protocol, Naga', () => {
  const g = gridLayout(32, 32, 32), spawn = jetsWGSL(g, 'spawn'), count = jetsWGSL(g, 'count'), allocate = jetsWGSL(g, 'allocate');
  const body = spawn.slice(spawn.lastIndexOf('@compute'));
  // every lane's mark is read before any lane changes its cell; ranks add the brick prefix, the group base, earlier lanes
  assert.ok(body.indexOf('wgMarked[li]=') < body.indexOf('workgroupBarrier()') && body.indexOf('workgroupBarrier()') < body.indexOf('storeMaterial('));
  assert.match(body, /var rank=atomicLoad\(&control\[J_PREFIX\+b\]\)\+atomicLoad\(&control\[J_COUNTS\+b\/64u\]\);/);
  assert.match(body, /for\(var lane=0u;lane<li;lane\+\+\) \{ rank\+=wgMarked\[lane\]; \}/);
  // acceptance: a free slot, a launch speed, a representable packet and carrier; else the mark goes and the liquid stays
  assert.match(body, /rank<atomicLoad\(&control\[4\]\) && length\(velocity\)>0\.0 && all\(dParticleEnergy\(m\)==carried\) && energyFits\(empty,rest\)/);
  assert.match(body, /\} else \{[^}]*storeMaterial\(t,before,Material\(zeroQ\(c\),before\.bank\)\);/);
  assert.match(spawn, /out\.bank = bitcast<i32>\(energySub\(jetCarried\(m\), dParticleEnergy\(out\)\)\.x\);/);
  assert.match(spawn, /fn jetCarried\(m: Material\) -> vec2u \{ return energySub\(energyOf\(m\), energyMul\(FULLU, cTq\(m\.core\)\)\); \}/);
  assert.match(body, /if\(li==0u\) \{ atomicStore\(&act2\[V2_JETS\+b\],0u\); \}/);
  // count keeps padding lanes through its barrier; allocate gives group bases and the request total
  const countBody = count.slice(count.lastIndexOf('@compute'));
  assert.doesNotMatch(countBody, /return;/); assert.match(countBody, /brickDemand\[li\]=count; workgroupBarrier\(\)/);
  assert.match(allocate, /atomicStore\(&control\[5\],requested\);/); assert.match(allocate, /if\(requested>free\) \{ atomicAdd\(&control\[7\],requested-free\); \}/);
  for (const stage of JET_STAGES) assertNaga(jetsWGSL(gridLayout(16, 8, 8), stage), `jets ${stage}`);
});

test('radial gravity: column water stands down and a liquid over open space drips toward the centre', async () => {
  const { blastsWGSL } = await import('../../src/shaders/v2/blasts.js');
  const { nativeDynamicsHead, v2RunsWGSL, v2PairsWGSL } = await import('../../src/shaders/v2.js');
  const g = gridLayout(16, 8, 8), plan = blastsWGSL(g, nativeDynamicsHead, 'couplePlan');
  assert.match(plan, /let radialDrip = k==3u && P\.gravMode==2u && P\.gravity>0\.0 && dUnsupported\(p\);/);
  assert.match(plan, /\|\| radialDrip\) \{\s*\/\/ Real SI flight/);
  for (const code of [v2RunsWGSL(g), v2PairsWGSL(g)]) assert.match(code.slice(code.lastIndexOf('@compute')), /if \(P\.gravMode == 2u\) \{ return; \}/);
});
