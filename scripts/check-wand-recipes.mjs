// Real GPU recipe integration on a small world. Owns its server and browser.
// node scripts/check-wand-recipes.mjs [--port 53243]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { launchBrowser, newTestPage } from '../tools/browser.mjs';

const i = process.argv.indexOf('--port');
const port = i < 0 ? 53243 : Number(process.argv[i + 1]);
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
let output = '', browser;
server.stdout.on('data', (b) => { output += b; });
server.stderr.on('data', (b) => { output += b; });
try {
  for (let n = 0; n < 100 && !output.includes('Local:'); n++) {
    assert.equal(server.exitCode, null, output);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(output, /Local:/);
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual' });   // no app boots here: the check steps its own Simulation
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(`${url}/__recipes__`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Wand recipe checks</title>' }));
  await page.goto(`${url}/__recipes__`);
  const report = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { Simulation } = await import('/src/sim.js');
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { PRESETS } = await import('/src/pov/wands/catalog.js');
    const { createWandRuntime } = await import('/src/pov/wands/runtime.js');
    const { createWandWorld } = await import('/src/pov/wands/world.js');
    const { addTarget } = await import('/src/pov/targets.js');
    const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
    const renderer = new THREE.WebGLRenderer(); renderer.autoClear = false; renderer.setSize(32, 32);
    const sim = new Simulation(renderer, 64, 32, 32), scene = new THREE.Scene();
    const volume = { position: v() }, results = [];
    const env = { renderer, scene, getSim: () => sim, getScale: () => 1, getVolume: () => volume, requestRender() {} };
    let runtime, removeTarget = () => {};
    const read = (x, y, z) => sim.readCell(x, y, z);
    const count = () => {
      const [a] = sim.readState(), c = {};
      for (let n = 0; n < a.length; n += 4) c[Math.round(a[n])] = (c[Math.round(a[n])] ?? 0) + 1;
      return c;
    };
    try {
      for (const preset of PRESETS) {
        let commands = [], lights = [], impulses = [], teleports = [], health = 1, checks = [];
        let cpuMs = 0, framesRun = 0, maxCpuMs = 0;
        const check = (ok, label) => checks.push({ ok: !!ok, label });
        runtime?.dispose(); removeTarget();
        const [a, b] = sim.blankState();
        const put = (x, y, z, id, temperature = ELEMENTS[id].temp) =>
          a.set([id, temperature, ELEMENTS[id].life, 0.125], sim.cellTexel(x, y, z) * 4);
        const wall = () => {
          for (let y = 0; y < 24; y++) for (let z = 2; z < 30; z++) put(26, y, z, E.WALL);
        };
        const id = preset.id;
        if (['acid-shotgun', 'stored-scrap-machinegun', 'double-explosion', 'delayed-second-explosion', 'teleport'].includes(id)) wall();
        if (['mining-vacuum', 'tunnel-cutter', 'water-extinguisher'].includes(id)) {
          put(14, 14, 16, E.ROCK, id === 'water-extinguisher' ? 800 : 20);
          put(14, 18, 16, E.ROCK);
          if (id === 'mining-vacuum') put(13, 14, 17, E.STONE);
          if (id === 'water-extinguisher') put(13, 14, 16, E.FIRE);
        }
        if (id === 'liquid-sponge') {
          for (let x = 14; x < 16; x++) for (let y = 13; y < 15; y++) for (let z = 15; z < 17; z++) put(x, y, z, E.WATER, 42);
        }
        if (id === 'stored-lava-mortar') {
          for (let x = 0; x < 64; x++) for (let z = 0; z < 32; z++) put(x, 1, z, E.WALL);
        }
        if (id === 'remote-black-hole') {
          put(47, 16, 16, E.ROCK); put(47, 17, 16, E.WALL); put(48, 17, 16, E.CLONE); put(9, 16, 16, E.ROCK);
        }
        sim.load(a, b); sim.updateBricks();
        const world = createWandWorld(env), queue = world.queue, setLights = world.setLights;
        world.queue = (c) => { const accepted = queue(c); if (accepted) commands.push({ effect: c.effect, at: c.center.toArray(), time: runtime.stats.time }); return accepted; };
        world.setLights = (ls) => { if (ls.length) lights = ls.map((l) => ({ ...l, position: l.position.toArray() })); setLights(ls); };
        runtime = createWandRuntime({ ...env, world });
        runtime.equip(preset); runtime.resetWorld();
        const player = { pos: v(8, 8.5, 16), vel: v(), onGround: false, inLiquid: false,
          applyImpulse: (dv) => impulses.push(dv.toArray()), teleport: (feet) => { teleports.push(feet.toArray()); player.pos.copy(feet); } };
        const ctx = { sim, dt: 0.05, stepsPerFrame: 1, eye: v(8, 14, 16), dir: id === 'recoil-flying' ? v(0, -1, 0) : v(1, 0, 0),
          primary: false, player, aim: { valid: false } };
        if (id === 'spark-machinegun') removeTarget = addTarget({ id: 'wand-test-target', alive: true,
          box(lo, hi) { lo.set(22, 10, 12); hi.set(25, 20, 20); }, hurt(amount) { health -= amount; } });
        const frame = async (fire = false) => {
          ctx.primary = fire;
          const start = performance.now();
          runtime.update(ctx);
          const elapsed = performance.now() - start;
          cpuMs += elapsed; maxCpuMs = Math.max(maxCpuMs, elapsed); framesRun++;
          check(runtime.stats.frameCommands <= 64 && runtime.stats.frameTransfers <= 2, 'bounded per-frame work');
          await new Promise(requestAnimationFrame);
        };
        const frames = async (n) => { for (let k = 0; k < n; k++) await frame(); };
        await frame(true); await frames(90);
        const first = count(), stored = runtime.stats.inventory;
        if (id === 'mining-vacuum') {
          check(read(14, 14, 16)[0][0] !== E.ROCK, 'fractures aimed rock');
          check(stored > 0, 'collects powder');
          check((first[E.STONE] ?? 0) + stored === 2, 'conserves mined and loose stone');
        } else if (id === 'tunnel-cutter') {
          check(read(14, 14, 16)[0][0] === E.STONE && read(14, 18, 16)[0][0] === E.ROCK, 'narrow drill leaves off-axis rock');
          check(lights.length > 0, 'drill supplies cold work light');
        } else if (id === 'acid-shotgun') {
          check((first[E.ACID] ?? 0) > 0, 'creates real acid at impacts');
          check(commands.filter((c) => c.effect === 'emit').length === 3, 'three pellets');
          check(read(26, 14, 16)[0][0] === E.WALL, 'does not replace wall');
        } else if (id === 'spark-machinegun') {
          check(health > 0 && health <= 0.77, `three nonlethal actor hits: health ${health}`);
          check(runtime.stats.casts === 1, 'burst prepaid as one cast');
        } else if (id === 'stored-scrap-machinegun' || id === 'stored-lava-mortar') {
          const element = id.includes('scrap') ? E.SCRAP : E.LAVA;
          check((first[element] ?? 0) > 0, 'deposits real stored matter');
          check((first[element] ?? 0) + stored === 256, `conserves starter matter: grid ${first[element] ?? 0}, stored ${stored}`);
          runtime.equip(preset); check(runtime.stats.inventory === stored, 'reequip does not refill');
        } else if (id === 'recoil-flying') check(impulses.some((p) => p[1] > 0), 'downward aim gives upward propulsion');
        else if (id === 'water-extinguisher') {
          check((first[E.WATER] ?? 0) > 0, 'creates water');
          check(read(14, 14, 16)[0][1] < 800, 'cools hot rock');
        } else if (id === 'liquid-sponge') {
          check(stored === 8 && !(first[E.WATER] ?? 0), 'absorbs all eight cells');
          ctx.dir.set(-1, 0, 0); ctx.eye.set(20, 14, 16);
          await frame(true); await frames(20);
          check((count()[E.WATER] ?? 0) + runtime.stats.inventory === 8, 'release conserves cells');
          check(runtime.stats.inventory < stored, 'releases stored water');
        } else if (id === 'remote-black-hole') {
          check(read(47, 16, 16)[0][0] === E.EMPTY, 'remote sphere erases rock');
          check(read(47, 17, 16)[0][0] === E.WALL && read(48, 17, 16)[0][0] === E.CLONE, 'protected materials survive');
          check(read(9, 16, 16)[0][0] === E.ROCK, 'near-caster rock survives');
          check(commands.filter((c) => c.effect === 'erase').every((c) => c.at[0] > 35), 'timer deploys remotely');
        } else if (id === 'double-explosion' || id === 'delayed-second-explosion') {
          const blasts = commands.filter((c) => c.effect === 'pressure');
          check(blasts.length === 2, 'exactly two explosions');
          check(blasts.every((c) => Math.abs(c.at[0] - 26) < 0.1), 'payloads execute at impact origin');
          check(read(24, 14, 16)[1][3] > 0, 'blast changes world pressure');
          if (blasts.length === 2) check(id === 'double-explosion' ? blasts[0].time === blasts[1].time : blasts[1].time - blasts[0].time >= 0.3, 'correct blast timing');
        } else if (id === 'ice-bridge') check([12, 13, 14, 15, 16, 17, 18].every((x) => read(x, 14, 16)[0][0] === E.ICE), 'connected ice span');
        else if (id === 'cave-lantern') check(lights.some((l) => l.position[0] > 20 && l.position[0] < 35), 'cold lantern deployed remotely in open air');
        else if (id === 'powder-and-ignition') {
          check((first[E.GUNPOWDER] ?? 0) > 0, 'first cast places gunpowder');
          check(read(16, 14, 16)[0][1] < 200, 'powder starts unlit');
          await frame(true); await frames(30);
          check(read(16, 14, 16)[0][1] >= 200 || read(13, 14, 16)[0][1] >= 200, 'second cast ignites actual deposit');
        } else if (id === 'teleport') check(teleports.length === 1 && player.pos.x > 20 && player.pos.x < 26, 'teleports to full-body clear near side');
        check(runtime.stats.mana >= 0 && Number.isFinite(runtime.stats.mana), 'finite nonnegative mana');
        check(renderer.getContext().getError() === 0, 'no WebGL errors');
        results.push({ recipe: id, ok: checks.every((c) => c.ok), failed: checks.filter((c) => !c.ok), commands: commands.length,
          cpuSubmissionMs: { mean: +(cpuMs / framesRun).toFixed(3), max: +maxCpuMs.toFixed(3) },
          stats: { casts: runtime.stats.casts, traces: runtime.stats.traceErrors, storage: runtime.stats.inventory, lastError: runtime.stats.lastError } });
      }
      return results;
    } finally { runtime?.dispose(); removeTarget(); sim.dispose(); renderer.dispose(); }
  });
  console.log('CPU timings include scheduling and GPU submission, not GPU execution or full-game rendering. Grid: 64×32×32.');
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, [], errors.join('\n'));
  assert.ok(report.every((r) => r.ok), 'Every recipe must pass physical-world assertions');
} finally {
  await browser?.close();
  if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
}
