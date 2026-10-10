// Kick and hook end-to-end check (docs/pov.md "Kick", "Hook"): the kick breaks
// glass, shoves loose sand, throws you off a wall in the air and off the floor
// standing, and shoves a body; the hook reels you to a wall, hangs you to swing
// on, and brings a bite of sand to you, with matter conserved.
// usage: node tools/kick-hook-check.mjs [--port 5421] [--shots dir]   (needs a dev server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5421');
const shots = opt('shots', null);
const W = 960, H = 600;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 300)); });   // (no local multiplayer relay)
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
await p.goto(`http://localhost:${port}/?preset=empty`);
await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
// (headless has no real pointer lock, so the hotbar's tool stack, which opens over the crosshair on a switch, would take the clicks meant for the tool)
await p.addStyleTag({ content: '.hb-stack { pointer-events: none !important; }' });
await p.waitForTimeout(1500);

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const wait = (ms) => p.waitForTimeout(ms);
const shot = async (name) => { if (shots) await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 60, scale: 'css' }); };
const census = () => ev(async () => {
  const { ELEMENTS } = await import('/src/elements.js');
  return Object.fromEntries(Object.entries(window.__app.sim.census()).map(([k, v]) => [ELEMENTS[k].key, v.n]));
});
const GASES = new Set(['EMPTY', 'FIRE', 'SMOKE', 'STEAM', 'CLOUD']);
const matter = (c) => Object.entries(c).filter(([k]) => !GASES.has(k)).reduce((s, [, n]) => s + n, 0);
// clear the box and set the scene: [element key, center [x, y, z], radius] cubes; the player at feet, looking (yaw, pitch)
const scene = (cubes, feet, yaw, pitch) => ev(async ({ cubes, feet, yaw, pitch }) => {
  const a = window.__app, { E } = await import('/src/elements.js'), V = a.camera.position.constructor;
  const g = a.sim.g;
  a.sim.paint({ center: new V(g.nx / 2, g.ny / 2, g.nz / 2), radius: g.nx, shape: 1, tool: E.EMPTY, rate: 1, replace: true });
  for (const [key, c, r] of cubes) a.sim.paint({ center: new V(...c), radius: r, shape: 1, tool: E[key], rate: 1, replace: true });
  a.pov.player.tether(null);
  a.pov.player.spawn(new V(...feet));
  a.pov.setLook(yaw, pitch);
}, { cubes, feet, yaw, pitch });
const player = () => ev(() => { const pl = window.__app.pov.player; return { pos: pl.pos.toArray(), vel: pl.vel.toArray(), onGround: pl.onGround }; });
const kick = async () => { await p.keyboard.press('f'); await wait(60); return ev(() => window.__kicks.at(-1) ?? null); };
// the SAND cells' mean x (a full readback)
const sandX = () => ev(async () => {
  const a = window.__app, { E } = await import('/src/elements.js');
  const g = a.sim.g, [A] = a.sim.readState();
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
await p.mouse.move(W / 2, H / 2);
await p.keyboard.press('f');
await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 }).catch(() => {});
check('dropped in', (await ev(() => window.__app.pov.mode)) === 'on');
await ev(() => { window.__app.pov.test.assumeLocked = true; });
const RIGHT = -Math.PI / 2;   // yaw facing +x

// ---- kick: a glass pane breaks
await scene([['GLASS', [24, 4, 64.5], 2]], [19.5, 0, 64.5], RIGHT, 0);
await wait(1200);
let c0 = await census();
let k = await kick();
await wait(120);
await shot('kick-glass');
await wait(600);
let c1 = await census();
check('kick breaks glass', (c1.SHARDS ?? 0) > (c0.SHARDS ?? 0), `GLASS ${c0.GLASS}→${c1.GLASS}, SHARDS ${c0.SHARDS ?? 0}→${c1.SHARDS ?? 0}, kick ${JSON.stringify(k)}`);
check('kick adds no matter', matter(c1) === matter(c0), `${matter(c0)}→${matter(c1)}`);

// ---- kick: a lone heap of sand is shoved along the kick
// a heap of sand just past the feet (one paint: many small paints in one frame don't all land)
await scene([['SAND', [24, 2.5, 64.5], 2.5]], [19.5, 0, 64.5], RIGHT, -0.6);
await wait(1500);
const sx0 = await sandX();
c0 = await census();
await wait(700);   // the kick recovers
k = await kick();
await wait(700);
const sx1 = await sandX();
c1 = await census();
if (k?.hit !== 'cell') console.log('  kick ray crossed', JSON.stringify(await ev(() => window.__app.pov.player.kicker.walked)), 'feet', (await player()).pos.map((x) => x.toFixed(2)).join(','));
check('kick shoves loose sand away (mean x)', k?.hit === 'cell' && sx1 > sx0, `x ${sx0.toFixed(2)}→${sx1.toFixed(2)}, kick ${JSON.stringify(k)}`);
check('sand conserved', (c0.SAND ?? 0) === (c1.SAND ?? 0), `${c0.SAND}→${c1.SAND}`);

// ---- kick: in the air, a rock wall throws you back (the wall kick)
await scene([['ROCK', [24, 4, 64.5], 2]], [20, 0, 64.5], RIGHT, -0.1);
await wait(1200);
// off the ground (a jump's way up), and kick the wall on the way
await ev(() => { const pl = window.__app.pov.player; pl.vel.set(0, 30, 0); pl.onGround = false; });
const air = await player();
k = await kick();
await wait(30);
const after = await player();
check('wall kick throws you off the wall', k?.hit === 'cell' && k.mass === 'inf' && k.dv[0] < -40, `onGround ${air.onGround}, dv ${k?.dv.map((x) => x.toFixed(1))}, vel x ${after.vel[0].toFixed(1)}`);

// ---- kick: standing, the floor below lifts you (kick-jump)
await scene([], [40.5, 0, 64.5], RIGHT, -1.45);
await wait(1200);
await wait(500);
const y0 = (await player()).pos[1];
k = await kick();
let top = y0;
for (let i = 0; i < 10; i++) { await wait(40); top = Math.max(top, (await player()).pos[1]); }
check('kicking the floor lifts you', k?.dv[1] > 30 && top > y0 + 2, `dv y ${k?.dv[1]?.toFixed(1)}, rose ${(top - y0).toFixed(2)} cells`);

// ---- kick: a body in front is shoved by momentum (a test target, as an NPC registers one)
await scene([], [40.5, 0, 64.5], RIGHT, 0);
await wait(1200);
await ev(async () => {
  const { addTarget } = await import('/src/pov/targets.js');
  window.__dummy = { hurt: 0, dv: null };
  window.__removeDummy = addTarget({
    id: 'dummy', alive: true,
    box(min, max) { min.set(42.2, 0, 63.7); max.set(43.8, 5.5, 65.3); },
    hurt(amount) { window.__dummy.hurt += amount; },
    shove(dv) { window.__dummy.dv = dv.toArray(); },
  });
});
await wait(500);
k = await kick();
const dummy = await ev(() => { window.__removeDummy(); return window.__dummy; });
check('kick shoves a body by momentum (equal masses: half each)', k?.hit === 'body' && dummy.dv && Math.abs(dummy.dv[0] - 23.3) < 1 && dummy.hurt > 0,
  `dummy dv ${dummy.dv?.map((x) => x.toFixed(1))}, hurt ${dummy.hurt}, my dv ${k?.dv.map((x) => x.toFixed(1))}`);

// ---- hook: reel in to a wall
const hold = (key) => ev((key) => window.__app.pov.toolbelt.select(key), key);
await scene([['ROCK', [70, 12, 64.5], 4]], [30.5, 0, 64.5], RIGHT, Math.atan2(12 - 5, 66 - 30.5));
await wait(1200);
check('hook is carried (Gadgets, starts in hand)', await hold('HOOK'), await ev(() => window.__app.pov.toolbelt.selectedKey));
await wait(400);
const x0 = (await player()).pos[0];
await p.mouse.down();
let state = '', best = Infinity;
for (let i = 0; i < 40; i++) {
  await wait(60);
  state = await ev(() => window.__app.pov.toolbelt.tool('HOOK').state);
  const pl = await player();
  best = Math.min(best, Math.abs(66 - pl.pos[0]));
  if (i === 6) await shot('hook-reel');
  if (state === 'back' || state === 'idle') break;
}
await p.mouse.up();
const x1 = (await player()).pos[0];
const hookLog = await ev(() => window.__hook.map((e) => e.action).join(' '));
check('hook catches the wall and reels you to it', hookLog.includes('catch') && x1 - x0 > 20, `x ${x0.toFixed(1)}→${x1.toFixed(1)} (wall face at 66), closest ${best.toFixed(1)}, events: ${hookLog}`);
await ev(() => { window.__hook.length = 0; });

// ---- hook: hang from a high anchor and swing (let go of the reel)
// a high anchor, fired at from a pillar top; then a shove off the pillar
await scene([['ROCK', [64.5, 60, 64.5], 3], ['ROCK', [50.5, 14, 64.5], 0.5]], [50.5, 15, 64.5], RIGHT, Math.atan2(57 - 20, 64.5 - 50.5));
await wait(1500);
await p.mouse.down(); await wait(40); await p.mouse.up();   // a click: fire, then hang at the length it caught at
await p.waitForFunction(() => window.__app.pov.toolbelt.tool('HOOK').state === 'anchor', null, { timeout: 3000 }).catch(() => {});
await ev(() => { window.__app.pov.player.vel.set(-30, 20, 0); });   // off the pillar, away from under the anchor
const xs = [];
let stretch = 0;
for (let i = 0; i < 40; i++) {
  await wait(60);
  const r = await ev(() => {
    const a = window.__app, pl = a.pov.player, rope = pl.rope;
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
await p.mouse.down({ button: 'right' }); await wait(40); await p.mouse.up({ button: 'right' });
await wait(100);
check('right-click lets go', !(await ev(() => window.__app.pov.player.rope)), await ev(() => window.__hook.map((e) => e.action).join(' ')));

// ---- hook: loose sand comes to you
await ev(() => { window.__hook.length = 0; });
await scene([['SAND', [50, 1, 64.5], 2]], [30.5, 0, 64.5], RIGHT, Math.atan2(1 - 5, 50 - 30.5));
await wait(1500);
c0 = await census();
const sxa = await sandX();
await p.mouse.down(); await wait(40); await p.mouse.up();
for (let i = 0; i < 40; i++) {
  await wait(60);
  if (i === 5) await shot('hook-sand');
  if ((await ev(() => window.__app.pov.toolbelt.tool('HOOK').state)) === 'idle' && i > 3) break;
}
await wait(800);
c1 = await census();
const sxb = await sandX();
const log = await ev(() => window.__hook);
const caughtSand = log.some((e) => e.action === 'catch' && e.id != null);
check('hook bites loose sand and brings it to you', caughtSand && log.some((e) => e.action === 'dump') && sxb < sxa, `events ${log.map((e) => e.action).join(' ')}, sand mean x ${sxa.toFixed(2)}→${sxb.toFixed(2)}`);
check('sand conserved through the hook', (c0.SAND ?? 0) === (c1.SAND ?? 0), `${c0.SAND}→${c1.SAND}`);

check('no errors', errs.length === 0, errs.slice(0, 5).join(' | '));
await b.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
