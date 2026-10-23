// CPU-only: once a big map is on screen, its packing waits for the GPU between
// batches (worldClassify paced). Unpaced, a view round's new demand queued every
// batch at once and frames waited behind seconds of packing (Descent, real Chrome
// 2026-10-22: 1.2 s stalls). A first load stays unpaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worldClassify, WORLD_CLASSIFY_BRICKS, WORLD_LOAD_POOL_HEADROOM } from '../src/wire/worldRender.js';

function fakes() {
  const log = [];
  const gpu = { frame: {}, flush: () => log.push('flush'), device: { queue: { onSubmittedWorkDone: async () => { log.push('wait'); } } } };
  const cells = { recordSourceColumns: () => false, record: () => { log.push('record'); return {}; }, commitAfterSourceFlush: () => {} };
  const reserved = [];
  const atlas = { live: { cell: new Map() }, reserve: (kind, n) => reserved.push([kind, n]), poolUsed: () => 0, pageBudget: null };
  // three cores' worth of bricks per batch limit: several batches
  const n = WORLD_CLASSIFY_BRICKS * 3, ids = new Set(Array.from({ length: n }, (_, i) => i));
  const brick = (i) => [i % 64, Math.floor(i / 64) % 64, Math.floor(i / 4096)];
  return { log, gpu, cells, atlas, ids, brick, reserved };
}

test('paced packing waits for the GPU before every batch after the first; unpaced never does', async () => {
  for (const paced of [true, false]) {
    const f = fakes();
    const packed = await worldClassify(f.gpu, f.cells, f.atlas, f.ids, { fieldTick: 0, paced }, f.brick);
    assert.equal(packed, f.ids.size);
    const records = f.log.filter(e => e === 'record').length, waits = f.log.filter(e => e === 'wait').length;
    assert(records > 1, 'several batches');
    assert.equal(waits, paced ? records - 1 : 0);
    if (paced) for (let i = 1; i < f.log.length; i++) if (f.log[i] === 'record' && f.log.slice(0, i).includes('record')) assert.equal(f.log[i - 1], 'wait', 'a paced batch follows a GPU wait');
  }
});

// A first load reserves headroom behind its loading screen (the pool doubles there,
// not under the first frames); a load on screen reserves its demand; never past the budget.
test('first load reserves pool headroom within the page budget; a paced load reserves its demand', async () => {
  for (const [paced, budget] of [[false, null], [true, null], [false, 7000]]) {
    const f = fakes();f.atlas.pageBudget = budget == null ? null : { cell: budget };
    await worldClassify(f.gpu, f.cells, f.atlas, f.ids, { fieldTick: 0, paced }, f.brick);
    const want = paced ? f.ids.size : Math.min(f.ids.size + Math.ceil(f.ids.size * WORLD_LOAD_POOL_HEADROOM), budget ?? Infinity);
    assert.deepEqual(f.reserved, [['cell', Math.max(f.ids.size, want)]]);
  }
});
