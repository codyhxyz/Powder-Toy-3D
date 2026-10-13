// Gibs and cooking check (docs/pov.md "Gibs and eating"): meat cooks in the
// engine's heat and chars past its fat's flash point, Quake's gib rule, and
// eating cooked meat. The CPU part runs in node (the dock tiles' engine port,
// src/ui/tiles/engine.js, and vitals.js); --gpu adds the app at 64³ in parts,
// each its own browser (its own Vite: tools/vite-server.mjs, on --port N if
// given): meat cooked in the real sim, and cooked meat eaten (raw meat not);
// then, in the POV tools' harness (tools/harness/pov-tools.js, no app), cooked
// meat burnt past its flash point (burn: stage char) and a body's burst laid
// as meat, cooked meat eaten (lay: stage meat). Two app parts run when asked:
// char (the Heat brush kept on the cooked meat until it chars) and gib (a
// rocket kill that gibs the lab spawner's NPC into the body's mass in meat).
// Their heat, fire, NPC and blasts wake the 64³ box (60 frames in, the NPC's
// part had 1431 of 4096 bricks awake), which takes SwiftShader over ten
// minutes a part (docs/webgpu.md I1: a part under ~3); burn and lay, with the
// CPU part's gib rules, are their witnesses here.
// usage: node tools/gibs-check.mjs [--gpu [--only cook,eat,burn,lay,char,gib | --all]] [--port N] [--shots dir]
import { World } from '../src/ui/tiles/engine.js';
import { E, ELEMENTS } from '../src/elements.js';
import { createVitals, GIB_HEALTH, EAT_HEAL, VITALS } from '../src/pov/vitals.js';
import { GIB_CELLS } from '../src/pov/meat.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const gpuRun = args.includes('--gpu') || args.includes('--port');
const shots = opt('shots', null);
// the GPU run's parts: the app's cook (meat in the sim's heat) and eat (first person); the harness's
// burn (cooked meat past its flash point) and lay (a burst laid, cooked meat eaten); the app's char
// and gib when named, or --all
const GPU_DEFAULT = ['cook', 'eat', 'burn', 'lay'];
const HARNESS = { burn: 'char', lay: 'meat' };   // part → its stage in the harness page
const gpuParts = opt('only', null)?.split(',') ?? (args.includes('--all') ? [...GPU_DEFAULT, 'char', 'gib'] : GPU_DEFAULT);

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

// ---------------------------------------------------------------- GPU (the app)
// The empty box at 64³ (with the lab's enemy spawner where the lab has it,
// app.js LAB_ENEMY_AT, for gib), booted through ready() and its frames run by
// the check (tools/pov-app.mjs): the waits are game time (frames), not the
// wall's. What is checked needs a floor, the meat, the heat and an NPC; the
// lab's scenery would keep the grid awake, which costs SwiftShader seconds a
// frame (a run in the lab managed 60 frames in 7 minutes). Each part is an app
// of its own (its own browser: runParts): cook, eat, and when asked char, gib.
// The heat and the fire wake the box's air, so the cooking parts stop as soon
// as what they check has happened.
const LAB_ENEMY_AT = [0.555, 0.86];   // the lab's enemy spawner, shares of the box (app.js)
const COOK_HEATS = 60, CHAR_HEATS = 120;   // the brush's strokes at most (the old check's), one or two frames each
const CENSUS_EVERY = 10;                   // strokes between looks at what the meat has become
if (gpuRun) {
  const { runParts } = await import('./pov-app.mjs');
  const W = 640, H = 400;

  // One part's page helpers.
  const helpers = (app) => {
    const p = app.page;
    const ev = (fn, arg) => p.evaluate(fn, arg);
    return {
      p, ev,
      frames: (k) => ev((k) => __pov.frames(k), k),
      secs: (s) => ev((s) => __pov.frames(Math.max(1, Math.round(s / __pov.dt))), s),
      shot: async (name) => { if (shots) { await ev(() => __app.test.renderOnce()); await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 70 }); } },
      census: () => ev(async () => {
        const { ELEMENTS } = await import('/src/elements.js');
        return Object.fromEntries(Object.entries(await window.__app.sim.census()).map(([k, v]) => [ELEMENTS[k].key, v.n]));
      }),
      at: async (fx, fz, y = 0) => {
        const g = await ev(() => { const { nx, nz } = window.__app.sim.g; return { nx, nz }; });
        return { x: Math.floor(g.nx * fx) + 0.5, y, z: Math.floor(g.nz * fz) + 0.5 };
      },
      fill: (key, c, r) => ev(async ({ key, c, r }) => {
        const a = window.__app, { E, ELEMENTS } = await import('/src/elements.js'), V = a.THREE.Vector3;
        a.sim.paint({ center: new V(c.x, c.y, c.z), radius: r, shape: 1, tool: E[key], rate: 1 / ELEMENTS[E[key]].spawn, replace: false });
      }, { key, c, r }),
      heat: (c) => ev((c) => { const a = window.__app, V = a.THREE.Vector3; a.sim.paint({ center: new V(c.x, c.y, c.z), radius: 4, shape: 0, tool: -2, rate: 1, replace: false }); }, c),
    };
  };

  // Cooking in the real sim: a meat block on the floor where the lab's is open, held under the
  // Heat brush (two frames a stroke) until some of it has cooked. → { k0, cookedSeen }
  async function cookMeat(app) {
    const { fill, secs, census, heat, frames, at } = helpers(app);
    const SPOT = await at(0.5, 0.8, 1.5);
    await fill('MEAT', SPOT, 1);
    await secs(0.8);
    const k0 = await census();
    let cookedSeen = 0;
    for (let i = 0; i < COOK_HEATS && !cookedSeen; i++) {
      await heat(SPOT);
      await frames(2);
      if (i % CENSUS_EVERY === CENSUS_EVERY - 1) cookedSeen = Math.max(cookedSeen, (await census()).COOKED_MEAT ?? 0);
    }
    return { SPOT, k0, cookedSeen };
  }

  // What every part's app needs first: the events recorded.
  async function setup(app) {
    await app.page.evaluate(async () => {
      const { povEvents } = await import('/src/pov/events.js');
      window.__gib = []; window.__eat = [];
      povEvents.on('body:gib', (x) => window.__gib.push({ cells: x.cells, lost: x.lost, by: x.by ?? null }));
      povEvents.on('body:eat', (x) => window.__eat.push({ cells: x.cells, by: x.by ?? null }));
    });
  }
  // The lab's enemy spawner, where there are spawners (src/wire/mesh.js: none until the mesh layer
  // is ready). Its NPC wakes the box, so only the part that needs one has it. → whether there are.
  const addSpawner = (app) => app.page.evaluate((at) => {
    const a = window.__app, g = a.sim.g;
    if (a.spawners) a.spawners.add('enemy', new a.THREE.Vector3(Math.round(g.nx * at[0]), 0, Math.round(g.nz * at[1])));
    return !!a.spawners;
  }, LAB_ENEMY_AT);

  // The body dropped in, standing at PL.
  async function enterAt(app) {
    const { ev, secs, at } = helpers(app);
    const entered = await app.enter();
    app.check('dropped in', entered.mode === 'on', `${entered.s.toFixed(0)} s, ${entered.frames} frames`);
    const PL = await at(0.33, 0.9);
    await ev((s) => { const a = window.__app, V = a.THREE.Vector3; a.pov.player.spawn(new V(s.x, s.y, s.z)); }, PL);
    await secs(1.5);
    return { PL };
  }

  const parts = [
    // heat cooks meat
    ['cook', async (app) => {
      const { census, shot } = helpers(app);
      const { k0, cookedSeen } = await cookMeat(app);
      const kc = await census();
      app.check('GPU: heat cooks meat', (k0.MEAT ?? 0) > 0 && cookedSeen > 0, `meat ${k0.MEAT ?? 0}, cooked up to ${cookedSeen}, raw left ${kc.MEAT ?? 0}`);
      await shot('cooked');
    }],

    // kept on, cooked meat chars and burns (until it has: the check's condition, looked at every few strokes)
    ['char', async (app) => {
      const { census, shot, heat, frames, secs } = helpers(app);
      const { SPOT, k0, cookedSeen } = await cookMeat(app);
      app.check('GPU: some meat cooked first', cookedSeen > 0, `cooked up to ${cookedSeen}`);
      const charred = (k) => (k.COOKED_MEAT ?? 0) < cookedSeen && (k.ASH ?? 0) > (k0.ASH ?? 0);
      let k1 = null, strokes = 0;
      for (; strokes < CHAR_HEATS; strokes++) {
        await heat(SPOT);
        await frames(1);
        if (strokes % CENSUS_EVERY === CENSUS_EVERY - 1 && charred(k1 = await census())) break;
      }
      if (!k1 || !charred(k1)) { await secs(3); k1 = await census(); }   // (the old check's: the fire burns on a while)
      app.check('GPU: kept on, cooked meat chars and burns', charred(k1),
        `cooked ${cookedSeen}→${k1.COOKED_MEAT ?? 0}, ash ${k0.ASH ?? 0}→${k1.ASH ?? 0}, fire ${k1.FIRE ?? 0} (${strokes + 1} more strokes)`);
      await shot('charred');
    }],

    // gibs: a clean kill leaves a body; a rocket kill bursts it into meat (an NPC from the spawner)
    ['gib', async (app) => {
      const { ev, p, secs, frames, census, shot } = helpers(app), check = app.check;
      if (!(await addSpawner(app))) { console.log('SKIP the gibs (an NPC): no spawners in this build (src/wire/mesh.js isn\'t ready)'); return; }
      const { PL } = await enterAt(app);
      await ev(() => __pov.frames(Math.round(30 / __pov.dt), () => window.__app.pov.npc?.placeAt));
      const hasNpc = await ev(() => !!window.__app.pov.npc);
      check('the enemy spawner brings an NPC', hasNpc);
      if (!hasNpc) return;
      const NP = { x: PL.x + 14, y: 0, z: PL.z };
      const place = () => ev((s) => { const a = window.__app; a.pov.npc.placeAt(new a.THREE.Vector3(s.x, s.y, s.z)); }, NP);
      await place();
      await secs(0.8);
      await ev(() => window.__app.pov.npc.body.hurt(1.1, 'test'));
      await secs(0.3);
      const clean = await ev(() => ({ dead: window.__app.pov.npc.body.dead, gibbed: window.__app.pov.npc.body.gibbed }));
      check('GPU: a kill that isn\'t overkill leaves a body', clean.dead && !clean.gibbed, JSON.stringify(clean));

      await ev(async () => { const { inventory } = await import('/src/pov/tools/inventory.js'); inventory.give('ROCKET'); });
      await app.hold('ROCKET');   // (in hand, its slot selector gone: a click while it's up only closes it)
      // meat laid in the rocket's fire may cook at once: count both
      const meatOf = (c) => (c.MEAT ?? 0) + (c.COOKED_MEAT ?? 0);
      const m0 = meatOf(await census());
      const g0 = await ev(() => window.__gib.length);
      let gibbed = false, rockets = 0;
      for (; rockets < 4 && !gibbed; rockets++) {
        await place();
        await secs(0.4);
        await ev(() => {
          const pov = window.__app.pov, q = pov.player.pos, t = pov.npc.body.pos;
          const dx = t.x - q.x, dy = (t.y + 2.75) - (q.y + 5), dz = t.z - q.z;
          pov.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
        });
        await frames(3);
        await p.mouse.down(); await frames(1); await p.mouse.up();
        await ev(() => __pov.frames(Math.round(1.5 / __pov.dt), () => window.__app.pov.npc.body.gibbed));
        gibbed = await ev(() => window.__app.pov.npc.body.gibbed);
      }
      await secs(0.5);
      const k2 = await census(), m1 = meatOf(k2);
      const gibs = await ev((g0) => window.__gib.slice(g0), g0);
      const npcVisible = await ev(() => { let v = false; window.__app.pov.npc.root.traverseVisible(() => { v = true; }); return v && window.__app.pov.npc.root.visible; });
      check('GPU: a rocket kill gibs the NPC', gibbed && gibs.some((x) => x.by), `${rockets} rockets, ${JSON.stringify(gibs)}`);
      check('GPU: the gib is the body\'s mass in meat', gibs.length > 0 && gibs.every((x) => x.cells + x.lost === GIB_CELLS) && m1 - m0 === gibs.reduce((t, x) => t + x.cells, 0),
        `meat ${m0}→${m1} (+${m1 - m0}, ${k2.COOKED_MEAT ?? 0} cooked), laid ${gibs.map((x) => x.cells).join(',')}, body = ${GIB_CELLS} cells`);
      check('GPU: the gibbed NPC is no longer drawn', !npcVisible);
      if (shots) {   // look down at where it burst
        await ev((s) => {
          const pov = window.__app.pov, q = pov.player.pos;
          const dx = s.x - q.x, dy = 0.5 - (q.y + 5), dz = s.z - q.z;
          pov.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
        }, NP);
        await secs(0.8);
        await shot('gibbed');
      }
      console.log('     every burst this run:', JSON.stringify(await ev(() => window.__gib)));
    }],

    // eating: cooked meat at the feet, raw meat on the other side, laid while at full health
    // (nothing eaten), then hurt
    ['eat', async (app) => {
      const { ev, secs, census, fill, shot } = helpers(app), check = app.check;
      const { PL } = await enterAt(app);   // (standing: enterAt waited for it)
      await fill('COOKED_MEAT', { x: PL.x - 2, y: 1.5, z: PL.z }, 1);
      await fill('MEAT', { x: PL.x + 2, y: 1.5, z: PL.z }, 1);
      await secs(1.5);
      const e0 = await ev(() => window.__eat.length);
      const c0 = await census();
      await ev(() => window.__app.pov.player.hurt(0.6, 'test'));
      const h0 = await ev(() => window.__app.pov.player.health);
      // up to 2.5 s for the bites to heal it full (then it wants no more), and a few frames to see it stops
      await ev(() => __pov.frames(Math.round(2.5 / __pov.dt), () => window.__app.pov.player.health >= 1));
      await secs(0.3);
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
    }],
  ];
  const appParts = gpuParts.filter((n) => !HARNESS[n]), stages = gpuParts.filter((n) => HARNESS[n]);
  if (appParts.length) fails += await runParts(parts, { only: appParts, open: { query: '?size=64&preset=empty&view=plain', viewport: { width: W, height: H } }, setup });
  if (stages.length) {
    const { runStages, TOOLS_PAGE } = await import('./pov-gpu-check.mjs');
    fails += await runStages(stages.map((n) => HARNESS[n]), { page: TOOLS_PAGE });
  }
}

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
