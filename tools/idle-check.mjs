// GPU idle and wake (docs/webgpu.md D4, D5, F7), two stages, each its own
// Vite (tools/vite-server.mjs), within ~3 minutes on SwiftShader:
//
//   sim   the Simulation on the sim-check harness page (tools/harness/sim-check.*,
//         no app), a 32×16×32 window: a settled world certifies idle, its
//         steps then record nothing (no dispatch, the version still, the
//         clock running) and leave the state, the flow and both copies as
//         they were; every writer and setting drops the certificate and the
//         next step runs; matter in the air keeps it awake; the activity
//         counts' read (sim.counts.read, held back here, not the GPU) can't
//         certify after a write, a reset, a shift, a setting's round trip or
//         disposal, a late valid one still can, and a failed or empty read
//         never does; a fresh map runs both its settling steps first
//   app   the app's deep idle on a 64³ box (?preset=empty, plain view, TAA
//         off), paused: once settled, no submits and no animation frames over
//         a second; each waker (an input event, a resize, requestRender, a
//         setting, a stroke, a view whose pipeline isn't built yet) runs the
//         loop again, and it goes back to sleep
//   run   the same box with the simulation running (unpaused, a step a
//         frame: the player's default): it certifies idle and the loop
//         sleeps, with no submits, no animation frames and no steps over a
//         second and the HUD reading idle; a stroke wakes it, the steps run
//         again, and it sleeps again once the stroke has settled
//
// The particle layer's checks (a photon stroke wakes the world, the layer
// keeps it awake, a stale read after a particle stroke) wait for its port
// (src/wire/rays.js, U12): the stage says they're skipped.
//
//   node tools/idle-check.mjs [--stage sim,app,run]
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const argv = process.argv.slice(2);
const STAGES = (argv.includes('--stage') ? argv[argv.indexOf('--stage') + 1] : 'sim,app,run').split(',');
let failures = 0;

async function simStage(browser) {
  const vite = await startVite({ harness: true });
  try {
    const errors = [];
    const page = await openHarness(browser, vite, '/tools/harness/sim-check.html', { errors });
    const r = await page.evaluate(async () => {
      const h = window.__harness, { E } = h, gpu = h.gpu;
      const { SUPER_CELLS } = await import('/src/shaders/common.js');
      const sim = await h.make([32, 16, 32], { windowed: true, debug: false });
      await sim.prepare('fresh');
      const checks = [], skipped = [];
      const ok = (cond, message) => { if (!cond) throw new Error(message); };
      const bits = (a) => new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4);
      const same = (a, b) => { const x = bits(a), y = bits(b); return x.length === y.length && x.every((v, i) => v === y[i]); };
      // Steps until one records nothing (the version holds), the counts' read awaited between.
      const sleep = async (after) => {
        for (let i = 0; i < 48; i++) {
          const v = sim.version;
          sim.step();
          await sim.gpuSync();
          if (sim.idleRead) await sim.idleRead;
          if (v === sim.version) return i + 1;
        }
        throw new Error(`did not sleep after ${after}: ${JSON.stringify({ frame: sim.frame, certified: sim.idleCertified, age: sim.actAge, steps: sim.actSteps, counts: await sim.readCounts() })}`);
      };
      const stroke = (tool = E.SAND) => sim.paint({ center: sim.origin.clone().set(12, 12, 12), radius: 2, shape: 0, tool, rate: 1, replace: true });
      const wakes = (label, change) => {
        change();
        ok(!sim.idleCertified, `${label}: the certificate is dropped`);
        const v = sim.version;
        sim.step();
        ok(sim.version > v, `${label}: the next step runs`);
        checks.push(label);
      };
      // The counts' reads held until release() (their delivery, not the GPU).
      const read = sim.counts.read.bind(sim.counts);
      const hold = () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        sim.counts.read = (slot) => read(slot).then(async (b) => { await gate; return b; });
        return () => { release(); };
      };
      const unhold = () => { sim.counts.read = read; };
      try {
        // Stone in the other copy, then a clear of the current one: sleep has
        // to wait until both copies and their flags have settled.
        stroke(E.STONE);
        sim.clear();
        const n = await sleep('a clear over stone');
        const c = await sim.readCopies();
        for (const k of ['A', 'B', 'F']) ok(same(c[k][0], c[k][1]), `asleep, copy 0's ${k} = copy 1's`);
        const [a0, b0] = await sim.readState(), flow0 = await sim.readFlow();
        const frame = sim.frame, version = sim.version, s0 = { ...gpu.stats };
        let passes = 0;
        sim.onPass = () => passes++;
        for (let i = 0; i < 20; i++) sim.step();
        await sim.gpuSync();
        sim.onPass = null;
        const dispatches = gpu.stats.dispatches - s0.dispatches;
        ok(passes === 0 && dispatches === 0 && sim.version === version && sim.frame === frame + 20,
          `20 steps asleep: ${passes} passes, ${dispatches} dispatches, version +${sim.version - version}, frame +${sim.frame - frame}`);
        const [a1, b1] = await sim.readState(), flow1 = await sim.readFlow();
        ok(same(a0, a1) && same(b0, b1) && same(flow0, flow1), 'asleep, the state and the flow stay as they were');
        checks.push(`asleep (${n} steps after a clear): both copies the same, 20 steps with no pass and no dispatch, the version still, the clock running, the state and flow kept`);

        skipped.push('a photon stroke wakes the world, and the particle layer keeps it awake (the particle layer: src/wire/rays.js, U12)');
        wakes('a stroke wakes it', () => stroke());
        for (let i = 0; i < 8; i++) { sim.step(); await sim.gpuSync(); if (sim.idleRead) await sim.idleRead; }
        ok(!sim.idleCertified, 'falling sand does not certify idle');
        checks.push('falling sand keeps it awake (8 steps)');
        sim.clear(); await sleep('a clear');
        sim.snapshot();
        stroke(E.ROCK); await sleep('a rock stroke');
        wakes('an undo wakes it', () => ok(sim.undo(), 'a snapshot to undo'));
        await sleep('the undo');
        wakes('gravity wakes it', () => { sim.gravity += 0.005; });
        await sleep('gravity');
        wakes('skipSleeping off wakes it', () => { sim.skipSleeping = false; });
        for (let i = 0; i < 6; i++) { const v = sim.version; sim.step(); await sim.gpuSync(); ok(sim.version > v, 'with sleeping off every step runs'); }
        checks.push('with sleeping off every step runs (6 steps)');
        sim.skipSleeping = true; await sleep('sleeping back on');
        wakes('skipQuiet off wakes it', () => { sim.skipQuiet = false; });
        ok(!sim.quietOk, 'skipQuiet off: quiet skipping is off from the next map');
        sim.skipQuiet = true; sim.clear(); await sleep('skipQuiet back on');
        wakes('a shift wakes it', () => { sim.shift(SUPER_CELLS.x, 0); sim.syncCopies(); });
        await sleep('the shift');
        wakes('a load wakes it', () => sim.load(...sim.blankState()));
        await sleep('the load');
        wakes("a whole-grid writer's fresh flags wake it (the codec's unpack, sim.freshFlags)", () => sim.freshFlags());
        await sleep('freshFlags');

        // A late valid read: ordinary map rebuilds don't make it stale.
        let release = hold();
        sim.wake(); sim.updateActivity();
        const slow = sim.idleRead;
        ok(slow, 'a read in flight');
        for (let i = 0; i < 6; i++) sim.step();
        ok(sim.idleRead === slow, 'one read in flight through 6 steps (and their map rebuilds)');
        release(); await slow; unhold();
        await sim.gpuSync();
        const before = sim.version;
        sim.step();
        ok(sim.idleCertified && sim.version === before, 'the late valid read still certifies idle');
        checks.push('a late valid read survives map rebuilds and certifies idle');
        // A stale one: a write or a setting while it was in flight.
        skipped.push('a stale read after a photon stroke (the particle layer)');
        for (const [label, change] of [
          ['a stroke', () => stroke()],
          ['a reset', () => sim.clear()],
          ['a shift', () => { sim.shift(-SUPER_CELLS.x, 0); sim.syncCopies(); }],
          ["gravity's round trip", () => { const g = sim.gravity; sim.gravity = 0; sim.gravity = g; }],
          ["skipSleeping's round trip", () => { sim.skipSleeping = false; sim.skipSleeping = true; }],
          ["skipQuiet's round trip", () => { sim.skipQuiet = false; sim.skipQuiet = true; }],
        ]) {
          sim.clear(); await sleep(`a clear before ${label}`);
          release = hold();
          sim.wake(); sim.updateActivity();
          const pending = sim.idleRead;
          ok(pending, 'a read in flight');
          change();
          sim.step();   // a map rebuilt while the old read is pending: no second read
          ok(sim.idleRead === pending, 'one read in flight');
          release(); await pending; unhold();
          ok(!sim.idleCertified, `${label}: the stale read is rejected`);
          checks.push(`a stale read is rejected after ${label}`);
        }
        sim.clear(); await sleep('a clear');
        // A fresh map certified before its first step still runs both settling steps.
        sim.wake(); sim.updateActivity(); await sim.gpuSync(); await sim.idleRead;
        ok(sim.idleCertified && sim.actFresh, 'an empty map certified before its first step');
        for (let i = 0; i < 2; i++) { const v = sim.version; sim.step(); ok(sim.version > v, `settling step ${i + 1} runs`); }
        const settled = sim.version;
        sim.step();
        ok(sim.version === settled, 'asleep after both settling steps');
        checks.push('a fresh map runs both its settling steps before it sleeps');
        // A failed or empty read keeps it awake.
        for (const fail of [() => Promise.reject(new Error('injected read failure')), () => Promise.resolve(new ArrayBuffer(0))]) {
          sim.counts.read = fail;
          sim.wake(); sim.step(); await sim.gpuSync(); if (sim.idleRead) await sim.idleRead;
          ok(!sim.idleCertified, 'a failed read cannot certify idle');
        }
        unhold();
        await sleep('the failed reads');
        checks.push('a failed or empty read keeps it awake');
        // Disposal while a read is in flight.
        release = hold();
        sim.wake(); sim.updateActivity();
        const pending = sim.idleRead;
        sim.dispose(); release(); await pending;
        ok(!sim.idleCertified, 'a late read after dispose() is rejected');
        checks.push('dispose() rejects a late read');
        return { checks, skipped };
      } catch (e) {
        return { checks, skipped, error: String(e.stack || e) };
      } finally {
        if (!sim.disposed) sim.dispose();
      }
    });
    for (const c of r.checks) console.log(`ok   ${c}`);
    for (const s of r.skipped) console.log(`skip ${s}`);
    if (r.error) { failures++; console.log(`FAIL ${r.error}`); }
    const gpuFailures = await page.evaluate(() => window.__harness.failures);
    assert.deepEqual([...errors, ...gpuFailures], [], 'page and GPU errors');
    console.log(`sim: ${r.checks.length} idle/wake checks${r.error ? ', then a failure' : ''}; ${r.skipped.length} skipped; no page or GPU errors`);
    await page.close();
  } finally {
    await vite.close();
  }
}

async function appStage(browser) {
  const vite = await startVite();
  const t0 = Date.now(), secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  try {
    const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 320, height: 200 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    // (the relay the UI asks for quota isn't running here)
    page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await page.goto(vite.url('/?size=64&preset=empty&view=plain'));
    await page.waitForFunction(() => window.__app?.sim, null, { polling: 250, timeout: 150000 });
    await page.evaluate(() => { const a = window.__app; a.post.settings.taa = false; return a.test.ready(); });
    await page.evaluate(() => window.__app.test.resume());
    const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
    // Asleep, then a second of nothing: no submits, no animation frames.
    const settled = async (after) => {
      await page.waitForFunction(() => window.__app.loop.asleep, null, { polling: 250, timeout: 120000 });
      const m = await page.evaluate(async () => {
        const a = window.__app, s0 = a.gpu.stats.submits, c0 = a.loop.callbacks;
        await new Promise((r) => setTimeout(r, 1000));
        return { submits: a.gpu.stats.submits - s0, callbacks: a.loop.callbacks - c0, asleep: a.loop.asleep, hud: document.querySelector('.stats b')?.textContent };
      });
      ok(m.submits === 0 && m.callbacks === 0 && m.asleep && m.hud === 'idle',
        `${after}: asleep, then ${m.submits} submits and ${m.callbacks} animation frames over 1 s, the HUD reading '${m.hud}' (${secs()})`);
    };
    await settled('the box settled');
    const wakers = [
      ['an input event', () => page.mouse.move(160, 100)],
      ['a resize', () => page.setViewportSize({ width: 330, height: 200 })],
      ['requestRender', () => page.evaluate(() => window.__app.requestRender())],
      ['a setting (the brush radius)', () => page.evaluate(() => { window.__app.settings.radius += 1; })],
      ['a stroke (sim.paint)', () => page.evaluate(async () => {
        const a = window.__app, { E } = await import('/src/elements.js');
        a.sim.paint({ center: new a.THREE.Vector3(32, 8, 32), radius: 3, shape: 0, tool: E.ROCK, rate: 1, replace: false });
      })],
      ['a view whose pipeline is not built (heat)', () => page.evaluate(async () => {
        const { VIEWS } = await import('/src/views.js');
        window.__app.setView(VIEWS.find((v) => v.key === 'heat').id);
      })],
    ];
    const stats = () => page.evaluate(() => ({ callbacks: window.__app.loop.callbacks, ...window.__app.gpu.stats }));
    for (const [label, fn] of wakers) {
      const s0 = await stats();
      await fn();
      const woke = await page.waitForFunction((c) => window.__app.loop.callbacks > c, s0.callbacks, { polling: 50, timeout: 10000 }).then(() => true, () => false);
      ok(woke, `${label}: the loop runs again`);
      await settled(label);
      const s1 = await stats();
      console.log(`     (${s1.callbacks - s0.callbacks} animation frames, ${s1.submits - s0.submits} submits, ${s1.pipelinesCreated - s0.pipelinesCreated} pipelines built)`);
      // (the view's: built while the loop waited on it, then drawn)
      if (label.startsWith('a view')) {
        const v = await page.evaluate(() => ({ view: window.__app.settings.view, drawn: window.__app.view.volumeDrawn }));
        ok(s1.pipelinesCreated > s0.pipelinesCreated && v.view !== 0 && v.drawn, `${label}: its pipeline built, and the last frame before sleep drew the volume with it`);
      }
    }
    await page.evaluate(() => window.__app.test.park());
    ok(!errors.length, `no page errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
    await page.close();
  } finally {
    await vite.close();
  }
}

// The box with the simulation running: certified idle, the loop asleep; a stroke wakes it, then it sleeps again.
async function runStage(browser) {
  const vite = await startVite();
  const t0 = Date.now(), secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  try {
    const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 320, height: 200 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await page.goto(vite.url('/?size=64&preset=empty&view=plain'));
    await page.waitForFunction(() => window.__app?.sim, null, { polling: 250, timeout: 150000 });
    await page.evaluate(() => { const a = window.__app; a.post.settings.taa = false; return a.test.ready(); });
    // running, as a player's session runs: unpaused, a step a frame (manual mode boots paused and parked)
    await page.evaluate(() => { const a = window.__app; a.settings.steps = 1; a.test.resume(); a.settings.paused = false; });
    const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
    const asleep = async (after) => {
      const t = Date.now();
      await page.waitForFunction(() => window.__app.loop.asleep, null, { polling: 250, timeout: 150000 });
      const m = await page.evaluate(async () => {
        const a = window.__app, s0 = a.gpu.stats.submits, c0 = a.loop.callbacks, f0 = a.sim.frame;
        await new Promise((r) => setTimeout(r, 1000));
        return {
          submits: a.gpu.stats.submits - s0, callbacks: a.loop.callbacks - c0, steps: a.sim.frame - f0, asleep: a.loop.asleep,
          paused: a.settings.paused, certified: a.sim.idleCertified, hud: document.querySelector('.stats b')?.textContent,
        };
      });
      ok(m.submits === 0 && m.callbacks === 0 && m.steps === 0 && m.asleep && !m.paused && m.certified && m.hud === 'idle',
        `${after}: running, certified idle, asleep after ${((Date.now() - t) / 1000).toFixed(0)} s; then ${m.submits} submits, ${m.callbacks} animation frames, ${m.steps} steps over 1 s, the HUD reading '${m.hud}' (${secs()})`);
    };
    await asleep('the empty box');
    const before = await page.evaluate(() => ({ frame: window.__app.sim.frame, version: window.__app.sim.version, callbacks: window.__app.loop.callbacks }));
    // a rock on the floor (it settles in a few steps)
    await page.evaluate(async () => {
      const a = window.__app, { E } = await import('/src/elements.js');
      a.sim.paint({ center: new a.THREE.Vector3(32, 2, 32), radius: 2, shape: 0, tool: E.ROCK, rate: 1, replace: false });
    });
    const woke = await page.waitForFunction((f) => window.__app.sim.frame > f, before.frame, { polling: 100, timeout: 20000 }).then(() => true, () => false);
    ok(woke, 'a stroke wakes it: the steps run again');
    await asleep('the stroke settled');
    const after = await page.evaluate(async () => {
      const a = window.__app, { E } = await import('/src/elements.js');
      const c = await a.sim.census();
      return { frame: a.sim.frame, version: a.sim.version, callbacks: a.loop.callbacks, rock: c[E.ROCK]?.n ?? 0 };
    });
    ok(after.rock > 0 && after.version > before.version, `between: ${after.frame - before.frame} steps, ${after.callbacks - before.callbacks} animation frames, ${after.rock} rock cells`);
    await page.evaluate(() => window.__app.test.park());
    ok(!errors.length, `no page errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
    await page.close();
  } finally {
    await vite.close();
  }
}

const browser = await launchBrowser();
try {
  if (STAGES.includes('sim')) {
    try { await simStage(browser); } catch (e) { failures++; console.log(`FAIL sim: ${e.message}`); }
  }
  if (STAGES.includes('app')) {
    try { await appStage(browser); } catch (e) { failures++; console.log(`FAIL app: ${e.message}`); }
  }
  if (STAGES.includes('run')) {
    try { await runStage(browser); } catch (e) { failures++; console.log(`FAIL run: ${e.message}`); }
  }
} finally {
  await browser.close();
}
console.log(failures ? `\nidle-check: ${failures} failed` : '\nidle-check: PASS');
process.exit(failures ? 1 : 0);
