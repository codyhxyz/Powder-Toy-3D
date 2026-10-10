// Headless check of the massive-world window (docs/scaling.md D11, W1 and W2),
// in world mode (?size=world: a 1024×128×1024 world through a 128³ window):
//   1. diff: right after the world loads, the diff pass flags exactly the
//      bricks the trees changed, so the store keeps nothing the generator makes;
//   2. round trip: sand, water and a wall placed by the window's centre and
//      settled; the focus walks a loop more than 3 window widths out and back;
//      the edited bricks come back cell for cell, and every other brick as it
//      was, up to what the store ignores (air seeds, velocity, pressure, drift
//      within the temperature tolerances);
//   3. seams: at the far end of the walk, the window built slab by slab equals,
//      cell for cell, a window generated there in one go (a second simulation);
//      plus a still across the slabs;
//   4. no texture jump: frames straddling a move with the camera fixed in the
//      world, with the render fields and GI moved, and (the pop) started over;
//   5. cost: per move (CPU, GPU-synced, readback latency, storing), frame times
//      during a continuous walk with the sim running, interleaved with walks
//      that don't move the window; the store after the long walk.
// usage: node tools/world-check.mjs [outDir] [--port 5411] [--skip 4,5] [--detail on|off|default]
//   --detail: close-up detail features (gfx/detail.js) all on (the default:
//   they add most of the texture a move could make jump), all off, or as
//   their cost tiers set them.
import { launchBrowser, newTestPage } from './browser.mjs';
import { mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { DETAIL, settingKey, detailDefaults } from '../src/gfx/detail.js';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : null;
const port = opt('port', '5411');
const skip = new Set(String(opt('skip', '')).split(',').filter(Boolean).map(Number));
const detailMode = opt('detail', 'on');
const detail = detailMode === 'default' ? detailDefaults()
  : Object.fromEntries(DETAIL.map((f) => [settingKey(f), detailMode === 'on']));
if (out) mkdirSync(out, { recursive: true });

// the walk: the window starts in the hills (bare rock round its centre, so
// the edits land on ground, not in a canopy) and goes round a loop (world
// cells, the window's origin), out to more than 3 window widths from the
// edits and back. The stills look at the west coast (sea, beach, meadow, trees).
const START = [448, 192];
const LOOP = [[896, 192], [896, 448], [448, 448], [448, 192]];
const COAST = [128, 384];
const SETTLE_STEPS = 240;     // sim steps the edits get to land and settle before the walk
const FRAME_LIMIT = 4000;     // frames a walk may take before the check gives up
const COST_MOVES = 16;        // moves timed one by one (half of them pass by pass)
const WALK_FRAMES = 360;      // frames of each continuous walk
const WALK_SPEED = 1.5;       // cells per frame the focus moves on the continuous walk (90 cells/s at 60 fps)
const JUMP_FRAME = 1000;      // the jitter frame index the jump stills are drawn at (same before and after)
const SETTLE_FRAMES = 90;     // frames for the derived passes and GI to converge on a still view

const b = await launchBrowser();
const p = await newTestPage(b, { mode: 'visual', viewport: { width: 1280, height: 800 } });
await p.addInitScript((detail) => {
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify(detail));
  addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = 'body *{visibility:hidden !important} #app > canvas{visibility:visible !important}';
    document.head.appendChild(st);
  });
  // __hold() parks the frame loop so a screenshot captures a fixed frame (tools/regress.mjs)
  const raf = window.requestAnimationFrame.bind(window);
  let held = null;
  window.requestAnimationFrame = (cb) => { if (held) { held.push(cb); return 0; } return raf(cb); };
  window.__hold = () => { held ??= []; };
  window.__release = () => { const h = held ?? []; held = null; h.forEach((cb) => window.requestAnimationFrame(cb)); };
  window.__rawFrame = () => new Promise((r) => raf(() => r()));
}, detail);
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
p.on('crash', () => errs.push('PAGE CRASHED'));
let booted = false;
p.on('framenavigated', (f) => { if (booted && f === p.mainFrame()) errs.push(`NAVIGATED to ${f.url()}`); });
process.on('exit', () => { if (errs.length) console.log(errs.join('\n')); });
await p.goto(`http://localhost:${port}/?size=world&paused=1`);
booted = true;
await p.waitForFunction(() => window.__app?.win, null, { timeout: 30000 });
await p.waitForTimeout(1500);

// page helpers
await p.evaluate(() => {
  const a = window.__app;
  a.settings.paused = true;
  a.autoRes.enabled = false;
  const H = window.__wc = {};
  H.frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  // walk the focus until the window's origin is o (world cells, x and z): one
  // move per frame at most. The focus stops LEAD cells past the centre o
  // makes, in the direction of travel: within the hysteresis there, but past
  // it from the origin a move short of o.
  const LEAD = 12;
  H.walk = async (o, limit) => {
    const w = a.win, sim = a.sim, g = sim.g;
    const dir = [Math.sign(o[0] - sim.origin.x), Math.sign(o[1] - sim.origin.z)];
    a.worldFocus = [o[0] + g.nx / 2 + LEAD * dir[0], o[1] + g.nz / 2 + LEAD * dir[1]];
    const moves = [];
    for (let i = 0; i < limit; i++) {
      await H.frames(1);
      if (w.last && moves[moves.length - 1] !== w.last) moves.push(w.last);
      if (!w.pending && sim.origin.x === o[0] && sim.origin.z === o[1]) break;
    }
    await w.pending;
    return moves;
  };
  // every cell of the window, as [A, B] float arrays per world brick
  H.bricks = () => {
    const sim = a.sim, g = sim.g, [A, B] = sim.readState(), o = sim.origin, out = new Map();
    for (let bz = 0; bz < g.nz / 4; bz++)
      for (let by = 0; by < g.ny / 4; by++)
        for (let bx = 0; bx < g.nx / 4; bx++) {
          const a8 = new Float32Array(512);
          let n = 0;
          for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
            const i = sim.cellTexel(bx * 4 + x, by * 4 + y, bz * 4 + z) * 4;
            a8.set(A.subarray(i, i + 4), n); a8.set(B.subarray(i, i + 4), 256 + n); n += 4;
          }
          out.set(`${o.x / 4 + bx},${by},${o.z / 4 + bz}`, a8);
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
});
const res = {};
const evalPage = (fn, arg) => p.evaluate(fn, arg);

// ------------------------------------------------------------- 1. diff
if (!skip.has(1)) res.diff = await evalPage(async ([O]) => {
  const a = window.__app, H = window.__wc, w = a.win, sim = a.sim, g = sim.g;
  const { STORE_MATTER_T } = await import('/src/shaders/generate.js');
  a.worldLoad([O[0], 0, O[1]]);
  const withTrees = H.bricks();
  // the generator alone (no trees) over the same window
  w.gen.fill(w.P, [O[0], 0, O[1]]);
  const bare = H.bricks();
  const treeBricks = new Set([...withTrees].filter(([k, v]) => H.compare(v, bare.get(k), 0, 0) !== 'same').map(([k]) => k));
  // the diff pass over the window with its trees, slab by slab, read back now
  a.worldLoad([O[0], 0, O[1]]);
  const flagged = new Set(), r = a.renderer;
  for (let x0 = 0; x0 < g.nx; x0 += 16) {
    const bricks = [4, g.ny / 4, g.nz / 4], n = bricks[0] * bricks[1] * bricks[2];
    w.gen.diff(w.P, [x0, 0, 0], bricks, w.diffTarget);
    const f = new Uint8Array(w.diffTarget.width * w.diffTarget.height * 4);
    r.readRenderTargetPixels(w.diffTarget, 0, 0, w.diffTarget.width, w.diffTarget.height, f);
    for (let i = 0; i < n; i++) if (f[i * 4]) flagged.add(`${O[0] / 4 + x0 / 4 + (i % 4)},${Math.floor(i / 4) % bricks[1]},${O[1] / 4 + Math.floor(i / (4 * bricks[1]))}`);
  }
  const missed = [...treeBricks].filter((k) => !flagged.has(k)).length;
  const extra = [...flagged].filter((k) => !treeBricks.has(k)).length;
  return { treeBricks: treeBricks.size, flagged: flagged.size, missed, extra, ok: missed === 0 && extra === 0, matterTolerance: STORE_MATTER_T };
}, [COAST]);

// ------------------------------------------------------------- 2. round trip, 3. seams
if (!skip.has(2)) {
  res.roundTrip = await evalPage(async ([START, LOOP, SETTLE_STEPS, FRAME_LIMIT]) => {
    const a = window.__app, H = window.__wc, w = a.win, sim = a.sim, g = sim.g;
    const { E } = await import('/src/elements.js');
    const { heightAt, layersAt, treesIn } = await import('/src/world/generator.js');
    const { STORE_MATTER_T } = await import('/src/shaders/generate.js');
    const { PHYS } = await import('/src/physics.js');
    const V3 = a.camera.position.constructor;   // THREE.Vector3 (bare imports don't resolve here)
    a.settings.paused = true;
    a.worldLoad([START[0], 0, START[1]]);
    a.worldFocus = [sim.origin.x + g.nx / 2, sim.origin.z + g.nz / 2];   // stay here until the walk
    const fresh = H.bricks();
    // sand dropped, water poured, a wall built in a clearing by the window's
    // centre (grid cells): dry ground, no plants, no tree within reach
    const ground = (x, z) => Math.floor(heightAt(sim.origin.x + x, sim.origin.z + z, w.P) + 0.5);
    const CLEAR = 14;        // cells around the spot with no tree trunk
    const SEARCH = 44;       // cells from the window's centre the spot may be
    const SEARCH_STEP = 4;   // cells between candidates
    let c = null;
    for (let r = 0; r <= SEARCH && !c; r += SEARCH_STEP)
      for (let k = 0; k < 16 && !c; k++) {
        const x = Math.round(g.nx / 2 + r * Math.cos(k * Math.PI / 8)), z = Math.round(g.nz / 2 + r * Math.sin(k * Math.PI / 8));
        const wx = sim.origin.x + x, wz = sim.origin.z + z, L = layersAt(wx, wz, w.P);
        if (L.ground <= w.P.sea + 1 || L.plant) continue;
        if (treesIn(wx - CLEAR, wz - CLEAR, wx + CLEAR, wz + CLEAR, w.P).length) continue;
        c = [x, z];
      }
    c ??= [g.nx / 2, g.nz / 2];
    const strokes = [
      { tool: E.SAND, at: [c[0], ground(c[0], c[1]) + 14, c[1]], radius: 5, shape: 0 },
      { tool: E.WATER, at: [c[0] + 14, ground(c[0] + 14, c[1]) + 10, c[1]], radius: 5, shape: 0 },
      { tool: E.WALL, at: [c[0] - 14, ground(c[0] - 14, c[1]) + 3, c[1] + 6], radius: 3, shape: 1 },
    ];
    for (const s of strokes) {
      sim.paint({ center: new V3(...s.at), radius: s.radius, shape: s.shape, tool: s.tool, rate: 1, replace: s.tool === E.WALL });
    }
    for (let i = 0; i < SETTLE_STEPS; i++) sim.step();
    await H.frames(2);
    const before = H.bricks();
    // bricks the strokes changed: an element differs from the fresh world in some cell
    const edited = [...before].filter(([k, v]) => {
      const f = fresh.get(k);
      for (let i = 0; i < 64; i++) if (Math.round(v[i * 4]) !== Math.round(f[i * 4])) return true;
      return false;
    }).map(([k]) => k);
    // the walk; the window holds the seams check at the far end
    const legs = [];
    let far = null, storeMax = { bricks: 0, bytes: 0 };
    for (const [i, o] of LOOP.entries()) {
      const moves = await H.walk(o, FRAME_LIMIT);
      const st = w.stats();
      if (st.bytes > storeMax.bytes) storeMax = st;
      legs.push({ to: o, moves: moves.length, reached: sim.origin.x === o[0] && sim.origin.z === o[1], store: st });
      if (i === 1) {
        // 3. seams: this window, built slab by slab, against one generated here in one go
        const { Simulation } = await import('/src/sim.js');
        const { WorldWindow } = await import('/src/world/window.js');
        const built = sim.readState();
        const sim2 = new Simulation(a.renderer, g.nx, g.ny, g.nz);
        const w2 = new WorldWindow(a.renderer, sim2, { size: w.size, seed: w.P.seed, scene: w.scene });
        w2.load([sim.origin.x, 0, sim.origin.z]);
        const one = sim2.readState();
        let cells = 0, diffA = 0, diffB = 0;
        for (let t = 0; t < built[0].length; t += 4) {
          const ia = sim.texelCell(t / 4);
          if (!ia) continue;
          cells++;
          for (let k = 0; k < 4; k++) {
            if (!Object.is(built[0][t + k], one[0][t + k])) { diffA++; break; }
          }
          for (let k = 0; k < 4; k++) {
            if (!Object.is(built[1][t + k], one[1][t + k])) { diffB++; break; }
          }
        }
        far = { origin: [sim.origin.x, sim.origin.z], cells, cellsDifferingA: diffA, cellsDifferingB: diffB, treesPlantedHere: w2.stats().planted };
        w2.dispose();
        sim2.dispose();
      }
    }
    const after = H.bricks();
    // compare every brick of the window with its state before the walk
    const tally = { same: 0, equivalent: 0, different: 0, missing: 0 };
    const differentKeys = [];
    // a brick that came back changed (only in what the store ignores) was
    // regenerated: it must be the freshly loaded world's, bit for bit
    let regenerated = 0, regeneratedAsFresh = 0;
    for (const [k, v] of before) {
      if (!after.has(k)) { tally.missing++; continue; }
      const r = H.compare(v, after.get(k), PHYS.AIR_REST_T, STORE_MATTER_T);
      tally[r]++;
      if (r === 'equivalent') { regenerated++; if (H.compare(fresh.get(k), after.get(k), 0, 0) === 'same') regeneratedAsFresh++; }
      if (r === 'different' && differentKeys.length < 10) differentKeys.push(k);
    }
    if (tally.missing) return { error: 'the walk did not come back', origin: [sim.origin.x, sim.origin.z], legs, seams: far };
    const editedExact = edited.filter((k) => H.compare(before.get(k), after.get(k), 0, 0) === 'same').length;
    // matter cells of the edits that came back
    const count = (snap, id) => edited.reduce((n, k) => { const v = snap.get(k); for (let i = 0; i < 64; i++) if (Math.round(v[i * 4]) === id) n++; return n; }, 0);
    return {
      spot: [sim.origin.x + c[0], sim.origin.z + c[1]],
      editedBricks: edited.length, editedBricksExact: editedExact,
      cells: { sand: [count(before, E.SAND), count(after, E.SAND)], water: [count(before, E.WATER), count(after, E.WATER)], wall: [count(before, E.WALL), count(after, E.WALL)] },
      bricks: tally, regenerated, regeneratedAsFresh, differentKeys, legs, storeMax, storeAfter: w.stats(), seams: far,
      ok: editedExact === edited.length && tally.different === 0 && regeneratedAsFresh === regenerated
        && far && far.cellsDifferingA === 0 && far.cellsDifferingB === 0,
    };
  }, [START, LOOP, SETTLE_STEPS, FRAME_LIMIT]);
}

// stills: park the frame loop, optionally aim the focus one move east, then
// let exactly one frame run (at jitter index K) and capture what it drew. pin:
// the passes keep seeing the origin from before the move (the control: a
// renderer that isn't anchored in the world), until unpin().
async function still(path, K, move = false, pin = false) {
  await p.evaluate(async ([K, move, pin]) => {
    const a = window.__app, sim = a.sim, g = sim.g;
    window.__hold();
    for (let i = 0; i < 2; i++) await window.__rawFrame();
    if (pin) sim.originUniform.value = sim.origin.clone();
    if (move) a.worldFocus = [sim.origin.x + g.nx / 2 + 16 + 5, sim.origin.z + g.nz / 2];
    a.requestRender();
    a.volume.material.uniforms.uFrame.value = K - 1;
    window.__release();
    window.__hold();
    for (let i = 0; i < 2; i++) await window.__rawFrame();
  }, [K, move, pin]);
  await p.screenshot({ path });
  await p.evaluate(() => window.__release());
}
const unpin = () => p.evaluate(() => { const sim = window.__app.sim; sim.originUniform.value = sim.origin; });
const ae = (x, y) => {
  try { return +execFileSync('compare', ['-metric', 'AE', '-fuzz', '1%', x, y, 'null:'], { stdio: 'pipe' }).toString().split(' ')[0]; }
  catch (e) { return +String(e.stderr).split(' ')[0]; }
};
const rmse = (x, y) => {
  try { return execFileSync('compare', ['-metric', 'RMSE', x, y, 'null:'], { stdio: 'pipe' }).toString(); }
  catch (e) { return String(e.stderr).trim(); }
};

// ------------------------------------------------------------- 3b. a still across the slabs
// An elevated view of a coastal window whose far quarter came in a slab at a
// time (4 moves south), the box's edges marking the window.
if (out && !skip.has(3)) {
  await p.evaluate(async ([O, SETTLE_FRAMES]) => {
    const a = window.__app, H = window.__wc, g = a.sim.g;
    a.post.settings.taa = true;
    a.worldLoad([O[0] - g.nx / 2, 0, O[1] - g.nz / 2]);
    await H.walk([O[0] - g.nx / 2, O[1]], 600);
    const s = a.scale, v = a.volume.position;
    a.camera.position.set(v.x + 0.5 * g.nx * s, v.y + 1.05 * g.ny * s, v.z - 0.05 * g.nz * s);
    a.controls.target.set(v.x + 0.5 * g.nx * s, v.y + 0.12 * g.ny * s, v.z + 0.7 * g.nz * s);
    a.controls.update();
    a.post.reset();
    await H.frames(SETTLE_FRAMES);
  }, [COAST, SETTLE_FRAMES]);
  await still(`${out}/seams.png`, JUMP_FRAME);
}

// ------------------------------------------------------------- 4. no texture jump, and the pop
if (!skip.has(4) && out) {
  res.jump = {};
  // moved: the render history moves with the cells; reset: it starts over
  // (the pop); unanchored: moved, but drawn with the origin from before the move
  for (const tag of ['moved', 'reset', 'unanchored']) {
    const keep = tag !== 'reset', pin = tag === 'unanchored';
    await p.evaluate(async ([O, keep, SETTLE_FRAMES]) => {
      const a = window.__app, H = window.__wc, sim = a.sim, g = sim.g;
      a.post.settings.taa = false;   // compare frames, not their history
      sim.shiftKeepsHistory = keep;
      a.worldLoad([O[0], 0, O[1]]);
      a.worldFocus = [sim.origin.x + g.nx / 2, sim.origin.z + g.nz / 2];
      // close over the middle of the window, the box's sides out of view
      const s = a.scale, v = a.volume.position;
      const { heightAt } = await import('/src/world/generator.js');
      const gx = g.nx / 2, gz = g.nz / 2, gy = heightAt(sim.origin.x + gx, sim.origin.z + gz, a.win.P);
      a.camera.position.set(v.x + (gx - 22) * s, (gy + 16) * s, v.z + (gz - 22) * s);
      a.controls.target.set(v.x + (gx + 6) * s, gy * s, v.z + (gz + 6) * s);
      a.controls.update();
      await H.frames(SETTLE_FRAMES);
    }, [COAST, keep, SETTLE_FRAMES]);
    await still(`${out}/jump-${tag}-before.png`, JUMP_FRAME);
    // one move east, made and drawn in the same frame: the camera stays where it is in the world
    const o0 = await p.evaluate(() => window.__app.sim.origin.x);
    await still(`${out}/jump-${tag}-after1.png`, JUMP_FRAME, true, pin);
    const o1 = await p.evaluate(() => window.__app.sim.origin.x);
    if (o1 !== o0 + 16) throw new Error(`jump: the window didn't move once (${o0} → ${o1})`);
    await p.evaluate(async (n) => { await window.__app.win.pending; await window.__wc.frames(n); }, SETTLE_FRAMES);
    await still(`${out}/jump-${tag}-settled.png`, JUMP_FRAME);
    await unpin();
    res.jump[tag] = {
      firstFrame: { pixels: ae(`${out}/jump-${tag}-before.png`, `${out}/jump-${tag}-after1.png`), rmse: rmse(`${out}/jump-${tag}-before.png`, `${out}/jump-${tag}-after1.png`) },
      settled: { pixels: ae(`${out}/jump-${tag}-before.png`, `${out}/jump-${tag}-settled.png`), rmse: rmse(`${out}/jump-${tag}-before.png`, `${out}/jump-${tag}-settled.png`) },
    };
  }
  await p.evaluate(() => { window.__app.sim.shiftKeepsHistory = true; window.__app.post.settings.taa = true; });
}

// ------------------------------------------------------------- 5. cost
if (!skip.has(5)) {
  res.cost = await evalPage(async ([O, COST_MOVES, WALK_FRAMES, WALK_SPEED]) => {
    const a = window.__app, H = window.__wc, sim = a.sim, g = sim.g, w = a.win;
    const median = (v) => [...v].sort((x, y) => x - y)[v.length >> 1];
    const pct = (v, q) => [...v].sort((x, y) => x - y)[Math.min(v.length - 1, Math.floor(q * v.length))];
    const sum = (v) => ({ median: +median(v).toFixed(2), p95: +pct(v, 0.95).toFixed(2), max: +Math.max(...v).toFixed(2) });
    a.settings.paused = true;
    a.worldLoad([O[0], 0, O[1]]);
    a.worldFocus = [sim.origin.x + g.nx / 2, sim.origin.z + g.nz / 2];
    await H.frames(5);
    // one move at a time: CPU (no sync), CPU + GPU (synced), the readback's
    // latency and storing. Every other move instead times each pass on the GPU
    // the way gfx/profiler.js does: after the pass, wait for its target with a
    // 1-texel read, less a calibrated sync.
    const types = { f32: sim.targets[0].texture.type, f16: sim.flowV.texture.type };
    const bufs = { f32: new Float32Array(4), f16: new Uint16Array(4), u8: new Uint8Array(4) };
    const readBuf = (t) => (t.texture.type === types.f32 ? bufs.f32 : t.texture.type === types.f16 ? bufs.f16 : bufs.u8);
    const cal = new sim.targets[0].constructor(1, 1);
    const r = a.renderer;
    const syncCal = () => { r.setRenderTarget(cal); r.clear(); r.readRenderTargetPixels(cal, 0, 0, 1, 1, bufs.f32); r.setRenderTarget(null); };
    const cpu = [], synced = [], readback = [], keep = [], kept = [], flags = [], passMs = {};
    for (let i = 0; i < COST_MOVES; i++) {
      const d = i % 4 < 2 ? 16 : -16;   // out and back, so trees and edits come and go
      const hooked = i % 2 === 1, hookWas = sim.onPass;
      sim.gpuSync();
      let overhead = 0;
      if (hooked) {
        syncCal();
        const c = [];
        for (let k = 0; k < 5; k++) { const t = performance.now(); syncCal(); c.push(performance.now() - t); }
        overhead = median(c);
        sim.onPass = (name, target) => {
          const t = performance.now();
          r.readRenderTargetPixels(target, 0, 0, 1, 1, readBuf(target));
          (passMs[name] ??= []).push(Math.max(0, performance.now() - t - overhead));
        };
      }
      const t0 = performance.now();
      w.shift(d, 0);
      const t1 = performance.now();
      sim.gpuSync();
      const t2 = performance.now();
      sim.onPass = hookWas;
      await w.pending;
      if (!hooked) { cpu.push(t1 - t0); synced.push(t2 - t0); }
      readback.push(w.last.readbackMs); keep.push(w.last.keepMs); kept.push(w.last.kept); flags.push(w.last.flagsMs);
      await H.frames(2);
    }
    cal.dispose();
    // what reading the whole staged slab back costs the main thread: the same
    // copy the async readback makes once its fence passes (GPU idle first)
    const copy = [];
    for (let k = 0; k < 3; k++) {
      sim.gpuSync();
      const t = performance.now();
      r.readRenderTargetPixels(w.stage, 0, 0, w.stage.width, w.stage.height, w.bufA, undefined, 0);
      r.readRenderTargetPixels(w.stage, 0, 0, w.stage.width, w.stage.height, w.bufB, undefined, 1);
      copy.push(performance.now() - t);
    }
    const slabCopyMs = { median: +median(copy).toFixed(2), bytes: w.bufA.byteLength + w.bufB.byteLength };
    // ...and what reading back only the differing bricks costs (the readback's second phase)
    const K = median(kept), rowsK = Math.ceil(K * 64 / w.packed.width), copyK = [];
    for (let k = 0; k < 3; k++) {
      sim.gpuSync();
      const t = performance.now();
      r.readRenderTargetPixels(w.packed, 0, 0, w.packed.width, rowsK, w.bufA, undefined, 0);
      r.readRenderTargetPixels(w.packed, 0, 0, w.packed.width, rowsK, w.bufB, undefined, 1);
      copyK.push(performance.now() - t);
    }
    const packedCopyMs = { median: +median(copyK).toFixed(2), bricks: K, bytes: 2 * rowsK * w.packed.width * 16 };
    const gpuPerPass = Object.fromEntries(Object.entries(passMs).map(([k, v]) => [k, { median: +median(v).toFixed(2), runs: v.length }]));
    const perMove = { cpu: sum(cpu), cpuAndGpu: sum(synced), flagsLatency: sum(flags), readbackLatency: sum(readback), storing: sum(keep), keptPerMove: sum(kept), gpuPerPass, slabCopyMs, packedCopyMs };
    // frame times, the sim running: the camera and its orbit target travel
    // together (the focus), out and back so the window moves, alternating
    // with a walk that circles the centre without moving it. Frames are
    // sorted by what happened in them: a move, a leaving slab landing in the
    // store, or neither.
    a.settings.paused = false;
    a.worldFocus = null;
    const walk = async (moving) => {
      const s = a.scale, cam0 = a.camera.position.clone(), tgt0 = a.controls.target.clone();
      const all = [], move = [], land = [], other = [], bake = [];
      let last = performance.now(), prev = w.last, fx = 0, fz = 0;
      for (let i = 0; i < WALK_FRAMES; i++) {
        if (moving) fx += WALK_SPEED * (i < WALK_FRAMES / 2 ? 1 : -1);
        else { fx = 8 * Math.cos(i / 20); fz = 8 * Math.sin(i / 20); }
        a.camera.position.set(cam0.x + fx * s, cam0.y, cam0.z + fz * s);
        a.controls.target.set(tgt0.x + fx * s, tgt0.y, tgt0.z + fz * s);
        await H.frames(1);
        const t = performance.now(), dt = t - last, L = w.last;
        all.push(dt);
        if (L !== prev) { move.push(dt); bake.push(L.bakeMs + L.placeMs); }
        else if (L?.landedAt > last && L.landedAt <= t) land.push(dt);
        else other.push(dt);
        prev = L;
        last = t;
      }
      a.camera.position.copy(cam0); a.controls.target.copy(tgt0);
      const opt = (v) => (v.length ? sum(v) : null);
      return { moving, frames: sum(all), moveFrames: opt(move), landingFrames: opt(land), otherFrames: opt(other),
        moves: move.length, treeCpuPerMove: opt(bake) };
    };
    const walks = [];
    for (let r = 0; r < 2; r++) { walks.push(await walk(true)); walks.push(await walk(false)); }
    a.settings.paused = true;
    return { perMove, walks, steps: a.settings.steps };
  }, [COAST, COST_MOVES, WALK_FRAMES, WALK_SPEED]);
}

console.log(JSON.stringify(res, null, 1));
console.log(errs.length ? errs.join('\n') : 'no console errors');
errs.length = 0;
await b.close();
