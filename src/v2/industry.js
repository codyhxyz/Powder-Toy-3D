import { fold, STAGE } from '../gpu/kernels.js';
import { nativeWeatherParams, nativeWeatherEvaluateWGSL, nativeWeatherCommitWGSL, NATIVE_WEATHER_COMMIT_LAYOUT, scratchWGSL, boxWGSL, weatherMain } from './nativeWeather.js';
import { prelude, STATE_OPTS } from '../shaders/common.js';
import { PARTICLE_CAP } from './dynamics-reference.js';
import { nativeForceCommitWGSL, FORCE_COMMIT_LAYOUT } from './nativeForcing.js';
import { nativeModes } from './modes.js';
import { GRAVITY } from './dynamics-reference.js';
import { SIM_GRAVITY, NOMINAL_STEP_RATE } from '../physics.js';
import { CELL_M } from '../scale.js';
import { INDUSTRY_EDIT, INDUSTRY_KIND } from '../shaders/industry.js';
import { ELEMENTS, K } from '../elements.js';
import { PLAN } from '../shaders/v2/blasts.js';

// Factory machines on V2's own cells. The machine rules are V1's, unchanged:
// shaders/industry.js update() (belt, separator, lift, miner, furnace, hearth)
// evaluates against the frozen native grid, exactly as the POV kick does
// (nativeForcing.js). Its writes commit natively: heat as energy, fuel life
// and ctype as payload, a fracture as V2's energy-exact rename, and motion as
// a V2 particle that carries the whole cell (a liquid's fill, a grain's fall
// state, the heat bank). No legacy B, projection or import is involved.
//
// Units. The rules author speeds in cells per V1 step: V1 steps NOMINAL_STEP_RATE
// (240) times a second under SIM_GRAVITY = 0.025 cells/step² (physics.js), which is
// 0.025·240² = 1440 cells/s² (432 m/s² at CELL_M = 0.3 m). V2 falls at V1's pull
// (GRAVITY, v2/gravity.js; user decision 2026-10-21), so one speed keeps both V1's
// cells/s and V1's trajectories; a machine's motion still converts by what it is
// (V1's rule kinds, shaders/industry.js update), and both maps are V1's 72 m/s per cell/step:
// - a throw (a lift's launch, a miner's cut debris, a furnace's or hearth's pour)
//   keeps V1's trajectory in cells: v·√(GRAVITY·CELL_M/SIM_GRAVITY) (MACHINE_SPEED_SI).
//   A lift throws its grains V1's 20 cells up (1²/(2·0.025)) into the catch you built,
//   in V1's time (0.17 s to the top);
// - a deck's carry (a belt's, a separator's, a miner's deck: grains resting on it)
//   moves at V1's cells/s along the deck: v·NOMINAL_STEP_RATE·CELL_M
//   (MACHINE_CARRY_SI: a belt's 0.6 is 144 cells/s). The vertical part of a carry is
//   a throw's. A grain that runs off a deck's end flies on at that speed and falls as V1's.
export const MACHINE_SPEED_SI = Math.sqrt(GRAVITY * CELL_M / SIM_GRAVITY);
export const MACHINE_CARRY_SI = NOMINAL_STEP_RATE * CELL_M;
const wf = n => (Number.isInteger(n) ? `${n}.0` : String(n));

// ---- a deck's carry, V1's speed in game time (M7) ----
// V1 runs the machine pass once a frame, after the frame's settings.steps steps (app.js; industry/index.js
// update). Its kick sets a grain's velocity along the deck, 0.6 cells/step (shaders/industry.js update); each
// step after, the move (shaders/move.js, a Margolus block pass) moves the grain one cell with chance |v|, but
// only from its block's near side: a hit keeps it there for the next step's block, a miss leaves it on the
// far side for one; then react (react.js forces) takes its drag and, resting on the deck, its friction. So a
// belt's speed in game time is V1's mean over a pass of settings.steps steps: a frame rate never changes it,
// the Speed setting does (a 12-step frame's grain slows to a crawl before the next kick). Measured on V1
// (tools/v2/industry-belt-browser-check.mjs): nuggets 58 cells/s at Speed 1, 25 at Speed 3; this model, 60
// and 27. V2 carries per native tick (industry/physics.js nativeStep), whatever the frames: the tick's slide
// moves the grain V1's cells for the tick's LEGACY_STEPS_PER_TICK steps (v2/host.js).
// V1's keep of a resting grain's velocity a step: (1 - drag)(1 - friction) (react.js forces).
export const v1DeckKeep = e => (1 - (e.drag ?? 0)) * (1 - (e.friction ?? 0));
// Frames of the chain run to its steady state (it settles in four; eight leaves it to f32's digits).
export const DECK_CHAIN_FRAMES = 8;
/** V1's mean cells/step of a deck's grain: kicked to `kick` cells/step once every `steps` steps (V1's frame). */
export function v1DeckCells(keep, kick, steps) {
  let near = 1, moved = 0;
  for (let f = 0; f < DECK_CHAIN_FRAMES; f++) {
    moved = 0;
    for (let k = 0, u = kick; k < steps; k++, u *= keep) { const hit = near * Math.min(u, 1); moved += hit; near = hit + 1 - near; }
  }
  return moved / steps;
}
// A slide (blasts.js PLAN.SLIDE) moves its grain its speed for one tick, and the grain is on the grid for a
// kick again one tick after it lands: a deck kicks a grain every DECK_SLIDE_TICKS ticks (measured on the GPU:
// a 144 cells/s slide carries 72 cells/s; tools/v2/industry-belt-browser-check.mjs).
export const DECK_SLIDE_TICKS = 2;
// m/s of the slide that carries V1's mean `cells` a step, kicked every DECK_SLIDE_TICKS ticks
export const deckSlideSI = cells => cells * MACHINE_CARRY_SI * DECK_SLIDE_TICKS;
const deckKeeps = (() => {
  const by = new Map();
  for (const e of ELEMENTS) if (e?.kind === K.POWDER) { const k = Math.fround(v1DeckKeep(e)); by.set(k, [...(by.get(k) ?? []), e.id]); }
  return [...by];
})();
// V2's own: which motion is a deck's carry (V1's update: a belt or separator moves only grains on its
// deck; a miner's deck is its 4×4 at y 1, its cut face z 4..7 ahead). A carry leaves from its contact
// with the deck (blasts.js PLAN.SLIDE), so it slides on to the next deck instead of gliding over it.
export const industryMotionWGSL = /* wgsl */ `
fn industryCarries(p: vec3i) -> bool {
  if (P.kind == ${INDUSTRY_KIND.belt}u || P.kind == ${INDUSTRY_KIND.separator}u) { return true; }
  if (P.kind != ${INDUSTRY_KIND.miner}u) { return false; }
  let rel = p - P.corner;
  return rel.y == 1 && dot(vec3f(rel), vec3f(P.forward)) <= 3.0;
}
fn industryKeep(id: u32) -> f32 {
  switch id { ${deckKeeps.map(([k, ids]) => `case ${ids.map(i => `${i}u`).join(', ')}: { return ${wf(k)}; }`).join(' ')} default: { return 1.0; } }
}
// v1DeckCells: V1's mean cells/step, kicked once every P.carrySteps steps (V1's frame at its Speed)
fn industryDeckCells(id: u32, kick: f32) -> f32 {
  let steps = max(P.carrySteps, 1u); let keep = industryKeep(id);
  var near = 1.0; var moved = 0.0;
  for (var f = 0u; f < ${DECK_CHAIN_FRAMES}u; f++) {
    moved = 0.0; var u = kick;
    for (var k = 0u; k < steps; k++) { let hit = near * min(u, 1.0); moved += hit; near = hit + 1.0 - near; u *= keep; }
  }
  return moved / f32(steps);
}
fn industryVelocity(p: vec3i, id: u32, motion: vec3f) -> vec3f {
  if (!industryCarries(p)) { return motion * ${wf(MACHINE_SPEED_SI)}; }
  // the carry along the deck at V1's game-time speed (deckSlideSI); its vertical part is a throw's
  let along = length(motion.xz);
  var flat = vec2f(0.0);
  if (along > 0.0) { flat = motion.xz / along * (industryDeckCells(id, along) * ${wf(MACHINE_CARRY_SI * DECK_SLIDE_TICKS)}); }
  return vec3f(flat.x, motion.y * ${wf(MACHINE_SPEED_SI)}, flat.y);
}
`;
export const NATIVE_INDUSTRY_SPEC = { ...INDUSTRY_EDIT, nativeForcing: true, speedSI: MACHINE_SPEED_SI };
export const NATIVE_INDUSTRY_COMMIT = { speedSI: MACHINE_SPEED_SI, life: true, sparse: true, motion: {
  decls: industryMotionWGSL, velocity: 'industryVelocity(p,id,r.motion.xyz)',
  flags: `if((flags&1u)!=0u && industryCarries(p)) { flags|=${PLAN.SLIDE}u; }\n` } };
const RESULT_BYTES = 64;   // nativeWeather.js WeatherResult: four vec4s a cell
const binding = (n, read = false) => ({ binding: n, visibility: STAGE.COMPUTE, buffer: { type: read ? 'read-only-storage' : 'storage' } });
// carrySteps: V1's steps a frame at the game's Speed (app.js settings.steps), for a deck's carry (V2 only)
export const nativeIndustryParams = () => nativeWeatherParams('industry', { ...NATIVE_INDUSTRY_SPEC,
  params: { ...Object.fromEntries(INDUSTRY_EDIT.params.fields.map(f => [f.name, f.type])), origin: 'vec3i', carrySteps: 'u32' } });
export const nativeIndustryEvaluateWGSL = (g, params = nativeIndustryParams()) => nativeWeatherEvaluateWGSL(g, NATIVE_INDUSTRY_SPEC, params);
export const nativeIndustryPlanWGSL = (g, params = nativeIndustryParams()) => nativeForceCommitWGSL(g, params, 'plan', NATIVE_INDUSTRY_COMMIT);

export class NativeIndustry {
  constructor(sim) {
    const o = sim.compactOwner, d = o?.dynamics, gpu = sim.gpu;
    if (!o?.nativeDynamics || !d) throw new Error('Native Factory machines need the native dynamics adapter');
    this.sim = sim; this.owner = o; this.dynamics = d; this.gpu = gpu;
    const params = this.params = nativeIndustryParams();
    this.evalLayout = gpu.layout('industryNativeEvaluate', [binding(1)]);
    this.commitLayout = gpu.layout('NATIVE_FORCE_COMMIT', FORCE_COMMIT_LAYOUT);
    this.evaluate = gpu.kernel({ name: 'industryNativeEvaluate', params, code: nativeIndustryEvaluateWGSL(sim.g, params),
      layouts: [sim.L.TABLES, sim.L.STATE_RO, this.evalLayout] });
    this.plan = gpu.kernel({ name: 'industryNativePlan', params, code: nativeIndustryPlanWGSL(sim.g, params),
      layouts: [o.nativeDynamics.layout, this.commitLayout] });
    this.ready = Promise.all([this.evaluate.ready, this.plan.ready, d.ready]);
    this.ready.catch(() => {});
    this.scratch = null; this.groups = null;
  }
  get isReady() {
    return this.evaluate.state === 'ready' && this.plan.state === 'ready' && this.dynamics.isReady
      && !this.sim.disposed && !this.owner.disposed && this.sim.compactOwner === this.owner && this.sim.compact === this.owner;
  }
  // One results scratch, reused by every box of a batch: the dispatches run in
  // call order, so each machine evaluates the grid its predecessors committed.
  _scratch(count) {
    const bytes = Math.max(1, count) * RESULT_BYTES;
    if (!this.scratch || this.scratch.size < bytes) {
      if (this.scratch) this.sim._retire(this.scratch);
      this.scratch = this.gpu.createBuffer({ label: 'industry native results', size: bytes, usage: GPUBufferUsage.STORAGE });
      this.groups = null;
    }
    const d = this.dynamics, air = d.air[d.airIndex];
    if (this.groups?.air !== air) {
      const entries = buffers => buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
      this.groups = { air,
        evaluate: this.gpu.bindGroup(this.evalLayout, [{ binding: 1, resource: { buffer: this.scratch } }], 'industry native evaluate'),
        commit: this.gpu.bindGroup(this.commitLayout, entries([this.scratch, air, d.plans, d.particles]), 'industry native commit') };
    }
    return this.groups;
  }
  /** One batch of machine edits ({ box: {lo, hi} inclusive cells, values: IndustryParams' fields }).
   * launch: the batch may move matter: each box lists its bricks before its plans (clearing those
   * the batch hasn't listed yet), and ONE native allocation over the listed bricks after the last box
   * turns every planned cell into a particle (or leaves it exact on the grid). Its cost follows the
   * machines' bricks, not the grid's. */
  run(edits, { launch = true } = {}) {
    const sim = this.sim, o = this.owner, d = this.dynamics;
    if (!this.isReady || sim.nativeTransition || sim.nativeTransitionError) return false;
    const dims = [sim.g.nx, sim.g.ny, sim.g.nz], boxes = [];
    for (const { box, values } of edits) {
      const lo = box.lo.map(v => Math.max(0, Math.ceil(v))), hi = box.hi.map((v, a) => Math.min(dims[a] - 1, Math.floor(v)));
      if (lo.some((v, a) => v > hi[a])) continue;
      boxes.push({ lo, hi, values, count: hi.reduce((n, v, a) => n * (v - lo[a] + 1), 1) });
    }
    if (!boxes.length) return false;
    o.sync();
    const groups = this._scratch(Math.max(...boxes.map(b => b.count)));
    const origin = [sim.origin.x, sim.origin.y, sim.origin.z], tick = o.tick + 1;
    const dispatch = (k, n, bind, header, b) => {
      k.dispatch(this.gpu.frame, fold(Math.ceil(n / 64)), { bind, header,
        params: { ...nativeModes(sim), ...b.values, editLo: b.lo, editHi: b.hi, tick, origin } });
      sim.onPass?.(k.name, { kind: 'compute', gpuMs: null });
    };
    for (const b of boxes) {
      dispatch(this.evaluate, b.count, [sim.tables, sim.bindPhysicalRO, groups.evaluate], sim.readHeader({ physical: true }), b);
      if (launch) d.markLaunch(tick, b.lo, b.hi);
      dispatch(this.plan, b.count, [o.nativeDynamics.group, groups.commit], sim.header(), b);
    }
    if (launch) d.allocateLaunch(tick);
    // As the native tick does: storeMaterial noted every changed brick, so a frame of
    // running machines never forces whole-grid derived passes (no changedAll).
    o.legacyPending = o.writtenSinceTick = true;
    sim.version++; o.seenVersion = sim.version;
    d._externalWork(); sim.wake();
    return true;
  }
  dispose() { if (this.scratch) this.sim._retire(this.scratch); this.scratch = null; this.groups = null; }
}

const natives = new WeakMap();   // sim → { owner, kernel }: one per native owner, like the POV force kernels
export function nativeIndustry(sim) {
  const o = sim?.compactOwner;
  if (!sim?.compact || sim.compact !== o || !o.dynamics || !o.nativeDynamics) return null;
  let entry = natives.get(sim);
  if (!entry || entry.owner !== o) {
    entry?.kernel.dispose();
    entry = { owner: o, kernel: new NativeIndustry(sim) };
    natives.set(sim, entry);
  }
  return entry.kernel;
}

// ---- Factory construction, gates and control parts on V2's own cells ----
// V1's writers (industry/construction.js, gates.js, controlParts.js) are one-invocation kernels that test
// a whole structure, then write it (writeCell), and report through the result ring. Under V2 the same WGSL
// body runs here against the frozen native grid (the physical read, as the machines' evaluate above), its
// writeCell recorded as the cell's after-state; nativeWeather.js's material commit then stores each changed
// cell in V2's own cells: a change of element is a new cell at the rule's temperature, life and seed (a
// shutter, a deck, a switch), anything else merges its life, ctype and heat (a switch's toggle). It lands in
// the frame that asked, before the next tick, as V1's kernel write does: no legacy A/B write, no export of
// the projection, no import, no wait for the ring's readback (M10, M11).
// V1 holds moving matter as cells, so its emptiness tests see a grain crossing a gate's opening or a
// machine's footprint; V2 holds it as a particle. A packet inside the box counts as V1's cell there: the
// rule's emptiness answer is overturned (`blocks`) and nothing is written, as V1's rule found it occupied.
export const WRITER_CELLS_MAX = 256;                   // a writer's box: a pump's 4×7×4 is the largest
const FLYING_WORDS = WRITER_CELLS_MAX / 32;
export const nativeWriterParams = (name, fields) => nativeWeatherParams(name,
  { params: { ...Object.fromEntries(fields.fields.map(f => [f.name, f.type])), origin: 'vec3i' } });
// The flying scan's and the commit's: box, tick, modes and origin alone, so every writer shares their pipelines.
export const WRITER_SHARED_PARAMS = nativeWeatherParams('industryWriter', { params: { origin: 'vec3i' } });
const shared = values => Object.fromEntries(WRITER_SHARED_PARAMS.fields.filter(f => f.name in values).map(f => [f.name, values[f.name]]));
// The packets inside the box, a bit a box cell.
export const nativeWriterFlyingWGSL = params => `${params.wgsl}
@group(3) @binding(1) var<uniform> P: ${params.name};
${boxWGSL}
struct WriterParticle { position: vec3f, id: u32, velocity: vec3f, c0: u32, tail: vec4u }
@group(0) @binding(0) var<storage, read> particles: array<WriterParticle>;
@group(0) @binding(1) var<storage, read_write> flying: array<atomic<u32>>;
${weatherMain(`if(i>=${PARTICLE_CAP}u) { return; }
let q=particles[i]; let id=q.c0&255u;
// (matter only: no free slot, no ray or heat carrier: dynamics-reference.js PHOTON_TAG and up)
if(q.id==0u || id==0u || id>=254u) { return; }
let p=vec3i(floor(q.position))-P.origin;
if(any(p<P.editLo) || any(p>P.editHi)) { return; }
let k=weatherIndex(p); atomicOr(&flying[k>>5u],1u<<(k&31u));`)}`;
// The V1 body with its stores recorded (not written) and its legacy bookkeeping dropped.
// blocks: WGSL bool, after the rule, for "the box's flying matter overturns this answer"; blocked: the ring's
// answer then (what V1's rule reports for an occupied cell).
export function nativeWriterEvaluateWGSL(g, body, { blocks, blocked }) {
  const entry = /@compute @workgroup_size\(1\)\nfn main\(\) \{/;
  if (!entry.test(body)) throw new Error('native Factory writer: the V1 body has no one-invocation main');
  return `${prelude(g, STATE_OPTS.STATE_RO)}
${scratchWGSL}
@group(2) @binding(1) var<storage, read_write> results: array<WeatherResult>;
@group(2) @binding(2) var<storage, read> flying: array<u32>;
${boxWGSL}
fn fetchF(p: vec3i) -> u32 { return 0u; }
fn markBrick(id: u32) {}
fn ownLegacy(s: u32) {}
// V1's store (shaders/common.js writeCell): only a cell of the box, only a change; here its after-state
fn writeCell(p: vec3i, a: vec4f, b: vec4f, f: u32, oA: vec4f, oB: vec4f) -> bool {
  if (!inGrid(p) || any(p < P.editLo) || any(p > P.editHi)) { return false; }
  if (all(oA == a) && all(oB == b)) { return false; }
  results[weatherIndex(p)].after = oA;
  return true;
}
fn writerFlying() -> bool {
  for (var w = 0u; w < ${FLYING_WORDS}u; w++) { if (flying[w] != 0u) { return true; } }
  return false;
}
fn writerPlaces() -> bool {
  for (var i = 0u; i < weatherCount(); i++) { let r = results[i]; if (eid(r.before) == E_EMPTY && eid(r.after) != E_EMPTY) { return true; } }
  return false;
}
${body.replace(entry, 'fn industryWriterRule() {')}
@compute @workgroup_size(1)
fn main() {
  for (var i = 0u; i < weatherCount(); i++) { let a = fetchA(weatherCell(i)); results[i] = WeatherResult(a, a, vec4f(0.0), vec4f(0.0)); }
  industryWriterRule();
  if (writerFlying() && (${blocks})) {
    for (var i = 0u; i < weatherCount(); i++) { results[i].after = results[i].before; }
    ringOut[P.slot] = ${blocked};
  }
}`;
}
export const nativeWriterCommitWGSL = (g, params) => nativeWeatherCommitWGSL(g, params, 'material');

export class NativeIndustryWriter {
  /** spec: { fields: the V1 kernel's params struct, body: params => its WGSL body, blocks, blocked } */
  constructor(sim, name, spec) {
    const o = sim.compactOwner, d = o?.dynamics, gpu = sim.gpu;
    if (!o?.nativeDynamics || !d) throw new Error('Native Factory writers need the native dynamics adapter');
    this.sim = sim; this.owner = o; this.dynamics = d; this.gpu = gpu; this.name = name;
    const params = this.params = nativeWriterParams(name, spec.fields);
    this.flyLayout = gpu.layout('industryWriterFlying', [binding(0, true), binding(1)]);
    this.evalLayout = gpu.layout('industryWriterEvaluate', [binding(0), binding(1), binding(2, true)]);
    this.commitLayout = gpu.layout('NATIVE_WEATHER_COMMIT', NATIVE_WEATHER_COMMIT_LAYOUT);
    const common = WRITER_SHARED_PARAMS;
    this.flying = gpu.kernel({ name: 'industryWriterFlying', params: common, code: nativeWriterFlyingWGSL(common), layouts: [this.flyLayout] });
    this.evaluate = gpu.kernel({ name: `${name}Evaluate`, params, code: nativeWriterEvaluateWGSL(sim.g, spec.body(params), spec),
      layouts: [sim.L.TABLES, sim.L.STATE_RO, this.evalLayout], workgroupSize: [1, 1, 1] });
    this.commit = gpu.kernel({ name: 'industryWriterCommit', params: common, code: nativeWriterCommitWGSL(sim.g, common), layouts: [o.nativeDynamics.layout, this.commitLayout] });
    this.kernels = [this.flying, this.evaluate, this.commit];
    // Its own kernels only: it records none of the dynamics' (it reads their buffers), so it writes from
    // the first frame while their kernels still build, as the native brush does (nativePaint.js).
    this.ready = Promise.all(this.kernels.map(k => k.ready));
    this.ready.catch(() => {});
    this.results = gpu.createBuffer({ label: `${name} native results`, size: WRITER_CELLS_MAX * RESULT_BYTES, usage: GPUBufferUsage.STORAGE });
    this.flags = gpu.createBuffer({ label: `${name} flying cells`, size: FLYING_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.groups = new Map();
  }
  get isReady() {
    const d = this.dynamics;
    return this.kernels.every(k => k.state === 'ready') && !d.disposed && !!d.air && !!d.particles
      && !this.sim.disposed && !this.owner.disposed && this.sim.compactOwner === this.owner && this.sim.compact === this.owner;
  }
  _groups(ring) {
    const d = this.dynamics, air = d.air[d.airIndex], key = ring;
    let g = this.groups.get(key);
    if (!g || g.air !== air) {
      const entries = buffers => buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
      g = { air,
        flying: this.gpu.bindGroup(this.flyLayout, entries([d.particles, this.flags]), `${this.name} flying`),
        evaluate: this.gpu.bindGroup(this.evalLayout, entries([ring, this.results, this.flags]), `${this.name} evaluate`),
        commit: this.gpu.bindGroup(this.commitLayout, entries([this.results, air, d.plans]), `${this.name} commit`) };
      this.groups.set(key, g);
    }
    return g;
  }
  /** One write: box {lo, hi} (inclusive cells, the V1 rule's whole reach), values: the V1 params' fields,
   * ring: the result ring's buffer the rule reports into (its P.slot). False if it can't run now. */
  run(box, values, ring) {
    const sim = this.sim, o = this.owner, d = this.dynamics, gpu = this.gpu;
    if (!this.isReady || sim.nativeTransition || sim.nativeTransitionError) return false;
    const dims = [sim.g.nx, sim.g.ny, sim.g.nz];
    const lo = box.lo.map(v => Math.max(0, Math.ceil(v))), hi = box.hi.map((v, a) => Math.min(dims[a] - 1, Math.floor(v)));
    if (lo.some((v, a) => v > hi[a])) return false;
    const count = hi.reduce((n, v, a) => n * (v - lo[a] + 1), 1);
    if (count > WRITER_CELLS_MAX) throw new RangeError(`${this.name}: a box of ${count} cells is past the writer's ${WRITER_CELLS_MAX}`);
    o.sync();
    const groups = this._groups(ring), physical = sim.bindPhysicalRO;
    const params = { ...nativeModes(sim), ...values, editLo: lo, editHi: hi, tick: o.tick + 1, scrub: 0, origin: [sim.origin.x, sim.origin.y, sim.origin.z] };
    const dispatch = (k, size, bind, header) => {
      k.dispatch(gpu.frame, size, { bind, header, params: k === this.evaluate ? params : shared(params) });
      sim.onPass?.(k.name, { kind: 'compute', gpuMs: null });
    };
    gpu.frame.clear(this.flags);
    dispatch(this.flying, fold(PARTICLE_CAP / 64), [groups.flying], sim.header());
    dispatch(this.evaluate, [1, 1, 1], [sim.tables, physical, groups.evaluate], sim.readHeader({ physical: true }));
    dispatch(this.commit, fold(Math.ceil(count / 64)), [o.nativeDynamics.group, groups.commit], sim.header());
    // As the machines' batch: storeMaterial noted every brick it changed (no changedAll); the projection is stale.
    o.legacyPending = o.writtenSinceTick = true;
    sim.version++; o.seenVersion = sim.version;
    d._externalWork?.(); o.wake?.(); sim.wake();
    return true;
  }
  dispose() {
    if (this.results) this.sim._retire(this.results);
    if (this.flags) this.sim._retire(this.flags);
    this.results = this.flags = null; this.groups.clear();
  }
}
const writers = new WeakMap();   // sim → { owner, byName }: one per native owner and writer
export function nativeIndustryWriter(sim, name, spec) {
  const o = sim?.compactOwner;
  if (!sim?.compact || sim.compact !== o || !o.dynamics || !o.nativeDynamics) return null;
  let entry = writers.get(sim);
  if (!entry || entry.owner !== o) {
    for (const w of entry?.byName.values() ?? []) w.dispose();
    entry = { owner: o, byName: new Map() };
    writers.set(sim, entry);
  }
  let writer = entry.byName.get(name);
  if (!writer) entry.byName.set(name, writer = new NativeIndustryWriter(sim, name, spec));
  return writer;
}
