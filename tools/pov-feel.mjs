// Gunplay feel check: camera kick and trauma shake, the blast shake (the
// player's knock) and the jetpack's spool, effects (gfx/billboards.js pools),
// hitmarker and crosshair bloom, footsteps. Drives povEvents by hand, so it
// needs no gun. On WebGPU (docs/webgpu.md G2, I1) through the app-level POV
// harness (tools/pov-app.mjs): the empty box at 128³ (the coordinates below
// are the box's) in the plain view, manual mode, and the body's frames run by
// the check at a fixed 1/30 s, so its game time doesn't depend on how slow
// SwiftShader's frames are. Runs its own Vite.
// usage: node tools/pov-feel.mjs [--shots dir]
import { openPovApp, POV_DT } from './pov-app.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const shots = opt('shots', null);
const W = 800, H = 500;

const app = await openPovApp({ query: '?size=128&preset=empty&view=plain', viewport: { width: W, height: H } });
const p = app.page, check = app.check;
try {
  console.log(`  booted in ${app.boot.toFixed(0)} s`);
  const ev = (fn, arg) => p.evaluate(fn, arg);
  // game time: body frames of POV_DT (the harness's __pov.frames)
  const frames = (ms) => Math.max(1, Math.ceil(ms / 1000 / POV_DT - 1e-9));
  const settle = (ms) => ev((n) => window.__pov.frames(n), frames(ms));
  const nextFrame = () => ev(() => window.__pov.frames(1));
  const emit = (name, payload) => ev(async ([name, payload]) => {
    const THREE = window.__app.camera.position.constructor;
    const v = (a) => (Array.isArray(a) ? new THREE(...a) : a);
    const out = {};
    for (const [k, val] of Object.entries(payload)) out[k] = Array.isArray(val) ? v(val) : val;
    (await import('/src/pov/events.js')).povEvents.emit(name, out);
  }, [name, payload]);
  const counts = () => ev(() => window.__app.pov.vfx.counts());
  const paint = (tool, c, r, shape = 1) => ev(async ([tool, c, r, shape]) => {
    const { E } = await import('/src/elements.js');
    const a = window.__app;
    a.sim.paint({ center: new a.camera.position.constructor(...c), radius: r, shape, tool: E[tool], rate: 1, replace: false });
  }, [tool, c, r, shape]);
  const ids = await ev(async () => { const { E } = await import('/src/elements.js'); return { METAL: E.METAL, SAND: E.SAND, WATER: E.WATER, GLASS: E.GLASS, SCRAP: E.SCRAP }; });

  // ---- drop in, stand facing +x
  const entered = await app.enter([30, 1, 64]);
  check('dropped in', entered.mode === 'on' && entered.onGround, JSON.stringify(entered));
  check('vfx built on entry', await ev(() => !!window.__app.pov.vfx && window.__app.scene.getObjectByName('pov-vfx') != null));
  await ev(() => {
    const a = window.__app;
    a.pov.player.spawn(a.pov.player.pos.clone().set(30, 0, 64));
    a.pov.setLook(-Math.PI / 2, 0);
  });
  await settle(700);

  // a pistol shot as the gun throws it: 'gun:fire' (trauma, bloom, the muzzle flash) and its
  // rig.hit(HIT.GUN)'s view punch ('punch', viewmodel.js: the kick is a punch since the view punch landed)
  await ev(() => {
    window.__feelFire = async () => {
      const { povEvents } = await import('/src/pov/events.js');
      const { HIT } = await import('/src/pov/viewmodel.js');
      povEvents.emit('gun:fire', {
        origin: window.__app.pov.ctx.eye.clone(), dir: window.__app.pov.ctx.dir.clone(),
        muzzleWorld: window.__app.camera.localToWorld(window.__app.camera.position.clone().set(0.04, -0.03, -0.12)),
      });
      povEvents.emit('punch', { pitch: HIT.GUN.punch.pitch[0], yaw: 0 });
    };
  });
  const fire = () => window.__feelFire();

  // ---- kick and shake: sample the camera against the look for 1.2 s after a shot
  const sampleAfter = (fn) => ev(async (fnSrc) => {
    const a = window.__app;
    const E = new a.camera.rotation.constructor(0, 0, 0, 'YXZ');
    const samples = [];
    await (0, eval)(`(${fnSrc})`)();
    const t0 = a.pov.feel.time;   // from the shot
    const wrap = (x) => x - 2 * Math.PI * Math.round(x / (2 * Math.PI));
    await window.__pov.frames(60, () => {
      const t = a.pov.feel.time - t0;
      E.setFromQuaternion(a.camera.quaternion, 'YXZ');
      const look = a.pov.camera.look;
      samples.push({ t, dp: E.x - look.pitch, dy: wrap(E.y - look.yaw), roll: E.z, trauma: a.pov.feel.trauma, kick: a.pov.feel.kick });
      return t >= 1.2;
    });
    return samples;
  }, fn.toString());
  const s1 = await sampleAfter(fire);
  if (process.env.FEEL_DEBUG) console.log(s1.map((x) => `${x.t.toFixed(2)}:${x.kick.toFixed(4)}`).join(' '));
  const at = (t) => s1.find((s) => s.t >= t) ?? s1[s1.length - 1];
  const peakP = Math.max(...s1.map((s) => s.dp));
  // the first sample is a frame after the shot (1/30 s: 0.035·e^−0.9 at the old 0.1 s headless frames)
  check('kick tips the view up', peakP > 0.012, `peak Δpitch ${peakP.toFixed(4)} rad`);
  check('kick recovers', Math.abs(at(0.6).dp) < 0.004 && at(0.6).kick < 0.002, `Δpitch at 0.6 s ${at(0.6).dp.toFixed(4)}, kick ${at(0.6).kick.toFixed(4)}`);
  check('shake moves yaw and roll', Math.max(...s1.map((s) => Math.abs(s.dy))) > 1e-5 && Math.max(...s1.map((s) => Math.abs(s.roll))) > 1e-5,
    `max |Δyaw| ${Math.max(...s1.map((s) => Math.abs(s.dy))).toFixed(5)}, max |roll| ${Math.max(...s1.map((s) => Math.abs(s.roll))).toFixed(5)}`);
  check('trauma decays to rest', at(1.15).trauma === 0 && Math.abs(at(1.15).dy) < 1e-6, `trauma at 0 s ${s1[0].trauma.toFixed(2)}, at 1.15 s ${at(1.15).trauma.toFixed(3)}`);

  // a burst builds trauma (squared), so 3 quick shots shake more than one
  await settle(300);
  const [peakT1, peakT3] = await ev(async () => {
    const f = window.__app.pov.feel, out = [];
    for (const n of [1, 3]) {
      f.reset();
      for (let i = 0; i < n; i++) await window.__feelFire();
      out.push(f.trauma);
    }
    return out;
  });
  check('bursts build up', peakT3 > peakT1 * 1.5, `trauma after 1 shot ${peakT1.toFixed(2)} (shake ∝ ${(peakT1 ** 2).toFixed(2)}), 3 shots ${peakT3.toFixed(2)} (${(peakT3 ** 2).toFixed(2)})`);
  check('aim ignores the shake', await ev(() => {
    const a = window.__app, ro = a.camera.position.clone(), rd = ro.clone();
    a.pov.aimRay(ro, rd);
    return rd.distanceTo(a.pov.ctx.dir) < 1e-6;
  }));

  // blast: a big sudden push from outside (the player's knock: pressure and impulses)
  await settle(1300);
  const blast = await ev(async () => {
    const a = window.__app, out = [];
    a.pov.player.applyImpulse({ x: 45, y: 0, z: 0 });
    await window.__pov.frames(4, () => {
      out.push({ t: a.pov.feel.time, vx: a.pov.player.vel.x, ground: a.pov.player.onGround, trauma: a.pov.feel.trauma, knock: a.pov.player.knock });
      return false;
    });
    return out;
  });
  const blastT = Math.max(...blast.map((x) => x.trauma));
  check('blast (a knock) adds trauma', blastT > 0.2, `peak trauma ${blastT.toFixed(2)}; ${blast.map((x) => `vx ${x.vx.toFixed(1)} knock ${x.knock.toFixed(1)} ${x.ground ? 'g' : 'a'} ${x.trauma.toFixed(2)}`).join(', ')}`);
  await settle(2500);

  // the jetpack catching a fall: it spools in and out, never shakes the view, and still climbs
  await ev(() => {
    const a = window.__app;
    a.pov.player.spawn(a.pov.player.pos.clone().set(30, Math.round(a.sim.g.ny * 0.5), 64));
    a.pov.feel.reset();
  });
  await settle(350);   // falling
  const trace = (ms) => ev(async (n) => {
    const a = window.__app, pl = a.pov.player, out = [];
    await window.__pov.frames(n, () => {
      out.push({ t: a.pov.feel.time, vy: pl.vel.y, trauma: a.pov.feel.trauma, jet: pl.jetting, ground: pl.onGround });
      return false;
    });
    return out;
  }, frames(ms));
  await p.keyboard.down('Space');
  const jetOn = await trace(1000);
  await p.keyboard.up('Space');
  const jt = [...jetOn, ...await trace(500)];
  let maxA = 0;
  for (let i = 1; i < jt.length; i++) { const dt = jt[i].t - jt[i - 1].t; if (dt > 0 && !jt[i].ground) maxA = Math.max(maxA, Math.abs(jt[i].vy - jt[i - 1].vy) / dt); }
  const jetTrauma = Math.max(...jt.map((x) => x.trauma)), jetTop = Math.max(...jt.map((x) => x.vy));
  check('jetpack fired', jt.some((x) => x.jet), `${jt.filter((x) => x.jet).length} of ${jt.length} frames`);
  check('jetpack does not shake the view', jetTrauma === 0, `peak trauma ${jetTrauma.toFixed(3)}`);
  check('jetpack ramps (no jolt)', maxA < 400, `peak |Δv/Δt| ${maxA.toFixed(0)} cells/s² (was ~900–1900 catching a fall)`);
  check('jetpack still climbs', jetTop > 40, `top climb ${jetTop.toFixed(1)} cells/s, from ${jt[0]?.vy.toFixed(1)}`);
  if (process.env.FEEL_DEBUG) console.log(jt.map((x) => `${x.t.toFixed(2)}:${x.vy.toFixed(0)}${x.jet ? 'J' : ''}`).join(' '));
  await settle(2500);

  // impact distance: close impacts shake, far ones barely
  const tNear = await ev(async () => {
    const a = window.__app; a.pov.feel.reset();
    const pt = a.pov.ctx.eye.clone().add(a.pov.ctx.dir.clone().multiplyScalar(4));
    (await import('/src/pov/events.js')).povEvents.emit('impact', { source: 'axe', point: pt, normal: pt.clone().set(-1, 0, 0), id: 1, energy: 40, broke: false });
    return a.pov.feel.trauma;
  });
  const tFar = await ev(async () => {
    const a = window.__app; a.pov.feel.reset();
    const pt = a.pov.ctx.eye.clone().add(a.pov.ctx.dir.clone().multiplyScalar(30));
    (await import('/src/pov/events.js')).povEvents.emit('impact', { source: 'axe', point: pt, normal: pt.clone().set(-1, 0, 0), id: 1, energy: 40, broke: false });
    return a.pov.feel.trauma;
  });
  check('impact shake falls off with distance', tNear > 0.15 && tFar === 0, `near ${tNear.toFixed(3)}, far ${tFar.toFixed(3)}`);

  // ---- VFX: spawn and die
  // (counted in the same task as the shot, before any frame ages it)
  const c0 = await ev(async () => {
    const v = window.__app.pov.vfx;
    v.clear();
    await window.__feelFire();
    v.update(0);
    return { ...v.counts(), light: v.light.intensity };
  });
  check('muzzle flash spawns', c0.flash >= 2 && c0.spark > 0 && c0.debris > 0, JSON.stringify(c0));
  check('muzzle light on', c0.light > 0);
  await settle(150);
  const c1 = await counts();
  check('flash dies fast', c1.flash === 0, JSON.stringify(c1));
  // (body: a shot into an entity, which alone shows the hitmarker since main's 8041f16; blocks don't)
  const hit = (id, broke, source = 'gun', point = [39.5, 5, 64], body = false) => emit('impact', { source, point, normal: [-1, 0, 0], id, energy: 39, broke, ...(body ? { body: true } : {}) });
  await hit(ids.METAL, false);
  check('sparks on metal', (await counts()).spark > 0);
  await hit(ids.SAND, null);
  check('dust on sand (powder)', (await counts()).debris > 0);
  await hit(ids.GLASS, true);
  check('chips on a broken solid', (await counts()).chip > 0);
  await hit(ids.WATER, null);
  check('mist on water', (await counts()).mist > 0);
  // (kind 'round': a bullet streaks, a rocket smokes; vfx.js)
  for (let i = 0; i < 4; i++) await emit('round:move', { id: 1, kind: 'round', from: [32 + i * 6, 5, 64], to: [38 + i * 6, 5, 64] });
  const ct = await counts();
  check('tracers from round:move', ct.tracer > 0, JSON.stringify(ct));
  await ev(async () => {   // all of it inside TRACER_NEAR
    const c = window.__app.pov.ctx;
    (await import('/src/pov/events.js')).povEvents.emit('round:move', { id: 2, kind: 'round', from: c.eye.clone().addScaledVector(c.dir, 0.2), to: c.eye.clone().addScaledVector(c.dir, 1.2) });
  });
  check('tracer skips what is at the eye', (await counts()).tracer === ct.tracer);
  for (let i = 0; i < 40; i++) await hit(ids.METAL, false);
  check('pools are capped', (await counts()).spark <= 120, JSON.stringify(await counts()));
  await settle(1200);
  const cEnd = await counts();
  check('everything dies', Object.values(cEnd).every((n) => n === 0) && !(await ev(() => window.__app.pov.vfx.busy)), JSON.stringify(cEnd));

  // ---- HUD: hitmarker and bloom
  const hud = () => ev(() => {
    const hm = document.querySelector('.pov-hitmark'), cr = document.querySelector('.pov-cross');
    return { hit: +getComputedStyle(hm).opacity, broke: hm.classList.contains('broke'), gap: cr.style.getPropertyValue('--gap') };
  });
  const h0 = await hud();
  check('crosshair at rest', h0.gap === '4px' && h0.hit === 0, JSON.stringify(h0));
  // (the HUD pushed in the same task as the shot, before a frame decays it)
  await ev(async () => { const a = window.__app; await window.__feelFire(); a.pov.feel.update({ dt: 0, live: true, eye: a.pov.ctx.eye }); });
  const h1 = await hud();
  check('crosshair blooms on fire', parseFloat(h1.gap) > 6, JSON.stringify(h1));
  await settle(400);
  check('bloom decays', (await hud()).gap === '4px');
  await hit(ids.METAL, false, 'gun', undefined, true);
  await nextFrame();
  const h2 = await hud();
  check('hitmarker on a gun impact', h2.hit > 0.5 && !h2.broke, JSON.stringify(h2));
  await settle(300);
  check('hitmarker fades', (await hud()).hit === 0);
  await hit(ids.GLASS, true, 'gun', undefined, true);
  await nextFrame();
  check('hitmarker brighter when broke', (await hud()).broke);
  await settle(300);
  await hit(ids.METAL, false, 'axe', undefined, true);
  await nextFrame();
  check('no hitmarker for the axe', (await hud()).hit === 0);

  // ---- footsteps while walking
  await ev(() => {
    const a = window.__app;
    a.pov.player.spawn(a.pov.player.pos.clone().set(20, 0, 40));
    a.pov.setLook(-Math.PI / 2, 0);
    window.__steps = [];
    import('/src/pov/events.js').then(({ povEvents }) => povEvents.on('player:step', (e) => window.__steps.push({ t: window.__app.pov.feel.time * 1000, ...e })));
  });
  await settle(600);
  const stepsIdle = await ev(() => window.__steps.length);
  await p.keyboard.down('w'); await settle(3000); await p.keyboard.up('w');
  const held = await ev(() => window.__steps.length);   // (the cadence is the walk's: the step slowing down after the key is longer)
  await settle(300);
  const st = await ev(() => window.__steps);
  const gaps = st.slice(1, held).map((s, i) => (s.t - st[i].t) / 1000);
  const mean = gaps.reduce((a, x) => a + x, 0) / Math.max(1, gaps.length);
  check('no steps standing still', stepsIdle === 0);
  check('steps while walking', st.length >= 2, `${st.length} steps in 3 s, mean gap ${mean.toFixed(2)} s, speed ${st[1]?.speed?.toFixed(1)} cells/s`);
  check('step cadence is even', gaps.length < 3 || Math.max(...gaps.slice(1)) - Math.min(...gaps.slice(1)) < 0.12, gaps.map((g) => g.toFixed(2)).join(' '));
  await p.keyboard.down('Shift'); await p.keyboard.down('w'); await settle(2000); await p.keyboard.up('w'); await p.keyboard.up('Shift');
  const st2 = await ev(() => window.__steps);
  const sprintSteps = st2.slice(st.length);
  check('sprinting steps faster', sprintSteps.length > st.length * 2 / 3 * 1.2, `${sprintSteps.length} steps in 2 s`);

  // ---- screenshots: a muzzle flash frame and a spark frame (one run)
  const shot = async (name) => {
    await ev(() => window.__app.test.renderOnce());
    await p.screenshot({ path: `${shots}/${name}`, type: 'jpeg', quality: 70 });
  };
  if (shots) {
    await paint('METAL', [40, 4, 64], 6, 0);
    await ev(() => {
      const a = window.__app;
      a.pov.player.spawn(a.pov.player.pos.clone().set(28, 0, 64));
      a.pov.setLook(-Math.PI / 2, 0.02);
    });
    await settle(1500);
    await ev(() => window.__feelFire());
    await settle(18);
    await shot('feel-flash.jpg');
    await settle(400);
    await hit(ids.METAL, false, 'gun', [34, 5, 64]);
    await hit(ids.GLASS, true, 'gun', [34, 3, 66]);
    for (let i = 0; i < 2; i++) await emit('round:move', { id: 3, from: [29 + i * 2.5, 5.2, 64], to: [31.5 + i * 2.5, 5.1, 64] });
    await settle(45);
    await shot('feel-sparks.jpg');
  }

  check('no console errors', app.errors.length === 0, app.errors.join('\n'));
} catch (e) {
  check(`threw ${String(e?.stack ?? e).slice(0, 600)}`, false);
} finally {
  await app.close();
}
const fails = app.failures();
console.log(fails ? `${fails} failed (${app.secs()})` : `all ok (${app.secs()})`);
process.exit(fails ? 1 : 0);
