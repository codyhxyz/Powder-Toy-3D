// CPU contracts/predictions only: no actual tool placement, heat or Native success.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { E } from '../../src/elements.js';
import { hearthStructureCells } from '../../src/industry/hearth.js';
import { ballRadius, cellsNear, outsideBody, faceNormal } from '../../src/pov/tools/transfer.js';
import { runIndustryLine, purelineDeviceLayout, lineWaterSourceCells } from '../../tools/fixtures/industry-line.js';
import { CHARGE_POSE, FUEL_POSE } from '../../tools/fixtures/industry-loading.js';
import { firstOccupiedRayHit } from '../../tools/fixtures/industry-operator.js';

const source = readFileSync(new URL('../../tools/fixtures/industry-line.js', import.meta.url), 'utf8');

test('invalid SCRAP amounts/combinations reject before any world inspection', async () => {
  const sim = new Proxy({}, { get() { assert.fail('invalid comparison inspected the world'); } });
  for (const scrapCells of [0, 1, 3, 5, -2, 2.5, NaN, Infinity, '2', '4', null, true, {}, []]) {
    await assert.rejects(runIndustryLine({ sim, scrapCells }), /scrapCells must be the integer 2 or 4/);
  }
  for (const options of [
    {}, { operatorMode: 'transfer' }, { operatorMode: 'other' },
    { operatorMode: 'tools', refuelOnce: true },
    { operatorMode: 'tools', refuelOnce: 0 },
    { operatorMode: 'tools', refuelOnce: null },
    { operatorMode: 'tools', refuelOnce: 'false' },
  ]) {
    await assert.rejects(runIndustryLine({ sim, scrapCells: 2, ...options }), /requires operatorMode=tools and refuelOnce=false/);
  }
});

test('valid/default declarations attest the requested count even on an interrupted setup', async () => {
  for (const [options, expected, deviceCount] of [
    [{}, 4, 83],
    [{ scrapCells: 4 }, 4, 83],
    [{ operatorMode: 'tools' }, 4, 89],
    [{ operatorMode: 'tools', refuelOnce: true }, 4, 91],
    [{ operatorMode: 'tools', scrapCells: 2 }, 2, 89],
  ]) {
    let stages = 0;
    const result = await runIndustryLine({
      ...options,
      sim: { g: { nx: 128, ny: 128, nz: 128 }, frame: 0 },
      gpu: { fence: async () => {} },
      stage() { stages++; throw new Error('CPU stop before construction/tool setup'); },
    });
    assert.equal(stages, 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.declaredScrapCells, expected);
    assert.equal(result.observations.declaredScrapCells, expected);
    assert.equal(result.observations.deviceCount, deviceCount);
    assert.equal(result.observations.nativeTicks, 0);
    assert.equal(result.checks.nativeMetalMelt, false);
    assert.equal(Object.hasOwn(result.checks, 'operatorFourCellMeltBatch'), false);
    if (expected === 2) assert.match(result.observations.comparisonScope, /two-SCRAP physical workflow comparison only/);
    else assert.equal(Object.hasOwn(result.observations, 'comparisonScope'), false);
  }
});

test('two-cell comparison retains the ordinary layout, water and supported side-face prediction', async () => {
  assert.equal(purelineDeviceLayout().length, 83);
  const devices = purelineDeviceLayout({ operatorMode: 'tools' });
  assert.equal(devices.length, 89);
  assert.equal(lineWaterSourceCells().length, 120);
  const hearth = devices.find(d => d.type === 'hearth');
  const occupied = new Map(hearthStructureCells(hearth).map(at => [at.join(','), E.TUNGSTEN]));
  const feet = new Vector3(...CHARGE_POSE.feet);
  const eye = feet.clone().add(new Vector3(0, 5, 0));
  const sim = { g: { nx: 128, ny: 128, nz: 128 },
    readCell: async (x, y, z) => [[occupied.get(`${x},${y},${z}`) ?? E.EMPTY, 20, 0, 0]] };
  const hit = await firstOccupiedRayHit({ sim, eye,
    direction: new Vector3(...CHARGE_POSE.target).addScalar(0.5).sub(eye).normalize(),
    deadline: Date.now() + 1000 });
  assert.deepEqual(hit.cell.toArray(), [16, 14, 18]);
  assert.equal(hit.face, 0);
  const normal = faceNormal(hit.face), clear = outsideBody(feet, 0.3);
  const center = hit.cell.clone().addScalar(0.5).addScaledVector(normal, 0.5 + ballRadius(2));
  const offered = cellsNear(center, ballRadius(2 * 2.5), sim.g,
    (x, y, z) => (x - hit.cell.x) * normal.x + (y - hit.cell.y) * normal.y
      + (z - hit.cell.z) * normal.z >= 1 && clear(x, y, z))
    .filter(at => !occupied.has(at.join(','))).slice(0, 2);
  assert.equal(offered.length, 2);
  const chamber = new Set([[17, 14, 18], [18, 14, 18], [17, 14, 17], [18, 14, 17]].map(at => at.join(',')));
  assert(offered.every(at => chamber.has(at.join(','))));
  assert.deepEqual(FUEL_POSE.target, [16, 13, 17]);
});

test('comparison goals remain target-aware without changing transfer/refuel constants', () => {
  assert.match(source, /z < 100 \+ scrapCells \/ 2/);
  assert.match(source, /edit\(\[96, 30, 100\], \[97, 30, 99 \+ scrapCells \/ 2\], E\.SCRAP, 20, scrapLife, 0\.625\)/);
  for (const expression of [
    'scrapTaken.length === scrapCells && chargePut === scrapCells',
    'operatorChargeSnapshots.every(cells => cells.length === scrapCells)',
    'operatorChargeDistribution.length === scrapCells',
    'molten.length === scrapCells && bucketPoured === 0',
    'checks[meltBatchCheck] = false', 'checks[meltBatchCheck] = true',
    'Math.min(scrapCells - bucketPoured, before)',
    'coldShipments.reduce((sum, shipment) => sum + shipment.count, 0) === scrapCells',
    'observations.cargo.bucketCells.length === scrapCells',
    'nativePours.length === scrapCells',
    'observations.operator.actions.every(action => action.completed)',
    'industry.pending === 0 && industry.buffered === 0',
  ]) assert(source.includes(expression), expression);
  assert(!source.includes('checks.operatorFourCellMeltBatch'));
  assert.match(source, /scrapCells === 2 \? 'operatorTwoCellMeltBatch' : 'operatorFourCellMeltBatch'/);
  assert(source.includes('for (const frames of [0, 2, 6])'));
  assert(source.includes('every(cell => cell.at[1] === 13)'));
  assert(source.includes('coalTaken.length === 6 && fuelPut === 6'));
  assert(source.includes('const scrapLoad = new Load(4)'));
  assert(source.includes('refuel.chamberAfter.filter(isCharge).length === 4'));
  assert(source.includes('const MAX_NATIVE_TICKS = 4_800'));
  assert(source.includes('wallsAfter.length === 48'));
  assert(source.includes('pumpPlateEnd.length === 24'));
  assert(source.includes('observations.operator.finalLoads.omittedTransfers === 0'));
  assert(source.includes('transfers.every(r => !r.error && !r.pending)'));
});
