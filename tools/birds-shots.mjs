// Birds on the GPU (src/birds): World's ambient flocks by day, at dusk and at
// midnight (screenshots), perching on the island's trees, a shot bird
// falling, a blast and fire, a Bird flock spawner in a box, and what they cost
// (CPU per frame, the probe pass and the bird draw on the GPU).
// usage: node tools/birds-shots.mjs [--port 5435] [--shots dir]   (needs a dev server; AC power)
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5435');
const shots = opt('shots', null);
const W = 960, H = 600;
const DUSK_EL = -2;          // degrees: dusk, birds glowing and still up
const TIMED = 40;            // draws per GPU timing
const PROBE_MS_MAX = 2;      // ms a probe pass may take (timed under other sessions' GPU load: ~1.4 at 99%)
const DRAW_MS_MAX = 0.5;     // ms the birds' draw may take
const FRAME_FROM = [2.2, 1.0, 2.6];   // scene units from a flock to the camera, for its close-up

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
// (a dev server has no multiplayer relay or account API: their refused connections aren't the birds')
p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 300)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const wait = (ms) => p.waitForTimeout(ms);
const shot = async (name) => {
  if (!shots) return;
  await p.addStyleTag({ content: 'body *{visibility:hidden} canvas[data-engine]{visibility:visible}' }).catch(() => {});
  await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 72 });
};

try {
  await p.goto(`http://localhost:${port}/?size=world`, { timeout: 120000 });
  await p.waitForFunction(() => window.__app?.win?.loaded && window.__app.birds?.count > 0, null, { timeout: 90000 });
  await wait(3000);
  const st = () => ev(() => {
    const a = window.__app, B = a.birds;
    const states = {};
    for (const f of B.flocks) for (const bd of f.birds) states[bd.state] = (states[bd.state] ?? 0) + 1;
    return { count: B.count, flocks: B.flocks.length, states, night: B.night, glow: +B.glow.toFixed(2), cost: +B.costMs.toFixed(3), motes: B.motes, perches: B.probe.perchCount };
  });
  let s = await st();
  console.log('     day:', JSON.stringify(s));
  check('a World has ambient flocks', s.flocks === 3 && s.count >= 3 * 7, `${s.flocks} flocks, ${s.count} birds`);
  check('the probe finds perches in the window (tree crowns, roofs)', s.perches > 0, `${s.perches} columns`);

  // clearance: no flying bird inside the ground the probe sees
  const clear = await ev(() => {
    const B = window.__app.birds, w = B.probe.world;
    let min = Infinity;
    for (const f of B.flocks) for (const bd of f.birds) if (bd.state === 0) min = Math.min(min, bd.v.position.y - w.ground(bd.v.position.x, bd.v.position.z));
    return min;
  });
  check('flying birds stay above the ground and water', clear > 0, `min clearance ${clear.toFixed(1)} cells`);

  // freeze the world and frame the flock nearest the window's middle
  const frame = (from) => ev((F) => {
    const a = window.__app, B = a.birds, V = a.camera.position.constructor;
    a.settings.paused = true;
    const o = a.sim.origin, mid = new V(o.x + a.sim.g.nx / 2, 0, o.z + a.sim.g.nz / 2);
    let best = null;
    for (const f of B.flocks) { f.updateCentre(); if (f.alive && (!best || Math.hypot(f.centre.x - mid.x, f.centre.z - mid.z) < Math.hypot(best.centre.x - mid.x, best.centre.z - mid.z))) best = f; }
    const c = best.centre, t = new V(c.x - o.x, c.y, c.z - o.z).multiplyScalar(a.scale).add(a.volume.position);
    a.controls.target.copy(t);
    a.camera.position.copy(t).add(new V(...F));
    a.camera.lookAt(t);
    a.controls.update();
    a.requestRender();
    return best.birds.length;
  }, from);
  const resume = () => ev(() => { window.__app.settings.paused = false; });

  await frame(FRAME_FROM); await wait(1200); await shot('birds-day');
  await resume();

  // ---- costs: CPU per frame (running average), the probe's GPU pass, the bird draw
  const cost = await ev(async ([N]) => {
    const a = window.__app, B = a.birds, r = a.renderer, T = a.THREE;
    const one = new Float32Array(4), px = new Uint8Array(4);
    const { mat, target } = B.probe.pass;
    mat.uniforms.tA.value = a.sim.stateA;
    a.sim.run(mat, target); r.readRenderTargetPixels(target, 0, 0, 1, 1, one);
    let t0 = performance.now();
    for (let i = 0; i < N; i++) { a.sim.run(mat, target); r.readRenderTargetPixels(target, 0, 0, 1, 1, one); }
    const probe = (performance.now() - t0) / N;
    // the empty-target baseline: a sync alone
    t0 = performance.now();
    for (let i = 0; i < N; i++) r.readRenderTargetPixels(target, 0, 0, 1, 1, one);
    const sync = (performance.now() - t0) / N;
    // the birds alone into a target the canvas's size: the InstancedMesh, its material, its instances
    const rt = new T.WebGLRenderTarget(r.domElement.width, r.domElement.height, { type: T.HalfFloatType });
    const solo = new T.Scene(), m = B.view.mesh, copy = new T.InstancedMesh(m.geometry, m.material, m.count);
    copy.instanceMatrix = m.instanceMatrix; copy.count = m.count; copy.frustumCulled = false;
    solo.add(copy);
    const draw = (sc) => { r.setRenderTarget(rt); r.clear(); r.render(sc, a.camera); r.readRenderTargetPixels(rt, 0, 0, 1, 1, px); };
    draw(solo);
    t0 = performance.now(); for (let i = 0; i < N; i++) draw(solo); const withBirds = (performance.now() - t0) / N;
    const empty = new T.Scene();
    t0 = performance.now(); for (let i = 0; i < N; i++) draw(empty); const none = (performance.now() - t0) / N;
    r.setRenderTarget(null);
    rt.dispose();
    return { cpu: B.costMs, probe: probe - sync, draw: withBirds - none, birds: m.count };
  }, [TIMED]);
  console.log(`     cost: CPU ${cost.cpu.toFixed(3)} ms/frame (running average, ${cost.birds} birds); GPU probe ${cost.probe.toFixed(3)} ms per pass (2 a second); bird draw ${cost.draw.toFixed(3)} ms`);
  check('CPU cost is negligible', cost.cpu < 0.5, `${cost.cpu.toFixed(3)} ms`);
  check('GPU cost is negligible (a probe pass twice a second, the birds one draw)', cost.probe < PROBE_MS_MAX && cost.draw < DRAW_MS_MAX);

  // ---- perching on the island's trees
  const landed = await ev(async () => {
    const a = window.__app, B = a.birds;
    const f = B.flocks.reduce((x, y) => (x.alive >= y.alive ? x : y));
    f.updateCentre();
    // look for perches near it: send it home over the window's middle first if it has none
    const o = a.sim.origin;
    f.home.set(o.x + a.sim.g.nx / 2, 0, o.z + a.sim.g.nz / 2);
    f.timer = 0;
    for (let t = 0; t < 30 && f.mode !== 'perch'; t += 0.25) await new Promise((res) => setTimeout(res, 250));
    // each perched bird stands on a perch the probe found (a top with open air under it), a tree's or not
    const on = { onPerch: 0, onTree: 0, off: 0 };
    for (const bd of f.birds) {
      if (bd.state !== 2) continue;
      const P = bd.v.position, spot = B.probe.world.perches(P.x, P.z, 1.5).find((q) => Math.abs(q.y - P.y) < 1);
      if (!spot) on.off++; else { on.onPerch++; if (spot.tree) on.onTree++; }
    }
    return { mode: f.mode, perched: f.birds.filter((bd) => bd.state === 2).length, of: f.birds.length, ...on, key: B.flocks.indexOf(f) };
  });
  console.log('     perch:', JSON.stringify(landed));
  check('a flock lands on perches in the window', landed.perched > 0 && !landed.off, `${landed.perched}/${landed.of}`);
  // a close-up of the perched flock
  await ev((k) => {
    const a = window.__app, f = a.birds.flocks[k], V = a.camera.position.constructor, o = a.sim.origin;
    a.settings.paused = true;
    const bd = f.birds.find((x) => x.state === 2);
    const t = new V(bd.v.position.x - o.x, bd.v.position.y, bd.v.position.z - o.z).multiplyScalar(a.scale).add(a.volume.position);
    a.controls.target.copy(t); a.camera.position.copy(t).add(new V(0.9, 0.45, 1.1)); a.camera.lookAt(t); a.controls.update(); a.requestRender();
  }, landed.key);
  await wait(1200); await shot('birds-perched'); await resume();

  // ---- fire under the perched flock: they catch alight and fall
  const burnt = await ev(async (k) => {
    const a = window.__app, f = a.birds.flocks[k], V = a.camera.position.constructor, o = a.sim.origin;
    const { E } = await import('/src/elements.js');
    const bd = f.birds.find((x) => x.state === 2);
    if (!bd) return null;
    a.sim.paint({ center: new V(bd.v.position.x - o.x, bd.v.position.y + 1, bd.v.position.z - o.z), radius: 8, shape: 0, tool: E.FIRE, rate: 1, replace: false });
    await new Promise((res) => setTimeout(res, 2500));
    return { burning: f.birds.filter((x) => x.state === 3).length, down: f.birds.filter((x) => x.state === 4 || x.state === 5).length, of: f.birds.length };
  }, landed.key);
  console.log('     fire:', JSON.stringify(burnt));
  check('fire on their perch sets birds alight and they fall', !!burnt && burnt.burning + burnt.down > 0);

  // ---- a shot bird falls (pov/targets.js, as the guns and the axe hit bodies)
  const shotBird = await ev(async () => {
    const a = window.__app, V = a.camera.position.constructor, o = a.sim.origin;
    const { rayTarget } = await import('/src/pov/targets.js');
    const f = a.birds.flocks.find((x) => x.birds.some((y) => y.state === 0));
    const bd = f.birds.find((y) => y.state === 0);
    const g = new V(bd.v.position.x - o.x, bd.v.position.y, bd.v.position.z - o.z);
    const from = g.clone().add(new V(-20, 0, 0));
    const hit = rayTarget(from, new V(1, 0, 0), 40);
    if (!hit) return { hit: false };
    hit.target.hurt(1, 'Shot', new V(1, 0, 0));
    const y0 = bd.v.position.y;
    for (let t = 0; t < 10 && bd.state !== 5; t += 0.1) await new Promise((res) => setTimeout(res, 100));
    return { hit: hit.target.id === `bird:${bd.id}`, state: bd.state, fell: y0 - bd.v.position.y, ground: a.birds.probe.world.ground(bd.v.position.x, bd.v.position.z) - bd.v.position.y };
  });
  console.log('     shot:', JSON.stringify(shotBird));
  check('a round through a bird hits it, and it falls dead to the ground', shotBird.hit && shotBird.state === 5 && Math.abs(shotBird.ground) < 1);

  // ---- a blast: the flock nearby takes off, the birds next to it die
  const blast = await ev(async () => {
    const a = window.__app, V = a.camera.position.constructor, o = a.sim.origin;
    const { povEvents } = await import('/src/pov/events.js');
    const flying = (x) => x.birds.filter((y) => y.state === 0).length;
    const f = a.birds.flocks.reduce((x, y) => (flying(x) >= flying(y) ? x : y));
    f.updateCentre();
    const before = f.birds.filter((y) => y.state <= 2).length, deadBefore = f.birds.filter((y) => y.state >= 4).length;
    povEvents.emit('blast', { point: new V(f.centre.x - o.x, f.centre.y, f.centre.z - o.z) });
    const dead = f.birds.filter((y) => y.state >= 4).length - deadBefore;
    return { before, dead, alive: f.alive, fleeing: f.fleeT > 0, perched: f.birds.filter((y) => y.state === 2).length };
  });
  console.log('     blast:', JSON.stringify(blast));
  check('a blast kills the birds next to it and flushes the rest', blast.dead > 0 && blast.perched === 0 && (blast.alive === 0 || blast.fleeing));

  // ---- dusk: glowing flight with motes
  await ev(async ([el]) => {
    const a = window.__app, { phaseSteps, DAY } = await import('/src/gfx/daylight.js');
    const lat = DAY.latitude * Math.PI / 180, c = Math.sin(el * Math.PI / 180) / Math.cos(lat);
    a.day.clock = phaseSteps(0.5 + Math.acos(c) / (2 * Math.PI));   // the evening side
  }, [DUSK_EL]);
  await wait(2500);
  s = await st();
  console.log('     dusk:', JSON.stringify(s));
  check('at dusk they glow and leave motes', s.glow > 0.5 && s.motes > 0, `glow ${s.glow}, ${s.motes} motes`);
  await frame([1.6, 0.6, 2.0]); await wait(1200); await shot('birds-dusk'); await resume();

  // ---- midnight: they roost; a gunshot puts them up, glowing
  await ev(async () => { const a = window.__app, { phaseSteps } = await import('/src/gfx/daylight.js'); a.day.clock = phaseSteps(0); });
  await wait(1000);
  await ev(() => { for (const f of window.__app.birds.flocks) f.timer = Math.min(f.timer, 1); });   // (don't wait out their flight)
  await wait(14000);
  s = await st();
  console.log('     midnight:', JSON.stringify(s));
  check('at night the flocks roost', s.night && (s.states[2] ?? 0) >= s.count * 0.5, `${s.states[2] ?? 0}/${s.count} perched`);
  await ev(async () => {
    const a = window.__app, B = a.birds, V = a.camera.position.constructor, o = a.sim.origin;
    a.settings.paused = true;
    const f = B.flocks.find((x) => x.birds.some((y) => y.state === 2));
    const bd = f.birds.find((y) => y.state === 2);
    const t = new V(bd.v.position.x - o.x, bd.v.position.y, bd.v.position.z - o.z).multiplyScalar(a.scale).add(a.volume.position);
    a.controls.target.copy(t); a.camera.position.copy(t).add(new V(1.1, 0.9, 1.3)); a.camera.lookAt(t); a.controls.update(); a.requestRender();
  });
  await wait(1200); await shot('birds-night-roost'); await resume();
  await ev(async () => {
    const a = window.__app, V = a.camera.position.constructor, o = a.sim.origin;
    const { povEvents } = await import('/src/pov/events.js');
    const f = a.birds.flocks.find((x) => x.birds.some((y) => y.state === 2));
    f.updateCentre();
    povEvents.emit('gun:fire', { origin: new V(f.centre.x - o.x + 30, f.centre.y, f.centre.z - o.z), dir: new V(1, 0, 0) });
  });
  await wait(1500);
  s = await st();
  check('a gunshot at night puts the roost up', (s.states[0] ?? 0) > 0 && s.motes > 0, JSON.stringify(s.states));
  await frame([1.6, 0.7, 2.0]); await wait(1200); await shot('birds-night-flight'); await resume();

  // ---- a Bird flock spawner in a box
  await ev(() => { const a = window.__app; a.day.clock = 0; a.setSize('128'); });
  await p.waitForFunction(() => !window.__app.win && window.__app.sim.g.nx === 128, null, { timeout: 30000 });
  await ev(() => window.__app.loadPreset('lab'));
  await wait(1500);
  const box = await ev(async () => {
    const a = window.__app, V = a.camera.position.constructor;
    const before = a.birds.count;
    a.spawners.add('birds', new V(64, 20, 64));
    await new Promise((res) => setTimeout(res, 6000));
    const f = a.birds.flocks[0];
    const inside = f ? f.birds.every((y) => y.v.position.x > -8 && y.v.position.z > -8 && y.v.position.x < 136 && y.v.position.z < 136) : false;
    return { before, after: a.birds.count, flocks: a.birds.flocks.length, inside };
  });
  console.log('     box:', JSON.stringify(box));
  check('no ambient birds in a box; a Bird flock spawner keeps a flock over it', box.before === 0 && box.flocks === 1 && box.after > 0 && box.inside);
  await ev(() => { const a = window.__app; a.settings.paused = true; a.requestRender(); });
  await wait(800); await shot('birds-box');

  check('no console errors', errs.length === 0, errs.slice(0, 5).join(' | '));
} catch (e) {
  fails++;
  console.log('FAIL', e.message.split('\n')[0]);
  if (errs.length) console.log(errs.slice(0, 5).join('\n'));
} finally {
  await b.close();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall birds GPU checks passed');
process.exit(fails ? 1 : 0);
