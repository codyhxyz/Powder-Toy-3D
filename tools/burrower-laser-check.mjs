// Burrower and laser cannon end-to-end check (docs/pov.md, "Burrower", "Laser cannon"):
// the drill homes on a body behind a rock hill, bores a tunnel to it that the
// body can walk through, and adds no matter; the laser charges for its full
// time (releasing early cancels), then one beam vaporises and melts a tunnel
// through rock and metal and hits the body behind them. The beam's reach comes
// back from the GPU a frame or few after the shot (its ring: docs/webgpu.md
// W17), with no read of the world in between.
// The app at 64³ (the old 128³ range's matter, brought in), booted through
// ready() and its frames run by the check (tools/pov-app.mjs), so its times
// are game time, not the wall's. A bore keeps much of the grid awake, which
// costs SwiftShader seconds a frame: allow it tens of minutes there.
// usage: node tools/burrower-laser-check.mjs [--only burrower,laser] [--shots dir]   (runs its own Vite: tools/vite-server.mjs)
import { openPovApp } from './pov-app.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const shots = opt('shots', null);
const only = opt('only', 'burrower,laser').split(',');   // the parts to run
const W = 640, H = 400;

// the range, in grid cells (the empty 64³ box): the old 128³ check's matter,
// cell for cell (CLAUDE.md: physics fixtures aren't shrunk to save GPU work), its
// lanes and stands brought in so they fit
const LANE_Z = 44.5;                 // the burrower's lane
const HILL = { x: 34, y: 8, r: 8 };  // a rock cube 17 cells a side (x 26..42, floor to y 16)
const DUMMY_X = 56;                  // a still body behind it
const DRILL_X0 = 6;                  // where the body stands to fire the drill
const LASER_Z = 16.5;                // the laser's lane
const LASER_X0 = 4;                  // where the body stands to fire the laser
const ROCK2 = { x: 30, y: 8, r: 8 }; // rock, 17 cells deep...
const METAL = { x: 46, y: 8, r: 4 }; // ...then 9 of metal
const TARGET_X = 56;                 // the body behind them
const ROCK_BORED_MIN = 300;          // rock cells a tunnel through the hill bores at least (the old check's)
// what one beam does to that range at least: rock vaporised or spalled, lava made, metal melted (the old check's)
const LASER_ROCK_MIN = 200, LASER_LAVA_MIN = 50, LASER_METAL_MIN = 40;

let app = null, fails = 0;
const local = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
try {
  app = await openPovApp({ viewport: { width: W, height: H } });
  const p = app.page, check = local;
  console.log(`booted in ${app.boot.toFixed(0)} s`);
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const frames = (n) => ev((n) => __pov.frames(n), n);
  const secs = (s) => ev((s) => __pov.frames(Math.round(s / __pov.dt)), s);
  const shot = async (name) => { if (shots) { await ev(() => __app.test.renderOnce()); await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 70 }); } };
  const census = () => ev(async () => {
    const { ELEMENTS } = await import('/src/elements.js');
    return Object.fromEntries(Object.entries(await window.__app.sim.census()).map(([k, v]) => [ELEMENTS[k].key, { n: v.n, Tmax: v.Tmax }]));
  });
  const n = (c, k) => c[k]?.n ?? 0;
  const GASES = new Set(['EMPTY', 'FIRE', 'SMOKE', 'STEAM', 'CLOUD']);
  const matter = (c) => Object.entries(c).filter(([k]) => !GASES.has(k)).reduce((s, [, v]) => s + v.n, 0);

  // both given from the palette's Tools group, then into the body
  await ev(async () => { const { inventory } = await import('/src/pov/tools/inventory.js'); inventory.give('BURROWER'); inventory.give('LASER'); });
  const entered = await app.enter();
  check('dropped in', entered.mode === 'on' && entered.onGround, `${entered.s.toFixed(0)} s, ${entered.frames} frames`);
  // in hand, its slot selector gone (a click while it's up only closes it), and drawn
  const hold = async (key) => { const k = await app.hold(key); await frames(6); return k; };
  check('both are carried', (await ev(() => window.__app.pov.toolbelt.carried)).join().match(/LASER.*BURROWER|BURROWER.*LASER/) !== null);

  // a body: a 1.6 × 5.5 box standing on the floor, one hit's worth of health (each part stands it where it wants it)
  await ev(async () => {
    const { addTarget } = await import('/src/pov/targets.js');
    const dummy = { id: 'dummy', alive: true, health: 1, cause: null, at: [0, 0],
      stand(x, z) { dummy.at = [x, z]; dummy.alive = true; dummy.health = 1; dummy.cause = null; },
      box(lo, hi) { const [x, z] = dummy.at; lo.set(x - 0.8, 0, z - 0.8); hi.set(x + 0.8, 5.5, z + 0.8); },
      hurt(amount, cause) { dummy.health -= amount; dummy.cause = cause; if (dummy.health <= 0) dummy.alive = false; } };
    window.__dummy = dummy;
    window.__offDummy = addTarget(dummy);
  });

  if (only.includes('burrower')) {
    // ================= the burrower: a hill, a still body behind it
    await ev(async ({ HILL, LANE_Z, DUMMY_X, DRILL_X0 }) => {
      const a = window.__app, { E } = await import('/src/elements.js'), V = a.THREE.Vector3;
      a.sim.paint({ center: new V(HILL.x, HILL.y, LANE_Z), radius: HILL.r, shape: 1, tool: E.ROCK, rate: 1, replace: true });
      window.__dummy.stand(DUMMY_X, LANE_Z);
      a.pov.player.spawn(new V(DRILL_X0, 0, LANE_Z));
      a.pov.setLook(-Math.PI / 2, 0.15);   // facing +x, a little up: the drill must home down onto the body
    }, { HILL, LANE_Z, DUMMY_X, DRILL_X0 });
    await secs(1);
    check('burrower in hand', (await hold('BURROWER')) === 'BURROWER');
    const b0 = await census();
    await p.mouse.down(); await frames(2); await p.mouse.up();
    await secs(1.5);
    await shot('burrower-boring');
    await ev(() => __pov.frames(Math.round(14 / __pov.dt), () => window.__app.pov.toolbelt.tool('BURROWER').lastHit));
    const hit = await ev(() => {
      const t = window.__app.pov.toolbelt.tool('BURROWER'), h = t.lastHit, d = window.__dummy;
      return h && { target: h.target, age: +h.age.toFixed(2), point: h.point.toArray().map((v) => +v.toFixed(1)), pathN: h.path.length, health: d.health, cause: d.cause, alive: d.alive };
    });
    check('the drill reached the body behind the hill', !!hit && hit.target === 'dummy', JSON.stringify(hit && { age: hit.age, point: hit.point, pathN: hit.pathN }));
    check('and drilled into it (one kills)', !!hit && !hit.alive && hit.cause === 'Bored', JSON.stringify(hit && { health: hit.health, cause: hit.cause }));
    // the conveyor clears the bore, then the tunnel is checked
    await secs(4);
    const b1 = await census();
    check('it bored through rock', n(b0, 'ROCK') - n(b1, 'ROCK') > ROCK_BORED_MIN, `ROCK ${n(b0, 'ROCK')}→${n(b1, 'ROCK')}, STONE ${n(b0, 'STONE')}→${n(b1, 'STONE')}`);
    check('the burrower adds no matter', matter(b1) === matter(b0), `${matter(b0)}→${matter(b1)}`);
    // the tunnel's corridor inside the hill: a body's footprint (1.6 wide), its height above the tunnel floor
    const corridor = await ev(async ({ HILL, LANE_Z }) => {
      const a = window.__app, sim = a.sim, [st] = await sim.readState(), { ELEMENTS, K } = await import('/src/elements.js');
      const idAt = (x, y, z) => Math.round(st[sim.cellTexel(x, y, z) * 4]);
      const blocks = (id) => ELEMENTS[id].kind === K.SOLID || ELEMENTS[id].kind === K.POWDER;
      const out = [];
      for (let x = HILL.x - HILL.r; x <= HILL.x + HILL.r; x++) {
        let floor = 0;   // the highest blocking cell under the lane's middle below y 4 (the tunnel's floor, or the grid's)
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
      const a = window.__app, V = a.THREE.Vector3;
      a.pov.player.spawn(new V(HILL.x - HILL.r + 1, mouthFloor + 0.2, LANE_Z));   // on the tunnel's floor, just inside
      a.pov.setLook(-Math.PI / 2, 0);
    }, { HILL, LANE_Z, mouthFloor });
    await secs(0.8);
    await shot('burrower-tunnel');
    await p.keyboard.down('w'); await secs(6); await p.keyboard.up('w');
    const walked = await ev(() => window.__app.pov.player.pos.toArray().map((v) => +v.toFixed(1)));
    check('the body walks through the tunnel', walked[0] > HILL.x + HILL.r + 1, `feet ${walked.join(', ')}`);
  }

  if (only.includes('laser')) {
    // ================= the laser: rock then metal down a second lane
    await ev(async ({ ROCK2, METAL, LASER_Z, LASER_X0, TARGET_X }) => {
      const a = window.__app, { E } = await import('/src/elements.js'), V = a.THREE.Vector3;
      // the box emptied first: the bore's spoil would keep the grid awake, which costs SwiftShader seconds a frame
      a.sim.clear();
      a.sim.paint({ center: new V(ROCK2.x, ROCK2.y, LASER_Z), radius: ROCK2.r, shape: 1, tool: E.ROCK, rate: 1, replace: true });
      a.sim.paint({ center: new V(METAL.x, METAL.y, LASER_Z), radius: METAL.r, shape: 1, tool: E.METAL, rate: 1, replace: true });
      window.__dummy.stand(TARGET_X, LASER_Z);   // a fresh body behind them
      a.pov.player.spawn(new V(LASER_X0, 0, LASER_Z));
      a.pov.setLook(-Math.PI / 2, 0);   // aim along the lane at the body's chest height (about eye height): level
    }, { ROCK2, METAL, LASER_Z, LASER_X0, TARGET_X });
    await secs(1);
    check('laser in hand', (await hold('LASER')) === 'LASER');
    await ev(async () => {
      const { povEvents } = await import('/src/pov/events.js');
      // game seconds of charge (the tool's clock)
      window.__laser = { fires: 0, charges: 0, cancels: 0, chargeT: 0, fireT: null };
      povEvents.on('gun:fire', (e) => { if (e.gun === 'LASER') { window.__laser.fires++; window.__laser.fireT = window.__laser.chargeT; } });
      povEvents.on('laser:charge', (e) => { window.__laser.chargeT += e.dt; });
      povEvents.on('tool:action', (e) => { if (e.tool === 'laser') { if (e.action === 'charge') { window.__laser.charges++; window.__laser.chargeT = 0; } if (e.action === 'cancel') window.__laser.cancels++; } });
    });
    await frames(6);
    // released early: cancels, no shot
    await p.mouse.down(); await secs(1.5);
    const midCharge = await ev(() => window.__app.pov.toolbelt.tool('LASER').charge);
    await shot('laser-charging');
    await p.mouse.up(); await frames(9);
    const L = await ev(() => ({ ...window.__laser, charge: window.__app.pov.toolbelt.tool('LASER').charge }));
    check('the laser charges while held', midCharge > 0.35 && midCharge < 0.7, `charge ${midCharge.toFixed(2)} at 1.5 s`);
    check('letting go early cancels it: no shot', L.fires === 0 && L.cancels === 1 && L.charge === 0, JSON.stringify(L));
    // held to full: it fires itself at 3 s
    const l0 = await census();
    await p.mouse.down();
    await ev(() => __pov.frames(Math.round(5 / __pov.dt), () => window.__laser.fires > 0));
    const tFire = await ev(() => window.__laser.fireT ?? -1);
    // the beam's reach comes back from the GPU a frame or few after the shot (its ring: docs/webgpu.md W17), and with it lastShot
    const reachFrames = await ev(() => __pov.frames(30, () => window.__app.pov.toolbelt.tool('LASER').lastShot));
    await frames(2);
    await shot('laser-beam');
    await p.mouse.up();
    const shotInfo = await ev(() => {
      const s = window.__app.pov.toolbelt.tool('LASER').lastShot;
      return s && { reach: +s.reach.toFixed(1), stopId: s.stopId, hits: s.hits, from: s.from.toArray().map((v) => +v.toFixed(1)) };
    });
    check('held to full charge it fires itself at 3 s (game time)', tFire > 2.9 && tFire < 3.2, `${tFire.toFixed(2)} s of charge`);
    check('the reach lands through its ring within a few frames (no read of the world)', !!shotInfo && reachFrames <= 6, `${reachFrames} frame(s)`);
    check(`the beam reaches through ${2 * ROCK2.r + 1} cells of rock and ${2 * METAL.r + 1} of metal`, !!shotInfo && shotInfo.reach > METAL.x + METAL.r - LASER_X0, JSON.stringify(shotInfo));
    check('the body in the beam is hit', !!shotInfo && shotInfo.hits.includes('dummy') && (await ev(() => window.__dummy.cause)) === 'Lasered');
    await secs(1.2);
    await shot('laser-tunnel');
    const l1 = await census();
    check('rock vaporised and melted (rock gone, smoke and lava made)', n(l0, 'ROCK') - n(l1, 'ROCK') > LASER_ROCK_MIN && n(l1, 'LAVA') > LASER_LAVA_MIN,
      `ROCK ${n(l0, 'ROCK')}→${n(l1, 'ROCK')}, STONE ${n(l0, 'STONE')}→${n(l1, 'STONE')}, LAVA ${n(l0, 'LAVA')}→${n(l1, 'LAVA')} (Tmax ${l1.LAVA?.Tmax?.toFixed(0)}), SMOKE ${n(l1, 'SMOKE')}`);
    check('metal melted through', n(l0, 'METAL') - n(l1, 'METAL') > LASER_METAL_MIN, `METAL ${n(l0, 'METAL')}→${n(l1, 'METAL')}`);
    if (shots) {   // a look down the tunnel from its mouth
      await ev(({ ROCK2, LASER_Z }) => {
        const a = window.__app, V = a.THREE.Vector3;
        a.pov.player.spawn(new V(Math.max(2, ROCK2.x - ROCK2.r - 14), 0, LASER_Z + 0.5));
        a.pov.setLook(-Math.PI / 2, 0.02);
      }, { ROCK2, LASER_Z });
      await hold('SHOVEL');
      await secs(1.5);
      await shot('laser-tunnel-mouth');
    }
  }
  check(`no page or GPU errors (${app.secs()})`, app.errors.length === 0, app.errors.slice(0, 5).join(' | '));
  if (app.allowed.length) console.log(`(${app.allowed.length} allowed three.js material warnings, until U13)`);
  await ev(() => window.__offDummy?.());
} catch (err) {
  fails++;
  console.log('FAIL threw', String(err).slice(0, 500));
} finally {
  await app?.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
