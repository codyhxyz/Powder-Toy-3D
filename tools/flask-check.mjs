// Check of Noita's potion flask (src/pov/tools/flask.tool.js, src/pov/ingest.js).
// Part 1 drives the toolbelt with a hand-built ctx and proves matter is conserved
// with sim.census() plus every load while the sim runs: the starting water pours
// out, the flask fills from a pool, a drink takes Noita's share of each material,
// sand mixes in, and a throw shatters it into exactly FLASK_GLASS cells of
// broken glass plus everything it held. Part 2 goes through the real shell and
// body: H drinks, lava kills with its cause, whiskey's row sways the view.
// usage: node tools/flask-check.mjs [--port 5433] [--shot file.png]   (needs a dev server; AC power)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5433');
const shot = opt('shot');
const W = 960, H = 600;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`); };
const zero = (d) => Object.keys(d).length === 0;

try {
  // ================= part 1: the toolbelt alone
  await p.goto(`http://localhost:${port}/?preset=empty&size=64`);
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
  await p.goto(`http://localhost:${port}/?preset=empty&size=64`);
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.mouse.move(W / 2, H * 0.62);
  await p.keyboard.press('f');
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
