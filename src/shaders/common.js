import { compactDecodeWGSL } from './compact.js';
import { LEGACY_PRESSURE_PA } from '../v2/pressure.js';
import { elementsGLSL, ELEMENTS, ELEMENT_FIELDS, RXDEF_FIELDS, K, REACTIONS, mechanismTables } from '../elements.js';
import { electricityGLSL, ELEC_FIELDS } from '../electricity.js';
import { incandescenceGLSL, INCAND, INCAND_KNOTS, LUMA_709 } from '../gfx/incandescence.js';
import { MATERIAL_FIELDS, FOAMS_FIELD, materialAccessorsWGSL } from '../gfx/materials.js';
import { physicsGLSL, PHYS } from '../physics.js';
import { CELL_M } from '../scale.js';
import { hostStruct } from './hostStruct.js';
import { appearanceWGSL } from '../appearance.js';

// Shared WGSL prelude (docs/webgpu.md C5). The 3D grid (NX × NY × NZ) lives
// in storage buffers, and every kernel reaches a cell through the functions
// below, so there is no filtering and no precision loss.
//
// The simulation state is three buffers, A, B and F, each holding both
// ping-pong copies (copy c of slot s is element c·SLOTS + s), read only
// through fetchA/fetchB/fetchF and written only through writeState/writeCell,
// so the layout and format can change here alone (docs/scaling.md D5;
// tools/check-state-access.mjs enforces it):
//   A = (element id, temperature °C, life/latent/fuel, ctype + seed)
//   B = (velocity xyz in cells/step, air pressure)
//   F = activity flags (FLAG below), one u32 per cell, which the activity map
//       reduces per brick (shaders/activity.js)
// Slots are brick-major (docs/webgpu.md C2): a brick's 64 cells are one run,
// in the 8×8 tile order the WebGL atlas used, and bricks run supertile by
// supertile. Physical indices come only from brickId, slotOf, brickCoord and
// cellOf (and slot >> 6 for a brick, slot >> 10 for a supertile).
// Edge of a brick, in cells: the unit of empty-space skipping, the light and
// GI volumes, and the simulation's activity map.
export const BRICK = 4;
// State atlas, the CPU's order (readState, load, the codec's bytes;
// docs/webgpu.md C2: sim.js cellTexel): a brick is one TILE × TILE-texel tile
// holding its BRICK y-layers as a 2×2 block (cell (x, y, z) at tile texel
// (x + BRICK·(y & 1), z + BRICK·(y >> 1))), and a supertile of SUPER bricks is
// one SUPER_TEX-texel square (the bricks' tiles at (x, z + SUPER.z·y) in it).
// Supertiles are numbered x fastest, then z, then y. Grid sizes are multiples
// of SUPER_CELLS. A slot is the same order with the supertiles' squares laid
// end to end.
export const TILE = 2 * BRICK;                    // texels per brick tile edge
export const SUPER = { x: 4, y: 2, z: 2 };       // bricks per supertile along x, y, z
export const SUPER_TEX = SUPER.x * TILE;          // texels per supertile edge (= SUPER.z · SUPER.y · TILE)
export const SUPER_CELLS = { x: SUPER.x * BRICK, y: SUPER.y * BRICK, z: SUPER.z * BRICK };   // 16×8×8 cells
// The sleeping unit, in bricks per axis (docs/webgpu.md W12, D5): a brick.
// SUPER here reproduces docs/scaling.md D8's supertile rule, for an A/B; a
// grid layout may carry its own (g.sleepUnit).
export const SLEEP_UNIT = { x: 1, y: 1, z: 1 };
// A cell's random seed is the fraction of state A's w, kept below 1 so it
// never carries into the integer ctype.
export const SEED_MAX = 0.999;

// The salts of the simulation kernels' random streams (seed3, seedWorld,
// seedSlot below), all in one place so no two streams share one; the prelude
// has each as SALT_<name>. Changing a value changes that stream's draws.
export const SALT = {
  MOVE: 0x51,              // the move pass's blocks (move.js)
  REACT: 0x7a,             // the react pass's cells (react.js)
  RX: 0x52,                // a reacting pair, apart from the cells' own (react.js; ui/tiles/engine.js twins it)
  SING: 0x5a,              // a singularity and its partner (react.js)
  MIX: 0x4d,               // the Mix tool's block offset and blocks (passes.js)
  MIX_PAIR: 0x4e,          // ...and its pairs
  PAINT: 0xb7,             // the brush (passes.js)
  POV: 0x9d,               // the POV body's coupling (povBody.js)
  FLAME: 0x70,             // the flamethrower (povTools.js)
  ROCKET: 0x72,            // the rocket's blast (povTools.js)
  RAY: 0x5a7,              // the particle kernels (rays.js): a particle's flight...
  RAY_SPAWN: 0x5b1,        // ...its birth...
  RAY_PAINT: 0x5c3,        // ...and what it leaves in the cells
  STAMP: 0x57a3,           // a stamped cell's colour seed (stamp.js, construction.js)
  BOLT: 0x11e7,            // the lightning bolt's edit (lightning.js)
  FOLIAGE: 0x6c656166,     // the foliage clump lattice ('leaf', fields.js)
  CODEC: 0x5eed,           // a decoded snapshot's cell seeds (net/codec.js)
};
{
  const seen = new Map();
  for (const [k, v] of Object.entries(SALT)) {
    if (seen.has(v)) throw new Error(`SALT.${k} and SALT.${seen.get(v)} share the salt 0x${v.toString(16)}: their random streams would be one`);
    seen.set(v, k);
  }
}

// Activity flags (docs/scaling.md D8): bits of the word each state writer
// leaves beside a cell, so the activity map (shaders/activity.js) can tell
// whether a brick is inert from its flags instead of re-running the rest test
// on the whole state. Every other bit is zero and stays zero.
//   SELF    the cell's own state passes the rest test (inertSelf). Always
//           exact: whoever writes a cell evaluates it on what it writes.
//   NEAR    its neighbour test (activity.js inertNear) passed when last
//           evaluated (air passes trivially). Trusted only while nothing it
//           reads is DIRTY; the activity map redoes it otherwise.
//   MATTER  the cell holds matter, not air (air's neighbour test is empty).
//   DIRTY   since the activity map was last built, the cell changed in a
//           way its neighbours' tests read (nearChange), or a writer gave it
//           a new state A: the NEAR around it may be stale. The first step
//           after a build clears it.
export const FLAG = { SELF: 1, NEAR: 2, MATTER: 4, DIRTY: 8 };
// A neighbour test reads an air cell's temperature only through canMove's
// density test, for a powder or liquid that might fall or flow into it. Air
// is at most 1 - AIR_DENS_LO dense (airDensity), so unless some loose element
// is that light, an air cell counts only as air there, and air that warms,
// cools or swaps with other air changes no neighbour's test.
const AIR_DENS_MAX = 1 - PHYS.AIR_DENS_LO;
// A reaction with air (elements.js REACTIONS naming EMPTY) reads its temperature too (its gate).
const AIR_T_IN_NEAR = ELEMENTS.some((e) => (e.kind === K.POWDER || e.kind === K.LIQUID) && e.dens <= AIR_DENS_MAX)
  || REACTIONS.some((r) => r.a === 'EMPTY' || r.b === 'EMPTY');

// ---------------------------------------------------------------- the grid
// The grid's numbers, from its size alone (sim.js gridLayout adds the CPU's
// atlas sizes; the prelude needs only nx, ny, nz).
export function gridDims(g) {
  const { nx, ny, nz } = g;
  if (nx % SUPER_CELLS.x || ny % SUPER_CELLS.y || nz % SUPER_CELLS.z) {
    throw new Error(`grid ${nx}×${ny}×${nz}: sides must be multiples of ${SUPER_CELLS.x}×${SUPER_CELLS.y}×${SUPER_CELLS.z} (a supertile)`);
  }
  const bx = nx / BRICK, by = ny / BRICK, bz = nz / BRICK;
  const stx = nx / SUPER_CELLS.x, sty = ny / SUPER_CELLS.y, stz = nz / SUPER_CELLS.z;
  return { nx, ny, nz, bx, by, bz, stx, sty, stz, slots: nx * ny * nz, nbricks: bx * by * bz, nsuper: stx * sty * stz };
}

// The CPU's state atlas (docs/webgpu.md C2; sim.js gridLayout, cellTexel):
// supertile squares in rows of stw, stw the smallest divisor of their count
// from its square root up, so the atlas is near square and every texel holds
// a cell (all the app's grid sizes); if that would make it more than
// ATLAS_ASPECT_MAX times wider than tall, a square atlas whose last row is
// partly empty.
const ATLAS_ASPECT_MAX = 4;
export function atlasDims(g) {
  const { stx, sty, stz } = gridDims(g), count = stx * sty * stz;
  const root = Math.ceil(Math.sqrt(count));
  let w = root;
  while (count % w) w++;
  const stw = w * w <= ATLAS_ASPECT_MAX * count ? w : root;
  const sth = Math.ceil(count / stw);
  return { stw, sth, width: stw * SUPER_TEX, height: sth * SUPER_TEX };
}

// JS mirrors of brickId, brickCoord, slotOf and cellOf (below), with WGSL's
// i32 and u32 arithmetic: out-of-grid cells give some slot (docs/webgpu.md C2:
// slotOf(-1, 6, 7) = 763), as the WGSL does. sim.js re-exports cellSlot and
// slotCell (C2).
export function brickIdOf(g, bx, by, bz) {
  const stx = g.nx / SUPER_CELLS.x, stz = g.nz / SUPER_CELLS.z;
  const sx = Math.trunc(bx / SUPER.x), sy = Math.trunc(by / SUPER.y), sz = Math.trunc(bz / SUPER.z);
  const kx = bx - sx * SUPER.x, ky = by - sy * SUPER.y, kz = bz - sz * SUPER.z;
  const st = sx + stx * (sz + stz * sy);
  return (st * 16 + kx + 4 * (kz + 2 * ky)) >>> 0;
}
export function brickCoordOf(g, id) {
  const stx = g.nx / SUPER_CELLS.x, stz = g.nz / SUPER_CELLS.z;
  const st = id >>> 4, t = id & 15;
  return [(st % stx) * SUPER.x + (t & 3), Math.floor(st / (stx * stz)) * SUPER.y + (t >> 3), (Math.floor(st / stx) % stz) * SUPER.z + ((t >> 2) & 1)];
}
export function cellSlot(g, x, y, z) {
  const ly = y & 3;
  return (Math.imul(brickIdOf(g, x >> 2, y >> 2, z >> 2), 64) + (x & 3) + 4 * (ly & 1) + 8 * ((z & 3) + 4 * (ly >> 1))) >>> 0;
}
export function slotCell(g, s) {
  const [bx, by, bz] = brickCoordOf(g, s >>> 6);
  const u = s & 7, v = (s >> 3) & 7;
  return [bx * BRICK + (u & 3), by * BRICK + ((u >> 2) | ((v >> 2) << 1)), bz * BRICK + (v & 3)];
}

// The marks buffer (docs/webgpu.md C1, D6): one bit per brick a writer
// changed, for the activity build (act) and for the derived passes' age
// (derived), then a word per brick that may hold a foaming liquid (foams, G4),
// then one word the debug prelude counts out-of-grid accesses in (dbg, I2.8).
// Offsets in u32 words; WGSL has them as MARK_* consts.
export function marksLayout(g) {
  const { nbricks, slots } = gridDims(g), bits = Math.ceil(nbricks / 32);
  const owned = 2 * bits + nbricks + 1;
  // Sticky positional ownership, independent of ping-pong F and activity consumption.
  return { act: 0, derived: bits, foams: 2 * bits, dbg: 2 * bits + nbricks, owned, words: owned + Math.ceil(slots / 32) };
}

// The sleeping unit of a grid (docs/webgpu.md W12, D5): a brick (SLEEP_UNIT),
// or SUPER (docs/scaling.md D8's supertile, for an A/B). Units are numbered so
// that unit u holds bricks u·bricks … u·bricks + bricks − 1: a brick's number
// is its own, a supertile's is the one its 16 bricks share (brickId runs
// supertile by supertile), so a list of units names its bricks too.
export function sleepUnitOf(g) {
  const u = g.sleepUnit ?? SLEEP_UNIT;
  const brick = u.x === 1 && u.y === 1 && u.z === 1;
  const sup = u.x === SUPER.x && u.y === SUPER.y && u.z === SUPER.z;
  if (!brick && !sup) throw new Error(`sleep unit ${u.x}×${u.y}×${u.z}: a brick or a supertile (${SUPER.x}×${SUPER.y}×${SUPER.z})`);
  const bricks = u.x * u.y * u.z, d = gridDims(g);
  return { x: u.x, y: u.y, z: u.z, bricks, ux: d.bx / u.x, uy: d.by / u.y, uz: d.bz / u.z, units: d.nbricks / bricks };
}

// The activity arrays and lists (the act buffer, docs/webgpu.md C1, D4), in
// u32 words, a run of one word per brick each:
//   inert    1: the brick is inert (the build's inert kernel)
//   quiet    1: it and its 26 neighbours are inert, so steps skip it
//   changed  1: steps may have changed it since the derived passes last
//            noted it (noteAwake, the old MAX blend; their age pass reads it)
//   map      per unit: AWAKE and DRAWN (ACT_MAP) and the settle run counter
//            (docs/webgpu.md D5.3)
//   aerSeen  per brick, the aeration list's history (G4, its own kernel's)
//   drawnL, move1L, inertL, aerL   the lists: unit numbers (DRAWN, MOVE1),
//            brick numbers (INERT, AER)
//   count    the lists' lengths (ACT_COUNTS), the units AWAKE, and the last
//            build's INERT length (INERT_LAST: the args kernel keeps it when
//            it starts the INERT list over for the next build)
export const ACT_COUNTS = { DRAWN: 0, MOVE1: 1, INERT: 2, AER: 3, AWAKE: 4, INERT_LAST: 5 };
export const ACT_MAP = { AWAKE: 1, DRAWN: 2, RUN_SHIFT: 8, RUN_MAX: 255 };
export function actLayout(g) {
  const { nbricks } = gridDims(g);
  const at = (k) => k * nbricks;
  return {
    inert: at(0), quiet: at(1), changed: at(2), map: at(3), aerSeen: at(4),
    drawnL: at(5), move1L: at(6), inertL: at(7), aerL: at(8), count: at(9), words: at(9) + 8,
  };
}

// The activity arrays' WGSL, with the act binding: their offsets, the unit
// helpers and the map's readers (prelude).
function actWGSL(g, o) {
  const a = actLayout(g), u = sleepUnitOf(g);
  const load = o.act === 'read_write' ? 'atomicLoad(&act[i])' : 'act[i]';
  return /* wgsl */ `
// ---- the activity arrays (docs/webgpu.md C1, D4; shaders/common.js actLayout) ----
${Object.entries(a).map(([k, v]) => `const ACT_${k.toUpperCase()}: u32 = ${v}u;`).join('\n')}
${Object.entries(ACT_COUNTS).map(([k, v]) => `const CNT_${k}: u32 = ${v}u;`).join('\n')}
const MAP_AWAKE: u32 = ${ACT_MAP.AWAKE}u;
const MAP_DRAWN: u32 = ${ACT_MAP.DRAWN}u;
const MAP_RUN_SHIFT: u32 = ${ACT_MAP.RUN_SHIFT}u;
const MAP_RUN_MAX: u32 = ${ACT_MAP.RUN_MAX}u;
// the sleeping unit (docs/webgpu.md W12): UNIT_B bricks; units along x, y, z
const UNIT_B: u32 = ${u.bricks}u;
const UX: i32 = ${u.ux};
const UY: i32 = ${u.uy};
const UZ: i32 = ${u.uz};
const NUNITS: u32 = ${u.units}u;
fn actLoad(i: u32) -> u32 { return ${load}; }
fn unitOfBrick(id: u32) -> u32 { return id / UNIT_B; }
fn unitCoord(un: u32) -> vec3i { return brickCoord(un * UNIT_B) / SLEEP_UNIT; }
fn unitId(c: vec3i) -> u32 { return brickId(c * SLEEP_UNIT) / UNIT_B; }
fn unitOfCell(p: vec3i) -> u32 { return unitOfBrick(brickId(p >> vec3u(2u))); }
fn inUnits(c: vec3i) -> bool { return all(c >= vec3i(0)) && all(c < vec3i(UX, UY, UZ)); }
fn inBricks(b: vec3i) -> bool { return all(b >= vec3i(0)) && all(b < vec3i(BX, BY, BZ)); }
// Is brick id quiet, or the brick holding cell c (clamped into the grid)?
fn quietBrick(id: u32) -> bool { return actLoad(ACT_QUIET + id) != 0u; }
fn quietCell(c: vec3i) -> bool { return quietBrick(brickId(clamp(c, vec3i(0), vec3i(NX, NY, NZ) - 1) >> vec3u(2u))); }
// Unit un's map word, and whether this map's steps draw it
fn unitMap(un: u32) -> u32 { return actLoad(ACT_MAP + un); }
fn drawnUnit(un: u32) -> bool { return (unitMap(un) & MAP_DRAWN) != 0u; }`;
}

// ---------------------------------------------------------------- tables
// The element tables (docs/webgpu.md C6): one read-only storage buffer, the
// same for every grid, bound at group 0 binding 0 as TB. Its struct and its
// bytes come from the same field lists (elements.js ELEMENT_FIELDS and
// RXDEF_FIELDS, electricity.js ELEC_FIELDS, gfx/materials.js MATERIAL_FIELDS
// and FOAMS_FIELD, gfx/incandescence.js INCAND_KNOTS), so the two can't drift;
// tools/tables-check.mjs reads every field back through its accessor. Built
// on demand: tools add test rows to ELEMENTS before they ask.
//
// After the tables, one value that isn't a table: the scene's ambient air
// temperature, °C (airT; TPT's "ambient air temperature" option), what the air
// relaxes to and rests at in every sim kernel. It is the WebGL build's uAirT,
// one value for every pass and every simulation (only one world is live at a
// time), so it lives in the one buffer they all bind: tablesBuffer writes
// PHYS.AMBIENT, and Simulation.airT (src/sim.js) rewrites the word when a
// world scene sets its own (scene.airT: the Snowy Depths are frozen through),
// in gfx/uniforms.js's render copy of the buffer too when there is one.
// The prelude reads it as airT().
function tableStructs() {
  const t = mechanismTables(), ne = ELEMENTS.length;
  const elemFields = [...ELEMENT_FIELDS, ...ELEC_FIELDS, FOAMS_FIELD];
  const Element = hostStruct('Element', elemFields);
  const Material = hostStruct('Material', MATERIAL_FIELDS);
  const RxDef = hostStruct('RxDef', RXDEF_FIELDS);
  const Tables = hostStruct('Tables', [
    { name: 'elem', type: 'Element', count: ne, countWGSL: 'NE' },
    { name: 'mat', type: 'Material', count: ne, countWGSL: 'NE' },
    { name: 'rxDef', type: 'RxDef', count: t.rx.length, countWGSL: 'NRX' },
    { name: 'incand', type: 'vec4f', count: INCAND.N, countWGSL: 'INCAND_N' },
    { name: 'outs', type: 'vec2f', count: t.outs.length, countWGSL: 'NOUT' },
    { name: 'specs', type: 'vec2i', count: t.specs.length, countWGSL: 'NSPEC' },
    { name: 'rx', type: 'u32', count: ne * ne, countWGSL: 'NE * NE' },
    { name: 'airT', type: 'f32' },
  ], { structs: { Element, Material, RxDef } });
  return { Element, Material, RxDef, Tables, elemFields, t };
}
export const tableLayout = () => tableStructs();

// The tables' WGSL: the structs, the binding and the Material accessors (the
// element accessors are elementsGLSL's and electricityGLSL's).
export function tablesWGSL() {
  const { Element, Material, RxDef, Tables } = tableStructs();
  return [Element.wgsl, Material.wgsl, RxDef.wgsl, Tables.wgsl,
    '@group(0) @binding(0) var<storage, read> TB: Tables;', materialAccessorsWGSL()].join('\n');
}

// The tables' bytes, for the buffer behind TB (Tables.size bytes).
export function tablesBuffer() {
  const { Tables, elemFields, t } = tableStructs();
  const buffer = new ArrayBuffer(Tables.size);
  const row = (fields, x) => Object.fromEntries(fields.map((f) => [f.name, f.get(x)]));
  Tables.write(new DataView(buffer), 0, {
    elem: ELEMENTS.map((e) => row(elemFields, e)),
    mat: ELEMENTS.map((e) => row(MATERIAL_FIELDS, e)),
    rxDef: t.rx.map((r) => row(RXDEF_FIELDS, r)),
    incand: INCAND_KNOTS(),
    outs: t.outs,
    specs: t.specs,
    rx: Array.from(t.lookup),
    airT: PHYS.AMBIENT,
  });
  return buffer;
}
// The byte offset of the ambient air temperature in that buffer (Simulation.airT writes it there).
export const tablesAirTOffset = () => tableStructs().Tables.offsetOf('airT');

// ---------------------------------------------------------------- bindings
// Shader stages, as GPUShaderStage numbers (Node has no GPUShaderStage).
export const STAGE = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
const READ_STAGES = STAGE.COMPUTE | STAGE.FRAGMENT;

// The sim header (docs/webgpu.md B4, C5): the window's origin (docs/scaling.md
// D11: the world cell of grid cell 0, which hashes add so streams don't depend
// on where the window is) and the state copies a dispatch reads (src) and
// writes (dst). Every pipeline has it at group 3 binding 0. The JS side packs
// it from the same fields (src/gpu/params.js uniformStruct('Header', HEADER_FIELDS)).
export const HEADER_FIELDS = { origin: 'vec3i', src: 'u32', dst: 'u32', format: 'u32', capture: 'u32' };
export const Header = hostStruct('Header', HEADER_FIELDS, { space: 'uniform' });

// Which state bindings a prelude declares (group 1, docs/webgpu.md C4):
//   state  false | 'read' | 'read_write': A and B (binding 0, 1)
//   flags  F (binding 2): read with the state, read_write with it (a writer
//          always writes F: flags are positional)
//   marks  the marks (binding 3), read_write atomics
//   act    the activity arrays (binding 4): 'read' (or true) | 'read_write'
//          (atomics: the activity build and the AER list kernel)
//   debug  every accessor tests its cell and counts misses in marks' dbg word
//          (when the marks are bound; ?gpudebug=1, the harness, sim-check)
// A readonly pipeline may commit to one representation; generic readers and
// every writer retain the dynamic header ABI.
export function readFormatWGSL(format) {
  if (format === undefined) return 'H.format';
  if (![0, 2, 3].includes(format)) throw new Error(`prelude: fixedReadFormat ${format}`);
  return `${format}u`;
}
function stateOpts({ state = 'read', flags = false, marks = false, act = false, debug = false, fixedReadFormat } = {}) {
  readFormatWGSL(fixedReadFormat);
  if (fixedReadFormat !== undefined && state !== 'read') throw new Error('prelude: fixedReadFormat requires readonly state');
  if (state !== false && state !== 'read' && state !== 'read_write') throw new Error(`prelude: state ${state}`);
  if (act !== false && act !== true && act !== 'read' && act !== 'read_write') throw new Error(`prelude: act ${act}`);
  return {
    state, fixedReadFormat, flags: state === 'read_write' || (state !== false && !!flags), marks: !!marks,
    act: act === true ? 'read' : act, debug: !!debug,
  };
}
// The group-1 layout entries that match prelude(g, opts)'s declarations.
export function stateLayout(opts) {
  const o = stateOpts(opts), rw = o.state === 'read_write';
  const buf = (binding, write) => ({ binding, visibility: write ? STAGE.COMPUTE : READ_STAGES,
    buffer: { type: write ? 'storage' : 'read-only-storage' } });
  return [
    ...(o.state ? [buf(0, rw), buf(1, rw)] : []),
    ...(o.flags ? [buf(2, rw)] : []),
    ...(o.marks ? [buf(3, true)] : []),
    ...(o.act ? [buf(4, o.act === 'read_write')] : []),
  ];
}
// The state layouts every family builds on (docs/webgpu.md C4), and the
// prelude options that declare them: prelude(g, STATE_OPTS.STATE_RW) with
// layouts [L.TABLES, L.STATE_RW, ...].
export const STATE_OPTS = {
  STATE_RW: { state: 'read_write', flags: true, marks: true, act: 'read' },   // writers, the move, react
  STATE_ACT: { state: 'read', act: 'read' },                                // sim-side readers: aeration, probes
  STATE_RO: { state: 'read' },                                              // render kernels
  STATE_BUILD: { state: 'read', flags: true, marks: true, act: 'read_write' },   // the activity build, the AER list
};
// Bind group layout entries (GPUBindGroupLayoutEntry) for gpu.layout(name,
// entries), docs/webgpu.md B1, C4. Render groups (FRAME, LIGHTING and its
// writer variants) are shaders/bindings.js RENDER_LAYOUT.
const uniformDyn = (binding) => ({ binding, visibility: STAGE.VERTEX | STAGE.FRAGMENT | STAGE.COMPUTE,
  buffer: { type: 'uniform', hasDynamicOffset: true } });
export const LAYOUT = {
  TABLES: [{ binding: 0, visibility: READ_STAGES, buffer: { type: 'read-only-storage' } }],
  ...Object.fromEntries(Object.entries(STATE_OPTS).map(([k, o]) => [k, stateLayout(o)])),
  PARAMS: [uniformDyn(0), uniformDyn(1)],   // the header, the kernel's params (src/gpu/params.js ParamRing)
  EMPTY: [],
};

const stateBindings = (o) => {
  const acc = o.state === 'read_write' ? 'read_write' : 'read';
  return [
    ...(o.state ? [
      `@group(1) @binding(0) var<storage, ${acc}> A: array<${o.state === 'read' ? 'vec4u' : 'vec4f'}>;   // both copies: copy c of slot s at c·SLOTS + s`,
      `@group(1) @binding(1) var<storage, ${acc}> B: array<vec4f>;`] : []),
    ...(o.flags ? [`@group(1) @binding(2) var<storage, ${acc}> F: array<u32>;`] : []),
    ...(o.marks ? ['@group(1) @binding(3) var<storage, read_write> marks: array<atomic<u32>>;'] : []),
    ...(o.act === 'read' ? ['@group(1) @binding(4) var<storage, read> act: array<u32>;'] : []),
    ...(o.act === 'read_write' ? ['@group(1) @binding(4) var<storage, read_write> act: array<atomic<u32>>;'] : []),
  ].join('\n');
};

// The accessors (docs/webgpu.md C5.6, D8.1): the only code that indexes A, B
// and F. The caller has established inGrid(p) (H1.29: slotOf of a cell
// outside the grid is another real cell). With opts.debug, each tests that
// and counts a miss (dbgOob); a store outside the grid is then dropped.
function accessorsWGSL(o) {
  if (!o.state) return '';
  const cell = (dir) => (o.debug ? `if (!inGrid(p) || H.${dir} > 1u) { dbgOob(); }\n  ` : '');
  const slot = (dir) => (o.debug ? `if (s >= SLOTS || H.${dir} > 1u) { dbgOob(); }\n  ` : '');
  const fetch = (name, buf, type) => `fn ${name}(p: vec3i) -> ${type} {
  ${cell('src')}return ${buf}[H.src * SLOTS + slotOf(p)];
}
fn ${name}s(s: u32) -> ${type} {
  ${slot('src')}return ${buf}[H.src * SLOTS + s];
}`;
  // Read-only A is raw words: compact payloads may contain NaN float bit patterns.
  // H.src remains a copy index; the header or fixed readonly variant selects storage.
  const format = readFormatWGSL(o.fixedReadFormat);
  // Committed to today's representation: no compact decoder (and none of its
  // table reads) is statically used, so a stage binds only the copies it reads.
  const legacyRead = `
fn fetchAs(s: u32) -> vec4f {
  ${slot('src')}return bitcast<vec4f>(A[H.src * SLOTS + s]);
}
fn fetchA(p: vec3i) -> vec4f { ${cell('src')}return fetchAs(slotOf(p)); }
fn fetchNativeCore(p: vec3i) -> vec4u { ${cell('src')}return vec4u(0u); }
fn fetchNativeAeration(p: vec3i) -> vec3f { ${cell('src')}return vec3f(0.0); }
fn fetchBs(s: u32) -> vec4f {
  ${slot('src')}return B[H.src * SLOTS + s];
}
fn fetchB(p: vec3i) -> vec4f { ${cell('src')}return fetchBs(slotOf(p)); }
`;
  const out = o.state !== 'read' ? [fetch('fetchA', 'A', 'vec4f'), fetch('fetchB', 'B', 'vec4f')] : o.fixedReadFormat === 0 ? [legacyRead] : [compactDecodeWGSL, `
fn fetchAs(s: u32) -> vec4f {
  ${slot('src')}if (${format} == 2u || ${format} == 3u) {
    var core = A[s];
    if (${format} == 3u) { core = compactProbeCore(core); }
    return compactA(cellOf(s), core);
  }
  return bitcast<vec4f>(A[H.src * SLOTS + s]);
}
fn fetchA(p: vec3i) -> vec4f { ${cell('src')}return fetchAs(slotOf(p)); }
fn fetchNativeCore(p: vec3i) -> vec4u {
  ${cell('src')}if (${format} != 2u && ${format} != 3u) { return vec4u(0u); }
  return A[slotOf(p)];
}
fn fetchNativeAeration(p: vec3i) -> vec3f {
  ${cell('src')}if (${format} != 2u && ${format} != 3u) { return vec3f(0.0); }
  let core = A[slotOf(p)];
  if (KIND(i32(core.x & 255u)) != K_LIQUID || (core.y & 0xffffffu) == 0u) { return vec3f(0.0); }
  return vec3f(f32(core.x >> 24u) / 255.0, 1.0, 1.0);
}
fn fetchBs(s: u32) -> vec4f {
  ${slot('src')}if (${format} == 2u) { return vec4f(0.0); }
  if (${format} == 3u) {
    // Physical readers bind current native coarse air in B (two vec4s/brick).
    // Return the existing probe ABI, not Pa disguised as legacy pressure.
    let air = B[(s >> 6u) * 2u];
    return vec4f(air.xyz / ${240 * CELL_M}, air.w / ${LEGACY_PRESSURE_PA});
  }
  return B[H.src * SLOTS + s];
}
fn fetchB(p: vec3i) -> vec4f { ${cell('src')}return fetchBs(slotOf(p)); }
`];
  if (o.flags) out.push(fetch('fetchF', 'F', 'u32'));
  if (o.state === 'read_write') {
    out.push(`${o.marks ? `// A legacy write owns this coordinate until compact import consumes the bit.
// Atomic bits live outside F: neither ping-pong skips nor activity rebuilds lose them.
fn ownLegacy(s: u32) {
  if (H.capture != 0u) { atomicOr(&marks[MARK_OWNED + (s >> 5u)], 1u << (s & 31u)); }
}
fn noteLegacy(s: u32, a: vec4f, b: vec4f) {
  if ((H.capture == 1u && (any(a != fetchAs(s)) || any(b != fetchBs(s)))) ||
      (H.capture == 2u && eid(a) != eid(fetchAs(s)))) { ownLegacy(s); }
}` : ''}
// Store cell p's new state in the copy H.dst names. The caller has
// established inGrid(p) and its own box test (D8.9).
fn writeState(p: vec3i, a: vec4f, b: vec4f, f: u32) {
  ${o.debug ? 'if (!inGrid(p) || H.dst > 1u) { dbgOob(); return; }\n  ' : ''}let i = H.dst * SLOTS + slotOf(p);
  ${o.marks ? 'noteLegacy(slotOf(p), a, b);' : ''}
  A[i] = a;
  B[i] = b;
  F[i] = f;
}
fn writeStateS(s: u32, a: vec4f, b: vec4f, f: u32) {
  ${o.debug ? 'if (s >= SLOTS || H.dst > 1u) { dbgOob(); return; }\n  ' : ''}let i = H.dst * SLOTS + s;
  ${o.marks ? 'noteLegacy(s, a, b);' : ''}
  A[i] = a;
  B[i] = b;
  F[i] = f;
}
// Store only cell p's flags (its A and B stay as they are): a pass that
// leaves a cell's state but settles its flags, as the move's blocks with a
// quiet base do in place (docs/webgpu.md D2). Same rules as writeState.
fn writeFlags(p: vec3i, f: u32) {
  ${o.debug ? 'if (!inGrid(p) || H.dst > 1u) { dbgOob(); return; }\n  ' : ''}F[H.dst * SLOTS + slotOf(p)] = f;
}
// A writer's store (docs/webgpu.md D6): cell p held (a, b) with flags f and
// gets (oA, oB). Outside the grid it stores nothing; inside, only if A or B
// changed, with the flags writtenFlags leaves. True when it stored: the
// caller marks the brick (markBrick; editMain does, once per workgroup).
fn writeCell(p: vec3i, a: vec4f, b: vec4f, f: u32, oA: vec4f, oB: vec4f) -> bool {
  if (!inGrid(p)) { return false; }
  // Eligibility belongs to the edit branch, not its enclosing dispatch box.
  if (all(oA == a) && all(oB == b)) { return false; }
  writeState(p, oA, oB, writtenFlags(f, a, b, oA, oB));
  return true;
}`);
  }
  return out.join('\n');
}

// Physics V2's cores and coarse air by slot, raw, for readers that bind a V2 read group (formats
// 2 and 3: v2/physics.js readGroup, sim.bindPhysicalRO bind the cells in A and dynamics' current air,
// two vec4f per brick, in B): shaders/v2/viewRead.js. Not part of the prelude (its text, and so every
// generic module's, is unchanged): a module that reads them includes this once (viewRead.js does).
export const nativeSlotAccessWGSL = /* wgsl */ `
fn fetchNativeCoreS(s: u32) -> vec4u { return A[s]; }
fn fetchNativeAirS(s: u32) -> vec4f { return B[(s >> 6u) * 2u]; }`;


const saltConsts = () => Object.entries(SALT).map(([k, v]) => `const SALT_${k}: u32 = 0x${v.toString(16)}u;`).join('\n');
const flagConsts = () => Object.entries(FLAG).map(([k, v]) => `const FLAG_${k}: u32 = ${v}u;`).join('\n');

// prelude(g, opts): WGSL that every kernel of ours starts with
// (docs/webgpu.md C5): the grid's and the engine's consts, the element tables
// and their accessors, the header, the state bindings opts asks for (see
// stateOpts), the slot layout, the state accessors, hashing and random
// streams, and the shared physics tests. g needs only nx, ny, nz (and may
// carry sleepUnit).
export function prelude(g, opts = {}) {
  const o = stateOpts(opts), d = gridDims(g), m = marksLayout(g), u = g.sleepUnit ?? SLEEP_UNIT;
  return /* wgsl */ `
// ---- the grid ----
const NX: i32 = ${d.nx};
const NY: i32 = ${d.ny};
const NZ: i32 = ${d.nz};
const CELL_M: f32 = ${CELL_M.toFixed(4)};   // metres per cell (src/scale.js)
const BS: i32 = ${BRICK};                  // cells per brick edge
const BX: i32 = ${d.bx};
const BY: i32 = ${d.by};
const BZ: i32 = ${d.bz};
const STX: i32 = ${d.stx};                 // supertiles along x, y, z
const STY: i32 = ${d.sty};
const STZ: i32 = ${d.stz};
const SUPER_B: vec3i = vec3i(${SUPER.x}, ${SUPER.y}, ${SUPER.z});   // bricks per supertile
const SLOTS: u32 = ${d.slots}u;            // cells: one copy of the state
const NBRICKS: u32 = ${d.nbricks}u;
const NSUPER: u32 = ${d.nsuper}u;
const SLEEP_UNIT: vec3i = vec3i(${u.x}, ${u.y}, ${u.z});   // bricks per sleeping unit (docs/webgpu.md W12)
// the marks buffer, in words (docs/webgpu.md C1, D6; shaders/common.js marksLayout)
const MARK_ACT: u32 = ${m.act}u;
const MARK_DERIVED: u32 = ${m.derived}u;
const MARK_FOAMS: u32 = ${m.foams}u;
const MARK_DBG: u32 = ${m.dbg}u;
const MARK_OWNED: u32 = ${m.owned}u;
const MARK_WORDS: u32 = ${m.words}u;
${physicsGLSL()}
const SEED_MAX: f32 = ${SEED_MAX};   // a cell's random seed (the fraction in state A's w) stays below this
${flagConsts()}
const PI: f32 = 3.14159265;
const TWO_PI: f32 = 6.2831853;
const LUMA_709: vec3f = vec3f(${LUMA_709.join(', ')});   // Rec. 709 luminance weights, linear sRGB (gfx/incandescence.js)
// A clip-space position's depth, WebGPU's [0, 1] (docs/webgpu.md F4): what a fragment writes as frag_depth.
fn clipDepth(clip: vec4f) -> f32 { return clamp(clip.z / clip.w, 0.0, 1.0); }
const AIR_T_IN_NEAR: bool = ${AIR_T_IN_NEAR};   // an air cell's temperature can decide a neighbour test (see AIR_T_IN_NEAR)

// ---- the element tables (docs/webgpu.md C6) ----
${elementsGLSL()}
${tablesWGSL()}
${appearanceWGSL}
// The scene's ambient air temperature, °C (the tables' airT; the WebGL build's
// uAirT): what the air relaxes to and rests at. PHYS.AMBIENT unless a world
// scene sets its own (Simulation.airT).
fn airT() -> f32 { return TB.airT; }

// ---- the header and the state (docs/webgpu.md B4, C1, C4) ----
${Header.wgsl}
@group(3) @binding(0) var<uniform> H: Header;
${stateBindings(o)}

// ---- the layout (docs/webgpu.md C2) ----
// Brick b's number: its supertile's (x fastest, then z, then y) times 16, plus
// its tile's row-major place in the supertile's 4×4-tile square.
fn brickId(b: vec3i) -> u32 {
  let s = b / SUPER_B;
  let k = b - s * SUPER_B;
  let st = s.x + STX * (s.z + STZ * s.y);
  return u32(st * 16 + k.x + 4 * (k.z + 2 * k.y));
}
fn brickCoord(id: u32) -> vec3i {
  let st = i32(id >> 4u);
  let t = i32(id & 15u);
  let s = vec3i(st % STX, st / (STX * STZ), (st / STX) % STZ);
  return s * SUPER_B + vec3i(t & 3, t >> 3u, (t >> 2u) & 1);
}
// Cell p's slot: its brick's 64-cell run, in the brick tile's row-major order
// (x + BS·(y & 1) across, z + BS·(y >> 1) down). Outside the grid it is
// another cell's (bounds are the caller's, H1.29).
fn slotOf(p: vec3i) -> u32 {
  let l = p & vec3i(3);
  return brickId(p >> vec3u(2u)) * 64u + u32(l.x + 4 * (l.y & 1) + 8 * (l.z + 4 * (l.y >> 1u)));
}
fn cellOf(s: u32) -> vec3i {
  let t = i32(s & 63u);
  let u = t & 7;
  let v = t >> 3u;
  return brickCoord(s >> 6u) * BS + vec3i(u & 3, (u >> 2u) | ((v >> 2u) << 1u), v & 3);
}
fn inGrid(p: vec3i) -> bool { return all(p >= vec3i(0)) && all(p < vec3i(NX, NY, NZ)); }
// the supertile of brick b (its 16 bricks are one run of brick numbers)
fn supertileOf(b: vec3i) -> u32 { return brickId(b) >> 4u; }
// A folded dispatch's flat workgroup index (src/gpu/kernels.js fold(n):
// [ceil(n / y), y, 1]): past the end on its last row, so check it.
fn foldId(wg: vec3u, nwg: vec3u) -> u32 { return wg.x + wg.y * nwg.x; }
// ...and a 64-thread workgroup's thread's
fn foldThread(wg: vec3u, nwg: vec3u, li: u32) -> u32 { return foldId(wg, nwg) * 64u + li; }
${o.marks ? `// A writer changed brick id (docs/webgpu.md D6): the next activity map forces
// it, the derived passes re-age it, and it may now hold a foaming liquid.
fn markBrick(id: u32) {
  atomicOr(&marks[MARK_ACT + (id >> 5u)], 1u << (id & 31u));
  atomicOr(&marks[MARK_DERIVED + (id >> 5u)], 1u << (id & 31u));
  atomicStore(&marks[MARK_FOAMS + id], 1u);
}` : ''}
${o.act ? actWGSL(g, o) : ''}
${o.debug ? `// an accessor reached outside the grid (or past a copy): counted for sim-check
// (I2.8) in the marks' dbg word${o.marks ? '' : ' (no marks bound here: nothing to count in)'}
fn dbgOob() {${o.marks ? ' atomicAdd(&marks[MARK_DBG], 1u); ' : ''}}` : ''}

// ---- the state's accessors (docs/webgpu.md C5, D8.1) ----
${accessorsWGSL(o)}
fn eid(a: vec4f) -> i32 { return i32(floor(a.x + 0.5)); }
${electricityGLSL()}

// ---- random streams ----
// PCG hash (Jarzynski & Olano 2020, "Hash Functions for GPU Rendering"); the
// numbers are the published constants. u32 arithmetic wraps, as GLSL's did.
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
const LCG_MUL: u32 = 1664525u;   // Numerical Recipes' LCG multiplier: spreads frame numbers apart
// A random stream for world cell w (seed3 for a grid cell).
fn seedWorld(w: vec3i, frame: u32, salt: u32) -> u32 {
  return pcg(bitcast<u32>(w.x) + pcg(bitcast<u32>(w.y) + pcg(bitcast<u32>(w.z) + pcg(frame * LCG_MUL + salt))));
}
// ...for grid cell p: hashed at its world cell, so results don't depend on where the window is
fn seed3(p: vec3i, frame: u32, salt: u32) -> u32 { return seedWorld(p + H.origin, frame, salt); }
// ...for slot j of a list that isn't the grid (the rays' particles)
fn seedSlot(j: u32, frame: u32, salt: u32) -> u32 { return pcg(j + pcg(frame * LCG_MUL + salt)); }
// the random streams' salts (SALT)
${saltConsts()}
// Correctly rounded u32 → f32 on every device. WGSL lets f32(u) round either way when u isn't representable
// (SwiftShader doesn't round to nearest even; Metal does): both terms here are exact, so the one add rounds.
fn u32ToF32(s: u32) -> f32 { return f32(s >> 8u) * 256.0 + f32(s & 255u); }
fn i32ToF32(s: i32) -> f32 { return f32(s >> 8u) * 256.0 + f32(s & 255); }
const UINT_TO_UNIT: f32 = 1.0 / 4294967296.0;   // 2^-32: a 32-bit hash to [0, 1]
// The next draw of stream rs, in [0, 1] (exactly 1 for a hash past 0xFFFFFF7F,
// as round-to-nearest-even gives: docs/webgpu.md D8.3). A stream is a
// function-scope var passed down by pointer (C5).
fn rnd(rs: ptr<function, u32>) -> f32 {
  *rs = pcg(*rs);
  return u32ToF32(*rs) * UINT_TO_UNIT;
}
// A unit vector in a random direction in the plane, from one draw of stream rs.
fn randDir2(rs: ptr<function, u32>) -> vec2f {
  let ang = rnd(rs) * TWO_PI;
  return vec2f(cos(ang), sin(ang));
}

// ---- the shared physics tests ----
fn airDensity(T: f32) -> f32 { return 1.0 - clamp((T - airT()) / AIR_DENS_SPAN, AIR_DENS_LO, AIR_DENS_HI); }
// Gases thin with heat the way air does (ideal gas): a gas's DENS is its density
// at its spawn temperature, so hot smoke rises through the hot air around a fire.
fn densityOf(id: i32, T: f32) -> f32 {
  if (id == E_EMPTY) { return airDensity(T); }
  if (KIND(id) == K_GAS) { return DENS(id) * airDensity(T) / airDensity(SPAWNT(id)); }
  return DENS(id);
}
fn isGasLike(id: i32) -> bool { return KIND(id) == K_GAS || id == E_EMPTY; }
fn isFluid(id: i32) -> bool { return KIND(id) == K_LIQUID || isGasLike(id); }
fn movable(id: i32) -> bool { return KIND(id) != K_SOLID; }
// loose matter: powder or liquid (what falls, piles and pours)
fn isLoose(id: i32) -> bool { let k = KIND(id); return k == K_POWDER || k == K_LIQUID; }
// loose matter or a gas: what the Mix tool stirs and the physics gun holds (TPT MIX.cpp: TYPE_PART | TYPE_LIQUID | TYPE_GAS)
fn isLooseOrGas(id: i32) -> bool { let k = KIND(id); return k == K_POWDER || k == K_LIQUID || k == K_GAS; }
// The kinetic energy a hit between two cells closing at speed u dissipates:
// ½·μ·u², μ their reduced mass; against a solid (jSolid), the mover's mass.
fn hitKE(mi: f32, mj: f32, jSolid: bool, u: f32) -> f32 {
  var m = mi;
  if (!jSolid) { m = mi * mj / (mi + mj); }
  return 0.5 * m * u * u;
}
// Would a hit with kinetic energy ke between cells of elements i and j set
// off an explosive on either side (elements.js blast.shock)? Cells of one
// element don't set each other off: a pool's own flow isn't a hit.
fn shockActs(i: i32, j: i32, ke: f32) -> bool {
  return i != j && ((BLAST(i).z > 0.0 && ke >= BLAST(i).z) || (BLAST(j).z > 0.0 && ke >= BLAST(j).z));
}
// Does a hit carrying kinetic energy ke, by a cell of element i on a solid
// of element j, do anything: break j (elements.js hard, breakInto) or set off
// an explosive? The move pass leaves such a projectile unbounced (and a
// shockActs hit between two loose cells uncollided), so the react pass sees
// the hit (react.js).
fn impactActs(i: i32, j: i32, ke: f32) -> bool {
  return (BREAKINTO(j) >= 0 && ke >= HARD(j)) || shockActs(i, j, ke);
}
// Can a particle (id a, density da) move into the place of (b, db), travelling
// in direction dir (0 = down, 1 = up, 2 = sideways)? The move pass's rule;
// the react pass and the activity map ask it too, so all three agree on what
// is blocked.
fn canMove(a: i32, b: i32, da: f32, db: f32, dir: i32) -> bool {
  if (!movable(a) || !movable(b)) { return false; }
  if (a == b && a != E_EMPTY) { return false; }
  if (isGasLike(a) && isGasLike(b)) {
    if (dir == 0) { return da > db - GAS_DENS_TOL; }
    if (dir == 1) { return da < db + GAS_DENS_TOL; }
    return true;
  }
  if (!isFluid(a) && !isFluid(b)) { return false; }   // grains don't sink into grains
  if (dir == 0) { return da > db; }
  if (dir == 1) { return da != db; }                 // buoyant rise, or thrown upward
  return db < da;
}

// Rough blackbody colour (normalised) for a temperature in °C: Tanner Helland's
// fit (2012), in hundreds of kelvin with its knee at 6600 K; the numbers are the
// fit's coefficients.
const C_TO_K: f32 = KELVIN;   // (physics.js)
fn blackbody(tC: f32) -> vec3f {
  let t = (tC + C_TO_K) / 100.0;
  var r = 1.0;
  var g: f32;
  var b = 1.0;
  if (t <= 66.0) {
    g = clamp(0.3900816 * log(t) - 0.6318414, 0.0, 1.0);
  } else {
    r = clamp(1.292936 * pow(t - 60.0, -0.1332047), 0.0, 1.0);
    g = clamp(1.1298909 * pow(t - 60.0, -0.0755148), 0.0, 1.0);
  }
  if (t < 66.0) {
    if (t <= 19.0) { b = 0.0; } else { b = clamp(0.5432068 * log(t - 10.0) - 1.1962541, 0.0, 1.0); }
  }
  return vec3f(r, g * g, b * b);
}
${incandescenceGLSL()}

// ---- the activity flags a writer leaves (docs/scaling.md D8) ----
${inertSelfGLSL}
// A cell given the state (a, b) with no neighbour test: FLAG_DIRTY has the
// activity map run the neighbour tests around it (its own included).
fn freshFlags(a: vec4f, b: vec4f) -> u32 { return ownFlags(a, b) | FLAG_DIRTY; }
// The flags a writer leaves on a cell that held (a, b) with flags f and now
// holds (oA, oB): an untouched cell keeps its flags; a new element,
// temperature or ctype + seed is fresh (freshFlags: the cell's own neighbour
// test reads them too); a new life or state B (velocity, pressure) only
// redoes its own test, since no neighbour test reads them.
fn writtenFlags(f: u32, a: vec4f, b: vec4f, oA: vec4f, oB: vec4f) -> u32 {
  if (any(oA.xyw != a.xyw)) { return freshFlags(oA, oB); }
  if (any(oA != a) || any(oB != b)) { return select(f & ~FLAG_SELF, f | FLAG_SELF, inertSelf(oA, oB)); }
  return f;
}
`;
}

// Air's steady jitter speed, 0.5·JITTER(E_EMPTY)/DRAG(E_EMPTY), in f32 at
// each step as the GLSL folded it (a const in WGSL, so computed here: H1.7).
const airJitterV = () => {
  const air = ELEMENTS[0], r = Math.fround;
  return r(r(0.5 * r(air.jitter)) / r(air.drag));
};

// The rest test on a cell's own state (docs/scaling.md D2; the half that reads
// its neighbours is shaders/activity.js inertNear). Every state writer
// evaluates it on what it writes (FLAG_SELF); see activity.js for the rules.
// (In the prelude; the name is the GLSL version's, docs/webgpu.md W2.)
export const inertSelfGLSL = /* wgsl */ `
// Air's steady jitter speed: the react pass does v' = v·(1 - drag) + j with
// |j| ≤ jitter / 2, whose bound is this. Calmer than that is no wind (cells/step).
const AIR_JITTER_V: f32 = ${airJitterV()};   // 0.5 · JITTER(E_EMPTY) / DRAG(E_EMPTY)
fn inertSelf(a: vec4f, b: vec4f) -> bool {
  let id = eid(a);
  let T = a.y;
  if (id == E_EMPTY) {
    let v = abs(b.xyz);
    return abs(T - airT()) <= AIR_REST_T && abs(b.w) <= REST_P && max(v.x, max(v.y, v.z)) <= AIR_JITTER_V + REST_V_SLOP;
  }
  let k = KIND(id);
  if (k == K_GAS) { return false; }   // smoke, steam and flames rise, fade and burn
  if (!electricQuiet(id, a)) { return false; }   // a spark, a switch turning off, a firing sensor (src/electricity.js)
  // moving, or pressure still settling (solids hold none)
  if (k != K_SOLID && (any(b.xyz != vec3f(0.0)) || abs(b.w) > REST_P)) { return false; }
  if (MELT(id) > 0.0 && T > MELT(id)) { return false; }
  if (IGNITE(id) > 0.0 && T >= IGNITE(id)) { return false; }   // burning, or hot enough to light the air
  // a phase change from the table (elements.js cold/hot): past its point, at
  // it with no latent heat to bank (instant), or with some banked
  if (INTO(id)[PH_HOT] >= 0 && (T > HOT(id).x || (T == HOT(id).x && HOT(id).y == 0.0))) { return false; }
  if (INTO(id)[PH_COLD] >= 0 && (T < COLD(id).x || (T == COLD(id).x && COLD(id).y == 0.0))) { return false; }
  if (LIFE_BANK(id) && (HOT(id).y > 0.0 || COLD(id).y > 0.0) && a.z != 0.0) { return false; }
  // latent heat: water and ice at rest sit within their phase with nothing
  // banked, or with some banked but pinned at the phase point (react.js latent()
  // holds them there): then only heat flowing in or out changes them, and that
  // takes a neighbour off the rest test (or is drift under its tolerances). So
  // snow in freezing air, warmed a little by its grains settling, rests.
  // (water's life: + banked toward boiling, - toward freezing)
  if (id == E_WATER) {
    if (a.z == 0.0) { return T >= 0.0 && T <= 100.0; }
    return T == select(0.0, 100.0, a.z > 0.0);
  }
  if (id == E_ICE || id == E_SNOW) {
    if (a.z == 0.0) { return T <= 0.0; }
    return T == 0.0;
  }
  if (id == E_FUSE) { return a.z >= 1.0; }   // lit: burning down (react.js)
  if (id == E_LAVA) {
    var ct = i32(floor(a.w));
    if (ct <= 0 || ct >= NE) { ct = E_STONE; }
    return T >= MELT(ct) - LAVA_FREEZE_BELOW;   // not cool enough to set
  }
  return true;
}
// FLAG_SELF and FLAG_MATTER of a cell holding (a, b).
fn ownFlags(a: vec4f, b: vec4f) -> u32 {
  return select(0u, FLAG_SELF, inertSelf(a, b)) | select(0u, FLAG_MATTER, eid(a) != E_EMPTY);
}
// Does a cell going from state A a0 to a1 change what its neighbours' tests
// (activity.js inertNear) read of it? Its element, and its temperature unless
// it is air (AIR_T_IN_NEAR). Its ctype + seed they don't read, nor its life,
// but for a switch or powered clone going on or off (electricQuietNear, and
// the air beside a powered clone, which copies it while it is on), a fuse
// being lit (a fuse beside it reads that), and a moss or fungus cell's ctype
// (its damp).
fn nearChange(a0: vec4f, a1: vec4f) -> bool {
  let i1 = eid(a1);
  return eid(a0) != i1 || (a0.y != a1.y && (i1 != E_EMPTY || AIR_T_IN_NEAR))
      || (powered(i1) && (a0.z >= SWITCH_ON) != (a1.z >= SWITCH_ON))
      || (i1 == E_FUSE && (a0.z < 1.0) != (a1.z < 1.0))
      || ((i1 == E_MOSS || i1 == E_FUNGUS) && floor(a0.w) != floor(a1.w));
}
`;

// ---------------------------------------------------------------- writers
// The fields editMain reads from its kernel's params (P, group 3 binding 1):
// the box, inclusive, in grid cells, clipped to the grid (docs/webgpu.md D6).
// sim.editKernel puts them first in the kernel's params struct.
export const EDIT_FIELDS = { editLo: 'vec3i', editHi: 'vec3i' };
// The group-2 binding of a two-phase writer's scratch (reads: 'neighbours').
export const EDIT_SCRATCH_BINDING = 15;

/**
 * main() of a writer that changes the cells of a box (docs/webgpu.md D6: the
 * brush, stamps, transfers, the POV body and tools): a 64-thread workgroup
 * (4×4×4) per brick the box overlaps, from a folded dispatch over
 * ceil-to-bricks(box) bricks, x fastest; threads outside the box or the grid
 * skip. update names the kernel's WGSL function
 *   fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>)
 * which gets cell p's state (a, b) and leaves its new state in *oA, *oB (they
 * start as a copy). writeCell stores what changed with the flags writtenFlags
 * leaves, and the brick of any changed cell is marked once per workgroup.
 * Needs a prelude with STATE_OPTS.STATE_RW and the kernel's params P holding
 * EDIT_FIELDS.
 *   reads 'own'         update reads only its own cell: in place, one pass
 *         'neighbours'  it reads others: main runs update into a box-sized
 *                       scratch (group 2, EDIT_SCRATCH_BINDING: two vec4f per
 *                       cell of the brick-aligned box, x fastest), and the
 *                       entry point apply, a second dispatch of the same
 *                       size, copies it into the state, so every read sees
 *                       the state before the edit
 */
export function editMain(update, { reads = 'own', scratchBinding = EDIT_SCRATCH_BINDING } = {}) {
  if (reads !== 'own' && reads !== 'neighbours') throw new Error(`editMain: reads ${reads}`);
  const head = `@compute @workgroup_size(4, 4, 4)
fn NAME(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
        @builtin(local_invocation_id) lid: vec3u, @builtin(local_invocation_index) li: u32) {
  let b0 = P.editLo >> vec3u(2u);                     // the box's first brick
  let nb = vec3u((P.editHi >> vec3u(2u)) - b0 + 1);   // its bricks along x, y, z
  let k = foldId(wg, nwg);
  let b = b0 + vec3i(vec3u(k % nb.x, (k / nb.x) % nb.y, k / (nb.x * nb.y)));
  let p = b * BS + vec3i(lid);
  let inBox = k < nb.x * nb.y * nb.z && inGrid(p) && all(p >= P.editLo) && all(p <= P.editHi);`;
  // (workgroup memory starts zeroed, so editChanged needs no clearing)
  const mark = `
  workgroupBarrier();
  if (li == 0u && atomicLoad(&editChanged) != 0u) { markBrick(brickId(b)); }
}`;
  if (reads === 'own') {
    return /* wgsl */ `
var<workgroup> editChanged: atomic<u32>;   // a cell of the workgroup's brick changed
${head.replace('NAME', 'main')}
  if (inBox) {
    let a = fetchA(p);
    let bb = fetchB(p);
    var oA = a;
    var oB = bb;
    ${update}(p, a, bb, &oA, &oB);
    if (writeCell(p, a, bb, fetchF(p), oA, oB)) { atomicOr(&editChanged, 1u); }
  }${mark}
`;
  }
  return /* wgsl */ `
var<workgroup> editChanged: atomic<u32>;   // a cell of the workgroup's brick changed
@group(2) @binding(${scratchBinding}) var<storage, read_write> editScratch: array<vec4f>;
// cell p's (oA, oB) in the scratch: its place in the brick-aligned box, x fastest
fn editIndex(p: vec3i) -> u32 {
  let b0 = P.editLo >> vec3u(2u);
  let n = vec3u(((P.editHi >> vec3u(2u)) - b0 + 1) * BS);
  let o = vec3u(p - b0 * BS);
  return 2u * (o.x + n.x * (o.y + n.y * o.z));
}
// phase 1: update reads the state before the edit, its results go to the scratch
${head.replace('NAME', 'main')}
  if (inBox) {
    let a = fetchA(p);
    let bb = fetchB(p);
    var oA = a;
    var oB = bb;
    ${update}(p, a, bb, &oA, &oB);
    let i = editIndex(p);
    editScratch[i] = oA;
    editScratch[i + 1u] = oB;
  }
}
// phase 2: the scratch into the state
${head.replace('NAME', 'apply')}
  if (inBox) {
    let i = editIndex(p);
    if (writeCell(p, fetchA(p), fetchB(p), fetchF(p), editScratch[i], editScratch[i + 1u])) { atomicOr(&editChanged, 1u); }
  }${mark}
`;
}

/**
 * A box writer's whole module (docs/webgpu.md D6; sim.editKernel builds it):
 * the prelude with the writable state, its params struct (EDIT_FIELDS first)
 * at group 3 binding 1 as P, extra declarations, its update and editMain.
 * @param {object} g grid
 * @param {{ update: string, params: object, reads?: 'own' | 'neighbours', decls?: string, debug?: boolean }} opts
 *   update   WGSL defining fn update(p, a, b, oA, oB)
 *   params   a uniformStruct whose first fields are EDIT_FIELDS
 *   decls    WGSL after the params (the kernel's own group-2 bindings, helpers)
 * @returns {string}
 */
export function editKernelWGSL(g, { update, params, reads = 'own', decls = '', debug = false }) {
  const [lo, hi] = params.fields ?? [];
  if (lo?.name !== 'editLo' || hi?.name !== 'editHi') throw new Error(`editKernelWGSL: ${params.name} must start with EDIT_FIELDS`);
  return /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_RW, debug })}
${params.deps?.map((d) => d.wgsl).join('') ?? ''}${params.wgsl}
@group(3) @binding(1) var<uniform> P: ${params.name};
${decls}
${update}
${editMain('update', { reads })}`;
}

// ---------------------------------------------------------------- check-wgsl
// The prelude on its own with each state layout (C4), its debug variant
// included, so tools/check-wgsl.mjs validates it at every grid even before a
// kernel that uses it is checked. Tools' entries: never warmed for a session.
const PROBES = {
  preludeRW: [{ ...STATE_OPTS.STATE_RW, debug: true }, 'writeState(p, fetchA(p), fetchB(p), fetchF(p));\n  _ = quietCell(p);'],
  preludeBuild: [STATE_OPTS.STATE_BUILD, '_ = fetchF(p);\n  _ = drawnUnit(unitOfCell(p));'],
  preludeAct: [STATE_OPTS.STATE_ACT, '_ = fetchA(p);\n  _ = quietCell(p);'],
  preludeRO: [STATE_OPTS.STATE_RO, '_ = fetchB(p);'],
};
/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
export const WGSL_CHECK = Object.entries(PROBES).map(([name, [opts, body]]) => ({
  name, kind: 'compute', tool: true,
  code: (g) => `${prelude(g, opts)}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let p = cellOf(id.x % SLOTS);
  ${body}
}`,
  layouts: () => [LAYOUT.TABLES, stateLayout(opts)],
}));

