// Real WebGL checks; owns and closes its Vite server/browser. No app/UI boot.
// node scripts/check-wand-world.mjs [--port 53187]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 53187;
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
let output = '', browser;
server.stdout.on('data', (b) => { output += b; });
server.stderr.on('data', (b) => { output += b; });
try {
  for (let i = 0; i < 100 && !output.includes('Local:'); i++) {
    assert.equal(server.exitCode, null, output);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(output, /Local:/);
  browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(`${url}/__wand_check__`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Wand GPU checks</title>' }));
  await page.goto(`${url}/__wand_check__`);
  const result = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { Simulation } = await import('/src/sim.js');
    const { createWandWorld } = await import('/src/pov/wands/world.js');
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { gfxUniforms, updateGfxUniforms } = await import('/src/gfx/uniforms.js');
    const { volumeVert, volumeFrag } = await import('/src/shaders/render.js');
    const check = (ok, message) => {
      if (!ok) throw Error(message);
      const error = renderer.getContext().getError();
      if (error) throw Error(`${message}: WebGL error ${error}`);
    };
    const v = (x, y, z) => new THREE.Vector3(x, y, z);
    const renderer = new THREE.WebGLRenderer(); renderer.autoClear = false; renderer.setSize(32, 32);
    const sim = new Simulation(renderer, 32, 32, 32);
    check(true, 'Simulation construction');
    let active = sim;
    const world = createWandWorld({ renderer, getSim: () => active });
    const begin = () => world.begin({ sim: active, dt: 1 / 60, stepsPerFrame: 4 });
    const c = v(8.5, 8.5, 8.5);
    const cmd = (effect, props = {}) => ({ effect, center: c, radius: 0.5, power: 100, ...props });
    const cell = (x = 8, y = 8, z = 8) => sim.readCell(x, y, z);
    function scene(cells = []) {
      const [a, b] = sim.blankState();
      for (const [x, y, z, id] of cells) {
        const i = sim.cellTexel(x, y, z) * 4, e = ELEMENTS[id];
        a.set([id, e.temp, e.life, 0.25], i);
      }
      sim.load(a, b);
      begin();
    }
    function apply(...commands) {
      begin();
      for (const command of commands) check(world.queue(command), `queue ${command.effect}`);
      world.flush();
    }
    try {
      scene([[8, 8, 8, E.ROCK], [9, 8, 8, E.WALL], [10, 8, 8, E.CLONE]]);
      apply(cmd('dig', { power: 29 })); check(cell()[0][0] === E.ROCK, 'dig honors hardness');
      apply(cmd('dig')); check(cell()[0][0] === E.STONE, 'dig leaves debris');
      apply(cmd('erase', { radius: 3 }));
      check(cell()[0][0] === E.EMPTY && cell(9)[0][0] === E.WALL && cell(10)[0][0] === E.CLONE, 'erase protects WALL/CLONE');
      apply(cmd('emit', { material: 'ACID', radius: 3, velocity: v(240, 0, 0) }));
      check(cell()[0][0] === E.ACID && cell()[1][0] === 1 && cell(9)[0][0] === E.WALL, 'emit gas-only and step velocity');
      apply(cmd('place', { material: 'ICE' })); check(cell()[0][0] === E.ACID, 'place preserves liquid');
      apply(cmd('erase'), cmd('place', { material: 'ICE' })); check(cell()[0][0] === E.ICE, 'ordered ice placement');
      apply(cmd('heat', { power: 100 })); check(cell()[0][1] === 80, 'heat');
      apply(cmd('cool', { power: 200 })); check(cell()[0][1] === -120, 'cool');
      apply(cmd('pressure', { power: 6000 })); check(cell()[1][3] === 200, 'bounded pressure');
      scene([[8, 8, 8, E.GUNPOWDER]]);
      apply(cmd('ignite')); check(cell()[0][1] > 200, 'ignite combustible');
      apply(cmd('attract', { center: v(7.5, 8.5, 8.5), radius: 2, power: 1000, dt: 0.25 }));
      check(cell()[1][0] < 0, 'attract');
      apply(cmd('repel', { center: v(7.5, 8.5, 8.5), radius: 2, power: 6000, dt: 0.25 }));
      check(cell()[1][0] >= 0, 'repel');
      scene();
      for (let i = 0; i < 64; i++) check(world.queue(cmd('heat', { power: 1 })), 'accept bounded batch');
      check(!world.queue(cmd('heat')), 'queue overflow'); world.flush(); world.flush();
      check(world.stats.passes === 1 && world.stats.commands === 64 && cell()[0][1] === 84, 'one pass for 64 commands');
      check(world.stats.touched.lo[0] === 8 && world.stats.touched.hi[0] === 9, 'tight touched bounds');
      check(!world.queue(cmd('heat')), 'one flush per frame');
      begin();
      for (const bad of [cmd('wat'), cmd('heat', { power: NaN }), cmd('emit', { material: '__proto__' }), cmd('heat', { center: v(Infinity, 0, 0) }), cmd('heat', { velocity: v(NaN, 0, 0) })]) check(!world.queue(bad), 'reject invalid inputs');
      // Query direct state immediately after mutation; no derived brick rebuild.
      apply(cmd('place', { material: 'WALL' }));
      const segment = { from: v(2.5, 8.5, 8.5), to: v(12.5, 8.5, 8.5) };
      begin();
      const hits = await world.trace(Array.from({ length: 128 }, () => segment));
      check(hits.length === 128 && hits.every((h) => h?.id === E.WALL && h.cell.x === 8 && h.normal.x === -1 && Math.abs(h.fraction - 0.55) < 1e-5), '128 batched segment hits');
      check(world.stats.readbacks === 1, 'one tiny readback for 128 rays');
      const floor = (await world.trace([{ from: v(2, 2, 2), to: v(2, -2, 2) }]))[0];
      check(floor?.cell.y === -1 && floor.normal.y === 1 && floor.fraction === 0.5, 'floor ray');
      check((await world.trace([{ from: v(-1, 10, 10), to: v(33, 10, 10) }]))[0] === null, 'empty through-grid ray');
      let rejected = false; try { await world.trace(Array(129).fill(segment)); } catch { rejected = true; }
      check(rejected, 'overlong batch rejected');
      begin();
      check((await world.trace([{ from: v(8, 8.5, 8.5), to: v(3, 8.5, 8.5) }]))[0] === null, 'departing exact face is clear');
      const entering = (await world.trace([{ from: v(-2, 8.5, 8.5), to: v(18, 8.5, 8.5) }]))[0];
      check(entering?.cell.x === 8 && Math.abs(entering.fraction - 0.5) < 1e-5, 'outside-grid entry');
      const mutable = [segment, segment], captured = world.trace(mutable); mutable.length = 0;
      check((await captured).length === 2, 'async result owns input batch length');
      begin(); const pendingHit = world.trace([segment]); world.windowShifted(4, 0);
      check((await pendingHit)[0]?.cell.x === 4, 'pending hit shifts to current window');
      world.windowShifted(-4, 0);
      scene();
      check(await world.clearance(v(8, 2, 8)), 'empty full-body clearance');
      check(!await world.clearance(v(8, -0.01, 8)), 'feet below floor fails clearance');
      scene([[8, 7, 8, E.ROCK]]);
      check(!await world.clearance(v(8, 2, 8)), 'head obstruction fails clearance');
      scene([[7, 4, 7, E.ROCK]]);
      check(!await world.clearance(v(8, 2, 8)), 'corner obstruction fails clearance');
      scene(); const movingClearance = world.clearance(v(8, 2, 8)); world.windowShifted(4, 0);
      check(!await movingClearance, 'shift invalidates clearance'); world.windowShifted(-4, 0);
      begin(); check(!await world.clearance(v(0, 2, 0)), 'out-of-grid body rejected');
      begin(); const stale = world.trace([segment]); active = null;
      check((await stale)[0] === null, 'replacement invalidates pending trace'); active = sim;
      begin();
      const reads = Array.from({ length: 4 }, () => world.trace([segment])); await Promise.all(reads);
      check(world.stats.readbacks === 3 && world.stats.maxPending <= 3, 'bounded in-flight/readbacks');
      // Queue and lights already captured before a window shift move exactly once.
      scene(); check(world.queue(cmd('place', { center: v(12.5, 8.5, 8.5), material: 'ICE' })), 'shift queue');
      world.setLights([{ position: v(12, 10, 8), color: [0.2, 0.4, 1], radius: 12, intensity: 4 }]);
      world.windowShifted(4, 0); world.flush();
      check(cell()[0][0] === E.ICE && gfxUniforms.uWandLightPosition.value[0].x === 8, 'queued mutation/light shift');
      world.windowShifted(-4, 0);
      // Real voxel surface shading, same volume shader and shared uniforms as app.
      const blocks = [];
      for (let x = 12; x < 20; x++) for (let y = 8; y < 16; y++) for (let z = 12; z < 20; z++) blocks.push([x, y, z, E.WALL]);
      scene(blocks); sim.updateBricks();
      const sun = v(0, 1, 0); updateGfxUniforms(sim, sun, [1, 1, 1]);
      gfxUniforms.uNearGI.value = false; gfxUniforms.uGlowLights.value = false;
      const geometry = new THREE.BoxGeometry(32, 32, 32); geometry.translate(16, 16, 16);
      const mat = new THREE.ShaderMaterial({ vertexShader: volumeVert, fragmentShader: volumeFrag(sim.g), side: THREE.BackSide,
        uniforms: { ...gfxUniforms, tA: { value: sim.stateA }, tBrick: { value: sim.brick.texture }, tLight: { value: sim.lightTexture },
          uCam: { value: v(16, 12, 30) }, uSun: { value: sun }, uView: { value: 0 }, uShadows: { value: false },
          uTime: { value: 0 }, uLightGain: { value: 1 }, uOrigin: sim.originUniform, uFar: { value: false } } });
      const view = new THREE.Scene(); view.add(new THREE.Mesh(geometry, mat));
      const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100); camera.position.set(16, 12, 30); camera.lookAt(16, 12, 16);
      const target = new THREE.WebGLRenderTarget(32, 32, { type: THREE.FloatType });
      function pixel() {
        renderer.setRenderTarget(target); renderer.render(view, camera);
        const buf = new Float32Array(4); renderer.readRenderTargetPixels(target, 16, 16, 1, 1, buf); return [...buf];
      }
      world.setLights(Array.from({ length: 20 }, () => ({ position: v(16, 12, 23), color: [1, 1, 1], radius: 12, intensity: 1 })));
      check(world.stats.lights === 8, 'light cap');
      world.setLights([{ position: v(NaN, 0, 0), color: [1, 1, 1], radius: 12, intensity: 1 }]);
      check(world.stats.lights === 0, 'invalid light rejected');
      world.setLights([]); const dark = pixel();
      world.setLights([{ position: v(16, 12, 23), color: [0.1, 0.3, 1], radius: 12, intensity: 8 }]); const lit = pixel();
      check(lit[2] > dark[2] + 0.1, `cold light changes voxel surface: ${dark} -> ${lit}`);
      check(cell(16, 12, 19)[0][1] === 20, 'cold light does not heat surface');
      world.setLights([]); const off = pixel(); check(Math.abs(off[2] - dark[2]) < 1e-5, 'light removal');
      renderer.setRenderTarget(null); target.dispose(); geometry.dispose(); mat.dispose();
      begin(); const disposedTrace = world.trace([segment]); world.dispose();
      check((await disposedTrace)[0] === null && gfxUniforms.uWandLightCount.value === 0, 'disposal invalidates probes/lights');
      const glError = renderer.getContext().getError();
      check(glError === 0, `no WebGL errors: ${glError}`);
      return { checks: 'all effects, bounds, 128 traces, full-body clearance, generations, shifts, cold voxel surfaces', stats: world.stats, surface: { dark, lit, off } };
    } finally { world.dispose(); sim.dispose(); renderer.dispose(); }
  }).catch((error) => { console.error(errors.join('\n')); throw error; });
  assert.deepEqual(errors, [], errors.join('\n'));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
}
