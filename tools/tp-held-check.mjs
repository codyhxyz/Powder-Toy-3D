// Headless check of the tool in hand in third person (pov/held.js, holds.js,
// limbs.js): each hold's hands reach its grips, the pogo stick is ridden (feet
// on its pegs, its foot on the ground), the held model is lit like the body, a
// gun's muzzle flash leaves from the gun on the body, an axe's swing moves the
// held axe, first person puts the viewmodel back at the eye, and the stickman
// holds tools too.
// usage: node tools/tp-held-check.mjs [--port 5205 | --url https://tpt3d.codyh.xyz]   (a dev server, or the live site)
import { launchBrowser, newTestPage } from './browser.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5205');
const url = opt('url', `http://localhost:${port}`);
const W = 900, H = 560;
const SPAWN = [64, 0, 64.5];
const YAW = -Math.PI / 2;
const HAND_TOL = 0.5;                     // cells from a hand bone (the wrist) to its grip's centre: about a hand's length
const FOOT_TOL = 0.7;                     // cells from an ankle to its peg (the ankle sits above and behind the sole's middle)
const STICK_TOL = 0.15;                   // cells: the stickman's hand point is the grip
const TIP_TOL = 0.3;                      // cells between the pogo's foot and the body's feet
const MUZZLE_PAD = 0.6;                   // cells round the held gun's box the flash may leave from
const SWING_TURN = 0.2;                   // rad the held axe turns at least during a swing
const SETTLE_MS = 900;

const b = await launchBrowser();
let fails = 0;
try {
  const p = await newTestPage(b, { mode: 'preview', viewport: { width: W, height: H } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.stack || e).slice(0, 1200)));
  const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const wait = (ms) => p.waitForTimeout(ms);
  await p.goto(`${url}/?preset=empty`, { timeout: 120000 });
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 120000 });
  await wait(1500);
  await p.mouse.move(W / 2, H / 2);
  await p.keyboard.press('v');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 }).catch(() => {});
  await ev(([spawn, yaw]) => {
    const a = window.__app;
    a.pov.test.assumeLocked = true; a.pov.player.spawn(new a.THREE.Vector3(...spawn)); a.pov.setLook(yaw, 0);
  }, [SPAWN, YAW]);
  await p.waitForFunction(() => window.__app.pov.figure.loaded, null, { timeout: 30000 }).catch(() => {});
  await p.keyboard.press('F5');
  await wait(1500);

  // where the hands and feet are against where they were sent, in cells
  const measure = () => ev(() => {
    const a = window.__app, T = a.THREE, f = a.pov.figure, h = a.pov.held, r = h.reached;
    const real = f.showing === 'real';
    const body = real ? f.real : null;
    const s = (real ? body.root : f.root.children[0]).getWorldScale(new T.Vector3()).x;
    const bone = (n) => (real ? body.model.getObjectByName(n) : null);
    const stickLimb = (side) => {   // the stickman: the forearm's end
      let el = null; f.root.children[0].traverse((o) => { if (!el && o.name === 'stick-hand_r') el = o; });
      return side === 'r' ? el : null;
    };
    const at = (o) => { o.updateWorldMatrix(true, false); return o.getWorldPosition(new T.Vector3()); };
    const dist = (o, pt) => (o && pt ? +(at(o).distanceTo(pt) / s).toFixed(2) : null);
    let lambert = 0;
    h.group.traverse((o) => { if (o.isMesh && o.visible && o.material.isMeshLambertMaterial) lambert++; });
    const out = {
      holding: h.holding, weight: +h.weight.toFixed(2), showing: f.showing, lambert,
      right: real ? dist(bone('hand_r'), r?.right?.pos) : dist(stickLimb('r'), r?.right?.pos),
      left: real && r?.left ? dist(bone('hand_l'), r.left.pos) : null,
      feet: real && r?.feet ? [dist(bone('foot_r'), r.feet[0]), dist(bone('foot_l'), r.feet[1])] : null,
    };
    if (h.model && r?.feet) {
      const box = new T.Box3().setFromObject(h.model);
      const feetY = a.volume.position.y + a.pov.player.pos.y * a.volume.scale.x;
      out.tip = +((box.min.y - feetY) / s).toFixed(2);
    }
    return out;
  });
  const select = async (key) => { await ev((k) => window.__app.pov.toolbelt.select(k), key); await wait(SETTLE_MS); };

  // ---- the holds: hands on the grips
  for (const [key, two] of [['SMG', true], ['SNIPER', true], ['AXE', false], ['BUCKET', false], ['GUN', false], ['PICKAXE', true]]) {
    await select(key);
    const m = await measure();
    check(`${key}: held on the body, lit`, !!m.holding && m.weight > 0.9 && m.lambert === 0, JSON.stringify({ holding: m.holding, weight: m.weight, lambert: m.lambert }));
    check(`${key}: right hand on the grip`, m.right != null && m.right < HAND_TOL, `${m.right} cells`);
    if (two) check(`${key}: left hand on the support`, m.left != null && m.left < HAND_TOL, `${m.left} cells`);
  }

  // ---- the canary: the pogo stick is ridden
  await select('POGO');
  await wait(600);
  const pogo = await measure();
  check('POGO: both hands on the bar', pogo.right < HAND_TOL && pogo.left < HAND_TOL, `${pogo.right} / ${pogo.left} cells`);
  check('POGO: feet on the pegs', pogo.feet && pogo.feet.every((d) => d < FOOT_TOL), JSON.stringify(pogo.feet));
  check('POGO: its foot at the body\'s feet', pogo.tip != null && Math.abs(pogo.tip) < TIP_TOL, `${pogo.tip} cells`);
  const bounces = await ev(async () => {
    const a = window.__app.pov; let n = 0;
    const off = a.player.on('pogo', () => n++);   // the body still bounces on it (player.js)
    await new Promise((r) => setTimeout(r, 1500));
    off?.();
    return n;
  });
  check('POGO: still bounces', bounces > 0, `${bounces} bounces in 1.5 s`);

  // ---- a gun's flash leaves from the gun on the body, not the eye
  await select('SMG');
  const fired = await ev(async (pad) => {
    const a = window.__app, T = a.THREE, h = a.pov.held;
    let muzzle = null;
    const off = a.pov.events.on('gun:fire', (e) => { muzzle ??= e.muzzleWorld?.clone(); });
    const c = document.querySelector('canvas');
    c.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    c.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    off?.();
    if (!muzzle) return null;
    const s = a.pov.figure.real.root.scale.x;
    const box = new T.Box3().setFromObject(h.model).expandByScalar(pad * s);
    return { inGun: box.containsPoint(muzzle), fromCamera: +(muzzle.distanceTo(a.camera.position) / s).toFixed(2) };
  }, MUZZLE_PAD);
  check('SMG: the flash leaves from the held gun', !!fired?.inGun, JSON.stringify(fired));

  // ---- a swing moves the held axe
  await select('AXE');
  const swing = await ev(async () => {
    const a = window.__app, T = a.THREE, h = a.pov.held;
    const q0 = h.model.getWorldQuaternion(new T.Quaternion());
    let most = 0;
    const c = document.querySelector('canvas');
    c.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 25));
      most = Math.max(most, h.model.getWorldQuaternion(new T.Quaternion()).angleTo(q0));
    }
    c.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    return +most.toFixed(2);
  });
  check('AXE: the swing turns the held axe', swing > SWING_TURN, `${swing} rad`);

  // ---- looking up: a gun aims up with the look
  await select('SMG');
  await ev(([yaw]) => window.__app.pov.setLook(yaw, 0.7), [YAW]);
  await wait(500);
  const up = await ev(() => {
    const a = window.__app, T = a.THREE, h = a.pov.held;
    return +new T.Vector3(0, 0, -1).applyQuaternion(h.model.getWorldQuaternion(new T.Quaternion())).y.toFixed(2);
  });
  const upHands = await measure();
  check('SMG looking up: the gun points up', up > 0.4, `forward.y ${up}`);
  check('SMG looking up: hands still on it', upHands.right < HAND_TOL && upHands.left < HAND_TOL, `${upHands.right} / ${upHands.left}`);
  await ev(([yaw]) => window.__app.pov.setLook(yaw, 0), [YAW]);

  // ---- first person: the viewmodel back at the eye, nothing held on the body
  await p.keyboard.press('F5');
  await wait(1200);
  const fp = await ev(() => {
    const vm = window.__app.pov.viewmodel;
    return { holding: window.__app.pov.held.holding, at: vm.position.length(), turn: vm.quaternion.w, scale: vm.scale.x };
  });
  check('first person: the viewmodel is back at the eye', fp.holding === null && fp.at < 1e-6 && Math.abs(fp.turn - 1) < 1e-6 && Math.abs(fp.scale - 1) < 1e-6, JSON.stringify(fp));

  // ---- the stickman holds tools too
  await ev(() => document.querySelector('.drawer button[data-value="stick"]')?.click() ?? (window.__app.settings.character = 'stick'));
  await p.keyboard.press('F5');
  await select('SMG');
  const stick = await measure();
  check('stickman: right hand on the grip', stick.showing === 'stick' && stick.right != null && stick.right < STICK_TOL, JSON.stringify(stick));

  check('no page errors', errs.length === 0, errs.slice(0, 5).join('\n'));
} finally {
  await b.close();
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
