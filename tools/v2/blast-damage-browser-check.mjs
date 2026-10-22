// GPU: a blast's damage under V2 against V1's, on the outcome bench's bare simulations (tools/outcomes/engine-v1.js and
// engine-v2.js, no app), each scene a fresh box, judged by what is left. V1 react.js breaks a solid when the pressure
// difference across it passes hard·P_BREAK_PER_HARD and sets an explosive off past its crushP, both on its front (a
// cell a step, KEEP a cell); V2's batch reads the same front from its sources (shaders/v2/blasts.js damageCharges; the
// CPU twin dynamics-reference.js chargeBatchDamage, tools/v2/blast-batch-check.mjs). One part a launch, one GPU slot:
//   walls   a lit 2×2×2 C-4 block 2 cells from ROCK and METAL walls, 4 from a BRICK wall, 6 under a GLASS ceiling:
//           the cells of each it breaks (V1: rock's face within 2 taxicab cells, metal never, brick within 8, glass 11);
//           a lit 9-cell TNT slab against a 9-cell nitroglycerin puddle of the same cells, each 4 cells from a glass
//           wall: the glass each breaks (V1: blast.P 148 against 183, about level)
//   block   a 6×6×6 C-4 block lit at a corner: its C-4 left each 1/60 s (V1: a layer a step, 240 steps/s)
//   rocket  the rocket (shaders/povTools.js rocketWGSL; V2: native forcing) 1.5 cells off a rock wall, a wood wall
//           and a sand floor: the rock and wood it breaks, the fire it leaves, the sand it moves (V1: none, its
//           shove walled in by the bed)
//
//   node tools/v2/blast-damage-browser-check.mjs --part walls|block|rocket [--engine v1|v2 [--v1 '<v1 json>']]
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
// several parts, comma-separated, run in turn in one launch (each prints as it ends)
const parts = (arg('--part') ?? '').split(',');
if (!parts.every(p => ['walls', 'block', 'rocket'].includes(p))) { console.error('usage: node tools/v2/blast-damage-browser-check.mjs --part walls|block|rocket[,...]'); process.exit(2); }
const part = parts[0];
let failures = 0;
const t0 = Date.now(), at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what} [${at()}]`); };

async function setup(name) {
  const { createEngine } = await import(`/tools/outcomes/engine-${name}.js`);
  const e = createEngine(window.__harness.gpu);
  const count = async (key, lo = [0, 0, 0], hi = [1e9, 1e9, 1e9]) => { const g = await e.read(), id = e.id(key); let n = 0;
    for (let y = lo[1]; y <= Math.min(hi[1], g.ny - 1); y++) for (let z = lo[2]; z <= Math.min(hi[2], g.nz - 1); z++) for (let x = lo[0]; x <= Math.min(hi[0], g.nx - 1); x++) if (g.id[x + g.nx * (z + g.nz * y)] === id) n++;
    return n; };
  window.__blast = { e, count };
}
async function wallScene() {
  const { e, count } = window.__blast, out = {};
  await e.create([32, 32, 32]);
  const rock = [[17, 0, 10], [18, 12, 21]], brick = [[6, 0, 10], [9, 12, 21]], metal = [[11, 0, 17], [16, 12, 18]], glass = [[6, 8, 6], [18, 8, 16]];
  for (const [[lo, hi], key] of [[rock, 'ROCK'], [brick, 'BRICK'], [metal, 'METAL'], [glass, 'GLASS']]) e.box(lo, hi, key);
  await e.advance(0.05);
  const before = { rock: await count('ROCK', ...rock), brick: await count('BRICK', ...brick), metal: await count('METAL', ...metal), glass: await count('GLASS', ...glass) };
  e.box([14, 1, 14], [15, 2, 15], 'C4', { T: 400 });
  await e.advance(0.5);
  out.broken = { rock: before.rock - await count('ROCK', ...rock), brick: before.brick - await count('BRICK', ...brick),
    metal: before.metal - await count('METAL', ...metal), glass: before.glass - await count('GLASS', ...glass) };
  out.c4Left = await count('C4');
  return out;
}
async function chargeScene(key) {
  const { e, count } = window.__blast;
  await e.create([32, 32, 32]);
  e.box([4, 0, 4], [27, 0, 27], 'METAL'); const wall = [[20, 1, 8], [20, 12, 23]]; e.box(...wall, 'GLASS');
  await e.advance(0.05); const glass0 = await count('GLASS', ...wall);
  e.box([15, 1, 14], [17, 1, 16], key, { T: key === 'TNT' ? 300 : 250 });
  await e.advance(0.5); return { glass: glass0 - await count('GLASS', ...wall), left: await count(key), shards: await count('SHARDS'), lava: await count('LAVA') };
}
async function block() {
  const { e, count } = window.__blast, out = [];
  await e.create([32, 32, 32]);
  e.box([13, 0, 13], [18, 5, 18], 'C4'); await e.advance(0.05);
  out.push(await count('C4'));
  e.box([13, 0, 13], [13, 0, 13], 'C4', { T: 400 });
  for (let k = 0; k < 20; k++) { await e.advance(1 / 60); out.push(await count('C4')); }
  return out;
}
async function rocket(only) {
  const { e, count } = window.__blast, out = {};
  const { povGpu } = await import('/src/pov/gpu.js');
  // the rocket's edit, as rocket.tool.js records it (its kernels build on first use: retried until recorded)
  const fire = async (center) => { const r = 9, box = e.sim.touchCentres([center.x - r, center.y - r, center.z - r], [center.x + r, center.y + r, center.z + r]);
    for (let i = 0; i < 200; i++) { if (povGpu(e.sim).edit('povRocket', box, { center, frame: 1 })) return true; await new Promise(res => setTimeout(res, 20)); }
    return false; };
  for (const [name, key, lo, hi, center] of [['rock', 'ROCK', [16, 0, 4], [19, 16, 27], { x: 14.5, y: 8.5, z: 16.5 }], ['wood', 'WOOD', [16, 0, 4], [19, 16, 27], { x: 14.5, y: 8.5, z: 16.5 }],
    ['sand', 'SAND', [0, 0, 0], [31, 5, 31], { x: 16.5, y: 7.5, z: 16.5 }]]) {
    if (only && name !== only) continue;
    await e.create([32, 32, 32]); e.box(lo, hi, key); await e.advance(name === 'sand' ? 0.6 : 0.05);
    const before = await count(key, lo, hi), crater = await count(key, [10, 0, 10], [22, 16, 22]);
    out[name] = { fired: await fire(center) };
    await e.advance(1 / 60); out[name].fire = await count('FIRE');
    await e.advance(0.6);
    out[name].left = await count(key, lo, hi); out[name].before = before; out[name].crater = crater - await count(key, [10, 0, 10], [22, 16, 22]);
    if (name !== 'sand') { const debris = key === 'ROCK' ? 'STONE' : 'SAWDUST'; out[name].debris = await count(debris); }
  }
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
    let out;
    for (const extra of parts.slice(1)) { const o = await page.evaluate(extra === 'block' ? block : extra === 'rocket' ? rocket : wallScene); console.log(`${engine} ${extra}: ${JSON.stringify(o)} [${at()}]`); }
    if (part === 'walls') { out = {}; for (const [name, fn, a] of [['walls', wallScene], ['TNT', chargeScene, 'TNT'], ['NITRO', chargeScene, 'NITRO']]) {
      out[name] = await page.evaluate(fn, a); console.log(`${engine} ${name}: ${JSON.stringify(out[name])} [${at()}]`); }
      out = { ...out.walls, TNT: out.TNT, NITRO: out.NITRO }; }
    else if (part === 'rocket') { out = {}; for (const name of ['rock', 'sand', 'wood']) { Object.assign(out, await page.evaluate(rocket, name)); console.log(`${engine} rocket ${name}: ${JSON.stringify(out[name])} [${at()}]`); } }
    else out = await page.evaluate(block);
    await page.evaluate(() => window.__blast.e.dispose());
    await page.close();
    console.log(`${engine}: ${JSON.stringify(out)} [${at()}]`);
    return out;
  };
  // --engine v1|v2: one engine a launch (V2 builds its kernels cold, so both rarely fit one slot); the other's
  // outcome from its own launch's printed line, --v1 '<json>'
  // (V1's outcome: the v1-oracle tag's run of this script, --engine v1, printed and passed back as --v1 '<json>')
  const only = arg('--engine') ?? 'v2', given = arg('--v1');
  if (only === 'v1') throw new Error('V1 is the v1-oracle tag (git worktree add <dir> v1-oracle): run this from that checkout --engine v1');
  const v1 = given ? JSON.parse(given) : null;
  const v2 = only === 'v1' ? null : await run('v2');
  if (!v1 || !v2) console.log('one engine: no comparison');
  const near = (a, b, slack) => Math.abs(a - b) <= slack;
  if (!v1 || !v2) { /* (printed above) */ } else if (part === 'walls') {
    ok(v2.broken.metal === 0 && v1.broken.metal === 0, `metal never breaks: V1 ${v1.broken.metal}, V2 ${v2.broken.metal}`);
    for (const key of ['rock', 'brick', 'glass']) ok(near(v2.broken[key], v1.broken[key], Math.max(2, v1.broken[key] * 0.35)), `${key} broken: V1 ${v1.broken[key]}, V2 ${v2.broken[key]}`);
    ok(v1.TNT.glass > 0 && v1.NITRO.glass > 0 && near(v2.TNT.glass, v1.TNT.glass, Math.max(2, v1.TNT.glass * 0.35)) && near(v2.NITRO.glass, v1.NITRO.glass, Math.max(2, v1.NITRO.glass * 0.35)),
      `TNT against nitroglycerin, glass broken: V1 ${v1.TNT.glass}/${v1.NITRO.glass}, V2 ${v2.TNT.glass}/${v2.NITRO.glass}`);
  } else if (part === 'block') {
    const gone = o => o.findIndex(n => n === 0);
    ok(v1[0] === 216 && v2[0] === 216, 'the block');
    ok(gone(v2) > 0 && gone(v1) > 0 && gone(v2) <= gone(v1) + 2, `all of it off within 1/60 s ×: V1 ${gone(v1)}, V2 ${gone(v2)} (V1 ${v1.join(',')}; V2 ${v2.join(',')})`);
  } else {
    for (const key of ['rock', 'wood', 'sand']) ok(v1[key].fired && v2[key].fired, `${key}: the rocket fired on both`);
    ok(v2.rock.fire > 0 && v1.rock.fire > 0, `fire at the blast: V1 ${v1.rock.fire}, V2 ${v2.rock.fire}`);
    for (const key of ['rock', 'wood']) ok(near(v2[key].before - v2[key].left, v1[key].before - v1[key].left, Math.max(3, (v1[key].before - v1[key].left) * 0.4)),
      `${key} broken: V1 ${v1[key].before - v1[key].left}, V2 ${v2[key].before - v2[key].left}`);
    ok(near(v2.sand.crater, v1.sand.crater, Math.max(4, v1.sand.crater * 0.5)), `sand moved from the crater: V1 ${v1.sand.crater}, V2 ${v2.sand.crater}`);
  }
  ok(!errors.length, `no page errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
} finally {
  await browser?.close();
  await vite.close();
}
console.log(`${failures ? `${failures} FAILED` : 'all ok'} (${at()})`);
process.exit(failures ? 1 : 0);
