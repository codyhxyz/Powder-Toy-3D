// GPU visual/interaction smoke of the rolling log through the app's own paths
// (main's, on the WebGPU app: docs/webgpu.md Sync log, Sync 4). Four stages,
// each its own browser within ~3 minutes on SwiftShader, and one Vite
// (tools/vite-server.mjs) unless --port names a running one:
//
//   launch  the start menu's gamemode filter, a URL launch into the gamemode,
//           a visible A/B against Sandbox, the simulation untouched
//   pick    a cell picked under the cursor while curved, an ordinary mesh
//           where the bend shows it
//   mode    the mode lifecycle: selection idempotent, a mesh bent and
//           restored, its programs compiled before it draws, the simulation
//           untouched
//   fallback  an incompatible map's fallback (the Lab with Animal Crossing)
//
//   node tools/presentation-visual-check.mjs [--stage launch,pick,mode,fallback] [--map willowCove] [--win N] [--view plain] [--port N]
//
// --map willowCove (the gamemode's map, main's case) launches with
// &mode=animalCrossing. Any other map has no Animal Crossing: its URL launch
// must fall back to Sandbox, and the effect is then selected by hand (as
// tools/presentation-check.mjs does): --map island --win 64 --view plain is the
// case SwiftShader runs while Willow Cove's world WGSL is DP4-W's. The launch
// waits for the far field's whole build, as main's does, on Willow Cove or
// with --drain; else for its first chunks only (SwiftShader draws the Island's
// 256 at about one per 5 s: half an hour).
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage, ready, render, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const port = arg('port', null);
const STAGES = arg('stage', 'launch,pick,mode,fallback').split(',');
const MAP = arg('map', 'willowCove');
const WIN = arg('win', null);
const VIEW = arg('view', null);
const OWN_MODE = MAP === 'willowCove';   // (maps.js: the only map with Animal Crossing)
const DRAIN = OWN_MODE || args.includes('--drain');
// a stage's browser lifetime (TPT_TEST_TIMEOUT_MS raises it on a slow or shared machine: Willow Cove's
// far field drains ~255 detail chunks while bent, culling off as in main, about a minute a hundred on SwiftShader)
const STAGE_MS = Number(process.env.TPT_TEST_TIMEOUT_MS) || 175000;
const VIEWPORT = { width: 480, height: 320 };   // (main's 1200×800, scaled down: the Island's frames take seconds on SwiftShader)
// the frame below the HUD's bars (main's 310,280 790×400 of 1200×800), scaled
const CROP = [310 / 1200, 280 / 800, 790 / 1200, 400 / 800].map((f, i) => Math.round(f * (i % 2 ? VIEWPORT.height : VIEWPORT.width)));
const out = '/tmp/tpt-presentation-check';
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

function watch(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    const t = message.text();
    if (t.includes('ERR_CONNECTION_REFUSED')) return;
    if (message.type() === 'error' || (message.type() === 'warning' && /WebGPU|GPU (validation|internal|out-of-memory)|shader failed/i.test(t))) errors.push(t);
  });
  return errors;
}

// The URL launch: the gamemode on its map, or Sandbox (and the effect by hand)
// on another. Leaves the app parked at native resolution under a fixed sun.
// TAA off on a fallback adapter (still()): a frame is then whole, where
// TAA's history takes dozens (seconds each, the Island's, on SwiftShader).
// TAA under the bend is tools/presentation-check.mjs's box stage.
async function launch(page, vite) {
  const query = new URLSearchParams({ map: MAP, mode: 'animalCrossing', ...(WIN ? { win: WIN } : {}), ...(VIEW ? { view: VIEW } : {}) });
  await page.goto(vite.url(`/?${query}`));
  await page.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 150000 });
  const failed = await page.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot ${query}: ${failed.slice(0, 600)}`);
  await ready(page);
  const g = await gpuInfo(page);
  console.log(`     gpu: ${g.vendor} ${g.architecture}${g.isFallbackAdapter ? ' (fallback adapter)' : ''}; booted ${secs()}`);
  // (bootReady starts the URL's gamemode once the world has loaded: join:ready)
  await page.waitForFunction((drain) => {
    const a = window.__app;
    return performance.getEntriesByName('join:ready').length && a.win.loaded && a.win.far.ready && a.win.far.built && (!drain || !a.win.far.queue.length);
  }, DRAIN, { timeout: STAGE_MS - 25000, polling: 250 });
  if (!OWN_MODE) {
    const launched = await page.evaluate(() => ({ current: window.__app.current(), effect: window.__app.presentation.effect }));
    assert.equal(launched.current.mode, 'sandbox', `${MAP} has no Animal Crossing: the URL launch falls back to Sandbox`);
    assert.equal(launched.effect, null);
    await page.evaluate(() => window.__app.presentation.select('rollingLog'));   // (by hand, as the mode would)
  }
  assert.equal(await page.evaluate(() => window.__app.presentation.effect), 'rollingLog');
  console.log(`     loaded, the far field ${DRAIN ? 'built' : 'building'} (${secs()})`);
  return page.evaluate(async (software) => {
    const a = window.__app;
    a.test.park();
    a.autoRes.enabled = false;
    a.settings.upscale = 'native';
    a.post.settings.resolutionScale = 1;
    if (software) a.post.settings.taa = false;
    a.day.fixed = { az: 35, el: 32 };
    return { current: a.current(), version: a.sim.version, pov: a.pov.active, software };
  }, g.isFallbackAdapter);
}

// A full-quality still: render() (converged), or on SwiftShader, where that is
// dozens of frames of seconds each, the pipelines ready and two frames (TAA is
// off there: each frame is whole).
async function still(page, software) {
  if (!software) return render(page);
  await page.evaluate(async () => {
    const a = window.__app;
    a.test.park();
    await a.test.ready();
    await a.test.renderOnce();
    await a.test.renderOnce();
  });
}

// ---------------------------------------------------------------- launch
async function launchStage(page, vite) {
  const errors = watch(page);
  await page.goto(vite.url('/'));
  await page.locator('.mm-mode').filter({ hasText: 'Animal Crossing' }).click();
  assert.equal(await page.locator('.mm-card').count(), 1);
  assert.equal(await page.locator('.mm-card').getAttribute('data-map'), 'willowCove');
  assert.equal(await page.evaluate(() => !!window.__app), false, 'mode menu stays lightweight');
  await page.locator('.mm-mode').filter({ hasText: 'Sandbox' }).click();
  assert.equal(await page.locator('.mm-card[data-map="willowCove"]').count(), 1, 'Sandbox still includes Willow Cove');
  console.log(`PASS the menu filters by gamemode (${secs()})`);

  const initial = await launch(page, vite);
  assert.deepEqual(initial.current, { map: MAP, mode: OWN_MODE ? 'animalCrossing' : 'sandbox' });
  assert.equal(initial.pov, false, 'presentation mode does not force POV');
  await still(page, initial.software);
  const curved = await page.screenshot({ path: `${out}/rolling.png` });
  await page.evaluate(() => window.__app.setMode('sandbox'));
  await still(page, initial.software);
  const flat = await page.screenshot({ path: `${out}/flat.png` });
  const comparison = await page.evaluate(async ([before, after, crop]) => {
    async function pixels(data) {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(...crop).data; // no HUD
    }
    const a = await pixels(before), b = await pixels(after);
    let changed = 0, bright = 0, difference = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > 30) changed++;
      if (a[i] + a[i + 1] + a[i + 2] > 60) bright++;
      difference += d;
    }
    return { changed: changed / (a.length / 4), bright: bright / (a.length / 4), difference: difference / (a.length / 4) };
  }, [curved.toString('base64'), flat.toString('base64'), CROP]);
  assert(comparison.changed > 0.05, `curvature must visibly change geometry: ${JSON.stringify(comparison)}`);
  assert(comparison.bright > 0.5, 'curved scene is not a black shader failure');
  assert.equal(await page.evaluate(() => window.__app.sim.version), initial.version, 'effect toggles do not change physics');
  assert.deepEqual(errors, []);
  console.log(`PASS URL launch, render-only mode, visible A/B, no browser errors (${secs()})`, comparison);
}

// ---------------------------------------------------------------- pick
async function pickStage(page, vite) {
  const errors = watch(page);
  const { software } = await launch(page, vite);
  // A real voxel target and an ordinary Three mesh share the same deformation.
  // Willow Cove's are main's (its plaza); another map's stand on the ground the
  // flat view shows a little below the frame's middle.
  const target = await page.evaluate(async ([own, crop]) => {
    const a = window.__app, T = a.THREE;
    const { E } = await import('/src/elements.js');
    const { warp } = await import('/src/gfx/presentationMath.js');
    const origin = new T.Vector3(a.sim.origin.x, 0, a.sim.origin.z);
    let center = [484.5, 52.5, 524.5], meshWorld = [496.5, 68.5, 524.5];
    if (!own) {
      const toGrid = a.volume.matrixWorld.clone().invert();
      const eye = a.camera.position.clone().applyMatrix4(toGrid);
      const at = new T.Vector3(((crop[0] + crop[2] / 2) / innerWidth) * 2 - 1, 1 - ((crop[1] + crop[3] * 0.6) / innerHeight) * 2, 0.5)
        .unproject(a.camera).applyMatrix4(toGrid);
      const ground = await a.pickRay(eye, at.sub(eye).normalize());
      if (!ground.valid) return { ground: false };
      const c = ground.cell.clone().addScalar(0.5).add(new T.Vector3(0, 4, 0)).add(origin);
      center = c.toArray(); meshWorld = c.clone().add(new T.Vector3(-6, 10, 0)).toArray();
    }
    if (own) await a.setMode('animalCrossing'); else a.presentation.select('rollingLog');
    a.test.render();
    const local = new T.Vector3(...center).sub(origin);
    a.sim.paint({ center: local, radius: 3, shape: 1, tool: E.WALL, rate: 1, replace: true });
    const mesh = new T.Mesh(new T.BoxGeometry(4 * a.scale, 4 * a.scale, 4 * a.scale), new T.MeshBasicMaterial({ color: 0xff00ff }));
    mesh.name = 'presentation-check-marker';
    mesh.position.set(...meshWorld).applyMatrix4(a.presentation.worldToScene);
    a.scene.add(mesh);
    a.test.render();
    const screen = (p) => {
      const v = new T.Vector3(...p).applyMatrix4(a.presentation.worldToScene).project(a.camera);
      return { x: (v.x + 1) * innerWidth / 2, y: (1 - v.y) * innerHeight / 2 };
    };
    const project = p => screen(warp(p, a.presentation.parameters));
    return { ground: true, voxel: project(center), voxelFlat: screen(center), mesh: project(meshWorld), meshFlat: screen(meshWorld), center, id: E.WALL, origin: a.sim.origin, version: a.sim.version };
  }, [OWN_MODE, CROP]);
  assert(target.ground, 'the flat view shows ground below the frame\'s middle');
  const visible = (p) => p.x > CROP[0] && p.x < CROP[0] + CROP[2] && p.y > CROP[1] - CROP[3] / 2 && p.y < CROP[1] + CROP[3];
  assert(visible(target.voxel), `voxel target is visible and outside HUD: ${JSON.stringify(target.voxel)}`);
  const at = (p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`;
  console.log(`     target ${target.center} shown at ${at(target.voxel)} (flat: ${at(target.voxelFlat)}); the mesh at ${at(target.mesh)} (flat: ${at(target.meshFlat)})`);
  await page.evaluate(() => { window.__app.hover.valid = false; window.__app.test.resume(); });
  await page.mouse.move(target.voxel.x, target.voxel.y);
  try {
    await page.waitForFunction(id => window.__app.hover.valid && window.__app.hover.id === id, target.id, { timeout: 60000 });   // (frames of seconds)
  } catch (error) {
    await page.evaluate(() => window.__app.test.park());
    await page.screenshot({ path: `${out}/pick-failure.png` });
    console.error({ target, hover: await page.evaluate(() => window.__app.hover), errors });
    throw error;
  }
  const hover = await page.evaluate(() => {
    const a = window.__app;
    a.test.park();
    return { ...a.hover, cell: a.hover.cell.toArray() };
  });
  for (let i = 0; i < 3; i++) {
    const origin = [target.origin.x, 0, target.origin.z][i];
    assert(Math.abs(hover.cell[i] + origin - target.center[i]) <= 4, 'hover picks the deformed target in flat cell coordinates');
  }
  // (the marker's program compiles, parked, on its first frames: frames until
  // it shows; on SwiftShader one renderOnce, not render(), each: TAA is off)
  const magenta = (c) => c[0] > c[1] * 1.2 && c[2] > c[1] * 1.2;
  let meshPixel = null;
  // the canvas alone: the HUD (Willow Cove's tool chip, the hover label) can
  // sit over the marker's projection, and a page screenshot samples the HUD
  await page.addStyleTag({ content: 'body * { visibility: hidden !important } canvas { visibility: visible !important }' });
  for (let i = 0; i < 6 && !(meshPixel && magenta(meshPixel)); i++) {
    if (i === 0 && !software) await render(page); else await page.evaluate(() => window.__app.test.renderOnce());
    const markerImage = await page.screenshot({ path: `${out}/targets.png` });
    meshPixel = await page.evaluate(async ({ png, point }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data];
    }, { png: markerImage.toString('base64'), point: target.mesh });
  }
  assert(magenta(meshPixel), `mesh appears at its deformed projection: ${meshPixel}`);
  console.log(`PASS screen picking and ordinary mesh projection (${secs()})`, { hover: { id: hover.id, cell: hover.cell }, meshPixel });

  assert.deepEqual(errors, []);
  await page.evaluate(() => window.__app.test.park());
}

// ---------------------------------------------------------------- mode
async function modeStage(page, vite) {
  const errors = watch(page);
  const { version } = await launch(page, vite);
  // A marker the bend takes over (its material's vertex stage, culling off),
  // and gives back: each program compiles parked before the mesh draws
  // (src/wire/mesh.js compileChanged), never at a draw (F8: three's
  // synchronous pipeline builds, counted at its backend).
  const lifecycle = await page.evaluate(async (own) => {
    const a = window.__app, T = a.THREE, backend = a.renderer.backend, create = backend.createRenderPipeline;
    let sync = 0;
    backend.createRenderPipeline = function (renderObject, promises) { if (!promises) sync++; return create.call(this, renderObject, promises); };
    try {
      const mesh = new T.Mesh(new T.BoxGeometry(4 * a.scale, 4 * a.scale, 4 * a.scale), new T.MeshBasicMaterial({ color: 0xff00ff }));
      mesh.name = 'presentation-check-marker';
      mesh.position.copy(a.camera.position).addScaledVector(a.camera.getWorldDirection(new T.Vector3()), 24 * a.scale);   // (in view)
      a.scene.add(mesh);
      const until = async (done) => {
        let frames = 0;
        while (!done() && frames < 12) { await a.test.renderOnce(); frames++; }
        await a.test.renderOnce();   // (and drawn)
        return frames;
      };
      const shown = await until(() => !!mesh.material.vertexNode && mesh.layers.mask === 1);
      const bent = { frames: shown, culled: mesh.frustumCulled, node: !!mesh.material.vertexNode, layers: mesh.layers.mask, sync };
      // the control: a mesh compiled flat whose bent program nobody compiles
      // (its change taken from compileChanged) builds it at its first draw.
      // (A material no other mesh has: three shares a pipeline between meshes
      // whose programs match, the marker's among them.)
      const { prepareMesh } = await import('/src/gfx/meshLight.js');
      const control = new T.Mesh(new T.BoxGeometry(4 * a.scale, 4 * a.scale, 4 * a.scale), new T.MeshNormalMaterial({ side: T.DoubleSide, flatShading: true }));
      control.position.copy(mesh.position).addScaledVector(new T.Vector3(1, 0, 0), 6 * a.scale);
      await prepareMesh(control, { camera: a.camera });
      a.scene.add(control);
      a.presentation.install(a.scene, a.camera);
      a.presentation.takeChanged();
      await a.test.renderOnce();
      bent.control = sync - bent.sync;
      a.scene.remove(control); control.geometry.dispose(); control.material.dispose();
      const syncBefore = sync;
      const revision = a.presentation.revision;
      if (own) await a.setMode('animalCrossing'); else a.presentation.select('rollingLog');
      const stable = a.presentation.revision === revision;
      await a.setMode('sandbox');
      const restored = mesh.frustumCulled && !mesh.material.vertexNode && !a.presentation.active && a.presentation.uniforms.uWarpK.value === 0;
      await a.test.renderOnce();
      const back = await until(() => mesh.layers.mask === 1);
      const flat = { frames: back + 1, layers: mesh.layers.mask, sync: sync - syncBefore };
      a.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose();
      return { bent, stable, restored, flat, version: a.sim.version, current: a.current() };
    } finally {
      backend.createRenderPipeline = create;
    }
  }, OWN_MODE);
  console.log(`     the marker bent after ${lifecycle.bent.frames} frames, flat again after ${lifecycle.flat.frames}; three's synchronous pipeline builds: ${lifecycle.bent.sync}, ${lifecycle.flat.sync} (the uncompiled control: ${lifecycle.bent.control})`);
  assert(!lifecycle.bent.culled && lifecycle.bent.node && lifecycle.bent.layers === 1, `the bend takes the marker over while selected: ${JSON.stringify(lifecycle.bent)}`);
  assert(lifecycle.stable && lifecycle.restored && lifecycle.flat.layers === 1, 'effect selection is idempotent and restores mesh state');
  assert(lifecycle.bent.control > 0, 'the control builds its bent program at a draw (the count sees one)');
  assert.equal(lifecycle.bent.sync + lifecycle.flat.sync, 0, 'the bent and restored programs compile before a draw (F8)');
  assert.equal(lifecycle.version, version, 'effect changes do not step physics');
  assert.equal(lifecycle.current.mode, 'sandbox');
  assert.deepEqual(errors, []);
  console.log(`PASS mode lifecycle, programs compiled before a draw, no browser errors (${secs()})`);
}

// ---------------------------------------------------------------- fallback
// From a small box (the Island's frames are seconds each on SwiftShader): the
// Lab has no Animal Crossing, so opening it with the mode plays Sandbox. A
// converged frame of it, as main's, on a real GPU: SwiftShader's frames of the
// Lab (128³) take 9 s and render() dozens of them, so there one frame.
async function fallbackStage(page, vite) {
  const errors = watch(page);
  await page.goto(vite.url('/?size=64&preset=empty&view=plain'));
  await ready(page);
  const software = (await gpuInfo(page)).isFallbackAdapter;
  await page.evaluate(() => window.__app.openMap('lab', 'animalCrossing'));
  await page.waitForFunction(() => !window.__app.win && window.__app.settings.preset === 'lab', null, { timeout: 60000, polling: 250 });
  if (software) await page.evaluate(async () => { window.__app.test.park(); await window.__app.test.ready(); await window.__app.test.renderOnce(); });
  else await render(page);
  const after = await page.evaluate(() => ({ current: window.__app.current(), effect: window.__app.presentation.effect }));
  assert.deepEqual(after, { current: { map: 'lab', mode: 'sandbox' }, effect: null }, 'incompatible mode/map falls back safely');
  assert.deepEqual(errors, []);
  console.log(`PASS incompatible-map fallback, no browser errors (${secs()})`);
}

const vite = port ? { url: (p) => `http://127.0.0.1:${port}${p}`, close: async () => {} } : await startVite();
try {
  for (const stage of STAGES) {
    const fn = { launch: launchStage, pick: pickStage, mode: modeStage, fallback: fallbackStage }[stage];
    if (!fn) throw new Error(`no stage ${stage}`);
    const browser = await launchBrowser({ lifetimeMs: STAGE_MS });   // (a stage: under three minutes on an idle machine)
    try {
      await fn(await newTestPage(browser, { mode: 'ui', viewport: VIEWPORT }), vite);
    } finally {
      await browser.close();
    }
  }
} finally {
  await vite.close();
}
