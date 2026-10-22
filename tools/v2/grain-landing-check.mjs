// CPU witness for a grain's landing in the column pass (src/shaders/v2.js grainLandWGSL): EXECUTES the emitted
// v2column main (the restricted adapter of fall-check, not a rewritten model) on one column of production-format
// cells, with the emitted landing and fast-mover helpers (tools/v2/block-motion.mjs), and compares with V1:
//   - BL-7: a heavy grain sets C-4 off at its own odds by its fall (dynamics-reference.js v1GrainOdds, V1's
//     random stream), so a slab dropped a cell goes off far more often than a lone grain does;
//   - BL-8: a heavy fall breaks the breakable solid it lands on (react.js: ½·dens·u² ≥ hard), a light one doesn't;
//   - TH-10: a hard landing on a solid it doesn't break warms both alike (move.js impactHeat, KE_TO_HEAT).
import assert from 'node:assert/strict';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { PHYS } from '../../src/physics.js';
import { FALL_KEEP, fallTerminal, setFall } from '../../src/v2/fall.js';
import { GRAVITY_MS2, V1_STEP_MS } from '../../src/v2/gravity.js';
import { fallWGSL, fallStepWGSL } from '../../src/shaders/v2/fall.js';
import { v2ColumnWGSL } from '../../src/shaders/v2.js';
import { gridDims } from '../../src/shaders/common.js';
import { makeMaterial, cTq } from '../../src/v2/layout.js';
import { v1GrainLandingOdds } from '../../src/v2/dynamics-reference.js';
import { grainLandingHelpers } from './block-motion.mjs';

const NY = 64;
const word = value => new Uint32Array(new Float32Array([value]).buffer)[0];
const vec = (...v) => { const a = Uint32Array.from(v); for (const [i, k] of ['x', 'y', 'z', 'w'].entries()) Object.defineProperty(a, k, { get: () => a[i] }); return a; };
function scalar(source) {
  return source.replace(/const FALL_(?:TERMINAL|POWDER|KEEP) = array<[^;]+;/g, '')
    .replace(/fn (\w+)\(([^)]*)\) -> \w+\s*\{/g, (_, n, args) => `function ${n}(${args.replace(/: \w+/g, '')}) {`)
    .replace(/bitcast<f32>/g, 'fromBits').replace(/bitcast<u32>/g, 'toBits')
    .replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1').replace(/>>/g, '>>>').replace(/&act2/g, 'act2');
}
const helpers = scalar(fallWGSL + fallStepWGSL);
const code = v2ColumnWGSL(gridDims({ nx: 16, ny: NY, nz: 8 }));
const main = scalar(code.slice(code.lastIndexOf('  if (P.gravMode == 2u'), code.lastIndexOf('}')));
// One column: cells[y]; `ticks` ticks of the emitted pass from `tick`. Returns the cells and the requests.
function run(start, ticks, tick = 1) {
  const cells = start.map(c => vec(...c)), banks = new Int32Array(NY), events = new Uint32Array(NY);
  const P = { gravity: GRAVITY_MS2, gravMode: 0, edge: 0, tick, ambient: 20, deco: 0 };
  const store = (s, a) => { cells[s] = vec(...a.core); banks[s] = a.bank; };
  const env = { P, wg: 0, nwg: 0, li: 0, BS: 4, BX: 1, NY,
    V2_COUNT: 0, CNT_USE_COLS: 0, V2_COLS: 1, act2: [1, 0], C_AIR: 0, C_GAS: 4, C_POWDER: 2, C_LIQUID: 3, C_SOLID: 1,
    V2_SUMMARY: 2, SUM_AIR: 2, SUM_LIQUID: 3, brickOfCell: p => p.y >> 2,
    atomicLoad: x => x, foldThread: () => 0, u32: x => x >>> 0, i32: Math.trunc, f32: Math.fround,
    min: Math.min, floor: Math.floor, select: (a, b, c) => c ? b : a,
    FALL_TERMINAL: ELEMENTS.map(e => fallTerminal(e.id)), FALL_POWDER: ELEMENTS.map(e => e.kind === K.POWDER), FALL_KEEP, vec2f: (x, y) => ({ x, y }),
    fromBits: x => new Float32Array(new Uint32Array([x]).buffer)[0], toBits: word,
    vec4u: vec, vec3i: (x, y, z) => ({ x, y, z }), loadCell: p => cells[p.y], cid: c => c[0] & 255,
    clsOf: c => ({ [K.EMPTY]: 0, [K.SOLID]: 1, [K.POWDER]: 2, [K.LIQUID]: 3, [K.GAS]: 4 })[ELEMENTS[c[0] & 255].kind], markBusy: () => {},
    storeCell: (p, c) => { cells[p.y] = vec(...c); }, zeroQ: c => c, slotOf: p => p.y, events, noteEvents: () => {}, inGrid: p => p.y >= 0 && p.y < NY,
    loadMaterial: s => ({ core: cells[s], bank: banks[s] }), Material: (core, bank) => ({ core, bank }),
    storeMaterial: (s, b, a) => store(s, a), noteEnergySource: () => {}, decoOf: () => 0, setDeco: () => {}, cFill: c => c[1] & 0xffffff,
  };
  const h = grainLandingHelpers(code, env);
  for (const name of ['colExcess', 'colSinkP', 'colRiseP', 'colCells', 'colShift', 'grainFallen', 'grainLands', 'grainHeat',
    'energyAdd', 'energyOf', 'energySub', 'energyFits', 'withEnergy']) env[name] = h[name];
  const tickFn = Function(...Object.keys(env), helpers + main);
  for (let n = 0; n < ticks; n++) { P.tick = tick + n; tickFn(...Object.values(env)); }
  return { cells, events, banks };
}
const air = () => makeMaterial(E.EMPTY).core;
const column = (under, at, grain, h, y0 = 4) => {
  const cells = Array.from({ length: NY }, air);
  for (let y = 0; y <= y0; y++) cells[y] = makeMaterial(y === y0 ? at : under).core;
  cells[y0 + 1 + h] = makeMaterial(grain).core;
  return cells;
};

// ---- BL-7: V1's per-grain odds, by fall (each landing its own roll)
{
  const lines = [];
  for (const [grain, h] of [[E.URANIUM, 1], [E.URANIUM, 2], [E.URANIUM, 3], [E.SCRAP, 6], [E.SCRAP, 8]]) {
    const odds = v1GrainLandingOdds(grain, E.C4, h);
    let off = 0; const n = 400;
    for (let k = 0; k < n; k++) if (run(column(E.STONE, E.C4, grain, h), 30, 1 + 7919 * k).events[4] & 1) off++;
    assert(Math.abs(off / n - odds) < 0.06, `${ELEMENTS[grain].key} from ${h} cells: ${off}/${n}, V1 ${odds.toFixed(3)}`);
    lines.push(`${ELEMENTS[grain].key} ${h}: ${(off / n).toFixed(2)} (V1 ${odds.toFixed(2)})`);
  }
  // a 4×4 slab dropped a cell: sixteen rolls
  let slabs = 0; const N = 150;
  for (let k = 0; k < N; k++) {
    let any = false;
    for (let g = 0; g < 16 && !any; g++) any = (run(column(E.STONE, E.C4, E.URANIUM, 1), 20, 1 + 104729 * k + 31 * g).events[4] & 1) !== 0;
    if (any) slabs++;
  }
  const want = 1 - (1 - v1GrainLandingOdds(E.URANIUM, E.C4, 1)) ** 16;
  assert(Math.abs(slabs / N - want) < 0.12, `uranium slab from 1 cell: ${slabs}/${N}, V1 ${want.toFixed(2)}`);
  // sand never sets C-4 off (V1: ½·16·V_MAX² < its shock)
  let sand = 0; for (let k = 0; k < 50; k++) if (run(column(E.STONE, E.C4, E.SAND, 20), 40, 1 + 13 * k).events[4] & 1) sand++;
  assert.equal(sand, 0);
  console.log(`BL-7 odds by fall: ${lines.join(', ')}; a uranium slab from 1 cell ${(slabs / N).toFixed(2)} (V1 ${want.toFixed(2)}); sand never`);
}
// ---- BL-8: a heavy fall breaks glass (into shards, warmer by its hardness's work); sand's doesn't
{
  const T = c => cTq(c) * 0.25 - 273.25;
  const hit = run(column(E.STONE, E.GLASS, E.URANIUM, 6), 30);
  assert.equal(hit.cells[4][0] & 255, E.SHARDS, 'uranium from 6 cells breaks glass');
  const debrisT = T(hit.cells[4]);
  assert(debrisT > 20 + 0.9 * ELEMENTS[E.GLASS].hard * PHYS.KE_TO_HEAT / ELEMENTS[E.SHARDS].cap, `the debris takes the fracture work: ${debrisT}`);
  const light = run(column(E.STONE, E.GLASS, E.SAND, 30), 40);
  assert.equal(light.cells[4][0] & 255, E.GLASS, 'sand never breaks glass (½·16·u² < 8)');
  const lamp = run(column(E.STONE, E.WOOD, E.SCRAP, 12), 40);
  assert.equal(lamp.cells[4][0] & 255, E.SAWDUST, 'scrap breaks wood');
  console.log(`BL-8: uranium breaks glass into shards (${debrisT.toFixed(1)} °C), scrap breaks wood, sand rests on glass`);
}
// ---- TH-10: a hard landing on metal it can't break warms both by V1's equal share
{
  const T = c => cTq(c) * 0.25 - 273.25;
  const out = run(column(E.STONE, E.METAL, E.SAND, 30), 40);
  const sandAt = out.cells.findIndex(c => (c[0] & 255) === E.SAND);
  assert.equal(sandAt, 5, 'the sand rests on the metal');
  const ds = T(out.cells[5]) - 20, dm = T(out.cells[4]) - 20;
  const u = Math.min(PHYS.V_MAX, fallTerminal(E.SAND) / V1_STEP_MS);
  const v1 = 0.5 * ELEMENTS[E.SAND].dens * u * u * PHYS.KE_TO_HEAT / (ELEMENTS[E.SAND].cap + ELEMENTS[E.METAL].cap);
  assert(ds > 0 && dm > 0 && Math.abs(ds - dm) <= 0.25 && Math.abs(ds - v1) <= 0.25 + 0.2 * v1, `sand +${ds}, metal +${dm} °C, V1 +${v1.toFixed(2)}`);
  const soft = run(column(E.STONE, E.SAND, E.SAND, 30), 40);
  assert.equal(T(soft.cells[4]), 20, 'onto grains: no heat (V1 heats only a landing on a solid)');
  console.log(`TH-10: sand landing on metal warms both +${ds.toFixed(2)} / +${dm.toFixed(2)} °C (V1 +${v1.toFixed(2)}); onto grains none`);
}
console.log('grain-landing-check: ok');
