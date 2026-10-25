// CPU check of the far summary from the world copy (src/shaders/world/farFromCopy.js). No GPU, no browser:
//   1. naga on its WGSL (farCopyFrag, its WGSL_CHECK);
//   2. its JS twin (farCopyTexel: uniform neighbour bricks counted in one step, as the kernel counts) against
//      the per-cell formula of the scene's and the window's summaries (farCellTexel: shaders/far.js
//      farSceneFrag, the window's farWinFrag before it) on every brick of a small synthetic world copy:
//      uniform solid rock with a grass top, powder, liquids at partial fill (water, and lava, which is opaque),
//      whole water, glass, air, hot lava (glow), logs and leaves with their appearance, a randomly mixed block,
//      and the world's edges (rock below it, air above, the edge columns repeated past its sides).
// usage: node tools/far-from-copy-cpu-check.mjs
import { WGSL_CHECK, farCopyTexel, farCellTexel } from '../src/shaders/world/farFromCopy.js';
import { wcWord, wcTempOf, WC_MIXED, WC_BRICK_CELLS } from '../src/shaders/world/cellWord.js';
import { unpackFarTexel } from '../src/shaders/farShared.js';
import { APPEARANCE_BASE, Appearance } from '../src/appearance.js';
import { E } from '../src/elements.js';
import { gridLayout } from '../src/sim.js';
import { nagaExec } from './naga.mjs';

let bad = 0;
const fail = (msg) => { bad++; console.error(`FAIL ${msg}`); };

// ---------------------------------------------------------------- 1. naga
for (const c of WGSL_CHECK()) {
  try { nagaExec(c.code(gridLayout(128, 128, 128)), `${c.name}.wgsl`); console.log(`naga ${c.name}: ok`); } catch (e) { fail(String(e.message).slice(0, 1500)); }
}

// ---------------------------------------------------------------- 2. twin vs formula
// shaders/common.js pcg and seedWorld, for wcA's liquid dither (seedWorld(c, 0, 4243) >> 16)
const pcg = (v) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const seedWorld = ([x, y, z], frame, salt) => pcg((x >>> 0) + pcg((y >>> 0) + pcg((z >>> 0) + pcg(Math.imul(frame, 1664525) + salt))));
const dither = (c) => seedWorld(c, 0, 4243) >>> 16;
const tempOf = (w) => Math.fround(wcTempOf((w >>> 16) & 255));

// a world of 8³ bricks (32 cells a side), dense, then compacted as the world copy holds it
const N = 32, B = 4, NB = N / B;
let rng = 20261025;
const rand = () => { rng = (Math.imul(rng, 1103515245) + 12345) >>> 0; return rng / 2 ** 32; };
const AMBIENT = 20;
const air = wcWord(E.EMPTY, 0, AMBIENT, 0);
const ap = (a) => APPEARANCE_BASE + a;
function cell(x, y, z) {
  if (y < 8) return wcWord(E.ROCK, 0, AMBIENT, 1);                                                  // solid ground (uniform bricks)...
  if (y === 8 && x < 16) return wcWord(E.PLANT, ap(Appearance.GRASS), AMBIENT, 1);                  // ...grass on half of it
  if (x < 8 && z < 8 && y < 16) return wcWord(E.SAND, 0, AMBIENT, 1);                              // a powder heap
  if (x >= 8 && x < 16 && z < 8 && y < 16) return wcWord(E.WATER, 0, AMBIENT, 0.4);                 // water at partial fill
  if (x >= 16 && x < 24 && z < 8 && y < 12) return wcWord(E.WATER, 0, AMBIENT, 1);                  // whole water
  if (x >= 24 && z < 8 && y < 16) return wcWord(E.GLASS, 0, AMBIENT, 1);                            // glass
  if (x < 8 && z >= 8 && z < 16 && y < 12) return wcWord(E.LAVA, 0, 1500, (x + z) % 3 ? 1 : 0.6);   // hot lava, some partial
  if (x >= 8 && x < 12 && z >= 8 && z < 12 && y < 20) return wcWord(E.WOOD, ap(Appearance.LOG_Y), AMBIENT, 1);   // a trunk...
  if (x >= 6 && x < 14 && z >= 6 && z < 14 && y >= 20 && y < 24) return wcWord(E.PLANT, ap(Appearance.LEAVES), AMBIENT, 1);   // ...its crown
  if (x >= 16 && z >= 16 && y < 24) {                                                               // a randomly mixed block, at the edges
    const r = rand();
    if (r < 0.3) return air;
    const id = [E.SAND, E.WATER, E.GLASS, E.LAVA, E.OIL, E.STEAM, E.STONE, E.MOSS][Math.floor(r * 80) % 8];
    return wcWord(id, 0, 50 + rand() * 1200, rand());
  }
  if (y >= 28 && x === 0) return wcWord(E.STONE, 0, AMBIENT, 1);                                    // matter at the top edge
  return air;
}
const table = new Uint32Array(NB ** 3), poolWords = [];
for (let bz = 0; bz < NB; bz++) for (let by = 0; by < NB; by++) for (let bx = 0; bx < NB; bx++) {
  const words = [];
  for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) words[x + B * (y + B * z)] = cell(bx * B + x, by * B + y, bz * B + z);
  const i = bx + NB * (by + NB * bz);
  if (words.every((w) => w === words[0])) table[i] = words[0];
  else { table[i] = (WC_MIXED | (poolWords.length / WC_BRICK_CELLS)) >>> 0; poolWords.push(...words); }
}
const copy = { size: [N, N, N], table, pool: Uint32Array.from(poolWords) };
let bricks = 0, uniform = 0, nonzero = 0;
const kinds = new Set();
for (let bz = 0; bz < NB; bz++) for (let by = 0; by < NB; by++) for (let bx = 0; bx < NB; bx++) {
  const b = [bx, by, bz], opts = { tempOf, dither };
  const want = farCellTexel(copy, b, opts), got = farCopyTexel(copy, b, opts);
  bricks++;
  if (!(table[bx + NB * (by + NB * bz)] & WC_MIXED)) uniform++;
  if (want.some((v) => v)) nonzero++;
  const u = unpackFarTexel(want);
  if (u.id) kinds.add(u.id);
  if (u.liquid) kinds.add(u.liquid);
  if (got.some((v, k) => v !== want[k])) fail(`brick ${b}: twin ${JSON.stringify(unpackFarTexel(got))}, formula ${JSON.stringify(u)}`);
}
const glowing = (() => { for (let z = 0; z < NB; z++) for (let x = 0; x < NB; x++) if (unpackFarTexel(farCellTexel(copy, [x, 2, z], { tempOf, dither })).glow) return true; return false; })();
if (!glowing) fail('no glowing brick: the lava test reads nothing');
console.log(`twin vs formula: ${bricks} bricks (${uniform} uniform, ${copy.pool.length / WC_BRICK_CELLS} mixed, ${nonzero} nonzero texels), elements ${[...kinds].sort((a, b) => a - b).join(',')}`);
console.log(bad ? `${bad} failing` : 'ok');
process.exit(bad ? 1 : 0);
