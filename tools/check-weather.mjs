import assert from 'node:assert/strict';
import { createWeather, WEATHER_STEPS_PER_SECOND } from '../src/weather.js';

const checks = [];
function test(name, fn) { checks.push([name, fn]); }
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('clear defaults never schedule weather', () => {
  const w = createWeather();
  assert.equal(WEATHER_STEPS_PER_SECOND, 240);
  assert.deepEqual(w.state, { preset: 'clear', cloud: 0, rain: 0, storm: 0, wind: [0.8, 0.6], time: 0 });
  w.update(100000);
  assert.equal(w.state.preset, 'clear');
  assert.equal(w.active, false);
  assert.equal(w.version, 0); // an idle clear sky does not force redraws
});

// Sea fog, ocean chop and tsunamis were removed (user request, 2026-10-20): no
// control, state or event of theirs may come back through the weather API.
test('no sea fog, ocean chop or tsunami controls', () => {
  const w = createWeather();
  for (const name of ['setFog', 'setOcean', 'tsunami', 'triggerTsunami', 'cancelTsunami', 'finishTsunami', 'setTsunamiHooks', 'setOceanEligible'])
    assert.equal(name in w, false, `${name} is gone`);
  assert.deepEqual(w.selection, { preset: 'clear' });
  for (const preset of ['clear', 'overcast', 'rain', 'storm']) {
    w.setPreset(preset); w.update(w.state.time + 600);
    assert.deepEqual(Object.keys(w.state).sort(), ['cloud', 'preset', 'rain', 'storm', 'time', 'wind']);
  }
});

test('presets approach deterministically and hold without a timer', () => {
  const w = createWeather();
  const state = w.state;
  w.setPreset('storm');
  assert.equal(w.state.rain, 0);
  w.update(1);
  assert.ok(w.state.rain > 0 && w.state.rain < 1);
  assert.ok(w.state.cloud > 0 && w.state.cloud < 1);
  w.update(600);
  assert.deepEqual([w.state.cloud, w.state.rain, w.state.storm], [1, 1, 1]);
  w.update(100000);
  assert.equal(w.state, state); // renderer references remain valid
  assert.equal(w.state.preset, 'storm');
  assert.equal(w.state.storm, 1);
});

test('overcast and rain do not imply thunder', () => {
  const w = createWeather();
  w.setPreset('overcast'); w.update(600);
  assert.equal(w.state.cloud, 0.65);
  assert.equal(w.state.rain, 0);
  assert.equal(w.state.storm, 0);
  w.setPreset('rain'); w.update(1200);
  assert.equal(w.state.rain, 0.65);
  assert.equal(w.state.storm, 0);
});

test('easing is independent of update partitioning', () => {
  const a = createWeather(), b = createWeather();
  for (const w of [a, b]) w.setPreset('storm');
  a.update(10);
  for (let i = 1; i <= 2400; i++) b.update(i / WEATHER_STEPS_PER_SECOND);
  for (const key of ['cloud', 'rain', 'storm', 'time']) close(a.state[key], b.state[key]);
});

test('pause and repeated preset input do not advance or restart transitions', () => {
  const w = createWeather();
  w.setPreset('rain'); w.update(2);
  const snapshot = JSON.stringify(w.state), version = w.version;
  for (let i = 0; i < 20; i++) { w.update(2); assert.equal(w.setPreset('rain'), false); }
  assert.equal(JSON.stringify(w.state), snapshot);
  assert.equal(w.version, version);
  w.update(0); // clock rewind rebases without reverse time or a jump
  assert.equal(JSON.stringify(w.state), snapshot);
  w.update(1);
  assert.equal(w.state.time, 3);
});

test('Clear immediately stops sources; existing matter belongs to physics', () => {
  const w = createWeather();
  w.setPreset('storm'); w.update(600);
  assert.equal(w.setPreset('clear'), true);
  assert.equal(w.state.rain, 0);
  assert.deepEqual(w.selection, { preset: 'clear' });
  w.update(1200);
  assert.equal(w.active, false);
  for (const key of ['cloud', 'rain', 'storm']) assert.equal(w.state[key], 0);
  assert.equal(w.setPreset('clear'), false); // a repeated Clear does nothing
});

test('reset is immediate and rebases time', () => {
  const w = createWeather();
  w.setPreset('storm'); w.update(30);
  w.reset();
  assert.equal(w.state.time, 0);
  assert.equal(w.active, false);
  assert.deepEqual(w.selection, { preset: 'clear' });
  w.update(31); assert.equal(w.state.time, 1);
  w.reset(0); w.update(1); assert.equal(w.state.time, 1);
});

test('invalid input leaves state untouched', () => {
  const w = createWeather();
  const initial = JSON.stringify(w.state);
  for (const value of ['bad', '__proto__', 'toString', null]) assert.throws(() => w.setPreset(value), RangeError);
  for (const value of [-1, NaN, Infinity, '1']) {
    assert.throws(() => w.update(value), RangeError);
    assert.throws(() => w.reset(value), RangeError);
  }
  assert.equal(JSON.stringify(w.state), initial);
});

test('disposal stops notifications and input', () => {
  const w = createWeather();
  let notifications = 0;
  const unsubscribe = w.subscribe(() => { notifications++; });
  w.setPreset('rain');
  assert.equal(notifications, 1);
  w.dispose(); w.dispose();
  assert.equal(w.setPreset('storm'), false);
  assert.equal(w.reset(), false);
  w.update(500);
  assert.equal(notifications, 1);
  unsubscribe();
});

for (const [name, fn] of checks) { await fn(); console.log(`PASS ${name}`); }
console.log(`Weather: ${checks.length} checks passed (CPU only).`);
