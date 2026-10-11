import { BRICK, brickIdOf } from './shaders/common.js';
import {
  fieldEmaFrag, fieldBlurFrag, fieldBoostFrag, fieldPeakFrag, fieldShiftFrag, fieldMaxFrag,
  EmaParams, FieldBlurParams, BoostParams, PeakParams, FieldShiftParams, MaxParams,
  FIELD_LAYOUT, FIELD_FORMAT, DIRTY, dirtyLists, BLUR_TAPS,
} from './shaders/fields.js';
import {
  ageFrag, dirtyFrag, dirtyArgsFrag, brickFrag, brickDistFrag, blurFrag, brickShiftFrag, giShiftFrag, brickBitsFrag,
  AgeParams, BrickDistParams, BlurParams, BrickShiftParams, GiShiftParams, DERIVED_LAYOUT, LIGHT_BLUR_PASSES,
} from './shaders/passes.js';
import { CHANNELS, MEDIA, gauss5, bulkPeak, bulkPeakCubic, CUBIC_LATTICE } from './gfx/materials.js';
import { fold } from './gpu/kernels.js';
import { halfsToFloats } from './gpu/readback.js';
import {
  giSourceFrag, giGatherFrag, GiParams, giProbeCount, giSourceDispatch, giGatherDispatch, GI_LAYOUT_NAMES,
} from './shaders/gi.js';
import { libLayouts } from './shaders/gfx/lib.js';
import { WORLD_SIZE } from './shaders/farShared.js';
import { createMediaNoise } from './gfx/mediaNoise.js';
import { GI_BLEND } from './sim.js';

// The derived passes (docs/webgpu.md E): what the renderer reads of the
// simulation, rebuilt from its state once per derived frame, in the open
// frame's compute pass. The render fields (shaders/fields.js), the brick map,
// its empty-space distance and the glow volume (shaders/passes.js), and the
// GI probes (shaders/gi.js: updateGI, the realistic view's, after the shadow
// map). The simulation delegates to it: sim.updateBricks(), sim.updateGI(),
// sim.resetGI() and the getters (sim.fieldSurf, sim.brick, …).
//
//   const derived = new Derived(sim);   // attaches itself (sim.attachDerived)
//   await derived.ready;                // its pipelines (built asynchronously, B5)
//   sim.step(); sim.updateBricks();     // the volume then binds derived.lightingEntries()
//   volume.recordShadow();              // the realistic view: the GI after the shadow map
//   sim.updateGI(SUN, volume.shadowTextures, volume.shadowRes);   // (the WebGL call; FrameUniforms has the sun)
//
// Incremental, exactly (docs/scaling.md D9): each brick's age counts derived
// frames since it last changed, and the passes run over GPU-built lists of
// the bricks whose results may have changed, dispatched indirectly
// (shaders/passes.js dirtyFrag). Everything else holds what the passes would
// write there again. sim.incremental = false feeds the same kernels lists of
// every brick, which tools/derived-check.mjs compares with bit for bit.
//
// A window move (sim.shift, docs/scaling.md D11) moves the derived history
// with the cells instead of starting it over: the EMA, the ages, the brick
// map, its distances, the final fields and the GI probes shift, and only the
// bricks shifted in and those at the grid's faces on the moving axis re-age
// (shift below). The changes still pending at a move (the writers' marks and
// the steps' `changed` map, both where the bricks were) are folded into the
// ages first, so they move with their bricks.

// Resources, per grid (sizes at 128³):
//   age        u32 per brick: the age and its shift bits (shaders/fields.js AGE)          128 KB
//   dlist      the dirty sets' lists, their lengths and indirect arguments (dirtyLists)  384 KB
//   ema        the EMA, 3 planes of pack4x8unorm words                                     25 MB
//   tmpA, tmpB the blur's and the boost's scratch, 3 planes each (scratch: outside this
//              frame's WORK bricks it holds stale values no listed brick reads)        2 × 25 MB
//   blurred    the normalised blur, 4 planes of pack2x16float (φ.xy, φ.zw, media)          34 MB
//   fieldSurf, fieldMedia, fieldThin   the final fields, rgba16float 3D textures       3 × 17 MB
//   brick      BrickInfo per brick (shaders/bindings.js)                                  512 KB
//   brickDist  u32 per brick: empty-space distance (bindings.js brickDistAt)              128 KB
//   scratchB   4 words per brick: brickDist's middle axis, the per-brick shifts          512 KB
//   lightA, lightB   the light blur's ping-pong, vec4f per brick                     2 × 512 KB
//   light      the glow volume, rgba16float BX×BY×BZ                                      256 KB
//   giHist     the GI probes' history: 4 bands of rgba as two pack2x16float words,
//              band k of brick id at k·NBRICKS + id (shaders/gi.js blends into it)          1 MB
//   gi0..gi3   the GI bands, rgba16float BX×BY×BZ (the volume and figures sample them)  4 × 256 KB
//   giSrc      vec4u per brick: GI sources (shaders/gi.js giSource writes them)            512 KB
//   fieldsTmp  a copy of a final field, for its shift (made on a grid's first shift)      17 MB
//   noAer      16 bytes: the aeration's stand-in while the whitewater doesn't run
//
// The field passes also read whitewater's aeration field (gfx/foam.js, attached
// with sim.attachAeration: falling water and its wakes, shaders/fields.js
// jetWGSL): its buffer (both copies) while it is active, its current copy in
// their params.

// Planes (u32 words a cell) of the field passes' buffers (shaders/fields.js), and the GI's bands.
const EMA_PLANES = 3, TMP_PLANES = 3, BLURRED_PLANES = 4;
const GI_BANDS = 4;

// The group-2 layouts, named in gpu.L (docs/webgpu.md C4).
function derivedLayouts(gpu) {
  const L = {};
  for (const [name, entries] of Object.entries({
    BOOK: DERIVED_LAYOUT.BOOK, FIELD: FIELD_LAYOUT.FIELD, JET: FIELD_LAYOUT.JET, PEAK: FIELD_LAYOUT.PEAK, BRICK: DERIVED_LAYOUT.BRICK,
    PAIR: DERIVED_LAYOUT.PAIR, LIGHT: DERIVED_LAYOUT.LIGHT, GI_SHIFT: DERIVED_LAYOUT.GI_SHIFT,
  })) L[name] = gpu.layout(`DERIVED_${name}`, entries);
  return L;
}

// The channels' blur kernels, tap-major (gfx/materials.js gauss5, as the
// WebGL build's uW), their bulk peaks, and the lattice smoothing's centre
// weights, for a smoothing setting.
export function fieldWeights(smoothing) {
  const k = CHANNELS.map((c) => gauss5(Math.max(c.sigma * smoothing, 0.05)));
  return {
    w: [...Array(BLUR_TAPS).keys()].map((i) => k.map((ch) => ch[i])),
    bulk: k.map((w, i) => (CHANNELS[i].cubic ? bulkPeakCubic(w) : bulkPeak(w))),
    s: CHANNELS.map((c) => (c.cubic ? CUBIC_LATTICE[1] : 1)),
  };
}

export class Derived {
  /**
   * @param {import('./sim.js').Simulation} sim
   * @param {{ world?: number[] | null }} [opts] world: the world size whose far layout the GI holds (sim.world)
   */
  constructor(sim, { world = sim.world } = {}) {
    const gpu = (this.gpu = sim.gpu);
    this.sim = sim;
    this.g = sim.g;
    this.world = world;
    this.far = null;              // the far field's textures (attachFar; the GI's far branch)
    this.shiftsBricks = true;     // sim.shift: this keeps the history across a move (no changedAll)
    // test only (gpu.testMode): dropFold leaves the changes pending at a shift
    // where they are, dropJetToggle doesn't rebuild every brick when the
    // aeration starts or stops (tools/derived-check.mjs's negative controls)
    this.test = { dropFold: false, dropJetToggle: false };
    this.lastSmoothing = null;
    this.lastJet = false;         // the aeration was read at the last derived frame (_jet)
    const g = this.g, n = g.nbricks, slots = g.slots;
    this.lists = dirtyLists(g);

    // ---- buffers and textures (made once per grid, B6) ----
    const S = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC, CD = GPUBufferUsage.COPY_DST;
    const label = (x) => `sim${sim.id} ${x}`;
    const buf = (name, size, usage = S | CS | CD) => gpu.createBuffer({ label: label(name), size: Math.max(16, Math.ceil(size / 16) * 16), usage });
    this.age = buf('age', n * 4);
    this.dlist = buf('dirty lists', this.lists.words * 4, S | CS | GPUBufferUsage.INDIRECT);
    this.ema = buf('field EMA', EMA_PLANES * slots * 4);
    this.tmpA = buf('field scratch A', TMP_PLANES * slots * 4, S | CS);
    this.tmpB = buf('field scratch B', TMP_PLANES * slots * 4, S | CS | CD);   // (resetGI clears a run of it)
    this.blurred = buf('fields blurred', BLURRED_PLANES * slots * 4, S);
    this.brick = buf('brick', n * 16);
    this.brickDist = buf('brickDist', n * 4);
    this.scratchB = buf('brick scratch', n * 16, S | CS);
    this.lightA = buf('light blur A', n * 16, S);
    this.lightB = buf('light blur B', n * 16, S);
    this.giHist = buf('GI history', GI_BANDS * n * 8);
    this.giSrc = buf('GI sources', n * 16);   // (copyable: tools/gi-check.mjs seeds and reads it)
    this.noAer = buf('no aeration', 16, S);
    const TB = GPUTextureUsage.TEXTURE_BINDING, SB = GPUTextureUsage.STORAGE_BINDING, TS = GPUTextureUsage.COPY_SRC, TD = GPUTextureUsage.COPY_DST;
    const tex = (name, size, usage = TB | SB | TS | TD) => gpu.createTexture({ label: label(name), size, dimension: '3d', format: FIELD_FORMAT, usage });
    const cells = [g.nx, g.ny, g.nz], bricks = [g.bx, g.by, g.bz];
    this.fieldSurf = tex('fieldSurf', cells);
    this.fieldMedia = tex('fieldMedia', cells);
    this.fieldThin = tex('fieldThin', cells);
    this.light = tex('light', bricks, TB | SB | TS);
    this.giTextures = [0, 1, 2, 3].map((k) => tex(`gi${k}`, bricks));
    this.fieldsTmp = null;
    const view = (t) => t.createView({ dimension: '3d' });
    this.views = {
      fieldSurf: view(this.fieldSurf), fieldMedia: view(this.fieldMedia), fieldThin: view(this.fieldThin),
      light: view(this.light), gi: this.giTextures.map(view),
    };

    // ---- bind groups (B6) ----
    const L = (this.L = derivedLayouts(gpu));
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    const t = (binding, v) => ({ binding, resource: v });
    const field = (name, src, dst) => gpu.bindGroup(L.FIELD, [b(0, this.dlist), b(1, src), b(2, dst)], name);
    const pair = (name, src, dst) => gpu.bindGroup(L.PAIR, [b(0, src), b(1, dst)], name);
    const v = this.views;
    this.groups = {
      book: gpu.bindGroup(L.BOOK, [b(0, this.age), b(1, this.dlist)], 'derived book'),
      // the blur: x, y, then z normalised into the half-float planes
      blur: [field('blur x', this.ema, this.tmpA), field('blur y', this.tmpA, this.tmpB), field('blur z', this.tmpB, this.blurred)],
      // the boost's smoothing: x from the blur (with the EMA and the peak, _jetGroups), then y and z
      boost: [null, field('boost y', this.tmpA, this.tmpB), field('boost z', this.tmpB, this.tmpA)],
      brick: gpu.bindGroup(L.BRICK, [b(0, this.dlist), t(1, v.fieldSurf), t(2, v.fieldMedia), t(3, v.fieldThin), b(4, this.brick)], 'brick'),
      // empty-space distance: x from the brick map, y, z (ends in brickDist)
      dist: [pair('brickDist x', this.brick, this.brickDist), pair('brickDist y', this.brickDist, this.scratchB),
        pair('brickDist z', this.scratchB, this.brickDist)],
      // the light blur (docs/webgpu.md H2): brick → A, A → B, B → A, …, A → the light volume
      light: { fromBrick: pair('light from brick', this.brick, this.lightA), aToB: pair('light A→B', this.lightA, this.lightB),
        bToA: pair('light B→A', this.lightB, this.lightA),
        aToLight: gpu.bindGroup(L.LIGHT, [b(0, this.lightA), t(1, v.light)], 'light A→volume') },
    };
    this._jetBuffer = null;
    this._jetGroups(this.noAer);

    // ---- kernels (B5): built now; the shift's on a world's grid (else on first use: prepare) ----
    const SL = sim.L, E = gpu.L.EMPTY;
    const kernel = (name, code, group1, group2, params = null) => gpu.kernel({ name, code, layouts: [SL.TABLES, group1, group2], params, workgroupSize: [64, 1, 1] });
    this.kernels = {
      age: kernel('age', ageFrag(g), SL.STATE_BUILD, L.BOOK, AgeParams),
      dirty: kernel('dirty', dirtyFrag(g), E, L.BOOK),
      dirtyArgs: kernel('dirtyArgs', dirtyArgsFrag(g), E, L.BOOK),
      fieldEma: kernel('fieldEma', fieldEmaFrag(g), SL.STATE_RO, L.JET, EmaParams),
      fieldBlur: kernel('fieldBlur', fieldBlurFrag(g, false), E, L.FIELD, FieldBlurParams),
      fieldFinal: kernel('fieldFinal', fieldBlurFrag(g, true), E, L.FIELD, FieldBlurParams),
      fieldBoost0: kernel('fieldBoost0', fieldBoostFrag(g, 0), SL.STATE_RO, L.JET, BoostParams),
      fieldBoost: kernel('fieldBoost', fieldBoostFrag(g, 1), E, L.FIELD, BoostParams),
      fieldPeak: kernel('fieldPeak', fieldPeakFrag(g), E, L.PEAK, PeakParams),
      brick: kernel('brick', brickFrag(g), SL.STATE_RO, L.BRICK),
      brickDist: kernel('brickDist', brickDistFrag(g), E, L.PAIR, BrickDistParams),
      blur: kernel('blur', blurFrag(g), E, L.PAIR, BlurParams),
      blurLast: kernel('blurLast', blurFrag(g, { last: true }), E, L.LIGHT, BlurParams),
    };
    this.passes = {};
    this._lazy = {
      fieldShift: () => kernel('fieldShift', fieldShiftFrag(g), E, L.PAIR, FieldShiftParams),
      brickShift: () => kernel('brickShift', brickShiftFrag(g), E, L.PAIR, BrickShiftParams),
      giShift: () => kernel('giShift', giShiftFrag(g), E, L.GI_SHIFT, GiShiftParams),
      fieldMax: () => kernel('fieldMax', fieldMaxFrag(g), E, L.FIELD, MaxParams),
      brickBits: () => kernel('brickBits', brickBitsFrag(g), E, L.PAIR),
    };
    if (g.windowed) this.prepare('shift');
    // (a world's grid moves: its shift's kernels are part of what it waits for)
    this.ready = Promise.all([...Object.values(this.kernels), ...Object.values(this.passes)].map((k) => k.ready)).then(() => this);

    // a new derived history: every brick starts over
    sim.changedAll = true;
    sim.fieldReset = true;
    sim.giReset = true;
    sim.attachDerived(this);
    this._offShift = sim.onShift((dx, dz) => this.shift(dx, dz));
  }

  /**
   * Builds the kernels made only on demand: 'shift' (the window's: a grid
   * made without `windowed`), 'fieldMax' (derived-check's separable
   * reference), 'brickBits' (the decode test). Resolves when they're ready.
   * @param {...string} names
   */
  prepare(...names) {
    const list = names.flatMap((n) => (n === 'shift' ? ['fieldShift', 'brickShift', 'giShift'] : [n]));
    return Promise.all(list.map((n) => this.passOf(n).ready));
  }

  passOf(name) { return (this.passes[name] ??= this._lazy[name]()); }

  // The bind groups that hold the aeration buffer (the EMA, the boost's
  // stage 0, the peak), made for `buffer`: the whitewater's, or noAer.
  _jetGroups(buffer) {
    const gpu = this.gpu, L = this.L, v = this.views;
    const b = (binding, buf) => ({ binding, resource: { buffer: buf } });
    const t = (binding, view) => ({ binding, resource: view });
    const jet = (name, src, dst) => gpu.bindGroup(L.JET, [b(0, this.dlist), b(1, src), b(2, dst), b(3, buffer)], name);
    this.groups.ema = jet('field EMA', this.age, this.ema);
    this.groups.boost[0] = jet('boost x', this.blurred, this.tmpA);
    this.groups.peak = gpu.bindGroup(L.PEAK, [b(0, this.dlist), b(1, this.tmpA), b(2, this.blurred),
      t(3, v.fieldSurf), t(4, v.fieldMedia), t(5, v.fieldThin), b(6, buffer)], 'field peak');
    this._jetBuffer = buffer;
  }

  // Falling water's input (shaders/fields.js jetWGSL), as the field passes'
  // params take it: 0 while whitewater's aeration field doesn't run, else 1 +
  // its current copy. sim.aeration (gfx/foam.js) is { active, buffer (both
  // copies, array<vec2u>), cur }; the groups follow its buffer.
  _jet() {
    const aer = this.sim.aeration;
    const on = Boolean(aer?.active && aer.buffer);
    const buffer = on ? aer.buffer : this.noAer;
    if (buffer !== this._jetBuffer) this._jetGroups(buffer);
    return on ? 1 + (aer.cur ? 1 : 0) : 0;
  }

  // Records a dispatch into the frame's compute pass and tells the profiler.
  _dispatch(kernel, size, opts) {
    kernel.dispatch(this.gpu.frame, size, opts);
    this.sim.onPass?.(kernel.name, { kind: 'compute', gpuMs: null });
  }

  // a list's indirect arguments (fold()ed by dirtyArgs)
  _over(list) { return { indirect: this.dlist, offset: (this.lists.args + 4 * list) * 4 }; }

  get _perBrick() { return fold(Math.ceil(this.g.nbricks / 64)); }

  // ---- the passes ----

  /**
   * Which bricks the derived passes rebuild this frame (docs/scaling.md D9):
   * the ages from what changed since the last call, then the dirty sets'
   * lists and their indirect arguments.
   */
  updateDirty() {
    const sim = this.sim;
    this._carry();
    // a new kernel or a reset changes the fields everywhere, and so does the
    // aeration starting or stopping: falling water's input is read everywhere
    // or nowhere (a choice the WebGL build didn't make: it kept what settled
    // bricks held, so incremental and full could differ there)
    if (sim.smoothing !== this.lastSmoothing || sim.fieldReset) sim.changedAll = true;
    this.lastSmoothing = sim.smoothing;
    const jet = this._jet() !== 0;
    if (jet !== this.lastJet && !(this.gpu.testMode && this.test.dropJetToggle)) sim.changedAll = true;
    this.lastJet = jet;
    const { age, dirty, dirtyArgs } = this.kernels;
    const book = this.groups.book, tables = sim.tables;
    this._dispatch(age, this._perBrick, {
      bind: [tables, sim.bindBuild, book], header: sim.header(),
      params: { steps: sim.actNoted, all: sim.changedAll || !sim.incremental, tick: 1 },
    });
    sim.changedAll = false;
    sim.actNoted = false;
    this._dispatch(dirty, this._perBrick, { bind: [tables, this.gpu.emptyGroup, book] });
    this._dispatch(dirtyArgs, [1, 1, 1], { bind: [tables, this.gpu.emptyGroup, book] });
  }

  // The quiet map still current at the last age pass, if steps used it since:
  // its bricks into `changed` (sim.noteAwake), for the age pass about to run.
  _carry() {
    const sim = this.sim;
    if (sim.actCarry !== null && sim.actAge > sim.actCarry) sim.noteAwake();
    sim.actCarry = sim.actAge;
  }

  /**
   * The render fields over the dirty sets (shaders/fields.js): the EMA over
   * EMA, the blur and the boost's smoothing over WORK, the peak and the final
   * fields over FIELDS. The rest of every buffer and texture keeps what it
   * holds, which is what these passes would write there again.
   */
  updateFields() {
    const sim = this.sim, k = this.kernels, gr = this.groups, tables = sim.tables, empty = this.gpu.emptyGroup;
    const reset = sim.fieldReset;
    sim.fieldReset = false;
    const { w, bulk, s } = fieldWeights(sim.smoothing);
    const aer = this._jet();   // (the groups below follow its buffer)
    this._dispatch(k.fieldEma, this._over(DIRTY.EMA), {
      bind: [tables, sim.bindRO, gr.ema], header: sim.header(),
      params: { emaS: CHANNELS.map((c) => c.ema), emaM: MEDIA.map((m) => m.ema), reset, aer },
    });
    const work = this._over(DIRTY.WORK);
    for (let axis = 0; axis < 3; axis++) {
      this._dispatch(axis === 2 ? k.fieldFinal : k.fieldBlur, work, { bind: [tables, empty, gr.blur[axis]], params: { w, axis } });
    }
    for (let axis = 0; axis < 3; axis++) {
      const bind = axis ? [tables, empty, gr.boost[axis]] : [tables, sim.bindRO, gr.boost[0]];
      this._dispatch(axis ? k.fieldBoost : k.fieldBoost0, work, { bind, header: sim.header(), params: { s, axis, aer } });
    }
    this._dispatch(k.fieldPeak, this._over(DIRTY.FIELDS), { bind: [tables, empty, gr.peak], params: { bulk, reach: [1, 1, 1], aer } });
  }

  /**
   * The derived frame (docs/webgpu.md E): the dirty sets, the render fields,
   * the brick map over FIELDS, then over every brick the empty-space distance
   * and the glow volume.
   */
  updateBricks() {
    const sim = this.sim, k = this.kernels, gr = this.groups, tables = sim.tables, empty = this.gpu.emptyGroup;
    this.updateDirty();
    this.updateFields();
    this._dispatch(k.brick, this._over(DIRTY.FIELDS), { bind: [tables, sim.bindRO, gr.brick], header: sim.header() });
    const per = this._perBrick;
    for (let axis = 0; axis < 3; axis++) this._dispatch(k.brickDist, per, { bind: [tables, empty, gr.dist[axis]], params: { axis } });
    const { fromBrick, aToB, bToA, aToLight } = gr.light;
    for (let i = 0; i < LIGHT_BLUR_PASSES; i++) {
      const last = i === LIGHT_BLUR_PASSES - 1;
      const group = last ? aToLight : i === 0 ? fromBrick : i & 1 ? aToB : bToA;
      this._dispatch(last ? k.blurLast : k.blur, per, { bind: [tables, empty, group], params: { axis: i % 3 } });
    }
  }

  // ---- the GI probes (shaders/gi.js; docs/webgpu.md E) ----

  /**
   * The GI probes (the realistic view; after the shadow map, which it reads
   * for sunlight): giSource over every brick, then giGather over half the
   * probes, alternating (all of them, replacing, after a reset: sim.giReset),
   * blended into the history and the four band textures. FrameUniforms must
   * have been written on this tick (B3): the sun, the sky, the shadow map's
   * size, the far field's switch. The kernels build on the first call, or on
   * prepareGI() (B5: no other view has GI); until they are ready this records
   * nothing and the probes stay as they are.
   *
   * Two call shapes. The WebGL build's, which callers keep (docs/webgpu.md E):
   * updateGI(sun, shadow, shadowRes, shadows), where the sun and shadowRes
   * are FrameUniforms' now and are ignored here, and shadows defaults to true.
   * Or updateGI({ frame, shadow, shadows }).
   *   frame: group 0 of render kernels; by default the gpu's FrameUniforms
   *     group (gfx/uniforms.js frameUniformsOf(gpu).group, which it keeps on
   *     the gpu: no three import here). Throws if there is none at all.
   *   shadow: the sun's shadow map, { map, x }, recorded earlier in the frame
   *     (gfx/volume.js volume.shadowTextures);
   *   shadows: the sun is shadowed by it, as the WebGL updateGI's `shadows`
   *     (without a map: unshadowed)
   * @param {...*} args
   * @returns {boolean} whether it recorded
   */
  updateGI(...args) {
    const [a] = args;
    const positional = args.length > 1 || typeof a?.x === 'number' || Array.isArray(a);
    const {
      frame = this.gpu._frameUniforms?.group, shadow = null, shadows = true,
    } = positional ? { shadow: args[1] ?? null, shadows: args[3] ?? true } : (a ?? {});
    if (!frame) throw new Error('derived.updateGI: no frame group (gfx/uniforms.js frameUniformsOf(gpu).group, written this tick)');
    const k = this.giKernels();
    if (k.giSource.state !== 'ready' || k.giGather.state !== 'ready') {
      this.prepareGI().catch(() => {});   // (a kernel that fails stops graphics through gpu.fail)
      return false;
    }
    const sim = this.sim, g = this.g, header = sim.header();
    const sun = Boolean(shadows && shadow?.map);
    this._dispatch(k.giSource, giSourceDispatch(g), {
      bind: [frame, sim.bindRO, this._giGroup('LIGHTING_GISRC', shadow)], header, params: { shadows: sun },
    });
    // after a reset trace every probe and replace; else half of them, blended in
    sim.giFrame = (sim.giFrame ?? 0) + 1;
    const parity = sim.giReset ? -1 : sim.giFrame & 1;
    const blend = sim.giReset ? 1 : GI_BLEND;
    sim.giReset = false;
    this._dispatch(k.giGather, giGatherDispatch(g, parity), {
      bind: [frame, sim.bindRO, this._giGroup('LIGHTING_GI', shadow)], header,
      params: { parity, count: giProbeCount(g, parity), blend, shadows: sun },
    });
    return true;
  }

  /**
   * The GI's kernels, { giSource, giGather } (gpu.kernels, made on first use
   * and built by prepareGI or updateGI). The gather holds the far layout of
   * the world this grid is a window of (a box: WORLD_SIZE's, off), as the
   * shadow kernel does.
   */
  giKernels() {
    if (!this._giKernels) {
      const gpu = this.gpu, g = this.g;
      const kernel = (name, code, variant) => gpu.kernel({
        name, code, params: GiParams, workgroupSize: [64, 1, 1], build: 'manual',
        layouts: GI_LAYOUT_NAMES[name].map((n, i) => gpu.layout(n, libLayouts(variant)[i])),
      });
      this._giKernels = {
        giSource: kernel('giSource', giSourceFrag(g), 'LIGHTING_GISRC'),
        giGather: kernel('giGather', giGatherFrag(g, { world: this.world ?? WORLD_SIZE }), 'LIGHTING_GI'),
      };
    }
    return this._giKernels;
  }

  /** Builds the GI's kernels (booting in the realistic view, or switching to it); resolves when they're ready. */
  prepareGI() {
    const k = this.giKernels();
    return Promise.all([k.giSource.build(), k.giGather.build()]);
  }

  // Group 2 of a GI kernel (shaders/bindings.js L.LIGHTING_GISRC or
  // L.LIGHTING_GI): this module's resources (the fields, light, the bands,
  // the brick map, giSrc, the history), the shadow map (stand-ins without one:
  // never read then), the media noise (the clouds' shadow), the far field's
  // textures (attachFar; stand-ins in a box: FrameUniforms.far keeps them
  // unread), the samplers, and for the source the flow and a stand-in for the
  // aeration, which no GI code reads. One per variant, shadow map and far field.
  _giGroup(variant, shadow) {
    const gpu = this.gpu, sim = this.sim;
    if (!this._gi) {
      const T = GPUTextureUsage.TEXTURE_BINDING;
      const dummy = (gpu._giDummies ??= {
        map: gpu.createTexture({ label: 'GI shadow map (none)', size: [1, 1], format: 'rgba32float', usage: T }),
        x: gpu.createTexture({ label: 'GI shadow map x (none)', size: [1, 1], format: 'r32float', usage: T }),
        grid: gpu.createTexture({ label: 'GI far grid (none)', size: [1, 1, 1], dimension: '3d', format: 'rgba16uint', usage: T }),
        flat: gpu.createTexture({ label: 'GI far 2d (none)', size: [1, 1], format: 'rgba16float', usage: T }),
      });
      const sampler = (address) => gpu.device.createSampler({
        label: `GI linear ${address}`, magFilter: 'linear', minFilter: 'linear', addressModeU: address, addressModeV: address, addressModeW: address,
      });
      this._gi = {
        dummy, noise: createMediaNoise(gpu), clamp: sampler('clamp-to-edge'), repeat: sampler('repeat'),
        groups: new Map(), views: new WeakMap(), ids: new WeakMap(), next: 1,
      };
    }
    const r = this._gi;
    const view = (t) => {
      if (!(t instanceof GPUTexture)) return t;   // (a view already)
      let v = r.views.get(t);
      if (!v) r.views.set(t, v = t.createView({ label: t.label, ...(t.dimension === '3d' ? { dimension: '3d' } : {}) }));
      return v;
    };
    const far = this.far;
    const parts = [shadow?.map ?? r.dummy.map, shadow?.x ?? r.dummy.x, far?.grid ?? r.dummy.grid, far?.top ?? r.dummy.flat, far?.shadow ?? r.dummy.flat];
    const idOf = (o) => { let id = r.ids.get(o); if (!id) r.ids.set(o, id = r.next++); return id; };
    const key = `${variant}|${parts.map(idOf).join('|')}`;
    let group = r.groups.get(key);
    if (!group) {
      if (r.groups.size >= 8) r.groups.clear();   // (shadow maps and far fields come and go with grids and worlds)
      const b = (binding, buffer) => ({ binding, resource: { buffer } });
      const layout = libLayouts(variant)[2], has = new Set(layout.map((e) => e.binding));
      // every resource either variant can hold, kept where the layout has its
      // binding (so a layout that drops one, as LIGHTING_GI drops 18 and 19,
      // needs no change here)
      const entries = [
        ...this.lightingEntries(),
        ...parts.map((t, i) => ({ binding: [8, 9, 11, 12, 13][i], resource: view(t) })),
        { binding: 10, resource: r.noise.view }, { binding: 14, resource: r.clamp }, { binding: 15, resource: r.repeat },
        b(18, sim.state.flow), b(19, this.noAer), b(20, this.giSrc), b(21, this.giHist),
      ].filter((e) => has.has(e.binding));
      group = gpu.bindGroup(gpu.layout(variant, layout), entries, `sim${sim.id} ${variant}`);
      r.groups.set(key, group);
    }
    return group;
  }

  /**
   * The GI probe of brick b ([x, y, z] in bricks) as it is at this call
   * (the copy is recorded now, B7): its four bands, rgba each, band k's at
   * 4k (what pov/viewmodel.js reads at the eye for the hands' light). Null
   * for a brick outside the grid (any coordinate not an integer in [0, B) on
   * its axis), which has no probe: the WebGL reader tested `inside` first.
   * @param {number[]} b
   * @returns {Promise<Float32Array | null>}
   */
  async readProbe([x, y, z]) {
    const g = this.g, n = g.nbricks, rb = this.gpu.readback;
    const inside = (v, hi) => Number.isInteger(v) && v >= 0 && v < hi;
    if (!(inside(x, g.bx) && inside(y, g.by) && inside(z, g.bz))) return null;
    const id = brickIdOf(g, x, y, z);
    const bands = await Promise.all([0, 1, 2, 3].map((k) => rb.buffer(this.giHist, (k * n + id) * 8, 8)));
    const out = new Float32Array(16);
    bands.forEach((bytes, k) => out.set(halfsToFloats(new Uint16Array(bytes)), 4 * k));
    return out;
  }

  /** Starts the GI probes over: their history and their four textures to zeros. */
  resetGI() {
    this.sim.giFrame = 0;   // (and the checkerboard from its start, as a new Derived)
    const f = this.gpu.frame, g = this.g;
    f.clear(this.giHist);
    // the textures from a zeroed run of the scratch (rows padded to 256 bytes, as copies want)
    const bytesPerRow = Math.ceil((g.bx * 8) / 256) * 256, size = bytesPerRow * g.by * g.bz;
    f.clear(this.tmpB, 0, size);
    const enc = f.direct();
    for (const t of this.giTextures) {
      enc.copyBufferToTexture({ buffer: this.tmpB, bytesPerRow, rowsPerImage: g.by }, { texture: t }, [g.bx, g.by, g.bz]);
    }
  }

  /**
   * The far field's textures for the GI's far branch (docs/webgpu.md E;
   * src/wire/world.js calls it): shaders/gi.js binds them.
   * @param {object | null} far
   */
  attachFar(far) { this.far = far ?? null; }

  /**
   * The resources of shaders/bindings.js L.LIGHTING this module owns, as bind
   * group entries: the final fields (0-2), the glow volume (3), the GI bands
   * (4-7), the brick map (16) and its distances (17). The volume, shadow, GI
   * and the sign probe add the rest (docs/webgpu.md F6). Made once per grid:
   * a new grid has a new Derived.
   * @returns {GPUBindGroupEntry[]}
   */
  lightingEntries() {
    const v = this.views;
    return [
      { binding: 0, resource: v.fieldSurf }, { binding: 1, resource: v.fieldMedia }, { binding: 2, resource: v.fieldThin },
      { binding: 3, resource: v.light },
      ...v.gi.map((resource, i) => ({ binding: 4 + i, resource })),
      { binding: 16, resource: { buffer: this.brick } }, { binding: 17, resource: { buffer: this.brickDist } },
    ];
  }

  // ---- the window's shift (docs/webgpu.md E, D8.12) ----

  // sim.onShift: the window moved by (dx, 0, dz) cells (whole supertiles), after
  // the state. Every buffer shifts out of place, through a scratch it is then
  // copied back from; the final fields through a texture of their own (a
  // texture can't copy onto an overlapping region of itself).
  shift(dx, dz) {
    const sim = this.sim, g = this.g, gpu = this.gpu;
    if (!sim.shiftKeepsHistory) return;   // the history starts over (sim.shift sets fieldReset, giReset)
    const p = this.passes;
    if (![p.fieldShift, p.brickShift, p.giShift].every((x) => x?.state === 'ready')) {
      // (a grid made without `windowed` that hasn't prepared its shift: start over)
      console.warn('derived: the shift\'s kernels aren\'t ready (derived.prepare(\'shift\')): the derived history starts over');
      sim.changedAll = sim.fieldReset = sim.giReset = true;
      return;
    }
    const f = gpu.frame, tables = sim.tables, empty = gpu.emptyGroup, L = this.L, n = g.nbricks;
    // The changes since the last age pass that it hasn't counted yet: the
    // writers' marks and the steps' `changed` map (with the carry from the
    // quiet map still current) are kept by brick number, where the bricks were
    // before this move. The age pass's fold (tick 0) notes them in each
    // brick's own word (AGE.CHANGED), which moves with it below; the next
    // derived frame counts them as its own. `changed` is consumed (the next
    // map's note starts it over), and a whole-grid change (changedAll, a reset)
    // is the same everywhere, so it waits for that frame.
    if (!(gpu.testMode && this.test.dropFold)) {
      this._carry();
      this._dispatch(this.kernels.age, this._perBrick, {
        bind: [tables, sim.bindBuild, this.groups.book], header: sim.header(), params: { steps: sim.actNoted, all: false, tick: 0 },
      });
      sim.actNoted = false;
    }
    const sb = [dx / BRICK, 0, dz / BRICK];
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    this._shiftGroups ??= {
      age: gpu.bindGroup(L.PAIR, [b(0, this.age), b(1, this.scratchB)], 'age shift'),
      brick: gpu.bindGroup(L.PAIR, [b(0, this.brick), b(1, this.scratchB)], 'brick shift'),
      brickDist: gpu.bindGroup(L.PAIR, [b(0, this.brickDist), b(1, this.scratchB)], 'brickDist shift'),
      ema: gpu.bindGroup(L.PAIR, [b(0, this.ema), b(1, this.tmpA)], 'EMA shift'),
      gi: gpu.bindGroup(L.GI_SHIFT, [b(0, this.giHist), b(1, this.tmpB),
        ...this.views.gi.map((resource, i) => ({ binding: 2 + i, resource }))], 'GI shift'),
    };
    const sg = this._shiftGroups;
    // the per-brick buffers: the ages (re-aging the bricks shifted in and the faces'), the brick map, its distances
    for (const [buffer, group, words, age] of [[this.age, sg.age, 1, 1], [this.brick, sg.brick, 4, 0], [this.brickDist, sg.brickDist, 1, 0]]) {
      this._dispatch(p.brickShift, this._perBrick, { bind: [tables, empty, group], params: { shift: sb, words, age } });
      f.copy(this.scratchB, 0, buffer, 0, n * words * 4);
    }
    // the EMA, cell by cell
    this._dispatch(p.fieldShift, fold(Math.ceil(g.slots / 64)), { bind: [tables, empty, sg.ema], params: { shift: [dx, 0, dz] } });
    f.copy(this.tmpA, 0, this.ema, 0, EMA_PLANES * g.slots * 4);
    // the final fields: the region that stays in the window, moved
    const w = g.nx - Math.abs(dx), d = g.nz - Math.abs(dz);
    if (w > 0 && d > 0) {
      this.fieldsTmp ??= gpu.createTexture({
        label: `sim${sim.id} fields shift`, size: [g.nx, g.ny, g.nz], dimension: '3d', format: FIELD_FORMAT,
        usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
      const from = [Math.max(dx, 0), 0, Math.max(dz, 0)], to = [Math.max(-dx, 0), 0, Math.max(-dz, 0)], size = [w, g.ny, d];
      const enc = f.direct();
      for (const t of [this.fieldSurf, this.fieldMedia, this.fieldThin]) {
        enc.copyTextureToTexture({ texture: t, origin: from }, { texture: this.fieldsTmp, origin: to }, size);
        enc.copyTextureToTexture({ texture: this.fieldsTmp, origin: to }, { texture: t, origin: to }, size);
      }
    }
    // the GI probes (unless they start over anyway)
    if (!sim.giReset) {
      this._dispatch(p.giShift, this._perBrick, { bind: [tables, empty, sg.gi], params: { shift: sb } });
      f.copy(this.tmpB, 0, this.giHist, 0, GI_BANDS * n * 8);
    }
  }

  // ---- reads, for tools (all asynchronous: docs/webgpu.md W6) ----

  /**
   * Every derived resource as it is at this call, raw (u32 words, or a
   * texture's half-float bits): { ema, fieldSurf, fieldMedia, fieldThin,
   * brick, brickDist, light, giHist, gi0..gi3 }.
   * @returns {Promise<Record<string, ArrayBufferView>>}
   */
  async read() {
    const rb = this.gpu.readback;
    const reads = {
      ema: rb.buffer(this.ema), fieldSurf: rb.texture(this.fieldSurf), fieldMedia: rb.texture(this.fieldMedia),
      fieldThin: rb.texture(this.fieldThin), brick: rb.buffer(this.brick, 0, this.g.nbricks * 16),
      brickDist: rb.buffer(this.brickDist, 0, this.g.nbricks * 4), light: rb.texture(this.light),
      giHist: rb.buffer(this.giHist, 0, GI_BANDS * this.g.nbricks * 8),
      ...Object.fromEntries(this.giTextures.map((t, i) => [`gi${i}`, rb.texture(t)])),
    };
    const out = {};
    for (const [k, p] of Object.entries(reads)) {
      const x = await p;
      out[k] = ArrayBuffer.isView(x) ? x : new Uint32Array(x);
    }
    return out;
  }

  /**
   * The dirty sets' lengths as the last derived frame built them, and the
   * ages (u32 per brick, brickId order) as they are at this call.
   * @returns {Promise<{ ema: number, fields: number, work: number, ages: Uint32Array }>}
   */
  async readLists() {
    const rb = this.gpu.readback;
    const [last, ages] = await Promise.all([rb.buffer(this.dlist, this.lists.last * 4, 16), rb.buffer(this.age, 0, this.g.nbricks * 4)]);
    const [ema, fields, work] = new Uint32Array(last);
    return { ema, fields, work, ages: new Uint32Array(ages) };
  }

  dispose() {
    this._offShift?.();
    if (this.sim.derived === this) this.sim.attachDerived(null);
    if (!this.gpu.failure) this.gpu.flush('derived dispose');
    for (const x of [this.age, this.dlist, this.ema, this.tmpA, this.tmpB, this.blurred, this.brick, this.brickDist, this.scratchB,
      this.lightA, this.lightB, this.giHist, this.giSrc, this.noAer, this.fieldSurf, this.fieldMedia, this.fieldThin, this.light,
      ...this.giTextures, this.fieldsTmp]) x?.destroy();
  }
}
