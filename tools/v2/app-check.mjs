// The new physics' fast version in the game (?physics=v2, src/v2/physics.js): a 64³ box boots with it,
// painting, erasing, a box preset and undo reach its cells, its ticks reach what today's renderer,
// picker and census read (direct readers / lazy legacy cache), and the flag turns off and on again. Manual mode: every tick
// is an explicit __app.test.step (60 a game second).
//
//   node tools/v2/app-check.mjs [--port N] [--shot dir] [--part edits|rest]   (--shot: a converged frame of the lab, mid-run)
import { launchBrowser, newTestPage, render } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const shotDir = argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : null;
let failures = 0;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };

// Two parts, each its own process and GPU slot under the 25 s cap (CLAUDE.md; tools/browser.mjs allows one
// launch a process): the edits, the lab and the flag toggles; then the rest fixture, on a box of its own.
const PARTS = { edits, rest };
const part = argv.includes('--part') ? argv[argv.indexOf('--part') + 1] : null;
if (!part) {
  let code = 0;
  for (const name of Object.keys(PARTS)) code |= spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...argv, '--part', name], { stdio: 'inherit' }).status ?? 1;
  process.exit(code);
}
if (!PARTS[part]) throw new Error(`--part ${Object.keys(PARTS).join(' or ')}`);
const vite = await startVite();
const browser = await launchBrowser();
try {
  const { page, errors } = await open(browser);
  await PARTS[part](page);
  ok(!errors.length, `${part}: no page errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await page.close();
} finally {
  await browser.close();
  await vite.close();
}
console.log(failures ? `${part}: ${failures} FAILED` : `${part}: all ok`);
process.exit(failures ? 1 : 0);

// a 64³ box under v2, parked, with the page helpers
async function open(browser) {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 400, height: 250 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(vite.url('/?size=64&preset=empty&view=plain&physics=v2'));
  await page.waitForFunction(() => window.__app?.sim, null, { polling: 250, timeout: 150000 });
  // (TAA off: its history converging keeps a live loop presenting: tools/idle-check.mjs does the same)
  await page.evaluate(() => { const a = window.__app; a.post.settings.taa = false; return a.test.ready(); });
  await page.evaluate(() => window.__app.test.park());
  // helpers in the page: v2's cells and today's state A, counted per element
  await page.evaluate(async () => {
    const a = window.__app, { E, TOOLS } = await import('/src/elements.js');
    window.__v2 = {
      E, ERASE: TOOLS.find((t) => t.key === 'ERASE').id,
      async v2Count(id) { a.physics.v2.sync(); const c = await a.physics.v2.readCells(); let n = 0, ymin = 1e9, fill = 0; for (let i = 0; i < c.id.length; i++) if (c.id[i] === id) { n++; fill += c.fill[i]; ymin = Math.min(ymin, Math.floor(i / (a.sim.g.nx * a.sim.g.nz))); } return { n, ymin, fill }; },
      async todayCount(id) { const c = await a.sim.census(); return c[id]?.n ?? 0; },
      paint(x, y, z, r, tool) { a.sim.paint({ center: new a.THREE.Vector3(x, y, z), radius: r, shape: 0, tool, rate: 1, replace: false }); },
    };
  });
  return { page, errors };
}

async function edits(page) {
  const st = await page.evaluate(() => ({ ...window.__app.physics, v2: !!window.__app.physics.v2 }));
  ok(st.mode === 'v2' && st.active && st.v2, `the box runs v2 (mode ${st.mode}, active ${st.active})`);

  // a ball of sand painted in mid-air falls and lands; today's state A shows it where v2 has it
  const sand = await page.evaluate(async () => {
    const a = window.__app, h = window.__v2;
    h.paint(32, 40, 32, 3, h.E.SAND);
    const before = await h.v2Count(h.E.SAND);
    a.test.step(150);   // 2.5 s: 40 cells at 2 g with a 12 m/s run speed take ~1.4 s
    const after = await h.v2Count(h.E.SAND);
    await a.gpu.fence();
    return { before, after, today: await h.todayCount(h.E.SAND) };
  });
  ok(sand.before.n > 50 && sand.after.n === sand.before.n && sand.after.ymin === 0 && sand.before.ymin > 30,
    `painted sand falls and lands: ${sand.before.n} grains from y ${sand.before.ymin} to y ${sand.after.ymin}, ${sand.after.n} kept`);
  ok(sand.today === sand.after.n, `the bridge: today's state A holds the ${sand.today} grains v2 holds (${sand.after.n})`);

  // water painted beside it: mass kept while it spreads
  const water = await page.evaluate(async () => {
    const a = window.__app, h = window.__v2;
    h.paint(20, 6, 20, 3, h.E.WATER);
    const m0 = await h.v2Count(h.E.WATER);
    a.test.step(120);
    const m1 = await h.v2Count(h.E.WATER);
    return { m0: m0.fill, m1: m1.fill, n1: m1.n };
  });
  ok(water.m0 > 50 && Math.abs(water.m1 - water.m0) < 1e-3, `painted water spreads with its mass kept: ${water.m0.toFixed(3)} → ${water.m1.toFixed(3)} cells over ${water.n1} cells`);

  // erasing (the eraser tool, as the right button paints it): v2's cells go
  const erased = await page.evaluate(async () => {
    const a = window.__app, h = window.__v2;
    h.paint(32, 1, 32, 8, h.ERASE);
    a.test.step(2);
    return { v2: (await h.v2Count(h.E.SAND)).n, today: await h.todayCount(h.E.SAND) };
  });
  ok(erased.v2 < sand.after.n && erased.v2 === erased.today, `erasing reaches v2: ${sand.after.n} → ${erased.v2} grains (today's state A: ${erased.today})`);

  // a box preset (the lab: glass tank, water, oil, a sand pile, lava under a plate), then undo
  const lab = await page.evaluate(async () => {
    const a = window.__app, h = window.__v2;
    a.physics.v2.sync();
    h.beforeLab = new Uint32Array(await a.gpu.readback.buffer(a.physics.v2.cells, 0, a.sim.g.slots * 16));
    a.loadPreset('lab');
    await a.test.ready();
    a.test.step(1);
    const h2o = async () => (await h.v2Count(h.E.WATER)).fill + (await h.v2Count(h.E.ICE)).n;
    const w0 = await h.v2Count(h.E.WATER), s0 = await h.v2Count(h.E.SAND), m0 = await h2o();
    a.test.step(120);
    const w1 = await h.v2Count(h.E.WATER), s1 = await h.v2Count(h.E.SAND), m1 = await h2o(), stats = await a.physics.v2.readStats();
    return { w0: w0.fill, w1: w1.fill, m0, m1, s0: s0.n, s1: s1.n, awake: stats.awake, units: stats.units };
  });
  // (its ice melts in the warm tank: water + ice is what stays, not water alone)
  ok(lab.w0 > 1000 && Math.abs(lab.m1 - lab.m0) < 1e-3 && lab.s0 > 0 && lab.s1 === lab.s0,
    `the lab preset runs: water ${lab.w0.toFixed(1)} → ${lab.w1.toFixed(1)} cells, water + ice ${lab.m0.toFixed(1)} → ${lab.m1.toFixed(1)}, sand ${lab.s0} → ${lab.s1}; ${lab.awake} of ${lab.units} bricks awake after 2 s`);
  if (shotDir) {
    await render(page);
    await page.screenshot({ path: `${shotDir}/v2-lab.png` });
    console.log(`     shot: ${shotDir}/v2-lab.png`);
  }
  const undone = await page.evaluate(async () => {
    const a = window.__app, h = window.__v2;
    a.undo();
    const words = new Uint32Array(await a.gpu.readback.buffer(a.physics.v2.cells, 0, a.sim.g.slots * 16));
    return { water: (await h.v2Count(h.E.WATER)).n, today: await h.todayCount(h.E.WATER), exact: words.every((w, i) => w === h.beforeLab[i]) };
  });
  ok(undone.exact, `undo restores exact pre-lab compact words: ${undone.water} fractional water cells in v2, ${undone.today} whole cells in the legacy projection`);

  // the flag off, then on again: today's step runs, then v2 picks up today's state
  const toggled = await page.evaluate(async () => {
    const a = window.__app, h = window.__v2;
    await a.setPhysics('v1');
    const off = { ...a.physics, v2: !!a.physics.v2 };
    const f0 = a.sim.frame;
    h.paint(40, 30, 40, 2, h.E.SAND);
    a.test.step(30);
    const stepped = a.sim.frame - f0;
    await a.setPhysics('v2');
    a.test.step(1);
    const on = { ...a.physics, v2: !!a.physics.v2 };
    return { off, on, stepped, v2: (await h.v2Count(h.E.SAND)).n, today: await h.todayCount(h.E.SAND) };
  });
  ok(!toggled.off.active && toggled.off.mode === 'v1' && toggled.stepped === 30, `setPhysics('v1'): today's physics steps the box (${toggled.stepped} steps)`);
  ok(toggled.on.active && toggled.v2 === toggled.today, `setPhysics('v2') again: v2 takes today's state (${toggled.v2} grains, today's ${toggled.today})`);
}

async function rest(page) {
  // A separate actor-free rest fixture: Lab intentionally has an enemy spawner,
  // and a preceding v1 run can leave legacy foam animating. Neither is an idle box.
  await page.evaluate(async () => {
    const a = window.__app, h = window.__v2;
    a.loadPreset('empty', false);
    await a.test.ready();
    a.test.park();
    h.paint(32, 20, 32, 3, h.E.SAND);
    h.paint(16, 5, 16, 2, h.E.WATER);
    const sand = await h.v2Count(h.E.SAND), water = await h.v2Count(h.E.WATER);
    if (!(sand.n > 0 && water.fill > 0)) throw new Error('Rest fixture must contain a heap and a puddle');
  });
  // at rest: ticks until v2 certifies the box idle, then the game running (unpaused): its loop sleeps and
  // v2 records nothing (a live settle at SwiftShader's frame rate would take minutes: the ticks go first)
  const rest = await page.evaluate(async () => {
    const a = window.__app, v2 = a.physics.v2, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Stepped ticks never certify (frame() does, in the live loop below): step until quiet by
    // tools/outcomes/engine-v2.js activity()'s rule. The dynamics' idle word refreshes only on its own readback.
    let ticks = 0, quiet = false;
    while (!quiet && ticks < 3600) {
      a.test.step(30); ticks += 30;
      const [s] = await Promise.all([v2.readStats(), v2.dynamics.readActivity()]);
      quiet = s.awake === 0 && v2.unwrittenSinceTick && v2.dynamics.isIdle;
    }
    a.test.resume();
    a.settings.paused = false;   // (manual mode boots paused)
    const t0 = performance.now();
    while (!a.loop.asleep && performance.now() - t0 < 10000) await sleep(250);
    // Drain work recorded before the loop slept, rather than charging its final
    // submission to the subsequent idle interval.
    await v2.idleRead;
    await a.gpu.fence();
    const asleep = a.loop.asleep && v2.asleep, tick0 = v2.tick, s0 = a.gpu.stats.submits;
    await sleep(1000);
    const out = { ticks, quiet, certified: v2.certified, asleep: asleep && a.loop.asleep && v2.asleep, waited: (performance.now() - t0) / 1000 - 1, run: v2.tick - tick0, submits: a.gpu.stats.submits - s0, why: { loop: a.loop.asleep, v2: v2.asleep, adapting: a.post.adapting, busy: a.loop.busy, rays: { active: a.sim.rays.active, holds: a.sim.rays.holds, live: a.sim.rays.live, seen: a.sim.rays.seen }, foam: a.sim.aeration?.bursting } };
    a.test.park();
    a.settings.paused = true;
    return out;
  });
  ok(rest.quiet && rest.certified && rest.asleep && rest.run === 0 && rest.submits === 0,
    `at rest: quiet within ${rest.ticks} ticks; running, certified idle, the loop asleep after ${rest.waited.toFixed(1)} s, then ${rest.run} ticks and ${rest.submits} submits over 1 s${rest.asleep ? '' : ` (${JSON.stringify(rest.why)})`}`);
}
