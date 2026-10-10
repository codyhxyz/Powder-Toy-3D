// CPU check of batch 3's materials and lightning (elements.js VOID … DIAMOND,
// src/bolt.js), run on the engine's CPU twin (src/ui/tiles/engine.js: the same
// element table, rules and constants as the GPU passes, in a 2D slice).
// No browser, no GPU. Prints one line per check; exits 1 if any fails.
// Checks that need el-core's phase rows (cold/hot) print PENDING until it lands.
//   node tools/mat-check.mjs
import { World } from '../src/ui/tiles/engine.js';
import { E, ELEMENTS, K } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import { BOLT, STORM, boltPath, pickStrike, prefersStrike } from '../src/bolt.js';
import { sparkPhase } from '../src/electricity.js';

const GRAVITY = 0.025;     // the app's default gravity setting (app.js settings.gravity)
let fails = 0, pendings = 0;
const report = (name, ok, detail, pending = false) => {
  const tag = ok ? 'PASS' : pending ? 'PENDING' : 'FAIL';
  if (!ok && !pending) fails++;
  if (!ok && pending) pendings++;
  console.log(`${tag.padEnd(7)} ${name}: ${detail}`);
};
const count = (w, id) => w.id.reduce((n, v) => n + (v === id ? 1 : 0), 0);
const world = (nx, ny) => { const w = new World(nx, ny); w.gravity = GRAVITY; return w; };
const fill = (w, x0, x1, y0, y1, id, extra) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) w.put(x, y, id, extra); };
const steps = (w, n, each) => { for (let i = 0; i < n; i++) { each?.(w, i); w.step(); } };

// ---- Void ----
{
  const w = world(16, 16);
  fill(w, 0, 16, 0, 1, E.VOID);
  fill(w, 2, 14, 1, 7, E.WATER);
  fill(w, 0, 1, 1, 6, E.ROCK);                   // a solid touching the void stays
  steps(w, 300);
  report('void drains a pool', count(w, E.WATER) === 0 && count(w, E.ROCK) === 5,
    `water ${count(w, E.WATER)} (was 72), rock beside it ${count(w, E.ROCK)}/5`);
}
{
  // a waterfall: a clone fed water pours forever onto a void floor; it never floods
  const w = world(16, 24);
  fill(w, 0, 16, 0, 1, E.VOID);
  fill(w, 6, 10, 20, 21, E.CLONE, { ctype: E.WATER });
  const seen = [];
  steps(w, 3000, (_, i) => { if (i % 500 === 499) seen.push(count(w, E.WATER)); });
  const steady = Math.max(...seen.slice(1)) - Math.min(...seen.slice(1));
  report('clone + void: a river that never floods', seen.at(-1) > 0 && seen.at(-1) < 16 * 10 && steady < 40,
    `water every 500 steps: ${seen.join(', ')}`);
}
{
  const w = world(8, 8);
  fill(w, 0, 8, 7, 8, E.VOID);                    // a void ceiling: steam rises into it
  fill(w, 2, 6, 2, 4, E.STEAM);
  steps(w, 400);
  report('void eats gas too', count(w, E.STEAM) === 0, `steam ${count(w, E.STEAM)} of 8 left after 400 steps under a void ceiling`);
}

// ---- densities: mercury floats stone, scrap and rubble; gold sinks ----
{
  const w = world(14, 30);
  fill(w, 0, 14, 0, 10, E.MERCURY);
  const floaters = [E.STONE, E.SCRAP, E.RUBBLE];
  floaters.forEach((id, k) => fill(w, 1 + 4 * k, 3 + 4 * k, 20, 21, id));
  fill(w, 5, 9, 25, 26, E.NUGGETS);
  steps(w, 1500);
  let hgTop = -1;
  const ys = {};
  for (let y = 0; y < w.ny; y++) for (let x = 0; x < w.nx; x++) {
    const id = w.id[w.idx(x, y)];
    if (id === E.MERCURY) hgTop = Math.max(hgTop, y);
    (ys[id] ??= []).push(y);
  }
  const lowest = (id) => Math.min(...(ys[id] ?? [Infinity]));
  const floats = floaters.every((id) => lowest(id) >= hgTop - 1);
  report('mercury floats stone, scrap and rubble', floats,
    `mercury top y ${hgTop}; lowest stone ${lowest(E.STONE)}, scrap ${lowest(E.SCRAP)}, rubble ${lowest(E.RUBBLE)}`);
  report('gold sinks in mercury', lowest(E.NUGGETS) <= 1, `lowest nugget y ${lowest(E.NUGGETS)} (floor 0)`);
}

// ---- breaking: brick cracks under a blast, titanium and tungsten don't; a slug breaks gold ----
{
  const w = world(24, 12);
  const walls = [[E.BRICK, 3], [E.TITANIUM, 11], [E.TUNGSTEN, 19]];
  for (const [id, x] of walls) fill(w, x, x + 2, 0, 8, id);
  steps(w, 30, () => { for (const [, x] of walls) w.pressure(x - 2, 4, 2, 20); });   // the Pressure tool, hard, beside each wall
  report('a blast breaks brick into rubble', count(w, E.BRICK) < 16 && count(w, E.RUBBLE) > 0,
    `brick ${count(w, E.BRICK)}/16, rubble ${count(w, E.RUBBLE)}`);
  report('titanium and tungsten stand any blast', count(w, E.TITANIUM) === 16 && count(w, E.TUNGSTEN) === 16,
    `titanium ${count(w, E.TITANIUM)}/16, tungsten ${count(w, E.TUNGSTEN)}/16`);
}
{
  const hit = (target) => {
    const w = world(6, 8);
    w.put(3, 2, target);
    w.put(3, 4, E.SCRAP);
    w.vy[w.idx(3, 4)] = -PHYS.V_MAX;
    steps(w, 6, (_, i) => { if (i < 3 && w.id[w.idx(3, 4 - i)] === E.SCRAP) w.vy[w.idx(3, 4 - i)] = -PHYS.V_MAX; });
    return w;
  };
  const gold = hit(E.GOLD), ti = hit(E.TITANIUM);
  report('a slug at full speed (KE 39) breaks gold (24) into nuggets, not titanium (190)',
    count(gold, E.GOLD) === 0 && count(gold, E.NUGGETS) === 1 && count(ti, E.TITANIUM) === 1,
    `gold: ${count(gold, E.GOLD)} left, ${count(gold, E.NUGGETS)} nugget; titanium: ${count(ti, E.TITANIUM)} left`);
}

// ---- melting points (the generic melt) ----
{
  const cases = [['GOLD', 1064], ['TITANIUM', 1668], ['TUNGSTEN', 3422], ['BRICK', 1300], ['NUGGETS', 1064], ['RUBBLE', 1300]];
  const out = cases.map(([key, T]) => {
    const at = (t) => { const w = world(3, 3); w.put(1, 1, E[key], { T: t }); fill(w, 0, 3, 0, 1, E.WALL); w.step(); return w.id[w.idx(1, 1)] === E.LAVA; };
    return { key, ok: !at(T - 20) && at(T + 20) };
  });
  report('melting points', out.every((o) => o.ok), out.map((o) => `${o.key} ${o.ok ? 'ok' : 'WRONG'}`).join(', '));
}
{
  // gold's melt sets back into gold; brick's into stone
  const w = world(3, 3);
  w.put(1, 1, E.LAVA, { T: 800, ctype: E.GOLD });
  w.put(1, 2, E.LAVA, { T: 900, ctype: E.STONE });
  fill(w, 0, 3, 0, 1, E.WALL);
  w.step();
  report('melts set back', w.id[w.idx(1, 1)] === E.GOLD, `gold melt at 800 °C → ${ELEMENTS[w.id[w.idx(1, 1)]].key}`);
}

// ---- acid ----
{
  const proof = ['GOLD', 'NUGGETS', 'TUNGSTEN', 'DIAMOND', 'BRICK', 'RUBBLE', 'VOID'].filter((k) => !ELEMENTS[E[k]].acidProof);
  report('acid-proof: gold, tungsten, diamond, brick, void', proof.length === 0, proof.length ? `not: ${proof.join(', ')}` : 'all set');
}

// ---- diamond burns in air past 780 °C, only while kept hot ----
{
  const run = (T, air) => {
    const w = world(8, 8);
    fill(w, 2, 6, 0, 4, E.DIAMOND, { T });
    if (!air) { fill(w, 0, 8, 4, 8, E.WALL); fill(w, 0, 2, 0, 4, E.WALL); fill(w, 6, 8, 0, 4, E.WALL); }
    steps(w, 12000, () => { for (let i = 0; i < w.id.length; i++) if (w.id[i] === E.DIAMOND) w.T[i] = T; });   // a torch held on it
    return count(w, E.DIAMOND);
  };
  const hot = run(900, true), warm = run(700, true), sealed = run(900, false);
  report('diamond burns in air above 780 °C', hot < 16 && warm === 16 && sealed === 16,
    `held at 900 °C in air: ${hot}/16 left; at 700 °C: ${warm}/16; at 900 °C sealed from air: ${sealed}/16`);
  const w = world(8, 8);
  fill(w, 2, 6, 0, 4, E.DIAMOND, { T: 900 });
  steps(w, 2000);
  report('…but does not keep itself alight', count(w, E.DIAMOND) >= 14, `heated once to 900 °C, then left: ${count(w, E.DIAMOND)}/16 left`);
}

// ---- plasma: radiates fast and (el-core cold row) recombines into air ----
{
  const w = world(8, 8);
  w.put(4, 4, E.PLASMA);
  let n = 0;
  while (w.id.includes(E.PLASMA) && n < 400) { w.step(); n++; }
  const left = w.id.includes(E.PLASMA);
  const i = w.id.indexOf(E.PLASMA);
  report('plasma recombines into air within ~0.5 s', !left && n < 120,
    left ? `still plasma after ${n} steps (T ${w.T[i].toFixed(0)} °C): needs el-core's cold row` : `gone after ${n} steps`, left);
}

// ---- mercury phases (el-core phase rows) ----
{
  const freeze = world(3, 3); freeze.put(1, 1, E.MERCURY, { T: -60 }); fill(freeze, 0, 3, 0, 1, E.WALL);
  steps(freeze, 200, (w) => { for (let i = 0; i < w.id.length; i++) if (w.id[i] === E.MERCURY) w.T[i] = Math.min(w.T[i], -60); });
  const boil = world(3, 6); boil.put(1, 1, E.MERCURY, { T: 400 }); fill(boil, 0, 3, 0, 1, E.WALL);
  steps(boil, 400, (w) => { for (let i = 0; i < w.id.length; i++) if (w.id[i] === E.MERCURY) w.T[i] = Math.max(w.T[i], 400); });
  const fz = count(freeze, E.SOLID_MERCURY) === 1, bl = count(boil, E.MERCURY_VAPOR) > 0;
  report('mercury freezes at −38.8 °C and boils at 357 °C', fz && bl,
    `at −60 °C: frozen ${count(freeze, E.SOLID_MERCURY)}/1; at 400 °C: vapour ${count(boil, E.MERCURY_VAPOR)}`, !(fz && bl));
}

// ---- lightning (one bolt, src/bolt.js) ----
{
  let s = 7; const rng = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const size = [128, 128, 128];
  let ok = true, worst = 0, mains = 0;
  for (let k = 0; k < 50; k++) {
    const to = [20 + rng() * 88, 4 + rng() * 40, 20 + rng() * 88];
    const segs = boltPath([to[0] + 3, 127.5, to[2] - 2], to, rng, size);
    const main = segs.filter((g) => g.r === BOLT.RADIUS);
    mains += main.length;
    // the main channel is continuous and ends on the target
    for (let i = 1; i < main.length; i++) worst = Math.max(worst, Math.hypot(...main[i].a.map((v, j) => v - main[i - 1].b[j])));
    const end = main.at(-1).b;
    ok &&= segs.length <= BOLT.MAX_SEGS && Math.hypot(...end.map((v, j) => v - to[j])) < 1e-6
      && segs.every((g) => [...g.a, ...g.b].every((v, j) => v >= 0 && v < size[j % 3]));
  }
  report('bolt: main channel continuous, lands on its target, within budget and box', ok && worst < 1e-6,
    `50 bolts, ${(mains / 50).toFixed(1)} main segments each, worst gap ${worst}`);
}
{
  // the tool, in the slice: sand under wood under air; strike the wood
  const w = world(22, 30);
  fill(w, 0, 22, 0, 4, E.SAND);
  fill(w, 8, 14, 4, 6, E.WOOD);
  const segs = w.strike([12.5, 29.5], [11.5, 6], { strikeR: 1.5 });
  const plasma = count(w, E.PLASMA);
  const woodT = Math.max(...[...w.id].map((id, i) => (id === E.WOOD ? w.T[i] : -Infinity)));
  let Pmax = 0; for (let i = 0; i < w.P.length; i++) if (w.id[i] === E.PLASMA || w.id[i] === E.EMPTY) Pmax = Math.max(Pmax, w.P[i]);
  report('a strike leaves a plasma column', plasma >= 15, `${plasma} plasma cells along ${segs.length} segments`);
  report('…sets what it hits alight', woodT >= ELEMENTS[E.WOOD].ignite, `hottest wood ${woodT.toFixed(0)} °C (lights at ${ELEMENTS[E.WOOD].ignite})`);
  report('…and cracks it with pressure', Pmax >= BOLT.STRIKE_P && Pmax > ELEMENTS[E.ROCK].hard * PHYS.P_BREAK_PER_HARD,
    `air at the strike point ${Pmax} (rock cracks past ${ELEMENTS[E.ROCK].hard * PHYS.P_BREAK_PER_HARD})`);
  steps(w, 60);
  report('…the wood breaks or burns there', count(w, E.WOOD) < 12, `wood ${count(w, E.WOOD)}/12 after 60 steps`);
}
{
  // a fulgurite: lightning on sand fuses it
  const w = world(22, 30);
  fill(w, 0, 22, 0, 6, E.SAND);
  w.strike([11.5, 29.5], [11.5, 6], { strikeR: 1.5 });
  const hot = [...w.id].map((id, i) => (id === E.SAND ? w.T[i] : -Infinity)).filter((T) => T > ELEMENTS[E.SAND].melt).length;
  steps(w, 2);
  report('lightning on sand fuses it (a fulgurite)', hot > 0 && count(w, E.LAVA) > 0, `${hot} sand cells past ${ELEMENTS[E.SAND].melt} °C, ${count(w, E.LAVA)} molten`);
}

{
  // a strike on metal sparks it (src/electricity.js), and the spark runs along it; one on rock doesn't
  const strikeOn = (id) => {
    const w = world(22, 30);
    fill(w, 0, 22, 0, 3, id);
    w.strike([11.5, 29.5], [11.5, 3], { strikeR: 1.5 });
    const live = (ww) => [...ww.id].filter((v, i) => v === id && sparkPhase(ww.ctype[i]) !== 0).length;
    const now = live(w);
    let reached = new Set();
    steps(w, 12, (ww) => { for (let i = 0; i < ww.id.length; i++) if (ww.id[i] === id && sparkPhase(ww.ctype[i]) !== 0) reached.add(i); });
    return { now, reached: reached.size };
  };
  const metal = strikeOn(E.METAL), mercury = strikeOn(E.MERCURY), rock = strikeOn(E.ROCK);
  report('a strike on metal sparks it, and the spark runs along it', metal.now > 0 && metal.reached > metal.now && rock.now === 0,
    `metal: ${metal.now} cells sparked by the strike, ${metal.reached} live within 12 steps; mercury: ${mercury.now} → ${mercury.reached}; rock: ${rock.now}`);
}
{
  // conductors keep their spark in ctype: batch 3's conductors use it for nothing else
  const cond = ['TITANIUM', 'TUNGSTEN', 'GOLD', 'NUGGETS', 'MERCURY', 'SOLID_MERCURY'];
  const bad = cond.filter((k) => !ELEMENTS[E[k]].conducts);
  const w = world(10, 10);
  fill(w, 0, 10, 0, 2, E.WALL);
  fill(w, 1, 3, 2, 4, E.NUGGETS); fill(w, 4, 9, 2, 4, E.MERCURY); fill(w, 1, 3, 6, 7, E.SOLID_MERCURY);
  for (let i = 0; i < w.id.length; i++) w.spark(i);
  let wrong = 0;
  steps(w, 200, (ww) => { for (let i = 0; i < ww.id.length; i++) if ([E.NUGGETS, E.MERCURY, E.SOLID_MERCURY].includes(ww.id[i]) && ww.ctype[i] !== 0 && sparkPhase(ww.ctype[i]) === 0) wrong++; });
  report('conductors: ctype holds only their spark', bad.length === 0 && wrong === 0,
    `${bad.length ? `not conducts: ${bad.join(', ')}; ` : ''}cell-steps with a non-spark ctype on nuggets/mercury/frozen mercury: ${wrong}`);
}

// ---- storms ----
{
  // the charge: snow falling past freezing cloud
  let charged = 0;
  const N = 400;
  for (let k = 0; k < N; k++) {
    const w = world(3, 5);
    w.put(1, 2, E.CLOUD, { T: 0, life: -1 });
    w.put(1, 3, E.SNOW, { T: -5 });
    w.vy[w.idx(1, 3)] = -0.3;
    w.react();
    if (w.id[w.idx(1, 2)] === E.CLOUD && w.ctype[w.idx(1, 2)] === 1) charged++;
  }
  const want = PHYS.CHARGE_RATE * 0.3;
  report('freezing cloud charges as snow falls past it', Math.abs(charged / N - want) < 0.06,
    `charged in ${(100 * charged / N).toFixed(0)}% of steps (expect ~${(100 * want).toFixed(0)}%)`);
  const warm = world(3, 5);
  warm.put(1, 2, E.CLOUD, { T: 15 });
  warm.put(1, 3, E.SNOW, { T: -5 });
  warm.vy[warm.idx(1, 3)] = -0.3;
  let any = 0; for (let k = 0; k < 50; k++) { warm.react(); any += warm.ctype[warm.idx(1, 2)]; }
  report('…but warm cloud does not', any === 0, `charge ${any}`);
}
{
  report('leaders prefer conductors and water', prefersStrike(E.METAL) === Boolean(ELEMENTS[E.METAL].conducts) && prefersStrike(E.WATER) && prefersStrike(E.GOLD) && !prefersStrike(E.ROCK),
    `metal ${prefersStrike(E.METAL)} (conducts: ${Boolean(ELEMENTS[E.METAL].conducts)}, el-elec's field), water ${prefersStrike(E.WATER)}, gold ${prefersStrike(E.GOLD)}, rock ${prefersStrike(E.ROCK)}`);
  const pick = pickStrike([10, 30, 10], [
    { x: 10, z: 10, top: 2, id: E.ROCK },          // straight below, 27 away
    { x: 14, z: 10, top: 5, id: E.GOLD },          // a gold post 4 cells over, 3 taller: ~24.8, a conductor
    { x: 4, z: 10, top: 9, id: E.ROCK },           // a taller rock 6 cells over: ~21.9
  ]);
  report('…the nearest point, conductors counting nearer', pick?.id === E.GOLD,
    `struck ${pick ? ELEMENTS[pick.id].key : 'nothing'} at ${pick?.cell}`);
}
{
  // a storm: snow falls from a cold sky through a freezing cloud deck over a
  // field with a gold post; the deck charges and strikes by itself, rate-limited
  // The sim's air is 20 °C everywhere (cloud radiates toward it: rad), so the
  // deck is held at the freezing level by hand, as a cold sky aloft would.
  const w = world(22, 44);
  fill(w, 0, 22, 0, 2, E.ROCK);
  fill(w, 16, 17, 2, 8, E.GOLD);
  fill(w, 2, 20, 22, 34, E.CLOUD, { T: 0, life: -1 });
  const STEPS = 6000;
  let firstAt = -1;
  steps(w, STEPS, (_, i) => {
    for (let k = 0; k < w.id.length; k++) if (w.id[k] === E.CLOUD) { w.T[k] = Math.min(w.T[k], 0); w.life[k] = Math.min(w.life[k], -1); }
    for (let x = 4; x < 18; x++) if (w.id[w.idx(x, 40)] === E.EMPTY && Math.random() < 0.3) w.put(x, 40, E.SNOW, { T: -15 });
    if (firstAt < 0 && w.strikes > 0) firstAt = i;
  });
  const maxStrikes = Math.floor(STEPS / STORM.MIN_STEPS) + 1;
  report('a freezing cloud deck in falling snow strikes by itself', w.strikes > 0 && w.strikes <= maxStrikes,
    `${w.strikes} strikes in ${STEPS} steps (first at step ${firstAt}; the rate limit allows ${maxStrikes})`);
}

console.log(fails ? `${fails} check(s) FAILED${pendings ? `, ${pendings} pending el-core` : ''}` : `all checks pass${pendings ? ` (${pendings} pending el-core)` : ''}`);
process.exit(fails ? 1 : 0);
