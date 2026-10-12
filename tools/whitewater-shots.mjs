// Pouring water, before/after: how visible a thin falling stream and a
// waterfall are, and what the whitewater does with them. Repeatable: the same
// scene, cameras and metrics every run, so two builds compare.
//
// Scene (Lab, 128³, built as a state array like presets.js): a walled tank
// kept full by a water clone, with a one-cell hole in its side 30 cells up (a
// stream pouring out of a hole in a wall), and a ledge fed by a clone that
// spills an 8-cell sheet 34 cells down (a waterfall). With --island, the same
// two pours are built on the island (World) in its clearest dry spot.
//
// Shots (Realistic view, TAA converged, the world parked): per detail level
// (Balanced = the default, Full) and camera, plus one live shot per level
// (the world running, the frame mid-motion as a player sees it).
// Contrast: each camera is shot again with the falling water removed (the
// stream's background), and in the Plain view with and without it (its mask:
// where the stream really is). Over the mask: mean CIE76 ΔE between the
// Realistic shots with and without the stream, and the share of the stream's
// pixels with ΔE ≥ VISIBLE_DE (plainly visible at a glance); and "visible
// px", every pixel on screen the falling water changes by that much (the
// mask is where the sim's parcels are: what is drawn between them lies
// outside it), i.e. how much of the screen shows it.
//
// usage: node tools/whitewater-shots.mjs <outDir> [--port 5287] [--island] [--levels balanced,full]
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';

const args = process.argv.slice(2);
const out = args[0];
if (!out || out.startsWith('--')) throw new Error('usage: node tools/whitewater-shots.mjs <outDir> [--port 5287] [--island]');
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5287');
const island = args.includes('--island');
const levels = opt('levels', 'balanced,full').split(',');
mkdirSync(out, { recursive: true });

const W = 1280, H = 800;
const STEPS = 420;           // the tank's stream and the ledge's sheet are falling and have pooled
const LIVE_MS = 1500;        // a running world before its live shot
const ISLAND_SETTLE_MS = 3000;   // after the island's window has loaded (its trees go in as frames run)
const VISIBLE_DE = 10;       // CIE76 ΔE a glance picks out (≈ 4× the 2.3 JND)
const MASK_DIFF = 0.08;      // Plain-view change (max channel, 0..1) that marks the stream's pixels

// [eye, target] in grid cells (128³ lab)
const LAB_CAMS = {
  god: null,
  tankMid: [[64, 22, 96], [42, 16, 64]],     // ~10 m off the hole's stream
  tankClose: [[56, 16, 66], [42, 16, 64]],   // ~4 m, the tank wall behind it
  tankEye: [[56, 5.5, 78], [41, 12, 64]],    // eye height (1.65 m), the stream against the sky and tank
  fallMid: [[118, 26, 62], [100, 18, 28]],   // the ledge's waterfall from ~12 m
  fallEye: [[112, 5.5, 50], [99, 14, 28]],   // eye height near the plunge
};

const b = await launchBrowser();
const p = await newTestPage(b, { mode: 'visual', viewport: { width: W, height: H } });
await p.addInitScript(() => {
  let s = 12345;   // mulberry32: same scene every run
  Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = 'body > *:not(canvas):not(:has(canvas)), .dock, .card, .topbar, .hud, .toast { visibility: hidden !important; }';
    document.head.appendChild(st);
  });
});
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 500)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));

const rows = [];
try {
  await p.goto(`http://localhost:${port}/?${island ? 'size=world&scene=island' : 'size=128&preset=empty'}&paused=1`);
  await ready(p);
  if (island) {
    await p.waitForFunction(() => window.__app.win?.loaded, null, { polling: 250, timeout: 180000 });
    await p.waitForTimeout(ISLAND_SETTLE_MS);
  }
  await p.evaluate(() => {
    const a = window.__app;
    a.autoRes.enabled = false;
    const cv = a.renderer.domElement;
    document.querySelectorAll('body *').forEach((el) => { if (!el.contains(cv)) el.style.visibility = 'hidden'; });
  });

  // ---- the scene ----
  const cams = await p.evaluate(async ([island, LAB_CAMS]) => {
    const a = window.__app, sim = a.sim;
    const { E, ELEMENTS, K } = await import('/src/elements.js');
    const { SEED_MAX } = await import('/src/shaders/common.js');
    a.test.park();
    await a.test.ready();   // (load and the steps need the grid's pipelines)
    const g = sim.g;
    const TREE = new Set(['WOOD', 'PLANT', 'MOSS', 'FUNGUS', 'VINE', 'LEAF', 'LEAVES'].map((k) => E[k]).filter((v) => v !== undefined));
    const [A, B] = island ? await sim.readState() : sim.blankState();
    const idAt = (x, y, z) => Math.round(A[sim.cellTexel(x, y, z) * 4]);
    const terrain = (id) => id && ELEMENTS[id].kind !== K.GAS && !TREE.has(id);   // (a tree's crown is not the ground)
    const ground = (x, z) => { for (let y = g.ny - 1; y >= 0; y--) if (terrain(idAt(x, y, z))) return y + 1; return 0; };
    // where the scene goes: the lab's floor; on the island the dry spot in
    // the window with the fewest trees round it (a beach, a clearing)
    let o = [0, 0, 0];
    if (island) {
      const SPOT_STEP = 8, SPOT_REACH = 16, SPOT_LO = [8, 48], SPOT_HI = [g.nx - 80, g.nz - 24];   // the layout (x 20..104, z 14..84) stays in the window
      let best = null;
      for (let x = SPOT_LO[0]; x <= SPOT_HI[0]; x += SPOT_STEP)
        for (let z = SPOT_LO[1]; z <= SPOT_HI[1]; z += SPOT_STEP) {
          const y = ground(x + 32, z);
          if (!y || ELEMENTS[idAt(x + 32, y - 1, z)].kind === K.LIQUID || y > g.ny - 50) continue;   // not over the sea, room above
          let trees = 0;
          for (let dx = 0; dx <= 64; dx += 4)
            for (let dz = -SPOT_REACH; dz <= SPOT_REACH; dz += 4)
              for (let yy = y; yy < Math.min(g.ny, y + 30); yy += 3) if (TREE.has(idAt(x + dx, yy, z + dz))) trees++;
          if (!best || trees < best.trees) best = { x, z, y, trees };
        }
      o = [best.x - 24, best.y, best.z - 64];   // the lab layout's (24, 0, 64) lands here
    }
    const set = (x, y, z, id, ctype = 0) => {
      x += o[0]; y += o[1]; z += o[2];
      if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return;
      const i = sim.cellTexel(x, y, z) * 4;
      A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = ctype + Math.random() * SEED_MAX;
      B[i] = B[i + 1] = B[i + 2] = 0;
    };
    const box = (x0, y0, z0, x1, y1, z1, id, ctype) => {
      for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) set(x, y, z, id, ctype);
    };
    if (island) box(20, 1, 44, 64, 50, 84, E.EMPTY);   // a clearing round the tank's pour
    if (island) box(66, 1, 14, 104, 50, 44, E.EMPTY);   // ... and the ledge's
    // the tank: walls, water, a clone lid keeping it full, a one-cell hole 30 up
    box(24, 0, 56, 40, 46, 72, E.WALL);
    box(25, 1, 57, 39, 44, 71, E.WATER);
    box(25, 44, 57, 39, 45, 71, E.CLONE, E.WATER);
    box(39, 30, 64, 40, 31, 65, E.EMPTY);
    // the ledge: a channel 8 wide, a clone at its back, spilling off x = 96
    box(72, 32, 22, 96, 34, 34, E.WALL);
    box(72, 34, 22, 96, 37, 23, E.WALL);
    box(72, 34, 33, 96, 37, 34, E.WALL);
    box(72, 34, 23, 74, 37, 33, E.CLONE, E.WATER);
    sim.load(A, B);
    if (!island) return LAB_CAMS;
    // the lab's cameras moved with the scene, in scene units (a window shift doesn't move them off)
    const s = (c) => a.volume.position.clone().addScaledVector({ x: c[0] + o[0], y: c[1] + o[1], z: c[2] + o[2] }, a.scale).toArray();
    return Object.fromEntries(Object.entries(LAB_CAMS).map(([k, c]) => [k, c ? { scene: [s(c[0]), s(c[1])] } : null]));
  }, [island, LAB_CAMS]);
  await p.evaluate((n) => window.__app.test.step(n), STEPS);

  const setLevel = (level) => p.evaluate(async (level) => {
    const a = window.__app;
    const { setDetailLevel } = await import('/src/gfx/detail.js');
    setDetailLevel(a.settings, level);
    a.applyDetail();
  }, level);
  const setCam = (cam) => p.evaluate((cam) => {
    const a = window.__app;
    if (!cam) { a.rig.reset(true); return; }
    if (cam.scene) {   // scene units (the island's)
      a.camera.position.fromArray(cam.scene[0]); a.controls.target.fromArray(cam.scene[1]); a.controls.update();
      return;
    }
    const g = (c) => a.volume.position.clone().addScaledVector({ x: c[0], y: c[1], z: c[2] }, a.scale);
    a.camera.position.copy(g(cam[0])); a.controls.target.copy(g(cam[1])); a.controls.update();
  }, cam);
  const setView = (v) => p.evaluate((v) => window.__app.setView(v), v);
  const shot = async (name) => { await render(p); await p.screenshot({ path: `${out}/${name}.png` }); };

  // with the falling water: Realistic per level, then Plain
  for (const level of levels) {
    await setLevel(level);
    for (const [cn, cam] of Object.entries(cams)) { await setCam(cam); await shot(`${level}-${cn}`); }
  }
  await setView(5);
  for (const [cn, cam] of Object.entries(cams)) { await setCam(cam); await shot(`plain-${cn}`); }
  await setView(0);

  // live: the world running, as a player sees the stream move
  for (const level of levels) {
    await setLevel(level);
    await setCam(cams.tankMid);
    await render(p);
    await p.evaluate(() => { const a = window.__app; a.settings.paused = false; a.test.resume(); });
    await p.waitForTimeout(LIVE_MS);
    await p.screenshot({ path: `${out}/${level}-live.png` });
    await p.evaluate(() => { const a = window.__app; a.test.park(); a.settings.paused = true; });
  }

  // without it: the falling water removed (water outside the tank, off the
  // ledge and above the floor's puddle), the stream's background
  await p.evaluate(async (island) => {
    const a = window.__app, sim = a.sim, g = sim.g;
    const { E } = await import('/src/elements.js');
    if (island) return;
    const [A, B] = await sim.readState();
    const fallBox = [[40, 3, 50, 70, 31, 78], [96, 3, 14, 124, 34, 42]];
    for (const [x0, y0, z0, x1, y1, z1] of fallBox)
      for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
        const i = sim.cellTexel(x, y, z) * 4;
        if (A[i] === E.WATER) { A[i] = E.EMPTY; A[i + 1] = 22; A[i + 2] = 0; }
      }
    sim.load(A, B);
  }, island);
  if (!island) {
    for (const level of levels) {
      await setLevel(level);
      for (const [cn, cam] of Object.entries(cams)) { await setCam(cam); await shot(`${level}-${cn}-bg`); }
    }
    await setView(5);
    for (const [cn, cam] of Object.entries(cams)) { await setCam(cam); await shot(`plain-${cn}-bg`); }
    await setView(0);
  }
} finally {
  await b.close();
}

// ---- metrics (CPU: ImageMagick decodes the PNGs) ----
const raw = (f) => execFileSync('magick', [f, '-depth', '8', 'rgb:-'], { maxBuffer: 64 << 20 });
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function lab(r, g, bb) {
  const R = lin(r / 255), G = lin(g / 255), B = lin(bb / 255);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z)), Y];
}
if (!island) {
  for (const level of levels) {
    for (const cn of Object.keys(LAB_CAMS)) {
      const p1 = raw(`${out}/plain-${cn}.png`), p0 = raw(`${out}/plain-${cn}-bg.png`);
      const r1 = raw(`${out}/${level}-${cn}.png`), r0 = raw(`${out}/${level}-${cn}-bg.png`);
      // seen: every pixel the falling water changes by VISIBLE_DE, in or out
      // of the mask (what the renderer draws between parcels is outside it)
      let n = 0, sum = 0, vis = 0, weber = 0, seen = 0;
      for (let i = 0; i < p1.length; i += 3) {
        const A = lab(r1[i], r1[i + 1], r1[i + 2]), B = lab(r0[i], r0[i + 1], r0[i + 2]);
        const de = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
        if (de >= VISIBLE_DE) seen++;
        const d = Math.max(Math.abs(p1[i] - p0[i]), Math.abs(p1[i + 1] - p0[i + 1]), Math.abs(p1[i + 2] - p0[i + 2])) / 255;
        if (d < MASK_DIFF) continue;
        n++; sum += de; if (de >= VISIBLE_DE) vis++;
        weber += Math.abs(A[3] - B[3]) / Math.max(B[3], 0.01);
      }
      rows.push({ level, cam: cn, 'stream px': n, 'mean ΔE': n ? +(sum / n).toFixed(1) : 0, [`ΔE≥${VISIBLE_DE}`]: n ? `${Math.round((100 * vis) / n)}%` : '-',
        'weber': n ? +(weber / n).toFixed(2) : 0, 'visible px': seen });
    }
  }
  console.table(rows);
  writeFileSync(`${out}/contrast.json`, JSON.stringify(rows, null, 1));
}
// contact sheets: one per level (cameras + live), downscaled
for (const level of levels) {
  const names = [...Object.keys(LAB_CAMS), 'live'];
  execFileSync('montage', [...names.map((n) => `${out}/${level}-${n}.png`), '-tile', '3x', '-geometry', '640x400+2+2',
    '-title', `${island ? 'island' : 'lab'} ${level}`, `${out}/sheet-${level}.jpg`]);
}
console.log(errs.length ? errs.join('\n') : 'no console errors');
