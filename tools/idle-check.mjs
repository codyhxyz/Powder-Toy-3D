// GPU idle and wake (docs/webgpu.md D4, D5, F7), two stages, each its own
// Vite (tools/vite-server.mjs), within ~3 minutes on SwiftShader:
//
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
// Physics V2 (the only engine) runs the box: its certificate (PhysicsV2.asleep) and its ticks are the
// box's rest and steps. (V1's Simulation-level stage went with V1: the v1-oracle tag.)
//
//   node tools/idle-check.mjs [--stage app,run]
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const argv = process.argv.slice(2);
const STAGES = (argv.includes('--stage') ? argv[argv.indexOf('--stage') + 1] : 'app,run').split(',');
const BOX = '/?size=64&preset=empty&view=plain';
let failures = 0;

async function appStage(browser) {
  const vite = await startVite();
  const t0 = Date.now(), secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  try {
    const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 320, height: 200 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    // (the relay the UI asks for quota isn't running here)
    page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await page.goto(vite.url(BOX));
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
      ok(m.submits === 0 && m.callbacks === 0 && m.asleep && /^\d+$/.test(m.hud),
        `${after}: asleep, then ${m.submits} submits and ${m.callbacks} animation frames over 1 s, the HUD keeping its last rate '${m.hud}' (${secs()})`);
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
    await page.goto(vite.url(BOX));
    await page.waitForFunction(() => window.__app?.sim, null, { polling: 250, timeout: 150000 });
    await page.evaluate(() => { const a = window.__app; a.post.settings.taa = false; return a.test.ready(); });
    // running, as a player's session runs: unpaused, a step a frame (manual mode boots paused and parked)
    await page.evaluate(() => { const a = window.__app; a.settings.steps = 1; a.test.resume(); a.settings.paused = false; });
    const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
    const asleep = async (after) => {
      const t = Date.now();
      await page.waitForFunction(() => window.__app.loop.asleep, null, { polling: 250, timeout: 150000 });
      const m = await page.evaluate(async () => {
        const a = window.__app, v2 = a.physics.v2, ticks = () => v2.tick;
        const s0 = a.gpu.stats.submits, c0 = a.loop.callbacks, f0 = ticks();
        await new Promise((r) => setTimeout(r, 1000));
        return {
          submits: a.gpu.stats.submits - s0, callbacks: a.loop.callbacks - c0, steps: ticks() - f0, asleep: a.loop.asleep,
          paused: a.settings.paused, certified: v2.asleep, hud: document.querySelector('.stats b')?.textContent,
        };
      });
      ok(m.submits === 0 && m.callbacks === 0 && m.steps === 0 && m.asleep && !m.paused && m.certified && /^\d+$/.test(m.hud),
        `${after}: running, certified idle, asleep after ${((Date.now() - t) / 1000).toFixed(0)} s; then ${m.submits} submits, ${m.callbacks} animation frames, ${m.steps} steps over 1 s, the HUD keeping its last rate '${m.hud}' (${secs()})`);
    };
    ok(await page.evaluate(() => window.__app.physics.mode === 'v2' && window.__app.physics.active), 'the box runs Physics V2');
    await asleep('the empty box');
    // (steps taken: v2's ticks when it runs the box)
    const before = await page.evaluate(() => { const a = window.__app; return { frame: a.physics.v2.tick, version: a.sim.version, callbacks: a.loop.callbacks }; });
    // a rock on the floor (it settles in a few steps)
    await page.evaluate(async () => {
      const a = window.__app, { E } = await import('/src/elements.js');
      a.sim.paint({ center: new a.THREE.Vector3(32, 2, 32), radius: 2, shape: 0, tool: E.ROCK, rate: 1, replace: false });
    });
    const woke = await page.waitForFunction((f) => { const a = window.__app; return (a.physics.v2.tick) > f; }, before.frame, { polling: 100, timeout: 20000 }).then(() => true, () => false);
    ok(woke, 'a stroke wakes it: the steps run again');
    await asleep('the stroke settled');
    const after = await page.evaluate(async () => {
      const a = window.__app, { E } = await import('/src/elements.js');
      const c = await a.sim.census();
      return { frame: a.physics.v2.tick, version: a.sim.version, callbacks: a.loop.callbacks, rock: c[E.ROCK]?.n ?? 0 };
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
