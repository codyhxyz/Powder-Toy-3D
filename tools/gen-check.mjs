// Headless check of the world generator (src/world, src/shaders/generate.js):
//   - the Island scene loads without console errors;
//   - fill time: the column + fill passes on the grid, wall clock with a forced
//     sync (a 1-texel readback of the written target), median and minimum of
//     FILL_RUNS (other sessions share the GPU: the minimum is the uncontended cost);
//   - stability: the element at every cell after --steps steps vs right after
//     loading (cells whose element changed, by from → to);
//   - the JS twin (heightAt) against the GPU's column heights;
//   - seams: the grid generated at a shifted world origin matches the
//     overlapping cells exactly, and a slab fill keeps the cells outside it;
//   - the far-field brick summary against a CPU tally of the generated cells;
//   - stills: god view, three-quarter, eye level on a meadow and on a beach.
// usage: node tools/gen-check.mjs [outDir] [--port 5371] [--size 128|wide|64|96]
//          [--seed N] [--steps 600] [--no-shots] [--verbose: list the changed cells]
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : null;
const port = opt('port', '5371');
const size = opt('size', '128');
const seed = opt('seed', null);
const steps = +opt('steps', 600);
const shots = out && !args.includes('--no-shots');
const verbose = args.includes('--verbose');
const FILL_RUNS = 15;
const TAA_FRAMES = 40;     // frames for TAA to converge on a still view
const EYE_CELLS = 5.5;     // eye height above the ground, cells (the POV body's eye)
if (out) mkdirSync(out, { recursive: true });

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.addInitScript(() => {
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true }));
  addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = 'body *{visibility:hidden !important} #app > canvas{visibility:visible !important}';
    document.head.appendChild(st);
  });
});
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 600)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
await p.goto(`http://localhost:${port}/?preset=island&size=${size}${seed != null ? `&seed=${seed}` : ''}`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 30000 });
await p.waitForTimeout(1500);

const res = await p.evaluate(async ([steps, FILL_RUNS, seed, verbose]) => {
  const a = window.__app;
  a.settings.paused = true;
  a.autoRes.enabled = false;
  const { generatorFor, loadIsland } = await import('/src/world/gpu.js');
  const { worldParams, treesIn, heightAt } = await import('/src/world/generator.js');
  const { ELEMENTS } = await import('/src/elements.js');
  const sim = a.sim, g = sim.g, r = a.renderer;
  const P = worldParams({ size: [g.nx, g.ny, g.nz], seed: seed == null ? undefined : +seed });
  const gen = generatorFor(sim);
  const px = new Float32Array(4);
  const sync = () => r.readRenderTargetPixels(sim.targets[sim.cur], 0, 0, 1, 1, px, undefined, 0);
  const median = (v) => v.sort((x, y) => x - y)[v.length >> 1];
  const stat = (v) => `${median(v).toFixed(2)} (min ${Math.min(...v).toFixed(2)})`;
  const time = (fn) => { const t0 = performance.now(); fn(); sync(); return performance.now() - t0; };

  // timing (the first run compiles the shaders)
  time(() => loadIsland(sim, { seed: P.seed }));
  const fill = [], column = [], fillOnly = [], trees = [];
  for (let i = 0; i < FILL_RUNS; i++) {
    gen.columnsKey = '';
    fill.push(time(() => gen.fill(P)));
    column.push(time(() => { gen.columnsKey = ''; gen.updateColumns(P, [0, 0, 0]); }));
    fillOnly.push(time(() => gen.fill(P)));
    trees.push(time(() => gen.plantTrees(P)));
  }
  const treeList = treesIn(0, 0, g.nx, g.nz, P);

  // stability
  loadIsland(sim, { seed: P.seed });
  const read = () => {
    const { width, height, nx, ny, nz, tx } = g;
    const buf = new Float32Array(width * height * 4);
    r.readRenderTargetPixels(sim.targets[sim.cur], 0, 0, width, height, buf, undefined, 0);
    const ids = new Uint8Array(nx * ny * nz), T = new Float32Array(nx * ny * nz);
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          const i = ((Math.floor(y / tx) * nz + z) * width + (y % tx) * nx + x) * 4, j = (y * nz + z) * nx + x;
          ids[j] = Math.round(buf[i]); T[j] = buf[i + 1];
        }
    return { ids, T };
  };
  const s0 = read();
  sim.frame = 0;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) sim.step();
  sync();
  const stepMs = (performance.now() - t0) / steps;
  const s1 = read();
  const name = (id) => ELEMENTS[id]?.key ?? id;
  const census = {}, changes = {};
  let changed = 0, snowMaxT = -1e9;
  const list = [];
  for (let j = 0; j < s0.ids.length; j++) {
    census[name(s0.ids[j])] = (census[name(s0.ids[j])] ?? 0) + 1;
    if (s1.ids[j] === ELEMENTS.findIndex((e) => e.key === 'SNOW')) snowMaxT = Math.max(snowMaxT, s1.T[j]);
    if (s0.ids[j] !== s1.ids[j]) {
      changed++;
      const k = `${name(s0.ids[j])}->${name(s1.ids[j])}`;
      changes[k] = (changes[k] ?? 0) + 1;
      const x = j % g.nx, z = Math.floor(j / g.nx) % g.nz, y = Math.floor(j / (g.nx * g.nz));
      if (verbose && list.length < 40) list.push(`${k} at (${x}, ${y}, ${z}) T ${s0.T[j].toFixed(1)} -> ${s1.T[j].toFixed(1)}`);
    }
  }
  const matter = s0.ids.length - (census.EMPTY ?? 0);
  // snow at its melting point, and what touches it
  const SNOW = ELEMENTS.findIndex((e) => e.key === 'SNOW'), melting = [];
  for (let j = 0; j < s1.ids.length && verbose && melting.length < 6; j++) {
    if (s1.ids[j] !== SNOW || s1.T[j] < -0.5) continue;
    const x = j % g.nx, z = Math.floor(j / g.nx) % g.nz, y = Math.floor(j / (g.nx * g.nz));
    const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => {
      const q = ((y + dy) * g.nz + z + dz) * g.nx + x + dx;
      return x + dx < 0 || x + dx >= g.nx || y + dy < 0 || y + dy >= g.ny || z + dz < 0 || z + dz >= g.nz ? 'box'
        : `${name(s1.ids[q])}@${s1.T[q].toFixed(0)}`;
    });
    melting.push(`(${x}, ${y}, ${z}) ${s1.T[j].toFixed(1)}: ${nb.join(' ')}`);
  }

  // JS twin vs GPU: the column heights (columnFrag) against heightAt
  gen.columnsKey = '';
  gen.updateColumns(P, [0, 0, 0]);
  const { COLUMN_MARGIN: M } = await import('/src/shaders/generate.js');
  const cw = g.nx + 2 * M, ch = g.nz + 2 * M, cols = new Float32Array(cw * ch * 4);
  r.readRenderTargetPixels(gen.columns, 0, 0, cw, ch, cols);
  let twinMax = 0, twinGround = 0;
  for (let j = 0; j < ch; j++)
    for (let i = 0; i < cw; i++) {
      const gpu = cols[(j * cw + i) * 4], cpu = heightAt(i - M, j - M, P);
      twinMax = Math.max(twinMax, Math.abs(gpu - cpu));
      if (Math.floor(gpu + 0.5) !== Math.floor(cpu + 0.5)) twinGround++;
    }

  // seams: generate at origin 0, then at a shifted origin, and compare where they overlap
  const SHIFT = 16;   // cells (D11's window step)
  const readRaw = () => {
    const buf = new Float32Array(g.width * g.height * 4);
    r.readRenderTargetPixels(sim.targets[sim.cur], 0, 0, g.width, g.height, buf, undefined, 0);
    return buf;
  };
  const at = (x, y, z) => ((Math.floor(y / g.tx) * g.nz + z) * g.width + (y % g.tx) * g.nx + x) * 4;
  gen.fill(P, [0, 0, 0]);
  const base = readRaw();
  gen.fill(P, [SHIFT, 0, SHIFT]);
  const shifted = readRaw();
  let seamDiff = 0;
  for (let y = 0; y < g.ny; y++)
    for (let z = 0; z < g.nz - SHIFT; z++)
      for (let x = 0; x < g.nx - SHIFT; x++) {
        const i = at(x, y, z), k = at(x + SHIFT, y, z + SHIFT);
        for (let c = 0; c < 4; c++) if (shifted[i + c] !== base[k + c]) { seamDiff++; break; }
      }
  // the pure single-cell path (generate(), no column pass) against the fill, on a few slices
  const { rawMat, makeFieldTarget } = await import('/src/sim.js');
  const { prelude } = await import('/src/shaders/common.js');
  const { generatorGLSL } = await import('/src/shaders/generate.js');
  const fu = gen.mats.fill.uniforms;
  const probe = rawMat(`${prelude(g)}\n${generatorGLSL}\nuniform int uY;\nout vec4 oC;\n`
    + 'void main() { ivec2 f = ivec2(gl_FragCoord.xy); vec4 A, B; generate(ivec3(f.x, uY, f.y), A, B); oC = A; }',
    { ...Object.fromEntries(Object.keys(fu).filter((k) => k.startsWith('uGen')).map((k) => [k, fu[k]])), uY: { value: 0 } });
  const colTex = gen.columns.texture;   // a float, nearest-filtered target: the probe's matches it
  const probeT = makeFieldTarget(g.nx, g.nz, 1, colTex.type, colTex.minFilter);
  const slice = new Float32Array(g.nx * g.nz * 4);
  let pureDiff = 0, pureCells = 0;
  const PURE_T_TOL = 1e-3;   // °C
  for (const y of [P.sea - 3, P.sea, P.sea + 6, P.sea + 14, Math.round(P.sea + P.relief * 0.75)]) {
    probe.uniforms.uY.value = y;
    sim.run(probe, probeT);
    r.readRenderTargetPixels(probeT, 0, 0, g.nx, g.nz, slice);
    for (let z = 0; z < g.nz; z++)
      for (let x = 0; x < g.nx; x++) {
        const i = (z * g.nx + x) * 4, k = at(x, y, z);
        pureCells++;
        // id, life and seed exactly; temperature to float rounding (two programs fold the frost differently)
        const off = slice[i] !== base[k] || slice[i + 2] !== base[k + 2] || slice[i + 3] !== base[k + 3]
          || Math.abs(slice[i + 1] - base[k + 1]) > PURE_T_TOL;
        if (off && verbose && pureDiff < 8) list.push(`pure ${[...slice.slice(i, i + 4)]} fill ${[...base.slice(k, k + 4)]} at (${x}, ${y}, ${z})`);
        if (off) pureDiff++;
      }
  }
  probe.dispose(); probeT.dispose();
  // a slab fill: x < SHIFT from the shifted world, the rest kept
  gen.fill(P, [0, 0, 0]);
  gen.fill(P, [SHIFT, 0, SHIFT], [0, 0, 0], [SHIFT, g.ny, g.nz]);
  const slab = readRaw();
  let slabDiff = 0;
  for (let y = 0; y < g.ny; y++)
    for (let z = 0; z < g.nz; z++)
      for (let x = 0; x < g.nx; x++) {
        const i = at(x, y, z), want = x < SHIFT ? shifted : base;
        for (let c = 0; c < 4; c++) if (slab[i + c] !== want[i + c]) { slabDiff++; break; }
      }

  // far-field summary: dominant ids over the grid's bricks
  const sum = gen.summarize(P);
  const sbuf = new Uint8Array(g.bwidth * g.bheight * 4);
  r.readRenderTargetPixels(sum, 0, 0, g.bwidth, g.bheight, sbuf);
  const dominant = {};
  let solidSum = 0, bricks = 0, summaryDiff = 0;
  const { SUMMARY_SURFACE_W } = await import('/src/shaders/generate.js');
  const B = 4, kind = (id) => ELEMENTS[id].kind, K = { SOLID: 1, POWDER: 2, LIQUID: 3, GAS: 4 };
  for (let by = 0; by < g.ny / B; by++)
    for (let bz = 0; bz < g.nz / B; bz++)
      for (let bx = 0; bx < g.nx / B; bx++) {
        // the CPU tally of the generated cells (base: origin 0, no trees), as summaryFrag counts them
        const w = new Float64Array(ELEMENTS.length);
        let solid = 0;
        for (let z = 0; z < B; z++)
          for (let x = 0; x < B; x++)
            for (let y = 0; y < B; y++) {
              const X = bx * B + x, Y = by * B + y, Z = bz * B + z;
              const id = Math.round(base[at(X, Y, Z)]);
              const above = Y + 1 < g.ny ? Math.round(base[at(X, Y + 1, Z)]) : 0;
              if (kind(id) === K.SOLID || kind(id) === K.POWDER) solid++;
              if (id !== 0 && kind(id) !== K.GAS) w[id] += above === 0 ? SUMMARY_SURFACE_W : 1;
            }
        let best = 0;
        for (let i = 0; i < w.length; i++) if (w[i] > w[best]) best = i;
        const bt = ((Math.floor(by / g.btx) * (g.nz / B) + bz) * g.bwidth + (by % g.btx) * (g.nx / B) + bx) * 4;
        if (sbuf[bt] !== best || Math.abs(sbuf[bt + 1] - Math.round(solid / 64 * 255)) > 1) summaryDiff++;
        if (!sbuf[bt] && !sbuf[bt + 1] && !sbuf[bt + 2]) continue;
        dominant[name(sbuf[bt])] = (dominant[name(sbuf[bt])] ?? 0) + 1;
        solidSum += sbuf[bt + 1] / 255; bricks++;
      }
  return {
    world: { seed: P.seed, sea: P.sea, relief: +P.relief.toFixed(1), radius: P.radius },
    timingMs: { columnAndFill: stat(fill), columnPass: stat(column), fillPass: stat(fillOnly),
      trees: stat(trees), treeCount: treeList.length, step: +stepMs.toFixed(2) },
    trees: treeList.map((t) => t.variant).join(' '),
    census, matter,
    stability: { steps, changed, shareOfMatter: +(changed / matter).toExponential(2), changes, snowMaxT: +snowMaxT.toFixed(2), list, melting },
    twin: { maxHeightDiff: +twinMax.toExponential(2), groundDiffColumns: twinGround, columns: cw * ch },
    seams: { shift: SHIFT, cellsDiffering: seamDiff, slabFillCellsDiffering: slabDiff },
    pureGenerate: { cells: pureCells, differingFromFill: pureDiff },
    summary: { bricksWithMatter: bricks, meanSolid: +(solidSum / Math.max(bricks, 1)).toFixed(3), dominant, bricksDisagreeingWithCpu: summaryDiff },
  };
}, [steps, FILL_RUNS, seed, verbose]);
console.log(JSON.stringify(res, null, 1));

if (shots) {
  const frames = (n) => p.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
  // reload a fresh island for the stills
  await p.evaluate((seed) => window.__app.loadPreset('island', false), seed);
  const cam = async (name, fn, arg) => {
    await p.evaluate(fn, arg);
    await p.evaluate(() => { window.__app.controls.update(); window.__app.post.reset(); });
    await frames(TAA_FRAMES);
    await p.screenshot({ path: `${out}/${name}.png` });
  };
  await cam('god', () => window.__app.rig.reset(true));
  await cam('three-quarter', () => { const a = window.__app; a.camera.position.set(6.2, 3.6, 6.8); a.controls.target.set(0, 1.4, 0); });
  // eye level: stand on open meadow (looking up at the summit) or on a beach
  // (looking along the shore, the island on one side and the sea on the other)
  const eye = async (name, want, EYE) => cam(name, async ([want, EYE]) => {
    const a = window.__app, g = a.sim.g, s = a.scale;
    const { worldParams, layersAt, treesIn, heightAt } = await import('/src/world/generator.js');
    const seed = new URLSearchParams(location.search).get('seed');
    const P = worldParams({ size: [g.nx, g.ny, g.nz], seed: seed == null ? undefined : +seed });
    const trees = treesIn(0, 0, g.nx, g.nz, P);
    const CLEAR = 7;    // cells to the nearest trunk
    let best = null, top = { h: -1 };
    for (let z = 0; z < g.nz; z += 2)
      for (let x = 0; x < g.nx; x += 2) { const h = heightAt(x, z, P); if (h > top.h) top = { x, z, h }; }
    for (let k = 0; k < 24 && !best; k++) {
      const ang = (k / 24) * Math.PI * 2 + 0.4;
      for (let d = g.nx * 0.45; d > 4 && !best; d -= 1) {
        const x = Math.round(P.center[0] + Math.cos(ang) * d), z = Math.round(P.center[1] + Math.sin(ang) * d);
        if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < CLEAR)) continue;
        const L = layersAt(x, z, P);
        if (want === 'beach' ? L.sand && L.ground > P.sea : L.plant && L.slope < 0.6) best = { x, z, y: L.ground, ang };
      }
    }
    if (!best) return;
    const toW = (x, y, z) => [(x + 0.5 - g.nx / 2) * s, y * s, (z + 0.5 - g.nz / 2) * s];
    a.camera.position.set(...toW(best.x, best.y + EYE, best.z));
    const SHORE_TURN = 1.25;   // rad off the inland direction: mostly along the shore
    const look = want === 'beach'
      ? [best.x - Math.cos(best.ang - SHORE_TURN) * 40, best.y + EYE, best.z - Math.sin(best.ang - SHORE_TURN) * 40]
      : [top.x, top.h, top.z];
    a.controls.target.set(...toW(...look));
  }, [want, EYE]);
  await eye('eye-meadow', 'meadow', EYE_CELLS);
  await eye('eye-beach', 'beach', EYE_CELLS);
}
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
