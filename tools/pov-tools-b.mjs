// Headless GPU check for the POV axe, gun and physgun (src/pov/tools/).
// Builds small test worlds with sim.load, drives each tool's update(ctx) with
// a hand-built ctx and steps the sim by hand (the app's own stepping paused),
// and prints the numbers: slug path and recoil, axe census, physgun hold.
// usage: node tools/pov-tools-b.mjs [--port 5195] [--only gun,axe,phys] [--shot out.png]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5195');
const only = opt('only', 'gun,axe,phys').split(',');
const shot = opt('shot');

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 960, height: 600 } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 2000)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 2000)));
await p.goto(`http://localhost:${port}/?preset=empty&size=128`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 30000 });
await p.waitForTimeout(1500);

// Shared page helpers.
await p.evaluate(() => {
  const a = window.__app;
  a.settings.paused = true;
  window.T = {};
  T.world = (fill) => {
    const sim = a.sim, g = sim.g;
    const [A, B] = sim.blankState();
    const set = (x, y, z, id, temp = 20, life = 0) => {
      const i = ((Math.floor(y / g.tx) * g.nz + z) * g.width + (y % g.tx) * g.nx + x) * 4;
      A[i] = id; A[i + 1] = temp; A[i + 2] = life;
    };
    fill(set, g);
    sim.load(A, B);
  };
  T.read = () => {
    const sim = a.sim, g = sim.g;
    const n = g.width * g.height * 4;
    const A = new Float32Array(n), B = new Float32Array(n);
    const t = sim.targets[sim.cur];
    a.renderer.readRenderTargetPixels(t, 0, 0, g.width, g.height, A, undefined, 0);
    a.renderer.readRenderTargetPixels(t, 0, 0, g.width, g.height, B, undefined, 1);
    const cells = (id) => {
      const out = [];
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = ((Math.floor(y / g.tx) * g.nz + z) * g.width + (y % g.tx) * g.nx + x) * 4;
        if (Math.round(A[i]) === id) out.push({ x, y, z, T: A[i + 1], life: A[i + 2], v: [B[i], B[i + 1], B[i + 2]] });
      }
      return out;
    };
    return { cells };
  };
  T.steps = (n) => { for (let i = 0; i < n; i++) a.sim.step(); };
  T.count = () => Object.fromEntries(Object.entries(a.sim.census()).map(([k, v]) => [k, v.n]));
  T.env = async (THREEmod) => ({
    renderer: a.renderer, scene: a.scene,
    getSim: () => a.sim, getVolume: () => a.volume, getScale: () => a.scale,
    hud: { toast(t) { (T.toasts ??= []).push(t); } },
    viewmodel: (() => { const v = new THREEmod.Group(); a.camera.add(v); a.scene.add(a.camera); return v; })(),
    isActive: () => true,
  });
});

const results = {};

if (only.includes('gun')) {
  results.gun = await p.evaluate(async () => {
    const a = window.__app;
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { E } = await import('/src/elements.js');
    const gun = (await import('/src/pov/tools/gun.tool.js')).default;
    const env = await T.env(THREE);
    const tool = gun.create(env);
    const impulses = [];
    const player = { pos: new THREE.Vector3(20.5, 1, 40.5), vel: new THREE.Vector3(), onGround: true, inLiquid: false,
      applyImpulse: (dv) => impulses.push(dv.clone()) };
    const eye = new THREE.Vector3(20.5, 6.5, 40.5);
    const ctx = (over) => ({ sim: a.sim, dt: 1 / 60, stepsPerFrame: 4, eye, dir: new THREE.Vector3(1, 0, 0),
      primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0,
      aim: { valid: false }, player, ...over });
    const wait = () => new Promise((r) => setTimeout(r, 50));
    const out = {};

    // 1) open air: track the slug
    T.world((set, g) => { for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) set(x, 0, z, E.WALL); });
    const c0 = T.count();
    tool.update(ctx({ primaryPressed: true, primary: true }));
    await wait(); tool.update(ctx({}));
    out.shot = tool.lastShot && { cell: tool.lastShot.cell.toArray(), vel: tool.lastShot.vel.toArray().map((v) => +v.toFixed(3)) };
    out.recoil = impulses.map((v) => v.toArray().map((x) => +x.toFixed(2)));
    const track = [];
    let s = 0;
    for (const at of [0, 5, 10, 20, 30, 40]) {
      T.steps(at - s); s = at;
      const sl = T.read().cells(E.SCRAP)[0];
      track.push(sl ? { step: at, x: sl.x, y: sl.y, vx: +sl.v[0].toFixed(3), vy: +sl.v[1].toFixed(3), T: sl.T } : { step: at, gone: true });
    }
    out.air = track;
    out.scrapCount = T.count()[E.SCRAP];
    out.emptyDelta = (T.count()[E.EMPTY] ?? 0) - (c0[E.EMPTY] ?? 0);

    // 2) into a water pool starting 9 cells ahead
    T.world((set, g) => {
      for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) set(x, 0, z, E.WALL);
      for (let x = 30; x < 90; x++) for (let y = 1; y < 14; y++) for (let z = 30; z < 52; z++) set(x, y, z, E.WATER);
      for (let x = 29; x < 91; x++) for (let y = 1; y < 15; y++) for (const z of [29, 52]) set(x, y, z, E.WALL);
      for (const x of [29, 90]) for (let y = 1; y < 15; y++) for (let z = 29; z < 53; z++) set(x, y, z, E.WALL);
    });
    // fire over the basin's rim (y 14) from a raised eye
    eye.set(20.5, 17.5, 40.5); player.pos.set(20.5, 12, 40.5);
    tool.update(ctx({ dt: 0.4 }));   // let the fire interval pass
    tool.update(ctx({ primaryPressed: true, primary: true, dir: new THREE.Vector3(1, -0.15, 0).normalize() }));
    await wait(); tool.update(ctx({}));
    const wtrack = [];
    s = 0;
    for (const at of [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 60]) {
      T.steps(at - s); s = at;
      const sl = T.read().cells(E.SCRAP)[0];
      wtrack.push(sl ? { step: at, x: sl.x, y: sl.y, vx: +sl.v[0].toFixed(3), vy: +sl.v[1].toFixed(3) } : { step: at, gone: true });
    }
    out.water = wtrack;

    // 3) blocked muzzle: standing in water
    T.world((set, g) => { for (let x = 0; x < 40; x++) for (let y = 0; y < 12; y++) for (let z = 30; z < 50; z++) set(x, y, z, E.WATER); });
    eye.set(20.5, 6.5, 40.5); player.pos.set(20.5, 1, 40.5);
    const before = impulses.length; T.toasts = [];
    tool.update(ctx({ dt: 0.4 }));
    tool.update(ctx({ primaryPressed: true, primary: true }));
    await wait(); tool.update(ctx({}));
    out.blocked = { impulses: impulses.length - before, toasts: T.toasts, scrap: T.count()[E.SCRAP] ?? 0 };
    tool.deselect(); tool.dispose();
    return out;
  });
}

if (only.includes('axe')) {
  results.axe = await p.evaluate(async () => {
    const a = window.__app;
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { E, ELEMENTS } = await import('/src/elements.js');
    const axe = (await import('/src/pov/tools/axe.tool.js')).default;
    const env = await T.env(THREE);
    const tool = axe.create(env);
    const mats = ['WOOD', 'GLASS', 'ICE', 'PLANT', 'ROCK', 'METAL'];
    // a 9×9×3 slab of each, facing −x, at z = 10, 30, ...
    T.world((set) => mats.forEach((m, i) => {
      const zc = 10 + 20 * i;
      for (let x = 30; x < 33; x++) for (let y = 2; y < 11; y++) for (let z = zc - 4; z <= zc + 4; z++)
        set(x, y, z, E[m], ELEMENTS[E[m]].temp, ELEMENTS[E[m]].life);
    }));
    const c0 = T.count();
    const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), applyImpulse() {} };
    const res = {};
    for (const [i, m] of mats.entries()) {
      const zc = 10 + 20 * i;
      const eye = new THREE.Vector3(26.5, 6.5, zc + 0.5);
      const ctx = (over) => ({ sim: a.sim, dt: 1 / 60, stepsPerFrame: 4, eye, dir: new THREE.Vector3(1, 0, 0),
        primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0,
        aim: { valid: true, cell: new THREE.Vector3(30, 6, zc), face: 0, id: E[m], dist: 3.5 }, player, ...over });
      const before = T.count();
      tool.update(ctx({ primaryPressed: true, primary: true }));
      for (let f = 0; f < 40; f++) tool.update(ctx({}));
      const after = T.count();
      const into = ELEMENTS[E[m]].breakInto;
      res[m] = { broken: (before[E[m]] ?? 0) - (after[E[m]] ?? 0), debris: into ? (after[E[into]] ?? 0) - (before[E[into]] ?? 0) : 0, into };
    }
    // chip velocity and kept temperature (ice → snow at −20 °C)
    const snow = T.read().cells(E.SNOW);
    res.snowT = snow.length ? +(snow.reduce((s, c) => s + c.T, 0) / snow.length).toFixed(1) : null;
    res.snowVx = snow.length ? +(Math.max(...snow.map((c) => c.v[0]))).toFixed(3) : null;
    const c1 = T.count();
    res.totalBefore = Object.values(c0).reduce((s, n) => s + n, 0);
    res.totalAfter = Object.values(c1).reduce((s, n) => s + n, 0);
    tool.deselect(); tool.dispose();
    return res;
  });
}

if (only.includes('phys')) {
  results.phys = await p.evaluate(async () => {
    const a = window.__app;
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { E } = await import('/src/elements.js');
    const phys = (await import('/src/pov/tools/physgun.tool.js')).default;
    const env = await T.env(THREE);
    const out = {};
    for (const mat of ['SAND', 'WATER']) {
      const tool = phys.create(env);
      const id = E[mat];
      T.world((set, g) => {
        for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) set(x, 0, z, E.WALL);
        // a basin of WALL (for water) holding a 10×5×10 block
        for (let x = 39; x <= 50; x++) for (let z = 59; z <= 70; z++) for (let y = 1; y <= 6; y++)
          if (x === 39 || x === 50 || z === 59 || z === 70) set(x, y, z, E.WALL);
        for (let x = 40; x < 50; x++) for (let z = 60; z < 70; z++) for (let y = 1; y < 6; y++) set(x, y, z, id);
      });
      T.steps(60);   // settle
      const n0 = T.count()[id];
      const eye = new THREE.Vector3(30.5, 8.5, 65);
      const surface = new THREE.Vector3(45, 5.5, 65);
      const player = { pos: new THREE.Vector3(30.5, 3.5, 65), vel: new THREE.Vector3(), applyImpulse() {} };
      let dir = surface.clone().sub(eye).normalize();
      const ctx = (over) => ({ sim: a.sim, dt: 1 / 60, stepsPerFrame: 4, eye, dir,
        primary: true, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0,
        aim: { valid: true, cell: new THREE.Vector3(45, 5, 65), face: 2, id, dist: surface.distanceTo(eye) }, player, ...over });
      tool.update(ctx({ primaryPressed: true }));
      T.steps(4);
      // raise the aim over 1 s to a point 12 cells up, then hold 3 s
      const target = new THREE.Vector3(45, 18, 65);
      const frames = 60, holdFrames = 180;
      for (let f = 1; f <= frames + holdFrames; f++) {
        const k = Math.min(f / frames, 1);
        dir = surface.clone().lerp(target, k).sub(eye).normalize();
        tool.update(ctx({}));
        T.steps(4);
      }
      const hold = tool.hold;
      const cells = T.read().cells(id);
      const lifted = cells.filter((c) => c.y > 8);
      const cen = lifted.reduce((s, c) => s.add(new THREE.Vector3(c.x + 0.5, c.y + 0.5, c.z + 0.5)), new THREE.Vector3()).divideScalar(lifted.length || 1);
      const status = tool.status();
      // fling along the aim
      tool.update(ctx({ secondaryPressed: true, secondary: true }));
      const flungAt = cen.clone();
      T.steps(12);
      const after = T.read().cells(id).filter((c) => c.y > 4 && c.x > 46);
      const cen2 = after.reduce((s, c) => s.add(new THREE.Vector3(c.x + 0.5, c.y + 0.5, c.z + 0.5)), new THREE.Vector3()).divideScalar(after.length || 1);
      T.steps(200);
      const n1 = T.count()[id];
      out[mat] = {
        hold: hold?.toArray().map((v) => +v.toFixed(1)), status,
        lifted: lifted.length, centroid: cen.toArray().map((v) => +v.toFixed(1)),
        meanDistFromHold: +(lifted.reduce((s, c) => s + new THREE.Vector3(c.x + 0.5, c.y + 0.5, c.z + 0.5).distanceTo(hold), 0) / (lifted.length || 1)).toFixed(2),
        flungAhead: after.length, flungCentroid: cen2.toArray().map((v) => +v.toFixed(1)), flungFrom: flungAt.toArray().map((v) => +v.toFixed(1)),
        dirAtFling: dir.toArray().map((v) => +v.toFixed(2)),
        census: [n0, n1], stillHolding: tool.hold !== null,
      };
      tool.deselect(); tool.dispose();
    }
    return out;
  });
}

if (shot) {
  // one view of the held physgun ball and the viewmodel, downscaled by the caller
  await p.screenshot({ path: shot });
}
console.log(JSON.stringify(results, null, 1));
if (errs.length) console.log('ERRORS\n' + errs.join('\n'));
await b.close();
