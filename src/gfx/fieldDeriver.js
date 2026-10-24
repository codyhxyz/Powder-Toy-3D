// Field-only resources and recording. No simulation, lighting or physics ownership.
import {
  fieldEmaFrag, fieldBlurFrag, fieldBoostFrag, fieldPeakFrag, fieldShiftFrag, fieldMaxFrag,
  EmaParams, FieldBlurParams, BoostParams, PeakParams, FieldShiftParams, MaxParams,
  FIELD_LAYOUT, FIELD_FORMAT, DIRTY, dirtyLists, BLUR_TAPS, worldFieldParams,
} from '../shaders/fields.js';
import { CHANNELS, MEDIA, gauss5, bulkPeak, bulkPeakCubic, CUBIC_LATTICE } from './materials.js';

export const FIELD_RESOURCES = Object.freeze({ ema: 3, tmpA: 3, tmpB: 4, blurred: 4 });
export const FIELD_TEXTURES = Object.freeze(['fieldSurf', 'fieldMedia', 'fieldThin']);

export function createFieldResources(gpu, g, { label = (s) => s, normalizedCopySrc = false } = {}) {
  const U = GPUBufferUsage, T = GPUTextureUsage, r = {};
  const usage = { ema: U.STORAGE | U.COPY_SRC | U.COPY_DST, tmpA: U.STORAGE | U.COPY_SRC,
    tmpB: U.STORAGE | U.COPY_SRC | U.COPY_DST,
    blurred: U.STORAGE | U.COPY_DST | (normalizedCopySrc ? U.COPY_SRC : 0) };
  for (const [name, planes] of Object.entries(FIELD_RESOURCES)) {
    const names = { ema: 'field EMA', tmpA: 'field scratch A', tmpB: 'field scratch B', blurred: 'fields blurred' };
    r[name] = gpu.createBuffer({ label: label(names[name]), size: planes * g.slots * 4, usage: usage[name] });
  }
  r.views = {};
  for (const name of FIELD_TEXTURES) {
    r[name] = gpu.createTexture({ label: label(name), size: [g.nx, g.ny, g.nz], dimension: '3d', format: FIELD_FORMAT,
      usage: T.TEXTURE_BINDING | T.STORAGE_BINDING | T.COPY_SRC | T.COPY_DST });
    r.views[name] = r[name].createView({ dimension: '3d' });
  }
  return r;
}

export function createFieldLayouts(gpu, prefix = 'DERIVED') {
  return Object.fromEntries(Object.entries(FIELD_LAYOUT).map(([name, entries]) => [name, gpu.layout(`${prefix}_${name}`, entries)]));
}

export function createFieldKernels(gpu, g, { tablesLayout, stateLayout, layouts, domain = 'box' }) {
  const L = layouts, E = gpu.L.EMPTY;
  const kernel = (name, code, state, group, params) => gpu.kernel({ name, code,
    layouts: [tablesLayout, state ? stateLayout : E, group],
    params: domain === 'world' ? worldFieldParams(params) : params, workgroupSize: [64, 1, 1] });
  return {
    fieldEma: kernel('fieldEma', fieldEmaFrag(g, domain), true, L.JET, EmaParams),
    fieldBlur: kernel('fieldBlur', fieldBlurFrag(g, false, domain), false, L.FIELD, FieldBlurParams),
    fieldFinal: kernel('fieldFinal', fieldBlurFrag(g, true, domain), false, L.FIELD, FieldBlurParams),
    fieldBoost0: kernel('fieldBoost0', fieldBoostFrag(g, 0, domain), true, L.JET, BoostParams),
    fieldBoost: kernel('fieldBoost', fieldBoostFrag(g, 1, domain), false, L.FIELD, BoostParams),
    fieldPeak: kernel('fieldPeak', fieldPeakFrag(g, domain), true, L.PEAK, PeakParams),
  };
}

// Lazy Box helpers. tmpB remains owned by Derived (also used by GI reset/shift).
export function createFieldHelpers(gpu, g, tablesLayout, L) {
  const make = (name, code, group, params) => gpu.kernel({ name, code,
    layouts: [tablesLayout, gpu.L.EMPTY, group], params, workgroupSize: [64, 1, 1] });
  return {
    fieldShift: () => make('fieldShift', fieldShiftFrag(g), L.SHIFT, FieldShiftParams),
    fieldMax: () => make('fieldMax', fieldMaxFrag(g), L.FIELD, MaxParams),
  };
}

export function createFieldGroups(gpu, L, r) {
  const b = (binding, buffer) => ({ binding, resource: { buffer } });
  const field = (name, src, dst) => gpu.bindGroup(L.FIELD, [b(0, r.dlist), b(1, src), b(2, dst)], name);
  return {
    blur: [field('blur x', r.ema, r.tmpA), field('blur y', r.tmpA, r.tmpB), field('blur z', r.tmpB, r.blurred)],
    boost: [null, field('boost y', r.tmpA, r.tmpB), field('boost z', r.tmpB, r.tmpA)],
  };
}

export function bindFieldAeration(gpu, L, r, groups, buffer) {
  const b = (binding, buf) => ({ binding, resource: { buffer: buf } });
  const t = (binding, resource) => ({ binding, resource });
  const jet = (name, src, dst) => gpu.bindGroup(L.JET, [b(0, r.dlist), b(1, src), b(2, dst), b(3, buffer)], name);
  groups.ema = jet('field EMA', r.age, r.ema);
  groups.boost[0] = jet('boost x', r.blurred, r.tmpA);
  groups.peak = gpu.bindGroup(L.PEAK, [b(0, r.dlist), b(1, r.tmpA), b(2, r.blurred),
    t(3, r.views.fieldSurf), t(4, r.views.fieldMedia), t(5, r.views.fieldThin), b(6, buffer)], 'field peak');
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

// Resources/groups are borrowed. Their allocator is their only destruction owner.
export class FieldDeriver {
  constructor(gpu, { g, resources, layouts, kernels, tables, groups = createFieldGroups(gpu, layouts, resources), onPass = null }) {
    Object.assign(this, { gpu, g, resources, layouts, kernels, tables, groups, onPass });
    this.lists = dirtyLists(g);
  }
  setAeration({ buffer, copy = 0, active = false }) {
    if (buffer !== this.aerBuffer) {
      bindFieldAeration(this.gpu, this.layouts, this.resources, this.groups, buffer);
      this.aerBuffer = buffer;
    }
    this.aer = active ? 1 + copy : 0;
    return this.aer;
  }
  _over(list) { return { indirect: this.resources.dlist, offset: (this.lists.args + 4 * list) * 4 }; }
  _dispatch(frame, name, size, opts, domain) {
    this.kernels[name].dispatch(frame, size, { ...opts, params: { ...opts.params, ...domain } });
    this.onPass?.(name, { kind: 'compute', gpuMs: null });
  }
  recordEMA(frame, { sourceGroup, header, reset = false, emaS = CHANNELS.map((c) => c.ema), emaM = MEDIA.map((m) => m.ema),
    domain, size = this._over(DIRTY.EMA) }) {
    this._dispatch(frame, 'fieldEma', size, { bind: [this.tables, sourceGroup, this.groups.ema], header,
      params: { emaS, emaM, reset, aer: this.aer } }, domain);
  }
  recordSpatial(frame, { sourceGroup, header, smoothing, domainFor = () => undefined,
    sizeFor = (stage) => this._over(stage.startsWith('boost') ? DIRTY.WORK : DIRTY.FIELDS), onStage = null }) {
    const { w, bulk, s } = fieldWeights(smoothing), empty = this.gpu.emptyGroup, gr = this.groups;
    for (let axis = 0; axis < 3; axis++) {
      const stage = `blur${axis}`;
      this._dispatch(frame, axis === 2 ? 'fieldFinal' : 'fieldBlur', sizeFor(stage),
        { bind: [this.tables, empty, gr.blur[axis]], header, params: { w, axis } }, domainFor(stage));   // (the header: a ringed grid's brick numbers)
      onStage?.(stage, frame, this.resources);
    }
    for (let axis = 0; axis < 3; axis++) {
      const stage = `boost${axis}`;
      const bind = axis ? [this.tables, empty, gr.boost[axis]] : [this.tables, sourceGroup, gr.boost[0]];
      this._dispatch(frame, axis ? 'fieldBoost' : 'fieldBoost0', sizeFor(stage), { bind, header, params: { s, axis, aer: this.aer } }, domainFor(stage));
      onStage?.(stage, frame, this.resources);
    }
    this._dispatch(frame, 'fieldPeak', sizeFor('peak'), { bind: [this.tables, sourceGroup, gr.peak], header,
      params: { bulk, reach: [1, 1, 1], aer: this.aer } }, domainFor('peak'));
    onStage?.('peak', frame, this.resources);
  }
}
