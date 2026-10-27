import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from '../../src/elements.js';
import { BUTTON_HOLD } from '../../src/electricity.js';
import { createFactoryControlParts, controlPartsBodyWGSL } from '../../src/industry/controlParts.js';
import { withPayload, lifeScale } from '../../src/v2/layout.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
function fake(ready = Promise.resolve()) {
  const requests = [], slots = [];
  const ring = { buffer: {}, next: () => { slots.push(deferred()); return slots.length - 1; }, read: i => slots[i].promise };
  const sim = { origin: { x: 64, y: 0, z: 96 }, g: { nx: 32, ny: 32, nz: 32 }, version: 0,
    L: { TABLES: [], STATE_RW: [] }, tables: {}, bindRW: {}, header: () => ({}), wake() {},
    gpu: { layout: () => ({}), readback: { ring: () => ring }, bindGroup: () => ({}), kernel: () => ({ ready }), flush() {} },
    _dispatch(k, n, args) { requests.push(args.params); } };
  return { sim, requests, answer(i, values) { slots[requests[i].slot].resolve(new Float32Array(values).buffer); } };
}
test('button press, compatible SWCH toggle and mismatched native material rejection', async () => {
  const f = fake(), parts = createFactoryControlParts({ getSim: () => f.sim });
  const press = parts.activate({ x: 2, y: 3, z: 4, material: E.BUTTON }); await tick();
  assert.equal(f.requests[0].material, E.BUTTON); assert.equal(f.requests[0].mode, 1);
  f.answer(0, [1, E.BUTTON, 77, BUTTON_HOLD]);
  assert.deepEqual(await press, { ok: true, reason: '', key: 'BUTTON', material: E.BUTTON,
    x: 2, y: 3, z: 4, pressed: true, life: BUTTON_HOLD });
  const toggle = parts.toggle({ x: 2, y: 3, z: 4, material: E.BUTTON }); await tick();
  assert.equal(f.requests[1].material, E.SWITCH);
  f.answer(1, [1, E.SWITCH, 77, 10]); assert.equal((await toggle).on, true);
  const stale = parts.activate({ x: 2, y: 3, z: 4, material: E.BUTTON }); await tick();
  f.answer(2, [2, E.METAL, 77, 0]); assert.equal((await stale).ok, false);
  for (const material of [E.BATTERY, E.CONTACTOR, E.LAMP]) {
    assert.equal((await parts.activate({ x: 2, y: 3, z: 4, material })).ok, false);
  }
  assert.equal(f.requests.length, 3);
});
test('window moves, authority loss and reset fence writes waiting for readiness', async () => {
  for (const change of ['window', 'authority', 'reset']) {
    const ready = deferred(), f = fake(ready.promise); let allowed = true;
    const parts = createFactoryControlParts({ getSim: () => f.sim, isCurrent: () => allowed });
    const press = parts.activate({ x: 2, y: 3, z: 4, material: E.BUTTON }); await tick();
    if (change === 'window') f.sim.origin.x++;
    if (change === 'authority') allowed = false;
    if (change === 'reset') parts.reset();
    ready.resolve(); assert.equal((await press).ok, false); assert.equal(f.requests.length, 0);
  }
});
test('an unavailable native writer never falls back to legacy state', async () => {
  const f = fake(); f.sim.compact = {};
  const parts = createFactoryControlParts({ getSim: () => f.sim });
  assert.equal((await parts.activate({ x: 2, y: 3, z: 4, material: E.BUTTON })).ok, false); assert.equal(f.requests.length, 0);
});
test('native life merge preserves all unrelated packed words and energy bank', () => {
  for (const id of [E.SWITCH, E.BUTTON]) {
    const before = { core: new Uint32Array([id | (1234 << 8), 0xa5b50000, 0xdeadbeef, 0x12345678]), bank: 12345 };
    const payload = BUTTON_HOLD * lifeScale(id), after = withPayload(before, payload);
    assert.equal(after.core[0], before.core[0]); assert.equal(after.core[2], before.core[2]); assert.equal(after.core[3], before.core[3]);
    assert.equal(after.core[1] >>> 16, before.core[1] >>> 16);
    assert.equal(after.core[1] & 65535, payload); assert.equal(after.bank, before.bank); assert.equal(before.core[1] & 65535, 0);
  }
});
test('control shader checks exact material and changes only contact life', () => {
  const code = controlPartsBodyWGSL();
  assert.match(code, /eid\(a\) == P\.material/); assert.match(code, /P\.material == E_SWITCH \|\| P\.material == E_BUTTON/);
  const action = code.slice(code.indexOf('} else if (P.mode == FACTORY_PART_TOGGLE'));
  assert.match(action, /var outA = a;/); assert.match(action, /writeCell\(P\.at, a, b, fetchF\(P\.at\), outA, b\)/);
  assert.match(action, new RegExp(`outA\\.z = ${BUTTON_HOLD.toFixed(1).replace('.', '\\.')}\\b`));
  assert.doesNotMatch(action, /outA\.[xyw]\s*=|vec4f\(0\.0|withSpark|withCtype/);
});
