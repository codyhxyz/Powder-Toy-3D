// CPU-only gameplay regression: real village controller/models, stubbed DOM UI and audio.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { HOMES, FLOOR, HOME_Z, initialState } from '../src/pov/village/state.js';
import { VILLAGE_TOOLS, punchTarget, punchOccluded, stepResident } from '../src/pov/village/actions.js';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/village/index.js') && specifier === './ui.js') return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
    export function createVillageUi(opts) {
      let opened = false;
      return { get opened() { return opened; }, open() { opened = true; opts.onOpen(); },
        close() { if (opened) { opened = false; opts.onClose(); } }, update() {}, handleKey() { return false; }, talk() {} };
    }`)}` };
  if (context.parentURL?.endsWith('/village/index.js') && specifier === './speech.js') return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
    export function createSpeech() { return globalThis.__villageSpeech; }
  `)}` };
  return next(specifier, context);
} });
const events = new Map();
globalThis.addEventListener = (key, fn) => events.set(key, fn);
globalThis.document = { body: { classList: { toggle() {} } }, querySelector: () => null, addEventListener() {},
  createElement: () => ({ getContext: () => ({ beginPath() {}, roundRect() {}, fill() {}, fillText() {} }) }) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.__villageSpeech = { stats: { played: 0 }, muted: false, bonks: 0, speak() { this.stats.played++; }, bonk() { this.bonks++; }, stop() {} };
const { createVillage } = await import('../src/pov/village/index.js');
const size = [384, 128, 256], sim = { origin: new THREE.Vector3() }, world = { scene: { key: 'willowCove' }, P: { size, seed: 1 } };
const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), size: 1, width: 2, height: 5, onGround: true, sprintRush: 0 };
const camera = { look: { yaw: 0, pitch: 0 }, third: false,
  forwardH(out) { return out.set(-Math.sin(this.look.yaw), 0, -Math.cos(this.look.yaw)); } };
let active = true, picked = { valid: false }, pending = null, mode = 'animalCrossing', modal = false, tool = null, used = null, inputReleases = 0, actionReleases = 0;
const app = { scene: new THREE.Scene(), getSim: () => sim, getMode: () => mode, getWorld: () => world,
  getScale: () => 1, getVolume: () => ({ position: new THREE.Vector3() }), requestRender() {}, isTyping: () => false,
  pickRay: () => pending ?? Promise.resolve(picked) };
document.querySelector = () => modal ? {} : null;
const village = createVillage({ app, getPlayer: () => player, live: () => active, camera,
  releaseInput() { inputReleases++; }, releaseActions() { actionReleases++; }, freeMouse() {}, onEnabled() {},
  onTool: key => { tool = key; }, useTool: button => { used = button; } });
const atMaple = () => { player.pos.set(size[0] / 2 + HOMES[1], FLOOR, size[2] / 2 + HOME_Z + 3); camera.look.yaw = 0; };
atMaple(); village.setEnabled(true, world.P);
assert.equal(camera.third, true);
assert.equal(village.tool, null);
assert.deepEqual(village.state, initialState());
await village.punch();
assert.equal(__villageSpeech.bonks, 1, 'nearby forward neighbor gets a bonk');
assert.equal(__villageSpeech.stats.played, 1, 'brief animalese reaction');
const before = village.residents[0].z;
village.update(0.1, true); assert.ok(village.residents[0].z < before, 'neighbor recoils away, not damaged');
assert.ok(village.avatar.children[0].children[3].rotation.x > 1, 'the AC avatar visibly extends its punching arm');
assert.deepEqual(village.state, initialState(), 'punching leaves saved furniture untouched');
await village.punch(); assert.equal(__villageSpeech.bonks, 1, 'cooldown blocks repeats');
village.update(0.5); camera.look.yaw = Math.PI;
await village.punch(); assert.equal(__villageSpeech.bonks, 1, 'cannot punch behind your back');
village.update(0.5); atMaple();
picked = { valid: true, cell: player.pos.clone().add(new THREE.Vector3(0, 3, -1)) };
await village.punch(); assert.equal(__villageSpeech.bonks, 1, 'terrain between fist and neighbor blocks hit');
village.update(0.5); picked = { valid: false };
village.open(); await village.punch(); assert.equal(__villageSpeech.bonks, 1, 'dialogue owns input'); village.close();
modal = true; await village.punch(); assert.equal(__villageSpeech.bonks, 1, 'main menu owns input'); modal = false;
active = false; await village.punch(); assert.equal(__villageSpeech.bonks, 1, 'inactive player cannot punch'); active = true;
player.pos.y += 8; await village.punch(); assert.equal(__villageSpeech.bonks, 1, 'vertical reach is bounded');
village.update(0.5); atMaple(); player.pos.z += 20;
await village.punch(); assert.equal(__villageSpeech.bonks, 1, 'cannot hit at distance');
village.update(0.5); atMaple();
let resolve; pending = new Promise(r => { resolve = r; }); const strike = village.punch();
village.open(); village.close(); resolve({ valid: false }); await strike;
assert.equal(__villageSpeech.bonks, 1, 'opening then closing a modal still cancels an in-flight punch'); pending = null;

const releasesBeforeTools = inputReleases, actionsBeforeTools = actionReleases;
for (const entry of VILLAGE_TOOLS) {
  village.act({ type: 'tool', key: entry.key }); assert.equal(tool, entry.key);
  village.update(0.1, true);
  let models = 0; village.avatar.traverse(o => { if (o.name.startsWith('viewmodel-')) models++; });
  assert.equal(models, entry.key ? 1 : 0, 'one visible tool model attached to the AC avatar');
}
assert.equal(inputReleases, releasesBeforeTools, 'switching tools preserves movement and held touch pointers');
assert.equal(actionReleases, actionsBeforeTools + VILLAGE_TOOLS.length, 'tool switches clear only action input');
village.act({ type: 'tool', key: 'GUN' }); assert.equal(tool, 'TROWEL', 'weapons cannot be equipped');
village.act({ type: 'tool-primary' }); assert.equal(used, 'primary', 'UI/touch use reaches the existing tools');
village.act({ type: 'tool-secondary' }); assert.equal(used, 'secondary');
village.cycleTool(1); assert.equal(tool, null); village.cycleTool(-1); assert.equal(tool, 'TROWEL');
player.pos.set(size[0] / 2 + HOMES[0], FLOOR, size[2] / 2 + HOME_Z);
assert.ok(!village.act({ type: 'grab', id: 'plant' }).error);
await village.punch(); assert.equal(__villageSpeech.bonks, 1, 'carrying furniture blocks punch');
used = null; village.act({ type: 'tool-primary' }); assert.equal(used, null, 'carrying blocks terrain edits');
village.act({ type: 'tool', key: 'SHOVEL' }); assert.equal(tool, 'TROWEL', 'carrying blocks tool changes');
village.act({ type: 'cancel' });
village.setEnabled(false); assert.equal(camera.third, false); assert.equal(village.tool, null);
let models = 0; village.avatar.traverse(o => { if (o.name.startsWith('viewmodel-')) models++; }); assert.equal(models, 0, 'exit disposes held model');

const resident = { spec: { home: 1 }, x: 0, z: 0, vx: 100, vz: 100, bonk: 1 };
for (let i = 0; i < 600; i++) { stepResident(resident, 1 / 60, i / 60, true); assert.ok(Math.abs(resident.x) <= 1 && Math.abs(resident.z) <= 8); }
assert.equal(resident.bonk, 0, 'recoil settles back into wandering');
assert.equal(punchTarget({ x: 0, y: 0, z: 3 }, 0, [{ spec: { home: 2 }, x: 0, z: 0 }], 1), null, 'never target a neighboring room');
assert.equal(punchOccluded({ valid: true, cell: new THREE.Vector3(0, 3, -10) }, new THREE.Vector3(0, 3, 0), 4), false, 'wall behind neighbor is not an obstruction');
const source = readFileSync(new URL('../src/pov/index.js', import.meta.url), 'utf8');
assert.match(source, /const canUse = \(\) => !village.enabled/, 'body combat remains disabled in AC');
assert.match(source, /ctx.peaceful = village.enabled/, 'mining uses the peaceful body-hit guard');
assert.match(source, /if \(village.enabled && !use\) toolbelt.tool\(toolbelt.selectedKey\)\?\.deselect\?\.\(\)/, 'blocked village input resets buffered tool actions');
assert.match(source, /toolbelt.restrict\(villageTools.restricted, villageTools.selected\)/, 'previous restriction is restored on exit');
assert.match(readFileSync(new URL('../src/pov/tools/melee.js', import.meta.url), 'utf8'), /ctx.peaceful \? null : rayTarget/, 'pickaxe cannot hurt any body in peaceful mode');
hooks.deregister();
console.log('PASS village punch reach/facing/cooldown/walls/modal/carry/async guards, bonk/animalese, recoil recovery, peaceful tool selection/use/models and cleanup');
