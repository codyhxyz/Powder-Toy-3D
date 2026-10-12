// Headless check of the massive-world window (docs/scaling.md D11, W1 and W2;
// docs/webgpu.md G1), a world map booted through a small window (?win=64: the
// container's budget) in manual mode:
//   1. diff: right after the world loads, the leaving slab's kernel
//      (shaders/generate.js sceneDiffFrag) flags exactly the bricks the trees
//      changed, so the store keeps nothing the generator makes; over the
//      window as the generator fills it (no trees), none;
//   2. round trip: sand, water and a wall placed by the window's centre and
//      settled; the window walks out WALK window widths along x and back; the
//      edited bricks come back cell for cell, and every other brick as it was,
//      up to what the store ignores (air seeds, velocity, pressure, drift
//      within the temperature tolerances); a brick that came back regenerated
//      is the freshly loaded world's, bit for bit;
//   3. seams: at the far end of the walk, the window built slab by slab equals,
//      cell for cell, a window generated there in one go (a second simulation);
//   plus each move's cost (CPU, GPU-synced, readback latency, gpu.stats).
// Stages 2 and 3 run together. Give each stage its own run (--stage 1, then
// --stage 2): one browser run each stays under 3 minutes here (an island
// move is ~5 s of SwiftShader).
// usage: node tools/world-check.mjs [--map island] [--win 64] [--stage 1,2] [--port N] [--verbose]
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MAP = opt('map', 'island');
const WIN = +opt('win', 64);
const STAGES = opt('stage', '1,2').split(',').map(Number);
const WALK = 1;               // window widths the walk goes out along x (the edits, within 20 cells of its centre, leave it entirely)
const SETTLE_STEPS = 20;      // sim steps the edits get to start settling before the walk (each is ~1 s of SwiftShader here)
const LOAD_TIMEOUT = 150000;  // ms the world may take to boot and compile
const VERBOSE = args.includes('--verbose');   // the page's progress, timed

const vite = await startVite();
const b = await launchBrowser();
const errs = [];
let failures = 0;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
try {
  const p = await newTestPage(b, { mode: 'manual', viewport: { width: 320, height: 200 } });
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.stack || e).slice(0, 600)));
  const t0 = Date.now();
  if (VERBOSE) p.on('console', (m) => { if (m.text().startsWith('[world-check]')) console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s ${m.text()}`); });
  await p.goto(vite.url(`/?map=${MAP}&view=plain&win=${WIN}`));
  await p.waitForFunction(() => window.__app?.win?.loaded || document.getElementById('error')?.textContent, null, { polling: 250, timeout: LOAD_TIMEOUT });
  const failed = await p.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot: ${failed.slice(0, 400)}`);
  await p.evaluate(() => window.__app.test.ready());

  // page helpers
  await p.evaluate(() => {
    const a = window.__app;
    const H = window.__wc = {};
    // every cell of the window, as [A, B] float arrays (512 floats: A's 64 cells, then B's) per world brick
    H.bricks = async () => {
      const sim = a.sim, g = sim.g, [A, B] = await sim.readState(), o = sim.origin, out = new Map();
      for (let bz = 0; bz < g.nz / 4; bz++)
        for (let by = 0; by < g.ny / 4; by++)
          for (let bx = 0; bx < g.nx / 4; bx++) {
            const v = new Float32Array(512);
            let n = 0;
            for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
              const i = sim.cellTexel(bx * 4 + x, by * 4 + y, bz * 4 + z) * 4;
              v.set(A.subarray(i, i + 4), n); v.set(B.subarray(i, i + 4), 256 + n); n += 4;
            }
            out.set(`${o.x / 4 + bx},${by},${o.z / 4 + bz}`, v);
          }
      return out;
    };
    // how two snapshots of a brick differ: 'same' (bit for bit), 'equivalent'
    // (only in what the store ignores) or 'different'
    H.compare = (u, v, AIR_T, MATTER_T) => {
      let same = true;
      for (let k = 0; k < 512; k++) if (!Object.is(u[k], v[k])) { same = false; break; }
      if (same) return 'same';
      for (let c = 0; c < 64; c++) {
        const ia = u[c * 4], ib = v[c * 4], ta = u[c * 4 + 1], tb = v[c * 4 + 1];
        if (Math.round(ia) !== Math.round(ib)) return 'different';
        if (Math.round(ia) === 0) { if (Math.abs(ta - tb) > AIR_T) return 'different'; continue; }
        if (!Object.is(u[c * 4 + 3], v[c * 4 + 3]) || Math.abs(ta - tb) > MATTER_T || Math.abs(u[c * 4 + 2] - v[c * 4 + 2]) > 1e-4) return 'different';
      }
      return 'equivalent';
    };
    // walk the window to origin o (world cells, x and z) a move at a time,
    // each move's leaving slab read back before the next; returns the moves
    H.walk = async (o) => {
      const w = a.win, sim = a.sim, g = sim.g, moves = [];
      while (sim.origin.x !== o[0] || sim.origin.z !== o[1]) {
        const dir = [Math.sign(o[0] - sim.origin.x), Math.sign(o[1] - sim.origin.z)];
        // the focus past the hysteresis toward o
        const f = [sim.origin.x + g.nx / 2 + dir[0] * 21, sim.origin.z + g.nz / 2 + dir[1] * 21];
        await a.gpu.fence();
        const s0 = { ...a.gpu.stats }, t0 = performance.now();
        const m = w.update(f[0], f[1]);
        if (!m) throw new Error(`walk: no move toward ${o} from ${sim.origin.x}, ${sim.origin.z}`);
        const t1 = performance.now();
        await a.gpu.fence();
        const t2 = performance.now(), s1 = { ...a.gpu.stats };
        await w.pending;
        const stats = Object.fromEntries(['submits', 'computePasses', 'dispatches', 'bytesAllocated', 'bytesUploaded', 'bytesReadBack', 'pipelinesCreated']
          .map((k) => [k, s1[k] - s0[k]]));
        moves.push({ ...w.last, cpu: t1 - t0, synced: t2 - t0, stats });
        console.log(`[world-check] move to ${sim.origin.x}, ${sim.origin.z}: ${(t2 - t0).toFixed(0)} ms, kept ${w.last.kept}, restored ${w.last.restored}`);
      }
      return moves;
    };
    // the leaving slab's kernel over the window's slab [x0, x0 + 16) along x, read back now: the world keys it flags
    H.diffSlab = async (x0) => {
      const w = a.win, g = a.sim.g, bricks = [4, g.ny / 4, g.nz / 4], n = bricks[0] * bricks[1] * bricks[2];
      w.gen.diff(w.P, [x0, 0, 0], bricks, w.leave);
      const head = new Uint32Array(await a.gpu.readback.buffer(w.leave.head, 0, 4 + 4 * n));
      return [...head.subarray(1, 1 + Math.min(head[0], n))];
    };
  });
  const res = {};

  // ------------------------------------------------------------- 1. diff
  if (STAGES.includes(1)) {
    res.diff = await p.evaluate(async () => {
      const a = window.__app, H = window.__wc, w = a.win, sim = a.sim, g = sim.g, o = [sim.origin.x, 0, sim.origin.z];
      a.worldLoad(o);
      const withTrees = await H.bricks();
      // the generator alone (no trees) over the same window
      w.gen.fill(w.P, o);
      const bare = await H.bricks();
      const key = (k) => { const [x, y, z] = k.split(',').map(Number); return w.store.key(x, y, z); };
      const treeBricks = new Set([...withTrees].filter(([k, v]) => H.compare(v, bare.get(k), 0, 0) !== 'same').map(([k]) => key(k)));
      // the diff over the window with its trees, slab by slab
      a.worldLoad(o);
      const flagged = new Set();
      for (let x0 = 0; x0 < g.nx; x0 += 16) for (const k of await H.diffSlab(x0)) flagged.add(k);
      // and over the bare window: nothing (the fill's sceneCell is the diff's)
      w.gen.fill(w.P, o);
      let bareFlagged = 0;
      for (let x0 = 0; x0 < g.nx; x0 += 16) bareFlagged += (await H.diffSlab(x0)).length;
      const missed = [...treeBricks].filter((k) => !flagged.has(k)).length;
      const extra = [...flagged].filter((k) => !treeBricks.has(k)).length;
      a.worldLoad(o);
      return { scene: w.scene.key, origin: [o[0], o[2]], treeBricks: treeBricks.size, flagged: flagged.size, missed, extra, bareFlagged };
    });
    const d = res.diff;
    ok(d.missed === 0 && d.extra === 0, `diff (${d.scene} at ${d.origin}): the trees changed ${d.treeBricks} bricks, the leaving slab's kernel flags ${d.flagged} (${d.missed} missed, ${d.extra} extra)`);
    ok(d.bareFlagged === 0, `diff: over the window as the generator fills it (no trees) it flags ${d.bareFlagged} bricks`);
  }

  // ------------------------------------------------------------- 2. round trip, 3. seams
  if (STAGES.includes(2) || STAGES.includes(3)) {
    res.roundTrip = await p.evaluate(async ([WALK, SETTLE_STEPS]) => {
      const a = window.__app, H = window.__wc, w = a.win, sim = a.sim, g = sim.g;
      const { E } = await import('/src/elements.js');
      const { STORE_MATTER_T } = await import('/src/shaders/generate.js');
      const { PHYS } = await import('/src/physics.js');
      const V3 = a.THREE.Vector3;
      const start = [sim.origin.x, sim.origin.z];
      // the walk's far end: WALK widths along x, the way the world has room for
      const far = [start[0] + WALK * g.nx <= w.size[0] - g.nx ? start[0] + WALK * g.nx : start[0] - WALK * g.nx, start[1]];
      if (far[0] < 0) return { error: `no room for a walk of ${WALK} windows along x from ${start}` };
      a.worldLoad([start[0], 0, start[1]]);
      const fresh = await H.bricks();
      // sand dropped, water poured, a wall built by the window's centre on dry
      // ground (the island's: no plants, no tree trunk within CLEAR)
      const scene = w.scene, P = w.P;
      const ground = (x, z) => Math.floor(scene.ground(sim.origin.x + x, sim.origin.z + z, P) + 0.5);
      const CLEAR = 14, SEARCH = 20, SEARCH_STEP = 4;
      let c = null;
      const gen = scene.key === 'island' ? await import('/src/world/generator.js') : null;
      for (let r = 0; r <= SEARCH && !c; r += SEARCH_STEP)
        for (let k = 0; k < 16 && !c; k++) {
          const x = Math.round(g.nx / 2 + r * Math.cos(k * Math.PI / 8)), z = Math.round(g.nz / 2 + r * Math.sin(k * Math.PI / 8));
          const wx = sim.origin.x + x, wz = sim.origin.z + z;
          if (ground(x, z) + 20 >= g.ny) continue;
          if (gen) {
            const L = gen.layersAt(wx, wz, P);
            if (L.ground <= P.sea + 1 || L.plant) continue;
            if (gen.treesIn(wx - CLEAR, wz - CLEAR, wx + CLEAR, wz + CLEAR, P).length) continue;
          }
          c = [x, z];
        }
      c ??= [g.nx / 2, g.nz / 2];
      const D = 10;   // cells between the strokes
      const strokes = [
        { tool: E.SAND, at: [c[0], ground(c[0], c[1]) + 10, c[1]], radius: 3, shape: 0 },
        { tool: E.WATER, at: [c[0] + D, ground(c[0] + D, c[1]) + 8, c[1]], radius: 3, shape: 0 },
        { tool: E.WALL, at: [c[0] - D, ground(c[0] - D, c[1]) + 3, c[1] + 4], radius: 2, shape: 1 },
      ];
      for (const s of strokes) sim.paint({ center: new V3(...s.at), radius: s.radius, shape: s.shape, tool: s.tool, rate: 1, replace: s.tool === E.WALL });
      console.log('[world-check] painted');
      a.test.step(SETTLE_STEPS);
      await a.gpu.fence();
      console.log('[world-check] settled');
      const before = await H.bricks();
      // bricks the strokes changed: an element differs from the fresh world in some cell
      const edited = [...before].filter(([k, v]) => {
        const f = fresh.get(k);
        for (let i = 0; i < 64; i++) if (Math.round(v[i * 4]) !== Math.round(f[i * 4])) return true;
        return false;
      }).map(([k]) => k);
      // out
      const moves = await H.walk(far);
      const storeOut = w.stats();
      // 3. seams: this window, built slab by slab, against one generated here in one go
      const { Simulation } = await import('/src/sim.js');
      const { WorldWindow } = await import('/src/world/window.js');
      const built = await sim.readState();
      const sim2 = new Simulation(a.gpu, g.nx, g.ny, g.nz, { windowed: true, world: w.size });
      let seams;
      try {
        await sim2.ready;
        const w2 = new WorldWindow(null, sim2, { size: w.size, seed: P.seed, scene });
        try {
          await w2.whenReady();
          w2.load([sim.origin.x, 0, sim.origin.z]);
          const one = await sim2.readState();
          let cells = 0, diffA = 0, diffB = 0;
          for (let t = 0; t < built[0].length; t += 4) {
            if (!sim.texelCell(t / 4)) continue;
            cells++;
            for (let k = 0; k < 4; k++) if (!Object.is(built[0][t + k], one[0][t + k])) { diffA++; break; }
            for (let k = 0; k < 4; k++) if (!Object.is(built[1][t + k], one[1][t + k])) { diffB++; break; }
          }
          seams = { origin: [sim.origin.x, sim.origin.z], cells, cellsDifferingA: diffA, cellsDifferingB: diffB, treesPlantedHere: w2.stats().planted };
        } finally { w2.dispose(); }
      } finally { sim2.dispose(); }
      // back
      moves.push(...await H.walk(start));
      const after = await H.bricks();
      // every brick of the window against its state before the walk
      const tally = { same: 0, equivalent: 0, different: 0, missing: 0 }, differentKeys = [];
      let regenerated = 0, regeneratedAsFresh = 0;
      for (const [k, v] of before) {
        if (!after.has(k)) { tally.missing++; continue; }
        const r = H.compare(v, after.get(k), PHYS.AIR_REST_T, STORE_MATTER_T);
        tally[r]++;
        if (r === 'equivalent') { regenerated++; if (H.compare(fresh.get(k), after.get(k), 0, 0) === 'same') regeneratedAsFresh++; }
        if (r === 'different' && differentKeys.length < 10) differentKeys.push(k);
      }
      const editedExact = edited.filter((k) => after.has(k) && H.compare(before.get(k), after.get(k), 0, 0) === 'same').length;
      const count = (snap, id) => edited.reduce((n, k) => { const v = snap.get(k); if (v) for (let i = 0; i < 64; i++) if (Math.round(v[i * 4]) === id) n++; return n; }, 0);
      const med = (v) => [...v].sort((x, y) => x - y)[v.length >> 1];
      const sum = (f) => { const v = moves.map(f).filter((x) => x != null); return v.length ? { median: +med(v).toFixed(1), max: +Math.max(...v).toFixed(1) } : null; };
      return {
        scene: scene.key, start, far, spot: [sim.origin.x + c[0], sim.origin.z + c[1]],
        editedBricks: edited.length, editedBricksExact: editedExact,
        cells: { sand: [count(before, E.SAND), count(after, E.SAND)], water: [count(before, E.WATER), count(after, E.WATER)], wall: [count(before, E.WALL), count(after, E.WALL)] },
        bricks: tally, regenerated, regeneratedAsFresh, differentKeys, storeOut, storeAfter: w.stats(), seams,
        moves: moves.length,
        cost: {
          cpuMs: sum((m) => m.cpu), syncedMs: sum((m) => m.synced), readbackMs: sum((m) => m.readbackMs), keptBricks: sum((m) => m.kept),
          restored: sum((m) => m.restored), trees: sum((m) => m.trees),
          stats: Object.fromEntries(Object.keys(moves[0]?.stats ?? {}).map((k) => [k, { median: med(moves.map((m) => m.stats[k])), max: Math.max(...moves.map((m) => m.stats[k])) }])),
        },
      };
    }, [WALK, SETTLE_STEPS]);
    const r = res.roundTrip;
    if (r.error) ok(false, `round trip: ${r.error}`);
    else {
      ok(r.editedBricks > 0 && r.editedBricksExact === r.editedBricks,
        `round trip (${r.scene}, ${r.moves} moves to ${r.far} and back): ${r.editedBricksExact} of ${r.editedBricks} edited bricks back bit for bit (sand ${r.cells.sand.join('→')}, water ${r.cells.water.join('→')}, wall ${r.cells.wall.join('→')})`);
      ok(r.bricks.different === 0 && r.bricks.missing === 0,
        `round trip: every brick back (${r.bricks.same} same, ${r.bricks.equivalent} equivalent, ${r.bricks.different} different${r.differentKeys.length ? `: ${r.differentKeys.join(' ')}` : ''})`);
      ok(r.regeneratedAsFresh === r.regenerated, `round trip: ${r.regeneratedAsFresh} of ${r.regenerated} regenerated bricks are the fresh world's bit for bit`);
      const s = r.seams;
      ok(s && s.cellsDifferingA === 0 && s.cellsDifferingB === 0, `seams at ${s?.origin}: the window built slab by slab against one generated there: ${s?.cellsDifferingA} of ${s?.cells} cells differ in A, ${s?.cellsDifferingB} in B`);
      console.log(`cost per move: ${JSON.stringify(r.cost)}`);
      console.log(`store: out ${JSON.stringify(r.storeOut)}, back ${JSON.stringify(r.storeAfter)}`);
    }
  }
  ok(!errs.length, `no page errors${errs.length ? `:\n  ${errs.join('\n  ')}` : ''}`);
  await p.close();
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}`);
  if (errs.length) console.log(errs.join('\n'));
} finally {
  await b.close();
  await vite.close();
}
console.log(failures ? `\nworld-check: ${failures} failed` : '\nworld-check: ok');
process.exit(failures ? 1 : 0);
