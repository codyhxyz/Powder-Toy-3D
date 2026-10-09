// Headless check of the realistic body (figureReal.js) next to the stickman:
// the model loads, the clips blend with speed (idle, walk, jog, swim, tread),
// death plays, the Body setting switches live, no T-pose, and it is lit like
// the stickman standing in the same spot.
// usage: node tools/pov-character.mjs [--port 5205] [--shots dir]   (needs a dev server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5205');
const shots = opt('shots', null);
const W = 960, H = 600;
const SHOT_W = 480;                       // px per body in the side-by-side
const BODY_ASPECT = 0.5;                  // half-width of the body's screen box, per unit of its height
const LIT_DIFF = 24;                      // 0..255 summed RGB change that marks a pixel as the body's
const BRIGHT_RATIO = [0.6, 1.6];          // realistic / stickman mean brightness on the body must fall here
const T_POSE_DROP = 1;                    // cells: hands hang at least this far below the shoulders
const LAVA_OFFSET = 24;                   // cells from the drop point to the lava that kills the body
const POOL_REFILL_MS = 250;               // ms between top-ups of the pool
const STANDING_HEAD_MIN = 4;              // cells: the head bone above the feet when standing...
const BODY_TOP = 6;                       // ...and below this
const DEAD_HEAD_MAX = 2.5;                // cells: lying down, the head is this low at most
const POOL_R = 9;                         // cells, radius of the water ball
const LAVA_R = 4;                         // cells, radius of the lava ball

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 600)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 1000)));
await p.goto(`http://localhost:${port}/?preset=lab`);
await p.waitForFunction(() => window.__app?.pov, null, { timeout: 20000 });
await p.waitForTimeout(2500);

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const settle = (ms) => p.waitForTimeout(ms);
const weights = () => ev(() => {
  const w = window.__app.pov.figure.real?.weights ?? {};
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, +v.toFixed(2)]));
});
const top = (w) => Object.entries(w).sort((a, b) => b[1] - a[1])[0]?.[0];
const setFigure = (v) => ev((v) => document.querySelector(`.drawer button[data-value="${v}"]`).click(), v);

check('defaults to realistic', (await ev(() => window.__app.settings.body)) === 'real');
await ev(() => { window.__app.settings.body = 'real'; });

// ---- drop in, third person
await p.mouse.move(W * 0.5, H * 0.62);
await settle(300);
await p.keyboard.press('f');
await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 10000 }).catch(() => {});
await ev(() => { window.__app.pov.test.assumeLocked = true; });
await p.waitForFunction(() => window.__app.pov.figure.loaded, null, { timeout: 15000 }).catch(() => {});
await p.keyboard.press('v');
await settle(1000);
const st = await ev(() => ({ mode: window.__app.pov.mode, loaded: window.__app.pov.figure.loaded, showing: window.__app.pov.figure.showing, vis: window.__app.pov.figure.root.visible }));
check('model loaded and showing', st.mode === 'on' && st.loaded && st.showing === 'real' && st.vis, JSON.stringify(st));

// ---- no T-pose: hands hang below the shoulders (grid cells)
const pose = () => ev(() => {
  const a = window.__app, m = a.pov.figure.real.model, s = a.scale, v = a.volume.position;
  const y = (n) => (m.getObjectByName(n).getWorldPosition(new a.camera.position.constructor()).y - v.y) / s;
  const feet = a.pov.player.pos.y;
  return { hand: y('hand_l') - y('upperarm_l'), handR: y('hand_r') - y('upperarm_r'), head: y('Head') - feet, pelvis: y('pelvis') - feet };
});
const idle = await pose();
check('idle: not a T-pose', idle.hand < -T_POSE_DROP && idle.handR < -T_POSE_DROP, JSON.stringify(idle, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
check('idle: head at body height', idle.head > STANDING_HEAD_MIN && idle.head < BODY_TOP, idle.head.toFixed(2));
const wIdle = await weights();
check('idle clip', top(wIdle) === 'idle', JSON.stringify(wIdle));

// ---- walk, then run
await p.keyboard.down('w');
await settle(900);
const wWalk = await weights();
const walkPose = await pose();
check('walk clip', top(wWalk) === 'walk', JSON.stringify(wWalk));
check('walking: not a T-pose', walkPose.hand < -T_POSE_DROP, walkPose.hand.toFixed(2));
await p.keyboard.down('Shift');
await settle(900);
const wRun = await weights();
check('run blends into jog', wRun.jog > wWalk.jog && wRun.jog > 0.5, JSON.stringify(wRun));
await p.keyboard.up('Shift');
await p.keyboard.up('w');
await settle(900);
check('back to idle', top(await weights()) === 'idle');

// ---- lighting: the body's mean brightness, realistic vs stickman, same spot
// (pixels that change when the body is hidden are the body's)
async function bodyBrightness() {
  const grab = async () => (await p.screenshot({ type: 'png' })).toString('base64');
  await settle(600);
  const on = await grab();
  await ev(() => { const f = window.__app.pov.figure; f._setVisible = f.setVisible; f.setVisible = () => {}; f.root.visible = false; window.__app.requestRender(); });
  await settle(600);
  const off = await grab();
  await ev(() => { const f = window.__app.pov.figure; f.setVisible = f._setVisible; window.__app.requestRender(); });
  // the body's screen rectangle: its feet and the top of its head, projected
  const rect = await ev(([W, H, aspect]) => {
    const a = window.__app, pl = a.pov.player, V = a.camera.position.constructor;
    const toScreen = (y) => { const v = pl.pos.clone().setY(y).multiplyScalar(a.scale).add(a.volume.position).project(a.camera); return new V((v.x + 1) / 2 * W, (1 - v.y) / 2 * H, 0); };
    const f = toScreen(pl.pos.y), h = toScreen(pl.pos.y + 5.5);
    const hh = Math.abs(f.y - h.y);
    return { x0: (f.x + h.x) / 2 - hh * aspect, x1: (f.x + h.x) / 2 + hh * aspect, y0: Math.min(f.y, h.y) - hh * 0.1, y1: Math.max(f.y, h.y) + hh * 0.1 };
  }, [W, H, BODY_ASPECT]);
  return ev(async ([on, off, diff, rect]) => {
    const load = (b64) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = `data:image/png;base64,${b64}`; });
    const [a, b] = await Promise.all([load(on), load(off)]);
    const px = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
    const A = px(a), B = px(b);
    let n = 0, sum = 0;
    for (let i = 0; i < A.length; i += 4) {
      const x = (i / 4) % a.width, y = Math.floor(i / 4 / a.width);
      if (x < rect.x0 || x > rect.x1 || y < rect.y0 || y > rect.y1) continue;
      const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
      if (d > diff) { n++; sum += (A[i] + A[i + 1] + A[i + 2]) / 3; }
    }
    return { pixels: n, mean: n ? sum / n : 0 };
  }, [on, off, LIT_DIFF, rect]);
}
const litReal = await bodyBrightness();
await setFigure('stick');
await settle(300);
check('setting switches live to the stickman', (await ev(() => window.__app.pov.figure.showing)) === 'stick' && (await ev(() => window.__app.settings.body)) === 'stick');
const litStick = await bodyBrightness();
const ratio = litReal.mean / Math.max(litStick.mean, 1);
check('realistic body is lit (not black)', litReal.pixels > 200 && litReal.mean > 30, JSON.stringify(litReal));
check('lit about like the stickman', ratio > BRIGHT_RATIO[0] && ratio < BRIGHT_RATIO[1], `real ${litReal.mean.toFixed(0)} vs stick ${litStick.mean.toFixed(0)} (×${ratio.toFixed(2)}), pixels ${litReal.pixels} / ${litStick.pixels}`);
await setFigure('real');
await settle(300);
check('and back to realistic', (await ev(() => window.__app.pov.figure.showing)) === 'real');

// ---- side by side: third person walking, seen from the side
if (shots) {
  const side = async () => {
    await ev(() => { const f = window.__app.pov.figure; f._update ??= f.update; f.update = (dt, s) => f._update(dt, { ...s, yaw: s.yaw + Math.PI / 2 }); });
    await p.keyboard.down('w');
    await settle(700);
    const img = (await p.screenshot({ type: 'png', clip: { x: (W - SHOT_W) / 2, y: 0, width: SHOT_W, height: H } })).toString('base64');
    await p.keyboard.up('w');
    await settle(500);
    return img;
  };
  await setFigure('stick');
  const s1 = await side();
  await setFigure('real');
  const s2 = await side();
  await ev(() => { const f = window.__app.pov.figure; f.update = f._update; });
  const jpg = await ev(async ([a, b, w, h]) => {
    const load = (b64) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = `data:image/png;base64,${b64}`; });
    const [A, B] = await Promise.all([load(a), load(b)]);
    const scale = 0.5, c = document.createElement('canvas');
    c.width = 2 * w * scale; c.height = h * scale;
    const x = c.getContext('2d');
    x.drawImage(A, 0, 0, w * scale, h * scale);
    x.drawImage(B, w * scale, 0, w * scale, h * scale);
    x.fillStyle = '#fff'; x.font = '14px sans-serif';
    x.fillText('Stickman', 8, 18); x.fillText('Realistic', w * scale + 8, 18);
    return c.toDataURL('image/jpeg', 0.8).split(',')[1];
  }, [s1, s2, SHOT_W, H]);
  const fs = await import('node:fs');
  fs.writeFileSync(`${shots}/character-side-by-side.jpg`, Buffer.from(jpg, 'base64'));
  console.log(`wrote ${shots}/character-side-by-side.jpg`);
}

// ---- death
// lava, away from the drop point (the respawn spot stays clear)
await ev(async ([off, r]) => {
  const { E } = await import('/src/elements.js');
  const a = window.__app, pl = a.pov.player, g = a.sim.g;
  const spot = a.pov.dropPoint.clone();
  spot.z = spot.z + off < g.nz - r ? spot.z + off : spot.z - off;
  pl.spawn(spot);
  const c = spot.clone().setY(spot.y + 2);
  for (let i = 0; i < 4; i++) a.sim.paint({ center: c, radius: r, shape: 0, tool: E.LAVA, rate: 1, replace: true });
}, [LAVA_OFFSET, LAVA_R]);
await p.waitForFunction(() => window.__app.pov.player.dead, null, { timeout: 30000 }).catch(() => {});
const cause = await ev(() => window.__app.pov.player.cause);
await settle(1800);
const dead = await ev(() => window.__app.pov.player.dead);
const wDead = await weights();
const deadPose = await pose();
check('death plays', dead && wDead.death > 0.9, `${cause}: ${JSON.stringify(wDead)}`);
check('dead body lies down', deadPose.head < DEAD_HEAD_MAX, JSON.stringify(deadPose, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
await p.waitForFunction(() => !window.__app.pov.player.dead, null, { timeout: 30000 }).catch(() => {});
await settle(1500);
check('respawned upright', (await pose()).head > STANDING_HEAD_MIN);

// ---- swim and tread: a pool around the body
await ev(async (r) => {
  const { E } = await import('/src/elements.js');
  const a = window.__app, pl = a.pov.player;
  const c = pl.pos.clone().setY(pl.pos.y + 4);
  for (let i = 0; i < 6; i++) a.sim.paint({ center: c, radius: r, shape: 0, tool: E.WATER, rate: 1, replace: false });
}, POOL_R);
// keep it topped up (the lab drains it), so the head stays under
await ev(([r, ms]) => { window.__poolTimer = setInterval(async () => {
  const { E } = await import('/src/elements.js');
  const a = window.__app, c = a.pov.player.pos.clone(); c.y += 4;
  a.sim.paint({ center: c, radius: r, shape: 0, tool: E.WATER, rate: 1, replace: false });
}, ms); }, [POOL_R, POOL_REFILL_MS]);
await settle(3000);
const inWater = await ev(() => ({ inLiquid: window.__app.pov.player.inLiquid, head: window.__app.pov.player.headInLiquid, ground: window.__app.pov.player.onGround }));
const wTread = await weights();
check('in water: treading', inWater.inLiquid && wTread.tread > 0.5, `${JSON.stringify(inWater)} ${JSON.stringify(wTread)}`);
await p.keyboard.down('w');
await settle(1200);
const wSwim = await weights();
await p.keyboard.up('w');
await ev(() => clearInterval(window.__poolTimer));
check('swimming forward: swim clip', wSwim.swim > wTread.swim && wSwim.swim > 0.3, JSON.stringify(wSwim));

check('no console errors', errs.length === 0, errs.slice(0, 5).join('\n'));
await b.close();
console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
