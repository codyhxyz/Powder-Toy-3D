import { particleOwnershipWGSL } from './hybrid/particles.js';
import { prelude, STATE_OPTS, LAYOUT, STAGE, BRICK, gridDims } from './common.js';
import { materialsGLSL, CHANNELS, MEDIA } from '../gfx/materials.js';
import { blendFixedFrames } from '../gfx/pacing.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { JOIN_REACH } from './gfx/liquidDetail.js';

// Render fields: continuous versions of the blocky state, rebuilt once per
// frame for the renderer only (the simulation never reads them).
//
// 1. EMA pass: per cell, one-hot occupancy of each smooth-surface channel,
//    media densities and flame temperature, blended toward the previous frame's values
//    (temporal smoothing, so cells swapping every sim step don't shimmer).
// 2. Three separable 5-tap Gaussian passes (x, y, z) with a per-channel
//    radius. The last pass normalises by the blurred "non-crisp" weight, so
//    walls, the floor and the box sides count neither way: a liquid film one
//    cell deep keeps its height, and surfaces meet walls at a clean angle.
//
// 3. Thin-feature boost: three separable passes over the 3-cell
//    neighbourhood (x, y, z) smooth the cubic channels (liquids) with the
//    B-spline's lattice weights, which is what the tracer's cubic sample reads
//    at a cell centre (other channels pass through), and find whether the
//    channel holds any of the 3³ cells right now. Then one pass finds each
//    channel's local peak of that over the 3³ cells (the separable x, y, z
//    maximum the WebGL build ran as three more passes, fused: a maximum is
//    exact in any order, docs/webgpu.md E). Next to current matter, a feature
//    whose peak is under the channel's bulk peak (gfx/materials.js bulkPeak,
//    bulkPeakCubic) is scaled up so its surface sits THIN_RADIUS from the cell
//    centre instead of blurring away: lone grains and droplets, one-cell
//    trunks, films, streams. Ghosts of cells that moved on hold no matter now,
//    so they still fade with the EMA.
//
// Pours (jetWGSL): the sim pours a stream as parcels a few cells apart along
// one path, which drawn as they are make a dotted line of glass beads. While
// the whitewater runs (gfx/foam.js), its aeration field marks the parcels
// that follow another's path and the wakes they are following
// (shaders/gfx/liquidDetail.js, the aeration model: pours). Those cells are
// drawn as liquid at full occupancy at once (the EMA pass) and count as
// current matter for the boost, so a pour is one rope of clear water a cell
// across along the path its parcels really take. Nothing else changes: a lone
// parcel, a falling blob or spray has no such wake and looks as it always did.
//
// Channels (vec4f): surface = liquid, molten, granular, organic; media =
// smoke, steam, fire, flame temperature; non-crisp weight, one copy per
// surface channel since each channel has its own blur radius (the media share
// the liquid kernel and its weight).
// Final output, three rgba16float 3D textures the renderer samples with
// hardware trilinear filtering (docs/webgpu.md W14): fieldSurf = surface φ
// (0.5 is the surface), fieldMedia = media densities, fieldThin = the thin
// mask, rising from 0 to 1 with a channel's boost (THIN_MASK_LO..HI). Only
// cubic channels need it: the tracer reads them cubic only there (bulk
// surfaces read the same either way, and trilinear is 8x cheaper).
//
// Every stage is a compute kernel over a brick list (src/derived.js): a
// 64-thread workgroup per listed brick, a thread per cell. In between, the
// stages keep their values in storage buffers of u32 words, one plane of
// SLOTS words per vec4f (word k of slot s at k·SLOTS + s), packed as the
// WebGL build's targets held them (docs/webgpu.md E): pack4x8unorm where the
// target was RGBA8 (the EMA, the blur's and the boost's scratch),
// pack2x16float where it was half float (the normalised blur).

// ---- the dirty sets (docs/scaling.md D9, docs/webgpu.md E) ----
// The passes run only over the bricks that may have changed (src/derived.js
// updateDirty; shaders/passes.js dirtyFrag builds the lists):
//   EMA     the EMA may still change: the brick changed within the last
//           FIELD_EMA_SETTLE derived frames
//   FIELDS  the final fields and the brick map may change: an EMA brick
//           within FIELDS_DILATE bricks (FIELD_REACH); the blur runs here too
//   WORK    the boost's smoothing must run: an EMA brick within WORK_DILATE
//           (their scratch's reach on top)
// Each list is one run of brick numbers in the lists buffer (dirtyLists).
//
// Within a listed brick a pass computes only the cells a later pass reads
// (COVER below), so a WORK brick at the list's outer ring computes a shell a
// cell or two deep, not its 64 cells, and the blur runs over the 27 FIELDS
// bricks of a changed brick, not the 125 WORK ones. Every reach is at most a
// brick, so a brick's 3³ neighbourhood decides which of its cells a pass
// needs: the dirty pass leaves each brick two 27-bit masks, of its neighbours
// that are EMA bricks and of those that are FIELDS bricks (dirtyLists emask,
// fmask). Exact: every cell a pass reads was written this frame, or is a
// persistent buffer's (the EMA, the normalised blur) that holds what the pass
// before would write there again.
export const DIRTY = { EMA: 0, FIELDS: 1, WORK: 2 };
// Frames a cell's EMA keeps changing after its state last did: the slowest
// channel's blend reaches its 8-bit fixed point by then (gfx/pacing.js
// blendFixedFrames; 13 for the liquid's 0.35), and the EMA pass may skip it.
export const FIELD_EMA_SETTLE = Math.max(...[...new Set([...CHANNELS, ...MEDIA].map((c) => c.ema))].map(blendFixedFrames));

// Taps of the separable Gaussian (gfx/materials.js gauss5), centred: each pass
// reads BLUR_REACH cells to either side along its axis.
export const BLUR_TAPS = 5;
export const BLUR_REACH = (BLUR_TAPS - 1) / 2;
// The boost's stages as the WebGL build counted them: 0-2 the lattice
// smoothing (x, y, z), 3-5 the local peak (x, y, z), each reaching a cell to
// either side along its axis, so the whole boost reaches two along each axis.
// (Stages 3-5 are one kernel now, fieldPeakFrag, with the same reach.)
export const BOOST_STAGES = 6;
const AXES = 3;
const BOOST_STAGE_REACH = 1;
export const BOOST_REACH = (BOOST_STAGES / AXES) * BOOST_STAGE_REACH;
// Cells a change in the EMA (or the state) reaches into the final fields
// along each axis: the blur's taps, then the boost's stages.
export const FIELD_REACH = BLUR_REACH + BOOST_REACH;
// The passes between the EMA and the final fields share scratch buffers,
// which outside this frame's WORK bricks hold stale values: each must cover
// every cell the passes after it read. The first blur's output (x) is read
// farthest from a final field cell: along y (or z) by one more blur and the
// boost's stages.
export const FIELD_SCRATCH_REACH = BLUR_REACH + BOOST_REACH;
// The same reaches in bricks (shaders/passes.js dirtyFrag dilates by them).
export const FIELDS_DILATE = Math.ceil(FIELD_REACH / BRICK);
export const WORK_DILATE = Math.ceil((FIELD_REACH + FIELD_SCRATCH_REACH) / BRICK);

// A brick's age word (shaders/passes.js ageFrag): derived frames since it
// last changed in bits 0-7, and two bits for the bricks a window shift brings
// in (shaders/passes.js brickShiftFrag sets SHIFTED; the next age pass turns
// it into FRESH, which the EMA pass reads): their cells came from outside the
// window and have no history, so the EMA starts them over at their targets,
// as the WebGL build's EMA pass did for cells shifted in. CHANGED is a change
// the age pass noted just before a shift (its fold, tick 0): the writers'
// marks and the steps' `changed` map are where the brick was, so the shift
// carries the change in the brick's own word, and the next age pass counts it.
export const AGE = { MAX: 255, MASK: 255, FRESH: 256, SHIFTED: 512, CHANGED: 1024 };

// The lists buffer (src/derived.js), in u32 words: the three lists (a run of
// NBRICKS brick numbers each, in DIRTY order), their append counters, their
// lengths as the last dirty pass left them (what a kernel dispatched over a
// list reads), and each list's indirect dispatch arguments [x, y, z, pad]
// (fold()ed: a workgroup per entry), then the FIELDS list's again with a
// thread per entry (threads: the shadow map's tile marks, src/derived.js
// shadowTiles), then the GI's sources' and probes' (gi: shaders/gi.js giArgs
// writes them here, as their kernels write giSrc, which holds their lists:
// WebGPU won't take a buffer as a dispatch's arguments and its writable
// storage at once). Then a word per brick (brick number order): the mask of its
// 3³ neighbours that are EMA bricks (bit (x+1) + 3(y+1) + 9(z+1) for the
// neighbour at offset x, y, z) with GI_NEAR in bit GI_NEAR_BIT; and a word
// per brick, the mask of its neighbours that are FIELDS bricks.
export function dirtyLists(g) {
  const { nbricks } = gridDims(g), n = 3 * nbricks;
  return {
    list: (l) => l * nbricks, count: n, last: n + 4, args: n + 8, threads: n + 20, gi: n + 24,
    emask: n + 32, fmask: n + 32 + nbricks, words: n + 32 + 2 * nbricks,
  };
}
// The GI's view of recent change (shaders/gi.js giSelect): GI_NEAR marks a
// brick within GI_NEAR_DILATE bricks (at most WORK_DILATE: the dirty pass's
// own neighbourhood) of one that changed within GI_RECENT derived frames. Its
// probes are traced at the full rate and its sources every frame; the rest at
// a background rate. GI_RECENT is the derived passes' settle for the GI
// (app.js: settleFrames(GI_BLEND, 2)), so a probe near a change converges as
// it did when every probe was traced every other frame.
export const GI_NEAR_BIT = 31;
export const GI_NEAR_DILATE = 2;
export const GI_RECENT = 22;

// The cells each pass between the EMA and the peak computes, as reaches (per
// axis, in cells) from the bricks a mask holds: the final fields are written
// over the FIELDS bricks, so the boost's last stage covers them and a cell
// around (the peak's 3³ maximum), each earlier stage that and its
// successor's reach along its axis; the blur's last axis covers the cells
// whose normalised blur may change (within BLUR_REACH of an EMA brick: the
// blurred planes keep their values elsewhere), each earlier axis that and its
// successor's reach. The blur tests DL_EMASK, the boost DL_FMASK.
export const COVER = {
  blur: [[BLUR_REACH, 2 * BLUR_REACH, 2 * BLUR_REACH], [BLUR_REACH, BLUR_REACH, 2 * BLUR_REACH], [BLUR_REACH, BLUR_REACH, BLUR_REACH]],
  boost: [[1, 2, 2], [1, 1, 2], [1, 1, 1]],
};
if (Math.max(...COVER.blur.flat(), ...COVER.boost.flat()) > BRICK) throw new Error('shaders/fields.js COVER: a reach past a brick needs more than the 3³ masks');
// The early return of a pass over a list for the cells it needn't compute
// (pass: 'blur' or 'boost'; its stage is P.axis). After listMainWGSL.
const coverWGSL = (pass) => /* wgsl */ `
  var cover = array<vec3i, 3>(${COVER[pass].map((r) => `vec3i(${r.join(', ')})`).join(', ')});
  if (!reaches(dlist[${pass === 'blur' ? 'DL_EMASK' : 'DL_FMASK'} + b], p & vec3i(3), cover[P.axis])) { return; }`;

// The lists' WGSL: their offsets, the age bits and the dilations. Each kernel
// declares the buffer itself: read_write atomics where it appends, read-only
// where it is dispatched over a list.
export const dirtyListsWGSL = (g) => {
  const d = dirtyLists(g);
  return /* wgsl */ `
// ---- the dirty sets' lists (shaders/fields.js DIRTY, dirtyLists) ----
const LIST_EMA: u32 = ${DIRTY.EMA}u;
const LIST_FIELDS: u32 = ${DIRTY.FIELDS}u;
const LIST_WORK: u32 = ${DIRTY.WORK}u;
const DL_COUNT: u32 = ${d.count}u;   // words: the append counters, one per list
const DL_LAST: u32 = ${d.last}u;     // the lists' lengths
const DL_ARGS: u32 = ${d.args}u;     // the indirect arguments, four words per list
const DL_THREADS: u32 = ${d.threads}u;   // FIELDS's again, a thread per entry
const DL_GI: u32 = ${d.gi}u;         // the GI's sources' arguments, then its probes'
const DL_EMASK: u32 = ${d.emask}u;   // per brick: its neighbours that are EMA bricks, and GI_NEAR
const DL_FMASK: u32 = ${d.fmask}u;   // per brick: its neighbours that are FIELDS bricks
const GI_NEAR: u32 = ${(1 << GI_NEAR_BIT) >>> 0}u;
const GI_NEAR_DILATE: i32 = ${GI_NEAR_DILATE};
const GI_RECENT: u32 = ${GI_RECENT}u;
const AGE_MAX: u32 = ${AGE.MAX}u;
const AGE_MASK: u32 = ${AGE.MASK}u;
const AGE_FRESH: u32 = ${AGE.FRESH}u;
const AGE_SHIFTED: u32 = ${AGE.SHIFTED}u;
const AGE_CHANGED: u32 = ${AGE.CHANGED}u;
const EMA_SETTLE: u32 = ${FIELD_EMA_SETTLE}u;   // frames
const FIELDS_DILATE: i32 = ${FIELDS_DILATE};    // bricks
const WORK_DILATE: i32 = ${WORK_DILATE};
fn brickInGrid(b: vec3i) -> bool { return all(b >= vec3i(0)) && all(b < vec3i(BX, BY, BZ)); }
// Does the box of cells within r (per axis, at most BS) of local cell l (its
// place in its brick) meet a brick that mask m holds (a brick's 3³
// neighbours, DL_EMASK or DL_FMASK)? It reaches the neighbours at offsets
// floor((l - r) / BS) to floor((l + r) / BS) along each axis.
fn reaches(m: u32, l: vec3i, r: vec3i) -> bool {
  let lo = (l - r) >> vec3u(2u);
  let hi = (l + r) >> vec3u(2u);
  let row = ((2u << u32(hi.x - lo.x)) - 1u) << u32(lo.x + 1);   // those along x, in a row of the mask's 3 bits
  for (var z = lo.z; z <= hi.z; z++) {
    for (var y = lo.y; y <= hi.y; y++) {
      if (((m >> u32(3 * (y + 1) + 9 * (z + 1))) & row) != 0u) { return true; }
    }
  }
  return false;
}`;
};

// main() of a kernel dispatched over one of the lists: a workgroup per entry
// (fold()ed), a thread per cell of its brick. Declares e (the entry), b (the
// brick), s (the cell's slot) and p (the cell). A workgroup past the list's
// end returns, uniformly: the length comes from a read-only binding.
export const listMainWGSL = (list) => /* wgsl */ `@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let e = foldId(wg, nwg);
  if (e >= dlist[DL_LAST + ${list}]) { return; }
  let b = dlist[${list} * NBRICKS + e];
  let s = b * 64u + li;
  let p = cellOf(s);`;

// The group-2 layouts of the field kernels (src/derived.js makes them):
//   FIELD  the lists, a source and a destination (the blur, the boost's
//          later stages)
//   JET    the same and the aeration buffer (jetWGSL: the EMA pass, with the
//          lists, the ages and the EMA, which it updates in place; the
//          boost's stage 0)
//   PEAK   the lists, the boost's last smoothing stage, the normalised blur,
//          the three final fields as storage textures; and the aeration at
//          binding 6, which the peak no longer reads (the thin mask's y and z
//          stopped carrying falling water when main's pours replaced it: Sync
//          3). It stays in the layout so src/derived.js's peak group, which
//          binds it, still matches.
//   PAIR   a source and a destination
//   SHIFT  two of them (the window shift of the EMA and the normalised blur)
const ro = (binding) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } });
const rw = (binding) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } });
const out3d = (binding) => ({ binding, visibility: STAGE.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } });
const tex3d = (binding) => ({ binding, visibility: STAGE.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } });
// (shaders/passes.js builds its layouts from the same entries)
export const LAYOUT_ENTRY = { ro, rw, out3d, tex3d };
// where the aeration buffer is bound in JET (and PEAK, unread there)
const JET_BINDING = { JET: 3, PEAK: 6 };
export const FIELD_LAYOUT = {
  FIELD: [ro(0), ro(1), rw(2)],
  JET: [ro(0), ro(1), rw(2), ro(JET_BINDING.JET)],
  PEAK: [ro(0), ro(1), ro(2), out3d(3), out3d(4), out3d(5), ro(JET_BINDING.PEAK)],
  PAIR: [ro(0), rw(1)],
  SHIFT: [ro(0), rw(1), ro(2), rw(3)],
};
// The format of the final fields (src/derived.js allocates them).
export const FIELD_FORMAT = 'rgba16float';

// Domain parameters occupy the existing group-3 uniform; no extra bindings.
// The planner proves in-world reads are in scratch. Missing in-world input
// is a readiness error, never a boundary/zero sample.
const worldParamsCache = new Map();
export function worldFieldParams(base) {
  if (!worldParamsCache.has(base)) worldParamsCache.set(base, uniformStruct(`World${base.name}`,
    { ...Object.fromEntries(base.fields.map((f) => [f.name, f.type])),
      worldMin: 'vec3i', worldMax: 'vec3i', scratchOrigin: 'vec3i', lo: 'vec3i', hi: 'vec3i' }));
  return worldParamsCache.get(base);
}
function fieldDomain(code, base, domain) {
  if (domain === 'box') return code;
  if (domain !== 'world') throw new Error(`Unknown field domain: ${domain}`);
  const params = worldFieldParams(base);
  const helpers = /* wgsl */ `
fn fieldInWorld(c: vec3i) -> bool {
  let w = P.scratchOrigin + c;
  return all(w >= P.worldMin) && all(w < P.worldMax);
}
fn fieldClamp(c: vec3i) -> vec3i {
  return clamp(c, P.worldMin - P.scratchOrigin, P.worldMax - P.scratchOrigin - 1);
}
`;
  code = code.replace(base.wgsl, params.wgsl).replace(`P: ${base.name}`, `P: ${params.name}`);
  // Remove the Box-only incremental coverage optimization: transient normalized
  // planes are never persistent. Stage intervals replace COVER completely.
  for (const pass of ['blur', 'boost']) code = code.replace(coverWGSL(pass), '');
  code = code.replace('  let p = cellOf(s);', `  let p = cellOf(s);
  if (any(p < P.lo) || any(p >= P.hi) || !fieldInWorld(p)) { return; }`);
  code = code.replaceAll('if (!inGrid(c))', 'if (!fieldInWorld(c))')
    .replaceAll('if (!inGrid(q))', 'if (!fieldInWorld(q))')
    .replaceAll('if (inGrid(q))', 'if (fieldInWorld(q))')
    .replace('clamp(p + dir * i, vec3i(0), vec3i(NX, NY, NZ) - 1)', 'fieldClamp(p + dir * i)');
  return code + helpers;
}

// ---- pours (docs/webgpu.md G4; the header's paragraph above) ----
// Whitewater's aeration buffer (gfx/foam.js; its record: shaders/gfx/
// liquidDetail.js, the aeration model) holds both copies (copy c of slot s
// at c·SLOTS + s), per slot (x, y) and (z, w) as two pack2x16float words. A
// kernel's params carry aer: 0 while the field doesn't run (the Whitewater
// switch; a 16-byte stand-in is bound then), else 1 + its current copy (the
// aeration's ping-pong isn't the state's, so the header can't say).
// A record with y > 1.5 is a pour's parcel; y < 0 is a wake, −y its age
// (1 fading to 0) and xzw the way its maker went, a unit vector if the maker
// was a pour's parcel (half that if not).
const jetWGSL = (binding) => /* wgsl */ `
const JOIN_REACH: i32 = ${JOIN_REACH};   // cells behind a wake a pour's next parcel may be
@group(2) @binding(${binding}) var<storage, read> aer: array<vec2u>;
fn aerAt(c: vec3i) -> vec4f {
  if (!inGrid(c)) { return vec4f(0.0); }
  let w = aer[(P.aer - 1u) * SLOTS + slotOf(c)];
  return vec4f(unpack2x16float(w.x), unpack2x16float(w.y));
}
// a pour's parcel, or a wake one left with another coming up behind it
// (along the way it went)
fn jetAt(p: vec3i) -> bool {
  if (P.aer == 0u) { return false; }
  let f = aerAt(p);
  if (f.y > 1.5) { return true; }
  if (f.y >= 0.0 || dot(f.xzw, f.xzw) < 0.5) { return false; }   // (a wake a pour's parcel left: its way is a unit vector)
  for (var k = 1; k <= JOIN_REACH; k++) {
    // (round: the GLSL's, whose ties may go either way; WGSL's go to even)
    let b = aerAt(p - vec3i(round(f.xzw * f32(k))));
    if (b.y > 1.5) { return true; }   // a pour's parcel
  }
  return false;
}`;

// ---- 1. the EMA ----
// emaS, emaM: each channel's blend weight (CHANNELS[i].ema, MEDIA[i].ema);
// reset: every cell starts over at its target (a load, a new smoothing:
// sim.fieldReset), as the cells of FRESH bricks do. aer: jetWGSL's.
export const EmaParams = uniformStruct('EmaParams', { emaS: 'vec4f', emaM: 'vec4f', reset: 'u32', aer: 'u32', particleSplit: 'u32', world: 'u32' });
export const fieldEmaFrag = (g, domain = 'box') => fieldDomain(/* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${materialsGLSL()}
${dirtyListsWGSL(g)}
// Rubble (STONE) is a heap of chips up to ~11 cm, so its surface is lumpy at
// the cell's scale, not smooth like sand: each cell fills its channel by a
// share of its own (from its seed, so it moves with the cell), and the blurred
// surface bulges over the full cells and dips over the sparse ones.
const RUBBLE_LUMP: f32 = 0.45;        // most a rubble cell's occupancy falls short of 1
const RUBBLE_LUMP_HASH: f32 = 7.13;   // spreads the seed (a.w) into a fresh uniform
${particleOwnershipWGSL}
${EmaParams.wgsl}
@group(3) @binding(1) var<uniform> P: EmaParams;
@group(2) @binding(0) var<storage, read> dlist: array<u32>;
@group(2) @binding(1) var<storage, read> age: array<u32>;
// the EMA, in place (each cell reads only its own history): planes surface,
// media, non-crisp weight (the weight has no history: it is the state's)
@group(2) @binding(2) var<storage, read_write> ema: array<u32>;
${jetWGSL(JET_BINDING.JET)}
${listMainWGSL('LIST_EMA')}
  let a = fetchAs(s);
  let id = eid(a);
  var sv = vec4f(0.0);
  var m = vec4f(0.0);
  let ch = SURFCH(id);
  let md = MEDIACH(id);
  let crisp = id != E_EMPTY && ch < 0 && md < 0;
  let particleOwned = P.particleSplit != 0u && hybridParticleOwns(p, P.world != 0u);
  if (ch >= 0 && !particleOwned) {
    var v = 1.0;
    if (id == E_STONE) { v = 1.0 - RUBBLE_LUMP * fract(fract(a.w) * RUBBLE_LUMP_HASH); }
    sv[ch] = v;
  }
  if (md == MD_SMOKE) { m.x = clamp(a.z, 0.0, 1.0); }
  else if (md == MD_STEAM) { m.y = HAZE(id); }   // droplets 1, a clear gas a faint haze (gfx/materials.js)
  else if (md == MD_FIRE) {
    m.z = mix(FIRE_BASE, 1.0, clamp(a.z, 0.0, 1.0));
    // flame temperature, weighted by density (see MEDIA in gfx/materials.js)
    m.w = m.z * clamp((a.y - AMBIENT) / HEAT_RANGE, 0.0, 1.0);
  }
  // a cell with history blends toward its target; one without takes it
  if (P.reset == 0u && (age[b] & AGE_FRESH) == 0u) {
    sv = mix(unpack4x8unorm(ema[s]), sv, P.emaS);
    m = mix(unpack4x8unorm(ema[SLOTS + s]), m, P.emaM);
  }
  // Ownership wins over old bulk history, before any spatial blur.
  if (particleOwned) { sv[ch] = 0.0; }
  if (jetAt(p) && !particleOwned) { sv.x = 1.0; }   // ownership wins over jet boost
  ema[s] = pack4x8unorm(sv);
  ema[SLOTS + s] = pack4x8unorm(m);
  var weight = vec4f(select(1.0, 0.0, crisp));
  // Liquid/media touch smooth solids too; their blur must not carve an air gap.
  if (ch > CH_LIQUID) { weight.x = 0.0; }
  ema[2u * SLOTS + s] = pack4x8unorm(weight);
}
`, EmaParams, domain);

// ---- 2. the blur ----
// w: per-tap weights, one per surface channel (media use .x); axis 0, 1, 2.
export const FieldBlurParams = uniformStruct('FieldBlurParams', { w: `array<vec4f, ${BLUR_TAPS}>`, axis: 'u32' });
// final: the last axis, which normalises and writes the blurred fields in
// half floats (planes φ.xy, φ.zw, media.xy, media.zw); else the source's
// three planes (surface, media, weight) blurred along one axis, in 8 bits.
export const fieldBlurFrag = (g, final, domain = 'box') => fieldDomain(/* wgsl */ `
${prelude(g, { state: false })}
${dirtyListsWGSL(g)}
const BLUR_TAPS: i32 = ${BLUR_TAPS};
const BLUR_REACH: i32 = ${BLUR_REACH};
// below this blurred non-crisp weight (deep inside crisp solids) there is nothing to normalise by
const NORM_FLOOR: f32 = 0.02;
${FieldBlurParams.wgsl}
@group(3) @binding(1) var<uniform> P: FieldBlurParams;
@group(2) @binding(0) var<storage, read> dlist: array<u32>;
@group(2) @binding(1) var<storage, read> src: array<u32>;
@group(2) @binding(2) var<storage, read_write> dst: array<u32>;
${listMainWGSL('LIST_FIELDS')}${coverWGSL('blur')}
  var dir = vec3i(0);
  dir[P.axis] = 1;
  var sv = vec4f(0.0);
  var m = vec4f(0.0);
  var d = vec4f(0.0);
  for (var i = 0; i < BLUR_TAPS; i++) {
    let q = p + dir * (i - BLUR_REACH);
    if (!inGrid(q)) { continue; }   // outside the box = crisp
    let t = slotOf(q);
    let w = P.w[i];
    sv += w * unpack4x8unorm(src[t]);
    m += w.x * unpack4x8unorm(src[SLOTS + t]);
    d += w * unpack4x8unorm(src[2u * SLOTS + t]);
  }
${final ? `  // normalise; deep inside crisp solids there is nothing to normalise by
  let ok = step(vec4f(NORM_FLOOR), d);
  let o0 = ok * sv / max(d, vec4f(NORM_FLOOR));
  let o1 = ok.x * m / max(d.x, NORM_FLOOR);
  dst[s] = pack2x16float(o0.xy);
  dst[SLOTS + s] = pack2x16float(o0.zw);
  dst[2u * SLOTS + s] = pack2x16float(o1.xy);
  dst[3u * SLOTS + s] = pack2x16float(o1.zw);` : `  dst[s] = pack4x8unorm(sv);
  dst[SLOTS + s] = pack4x8unorm(m);
  dst[2u * SLOTS + s] = pack4x8unorm(d);`}
}
`, FieldBlurParams, domain);

// ---- 3. the thin-feature boost ----
// Stages 0-2 (x, y, z): lattice smoothing of φ (stage 0 reads the blurred φ
// and the state, later stages their predecessor) and the occupancy, dilated:
// planes smoothed φ, occupancy, 8 bits each. Stage 0 is a kernel of its own
// (it reads the half-float blur and the state); stages 1 and 2 share one
// (fieldBoostFrag(g, 1), axis 1 then 2).
// s: per-channel centre weight of the lattice smoothing (1 = none). aer:
// jetWGSL's (stage 0 reads it: a pour's wake is current liquid).
export const BoostParams = uniformStruct('BoostParams', { s: 'vec4f', axis: 'u32', aer: 'u32', particleSplit: 'u32', world: 'u32' });
export const fieldBoostFrag = (g, stage, domain = 'box') => fieldDomain(/* wgsl */ `
${prelude(g, stage === 0 ? STATE_OPTS.STATE_RO : { state: false })}
${dirtyListsWGSL(g)}
${stage === 0 ? `${materialsGLSL()}\n${particleOwnershipWGSL}` : ''}
${BoostParams.wgsl}
@group(3) @binding(1) var<uniform> P: BoostParams;
@group(2) @binding(0) var<storage, read> dlist: array<u32>;
// ${stage === 0 ? 'the blurred fields (φ in planes 0 and 1)' : 'the last stage: smoothed φ, occupancy'}
@group(2) @binding(1) var<storage, read> src: array<u32>;
@group(2) @binding(2) var<storage, read_write> dst: array<u32>;
${stage === 0 ? jetWGSL(JET_BINDING.JET) : ''}
${listMainWGSL('LIST_WORK')}${coverWGSL('boost')}
  var dir = vec3i(0);
  dir[P.axis] = 1;
  var acc = vec4f(0.0);
  var occ = vec4f(0.0);
  for (var i = -1; i <= 1; i++) {
    // clamped to the edge, like the tracer's cubic sample
    let q = clamp(p + dir * i, vec3i(0), vec3i(NX, NY, NZ) - 1);
    let t = slotOf(q);
    var w = 0.5 * (1.0 - P.s);
    if (i == 0) { w = P.s; }
${stage === 0 ? `    acc += w * vec4f(unpack2x16float(src[t]), unpack2x16float(src[SLOTS + t]));
    let ch = SURFCH(eid(fetchAs(t)));
    if (ch >= 0 && !(P.particleSplit != 0u && hybridParticleOwns(q, P.world != 0u))) { occ[ch] = 1.0; }
    if (jetAt(q) && !(P.particleSplit != 0u && hybridParticleOwns(q, P.world != 0u))) { occ.x = 1.0; }` : `    acc += w * unpack4x8unorm(src[t]);
    occ = max(occ, unpack4x8unorm(src[SLOTS + t]));`}
  }
  dst[s] = pack4x8unorm(acc);
  dst[SLOTS + s] = pack4x8unorm(occ);
}
`, BoostParams, domain);

// The local peak and the boost (the WebGL build's stages 3-5): each channel's
// maximum of the smoothed field over the 3³ cells around (those in the grid),
// then the last stage's arithmetic, into the final fields; only FIELDS bricks
// are written. The maximum over the box ∩ grid is what three separable passes
// skipping out-of-grid taps per axis computed: a maximum is exact in any
// order. reach: cells to either side along each axis the maximum takes (1, 1,
// 1; tools/derived-check.mjs's separable reference gives 0, 0, 1 after its
// own x and y passes, fieldMaxFrag).
// aer: unread since Sync 3 (the layout's binding 6 above); src/derived.js still passes it.
export const PeakParams = uniformStruct('PeakParams', { bulk: 'vec4f', reach: 'vec3i', aer: 'u32' });
export const fieldPeakFrag = (g, domain = 'box') => fieldDomain(/* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${materialsGLSL()}
${dirtyListsWGSL(g)}
${PeakParams.wgsl}
@group(3) @binding(1) var<uniform> P: PeakParams;   // bulk: each channel's bulk peak
@group(2) @binding(0) var<storage, read> dlist: array<u32>;
@group(2) @binding(1) var<storage, read> src: array<u32>;       // stage 2: smoothed φ, occupancy
@group(2) @binding(2) var<storage, read> blurred: array<u32>;   // φ, media (half floats)
@group(2) @binding(3) var fieldSurf: texture_storage_3d<rgba16float, write>;
@group(2) @binding(4) var fieldMedia: texture_storage_3d<rgba16float, write>;
@group(2) @binding(5) var fieldThin: texture_storage_3d<rgba16float, write>;
${listMainWGSL('LIST_FIELDS')}
  var acc = vec4f(0.0);
  for (var z = -P.reach.z; z <= P.reach.z; z++) {
    for (var y = -P.reach.y; y <= P.reach.y; y++) {
      for (var x = -P.reach.x; x <= P.reach.x; x++) {
        let q = p + vec3i(x, y, z);
        if (inGrid(q)) { acc = max(acc, unpack4x8unorm(src[slotOf(q)])); }
      }
    }
  }
  let occ = unpack4x8unorm(src[SLOTS + s]);   // stage 2's, passed along
  let k = max(vec4f(1.0), P.bulk / max(acc, vec4f(THIN_MIN_PEAK)));
  let boosted = step(vec4f(0.5), occ);
  let phi = vec4f(unpack2x16float(blurred[s]), unpack2x16float(blurred[SLOTS + s]));
  let med = vec4f(unpack2x16float(blurred[2u * SLOTS + s]), unpack2x16float(blurred[3u * SLOTS + s]));
  var surf = phi * mix(vec4f(1.0), k, boosted);
  textureStore(fieldSurf, p, surf);
  textureStore(fieldMedia, p, med);
  textureStore(fieldThin, p, boosted * smoothstep(vec4f(THIN_MASK_LO), vec4f(THIN_MASK_HI), k));
}
`, PeakParams, domain);

// Test only (tools/derived-check.mjs): the WebGL build's separable peak
// stages 3 and 4, one axis each (the maximum along it, taps outside the grid
// skipped, the occupancy passed along), so the fused kernel can be held
// against them: fieldPeakFrag with reach (0, 0, 1) is then stage 5.
export const MaxParams = uniformStruct('MaxParams', { axis: 'u32' });
export const fieldMaxFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${dirtyListsWGSL(g)}
${MaxParams.wgsl}
@group(3) @binding(1) var<uniform> P: MaxParams;
@group(2) @binding(0) var<storage, read> dlist: array<u32>;
@group(2) @binding(1) var<storage, read> src: array<u32>;
@group(2) @binding(2) var<storage, read_write> dst: array<u32>;
${listMainWGSL('LIST_WORK')}
  var dir = vec3i(0);
  dir[P.axis] = 1;
  var acc = vec4f(0.0);
  for (var i = -1; i <= 1; i++) {
    let q = p + dir * i;
    if (inGrid(q)) { acc = max(acc, unpack4x8unorm(src[slotOf(q)])); }
  }
  dst[s] = pack4x8unorm(acc);
  dst[SLOTS + s] = src[SLOTS + s];
}
`;

// ---- the window's shift (docs/webgpu.md E, D8.12) ----
// The EMA follows its cells: cell p takes the history of p + shift, out of
// place (into a scratch that src/derived.js copies back). Cells shifted in
// from outside get none (their bricks are SHIFTED: the EMA starts them over).
// The normalised blur follows them in the same pass, into a scratch of its
// own (the blur reads it where it doesn't recompute it: COVER); the bricks
// shifted in and the faces' re-age, so its cells whose taps now reach past
// the grid's edge, or have no history, are recomputed.
export const FieldShiftParams = uniformStruct('FieldShiftParams', { shift: 'vec3i' });
export const fieldShiftFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${FieldShiftParams.wgsl}
@group(3) @binding(1) var<uniform> P: FieldShiftParams;
@group(2) @binding(0) var<storage, read> src: array<u32>;   // the EMA (3 planes)
@group(2) @binding(1) var<storage, read_write> dst: array<u32>;
@group(2) @binding(2) var<storage, read> blurSrc: array<u32>;   // the normalised blur (4 planes)
@group(2) @binding(3) var<storage, read_write> blurDst: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li);
  if (s >= SLOTS) { return; }
  let q = cellOf(s) + P.shift;
  let inside = inGrid(q);
  var t = 0u;
  if (inside) { t = slotOf(q); }
  for (var k = 0u; k < 3u; k++) {
    var w = 0u;
    if (inside) { w = src[k * SLOTS + t]; }
    dst[k * SLOTS + s] = w;
  }
  for (var k = 0u; k < 4u; k++) {
    var w = 0u;
    if (inside) { w = blurSrc[k * SLOTS + t]; }
    blurDst[k * SLOTS + s] = w;
  }
}
`;

// WEBGPU-STUB (docs/webgpu.md J3): the EMA is updated in place (each cell
// reads only its own history), so nothing copies it back.
export function fieldCopyFrag() { throw new Error('fieldCopyFrag removed in the WebGPU port: docs/webgpu.md E (fieldEmaFrag, in place)'); }
// WEBGPU-STUB (docs/webgpu.md J3): the field passes run over brick lists, not
// regions of a field atlas (docs/webgpu.md E).
export const FIELD_REGION_BRICKS = null;
// WEBGPU-STUB (docs/webgpu.md J3)
export const FIELD_FULL_SHARE = null;
// WEBGPU-STUB (docs/webgpu.md J3)
export function fieldRegions() { throw new Error('fieldRegions removed in the WebGPU port: docs/webgpu.md E (brick lists)'); }
// WEBGPU-STUB (docs/webgpu.md J3)
export function fieldRegionsGLSL() { throw new Error('fieldRegionsGLSL removed in the WebGPU port: docs/webgpu.md E (brick lists)'); }

// Ownership reads a 26-neighbour stencil, so a changed brick can change the
// ownership of cells in adjacent bricks. Dilate ages into existing scratch,
// never back into age (which would recursively spread dirtiness every frame).
export const particleAgeFrag = (g) => `
${prelude(g, { state: false })}
${dirtyListsWGSL(g)}
@group(2) @binding(0) var<storage, read_write> age: array<u32>;
@group(2) @binding(1) var<storage, read_write> expanded: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
  @builtin(local_invocation_index) li: u32) {
  let b = foldThread(wg, nwg, li);
  if (b >= NBRICKS) { return; }
  let p = brickCoord(b);
  var recent = age[b] & AGE_MASK;
  for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let q = p + vec3i(x,y,z);
    if (all(q >= vec3i(0)) && all(q < vec3i(BX,BY,BZ))) {
      recent = min(recent, age[brickId(q)] & AGE_MASK);
    }
  } } }
  expanded[b] = (age[b] & ~AGE_MASK) | recent;
}`;

// windowed: a world's grid only; tool: built only by the tools that run it
// (docs/webgpu.md B5; src/derived.js builds them on first use otherwise).
const perList = (g) => fold(gridDims(g).nbricks);   // the longest list: every brick
const fieldLayouts = (state, group = FIELD_LAYOUT.FIELD) => () => [LAYOUT.TABLES, state ? LAYOUT.STATE_RO : 'EMPTY', group];
/**
 * tools/check-wgsl.mjs, and the pipelines a grid's derived passes need (the
 * start menu's warm-up, docs/webgpu.md B5).
 */
export const WGSL_CHECK = [
  { name: 'particleAges', kind: 'compute', code: particleAgeFrag, layouts: () => [LAYOUT.TABLES, 'EMPTY', [0, 1].map(binding => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }))], dispatch: (g) => fold(Math.ceil(gridDims(g).nbricks / 64)) },
  { name: 'fieldEma', kind: 'compute', code: fieldEmaFrag, layouts: fieldLayouts(true, FIELD_LAYOUT.JET), dispatch: perList },
  { name: 'fieldBlur', kind: 'compute', code: (g) => fieldBlurFrag(g, false), layouts: fieldLayouts(false), dispatch: perList },
  { name: 'fieldFinal', kind: 'compute', code: (g) => fieldBlurFrag(g, true), layouts: fieldLayouts(false), dispatch: perList },
  { name: 'fieldBoost0', kind: 'compute', code: (g) => fieldBoostFrag(g, 0), layouts: fieldLayouts(true, FIELD_LAYOUT.JET), dispatch: perList },
  { name: 'fieldBoost', kind: 'compute', code: (g) => fieldBoostFrag(g, 1), layouts: fieldLayouts(false), dispatch: perList },
  { name: 'fieldPeak', kind: 'compute', code: fieldPeakFrag, layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, FIELD_LAYOUT.PEAK], dispatch: perList },
  { name: 'fieldShift', kind: 'compute', code: fieldShiftFrag, layouts: () => [LAYOUT.TABLES, 'EMPTY', FIELD_LAYOUT.SHIFT],
    layoutNames: [null, null, 'DERIVED_SHIFT'], dispatch: (g) => fold(Math.ceil(gridDims(g).slots / 64)), windowed: true },
  { name: 'fieldMax', kind: 'compute', code: fieldMaxFrag, layouts: fieldLayouts(false), dispatch: perList, tool: true },
];
