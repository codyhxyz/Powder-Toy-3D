// CPU-only: real NPC orchestration, figure, models, firearms and effects.
// Only body movement, AI decisions and GPU-backed kit plumbing are stubbed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { povEvents } from '../src/pov/events.js';
import { attachModel } from '../src/pov/models.js';
import { createVfx } from '../src/pov/vfx.js';

const replacements = {
  './player.js': `const createPlayer = () => ({
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), status: { has: () => false, tint: (out) => out.fill(0) },
    perks: { toolRate: 1 }, size: 1, get eyeHeight() { return 5 * this.size; }, onGround: true,
    spawn(at) { this.pos.copy(at); this.dead = false; }, update() {}, applyImpulse() {}, dispose() {},
  });`,
  './tools/index.js': 'const createKit = globalThis.__npcCreateKit;',
  './ai/brain.js': `class Agent {
    constructor(npc) { this.npc = npc; this.position = new THREE.Vector3(); this.velocity = new THREE.Vector3(); this.record = {};
      this.brain = { clearSubgoals() {} }; this.intent = {}; }
    think() {} update() {} landed() {} clearIntent() { this.intent = {}; }
  }
  const wantsMelee = () => false;`,
  './ai/gunner.js': 'const GunnerAgent = Agent;',
};
const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (!url.endsWith('/src/pov/npc.js')) return next(url, context);
  const source = readFileSync(new URL(url), 'utf8')
    .replace(/^import .* from '([^']+)';$/gm, (line, path) => replacements[path] ?? line);
  return { format: 'module', source, shortCircuit: true };
} });
const { default: pistol } = await import('../src/pov/tools/gun.tool.js');
const { default: smg } = await import('../src/pov/tools/smg.tool.js');
const { default: sniper } = await import('../src/pov/tools/sniper.tool.js');
const { default: rocket } = await import('../src/pov/tools/rocket.tool.js');
globalThis.__npcCreateKit = (env) => {
  const tools = new Map([pistol, smg, sniper, rocket].map((def) => [def.key, def.create(env)]));
  let held = null;
  return {
    get held() { return held; }, getMuzzleWorld: env.getMuzzleWorld,
    use(key, ctx) {
      if (held !== key) tools.get(held)?.deselect();
      held = key; tools.get(key)?.update(ctx);
    },
    putAway() { tools.get(held)?.deselect(); held = null; },
    dispose() { tools.forEach((t) => t.dispose()); },
  };
};
const { createNpc } = await import('../src/pov/npc.js');
delete globalThis.__npcCreateKit;
const sim = { g: { nx: 128, ny: 64, nz: 128 }, gravity: 0.025 };
const scene = new THREE.Scene(), volume = new THREE.Object3D();
volume.position.set(-30, 2, 10);
const scale = 0.3;
const toWorld = (p, out = new THREE.Vector3()) => out.copy(p).multiplyScalar(scale).add(volume.position);
const world = { player: null, toWorld, scale, worldToGrid: new THREE.Matrix4(), stepsPerFrame: 1 };
const env = { renderer: {}, scene, getSim: () => sim, getScale: () => scale, getVolume: () => volume,
  ballistics: { count: 0, fire: (() => { let id = 0; return () => ++id; })() },
};
const ai = { world: { ready: true, raycast: () => ({ valid: false }) } };
const vfx = createVfx({ ...env, camera: new THREE.PerspectiveCamera(), isActive: () => true });
const events = [], off = povEvents.on('gun:fire', (e) => events.push(e));
const near = (a, b, label) => assert.ok(a.distanceTo(b) < 1e-8, label);
const forward = (model) => new THREE.Vector3(0, 0, -1).applyQuaternion(model.getWorldQuaternion(new THREE.Quaternion()));
const visible = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
const random = Math.random;
Math.random = () => 0;
try {
  for (const style of ['axeman', 'gunner']) {
    const npc = createNpc({ env, ai, style, oneShot: true, home: () => new THREE.Vector3(40, 1, 40) });
    scene.add(npc.root);
    try {
      // Spawn/patrol with no attack: the gunner already has a visible gun.
      npc.update(0.1, world);
      if (style === 'gunner') assert.ok(visible(npc.root.getObjectByName('viewmodel-gun')), 'idle gunner carries SMG');
      for (const [key, modelKey] of [['GUN', 'pistol'], ['SMG', 'gun'], ['SNIPER', 'sniper'], ['ROCKET', 'rpg']]) {
        const template = attachModel(new THREE.Group(), modelKey, null, { arm: false });
        const handle = template.info.grip.clone(); template.dispose();
        for (const [pitch, yaw, size, moving] of [[0, 0, 1, false], [0.7, 1.5, 1, true], [-0.8, -2, 0.5, true]]) {
          vfx.clear();
          npc.body.size = size;
          npc.body.onGround = !moving;
          npc.body.inLiquid = moving;
          npc.body.vel.set(moving ? 8 : 0, 0, 0);
          const eye = npc.body.pos.clone().setY(npc.body.pos.y + npc.body.eyeHeight);
          const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
          npc.agent.intent = { tool: key, look: eye.clone().addScaledVector(dir, 30), primary: true, primaryPressed: true };
          const count = events.length;
          npc.update(2, world);
          const model = npc.root.getObjectByName(`viewmodel-${modelKey}`);
          assert.ok(visible(model), `${style}/${key}: equipped model visible`);
          near(forward(model), dir, `${key}: barrel follows pitch/yaw through walking/swimming`);
          near(model.localToWorld(handle.clone()), model.parent.getWorldPosition(new THREE.Vector3()), `${key}: handle sits in mitten`);
          const muzzle = model.getObjectByName('muzzle').getWorldPosition(new THREE.Vector3());
          near(npc.kit.getMuzzleWorld(key), muzzle, `${key}: current-frame world muzzle`);
          assert.ok(muzzle.distanceTo(toWorld(eye)) > 0.3 * scale * size, `${key}: muzzle distinct from eye`);
          model.traverse((o) => {
            if (o.isMesh) assert.ok(!o.material.isMeshLambertMaterial, `${key}: world-lit, not invisible-viewmodel lighting`);
          });
          assert.equal(events.length, count + 1, `${key}: fires`);
          const shot = events.at(-1);
          assert.equal(shot.by, npc.id);
          near(shot.muzzleWorld, muzzle, `${key}: shot flash leaves visible gun this frame`);
          near(shot.dir, dir, 'AI aim unchanged');
          near(vfx.light.position, muzzle, 'NPC muzzle flash/light uses real barrel');
          if (key !== 'ROCKET') {
            near(shot.origin, eye, 'cosmetic origin does not alter AI ballistics');
            const end = eye.clone().addScaledVector(dir, 30);
            povEvents.as({ id: npc.id, at: eye }, () => povEvents.emit('round:move', { id: shot.id, kind: 'round', from: eye, to: end }));
            const tracer = vfx.batch.children.find((o) => o.name === 'pov-tracer' && o.visible);
            tracer.updateMatrixWorld();
            near(tracer.localToWorld(new THREE.Vector3(0, -0.5, 0)), muzzle, 'NPC tracer starts at visible muzzle');
            near(tracer.localToWorld(new THREE.Vector3(0, 0.5, 0)), toWorld(end), 'NPC tracer keeps real ballistic endpoint');
          }
          npc.agent.intent = {};
          npc.update(0.05, world);
          assert.ok(visible(model), `${key}: no intent does not remove weapon`);
        }
      }
      npc.agent.weapons = new Set(['GUN']);
      npc.agent.intent = {};
      npc.update(0.05, world);
      assert.ok(visible(npc.root.getObjectByName('viewmodel-pistol')), 'restricted inventory selects an allowed visible gun');
      npc.body.dead = true;
      npc.update(0.1, world);
      assert.ok(!visible(npc.root.getObjectByName('viewmodel-pistol')), 'dead NPC does not keep live weapon');
      assert.equal(npc.kit.getMuzzleWorld('GUN'), null, 'dead NPC has no firing muzzle');
    } finally { npc.dispose(); scene.remove(npc.root); }
  }
  console.log('PASS: NPC equipped visibility, grip/aim/scale, current-frame muzzle flash + tracer, idle/restrictions/death; player aim unchanged');
} finally { Math.random = random; off(); vfx.dispose(); hooks.deregister(); }
