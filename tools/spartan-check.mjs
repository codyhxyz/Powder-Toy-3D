// node tools/spartan-check.mjs [port] [screenshot.png] — needs a dev server.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 960, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|POV failed/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${process.argv[2] ?? 5267}/?preset=lab`);
  await ready(page);
  await page.evaluate(async () => {
    const a = window.__app;
    a.settings.character = 'stick'; // armor must override either saved body choice
    await a.pov.enter({ at: new a.THREE.Vector3(44, 3, 110) });
    a.pov.test.assumeLocked = true;
  });
  for (const mode of ['slayer', 'ctf', 'koth', 'infection', 'siege']) {
    const result = await page.evaluate(async mode => {
      const a = window.__app, f = a.pov.figure, T = a.THREE;
      await a.pov.game.start(mode, { side: 'red' });
      const state = {
        feet: new T.Vector3(), scale: 1, yaw: 0, worldToGrid: new T.Matrix4(),
        speedH: 0, velY: 0, onGround: true, inLiquid: false, dead: false, deadTime: 0,
      };
      f.setVisible(true);
      f.update(1 / 60, state);
      const showing = f.showing, model = f.model;
      const hand = model.getObjectByName('stick-hand_r');
      const visor = model.getObjectByName('gold-visor');
      const poses = [];
      for (const pose of [{ speedH: 8 }, { crouch: 1 }, { inLiquid: true, speedH: 4 }, { dead: true, deadTime: 2 }]) {
        for (let i = 0; i < 30; i++) f.update(1 / 60, { ...state, ...pose });
        model.updateMatrixWorld(true);
        poses.push(hand.getWorldPosition(new T.Vector3()).toArray().every(Number.isFinite));
      }
      a.pov.game.end();
      f.update(1 / 60, state);
      return {
        showing, visor: !!visor, handOnArmor: !!hand?.parent.parent.parent.parent.getObjectByName('chest-armor'),
        poses, restored: f.showing, saved: a.settings.character,
      };
    }, mode);
    assert.equal(result.showing, mode === 'siege' ? 'stick' : 'spartan', mode);
    assert.equal(result.visor, mode !== 'siege', `${mode}: helmet replaces wizard`);
    if (mode !== 'siege') assert.ok(result.handOnArmor, 'held weapon uses armored hand, not hidden stickman');
    assert.ok(result.poses.every(Boolean), 'walk, crouch, swim, death keep valid transforms');
    assert.equal(result.restored, 'stick', 'match end restores saved body');
    assert.equal(result.saved, 'stick', 'mode does not overwrite preference');
    console.log(`ok ${mode}: body, helmet, hand, animations, restore`);
  }
  // Realistic preference also comes back, including when its download finishes mid-match.
  await page.evaluate(async () => {
    const a = window.__app;
    a.settings.character = 'real';
    await a.pov.game.start('slayer', { side: 'blue' });
  });
  assert.equal(await page.evaluate(() => window.__app.pov.figure.showing), 'spartan');
  await page.evaluate(() => {
    const a = window.__app;
    a.pov.game.end();
    a.pov.update(0);
  });
  await page.waitForFunction(() => window.__app.pov.figure.loaded, null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__app.pov.figure.showing), 'real');

  await page.evaluate(async () => {
    const a = window.__app;
    await a.pov.game.start('slayer', { side: 'red' });
    a.pov.vehicles.spawnLayout({ vehicles: [
      { kind: 'jeep', at: [40, 8, 70] },
      { kind: 'hoverbike', at: [64, 8, 70] },
    ] });
  });
  await page.waitForFunction(() => {
    const a = window.__app;
    a.pov.vehicles.update(0, { player: a.pov.player, live: false, worldToGrid: new a.THREE.Matrix4() });
    return a.pov.vehicles.list.length === 2;
  }, null, { timeout: 30000, polling: 100 });
  assert.ok(await page.evaluate(() => window.__app.pov.vehicles.list.every(v =>
    v.spartan.visible && !v.wizard.visible && v.spartan.getObjectByName('gold-visor')
  )), 'jeep and hoverbike use armored drivers in Halo');
  // Draw the real game materials, not just the standalone model checkpoint.
  await page.evaluate(() => {
    const a = window.__app, T = a.THREE, f = a.pov.figure;
    const feet = new T.Vector3(44, 3, 110).multiplyScalar(a.scale).add(a.volume.position);
    f.update(0, { feet, scale: a.scale, yaw: 0, worldToGrid: a.volume.matrixWorld.clone().invert(),
      speedH: 0, velY: 0, onGround: true, inLiquid: false, dead: false, deadTime: 0 });
    f.setVisible(true);
    for (const v of a.pov.vehicles.list) v.impl.driver.visible = true;
    a.camera.position.copy(feet).add(new T.Vector3(8, 6, -14).multiplyScalar(a.scale));
    a.camera.lookAt(feet.clone().add(new T.Vector3(0, 2.7, 0).multiplyScalar(a.scale)));
  });
  await render(page);
  if (process.argv[3]) await page.screenshot({ path: process.argv[3].replace(/\.png$/, '-game.png') });
  await page.evaluate(() => {
    const a = window.__app;
    a.pov.game.end();
    a.pov.vehicles.update(0, { player: a.pov.player, live: false, worldToGrid: new a.THREE.Matrix4() });
  });
  assert.ok(await page.evaluate(() => window.__app.pov.vehicles.list.every(v =>
    !v.spartan.visible && v.wizard.visible
  )), 'drivers restore outside Halo');
  console.log('ok jeep and hoverbike drivers; game materials render');

  // A full-size, static model checkpoint; the game loop remains parked.
  if (process.argv[3]) {
    await page.evaluate(async () => {
      const T = window.__app.THREE;
      const { buildSpartan } = await import('/src/pov/figureSpartan.js');
      const rig = buildSpartan(), scene = new T.Scene();
      rig.body.position.y = rig.hipY;
      rig.body.traverse(o => {
        if (o.isMesh) o.material = new T.MeshStandardMaterial({
          color: new T.Color(...o.userData.albedo), roughness: o.name === 'gold-visor' ? 0.25 : 0.65,
          metalness: o.name === 'gold-visor' ? 0.6 : 0.15,
        });
      });
      scene.add(rig.body, new T.HemisphereLight(0xd7e9ff, 0x404032, 3));
      const sun = new T.DirectionalLight(0xffffff, 4);
      sun.position.set(-3, 6, -5); scene.add(sun);
      scene.background = new T.Color(0x20262c);
      const camera = new T.PerspectiveCamera(34, 960 / 720, 0.1, 50);
      camera.position.set(7, 5.1, -12); camera.lookAt(0, 2.7, 0);
      const renderer = new T.WebGLRenderer({ antialias: true });
      renderer.setSize(960, 720);
      renderer.domElement.style.cssText = 'position:fixed;inset:0;z-index:99999';
      document.body.append(renderer.domElement);
      renderer.render(scene, camera);
    });
    await page.screenshot({ path: process.argv[3] });
  }
  assert.deepEqual(errors, []);
  console.log('ok realistic preference restored; no rendering errors');
} finally {
  await browser.close();
}
