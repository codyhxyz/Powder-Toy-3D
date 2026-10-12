// Check of Noita's potion flask (src/pov/tools/flask.tool.js, src/pov/ingest.js).
// Part 1 drives the toolbelt with a hand-built ctx and proves matter is conserved
// with sim.census() plus every load while the sim runs: the starting water pours
// out, the flask fills from a pool, a drink takes Noita's share of each material,
// sand mixes in, and a throw shatters it into exactly FLASK_GLASS cells of
// broken glass plus everything it held. Part 2 goes through the real shell and
// body: H drinks, lava kills with its cause, whiskey's row sways the view, and each of
// Noita's potions (potions.js) gives its status by touch and by drink.
// The CPU part runs first, in node: the drink's shares and the ingestion rows on a body built as
// player.js builds it (vitals, perks, a status set fed made-up contact cells), each potion's status
// by touch and by drink, Regeneration, Berserk, Polymorph, Teleportitis's safe spots and the drunk sway.
// Part 1 runs in the POV tools' harness page (tools/harness/pov-tools.js, stage flask: no app);
// part 2 boots the app at 64³ and runs the body's frames itself (tools/pov-app.mjs), so its
// times are game time (frames), not the wall's.
// usage: node tools/flask-check.mjs [--cpu | --app] [--shot file.png]
//   --cpu: the node part only; without it the GPU parts follow (each with its own Vite: tools/vite-server.mjs)
//   --app: the node part and part 2 (the shell and body), not part 1
import { runStages, TOOLS_PAGE } from './pov-gpu-check.mjs';
import { openPovApp } from './pov-app.mjs';
import { E } from '../src/elements.js';
import { createVitals } from '../src/pov/vitals.js';
import { createPerkSet } from '../src/pov/perks.js';
import { createStatusSet } from '../src/pov/status.js';
import '../src/pov/stains.js';
import { POTION_STATUS, POTION_TIMES, safeSpot } from '../src/pov/potions.js';
import { ingest } from '../src/pov/ingest.js';
import { createFeel } from '../src/pov/feel.js';
import { DRINK_CELLS } from '../src/pov/tools/flask.tool.js';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const shot = opt('shot');
const cpuOnly = args.includes('--cpu'), appOnly = args.includes('--app');
const W = 960, H = 600;
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`); };
const zero = (d) => Object.keys(d).length === 0;

// ================= the CPU part
{
  const N = 200, DT = 1 / 60, T_ROOM = 20;
  const full = (id) => [{ id, n: DRINK_CELLS, share: 1, T: T_ROOM }];
  function makeBody() {
    const perks = createPerkSet();
    const ctx = { world: { burn() {}, spill() {} }, hurt: (a, c, o) => vitals.hurt(a, c, false, o) };
    const body = { pos: { x: 0, y: 0, z: 0 }, perks };
    const vitals = createVitals(() => {}, perks);
    Object.defineProperties(body, {
      skinT: { get: () => vitals.skinT, set: (t) => { vitals.skinT = t; } }, dead: { get: () => vitals.dead },
      health: { get: () => vitals.health }, cause: { get: () => vitals.cause },
    });
    body.hurt = (a, c, o = {}) => vitals.hurt(a, c, true, { shielded: true, ...o });
    body.heal = (a) => { vitals.health = Math.min(1, vitals.health + a); };
    body.status = createStatusSet(body, ctx);
    const env = { contactId: new Int32Array(N).fill(E.EMPTY), contactT: new Float32Array(N).fill(T_ROOM), contactLife: new Float32Array(N), contactN: N };
    const run = (s) => { for (let t = 0; t < s / DT; t++) { vitals.update(DT, env); body.status.update(DT, env); } };
    return { body, vitals, env, run };
  }
  // the built-in rows
  { const a = makeBody(); a.vitals.skinT = 70; ingest(a.body, full(E.WATER)); check('cpu: water quenches and cools', a.body.skinT < 37 && a.body.health === 1, { skinT: +a.body.skinT.toFixed(1) }); }
  { const a = makeBody(); ingest(a.body, full(E.ACID)); check('cpu: acid hurts', a.body.health < 1 && /acid/.test(a.vitals.cause || 'acid'), { health: a.body.health }); }
  { const a = makeBody(); ingest(a.body, [{ id: E.LAVA, n: 1, share: 1 / DRINK_CELLS, T: 1600 }]); check('cpu: one cell of lava kills', a.body.dead && /Drank lava/.test(a.body.cause), { cause: a.body.cause }); }
  { const a = makeBody(); ingest(a.body, full(E.OIL)); check('cpu: oil makes you sick', a.body.health < 1 && a.body.health > 0.8, { health: a.body.health }); }
  {
    const feel = createFeel({ hud: null });
    feel.update({ dt: DT, live: true, eye: { x: 0, y: 0, z: 0 } });
    const a = makeBody();
    ingest(a.body, full(E.WHISKEY));
    let roll = 0;
    for (let t = 0; t < 5 / DT; t++) roll = Math.max(roll, Math.abs(feel.update({ dt: DT, live: true }).roll));
    check('cpu: a full drink of whiskey: 30 s of Drunk, and the view sways', Math.abs(feel.drunk + 5 - 30) < 0.1 && roll > 0, { drunk: +feel.drunk.toFixed(1), roll });
    feel.dispose();
  }
  // each potion's status by touch (half the skin in it for a second) and by drink (adding up)
  for (const [el, st] of Object.entries({ ...POTION_STATUS, TOXIC: 'TOXIC' })) {
    const a = makeBody();
    for (let i = 0; i < N / 2; i++) a.env.contactId[i] = E[el];
    a.run(1);
    const b = makeBody();
    ingest(b.body, full(E[el]));
    const one = b.body.status.time(st);
    ingest(b.body, full(E[el]));
    check(`cpu: ${st} by touching and by drinking ${el}`, a.body.status.has(st) && b.body.status.has(st) && Math.abs(b.body.status.time(st) - 2 * one) < 1e-6,
      { touch: +a.body.status.time(st).toFixed(1), drink: one, twoDrinks: b.body.status.time(st) });
  }
  { const a = makeBody(); a.vitals.hurt(0.7, 'test'); ingest(a.body, full(E.HEALTHIUM)); a.run(2); check('cpu: Regeneration heals 10% a second', Math.abs(a.body.health - (0.3 + 2 * POTION_TIMES.REGEN_RATE)) < 0.02, { health: +a.body.health.toFixed(3) }); }
  { const a = makeBody(); ingest(a.body, full(E.BERSERKIUM)); ingest(a.body, full(E.POLYMORPHINE)); check('cpu: Berserk 2× dealt, Polymorph no tools', a.body.status.damageScale === 2 && a.body.status.noTools, {}); }
  {
    const floor = 4;   // a flat rock floor's top, 64³
    const world = { dims: [64, 64, 64], standAt: () => floor, id: (x, y) => (y < floor ? E.ROCK : E.EMPTY), blocks: (x, y) => y < floor, isLiquid: () => false, hotNear: () => false };
    const s = safeSpot(world, { x: 32, y: floor, z: 32 });
    const d = s ? Math.hypot(s.x - 32, s.z - 32) : 0;
    const lake = { ...world, id: (x, y) => (y < floor ? E.WATER : E.EMPTY), blocks: () => false, isLiquid: (x, y) => y < floor };
    check('cpu: Teleportitis finds a spot on rock in reach, none on a lake', s && s.y === floor && d >= POTION_TIMES.TELEPORT_MIN && d <= POTION_TIMES.TELEPORT_MAX && safeSpot(lake, { x: 32, y: floor, z: 32 }) === null, { s, d: +d.toFixed(1) });
  }
}
if (cpuOnly) { console.log(fails ? `${fails} failed` : 'all ok'); process.exit(fails ? 1 : 0); }

// ================= part 1: the toolbelt alone (the POV tools' harness page, stage flask: no app)
if (!appOnly) fails += await runStages(['flask'], { page: TOOLS_PAGE });

// ================= part 2: the real shell and body (the app at 64³, its frames run by the check: tools/pov-app.mjs)
let app = null;
try {
  app = await openPovApp({ viewport: { width: W, height: H } });
  const p = app.page;
  console.log(`\nthe shell and body (boot ${app.boot.toFixed(0)} s)`);
  const frames = (n) => p.evaluate((n) => __pov.frames(n), n);
  // a key held for a few frames, then the frames after it (game time: the frames' dt)
  const press = async (key, held = 3, after = 9) => { await p.keyboard.down(key); await frames(held); await p.keyboard.up(key); await frames(after); };
  const entered = await app.enter();
  check('drops into the body', entered.mode === 'on' && entered.onGround, entered);
  await p.evaluate(() => window.__app.pov.toolbelt.select('FLASK'));
  await frames(15);
  // H: a gulp of water through the body
  const h0 = await p.evaluate(() => { const pl = window.__app.pov.player; return { health: pl.health, skinT: pl.skinT, n: window.__app.pov.toolbelt.tool('FLASK').load.count }; });
  await press('h');
  const h1 = await p.evaluate(() => { const pov = window.__app.pov, f = pov.toolbelt.tool('FLASK'); return { health: pov.player.health, skinT: pov.player.skinT, n: f.load.count, body: f.lastDrink?.body, doses: f.lastDrink?.doses.map((d) => [d.key, d.n]) }; });
  check('H drinks through the body (water: no harm)', h1.n === h0.n - DRINK_CELLS && h1.body === true && h1.health === h0.health, { h0, h1 });
  if (shot) {
    await p.evaluate(() => { const l = window.__app.pov.toolbelt.tool('FLASK').load; l.cells.splice(0, 60); l.version++; });   // show a half-full flask
    await frames(12);
    await p.evaluate(() => __app.test.renderOnce());
    await p.screenshot({ path: shot, scale: 'css' });
  }
  // whiskey's row (the element comes with nt-mat): the view sways
  const dr = await p.evaluate(async () => {
    const { ingestionRow } = await import('/src/pov/ingest.js');
    const pov = window.__app.pov;
    ingestionRow('WHISKEY')(pov.player, { share: 1 });
    const d0 = pov.feel.drunk;
    await __pov.frames(Math.round(2.5 / __pov.dt));
    return { d0, d1: pov.feel.drunk, sway: pov.feel.drunkSway, roll: pov.feel.offsets.roll };
  });
  check('whiskey: 30 s of Drunk, and the view sways', Math.abs(dr.d0 - 30) < 0.5 && dr.sway > 0.05 && dr.d1 < dr.d0, dr);
  // ================= Noita's potions (potions.js): each status by touch and by drink, through the real body
  const POTIONS = [['LEVITATIUM', 'LEVITATING'], ['TELEPORTATIUM', 'TELEPORTITIS'], ['HEALTHIUM', 'REGENERATION'],
    ['BERSERKIUM', 'BERSERK'], ['PHEROMONE', 'CHARMED'], ['POLYMORPHINE', 'POLYMORPH'], ['TOXIC', 'TOXIC']];
  const POOL_R = 2;   // cells: the pool painted round the legs
  // touch: a pool round the legs until the status comes on (or 3 s of frames),
  // then the grid cleared (the empty box again) and so are the statuses. (An
  // erase brush leaves the cells that ran out of it, a film over the floor that
  // never sleeps, and a 64³ grid awake costs SwiftShader seconds a frame.)
  const touch = (key, status) => p.evaluate(async ([key, status, POOL_R]) => {
    const { E } = await import('/src/elements.js');
    const a = window.__app, pl = a.pov.player, V3 = a.camera.position.constructor;
    pl.status.clearAll();
    const c = new V3(pl.pos.x, pl.pos.y + POOL_R, pl.pos.z);
    a.sim.paint({ center: c, radius: POOL_R, shape: 1, tool: E[key], rate: 4, replace: true });
    const n = await __pov.frames(Math.round(3 / __pov.dt), () => pl.status.has(status));
    const on = pl.status.has(status), left = pl.status.time(status);
    a.sim.clear();
    for (let i = 0; i < 30; i++) { await __pov.frames(1); if ((await a.sim.readCounts()).awake === 0) break; }
    pl.status.clearAll();
    return { on, left: +left.toFixed(1), frames: n };
  }, [key, status, POOL_R]);
  // drink: a flask of it, H through the shell
  const fill = (key, n = 26) => p.evaluate(async ([key, n]) => {
    const { E, ELEMENTS } = await import('/src/elements.js');
    const pov = window.__app.pov, l = pov.toolbelt.tool('FLASK').load;
    pov.player.status.clearAll();
    l.cells.length = 0;
    for (let i = 0; i < n; i++) l.cells.push([E[key], ELEMENTS[E[key]].temp, 0, 0.5]);
    l.version++;
  }, [key, n]);
  const statusOf = (status) => p.evaluate((s) => { const pl = window.__app.pov.player; return { on: pl.status.has(s), left: +pl.status.time(s).toFixed(1) }; }, status);
  await p.evaluate(() => { const pl = window.__app.pov.player; pl.spawn(pl.pos.clone()); });   // full health, no drunk carry-over
  await frames(20);
  for (const [key, status] of POTIONS) {
    const t = await touch(key, status);
    check(`${status} by touching ${key}`, t.on, t);
    await fill(key);
    await frames(9);   // the tool back in hand (Polymorph's touch put it away)
    await press('h', 2, 8);
    const d = await statusOf(status);
    check(`${status} by drinking ${key}`, d.on, d);
    await p.evaluate(() => window.__app.pov.player.status.clearAll());
    await frames(20);   // the gulp's refire wait
  }
  // what they do
  const fx = await p.evaluate(async () => {
    const pov = window.__app.pov, pl = pov.player, belt = pov.toolbelt;
    const { dealtScale } = await import('/src/pov/targets.js');
    const out = {};
    // Regeneration heals 10% of a life a second
    pl.hurt(0.5, 'test', { shielded: false });
    const h0 = pl.health;
    pl.status.add('REGENERATION', 7.5);
    await __pov.frames(Math.round(1.5 / __pov.dt));
    out.regen = { h0: +h0.toFixed(2), h1: +pl.health.toFixed(2) };
    pl.status.clearAll();
    // Berserk doubles what the player's weapons deal
    out.berserk = { off: dealtScale(null) };
    pl.status.add('BERSERK', 15);
    out.berserk.on = dealtScale(null);
    pl.status.clearAll();
    // Polymorph: no tools (the flask's gulp does nothing)
    belt.select('FLASK');
    out.poly = { n0: belt.tool('FLASK').load.count };
    pl.status.add('POLYMORPH', 20);
    return out;
  });
  await press('h', 2, 8);
  fx.poly.n1 = await p.evaluate(() => window.__app.pov.toolbelt.tool('FLASK').load.count);
  await p.evaluate(() => window.__app.pov.player.status.clearAll());
  check('Regeneration heals ~10% a second', fx.regen.h1 - fx.regen.h0 > 0.08, fx.regen);
  check('Berserk: the player\'s weapons deal 2×', fx.berserk.off === 1 && fx.berserk.on === 2, fx.berserk);
  check('Polymorph: no tools (H does nothing)', fx.poly.n1 === fx.poly.n0, fx.poly);
  // Levitating: hold jump in the air: the jet climbs and the tank holds
  const lev = await p.evaluate(() => { const pl = window.__app.pov.player; pl.status.add('LEVITATING', 20); return { y0: pl.pos.y }; });
  await press('Space', 45, 0);
  const lev1 = await p.evaluate(() => { const pl = window.__app.pov.player; return { y1: pl.pos.y, fuel: pl.jetFuel, jetting: pl.jetting }; });
  await p.evaluate(() => window.__app.pov.player.status.clearAll());
  await frames(36);
  check('Levitating: flies on a full tank', lev1.y1 - lev.y0 > 5 && lev1.fuel === 1, { ...lev, ...lev1 });
  // Teleportitis: jumps to a safe open spot within a few seconds
  const tp = await p.evaluate(async () => {
    const pov = window.__app.pov, pl = pov.player;
    const jumps = [];
    const off = pov.events.on('teleport', (e) => { if (!e.by) jumps.push({ from: e.from.toArray().map(Math.round), to: e.to.toArray().map(Math.round) }); });
    pl.status.add('TELEPORTITIS', 5);
    const n = await __pov.frames(Math.round(6 / __pov.dt), () => jumps.length > 0);
    off();
    pl.status.clearAll();
    await __pov.frames(Math.round(0.8 / __pov.dt));
    return { jumps, frames: n, health: +pl.health.toFixed(2), onGround: pl.onGround, dead: pl.dead };
  });
  check('Teleportitis: a jump to a safe spot, and the body stands there', tp.jumps.length > 0 && !tp.dead && tp.onGround, tp);
  // a flask of lava: one gulp kills, and says so
  await p.evaluate(async () => {
    const { E, ELEMENTS } = await import('/src/elements.js');
    const pov = window.__app.pov, l = pov.toolbelt.tool('FLASK').load;
    l.cells.length = 0;
    for (let i = 0; i < 20; i++) l.cells.push([E.LAVA, ELEMENTS[E.LAVA].temp, 0, 0.5]);
    l.version++;
    pov.player.perks.clear();
  });
  await press('h');
  const dead = await p.evaluate(() => ({ dead: window.__app.pov.player.dead, cause: window.__app.pov.player.cause }));
  check('a gulp of lava kills, with its cause', dead.dead && /Drank lava, 1,600 °C/.test(dead.cause), dead);
  check(`no page or GPU errors (${app.secs()})`, !app.errors.length, app.errors.slice(0, 5).join(' | '));
} catch (err) {
  fails++;
  console.log('FAIL', err.message);
} finally {
  await app?.close();
}
console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
