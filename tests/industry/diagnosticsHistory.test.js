import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndustryDiagnostics } from '../../src/industry/diagnostics.js';

const device = { id: 'history-pump', type: 'pump', x: 8, y: 2, z: 8, rotation: 0, powered: true };
for (const [method, field, event] of [
  ['recordTransfer', 'transferHistory', { confirmed: true, count: 3, operation: 'pump-output' }],
  ['recordConfirmation', 'confirmed', { confirmed: true, status: 'physical transition' }],
]) {
  test(`${method} survives the first observation, but not a simulation replacement`, () => {
    let sim = { g: { nx: 32, ny: 32, nz: 32 } };
    const diagnostics = createIndustryDiagnostics({ getSim: () => sim, now: () => 1000 });
    try {
      assert.equal(diagnostics[method](device, event), true);
      assert.deepEqual(diagnostics.snapshot(device)[field], { ...event, observedAt: 1000 });
      sim = { g: { nx: 32, ny: 32, nz: 32 } };
      assert.equal(diagnostics.snapshot(device)[field], null);
      assert.equal(diagnostics[method](device, event), true);
      assert.deepEqual(diagnostics.snapshot(device)[field], { ...event, observedAt: 1000 });
      sim.disposed = true;
      assert.equal(diagnostics[method](device, event), false);
      assert.equal(diagnostics.snapshot(device)[field], null);
      sim = null;
      assert.equal(diagnostics[method](device, event), false);
    } finally { diagnostics.dispose(); }
  });
}
