// V2 matches V1 for phase-change puffs and blast products. CPU only: no browser, no GPU.
//   1. A boil, sublimation or table phase change puffs V1's own pressure (react.js: water
//      Pr += STEAM_BOIL_PUFF, a table change Pr += puffP(HOT/COLD(id).z), cloud nothing), as the
//      GAS request's puff (contact.js ctPuff), not a flat cell of gas (AIR.gasPressure).
//   2. A charge's products come out at V1's blast.T (react.js T = BLAST(id).y), not near the
//      charge's own temperature.
// The crush rule (react.js crush) has its own check: tools/v2/crush-phase-check.mjs.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { PHYS } from '../../src/physics.js';
import * as C from '../../src/v2/contact.js';
import { dynamicsRows, LEGACY_PRESSURE_PA, EVENT, AIR } from '../../src/v2/dynamics-reference.js';
import { makeMaterial, energyOf, cTq, cid, FULL } from '../../src/v2/layout.js';
import { airborneReference, outsideOf, AIRBORNE, AIRBORNE_LANDED_REQUESTS } from '../../src/v2/airborne.js';
import { particlesWGSL, airborneBase, airbornePuffBase, PARTICLE_CAP } from '../../src/shaders/v2/particles.js';
import { blastsWGSL } from '../../src/shaders/v2/blasts.js';
import { nativeDynamicsHead } from '../../src/shaders/v2.js';
import { gridLayout } from '../../src/sim.js';

let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }
const puffOf = request => Math.floor(request / C.CONTACT_PUFF_UNIT);
// V1 react.js puffP, then pressure.js legacyPressureToPa, capped at P_MAX (react.js clamp).
const v1Pa = volumes => volumes ? Math.max(1, Math.round(Math.min(PHYS.P_MAX, PHYS.STEAM_BOIL_PUFF * volumes / PHYS.STEAM_EXPANSION) * LEGACY_PRESSURE_PA)) : 0;
// A cell at its hot (or cold) change: its whole latent heat banked (phase.js's last code).
function past(id, hot) {
  const r = C.ctRow(id), tq = hot ? r.hotQ : r.coldQ, c0 = C.ctNew(id, tq, 65536);
  const base = BigInt(C.ctCapacity(c0)) * BigInt(tq) + C.ctOffset(c0);
  const latent = BigInt(hot ? r.hotL : r.coldL) * BigInt(C.ctAmount(c0));
  return C.ctSetEnergy(c0, hot ? base + latent : base - latent);
}
const air = () => C.ctNew(E.EMPTY, C.ctRow(E.EMPTY).spawnQ, 65536);
const ns = () => [air(), air(), air()];

test('every phase change puffs V1 pressure: water STEAM_BOIL_PUFF, the table puffP(puff), cloud none', () => {
  for (const e of ELEMENTS) {
    const row = C.CONTACT_ROWS[e.id];
    // react.js: water's own branch adds STEAM_BOIL_PUFF, cloud's adds nothing, the table's puffP(HOT/COLD.z)
    const hot = e.key === 'WATER' ? v1Pa(PHYS.STEAM_EXPANSION) : e.key === 'CLOUD' ? 0 : v1Pa(e.hot?.puff ?? 0);
    assert.equal(row.hotGas, hot, `${e.key} hot`);
    assert.equal(row.coldGas, v1Pa(e.cold?.puff ?? 0), `${e.key} cold`);
  }
  assert.equal(v1Pa(PHYS.STEAM_EXPANSION), Math.round(PHYS.STEAM_BOIL_PUFF * LEGACY_PRESSURE_PA), 'water: STEAM_BOIL_PUFF exactly');
  // The numbers the audit quotes (Pa): each its own, none the flat cell of gas.
  const want = { WATER: 259, MERCURY: 247, DRY_ICE: 130, LIQUID_NITROGEN: 106 };
  for (const [key, pa] of Object.entries(want)) assert.equal(C.CONTACT_ROWS[E[key]].hotGas, pa, key);
  assert.equal(C.CONTACT_ROWS[E.CLOUD].hotGas, 0);
  assert.ok(Math.abs(AIR.gasPressure - 47.85) < 0.01, 'the flat puff these replace');
});

test('a boil or sublimation posts its own puff with the GAS request', () => {
  for (const [key, into] of [['WATER', 'STEAM'], ['MERCURY', 'MERCURY_VAPOR'], ['DRY_ICE', 'CO2'], ['LIQUID_NITROGEN', 'EMPTY'], ['MUD', 'CLAY']]) {
    const out = C.ctStep(past(E[key], true), ns(), 0);
    assert.equal(out.id, E[into], key);
    assert.ok(out.request & EVENT.GAS, `${key}: a GAS request`);
    assert.equal(puffOf(out.request), C.CONTACT_ROWS[E[key]].hotGas, `${key}: V1's puff, not one cell of gas`);
    assert.equal(out.request & EVENT.DETONATE, 0);
  }
  // a weighted product list puffs whichever product it draws (react.js: Pr += on goHot)
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const out = C.ctStep(past(E.SALTWATER, true), ns(), seed);
    assert.notEqual(out.id, E.SALTWATER);
    assert.equal(puffOf(out.request), C.CONTACT_ROWS[E.SALTWATER].hotGas);
  }
});

test('cloud boiling sets no puff (V1 react.js cloud branch), and condensing none', () => {
  const out = C.ctStep(past(E.CLOUD, true), ns(), 0);
  assert.equal(out.id, E.STEAM);
  assert.equal(out.request, 0, 'no GAS request, no puff');
  const wet = C.ctStep(past(E.STEAM, false), ns(), 0);
  assert.notEqual(wet.id, E.STEAM);
  assert.equal(puffOf(wet.request), 0);
});

test('a change waiting on its partner posts the same puff (pendingGas, ctResolvePhase)', () => {
  const waiting = { ...C.ctNew(E.WATER, C.ctRow(E.WATER).hotQ, 65536), pending: E.STEAM, pendingGas: C.CONTACT_ROWS[E.WATER].hotGas, busy: 1 };
  let pair = C.ctResolvePhase(waiting, air());
  assert.ok(pair.changed);
  assert.equal(pair.a.id, E.STEAM);
  assert.ok(pair.a.request & EVENT.GAS);
  assert.equal(puffOf(pair.a.request), 259);
});

test('a cold change with a puff posts it too (react.js puffP(COLD(id).z))', () => {
  const row = C.CONTACT_ROWS[E.STEAM], saved = row.coldGas;
  try {
    row.coldGas = 77;
    const out = C.ctStep(past(E.STEAM, false), [C.ctNew(E.STONE, row.coldQ, 65536), air(), air()], 0);
    assert.equal(out.id, E.WATER);
    assert.ok(out.request & EVENT.GAS);
    assert.equal(puffOf(out.request), 77);
  } finally { row.coldGas = saved; }
});

test('the block pass posts the puff (contactReference: a boiling cell among hot air)', () => {
  const cores = [], banks = new Int32Array(8), hotAir = C.ctNew(E.EMPTY, Math.round((2000 + 273.25) * 4), 65536);
  for (let i = 0; i < 8; i++) {
    const out = C.packContact(i === 0 ? past(E.WATER, true) : hotAir);
    cores.push(out.core); banks[i] = out.bank;
  }
  const out = C.contactReference(cores, banks, 0);
  assert.equal(out.cores[0][0] & 255, E.STEAM);
  assert.ok(out.requests[0] & EVENT.GAS);
  assert.equal(puffOf(out.requests[0]), 259);
});

const g = gridLayout(16, 16, 16);
test('a drop boiling in flight puffs the same (airborne.js: its host posts the puff)', () => {
  // a water drop through flames, a tick at a time, until it boils (tools/v2/airborne-react-check.mjs 2)
  const OPEN = outsideOf(Array.from({ length: 6 }, () => makeMaterial(E.EMPTY, 20, 0).core));
  let p = makeMaterial(E.WATER, 20, FULL / 8), r = null;
  for (let i = 0; i < 600 && cid(p.core) === E.WATER; i++) {
    r = airborneReference(p, makeMaterial(E.FIRE, ELEMENTS[E.FIRE].temp), Math.imul(i + 1, 2654435761) | 0, OPEN);
    if (r.state === AIRBORNE.FLYING) p = r.particle;
  }
  assert.equal(cid(p.core), E.STEAM, 'the drop boils in flight');
  assert.ok(r.requests & EVENT.GAS);
  assert.equal(puffOf(r.requests), 259, 'V1\'s boil puff, not one cell of gas');
  // The GPU twin: dReact keeps the puff above the bits; the react stage posts the bits in the slot
  // word and the puff in its own word; airborneEvents merges them into the host's request.
  const react = particlesWGSL(g, nativeDynamicsHead, 'react');
  assert.ok(react.includes('let puff = max(u32(v.request) / 256u, u32(h.request) / 256u) * 256u;'));
  assert.ok(react.includes(`s|((r.requests&${AIRBORNE_LANDED_REQUESTS}u)<<28u)`));
  assert.ok(react.includes(`atomicStore(&control[${airbornePuffBase(g)}u+t],r.requests/256u);`));
  assert.equal(airbornePuffBase(g), airborneBase(g) + 1 + PARTICLE_CAP);
  const post = blastsWGSL(g, nativeDynamicsHead, 'airborneEvents');
  assert.ok(post.includes(`let puff = atomicExchange(&control[${airbornePuffBase(g)}u + t], 0u);`));
});

test('blast products come out at V1 blast.T (react.js T = BLAST(id).y), the difference declared', () => {
  // The product rows are V1's: each charge's blast.into at its blast.T (gunpowder's flame 2200 °C).
  for (const e of ELEMENTS.filter(e => e.blast && !e.blast.into)) {
    const row = dynamicsRows[e.id];
    assert.equal(row.productT, e.blast.T, e.key);
    const product = makeMaterial(row.product, row.productT, 65536, row.productCtype);
    assert.equal(cTq(product.core), Math.round((e.blast.T + 273.25) * 4), `${e.key}: the product's temperature`);
  }
  assert.equal(dynamicsRows[E.GUNPOWDER].productT, 2200);
  // The product's energy is that product's own (dProduct at productT), not the charge's plus a share.
  const head = blastsWGSL(g, nativeDynamicsHead, 'finish');
  const body = head.slice(head.indexOf('fn dProductEnergy('), head.indexOf('fn dShielded('));
  assert.match(body, /if \(dEvaporates\(m\)\) \{ return energyOf\(dCarrier\(m\)\); \}\n  return energyOf\(dProduct\(m\)\);\n\}/);
  assert.ok(!/energyAdd\(energyOf\(m\)/.test(body), 'not the charge\'s energy plus a quarter of the blast');
  // Old rule, for scale: the charge's energy plus a quarter of the scaled chemical energy leaves
  // gunpowder's FIRE within a few degrees of the charge, far from 2200 °C.
  const charge = makeMaterial(E.GUNPOWDER, ELEMENTS[E.GUNPOWDER].ignite, 65536, 0);
  const nativePerJ = 16777216 / (1000 * 0.3 ** 3 * 4184);
  assert.ok(energyOf(charge) + BigInt(Math.round(dynamicsRows[E.GUNPOWDER].energy * 0.25 * nativePerJ)) < energyOf(makeMaterial(E.FIRE, 2200, 65536, 0)));
  // Both finishing stages note the signed difference (a charge hotter than blast.T is a sink).
  for (const stage of ['finish', 'finishCharges']) {
    const code = blastsWGSL(g, nativeDynamicsHead, stage);
    assert.ok(code.includes('dNoteEnergyChange(cellOf(s),energyOf(before),productEnergy);'), stage);
    assert.ok(!code.includes('noteEnergySource(cellOf(s),energySub(productEnergy,energyOf(before)));'), `${stage}: unsigned source`);
  }
  assert.match(blastsWGSL(g, nativeDynamicsHead, 'finish'), /fn dNoteEnergyChange\(p: vec3i, before: vec2u, after: vec2u\) \{\n  let gained=energySub\(after,before\);\n  if \(\(gained\.y&0x80000000u\)==0u\) \{ if \(any\(gained!=vec2u\(0u\)\)\) \{ noteEnergySource\(p,gained\); \} \}\n  else \{ noteEnergySink\(p,energyNeg\(gained\)\); \}/);
});

console.log(`${checks} phase-puff and blast-product CPU groups passed; no GPU launched`);
