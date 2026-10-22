// CPU-only check of the scripting console (src/console, docs/console.md): runs
// Lua snippets through fengari against a mock of the GPU backend, so the Lua
// bridge, the TPT-named API, the edit queue and the read cache are exercised
// without a browser. The mock applies edits by a JS port of the GPU pass's
// binary search (shaders/script.js), from the same packed texture data.
// usage: node tools/check-console.mjs
import { ELEMENTS, E } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import { ScriptWorld, EDIT, EDIT_TEX_W, EDIT_SEARCH_STEPS, EDIT_CHUNK } from '../src/console/world.js';
import { installBuiltins } from '../src/console/api.js';
import { registerConsoleApi } from '../src/console/registry.js';
import { createLua, EVENTS, COMMAND_LIMIT_MS } from '../src/console/lua.js';

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.error(`FAIL ${what}`); } };
const eq = (got, want, what) => ok(Object.is(got, want) || got === want, `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---------------------------------------------------------------- mock GPU
const B = [16, 8, 8];   // a block: a supertile's cells (shaders/common.js SUPER_CELLS)
function mockBackend([nx, ny, nz]) {
  const nb = [nx / B[0], ny / B[1], nz / B[2]];
  const texels = B[0] * B[1] * B[2];
  const blocks = [...Array(nb[0] * nb[1] * nb[2])].map(() => ({ a: new Float32Array(texels * 4), b: new Float32Array(texels * 4) }));
  for (const bl of blocks) for (let t = 0; t < texels; t++) { bl.a[t * 4 + 1] = PHYS.AMBIENT; bl.a[t * 4 + 3] = Math.random() * 0.999; }
  const where = [0, 0];
  const locate = (x, y, z) => {
    const bx = Math.floor(x / B[0]), by = Math.floor(y / B[1]), bz = Math.floor(z / B[2]);
    where[0] = bx + nb[0] * (bz + nb[2] * by);
    where[1] = (x - bx * B[0]) + B[0] * ((z - bz * B[2]) + B[2] * (y - by * B[1]));
    return where;
  };
  const be = {
    reads: 0, syncReads: 0, passes: 0, epochValue: 'a',
    epoch: () => be.epochValue,
    size: () => [nx, ny, nz],
    blockCount: blocks.length,
    blockTexels: texels,
    locate,
    // flying: V2's matter in flight beside the grid (console/gpu.js flyingMatter), when this
    // backend has any (be.flying: its records); V1's backend has none (its flying cells are cells)
    flying: null, flyingReads: 0,
    readBlocks(list, sync, flying = false) {
      be.reads += list.length;
      if (sync) be.syncReads += list.length;
      const m = new Map(list.map((i) => [i, { a: blocks[i].a.slice(), b: blocks[i].b.slice() }]));
      if (flying && be.flying) { m.flying = be.flying.slice(); be.flyingReads++; }
      return sync ? m : Promise.resolve(m);
    },
    // shaders/script.js scriptEdit, line by line
    applyEdits({ count, rows, data, lo, hi }) {
      be.passes++;
      const at = (j, part) => { const t = ((Math.floor(j / EDIT_TEX_W) + part * rows) * EDIT_TEX_W + (j % EDIT_TEX_W)) * 4; return data.subarray(t, t + 4); };
      for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
        const key = (z * ny + y) * nx + x;
        let l = 0, h = count - 1, j = -1;
        for (let i = 0; i < EDIT_SEARCH_STEPS; i++) {
          if (l > h) break;
          const mid = (l + h) >> 1, k = at(mid, 0)[0];
          if (k === key) { j = mid; break; }
          if (k < key) l = mid + 1; else h = mid - 1;
        }
        if (j < 0) continue;
        const m = at(j, 0)[1], va = at(j, 1), vb = at(j, 2);
        const [bi, t] = locate(x, y, z), A = blocks[bi].a, Bv = blocks[bi].b, o = t * 4;
        const id = Math.round(A[o]);
        if ((m & EDIT.IF_EMPTY) && id !== E.EMPTY) continue;
        if ((m & EDIT.IF_MATTER) && id === E.EMPTY) continue;
        const seed = A[o + 3] % 1;
        if (m & EDIT.SPAWN) {
          const n = Math.round(va[0]);
          const ctype = n === E.LAVA ? E.STONE : 0;
          if (n === E.EMPTY) A.set([E.EMPTY, PHYS.AMBIENT, 0, seed], o);
          else A.set([n, ELEMENTS[n].temp, ELEMENTS[n].life, ctype + seed], o);
          Bv.set([0, 0, 0, Bv[o + 3]], o);
        }
        if (m & EDIT.TYPE) A[o] = Math.round(va[0]);
        if (m & EDIT.TEMP) A[o + 1] = va[1];
        if (m & EDIT.LIFE) A[o + 2] = va[2];
        if (m & EDIT.CTYPE) A[o + 3] = va[3] + seed;
        if (m & EDIT.VX) Bv[o] = vb[0];
        if (m & EDIT.VY) Bv[o + 1] = vb[1];
        if (m & EDIT.VZ) Bv[o + 2] = vb[2];
        if (m & EDIT.PRESSURE) Bv[o + 3] = vb[3];
      }
    },
    cell(x, y, z) { const [bi, t] = locate(x, y, z); return { id: Math.round(blocks[bi].a[t * 4]), temp: blocks[bi].a[t * 4 + 1], p: blocks[bi].b[t * 4 + 3] }; },
    // a step of the mock world: every powder cell falls a cell if it can
    fall() {
      for (let y = 1; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const [bi, t] = locate(x, y, z); const id = Math.round(blocks[bi].a[t * 4]);
        if (id === E.EMPTY || ELEMENTS[id].kind !== 2) continue;
        const [bj, u] = locate(x, y - 1, z);
        if (Math.round(blocks[bj].a[u * 4]) !== E.EMPTY) continue;
        const a = blocks[bi].a.slice(t * 4, t * 4 + 4), b = blocks[bj].a.slice(u * 4, u * 4 + 4);
        blocks[bj].a.set(a, u * 4); blocks[bi].a.set(b, t * 4);
      }
    },
  };
  return be;
}

let clock = 0;
const now = () => clock;
const SIZE = [32, 16, 32];
const backend = mockBackend(SIZE);
const world = new ScriptWorld(backend, { now });
const state = { paused: false, gravity: 1, radius: 5, shape: 0, selected: E.SAND, steps: 0, paints: [] };
installBuiltins({
  world,
  paused: () => state.paused, setPaused: (p) => { state.paused = p; },
  step: (n) => { world.flush(); for (let i = 0; i < n; i++) backend.fall(); state.steps += n; world.invalidate(); },
  gravity: () => state.gravity, setGravity: (g) => { state.gravity = g; },
  brushRadius: () => state.radius, setBrushRadius: (r) => { state.radius = r; },
  brushShape: () => state.shape, setBrushShape: (s) => { state.shape = s; },
  selected: () => state.selected, select: (id) => { state.selected = id; },
  paint: (p) => state.paints.push(p),
  origin: () => [0, 0, 0],
});
const logs = [];
const L = createLua({ log: (text, kind) => logs.push({ text, kind }), now: () => { clock += 0.001; return clock; } });
// a typed command, as console/index.js runs it: fresh reads, flush after
const run = (code) => {
  world.beginCommand();
  const r = L.run(code);
  world.flush();
  return r;
};
const val = (code) => { const r = run(code); if (!r.ok) console.error(`  (${code}: ${r.error})`); return r.ok ? r.text : `ERROR ${r.error}`; };

// ---------------------------------------------------------------- names
eq(val('elem.DEFAULT_PT_SAND'), String(E.SAND), 'elem.DEFAULT_PT_SAND');
eq(val('elem.DEFAULT_PT_WATR'), String(E.WATER), 'TPT abbreviation WATR');
eq(val('elem.getByName("water")'), String(E.WATER), 'getByName by key');
eq(val('elem.getByName("NOPE")'), '-1', 'getByName unknown');
eq(val('elem.property(elem.DEFAULT_PT_SAND, "Name")'), 'SAND', 'elem.property Name');
eq(val('sim.XRES, sim.YRES, sim.ZRES'), SIZE.join(', '), 'sim.XRES/YRES/ZRES');
eq(val('1 + 1'), '2', 'an expression prints its value');
eq(val('local a = 3'), null, 'a statement prints nothing');
ok(L.run('for i = 1, 2 do').more, 'an unfinished chunk waits for more');
eq(L.run('end').ok, true, '...and runs with its last line');
eq(val('io == nil and require == nil and debug == nil and os.exit == nil and package == nil and dofile == nil'), 'true', 'sandbox');
ok(val('elem.property(1, "Name", "X")').includes('baked'), 'element properties are read only');

// ---------------------------------------------------------------- writes and reads
const idx = (x, y, z) => (z * SIZE[1] + y) * SIZE[0] + x;
eq(val('sim.partCreate(-1, 3, 4, 5, elem.DEFAULT_PT_SAND)'), String(idx(3, 4, 5)), 'partCreate returns the cell index');
eq(backend.cell(3, 4, 5).id, E.SAND, 'partCreate reached the grid');
eq(val('sim.partCreate(-1, 3, 4, 5, elem.DEFAULT_PT_WATR)'), '-1', 'partCreate(-1) on matter fails');
eq(val('sim.partProperty(sim.partID(3, 4, 5), "type")'), String(E.SAND), 'partProperty reads type');
eq(val('local i = sim.partCreate(-1, 1, 1, 1, "WATR"); sim.partProperty(i, "temp", 55.5); return sim.partProperty(i, "temp")'), '55.5', 'a write is visible to a read in the same command');
eq(backend.cell(1, 1, 1).temp, 55.5, 'temp reached the grid');
run(`sim.partProperty(${idx(1, 1, 1)}, "temp", 1e9)`);
eq(backend.cell(1, 1, 1).temp, PHYS.CELL_TEMP_MAX, 'temp is clamped to the sim\'s range');
eq(val(`sim.partProperty(${idx(9, 9, 9)}, "temp")`), 'nil', 'partProperty of air is nil (TPT: no particle)');
ok(Number(val('sim.cellProperty(9, 9, 9, "temp")')) === PHYS.AMBIENT, 'cellProperty reads air');
run('sim.partKill(3, 4, 5)');
eq(backend.cell(3, 4, 5).id, E.EMPTY, 'partKill(x, y, z)');
eq(val(`sim.partExists(${idx(3, 4, 5)})`), 'false', 'partExists after kill');
run('sim.pressure(2, 2, 2, 12.5)');
eq(backend.cell(2, 2, 2).p, 12.5, 'sim.pressure sets');
eq(val('sim.pressure(2, 2, 2)'), '12.5', 'sim.pressure gets');
run('sim.pressure(0, 0, 0, 2, 2, 2, 1e6)');
eq(backend.cell(1, 1, 1).p, PHYS.P_MAX, 'a pressure box, clamped');
run('tpt.set_property("temp", 300, 1, 1, 1)');
eq(backend.cell(1, 1, 1).temp, 300, 'tpt.set_property at x, y, z');
eq(val('tpt.get_property("type", 1, 1, 1)'), String(E.WATER), 'tpt.get_property type');
eq(val('tpt.get_property("type", 20, 1, 20)'), '0', 'tpt.get_property type of air is 0');
// edits merged in one batch: kill then create, create then set
eq(val(`sim.partKill(1, 1, 1); return sim.partCreate(-1, 1, 1, 1, "STNE")`), String(idx(1, 1, 1)), 'kill then create in one command');
eq(backend.cell(1, 1, 1).id, E.STONE, '...leaves the new element');
run('local i = sim.partCreate(-1, 6, 6, 6, "LAVA"); sim.partProperty(i, "temp", 1500); sim.partProperty(i, "type", "ROCK")');
eq(backend.cell(6, 6, 6).id, E.ROCK, 'create, set, change type: the type');
eq(backend.cell(6, 6, 6).temp, 1500, '...the temperature kept');
const before = backend.passes;
run('for x = 0, 31 do for z = 0, 31 do sim.partCreate(-1, x, 0, z, "WALL") end end');
eq(backend.passes - before, 1, 'a 1024-cell loop is one GPU pass');
eq(val('sim.elementCount("WALL")'), '1024', 'elementCount');
const parts = Number(val('local n = 0 for i in sim.parts() do n = n + 1 end return n'));
eq(parts, Number(val('sim.partCount()')), 'sim.parts() visits every particle');
// R4: V2's matter in flight is counted, as V1's flying cells are (they are cells): a census reads the
// pool with the blocks (console/world.js readAll flying, console/gpu.js flyingMatter)
const packet = (slot, id, x, y, z, more = {}) => ({ slot, id, x, y, z, temp: 20, life: 0, ctype: 0, vx: 0, vy: 0, vz: 0, ...more });
{
  const sand0 = Number(val('sim.elementCount("SAND")')), all0 = Number(val('sim.partCount()'));
  backend.flying = [packet(7, E.SAND, 2, 9, 3), packet(2, E.SAND, 30, 12, 30), packet(40, E.WATER, 0, 15, 0)];
  eq(Number(val('sim.elementCount("SAND")')), sand0 + 2, 'elementCount counts flying sand (V2 packets)');
  eq(Number(val('sim.partCount()')), all0 + 3, 'partCount counts every flying packet');
  const reads = backend.flyingReads;
  eq(val('return sim.partCount() == sim.partCount()'), 'true', 'one command, one read of the pool');
  eq(backend.flyingReads, reads + 1, '...read once per command, as each block is');
  // sim.parts() walks them as V1 walks its flying cells, the cells they are in: in key order, after the cell
  const cellCount = SIZE[0] * SIZE[1] * SIZE[2];
  const order = val('local t = {} for i in sim.parts() do t[#t + 1] = i end return table.concat(t, ",")').split(',').map(Number);
  eq(order.length, all0 + 3, 'sim.parts() visits each flying packet (V2) as V1 visits its flying cells');
  const where = (i) => (i >= cellCount ? backend.flying.find((p) => p.slot === i - cellCount) : null);
  const keyOf = (i) => { const p = where(i); return p ? idx(p.x, p.y, p.z) : i; };
  ok(order.every((i, k) => k === 0 || keyOf(order[k - 1]) < keyOf(i) || (keyOf(order[k - 1]) === keyOf(i) && i >= cellCount)), 'sim.parts() is in V1\'s order: a packet at its cell\'s key');
  eq(order.filter((i) => i >= cellCount).map((i) => i - cellCount).join(','), '40,7,2', '...the packets by their cells (keys 480, 1826, 15774)');
  eq(val(`return sim.partProperty(${cellCount + 40}, "type"), sim.partProperty(${cellCount + 40}, "temp"), sim.partProperty(${cellCount + 40}, "y")`), `${E.WATER}, 20, 15`, 'partProperty reads a flying packet');
  eq(val(`return sim.partExists(${cellCount + 2}), sim.partPosition(${cellCount + 2})`), 'true, 30, 12, 30', 'partExists, partPosition of a packet');
  eq(val(`return sim.partExists(${cellCount + 3})`), 'false', 'no packet in slot 3');
  eq(val(`local k = 0 for i in sim.parts() do if sim.partProperty(i, "type") == elem.DEFAULT_PT_SAND then k = k + 1 end end return k`), String(sand0 + 2), 'a parts() loop reads the flying sand');
  backend.flying = [packet(0, E.SAND, 1, 1, 1)];
  eq(Number(val('sim.partCount()')), all0 + 1, 'the next command reads the pool fresh');
  // a handler's census: what was read last, refreshed in the background as its blocks are
  const hw = new ScriptWorld(backend, { now });
  eq(hw.readAll(false, { flying: true }), false, 'a handler waits for the pool');
  hw.pump(); await new Promise((r) => setTimeout(r, 0));
  eq(hw.readAll(false, { flying: true }), true, '...then has it');
  let n = 0; hw.forEachFlying((id) => { if (id === E.SAND) n++; });
  eq(n, 1, '...and counts it');
  backend.flying = null;
}
{
  // the GPU backend's pool decode (src/shaders/v2/particles.js DParticle): live matter inside the window
  const { flyingMatter } = await import('../src/console/gpu.js');
  const { PARTICLE_BYTES, PHOTON_TAG, NEUTRON_TAG } = await import('../src/v2/dynamics-reference.js');
  const words = PARTICLE_BYTES / 4, pool = new ArrayBuffer(PARTICLE_BYTES * 6), u = new Uint32Array(pool), f = new Float32Array(pool);
  const put = (i, id, element, x, y, z) => { f.set([x, y, z], i * words); u[i * words + 3] = id; u[i * words + 7] = element | (77 << 8); };
  put(0, 5, E.SAND, 110.5, 4.2, 9.9);       // in the window at origin (100, 0, 0)
  put(1, 0, E.SAND, 110.5, 4.2, 9.9);       // a dead slot
  put(2, 6, PHOTON_TAG, 110.5, 4.2, 9.9);   // a photon: not matter
  put(3, 7, NEUTRON_TAG, 110.5, 4.2, 9.9);  // a neutron: not matter
  put(4, 8, E.WATER, 99.5, 4.2, 9.9);       // flying outside the window (World retains it)
  put(5, 9, E.OIL, 131.9, 15.5, 31.5);
  u[0 * words + 7] = E.SAND | (Math.round((300 + 273.25) * 4) << 8); f[0 * words + 5] = -2 * 240 * 0.3;   // 300 °C, falling 2 cells a V1 step (CELL_M 0.3 m)
  const found = flyingMatter(pool, [100, 0, 0], SIZE);
  eq(JSON.stringify(found.map((p) => p.id)), JSON.stringify([E.SAND, E.OIL]), 'flyingMatter: live matter packets in the window');
  eq(JSON.stringify(found.map((p) => [p.slot, p.x, p.y, p.z])), JSON.stringify([[0, 10, 4, 9], [5, 31, 15, 31]]), '...their slots and grid cells');
  eq(found[0].temp, 300, '...a packet\'s temperature in °C');
  ok(Math.abs(found[0].vy + 2) < 1e-6, `...its velocity in cells a V1 step (${found[0].vy})`);
}
// more edits than one pass takes
const many = SIZE[0] * SIZE[1] * SIZE[2];
const p0 = backend.passes;
run('for z = 0, sim.ZRES - 1 do for y = 0, sim.YRES - 1 do for x = 0, sim.XRES - 1 do sim.cellProperty(x, y, z, "pressure", 1) end end end');
eq(backend.passes - p0, Math.ceil(many / EDIT_CHUNK), `${many} edits take ${Math.ceil(many / EDIT_CHUNK)} passes`);
eq(backend.cell(31, 15, 31).p, 1, 'the last cell of a multi-pass batch');
// steps
run('sim.partCreate(-1, 10, 10, 10, "SAND")');
run('sim.step(3)');
eq(state.steps, 3, 'sim.step(n)');
eq(val('sim.partID(10, 7, 10) ~= nil'), 'true', 'a read after sim.step sees the new state');
ok(val('event.register(event.tick, function() sim.step() end)') !== null && (L.dispatch(EVENTS.TICK), logs.at(-1).text.includes('not from an event handler')), 'sim.step refuses inside a handler');

// ---------------------------------------------------------------- settings
run('tpt.set_pause(1)'); eq(state.paused, true, 'tpt.set_pause(1)');
eq(val('tpt.set_pause()'), '1', 'tpt.set_pause() reads');
run('tpt.toggle_pause()'); eq(state.paused, false, 'tpt.toggle_pause');
run('sim.gravity(0.5)'); eq(state.gravity, 0.5, 'sim.gravity');
run('tpt.selectedl = "DEFAULT_PT_WATR"'); eq(state.selected, E.WATER, 'tpt.selectedl = identifier');
eq(val('tpt.selectedl'), 'DEFAULT_PT_WATR', 'tpt.selectedl reads an identifier');
run('tpt.selectedl = "DEFAULT_TOOL_HEAT"'); eq(state.selected, -2, 'select a tool');
run('tpt.brushx = 9'); eq(state.radius, 9, 'tpt.brushx');
run('sim.createParts(5, 5, 5, 3, "DEFAULT_TOOL_HEAT")');
eq(state.paints.at(-1)?.tool, -2, 'createParts paints a tool');
ok(val('sim.createParts(5, 5, 5, 3, "DEFAULT_TOOL_SIGN")').startsWith('ERROR'), 'createParts refuses app-handled tools');
logs.length = 0;
run('print("hello", 3)');
eq(logs.at(-1)?.text, 'hello, 3', 'print (tpt.log) joins with ", " as TPT does');

// ---------------------------------------------------------------- events
L.clearHandlers();
run('n = 0; event.register(event.tick, function() n = n + 1; sim.partCreate(-1, 20, 15, 20, "SAND") end)');
L.dispatch(EVENTS.TICK); world.flush();
L.dispatch(EVENTS.TICK); world.flush();
eq(val('n'), '2', 'a tick handler runs every dispatch');
eq(backend.cell(20, 15, 20).id, E.SAND, 'a handler\'s writes reach the grid');
run('f = function() m = (m or 0) + 1 end; event.register(event.beforesim, f); event.unregister(event.beforesim, f)');
L.dispatch(EVENTS.BEFORESIM);
eq(val('m'), 'nil', 'event.unregister');
run('tpt.register_step(function() error("boom") end)');
logs.length = 0;
L.dispatch(EVENTS.TICK);
ok(logs.some((l) => l.kind === 'error' && l.text.includes('boom')), 'a throwing handler is reported');
eq(L.handlerCount(EVENTS.TICK), 1, '...and unregistered (the good one stays)');
run('event.register(event.tick, function() while true do end end)');
logs.length = 0;
L.dispatch(EVENTS.TICK);
ok(logs.some((l) => l.text.includes('ran longer')), 'a runaway handler is stopped');
eq(L.handlerCount(EVENTS.TICK), 1, '...and unregistered');
// reads in a handler come from the cache, filled asynchronously
L.clearHandlers();
world.blocks.clear();
run('seen = "unset"; event.register(event.tick, function() seen = sim.partProperty(sim.partID(0, 0, 0) or -1, "type") end)');
L.dispatch(EVENTS.TICK);
eq(val('seen'), 'nil', 'an uncached read in a handler is nil');
world.pump();
await new Promise((r) => setTimeout(r, 0));
const syncBefore = backend.syncReads;
L.dispatch(EVENTS.TICK);
eq(backend.syncReads, syncBefore, 'a handler never reads synchronously');
eq(val('seen'), String(E.WALL), '...and sees the block once it arrives');
L.clearHandlers();

// ---------------------------------------------------------------- limits
const t0 = clock;
const r = run('while true do end');
ok(!r.ok && r.error.includes('ran longer'), 'a runaway command is stopped');
ok(clock - t0 >= COMMAND_LIMIT_MS, '...after its time limit');
const r2 = run('while true do pcall(function() while true do end end) end');
ok(!r2.ok && r2.error.includes('ran longer'), 'pcall can\'t swallow the time limit');
eq(val('2 + 2'), '4', 'the console works after a runaway');
const r3 = run('string.rep("x", 2^31)');
ok(!r3.ok, `a huge string is an error, not a crash (${r3.error})`);
// the registry: late registration reaches a running console
registerConsoleApi('sim', 'lateFeature', (a) => a * 2, { args: 'a', doc: 'test' });
eq(val('sim.lateFeature(21)'), '42', 'a function registered after the console started');
registerConsoleApi('save', 'name', function () { return `mode ${this.mode}`; });
eq(val('save.name()'), 'mode command', 'a new table, and the call context');
// a new grid or a moved window drops the cache and the queue
world.edit(1, 2, 3, EDIT.SPAWN, { type: E.SAND });
backend.epochValue = 'b';
eq(world.read(1, 2, 3, false), null, 'a new epoch forgets');
eq(world.pending, 0, '...and drops queued edits');

// ---------------------------------------------------------------- speed
backend.epochValue = 'c';
const T0 = performance.now();
run('for z = 0, 31 do for y = 0, 15 do for x = 0, 31 do sim.partCreate(-3, x, y, z, "SAND") end end end');
const ms = performance.now() - T0;
console.log(`speed: ${many} partCreate calls in ${ms.toFixed(0)} ms (${(many / ms).toFixed(0)}/ms) through fengari`);

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
