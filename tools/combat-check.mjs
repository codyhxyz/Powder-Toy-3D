// End-to-end check of the Big Team Battle combat slice through the real shell,
// body and toolbelt: the Energy Shield (absorbs, holds off, refills, HUD), the
// movement perks (each doubles its quantity, measured in game time by wrapping
// player.update), the knife (a backstab kills an NPC in one blow, through its
// shield; a stab from the front doesn't) and the pogo stick (bounce heights grow
// with presses timed to the landing, and drop back without).
// usage: node tools/combat-check.mjs [--port 5401] [--shot file.jpg]   (needs a dev server; AC power)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5401');
const shotPath = opt('shot', null);
const W = 960, H = 600;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const settle = (ms) => p.waitForTimeout(ms);
const near = (a, b, tol) => Math.abs(a / b - 1) <= tol;
// give a catalog tool (inventory.js, as the palette's Tools group does) and put it in hand
const hold = (key) => ev(async (key) => {
  const { inventory } = await import('/src/pov/tools/inventory.js');
  inventory.give(key);
  window.__app.pov.toolbelt.select(key);
  return window.__app.pov.toolbelt.selectedKey;
}, key);

async function dropIn(url) {
  await p.goto(url);
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await settle(1500);
  await p.mouse.move(W / 2, H * 0.62);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });
  await ev(() => {
    const pov = window.__app.pov;
    pov.test.assumeLocked = true;
    // game time: every player.update's dt, and a hook that runs before each one
    const pl = pov.player, orig = pl.update;
    window.__game = { t: 0, before: null, after: null };
    pl.update = (dt, input) => {
      window.__game.before?.(dt, input);
      orig(dt, input);
      window.__game.t += Math.min(Math.max(dt, 0), 0.1);   // player.js MAX_DT
      window.__game.after?.(dt, input);
    };
  });
}
const stand = (x, z, y = 0) => ev(([x, y, z]) => { const a = window.__app; a.pov.player.spawn(a.pov.player.pos.clone().set(x, y, z)); }, [x, y, z]);
const perksTo = (keys) => ev((keys) => { const s = window.__app.pov.player.perks; s.clear(); keys.forEach((k) => s.add(k)); }, keys);
const game = () => ev(() => window.__game.t);
const waitGame = async (s) => { const t0 = await game(); await p.waitForFunction(([t0, s]) => window.__game.t - t0 >= s, [t0, s], { timeout: 60000 }); };

try {
  // ================= an empty box: the shield, the movement perks, the pogo
  await dropIn(`http://localhost:${port}/?size=128&preset=empty`);
  check('dropped in', (await ev(() => window.__app.pov.mode)) === 'on');

  // ---- Energy Shield
  await stand(64, 64);
  await perksTo(['ENERGY_SHIELD']);
  await waitGame(2.5);   // it fills in 2 s from empty
  const s0 = await ev(() => { const pl = window.__app.pov.player; return { shield: pl.shield, max: pl.shieldMax, health: pl.health, shown: document.querySelector('.pov-shield')?.classList.contains('show') }; });
  check('shield fills to 70/45 of a life', near(s0.shield, 70 / 45, 0.01) && s0.shown, JSON.stringify(s0));
  await ev(() => {
    const pl = window.__app.pov.player;
    window.__shieldEv = [];
    pl.on('shield', (e) => window.__shieldEv.push({ ...e, t: window.__game.t }));
    window.__hitT = window.__game.t;
    pl.hurt(0.6, 'test');
  });
  const s1 = await ev(() => ({ shield: window.__app.pov.player.shield, health: window.__app.pov.player.health }));
  check('a blow hits the shield, not health', near(s1.shield, 70 / 45 - 0.6, 0.01) && s1.health === 1, JSON.stringify(s1));
  await ev(() => window.__app.pov.player.hurt(1.2, 'test'));   // 0.96 left on the shield: 0.24 goes on
  await settle(100);
  const s2 = await ev(() => ({ shield: window.__app.pov.player.shield, health: window.__app.pov.player.health, empty: document.querySelector('.pov-shield').classList.contains('empty'), ev: window.__shieldEv.map((e) => e.state) }));
  check('a big blow breaks it, the rest goes to health', s2.shield === 0 && s2.health < 1 && s2.ev.includes('break') && s2.empty, JSON.stringify(s2));
  await ev(() => { window.__breakT = window.__shieldEv.find((e) => e.state === 'break').t; });
  await p.waitForFunction(() => window.__shieldEv.some((e) => e.state === 'full' && e.t > window.__breakT), null, { timeout: 20000 });
  const s3 = await ev(() => {
    const e = window.__shieldEv, rc = e.find((x) => x.state === 'recharge' && x.t > window.__breakT), full = e.find((x) => x.state === 'full' && x.t > window.__breakT);
    return { delay: rc.t - window.__breakT, refill: full.t - rc.t, shield: window.__app.pov.player.shield };
  });
  check('refill starts 5 s after the last hit (Halo 3)', near(s3.delay, 5, 0.05), `${s3.delay.toFixed(2)} s game time`);
  check('refills in 2 s from empty (Halo 3)', near(s3.refill, 2, 0.08), `${s3.refill.toFixed(2)} s game time`);
  // (a lethal blow through the shield is checked on the NPC below: killing the player here would respawn it mid-check)

  // ---- movement perks: each doubles its quantity (game time)
  // sprint: the steady ground speed with Shift held
  const sprint = async (perk) => {
    await perksTo(perk ? [perk] : []);
    await stand(16, 64);
    await ev(() => window.__app.pov.setLook(-Math.PI / 2, 0));   // facing +x
    await waitGame(0.3);
    await p.keyboard.down('ShiftLeft'); await p.keyboard.down('KeyW');
    await waitGame(0.6);
    await ev(() => { window.__m = { t: 0, d: 0, x: window.__app.pov.player.pos.x }; window.__game.after = (dt) => { window.__m.t += Math.min(dt, 0.1); }; });
    await waitGame(0.6);
    const r = await ev(() => { window.__game.after = null; return (window.__app.pov.player.pos.x - window.__m.x) / window.__m.t; });
    await p.keyboard.up('KeyW'); await p.keyboard.up('ShiftLeft');
    return r;
  };
  const run1 = await sprint(null), run2 = await sprint('FLEET_FOOT');
  check('Fleet Foot doubles sprint speed', near(run2 / run1, 2, 0.08), `${run1.toFixed(1)} → ${run2.toFixed(1)} cells/s`);

  // the jet: climb speed (Rocket Boots: the body's own vertical speed once eased in, so a frame
  // that waits on a late probe readback doesn't count as slow) and fuel burned per second of
  // thrust (Big Tank)
  const jet = async (perk) => {
    await perksTo(perk ? [perk] : []);
    await stand(64, 64);
    await waitGame(0.4);
    await ev(() => {
      window.__m = { t: 0, fuel: 0, vy: [], frames: 0, stalls: 0 };
      window.__game.before = () => { window.__m.f0 = window.__app.pov.player.jetFuel; window.__m.j0 = window.__app.pov.player.jetting; };
      window.__game.after = (dt) => {
        const pl = window.__app.pov.player, m = window.__m;
        if (pl.jetting && m.j0) {
          m.t += Math.min(dt, 0.1); m.fuel += m.f0 - pl.jetFuel;
          // the climb once the jet has eased in (after 0.25 s of thrust); a frame the body didn't move is a probe stall
          if (m.t > 0.25) { m.vy.push(pl.vel.y); m.frames++; if (pl.pos.y === m.y) m.stalls++; }
          m.y = pl.pos.y;
        }
      };
    });
    await p.keyboard.down('Space');
    await waitGame(0.75);
    await p.keyboard.up('Space');
    const r = await ev(() => {
      const m = window.__m; window.__game.before = window.__game.after = null;
      const vy = [...m.vy].sort((a, b) => a - b);
      return { burn: m.fuel / m.t, climb: vy[vy.length >> 1], stalls: `${m.stalls}/${m.frames}` };
    });
    await waitGame(2.5);   // fall back down
    return r;
  };
  const j0 = await jet(null), jBoots = await jet('ROCKET_BOOTS'), jTank = await jet('BIG_TANK');
  check('Rocket Boots double the jet climb', near(jBoots.climb / j0.climb, 2, 0.05), `${j0.climb.toFixed(1)} → ${jBoots.climb.toFixed(1)} cells/s (probe stalls: ${j0.stalls} plain, ${jBoots.stalls} boots)`);
  check('Big Tank doubles time aloft (half the fuel per second)', near(j0.burn / jTank.burn, 2, 0.05), `${(1 / j0.burn).toFixed(2)} s → ${(1 / jTank.burn).toFixed(2)} s on a tank`);

  // ---- pogo stick: heights grow with presses timed to the landing
  await perksTo([]);
  await stand(64, 64);
  check('the pogo stick is a catalog tool in hand', (await hold('POGO')) === 'POGO');
  await settle(200);
  await ev(() => {
    const pov = window.__app.pov, pl = pov.player;
    const key = (down) => dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code: 'Space', key: ' ', bubbles: true }));
    window.__pogo = { timed: false, apexes: [], steps: [], top: 0, pressFrames: -1, armed: true, frames: 0, dtSum: 0 };
    pl.on('pogo', (e) => {
      const g = window.__pogo;
      if (e.late) { g.steps[g.steps.length - 1] = e.step; return; }   // a press just after the bounce: the same bounce, a step up
      g.apexes.push(+g.top.toFixed(2)); g.steps.push(e.step); g.top = 0; g.armed = true;
    });
    window.__game.after = (dt) => {
      const g = window.__pogo;
      g.top = Math.max(g.top, pl.pos.y);
      if (g.pressFrames >= 0 && --g.pressFrames < 0) key(false);   // a tap: released a few frames on
      // timed: press when the body will reach the floor (y = 0) within about the next frame, so the
      // press is read on the landing frame or the one before, whatever the frame rate
      g.frames++; g.dtSum += Math.min(dt, 0.1);
      if (g.timed && g.armed && pl.vel.y < 0 && pl.pos.y < -pl.vel.y * Math.min(dt, 0.1)) { g.armed = false; key(true); g.pressFrames = 3; }
    };
  });
  await waitGame(3);   // untimed bounces settle at the rest height
  await ev(() => { window.__pogo.timed = true; window.__pogo.mark = window.__pogo.apexes.length; });
  await waitGame(9);
  await ev(() => { window.__pogo.timed = false; window.__pogo.mark2 = window.__pogo.apexes.length; });
  await waitGame(3);
  const pg = await ev(() => { window.__game.after = null; return window.__pogo; });
  // each bounce's own apex is the one recorded at the next bounce; group them by step
  const byStep = [[], [], [], []], afterSteps = [];
  for (let k = 1; k + 1 < pg.steps.length; k++) {
    byStep[pg.steps[k]]?.push(pg.apexes[k + 1]);
    if (k >= pg.mark2 + 1) afterSteps.push([pg.steps[k], pg.apexes[k + 1]]);
  }
  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
  const h = byStep.map((a) => (a.length ? median(a) : NaN));
  // the body's jump: 95 Noita px/frame against 350 px/frame², scaled by height (player.js)
  const jumpH = (95 * 95) / (2 * 350) * (5.5 / 11);
  const want = [0, 1, 2, 3].map((k) => jumpH * (750 + (1518 - 750) * k) / 1124);
  const fmt = (a) => a.map((x) => x.toFixed(1)).join(', ');
  check('untimed pogo bounces at Keen\'s released height', byStep[0].length >= 2 && near(h[0], want[0], 0.12), `${fmt(byStep[0])} (want ≈ ${want[0].toFixed(1)})`);
  check('timed presses climb a step a bounce, to Keen\'s and SM64\'s heights', h.every((x, k) => near(x, want[k], 0.12)), `by step ${fmt(h)} (want ${fmt(want)}); steps ${pg.steps.join('')}`);
  check('the climb tops out at three steps', byStep[3].length >= 2 && Math.max(...pg.steps) === 3, `${byStep[3].length} bounces at step 3`);
  check('no timed press: back to the rest bounce', afterSteps.length >= 1 && afterSteps.every(([st, a]) => st === 0 && near(a, want[0], 0.2)), JSON.stringify(afterSteps));
  console.log(`     (pogo run at ${(pg.frames / pg.dtSum).toFixed(0)} fps; apex scatter is the frame-time jitter)`);
  check('pogoing never hurt', (await ev(() => window.__app.pov.player.health)) === 1);
  await hold('SHOVEL');

  if (shotPath) {
    // the shield bar and the held knife, from the front of an empty box
    await perksTo(['ENERGY_SHIELD', 'FLEET_FOOT', 'ROCKET_BOOTS', 'BIG_TANK']);
    await stand(64, 40);
    await ev(() => window.__app.pov.setLook(0, -0.1));
    await hold('KNIFE');
    await waitGame(1);
    await ev(() => window.__app.pov.player.hurt(0.4, 'test'));
    await settle(80);
    await p.screenshot({ path: shotPath, type: 'jpeg', quality: 60, scale: 'css' });
  }

  // ================= the lab: the knife on its NPC
  await dropIn(`http://localhost:${port}/?preset=lab`);
  await p.waitForFunction(() => window.__app.pov.npc?.placeAt, null, { timeout: 30000 });
  await settle(1500);
  check('the knife is a catalog tool in hand', (await hold('KNIFE')) === 'KNIFE');
  await hold('SHOVEL');
  // One stab, synchronously, so nothing moves between the setup and the blow: from `side`
  // ('behind' or 'front') of the NPC, 2.6 cells from its middle, aimed at its chest.
  const stab = (side) => ev(async (side) => {
    const { targetById } = await import('/src/pov/targets.js');
    const V3 = window.__app.camera.position.constructor;
    const pov = window.__app.pov, npc = pov.npc, t = targetById(npc.id), knife = pov.toolbelt.tool('KNIFE');
    const f = t.facing(new V3()).setY(0).normalize();
    const c = npc.body.pos.clone().setY(npc.body.pos.y + 2.75);
    const feet = npc.body.pos.clone().addScaledVector(f, side === 'behind' ? -2.6 : 2.6);
    const eye = feet.clone().setY(feet.y + 5);
    const ctx = {
      ...pov.ctx, dt: 1, toolRate: 1, eye, dir: c.clone().sub(eye).normalize(),
      aim: { valid: false, cell: new V3(), dist: Infinity },
      primary: false, primaryPressed: false, secondary: false, secondaryPressed: false, wheel: 0,
      player: { pos: feet, vel: new V3(), onGround: true, inLiquid: false, applyImpulse() {}, holdPogo() {} },
    };
    const before = { health: npc.body.health, shield: npc.body.shield };
    knife.update(ctx);                       // aimed, not swinging: is the tell up?
    const tell = knife.telling;
    knife.update({ ...ctx, primary: true, primaryPressed: true });
    knife.deselect();
    return { tell, before, after: { health: npc.body.health, shield: npc.body.shield, dead: npc.body.dead, cause: npc.body.cause } };
  }, side);
  const front = await stab('front');
  check('from the front: no tell, a weak stab that doesn\'t kill', !front.tell && !front.after.dead && front.after.health < front.before.health && front.before.health - front.after.health < 0.34 * 0.6, JSON.stringify(front));
  await ev(() => { const n = window.__app.pov.npc; n.body.perks.add('ENERGY_SHIELD'); });
  // its shield fills (after the stab's 5 s hold-off, if nothing else hits it)
  await p.waitForFunction(() => { const b = window.__app.pov.npc.body; return b.shieldMax > 0 && b.shield >= b.shieldMax; }, null, { timeout: 30000 });
  const shielded = await stab('front');
  check('a shielded NPC\'s shield takes a front stab', shielded.after.shield < shielded.before.shield && shielded.after.health === shielded.before.health, JSON.stringify(shielded));
  const back = await stab('behind');
  check('from behind: the tell is up, one stab kills through the shield', back.tell && back.after.dead && back.after.cause === 'Backstabbed', JSON.stringify(back));
} catch (err) {
  fails++;
  console.log('FAIL threw', String(err).slice(0, 500));
}

check('no console errors', errs.length === 0, errs.slice(0, 4).join(' || '));
await b.close();
console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
