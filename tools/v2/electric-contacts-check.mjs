// CPU only: production gather/commit twin, native save container, shader validation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { E, ELEMENTS, PALETTE } from '../../src/elements.js';
import { ELEC, BUTTON_HOLD, CONTACTOR_HOLD, CONDUCTS, SPARK_BORN, packSpark, takesSpark } from '../../src/electricity.js';
import { ctNew, ctWithLife, ctLife, ctLive, ctElecStep, ctElecApply, CONTACT_CONSTANTS } from '../../src/v2/contact.js';
import { electricGrid, setGridCell, gridCell, electricTick, ELEC_STEPS } from '../../src/v2/electric.js';
import { encodeV2State, decodeV2State, stateLengths } from '../../src/v2/state.js';
import { encodeSave, decodeSave } from '../../src/saves/format.js';
import { materialTags } from '../../src/materialTraits.js';
import { requirementsForTags } from '../../src/lab/catalog.js';
import { wcLifeFull } from '../../src/shaders/world/copy.js';
import { wcWord, wcUnword } from '../../src/shaders/world/cellWord.js';
import { prelude, cellSlot } from '../../src/shaders/common.js';
import { gridLayout } from '../../src/sim.js';
import { assertNaga } from './wgsl-grouping.mjs';
import { WGSL_CHECK as volumeChecks } from '../../src/shaders/render.js';
import { WGSL_CHECK as blockChecks } from '../../src/shaders/blocks.js';

const q = 1173;
function fixture(nx = 12, ny = 4, nz = 4) {
  const g = electricGrid(nx, ny, nz);
  let tick = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) setGridCell(g, x, y, z, ctNew(E.EMPTY, q, 65536));
  return {
    g,
    put(x, id, life = 0, spark = 0) { const c = ctWithLife(ctNew(id, q, 65536), life); c.spark = spark; setGridCell(g, x, 1, 1, c); },
    get: x => gridCell(g, x, 1, 1),
    step(options) { return electricTick(g, ++tick, options); },
  };
}

test('IDs append; timers fit native fields; receiver does not conduct', () => {
  assert.equal(E.BUTTON, E.PLANKS + 1);
  assert.equal(E.CONTACTOR, E.BUTTON + 1);
  assert.equal(BUTTON_HOLD, 15);
  assert.equal(CONTACTOR_HOLD, ELEC.LAMP_HOLD);
  assert(BUTTON_HOLD <= CONTACT_CONSTANTS.CT_ELEC_LIFE_MAX[1]);
  assert.equal(CONDUCTS[E.BUTTON], true);
  assert.equal(CONDUCTS[E.CONTACTOR], false);
  assert.equal(takesSpark(E.BUTTON, 0), false);
  assert.equal(takesSpark(E.BUTTON, BUTTON_HOLD), true);
  assert.equal(takesSpark(E.CONTACTOR, CONTACTOR_HOLD), false);
  for (const key of ['BUTTON', 'CONTACTOR']) assert(PALETTE.find(p => p.name === 'Electronics').items.includes(key));
  const tags = materialTags(ELEMENTS[E.CONTACTOR]);
  assert(tags.includes('electrical-receiver') && !tags.includes('conductive'));
  assert(requirementsForTags(tags).includes('electrical-isolation'));
});

test('an unpowered press creates no spark, heat source, or downstream supply', () => {
  const f = fixture();
  f.put(4, E.BUTTON, BUTTON_HOLD); f.put(5, E.METAL); f.put(6, E.CONTACTOR);
  for (let t = 0; t < 8; t++) {
    assert.equal(f.step().source, 0n);
    assert.equal(f.get(4).spark, 0); assert.equal(f.get(5).spark, 0);
    assert.equal(ctLife(f.get(6)), 0);
  }
  assert.equal(ctLife(f.get(4)), 0);
});

test('pressed powered contact crosses a brick boundary; an open contact blocks it', () => {
  const f = fixture(); f.put(2, E.BATTERY); f.put(3, E.BUTTON); f.put(4, E.METAL); f.put(5, E.CONTACTOR);
  f.step(); assert.equal(f.get(4).spark, 0); assert.equal(ctLife(f.get(5)), 0);
  f.put(3, E.BUTTON, BUTTON_HOLD);
  const out = f.step({ awake: [0] });
  assert(out.busy.has(1));
  assert(ctLive(f.get(4)));
  assert.equal(ctLife(f.get(5)), CONTACTOR_HOLD);
  assert.equal(out.source, 0n);
});

test('button releases after 15 electrical steps and clears its residual spark', () => {
  const f = fixture(); f.put(2, E.BATTERY); f.put(3, E.BUTTON, BUTTON_HOLD); f.put(4, E.METAL);
  for (let n = 1; n <= 4; n++) {
    f.step(); assert.equal(ctLife(f.get(3)), Math.max(0, BUTTON_HOLD - n * ELEC_STEPS));
  }
  assert.equal(f.get(3).spark, 0);
  for (let n = 0; n < 8; n++) f.step();
  assert.equal(f.get(3).spark, 0); assert.equal(f.get(4).spark, 0);
  const empty = ctNew(E.EMPTY, q, 65536), ns = Array.from({ length: 6 }, () => empty);
  let c = ctWithLife(ctNew(E.BUTTON, q, 65536), 3);
  c.spark = packSpark(SPARK_BORN, ELEC.SPARK_V);
  for (let life = 2; life >= 0; life--) {
    c = ctElecApply(c, ctElecStep(c, ns, 0.5), 1); assert.equal(ctLife(c), life);
  }
  assert.equal(c.spark, 0);
});

test('contactor bridges spark gaps and expires after supply is disconnected', () => {
  const f = fixture(); f.put(2, E.BATTERY); f.put(3, E.METAL); f.put(4, E.CONTACTOR);
  for (let t = 0; t < 24; t++) {
    assert.equal(f.step().source, 0n);
    assert(ctLife(f.get(4)) > 0);
    assert.equal(f.get(4).spark, 0);
  }
  f.put(3, E.EMPTY); for (let t = 0; t < 3; t++) f.step();
  assert.equal(ctLife(f.get(4)), 0);
  f.put(3, E.BATTERY); f.step(); assert.equal(ctLife(f.get(4)), CONTACTOR_HOLD);
  f.put(3, E.EMPTY); f.step(); assert.equal(ctLife(f.get(4)), CONTACTOR_HOLD - ELEC_STEPS);
  f.step(); assert.equal(ctLife(f.get(4)), 0);
});

test('receivers do not backfeed; unpowered latches and bare sensors are not supply', () => {
  const f = fixture(); f.put(2, E.CONTACTOR, CONTACTOR_HOLD); f.put(3, E.METAL); f.put(1, E.CONTACTOR);
  f.put(6, E.SWITCH, ELEC.SWITCH_ON); f.put(7, E.CONTACTOR); f.put(9, E.TSNS, ELEC.TSNS_FIRE); f.put(10, E.CONTACTOR);
  for (let t = 0; t < 5; t++) {
    assert.equal(f.step().source, 0n);
    assert.equal(f.get(3).spark, 0); assert.equal(ctLife(f.get(1)), 0);
    assert.equal(ctLife(f.get(7)), 0); assert.equal(ctLife(f.get(10)), 0);
  }
  assert.equal(ctLife(f.get(2)), 0);
});

test('native savepack preserves timer, spark, receiver bank, and exact continuation', async () => {
  const f = fixture(16, 8, 8);
  f.put(0, E.BUTTON, 11, packSpark(SPARK_BORN - 1, ELEC.SPARK_V));
  f.put(1, E.CONTACTOR, 7); f.put(2, E.SWITCH, ELEC.SWITCH_ON);
  f.g.banks[20] = -123;
  const state = { dims: [16, 8, 8], mode: 'v2', tick: 9, frame: 9, paints: 1, acc: 0.25, certified: false, writtenSinceTick: true };
  for (const [key, n] of Object.entries(stateLengths(state.dims, true))) state[key] = new Uint32Array(n);
  const layout = gridLayout(...state.dims);
  for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {
    const i = x + 16 * (y + 8 * z), slot = cellSlot(layout, x, y, z);
    state.cells.set(f.g.cores.subarray(i * 4, i * 4 + 4), slot * 4); state.aux[slot] = f.g.banks[i];
  }
  const packed = await encodeSave({ name: 'native contacts' }, [{ key: 'physicsV2', data: encodeV2State(state) }]);
  const saved = decodeV2State((await decodeSave(packed)).sections.get('physicsV2'), state.dims);
  assert.deepEqual(saved.cells, state.cells); assert.deepEqual(saved.aux, state.aux);
  const g = electricGrid(...state.dims);
  for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {
    const i = x + 16 * (y + 8 * z), slot = cellSlot(layout, x, y, z);
    g.cores.set(saved.cells.subarray(slot * 4, slot * 4 + 4), i * 4); g.banks[i] = saved.aux[slot] | 0;
  }
  assert.equal(ctLife(gridCell(g, 0, 1, 1)), 11); assert.equal(ctLife(gridCell(g, 1, 1, 1)), 7);
  for (let tick = 10; tick < 16; tick++) {
    assert.deepEqual(electricTick(g, tick), electricTick(f.g, tick));
    assert.deepEqual(g.cores, f.g.cores); assert.deepEqual(g.banks, f.g.banks);
  }
});

test('World visual life and activity retain the final timer step', () => {
  for (const [id, hold] of [[E.BUTTON, BUTTON_HOLD], [E.CONTACTOR, CONTACTOR_HOLD]]) {
    assert.equal(wcLifeFull(id), hold);
    assert(wcUnword(wcWord(id, 0, 20, 1 / hold)).aux > 0);
  }
  const code = prelude(gridLayout(16, 8, 8), { state: false });
  assert.match(code, /id == E_BUTTON \|\| id == E_CONTACTOR/);
  assertNaga(code + '\n@compute @workgroup_size(1) fn main() { let a=vec4f(f32(E_BUTTON),20.0,1.0,0.0); let quiet=electricQuiet(E_BUTTON,a); let life=electricContactLife(E_CONTACTOR,0.0,true); }', 'shared activity');
});

test('mechanical contact state compiles in every material view', () => {
  const layout = gridLayout(16, 8, 8);
  assertNaga(blockChecks().find(k => k.name === 'blocks.opaque').code(layout), 'plain contacts');
  for (const view of ['realistic', 'cozy', 'noita']) {
    const k = volumeChecks().find(k => k.name === `volume.${view}.off`);
    assert(k);
    assertNaga(k.code(layout), `${view} contacts`);
  }
});
