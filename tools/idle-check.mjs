// GPU idle/wake regression. Start Vite on your own port first:
// npm run dev -- --port 5197 --strictPort
// node tools/idle-check.mjs --port 5197
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const port = args[args.indexOf('--port') + 1] || '5197';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (/GL_INVALID|WebGL:|THREE.WebGLProgram: Shader Error/.test(m.text())) errors.push(m.text());
  });
  await page.route('**/__idle-check', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Idle check</title>' }));
  await page.goto(`http://localhost:${port}/__idle-check`);
  const checks = await page.evaluate(async () => {
    const { Simulation } = await import('/src/sim.js');
    const { E, itemByKey } = await import('/src/elements.js');
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { SUPER_CELLS } = await import('/src/shaders/common.js');
    const r = new THREE.WebGLRenderer();
    r.autoClear = false;
    const sim = new Simulation(r, 32, 16, 32, { windowed: true });
    const checks = [];
    const ok = (condition, message) => { if (!condition) throw new Error(message); };
    const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const read = (target, attachment = 0, flags = false) => {
      const Type = flags ? Uint8Array : target.textures[attachment].type === THREE.HalfFloatType ? Uint16Array : Float32Array;
      const data = new Type(target.width * target.height * (flags ? 1 : 4));
      r.readRenderTargetPixels(target, 0, 0, target.width, target.height, data, undefined, attachment);
      return data;
    };
    const sleep = async () => {
      for (let i = 0; i < 24; i++) {
        const v = sim.version;
        sim.step();
        await sim.idleRead;
        await new Promise((resolve) => setTimeout(resolve, 10));   // let the particle layer's own read finish
        if (v === sim.version) return;
      }
      throw new Error(`did not sleep after ${checks.at(-1)}: ${JSON.stringify({ frame: sim.frame, rays: sim.rays.active, certified: sim.idleCertified, age: sim.actAge, steps: sim.actSteps, share: [...read(sim.superShare)] })}`);
    };
    const stroke = (tool = E.SAND) => sim.paint({ center: sim.origin.clone().set(12, 12, 12), radius: 2, shape: 0, tool, rate: 1, replace: true });
    const wakes = (label, change) => {
      change();
      ok(!sim.idleCertified, `${label}: certificate invalidated`);
      const v = sim.version;
      sim.step();
      ok(sim.version > v, `${label}: step resumed`);
      checks.push(label);
    };
    try {
      // Populate the other history, then replace only the current one: sleep
      // must wait for both copies and their activity flags to settle.
      stroke(E.STONE);
      sim.clear();
      await sleep();
      for (let i = 0; i < 3; i++) ok(equal(read(sim.targets[0], i, i === 2), read(sim.targets[1], i, i === 2)), `settled history ${i}`);
      const state = sim.readState(), flow = read(sim.flowV), frame = sim.frame, version = sim.version;
      let passes = 0;
      sim.onPass = () => passes++;
      for (let i = 0; i < 20; i++) sim.step();
      ok(passes === 0 && sim.version === version && sim.frame === frame + 20, 'idle has zero passes/version churn, clock advances');
      ok(sim.readState().every((data, i) => equal(data, state[i])) && equal(read(sim.flowV), flow), 'idle preserves state and flow');
      sim.onPass = null;
      checks.push('sleep: settled histories/flags, zero passes, stable version/state/flow, advancing clock');

      wakes('particle paint wakes', () => stroke(itemByKey('PHOTON').id));
      ok(sim.rays.active, 'particle layer running');
      sim.clear(); await sleep();
      wakes('paint wakes', () => stroke());
      for (let i = 0; i < 8; i++) { sim.step(); await sim.idleRead; }
      ok(!sim.idleCertified, 'falling sand cannot sleep');
      checks.push('active material stays awake');
      sim.clear(); await sleep();
      sim.snapshot();
      stroke(E.ROCK); await sleep();
      wakes('undo wakes', () => ok(sim.undo(), 'undo exists'));
      await sleep();
      wakes('gravity wakes', () => { sim.gravity += 0.005; });
      await sleep();
      wakes('skipSleeping off wakes', () => { sim.skipSleeping = false; });
      for (let i = 0; i < 6; i++) { const v = sim.version; sim.step(); await sim.idleRead; ok(sim.version > v, 'disabled sleep keeps stepping'); }
      sim.skipSleeping = true; await sleep();
      wakes('skipQuiet off wakes immediately', () => { sim.skipQuiet = false; });
      ok(sim.mats.quiet.uniforms.uEnabled.value === false, 'skipQuiet rebuilt map immediately');
      sim.skipQuiet = true; sim.clear(); await sleep();
      wakes('shift wakes', () => { sim.shift(SUPER_CELLS.x, 0); sim.syncCopies(); });
      await sleep();
      wakes('load wakes', () => sim.load(...sim.blankState()));
      await sleep();
      wakes('direct state run wakes (codec/network path)', () => {
        sim.mats.copy.uniforms.tA.value = sim.stateA;
        sim.mats.copy.uniforms.tB.value = sim.stateB;
        sim.run(sim.mats.copy, sim.targets[1 - sim.cur]);
      });
      await sleep();

      // Delay delivery, not the GPU: a zero-share result from before an edit,
      // reset, shift, setting round trip, or disposal must never re-arm sleep.
      const originalRead = r.readRenderTargetPixelsAsync;
      let finishSlowRead;
      const slowGate = new Promise((resolve) => { finishSlowRead = resolve; });
      r.readRenderTargetPixelsAsync = async function (...args) { const data = await originalRead.apply(this, args); await slowGate; return data; };
      sim.wake(); sim.updateActivity();
      const slowRead = sim.idleRead;
      for (let i = 0; i < 6; i++) sim.step();
      ok(sim.idleRead === slowRead, 'slow read survives ordinary map rebuilds');
      finishSlowRead(); await slowRead;
      r.readRenderTargetPixelsAsync = originalRead;
      const beforeSleep = sim.version;
      sim.step();
      ok(sim.version === beforeSleep, 'late valid result can still sleep');
      checks.push('late valid result survives multiple map rebuilds');
      for (const [label, change] of [
        ['edit', () => stroke()],
        ['particle paint', () => stroke(itemByKey('PHOTON').id)],
        ['reset', () => sim.clear()],
        ['shift', () => { sim.shift(-SUPER_CELLS.x, 0); sim.syncCopies(); }],
        ['gravity round trip', () => { const g = sim.gravity; sim.gravity = 0; sim.gravity = g; }],
        ['skip round trip', () => { sim.skipSleeping = false; sim.skipSleeping = true; }],
        ['quiet round trip', () => { sim.skipQuiet = false; sim.skipQuiet = true; }],
      ]) {
        sim.clear(); await sleep();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        r.readRenderTargetPixelsAsync = async function (...args) { const data = await originalRead.apply(this, args); await gate; return data; };
        sim.wake();
        sim.updateActivity();
        const pending = sim.idleRead;
        ok(pending, 'read in flight');
        change();
        // Also rebuild maps while the old read is pending: no second read.
        sim.step();
        ok(sim.idleRead === pending, 'only one read in flight');
        release(); await pending;
        r.readRenderTargetPixelsAsync = originalRead;
        ok(!sim.idleCertified, `${label}: stale result rejected`);
        checks.push(`stale read rejected after ${label}`);
      }
      sim.clear(); await sleep();
      // A manual map build leaves fresh flags: even a valid certificate must
      // wait for both steps, not skip the map's first write.
      sim.wake(); sim.updateActivity(); await sim.idleRead;
      ok(sim.idleCertified && sim.actFresh, 'zero map certified before its first step');
      for (let i = 0; i < 2; i++) { const v = sim.version; sim.step(); ok(sim.version > v, 'settling step not skipped'); }
      const settledVersion = sim.version;
      sim.step(); ok(sim.version === settledVersion, 'sleep after both settling steps');
      checks.push('fresh map completes both settling steps before sleep');
      // Readback failure stays conservative, including an unwritten buffer.
      for (const fail of [async () => { throw new Error('injected read failure'); }, async () => undefined]) {
        r.readRenderTargetPixelsAsync = fail;
        sim.wake(); sim.step(); await sim.idleRead;
        ok(!sim.idleCertified, 'failed read cannot certify sleep');
      }
      r.readRenderTargetPixelsAsync = originalRead;
      await sleep();
      checks.push('readback rejection/unwritten buffer keep simulation awake');

      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      r.readRenderTargetPixelsAsync = async function (...args) { const data = await originalRead.apply(this, args); await gate; return data; };
      sim.wake(); sim.updateActivity();
      const pending = sim.idleRead;
      sim.dispose(); release(); await pending;
      r.readRenderTargetPixelsAsync = originalRead;
      ok(!sim.idleCertified, 'disposed result rejected');
      checks.push('dispose rejects late read');
      return checks;
    } finally {
      if (!sim.disposed) sim.dispose();
      r.dispose();
    }
  });
  assert.deepEqual(errors, [], 'browser/WebGL errors');
  console.log(checks.join('\n'));
  console.log(`PASS: ${checks.length} idle/wake checks; no browser/WebGL errors`);
} finally {
  await browser.close();
}
