// Headless GPU check of the patchwork world scene (src/world/scenes/patchwork.js),
// the parts tools/scene-patch-check.mjs can't reach on the CPU:
//   - prepare()'s island bake (patchworkIsland.js) against the island box
//     preset as the Scene row loads it (world/gpu.js loadIsland on the app's
//     128³ box), every cell: element, temperature, life and ctype, exactly;
//   - its GLSL: sceneCell run in a pass over world cells across every tile,
//     seams, negative cells and past the map's edge, against a JS mirror of it
//     reading the same baked textures (the R8UI 3D texture's upload included),
//     and its colour seeds against seedWorld's.
// Needs the app served (vite) on --port. Not on battery (pmset -g batt).
//
//   ./node_modules/.bin/vite --port 5391 --strictPort &
//   node tools/scene-patch-gpu.mjs --port 5391
//   (then stop that vite by its PID)
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5391');

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
await p.addInitScript(() => localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true })));
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 600)); });
p.on('pageerror', (e) => errs.push(`PAGEERROR ${String(e).slice(0, 600)}`));
await p.goto(`http://localhost:${port}/?preset=island&size=128`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 30000 });
await p.waitForTimeout(1000);

const res = await p.evaluate(async () => {
  const a = window.__app;
  a.settings.paused = true;
  const r = a.renderer, sim = a.sim;
  const { rawMat, makeFieldTarget, gridLayout } = await import('/src/sim.js');
  const { prelude, SEED_MAX } = await import('/src/shaders/common.js');
  const { WORLD_SIZE } = await import('/src/shaders/far.js');
  const { loadIsland } = await import('/src/world/gpu.js');
  const { pcg } = await import('/src/world/generator.js');
  const { patchwork } = await import('/src/world/scenes/patchwork.js');
  const B = await import('/src/world/scenes/patchworkBake.js');
  const T = B.PATCH_TILE, out = { fails: [] };
  const fail = (m) => { if (out.fails.length < 12) out.fails.push(m); };
  if (sim.g.nx !== T || sim.g.ny !== T || sim.g.nz !== T) return { fails: [`the app's box is ${sim.g.nx}×${sim.g.ny}×${sim.g.nz}, not ${T}³`] };

  // the island box preset, as the Scene row makes it (the default world seed, as P's)
  loadIsland(sim, {});
  const [box] = sim.readState();

  // the scene's island bake
  const P = patchwork.params({ size: WORLD_SIZE, seed: undefined });
  patchwork.dispose();
  const t0 = performance.now();
  const U = patchwork.uniforms(P);
  const tCpu = performance.now();
  await patchwork.prepare(r, P);
  out.cpuBakeMs = tCpu - t0;
  out.prepareMs = performance.now() - tCpu;
  const cells = U.uPatchCells.value.image.data, pal = U.uPatchPalette.value.image.data;
  const palW = U.uPatchPalette.value.image.width;
  out.palette = new Set(cells).size;
  const decode = (e) => [pal[e * 4], pal[e * 4 + 1], pal[e * 4 + 2], pal[e * 4 + 3]];
  let bad = 0;
  for (let z = 0; z < T; z++)
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const i = sim.cellTexel(x, y, z) * 4;
        const want = [box[i], box[i + 1], box[i + 2], Math.floor(box[i + 3])];
        const got = decode(cells[B.cellIndex(B.PATCH_ISLAND, x, y, z)]);
        if (got.some((v, k) => v !== want[k]) && bad++ < 5) fail(`island (${x}, ${y}, ${z}): baked ${got}, the box has ${want}`);
      }
  out.islandCells = T ** 3;
  out.islandBad = bad;

  // sceneCell on the GPU: texel (i, j) is world cell (X0 + i, j % T, Z[j / T])
  const W = 1024, X0 = -64;                          // texels per row, and the world x of the first: every tile along x, from left of the world
  const Z = [-1, 0, 127, 128, 511, 512, 1023, 1029];  // world z of each band of T rows: tile edges either side of seams, and past both world edges
  const ROWS = Z.length;
  const g = { ...gridLayout(T, T, T), windowed: true };
  const mat = rawMat(`
${prelude(g)}
${patchwork.glsl(g)}
uniform int uZ[${ROWS}];
out vec4 oC;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  vec4 A, B;
  sceneCell(ivec3(${X0} + f.x, f.y % ${T}, uZ[f.y / ${T}]), A, B);
  oC = A + B;
}
`, { ...patchwork.uniforms(P), uZ: { value: new Int32Array(Z) } });
  const st = sim.targets[0].texture;   // (its type and filter: float, nearest)
  const target = makeFieldTarget(W, ROWS * T, 1, st.type, st.minFilter);
  r.setRenderTarget(target);
  sim.quad.material = mat;
  r.render(sim.scene, sim.camera);
  const px = new Float32Array(W * ROWS * T * 4);
  r.readRenderTargetPixels(target, 0, 0, W, ROWS * T, px);
  r.setRenderTarget(null);
  // JS mirrors: sceneCell's lookup, and seedWorld (shaders/common.js)
  const LCG_MUL = 1664525;            // shaders/common.js LCG_MUL
  const UINT_RANGE = 4294967296;      // 2^32 (UINT_TO_UNIT's inverse)
  const SEED_TOL = 1e-4;              // a seed's float rounding (ctype + seed in one float)
  const seedWorld = (x, y, z, frame, salt) =>
    pcg((x + pcg((y + pcg((z + pcg((Math.imul(frame, LCG_MUL) + salt) >>> 0)) >>> 0)) >>> 0)) >>> 0);
  const map = U.uPatchMap.value;
  let gpuBad = 0, seedBad = 0;
  for (let j = 0; j < ROWS * T; j++)
    for (let i = 0; i < W; i++) {
      const x = X0 + i, y = j % T, z = Z[Math.floor(j / T)];
      const [tx, tz] = B.tileOf(x, z), [lx, lz] = B.inTile(x, z);
      const k = map[(tx & (B.PATCH_MAP[0] - 1)) + B.PATCH_MAP[0] * (tz & (B.PATCH_MAP[1] - 1))];
      const want = decode(cells[B.cellIndex(k, lx, y, lz)]);
      const o = (j * W + i) * 4, got = [px[o], px[o + 1], px[o + 2], Math.floor(px[o + 3])];
      if (got.some((v, n) => v !== want[n]) && gpuBad++ < 5) fail(`sceneCell(${x}, ${y}, ${z}) = ${got}, the bake has ${want}`);
      const seed = Math.fround(Math.fround(Math.fround(seedWorld(x, y, z, P.seed, B.PATCH_SALT_CELL)) / UINT_RANGE) * SEED_MAX);
      if (Math.abs((px[o + 3] - want[3]) - seed) > SEED_TOL && seedBad++ < 3) fail(`sceneCell(${x}, ${y}, ${z}) seed ${px[o + 3] - want[3]}, seedWorld gives ${seed}`);
    }
  out.gpuCells = W * ROWS * T;
  out.gpuBad = gpuBad;
  out.seedBad = seedBad;
  target.dispose();
  mat.dispose();
  patchwork.dispose();
  return out;
});
await b.close();
console.log(JSON.stringify({ ...res, errors: errs.slice(0, 8) }, null, 1));
const ok = !res.fails.length && !errs.length;
console.log(ok ? 'patchwork GPU OK' : 'patchwork GPU FAILED');
process.exit(ok ? 0 : 1);
