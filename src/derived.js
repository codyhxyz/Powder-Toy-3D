import { BRICK } from './shaders/common.js';
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

// The derived passes (docs/webgpu.md E): what the renderer reads of the
// simulation, rebuilt from its state once per derived frame, in the open
// frame's compute pass. The render fields (shaders/fields.js), the brick map,
// its empty-space distance and the glow volume (shaders/passes.js), and the
// GI probes' storage, which shaders/gi.js fills (updateGI; zeros until then).
// The simulation delegates to it: sim.updateBricks(), sim.updateGI(),
// sim.resetGI() and the getters (sim.fieldSurf, sim.brick, …).
//
//   const derived = new Derived(sim);   // attaches itself (sim.attachDerived)
//   await derived.ready;                // its pipelines (built asynchronously, B5)
//   sim.step(); sim.updateBricks();     // the volume then binds derived.lightingEntries()
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
// (shift below).

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

// Planes (u32 words a cell) of the field passes' buffers (shaders/fields.js), and the GI's bands.
const EMA_PLANES = 3, TMP_PLANES = 3, BLURRED_PLANES = 4;
const GI_BANDS = 4;

// The group-2 layouts, named in gpu.L (docs/webgpu.md C4).
function derivedLayouts(gpu) {
  const L = {};
  for (const [name, entries] of Object.entries({
    BOOK: DERIVED_LAYOUT.BOOK, FIELD: FIELD_LAYOUT.FIELD, PEAK: FIELD_LAYOUT.PEAK, BRICK: DERIVED_LAYOUT.BRICK,
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
    this.lastSmoothing = null;
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
    this.tmpB = buf('field scratch B', TMP_PLANES * slots * 4, S | CS);
    this.blurred = buf('fields blurred', BLURRED_PLANES * slots * 4, S);
    this.brick = buf('brick', n * 16);
    this.brickDist = buf('brickDist', n * 4);
    this.scratchB = buf('brick scratch', n * 16, S | CS);
    this.lightA = buf('light blur A', n * 16, S);
    this.lightB = buf('light blur B', n * 16, S);
    this.giHist = buf('GI history', GI_BANDS * n * 8);
    this.giSrc = buf('GI sources', n * 16, S);
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
      ema: field('field EMA', this.age, this.ema),
      // the blur: x, y, then z normalised into the half-float planes
      blur: [field('blur x', this.ema, this.tmpA), field('blur y', this.tmpA, this.tmpB), field('blur z', this.tmpB, this.blurred)],
      // the boost's smoothing: x from the blur, then y and z
      boost: [field('boost x', this.blurred, this.tmpA), field('boost y', this.tmpA, this.tmpB), field('boost z', this.tmpB, this.tmpA)],
      peak: gpu.bindGroup(L.PEAK, [b(0, this.dlist), b(1, this.tmpA), b(2, this.blurred),
        t(3, v.fieldSurf), t(4, v.fieldMedia), t(5, v.fieldThin)], 'field peak'),
      brick: gpu.bindGroup(L.BRICK, [b(0, this.dlist), t(1, v.fieldSurf), t(2, v.fieldMedia), t(3, v.fieldThin), b(4, this.brick)], 'brick'),
      // empty-space distance: x from the brick map, y, z (ends in brickDist)
      dist: [pair('brickDist x', this.brick, this.brickDist), pair('brickDist y', this.brickDist, this.scratchB),
        pair('brickDist z', this.scratchB, this.brickDist)],
      // the light blur (docs/webgpu.md H2): brick → A, A → B, B → A, …, A → the light volume
      light: { fromBrick: pair('light from brick', this.brick, this.lightA), aToB: pair('light A→B', this.lightA, this.lightB),
        bToA: pair('light B→A', this.lightB, this.lightA),
        aToLight: gpu.bindGroup(L.LIGHT, [b(0, this.lightA), t(1, v.light)], 'light A→volume') },
    };

    // ---- kernels (B5): built now; the shift's on a world's grid (else on first use: prepare) ----
    const SL = sim.L, E = gpu.L.EMPTY;
    const kernel = (name, code, group1, group2, params = null) => gpu.kernel({ name, code, layouts: [SL.TABLES, group1, group2], params, workgroupSize: [64, 1, 1] });
    this.kernels = {
      age: kernel('age', ageFrag(g), SL.STATE_BUILD, L.BOOK, AgeParams),
      dirty: kernel('dirty', dirtyFrag(g), E, L.BOOK),
      dirtyArgs: kernel('dirtyArgs', dirtyArgsFrag(g), E, L.BOOK),
      fieldEma: kernel('fieldEma', fieldEmaFrag(g), SL.STATE_RO, L.FIELD, EmaParams),
      fieldBlur: kernel('fieldBlur', fieldBlurFrag(g, false), E, L.FIELD, FieldBlurParams),
      fieldFinal: kernel('fieldFinal', fieldBlurFrag(g, true), E, L.FIELD, FieldBlurParams),
      fieldBoost0: kernel('fieldBoost0', fieldBoostFrag(g, 0), SL.STATE_RO, L.FIELD, BoostParams),
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
    // the quiet map still current at the last call, if steps used it since
    if (sim.actCarry !== null && sim.actAge > sim.actCarry) sim.noteAwake();
    sim.actCarry = sim.actAge;
    // a new kernel or a reset changes the fields everywhere
    if (sim.smoothing !== this.lastSmoothing || sim.fieldReset) sim.changedAll = true;
    this.lastSmoothing = sim.smoothing;
    const { age, dirty, dirtyArgs } = this.kernels;
    const book = this.groups.book, tables = sim.tables;
    this._dispatch(age, this._perBrick, {
      bind: [tables, sim.bindBuild, book], header: sim.header(),
      params: { steps: sim.actNoted, all: sim.changedAll || !sim.incremental },
    });
    sim.changedAll = false;
    sim.actNoted = false;
    this._dispatch(dirty, this._perBrick, { bind: [tables, this.gpu.emptyGroup, book] });
    this._dispatch(dirtyArgs, [1, 1, 1], { bind: [tables, this.gpu.emptyGroup, book] });
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
    this._dispatch(k.fieldEma, this._over(DIRTY.EMA), {
      bind: [tables, sim.bindRO, gr.ema], header: sim.header(),
      params: { emaS: CHANNELS.map((c) => c.ema), emaM: MEDIA.map((m) => m.ema), reset },
    });
    const work = this._over(DIRTY.WORK);
    for (let axis = 0; axis < 3; axis++) {
      this._dispatch(axis === 2 ? k.fieldFinal : k.fieldBlur, work, { bind: [tables, empty, gr.blur[axis]], params: { w, axis } });
    }
    for (let axis = 0; axis < 3; axis++) {
      const bind = axis ? [tables, empty, gr.boost[axis]] : [tables, sim.bindRO, gr.boost[0]];
      this._dispatch(axis ? k.fieldBoost : k.fieldBoost0, work, { bind, header: sim.header(), params: { s, axis } });
    }
    this._dispatch(k.fieldPeak, this._over(DIRTY.FIELDS), { bind: [tables, empty, gr.peak], params: { bulk, reach: [1, 1, 1] } });
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

  /**
   * The GI probes (realistic view; after the shadow map, which it reads for
   * sunlight): shaders/gi.js's, which fills this in (docs/webgpu.md J1 U9).
   * Until then the probes stay as they are (zeros), and this records nothing.
   */
  updateGI() {}

  /** Starts the GI probes over: their history and their four textures to zeros. */
  resetGI() {
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
      this.lightA, this.lightB, this.giHist, this.giSrc, this.fieldSurf, this.fieldMedia, this.fieldThin, this.light,
      ...this.giTextures, this.fieldsTmp]) x?.destroy();
  }
}
