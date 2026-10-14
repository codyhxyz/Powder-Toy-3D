import assert from 'node:assert/strict';
import { createWeather, WEATHER_STEPS_PER_SECOND } from '../src/weather.js';

const checks = [];
function test(name, fn) { checks.push([name, fn]); }
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('clear defaults never schedule weather', () => {
  const w = createWeather();
  assert.equal(WEATHER_STEPS_PER_SECOND, 240);
  assert.deepEqual(w.state, { preset: 'clear', cloud: 0, rain: 0, storm: 0, fog: 0, ocean: 0, wind: [0.8, 0.6], time: 0 });
  w.update(100000);
  assert.equal(w.state.preset, 'clear');
  assert.equal(w.active, false);
  assert.equal(w.version, 0); // an idle clear sky does not force redraws
  assert.deepEqual(w.tsunami, { eligible: false, available: false, active: false, pending: false, error: '' });
});

test('presets approach deterministically and hold without a timer', () => {
  const w = createWeather();
  const state = w.state;
  w.setPreset('storm');
  assert.equal(w.selection.ocean, 'rough');
  assert.equal(w.state.rain, 0);
  w.update(1);
  assert.ok(w.state.rain > 0 && w.state.rain < 1);
  assert.ok(w.state.cloud > 0 && w.state.cloud < 1);
  w.update(600);
  assert.deepEqual([w.state.cloud, w.state.rain, w.state.storm, w.state.ocean], [1, 1, 1, 1]);
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
  assert.equal(w.selection.ocean, 'choppy');
});

test('easing is independent of update partitioning', () => {
  const a = createWeather(), b = createWeather();
  for (const w of [a, b]) { w.setPreset('storm'); w.setFog('thick'); }
  a.update(10);
  for (let i = 1; i <= 2400; i++) b.update(i / WEATHER_STEPS_PER_SECOND);
  for (const key of ['cloud', 'rain', 'storm', 'fog', 'ocean', 'time']) close(a.state[key], b.state[key]);
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

test('independent overrides survive repeated preset input', () => {
  const w = createWeather();
  w.setPreset('storm');
  w.setOcean('calm'); w.setFog('light');
  assert.equal(w.setPreset('storm'), false);
  w.update(600);
  assert.equal(w.state.ocean, 0);
  assert.equal(w.state.fog, 0.35);
  assert.equal(w.state.storm, 1);
  w.setPreset('rain'); // choosing a different preset sets its sea conditions
  assert.equal(w.selection.ocean, 'choppy');
  assert.equal(w.selection.fog, 'light');
  w.setOcean('rough'); w.update(1200);
  assert.equal(w.state.ocean, 1);
  w.setFog('off'); w.update(1800);
  assert.equal(w.state.fog, 0);
});

test('Clear immediately stops sources; existing matter belongs to physics', () => {
  const w = createWeather();
  w.setPreset('storm'); w.setFog('thick'); w.update(600);
  w.setPreset('clear');
  assert.equal(w.state.rain, 0);
  assert.deepEqual(w.selection, { preset: 'clear', fog: 'off', ocean: 'calm' });
  w.update(610);
  assert.equal(w.state.fog, 0);
  assert.equal(w.state.ocean, 0);
  w.update(1200);
  assert.equal(w.active, false);
  for (const key of ['cloud', 'rain', 'storm', 'fog', 'ocean']) assert.equal(w.state[key], 0);
  w.setFog('thick'); w.setOcean('rough');
  assert.equal(w.setPreset('clear'), true); // Clear also clears overrides on a clear sky
  w.update(1800);
  assert.equal(w.active, false);
});

test('reset is immediate, preserves hooks/eligibility, and rebases time', () => {
  const w = createWeather();
  w.setOceanEligible(true);
  w.setTsunamiHooks({ trigger() {}, cancel() {} });
  w.setPreset('storm'); w.setFog('thick'); w.update(30);
  w.reset();
  assert.equal(w.state.time, 0);
  assert.equal(w.active, false);
  assert.deepEqual(w.selection, { preset: 'clear', fog: 'off', ocean: 'calm' });
  assert.deepEqual(w.tsunami, { eligible: true, available: true, active: false, pending: false, error: '' });
  w.update(31); assert.equal(w.state.time, 1);
  w.reset(0); w.update(1); assert.equal(w.state.time, 1);
});

test('invalid input leaves state untouched', () => {
  const w = createWeather();
  const initial = JSON.stringify(w.state);
  for (const value of ['bad', '__proto__', 'toString', null]) {
    assert.throws(() => w.setPreset(value), RangeError);
    assert.throws(() => w.setFog(value), RangeError);
    assert.throws(() => w.setOcean(value), RangeError);
  }
  for (const value of [-1, NaN, Infinity, '1']) {
    assert.throws(() => w.update(value), RangeError);
    assert.throws(() => w.reset(value), RangeError);
  }
  assert.throws(() => w.setTsunamiHooks({ trigger() {} }), TypeError);
  assert.throws(() => w.setTsunamiHooks({ trigger: true, cancel: true }), TypeError);
  assert.equal(JSON.stringify(w.state), initial);
});

test('tsunami requires real hooks and an eligible map; repeated trigger is guarded', async () => {
  const w = createWeather();
  let starts = 0, stops = 0;
  assert.equal(await w.triggerTsunami(), false);
  w.setOceanEligible(true);
  assert.equal(await w.triggerTsunami(), false);
  w.setTsunamiHooks({ async trigger() { starts++; assert.equal(await w.triggerTsunami(), false); return true; }, cancel() { stops++; } });
  w.setOceanEligible(false);
  assert.equal(await w.triggerTsunami(), false);
  w.setOceanEligible(true);
  assert.equal(await w.triggerTsunami(), true);
  assert.equal(await w.triggerTsunami(), false);
  assert.equal(starts, 1);
  assert.equal(w.cancelTsunami(), true);
  assert.equal(w.cancelTsunami(), false);
  assert.equal(stops, 1);
  await w.triggerTsunami();
  assert.equal(w.finishTsunami(), true);
  assert.equal(w.finishTsunami(), false);
  assert.equal(stops, 1); // natural completion does not cancel a finished event
  await w.triggerTsunami(); w.setOceanEligible(false);
  assert.equal(stops, 2);
  assert.equal(w.tsunami.active, false);
});

test('failed event starts do not leave a stuck active flag', async () => {
  const w = createWeather();
  w.setOceanEligible(true);
  w.setTsunamiHooks({ trigger: () => false, cancel() {} });
  assert.equal(await w.triggerTsunami(), false);
  assert.equal(w.tsunami.active, false);
  w.setTsunamiHooks({ trigger() { throw new Error('not ready'); }, cancel() {} });
  await assert.rejects(w.triggerTsunami(), /not ready/);
  assert.equal(w.tsunami.active, false);
});

test('reset, hook replacement and disposal cancel active events exactly once', async () => {
  const w = createWeather();
  let starts = 0, stops = 0, notifications = 0;
  const hooks = { trigger: () => { starts++; return true; }, cancel: () => { stops++; } };
  const unsubscribe = w.subscribe(() => { notifications++; });
  w.setTsunamiHooks(hooks); w.setOceanEligible(true);
  await w.triggerTsunami(); w.reset();
  assert.equal(stops, 1);
  await w.triggerTsunami(); w.setTsunamiHooks(hooks);
  assert.equal(stops, 2);
  await w.triggerTsunami(); w.dispose(); w.dispose();
  assert.equal(stops, 3);
  assert.equal(starts, 3);
  const count = notifications;
  assert.equal(await w.triggerTsunami(), false);
  assert.equal(w.setPreset('storm'), false);
  assert.equal(w.reset(), false);
  w.update(500);
  assert.equal(notifications, count);
  unsubscribe();
});

test('cancelled readbacks cannot reactivate after clear, reset, map change or dispose', async () => {
  for (const stop of [w => w.cancelTsunami(), w => w.setPreset('clear'), w => w.reset(),
    w => w.setOceanEligible(false), w => w.dispose(), w => w.setTsunamiHooks()]) {
    const w = createWeather(); let resolve, cancels = 0;
    w.setOceanEligible(true);
    w.setTsunamiHooks({ trigger: () => new Promise(r => { resolve = r; }), cancel: () => { cancels++; } });
    const pending = w.triggerTsunami();
    assert.equal(w.tsunami.pending, true); assert.equal(w.tsunami.active, false);
    assert.equal(await w.triggerTsunami(), false);
    stop(w); resolve(true);
    assert.equal(await pending, false);
    assert.equal(w.tsunami.active, false); assert.equal(w.tsunami.pending, false);
    assert.equal(cancels, 1);
  }
});

test('a late cancelled result cannot cancel a newer active event', async () => {
  const w = createWeather(); let oldResolve, cancels = 0;
  w.setOceanEligible(true);
  w.setTsunamiHooks({ trigger: () => new Promise(r => { oldResolve = r; }), cancel: () => { cancels++; } });
  const old = w.triggerTsunami();
  w.setTsunamiHooks({ trigger: async () => true, cancel: () => { cancels++; } });
  assert.equal(await w.triggerTsunami(), true);
  oldResolve(true); assert.equal(await old, false);
  assert.equal(w.tsunami.active, true); assert.equal(cancels, 1);
});

for (const [name, fn] of checks) { await fn(); console.log(`PASS ${name}`); }
console.log(`Weather: ${checks.length} checks passed (CPU only).`);
