import assert from 'node:assert/strict';
import { test } from 'node:test';
import { E, ELEMENTS } from '../src/elements.js';
import { CONDUCTS } from '../src/electricity.js';
import { ctConductsInto } from '../src/v2/contact.js';
import { baseMaterial, controlCell, deviceCell } from '../src/industry/catalog.js';
import { machinePorts } from '../src/industry/physics.js';
import { validateDevices } from '../src/industry/validation.js';
import { hearthRegions, hearthStructureCells } from '../src/industry/hearth.js';
import { pumpStructureCells, pumpBackplateCells, PUMP_BACKPLATE_TAG } from '../src/industry/pumpStructure.js';
import { buildPreservation, PRESERVATION_SIZE } from '../src/lab/preservation/index.js';

const [nx, ny, nz] = PRESERVATION_SIZE;
const cells = new Uint16Array(nx * ny * nz), payloads = new Map();
const slot = ([x, y, z]) => (y * nz + z) * nx + x;
const inside = p => p.length === 3 && p.every((v, i) => Number.isInteger(v) && v >= 0 && v < PRESERVATION_SIZE[i]);
const set = (x, y, z, id, extra) => {
  assert(inside([x, y, z]), `outside map: ${[x, y, z]}`);
  assert(ELEMENTS[id], `unknown material: ${id}`);
  const i = slot([x, y, z]); cells[i] = id;
  if (extra) payloads.set(i, { ...extra }); else payloads.delete(i);
};
const layout = buildPreservation({
  set,
  box(x0, y0, z0, x1, y1, z1, id, extra) {
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) set(x, y, z, id, extra);
  },
});
const idAt = p => cells[slot(p)];
const lifeAt = p => payloads.get(slot(p))?.life ?? ELEMENTS[idAt(p)].life;
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Topology, not a replacement electrical solver. CONTACTORs receive but do
// not transmit; the actual timer/attenuation rules have separate native tests.
function connected(start, cut) {
  const seen = new Set(), queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i], k = slot(p), id = cells[k];
    if (seen.has(k) || k === cut || !(CONDUCTS[id] || id === E.BATTERY || id === E.CONTACTOR)) continue;
    seen.add(k);
    if (id === E.CONTACTOR) continue;
    for (const d of FACES) {
      const q = p.map((v, j) => v + d[j]);
      if (inside(q) && !seen.has(slot(q)) && ctConductsInto(id, idAt(q))) queue.push(q);
    }
  }
  return seen;
}

test('five installations register eighteen native actors exactly once without Factory ownership', () => {
  assert.equal(layout.stations.length, 5);
  assert.equal(layout.devices.length, 18);
  assert.equal(validateDevices(layout.devices, PRESERVATION_SIZE).length, layout.devices.length);
  assert.deepEqual(layout.devices.reduce((counts, d) => {
    counts[d.type] = (counts[d.type] ?? 0) + 1; return counts;
  }, {}), { belt: 7, separator: 1, hearth: 2, pump: 8 });
  const assigned = layout.stations.flatMap(s => s.devices);
  assert.equal(new Set(assigned).size, layout.devices.length);
  assert.deepEqual([...assigned].sort(), layout.devices.map(d => d.id).sort());
});

test('physical decks, full hearth guards and tagged pump backplates survive cable stamping', () => {
  for (const d of layout.devices) {
    const structure = d.type === 'hearth' ? hearthStructureCells(d)
      : d.type === 'pump' ? pumpStructureCells(d)
      : Array.from({ length: 16 }, (_, i) => [d.x + i % 4, d.y, d.z + Math.floor(i / 4)]);
    for (const p of structure) assert.equal(idAt(p), baseMaterial(d.type), `${d.id} structure ${p}`);
    assert.equal(idAt(controlCell(d)), E.CONTACTOR, `${d.id} actual native input`);
    assert.equal(lifeAt(controlCell(d)), 0, 'all drives start without a permit');
    if (d.type === 'pump') for (const p of pumpBackplateCells(d)) assert.equal(lifeAt(p), PUMP_BACKPLATE_TAG);
  }
});

test('all indicators and actual machine inputs are wired to only their own supply', () => {
  for (const c of layout.circuits) {
    const seen = connected(c.gate);
    for (const p of [c.supply, c.indicator, ...c.inputs, ...c.lamps]) assert(seen.has(slot(p)), `${c.id}: disconnected ${p}`);
    assert.equal([...seen].filter(i => cells[i] === E.BATTERY).length, 1, `${c.id}: unintended power source`);
    for (const other of layout.circuits) if (other !== c) {
      for (const p of [other.gate, other.supply, other.indicator, ...other.inputs, ...other.lamps]) {
        assert(!seen.has(slot(p)), `${c.id} shorted to ${other.id} at ${p}`);
      }
    }
    assert.equal(idAt(c.gate), c.id === 'light-wave' ? E.BUTTON : E.SWITCH);
    assert.equal(lifeAt(c.gate), 0);
  }
});

test('cutting each real station output disconnects every downstream actuator and lamp', () => {
  for (const c of layout.circuits) {
    const cut = slot(c.columns[0]);
    assert.equal(cells[cut], E.METAL);
    const upstream = connected(c.gate, cut);
    for (const p of [c.indicator, ...c.inputs, ...c.lamps]) assert(!upstream.has(slot(p)), `${c.id}: bypass at ${p}`);
  }
});

test('eight pump outlets coincide with the next inlets; the last chute drains over the lake', () => {
  const pumps = layout.devices.filter(d => d.type === 'pump');
  for (const [i, d] of pumps.entries()) {
    const ports = machinePorts(d);
    for (const p of ports.inlet) assert.equal(idAt(p), E.WATER, `${d.id}: unprimed inlet ${p}`);
    if (i) assert.deepEqual(machinePorts(pumps[i - 1]).outlet, ports.inlet);
    else assert.equal(idAt([d.x - 5, d.y + 2, d.z - 2]), E.WATER, 'first suction joins the main lake');
  }
  const final = machinePorts(pumps.at(-1)).outlet;
  for (const p of final) assert.equal(idAt(p), E.EMPTY, `blocked final spout: ${p}`);
  const [ox, oy, oz] = [84, 26, 8];
  for (let z = 93; z < 96; z++) {
    assert.equal(idAt([ox + 53, oy + 35, oz + z]), E.EMPTY, 'no west lip on the return');
    assert.equal(idAt([ox + 53, oy + 8, oz + z]), E.WATER, 'return lands in the finite lake');
  }
});

test('both thermal installations begin cold with finite real fuel and visible charge', () => {
  for (const d of layout.devices.filter(d => d.type === 'hearth')) {
    for (const p of hearthRegions(d).fuel) {
      const id = idAt(p);
      assert([E.COAL, E.BROKENCOAL].includes(id));
      if (d.id === 'receiving-coal-hearth') {
        assert.equal(id, E.COAL, 'foundry fuel remains fixed in its six authored positions');
        assert.equal(lifeAt(p), ELEMENTS[E.COAL].life, 'native default fuel; no extended-life map override');
      }
      assert.equal(payloads.get(slot(p))?.temp ?? ELEMENTS[id].temp, 20);
      assert(lifeAt(p) > 0, `${d.id}: finite burnable fuel`);
    }
  }
  const foundry = layout.devices.find(d => d.id === 'receiving-coal-hearth');
  for (const x of [1, 2]) for (const [y, z] of [[1, 2], [7, -9]]) {
    const p = deviceCell(foundry, x, y, z);
    assert.equal(idAt(p), E.NUGGETS, 'two preloaded and two conveyor-fed gold grains');
    assert.equal(payloads.get(slot(p))?.temp ?? ELEMENTS[E.NUGGETS].temp, 20);
  }
  const reaction = layout.devices.find(d => d.id === 'exceptions-reaction-hearth');
  let thermite = 0;
  for (let y = reaction.y + 1; y < reaction.y + 9; y++) for (let x = reaction.x + 1; x < reaction.x + 3; x++) {
    assert.equal(idAt([x, y, reaction.z + 2]), E.THERMITE); thermite++;
  }
  assert.equal(thermite, 16);
  assert.equal(layout.plaques.filter(p => p.elementKey === 'THERMITE').length, 1);
  assert(!layout.stocks.some(s => s.key === 'THERMITE'), 'one primary exhibit, not a redundant case');
});
