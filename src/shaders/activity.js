import { prelude, STATE_OPTS, LAYOUT, STAGE, sleepUnitOf, gridDims, actLayout, ACT_COUNTS, ACT_MAP } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold, MAX_WORKGROUPS } from '../gpu/kernels.js';

// Activity map: which 4×4×4 bricks the simulation may skip.
//
// Most of the box is quiet air or resting matter, and stepping it is pure
// cost. A cell is *inert* when stepping it would change nothing but drift
// below the tolerances in physics.js (rest states):
//   - air near ambient (AIR_REST_T), with no pressure and no wind beyond the
//     air's own jitter;
//   - a solid, or a powder or liquid at rest: velocity exactly 0 (react.js
//     holds resting matter still) and nowhere to go by the move pass's own
//     canMove, neither the cell below nor the lower ring it could topple
//     into, nor for a liquid its four sides;
//   - nothing that reacts: no gas, nothing burning or hot enough to light
//     the air, melting, setting, freezing, boiling or banking latent heat
//     (elements.js cold/hot included), nothing next to acid or caustic gas, no plant by
//     water, no clone by air, no explosive touching something past its
//     ignition point, no cell beside a reaction partner (elements.js
//     REACTIONS) whose temperature gate the pair passes, nothing that can
//     move touching void, nothing a singularity touches (it never rests
//     itself: it holds a vacuum), no moss or fungus whose damp is settling or
//     that can grow (growers, below);
//   - thermally quiet: within MATTER_REST_T of each matter face neighbour,
//     and within AIR_REST_T of ambient where it touches air.
// A change a neighbour sets off on its own (a flame catching in the air by
// burning wood) makes that neighbour non-inert instead.
// A brick is *quiet* (skipped) when it and its 26 neighbours are inert. Then
// anything that could change it is more than BS cells away, and a change
// travels at most INFLUENCE_PER_STEP cells per step (the move pass shifts a
// cell by one, then the react pass reads its neighbours), so the map holds for
// ACTIVITY_PERIOD steps. Skipped cells keep their state exactly; when matter
// or heat comes near, the brick wakes up before it can arrive. What skipping
// leaves out is the sub-tolerance drift: heat across faces within the
// tolerances (bounded in physics.js), the last of a pressure below REST_P
// decaying, the air's brownian shuffle.
//
// The test has two halves: inertSelf, on the cell's own state
// (shaders/common.js), and inertNear, on its neighbours' states A. Rather than
// run both over the whole state per brick, the build reduces the activity
// flags every state writer leaves beside a cell (common.js FLAG): SELF is
// always exact, and NEAR is the react pass's evaluation of inertNear, which
// may have seen a neighbour before the step changed it. So NEAR is trusted
// only where nothing a brick's neighbour tests read is DIRTY (changed since
// the last map in a way they read), and inertNear is rerun from the state
// where something is. A brick that was quiet all period has NEAR set by react
// (its cells were inert when the map was built, and are unchanged), so the
// result is the test above, exactly: inertRefFrag runs it the old way, for
// tools/activity-check.mjs to compare.

// Cells a change can travel in one step: one by moving, one by the react pass's stencil.
export const INFLUENCE_PER_STEP = 2;
// Steps an activity map stays valid: its one-brick halo, crossed at the speed above.
export const activityPeriod = (brickSize) => Math.floor(brickSize / INFLUENCE_PER_STEP);

// The neighbour half of the rest test, for cell c holding a, given its face
// neighbours' states A in FACES order (nA; those outside the box are skipped:
// the box walls insulate, never react and can't be entered). It reads the
// lower ring itself, from the pass's input state (fetchA). (WGSL; the name is
// the GLSL version's, docs/webgpu.md W2.)
export const inertNearGLSL = /* wgsl */ `
// A cell's face neighbours, in this order: +x, -x, +y, -y, +z, -z (axis i >> 1,
// toward - when i is odd). Arithmetic, not a table (docs/webgpu.md C6).
fn FACES(i: i32) -> vec3i {
  var d = vec3i(0);
  d[i >> 1u] = 1 - 2 * (i & 1);
  return d;
}

// What acid eats (react.js): all matter that isn't acid-proof (elements.js
// acidProof: acid itself, walls, glass, water). Never air or gases.
fn acidEats(j: i32) -> bool { return KIND(j) != K_EMPTY && KIND(j) != K_GAS && !ACIDPROOF(j); }

// Does reaction r's temperature gate pass for a pair at Ta and Tb? It reads
// the hotter cell: a hot spot lights a mixture, and too hot a cell stops it.
// (rxAt, the reaction lookup, is the element tables': shaders/common.js.)
fn rxGate(r: i32, Ta: f32, Tb: f32) -> bool {
  let Th = max(Ta, Tb);
  return Th >= RX(r).y && Th <= RX(r).z;
}

// Growers (react.js; physics.js DAMP_REACH): moss and fungus keep their damp
// in their ctype. A grower's damp, given its temperature and face neighbours.
fn grower(j: i32) -> bool { return j == E_MOSS || j == E_FUNGUS; }
fn mossBed(j: i32) -> bool { return j == E_ROCK || j == E_BASALT || j == E_STONE || j == E_LIMESTONE || j == E_SANDSTONE; }   // the rock moss creeps over
fn fungusFood(j: i32) -> bool { return j == E_WOOD || j == E_SAWDUST || j == E_PLANT; }                     // what fungus rots
fn dampOf(T: f32, nA: ptr<function, array<vec4f, 6>>) -> f32 {
  if (T >= DAMP_DRY_T) { return 0.0; }
  var h = 0.0;
  for (var i = 0; i < 6; i++) {
    let j = eid((*nA)[i]);
    if (j == E_WATER) { return DAMP_REACH; }
    if (grower(j)) { h = max(h, floor((*nA)[i].w) - 1.0); }
  }
  return h;
}
// Moss creeps into an air cell that touches damp moss and bare rock on faces
// across from each other's axis (so the mat follows the rock's surface).
// wet and bed: which axes (x, y, z) hold them.
fn mossSite(wet: vec3<bool>, bed: vec3<bool>) -> bool {
  return (wet.x && (bed.y || bed.z)) || (wet.y && (bed.x || bed.z)) || (wet.z && (bed.x || bed.y));
}

fn inertNear(c: vec3i, a: vec4f, nA: ptr<function, array<vec4f, 6>>) -> bool {
  let id = eid(a);
  if (id == E_EMPTY) { return true; }   // what changes air is a neighbour that isn't inert
  let k = KIND(id);
  let T = a.y;
  let d = densityOf(id, T);
  // a grower: its damp still settling, or damp with somewhere to grow (for
  // moss, an air face whose other faces, across its axis, touch bare rock:
  // cells along the edges of this one, read from the pass's input state)
  if (grower(id)) {
    let h = floor(a.w);
    if (dampOf(T, nA) != h) { return false; }
    if (h >= 1.0) {
      for (var i = 0; i < 6; i++) {
        let q = c + FACES(i);
        if (!inGrid(q)) { continue; }
        let j = eid((*nA)[i]);
        if (id == E_FUNGUS && fungusFood(j)) { return false; }
        if (id == E_MOSS && j == E_EMPTY) {
          for (var m = 0; m < 6; m++) {
            let r = q + FACES(m);
            if ((m >> 1u) != (i >> 1u) && inGrid(r) && mossBed(eid(fetchA(r)))) { return false; }
          }
        }
      }
    }
  }
  for (var i = 0; i < 6; i++) {
    let f = FACES(i);
    if (!inGrid(c + f)) { continue; }
    let n = (*nA)[i];
    let j = eid(n);
    // thermally quiet; a face touching air carries heat at air's conductance, so it takes air's tolerance
    // (a face with no conductance, a temperature sensor's, carries none)
    if (min(COND(id), COND(j)) > 0.0) {
      if (j == E_EMPTY) {
        if (abs(T - AMBIENT) > AIR_REST_T) { return false; }
      } else if (abs(T - n.y) > MATTER_REST_T) { return false; }
    }
    if (!electricQuietNear(id, a, j, n)) { return false; }   // src/electricity.js
    // acid, caustic gas (elements.js acid)
    if (ACIDIC(j)) {
      if (acidEats(id)) { return false; }
    } else if (ACIDIC(id) && acidEats(j)) { return false; }
    if ((id == E_WATER && j == E_PLANT) || (id == E_PLANT && j == E_WATER)) { return false; }
    if (fungusFood(id) && j == E_FUNGUS && floor(n.w) >= 1.0 && T < DAMP_DRY_T) { return false; }   // damp fungus rots it
    if (id == E_CLONE && (j == E_EMPTY || (a.w < 1.0 && cloneable(j)))) { return false; }   // (cloneable: src/electricity.js)
    // an explosive with an ignition point: a hot touch sets it off
    if (INTO(id)[PH_BLAST] >= 0 && IGNITE(id) > 0.0 && !isGasLike(j) && n.y >= IGNITE(id)) { return false; }
    // a reaction partner past its temperature gate (one below it lets both rest)
    let rx = rxAt(id, j);
    if (rx > 0 && rxGate((rx - 1) >> 1u, T, n.y)) { return false; }
    if (j == E_VOID && k != K_SOLID) { return false; }   // void drains it (react.js)
    if (j == E_SINGULARITY && id != E_WALL && id != E_VOID) { return false; }   // it may be swallowed (react.js singEats)
    // a fuse lights from a lit fuse beside it, or a hot touch (react.js)
    if (id == E_FUSE && ((j == E_FUSE && n.z < 1.0) || (!isGasLike(j) && n.y >= IGNITE(id)))) { return false; }
    // a powder or liquid: nowhere to fall, nor for a liquid to flow sideways
    let way = f.y < 0 || (k == K_LIQUID && f.y == 0);
    if (k != K_SOLID && way && canMove(id, j, d, densityOf(j, n.y), select(2, 0, f.y < 0))) { return false; }
  }
  if (k == K_SOLID) { return true; }
  // ... nor to topple into, in the rest of the lower ring
  for (var z = -1; z <= 1; z++) {
    for (var x = -1; x <= 1; x++) {
      let q = c + vec3i(x, -1, z);
      if ((x == 0 && z == 0) || !inGrid(q)) { continue; }
      let n = fetchA(q);
      let j = eid(n);
      if (canMove(id, j, d, densityOf(j, n.y), 0)) { return false; }
    }
  }
  return true;
}

// inertNear of cell c, its neighbours read from the pass's input state.
fn inertNearHere(c: vec3i) -> bool {
  var nA: array<vec4f, 6>;
  for (var i = 0; i < 6; i++) {
    let q = c + FACES(i);
    if (inGrid(q)) { nA[i] = fetchA(q); } else { nA[i] = vec4f(0.0); }
  }
  return inertNear(c, fetchA(c), &nA);
}
`;

// WEBGPU-STUB (docs/webgpu.md J3): quietCell is the prelude's now, with the
// act binding (shaders/common.js, STATE_OPTS with act). Kept for the modules
// that paste it until their units port them.
export const quietGLSL = '';

// ---- sleeping (docs/webgpu.md W12, D4, D5) ----
// The steps run over lists the GPU builds with every activity map, one entry
// per sleeping unit (a brick: SLEEP_UNIT in shaders/common.js), dispatched
// indirectly:
//   AWAKE  this map's steps may change the unit: a brick that isn't quiet lies
//          in it, or just below it along x, y or z (a Margolus block reaches one
//          cell past its home brick at partition offset 1: shaders/move.js)
//   DRAWN  the steps run it (react writes every cell of it, the move runs
//          every block with a cell in it): AWAKE, or written since the last map
//          by something other than a step (the writers' marks, D6), or drawn
//          under the last map and not yet settled (the run counter below)
//   MOVE   the move's list per partition offset: at 0 every block lies in its
//          home brick, so MOVE0 = DRAWN; at 1 a block reaches into the next
//          brick along each axis, so MOVE1 = DRAWN dilated a unit toward -x,
//          -y, -z (a superset; the move trims it per block)
// The settle rule (D5.3). Under a map that leaves a unit asleep (not AWAKE),
// its steps leave its cells as they are: the move runs no block that changes
// one (a quiet base block only settles flags) and react writes each one back
// as quiet, with its flags settled: its own, NEAR, and DIRTY as the move left
// it, which the map's first step clears. So after two such steps (in one map
// or two: a unit's first such step is always a map's first, which clears
// DIRTY) both state copies hold the unit's cells with settled flags. The run
// counter counts them: steps of maps under which the unit was drawn and not
// AWAKE, reset by a write into it (forced) or by its being AWAKE. A unit stays
// DRAWN until the counter reaches SUPER_SETTLE_STEPS. Writes elsewhere don't
// touch it, so unlike docs/scaling.md D8's rule a write between steps doesn't
// count as settling, and a one-step map counts its one step.
// The invariant every pass keeps: in a unit not DRAWN under the current map,
// both copies hold the same A, B and F, and F is settled (own flags | NEAR,
// DIRTY clear). tools/skip-model.mjs checks the rule on a CPU model at both
// unit sizes, with its negative controls.
// WEBGPU-STUB (docs/webgpu.md J3): the supertile map's channels are gone; the
// object stays for the profiler until its unit ports it.
export const SUPER_MAP = { AWAKE: 0, STEPS: 1, DRAWN: 2, BLOCKS: 3 };
// Steps under maps that settle both copies of a unit sleeping under them (above).
export const SUPER_SETTLE_STEPS = 2;
// WEBGPU-STUB (docs/webgpu.md J3): one full-screen quad or regions is gone
// (an indirect dispatch has no instancing to trade against).
export const STEP_FULL_SHARE = 0.9;

// The build's parameters, one struct for all its kernels (each reads its own).
export const BuildParams = uniformStruct('BuildParams', {
  full: 'u32',       // inertList: list every brick (a full rebuild: load, shift, forceAll, a skipQuiet toggle, a new grid)
  enabled: 'u32',    // quiet: skipQuiet (0 clears the quiet map)
  rays: 'u32',       // quiet: the rays layer is active (rayBricks holds its bricks)
  carry: 'u32',      // quiet: note the outgoing quiet map in `changed` first (steps used it since the derived passes)
  noted: 'u32',      // quiet: `changed` holds a map noted since the derived passes (else the first note overwrites)
  forceAll: 'u32',   // drawn: every unit was written since the last map
  nPrev: 'u32',      // drawn: steps under the last map (the run counter's increment)
  all: 'u32',        // drawn: skipSleeping = false, every unit DRAWN
  slot: 'u32',       // args: the counts' first word in the args buffer (a result ring slot)
  list: 'u32',       // permute: the list (ACT_COUNTS)
  order: 'u32',      // permute: 1 reverse, 2 shuffle
  seed: 'u32',       // permute: the shuffle's seed
});

// The indirect arguments live in a buffer of their own (B6: a dispatch can't
// take its arguments from a buffer it writes, and the inert kernel, dispatched
// over the INERT list, writes the act buffer): the byte offset of each
// dispatch's [x, y, z]. After them, the activity counts' result ring
// (gpu.readback.ring over this buffer: B7, D4): nAWAKE, nDRAWN, nMOVE1,
// nINERT per build.
export const ARGS = { INERT: 0, REACT: 16, MOVE0: 32, MOVE1: 48, AER: 64, RING: 128 };   // (AER: the aeration list's, G4)
export const COUNTS_SLOTS = 64;      // slots of the counts ring
export const COUNTS_BYTES = 16;
// (+1: the slot a build writes when nothing reads its counts)
export const ARGS_BYTES = ARGS.RING + (COUNTS_SLOTS + 1) * COUNTS_BYTES;
// INERT entries one inert workgroup takes: more than one only when the list
// may be longer than a dispatch's limit (the giant volcano's window).
export const inertFold = (g) => Math.ceil(gridDims(g).nbricks / MAX_WORKGROUPS);

// Group 2 of the build kernels (docs/webgpu.md C4): the indirect arguments
// (read_write) and the rays layer's brick bitset (read). The inert kernel,
// dispatched over the arguments, binds none (L.EMPTY).
export const BUILD_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
];
// The reference's output (inertRefFrag): one word per brick.
export const REF_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];

const buildHead = (g, { args = true, debug = false } = {}) => /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_BUILD, debug })}
${BuildParams.wgsl}
@group(3) @binding(1) var<uniform> P: BuildParams;
${args ? `@group(2) @binding(0) var<storage, read_write> args: array<atomic<u32>>;
@group(2) @binding(1) var<storage, read> rayBricks: array<u32>;   // a bit per brick: a fast particle is in it (raysLayer.js)` : ''}
const ARGS_INERT: u32 = ${ARGS.INERT / 4}u;   // words
const ARGS_REACT: u32 = ${ARGS.REACT / 4}u;
const ARGS_MOVE0: u32 = ${ARGS.MOVE0 / 4}u;
const ARGS_MOVE1: u32 = ${ARGS.MOVE1 / 4}u;
const INERT_FOLD: u32 = ${inertFold(g)}u;   // INERT entries per inert workgroup
const MAX_WG: u32 = ${MAX_WORKGROUPS}u;
const SUPER_SETTLE_STEPS: u32 = ${SUPER_SETTLE_STEPS}u;
fn actStore(i: u32, v: u32) { atomicStore(&act[i], v); }
// marks.act's bit for brick id: a writer changed it since the last map (D6)
fn markedAct(id: u32) -> bool { return (atomicLoad(&marks[MARK_ACT + (id >> 5u)]) & (1u << (id & 31u))) != 0u; }
// Appends to a list, one global atomic per workgroup (docs/webgpu.md D4):
// the workgroup counts its entries in workgroup memory, one thread adds them
// to the list's count, then each thread writes its entry. Call it from uniform
// control flow (it has barriers). Returns where this workgroup's entries
// start in the list and where they end.
var<workgroup> wgCount: atomic<u32>;
var<workgroup> wgSpan: vec2u;
fn append(on: bool, entry: u32, list: u32, cnt: u32, li: u32) -> vec2u {
  var mine = 0u;
  if (on) { mine = atomicAdd(&wgCount, 1u); }
  workgroupBarrier();
  if (li == 0u) {
    let n = atomicLoad(&wgCount);
    let base = atomicAdd(&act[ACT_COUNT + cnt], n);
    wgSpan = vec2u(base, base + n);
    atomicStore(&wgCount, 0u);
  }
  let span = workgroupUniformLoad(&wgSpan);
  if (on) { actStore(list + span.x + mine, entry); }
  return span;
}`;

// inertList: one thread per brick. Lists brick b for the inert kernel if a
// brick of b + {-1, 0, 1}³ was DRAWN under the last map or written since
// (marks.act), or for a full rebuild: flags change nowhere else, and one brick
// of dilation covers the neighbour tests' reach (one cell: the faces, the
// lower ring, the halo the flags are scanned over). A brick not listed keeps
// its inert bit. Also sizes the inert kernel's dispatch.
export const inertListFrag = (g) => /* wgsl */ `
${buildHead(g)}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = foldThread(wg, nwg, li);
  var on = false;
  if (b < NBRICKS) {
    on = P.full != 0u;
    if (!on) {
      let bc = brickCoord(b);
      for (var z = -1; z <= 1; z++) {
        for (var y = -1; y <= 1; y++) {
          for (var x = -1; x <= 1; x++) {
            let n = bc + vec3i(x, y, z);
            if (!inBricks(n)) { continue; }
            let nid = brickId(n);
            if (drawnUnit(unitOfBrick(nid)) || markedAct(nid)) { on = true; }
          }
        }
      }
    }
  }
  let span = append(on, b, ACT_INERTL, CNT_INERT, li);
  // the inert dispatch: ceil(entries / INERT_FOLD) workgroups (the largest
  // end a workgroup reached is the list's length)
  if (li == 0u) { atomicMax(&args[ARGS_INERT], (span.y + INERT_FOLD - 1u) / INERT_FOLD); }
}
`;

// inert: a workgroup per INERT entry (indirect), a thread per cell: AND and OR
// of the brick's 64 flags in workgroup memory, the halo's DIRTY scan split
// across the threads; where the flags don't decide it, each matter cell
// redoes inertNearHere from the state. The decision of the old inert,
// inertRows and inertJoin passes in one (docs/webgpu.md D4).
export const inertFrag = (g, { debug = false } = {}) => /* wgsl */ `
${buildHead(g, { args: false, debug })}
${inertNearGLSL}
const UNDECIDED: u32 = 2u;
var<workgroup> wgN: u32;
var<workgroup> wgEvery: atomic<u32>;
var<workgroup> wgSome: atomic<u32>;
var<workgroup> wgHalo: atomic<u32>;
var<workgroup> wgFail: atomic<u32>;
var<workgroup> wgState: u32;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { wgN = atomicLoad(&act[ACT_COUNT + CNT_INERT]); }
  let n = workgroupUniformLoad(&wgN);
  for (var r = 0u; r < INERT_FOLD; r++) {
    let e = foldId(wg, nwg) * INERT_FOLD + r;
    if (e >= n) { break; }
    if (li == 0u) {
      atomicStore(&wgEvery, 0xffffffffu);
      atomicStore(&wgSome, 0u);
      atomicStore(&wgHalo, 0u);
      atomicStore(&wgFail, 0u);
    }
    workgroupBarrier();
    let b = actLoad(ACT_INERTL + e);
    let o = brickCoord(b) * BS;
    let p = cellOf(b * 64u + li);
    let f = fetchF(p);
    atomicAnd(&wgEvery, f);
    atomicOr(&wgSome, f);
    // Is anything the brick's neighbour tests read outside it (within a cell
    // of it: its faces' cells and the lower rings) dirty? The 6³ cube around
    // the brick less its 4³ core, four cells a thread.
    for (var t = li; t < 216u; t += 64u) {
      let l = vec3i(i32(t % 6u), i32((t / 6u) % 6u), i32(t / 36u)) - 1;
      if (all(l >= vec3i(0)) && all(l < vec3i(BS))) { continue; }   // the brick itself
      let q = o + l;
      if (inGrid(q) && (fetchF(q) & FLAG_DIRTY) != 0u) { atomicOr(&wgHalo, 1u); }
    }
    workgroupBarrier();
    if (li == 0u) {
      let every = atomicLoad(&wgEvery);
      let some = atomicLoad(&wgSome);
      var st = UNDECIDED;   // the matter cells redo their neighbour tests from the state
      if ((every & FLAG_SELF) == 0u) { st = 0u; }         // a cell moves, reacts, or is off its rest temperature
      else if ((some & FLAG_MATTER) == 0u) { st = 1u; }   // only air: nothing to test against the neighbours
      // nothing the neighbour tests read changed since the last map: their NEAR stands
      else if ((some & FLAG_DIRTY) == 0u && atomicLoad(&wgHalo) == 0u) { st = select(0u, 1u, (every & FLAG_NEAR) != 0u); }
      wgState = st;
    }
    let st = workgroupUniformLoad(&wgState);
    if (st == UNDECIDED && (f & FLAG_MATTER) != 0u && !inertNearHere(p)) { atomicOr(&wgFail, 1u); }
    workgroupBarrier();
    if (li == 0u) {
      var inert = st;
      if (st == UNDECIDED) { inert = select(1u, 0u, atomicLoad(&wgFail) != 0u); }
      actStore(ACT_INERT + b, inert);
    }
    workgroupBarrier();
  }
}
`;

// The same map computed from the state alone, the way the brick pass did
// before the activity flags: a full rebuild, the reference the flags and the
// incremental build must reproduce exactly (tools/activity-check.mjs; sim.js
// passes.inertRef). A workgroup per brick (direct), a thread per cell;
// out[b] = 1 if inert.
export const inertRefFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${inertNearGLSL}
@group(2) @binding(0) var<storage, read_write> out: array<u32>;
var<workgroup> wgFail: atomic<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = foldId(wg, nwg);
  if (b >= NBRICKS) { return; }   // the whole workgroup
  let p = cellOf(b * 64u + li);
  let a = fetchA(p);
  // the cell's own state, then, for matter, its neighbours
  if (!inertSelf(a, fetchB(p)) || (eid(a) != E_EMPTY && !inertNearHere(p))) { atomicOr(&wgFail, 1u); }
  workgroupBarrier();
  if (li == 0u) { out[b] = select(1u, 0u, atomicLoad(&wgFail) != 0u); }
}
`;

// quiet: one thread per brick. The carry note from the outgoing map first,
// then quiet = enabled, and every brick of b + {-1, 0, 1}³ inert (outside the
// box counts as inert: the box walls are) and holding no fast particle (a
// particle flies at most a brick in the steps a map lives, rays.js RAY_V_MAX,
// so every cell it can heat stays awake), then the note of the new map:
// changed = noted ? changed | !quiet : !quiet (the old MAX blend). Brick 0's
// thread also starts this build's DRAWN and MOVE1 lists over (the last map's
// steps, their readers, ran before).
export const quietFrag = (g) => /* wgsl */ `
${buildHead(g)}
fn rayBrick(id: u32) -> bool { return (rayBricks[id >> 5u] & (1u << (id & 31u))) != 0u; }
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = foldThread(wg, nwg, li);
  if (b >= NBRICKS) { return; }
  if (b == 0u) {
    actStore(ACT_COUNT + CNT_DRAWN, 0u);
    actStore(ACT_COUNT + CNT_MOVE1, 0u);
    actStore(ACT_COUNT + CNT_AWAKE, 0u);
  }
  var changed = actLoad(ACT_CHANGED + b) != 0u;
  var noted = P.noted != 0u;
  if (P.carry != 0u) {
    let qOld = actLoad(ACT_QUIET + b) != 0u;
    changed = select(!qOld, changed || !qOld, noted);
    noted = true;
  }
  var q = P.enabled != 0u;
  if (q) {
    let bc = brickCoord(b);
    for (var z = -1; z <= 1; z++) {
      for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
          let n = bc + vec3i(x, y, z);
          if (!inBricks(n)) { continue; }
          let nid = brickId(n);
          if (actLoad(ACT_INERT + nid) == 0u || (P.rays != 0u && rayBrick(nid))) { q = false; }
        }
      }
    }
  }
  changed = select(!q, changed || !q, noted);
  actStore(ACT_QUIET + b, select(0u, 1u, q));
  actStore(ACT_CHANGED + b, select(0u, 1u, changed));
}
`;

// drawn: one thread per unit. AWAKE = a brick that isn't quiet lies in the
// unit or just below it (the unit's bricks − {0, 1}³); forced = a writer
// marked a brick of it since the last map, or every unit was; then the run
// counter and DRAWN (docs/webgpu.md D5.3), the map word, the DRAWN list and
// the count of AWAKE units.
export const drawnFrag = (g) => /* wgsl */ `
${buildHead(g)}
var<workgroup> wgAwake: atomic<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let un = foldThread(wg, nwg, li);
  var drawn = false;
  if (un < NUNITS) {
    var awake = false;
    let lo = unitCoord(un) * SLEEP_UNIT;
    for (var z = lo.z - 1; z < lo.z + SLEEP_UNIT.z; z++) {
      for (var y = lo.y - 1; y < lo.y + SLEEP_UNIT.y; y++) {
        for (var x = lo.x - 1; x < lo.x + SLEEP_UNIT.x; x++) {
          let n = vec3i(x, y, z);
          if (inBricks(n) && !quietBrick(brickId(n))) { awake = true; }
        }
      }
    }
    var forced = P.forceAll != 0u;
    for (var i = 0u; i < UNIT_B; i++) { forced = forced || markedAct(un * UNIT_B + i); }
    let old = actLoad(ACT_MAP + un);
    let prevDrawn = (old & MAP_DRAWN) != 0u;
    let prevAwake = (old & MAP_AWAKE) != 0u;
    // steps of maps under which the unit was drawn and not AWAKE, since a write into it
    var run = 0u;
    if (!forced && prevDrawn && !prevAwake) { run = min((old >> MAP_RUN_SHIFT) + P.nPrev, MAP_RUN_MAX); }
    drawn = P.all != 0u || awake || forced || (prevDrawn && run < SUPER_SETTLE_STEPS);
    actStore(ACT_MAP + un, (run << MAP_RUN_SHIFT) | select(0u, MAP_DRAWN, drawn) | select(0u, MAP_AWAKE, awake));
    if (awake) { atomicAdd(&wgAwake, 1u); }
  }
  append(drawn, un, ACT_DRAWNL, CNT_DRAWN, li);
  if (li == 0u) { atomicAdd(&act[ACT_COUNT + CNT_AWAKE], atomicLoad(&wgAwake)); }
}
`;

// move1: one thread per unit. MOVE1 = a unit of u + {0, 1}³ is DRAWN (a block
// based in u at partition offset 1 reaches the next unit along each axis);
// the list. The writers' marks start over here (inertList and drawn have read
// them).
export const move1Frag = (g) => /* wgsl */ `
${buildHead(g)}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let un = foldThread(wg, nwg, li);
  var on = false;
  if (un < NUNITS) {
    let uc = unitCoord(un);
    for (var z = 0; z <= 1; z++) {
      for (var y = 0; y <= 1; y++) {
        for (var x = 0; x <= 1; x++) {
          let n = uc + vec3i(x, y, z);
          if (inUnits(n) && drawnUnit(unitId(n))) { on = true; }
        }
      }
    }
    for (var i = 0u; i < UNIT_B; i++) {
      let id = un * UNIT_B + i;
      atomicAnd(&marks[MARK_ACT + (id >> 5u)], ~(1u << (id & 31u)));
    }
  }
  append(on, un, ACT_MOVE1L, CNT_MOVE1, li);
}
`;

// args: one thread. The steps' indirect arguments from the lists' lengths,
// fold()ed as src/gpu/kernels.js folds ([ceil(n / y), y, 1], y = ceil(n /
// 65535)): react a workgroup per brick of DRAWN, the move 64 blocks a
// workgroup (8 a brick) over DRAWN (offset 0) and MOVE1 (offset 1); and the
// counts for the CPU into its ring slot. Then the INERT list starts over for
// the next build (the inert kernel has run), its length kept in INERT_LAST
// (sim.readCounts).
export const argsFrag = (g) => /* wgsl */ `
${buildHead(g)}
fn writeFold(at: u32, n: u32) {
  let y = max(1u, (n + MAX_WG - 1u) / MAX_WG);
  atomicStore(&args[at], (n + y - 1u) / y);
  atomicStore(&args[at + 1u], y);
  atomicStore(&args[at + 2u], 1u);
}
@compute @workgroup_size(1)
fn main() {
  let nD = actLoad(ACT_COUNT + CNT_DRAWN);
  let nM = actLoad(ACT_COUNT + CNT_MOVE1);
  writeFold(ARGS_REACT, nD * UNIT_B);
  writeFold(ARGS_MOVE0, (nD * UNIT_B * 8u + 63u) / 64u);
  writeFold(ARGS_MOVE1, (nM * UNIT_B * 8u + 63u) / 64u);
  atomicStore(&args[P.slot], actLoad(ACT_COUNT + CNT_AWAKE));
  atomicStore(&args[P.slot + 1u], nD);
  atomicStore(&args[P.slot + 2u], nM);
  let nI = actLoad(ACT_COUNT + CNT_INERT);
  atomicStore(&args[P.slot + 3u], nI);
  actStore(ACT_COUNT + CNT_INERT_LAST, nI);
  actStore(ACT_COUNT + CNT_INERT, 0u);
  atomicStore(&args[ARGS_INERT], 0u);
}
`;

// Test only (sim.test.listOrder, docs/webgpu.md I2.1): reverses or shuffles
// one list in place, so a result that depends on list order (an append race,
// a workgroup reading another's cells) shows up even on a device that runs
// workgroups in order. One workgroup; the shuffle is one thread's
// Fisher-Yates over pcg.
export const permuteFrag = (g) => /* wgsl */ `
${buildHead(g)}
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) li: u32) {
  var list = ACT_DRAWNL;
  if (P.list == CNT_MOVE1) { list = ACT_MOVE1L; }
  if (P.list == CNT_INERT) { list = ACT_INERTL; }
  if (P.list == CNT_AER) { list = ACT_AERL; }
  let n = actLoad(ACT_COUNT + P.list);
  if (P.order == 1u) {
    for (var i = li; i < n / 2u; i += 64u) {
      let t = actLoad(list + i);
      actStore(list + i, actLoad(list + n - 1u - i));
      actStore(list + n - 1u - i, t);
    }
  } else if (P.order == 2u && li == 0u && n > 1u) {
    var s = P.seed;
    for (var i = n - 1u; i > 0u; i--) {
      s = pcg(s);
      let j = s % (i + 1u);
      let t = actLoad(list + i);
      actStore(list + i, actLoad(list + j));
      actStore(list + j, t);
    }
  }
}
`;

// tool: built only by the tools that run it, never warmed for a session (docs/webgpu.md B5)
const entry = (name, code, dispatch, layouts, tool = false) => ({ name, kind: 'compute', code, layouts, dispatch, ...(tool && { tool }) });
const buildLayouts = () => [LAYOUT.TABLES, LAYOUT.STATE_BUILD, BUILD_LAYOUT];
const perBrick = (g) => fold(Math.ceil(gridDims(g).nbricks / 64));
const perUnit = (g) => fold(Math.ceil(sleepUnitOf(g).units / 64));

/**
 * tools/check-wgsl.mjs, and the pipelines a grid needs for its activity
 * build (the start menu's warm-up, docs/webgpu.md B5).
 */
export const WGSL_CHECK = [
  entry('inertList', inertListFrag, perBrick, buildLayouts),
  entry('inert', (g) => inertFrag(g), (g) => fold(Math.ceil(gridDims(g).nbricks / inertFold(g))), () => [LAYOUT.TABLES, LAYOUT.STATE_BUILD, 'EMPTY']),
  entry('quiet', quietFrag, perBrick, buildLayouts),
  entry('drawn', drawnFrag, perUnit, buildLayouts),
  entry('move1', move1Frag, perUnit, buildLayouts),
  entry('args', argsFrag, () => [1, 1, 1], buildLayouts),
  // the tools' kernels (activity-check's reference, sim-check's listOrder)
  entry('inertRef', inertRefFrag, (g) => fold(gridDims(g).nbricks), () => [LAYOUT.TABLES, LAYOUT.STATE_RO, REF_LAYOUT], true),
  entry('permute', permuteFrag, () => [1, 1, 1], buildLayouts, true),
];
export { actLayout, ACT_COUNTS, ACT_MAP };
