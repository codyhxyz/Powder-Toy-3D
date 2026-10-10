// End-to-end check of the Noita creatures through the real shell, sim and spawners:
// the worm (pov/worm.js) tunnels through rock toward you, leaves stone rubble
// (rock + stone conserved), breaches and bites ("Eaten by a worm"), is stopped
// by WALL, and dies to pistol fire; the jetpack gunner (npc.js style 'gunner',
// ai/gunner.js) shoots, keeps its range (backs off when you close in) and flies.
// usage: node tools/creatures-check.mjs [--port 5434] [--shot file.jpg]   (needs a dev server; AC power)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5434');
const shotPath = opt('shot', null);
const W = 960, H = 600;
const GROUND = 36;           // the rock's top (cells)
const ROCK_Z = 80;           // rock under z < ROCK_Z; past it the bare floor
const WALL_X = 60;           // the WALL slab's near face (phase 2)

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const settle = (ms) => p.waitForTimeout(ms);
const shots = [];
const shot = async (name) => { if (shotPath) { const f = shotPath.replace(/(\.\w+)$/, `-${name}$1`); await p.screenshot({ path: f, type: 'jpeg', quality: 70 }); shots.push(f); } };

// paint a box of `key` cells (cube brushes, shape 1), over what's there
const fill = (key, lo, hi) => ev(async ([key, lo, hi]) => {
  const { E } = await import('/src/elements.js');
  const a = window.__app, C = a.camera.position.constructor, R = 8;
  for (let y = lo[1] + R; y < hi[1] + R; y += 2 * R) for (let z = lo[2] + R; z < hi[2] + R; z += 2 * R) for (let x = lo[0] + R; x < hi[0] + R; x += 2 * R) {
    const c = new C(Math.min(x, hi[0] - R), Math.min(y, hi[1] - R), Math.min(z, hi[2] - R));
    a.sim.paint({ center: c, radius: R, shape: 1, tool: E[key], rate: 1, replace: true });
  }
}, [key, lo, hi]);
const census = () => ev(async () => {
  const { ELEMENTS } = await import('/src/elements.js');
  return Object.fromEntries(Object.entries(window.__app.sim.census()).map(([k, v]) => [ELEMENTS[k].key, v.n]));
});
const stand = (x, y, z) => ev(([x, y, z]) => { const a = window.__app; a.pov.player.spawn(a.pov.player.pos.clone().set(x, y, z)); }, [x, y, z]);
const creature = (kind) => ev((kind) => window.__app.pov.npcs.find((n) => n.kind === kind)?.debug ?? null, kind);
const sample = (kind, s, every = 100) => ev(async ([kind, s, every]) => {
  const out = [];
  const t0 = performance.now();
  while (performance.now() - t0 < s * 1000) {
    const n = window.__app.pov.npcs.find((x) => x.kind === kind);
    const pl = window.__app.pov.player;
    if (n) out.push({ ...n.debug, pos: n.body.pos ? { x: n.body.pos.x, y: n.body.pos.y, z: n.body.pos.z } : null, player: { x: pl.pos.x, y: pl.pos.y, z: pl.pos.z, health: pl.health, dead: pl.dead, cause: pl.cause }, t: performance.now() - t0 });
    await new Promise((r) => setTimeout(r, every));
  }
  return out;
}, [kind, s, every]);

try {
  await p.goto(`http://localhost:${port}/?size=128&preset=empty`);
  await p.waitForFunction(() => window.__app?.pov && window.__app.spawners, null, { timeout: 60000 });
  await settle(1500);
  // ground: rock up to GROUND under z < ROCK_Z, the bare floor beyond
  await fill('ROCK', [0, 0, 0], [128, GROUND, ROCK_Z]);
  await settle(500);
  const c0 = await census();
  check('rock painted', c0.ROCK > 128 * GROUND * ROCK_Z * 0.95, `${c0.ROCK} cells`);
  await ev(async () => {
    const { povEvents } = await import('/src/pov/events.js');
    window.__ev = { hits: [], fires: [] };
    povEvents.on('player:hit', (e) => window.__ev.hits.push({ by: e.by, amount: e.amount }));
    povEvents.on('gun:fire', (e) => window.__ev.fires.push({ by: e.by ?? null, gun: e.gun }));
  });
  // the worm's spawner on the rock at one end; the player on the rock at the other
  await ev(([g]) => { const a = window.__app, V = a.camera.position.constructor; a.spawners.add('worm', new V(20, g, 40)); }, [GROUND]);
  await p.mouse.move(W / 2, H * 0.62);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });
  await ev(() => { window.__app.pov.test.assumeLocked = true; });
  await stand(100, GROUND, 40);
  await p.waitForFunction(() => window.__app.pov.npcs.some((n) => n.kind === 'worm' && n.debug.digs > 0), null, { timeout: 30000 });

  // ---- 1. it tunnels toward you, breaches and bites
  const run = await sample('worm', 14);
  const under = run.filter((s) => s.head.y < GROUND - 1);
  const xs = under.map((s) => s.head.x);
  check('worm tunnels through the rock toward you', under.length > 10 && Math.max(...xs) - xs[0] > 40, `${under.length} samples underground, head x ${xs[0]?.toFixed(0)} → ${Math.max(...xs).toFixed(0)}, ${run.at(-1).digs} bites of rock`);
  const maxY = Math.max(...run.map((s) => s.head.y));
  check('it breaches out of the ground in an arc', run.at(-1).breaches > 0 && maxY > GROUND + 5.5, `${run.at(-1).breaches} breaches, head up to ${(maxY - GROUND).toFixed(1)} cells over the ground`);
  // from here the player is not hurt (it would die and respawn mid-check, and a dead player isn't hunted)
  await ev(() => { const pl = window.__app.pov.player; pl.hurt = () => {}; });
  const bites = await ev(() => window.__ev.hits.filter((h) => h.by?.startsWith('worm')).length);
  const hurt = run.find((s) => s.player.health < 1);
  check('it bites', bites > 0 && !!hurt, `${bites} bites, health ${run.at(-1).player.health.toFixed(2)}${run.find((s) => s.player.dead) ? `, died: ${run.find((s) => s.player.dead).player.cause}` : ''}`);
  await shot('worm-hunt');
  const c1 = await census();
  const dRock = c1.ROCK - c0.ROCK, dStone = (c1.STONE ?? 0) - (c0.STONE ?? 0);
  check('its tunnel leaves rubble: rock breaks into stone, none lost', dRock < -200 && dStone > 200 && Math.abs(dRock + dStone) <= 2, `rock ${dRock}, stone +${dStone}`);
  await p.waitForFunction(() => window.__app.pov.mode === 'on' && !window.__app.pov.player.dead, null, { timeout: 20000 });   // respawned, if it died

  // ---- 2. WALL stops it
  await fill('WALL', [WALL_X, 0, 0], [WALL_X + 4, GROUND + 24, ROCK_Z]);
  await settle(1200);   // the world model reads it back
  await stand(100, GROUND, 40);
  await ev(([g]) => { const n = window.__app.pov.npcs.find((x) => x.kind === 'worm'); n.placeAt({ x: 24, y: g - 12, z: 40 }); }, [GROUND]);
  const walled = await sample('worm', 8);
  const past = Math.max(...walled.map((s) => s.head.x));
  const hunted = walled.filter((s) => s.mode === 'hunt').length;
  check('WALL stops it', hunted > walled.length / 2 && past < WALL_X && past > WALL_X - 6 && walled.at(-1).blocked > 0,
    `hunting ${hunted}/${walled.length} samples, head x at most ${past.toFixed(1)} (WALL at ${WALL_X}), ${walled.at(-1).blocked} blocked moves`);

  // ---- 3. it dies to gunfire: stranded on the bare floor, you shoot it with the pistol
  await stand(64, 0, 100);
  await ev(() => { const n = window.__app.pov.npcs.find((x) => x.kind === 'worm'); n.placeAt({ x: 64, y: 3, z: 118 }); });
  await settle(1500);
  await ev(async () => {
    const { inventory } = await import('/src/pov/tools/inventory.js');
    inventory.give('GUN');
    window.__app.pov.toolbelt.select('GUN');
  });
  let killed = false, clicks = 0;
  for (let i = 0; i < 40 && !killed; i++) {
    await ev(() => {
      const pov = window.__app.pov, pl = pov.player, n = pov.npcs.find((x) => x.kind === 'worm');
      // the segment nearest the eye
      const e = { x: pl.pos.x, y: pl.pos.y + 5, z: pl.pos.z };
      let best = null, bd = Infinity;
      for (const s of n.segments) { const d = Math.hypot(s.x - e.x, s.y - e.y, s.z - e.z); if (d < bd) { bd = d; best = s; } }
      const dx = best.x - e.x, dy = best.y - e.y, dz = best.z - e.z;
      pov.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    });
    await settle(60);
    if (i === 2) await shot('worm-shot');
    await p.mouse.down(); await settle(40); await p.mouse.up(); clicks++;
    await settle(350);
    killed = (await creature('worm'))?.dead;
  }
  const w3 = await creature('worm');
  check('it dies to pistol fire', killed, `${clicks} shots, health ${w3?.health.toFixed(2)}`);
  await ev(() => { for (const s of [...window.__app.spawners.of('worm')]) window.__app.spawners.remove(s); });

  // ---- 4. the jetpack gunner keeps its range, flies and shoots
  await ev(() => { const a = window.__app, V = a.camera.position.constructor; a.spawners.add('gunner', new V(64, 0, 124)); });
  await stand(64, 0, 92);
  await p.waitForFunction(() => window.__app.pov.npcs.some((n) => n.kind === 'gunner'), null, { timeout: 20000 });
  await settle(1000);
  const g1 = await sample('gunner', 14);
  const flown = Math.max(...g1.map((s) => s.pos.y));
  const jetted = g1.some((s) => s.jetting), refuel = g1.some((s) => s.flight === 'refuel');
  check('the gunner flies on its jetpack', jetted && flown > 5.5, `up to ${flown.toFixed(1)} cells, flights: ${[...new Set(g1.map((s) => s.flight))].join(', ')}`);
  check('it lands to refuel', refuel, `fuel min ${Math.min(...g1.map((s) => s.fuel)).toFixed(2)}`);
  const fired = await ev(() => window.__ev.fires.filter((f) => f.by?.startsWith('npc')).map((f) => f.gun));
  check('it shoots its guns', fired.length > 2, `${fired.length} shots: ${[...new Set(fired)].join(', ')}`);
  await shot('gunner');
  // walk up on it: it backs off
  const close = await ev(() => { const pov = window.__app.pov, n = pov.npcs.find((x) => x.kind === 'gunner'), pl = pov.player; pl.spawn(pl.pos.clone().set(n.body.pos.x + 6, 0, n.body.pos.z)); return Math.hypot(n.body.pos.x - pl.pos.x, n.body.pos.z - pl.pos.z); });
  const g2 = await sample('gunner', 3);
  const h = (s) => Math.hypot(s.pos.x - s.player.x, s.pos.z - s.player.z);
  check('it backs off when you close in', g2.some((s) => s.range === 'back off') && h(g2.at(-1)) > close + 4, `${close.toFixed(1)} → ${h(g2.at(-1)).toFixed(1)} cells`);
  const band = g1.filter((s) => s.goal === 'Engage').map(h);
  check('it holds its range', band.length > 5, `engaged at ${band.length ? (band.reduce((a, b) => a + b, 0) / band.length).toFixed(1) : '-'} cells on average`);
} catch (err) {
  console.error('check aborted:', err);
  fails++;
} finally {
  if (errs.length) { console.log('page errors:'); for (const e of [...new Set(errs)].slice(0, 10)) console.log('  ', e); }
  if (shots.length) console.log('shots:', shots.join(' '));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'all ok');
  process.exit(fails ? 1 : 0);
}
