// Real-GPU integration checks; run only when the shared launcher permits it.
// node tools/v2/compact-browser-check.mjs --port 5197
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, render } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';

const vite = await startVite();
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 640, height: 480 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/^http:\/\/(?:localhost|127\.0\.0\.1):8787\//.test(m.location().url) && /ERR_CONNECTION_REFUSED/.test(m.text())) return;
    errors.push(m.text());
  });
  await page.goto(vite.url('/?size=64&preset=empty&physics=v2'));
  await ready(page);
  await page.evaluate(async () => {
    const a = __app, { E, ELEMENTS } = await import('/src/elements.js');
    const { prelude, STATE_OPTS, cellSlot, marksLayout } = await import('/src/shaders/common.js');
    const { fold } = await import('/src/gpu/kernels.js');
    const { VIEWS } = await import('/src/views.js');
    a.test.park(); a.settings.paused = true; a.post.settings.taa = false;
    await a.test.ready();
    const sim = a.sim, gpu = a.gpu, bytes = sim.g.slots * 16;
    const check = (ok, message) => { if (!ok) throw new Error(message); console.log(`ok ${message}`); };
    const equal = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const raw = async () => new Uint32Array(await gpu.readback.buffer(a.physics.v2.cells, 0, bytes));
    const paint = (x, y, z, id) => sim.paint({ center: new a.THREE.Vector3(x, y, z), radius: 2, shape: 0, tool: id, rate: 1 / ELEMENTS[id].spawn, replace: false });
    const passes = [];
    const prev = sim.onPass;
    sim.onPass = (name, info) => { passes.push(name); prev?.(name, info); };
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    const out = gpu.createBuffer({ label: 'compact test output', size: bytes * 2, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const layout = gpu.layout('compact test', [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }]);
    const group = gpu.bindGroup(layout, [b(0, out)]);
    const kernel = gpu.kernel({ name: 'compact test read', layouts: [sim.L.TABLES, sim.L.STATE_RO, layout], code: `
${prelude(sim.g, STATE_OPTS.STATE_RO)}
@group(2) @binding(0) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li); if (s >= SLOTS) { return; }
  output[s] = fetchAs(s); output[SLOTS + s] = fetchBs(s);
}` });
    await kernel.ready;
    const decoded = async (compat) => {
      const v2 = a.physics.v2; v2.forceCompatibility = compat;
      kernel.dispatch(gpu.frame, fold(Math.ceil(sim.g.slots / 64)), { bind: [sim.tables, sim.bindRO, group], header: sim.readHeader() });
      return new Uint32Array(await gpu.readback.buffer(out, 0, bytes * 2));
    };
    window.__compactTest = { check, equal, raw, paint, passes, decoded, E, VIEWS, cellSlot, marksLayout, out, prev };

    paint(32, 40, 32, E.SAND);
    a.physics.v2.sync();
    check((await a.physics.v2.readCells()).id.some(id => id === E.SAND), 'sand fixture really contains painted grains');
    passes.length = 0;
    a.test.step(210); // >fall + quiet cycle: no presentation or legacy reads during these ticks
    await gpu.fence();
    check(!passes.includes('v2bridge'), 'many normal ticks never bridge');
    const stats = await a.physics.v2.readStats();
    check(stats.awake === 0, 'sand settles before the delayed compatibility read');
    const pending = new Uint32Array(await gpu.readback.buffer(a.physics.v2.act, a.physics.v2.layout.legacy * 4, sim.g.nbricks * 4));
    check(pending.some(w => w & 1), 'legacy dirty bricks survive sleeping'); // (bit 0: stale, shaders/v2.js LEGACY_WORD)
    const marks = marksLayout(sim.g);
    const dirty = new Uint32Array(await gpu.readback.buffer(sim.marks, marks.derived * 4, Math.ceil(sim.g.nbricks / 32) * 4));
    check(dirty.some(Boolean), 'settled movement remains marked for presentation');
    const direct = await decoded(false), compat = await decoded(true);
    check(equal(direct, compat), 'all decoded A/B words match delayed bridge after settling');
    const p = [32, 0, 32], slot = cellSlot(sim.g, ...p);
    const cell = await sim.readCell(...p);
    check(cell[0][0] === new Float32Array(direct.buffer)[slot * 4], 'raw readCell agrees with direct reader');
    a.physics.v2.forceCompatibility = false;
    // New edit after hundreds of compact ticks must not resurrect the old airborne sand.
    passes.length = 0;
    paint(10, 20, 10, E.STONE);
    const beforeTick = a.physics.v2.tick;
    sim.readHeader(); // paused presentation boundary imports the edit
    const cells = await a.physics.v2.readCells();
    const editedId = cells.id[10 + sim.g.nx * (10 + sim.g.nz * 20)];
    check(editedId === E.STONE, `paused edit imported before another tick (got ${editedId}, expected ${E.STONE}; passes ${passes.join(',')}; stone count ${cells.id.filter(id => id === E.STONE).length})`);
    check(a.physics.v2.tick === beforeTick, 'paused import does not step physics');
    const top = 32 + sim.g.nx * (32 + sim.g.nz * 40);
    check(cells.id[top] === E.EMPTY, 'edit after many ticks does not resurrect stale cache cells');
    passes.length = 0;
  });
  await render(page);
  await page.evaluate(async () => {
    const a = __app, h = __compactTest, sim = a.sim, gpu = a.gpu;
    h.check(!h.passes.includes('v2bridge'), 'smooth render/derived/shadow/GI/picker setup never bridges');
    const directPick = await a.vol.pick([32, 63, 32], [0, -1, 0]);
    sim.changedAll = sim.fieldReset = true;
    a.derived.updateBricks();
    const brick = new Uint32Array(await gpu.readback.buffer(a.derived.brick, 0, a.derived.brick.size));
    const occupancy = new Uint32Array(await gpu.readback.buffer(a.derived.brickDist, 0, sim.g.nbricks * 19 * 4));
    a.physics.v2.forceCompatibility = true;
    const compatPick = await a.vol.pick([32, 63, 32], [0, -1, 0]);
    h.check(JSON.stringify(directPick) === JSON.stringify(compatPick), 'picker output matches compatibility path');
    sim.changedAll = sim.fieldReset = true;
    a.derived.updateBricks();
    const brick2 = new Uint32Array(await gpu.readback.buffer(a.derived.brick, 0, a.derived.brick.size));
    const occupancy2 = new Uint32Array(await gpu.readback.buffer(a.derived.brickDist, 0, sim.g.nbricks * 19 * 4));
    h.check(h.equal(brick, brick2) && h.equal(occupancy, occupancy2), 'derived brick/occupancy output matches compatibility path');
    a.physics.v2.forceCompatibility = false;
    a.setView(h.VIEWS.find(v => v.key === 'plain').id);
    await a.test.ready();
    h.passes.length = 0;
  });
  await render(page);
  await page.evaluate(async () => {
    const a = __app, h = __compactTest;
    h.check(!h.passes.includes('v2bridge'), 'Plain render never bridges');
    await a.gpu.fence();
    const directMesh = { ...a.blocks.stats };
    a.physics.v2.forceCompatibility = true;
    a.blocks.update({ force: true });
    await a.gpu.fence();
    h.check(directMesh.opaque === a.blocks.stats.opaque && directMesh.translucent === a.blocks.stats.translucent, 'Plain mesh face counts match compatibility path');
    a.physics.v2.forceCompatibility = false;

    // Exact undo fixture: a fractional liquid cell with nonzero signed face flux.
    const sim = a.sim, gpu = a.gpu, bytes = sim.g.slots * 16;
    const words = await h.raw(), at = h.cellSlot(sim.g, 20, 5, 20) * 4;
    words.set([h.E.WATER | (1173 << 8), 12345, 0xbc003800, 0xffff3400], at);
    const seed = gpu.createBuffer({ label: 'exact compact undo fixture', size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    gpu.write(seed, 0, words);
    sim.noteWrite(); a.physics.v2.restore(seed);
    await sim.prepare('fresh');
    sim.airT = 19;
    a.physics.v2.sync();
    h.check(h.equal(words, await h.raw()), 'ambient flag refresh preserves fractional fill and flux');
    sim.snapshot('fractional fill and flux');
    h.paint(20, 5, 20, h.E.STONE);
    a.test.step(1);
    sim.undo();
    h.check(h.equal(words, await h.raw()), 'v2 undo restores exact fill and all flux words');
    const direct = await h.decoded(false), compat = await h.decoded(true);
    h.check(h.equal(direct, compat), 'fractional liquid direct decode equals projected bridge');
    a.physics.v2.forceCompatibility = false;

    sim.snapshot('compact history across toggles');
    await a.setPhysics('v1');
    h.check(sim.history.at(-1).format === 'v2' && sim.readHeader().format === 0, 'v1 transition exports and retains compact history tag');
    a.test.step(1);
    await a.setPhysics('v2');
    sim.undo();
    h.check(h.equal(words, await h.raw()), 'compact history restores exactly after v1/v2 toggles');
    await a.setPhysics('v1');
    sim.snapshot('v1 history');
    h.check(sim.history.at(-1).format === 'v1', 'legacy history tagged');
    await a.setPhysics('v2');
    sim.undo(); a.physics.v2.sync();
    h.check(h.equal(await h.decoded(false), await h.decoded(true)), 'v1 history imports consistently when undone in v2');
    a.physics.v2.forceCompatibility = false;
    gpu.flush('compact tests done'); seed.destroy(); h.out.destroy();
    sim.onPass = h.prev;
  });
  assert.deepEqual(errors, []);
  console.log('compact browser checks passed');
} finally {
  await browser?.close();
  await vite.close();
}
