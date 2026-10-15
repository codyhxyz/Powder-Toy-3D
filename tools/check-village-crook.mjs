// CPU only: real village controller/models, native module UI/audio adapters.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { initialCrookState, validCrookState, startCrook, answerCrook, crookDialogue, loadCrookState, CROOK_LINES } from '../src/pov/village/crook.js';
import { HOMES, FLOOR, HOME_Z, HOME_ENTRY } from '../src/pov/village/state.js';
import { createCrookController } from '../src/pov/village/crookController.js';

const saves = new Map();
const storage = { getItem: k => saves.get(k) ?? null, setItem: (k, v) => saves.set(k, v) };
// All 64 routes deliver their chosen reactions, survive reload, and debit once.
for (let route = 0; route < 64; route++) {
  let s = startCrook(initialCrookState());
  for (let i = 0; i < CROOK_LINES.length; i++) {
    const answer = (route >> i) & 1;
    assert.equal(answerCrook(s, 'invalid'), s);
    const id = crookDialogue(s).choices[Math.min(answer, crookDialogue(s).choices.length - 1)].id;
    s = answerCrook(s, id);
    assert.equal(answerCrook(s, id), s);
    if (!s.complete) {
      assert.equal(s.balance, 0);
      assert.equal(crookDialogue(s).text, `${CROOK_LINES[i].replies[answer]}\n\n${CROOK_LINES[i + 1].text}`);
    }
    storage.setItem('mid-dialogue', JSON.stringify(s));
    assert.deepEqual(loadCrookState(storage, 'mid-dialogue').state, s);
  }
  assert.equal(s.balance, -56000); assert.equal(s.complete, true);
  storage.setItem('roundtrip', JSON.stringify(s));
  assert.deepEqual(loadCrookState(storage, 'roundtrip').state, s);
  assert.equal(crookDialogue(s), null);
}
for (let step = 0; step < CROOK_LINES.length; step++) {
  const legacy = { version: 1, started: true, step, complete: false, balance: 0 };
  storage.setItem('legacy', JSON.stringify(legacy));
  assert.deepEqual(loadCrookState(storage, 'legacy').state, legacy);
  assert.equal(crookDialogue(legacy).text, CROOK_LINES[step].text);
}
const legacyComplete = { version: 1, started: true, step: 6, complete: true, balance: -56000 };
storage.setItem('legacy', JSON.stringify(legacyComplete));
assert.deepEqual(loadCrookState(storage, 'legacy').state, legacyComplete);
assert.equal(crookDialogue(legacyComplete), null);
for (const reply of [-1, 2, 0.5, '0', null]) {
  assert.equal(validCrookState({ ...initialCrookState(), started: true, step: 1, reply }), false);
}
assert.equal(validCrookState({ ...initialCrookState(), reply: 0 }), false);
for (const raw of ['{broken', '{"version":99}', '{"version":1,"started":true,"step":55}']) {
  storage.setItem('willow-cove:crook:v1:corrupt', raw);
  const c = createCrookController(storage, 'corrupt');
  c.tick(.05, { x: 0, y: 0, z: -7 });
  for (let z = -7; z > -14; z -= .5) c.tick(.05, { x: 0, y: 0, z });
  assert.equal(c.state.started, true);
  assert.equal(storage.getItem('willow-cove:crook:v1:corrupt'), raw);
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  const modules = {
    './debtBadge.js': `export function createDebtBadge() {
      const badge = { updates: [], disposed: false, update(value) { this.updates.push(value); }, dispose() { this.disposed = true; } };
      globalThis.lastDebtBadge = badge; return badge;
    }`,
    './ui.js': `export function createVillageUi(o) {
      globalThis.uiOptions = o; let opened = false, talking = false;
      return { get opened(){return opened}, get talking(){return talking},
        talk(resident,text,choices,options){opened=talking=true; globalThis.lastTalk={resident,text,choices,options};o.onOpen()},
        close(){if(opened){opened=talking=false;o.onClose()}},
        open(){opened=true;o.onOpen()}, update(){}, handleKey(){return false}
      };
    }`,
    './speech.js': `export function createSpeech(){return {stats:{},speak(){},stop(){},swing(){},bonk(){}}}`,
  };
  if (context.parentURL?.endsWith('/village/index.js') && modules[specifier])
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(modules[specifier])}` };
  return next(specifier, context);
} });
globalThis.addEventListener = () => {};
globalThis.document = { hidden: false, body: { classList: { toggle() {} } }, querySelector: () => null,
  addEventListener() {}, createElement: () => ({ getContext: () => ({
    beginPath() {}, roundRect() {}, moveTo() {}, lineTo() {}, fill() {}, fillText() {},
  }) }) };
globalThis.localStorage = storage;
const { createVillage } = await import('../src/pov/village/index.js');
const size = [512, 128, 512], sim = { origin: new THREE.Vector3() };
const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), size: 1, width: 1.6, height: 5.8,
  onGround: true, dead: false, leaping: false, cancelJump() { this.leaping = false; } };
const camera = { look: { yaw: 0, pitch: 0 }, third: true, forwardH: out => out.set(0, 0, -1) };
let seed = 'cpu', mode = 'animalCrossing', uses = 0;
const app = { scene: new THREE.Scene(), getSim: () => sim, getScale: () => 1,
  getVolume: () => ({ position: new THREE.Vector3() }), getMode: () => mode,
  getWorld: () => ({ scene: { key: 'willowCove' }, P: { size, seed } }), requestRender() {}, isTyping: () => false };
const village = createVillage({ app, getPlayer: () => player, live: () => true, camera,
  freeMouse() {}, releaseInput() {}, releaseActions() {}, onEnabled() {}, onTool() {}, useTool() { uses++; } });
function position(x, z, y = 0, home = 0) {
  player.pos.set(size[0] / 2 + HOMES[home] + x - sim.origin.x, FLOOR + y - sim.origin.y,
    size[2] / 2 + HOME_Z + z - sim.origin.z);
}
function tick(dz = 0, dx = 0) {
  const input = { move: { x: dx, z: dz }, jump: true, chargeJump: true, sprint: true };
  village.beforeBody(input, .05);
  player.pos.x += dx; player.pos.z += dz;
  village.afterBody(); village.update(.05, true);
  return input;
}
function reset(name, x = 0, z = -7, y = 0, home = 0) {
  village.setEnabled(false); seed = name; player.onGround = true; player.leaping = false;
  position(x, z, y, home); village.setEnabled(true, { size, seed });
}
function openDoor() {
  if (uiOptions.primary()?.title.startsWith('Open ')) village.act({ type: 'interact' });
  for (let i = 0; i < 10; i++) tick();
}
function exit() {
  openDoor(); // Open the new front door before leaving.
  for (let i = 0; i < 14; i++) tick(-.5);
}
function approach() { for (let i = 0; i < 80 && village.crook.phase !== 'talking'; i++) tick(); }
reset('first');
exit();
assert.equal(village.crook.state.started, true);
assert.equal(village.crook.phase, 'approaching');
const staging = village.crook.position;
assert.ok(staging.z < -13);
tick();
assert.ok(Math.hypot(village.crook.position.x - staging.x, village.crook.position.z - staging.z) <= .25 + 1e-7);
approach();
assert.equal(village.crook.phase, 'talking');
assert.ok(Math.hypot(village.crook.position.x, village.crook.position.z + 14) >= 3.6 - 1e-6);
assert.equal(lastTalk.options.choiceOnly, true);
assert.equal(lastTalk.resident.name, 'Tim Crook');
assert.equal(village.root.getObjectByName('village-tanuki').visible, true);
assert.ok(village.root.getObjectByName('overall-bib'));
assert.ok(village.root.getObjectByName('ring-tail'));
assert.equal(village.canAct, false);
const gated = tick(); assert.equal(gated.jump, false); assert.equal(gated.chargeJump, false);
village.act({ type: 'tool-primary' }); village.act({ type: 'kick' }); assert.equal(uses, 0);
uiOptions.speakNext(lastTalk.choices[1].id);
assert.equal(village.crook.state.step, 1);
const firstReply = `${CROOK_LINES[0].replies[1]}\n\n${CROOK_LINES[1].text}`;
assert.equal(lastTalk.text, firstReply, 'real UI receives the selected reaction before the next stage');
village.close();
tick(); assert.equal(village.blocked, false); assert.equal(village.crook.phase, 'idle');
for (let i = 0; i < 10; i++) tick();
assert.equal(village.blocked, false);
village.act({ type: 'interact' });
assert.equal(village.crook.state.step, 1); assert.equal(village.blocked, true);
assert.equal(lastTalk.text, firstReply, 'closing and reopening preserves the reaction');
while (!village.crook.state.complete) uiOptions.speakNext(lastTalk.choices[0].id);
assert.equal(village.crook.state.balance, -56000); assert.equal(village.blocked, false);
assert.equal(lastDebtBadge.updates.filter(u => u.reveal).length, 1, 'completion reveals the debt once');
assert.equal(lastDebtBadge.updates.at(-1).balance, -56000);
assert.equal(village.crook.phase, 'departing');
const exitPosition = village.crook.position;
for (let i = 0; i < 50; i++) tick();
assert.equal(village.crook.phase, 'gone');
assert.equal(village.root.getObjectByName('village-tanuki').visible, false);
assert.ok(Math.hypot(village.crook.position.x - exitPosition.x, village.crook.position.z - exitPosition.z) > 3, 'Tim walks off, not a teleport');
const oldBadge = lastDebtBadge;
reset('first', 0, -14); tick();
assert.equal(village.crook.state.balance, -56000);
assert.equal(oldBadge.disposed, true);
assert.equal(lastDebtBadge.updates.at(-1).balance, -56000);
assert.ok(lastDebtBadge.updates.every(u => !u.reveal), 'reload restores a docked balance, not the reveal');
assert.equal(village.root.getObjectByName('village-tanuki').visible, false);
reset('foyer', HOME_ENTRY.x, HOME_ENTRY.z);
openDoor();
for (let i = 0; i < 10; i++) tick(-.5);
assert.equal(village.crook.state.started, true, 'walking straight out of the real entry spawn triggers Tim');
reset('second'); assert.equal(village.crook.state.started, false);
exit(); approach(); uiOptions.speakNext(lastTalk.choices[0].id);
village.setEnabled(false);
assert.equal(village.root.children.length, 0); assert.equal(village.blocked, false);
reset('second', 0, -16); village.act({ type: 'interact' });
assert.equal(village.crook.state.step, 1); assert.equal(village.blocked, true);
mode = 'other'; village.update(.05);
assert.equal(village.enabled, false); assert.equal(village.blocked, false); mode = 'animalCrossing';

// External fixtures/teleports, room() boundary, roofs, side walls, neighbors.
reset('teleport'); position(0, -14); tick();
assert.equal(village.crook.state.started, false);
reset('small-teleport');
openDoor();
for (let i = 0; i < 11; i++) tick(-.5);
position(0, -13.2); tick();
assert.equal(village.crook.state.started, false);
reset('room-edge'); for (let i = 0; i < 7; i++) tick(-.5);
assert.equal(village.crook.state.started, false);
reset('outside', 0, -12); for (let i = 0; i < 6; i++) tick(-.5);
assert.equal(village.crook.state.started, false);
reset('roof', 0, -7, 15); exit(); assert.equal(village.crook.state.started, false);
reset('side', 6); exit(); assert.equal(village.crook.state.started, false);
reset('neighbor', 0, -7, 0, 1); exit(); assert.equal(village.crook.state.started, false);
sim.origin.set(37, 4, -21);
reset('offset'); exit(); approach();
assert.equal(village.crook.phase, 'talking');
assert.ok(village.crook.position.z < -14.5);
village.close();
// Swept player-vs-Tim collision uses sim origin, not display coordinates.
const t = village.crook.position;
position(t.x - 6, t.z); tick(0, 8);
const localX = player.pos.x + sim.origin.x - size[0] / 2 - HOMES[0];
assert.ok(localX <= t.x - 2.8 + 1e-6);
// Changed world seed tears down actor/menu and loads an independent record.
seed = 'new-world'; village.update(.05);
assert.equal(village.crook.state.started, false); assert.equal(village.blocked, false);
const actor = createCrookController(storage, 'actor-collision');
actor.tick(.05, { x: 0, y: 0, z: -7 });
for (let z = -7; z > -14; z -= .5) actor.tick(.05, { x: 0, y: 0, z });
for (let i = 0; i < 60; i++) actor.tick(.05, { x: 0, y: 0, z: -14 }, {
  obstacles: [{ x: 3, z: -16, radius: 1.4 }],
});
assert.ok(Math.hypot(actor.position.x - 3, actor.position.z + 16) >= 2.8 - 1e-7);
assert.ok(Math.hypot(actor.position.x, actor.position.z + 14) >= 2.8 - 1e-7);

// Terrain obstruction and reverse actor collision: no moving into terrain/player.
reset('terrain'); player.cellAt = () => 1; exit();
const blockedAt = village.crook.position;
for (let i = 0; i < 10; i++) tick();
assert.deepEqual(village.crook.position, blockedAt);
delete player.cellAt;
position(0, -7); tick();
assert.equal(village.crook.phase, 'idle'); // no chase into house or auto-reopen
village.setEnabled(false); hooks.deregister();

// Small UI source contract: keyboard reveal never bypasses required choices,
// choice clicks reveal first, generic goodbye absent for choice-only dialogue.
const ui = readFileSync(new URL('../src/pov/village/ui.js', import.meta.url), 'utf8');
assert.match(ui, /else if \(!dialogue\.choiceOnly\) speakNext\(\)/);
assert.match(ui, /dialogue\.choiceOnly \? \[\] : \[button\('See you soon!'/);
assert.match(ui, /dialogue\.choiceOnly && revealed < dialogue\.text\.length/);
assert.match(ui, /choiceOnly: !!options\.choiceOnly/);
console.log('PASS Tim Crook pure saves/dialogue, real controller exit/approach/abort/resume/debit/lifecycle/origin/collision/input gates and UI choice-only contract (CPU)');
