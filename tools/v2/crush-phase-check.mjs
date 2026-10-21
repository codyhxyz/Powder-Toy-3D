// V2 runs V1's crush rule (react.js "crushed by air pressure", elements.js crush { P, into, of }):
// a cell that didn't break, under more than P of air pressure (its own unless a solid, and its
// open neighbours': react.js pOn), becomes pickOut(into) at its own temperature, a LAVA product
// taking `of` (react.js ctypeOf). V1 ships no crush row today (ice crushing to snow is its
// breaking rule, react.js "a blast: the pressure difference across me", which couplePlan already
// runs), so this check adds test rows at runtime, as tools/elements-core-check.mjs does, and runs
// the generated tables as JS. CPU only: no browser, no GPU.
import assert from 'node:assert/strict';
import { ELEMENTS, E, K, R, elementRow } from '../../src/elements.js';

const add = d => {
  const id = ELEMENTS.length;
  ELEMENTS.push(elementRow({ render: R.OPAQUE, color: '#808080', cond: 0.01, cap: 0.5, ...d }, id));
  E[d.key] = id;
  return id;
};
// a solid that crushes to sand, a powder that crushes into a weighted mix, one into lava of metal
const FOAM_P = 5, MIX_P = 12, ORE_P = 40, MIX_SAND = 0.25;
add({ key: 'T_FOAM', kind: K.SOLID, crush: { P: FOAM_P, into: 'SAND' } });
add({ key: 'T_MIX', kind: K.POWDER, dens: 15, crush: { P: MIX_P, into: [['SAND', MIX_SAND], ['ASH', 1 - MIX_SAND]] } });
add({ key: 'T_ORE', kind: K.SOLID, crush: { P: ORE_P, into: 'LAVA', of: 'METAL' } });

const { dynamicsRows, LEGACY_PRESSURE_PA } = await import('../../src/v2/dynamics-reference.js');
const { blastsWGSL, PLAN } = await import('../../src/shaders/v2/blasts.js');
const { nativeDynamicsHead } = await import('../../src/shaders/v2.js');
const { gridLayout } = await import('../../src/sim.js');
const { nagaErrors } = await import('./wgsl-grouping.mjs');

let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }

test('the crush rows are V1\'s: P in Pa, the product draw as mechanisms() makes it, LAVA of `of`', () => {
  assert.deepEqual(dynamicsRows[E.T_FOAM].crushPhase, { pa: FOAM_P * LEGACY_PRESSURE_PA, outs: [[E.SAND, 1]], of: E.T_FOAM });
  assert.deepEqual(dynamicsRows[E.T_MIX].crushPhase, { pa: MIX_P * LEGACY_PRESSURE_PA, outs: [[E.SAND, MIX_SAND], [E.ASH, 1]], of: E.T_MIX });
  assert.deepEqual(dynamicsRows[E.T_ORE].crushPhase, { pa: ORE_P * LEGACY_PRESSURE_PA, outs: [[E.LAVA, 1]], of: E.METAL });
  for (const e of ELEMENTS) if (!e.crush) assert.equal(dynamicsRows[e.id].crushPhase, null, e.key);
});

const g = gridLayout(16, 16, 16);
const plan = blastsWGSL(g, nativeDynamicsHead, 'couplePlan'), apply = blastsWGSL(g, nativeDynamicsHead, 'apply');
// The generated switch functions, run as JS (syntax only: u32/f32 literals and the signature).
function run(code, name) {
  const at = code.indexOf(`fn ${name}(`), end = code.indexOf('\nfn ', at + 1);
  const js = code.slice(at, end).replace(/^fn (\w+)\(([^)]*)\) -> \w+ \{/, (_, n, args) => `return function ${n}(${args.split(',').map(a => a.split(':')[0].trim()).join(',')}) {`)
    .replace(/\b(\d+)u\b/g, '$1').replace(/D_NO_CRUSH/g, 'Infinity').replace(/switch (\w+) \{/g, 'switch ($1) {');
  return Function(js)();
}
const dCrushPa = run(plan, 'dCrushPa'), dCrushInto = run(plan, 'dCrushInto'), dCrushOf = run(plan, 'dCrushOf');

test('the generated tables draw V1\'s products past V1\'s pressures', () => {
  assert.ok(Math.abs(dCrushPa(E.T_FOAM) - FOAM_P * LEGACY_PRESSURE_PA) < 1e-9);
  assert.ok(Math.abs(dCrushPa(E.T_ORE) - ORE_P * LEGACY_PRESSURE_PA) < 1e-9);
  assert.equal(dCrushPa(E.ICE), Infinity, 'a row without a crush never crushes');
  assert.equal(dCrushInto(E.T_FOAM, 0.99), E.SAND);
  let sand = 0; const n = 1000;
  for (let i = 0; i < n; i++) { const into = dCrushInto(E.T_MIX, (i + 0.5) / n); assert.ok(into === E.SAND || into === E.ASH); if (into === E.SAND) sand++; }
  assert.equal(sand, MIX_SAND * n, 'the weighted draw');
  assert.equal(dCrushInto(E.STONE, 0.5), E.STONE, 'no crush: itself');
  assert.equal(dCrushOf(E.T_ORE), E.METAL); assert.equal(dCrushOf(E.T_FOAM), E.T_FOAM);
});

test('couplePlan crushes an unbroken cell under more than its P (V1 pOn), and apply converts it at its own T', () => {
  // V1 pOn: its own pressure (none for a solid) and every open neighbour's
  assert.match(plan, /fn dPressureOn\(p: vec3i, k: u32\) -> f32 \{\n  var on=-1e30; if \(k!=1u\) \{ on=dPressureCell\(p\); \}\n  for \(var a=0u;a<3u;a\+\+\) \{ on=max\(on,max\(dOpenPressure\(p\+dAxis\(a\)\),dOpenPressure\(p-dAxis\(a\)\)\)\); \}/);
  // breaking wins (V1: broke comes first), then the crush replaces any launch this tick
  assert.ok(plan.includes(`if ((plan.flags&2u)==0u && dCrushPa(id)<D_NO_CRUSH && mAirPressure() && dPressureOn(p,k)>dCrushPa(id)) {`));
  assert.ok(plan.includes(`if (into!=id) { plan=DPlan(vec3f(0),${PLAN.CRUSH}u|(into<<8u)); }`));
  // the quiet-brick skip never hides a crush: a brick under its weakest P holds none
  assert.ok(plan.includes(`&& most<=${Math.min(FOAM_P, MIX_P, ORE_P) * LEGACY_PRESSURE_PA});`));
  assert.ok(apply.includes(`if ((plan.flags&${PLAN.CRUSH}u)!=0u) {\n      after=dCrushed(before,(plan.flags>>8u)&255u);\n      dNoteEnergyChange(cellOf(t),energyOf(before),energyOf(after));`));
  assert.match(apply, /return makeMaterial\(into,f32\(cTq\(m\.core\)\)\*0\.25-273\.25,amount,select\(0u,dCrushOf\(id\),into==\d+u\)\);/);
  assert.equal(PLAN.CRUSH & (PLAN.SPAWN | PLAN.BREAK | PLAN.SOURCE | PLAN.NEUTRON | 16 | 32 | PLAN.SLIDE), 0, 'its own plan bit');
});

test('with crush rows the plan and apply stages validate (Naga)', () => {
  for (const [name, code] of [['couplePlan', plan], ['apply', apply]]) assert.equal(nagaErrors(code), '', name);
});

console.log(`${checks} crush CPU groups passed; no GPU launched`);
