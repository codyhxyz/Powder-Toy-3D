// GPU: V1's shock under V2 on what only the GPU runs, through the integrated native engine on the outcome
// bench's bare simulation (tools/outcomes/engine-v2.js: src/v2/physics.js with its dynamics, no app):
// nitroglycerin poured gently or dropped 2.4 m rests, dropped from past V1's own fall (3.0 m: its liquid falls
// without drag, dynamics-reference.js SHOCK_FALL_CELLS) goes off where its run lands (shaders/v2/columns.js
// colShockLand), and its chain takes what V1's pressure front reaches (blasts.js dChargeFrontOver: blocks 15
// cells away); a lit C-4 cell sets off C-4 8 cells away, not 10 (V1's front); C-4 hit by grains thrown down at
// it: sand never sets it off (V1: ½·16·V_MAX² < its shock 20), uranium does (shaders/v2/particles.js
// dShockHit, posted by blasts.js airborneEvents). The rules' CPU checks: tools/v2/shock-check.mjs,
// particle-deposition-check.mjs, blast-batch-check.mjs (V1's front); a chain under its own blast's pressure
// (V1 react.js setOff, crushP): airborne-react-check.mjs 9b'.
// One launch, one GPU slot, one part a launch (each builds its engines: --part nitro, --part c4). --v1 also
// runs the part on V1 (tools/outcomes/engine-v1.js, the same launch) and holds V2 to what V1 does there;
// without it V2 is held to V1's numbers below.
//
//   node tools/v2/shock-browser-check.mjs --part nitro|c4 [--v1]
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';

// V1 on the same scenes (--v1, Apple M-series, 2026-10-22). Nitroglycerin: poured gently and dropped 2.4 m it
// rests; dropped 4.8 m it goes off as it lands, its chain taking both resting blocks 15 cells away (none of
// the three left 1.5 s on); dropped 12.6 m, alone by then, it goes off and none is left 2 s on.
const V1_LEFT = { short: 0, high: 0 };
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
// Nitroglycerin, on a 32×48×32 box: a block resting a cell over the floor; one dropped 8 cells (2.4 m, short of
// V1's own fall) 15 cells from it; one dropped 16 (4.8 m, past it: V1's goes off) 15 from the first; then one
// dropped 42 (12.6 m) 15 from the two others. Each block 4×3×4 cells.
async function nitroScene() {
  const { e, amount } = window.__shock, out = {};
  await e.create([32, 48, 32]);
  const r = (v) => +v.toFixed(2);
  e.box([22, 1, 22], [25, 3, 25], 'NITRO');
  await e.advance(0.05); out.gentle0 = r(await amount('NITRO')); await e.advance(0.6); out.gentle1 = r(await amount('NITRO'));
  e.box([4, 8, 22], [7, 10, 25], 'NITRO');
  await e.advance(0.05); out.low0 = r(await amount('NITRO')); await e.advance(1); out.low1 = r(await amount('NITRO'));
  e.box([22, 16, 4], [25, 18, 7], 'NITRO');
  out.short = [];
  let start = e.time;
  for (const s of [0.05, 0.3, 0.45, 0.6, 0.9, 1.55]) { await e.advance(s - (e.time - start)); out.short.push([+(e.time - start).toFixed(3), r(await amount('NITRO'))]); }
  e.box([4, 42, 4], [7, 44, 7], 'NITRO');
  out.high = []; start = e.time;
  for (const s of [0.05, 0.3, 0.5, 1.35, 1.6, 2.05]) { await e.advance(s - (e.time - start)); out.high.push([+(e.time - start).toFixed(3), r(await amount('NITRO'))]); }
  await e.dispose();
  return out;
}
// C-4, on a 32³ box (sides whole supertiles: common.js gridDims): two blocks on the floor left alone; a lit
// cell (past its ignition point) with C-4 cells 8 and 10 taxicab cells from it, 11 or more from the blocks; sand
// thrown down at one block at 25 m/s, then uranium at the other (a body-coupled launch: engine-v2.js box { v })
async function c4Scene() {
  const { e } = window.__shock, out = {};
  await e.create([32, 32, 32]);
  // a block's C-4 cells (4×2×4 from x0, 0, z0), and what is at a cell
  const block = async (x0, z0) => { const g = await e.read(), id = e.id('C4'); let n = 0;
    for (let y = 0; y <= 1; y++) for (let z = z0; z < z0 + 4; z++) for (let x = x0; x < x0 + 4; x++) if (g.id[x + g.nx * (z + g.nz * y)] === id) n++; return n; };
  const at = async (x, y, z) => { const g = await e.read(); return e.nameOf(g.id[x + g.nx * (z + g.nz * y)]); };
  e.box([10, 0, 10], [13, 1, 13], 'C4'); e.box([2, 0, 24], [5, 1, 27], 'C4');
  await e.advance(0.05); out.rest0 = await block(10, 10); await e.advance(0.5); out.rest1 = await block(10, 10); out.other = await block(2, 24);
  e.box([26, 0, 18], [26, 0, 18], 'C4'); e.box([16, 0, 26], [16, 0, 26], 'C4');
  e.box([26, 0, 26], [26, 0, 26], 'C4', { T: 400 });
  await e.advance(0.25);
  out.source = await at(26, 0, 26); out.near = await at(26, 0, 18); out.far = await at(16, 0, 26); out.block0 = await block(10, 10);
  e.box([10, 20, 10], [13, 22, 13], 'SAND', { v: [0, -25, 0] });
  await e.advance(0.75); out.sand = await block(10, 10); out.other0 = await block(2, 24);
  e.box([2, 20, 24], [5, 22, 27], 'URANIUM', { v: [0, -25, 0] });
  await e.advance(0.75); out.uranium = await block(2, 24);
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
    const out = await page.evaluate(part === 'nitro' ? nitroScene : c4Scene);
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
      const short1 = o.short.at(-1)[1], high0 = o.high[0][1], high1 = o.high.at(-1)[1];
      ok(o.gentle0 > 10 && same(o.gentle1, o.gentle0), `${name}: nitroglycerin poured gently rests: ${o.gentle0} → ${o.gentle1} cells of it`);
      ok(o.low0 > o.gentle1 + 10 && same(o.low1, o.low0), `${name}: dropped 2.4 m, short of V1's own fall, it lands and rests: ${o.low0} → ${o.low1}`);
      ok(o.short[0][1] > o.low1 + 10, `${name}: then a block dropped 4.8 m: ${o.short[0][1]} cells of it in all`);
      // V1 react.js: past its own fall it goes off as it lands; its chain takes both resting blocks 15 cells away
      // (V1's front: setOff past crushP, dynamics-reference.js v1FrontOn)
      const v1Short = v1 ? v1.short.at(-1)[1] : V1_LEFT.short;
      ok(short1 <= v1Short + V1_MATCH_CELLS, `${name}: dropped 4.8 m it goes off as it lands and takes the resting blocks 15 cells away: ${o.short.map(s => s.join(' s: ')).join(', ')} (V1 leaves ${v1Short})`);
      const v1High = v1 ? v1.high.at(-1)[1] : V1_LEFT.high;
      ok(high0 > 10 && high1 <= v1High + V1_MATCH_CELLS, `${name}: dropped 12.6 m it goes off where it lands, its chain leaving what V1's leaves: ${o.high.map(s => s.join(' s: ')).join(', ')} (V1 leaves ${v1High})`);
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
      ok(o.sand === o.rest1, `${name}: sand thrown down at it at 25 m/s rests on it (V1: never past ½·16·V_MAX²): ${o.rest1} → ${o.sand} cells`);
      ok(o.other === o.rest1 && o.other0 === o.other && o.uranium < o.other / 2, `${name}: uranium thrown at 25 m/s sets the other block off: ${o.other} → ${o.other0} → ${o.uranium} cells`);
    }
    if (v1) ok(v1.source === v2.source && v1.near === v2.near && v1.far === v2.far, `V2 sets off what V1 does: ${v1.near}/${v2.near}, ${v1.far}/${v2.far}`);
  }
  ok(!errors.length, `no page errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
} finally {
  await browser?.close();
  await vite.close();
}
console.log(`${failures ? `${failures} FAILED` : 'all ok'} (${at()})`);
process.exit(failures ? 1 : 0);
