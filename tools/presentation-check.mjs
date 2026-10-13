// The rolling log on the GPU (gfx/presentation.js; docs/webgpu.md Sync log,
// Sync 4): the WebGPU port of main's bounded real-GPU follow-up. Stages, each
// its own browser and Vite (tools/vite-server.mjs), each within ~3 minutes on
// SwiftShader:
//
//   math   the WGSL twin (presentationMath.js presentationWGSL) against the
//          JS mapping on a few hundred rays: inverse rays, spans in a box,
//          exits, the cell at a point (a compute kernel of the test's own);
//          the motion pass's reprojection as post ships it (a compute entry added to its
//          module) against the JS algebra, and against the camera-only one
//   box    a 64³ box in the plain view (the cheapest to build): the effect
//          selected by hand (a box map has no gamemode with it) bends the
//          frame and leaves the simulation alone; a cell picked on screen is
//          the one the bent view shows; an ordinary mesh shows where the bend
//          puts it, an overlay (the viewmodel's) and an opted-out mesh aren't
//          bent; a figure bends where it stands; TAA stays steady while
//          the camera, and with it the bend's anchor, moves, and the
//          MotionParams createPost packs for its own draw reproject through the
//          bend; deep idle (no submits) with the effect on; the gamemodes resolve on a map
//          without the mode (Sandbox); dropping the effect restores every mesh
//   boot   the gamemode's effect selected before the grid is built (boot and
//          openMap: the build waits on the curved variant only; the Island
//          given Animal Crossing for it, maps.js served patched)
//   world  the Island at ?win=64 in the realistic view: the far view's
//          curved variant draws (and the volume's), and the frame differs
//          from the flat one. (The Animal Crossing gamemode's own map, Willow
//          Cove, gets its world WGSL from DP4-W: --map willowCove then.)
//
//   node tools/presentation-check.mjs [--stage math,box,boot,world] [--map island] [--out dir]
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newTestPage, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const STAGES = arg('stage', 'math,box,boot').split(',');
const MAP = arg('map', 'island');
const OUT = arg('out', join(ROOT, '.tmp-presentation'));   // (ignored by git: .tmp-*)
const VIEWPORT = { width: 400, height: 250 };
const LIFETIME_MS = 175000;   // a stage's browser: under three minutes
const DIFF = 12;              // levels (0-255) a pixel's channel must move to count as changed
const MIN_CHANGED = 0.05;     // the bend moves at least this share of the frame (the box's far side sinks cells)
const TAA_K_GAIN = 8;         // the TAA case's bend, × the game's
const IGNORE = [/ERR_CONNECTION_REFUSED/];   // (the relay the UI asks for quota isn't running here)
mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.stack || e).slice(0, 400)}`));
  page.on('console', (m) => {
    const t = m.text();
    if (IGNORE.some((r) => r.test(t))) return;
    if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|GPU (validation|internal|out-of-memory)|shader failed/i.test(t))) errors.push(`${m.type()}: ${t.slice(0, 400)}`);
  });
  return errors;
}
async function boot(browser, vite, query, mode = 'manual') {
  const page = await newTestPage(browser, { mode, viewport: VIEWPORT });
  const errors = watch(page);
  await page.goto(vite.url(`/${query}`));
  await page.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 150000 });
  const failed = await page.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot ${query}: ${failed.slice(0, 600)}`);
  // (the frame alone: the HUD's panels would cover it in the shots)
  await page.addStyleTag({ content: 'body > *:not(#app) { display: none !important; } #app > *:not(canvas) { display: none !important; }' });
  await page.evaluate(() => { __app.post.settings.taa = false; return __app.test.ready(); });
  if (!gpuShown) {
    gpuShown = true;
    const g = await gpuInfo(page);
    console.log(`gpu: ${g.vendor} ${g.architecture}${g.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
  }
  return { page, errors };
}
let gpuShown = false;
// In the page: share of pixels of two captures differing by more than diff in a channel, and helpers.
const PAGE_HELPERS = () => {
  window.__share = (a, b, diff) => {
    let n = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > diff) n++;
    }
    return n / (a.width * a.height);
  };
  window.__meanDiff = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.data.length; i += 4) s += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    return s / (3 * a.width * a.height);
  };
  // the motion pass's reprojection as post ships it (gfx/post.js motionWGSL's
  // presentationReproject, in a compute entry added to its module; three's TAAU
  // reads the velocity it makes) with MotionParams bytes: this frame's
  // [uv (y down), depth] → the last frame's clip position, or { errs }
  window.__taaReproject = async (params, pts) => {
    const device = __app.gpu.device;
    if (!window.__taaPipe) {
      const entry = (await import('/src/gfx/post.js')).WGSL_CHECK.find((e) => e.name === 'motion');
      const code = `${entry.code()}
@group(0) @binding(0) var<storage, read> qin: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> qout: array<vec4f>;
@compute @workgroup_size(64) fn reprojTest(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&qin)) { return; }
  warpUse(P.warpK, P.warpAnchor, P.warpDir);
  let uv = qin[id.x].xy;
  qout[id.x] = presentationReproject(vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, qin[id.x].z, 1.0));
}`;
      const module = device.createShaderModule({ code, label: 'presentation taa reprojection' });
      const errs = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
      if (errs.length) return { errs };
      window.__taaPipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'reprojTest' } });
    }
    const pipeline = window.__taaPipe;
    const buf = (data, usage) => {
      const b = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const inBuf = buf(new Float32Array(pts.map(([u, v, z]) => [u, v, z, 0]).flat()), GPUBufferUsage.STORAGE);
    const outBuf = device.createBuffer({ size: pts.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const pBuf = buf(new Uint8Array(params), GPUBufferUsage.UNIFORM);
    const g0 = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }] });
    const g3 = device.createBindGroup({ layout: pipeline.getBindGroupLayout(3), entries: [{ binding: 1, resource: { buffer: pBuf } }] });
    __app.gpu.flush('presentation taa');
    const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, g0); pass.setBindGroup(3, g3); pass.dispatchWorkgroups(Math.ceil(pts.length / 64)); pass.end();
    device.queue.submit([enc.finish()]);
    const out = new Float32Array(await __app.gpu.readback.buffer(outBuf, 0, pts.length * 16));
    inBuf.destroy(); outBuf.destroy(); pBuf.destroy();
    return { clip: pts.map((_, i) => [out[4 * i], out[4 * i + 1], out[4 * i + 2], out[4 * i + 3]]) };
  };
};

// ---------------------------------------------------------------- math
async function mathStage(browser, vite, secs) {
  const { page, errors } = await boot(browser, vite, '?size=64&preset=empty&view=plain');
  const r = await page.evaluate(async () => {
    const M = await import('/src/gfx/presentationMath.js');
    const device = __app.gpu.device;
    const e = M.effectParameters(M.ROLLING_LOG.k * 8, [37.5, -12.25], [0.6, 0.8]);   // (a stronger bend than the game's: the tests see it)
    const lo = [0, 0, 0], hi = [64, 48, 64];
    // rays from around and inside the box, displayed straight
    const rays = [];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 256; i++) {
      const o = [rnd() * 160 - 48, rnd() * 80 + 4, rnd() * 160 - 48];
      const target = [rnd() * 64, rnd() * 40, rnd() * 64];
      let d = target.map((v, k) => v - o[k]);
      const n = Math.hypot(...d);
      d = d.map((v) => v / n);
      rays.push({ o, d });
    }
    const f = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));
    const code = `${M.presentationWGSL}
struct In { o: vec4f, d: vec4f }
@group(0) @binding(0) var<storage, read> rays: array<In>;
@group(0) @binding(1) var<storage, read_write> outp: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&rays)) { return; }
  warpUse(${f(e.k)}, vec2f(${f(e.anchor[0])}, ${f(e.anchor[1])}), vec2f(${f(e.dir[0])}, ${f(e.dir[1])}));
  let r = warpRay(rays[i].o.xyz, rays[i].d.xyz);
  let lo = vec3f(${lo.map(f).join(', ')});
  let hi = vec3f(${hi.map(f).join(', ')});
  let spans = warpSpans(r, lo, hi, 0.0, WARP_INF);
  let ex = warpExit(r, lo, hi, select(0.0, spans.x, spans.x < WARP_INF));
  let tc = mix(spans.x, spans.y, 0.37);   // (not the middle: a span bounded by the x or z slabs has its middle on a face)
  outp[i * 6u + 0u] = vec4f(r.C, 0.0);
  outp[i * 6u + 1u] = vec4f(r.B, 0.0);
  outp[i * 6u + 2u] = vec4f(r.A, 0.0);
  outp[i * 6u + 3u] = spans;
  outp[i * 6u + 4u] = vec4f(ex, warpPoint(rays[i].o.xyz).y, unwarpPoint(warpPoint(rays[i].o.xyz)).y);
  outp[i * 6u + 5u] = vec4f(vec3f(warpCell(r, tc)), tc);
}`;
    const module = device.createShaderModule({ code, label: 'presentation math' });
    const info = await module.getCompilationInfo();
    const errs = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
    if (errs.length) return { errs };
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const inBuf = device.createBuffer({ size: rays.length * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(inBuf, 0, new Float32Array(rays.flatMap(({ o, d }) => [...o, 0, ...d, 0])));
    const outBuf = device.createBuffer({ size: rays.length * 96, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }] });
    __app.gpu.flush('presentation math');
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(rays.length / 64)); pass.end();
    device.queue.submit([enc.finish()]);
    const out = new Float32Array(await __app.gpu.readback.buffer(outBuf, 0, rays.length * 96));
    inBuf.destroy(); outBuf.destroy();
    // compare with the JS twin
    const worst = { ray: 0, span: 0, exit: 0, point: 0 };
    let spanMiss = 0, exitAxis = 0, cellMiss = 0, inside = 0;
    const examples = [];
    const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
    rays.forEach(({ o, d }, i) => {
      const q = out.subarray(i * 24, i * 24 + 24);
      const r = M.inverseRay(o, d, e);
      for (let k = 0; k < 3; k++) worst.ray = Math.max(worst.ray, rel(q[k], r.C[k]), rel(q[4 + k], r.B[k]), Math.abs(q[8 + k] - r.A[k]) / Math.max(Math.abs(r.A[k]), 1e-12) * (r.A[k] ? 1 : 0));
      const js = M.boxSpans(r, lo, hi);
      const gs = [q[12], q[13], q[14], q[15]].filter((t) => t < 1e8);
      const jt = js.flat();
      if (gs.length !== jt.length) spanMiss++;
      else gs.forEach((t, k) => { worst.span = Math.max(worst.span, Math.abs(t - jt[k])); });
      if (jt.length) {
        inside++;
        const ex = M.nextExit(r, lo, hi, jt[0]);
        if (ex.t < Infinity) {
          worst.exit = Math.max(worst.exit, Math.abs(q[16] - ex.t));
          if (q[17] !== ex.axis) exitAxis++;
        }
        const t = q[23], cell = M.rayCell(r, t);
        if (cell.some((v, k) => v !== q[20 + k])) { cellMiss++; if (examples.length < 4) examples.push({ t, js: cell, gpu: [q[20], q[21], q[22]], p: M.rayPoint(r, t), spans: jt }); }
      }
      worst.point = Math.max(worst.point, Math.abs(q[18] - M.warp(o, e)[1]), Math.abs(q[19] - o[1]));
    });
    return { rays: rays.length, inside, worst, spanMiss, exitAxis, cellMiss, examples };
  });
  if (r.errs) { ok(false, `math: the kernel compiles: ${r.errs.join('; ')}`); await page.close(); return; }
  if (r.examples.length) console.log(`     cells that differ: ${JSON.stringify(r.examples)}`);
  console.log(`     ${r.rays} rays (${r.inside} meet the box): worst ray ${r.worst.ray.toExponential(1)} (relative), span ${r.worst.span.toExponential(1)}, exit ${r.worst.exit.toExponential(1)}, point ${r.worst.point.toExponential(1)} cells`);
  ok(r.worst.ray < 1e-4 && r.worst.point < 1e-3, `math: warpRay, warpPoint and unwarpPoint are the JS mapping's (f32) (${secs()})`);
  ok(r.spanMiss === 0 && r.worst.span < 1e-2, `math: warpSpans gives boxSpans' spans (${r.spanMiss} rays with another count; worst ${r.worst.span.toExponential(1)} cells)`);
  ok(r.exitAxis === 0 && r.worst.exit < 1e-2, `math: warpExit is nextExit's exit (${r.exitAxis} other axes; worst ${r.worst.exit.toExponential(1)})`);
  ok(r.cellMiss <= Math.ceil(r.inside / 100), `math: warpCell is rayCell's cell (${r.cellMiss} of ${r.inside} differ: f32 at a cell's face)`);
  // the motion pass's reprojection as post ships it (gfx/post.js motionWGSL's, its
  // MotionParams packed as createPost packs them), in a compute entry added to
  // the module: a flat point shown this frame, its pixel and depth, come back
  // to where the last frame showed it, the camera and the bend's anchor both
  // moved. The camera-only reprojection (P.reproj) misses by far more.
  await page.evaluate(PAGE_HELPERS);
  const taa = await page.evaluate(async (gain) => {
    const M = await import('/src/gfx/presentationMath.js'), post = await import('/src/gfx/post.js');
    const T3 = __app.THREE, entry = post.WGSL_CHECK.find((e) => e.name === 'motion');
    // two frames: the scene → world cells transform, two cameras (the app's clip space), the bend anchored under each
    const toWorld = new T3.Matrix4().makeScale(10, 10, 10).setPosition(300, 0, 200), toScene = toWorld.clone().invert();
    const cam = (pos, at) => {
      const c = new T3.PerspectiveCamera(50, 1.6, 0.05, 200);
      c.coordinateSystem = __app.camera.coordinateSystem; c.updateProjectionMatrix();
      c.position.set(...pos); c.lookAt(...at); c.updateMatrixWorld();
      return c;
    };
    const vp = (c) => new T3.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    const bend = (c) => {
      const eye = c.position.clone().applyMatrix4(toWorld), look = c.getWorldDirection(new T3.Vector3()).transformDirection(toWorld);
      const dir = [look.x, look.z], n = Math.hypot(...dir);
      return M.effectParameters(M.ROLLING_LOG.k * gain, [eye.x, eye.z], dir.map((v) => v / n));
    };
    const camA = cam([3, 2, 4], [0, 0, 0]), camB = cam([2.2, 2.1, 4.6], [0.3, 0, 0]);
    const prev = bend(camA), cur = bend(camB);
    const prevWorldToClip = new T3.Matrix4().multiplyMatrices(vp(camA), toScene);
    const invVP = vp(camB).invert();
    const temporalToWorld = new T3.Matrix4().multiplyMatrices(toWorld, invVP), reproj = new T3.Matrix4().multiplyMatrices(vp(camA), invVP);
    // (bent, post packs this frame's clip → world cells where the flat reprojection goes)
    const params = entry.params.pack({
      reproj: temporalToWorld, warpK: cur.k, warpAnchor: cur.anchor, warpDir: cur.dir, prevK: prev.k, prevAnchor: prev.anchor, prevDir: prev.dir,
      prevWorldToClip,
    });
    const clipOf = (m, w) => new T3.Vector4(...w, 1).applyMatrix4(m);
    const curWorldToClip = new T3.Matrix4().multiplyMatrices(vp(camB), toScene);
    const pts = [], want = [];
    for (let i = 0; i < 64; i++) {
      const P = [300 + ((i * 37) % 64) - 32, (i * 13) % 24, 200 + ((i * 29) % 64) - 32];   // world cells around the eyes' ground
      const c = clipOf(curWorldToClip, M.warp(P, cur));
      if (c.w <= 0) continue;
      pts.push([(c.x / c.w + 1) / 2, (1 - c.y / c.w) / 2, c.z / c.w]);   // this frame's uv (y down) and depth
      const w = clipOf(prevWorldToClip, M.warp(P, prev));
      want.push([w.x / w.w, w.y / w.w]);
    }
    const got = await window.__taaReproject(params, pts);
    if (got.errs) return got;
    let worst = 0, cameraOnly = 0;
    pts.forEach((p, i) => {
      const [x, y, , w] = got.clip[i];
      worst = Math.max(worst, Math.abs(x / w - want[i][0]), Math.abs(y / w - want[i][1]));
      const r = new T3.Vector4(p[0] * 2 - 1, 1 - p[1] * 2, p[2], 1).applyMatrix4(reproj);
      cameraOnly = Math.max(cameraOnly, Math.abs(r.x / r.w - want[i][0]), Math.abs(r.y / r.w - want[i][1]));
    });
    return { n: pts.length, worst, cameraOnly, moved: Math.hypot(prev.anchor[0] - cur.anchor[0], prev.anchor[1] - cur.anchor[1]) };
  }, TAA_K_GAIN);
  if (taa.errs) ok(false, `math: the motion pass's reprojection kernel compiles: ${taa.errs.join('; ')}`);
  else {
    ok(taa.n >= 48 && taa.worst < 1e-3 && taa.cameraOnly > 20 * taa.worst,   // (1e-3: half a pixel of 1000; f32 through world cells in the hundreds)
      `math: the motion pass's reprojection (post's WGSL, ${TAA_K_GAIN}× the bend, the anchor ${taa.moved.toFixed(1)} cells on) brings ${taa.n} shown points back to the last frame's: worst ${taa.worst.toExponential(1)} (NDC), the camera-only one's ${taa.cameraOnly.toExponential(1)}`);
  }
  ok(!errors.length, `math: no page or GPU errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await page.close();
}

// ---------------------------------------------------------------- box
async function boxStage(browser, vite, secs) {
  const { page, errors } = await boot(browser, vite, '?size=64&preset=lab&view=plain');
  await page.evaluate(PAGE_HELPERS);
  // flat and bent frames of the lab, the simulation untouched
  const ab = await page.evaluate(async (diff) => {
    const a = __app;
    await a.test.renderOnce();
    const flat = await a.test.renderOnce({ capture: true });
    const v0 = a.sim.version;
    a.presentation.select('rollingLog');
    await a.test.ready();
    await a.test.renderOnce();
    const curved = await a.test.renderOnce({ capture: true });
    return {
      changed: window.__share(flat, curved, diff), drawn: a.view.volumeDrawn, active: a.presentation.active, k: a.presentation.parameters.k,
      same: v0 === a.sim.version, pipes: a.vol.pipelines.map((p) => `${p.key} ${p.state} ${Math.round(p.ms)} ms`),
    };
  }, DIFF);
  await page.screenshot({ path: join(OUT, 'box-curved.png') });
  console.log(`     pipelines: ${ab.pipes.join(', ')}`);
  ok(ab.active && ab.k > 0 && ab.drawn && ab.changed >= MIN_CHANGED,
    `box: the bend moves ${(100 * ab.changed).toFixed(1)}% of the frame (floor ${100 * MIN_CHANGED}%), the curved volume drawn (${secs()})`);
  ok(ab.same, 'box: selecting the effect leaves the simulation alone (its version)');

  // a cell picked on screen: the one the bent view shows there
  const pick = await page.evaluate(async () => {
    const a = __app, T = a.THREE, { E } = await import('/src/elements.js'), { warp } = await import('/src/gfx/presentationMath.js');
    a.sim.clear();
    const target = new T.Vector3(8.5, 30.5, 8.5);   // the box's far side from the camera: the bend lowers it ~10 cells
    a.sim.paint({ center: target, radius: 1.5, shape: 1, tool: E.WALL, rate: 1, replace: true });
    await a.test.renderOnce();
    const eye = a.camera.position.clone().applyMatrix4(a.volume.matrixWorld.clone().invert());
    const shown = new T.Vector3().fromArray(warp(target.clone().add(a.sim.origin).toArray(), a.presentation.parameters)).sub(a.sim.origin);
    const toShown = shown.clone().sub(eye).normalize(), toTarget = target.clone().sub(eye).normalize();
    const screen = await a.pickScreenRay(eye, toShown);     // the pixel showing the target, as the screen bends it
    const flatSame = await a.pickRay(eye, toShown);         // the same pixel's ray, flat (physics' path)
    const physical = await a.pickRay(eye, toTarget);        // the flat ray at the target
    const drop = target.y - shown.y;
    const far = (h) => h.cell.distanceTo(target.clone().floor());
    return {
      drop, wall: E.WALL,
      screen: { valid: screen.valid, id: screen.id, off: far(screen) }, flatSame: { valid: flatSame.valid, id: flatSame.id, off: far(flatSame) },
      physical: { valid: physical.valid, id: physical.id, off: far(physical) },
    };
  });
  ok(pick.screen.valid && pick.screen.id === pick.wall && pick.screen.off <= 2.5,
    `box: picking the pixel that shows the target (${pick.drop.toFixed(1)} cells below it, bent) finds it: ${JSON.stringify(pick.screen)}`);
  ok(!(pick.flatSame.valid && pick.flatSame.id === pick.wall && pick.flatSame.off <= 2.5),
    `box: the same pixel's ray walked flat misses it (the walk is what finds it): ${JSON.stringify(pick.flatSame)}`);
  ok(pick.physical.valid && pick.physical.id === pick.wall && pick.physical.off <= 2.5, `box: a physics ray (pickRay) stays flat: ${JSON.stringify(pick.physical)}`);

  // an ordinary mesh where the bend shows it; an overlay's and an opted-out one unbent
  const mesh = await page.evaluate(async () => {
    const a = __app, T = a.THREE, { warp } = await import('/src/gfx/presentationMath.js');
    const s = a.scale;
    const at = new T.Vector3(4, 40, 4);   // grid cells: far from the eye, high in the empty box
    const box = new T.Mesh(new T.BoxGeometry(4 * s, 4 * s, 4 * s), new T.MeshBasicNodeMaterial({ color: 0xff00ff }));
    box.name = 'presentation-check-marker';
    box.position.copy(at).multiplyScalar(s).add(a.volume.position);
    const overlay = new T.Group(); overlay.userData.presentationOverlay = true;
    const held = new T.Mesh(new T.BoxGeometry(s, s, s), new T.MeshBasicNodeMaterial({ color: 0x00ff00 }));
    overlay.add(held); overlay.position.copy(box.position).add(new T.Vector3(0, -12 * s, 0));
    const opted = new T.Mesh(new T.BoxGeometry(s, s, s), new T.MeshBasicNodeMaterial({ color: 0x00ffff }));
    opted.userData.presentation = false; opted.position.copy(overlay.position);
    a.scene.add(box, overlay, opted);
    window.__presentationMeshes = { box, overlay, held, opted };
    const project = (p) => {
      const v = p.clone().multiplyScalar(s).add(a.volume.position).project(a.camera);
      return [Math.round((v.x + 1) * innerWidth / 2), Math.round((1 - v.y) * innerHeight / 2)];
    };
    const shown = new T.Vector3().fromArray(warp(at.clone().add(a.sim.origin).toArray(), a.presentation.parameters)).sub(a.sim.origin);
    const px = project(shown), flatPx = project(at);
    // (the mesh compiles first: the frames go on until it shows)
    let shot = null, hit = null;
    for (let i = 0; i < 12; i++) {
      shot = await a.test.renderOnce({ capture: true });
      const sx = Math.round(px[0] * shot.width / innerWidth), sy = Math.round(px[1] * shot.height / innerHeight);
      const k = 4 * (sx + shot.width * sy);
      hit = [shot.data[k], shot.data[k + 1], shot.data[k + 2]];
      if (hit[0] > 1.5 * hit[1] + 40 && hit[2] > 1.5 * hit[1] + 40) break;
    }
    const k2 = 4 * (Math.round(flatPx[0] * shot.width / innerWidth) + shot.width * Math.round(flatPx[1] * shot.height / innerHeight));
    const atFlat = [shot.data[k2], shot.data[k2 + 1], shot.data[k2 + 2]];
    return {
      px, flatPx, hit, atFlat, bent: !!box.material.vertexNode, culled: box.frustumCulled,
      held: !!held.material.vertexNode, opted: !!opted.material.vertexNode,
      viewmodel: a.camera.getObjectByName('pov-viewmodel')?.userData.presentationOverlay ?? null,
    };
  });
  await page.screenshot({ path: join(OUT, 'box-mesh.png') });
  const magenta = (c) => c[0] > 1.5 * c[1] + 40 && c[2] > 1.5 * c[1] + 40;
  const apart = Math.hypot(mesh.px[0] - mesh.flatPx[0], mesh.px[1] - mesh.flatPx[1]);
  ok(mesh.bent && !mesh.culled && magenta(mesh.hit) && (apart < 6 || !magenta(mesh.atFlat)),
    `box: a mesh shows where the bend puts it (pixel ${mesh.px}: ${mesh.hit}; flat ${mesh.flatPx}, ${apart.toFixed(0)} px away: ${mesh.atFlat})`);
  ok(!mesh.held && !mesh.opted && mesh.viewmodel !== false,
    `box: an overlay's mesh (the viewmodel's: ${mesh.viewmodel}) and an opted-out mesh are left flat`);

  // a figure (pov/figure.js: node materials of its own, a contact shadow)
  // bends as the volume does where it stands: every mesh of it takes the bend,
  // compiled before it shows (src/wire/mesh.js), and what it adds to the frame
  // centres where the bend puts it, not where the flat view would
  const fig = await page.evaluate(async () => {
    const a = __app, T = a.THREE, s = a.scale, { createFigure } = await import('/src/pov/figure.js'), { warp } = await import('/src/gfx/presentationMath.js');
    for (const o of Object.values(window.__presentationMeshes)) o.visible = false;
    const toGrid = a.volume.matrixWorld.clone().invert();
    const figure = createFigure();
    figure.update(1 / 60, {
      feet: new T.Vector3(10, 26, 10).multiplyScalar(s).add(a.volume.position), scale: 3 * s, yaw: 0.6, worldToGrid: toGrid,   // (a giant: more pixels)
      speedH: 0, velY: 0, onGround: true, inLiquid: false, dead: false, heat: 0, crouch: 0, look: { pitch: 0, spine: 0 },
    });
    figure.setVisible(true);
    await figure.compile();
    a.scene.add(figure.root);
    const meshes = [];
    figure.root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const PENDING = 2147483648;   // (gfx/meshLight.js PENDING_MASK: waiting on its pipelines)
    let frames = 0;
    for (; frames < 12 && !meshes.every((m) => m.material.vertexNode && m.layers.mask !== PENDING); frames++) await a.test.renderOnce();
    const shot = await a.test.renderOnce({ capture: true });
    figure.root.visible = false;
    const bare = await a.test.renderOnce({ capture: true });
    let n = 0, cx = 0, cy = 0;
    for (let y = 0; y < shot.height; y++) for (let x = 0; x < shot.width; x++) {
      const k = 4 * (x + shot.width * y);
      if (Math.abs(shot.data[k] - bare.data[k]) + Math.abs(shot.data[k + 1] - bare.data[k + 1]) + Math.abs(shot.data[k + 2] - bare.data[k + 2]) > 30) { n++; cx += x; cy += y; }
    }
    const box = new T.Box3().setFromObject(figure.root), mid = box.getCenter(new T.Vector3()).applyMatrix4(toGrid);
    const project = (p) => {
      const v = p.clone().multiplyScalar(s).add(a.volume.position).project(a.camera);
      return [(v.x + 1) * shot.width / 2, (1 - v.y) * shot.height / 2];
    };
    const shown = new T.Vector3().fromArray(warp(mid.clone().add(a.sim.origin).toArray(), a.presentation.parameters)).sub(a.sim.origin);
    const bent = meshes.filter((m) => m.material.vertexNode).length;
    a.scene.remove(figure.root); figure.dispose?.();
    for (const o of Object.values(window.__presentationMeshes)) o.visible = true;
    return {
      frames, meshes: meshes.length, bent, pixels: n,
      centroid: n ? [cx / n, cy / n] : null, at: project(shown), flatAt: project(mid),
    };
  });
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const figOff = fig.centroid ? dist(fig.centroid, fig.at) : Infinity, figFlat = fig.centroid ? dist(fig.centroid, fig.flatAt) : Infinity;
  ok(fig.bent === fig.meshes && fig.pixels > 50 && figOff < 0.35 * dist(fig.at, fig.flatAt) && figOff < figFlat,
    `box: a figure bends with the volume: ${fig.bent} of its ${fig.meshes} meshes bent (${fig.frames} frames), its ${fig.pixels} pixels centred ${figOff.toFixed(1)} px from where the bend puts it, ${figFlat.toFixed(1)} px from the flat view's`);

  // TAA steady while the camera, and the bend's anchor under it, moves: after a
  // short walk the resolved frame is close to a fresh one at the same camera,
  // as close as the same walk's flat. The bend is TAA_K_GAIN times the game's
  // here (its parameters' k, which our passes read), so the bend moves pixels
  // a frame. (This doesn't single out the reprojection: TAA's neighbourhood
  // clip hides a misaligned history but for a pixel or two at edges: the
  // camera-only reprojection in its place measured within 0.05 levels of
  // this one's 2.2-2.3, the flat walk 1.9. The reprojection itself is the
  // math stage's, and its algebra tools/check-presentation.mjs's.)
  const taa = await page.evaluate(async (gain) => {
    const a = __app, p = a.presentation;
    const real = Object.getOwnPropertyDescriptor(p, 'parameters');
    Object.defineProperty(p, 'parameters', { configurable: true, get: () => ({ ...real.get.call(p), k: p.active ? real.get.call(p).k * gain : 0 }) });
    const meshes = Object.values(window.__presentationMeshes);
    for (const o of meshes) o.visible = false;   // (they bend by the game's k: only our passes read the parameters)
    a.post.settings.taa = true;
    const start = a.camera.position.clone(), look = new a.THREE.Vector3(0, 1.5, 0);
    const walk = async () => {
      a.camera.position.copy(start); a.camera.lookAt(look); a.camera.updateMatrixWorld();
      a.post.reset();
      for (let i = 0; i < 10; i++) await a.test.renderOnce();   // (the history converges where it starts)
      for (let i = 0; i < 8; i++) {
        a.camera.position.x -= 0.6 * a.scale * 4; a.camera.position.z += 0.3 * a.scale * 4;   // 2.4 and 1.2 cells a frame
        a.camera.lookAt(look); a.camera.updateMatrixWorld();
        await a.test.renderOnce();
      }
      const moved = await a.test.renderOnce({ capture: true });
      a.post.reset();
      const fresh = await a.test.renderOnce({ capture: true });
      return window.__meanDiff(moved, fresh);
    };
    const curved = await walk();
    a.presentation.select(null);
    const flat = await walk();
    a.presentation.select('rollingLog');
    a.camera.position.copy(start); a.camera.lookAt(look); a.camera.updateMatrixWorld();
    a.post.settings.taa = false;
    Object.defineProperty(p, 'parameters', real);
    for (const o of meshes) o.visible = true;
    return { curved, flat };
  }, TAA_K_GAIN);
  ok(taa.curved <= Math.max(1.5 * taa.flat, taa.flat + 1.5),
    `box: TAA steady while the camera moves bent (${TAA_K_GAIN}× the bend): ${taa.curved.toFixed(2)} levels from a fresh frame after the walk (flat: ${taa.flat.toFixed(2)})`);

  // the motion pass's reprojection as createPost builds it (finish(): this frame's
  // jittered clip → world cells, the last frame's parameters and world → clip,
  // swapped after the draw), not as the test builds it: the MotionParams post's own draw
  // packs on a frame after the camera, and the bend's anchor, moved (captured
  // at the draw) bring this frame's displayed points back to where the last
  // frame showed them. The two ways it could be wired wrong miss by far more:
  // the camera alone, and the last frame's parameters swapped in too early.
  const wired = await page.evaluate(async (gain) => {
    const a = __app, p = a.presentation, T = a.THREE, M = await import('/src/gfx/presentationMath.js');
    const { RenderPipe } = await import('/src/gpu/kernels.js'), entry = (await import('/src/gfx/post.js')).WGSL_CHECK.find((e) => e.name === 'motion');
    const real = Object.getOwnPropertyDescriptor(p, 'parameters'), draw = RenderPipe.prototype.draw;
    const meshes = Object.values(window.__presentationMeshes);
    const start = a.camera.position.clone(), look = new T.Vector3(0, 1.5, 0);
    let packed = null;
    try {
      Object.defineProperty(p, 'parameters', { configurable: true, get: () => ({ ...real.get.call(p), k: p.active ? real.get.call(p).k * gain : 0 }) });
      RenderPipe.prototype.draw = function (rp, o) {
        if (this.name === 'motion') packed = entry.params.pack(o.params);   // (as the ring packs them: the matrices change after the draw)
        return draw.call(this, rp, o);
      };
      for (const o of meshes) o.visible = false;
      a.post.settings.taa = true;
      const vp = () => new T.Matrix4().multiplyMatrices(a.camera.projectionMatrix, a.camera.matrixWorldInverse);   // (unjittered after a frame)
      a.camera.lookAt(look); a.camera.updateMatrixWorld();
      for (let i = 0; i < 3; i++) await a.test.renderOnce();
      const vpA = vp(), prev = p.parameters;
      a.camera.position.x -= 0.6 * a.scale * 4; a.camera.position.z += 0.3 * a.scale * 4;   // 2.4 and 1.2 cells
      a.camera.lookAt(look); a.camera.updateMatrixWorld();
      packed = null;
      await a.test.renderOnce();
      if (!packed) return { none: true };
      const vpB = vp(), cur = p.parameters, toScene = p.worldToScene.clone(), o = a.sim.origin;
      // (the scene drew with three's TAAU's jitter: a point's texel is its unjittered NDC less this, scene pixels y down)
      const [jx, jy] = a.post.jitter, [iw, ih] = a.post.inSize, jit = [(2 * jx) / iw, (-2 * jy) / ih];
      const clipOf = (m, w) => new T.Vector4(...w, 1).applyMatrix4(m);
      const ndc = (c) => [c.x / c.w, c.y / c.w];
      const toClip = (vpm) => new T.Matrix4().multiplyMatrices(vpm, toScene);
      const pts = [], want = [], early = [];
      for (let i = 0; i < 64; i++) {
        const P = [o.x + 4 + ((i * 37) % 56), o.y + ((i * 13) % 40), o.z + 4 + ((i * 29) % 56)];   // world cells in the box
        const c = clipOf(toClip(vpB), M.warp(P, cur));
        if (c.w <= 0 || Math.abs(c.x / c.w) > 1 || Math.abs(c.y / c.w) > 1) continue;
        pts.push([(c.x / c.w - jit[0] + 1) / 2, (1 - (c.y / c.w - jit[1])) / 2, c.z / c.w]);
        want.push(ndc(clipOf(toClip(vpA), M.warp(P, prev))));
        early.push(ndc(clipOf(toClip(vpA), M.warp(P, cur))));   // (the last frame's parameters swapped in before the draw)
      }
      const got = await window.__taaReproject(packed, pts);
      if (got.errs) return got;
      const reproj = new T.Matrix4().multiplyMatrices(vpA, vpB.clone().invert());
      let worst = 0, cameraOnly = 0, swapped = 0;
      pts.forEach((q, i) => {
        const [x, y, , w] = got.clip[i];
        worst = Math.max(worst, Math.abs(x / w - want[i][0]), Math.abs(y / w - want[i][1]));
        const r = new T.Vector4(q[0] * 2 - 1 + jit[0], 1 - q[1] * 2 + jit[1], q[2], 1).applyMatrix4(reproj);
        cameraOnly = Math.max(cameraOnly, Math.abs(r.x / r.w - want[i][0]), Math.abs(r.y / r.w - want[i][1]));
        swapped = Math.max(swapped, Math.abs(early[i][0] - want[i][0]), Math.abs(early[i][1] - want[i][1]));
      });
      return { n: pts.length, worst, cameraOnly, swapped, moved: Math.hypot(prev.anchor[0] - cur.anchor[0], prev.anchor[1] - cur.anchor[1]) };
    } finally {
      RenderPipe.prototype.draw = draw;
      Object.defineProperty(p, 'parameters', real);
      a.post.settings.taa = false;
      a.camera.position.copy(start); a.camera.lookAt(look); a.camera.updateMatrixWorld();
      for (const o of meshes) o.visible = true;
    }
  }, TAA_K_GAIN);
  ok(!wired.none && !wired.errs && wired.n >= 32 && wired.worst < 1e-3 && wired.cameraOnly > 20 * wired.worst && wired.swapped > 20 * wired.worst,
    `box: the motion pass's reprojection as createPost wires it (its own MotionParams, the anchor ${wired.moved?.toFixed(1)} cells on) brings ${wired.n} shown points back to the last frame's: worst ${wired.worst?.toExponential(1)} (NDC); the camera alone ${wired.cameraOnly?.toExponential(1)}, the parameters swapped early ${wired.swapped?.toExponential(1)}${wired.errs ? `: ${wired.errs.join('; ')}` : ''}${wired.none ? ': no motion draw captured' : ''}`);

  // deep idle with the effect on: the loop sleeps, no submits
  await page.evaluate(() => __app.test.resume());
  await page.waitForFunction(() => __app.loop.asleep, null, { polling: 250, timeout: 60000 }).catch(() => {});
  const idle = await page.evaluate(async () => {
    const a = __app, s0 = a.gpu.stats.submits, c0 = a.loop.callbacks;
    await new Promise((r) => setTimeout(r, 1000));
    return { submits: a.gpu.stats.submits - s0, callbacks: a.loop.callbacks - c0, asleep: a.loop.asleep, active: a.presentation.active };
  });
  await page.evaluate(() => __app.test.park());
  ok(idle.active && idle.asleep && idle.submits === 0 && idle.callbacks === 0,
    `box: deep idle bent: asleep, ${idle.submits} submits and ${idle.callbacks} animation frames over 1 s`);

  // gamemodes: the lab has none with an effect; dropping the effect restores the meshes
  const life = await page.evaluate(async () => {
    const a = __app, { box, held } = window.__presentationMeshes, revision = a.presentation.revision;
    await a.setMode('animalCrossing');   // (not the lab's: Sandbox, which has no effect)
    const resolved = { ...a.current(), active: a.presentation.active };
    await a.test.renderOnce();
    const restored = !box.material.vertexNode && box.frustumCulled && a.presentation.uniforms.uWarpK.value === 0;
    a.presentation.select('rollingLog');
    await a.test.renderOnce();
    const again = !!box.material.vertexNode;
    a.presentation.select(null);
    for (const o of Object.values(window.__presentationMeshes)) o.removeFromParent();
    return { resolved, restored, again, held: !!held.material.vertexNode, revision: a.presentation.revision > revision };
  });
  ok(life.resolved.mode === 'sandbox' && !life.resolved.active, `box: a map without the gamemode resolves it to Sandbox, no effect: ${JSON.stringify(life.resolved)}`);
  ok(life.restored && life.again && life.revision, 'box: dropping the effect restores the meshes (vertex stage, culling, k), selecting it again bends them');
  ok(!errors.length, `box: no page or GPU errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await page.close();
}

// ---------------------------------------------------------------- world
// The world boots in the plain view (cheap), then the effect is selected and
// the view turned realistic, the only one that draws the far field: only the
// curved variants build (the realistic view's and the far view's). The flat
// reference is the same pipelines with a vanishing bend (k 1e-12: their walk
// is then the straight ray's), so no flat realistic pipeline builds for it.
async function worldStage(browser, vite, secs) {
  const { page, errors } = await boot(browser, vite, `?map=${MAP}&win=64&view=plain`);
  await page.evaluate(PAGE_HELPERS);
  console.log(`     booted (${secs()})`);
  const r = await page.evaluate(async ({ map, diff }) => {
    const a = __app, far = a.win?.far, { mapByKey } = await import('/src/maps.js'), { VIEWS } = await import('/src/views.js');
    if (!far) return { noWorld: true };
    // the gamemode where the map has it, else the effect by hand
    if (mapByKey(map)?.modes?.includes('animalCrossing')) await a.setMode('animalCrossing'); else a.presentation.select('rollingLog');
    a.setView(VIEWS.find((v) => v.key === 'realistic').id);
    await a.test.ready();
    for (let i = 0; i < 3 && !(far.visible && far.viewReady); i++) { await a.test.renderOnce(); await far.buildView(); }
    const curved = await a.test.renderOnce({ capture: true });
    const out = { curvedFar: far.visible, farPipe: far.viewPipeline.state, curvedPipe: far.viewPipeline === far.viewPipeCurved, drawn: a.view.volumeDrawn, mode: a.current().mode };
    const p = a.presentation, real = Object.getOwnPropertyDescriptor(p, 'parameters');
    // (a k of 0 is flat and draws the flat variants, which aren't built: a vanishing one instead)
    Object.defineProperty(p, 'parameters', { configurable: true, get: () => ({ ...real.get.call(p), k: 1e-12 }) });
    const flat = await a.test.renderOnce({ capture: true });
    Object.defineProperty(p, 'parameters', real);
    out.flatFar = far.visible;
    out.changed = window.__share(flat, curved, diff);
    return out;
  }, { map: MAP, diff: DIFF });
  await page.screenshot({ path: join(OUT, `world-${MAP}.png`) });
  if (r.noWorld) { ok(false, `world: ${MAP} booted without its world`); await page.close(); return; }
  ok(r.curvedFar && r.curvedPipe && r.farPipe === 'ready' && r.drawn,
    `world: ${MAP}'s far view draws its curved variant (${r.farPipe}), the volume its own (${secs()})`);
  ok(r.flatFar && r.changed >= MIN_CHANGED, `world: the bend moves ${(100 * r.changed).toFixed(1)}% of the frame against a vanishing k (floor ${100 * MIN_CHANGED}%); gamemode ${r.mode}`);
  ok(!errors.length, `world: no page or GPU errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await page.close();
}

// ---------------------------------------------------------------- boot
// The gamemode's effect is selected before the grid is built (app.js's boot
// and openMap), so the build, and the loading screen with it, wait on the
// curved variant the view draws, never on a flat one it won't. Willow Cove,
// the gamemode's map, gets its world WGSL from DP4-W: the Island is given
// Animal Crossing here instead (maps.js served with it in the Island's modes).
async function bootStage(browser, vite, secs) {
  const page = await newTestPage(browser, { mode: 'manual', viewport: VIEWPORT });
  const errors = watch(page);
  let patched = false;
  await page.route('**/src/maps.js*', async (route) => {
    const res = await route.fetch(), text = await res.text();
    const body = text.replace("scene: 'island', dims: WORLD_DIMS,", "scene: 'island', dims: WORLD_DIMS, modes: ['animalCrossing'],");
    patched ||= body !== text;
    await route.fulfill({ response: res, body });
  });
  await page.goto(vite.url('/?map=island&win=64&view=plain&mode=animalCrossing'));
  await page.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 150000 });
  const failed = await page.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot: ${failed.slice(0, 600)}`);
  if (!gpuShown) {
    gpuShown = true;
    const g = await gpuInfo(page);
    console.log(`gpu: ${g.vendor} ${g.architecture}${g.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
  }
  // (__app is set once the build's pipelines are: app.js awaits coreWait first)
  const booted = await page.evaluate(() => ({
    effect: __app.presentation.effect, pipes: __app.vol.pipelines.map((p) => `${p.key} ${p.state}`),
  }));
  ok(patched && booted.effect === 'rollingLog' && booted.pipes.includes('plain||curved ready') && !booted.pipes.some((p) => p.startsWith('plain| ')),
    `boot: the URL's gamemode bends the view before the grid is built, which waited on the curved variant only: ${booted.pipes.join(', ')} (${secs()})`);
  // a map opened over it (the start menu's Start): the gamemode's effect, then the build
  const reopen = await page.evaluate(() => {
    const a = __app, keys = () => a.vol.pipelines.map((p) => p.key);
    a.openMap('island', 'sandbox');
    const flat = { effect: a.presentation.effect, pipes: keys() };
    a.openMap('island', 'animalCrossing');
    const bent = { effect: a.presentation.effect, pipes: keys() };
    return { flat, bent };
  });
  ok(reopen.flat.effect === null && reopen.flat.pipes.includes('plain|') && !reopen.flat.pipes.includes('plain||curved'),
    `boot: openMap into Sandbox builds the flat variant only: ${JSON.stringify(reopen.flat)}`);
  ok(reopen.bent.effect === 'rollingLog' && reopen.bent.pipes.includes('plain||curved') && !reopen.bent.pipes.includes('plain|'),
    `boot: openMap into Animal Crossing builds the curved variant only: ${JSON.stringify(reopen.bent)}`);
  await page.evaluate(() => __app.test.ready());
  ok(!errors.length, `boot: no page or GPU errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await page.close();
}

const t0 = Date.now(), secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
for (const stage of STAGES) {
  const fn = { math: mathStage, box: boxStage, world: worldStage, boot: bootStage }[stage];
  if (!fn) { ok(false, `no stage ${stage}`); continue; }
  const vite = await startVite();
  const browser = await launchBrowser({ lifetimeMs: LIFETIME_MS });
  try {
    await fn(browser, vite, secs);
  } catch (e) {
    ok(false, `${stage}: ${String(e.stack || e).slice(0, 600)}`);
  } finally {
    await browser.close();
    await vite.close();
  }
}
console.log(failures ? `presentation-check: ${failures} failure(s); shots in ${OUT}` : `presentation-check: clean; shots in ${OUT}`);
process.exit(failures ? 1 : 0);
