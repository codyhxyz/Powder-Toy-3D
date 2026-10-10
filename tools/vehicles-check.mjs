// End-to-end check of the vehicles (src/pov/vehicles/) through the real shell
// and body: a test yard (a flat stone run into a rock ramp, a sand lane, a
// walled lake), a jeep and a hoverbike from spawnLayout, E to get in and out,
// driving with the keys, a ramp climb, sand vs stone coasting, a run-over with
// team damage off, a blast shove, the hoverbike skimming water and drifting,
// and the jeep blowing up into a burning wreck and coming back.
// usage: node tools/vehicles-check.mjs [--port 5402] [--shot prefix]   (needs a dev server; AC power)
//   --shot writes prefix-jeep.jpg, prefix-bike.jpg and prefix-wreck.jpg
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5402');
const shotPath = opt('shot', null);
const W = 960, H = 600;
const DRIFT_SLIP_MIN = 15 * Math.PI / 180;   // rad: a hard turn at speed slides at least this far off the nose

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const settle = (ms) => p.waitForTimeout(ms);
const hold = async (keys, ms) => { for (const k of keys) await p.keyboard.down(k); await settle(ms); for (const k of keys) await p.keyboard.up(k); };

try {
  await p.goto(`http://localhost:${port}/?size=128&preset=empty`);
  await p.waitForFunction(() => window.__app?.pov?.vehicles, null, { timeout: 30000 });
  await settle(1000);

  // ---- the test yard, written straight into the state (cells: x, y, z)
  await ev(async () => {
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { SEED_MAX } = await import('/src/shaders/common.js');
    const sim = window.__app.sim, g = sim.g;
    const [A, B] = sim.blankState();
    const set = (x, y, z, id) => {
      const i = sim.cellTexel(x, y, z) * 4, e = ELEMENTS[id];
      A[i] = id; A[i + 1] = e.temp; A[i + 2] = e.life; A[i + 3] = Math.random() * SEED_MAX;
    };
    const box = (x0, y0, z0, x1, y1, z1, id) => { for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) set(x, y, z, id); };
    // the ramp: x 40..88, rising 1 cell in 3 from z 64 to 100 (18°), then a plateau
    for (let z = 64; z < 124; z++) box(40, 0, z, 88, Math.min(12, Math.floor((z - 64) / 3) + 1), z + 1, E.ROCK);
    // the sand lane: x 4..36, 3 cells of sand on rock... on the floor
    box(4, 0, 4, 36, 3, 124, E.SAND);
    // the lake: a wall at x 91, water x 92..127, 6 cells deep
    box(91, 0, 0, 92, 9, g.nz, E.WALL);
    box(92, 0, 0, g.nx, 6, g.nz, E.WATER);
    sim.load(A, B);
  });
  await settle(500);

  // ---- drop in
  await p.mouse.move(W / 2, H / 2);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 20000 }).catch(() => {});
  await ev(() => { window.__app.pov.test.assumeLocked = true; });
  check('dropped in', (await ev(() => window.__app.pov.mode)) === 'on');

  const n = await ev(() => window.__app.pov.vehicles.spawnLayout({ vehicles: [
    { kind: 'jeep', team: 'red', at: [64, 0, 10], yaw: 0 },
    { kind: 'hoverbike', team: 'blue', at: [110, 6, 12], yaw: 0 },
  ] }));
  check('spawnLayout takes the list', n === 2);
  await p.waitForFunction(() => window.__app.pov.vehicles.ready && window.__app.pov.vehicles.list.length === 2, null, { timeout: 20000 }).catch(() => {});
  check('Rapier loaded, both vehicles spawned', (await ev(() => window.__app.pov.vehicles.list.length)) === 2);
  await settle(2500);   // settle on their springs

  const V = () => ev(() => window.__app.pov.vehicles.list.map((v) => {
    const t = v.impl.body.translation(), l = v.impl.body.linvel(), r = v.impl.body.rotation();
    const fx = 2 * (r.x * r.z + r.w * r.y), fz = 1 - 2 * (r.x * r.x + r.y * r.y);   // the nose (+z turned)
    return { clock: window.__app.pov.vehicles.physics.clock, kind: v.kind, alive: v.alive, health: v.health, x: t.x, y: t.y, z: t.z, vx: l.x, vy: l.y, vz: l.z, speed: Math.hypot(l.x, l.y, l.z), fx, fz, state: { ...v.impl.state, surface: undefined } };
  }));
  const jeep = async () => (await V()).find((v) => v.kind === 'jeep');
  const bike = async () => (await V()).find((v) => v.kind === 'hoverbike');
  const stand = (x, y, z) => ev(([x, y, z]) => { const a = window.__app; a.pov.player.spawn(a.pov.player.pos.clone().set(x, y, z)); }, [x, y, z]);
  // put a vehicle somewhere (metres), facing +z, at a speed along +z
  const place = (kind, x, y, z, vz = 0) => ev(([kind, x, y, z, vz]) => {
    const v = window.__app.pov.vehicles.list.find((v) => v.kind === kind && v.alive);
    const b = v.impl.body;
    b.setTranslation({ x, y, z }, true); b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    b.setLinvel({ x: 0, y: 0, z: vz }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }, [kind, x, y, z, vz]);

  let j = await jeep();
  check('the jeep rests on its springs on the floor', j && j.y > 0.6 && j.y < 1.4 && Math.abs(j.vy) < 0.3, `y ${j?.y.toFixed(2)} m`);
  let hb = await bike();
  check('the hoverbike hovers over the lake', hb && hb.y > 1.8 + 0.4 && hb.state.overLiquid, `y ${hb?.y.toFixed(2)} m (water top 1.8 m), over liquid ${hb?.state.overLiquid}`);

  // ---- E: in and out
  await stand(64 + 6, 0, 10);
  await settle(400);
  await p.keyboard.press('KeyE');
  await settle(200);
  check('E gets in the jeep', (await ev(() => window.__app.pov.vehicles.seated?.kind)) === 'jeep');
  await p.keyboard.press('KeyE');
  await settle(300);
  const out = await ev(() => { const a = window.__app.pov; return { seated: !!a.vehicles.seated, pos: a.player.pos.toArray() }; });
  j = await jeep();
  const outside = Math.abs(out.pos[0] - j.x / 0.3) > 3.5 || Math.abs(out.pos[2] - j.z / 0.3) > 7.5;
  check('E gets out, beside it', !out.seated && outside, `feet ${out.pos.map((v) => v.toFixed(1))} vs jeep ${(j.x / 0.3).toFixed(1)}, ${(j.z / 0.3).toFixed(1)}`);

  // ---- drive on the flat
  await p.keyboard.press('KeyE');
  await settle(200);
  const j0 = await jeep();
  await hold(['KeyW'], 2500);
  const j1 = await jeep();
  const fps = await ev(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
  const tW = j1.clock - j0.clock;   // simulated seconds (a slow headless frame rate slows the physics, not its rates)
  check('W drives it forward on the flat', (j1.z - j0.z) / tW > 3 && j1.speed > 2.5 * tW, `${(j1.z - j0.z).toFixed(1)} m in ${tW.toFixed(2)} s simulated (2.5 s real, ${fps} fps), ${j1.speed.toFixed(1)} m/s`);
  if (shotPath) await p.screenshot({ path: `${shotPath}-jeep.jpg`, type: 'jpeg', quality: 60 });
  // steering: D turns it right (its right is −x while it faces +z)
  await hold(['KeyW', 'KeyD'], 800);
  const j2 = await jeep();
  check('D steers right', j2.fx < -0.15, `nose x ${j2.fx.toFixed(2)}`);
  await hold(['KeyS'], 1500);

  // ---- the ramp: from the flat run up 3.6 m of rock
  await place('jeep', 64 * 0.3, 1.2, 40 * 0.3, 6);
  await settle(300);
  await hold(['KeyW'], 4500);
  j = await jeep();
  check('climbs the ramp', j.y > 2.2, `y ${j.y.toFixed(2)} m, z ${(j.z / 0.3).toFixed(0)} cells`);

  // ---- coasting: sand stops it faster than stone
  const coast = async (x, y) => {
    await place('jeep', x, y, 4.2, 10);   // all four wheels on the lane (it starts 4 cells from the wall), clear of the ramp at z 64 cells (19 m)
    await settle(150);
    const a = await jeep();
    let powder = 0;
    for (let i = 0; i < 4; i++) { await settle(300); powder = Math.max(powder, (await jeep()).state.onPowder); }
    const c = await jeep();
    const t = c.clock - a.clock;
    return { lost: (a.speed - c.speed) / t, powder, from: a.speed };
  };
  const stone = await coast(64 * 0.3, 1.2);
  const sand = await coast(20 * 0.3, 0.9 + 1.2);
  check('coasting, sand slows it more than stone', sand.lost > 2 * stone.lost && sand.powder > 0.5,
    `slowed ${sand.lost.toFixed(1)} m/s² on sand (on powder ${sand.powder}) vs ${stone.lost.toFixed(1)} on stone, from ~10 m/s`);

  // ---- running a body over, team damage off
  const runOver = async (team) => {
    await place('jeep', 64 * 0.3, 1.2, 10 * 0.3, 0);
    await settle(300);
    const hurt = await ev(async (team) => {
      const { addTarget } = await import('/src/pov/targets.js');
      window.__hurt = [];
      const z0 = 40;
      window.__dummyOff = addTarget({ id: 'dummy', team, alive: true,
        box(min, max) { min.set(63, 0, z0); max.set(64.6, 5.5, z0 + 1.6); },
        hurt(amount, cause) { window.__hurt.push({ amount, cause }); } });
    }, team);
    await hold(['KeyW'], 2200);
    await hold(['KeyS'], 1200);
    return ev(() => { window.__dummyOff(); return window.__hurt; });
  };
  const enemy = await runOver('blue');
  check('running over an enemy hurts it', enemy.length > 0 && enemy[0].amount > 0.3, JSON.stringify(enemy));
  const friend = await runOver('red');
  check('running over a teammate does not', friend.length === 0, JSON.stringify(friend));

  // ---- a blast shoves it
  await place('jeep', 64 * 0.3, 1.2, 20 * 0.3, 0);
  await settle(600);
  const jb = await jeep();
  await ev(([x, z]) => { const a = window.__app.pov; a.events.emit('blast', { point: a.player.pos.clone().set(x - 4, 1, z) }); }, [jb.x / 0.3, jb.z / 0.3]);
  await settle(60);
  const ja = await jeep();
  check('a blast shoves it away', ja.vx > 1 && ja.vy > 0.5, `v ${ja.vx.toFixed(1)}, ${ja.vy.toFixed(1)}, ${ja.vz.toFixed(1)} m/s; health ${ja.health.toFixed(2)}`);
  await settle(1500);
  await p.keyboard.press('KeyE');
  await settle(200);

  // ---- the hoverbike: skims water, and drifts
  await stand(110 - 5, 7, 12);
  await settle(300);
  hb = await bike();
  await place('hoverbike', hb.x, hb.y, 8 * 0.3, 0);
  await stand(hb.x / 0.3 - 5, 7, 8);
  await settle(300);
  await p.keyboard.press('KeyE');
  await settle(200);
  check('E gets on the hoverbike', (await ev(() => window.__app.pov.vehicles.seated?.kind)) === 'hoverbike');
  await hold(['KeyW', 'ShiftLeft'], 1600);
  const fast = await bike();
  if (shotPath) await p.screenshot({ path: `${shotPath}-bike.jpg`, type: 'jpeg', quality: 60 });
  check('it skims the lake at speed', fast.y > 2 && fast.speed > 12 && fast.state.overLiquid, `y ${fast.y.toFixed(2)} m, ${fast.speed.toFixed(1)} m/s`);
  // a hard turn: sample the slip angle while A is held
  await p.keyboard.down('KeyW'); await p.keyboard.down('KeyA');
  let slip = 0;
  for (let i = 0; i < 8; i++) { await settle(70); slip = Math.max(slip, (await bike()).state.slip); }
  await p.keyboard.up('KeyA'); await p.keyboard.up('KeyW');
  check('a hard turn at speed drifts', slip > DRIFT_SLIP_MIN, `peak slip ${(slip * 180 / Math.PI).toFixed(0)}°`);
  await hold(['KeyS'], 1500);
  await p.keyboard.press('KeyE');
  await settle(300);

  // ---- the jeep goes up: a wreck, fire, and a new one later
  const fire0 = await ev(async () => { const { E } = await import('/src/elements.js'); return window.__app.sim.census()[E.FIRE]?.n ?? 0; });
  await ev(() => { window.__destroyed = null; window.__app.pov.events.on('vehicle:destroyed', (e) => { window.__destroyed = e; }); });
  await ev(() => { const vs = window.__app.pov.vehicles; const v = vs.list.find((v) => v.kind === 'jeep' && v.alive); vs.damage(v, 100, 'Test'); });
  await settle(1200);
  const fire1 = await ev(async () => { const { E } = await import('/src/elements.js'); const c = window.__app.sim.census(); return { fire: c[E.FIRE]?.n ?? 0, powder: c[E.GUNPOWDER]?.n ?? 0 }; });
  if (shotPath) {
    await ev(() => { const a = window.__app.pov; const v = a.vehicles.list.find((v) => v.kind === 'jeep'); const t = v.impl.body.translation(); a.player.spawn(a.player.pos.clone().set(t.x / 0.3 - 16, 0, t.z / 0.3 - 16)); a.setLook(Math.atan2(16, 16) + Math.PI, -0.2); a.camera.third = true; });
    await settle(700);
    await p.screenshot({ path: `${shotPath}-wreck.jpg`, type: 'jpeg', quality: 60 });
  }
  const wreck = await ev(() => window.__app.pov.vehicles.list.filter((v) => v.kind === 'jeep').map((v) => v.alive));
  check('0 health: it explodes into a wreck', !!(await ev(() => window.__destroyed)) && wreck.includes(false), JSON.stringify(wreck));
  check('the wreck burns (fire in the sim)', fire1.fire > fire0 + 3, `fire cells ${fire0} → ${fire1.fire}, gunpowder left ${fire1.powder}`);
  await p.waitForFunction(() => window.__app.pov.vehicles.list.some((v) => v.kind === 'jeep' && v.alive), null, { timeout: 30000 }).catch(() => {});
  const back = await ev(() => window.__app.pov.vehicles.list.filter((v) => v.kind === 'jeep').map((v) => v.alive));
  check('a new jeep comes back on its spot', back.includes(true), JSON.stringify(back));

  const perf = await ev(() => { const vs = window.__app.pov.vehicles; return { toggled: vs.physics.toggled, ms: vs.stats.ms }; });
  console.log(`vehicles.update ${perf.ms.toFixed(2)} ms a frame (eased); last terrain sync toggled ${perf.toggled} voxels`);
} catch (err) {
  fails++;
  console.log('FAIL threw', err.message);
} finally {
  if (errs.length) { console.log('page errors:'); for (const e of [...new Set(errs)].slice(0, 12)) console.log('  ' + e); }
  console.log(fails ? `${fails} FAILED` : 'all ok');
  await b.close();
  process.exit(fails ? 1 : 0);
}
