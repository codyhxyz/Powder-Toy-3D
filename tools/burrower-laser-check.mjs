// Burrower and laser cannon end-to-end check (docs/pov.md, "Burrower", "Laser cannon"):
// the drill homes on a body behind a rock hill, bores a tunnel to it that the
// body can walk through, and adds no matter; the laser charges for its full
// time (releasing early cancels), then one beam vaporises and melts a long
// tunnel through rock and metal and hits the body in it.
// usage: node tools/burrower-laser-check.mjs [--port 5423] [--shots dir]   (needs a dev server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5423');
const shots = opt('shots', null);
const W = 960, H = 600;

// the range, in grid cells (the empty 128³ box)
const LANE_Z = 64.5;                 // the burrower's lane
const HILL = { x: 64, y: 8, r: 8 };  // a rock cube 17 cells a side (x 56..72, floor to y 16)
const DUMMY_X = 88;                  // a still body behind it
const LASER_Z = 28.5;                // the laser's lane
const ROCK2 = { x: 48, y: 8, r: 8 }; // rock, 17 cells deep...
const METAL = { x: 70, y: 8, r: 4 }; // ...then 9 of metal
const EYE_Y = 5;                     // the body's eye over its feet (pov/constants.js EYE_HEIGHT)

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
try {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
  await p.addInitScript(() => { try { localStorage.removeItem('tpt3d.pov.given'); } catch { /* */ } });
  await p.goto(`http://localhost:${port}/?preset=empty`);
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const wait = (ms) => p.waitForTimeout(ms);
  const shot = async (name) => { if (shots) await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 70 }); };
  const census = () => ev(async () => {
    const { ELEMENTS } = await import('/src/elements.js');
    return Object.fromEntries(Object.entries(window.__app.sim.census()).map(([k, v]) => [ELEMENTS[k].key, { n: v.n, Tmax: v.Tmax }]));
  });
  const n = (c, k) => c[k]?.n ?? 0;
  const GASES = new Set(['EMPTY', 'FIRE', 'SMOKE', 'STEAM', 'CLOUD']);
  const matter = (c) => Object.entries(c).filter(([k]) => !GASES.has(k)).reduce((s, [, v]) => s + v.n, 0);

  // both given from the palette's Tools group
  await ev(async () => { const { inventory } = await import('/src/pov/tools/inventory.js'); inventory.give('BURROWER'); inventory.give('LASER'); });
  await p.mouse.move(W / 2, H / 2);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 20000 }).catch(() => {});
  check('dropped in', (await ev(() => window.__app.pov.mode)) === 'on');
  await ev(() => { window.__app.pov.test.assumeLocked = true; });
  const hold = (key) => ev((k) => { window.__app.pov.toolbelt.select(k); return window.__app.pov.toolbelt.selectedKey; }, key);
  check('both are carried', (await ev(() => window.__app.pov.toolbelt.carried)).join().match(/LASER.*BURROWER|BURROWER.*LASER/) !== null);

  // ================= the burrower: a hill, a still body behind it
  await ev(async ({ HILL, LANE_Z, DUMMY_X }) => {
    const a = window.__app, { E } = await import('/src/elements.js'), V = a.camera.position.constructor;
    const { addTarget } = await import('/src/pov/targets.js');
    a.sim.paint({ center: new V(HILL.x, HILL.y, LANE_Z), radius: HILL.r, shape: 1, tool: E.ROCK, rate: 1, replace: true });
    // a body: a 1.6 × 5.5 box standing on the floor, one hit's worth of health
    const dummy = { id: 'dummy', alive: true, health: 1, cause: null,
      box(lo, hi) { lo.set(DUMMY_X - 0.8, 0, LANE_Z - 0.8); hi.set(DUMMY_X + 0.8, 5.5, LANE_Z + 0.8); },
      hurt(amount, cause) { this.health -= amount; this.cause = cause; if (this.health <= 0) this.alive = false; } };
    window.__dummy = dummy;
    window.__offDummy = addTarget(dummy);
    a.pov.player.spawn(new V(30, 0, LANE_Z));
    a.pov.setLook(-Math.PI / 2, 0.15);   // facing +x, a little up: the drill must home down onto the body
  }, { HILL, LANE_Z, DUMMY_X });
  await wait(1200);
  check('burrower in hand', (await hold('BURROWER')) === 'BURROWER');
  await wait(400);
  const b0 = await census();
  await p.mouse.down(); await wait(60); await p.mouse.up();
  await wait(1500);
  await shot('burrower-boring');
  await p.waitForFunction(() => window.__app.pov.toolbelt.tool('BURROWER').lastHit, null, { timeout: 16000 }).catch(() => {});
  const hit = await ev(() => {
    const t = window.__app.pov.toolbelt.tool('BURROWER'), h = t.lastHit, d = window.__dummy;
    return h && { target: h.target, age: +h.age.toFixed(2), point: h.point.toArray().map((v) => +v.toFixed(1)), pathN: h.path.length,
      path: h.path.map((q) => q.toArray().map((v) => +v.toFixed(1))), health: d.health, cause: d.cause, alive: d.alive };
  });
  check('the drill reached the body behind the hill', !!hit && hit.target === 'dummy', JSON.stringify(hit && { age: hit.age, point: hit.point, pathN: hit.pathN }));
  check('and drilled into it (one kills)', !!hit && !hit.alive && hit.cause === 'Bored', JSON.stringify(hit && { health: hit.health, cause: hit.cause }));
  // the conveyor clears the bore, then the tunnel is checked
  await wait(4000);
  const b1 = await census();
  check('it bored through rock', n(b0, 'ROCK') - n(b1, 'ROCK') > 300, `ROCK ${n(b0, 'ROCK')}→${n(b1, 'ROCK')}, STONE ${n(b0, 'STONE')}→${n(b1, 'STONE')}`);
  check('the burrower adds no matter', matter(b1) === matter(b0), `${matter(b0)}→${matter(b1)}`);
  // the tunnel's corridor inside the hill: a body's footprint (1.6 wide), its height above the tunnel floor
  const corridor = await ev(async ({ HILL, LANE_Z }) => {
    const a = window.__app, sim = a.sim, [st] = sim.readState(), { ELEMENTS, K } = await import('/src/elements.js');
    const idAt = (x, y, z) => Math.round(st[sim.cellTexel(x, y, z) * 4]);
    const blocks = (id) => ELEMENTS[id].kind === K.SOLID || ELEMENTS[id].kind === K.POWDER;
    const out = [];
    for (let x = HILL.x - HILL.r; x <= HILL.x + HILL.r; x++) {
      // the floor: the highest blocking cell under the lane's middle below y 4 (the tunnel's floor, or the grid's)
      let floor = 0;
      for (let y = 0; y < 4; y++) if (blocks(idAt(x, y, Math.floor(LANE_Z)))) floor = y + 1;
      let blocked = 0;
      for (let y = floor; y < floor + 6; y++) for (const z of [Math.floor(LANE_Z) - 1, Math.floor(LANE_Z), Math.floor(LANE_Z) + 1]) if (blocks(idAt(x, y, z))) blocked++;
      out.push({ x, floor, blocked });
    }
    return out;
  }, { HILL, LANE_Z });
  const CORRIDOR_SLACK = 2;   // blocked cells a column may have (the body's corners against a round tunnel's roof)
  const clear = corridor.filter((c) => c.blocked <= CORRIDOR_SLACK).length;
  check('the tunnel is open the whole way through the hill (a body-sized corridor)', clear === corridor.length, corridor.map((c) => `${c.x}:${c.floor}/${c.blocked}`).join(' '));
  // walk it: in at the mouth, out the far side
  await hold('SHOVEL');
  const mouthFloor = corridor.find((c) => c.x === HILL.x - HILL.r + 1)?.floor ?? 0;
  await ev(({ HILL, LANE_Z, mouthFloor }) => {
    const a = window.__app, V = a.camera.position.constructor;
    a.pov.player.spawn(new V(HILL.x - HILL.r + 1, mouthFloor + 0.2, LANE_Z));   // on the tunnel's floor, just inside
    a.pov.setLook(-Math.PI / 2, 0);
  }, { HILL, LANE_Z, mouthFloor });
  await wait(800);
  await shot('burrower-tunnel');
  await p.keyboard.down('w'); await wait(6000); await p.keyboard.up('w');
  const walked = await ev(() => window.__app.pov.player.pos.toArray().map((v) => +v.toFixed(1)));
  check('the body walks through the tunnel', walked[0] > HILL.x + HILL.r + 1, `feet ${walked.join(', ')}`);

  // ================= the laser: rock then metal down a second lane
  await ev(async ({ ROCK2, METAL, LASER_Z }) => {
    const a = window.__app, { E } = await import('/src/elements.js'), V = a.camera.position.constructor;
    a.sim.paint({ center: new V(ROCK2.x, ROCK2.y, LASER_Z), radius: ROCK2.r, shape: 1, tool: E.ROCK, rate: 1, replace: true });
    a.sim.paint({ center: new V(METAL.x, METAL.y, LASER_Z), radius: METAL.r, shape: 1, tool: E.METAL, rate: 1, replace: true });
    // a fresh body behind them
    window.__dummy.alive = true; window.__dummy.health = 1; window.__dummy.cause = null;
    window.__dummy.box = (lo, hi) => { lo.set(85 - 0.8, 0, LASER_Z - 0.8); hi.set(85 + 0.8, 5.5, LASER_Z + 0.8); };
    a.pov.player.spawn(new V(22, 0, LASER_Z));
    // aim along the lane at the body's chest height (≈ eye height): level
    a.pov.setLook(-Math.PI / 2, 0);
  }, { ROCK2, METAL, LASER_Z });
  await wait(1200);
  check('laser in hand', (await hold('LASER')) === 'LASER');
  await ev(async () => {
    const { povEvents } = await import('/src/pov/events.js');
    // game seconds of charge (the tool's clock: headless frames can run slower than the wall's)
    window.__laser = { fires: 0, charges: 0, cancels: 0, chargeT: 0, fireT: null };
    povEvents.on('gun:fire', (e) => { if (e.gun === 'LASER') { window.__laser.fires++; window.__laser.fireT = window.__laser.chargeT; } });
    povEvents.on('laser:charge', (e) => { window.__laser.chargeT += e.dt; });
    povEvents.on('tool:action', (e) => { if (e.tool === 'laser') { if (e.action === 'charge') { window.__laser.charges++; window.__laser.chargeT = 0; } if (e.action === 'cancel') window.__laser.cancels++; } });
  });
  await wait(300);
  // released early: cancels, no shot
  await p.mouse.down(); await wait(1500);
  const midCharge = await ev(() => window.__app.pov.toolbelt.tool('LASER').charge);
  await shot('laser-charging');
  await p.mouse.up(); await wait(300);
  let L = await ev(() => ({ ...window.__laser, charge: window.__app.pov.toolbelt.tool('LASER').charge }));
  check('the laser charges while held', midCharge > 0.35 && midCharge < 0.7, `charge ${midCharge.toFixed(2)} at 1.5 s`);
  check('letting go early cancels it: no shot', L.fires === 0 && L.cancels === 1 && L.charge === 0, JSON.stringify(L));
  // held to full: it fires itself at 3 s
  const l0 = await census();
  await p.mouse.down();
  await p.waitForFunction(() => window.__laser.fires > 0, null, { timeout: 10000 }).catch(() => {});
  const tFire = await ev(() => window.__laser.fireT ?? -1);
  await wait(60);
  await shot('laser-beam');
  await p.mouse.up();
  const shotInfo = await ev(() => {
    const s = window.__app.pov.toolbelt.tool('LASER').lastShot;
    return s && { reach: +s.reach.toFixed(1), stopId: s.stopId, hits: s.hits, from: s.from.toArray().map((v) => +v.toFixed(1)) };
  });
  check('held to full charge it fires itself at 3 s (game time)', tFire > 2.9 && tFire < 3.2, `${tFire.toFixed(2)} s of charge`);
  check('the beam reaches through 17 cells of rock and 9 of metal', !!shotInfo && shotInfo.reach > METAL.x + METAL.r - 22, JSON.stringify(shotInfo));
  check('the body in the beam is hit', !!shotInfo && shotInfo.hits.includes('dummy') && (await ev(() => window.__dummy.cause)) === 'Lasered');
  await wait(1200);
  await shot('laser-tunnel');
  const l1 = await census();
  check('rock vaporised and melted (rock gone, smoke and lava made)', n(l0, 'ROCK') - n(l1, 'ROCK') > 200 && n(l1, 'LAVA') > 50,
    `ROCK ${n(l0, 'ROCK')}→${n(l1, 'ROCK')}, STONE ${n(l0, 'STONE')}→${n(l1, 'STONE')}, LAVA ${n(l0, 'LAVA')}→${n(l1, 'LAVA')} (Tmax ${l1.LAVA?.Tmax?.toFixed(0)}), SMOKE ${n(l1, 'SMOKE')}`);
  check('metal melted through', n(l0, 'METAL') - n(l1, 'METAL') > 40, `METAL ${n(l0, 'METAL')}→${n(l1, 'METAL')}`);
  // a look down the tunnel from its mouth
  await ev(({ ROCK2, LASER_Z }) => {
    const a = window.__app, V = a.camera.position.constructor;
    a.pov.player.spawn(new V(ROCK2.x - ROCK2.r - 14, 0, LASER_Z + 0.5));
    a.pov.setLook(-Math.PI / 2, 0.02);
  }, { ROCK2, LASER_Z });
  await hold('SHOVEL');
  await wait(1500);
  await shot('laser-tunnel-mouth');
  const real = errs.filter((e) => !/favicon|404|ERR_CONNECTION_REFUSED/.test(e));   // (the multiplayer relay isn't running)
  check('no errors', real.length === 0, real.slice(0, 5).join(' | '));
  await ev(() => window.__offDummy?.());
} catch (err) {
  fails++;
  console.log('FAIL threw', String(err).slice(0, 500));
} finally {
  await b.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
