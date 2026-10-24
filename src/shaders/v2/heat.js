// The heat pass: the faces the block pass leaves outside its cubes this tick trade heat too.
// V1 conducts on every face every step (react.js condFlux, 6 faces, NOMINAL_STEP_RATE steps a
// second). The block pass trades only inside its 2×2×2 cubes, so a face is a partner on half the
// ticks, and a pair that may not overshoot its equilibrium can't carry what V1 moves in two ticks
// when the material conducts as well as metal does: a metal bar's far end warmed at 0.8× V1's.
// This pass runs on the cubes one cell over on every axis (the complementary offset, 1 - P.offset):
// exactly the faces the block pass's cubes cut, after the block pass on even ticks and before its
// support pass on odd ones (src/v2/physics.js), so fewer faces trade twice running. Every face
// then trades once a tick, each V1's tick of conduction for the pair alone (v2/contact.js
// ctFluxTick), which never crosses the pair's equilibrium, so nothing flickers. Conduction only:
// reactions, phases and fire stay the block pass's. Same cube set rule as the block pass (the cubes
// whose upper corner lies in an awake brick, 8 a brick), so each cube runs in one thread.
import { contactWGSL as productionContactWGSL } from './contact.js';
import { contactSubsetWGSL } from './electric.js';
import { v2Head, v2BlockCompactLayout, V2_CONTACT_LAYOUT } from '../v2.js';
import { LAYOUT, gridDims } from '../common.js';
import { fold } from '../../gpu/kernels.js';

const HEAT_ROOTS = ['ctUnpack', 'ctPack', 'ctConduct'];
const MAIN = '@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32)';

export const v2HeatWGSL = (g, contactWGSL = productionContactWGSL) => /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
${contactSubsetWGSL(contactWGSL, HEAT_ROOTS)}
${MAIN} {
  let e = foldId(wg, nwg) * 8u + li / 8u;
  if (e >= useAwake()) { return; }
  let b = atomicLoad(&act2[V2_LIST + e]);
  let j = li % 8u;
  // the block pass's cube origin (shaders/v2.js v2BlockWGSL) at the complementary offset
  let c0 = brickCoord(b) * BS + (vec3i(1) - P.offset) + 2 * vec3i(i32(j & 1u), i32((j >> 1u) & 1u), i32(j >> 2u)) - vec3i(1);
  // a runtime bound, as the block pass's: Metal need not unroll eight copies of the energy helpers
  let count = min(8u, arrayLength(&events));
  var cores: array<vec4u, 8>; var banksIn: array<i32, 8>; var positions: array<vec3i, 8>; var valid: array<bool, 8>;
  var still = true;
  for (var i = 0u; i < count; i++) {
    let p = mEdge(c0 + vec3i(i32(i & 1u), i32((i >> 1u) & 1u), i32(i >> 2u))); positions[i] = p;
    valid[i] = inGrid(p);
    if (valid[i]) { cores[i] = cellAt(p); banksIn[i] = banks[slotOf(p)]; }
    // one element at one code, no remainders: no face can move anything
    if (!valid[i] || banksIn[i] != 0 || (cores[i].x & 0xffffffu) != (cores[0].x & 0xffffffu)) { still = false; }
  }
  if (still) { return; }
  var cs: array<CTCell, 8>; var moved: array<bool, 8>;
  for (var i = 0u; i < count; i++) { if (valid[i]) { cs[i] = ctUnpack(cores[i], banksIn[i]); } }
  for (var i = 0u; i < count; i++) {
    for (var axis = 0u; axis < 3u; axis++) {
      let k = i ^ (1u << axis); if (k <= i || !valid[i] || !valid[k]) { continue; }
      let heat = ctConduct(cs[i], cs[k], i32(P.ambientHeat));
      if (heat.changed != 0) { cs[i] = heat.a; cs[k] = heat.b; moved[i] = true; moved[k] = true; }
    }
  }
  for (var i = 0u; i < count; i++) {
    if (!moved[i]) { continue; }
    storeMaterial(slotOf(positions[i]), Material(cores[i], banksIn[i]), Material(ctPack(cs[i], cores[i]), cs[i].bank));
    markBusy(positions[i]);
  }
}
`;

// The heat-only pass: the block pass's cubes that classify found heat-only (shaders/v2.js heatOnlyWGSL; v2/contact.js
// contactHeatOnlyCube says why), in its place, as The Powder Toy updates heat apart from its particles' other rules.
// The block pass's own order, seeds and ledger on its cube (contactBlock) less what can't act there: each pair's
// conduction, each cell's phase change (its own step's first rule; the surface count only steam reads), the changes
// still pending on a partner, ambient cooling (v2/contact.js contactHeatOnlyReference). No motion, reaction,
// fire or growth, nor their helpers: a fraction of the block pass's registers and compile.
const HEAT_ONLY_ROOTS = ['ctUnpack', 'ctPack', 'ctConduct', 'ctPhase', 'ctResolvePhase', 'ctAmbient', 'ctEnergy', 'ctPairValue', 'ctRoll', 'ctSeed', 'contactAmbientQ', 'ctPairOrders', 'ctNeighborCount'];
export const v2HeatOnlyWGSL = (g, contactWGSL = productionContactWGSL) => {
  const tail = v2BlockCompactLayout(g);
  return /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
${contactSubsetWGSL(contactWGSL, HEAT_ONLY_ROOTS)}
fn off8(i: u32) -> vec3i { return vec3i(i32(i & 1u), i32(i >> 2u), i32((i >> 1u) & 1u)); }
${MAIN} {
  // the classify kernel's heat-only list, from the list's end (its count published in the header's .w)
  let index = foldId(wg, nwg) * 64u + li;
  if (index >= liquidScratch[${tail.header / 16}u].w) { return; }
  let at = ${tail.capacity - 1}u - index;
  let t = liquidScratch[${tail.list / 16}u + at / 4u][at % 4u];
  let e = t / 8u;
  if (e >= useAwake()) { return; }
  let b = atomicLoad(&act2[V2_LIST + e]);
  let j = t % 8u;
  // the block pass's cube (shaders/v2.js v2BlockWGSL), its corners in its order
  let c0 = brickCoord(b) * BS + P.offset + 2 * vec3i(i32(j & 1u), i32((j >> 1u) & 1u), i32(j >> 2u)) - vec3i(1);
  let down = mDown(vec3f(c0) + 1.0);
  let count = min(8u, arrayLength(&events));
  var cores: array<vec4u, 8>; var banksIn: array<i32, 8>; var positions: array<vec3i, 8>; var cells: array<CTCell, 8>;
  var initial = vec2u(0u);
  for (var i = 0u; i < count; i++) {
    let p = mEdge(c0 + mBlockOffset(off8(i), down)); positions[i] = p;
    cores[i] = cellAt(p); banksIn[i] = banks[slotOf(p)];
    cells[i] = ctUnpack(cores[i], banksIn[i]);
    initial = energyAdd(initial, ctEnergy(cells[i]));
  }
  ctLedgerDeferred = true;
  for (var i = 0u; i < count; i++) {
    for (var axis = 0u; axis < u32(ctNeighborCount()); axis++) {
      let k = i ^ (1u << axis); if (k <= i) { continue; }
      let heat = ctConduct(cells[i], cells[k], i32(P.ambientHeat)); cells[i] = heat.a; cells[k] = heat.b;
    }
  }
  for (var i = 0u; i < count; i++) { cells[i] = ctPhase(cells[i], 0, ctRoll(ctSeed(positions[i], P.tick), 3)); }
  for (var i = 0u; i < count; i++) {
    for (var axis = 0u; axis < u32(ctNeighborCount()); axis++) {
      let k = i ^ (1u << axis); if (k <= i) { continue; }
      var pair = ctPairValue(cells[i], cells[k], 0);
      for (var order = 0u; order < ctPairOrders(); order++) {
        if (pair.changed != 0) { continue; }
        var a = pair.a; var c = pair.b; if (order == 1u) { a = pair.b; c = pair.a; }
        let r = ctResolvePhase(a, c); pair = r; if (order == 1u) { pair = ctPairValue(r.b, r.a, r.changed); }
      }
      cells[i] = pair.a; cells[k] = pair.b;
    }
  }
  var after = vec2u(0u);
  for (var i = 0u; i < count; i++) {
    cells[i] = ctAmbient(cells[i], contactAmbientQ(), i32(P.ambientHeat));
    after = energyAdd(after, ctEnergy(cells[i]));
    let s = slotOf(positions[i]);
    let core = ctPack(cells[i], cores[i]);
    if (cells[i].busy != 0) { markBusy(positions[i]); }
    // (air holds no decoration: the block pass's carry, for a phase change into it)
    if (P.deco != 0u && cid(core) == 0u && decoOf(s) != 0u) { setDeco(s, 0u); }
    storeMaterial(s, Material(cores[i], banksIn[i]), Material(core, cells[i].bank));
    events[s] = u32(cells[i].request); noteEvents(s, events[s]);
  }
  ctLedgerDeferred = false;
  let net = energySub(after, initial);
  if (any(net != vec2u(0u))) { noteEnergySource(positions[0], net); }
}
`;
};

/** The passes' kernels for src/v2/physics.js (built with the contact module they are given), bind family 'contact'. */
export const V2_HEAT_KERNEL = { name: 'v2heat', code: v2HeatWGSL };
export const V2_HEAT_ONLY_KERNEL = { name: 'v2heatOnly', code: v2HeatOnlyWGSL };
/** tools/check-wgsl.mjs, tools/check-sampler-budget.mjs (src/gpu/checks.js). */
export const WGSL_CHECK = [
  { name: 'v2heat', kind: 'compute', code: g => v2HeatWGSL(g), layouts: () => [LAYOUT.TABLES, 'EMPTY', V2_CONTACT_LAYOUT], dispatch: g => fold(Math.ceil(gridDims(g).nbricks / 8)), tool: true },
  { name: 'v2heatOnly', kind: 'compute', code: g => v2HeatOnlyWGSL(g), layouts: () => [LAYOUT.TABLES, 'EMPTY', V2_CONTACT_LAYOUT], dispatch: g => fold(Math.ceil(gridDims(g).nbricks / 8)), tool: true },
];
