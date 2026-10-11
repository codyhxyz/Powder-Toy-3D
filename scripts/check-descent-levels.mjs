// CPU checks of the Descent levels (docs/descent-contract.md) against the
// scenes' JS twins (src/world/scenes/descent/scenes.js): levels.js is what the
// twins say it is (its sites are computed: src/world/scenes/descent/sites.js),
// every loot site and the spawn stand in air on a solid floor, the temple's
// sites are where its geometry puts them, the temple sits sealed in the
// indestructible band, its exit pit is open, and the way down from the spawn
// reaches the temple's entry shaft. No GPU: fine on battery.
//
//   node scripts/check-descent-levels.mjs           check
//   node scripts/check-descent-levels.mjs --write   regenerate levels.js first
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { E, ELEMENTS, K } from '../src/elements.js';
import { descentTwin, descentConstants, DS_LEVEL_DEFS } from '../src/world/scenes/descent/scenes.js';
import { levelSites, reachable, crossingOf, feetAt, wangWalk, LOOT_COUNTS, CHEST_COUNT, POTION_COUNT } from '../src/world/scenes/descent/sites.js';
import { GEOM } from '../src/world/wang/index.js';

const LEVELS_JS = fileURLToPath(new URL('../src/world/scenes/descent/levels.js', import.meta.url));
const SHELL_SAMPLES = 400;   // cells of the band round the temple checked to be WALL
const MAX_CLIMB = 1;         // cells a walk up the mouth's ramp may step up at a time (a body steps a cell)...
const MAX_DROP = 8;          // ...or drop (under vitals.js SAFE_FALL_M, 10 cells)

let failures = 0;
const fail = (what, msg) => { failures++; console.log(`FAIL ${what}: ${msg}`); };
const solid = (id) => ELEMENTS[id].kind === K.SOLID || ELEMENTS[id].kind === K.POWDER;

const computed = DS_LEVEL_DEFS.map((_, level) => levelSites(level));

if (process.argv.includes('--write')) {
  const row = (v) => JSON.stringify(v).replace(/"(\w+)":/g, '$1: ').replace(/,/g, ', ').replace(/"/g, "'");
  const level = (L) => `  {
    key: '${L.key}', name: '${L.name}', tier: ${L.tier},
    spawn: ${row(L.spawn)},
    temple: {
${Object.entries(L.temple).map(([k, v]) => `      ${k}: ${row(v)},`).join('\n')}
    },
    loot: [
${L.loot.map((l) => `      ${row(l)},`).join('\n')}
    ],
    chests: [
${L.chests.map((l) => `      ${row(l)},`).join('\n')}
    ],
    potions: [
${L.potions.map((l) => `      ${row(l)},`).join('\n')}
    ],
  },`;
  writeFileSync(LEVELS_JS, `// The Descent levels (docs/descent-contract.md): plain data, no imports, so the
// wand loot and the Holy Mountain code read it without pulling in the
// generator. World cells, integers; a site is the cell its feet stand in.
//
// GENERATED from the scenes' JS twins (src/world/scenes/descent/sites.js):
// don't edit by hand. Regenerate and check with
//   node scripts/check-descent-levels.mjs --write
export const DESCENT_LEVELS = [
${computed.map(level).join('\n')}
];
export const levelByScene = (key) => DESCENT_LEVELS.find((l) => l.key === key) ?? null;
// the level after this one, or null after the last
export const nextLevel = (key) => DESCENT_LEVELS[DESCENT_LEVELS.findIndex((l) => l.key === key) + 1] ?? null;
// is world point p ([x, y, z], cells) inside box b ([x0, y0, z0, x1, y1, z1])?
export const inBox = (b, p) => p[0] >= b[0] && p[1] >= b[1] && p[2] >= b[2] && p[0] < b[3] && p[1] < b[4] && p[2] < b[5];
`);
  console.log(`wrote ${LEVELS_JS}`);
}

const { DESCENT_LEVELS } = await import(`${LEVELS_JS}?t=${Date.now()}`);
if (JSON.stringify(DESCENT_LEVELS) !== JSON.stringify(computed)) fail('levels.js', "doesn't match the twins (run with --write)");

DESCENT_LEVELS.forEach((L, level) => {
  const T = descentTwin(level), C = descentConstants(level), cell = T.dsCell;
  const at = (p) => cell(p[0], p[1], p[2]);
  const stands = (what, p) => {
    if (at(p) !== E.EMPTY || at([p[0], p[1] + 1, p[2]]) !== E.EMPTY) fail(L.key, `${what} ${p} isn't in air`);
    else if (!solid(at([p[0], p[1] - 1, p[2]]))) fail(L.key, `${what} ${p} has no floor under it (${ELEMENTS[at([p[0], p[1] - 1, p[2]])].key})`);
  };
  if (L.key !== DS_LEVEL_DEFS[level].key) fail(L.key, 'out of order');
  stands('spawn', L.spawn);
  if (feetAt(cell, L.spawn[0], L.spawn[2], L.spawn[1], L.spawn[1] + 1) !== L.spawn[1]) fail(L.key, 'spawn is not on the floor');
  const counts = {};
  for (const l of L.loot) { stands(`${l.kind} site`, [l.x, l.y, l.z]); counts[l.kind] = (counts[l.kind] ?? 0) + 1; if (l.tier !== L.tier) fail(L.key, 'loot tier'); }
  if (!(counts.wand >= 4 && counts.wand <= 6 && counts.spell >= 6 && counts.gold >= LOOT_COUNTS.gold)) fail(L.key, `loot counts ${JSON.stringify(counts)}`);
  // chests (Noita's 2–3 a biome) and potion flasks: their own lists, same rules as a loot site
  for (const c of L.chests ?? []) { stands('chest', [c.x, c.y, c.z]); if (c.tier !== L.tier) fail(L.key, 'chest tier'); }
  for (const c of L.potions ?? []) { stands('potion', [c.x, c.y, c.z]); if (c.tier !== L.tier) fail(L.key, 'potion tier'); }
  if (!(L.chests?.length >= 2 && L.chests.length <= CHEST_COUNT)) fail(L.key, `${L.chests?.length} chests, want 2–${CHEST_COUNT}`);
  if (L.potions?.length !== POTION_COUNT) fail(L.key, `${L.potions?.length} potions, want ${POTION_COUNT}`);

  const t = L.temple, [bx0, by0, bz0, bx1, by1, bz1] = t.box;
  // the temple and its pit lie in the band, which is WALL round them beyond the lining
  if (by1 > C.BAND_TOP || t.exit[1] < C.FLOOR) fail(L.key, 'temple outside the band');
  for (let n = 0; n < SHELL_SAMPLES; n++) {
    const f = n / SHELL_SAMPLES, m = C.LINING + 1;
    const pts = [
      [Math.floor(bx0 - m + f * (bx1 - bx0 + 2 * m)), Math.floor(C.PIT_Y0 - m + f * (by1 - C.PIT_Y0 + 2 * m)), bz0 - m],
      [Math.floor(bx0 - m + f * (bx1 - bx0 + 2 * m)), Math.floor(C.PIT_Y0 - m + f * (by1 - C.PIT_Y0 + 2 * m)), bz1 + m - 1],
      [bx1 + m - 1, Math.floor(C.PIT_Y0 - m + f * (by1 - C.PIT_Y0 + 2 * m)), Math.floor(bz0 + f * (bz1 - bz0))],
      [bx0 - m, Math.floor(C.PIT_Y0 - m + f * (by1 - C.PIT_Y0 + 2 * m)), Math.floor(bz0 + f * (bz1 - bz0))],
    ];
    for (const p of pts) if (p[1] < C.BAND_TOP && at(p) !== E.WALL) { fail(L.key, `band cell ${p} round the temple is ${ELEMENTS[at(p)].key}, not WALL`); break; }
  }
  // its sites
  for (const a of t.altars) stands('altar', a);
  stands('refresher', t.refresher);
  for (const s of t.shop) { stands('shop pedestal', s); if (at([s[0], s[1] - 1, s[2]]) !== E.BRICK) fail(L.key, `shop site ${s} isn't on a pedestal`); }
  for (let x = t.pool[0]; x < t.pool[3]; x++) for (let y = t.pool[1]; y < t.pool[4]; y++) for (let z = t.pool[2]; z < t.pool[5]; z++)
    if (cell(x, y, z) !== E.WATER) { fail(L.key, `pool cell ${[x, y, z]} isn't water`); x = Infinity; break; }
  for (let x = t.exit[0]; x < t.exit[3]; x++) for (let y = t.exit[1]; y < t.exit[4]; y++) for (let z = t.exit[2]; z < t.exit[5]; z++)
    if (cell(x, y, z) !== E.EMPTY) { fail(L.key, `exit cell ${[x, y, z]} isn't air`); x = Infinity; break; }
  if (!solid(cell(t.exit[0], t.exit[1] - 1, t.exit[2]))) fail(L.key, 'the exit pit has no floor');
  // the entry shaft: open from the lowest layer's floor into the temple
  const sx = C.ESHAFT_X0 + C.ESHAFT_W / 2 - 1;
  for (let y = C.BIOME_Y0 - 1; y >= C.TY0 + C.LAND_H; y--) {
    if (y === C.LEDGE_A || y === C.LEDGE_B) continue;
    const id = cell(sx, y, C.TZC);
    if (id !== E.EMPTY) { fail(L.key, `entry shaft blocked at y ${y} (${ELEMENTS[id].key})`); break; }
  }
  const wang = !!DS_LEVEL_DEFS[level].kit;
  // a Wang level: the body's walk from the spawn reaches the temple, and every loot site
  if (wang) {
    const walk = wangWalk(level, L.spawn);
    if (!walk.inTemple) fail(L.key, 'no way down from the spawn to the temple (Wang walk)');
    for (const l of [...L.loot, ...L.chests, ...L.potions]) if (!walk.reached(l.x, l.y, l.z)) fail(L.key, `${l.kind ?? 'chest/potion'} site ${[l.x, l.y, l.z]} out of the walk's reach`);
    console.log(`${L.key}: Wang walk reaches ${walk.count} standing places${walk.inTemple ? ', the temple among them' : ''}`);
  }
  // the way down: from the spawn's crossing, down to the lowest layer's crossing over the entry shaft
  const start = level === 0 ? [C.LAYERS - 1, ...crossingOf(C, C.RAMP_X1, C.TZC)] : [C.LAYERS - 1, ...crossingOf(C, L.spawn[0], L.spawn[2])];
  const reach = reachable(T, C, start);
  const goal = [0, ...crossingOf(C, C.ESHAFT_X0, C.TZC)];
  // (the entry shaft's on the main row, which is open end to end: any crossing of row MAIN_ROW in layer 0 will do)
  const layer0 = [...reach].filter((k) => k.startsWith('0,') && k.endsWith(`,${C.MAIN_ROW}`));
  if (!wang && !layer0.length) fail(L.key, `no way down from the spawn to the temple (goal ${goal})`);
  // Mines: from the spawn, east into the mouth and down the ramp to the top layer, a cell at a time
  if (level === 0) {
    let y = L.spawn[1];
    // (a Wang level's ramp runs on to the entry shaft's hole in the hall's floor)
    const rampEnd = wang ? C.ENTRY_CX - GEOM.SHAFT_W / 2 : C.RAMP_X1;
    for (let x = L.spawn[0] + 1; x < rampEnd; x++) {
      // the highest floor in reach: a step up, else where the body falls to
      let ny = null;
      for (let yy = y + MAX_CLIMB; yy >= y - MAX_DROP && ny === null; yy--) if (feetAt(cell, x, C.RAMP_ZC, yy, yy + 1) === yy) ny = yy;
      if (ny === null) { fail(L.key, `the way from the spawn into the mountain is blocked at x ${x} (feet ${y})`); break; }
      y = ny;
    }
    if (y !== C.RAMP_FLOOR) fail(L.key, `the ramp ends at ${y}, not at ${C.RAMP_FLOOR}`);
    // ...and through the doorway into the main row
    if (!wang) for (let z = C.RAMP_ZC; z >= C.TZC; z--) if (feetAt(cell, C.RAMP_X1 - 1, z, C.TOP_FLOOR, C.TOP_FLOOR + 1) !== C.TOP_FLOOR) { fail(L.key, `no doorway from the ramp into the main row at z ${z}`); break; }
  }
  const lowest = Math.min(...[...reach].map((k) => +k.split(',')[0]));
  console.log(`${L.key}: spawn ${L.spawn}, ${L.loot.length} loot sites (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}), ${L.chests.length} chests, ${L.potions.length} potions${wang ? '' : `, ${reach.size} crossings reachable down to layer ${lowest}`}`);
});
console.log(failures ? `${failures} failure(s)` : 'descent levels OK');
process.exit(failures ? 1 : 0);
