// Real-GPU: the laser cannon under V2 burns V2's own cells. One shot along a row holding a full cell of
// water, a thin film (an eighth of a cell) and a cell of rock: the water is V1's steam at VAPOR_T, the rock
// V1's smoke, and the film holds exactly its eighth of V1's change (it was a full steam cell at VAPOR_T:
// V2 imported V1's apply). One GPU slot; run only when the shared launcher permits it.
// node tools/v2/laser-browser-check.mjs --port 5391
import { launchBrowser, newTestPage, ready } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';

const t0 = Date.now();
// (the import graph is built before the GPU slot is taken: the slot is for the GPU)
const vite = await startVite({ warmupEntries: ['/src/main.js', '/src/app.js', '/src/pov/index.js', '/src/pov/gpu.js', '/src/v2/layout.js', '/src/v2/interactions.js', '/src/shaders/common.js'] });
console.log(`info vite warm in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
let browser, failed = false;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 320, height: 240 } });
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.log('page error:', e.message); });
  page.on('console', m => { if (m.type() === 'log' && /^(ok|FAIL|info) /.test(m.text())) console.log(m.text()); });
  await page.goto(vite.url('/?size=64&preset=empty&physics=v2'));
  await ready(page);
  console.log(`info app up at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const result = await page.evaluate(async () => {
    const a = __app, { E } = await import('/src/elements.js');
    const { cellSlot } = await import('/src/shaders/common.js');
    const { makeMaterial, energyOf, cid, cTq, FULL } = await import('/src/v2/layout.js');
    const { povGpu } = await import('/src/pov/gpu.js');
    const { LASER } = await import('/src/shaders/povBore.js');
    const { nativeLaserReady } = await import('/src/v2/interactions.js');
    const t = performance.now(), info = (m) => console.log(`info ${((performance.now() - t) / 1000).toFixed(1)} s ${m}`);
    a.test.park(); a.settings.paused = true;
    const sim = a.sim, gpu = a.gpu, v2 = a.physics.v2;
    await v2.ready;
    info('V2 ready');
    // only the shot's kernels (the whole POV set is compiled on entering POV, not needed here)
    const reachKernel = povGpu(sim)._laserReachNative();
    while (!nativeLaserReady(sim) || reachKernel.state !== 'ready') await new Promise(r => setTimeout(r, 25));
    info('laser kernels built');
    const out = [];
    const check = (ok, message) => { out.push(`${ok ? 'ok' : 'FAIL'} ${message}`); return ok; };
    // the world: air at 20 °C, and along the row y = z = 32: water, a film, rock
    const words = new Uint32Array(sim.g.slots * 4), air = makeMaterial(E.EMPTY, 20).core;
    for (let s = 0; s < sim.g.slots; s++) words.set(air, s * 4);
    const cells = { water: [20, 32, 32, makeMaterial(E.WATER, 20, FULL)], film: [30, 32, 32, makeMaterial(E.WATER, 20, FULL / 8)], rock: [40, 32, 32, makeMaterial(E.ROCK, 20)] };
    for (const [x, y, z, m] of Object.values(cells)) words.set(m.core, cellSlot(sim.g, x, y, z) * 4);
    const snapshot = gpu.createBuffer({ label: 'laser check cells', size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    gpu.queue.writeBuffer(snapshot, 0, words);
    v2.restore(snapshot);
    v2.sync();
    const before = await v2.readCells(), at = (x, y, z) => x + sim.g.nx * (z + sim.g.nz * y);
    check(before.id[at(30, 32, 32)] === E.WATER && Math.abs(before.fill[at(30, 32, 32)] - 0.125) < 1e-6, 'the film is an eighth of a cell of water');
    // the shot, as laser.tool.js fires it
    const passes = [], prev = sim.onPass;
    sim.onPass = (name, info) => { passes.push(name); prev?.(name, info); };
    const shot = povGpu(sim).laser([4.5, 32.5, 32.5], [1, 0, 0]);
    sim.onPass = prev;
    if (!check(!!shot, 'the shot is issued (its kernels built)')) return { out };
    gpu.flush('laser check');
    const { reach } = await shot;
    check(reach >= LASER.LENGTH - 1e-3, `the beam crosses the box (reach ${reach.toFixed(1)})`);
    check(!passes.includes('povLaser') && passes.includes('povLaserReachNative'), "V2's reach ran; V1's apply never did");
    check(sim.version === v2.seenVersion && !v2.importFull && !v2.importMarked, "nothing of V1's to import (the shot's writes are V2's own)");
    const raw = new Uint32Array(await gpu.readback.buffer(v2.cells, 0, sim.g.slots * 16));
    const banks = new Int32Array(await gpu.readback.buffer(v2.aux, 0, sim.g.slots * 4));
    const material = (x, y, z) => { const s = cellSlot(sim.g, x, y, z); return { core: raw.slice(s * 4, s * 4 + 4), bank: banks[s] }; };
    const celsius = m => cTq(m.core) / 4 - 273.25;
    const steamV1 = makeMaterial(E.STEAM, LASER.VAPOR_T), waterFull = makeMaterial(E.WATER, 20, FULL);
    const w = material(20, 32, 32), f = material(30, 32, 32), r = material(40, 32, 32);
    check(cid(w.core) === E.STEAM && energyOf(w) === energyOf(steamV1), `full water -> V1's steam at ${celsius(w).toFixed(0)} °C (energy exact)`);
    check(cid(r.core) === E.SMOKE && Math.round(celsius(r)) === LASER.VAPOR_T, `rock -> smoke at ${celsius(r).toFixed(0)} °C (the tunnel opens)`);
    const share = energyOf(cells.film[3]) + (energyOf(steamV1) - energyOf(waterFull)) / 8n;
    check(energyOf(f) === share, `the film holds exactly its eighth of V1's change (${(Number(energyOf(f)) / Number(energyOf(steamV1))).toFixed(3)} of a full steam cell's energy) as ${cid(f.core) === E.STEAM ? 'steam' : cid(f.core) === E.WATER ? 'water past boiling, for V2 to boil' : `id ${cid(f.core)}`}`);
    check(!(cid(f.core) === E.STEAM && energyOf(f) === energyOf(steamV1)), 'not a full steam cell at VAPOR_T');
    const rim = material(20, 35, 32);
    check(celsius(rim) > 1000, `the rim's air is heated (${celsius(rim).toFixed(0)} °C)`);
    return { out };
  });
  for (const line of result.out) console.log(line);
  if (result.out.some(l => l.startsWith('FAIL')) || errors.length) failed = true;
} catch (e) {
  failed = true; console.log('FAIL', e.message);
} finally {
  await browser?.close();
  await vite.close();
  console.log(`slot ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
process.exitCode = failed ? 1 : 0;
