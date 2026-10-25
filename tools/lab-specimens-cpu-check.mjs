import test from 'node:test';
import assert from 'node:assert/strict';
import { E, ELEMENTS, K } from '../src/elements.js';
import { createExhibitCatalog } from '../src/lab/catalog.js';
import { specimenPlan } from '../src/lab/specimens.js';
import { buildArchive } from '../src/lab/preservation/archive.js';
import { ctNew, ctStep, ctAcid, ctCloneable, ctDrain, CONTACT_ROWS } from '../src/v2/contact.js';

const catalog = createExhibitCatalog();
const cell = id => ctNew(id, CONTACT_ROWS[id].spawnQ, 65536);

test('only the unstable singularity and non-material effects have no specimen recipe', () => {
  assert.deepEqual(catalog.filter(e => specimenPlan(e).mode === 'none').map(e => e.key),
    ['SINGULARITY', 'PHOTON', 'NEUTRON', 'SPARK']);
  assert.equal(specimenPlan(catalog.find(e => e.key === 'ANTIMATTER')).mode, 'cup');
  for (const key of ['ACID', 'NITRO', 'VOID', 'CLONE', 'MOSS', 'URANIUM']) {
    assert.equal(specimenPlan(catalog.find(e => e.key === key)).mode, 'sample');
  }
});

test('actual static fixture neighbors do not eat acid or program dormant clones', () => {
  const archive = buildArchive({ box() {} });
  for (const key of ['ACID', 'CLONE', 'PCLN', 'TNT', 'NITRO', 'PLANT', 'MOSS', 'FUNGUS', 'VOID', 'URANIUM']) {
    const stock = archive.stocks.find(e => e.key === key), [x, y, z] = stock.bounds;
    const cells = new Map(), pos = [x + 2, y + 1, z + 2];
    buildArchive({ box(x0, y0, z0, x1, y1, z1, id) {
      for (const p of [pos, ...[[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]
        .map(d => pos.map((v, i) => v + d[i]))]) {
        if (p[0] >= x0 && p[0] < x1 && p[1] >= y0 && p[1] < y1 && p[2] >= z0 && p[2] < z1) cells.set(p.join(), cell(id));
      }
    } });
    const faces = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]
      .map(d => cells.get(pos.map((v, i) => v + d[i]).join()));
    let sample = cells.get(pos.join());
    for (let tick = 0; tick < 1000; tick++) {
      sample = ctStep(sample, tick % 2 ? faces.slice(0, 3) : faces.slice(3), tick * 101);
      for (const neighbor of faces) sample = ctAcid(sample, neighbor, tick * 131).a;
      assert.equal(sample.id, E[key], key);
    }
    if (key === 'ACID') assert.equal(sample.life, cell(E.ACID).life);
    if (key === 'CLONE' || key === 'PCLN') {
      assert.equal(sample.ctype, 0);
      assert(faces.every(n => !ctCloneable(n.id)));
    }
  }
});

test('native clone rules replace exhausted short-lived samples at their own spawn state', () => {
  for (const key of ['SMOKE', 'FIRE', 'PLASMA']) {
    const source = cell(E.CLONE); source.ctype = E[key];
    const empty = cell(E.EMPTY);
    let sample = empty, births = 0;
    for (let tick = 0; tick < 2000; tick++) {
      const next = ctStep(sample, [source, empty, empty], tick * 101);
      if (sample.id === E.EMPTY && next.id === E[key]) {
        births++;
        assert.equal(next.tq, CONTACT_ROWS[E[key]].spawnQ);
        assert(next.life > 0);
      }
      // A real VOID sink removes mobile products (no custom lifetime reset).
      sample = next.id !== E.EMPTY && next.id !== E[key] ? ctDrain(next, empty.tq) : next;
    }
    assert(births > 5, `${key} was not renewed: ${births}`);
  }
});

test('annihilating grains have proof-material floor and retaining walls, not a glass floor', () => {
  const stock = buildArchive({ box() {} }).stocks.find(s => s.key === 'ANTIMATTER');
  const [x, y, z] = stock.bounds, cells = new Map();
  buildArchive({ box(x0, y0, z0, x1, y1, z1, id) {
    for (let py = Math.max(y0, y); py < Math.min(y1, y + 7); py++)
      for (let pz = Math.max(z0, z); pz < Math.min(z1, z + 6); pz++)
        for (let px = Math.max(x0, x); px < Math.min(x1, x + 7); px++) cells.set([px, py, pz].join(), id);
  } });
  assert.equal(cells.get([x + 3, y + 2, z + 3].join()), E.ANTIMATTER);
  for (const d of [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]]) {
    const id = cells.get([x + 3 + d[0], y + 2 + d[1], z + 3 + d[2]].join());
    assert.equal(id, E.WALL);
    assert(ELEMENTS[id].antimatterProof);
  }
  assert.equal(ELEMENTS[E.ANTIMATTER].kind, K.POWDER);
});
