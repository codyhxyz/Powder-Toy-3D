// Burrower and laser cannon end-to-end check (docs/pov.md, "Burrower", "Laser cannon"):
// the drill homes on a body behind a rock hill, bores a tunnel to it that the
// body can walk through, and adds no matter; the laser charges for its full
// time (releasing early cancels), then one beam vaporises and melts a tunnel
// through rock and metal and hits the body behind them. The beam's reach comes
// back from the GPU a frame or few after the shot (its ring: docs/webgpu.md
// W17), with no read of the world in between.
// The app at 64³ (the old 128³ range's matter, brought in), booted through
// ready() and its frames run by the check (tools/pov-app.mjs), so its times
// are game time, not the wall's. Each part is an app of its own (its own
// browser: runParts): burrower, charge and shot by default, a few minutes at
// most here each, one after another. The tunnel part only when asked for
// (--only tunnel, or --all): its conveyor throws the spoil out of the mouth at
// V_MAX, and the air it stirs keeps a fifth of the 64³ box awake for the 2.5 s
// the conveyor runs, which costs SwiftShader 3 to 4 s a frame: 6 to 9 minutes
// for the part (seconds on a real GPU: docs/webgpu.md I4's Mac list has it).
// Here the burrower part checks the drill's homing, the kill, the bore and
// that it adds no matter, and pov-gpu-check's edits stage the bore's edit
// (its cut and conveyor, nothing changed outside its box).
// usage: node tools/burrower-laser-check.mjs [--only burrower,tunnel,charge,shot | --all] [--shots dir]   (runs its own Vite: tools/vite-server.mjs)
import { runParts, argList, POV_DT } from './pov-app.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const shots = opt('shots', null);
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
const GASES = new Set(['EMPTY', 'FIRE', 'SMOKE', 'STEAM', 'CLOUD']);
const matter = (c) => Object.entries(c).filter(([k]) => !GASES.has(k)).reduce((s, [, v]) => s + v.n, 0);
const n = (c, k) => c[k]?.n ?? 0;

// One part's page helpers.
function helpers(app) {
  const p = app.page;
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const frames = (k) => ev((k) => __pov.frames(k), k);
  return {
    p, ev, frames,
    secs: (s) => ev((s) => __pov.frames(Math.round(s / __pov.dt)), s),
    shot: async (name) => { if (shots) { await ev(() => __app.test.renderOnce()); await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 70 }); } },
    census: () => ev(async () => {
      const { ELEMENTS } = await import('/src/elements.js');
      return Object.fromEntries(Object.entries(await window.__app.sim.census()).map(([k, v]) => [ELEMENTS[k].key, { n: v.n, Tmax: v.Tmax }]));
    }),
    // in hand, its slot selector gone (a click while it's up only closes it), and drawn
    hold: async (key) => { const k = await app.hold(key); await frames(6); return k; },
  };
}

// What every part's app needs first: both given from the palette's Tools group, the body
// dropped in, and a body to aim at: a 1.6 × 5.5 box standing on the floor, one hit's worth of
// health (each part stands it where it wants it).
async function setup(app) {
  const { ev } = helpers(app), check = app.check;
  await ev(async () => { const { inventory } = await import('/src/pov/tools/inventory.js'); inventory.give('BURROWER'); inventory.give('LASER'); });
  const entered = await app.enter();
  check('dropped in', entered.mode === 'on' && entered.onGround, `${entered.s.toFixed(0)} s, ${entered.frames} frames`);
  check('both are carried', (await ev(() => window.__app.pov.toolbelt.carried)).join().match(/LASER.*BURROWER|BURROWER.*LASER/) !== null);
  await ev(async () => {
    const { addTarget } = await import('/src/pov/targets.js');
    const dummy = { id: 'dummy', alive: true, health: 1, cause: null, at: [0, 0],
      stand(x, z) { dummy.at = [x, z]; dummy.alive = true; dummy.health = 1; dummy.cause = null; },
      box(lo, hi) { const [x, z] = dummy.at; lo.set(x - 0.8, 0, z - 0.8); hi.set(x + 0.8, 5.5, z + 0.8); },
      hurt(amount, cause) { dummy.health -= amount; dummy.cause = cause; if (dummy.health <= 0) dummy.alive = false; } };
    window.__dummy = dummy;
    window.__offDummy = addTarget(dummy);
  });
}

// The laser's range down its lane, the laser in hand, its events counted on the tool's clock.
async function laserRange(app) {
  const { ev, secs, hold, frames } = helpers(app), check = app.check;
  await ev(async ({ ROCK2, METAL, LASER_Z, LASER_X0, TARGET_X }) => {
    const a = window.__app, { E } = await import('/src/elements.js'), V = a.THREE.Vector3;
    a.sim.paint({ center: new V(ROCK2.x, ROCK2.y, LASER_Z), radius: ROCK2.r, shape: 1, tool: E.ROCK, rate: 1, replace: true });
    a.sim.paint({ center: new V(METAL.x, METAL.y, LASER_Z), radius: METAL.r, shape: 1, tool: E.METAL, rate: 1, replace: true });
    window.__dummy.stand(TARGET_X, LASER_Z);
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
}

// The hill and the body behind it, the drill fired from the far side of the hill and left to
// home on the body; the drill's hit is checked. Resolves to the census before the shot.
async function fireDrill(app) {
  const { p, ev, frames, secs, shot, census, hold } = helpers(app), check = app.check;
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
  return b0;
}

const parts = [
  // ================= the burrower: a hill, a still body behind it; the drill homes on it through the hill
  ['burrower', async (app) => {
    const { ev, census } = helpers(app), check = app.check;
    const b0 = await fireDrill(app);
    const b1 = await census();
    check('it bored through rock', n(b0, 'ROCK') - n(b1, 'ROCK') > ROCK_BORED_MIN, `ROCK ${n(b0, 'ROCK')}→${n(b1, 'ROCK')}, STONE ${n(b0, 'STONE')}→${n(b1, 'STONE')}`);
    check('the burrower adds no matter', matter(b1) === matter(b0), `${matter(b0)}→${matter(b1)}`);
    await ev(() => window.__offDummy?.());
  }],

  // ================= the same bore, its conveyor run out; then the tunnel, and a walk through it
  ['tunnel', async (app) => {
    const { p, ev, secs, shot, hold } = helpers(app), check = app.check;
    await fireDrill(app);
    // the conveyor clears the bore (CONVEY_AFTER past the hit), then the tunnel is checked
    await ev(() => __pov.frames(Math.round(4 / __pov.dt), () => !window.__app.pov.toolbelt.tool('BURROWER').drills.length));
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
    await p.keyboard.down('w');
    await ev((xOut) => __pov.frames(Math.round(6 / __pov.dt), () => window.__app.pov.player.pos.x > xOut), HILL.x + HILL.r + 1);
    await p.keyboard.up('w');
    const walked = await ev(() => window.__app.pov.player.pos.toArray().map((v) => +v.toFixed(1)));
    check('the body walks through the tunnel', walked[0] > HILL.x + HILL.r + 1, `feet ${walked.join(', ')}`);
  }],

  // ================= the laser charges; released early, it cancels
  ['charge', async (app) => {
    const { p, ev, frames, secs, shot } = helpers(app), check = app.check;
    await laserRange(app);
    await p.mouse.down(); await secs(1.5);
    const midCharge = await ev(() => window.__app.pov.toolbelt.tool('LASER').charge);
    await shot('laser-charging');
    await p.mouse.up(); await frames(9);
    const L = await ev(() => ({ ...window.__laser, charge: window.__app.pov.toolbelt.tool('LASER').charge }));
    check('the laser charges while held', midCharge > 0.35 && midCharge < 0.7, `charge ${midCharge.toFixed(2)} at 1.5 s`);
    check('letting go early cancels it: no shot', L.fires === 0 && L.cancels === 1 && L.charge === 0, JSON.stringify(L));
  }],

  // ================= held to full, one beam down the lane: rock then metal, the body behind them
  ['shot', async (app) => {
    const { p, ev, frames, secs, shot, census } = helpers(app), check = app.check;
    await laserRange(app);
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
    // what the beam did, looked at every few frames until it shows (rock gone, lava made, metal melted), for
    // the old check's 1.2 s at most: the lava and the plume wake the box, which costs SwiftShader seconds a frame
    const LOOK_EVERY = 6, done = (c) => n(l0, 'ROCK') - n(c, 'ROCK') > LASER_ROCK_MIN && n(c, 'LAVA') > LASER_LAVA_MIN && n(l0, 'METAL') - n(c, 'METAL') > LASER_METAL_MIN;
    let l1 = await census(), waited = 0;
    for (; waited < Math.round(1.2 / POV_DT) && !done(l1); waited += LOOK_EVERY) { await frames(LOOK_EVERY); l1 = await census(); }
    console.log(`  (the beam's work counted ${waited} frames after it)`);
    await shot('laser-tunnel');
    check('rock vaporised and melted (rock gone, smoke and lava made)', n(l0, 'ROCK') - n(l1, 'ROCK') > LASER_ROCK_MIN && n(l1, 'LAVA') > LASER_LAVA_MIN,
      `ROCK ${n(l0, 'ROCK')}→${n(l1, 'ROCK')}, STONE ${n(l0, 'STONE')}→${n(l1, 'STONE')}, LAVA ${n(l0, 'LAVA')}→${n(l1, 'LAVA')} (Tmax ${l1.LAVA?.Tmax?.toFixed(0)}), SMOKE ${n(l1, 'SMOKE')}`);
    check('metal melted through', n(l0, 'METAL') - n(l1, 'METAL') > LASER_METAL_MIN, `METAL ${n(l0, 'METAL')}→${n(l1, 'METAL')}`);
    if (shots) {   // a look down the tunnel from its mouth
      await ev(({ ROCK2, LASER_Z }) => {
        const a = window.__app, V = a.THREE.Vector3;
        a.pov.player.spawn(new V(Math.max(2, ROCK2.x - ROCK2.r - 14), 0, LASER_Z + 0.5));
        a.pov.setLook(-Math.PI / 2, 0.02);
      }, { ROCK2, LASER_Z });
      await app.hold('SHOVEL');
      await secs(1.5);
      await shot('laser-tunnel-mouth');
    }
  }],
];

// (the tunnel part only when asked for: see the top)
const DEFAULT = ['burrower', 'charge', 'shot'];
const only = argList('only') ?? (args.includes('--all') ? parts.map(([name]) => name) : DEFAULT);
process.exit(await runParts(parts, { only, open: { viewport: { width: W, height: H } }, setup }) ? 1 : 0);
