// CPU-only execution of the NPC lifecycle, with body/AI/render/tool boundaries
// stubbed. Tests production spawn/update/reset decisions, not GPU movement.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
const replacements = {
  './player.js': `const createPlayer = () => ({
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), status: { has: () => false }, perks: { toolRate: 1 }, size: 1,
    eyeHeight: 6, health: 1, spawns: 0, dead: false,
    spawn(at) { this.spawns++; this.pos.copy(at); this.dead = false; this.health = 1; }, update() {}, dispose() {},
  });`,
  './figure.js': `const createFigure = () => ({ root: new THREE.Group(), bind() {}, compile: async () => {}, update() {}, setVisible() {}, dispose() {} });`,
  './figureCrasher.js': 'const CRASHER_COLORS = {}, buildCrasher = () => {};',
  './models.js': 'const attachModel = () => {};',
  './tools/index.js': 'const createKit = () => ({ putAway() {}, dispose() {} });',
  './tools/catalog.js': 'const gearByKey = () => ({ model: null });',
  './tools/transfer.js': "const pack = () => ({ cells: [] }), persistentLoad = pack, ownedKey = () => '';",
  './ai/brain.js': `class Agent {
    constructor(npc) { this.npc = npc; this.position = new THREE.Vector3(); this.velocity = new THREE.Vector3(); this.record = {}; this.brain = { clearSubgoals() {} }; this.intent = {}; }
    clearIntent() { this.intent = {}; }
    get target() { return this.npc.target(); }
  }
  const wantsMelee = () => false;`,
  './frag.js': 'const throwFrag = () => {};',
  './ai/gunner.js': 'const GunnerAgent = Agent;',
  './ai/world.js': 'const createWorldModel = () => {};',
  './ai/nav.js': 'const createNav = () => {};',
};
const hooks = registerHooks({ load(url, context, next) {
  if (!url.endsWith('/src/pov/npc.js')) return next(url, context);
  let source = readFileSync(new URL(url), 'utf8');
  source = source.replace(/^import .* from '([^']+)';$/gm, (line, path) => replacements[path] ?? line);
  source = source.replace("export { createWorm } from './worm.js';", '');
  return { format: 'module', source, shortCircuit: true };
} });
try {
  const { createNpc } = await import('../src/pov/npc.js');
  const sim = { g: { nx: 128, ny: 64, nz: 128 } };
  const world = { player: null, toWorld: (p, out) => out.copy(p), scale: 1, worldToGrid: new THREE.Matrix4(), stepsPerFrame: 0 };
  for (const oneShot of [true, false]) for (const style of ['axeman', 'gunner']) {
    const npc = createNpc({ env: { renderer: {}, getSim: () => sim }, ai: { world: { ready: false } }, home: () => new THREE.Vector3(20, 4, 20), oneShot, style });
    try {
      npc.update(0, world);
      assert.equal(npc.body.spawns, 1, `${style} appears even on a paused god frame`);
      assert.equal(npc.agent.target.alive, false, 'no fake player is hunted in god view');
      npc.body.dead = true;
      npc.update(999, world);
      assert.equal(npc.body.dead, oneShot);
      assert.equal(npc.body.spawns, oneShot ? 1 : 2, 'only legacy homes replenish');
      assert.equal(npc.finished, oneShot, 'spent one-shot corpses can leave the runtime and let the editor idle');
      npc.reset(); npc.update(0, world);
      assert.equal(npc.body.dead, oneShot, 'reset cannot revive a one-shot NPC');
      assert.equal(npc.body.spawns, oneShot ? 1 : 3);
    } finally { npc.dispose(); }
  }
  console.log('ok NPC lifecycle: paused creation, absent god player, one-shot death/reset, legacy respawn');
} finally { hooks.deregister(); }
