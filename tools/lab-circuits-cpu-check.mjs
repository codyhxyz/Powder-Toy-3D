import test from 'node:test';
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../src/elements.js';
import { BUTTON_HOLD } from '../src/electricity.js';
import { ctNew, ctLife, ctWithLife } from '../src/v2/contact.js';
import { electricGrid, setGridCell, gridCell, electricTick } from '../src/v2/electric.js';
import { controlCell } from '../src/industry/catalog.js';
import { stampControlStations } from '../src/lab/preservation/circuits.js';

const size = [256, 96, 128], key = p => p.join(',');
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function fixture() {
  const cells = new Map(), devices = [{ id: 'pump', type: 'pump', x: 40, y: 6, z: 40, rotation: 0, powered: true }];
  const stations = [
    { id: 'water', at: [16, 2, 20], devices: ['pump'], label: 'WATER' },
    { id: 'wave', at: [72, 2, 80], devices: [], lamps: [[100, 36, 90]], label: 'WAVE', pulse: true },
  ];
  const set = (x, y, z, id, extra) => {
    assert(Number.isInteger(id), `unknown material at ${[x, y, z]}`);
    assert([x, y, z].every((v, i) => Number.isInteger(v) && v >= 0 && v < size[i]));
    cells.set(key([x, y, z]), { id, extra });
  };
  const box = (x0, y0, z0, x1, y1, z1, id) => {
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) set(x, y, z, id);
  };
  return { cells, devices, stations, set, box };
}
// Connectivity only. Electrical timing/eligibility is tested by electricTick.
function connected(cells, start) {
  const seen = new Set([key(start)]), queue = [start];
  const conductors = [E.METAL, E.LAMP, E.BUTTON, E.SWITCH];
  for (let i = 0; i < queue.length; i++) for (const d of FACES) {
    const p = queue[i].map((v, j) => v + d[j]), k = key(p), id = cells.get(k)?.id;
    if (seen.has(k) || !conductors.includes(id) && id !== E.CONTACTOR) continue;
    seen.add(k);
    if (id !== E.CONTACTOR) queue.push(p);
  }
  return seen;
}

test('stations stamp real isolated power paths and native receiver cells', () => {
  const f = fixture(), result = stampControlStations({ ...f, size });
  assert.equal(result.circuits.length, 2);
  const [water, wave] = result.circuits;
  assert.deepEqual(water.inputs, [controlCell(f.devices[0])]);
  assert.equal(f.cells.get(key(water.gate)).id, E.SWITCH);
  assert.equal(f.cells.get(key(wave.gate)).id, E.BUTTON);
  for (const circuit of result.circuits) {
    assert.equal(f.cells.get(key(circuit.supply)).id, E.BATTERY);
    assert.equal(f.cells.get(key(circuit.indicator)).id, E.LAMP);
    assert(circuit.indicator.reduce((sum, v, i) => sum + Math.abs(v - circuit.supply[i]), 0) > 1);
    const seen = connected(f.cells, circuit.gate);
    for (const input of [...circuit.inputs, ...circuit.lamps]) assert(seen.has(key(input)), `unwired ${input}`);
    const other = result.circuits.find(c => c !== circuit);
    assert(!seen.has(key(other.gate)), 'independent controls are shorted');
    assert(result.plaques.every(p => p.text.length <= 80));
  }
});

test('cutting the physical output wire disconnects the indicator and machine', () => {
  const f = fixture(), { circuits: [c] } = stampControlStations({ ...f, size });
  const [x, y, z] = f.stations[0].at;
  f.cells.delete(key([x + 3, y + 3, z + 1]));
  const seen = connected(f.cells, c.gate);
  assert(!seen.has(key(c.indicator)));
  assert(c.inputs.every(p => !seen.has(key(p))));
});

test('unroutable or invalid authored stations are rejected instead of hidden links', () => {
  const f = fixture();
  for (const stations of [
    [{ ...f.stations[0], devices: ['missing'] }],
    [{ ...f.stations[0], at: [-1, 2, 20] }],
    [{ ...f.stations[0], devices: [], lamps: [] }],
    [f.stations[0], { ...f.stations[0] }],
    [{ ...f.stations[0], startStop: 'yes' }],
    [{ ...f.stations[0], startStop: true, pulse: true }],
    [f.stations[0], { ...f.stations[1], at: [19, 2, 20] }],
  ]) assert.throws(() => stampControlStations({ ...f, stations, size }));
});

test('authored start/stop cabinet uses the native powered PSCN/NSCN relay, not a callback', () => {
  const f = fixture(); f.stations[0].startStop = true;
  const { circuits: [c] } = stampControlStations({ ...f, size });
  const g = electricGrid(12, 12, 8), origin = f.stations[0].at;
  const relative = p => p.map((n, i) => n - origin[i]);
  const put = (p, id, life = 0) => setGridCell(g, ...p, ctWithLife(ctNew(id, 1173, 65536), life));
  const read = p => gridCell(g, ...relative(p));
  for (let z = 0; z < 8; z++) for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) put([x, y, z], E.EMPTY);
  for (const [k, cell] of f.cells) {
    const p = relative(k.split(',').map(Number));
    if (p.every((n, i) => n >= 0 && n < [12, 12, 8][i])) put(p, cell.id, cell.extra?.life ?? ELEMENTS[cell.id].life);
  }
  const receiver = [3, 10, 1]; put(receiver, E.CONTACTOR);
  const press = p => setGridCell(g, ...relative(p), ctWithLife(read(p), BUTTON_HOLD));
  let tick = 0;
  const run = n => { for (let i = 0; i < n; i++) electricTick(g, ++tick); };
  const receiving = () => ctLife(gridCell(g, ...receiver)) > 0;
  run(8); assert.equal(ctLife(read(c.gate)), 0); assert.equal(receiving(), false);
  press(c.buttons.start); run(10);
  assert.equal(ctLife(read(c.buttons.start)), 0, 'momentary contact releases');
  assert.equal(ctLife(read(c.gate)), 10, 'native relay remembers START');
  for (let i = 0; i < 20; i++) { run(1); assert(receiving(), 'receiver bridges normal pulse gaps'); }
  put(relative(c.supply), E.EMPTY); run(12);
  assert.equal(ctLife(read(c.gate)), 10, 'command remains ON');
  assert.equal(receiving(), false, 'but disconnected drive power cannot run the machine');
  put(relative(c.supply), E.BATTERY); run(8); assert(receiving());
  press(c.buttons.stop); run(10);
  assert.equal(ctLife(read(c.gate)), 0); assert.equal(receiving(), false);
  press(c.buttons.start); press(c.buttons.stop); run(10);
  assert.equal(ctLife(read(c.gate)), 0, 'NSCN STOP wins over simultaneous START');
  put([1, 5, 1], E.EMPTY); put([0, 2, 1], E.EMPTY);
  press(c.buttons.start); run(10);
  assert.equal(ctLife(read(c.gate)), 0, 'unpowered control contact cannot set the relay');
  assert.equal(receiving(), false);
});
