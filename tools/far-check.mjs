// Headless check of the far field (docs/scaling.md D11, phase W4) in world
// mode (?size=world: a 1024×128×1024 world through a 128³ window):
//   1. god: high over the world, the terrain far past the window;
//   2. eye: first-person on a hillside, toward the island's hills and toward
//      the sea;
//   3. move: frames straddling a window move, the camera fixed in the world:
//      the far field must not pop (pixels that change outside the window);
//   4. edit: a wall of lava and a cleared patch made in the window, then the
//      window walked away until they are in the far field;
//   5. cost: the scene pass with and without the far field, interleaved,
//      each GPU-synced by a 1-texel read of the target it drew (a fresh frame
//      every time: consecutive full-screen draws into one target get merged);
//      plus the far grid's build and refresh;
//   6. trees: the far field's tree placement (GPU) against treesIn's (the
//      window plants those) over a region of the island.
// usage: node tools/far-check.mjs [outDir] [--port 5471] [--skip 4,5]
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : null;
const port = opt('port', '5471');
const skip = new Set(String(opt('skip', '')).split(',').filter(Boolean).map(Number));
if (out) mkdirSync(out, { recursive: true });

const SUN = { az: 215, el: 38 };   // a fixed sun for every still
const SETTLE_FRAMES = 90;          // frames for the derived passes, GI and TAA to converge
const COST_ROUNDS = 40;            // interleaved timing rounds (each draws with and without)
const EYE_DIR = [0.82, 0.57];      // the eye view's spot: out from the island's centre this way (x, z)...
const EYE_BELOW_FROST = 3;         // ...to where the ground is this many cells under the lowest snow (bare rock: an open view)
const EYE_CLEAR = 24;              // cells around the spot with no tree trunk (on the rock)...
const EYE_BEACH_CLEAR = 20;        // ...and on the beach (palms grow there; crowns reach 16)
const TREE_REGION = [320, 320, 704, 704];   // world cells [x0, z0, x1, z1) where the tree placements are compared

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.addInitScript(() => {
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true }));
  addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = 'body *{visibility:hidden !important} #app > canvas{visibility:visible !important}';
    document.head.appendChild(st);
  });
  const raf = window.requestAnimationFrame.bind(window);
  let held = null;
  window.requestAnimationFrame = (cb) => { if (held) { held.push(cb); return 0; } return raf(cb); };
  window.__hold = () => { held ??= []; };
  window.__release = () => { const h = held ?? []; held = null; h.forEach((cb) => window.requestAnimationFrame(cb)); };
  window.__rawFrame = () => new Promise((r) => raf(() => r()));
});
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
p.on('crash', () => errs.push('PAGE CRASHED'));
process.on('exit', () => { if (errs.length) console.log(errs.join('\n')); });
const t0 = Date.now();
await p.goto(`http://localhost:${port}/?size=world`);
await p.waitForFunction(() => window.__app?.win?.far?.built, null, { timeout: 90000 });
const bootMs = Date.now() - t0;
await p.waitForTimeout(1000);

await p.evaluate(([SUN]) => {
  const a = window.__app;
  a.settings.paused = true;
  a.autoRes.enabled = false;
  a.day.fixed = SUN;
  const H = window.__fc = {};
  H.frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  // the window's centre column and its ground (world cells)
  H.ground = async (x, z) => {
    const { heightAt } = await import('/src/world/generator.js');
    return heightAt(x, z, a.win.P);
  };
  // scene units of world cell (x, y, z)
  H.scene = (x, y, z) => {
    const s = a.scale, o = a.sim.origin, v = a.volume.position;
    return [v.x + (x - o.x) * s, v.y + y * s, v.z + (z - o.z) * s];
  };
  H.look = (pos, tgt) => {
    a.camera.position.set(...pos);
    a.controls.target.set(...tgt);
    a.controls.update();
    a.post.reset();
  };
}, [SUN]);

// a still: park the loop, let exactly one frame run (at jitter and dither
// frame STILL_FRAME, the same for every still), capture it
const STILL_FRAME = 1000;
async function still(path) {
  await p.evaluate(async (K) => {
    window.__hold();
    for (let i = 0; i < 2; i++) await window.__rawFrame();
    window.__app.requestRender();
    window.__app.volume.material.uniforms.uFrame.value = K - 1;   // (gfxUniforms' frame counter: the far view's too)
    window.__release();
    window.__hold();
    for (let i = 0; i < 2; i++) await window.__rawFrame();
  }, STILL_FRAME);
  await p.screenshot({ path });
  await p.evaluate(() => window.__release());
}
const ae = (x, y) => {
  try { return +execFileSync('compare', ['-metric', 'AE', '-fuzz', '2%', x, y, 'null:'], { stdio: 'pipe' }).toString().split(' ')[0]; }
  catch (e) { return +String(e.stderr).split(' ')[0]; }
};
const res = { bootMs };

// ------------------------------------------------------------- 1. god view
if (out && !skip.has(1)) {
  await p.evaluate(async (SETTLE) => {
    const a = window.__app, H = window.__fc, g = a.sim.g, w = a.win;
    a.worldLoad(w.centre());
    const c = [w.size[0] / 2, w.size[2] / 2];
    H.look(H.scene(c[0] - 380, 520, c[1] + 620), H.scene(c[0], 20, c[1] - 40));
    await H.frames(SETTLE);
  }, SETTLE_FRAMES);
  await still(`${out}/god.png`);
  res.god = await p.evaluate(() => window.__app.win.far.last);
}

// ------------------------------------------------------------- 2. eye level, first person
// Two spots out along EYE_DIR: the bare rock under the snow, looking out over
// the slopes to the sea; a beach, looking inland to the hills.
if (out && !skip.has(2)) {
  for (const [tag, from, toward] of [['sea', 'rock', 'edge'], ['hills', 'beach', 'centre']]) {
    await p.evaluate(async ([DIR, BELOW, CLEAR, BEACH_CLEAR, from, toward, SETTLE]) => {
      const a = window.__app, H = window.__fc, g = a.sim.g, w = a.win;
      const { heightAt, frostLine, treesIn } = await import('/src/world/generator.js');
      const c = [w.size[0] / 2, w.size[2] / 2];
      const clear = (x, z, r) => !treesIn(x - r, z - r, x + r, z + r, w.P).length;
      let spot = c;
      if (from === 'rock') {
        // out from the centre to the bare rock under the snow, then on to a spot with no tree near
        for (let r = 0; r < c[0]; r += 2) {
          const x = c[0] + DIR[0] * r, z = c[1] + DIR[1] * r;
          if (heightAt(x, z, w.P) <= frostLine(w.P) - BELOW && clear(x, z, CLEAR)) { spot = [x, z]; break; }
        }
      } else {
        // in from the world's edge to the first dry land, then on to a spot with no tree near
        let land = false;
        for (let r = c[0]; r > 0; r -= 2) {
          const x = c[0] + DIR[0] * r, z = c[1] + DIR[1] * r;
          land ||= heightAt(x, z, w.P) > w.P.sea + 1;
          if (land && clear(x, z, BEACH_CLEAR)) { spot = [x, z]; break; }
        }
      }
      if (a.pov.active) { a.pov.exit(true); await H.frames(3); }
      a.worldLoad([Math.round((spot[0] - g.nx / 2) / 16) * 16, 0, Math.round((spot[1] - g.nz / 2) / 16) * 16]);
      await H.frames(10);
      await a.pov.enter();
      await H.frames(120);   // swoop in, land
      const o = a.sim.origin, pp = a.pov.player.pos;
      const here = [o.x + pp.x, o.z + pp.z];
      const d = toward === 'centre' ? [c[0] - here[0], c[1] - here[1]] : [here[0] - c[0], here[1] - c[1]];
      a.pov.setLook(Math.atan2(-d[0], -d[1]), toward === 'centre' ? 0.06 : -0.04);
      await H.frames(SETTLE);
    }, [EYE_DIR, EYE_BELOW_FROST, EYE_CLEAR, EYE_BEACH_CLEAR, from, toward, SETTLE_FRAMES]);
    await still(`${out}/eye-${tag}.png`);
  }
  await p.evaluate(async () => { window.__app.pov.exit(true); await window.__fc.frames(5); });
}

// ------------------------------------------------------------- 3. a window move: no far-field pop
if (out && !skip.has(3)) {
  await p.evaluate(async (SETTLE) => {
    const a = window.__app, H = window.__fc, g = a.sim.g, w = a.win;
    a.post.settings.taa = false;   // compare frames, not their history
    const c = w.centre();
    a.worldLoad([c[0] - 160, 0, c[2] + 64]);
    a.worldFocus = [a.sim.origin.x + g.nx / 2, a.sim.origin.z + g.nz / 2];
    const ox = a.sim.origin.x, oz = a.sim.origin.z;
    H.look(H.scene(ox - 150, 210, oz + g.nz / 2 + 260), H.scene(ox + g.nx / 2, 30, oz + g.nz / 2));
    await H.frames(SETTLE);
  }, SETTLE_FRAMES);
  await still(`${out}/move-before.png`);
  await p.evaluate(async () => {
    const a = window.__app, g = a.sim.g;
    a.worldFocus = [a.sim.origin.x + g.nx / 2 + 16 + 5, a.sim.origin.z + g.nz / 2];
    await window.__fc.frames(3);
    await a.win.pending;
  });
  await still(`${out}/move-after1.png`);
  await p.evaluate(async (SETTLE) => { await window.__fc.frames(SETTLE); }, SETTLE_FRAMES);
  await still(`${out}/move-settled.png`);
  // the far field's own pixels: the window's box before and after the move (its screen rectangle) blacked out
  const rect = await p.evaluate(() => {
    const a = window.__app, g = a.sim.g, s = a.scale, v = a.volume.position, d = a.win.last?.dx ?? 0;
    const V = a.camera.position.constructor;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      // the moved box sits at v; the old one d cells back along x
      const q = new V(v.x + ((i & 1) ? g.nx : -d) * s, v.y + ((i >> 1) & 1) * g.ny * s, v.z + ((i >> 2) & 1) * g.nz * s).project(a.camera);
      const x = (q.x * 0.5 + 0.5) * innerWidth, y = (0.5 - q.y * 0.5) * innerHeight;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return [x0, y0, x1, y1].map(Math.round);
  });
  const mask = (f) => {
    const m = f.replace('.png', '-masked.png');
    execFileSync('magick', [f, '-fill', 'black', '-draw', `rectangle ${rect.join(',')}`, m]);
    return m;
  };
  const [mb, m1, ms] = ['move-before', 'move-after1', 'move-settled'].map((n) => mask(`${out}/${n}.png`));
  res.move = {
    moved: await p.evaluate(() => window.__app.win.last && [window.__app.win.last.dx, window.__app.win.last.dz]),
    windowRect: rect,
    firstFramePixels: ae(`${out}/move-before.png`, `${out}/move-after1.png`),
    farFieldPixels: ae(mb, m1),
    farFieldSettledPixels: ae(mb, ms),
  };
  await p.evaluate(() => { window.__app.post.settings.taa = true; window.__app.worldFocus = null; });
}

// ------------------------------------------------------------- 4. an edit that left the window
if (out && !skip.has(4)) {
  res.edit = await p.evaluate(async (SETTLE) => {
    const a = window.__app, H = window.__fc, g = a.sim.g, w = a.win, sim = a.sim;
    const { E } = await import('/src/elements.js');
    const V3 = a.camera.position.constructor;
    const c = w.centre();
    a.worldLoad([c[0] - 96, 0, c[2] + 96]);
    a.worldFocus = [sim.origin.x + g.nx / 2, sim.origin.z + g.nz / 2];
    // a wall of lava across the middle of the window and, beside it, a patch cleared down to below the ground
    const gx = g.nx / 2, gz = g.nz / 2;
    const gnd = Math.round(await H.ground(sim.origin.x + gx, sim.origin.z + gz));
    for (let k = -5; k <= 5; k++) {
      sim.paint({ center: new V3(gx + 4 * k, gnd + 6, gz), radius: 3, shape: 1, tool: E.LAVA, rate: 1, replace: true });
      sim.paint({ center: new V3(gx + 4 * k, gnd + 11, gz), radius: 3, shape: 1, tool: E.LAVA, rate: 1, replace: true });
    }
    for (let k = -3; k <= 3; k++) for (let j = -3; j <= 3; j++) {
      sim.paint({ center: new V3(gx + 5 * k, gnd, gz + 24 + 5 * j), radius: 4, shape: 1, tool: E.EMPTY, rate: 1, replace: true });
    }
    for (let i = 0; i < 6; i++) sim.step();
    await H.frames(2);
    const edited = [sim.origin.x + gx, sim.origin.z + gz];
    // walk the window two widths east: the edits are far field now
    const target = sim.origin.x + 2 * g.nx;
    a.worldFocus = [target + g.nx / 2 + 12, sim.origin.z + g.nz / 2];
    for (let i = 0; i < 400 && (sim.origin.x !== target || w.pending); i++) await H.frames(1);
    await w.pending;
    a.worldFocus = [sim.origin.x + g.nx / 2, sim.origin.z + g.nz / 2];
    // look back at the edits from above the old window's west side
    H.look(H.scene(edited[0] - 120, gnd + 110, edited[1] + 150), H.scene(edited[0], gnd + 4, edited[1] + 8));
    await H.frames(SETTLE);
    return { edited, originNow: [sim.origin.x, sim.origin.z], store: w.stats() };
  }, SETTLE_FRAMES);
  await still(`${out}/edit-far.png`);
  // the same spot in a freshly loaded world (no edits), for comparison
  await p.evaluate(async ([ed, SETTLE]) => {
    const a = window.__app, H = window.__fc, sim = a.sim;
    const o = [sim.origin.x, sim.origin.z];
    const cam = a.camera.position.clone(), tgt = a.controls.target.clone();
    a.worldLoad([o[0], 0, o[1]]);
    a.camera.position.copy(cam); a.controls.target.copy(tgt); a.controls.update(); a.post.reset();
    await H.frames(SETTLE);
  }, [res.edit.edited, SETTLE_FRAMES]);
  await still(`${out}/edit-far-fresh.png`);
  await p.evaluate(() => { window.__app.worldFocus = null; });
}

// ------------------------------------------------------------- 5. cost
if (!skip.has(5)) {
  res.cost = await p.evaluate(async ([ROUNDS, SETTLE]) => {
    const a = window.__app, H = window.__fc, r = a.renderer, THREE = a.THREE, far = a.win.far, g = a.sim.g, w = a.win;
    const median = (v) => [...v].sort((x, y) => x - y)[v.length >> 1];
    const c = w.centre();
    a.worldLoad(c);
    const cams = {
      god: () => H.look(H.scene(c[0] - 380 + g.nx / 2, 520, c[2] + g.nz / 2 + 620), H.scene(c[0] + g.nx / 2, 20, c[2] + g.nz / 2 - 40)),
      low: () => H.look(H.scene(c[0] + g.nx / 2 + 300, 120, c[2] + g.nz / 2 + 300), H.scene(c[0] + g.nx / 2 - 100, 40, c[2] + g.nz / 2 - 100)),
    };
    const out = {};
    for (const [name, set] of Object.entries(cams)) {
      set();
      await H.frames(SETTLE);
      for (const scale of [a.post.renderScale, 1]) {
        const size = r.getDrawingBufferSize(new THREE.Vector2());
        const w = Math.round(size.x * scale), h = Math.round(size.y * scale);
        const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
        const buf = new Uint16Array(4);
        const sync = () => r.readRenderTargetPixels(rt, 0, 0, 1, 1, buf);
        const draw = (on) => {
          far.mesh.visible = on;
          r.setRenderTarget(rt);
          r.clear();
          r.render(a.scene, a.camera);
          sync();
          r.setRenderTarget(null);
        };
        const t = { on: [], off: [] };
        for (let i = 0; i < ROUNDS; i++) {
          for (const on of i % 2 ? [true, false] : [false, true]) {
            draw(on);   // warm: a frame of the same kind, so caches and the merged-draw path are equal
            const t0 = performance.now();
            draw(on);
            t[on ? 'on' : 'off'].push(performance.now() - t0);
          }
        }
        far.mesh.visible = true;
        rt.dispose();
        out[`${name}@${w}x${h}`] = { withFar: +median(t.on).toFixed(2), without: +median(t.off).toFixed(2), far: +(median(t.on) - median(t.off)).toFixed(2) };
      }
    }
    // the build and a refresh, GPU-synced
    const syncSim = () => a.sim.gpuSync();
    const builds = [], refreshes = [], summaries = [];
    for (let i = 0; i < 5; i++) {
      syncSim(); let t0 = performance.now(); far.build(); syncSim(); builds.push(performance.now() - t0);
      syncSim(); t0 = performance.now(); far.summarizeWindow(); far.refresh(true); syncSim(); summaries.push(performance.now() - t0);
      syncSim(); t0 = performance.now(); far.shadowKey = ''; far.refresh(); syncSim(); refreshes.push(performance.now() - t0);
    }
    out.buildMs = +median(builds).toFixed(2);
    out.windowSummaryAndRefreshMs = +median(summaries).toFixed(2);
    out.shadowRefreshMs = +median(refreshes).toFixed(2);
    return out;
  }, [COST_ROUNDS, SETTLE_FRAMES]);
}

// ------------------------------------------------------------- 6. trees: the GPU's placement against treesIn
if (!skip.has(6)) {
  res.trees = await p.evaluate(async (REGION) => {
    const a = window.__app, w = a.win, r = a.renderer;
    const { treesIn, TREE } = await import('/src/world/generator.js');
    const { TREE_VARIANTS } = await import('/src/shaders/far.js');
    const { BRICK } = await import('/src/shaders/common.js');
    const t = w.far.placeTrees();
    const n = t.width * t.height, buf = new Float32Array(n * 4);
    r.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
    t.dispose();
    const gpu = new Map();   // trunk column → { variant, size, ground }
    for (let i = 0; i < n; i++) {
      if (!buf[i * 4]) continue;
      const k = buf[i * 4] - 1, bx = i % t.width, bz = Math.floor(i / t.width);
      const x = bx * BRICK + (k % BRICK), z = bz * BRICK + (Math.floor(k / BRICK) % BRICK);
      if (x < REGION[0] || x >= REGION[2] || z < REGION[1] || z >= REGION[3]) continue;
      const rest = Math.floor(k / (BRICK * BRICK));
      gpu.set(`${x},${z}`, { variant: TREE_VARIANTS[rest % TREE_VARIANTS.length], size: TREE.SIZE_MIN + Math.floor(rest / TREE_VARIANTS.length), ground: buf[i * 4 + 1] });
    }
    const js = treesIn(REGION[0], REGION[1], REGION[2], REGION[3], w.P);
    let same = 0, differ = 0, onlyJs = 0;
    for (const tr of js) {
      const key = `${tr.x},${tr.z}`, gt = gpu.get(key);
      if (!gt) { onlyJs++; continue; }
      gpu.delete(key);
      if (gt.variant === tr.variant && gt.size === tr.size && gt.ground === tr.y) same++; else differ++;
    }
    return { treesIn: js.length, same, differ, onlyTreesIn: onlyJs, onlyGpu: gpu.size };
  }, TREE_REGION);
}

console.log(JSON.stringify(res, null, 1));
console.log(errs.length ? errs.join('\n') : 'no console errors');
errs.length = 0;
await b.close();
