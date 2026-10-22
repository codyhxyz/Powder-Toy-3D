// GPU: V1's shock under V2 on what only the GPU runs, through the integrated native engine on the outcome
// bench's bare simulation (tools/outcomes/engine-v2.js: src/v2/physics.js with its dynamics, no app). Every
// scene is a fresh box (a scene's heat and fire never reach the next), and each is judged by its outcome only
// (what is left once both engines have long landed), never by when: V1 falls about 6× faster in game time
// (SIM_GRAVITY at 240 steps/s, ~430 m/s², against V2's GRAVITY), a separate design question.
// Nitroglycerin (V1's fall law, dynamics-reference.js v1LiquidArrival: a lone cell from 9 cells at phase 0, its
// start row even, and 10 at phase 1; a stack by its top's fall from 9; shaders/v2/columns.js colShockLand):
// poured gently, dropped 8 cells, from 9 at phase 1, a stack whose top falls 8: all rest; a slab from 9 at phase
// 0 (onto a metal layer), from 10, a stack whose top falls 9: each goes off; its chain takes what V1's pressure
// front reaches (blasts.js dChargeFrontOver: a block 15 cells away). C-4: a lit cell sets off C-4 8 cells away,
// not 10 (V1's front); grains thrown down at it: sand never (V1: ½·16·V_MAX² < its shock 20), uranium does
// (shaders/v2/particles.js dShockHit, posted by blasts.js airborneEvents); mercury landing on it from 4 cells at
// phase 0 goes off, from 4 at phase 1 and from 3 it rests (columns.js colShockOnFall). The rules' CPU checks:
// tools/v2/shock-check.mjs, particle-deposition-check.mjs, blast-batch-check.mjs (V1's front); a chain under its
// own blast's pressure (V1 react.js setOff, crushP): airborne-react-check.mjs 9b'.
// One launch, one GPU slot, one part a launch (each builds its engines: --part nitro, --part c4). --v1 also
// runs the part on V1 (tools/outcomes/engine-v1.js, the same launch) and holds V2 to what V1 does there;
// without it V2 is held to V1's outcomes below.
//
//   node tools/v2/shock-browser-check.mjs --part nitro|c4 [--v1]
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';

// V2's amounts are f32 fills and packets, V1's whole cells: what V2 may leave over V1's (cells)
const V1_MATCH_CELLS = 1;
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const part = arg('--part');
if (!['nitro', 'c4'].includes(part)) { console.error('usage: node tools/v2/shock-browser-check.mjs --part nitro|c4 [--v1]'); process.exit(2); }
const withV1 = process.argv.includes('--v1');
let failures = 0;
const t0 = Date.now(), at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what} [${at()}]`); };

// the page side, the same for both engines: window.__shock = { e, count, amount }
async function setup(name) {
  const { createEngine } = await import(`/tools/outcomes/engine-${name}.js`);
  const e = createEngine(window.__harness.gpu);
  window.__shock = { e, async count(key) { const g = await e.read(), id = e.id(key); let n = 0; for (let i = 0; i < g.id.length; i++) if (g.id[i] === id) n++; return n; },
    // a liquid's amount in full cells, resting fills and flying packets once each (native-grid.js nativeTally):
    // V2's liquid spreads into thinner cells, so its cell count grows while its amount holds
    async amount(key) { return (await e.census()).liquid[e.nameOf(e.id(key))] ?? 0; } };
}
// Nitroglycerin scenes, each a fresh 32×48×32 box (the floor is row 0: a cell placed at row y0 falls at phase
// y0 & 1), each [name, boxes [[lo, hi, element]], seconds to settle, V1's outcome: 'rest' or 'off'].
// rest: poured gently (a block a cell up) and dropped 8 cells, 26 cells apart (past V1's front, 15); a slab from 9
// at phase 1 (row 9) and a 4×4×3 block whose top falls 8, each alone in the middle of its box (V1 measured,
// 2026-10-22: all rest). (Nearer a wall V1 sets those two off: its landing splash, move.js land, throws cells
// aside past nitroglycerin's shock speed, and one that reaches a wall goes off against it. V2 has no such rule.)
// off: a slab from 9 at phase 0 (row 10 onto a metal layer at row 0), a slab from 10, a 4×4×3 block whose
// top falls 9, each alone; the chain: a resting block and a block dropped 16 cells (4.8 m) 15 cells from it,
// both gone (V1's front); a block dropped 42 cells (12.6 m).
const NITRO_SCENES = [
  ['poured gently, and dropped 8 cells', [[[6, 1, 6], [9, 3, 9], 'NITRO'], [[22, 8, 22], [25, 8, 25], 'NITRO']], 1.2, 'rest'],
  ['a slab from 9 cells at phase 1', [[[14, 9, 14], [17, 9, 17], 'NITRO']], 1.2, 'rest'],
  ['a 4×4×3 block whose top falls 8', [[[14, 6, 14], [17, 8, 17], 'NITRO']], 1.2, 'rest'],
  ['a slab from 9 cells at phase 0', [[[12, 0, 12], [19, 0, 19], 'METAL'], [[14, 10, 14], [17, 10, 17], 'NITRO']], 1.0, 'off'],
  ['a slab from 10 cells', [[[14, 10, 14], [17, 10, 17], 'NITRO']], 1.0, 'off'],
  ['a 4×4×3 block whose top falls 9', [[[14, 7, 14], [17, 9, 17], 'NITRO']], 1.0, 'off'],
  ['the chain: a block dropped 4.8 m 15 cells from a resting one', [[[22, 1, 22], [25, 3, 25], 'NITRO'], [[22, 16, 4], [25, 18, 7], 'NITRO']], 1.6, 'off'],
  ['a block dropped 12.6 m', [[[14, 42, 14], [17, 44, 17], 'NITRO']], 2.2, 'off'],
];
async function nitroScenes(scenes) {
  const { e, amount } = window.__shock, out = [];
  for (const [, boxes, seconds] of scenes) {
    await e.create([32, 48, 32]);
    for (const [lo, hi, key] of boxes) e.box(lo, hi, key);
    await e.advance(0.05); const before = await amount('NITRO');
    await e.advance(seconds); out.push([+before.toFixed(2), +(await amount('NITRO')).toFixed(2)]);
  }
  await e.dispose();
  return out;
}
// C-4, each scene a fresh 32³ box (sides whole supertiles: common.js gridDims). A block's C-4 cells (4×2×4 from
// x0, 0, z0) and what is at a cell. The front: two blocks left alone, a lit cell (past its ignition point) with
// C-4 cells 8 and 10 taxicab cells from it, 11 or more from the blocks. Grains thrown down at a block at 25 m/s
// (a body-coupled launch: engine-v2.js box { v }): sand, then uranium. Mercury landing on C-4 (a liquid run's
// own law, V1 measured: from 4 cells at phase 0 it goes off, from 4 at phase 1 and 3 at phase 0 it rests): a
// 2×2 slab onto a 4×4 C-4 layer at row 0 (it lands at row 1) from rows 5 (phase 1) and 4 (phase 0, 3 cells),
// 24 cells apart; then onto a C-4 layer two tall (it lands at row 2) from row 6 (phase 0, 4 cells).
async function c4Scene() {
  const { e } = window.__shock, out = {};
  const block = async (x0, z0, h = 2) => { const g = await e.read(), id = e.id('C4'); let n = 0;
    for (let y = 0; y < h; y++) for (let z = z0; z < z0 + 4; z++) for (let x = x0; x < x0 + 4; x++) if (g.id[x + g.nx * (z + g.nz * y)] === id) n++; return n; };
  const at = async (x, y, z) => { const g = await e.read(); return e.nameOf(g.id[x + g.nx * (z + g.nz * y)]); };
  await e.create([32, 32, 32]);
  e.box([10, 0, 10], [13, 1, 13], 'C4'); e.box([2, 0, 24], [5, 1, 27], 'C4');
  await e.advance(0.05); out.rest0 = await block(10, 10); await e.advance(0.5); out.rest1 = await block(10, 10); out.other = await block(2, 24);
  e.box([26, 0, 18], [26, 0, 18], 'C4'); e.box([16, 0, 26], [16, 0, 26], 'C4');
  e.box([26, 0, 26], [26, 0, 26], 'C4', { T: 400 });
  await e.advance(0.25);
  out.source = await at(26, 0, 26); out.near = await at(26, 0, 18); out.far = await at(16, 0, 26); out.block0 = await block(10, 10);
  await e.create([32, 32, 32]);
  e.box([10, 0, 10], [13, 1, 13], 'C4'); await e.advance(0.05); out.sand0 = await block(10, 10);
  e.box([10, 20, 10], [13, 22, 13], 'SAND', { v: [0, -25, 0] });
  await e.advance(0.75); out.sand = await block(10, 10);
  await e.create([32, 32, 32]);
  e.box([2, 0, 24], [5, 1, 27], 'C4'); await e.advance(0.05); out.uranium0 = await block(2, 24);
  e.box([2, 20, 24], [5, 22, 27], 'URANIUM', { v: [0, -25, 0] });
  await e.advance(0.75); out.uranium = await block(2, 24);
  await e.create([32, 32, 32]);
  e.box([2, 0, 2], [5, 0, 5], 'C4'); e.box([26, 0, 26], [29, 0, 29], 'C4');
  e.box([3, 5, 3], [4, 5, 4], 'MERCURY'); e.box([27, 4, 27], [28, 4, 28], 'MERCURY');
  await e.advance(1.0); out.mercuryRest = [await block(2, 2, 1), await block(26, 26, 1)];
  await e.create([32, 32, 32]);
  e.box([14, 0, 14], [17, 1, 17], 'C4'); e.box([15, 6, 15], [16, 6, 16], 'MERCURY');
  await e.advance(1.0); out.mercuryOff = await block(14, 14);
  await e.dispose();
  return out;
}

const vite = await startVite({ harness: true });
let browser;
try {
  browser = await launchBrowser();
  const errors = [];
  const run = async (engine) => {
    const page = await openHarness(browser, vite, `/tools/harness/outcomes.html?engine=${engine}`, { errors, timeout: 20000 });
    await page.evaluate(setup, engine);
    const out = part === 'nitro' ? await page.evaluate(nitroScenes, NITRO_SCENES) : await page.evaluate(c4Scene);
    await page.close();
    console.log(`${engine}: ${JSON.stringify(out)} [${at()}]`);
    return out;
  };
  const v1 = withV1 ? await run('v1') : null;
  const v2 = await run('v2');
  // the amounts are sums of f32 fills: AMOUNT_EPS is far under one fill quantum and far over their rounding
  const AMOUNT_EPS = 1e-2, same = (a, b) => Math.abs(a - b) < AMOUNT_EPS;
  if (part === 'nitro') {
    for (const [name, o] of [['V1', v1], ['V2', v2]]) {
      if (!o) continue;
      NITRO_SCENES.forEach(([label, , , outcome], k) => {
        const [before, after] = o[k], v1After = v1 ? v1[k][1] : null;
        // rest: all of it left; off: none of it, or no more than V1 leaves (its chain's reach)
        const pass = outcome === 'rest' ? before > 10 && same(after, before) : before > 10 && after < before / 2 && after <= (v1After ?? 0) + V1_MATCH_CELLS;
        ok(pass, `${name}: ${label}: ${before} → ${after} cells of it (V1 ${outcome}${v1After === null ? '' : `, leaves ${v1After}`})`);
      });
    }
  } else {
    for (const [name, o] of [['V1', v1], ['V2', v2]]) {
      if (!o) continue;
      ok(o.rest0 > 10 && o.rest1 === o.rest0, `${name}: C-4 left alone stays: ${o.rest0} → ${o.rest1} cells`);
      // V1's front (blast.P 200, KEEP a cell: 8 cells over C-4's crushP 60); flung fire and heat take longer
      ok(o.source !== 'C4' && o.near !== 'C4' && o.far === 'C4' && o.block0 === o.rest1,
        `${name}: a lit C-4 cell sets off C-4 8 cells away, not 10: ${o.source}, ${o.near}, ${o.far}; the block ${o.block0}`);
      // V1 react.js shock: ½·μ·u² past 20, μ the grain's mass on a solid, u to V_MAX (common.js hitKE): sand's
      // ½·16·1² = 8 never; uranium's ½·191·u² past 20 from u = 0.46 cells/step (33 m/s), which its fall reaches
      ok(o.sand0 > 10 && o.sand === o.sand0, `${name}: sand thrown down at it at 25 m/s rests on it (V1: never past ½·16·V_MAX²): ${o.sand0} → ${o.sand} cells`);
      ok(o.uranium0 > 10 && o.uranium < o.uranium0 / 2, `${name}: uranium thrown at 25 m/s sets it off: ${o.uranium0} → ${o.uranium} cells`);
      ok(o.mercuryRest.every(n => n === 16), `${name}: mercury landing on C-4 from 4 cells at phase 1, and from 3, rests on it: ${o.mercuryRest.join(', ')} of 16 cells`);
      ok(o.mercuryOff < 16, `${name}: mercury landing on C-4 from 4 cells at phase 0 sets it off: ${o.mercuryOff} of 32 cells`);
    }
    if (v1) ok(v1.source === v2.source && v1.near === v2.near && v1.far === v2.far, `V2 sets off what V1 does: ${v1.near}/${v2.near}, ${v1.far}/${v2.far}`);
    if (v1) ok(JSON.stringify([v1.mercuryRest, v1.mercuryOff < 16]) === JSON.stringify([v2.mercuryRest, v2.mercuryOff < 16]), `V2's mercury landings are V1's: ${JSON.stringify(v1.mercuryRest)}/${JSON.stringify(v2.mercuryRest)}`);
  }
  ok(!errors.length, `no page errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
} finally {
  await browser?.close();
  await vite.close();
}
console.log(`${failures ? `${failures} FAILED` : 'all ok'} (${at()})`);
process.exit(failures ? 1 : 0);
