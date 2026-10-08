// Headless check of the POV shell: drop-in swoop, key suppression, the
// crosshair pick, third person, HUD states, death and respawn, the swoop out.
// usage: node tools/pov-shell.mjs [--port 5193] [--shots dir]   (needs a dev server; the body module)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5193');
const shots = opt('shots', null);
const W = 960, H = 600;

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
const frames = (n) => ev((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const shot = async (name) => { if (shots) await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 70, scale: 'css' }); };

// hover a spot on the lab floor, then drop in there
await p.mouse.move(W * 0.62, H * 0.62);
await frames(10);
const before = await ev(() => {
  const a = window.__app;
  return { pos: a.camera.position.toArray(), fov: a.camera.fov, target: a.controls.target.toArray(), hover: a.hover.valid, cell: a.hover.cell.toArray(), paused: a.settings.paused, view: a.settings.view };
});
check('hover before entry', before.hover, JSON.stringify(before.cell));
await p.keyboard.press('f');
const samples = [];
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(130);
  samples.push(await ev(() => { const a = window.__app; return { mode: a.pov.mode, pos: a.camera.position.toArray().map((v) => +v.toFixed(3)), fov: +a.camera.fov.toFixed(1), fig: a.pov.figure?.root.visible }; }));
}
console.log('swoop in:', samples.map((s) => `${s.mode} fov ${s.fov} fig ${s.fig} [${s.pos}]`).join('\n          '));
await p.waitForTimeout(300);
const inPov = await ev(() => {
  const a = window.__app, pl = a.pov.player, s = a.scale, v = a.volume.position;
  const eye = pl.pos.clone().setY(pl.pos.y + 5).multiplyScalar(s).add(v);
  return { mode: a.pov.mode, fov: a.camera.fov, eyeErr: a.camera.position.distanceTo(eye) / s, feet: pl.pos.toArray(), drop: a.pov.dropPoint.toArray(), controls: a.controls.enabled, near: a.camera.near / s, body: document.body.className };
});
check('entered POV', inPov.mode === 'on', JSON.stringify(inPov));
check('POV fov ~75', Math.abs(inPov.fov - 75) < 1.5, inPov.fov.toFixed(1));
check('camera at the eye', inPov.eyeErr < 0.6, inPov.eyeErr.toFixed(3) + ' cells');
check('dropped at the hovered cell', Math.abs(inPov.drop[0] - before.cell[0] - 0.5) < 1.01 && Math.abs(inPov.drop[2] - before.cell[2] - 0.5) < 1.01);
check('orbit controls off', inPov.controls === false);
check('figure hidden in first person', samples.at(-1).fig === false || (await ev(() => !window.__app.pov.figure.root.visible)));

// god-mode keys suppressed
const tBefore = await ev(() => window.__app.controls.target.toArray());
await p.keyboard.press('Space');
await p.keyboard.press('2');
await p.keyboard.press('r');
await p.keyboard.down('w');
await p.waitForTimeout(600);
await p.keyboard.up('w');
const sup = await ev(() => { const a = window.__app; return { paused: a.settings.paused, view: a.settings.view, target: a.controls.target.toArray(), feet: a.pov.player.pos.toArray() }; });
check('Space does not pause', sup.paused === before.paused);
check('digits do not switch view', sup.view === before.view);
check('rig/orbit target untouched', sup.target.every((v, i) => Math.abs(v - tBefore[i]) < 1e-6));
const walked = Math.hypot(sup.feet[0] - inPov.feet[0], sup.feet[2] - inPov.feet[2]);
check('W walks the body', walked > 1, walked.toFixed(2) + ' cells');

// aim: look down at the ground in front, the crosshair cell should be on the ray
await ev(() => window.__app.pov.setLook(window.__app.pov.camera.look.yaw, -0.6));
await frames(12);
const aim = await ev(() => {
  const a = window.__app, c = a.pov.ctx, h = a.hover;
  const eye = a.pov.player.pos.clone().setY(a.pov.player.pos.y + 5);
  const d = a.pov.camera.dir(new a.camera.position.constructor());
  const centre = h.cell.clone().addScalar(0.5);
  const toCell = centre.clone().sub(eye);
  const along = toCell.dot(d), off = toCell.clone().addScaledVector(d, -along).length();
  return { valid: h.valid, cell: h.cell.toArray(), id: h.id, dist: c.aim.dist, along, off };
});
check('crosshair pick valid', aim.valid, JSON.stringify(aim));
check('pick lies on the aim ray', aim.along > 0 && aim.off < 1.8, `off ${aim.off.toFixed(2)} along ${aim.along.toFixed(2)}`);
check('aim.dist plausible', Math.abs(aim.dist - aim.along) < 2, aim.dist.toFixed(2));
await ev(() => window.__app.pov.setLook(window.__app.pov.camera.look.yaw, -0.05));
await frames(8);
await shot('pov-standing');

// third person
await p.keyboard.press('v');
await p.waitForTimeout(900);
const tp = await ev(() => {
  const a = window.__app, pl = a.pov.player, s = a.scale;
  const eye = pl.pos.clone().setY(pl.pos.y + 5).multiplyScalar(s).add(a.volume.position);
  return { d: a.camera.position.distanceTo(eye) / s, fig: a.pov.figure.root.visible, vm: a.pov.viewmodel.visible };
});
check('third person pulls back', tp.d > 6, tp.d.toFixed(2) + ' cells');
check('figure visible in third person', tp.fig);
check('viewmodel hidden in third person', !tp.vm);
await shot('pov-third');
await p.keyboard.press('v');
await p.waitForTimeout(800);

// HUD: lock prompt (headless can't lock), heat, underwater, hurt
const hud1 = await ev(() => ({ lock: document.querySelector('.pov-lock').classList.contains('show'), cross: document.querySelector('.pov-cross').classList.contains('show'), vitals: document.querySelector('.pov-vitals').classList.contains('show'), breath: document.querySelector('.pov-breath').classList.contains('show') }));
check('lock prompt while unlocked', hud1.lock);
check('crosshair + vitals shown', hud1.cross && hud1.vitals);
check('breath bar hidden at full breath', !hud1.breath);
await ev(async () => {
  const { E } = await import('/src/elements.js');
  const pl = window.__app.pov.player;
  pl.breath = 0.4; pl.headInLiquid = true; pl.liquidId = E.WATER; pl.feel.cold = 0.2;
});
await frames(6);
const hud2 = await ev(() => ({ breath: document.querySelector('.pov-breath').classList.contains('show'), water: getComputedStyle(document.querySelector('.pov-water')).opacity, liq: document.querySelector('.pov-water').style.getPropertyValue('--liq') }));
check('breath bar shows below full', hud2.breath);
check('underwater tint on', hud2.water === '1', JSON.stringify(hud2));
await shot('pov-underwater');
await ev(() => { const pl = window.__app.pov.player; pl.breath = 1; pl.headInLiquid = false; pl.liquidId = -1; pl.feel.cold = 0; pl.feel.heat = 0.8; pl._hurt(0.3); });
await frames(4);
const hud3 = await ev(() => ({ heat: document.querySelector('.pov-heat').style.opacity, hurt: document.querySelector('.pov-hurt').style.opacity }));
check('heat glow + hurt flash', +hud3.heat > 0.5 && +hud3.hurt > 0.3, JSON.stringify(hud3));
await ev(() => { window.__app.pov.player.feel.heat = 0; });

// death and respawn
await ev(() => window.__app.pov.player._kill('Killed by lava, 1,140 °C'));
await p.waitForTimeout(1500);
const dead = await ev(() => {
  const a = window.__app, pl = a.pov.player, s = a.scale;
  const feet = pl.pos.clone().multiplyScalar(s).add(a.volume.position);
  return { overlay: document.querySelector('.pov-death').classList.contains('show'), cause: document.querySelector('.pov-cause').textContent, count: document.querySelector('.pov-respawn b').textContent, camUp: (a.camera.position.y - feet.y) / s, fig: a.pov.figure.root.visible };
});
check('death overlay', dead.overlay && dead.cause.includes('lava'), JSON.stringify(dead));
check('death camera above the body', dead.camUp > 6 && dead.fig);
await shot('pov-death');
await p.waitForTimeout(3300);
const resp = await ev(() => ({ dead: window.__app.pov.player.dead, mode: window.__app.pov.mode, overlay: document.querySelector('.pov-death').classList.contains('show') }));
check('respawned', !resp.dead && !resp.overlay, JSON.stringify(resp));
await p.waitForTimeout(900);

// pop out
await p.keyboard.press('f');
const outS = [];
for (let i = 0; i < 6; i++) {
  await p.waitForTimeout(150);
  outS.push(await ev(() => { const a = window.__app; return { mode: a.pov.mode, fov: +a.camera.fov.toFixed(1), pos: a.camera.position.toArray().map((v) => +v.toFixed(3)) }; }));
}
console.log('swoop out:', outS.map((s) => `${s.mode} fov ${s.fov} [${s.pos}]`).join('\n           '));
await p.waitForTimeout(300);
const after = await ev(() => { const a = window.__app; return { mode: a.pov.mode, pos: a.camera.position.toArray(), fov: a.camera.fov, target: a.controls.target.toArray(), controls: a.controls.enabled, body: document.body.className }; });
const posErr = Math.hypot(...after.pos.map((v, i) => v - before.pos[i]));
check('back in god view', after.mode === 'off' && after.controls && !after.body.includes('pov-on'), JSON.stringify(after));
check('exact orbit pose restored', posErr < 1e-4 && Math.abs(after.fov - before.fov) < 1e-6, posErr.toExponential(2));
await p.keyboard.press('Space');
await frames(3);
const restored = await ev(() => window.__app.settings.paused);
check('Space pauses again in god view', restored !== before.paused);
await p.keyboard.press('Space');

console.log(errs.length ? 'console errors:\n' + errs.join('\n') : 'no console errors');
console.log(fails ? `${fails} check(s) failed` : 'all POV shell checks passed');
await b.close();
process.exit(fails ? 1 : 0);
