// Headless GPU check for the gun's ballistic rounds (src/pov/ballistics.js,
// src/shaders/povTrace.js). Builds test worlds with sim.load, drives the gun's
// update(ctx) with a hand-built ctx (the app's own stepping paused, the sim
// stepped by hand 4 steps per frame), and prints what each shot did: the
// impact event, the census change, recoil and the events seen.
// usage: node tools/gp-gun.mjs [--port 5201] [--only glass,metal,keg,pool,open,floor,away,recoil,dry,pause | e2e] [--shot out.png]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5201');
const only = opt('only', 'glass,metal,keg,pool,open,floor,away,recoil,dry,pause').split(',');
const shot = opt('shot');

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 960, height: 600 } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 2000)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 2000)));
await p.goto(`http://localhost:${port}/?preset=empty&size=128`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 30000 });
await p.waitForTimeout(1500);

// End to end through the real shell, body and toolbelt: drop in, face a glass
// pane 60 cells down range, click, and time the round.
async function e2e() {
  const ev = (fn, arg) => p.evaluate(fn, arg);
  await ev(async () => {
    const { povEvents } = await import('/src/pov/events.js');
    window.GP = { log: [] };
    for (const n of ['gun:fire', 'gun:dry', 'round:move', 'round:end', 'impact'])
      povEvents.on(n, (e) => GP.log.push({ n, t: performance.now(), e: JSON.parse(JSON.stringify(e)) }));
  });
  await p.mouse.move(480, 300);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 10000 }).catch(() => {});
  await ev(() => { window.__app.pov.test.assumeLocked = true; });
  await ev(async () => {
    const { E } = await import('/src/elements.js');
    const a = window.__app;
    const V = a.camera.position.constructor;
    for (let y = 1; y < 14; y += 2) a.sim.paint({ center: new V(96.5, y, 64.5), radius: 4, shape: 1, tool: E.GLASS, rate: 1, replace: false });
    a.pov.player.spawn(new V(36, 0, 64.5));
    a.pov.setLook(-Math.PI / 2, 0);
  });
  await p.waitForTimeout(1200);
  await ev(() => window.__app.pov.toolbelt.select('GUN'));
  await p.waitForTimeout(300);
  const c0 = await ev(() => Object.fromEntries(Object.entries(window.__app.sim.census()).map(([k, v]) => [k, v.n])));
  await ev(() => { GP.log.length = 0; });
  await p.mouse.down(); await p.waitForTimeout(60); await p.mouse.up();
  await p.waitForTimeout(3000);
  const evs = await ev(() => GP.log);
  const c1 = await ev(() => Object.fromEntries(Object.entries(window.__app.sim.census()).map(([k, v]) => [k, v.n])));
  const lat = await ev(() => window.__app.pov.toolbelt.tool('GUN')?.ballistics?.latency);
  const t0 = evs.find((x) => x.n === 'gun:fire')?.t;
  const imp = evs.find((x) => x.n === 'impact');
  return {
    events: evs.map((x) => `${x.n}@${(x.t - t0).toFixed(0)}ms`).join(' '),
    frameMs: await ev(() => new Promise((r) => { const t = performance.now(); let n = 0; const f = () => (++n < 10 ? requestAnimationFrame(f) : r((performance.now() - t) / n)); requestAnimationFrame(f); })),
    impact: imp?.e, msToImpact: imp ? +(imp.t - t0).toFixed(0) : null, latencyFrames: lat && +lat.toFixed(2),
    census: Object.fromEntries(Object.keys({ ...c0, ...c1 }).filter((k) => k !== '0' && (c1[k] ?? 0) !== (c0[k] ?? 0)).map((k) => [k, (c1[k] ?? 0) - (c0[k] ?? 0)])),
  };
}

const results = only.includes('e2e') ? { e2e: await e2e() } : await p.evaluate(async (only) => {
  const a = window.__app;
  a.settings.paused = true;
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { E, ELEMENTS } = await import('/src/elements.js');
  const { povEvents } = await import('/src/pov/events.js');
  const gun = (await import('/src/pov/tools/gun.tool.js')).default;
  const B = await import('/src/pov/ballistics.js');

  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const settle = async () => { for (let i = 0; i < 3; i++) await raf(); };   // the app rebuilds the bricks
  const world = async (fill, floor = true) => {
    const sim = a.sim, g = sim.g;
    const [A, Bs] = sim.blankState();
    const set = (x, y, z, id) => {
      const i = sim.cellTexel(x, y, z) * 4;
      A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life;
    };
    if (floor) for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) set(x, 0, z, E.WALL);
    fill(set, g);
    sim.load(A, Bs);
    await settle();
  };
  const count = () => Object.fromEntries(Object.entries(a.sim.census()).map(([k, v]) => [ELEMENTS[k]?.key ?? k, v.n]));
  const delta = (c0, c1) => {
    const out = {};
    for (const k of new Set([...Object.keys(c0), ...Object.keys(c1)])) {
      const d = (c1[k] ?? 0) - (c0[k] ?? 0);
      if (d && k !== 'EMPTY') out[k] = d;
    }
    return out;
  };
  const total = (c) => Object.entries(c).filter(([k]) => k !== 'EMPTY').reduce((s, [, n]) => s + n, 0);

  const viewmodel = new THREE.Group(); a.camera.add(viewmodel); a.scene.add(a.camera);
  const toasts = [];
  const env = {
    renderer: a.renderer, scene: a.scene,
    getSim: () => a.sim, getVolume: () => a.volume, getScale: () => a.scale,
    hud: { toast(t) { toasts.push(t); } }, viewmodel, isActive: () => true,
  };
  const tool = gun.create(env);
  const impulses = [];
  const player = { pos: new THREE.Vector3(20.5, 1, 40.5), vel: new THREE.Vector3(), onGround: true, inLiquid: false,
    applyImpulse: (dv) => impulses.push(dv.clone()) };
  const eye = new THREE.Vector3(20.5, 6.5, 40.5);
  const ctx = (over = {}) => ({ sim: a.sim, dt: 1 / 60, stepsPerFrame: 4, eye, dir: new THREE.Vector3(1, 0, 0),
    primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0,
    aim: { valid: false }, player, ...over });

  const log = [];
  for (const name of ['gun:fire', 'gun:dry', 'round:move', 'round:end', 'impact'])
    povEvents.on(name, (e) => log.push({ name, e, t: performance.now() }));
  const r3 = (v) => v && [v.x, v.y, v.z].map((x) => +x.toFixed(2));
  const summarize = (evs) => {
    const moves = evs.filter((x) => x.name === 'round:move');
    const imp = evs.find((x) => x.name === 'impact')?.e;
    const fire = evs.find((x) => x.name === 'gun:fire')?.e;
    return {
      names: [...new Set(evs.map((x) => x.name))],
      moves: moves.length,
      firstMove: moves[0] && [r3(moves[0].e.from), r3(moves[0].e.to)],
      lastMove: moves.at(-1) && [r3(moves.at(-1).e.from), r3(moves.at(-1).e.to)],
      fire: fire && { origin: r3(fire.origin), dir: r3(fire.dir), muzzleWorld: r3(fire.muzzleWorld) },
      impact: imp && { source: imp.source, point: r3(imp.point), normal: r3(imp.normal), id: ELEMENTS[imp.id]?.key ?? imp.id,
        energy: +imp.energy.toFixed(2), broke: imp.broke },
      ends: evs.filter((x) => x.name === 'round:end').length,
      dry: evs.filter((x) => x.name === 'gun:dry').length,
    };
  };

  let clock = 1;   // keeps the tool's fire interval satisfied between shots
  // fire once, then run frames (4 sim steps each) until the round is gone, plus `after` frames
  async function shoot(over = {}, after = 0) {
    tool.update(ctx({ dt: 0.5 }));   // the fire interval passes
    const from = log.length;
    const c0 = count();
    tool.update(ctx({ ...over, primaryPressed: true, primary: true }));
    let frames = 0;
    const t0 = performance.now();
    while (tool.ballistics.count && frames < 120) { for (let i = 0; i < 4; i++) a.sim.step(); await raf(); tool.update(ctx(over)); frames++; }
    const flightMs = performance.now() - t0;
    for (let f = 0; f < after; f++) { for (let i = 0; i < 4; i++) a.sim.step(); if (f % 8 === 0) await raf(); }
    const c1 = count();
    return { frames, flightMs: +flightMs.toFixed(0), ...summarize(log.slice(from)), census: delta(c0, c1), conserved: total(c1) - total(c0) };
  }

  const out = { constants: { ROUND_SPEED: B.ROUND_SPEED, ROUND_GRAVITY: +B.ROUND_GRAVITY.toFixed(2), ROUND_ENERGY: B.ROUND_ENERGY, MAX_ROUNDS: B.MAX_ROUNDS } };
  const pane = (id, x0, thick = 2) => (set) => {
    for (let x = x0; x < x0 + thick; x++) for (let y = 1; y < 16; y++) for (let z = 30; z < 52; z++) set(x, y, z, id);
  };

  if (only.includes('glass')) {
    await world(pane(E.GLASS, 81));   // 60 cells ahead of the eye (x 20.5)
    out.glass = await shoot({}, 60);
  }
  if (only.includes('metal')) {
    await world(pane(E.METAL, 81));
    out.metal = await shoot({}, 60);
  }
  if (only.includes('keg')) {
    // a wooden keg of gunpowder, its face 45 cells out
    await world((set) => {
      for (let x = 66; x < 76; x++) for (let y = 1; y < 12; y++) for (let z = 36; z < 46; z++) {
        const shell = x === 66 || x === 75 || y === 1 || y === 11 || z === 36 || z === 45;
        set(x, y, z, shell ? E.WOOD : E.GUNPOWDER);
      }
    });
    const r = await shoot({}, 0);
    const before = count();
    for (let f = 0; f < 120; f++) { for (let i = 0; i < 4; i++) a.sim.step(); if (f % 8 === 0) await raf(); }
    const after = count();
    out.keg = { ...r, gunpowderBefore: before.GUNPOWDER ?? 0, gunpowderAfter: after.GUNPOWDER ?? 0, flames: after.FIRE ?? 0 };
  }
  if (only.includes('pool')) {
    // a WALL basin of water, surface at y 13, fired into from a raised eye
    await world((set) => {
      for (let x = 30; x < 90; x++) for (let y = 1; y < 14; y++) for (let z = 30; z < 52; z++) set(x, y, z, E.WATER);
      for (let x = 29; x < 91; x++) for (let y = 1; y < 15; y++) for (const z of [29, 52]) set(x, y, z, E.WALL);
      for (const x of [29, 90]) for (let y = 1; y < 15; y++) for (let z = 29; z < 53; z++) set(x, y, z, E.WALL);
    });
    eye.set(20.5, 22.5, 40.5); player.pos.set(20.5, 17.5, 40.5);
    const dir = new THREE.Vector3(1, -0.25, 0).normalize();
    out.pool = await shoot({ dir }, 0);
    const track = [];
    for (let f = 0; f <= 10; f++) {
      const c = tool.ballistics.lastImpact;
      if (f === 0) out.pool.handoff = c && { prev: r3(c.prev), cell: r3(c.cell), vel: r3(c.vel) };
      // where the slug is: read the SCRAP cells
      const sim = a.sim;
      const [A, Bv] = sim.readState();
      for (let i = 0; i < A.length; i += 4) if (Math.round(A[i]) === E.SCRAP) {
        const c = sim.texelCell(i / 4);
        if (!c) continue;   // a padding texel
        const [x, y, z] = c;
        track.push({ step: f * 4, x, y, z, v: [Bv[i], Bv[i + 1], Bv[i + 2]].map((q) => +q.toFixed(2)) });
      }
      for (let i = 0; i < 4; i++) a.sim.step();
    }
    out.pool.slug = track;
    eye.set(20.5, 6.5, 40.5); player.pos.set(20.5, 1, 40.5);
  }
  if (only.includes('open')) {
    await world(() => {});
    out.open = await shoot({}, 0);
  }
  if (only.includes('floor')) {
    // the box's own floor (no WALL layer): below y = 0, which the engine treats as WALL
    await world(() => {}, false);
    out.floor = await shoot({ dir: new THREE.Vector3(1, -0.3, 0.2).normalize() }, 20);
  }
  if (only.includes('away')) {
    // fire, then put the gun away at once: the round still lands
    await world(pane(E.GLASS, 81));
    tool.update(ctx({ dt: 0.5 }));
    const c0 = count();
    tool.update(ctx({ primaryPressed: true, primary: true }));
    tool.deselect();
    let frames = 0;
    while (tool.ballistics.count && frames < 120) { for (let i = 0; i < 4; i++) a.sim.step(); await raf(); frames++; }
    for (let f = 0; f < 15; f++) for (let i = 0; i < 4; i++) a.sim.step();
    out.away = { frames, inFlight: tool.ballistics.count, census: delta(c0, count()) };
  }
  if (only.includes('recoil')) {
    await world(() => {});
    const res = {};
    const kick = async (label, dir, onGround) => {
      player.onGround = onGround;
      const n = impulses.length;
      await shoot({ dir: dir.normalize() }, 0);
      res[label] = impulses.slice(n).map((v) => r3(v));
    };
    await kick('groundLevel', new THREE.Vector3(1, 0, 0), true);
    await kick('groundFeet', new THREE.Vector3(0.3, -1, 0), true);
    await kick('airLevel', new THREE.Vector3(1, 0, 0), false);
    player.onGround = true;
    out.recoil = res;
  }
  if (only.includes('dry')) {
    await world((set) => { for (let x = 0; x < 40; x++) for (let y = 1; y < 12; y++) for (let z = 30; z < 50; z++) set(x, y, z, E.WATER); });
    // the pick under the crosshair is the water at the eye
    const aim = { valid: true, cell: new THREE.Vector3(20, 6, 40), face: 0, id: E.WATER, dist: 0 };
    toasts.length = 0;
    const r = await shoot({ aim }, 0);
    out.dry = { dry: r.dry, names: r.names, toasts: [...toasts], census: r.census };
  }
  if (only.includes('pause')) {
    await world(pane(E.GLASS, 81));
    tool.update(ctx({ dt: 0.5 }));
    tool.update(ctx({ primaryPressed: true, primary: true, stepsPerFrame: 0 }));
    const r0 = tool.ballistics.rounds[0];
    const t0 = r0?.t;
    for (let f = 0; f < 20; f++) { await raf(); tool.update(ctx({ stepsPerFrame: 0 })); }
    out.pause = { inFlight: tool.ballistics.count, flightTime: r0?.t, flightTimeAtFire: t0 };
    let frames = 0;
    while (tool.ballistics.count && frames < 120) { for (let i = 0; i < 4; i++) a.sim.step(); await raf(); tool.update(ctx()); frames++; }
    out.pause.framesAfterUnpause = frames;
  }
  tool.deselect(); tool.dispose();
  return out;
}, only);

console.log(JSON.stringify(results, null, 1));
if (shot) {
  await p.screenshot({ path: shot, scale: 'css' });
  console.log('screenshot', shot);
}
if (errs.length) console.log('ERRORS\n' + errs.join('\n'));
await b.close();
