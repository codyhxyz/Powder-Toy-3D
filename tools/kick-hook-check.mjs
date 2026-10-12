// Kick and hook end-to-end check (docs/pov.md "Kick", "Hook"): the kick breaks
// glass, shoves loose sand, throws you off a wall in the air and off the floor
// standing, and shoves a body; the hook reels you to a wall, hangs you to swing
// on, and brings a bite of sand to you, with matter conserved.
// The app at 64³ (the scenes in grid cells, the 128³ ones' lane at z 32.5 and
// the far ones brought in), booted through ready() and its frames run by the
// check (tools/pov-app.mjs), so its times are game time, not the wall's.
// usage: node tools/kick-hook-check.mjs [--shots dir]   (runs its own Vite: tools/vite-server.mjs)
import { openPovApp } from './pov-app.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const shots = opt('shots', null);
const W = 640, H = 400;
const Z = 32.5;   // the lane

let app = null, fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
try {
  app = await openPovApp({ viewport: { width: W, height: H } });
  const p = app.page;
  console.log(`booted in ${app.boot.toFixed(0)} s`);
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const frames = (n) => ev((n) => __pov.frames(n), n);
  const secs = (s) => ev((s) => __pov.frames(Math.max(1, Math.round(s / __pov.dt))), s);
  const shot = async (name) => { if (shots) { await ev(() => __app.test.renderOnce()); await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 60, scale: 'css' }); } };
  const census = () => ev(async () => {
    const { ELEMENTS } = await import('/src/elements.js');
    return Object.fromEntries(Object.entries(await window.__app.sim.census()).map(([k, v]) => [ELEMENTS[k].key, v.n]));
  });
  const GASES = new Set(['EMPTY', 'FIRE', 'SMOKE', 'STEAM', 'CLOUD']);
  const matter = (c) => Object.entries(c).filter(([k]) => !GASES.has(k)).reduce((s, [, n]) => s + n, 0);
  // clear the box and set the scene: [element key, center [x, y, z], radius] cubes; the player at feet, looking (yaw, pitch)
  const scene = (cubes, feet, yaw, pitch) => ev(async ({ cubes, feet, yaw, pitch }) => {
    const a = window.__app, { E } = await import('/src/elements.js'), V = a.THREE.Vector3;
    const g = a.sim.g;
    a.sim.paint({ center: new V(g.nx / 2, g.ny / 2, g.nz / 2), radius: g.nx, shape: 1, tool: E.EMPTY, rate: 1, replace: true });
    for (const [key, c, r] of cubes) a.sim.paint({ center: new V(...c), radius: r, shape: 1, tool: E[key], rate: 1, replace: true });
    a.pov.player.tether(null);
    a.pov.player.spawn(new V(...feet));
    a.pov.setLook(yaw, pitch);
  }, { cubes, feet, yaw, pitch });
  const player = () => ev(() => { const pl = window.__app.pov.player; return { pos: pl.pos.toArray(), vel: pl.vel.toArray(), onGround: pl.onGround }; });
  // F: a kick (the key held a frame or two, as a press is)
  const kick = async () => { await p.keyboard.down('f'); await frames(2); await p.keyboard.up('f'); await frames(1); return ev(() => window.__kicks.at(-1) ?? null); };
  // the SAND cells' mean x (a full readback)
  const sandX = () => ev(async () => {
    const a = window.__app, { E } = await import('/src/elements.js');
    const g = a.sim.g, [A] = await a.sim.readState();
    let n = 0, sx = 0;
    for (let z = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
      if (Math.round(A[a.sim.cellTexel(x, y, z) * 4]) === E.SAND) { n++; sx += x; }
    }
    return n ? sx / n : NaN;
  });

  await ev(async () => {
    const { povEvents } = await import('/src/pov/events.js');
    window.__kicks = []; window.__hook = [];
    povEvents.on('kick', (e) => window.__kicks.push({ hit: e.hit, id: e.id, broke: e.broke, mass: Number.isFinite(e.mass) ? e.mass : 'inf', dv: e.dv.toArray() }));
    povEvents.on('tool:action', (e) => { if (e.tool === 'hook') window.__hook.push({ action: e.action, id: e.id ?? null }); });
  });
  const entered = await app.enter();
  check('dropped in', entered.mode === 'on', `${entered.s.toFixed(0)} s, ${entered.frames} frames`);
  const RIGHT = -Math.PI / 2;   // yaw facing +x

  // ---- kick: a glass pane breaks
  await scene([['GLASS', [24, 4, Z], 2]], [19.5, 0, Z], RIGHT, 0);
  await secs(1.2);
  let c0 = await census();
  let k = await kick();
  await frames(4);
  await shot('kick-glass');
  await secs(0.6);
  let c1 = await census();
  check('kick breaks glass', (c1.SHARDS ?? 0) > (c0.SHARDS ?? 0), `GLASS ${c0.GLASS}→${c1.GLASS}, SHARDS ${c0.SHARDS ?? 0}→${c1.SHARDS ?? 0}, kick ${JSON.stringify(k)}`);
  check('kick adds no matter', matter(c1) === matter(c0), `${matter(c0)}→${matter(c1)}`);

  // ---- kick: a small heap of sand: the clump the boot meets flies off along the kick
  await scene([['SAND', [22.5, 1.5, Z], 1.2]], [20.5, 0, Z], RIGHT, -0.35);
  await secs(1.5);
  const sx0 = await sandX();
  // aim the boot at the slumped heap's near side, at the floor layer of sand (the hip is kick.js KICK_HIP up)
  const KICK_HIP_CELLS = 2.6, NEAR_SIDE = 0.5, SAND_LAYER = 0.5;
  await ev(([sx, hipUp, near, layer]) => {
    const pov = window.__app.pov, q = pov.player.pos;
    pov.setLook(-Math.PI / 2, Math.atan2(q.y + layer - (q.y + hipUp), sx - near - q.x));
  }, [sx0, KICK_HIP_CELLS, NEAR_SIDE, SAND_LAYER]);
  c0 = await census();
  await secs(0.7);   // the kick recovers
  k = await kick();
  // the clump flies (ballistics.js) and lands back in the sim: wait for it (4 s of frames at most)
  const flight = await ev(async () => {
    let flew = false;
    const kicker = window.__app.pov.player.kicker;
    const n = await __pov.frames(Math.round(4 / __pov.dt), () => { const c = kicker.carrying; flew ||= c.flying; return flew && !c.on; });
    return { flew, frames: n };
  });
  await secs(0.3);   // settle where it landed
  const sx1 = await sandX();
  console.log('  last kicked clump:', JSON.stringify(await ev(() => window.__app.pov.player.kicker.lastCarry)));
  c1 = await census();
  if (k?.hit !== 'cell') console.log('  kick ray crossed', JSON.stringify(await ev(() => window.__app.pov.player.kicker.walked)), 'feet', (await player()).pos.map((x) => x.toFixed(2)).join(','));
  check('kick shoves loose sand away (mean x)', k?.hit === 'cell' && sx1 > sx0, `x ${sx0.toFixed(2)}→${sx1.toFixed(2)}, kick ${JSON.stringify(k)}`);
  const sandCellKg = await ev(async () => (await import('/src/pov/tug.js')).cellKg((await import('/src/elements.js')).E.SAND));
  check('the kicked sand flies (a projectile) and lands back in the sim', flight.flew, JSON.stringify(flight));
  check('the boot moves the grains it meets, not the heap (one cell\'s mass)', k?.hit === 'cell' && Math.abs(k.mass - sandCellKg) < 1e-6,
    `struck ${typeof k?.mass === 'number' ? k.mass.toFixed(1) : k?.mass} kg, a sand cell ${sandCellKg.toFixed(1)} kg`);
  check('sand conserved', (c0.SAND ?? 0) === (c1.SAND ?? 0), `${c0.SAND}→${c1.SAND}`);

  // ---- kick: in the air, a rock wall throws you back (the wall kick)
  await scene([['ROCK', [24, 4, Z], 2]], [20, 0, Z], RIGHT, -0.1);
  await secs(1.2);
  await ev(() => { const pl = window.__app.pov.player; pl.vel.set(0, 30, 0); pl.onGround = false; });   // off the ground (a jump's way up)
  const air = await player();
  k = await kick();
  const after = await player();
  check('wall kick throws you off the wall', k?.hit === 'cell' && k.mass === 'inf' && k.dv[0] < -40, `onGround ${air.onGround}, dv ${k?.dv.map((x) => x.toFixed(1))}, vel x ${after.vel[0].toFixed(1)}`);

  // ---- kick: standing, the floor below lifts you (kick-jump)
  await scene([], [40.5, 0, Z], RIGHT, -1.45);
  await secs(1.7);
  const y0 = (await player()).pos[1];
  k = await kick();
  let top = y0;
  for (let i = 0; i < 12; i++) { await frames(1); top = Math.max(top, (await player()).pos[1]); }
  check('kicking the floor lifts you', k?.dv[1] > 30 && top > y0 + 2, `dv y ${k?.dv[1]?.toFixed(1)}, rose ${(top - y0).toFixed(2)} cells`);

  // ---- kick: a body in front is shoved by momentum (a test target, as an NPC registers one)
  await scene([], [40.5, 0, Z], RIGHT, 0);
  await secs(1.2);
  await ev(async (Z) => {
    const { addTarget } = await import('/src/pov/targets.js');
    window.__dummy = { hurt: 0, dv: null };
    window.__removeDummy = addTarget({
      id: 'dummy', alive: true,
      box(min, max) { min.set(42.2, 0, Z - 0.8); max.set(43.8, 5.5, Z + 0.8); },
      hurt(amount) { window.__dummy.hurt += amount; },
      shove(dv) { window.__dummy.dv = dv.toArray(); },
    });
  }, Z);
  await secs(0.5);
  k = await kick();
  const dummy = await ev(() => { window.__removeDummy(); return window.__dummy; });
  check('kick shoves a body by momentum (equal masses: half each)', k?.hit === 'body' && dummy.dv && Math.abs(dummy.dv[0] - 23.3) < 1 && dummy.hurt > 0,
    `dummy dv ${dummy.dv?.map((x) => x.toFixed(1))}, hurt ${dummy.hurt}, my dv ${k?.dv.map((x) => x.toFixed(1))}`);

  // ---- hook: reel in to a wall (its face at x 50, 35.5 cells off)
  const hold = (key) => app.hold(key);   // (in hand, its slot selector gone: a click while it's up only closes it)
  await scene([['ROCK', [54, 12, Z], 4]], [14.5, 0, Z], RIGHT, Math.atan2(12 - 5, 50 - 14.5));
  await secs(1.2);
  check('hook is carried (Gadgets, starts in hand)', await hold('HOOK'), await ev(() => window.__app.pov.toolbelt.selectedKey));
  await secs(0.4);
  const x0 = (await player()).pos[0];
  await p.mouse.down();
  let best = Infinity;
  for (let i = 0; i < 40; i++) {
    await frames(2);
    const state = await ev(() => window.__app.pov.toolbelt.tool('HOOK').state);
    best = Math.min(best, Math.abs(50 - (await player()).pos[0]));
    if (i === 6) await shot('hook-reel');
    if (state === 'back' || state === 'idle') break;
  }
  await p.mouse.up();
  const x1 = (await player()).pos[0];
  const hookLog = await ev(() => window.__hook.map((e) => e.action).join(' '));
  check('hook catches the wall and reels you to it', hookLog.includes('catch') && x1 - x0 > 20, `x ${x0.toFixed(1)}→${x1.toFixed(1)} (wall face at 50), closest ${best.toFixed(1)}, events: ${hookLog}`);
  await ev(() => { window.__hook.length = 0; });

  // ---- hook: hang from a high anchor and swing (let go of the reel)
  // a high anchor, fired at from a pillar top; then a shove off the pillar
  await scene([['ROCK', [48.5, 60, Z], 3], ['ROCK', [34.5, 14, Z], 0.5]], [34.5, 15, Z], RIGHT, Math.atan2(57 - 20, 48.5 - 34.5));
  await secs(1.5);
  await p.mouse.down(); await frames(1); await p.mouse.up();   // a click: fire, then hang at the length it caught at
  await ev(() => __pov.frames(90, () => window.__app.pov.toolbelt.tool('HOOK').state === 'anchor'));
  await ev(() => { window.__app.pov.player.vel.set(-30, 20, 0); });   // off the pillar, away from under the anchor
  const xs = [];
  let stretch = 0;
  for (let i = 0; i < 40; i++) {
    await frames(2);
    const r = await ev(() => {
      const pl = window.__app.pov.player, rope = pl.rope;
      if (!rope) return null;
      return { x: pl.pos.x, d: pl.ropeHand().distanceTo(rope.anchor), len: rope.length };
    });
    if (r) { xs.push(r.x); stretch = Math.max(stretch, r.d - r.len); }
    if (i === 20) await shot('hook-swing');
  }
  const span = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  let turns = 0;
  for (let i = 2; i < xs.length; i++) if ((xs[i] - xs[i - 1]) * (xs[i - 1] - xs[i - 2]) < 0) turns++;
  check('hanging on the rope swings like a pendulum', xs.length > 20 && span > 6 && turns >= 1, `${xs.length} frames on the rope, swing ${span.toFixed(1)} cells, ${turns} turn(s)`);
  check('the rope holds its length', stretch < 1, `worst stretch ${stretch.toFixed(2)} cells`);
  await p.mouse.down({ button: 'right' }); await frames(1); await p.mouse.up({ button: 'right' });
  await frames(3);
  check('right-click lets go', !(await ev(() => window.__app.pov.player.rope)), await ev(() => window.__hook.map((e) => e.action).join(' ')));

  // ---- hook: loose sand comes to you
  await ev(() => { window.__hook.length = 0; });
  await scene([['SAND', [50, 1, Z], 2]], [30.5, 0, Z], RIGHT, Math.atan2(1 - 5, 50 - 30.5));
  await secs(1.5);
  c0 = await census();
  const sxa = await sandX();
  await p.mouse.down(); await frames(1); await p.mouse.up();
  for (let i = 0; i < 40; i++) {
    await frames(2);
    if (i === 5) await shot('hook-sand');
    if ((await ev(() => window.__app.pov.toolbelt.tool('HOOK').state)) === 'idle' && i > 3) break;
  }
  await secs(0.8);
  c1 = await census();
  const sxb = await sandX();
  const log = await ev(() => window.__hook);
  const caughtSand = log.some((e) => e.action === 'catch' && e.id != null);
  check('hook bites loose sand and brings it to you', caughtSand && log.some((e) => e.action === 'dump') && sxb < sxa, `events ${log.map((e) => e.action).join(' ')}, sand mean x ${sxa.toFixed(2)}→${sxb.toFixed(2)}`);
  check('sand conserved through the hook', (c0.SAND ?? 0) === (c1.SAND ?? 0), `${c0.SAND}→${c1.SAND}`);
  check(`no page or GPU errors (${app.secs()})`, app.errors.length === 0, app.errors.slice(0, 5).join(' | '));
} catch (err) {
  fails++;
  console.log('FAIL threw', String(err).slice(0, 500));
} finally {
  await app?.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
