import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Vector3 } from 'three';

// Execute the actual entry function, not a copied approximation. In particular,
// there is no `driving` global: that name belongs only to the frame updater.
const source = readFileSync(new URL('../../src/pov/index.js', import.meta.url), 'utf8');
const start = source.indexOf('  function useControlAction()');
const end = source.indexOf('  function useVehicle()', start);
assert(start >= 0 && end > start);
function fixture() {
  const sim = {}, calls = [];
  const context = {
    mode: 'on', editing: false, player: { dead: false }, vehicles: { seated: null },
    controlGeneration: 0, networkWarp: 0, Promise,
    ctx: { eye: new Vector3(1, 2, 3), dir: new Vector3(0, 0, -1) },
    app: { getSim: () => sim, useElectronics(...args) { calls.push(args); return { matched: true, ok: true }; } },
    useVehicle() { calls.push('vehicle'); },
    hud: { toast(message) { throw new Error(message); } },
  };
  const run = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return useControlAction; })()`, context);
  return { run, calls, context };
}
test('on-foot E reaches native electronics without frame-local variables', async () => {
  const f = fixture();
  f.run(); await Promise.resolve();
  assert.equal(f.calls.length, 1);
  const [eye, dir, options] = f.calls[0];
  assert.deepEqual(eye.toArray(), [1, 2, 3]);
  assert.notEqual(eye, f.context.ctx.eye);
  assert.notEqual(dir, f.context.ctx.dir);
  assert.equal(options.authority(), true);
  f.context.controlGeneration++;
  assert.equal(options.authority(), false);
});
test('seated E remains vehicle use; dead/editing states cannot activate controls', () => {
  const f = fixture();
  f.context.vehicles.seated = {};
  f.run(); assert.deepEqual(f.calls, ['vehicle']);
  f.context.vehicles.seated = null; f.context.player.dead = true;
  f.run(); assert.equal(f.calls.length, 1);
  f.context.player.dead = false; f.context.editing = true;
  f.run(); assert.equal(f.calls.length, 1);
});
