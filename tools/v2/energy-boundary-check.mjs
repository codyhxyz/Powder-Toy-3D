// CPU-only regressions for real native admission helpers and save bookkeeping.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { PHASE_ROWS, PHASE_HOT_BASE, PHASE_COLD_BASE, PHASE_STEPS } from '../../src/v2/phase.js';
import {
  FULL, MAX_FILL, AIR_CAPACITY_Q, makeMaterial, withEnergy, energyOf,
  cTq, cFill, energyBounds, energyPacketFits, share, advectReference, isLiquid,
} from '../../src/v2/layout.js';
import { encodeV2State, decodeV2State, stateLengths } from '../../src/v2/state.js';
import { v2ActLayout } from '../../src/shaders/v2.js';

for (const [sourceT, receiverT, latent] of [[20, 100, 10000n], [100, 0, -10000n]]) {
  const source = makeMaterial(E.WATER, sourceT);
  const base = makeMaterial(E.WATER, receiverT);
  const receiver = withEnergy(base, energyOf(base) + latent);
  const packet = share(energyOf(source) - BigInt(AIR_CAPACITY_Q * cTq(source.core)), 0, 1000, FULL);
  assert(energyPacketFits(source, receiver, packet, 1000), 'ordinary mixing must not be dammed by a latent tag');
  const result = advectReference([source, receiver], [{ from: 0, to: 1, amount: 1000 }], true);
  assert.equal(cFill(result[0].core), FULL - 1000);
  assert.equal(cFill(result[1].core), FULL + 1000);
  assert.equal(result.reduce((sum, m) => sum + energyOf(m), 0n), energyOf(source) + energyOf(receiver));
}

// Admission's affine range must really contain the phase encodings, including
// full compression. A new material table must not invalidate this proof silently.
for (const element of ELEMENTS.filter(e => isLiquid(e.id))) {
  const row = PHASE_ROWS[element.id];
  for (const amount of [1, FULL, MAX_FILL]) {
    const material = makeMaterial(element.id, 20, amount);
    const bounds = energyBounds(material.core, amount);
    for (const [base, latent] of [[PHASE_HOT_BASE, row.hotLatent], [PHASE_COLD_BASE, row.coldLatent]]) {
      if (!latent) continue;
      for (const progress of [0, PHASE_STEPS]) {
        const core = new Uint32Array(material.core);
        core[0] = (core[0] & 0xff0000ff) | ((base + progress) << 8);
        const energy = energyOf({ core, bank: 0 });
        assert(energy >= bounds.lo && energy <= bounds.hi, `${element.key}: phase outside admission interval`);
      }
    }
  }
}

const dims = [32, 32, 32], lengths = stateLengths(dims, true);
const layout = v2ActLayout({ nx: 32, ny: 32, nz: 32 });
const snapshot = {
  dims, tick: 9, acc: 0, frame: 9, paints: 0, certified: false, writtenSinceTick: false, mode: 'v2',
  ...Object.fromEntries(Object.entries(lengths).map(([name, n]) => [name, new Uint32Array(n)])),
};
snapshot.activity.set([0xffffffff, 0xffffffff, 3], layout.energySource);
snapshot.activity.set([13, 2, 1], layout.energySink);
assert.deepEqual(decodeV2State(encodeV2State(snapshot)).activity, snapshot.activity, '96-bit ledgers survive saves');

// Reconstruct the actual pre-ledger version-2 wire format, not an encoder mock.
const oldArrays = {
  cells: snapshot.cells, activity: snapshot.activity.subarray(0, -6),
  args: snapshot.args, aux: snapshot.aux,
};
const { cells, activity, args, aux, ...oldMeta } = snapshot;
const json = new TextEncoder().encode(JSON.stringify({ ...oldMeta, version: 2, hasAux: true }));
const oldBytes = new Uint8Array(12 + json.length + Object.values(oldArrays).reduce((n, a) => n + a.byteLength, 0));
const view = new DataView(oldBytes.buffer);
view.setUint32(0, 0x32545054, true); view.setUint32(4, 2, true); view.setUint32(8, json.length, true);
oldBytes.set(json, 12);
let offset = 12 + json.length;
for (const array of Object.values(oldArrays)) for (const word of array) { view.setUint32(offset, word, true); offset += 4; }
const restored = decodeV2State(oldBytes);
assert.equal(restored.activity.length, snapshot.activity.length);
assert(restored.activity.subarray(-6).every(word => word === 0), 'old saves start explicit ledgers at zero');
assert.deepEqual(restored.cells, snapshot.cells);
console.log('native energy boundaries: hot/cold admission, phase-range proof, exact ledgers and old-save migration passed');
