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
// usage: node tools/flask-check.mjs [--cpu] [--port 5433] [--shot file.png]
//   --cpu: the node part only; without it the GPU part follows (needs a dev server; AC power)
import { chromium } from 'playwright';
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
const port = opt('port', '5433');
const shot = opt('shot');
const cpuOnly = args.includes('--cpu');
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

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));

try {
  // ================= part 1: the toolbelt alone
  await p.goto(`http://localhost:${port}/?preset=empty&size=64`, { timeout: 90000 });
  await p.waitForFunction(() => window.__app?.sim, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  const r = await p.evaluate(async () => {
    const a = window.__app;
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { createToolbelt } = await import('/src/pov/tools/index.js');
    const { FLASK_CAP, DRINK_CELLS, FLASK_GLASS } = await import('/src/pov/tools/flask.tool.js');
    const { inventory } = await import('/src/pov/tools/inventory.js');
    const V3 = a.camera.position.constructor;
    const Group = Object.getPrototypeOf(a.scene.constructor);
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    const wait = async (n) => { for (let i = 0; i < n; i++) await frame(); };
    const sim = () => a.sim;
    const toasts = [];
    const env = {
      renderer: a.renderer, scene: a.scene, getSim: sim, getVolume: () => a.volume, getScale: () => a.scale,
      hud: { toast: (t) => toasts.push(t) }, viewmodel: new Group(), isActive: () => true,
    };
    const belt = createToolbelt(env);
    belt.setVisible(true);
    belt.select('FLASK');
    const flask = belt.tool('FLASK');
    const cell = (x, y, z) => Math.round(sim().readCell(x, y, z)[0][0]);
    const top = (x, z) => { for (let y = sim().g.ny - 1; y >= 0; y--) if (cell(x, y, z) !== E.EMPTY) return y; return -1; };
    // matter: the grid plus the flask, plus any broken flask still spilling
    const extra = new Set();
    function totals() {
      const c = sim().census();
      const t = {};
      for (const k in c) if (+k !== E.EMPTY) t[ELEMENTS[k].key] = c[k].n;
      for (const load of [flask.load, ...extra]) for (const [id, n] of Object.entries(load.totals())) t[ELEMENTS[id].key] = (t[ELEMENTS[id].key] ?? 0) + n;
      return t;
    }
    const diff = (x, y) => Object.fromEntries([...new Set([...Object.keys(x), ...Object.keys(y)])]
      .map((k) => [k, (y[k] ?? 0) - (x[k] ?? 0)]).filter(([, d]) => d));
    const settle = async () => { while (belt.transfer.pending || flask.spilling) await frame(); await wait(2); };
    const body = { skinT: 37, dead: false, hurts: [], hurt(amount, cause, o) { this.hurts.push({ amount: +amount.toFixed(3), cause, o }); } };
    const player = { pos: new V3(32, 0, 14), vel: new V3(), onGround: true, inLiquid: false, applyImpulse() {}, body };
    function ctx(aimCell, id, extraCtx = {}) {
      const eye = aimCell ? new V3(aimCell.x + 0.5, aimCell.y + 3.5, aimCell.z - 1.5) : new V3(32, 8, 32);
      const dir = aimCell ? new V3(aimCell.x + 0.5, aimCell.y + 0.5, aimCell.z + 0.5).sub(eye).normalize() : new V3(0, -0.5, 1).normalize();
      return {
        sim: sim(), dt: 1 / 60, stepsPerFrame: a.settings.steps, eye, dir, toolRate: 1,
        primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0,
        aim: aimCell ? { valid: true, cell: aimCell, face: 2, id, T: 20, P: 0, dist: 3 } : { valid: false },
        player, drink: false, drinkPressed: false, ...extraCtx,
      };
    }
    const out = { FLASK_CAP, DRINK_CELLS, FLASK_GLASS };
    const named = (t) => Object.fromEntries(Object.entries(t).map(([id, n]) => [ELEMENTS[id].key, n]));

    // ---- scene: a water pool in a wall basin, a sand heap, a wall to throw at
    const paint = (center, radius, tool, shape = 1) => sim().paint({ center: new V3(...center), radius, shape, tool, rate: 4, replace: true });
    paint([46, 2, 46], 6, E.WALL);
    paint([46, 3, 46], 5, E.WATER);
    paint([16, 4, 16], 4, E.SAND);
    paint([32, 6, 54], 5, E.WALL);
    await wait(120);

    // ---- the start: one flask, full of water
    out.start = { inHand: flask.inHand, status: flask.status(), totals: named(flask.load.totals()) };

    // ---- left-click at nothing in reach pours: the starting water goes into the world
    const t0 = totals();
    const pourCtx = (o) => ({ ...ctx(null, -1, o), eye: new V3(24, 12, 24), dir: new V3(0.3, -0.2, 0.93).normalize() });
    for (let i = 0; i < 400 && flask.load.count; i++) { belt.update(pourCtx({ primary: true, primaryPressed: i === 0 })); await frame(); }
    await settle();
    out.pour = { left: flask.load.count, diff: diff(t0, totals()) };

    // ---- empty, it scoops: fill from the pool
    const t1 = totals();
    for (let i = 0; i < 240 && flask.load.free > 0; i++) {
      const y = top(46, 46);
      belt.update(ctx(new V3(46, y, 46), cell(46, y, 46), { primary: true, primaryPressed: i === 0 }));
      await frame();
    }
    await settle();
    out.fill = { count: flask.load.count, status: flask.status(), diff: diff(t1, totals()) };
    // full and pointed at the pool: a press pours there instead of scooping
    const tFull = totals();
    {
      const y = top(46, 46);
      for (let i = 0; i < 12; i++) { belt.update(ctx(new V3(46, y, 46), cell(46, y, 46), { primary: true, primaryPressed: i === 0 })); await frame(); }
      belt.update(ctx(new V3(46, y, 46), cell(46, y, 46)));
      await settle();
    }
    out.fullPress = { count: flask.load.count, diff: diff(tFull, totals()) };

    // ---- a drink: DRINK_CELLS, water quenches a hot skin and cools it toward the water
    body.skinT = 70;
    const t2 = totals();
    belt.update(ctx(null, -1, { drink: true, drinkPressed: true }));
    belt.update(ctx(null, -1));
    out.drink = { count: flask.load.count, doses: flask.lastDrink?.doses.map((d) => ({ key: d.key, n: d.n, share: +d.share.toFixed(2), T: Math.round(d.T) })),
      skinT: +body.skinT.toFixed(1), hurts: body.hurts.length, diff: diff(t2, totals()) };

    // ---- pointed at sand with room: it scoops sand in on top (mixed)
    const t3 = totals();
    for (let i = 0; i < 60 && flask.load.free > 0; i++) {
      const y = top(16, 16);
      belt.update(ctx(new V3(16, y, 16), cell(16, y, 16), { primary: true, primaryPressed: i === 0 }));
      await frame();
    }
    await settle();
    out.mix = { status: flask.status(), totals: named(flask.load.totals()), diff: diff(t3, totals()) };

    // ---- a mixed drink: Noita's same share of each material
    for (let i = 0; i < 45; i++) { belt.update(ctx(null, -1)); await frame(); }   // past the gulp's refire wait
    await settle();
    const before = named(flask.load.totals());
    belt.update(ctx(null, -1, { drink: true, drinkPressed: true }));
    belt.update(ctx(null, -1));
    out.mixedDrink = { before, doses: flask.lastDrink?.doses.map((d) => ({ key: d.key, n: d.n })) };

    // ---- throw: it flies, strikes the wall and shatters: contents + FLASK_GLASS shards, nothing else
    const held = named(flask.load.totals());
    const t4 = totals();
    const throwCtx = (o) => ({ ...ctx(null, -1, o), eye: new V3(32.5, 5, 14.5), dir: new V3(0, 0.15, 1).normalize() });
    belt.update(throwCtx({ secondary: true, secondaryPressed: true }));
    out.afterThrow = { inHand: flask.inHand, flying: flask.flying, left: flask.load.count };
    let frames = 0;
    for (; frames < 300 && (flask.flying || !flask.lastShatter); frames++) { belt.update(throwCtx()); await frame(); }
    if (flask.lastShatter) extra.add(flask.lastShatter.load);
    await settle();
    await wait(30);
    const sh = flask.lastShatter;
    out.shatter = sh ? { frames, point: [sh.point.x, sh.point.y, sh.point.z].map((v) => +v.toFixed(1)), held: sh.held, glass: sh.glass, id: ELEMENTS[sh.id]?.key,
      spillLeft: sh.load.count, lost: flask.lost } : null;
    out.throwDiff = { held, diff: diff(t4, totals()) };

    // ---- empty-handed: every button refuses
    toasts.length = 0;
    belt.update(ctx(null, -1, { primary: true, primaryPressed: true }));
    belt.update(ctx(null, -1, { drink: true, drinkPressed: true }));
    out.noFlask = { status: flask.status(), toasts: [...toasts] };

    // ---- the palette gives another: a fresh flask of water
    inventory.give('FLASK');
    out.given = { inHand: flask.inHand, status: flask.status() };
    belt.setVisible(false);
    belt.dispose();
    return out;
  });
  console.log(JSON.stringify(r));
  const { FLASK_CAP: CAP, DRINK_CELLS: DRINK, FLASK_GLASS: GLASS } = r;
  check('starts with one flask of water', r.start.inHand && r.start.status === 'WATR 100%' && r.start.totals.WATER === CAP && Object.keys(r.start.totals).length === 1, r.start);
  check('pouring puts every cell in the world', r.pour.left === 0 && zero(r.pour.diff), r.pour);
  check('empty, it scoops from the pool to full', r.fill.count === CAP && zero(r.fill.diff), r.fill);
  check('full and aimed at the pool, a press pours (no scoop)', r.fullPress.count < CAP && zero(r.fullPress.diff), r.fullPress);
  check('a drink takes a full gulp and quenches', r.drink.doses?.[0]?.key === 'WATER' && r.drink.doses[0].n === DRINK && r.drink.skinT < 37 && r.drink.hurts === 0
    && r.drink.diff.WATER === -DRINK, r.drink);
  check('sand scoops in on top: mixed', /\+/.test(r.mix.status) && r.mix.totals.SAND > 0 && r.mix.totals.WATER > 0 && zero(r.mix.diff), r.mix);
  {
    const before = r.mixedDrink.before, doses = r.mixedDrink.doses ?? [];
    const tot = Object.values(before).reduce((s, n) => s + n, 0);
    const ok = doses.length === Object.keys(before).length && doses.reduce((s, d) => s + d.n, 0) === DRINK
      && doses.every((d) => Math.abs(d.n - (DRINK * before[d.key]) / tot) < 1);
    check('a mixed drink takes the same share of each', ok, r.mixedDrink);
  }
  check('the throw empties the hand', !r.afterThrow.inHand && r.afterThrow.flying === 1 && r.afterThrow.left === 0, r.afterThrow);
  {
    const d = r.throwDiff.diff, held = r.throwDiff.held;
    const heldN = Object.values(held).reduce((s, n) => s + n, 0);
    const onlyGlass = Object.keys(d).length === 1 && d.SHARDS === GLASS;
    check('the shatter lands: spill done, nothing lost', r.shatter && r.shatter.spillLeft === 0 && r.shatter.lost === 0 && r.shatter.held === heldN, r.shatter);
    check('conserved: contents + exactly FLASK_GLASS shards', onlyGlass, r.throwDiff);
  }
  check('no flask: the buttons refuse', r.noFlask.status === 'none' && r.noFlask.toasts.some((t) => /No flask/.test(t)), r.noFlask);
  check('the palette gives a fresh flask of water', r.given.inHand && r.given.status === 'WATR 100%', r.given);

  // ================= part 2: the real shell and body
  await p.goto(`http://localhost:${port}/?preset=empty&size=64`, { timeout: 90000 });
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.mouse.move(W / 2, H * 0.62);
  await p.keyboard.press('v');   // V: into the body (app.js)
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });
  await p.evaluate(() => { window.__app.pov.test.assumeLocked = true; window.__app.pov.toolbelt.select('FLASK'); });
  await p.waitForTimeout(500);
  // H: a gulp of water through the body
  const h0 = await p.evaluate(() => { const pl = window.__app.pov.player; return { health: pl.health, skinT: pl.skinT, n: window.__app.pov.toolbelt.tool('FLASK').load.count }; });
  await p.keyboard.down('h');
  await p.waitForTimeout(100);
  await p.keyboard.up('h');
  await p.waitForTimeout(300);
  const h1 = await p.evaluate(() => { const pov = window.__app.pov, f = pov.toolbelt.tool('FLASK'); return { health: pov.player.health, skinT: pov.player.skinT, n: f.load.count, body: f.lastDrink?.body, doses: f.lastDrink?.doses.map((d) => [d.key, d.n]) }; });
  check('H drinks through the body (water: no harm)', h1.n === h0.n - 13 && h1.body === true && h1.health === h0.health, { h0, h1 });
  if (shot) {
    await p.evaluate(() => { const l = window.__app.pov.toolbelt.tool('FLASK').load; l.cells.splice(0, 60); l.version++; });   // show a half-full flask
    await p.waitForTimeout(400);
    await p.screenshot({ path: shot, scale: 'css' });
  }
  // whiskey's row (the element comes with nt-mat): the view sways
  const dr = await p.evaluate(async () => {
    const { ingestionRow } = await import('/src/pov/ingest.js');
    const pov = window.__app.pov;
    ingestionRow('WHISKEY')(pov.player, { share: 1 });
    const d0 = pov.feel.drunk;
    await new Promise((res) => setTimeout(res, 2500));
    return { d0, d1: pov.feel.drunk, sway: pov.feel.drunkSway, roll: pov.feel.offsets.roll };
  });
  check('whiskey: 30 s of Drunk, and the view sways', Math.abs(dr.d0 - 30) < 0.5 && dr.sway > 0.05 && dr.d1 < dr.d0, dr);
  // ================= Noita's potions (potions.js): each status by touch and by drink, through the real body
  const POTIONS = [['LEVITATIUM', 'LEVITATING'], ['TELEPORTATIUM', 'TELEPORTITIS'], ['HEALTHIUM', 'REGENERATION'],
    ['BERSERKIUM', 'BERSERK'], ['PHEROMONE', 'CHARMED'], ['POLYMORPHINE', 'POLYMORPH'], ['TOXIC', 'TOXIC']];
  const ERASE = -1;   // the Erase brush's id (elements.js TOOLS)
  const POOL_R = 2;   // cells: the pool painted round the legs
  const potionRun = (fn, arg) => p.evaluate(fn, arg);
  // touch: a pool round the legs until the status comes on (or 3 s), then the pool goes and so do the statuses
  const touch = (key, status) => potionRun(async ([key, status, ERASE, POOL_R]) => {
    const { E } = await import('/src/elements.js');
    const a = window.__app, pl = a.pov.player, V3 = a.camera.position.constructor;
    pl.status.clearAll();
    const c = new V3(pl.pos.x, pl.pos.y + POOL_R, pl.pos.z);
    a.sim.paint({ center: c, radius: POOL_R, shape: 1, tool: E[key], rate: 4, replace: true });
    const t0 = performance.now();
    while (!pl.status.has(status) && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
    const on = pl.status.has(status), left = pl.status.time(status), ms = Math.round(performance.now() - t0);
    a.sim.paint({ center: c, radius: POOL_R + 2, shape: 1, tool: ERASE, rate: 4, replace: true });
    await new Promise((r) => setTimeout(r, 300));
    pl.status.clearAll();
    return { on, left: +left.toFixed(1), ms };
  }, [key, status, ERASE, POOL_R]);
  // drink: a flask of it, H through the shell
  const fill = (key, n = 26) => potionRun(async ([key, n]) => {
    const { E, ELEMENTS } = await import('/src/elements.js');
    const pov = window.__app.pov, l = pov.toolbelt.tool('FLASK').load;
    pov.player.status.clearAll();
    l.cells.length = 0;
    for (let i = 0; i < n; i++) l.cells.push([E[key], ELEMENTS[E[key]].temp, 0, 0.5]);
    l.version++;
  }, [key, n]);
  const gulp = async () => { await p.keyboard.down('h'); await p.waitForTimeout(80); await p.keyboard.up('h'); await p.waitForTimeout(250); };
  const statusOf = (status) => potionRun((s) => { const pl = window.__app.pov.player; return { on: pl.status.has(s), left: +pl.status.time(s).toFixed(1) }; }, status);
  await p.evaluate(() => { const pl = window.__app.pov.player; pl.spawn(pl.pos.clone()); });   // full health, no drunk carry-over
  await p.waitForTimeout(700);
  for (const [key, status] of POTIONS) {
    const t = await touch(key, status);
    check(`${status} by touching ${key}`, t.on, t);
    await fill(key);
    await p.waitForTimeout(300);   // a frame for the tool to come back to hand (Polymorph's touch put it away)
    await gulp();
    const d = await statusOf(status);
    check(`${status} by drinking ${key}`, d.on, d);
    await p.evaluate(() => window.__app.pov.player.status.clearAll());
    await p.waitForTimeout(650);   // the gulp's refire wait
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
    await new Promise((r) => setTimeout(r, 1500));
    out.regen = { h0: +h0.toFixed(2), h1: +pl.health.toFixed(2) };
    pl.status.clearAll();
    // Berserk doubles what the player's weapons deal
    out.berserk = { off: dealtScale(null) };
    pl.status.add('BERSERK', 15);
    out.berserk.on = dealtScale(null);
    pl.status.clearAll();
    // Polymorph: no tools (the flask's gulp does nothing)
    belt.select('FLASK');
    const n0 = belt.tool('FLASK').load.count;
    pl.status.add('POLYMORPH', 20);
    out.poly = { n0 };
    return out;
  });
  await gulp();
  fx.poly.n1 = await p.evaluate(() => window.__app.pov.toolbelt.tool('FLASK').load.count);
  await p.evaluate(() => window.__app.pov.player.status.clearAll());
  check('Regeneration heals ~10% a second', fx.regen.h1 - fx.regen.h0 > 0.08, fx.regen);
  check('Berserk: the player\'s weapons deal 2×', fx.berserk.off === 1 && fx.berserk.on === 2, fx.berserk);
  check('Polymorph: no tools (H does nothing)', fx.poly.n1 === fx.poly.n0, fx.poly);
  // Levitating: hold jump in the air: the jet climbs and the tank holds
  const lev = await p.evaluate(async () => {
    const pl = window.__app.pov.player;
    pl.status.add('LEVITATING', 20);
    return { y0: pl.pos.y };
  });
  await p.keyboard.down('Space');
  await p.waitForTimeout(1500);
  const lev1 = await p.evaluate(() => { const pl = window.__app.pov.player; return { y1: pl.pos.y, fuel: pl.jetFuel, jetting: pl.jetting }; });
  await p.keyboard.up('Space');
  await p.evaluate(() => window.__app.pov.player.status.clearAll());
  await p.waitForTimeout(1200);
  check('Levitating: flies on a full tank', lev1.y1 - lev.y0 > 5 && lev1.fuel === 1, { ...lev, ...lev1 });
  // Teleportitis: jumps to a safe open spot within a few seconds
  const tp = await p.evaluate(async () => {
    const pov = window.__app.pov, pl = pov.player;
    const jumps = [];
    const off = pov.events.on('teleport', (e) => { if (!e.by) jumps.push({ from: e.from.toArray().map(Math.round), to: e.to.toArray().map(Math.round) }); });
    pl.status.add('TELEPORTITIS', 5);
    const t0 = performance.now();
    while (!jumps.length && performance.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 100));
    off();
    pl.status.clearAll();
    await new Promise((r) => setTimeout(r, 800));
    return { jumps, ms: Math.round(performance.now() - t0), health: +pl.health.toFixed(2), onGround: pl.onGround, dead: pl.dead };
  });
  check('Teleportitis: a jump to a safe spot, and the body stands there', tp.jumps.length > 0 && !tp.dead && tp.onGround, tp);
  // a flask of lava: one gulp kills, and says so
  const lava = await p.evaluate(async () => {
    const { E, ELEMENTS } = await import('/src/elements.js');
    const pov = window.__app.pov, l = pov.toolbelt.tool('FLASK').load;
    l.cells.length = 0;
    for (let i = 0; i < 20; i++) l.cells.push([E.LAVA, ELEMENTS[E.LAVA].temp, 0, 0.5]);
    l.version++;
    pov.player.perks.clear();
    return true;
  });
  await p.keyboard.down('h');
  await p.waitForTimeout(100);
  await p.keyboard.up('h');
  await p.waitForTimeout(300);
  const dead = await p.evaluate(() => ({ dead: window.__app.pov.player.dead, cause: window.__app.pov.player.cause }));
  check('a gulp of lava kills, with its cause', lava && dead.dead && /Drank lava, 1,600 °C/.test(dead.cause), dead);
} catch (err) {
  fails++;
  console.log('FAIL', err.message);
}
if (errs.length) { console.log(errs.join('\n')); }
console.log(fails ? `${fails} failed` : 'all ok');
await b.close();
process.exit(fails ? 1 : 0);
