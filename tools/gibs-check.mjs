// Gibs and cooking check (docs/pov.md "Gibs and eating"): meat cooks in the
// engine's heat and chars past its fat's flash point, Quake's gib rule, and
// eating cooked meat. The CPU part runs in node (the dock tiles' engine port,
// src/ui/tiles/engine.js, and vitals.js); --port adds one headless GPU run
// against a dev server: meat cooked and charred in the real sim, a rocket kill
// that gibs an NPC into the body's mass in meat, and cooked meat eaten (raw
// meat not).
// usage: node tools/gibs-check.mjs [--port 5422] [--shots dir]   (--port: a dev server; AC power)
import { World } from '../src/ui/tiles/engine.js';
import { E, ELEMENTS } from '../src/elements.js';
import { createVitals, GIB_HEALTH, EAT_HEAL, VITALS } from '../src/pov/vitals.js';
import { GIB_CELLS } from '../src/pov/meat.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', null);
const shots = opt('shots', null);

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };

// ---------------------------------------------------------------- CPU: cooking (tile engine)
const TILE_W = 32, TILE_H = 24, SIM_G = 0.025;
const count = (w) => { const c = {}; for (const id of w.id) c[id] = (c[id] ?? 0) + 1; return c; };
const n = (c, k) => c[E[k]] ?? 0;
function slab(w, x0, x1, y0, y1, id) { for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) w.put(x, y, id); }
function cook(name, setup, steps, feed = null) {
  const w = new World(TILE_W, TILE_H); w.gravity = SIM_G;
  slab(w, 12, 20, 0, 3, E.MEAT);
  setup?.(w);
  let cookedAt = -1, peakCooked = 0;
  for (let s = 1; s <= steps; s++) {
    feed?.(w, s);
    w.step();
    const c = count(w);
    if (cookedAt < 0 && n(c, 'COOKED_MEAT') > 0) cookedAt = s;
    peakCooked = Math.max(peakCooked, n(c, 'COOKED_MEAT'));
  }
  const c = count(w);
  return { name, raw: n(c, 'MEAT'), cooked: n(c, 'COOKED_MEAT'), ash: n(c, 'ASH'), cookedAt, peakCooked };
}
const MEAT0 = 24;
// left alone at room temperature it stays raw
const idle = cook('room', null, 400);
check('meat at 20 °C stays raw', idle.raw === MEAT0, JSON.stringify(idle));
// lava beside it: cooked through
const lava = cook('lava', (w) => { slab(w, 4, 11, 0, 3, E.LAVA); slab(w, 21, 28, 0, 3, E.LAVA); }, 300);
check('lava cooks meat', lava.raw === 0 && lava.cooked + lava.ash === MEAT0, JSON.stringify(lava));
// fire fed on top: cooks, then the top chars past 320 °C and burns to ash
const fire = cook('fire', null, 900, (w) => { for (let x = 12; x < 20; x++) if (w.id[w.idx(x, 3)] === E.EMPTY && Math.random() < 0.5) w.put(x, 3, E.FIRE); });
check('fire cooks meat, then chars it to ash', fire.cookedAt > 0 && fire.raw === 0 && fire.ash > 0, JSON.stringify(fire));
// a steamer: a walled box, steam fed at the floor's corners (it condenses on the meat: latent heat)
const steam = cook('steamer', (w) => {
  for (let y = 0; y < 14; y++) { w.put(8, y, E.WALL); w.put(23, y, E.WALL); }
  for (let x = 8; x < 24; x++) w.put(x, 14, E.WALL);
}, 1500, (w) => { for (const x of [9, 22]) if (w.id[w.idx(x, 0)] === E.EMPTY) w.put(x, 0, E.STEAM); });
check('steam cooks meat (steamer), never chars it', steam.raw === 0 && steam.cooked === MEAT0, JSON.stringify(steam));
// the Heat brush (the flamethrower's job in god view), held: cooked, then charred
const heat = cook('heat brush', null, 1200, (w, s) => { if (s % 4 === 0) w.heat(16, 1.5, 4); });
check('heat cooks, then chars', heat.cookedAt > 0 && heat.raw === 0 && heat.ash > 0, JSON.stringify(heat));
// the latent heat: meat pins at 71 °C while the denaturation heat banks, then cooks
{
  const w = new World(5, 5); w.gravity = 0;
  const HOT_METAL_T = 80;   // °C, metal round the meat (it conducts fast)
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) w.put(x, y, E.METAL, { T: HOT_METAL_T });
  w.put(2, 2, E.MEAT, { T: 70 });
  const i = w.idx(2, 2), Tc = ELEMENTS[E.MEAT].hot.T;
  let pinned = null, cookedAt = -1;
  for (let s = 1; s <= 20 && cookedAt < 0; s++) {
    w.step();
    if (w.id[i] === E.MEAT && Math.abs(w.T[i] - Tc) < 1e-4 && w.life[i] > 0) pinned ??= { s, banked: +w.life[i].toFixed(3) };
    if (w.id[i] === E.COOKED_MEAT) cookedAt = s;
  }
  check('meat banks its latent heat at 71 °C, then cooks', !!pinned && cookedAt > pinned.s, `pinned ${JSON.stringify(pinned)}, cooked at step ${cookedAt}`);
}

// ---------------------------------------------------------------- CPU: Quake's gib rule (vitals.js)
const BLAST_P = 140;                       // a rocket's pressure (docs/pov.md "Guns")
const BLAST_S = 0.12;                      // s it stands over the body
const env0 = { contactId: [], contactT: [], contactN: 0, headInLiquid: false, liquidId: E.WATER, buriedId: -1, pressure: 0 };
function blastAt(fps, pressure = BLAST_P, health = 1) {
  const ev = [];
  const v = createVitals((name, d) => ev.push(name));
  v.health = health;
  const dt = 1 / fps;
  for (let t = 0; t < BLAST_S; t += dt) v.update(dt, { ...env0, pressure });
  for (let t = 0; t < 1; t += dt) v.update(dt, env0);   // the corpse, after
  return { dead: v.dead, gibbed: v.gibbed, under: +v.under.toFixed(2), ev: ev.filter((e) => e !== 'hurt').join(',') };
}
const rates = [30, 60, 144].map((fps) => blastAt(fps));
check('a rocket\'s blast gibs at any frame rate (the corpse keeps taking it)', rates.every((r) => r.dead && r.gibbed), JSON.stringify(rates));
// a blast that only just kills: dead, not gibbed (health ends above GIB_HEALTH)
const justP = VITALS.BLAST_HURT_P + 1.1 / (VITALS.BLAST_DAMAGE * BLAST_S);
const just = [30, 60, 144].map((fps) => blastAt(fps, justP));
check('a blast that only just kills leaves a body', just.every((r) => r.dead && !r.gibbed && r.under > GIB_HEALTH), JSON.stringify(just));
{
  const v = createVitals(() => {});
  v.hurt(1.2, 'axe', true);
  const a = { dead: v.dead, gibbed: v.gibbed };
  v.hurt(0.25, 'axe', true);   // a blow to the corpse: -0.45
  check('a blow past -40% gibs; the corpse can still be gibbed (Quake III)', a.dead && !a.gibbed && v.gibbed, `${JSON.stringify(a)} → gibbed ${v.gibbed}`);
  const b = createVitals(() => {});
  b.hurt(0.9, 'axe', true);
  const burned = { ...env0, contactN: 1, contactId: [E.LAVA], contactT: [1600] };
  for (let t = 0; t < 10; t += 1 / 60) b.update(1 / 60, burned);
  check('burning to death leaves a body, however long it burns', b.dead && !b.gibbed, `under ${b.under.toFixed(2)}`);
}
// eating
{
  const v = createVitals(() => {});
  v.hurt(0.5, 'test', true);
  const want = v.eatWant();
  v.eat(2);
  check('eating heals EAT_HEAL a cell, wanting only what fills the body', Math.abs(v.health - (0.5 + 2 * EAT_HEAL)) < 1e-9 && want === Math.ceil(0.5 / EAT_HEAL),
    `want ${want}, health ${v.health.toFixed(2)}`);
  v.eat(100);
  check('eating stops at full health', v.health === 1 && v.eatWant() === 0);
}

// ---------------------------------------------------------------- GPU (a dev server)
if (port) {
  const { chromium } = await import('playwright');
  const W = 960, H = 600;
  const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 300)); });   // the dev server has no API
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const wait = (ms) => p.waitForTimeout(ms);
  const shot = async (name) => { if (shots) await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 70 }); };
  const census = () => ev(async () => {
    const { ELEMENTS } = await import('/src/elements.js');
    return Object.fromEntries(Object.entries(window.__app.sim.census()).map(([k, v]) => [ELEMENTS[k].key, v.n]));
  });
  try {
    await p.goto(`http://localhost:${port}/?preset=lab`);
    await p.waitForFunction(() => window.__app?.pov, null, { timeout: 90000 });
    await wait(1500);
    await ev(async () => {
      const { povEvents } = await import('/src/pov/events.js');
      window.__gib = []; window.__eat = [];
      povEvents.on('body:gib', (x) => window.__gib.push({ cells: x.cells, lost: x.lost, by: x.by ?? null, t: +(performance.now() / 1000).toFixed(1) }));
      povEvents.on('body:eat', (x) => window.__eat.push({ cells: x.cells, by: x.by ?? null }));
    });

    const g = await ev(() => { const { nx, ny, nz } = window.__app.sim.g; return { nx, ny, nz }; });
    const at = (fx, fz, y = 0) => ({ x: Math.floor(g.nx * fx) + 0.5, y, z: Math.floor(g.nz * fz) + 0.5 });
    const fill = async (key, c, r) => ev(async ({ key, c, r }) => {
      const a = window.__app, { E, ELEMENTS } = await import('/src/elements.js'), V = a.camera.position.constructor;
      a.sim.paint({ center: new V(c.x, c.y, c.z), radius: r, shape: 1, tool: E[key], rate: 1 / ELEMENTS[E[key]].spawn, replace: false });
    }, { key, c, r });
    const heat = (c) => ev((c) => { const a = window.__app, V = a.camera.position.constructor; a.sim.paint({ center: new V(c.x, c.y, c.z), radius: 4, shape: 0, tool: -2, rate: 1, replace: false }); }, c);

    // cooking in the real sim: a meat block on the lab's open south floor, held under the Heat brush
    const SPOT = at(0.5, 0.8, 1.5);
    await fill('MEAT', SPOT, 1);
    await wait(800);
    const k0 = await census();
    const meat0 = k0.MEAT ?? 0;
    let cookedSeen = 0;
    for (let i = 0; i < 60; i++) {
      await heat(SPOT);
      await wait(50);
      if (i % 10 === 9) cookedSeen = Math.max(cookedSeen, (await census()).COOKED_MEAT ?? 0);
    }
    const kc = await census();
    check('GPU: heat cooks meat', meat0 > 0 && cookedSeen > 0, `meat ${meat0}, cooked up to ${cookedSeen}, raw left ${kc.MEAT ?? 0}`);
    await shot('cooked');
    for (let i = 0; i < 120; i++) { await heat(SPOT); await wait(40); }
    await wait(3000);
    const k1 = await census();
    check('GPU: kept on, cooked meat chars and burns', (k1.COOKED_MEAT ?? 0) < cookedSeen && (k1.ASH ?? 0) > (k0.ASH ?? 0),
      `cooked ${cookedSeen}→${k1.COOKED_MEAT ?? 0}, ash ${k0.ASH ?? 0}→${k1.ASH ?? 0}, fire ${k1.FIRE ?? 0}`);
    await shot('charred');

    // first person, with the lab's NPC
    await p.mouse.move(W / 2, H / 2);
    await p.keyboard.press('f');
    await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 }).catch(() => {});
    check('dropped in', (await ev(() => window.__app.pov.mode)) === 'on');
    await ev(() => { window.__app.pov.test.assumeLocked = true; });
    await p.waitForFunction(() => window.__app.pov.npc?.placeAt, null, { timeout: 30000 }).catch(() => {});
    const hasNpc = await ev(() => !!window.__app.pov.npc);
    check('the lab has an NPC', hasNpc);
    const PL = at(0.33, 0.9);
    const spawnPlayer = () => ev((s) => { const a = window.__app, V = a.camera.position.constructor; a.pov.player.spawn(new V(s.x, s.y, s.z)); }, PL);
    await spawnPlayer();
    await wait(1500);

    // gibs: a clean kill leaves a body; a rocket kill bursts it into meat
    if (hasNpc) {
      const NP = { x: PL.x + 14, y: 0, z: PL.z };
      const place = () => ev((s) => { const a = window.__app; a.pov.npc.placeAt(new a.camera.position.constructor(s.x, s.y, s.z)); }, NP);
      await place();
      await wait(800);
      await ev(() => window.__app.pov.npc.body.hurt(1.1, 'test'));
      await wait(300);
      const clean = await ev(() => ({ dead: window.__app.pov.npc.body.dead, gibbed: window.__app.pov.npc.body.gibbed }));
      check('GPU: a kill that isn\'t overkill leaves a body', clean.dead && !clean.gibbed, JSON.stringify(clean));

      await ev(async () => { const { inventory } = await import('/src/pov/tools/inventory.js'); inventory.give('ROCKET'); window.__app.pov.toolbelt.select('ROCKET'); });
      // meat laid in the rocket's fire may cook at once: count both
      const meatOf = (c) => (c.MEAT ?? 0) + (c.COOKED_MEAT ?? 0);
      const m0 = meatOf(await census());
      const g0 = await ev(() => window.__gib.length);
      let gibbed = false, shots_ = 0;
      for (; shots_ < 4 && !gibbed; shots_++) {
        await place();
        await wait(400);
        await ev(() => {
          const pov = window.__app.pov, q = pov.player.pos, t = pov.npc.body.pos;
          const dx = t.x - q.x, dy = (t.y + 2.75) - (q.y + 5), dz = t.z - q.z;
          pov.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
        });
        await wait(100);
        await p.mouse.down(); await wait(40); await p.mouse.up();
        await wait(1500);
        gibbed = await ev(() => window.__app.pov.npc.body.gibbed);
      }
      await wait(500);
      const k2 = await census(), m1 = meatOf(k2);
      const gibs = await ev((g0) => window.__gib.slice(g0), g0);
      const npcVisible = await ev(() => { let v = false; window.__app.pov.npc.root.traverseVisible(() => { v = true; }); return v && window.__app.pov.npc.root.visible; });
      check('GPU: a rocket kill gibs the NPC', gibbed && gibs.some((x) => x.by), `${shots_} rockets, ${JSON.stringify(gibs)}`);
      check('GPU: the gib is the body\'s mass in meat', gibs.length > 0 && gibs.every((x) => x.cells + x.lost === GIB_CELLS) && m1 - m0 === gibs.reduce((t, x) => t + x.cells, 0),
        `meat ${m0}→${m1} (+${m1 - m0}, ${k2.COOKED_MEAT ?? 0} cooked), laid ${gibs.map((x) => x.cells).join(',')}, body = ${GIB_CELLS} cells`);
      check('GPU: the gibbed NPC is no longer drawn', !npcVisible);
      // look down at where it burst
      await ev((s) => {
        const pov = window.__app.pov, q = pov.player.pos;
        const dx = s.x - q.x, dy = 0.5 - (q.y + 5), dz = s.z - q.z;
        pov.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
      }, NP);
      await wait(800);
      await shot('gibbed');
      console.log('     every burst this run:', JSON.stringify(await ev(() => window.__gib)));
    }

    // eating (the NPC is dead for a while): cooked meat at the feet, raw meat on the other side,
    // laid while at full health (nothing eaten), then hurt
    await spawnPlayer();
    await wait(1200);
    await fill('COOKED_MEAT', { x: PL.x - 2, y: 1.5, z: PL.z }, 1);
    await fill('MEAT', { x: PL.x + 2, y: 1.5, z: PL.z }, 1);
    await wait(1500);
    const e0 = await ev(() => window.__eat.length);
    const c0 = await census();
    await ev(() => window.__app.pov.player.hurt(0.6, 'test'));
    const h0 = await ev(() => window.__app.pov.player.health);
    await wait(2500);
    const h1 = await ev(() => window.__app.pov.player.health);
    const c1 = await census();
    const eats = await ev((e0) => window.__eat.slice(e0).filter((e) => !e.by), e0);
    const eaten = eats.reduce((t, e) => t + e.cells, 0);
    check('GPU: cooked meat touching you is eaten and heals', eaten > 0 && Math.abs(h1 - Math.min(1, h0 + eaten * EAT_HEAL)) < 1e-6,
      `${eaten} eaten in ${eats.length} bites, health ${h0.toFixed(2)}→${h1.toFixed(2)}`);
    check('GPU: eating takes the cells out of the sim, no more', (c1.COOKED_MEAT ?? 0) + eaten === (c0.COOKED_MEAT ?? 0),
      `cooked in grid ${c0.COOKED_MEAT ?? 0}→${c1.COOKED_MEAT ?? 0}, eaten ${eaten}`);
    check('GPU: raw meat isn\'t eaten', (c1.MEAT ?? 0) === (c0.MEAT ?? 0), `raw ${c0.MEAT ?? 0}→${c1.MEAT ?? 0}`);
    await shot('ate');
    check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await b.close();
  }
}

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
