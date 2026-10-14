// CPU regression: landings keep the view steady; damage and blasts still shake it.
// Run: node tools/landing-feel-check.mjs
import assert from 'node:assert/strict';
import { createFeel } from '../src/pov/feel.js';
import { povEvents } from '../src/pov/events.js';

const listeners = new Map();
const player = {
  knock: 0,
  pressure: 0,
  on(type, fn) {
    listeners.set(type, fn);
    return () => listeners.delete(type);
  },
};
const feel = createFeel({});
const frame = () => feel.update({ dt: 1 / 60, live: true, eye: { x: 0, y: 0, z: 0 } });
try {
  feel.bindPlayer(player);
  frame();
  for (const speed of [12, 25, 55, 175]) {
    listeners.get('land')?.({ speed });
    for (let i = 0; i < 60; i++) {
      const view = frame();
      assert.equal(feel.trauma, 0, `landing at ${speed} must not shake`);
      for (const angle of Object.values(view)) assert.ok(angle === 0);
    }
  }
  listeners.get('hurt')({ amount: 0.2, cause: 'Shot' });
  frame();
  assert.ok(feel.trauma > 0, 'damage feedback stays intact');
  feel.reset();
  povEvents.emit('blast', { point: { x: 0, y: 0, z: 0 } });
  frame();
  assert.ok(feel.trauma > 0, 'blast feedback stays intact');
  console.log('PASS: landings stay steady; damage and blasts retain feedback');
} finally {
  feel.dispose();
}
