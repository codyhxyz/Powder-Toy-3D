// Real result-button events -> real POV wire -> app map/mode lifecycle -> mission.
// Only rendering, voxel rebuilds and body entry are CPU fixtures; no browser/GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { createMission } from '../src/game/mission.js';
import { isWorld, resolveMode } from '../src/maps.js';

let makePov;
const povUrl = new URL('../src/pov/index.js', import.meta.url).href;
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url === povUrl) return { format: 'module', source: 'export const createPov = app => globalThis.__retryMakePov(app);', shortCircuit: true };
  return next(url, context);
} });
globalThis.__retryMakePov = app => makePov(app);

class Element extends EventTarget {
  nodeType = 1;
  children = [];
  hidden = false;
  style = {};
  classes = new Set();
  classList = {
    add: name => this.classes.add(name),
    toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
  };
  constructor(tag) { super(); this.tagName = tag; }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  click() { this.dispatchEvent(new Event('click')); }
}
globalThis.document = { body: new Element('body'), createElement: tag => new Element(tag) };
const { createMissionHud } = await import('../src/game/missionHud.js');
const { default: povWire } = await import('../src/wire/pov.js');
const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const openMapSource = appSource.slice(appSource.indexOf('function openMap('), appSource.indexOf('// Animal Crossing on Tinker Creek:'));
const startModeSource = appSource.slice(appSource.indexOf('async function startMode('), appSource.indexOf('// maps.js is plain data'));
const povSource = readFileSync(new URL('../src/pov/index.js', import.meta.url), 'utf8');
const exitSource = povSource.slice(povSource.indexOf('  function exit('), povSource.indexOf('  function finishExit('));

const map = { key: 'retry-fixture', size: 'world', scene: 'retry-fixture', modes: ['crueltySquad'],
  mission: { id: 'retry-fixture', name: 'CPU Retry fixture', spawn: [12, 4, 20], spawnYaw: 0.75,
    targets: [{ id: 'target', name: 'Target', at: [20, 4, 20] }], guards: [],
    extraction: { at: [50, 4, 20], radius: 3, height: 4 } } };
const scene = new THREE.Scene();
const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), dead: false };
const sim = { origin: new THREE.Vector3(10, 0, 10) };
const toolbelt = { selectedKey: 'SHOVEL', restricted: null,
  restrict(keys, selected) { this.restricted = keys; if (selected) this.selectedKey = selected; },
  select(key) { this.selectedKey = key; } };
const actors = [], entries = [], looks = [], errors = [], calls = [];
let rebuilds = 0, edits = 0, facade, mission, pendingStart;
const world = () => ({ whenReady: async () => {}, pending: Promise.resolve() });
const lifecycle = {
  THREE, console: { error: (...args) => errors.push(args) },
  modeEpoch: 0, selectedMode: 'crueltySquad', villageFocus: null,
  settings: { view: 'plain', size: 'world', scene: map.scene, gravity: 1 },
  sim, win: world(), ctx: {}, mp: { role: 'solo', guard: () => false, guardWorld: () => false },
  graphicsFailure: null, mapByKey: key => key === map.key ? map : null, mapOf: () => map,
  isWorld, resolveMode, dimsOf: () => [64, 32, 64], gridFits: () => true,
  wire: () => ({ moveWindow: () => false }), hud: { toast() {} }, loadWatch: { start() {} },
  scoreboard: { reset() {} }, presentation: { select() {} }, pacer: { wake() {} },
  viewForMode: (_chosen, view) => view, applyGravity() {},
  useMap(m) { assert.equal(m, map); },
  // A world rebuild's CPU boundary: replace terrain and notify its owners.
  setSize() { rebuilds++; edits = 0; lifecycle.pov.exit(true); lifecycle.pov.mission.end(); lifecycle.win = world(); },
};
const api = runInNewContext(`${openMapSource}\n${startModeSource}\n({ openMap, startMode })`, lifecycle);
const app = {
  scene, settings: lifecycle.settings, sim, mp: lifecycle.mp, bootMatch: false,
  openMap(key, mode) { calls.push([key, mode]); return api.openMap(key, mode); },
  setMode(mode) { calls.push(['mode', mode]); return api.startMode(mode); },
};
makePov = narrowed => {
  facade = narrowed;
  const hud = createMissionHud({ retry: () => mission.retry(), leave: () => app.pov.exit(true) });
  mission = createMission({ app: narrowed, scene, player, toolbelt, hud,
    env: () => ({}), respawnPlayer(at) { player.pos.copy(at); player.dead = false; },
    loadNpcs: async () => ({ ai: {}, mod: { createNpc(options) {
      const actor = { root: new THREE.Group(), agent: {}, disposed: false,
        body: { pos: options.home(), dead: false, on() {} },
        setVisible() {}, update() {}, dispose() { this.disposed = true; } };
      actors.push(actor); return actor;
    } } }),
  });
  // Run the real mission-exit branch; no active camera skips GPU-facing cleanup.
  const exit = runInNewContext(`${exitSource}\nexit`, {
    mission, app: narrowed, viewmodel: { userData: {} }, village: { setEnabled() {} }, active: () => false,
  });
  return {
    player, mission, game: { useLayout() {}, end() {} }, vehicles: { spawnLayout() {} }, village: { setEnabled() {} },
    exit,
    async enter(opts) { assert.equal(opts.valid(), true); entries.push(opts); },
    setLook(...args) { looks.push(args); },
  };
};
povWire.attach(app);
lifecycle.pov = app.pov;
// Capture async mode entry initiated by synchronous openMap, without changing it.
lifecycle.startMode = (...args) => (pendingStart = api.startMode(...args));
const root = document.body.children[0];
const result = root.children[1];
const retry = result.children.find(node => node.textContent === 'Retry');
const leave = result.children.find(node => node.textContent === 'Leave mission');
assert.ok(retry && leave, 'actual result controls are mounted by h');

assert.equal(await api.startMode('crueltySquad'), true);
assert.equal(result.hidden, true);
for (const phase of ['failed', 'complete']) {
  const oldActors = [...mission.actors];
  oldActors[0].body.dead = true;
  if (phase === 'failed') player.dead = true;
  else player.pos.set(40, 4, 10); // extraction in origin-relative cells
  mission.update(0, {});
  assert.equal(mission.state.phase, phase);
  assert.equal(mission.state.eliminated, 1);
  assert.equal(result.hidden, false);
  edits = 5;
  const before = rebuilds;
  retry.click();
  // Map replacement is synchronous, body/NPC reentry is asynchronous.
  assert.deepEqual(calls.at(-1), [map.key, 'crueltySquad']);
  assert.equal(rebuilds, before + 1, 'Retry rebuilt the authored map, not just the body');
  assert.equal(edits, 0, 'world edits cleared');
  assert.equal(mission.state, null, 'old attempt ended before reentry');
  assert.ok(oldActors.every(actor => actor.disposed));
  assert.equal(await pendingStart, true);
  assert.equal(mission.state.phase, 'active');
  assert.equal(mission.state.eliminated, 0);
  assert.equal(mission.state.ready, false);
  assert.ok(mission.actors.every(actor => !actor.body.dead && !oldActors.includes(actor)));
  assert.equal(scene.children.length, 1, 'no old NPC roots survive');
  assert.equal(player.dead, false);
  assert.deepEqual(player.pos.toArray(), [2, 4, 10]);
  assert.deepEqual(looks.at(-1), [map.mission.spawnYaw, 0]);
  assert.equal(entries.at(-1).swoop, 0);
  assert.equal(entries.at(-1).hint, false);
  assert.equal(lifecycle.selectedMode, 'crueltySquad');
  assert.equal(root.hidden, false);
  assert.equal(result.hidden, true, 'result overlay dismissed');
  assert.deepEqual(toolbelt.restricted, ['GUN', 'SMG']);
  assert.equal(toolbelt.selectedKey, 'GUN');
  console.log(`PASS real ${phase} Retry click forwards through POV wire, reloads world and reenters fresh mission`);
}
player.dead = true;
mission.update(0, {});
leave.click();
assert.deepEqual(calls.at(-1), ['mode', 'sandbox']);
assert.equal(lifecycle.selectedMode, 'sandbox');
assert.equal(mission.engaged, false);
assert.equal(root.hidden, true);
assert.equal(scene.children.length, 0);
assert.equal(toolbelt.restricted, null);
assert.equal(toolbelt.selectedKey, 'SHOVEL');
assert.deepEqual(errors, []);
assert.equal(typeof facade.openMap, 'function');
assert.equal(typeof facade.setMode, 'function');
delete globalThis.__retryMakePov;
console.log('PASS Leave click forwards Sandbox transition and cleans mission owners');
console.log('3 mission Retry CPU checks passed (real DOM-helper events; no browser/GPU).');
