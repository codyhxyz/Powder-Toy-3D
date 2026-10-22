// CPU-only: the powder column pass's summary skip is exact. The emitted R1
// body (the restricted adapter of fall-check, not a rewritten model) runs on
// random 128-cell lanes of air, gas, stone, sand at every fall state and
// full still water, once with no brick summaries and once with exact ones
// (all air, all one full liquid; others unknown): every cell, request and
// busy mark must match. A summary that lies, or a liquid skip that leaves
// the floor behind, must break it.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { fallTerminal, setFall, FALL_KEEP } from '../../src/v2/fall.js';
import { GRAVITY_MS2 } from '../../src/v2/gravity.js';
import { fallWGSL } from '../../src/shaders/v2/fall.js';
import { v2ColumnWGSL, SUMMARY } from '../../src/shaders/v2.js';
import { gridDims } from '../../src/shaders/common.js';
import { makeMaterial } from '../../src/v2/layout.js';
import { K } from '../../src/elements.js';

const word = value => new Uint32Array(new Float32Array([value]).buffer)[0];
const vec = (...v) => { const a = Uint32Array.from(v); for (const [i, k] of ['x', 'y', 'z', 'w'].entries()) Object.defineProperty(a, k, { get: () => a[i] }); return a; };
function scalar(source) {
  return source.replace(/const FALL_(?:TERMINAL|POWDER|KEEP) = array<[^;]+;/g, '')
    .replace(/fn (\w+)\(([^)]*)\) -> \w+\s*\{/g, (_, n, args) => `function ${n}(${args.replace(/: \w+/g, '')}) {`)
    .replace(/bitcast<f32>/g, 'fromBits').replace(/bitcast<u32>/g, 'toBits')
    .replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1').replace(/>>/g, '>>>').replace(/&act2/g, 'act2');
}
const helpers = scalar(fallWGSL), g = gridDims({ nx: 16, ny: 128, nz: 8 });
const emitted = v2ColumnWGSL(g), body = emitted.slice(emitted.lastIndexOf('  if (P.gravMode == 2u'), emitted.lastIndexOf('}'));
const NY = 128, SUMMARY_AT = 2;
function run(start, summaries, main = body) {
  const cells = start.map(c => vec(...c)), events = new Uint32Array(NY), busy = new Set();
  start.forEach((_, y) => { events[y] = y % 7 === 0 ? y : 0; });
  const act2 = [1, 0, ...summaries];
  const env = { P: { gravity: GRAVITY_MS2, gravMode: 0, edge: 0 }, wg: 0, nwg: 0, li: 0, BS: 4, BX: 1, NY,
    V2_COUNT: 0, CNT_USE_COLS: 0, V2_COLS: 1, act2, C_AIR: 0, C_GAS: 4, C_POWDER: 2,
    V2_SUMMARY: SUMMARY_AT, SUM_AIR: SUMMARY.AIR, SUM_LIQUID: SUMMARY.LIQUID, brickOfCell: p => p.y >> 2,
    atomicLoad: x => x, foldThread: () => 0, u32: x => x >>> 0, i32: Math.trunc, f32: Math.fround,
    min: Math.min, floor: Math.floor, select: (a, b, c) => c ? b : a,
    FALL_TERMINAL: ELEMENTS.map(e => fallTerminal(e.id)), FALL_POWDER: ELEMENTS.map(e => e.kind === K.POWDER), FALL_KEEP, vec2f: (x, y) => ({ x, y }),
    fromBits: x => new Float32Array(new Uint32Array([x]).buffer)[0], toBits: word,
    vec4u: vec, vec3i: (x, y, z) => ({ x, y, z }), loadCell: p => cells[p.y],
    clsOf: c => ELEMENTS[c.x & 255].kind, markBusy: p => busy.add(p.y), storeCell: (p, c) => { cells[p.y] = vec(...c); },
    zeroQ: c => c, slotOf: p => p.y, events, noteEvents: () => {},
    loadMaterial: s => ({ core: cells[s], bank: 0 }), Material: (core, bank) => ({ core, bank }),
    storeMaterial: (s, b, a) => { cells[s] = vec(...a.core); },
  };
  Function(...Object.keys(env), helpers + scalar(main))(...Object.values(env));
  return JSON.stringify([cells.map(c => Array.from(c)), Array.from(events), [...busy].sort((a, b) => a - b)]);
}
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const air = () => makeMaterial(E.EMPTY).core, water = () => makeMaterial(E.WATER).core;
function lane(random) {
  const out = [], kinds = [];
  for (let b = 0; b < NY / 4; b++) {
    const r = random(), kind = r < 0.35 ? 'air' : r < 0.5 ? 'water' : 'mixed'; kinds.push(kind);
    for (let i = 0; i < 4; i++) {
      if (kind === 'air') out.push(air());
      else if (kind === 'water') out.push(water());
      else { const q = random(); out.push(q < 0.35 ? air() : q < 0.55 ? setFall(makeMaterial(E.SAND).core, random() < 0.5 ? 0 : random() * 0.4, random() < 0.5 ? 0 : random() * 0.9)
        : q < 0.7 ? makeMaterial(E.STONE).core : q < 0.8 ? water() : q < 0.9 ? makeMaterial(E.STEAM).core : makeMaterial(E.SAND).core); }
    }
  }
  return { cells: out, kinds };
}
const exact = (kinds, random, lie = false) => kinds.map(k => {
  if (lie && k === 'mixed' && random() < 0.3) return SUMMARY.AIR;
  return random() < 0.2 ? 0 : k === 'air' ? SUMMARY.AIR : k === 'water' ? SUMMARY.LIQUID | (E.WATER << 8) : 0;
});
let runs = 0, skipped = 0;
for (let seed = 1; seed <= 300; seed++) {
  const random = rng(seed), { cells, kinds } = lane(random), sums = exact(kinds, random);
  assert.equal(run(cells, sums), run(cells, new Array(NY / 4).fill(0)), `summary skip changed the column: seed ${seed}`);
  runs++; skipped += sums.filter(Boolean).length;
}
assert.ok(skipped > runs * 8, 'the lanes exercise the skip');
let lied = false, floorLost = false;
const noFloor = body.replace('if (code == SUM_LIQUID) { fl = y + 4; runFalling = false; y += 3; continue; }', 'if (code == SUM_LIQUID) { y += 3; continue; }');
assert.notEqual(noFloor, body);
for (let seed = 1; seed <= 300 && !(lied && floorLost); seed++) {
  const random = rng(seed), { cells, kinds } = lane(random), plain = run(cells, new Array(NY / 4).fill(0));
  if (!lied && run(cells, exact(kinds, rng(seed + 1), true)) !== plain) lied = true;
  if (!floorLost && run(cells, exact(kinds, rng(seed + 2)), noFloor) !== plain) floorLost = true;
}
assert.ok(lied, 'a summary claiming air over mixed cells must break the column');
assert.ok(floorLost, 'a liquid skip that leaves the floor behind must break the column');
console.log(`column skip: ${runs} lanes identical with ${skipped} summarised bricks skipped; 2 red variants caught`);
