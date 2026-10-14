// CPU-only DOM/state regression; layout is checked separately in vehicle-hud-check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVehicleHud } from '../src/pov/vehicles/hud.js';
class Element {
  nodes = new Map(); style = {}; attributes = {}; textContent = ''; hidden = false;
  classes = new Set();
  classList = {
    add: name => this.classes.add(name), remove: name => this.classes.delete(name),
    contains: name => this.classes.has(name),
    toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
  };
  querySelector(selector) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
    return this.nodes.get(selector);
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  append(el) { this.child = el; }
  remove() { this.removed = true; }
}
const timers = new Map(); let nextTimer = 0;
globalThis.setTimeout = (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.document = { body: new Element(), createElement: () => new Element() };
const hud = createVehicleHud(), el = document.body.child;
const node = selector => el.querySelector(selector);
const state = { seated: 'Boat', health: 0.75, kmh: 12.4 };
hud.board('boat'); hud.show(state);
assert(document.body.classList.contains('pov-driving'));
assert.equal(node('.veh-name').textContent, 'Boat');
assert.equal(node('.veh-speed').textContent, '12 km/h');
assert.equal(node('.veh-health').textContent, '75%');
assert.equal(node('.veh-hull i').attributes['aria-valuenow'], '75');
assert.equal(node('.veh-hull s').style.transform, 'scaleX(0.75)');
assert(node('.veh-boost').hidden);
assert(node('.veh-warning').hidden);
assert.match(el.innerHTML, /Hull health/);
assert.match(el.innerHTML, /<kbd>E<\/kbd> Get out/);
assert(!node('.veh-keys').textContent.includes('water'));
assert(!node('.veh-keys').textContent.includes('boost'));
assert(node('.veh-help').classList.contains('on'));
const timer = [...timers.values()][0]; assert.equal(timer.ms, 5000); timer.fn();
assert(!node('.veh-help').classList.contains('on'));
assert(node('.veh-panel').classList.contains('on'), 'readout persists after lesson fades');
hud.show({ ...state, needsWater: true, health: 0.2 });
assert(!node('.veh-warning').hidden);
assert(node('.veh-hull s').classList.contains('low'));
hud.show({ ...state, needsWater: false }); assert(node('.veh-warning').hidden);
hud.board('jeep'); hud.show({ ...state, seated: 'Jeep', health: 1.5, boost: 0.6 });
assert.equal(timers.size, 1, 'new boarding restarts one timer');
assert(!node('.veh-boost').hidden);
assert.equal(node('.veh-boost i').attributes['aria-valuenow'], '60');
assert.equal(node('.veh-boost s').style.transform, 'scaleX(0.6)');
assert.equal(node('.veh-health').textContent, '100%');
assert.match(node('.veh-keys').textContent, /Space brake.*Shift boost/);
hud.leave();
assert(!document.body.classList.contains('pov-driving'));
assert(!el.classList.contains('on'));
assert.equal(timers.size, 0);
hud.show({ prompt: 'Drive the boat' });
assert(node('.veh-prompt').classList.contains('on'));
assert(!node('.veh-panel').classList.contains('on'));
hud.board('hoverbike'); hud.show({ ...state, seated: 'Hoverbike', boost: 1 });
assert.match(node('.veh-keys').textContent, /Space hop/);
hud.dispose(); assert(el.removed); assert.equal(timers.size, 0);
assert(!document.body.classList.contains('pov-driving'));
const source = readFileSync(new URL('../src/pov/vehicles/index.js', import.meta.url), 'utf8');
assert(!source.includes('env.hud?.toast'), 'boarding must not emit a scene-covering toast');
assert.match(source, /needsWater: seated.kind === 'boat' && !seated.impl.state.motorWet/);
assert.match(source, /Math.abs\(drive.throttle\) > 0.05 \|\| Math.abs\(seated.impl.speed\) < 0.5/);
assert.match(source, /reset\(player\)[\s\S]*?hud.leave\(\)/);
assert.match(source, /if \(player.dead\) \{ dismount\(player\)/);
console.log('PASS vehicle HUD: labels, speed, hull, supported boost, water warning, 5s help, reboarding, exit/reset/death hooks and disposal');
