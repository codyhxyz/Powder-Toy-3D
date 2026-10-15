// World render ABI v1. Render-only; never allocates a Simulation.
// Public snapshots are immutable. Providers upload COMPLETE replacement pages;
// publication is a queue-ordered transaction, not an incremental readiness mask.
export const WORLD_ATLAS_ABI = 1;
export const READY = Object.freeze({ RAW: 1, FIELD: 2, AUX: 4, LIGHT: 8, ALL: 15 });
export const AUX_RECORDS = 132;
export const DEFAULT_WORLD_LIMITS = Object.freeze({
  maxTextureDimension2D: 8192, maxTextureArrayLayers: 256,
  maxStorageBufferBindingSize: 128 * 1024 ** 2, maxBufferSize: 256 * 1024 ** 2,
  maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4,
  maxSampledTexturesPerShaderStage: 16, maxBindGroups: 4,
});
const U32_MAX = 0xffffffff;
const BU = { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
const integer = (v, lo = 0, hi = U32_MAX) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const check = (ok, why) => { if (!ok) throw new RangeError(why); };
const frozen = (a) => Object.freeze(a);
// GPUSupportedLimits uses WebIDL prototype getters, not enumerable properties.
const limitsOf = supplied => Object.fromEntries(Object.entries(DEFAULT_WORLD_LIMITS).map(([k, v]) => [k, supplied?.[k] ?? v]));

export function worldBookLayout(worldSize, deviceLimits = {}) {
  const limits = limitsOf(deviceLimits);
  check(Array.isArray(worldSize) && worldSize.length === 3 && worldSize.every(n => integer(n, 4, 0x7ffffffc) && n % 4 === 0), 'worldSize must be three positive i32 multiples of four');
  const bricks = worldSize.map(n => n / 4);
  const count = bricks.reduce((a, b) => a * b, 1);
  check(integer(count, 1), 'world book u32 index overflow');
  const bytes = count * 4, requestBytes = Math.ceil(count / 32) * 4;
  for (const size of [bytes, requestBytes]) check(size <= Math.min(limits.maxStorageBufferBindingSize, 128 * 1024 ** 2, limits.maxBufferSize), 'world book exceeds default/device binding limit');
  return frozen({ worldSize: frozen([...worldSize]), bricks: frozen(bricks), count, bytes, requestBytes });
}
export function worldBrickIndex(book, b) {
  check(b?.length === 3 && b.every((n, i) => integer(n, 0, book.bricks[i] - 1)), 'world brick outside bounds');
  return b[0] + book.bricks[0] * (b[1] + book.bricks[1] * b[2]);
}
export function worldCellAddress(book, cell) {
  check(cell?.length === 3 && cell.every((n, i) => integer(n, 0, book.worldSize[i] - 1)), 'world cell outside bounds');
  const brick = cell.map(n => Math.floor(n / 4));
  return { brick, index: worldBrickIndex(book, brick), slot: worldLocalSlot(cell) };
}
// Original brick-local source-buffer order, NOT xyz-linear:
// x + 4*(y&1) + 8*(z + 4*(y>>1)); one physical page is an 8x8 tile.
export const worldLocalSlot = ([x, y, z]) => (x & 3) + 4 * (y & 1) + 8 * ((z & 3) + 4 * ((y & 3) >> 1));
export function worldSlotCell(slot) {
  check(integer(slot, 0, 63), 'invalid local slot');
  return [slot & 3, ((slot >> 2) & 1) + 2 * (slot >> 5), (slot >> 3) & 3];
}
function geometry(texels, maxDim, maxLayers, tile = 1) {
  const side = Math.floor(maxDim / tile);
  check(side >= 1, 'device texture dimension too small');
  let x = Math.min(side, 8), y = Math.min(side, 8);
  while (x * y < texels && (x < side || y < side)) {
    if (x <= y && x < side) x = Math.min(side, x * 2);
    else y = Math.min(side, y * 2);
  }
  const layers = Math.ceil(texels / (x * y));
  check(layers <= maxLayers, 'atlas exceeds device array layers');
  return frozen({ width: x * tile, height: y * tile, layers, x, y });
}
export function worldAtlasLayout(capacity = 64, deviceLimits = {}) {
  const limits = limitsOf(deviceLimits);
  check(integer(capacity, 1, Math.floor(U32_MAX / AUX_RECORDS)), 'physical page/aux address overflow');
  return frozen({ capacity,
    cells: geometry(capacity, limits.maxTextureDimension2D, limits.maxTextureArrayLayers, 8),
    aux: geometry(capacity * AUX_RECORDS, limits.maxTextureDimension2D, limits.maxTextureArrayLayers),
    probes: geometry(capacity, limits.maxTextureDimension2D, limits.maxTextureArrayLayers),
  });
}
export function linearTexel(index, g) {
  check(integer(index, 0, g.width * g.height * g.layers - 1), 'texture address outside geometry');
  return [index % g.width, Math.floor(index / g.width) % g.height, Math.floor(index / (g.width * g.height))];
}
export function pageTexel(pid, slot, layout) {
  check(integer(pid, 0, layout.capacity - 1) && integer(slot, 0, 63), 'page address outside capacity');
  const g = layout.cells;
  return [(pid % g.x) * 8 + (slot & 7), (Math.floor(pid / g.x) % g.y) * 8 + (slot >> 3), Math.floor(pid / (g.x * g.y))];
}
export function auxTexel(pid, record, layout) {
  check(integer(pid, 0, layout.capacity - 1) && integer(record, 0, AUX_RECORDS - 1), 'aux address outside capacity');
  return linearTexel(pid * AUX_RECORDS + record, layout.aux);
}
export function probeTexel(pid, layout) {
  check(integer(pid, 0, layout.capacity - 1), 'probe address outside capacity');
  return linearTexel(pid, layout.probes);
}
// Aux packet (132 vec4u): [readyBits,epoch,sourceRevision,fieldTick],
// [BrickInfo.emit.xyz float32 BITS, BrickInfo.info], [occLo,occHi,distancePlus1,age],
// [reserved x4], then 64 * { [flow.xy, aeration.xy], [decoRGBA8, reserved x3] }.
// flow/aeration are original vec2u pack2x16float words; deco is CELL PAINT,
// never the particle pool. A known zero BrickInfo/occupancy is not UNKNOWN.
export function packWorldAux({ epoch, sourceRevision, fieldTick = 0, readyBits = READY.ALL,
  brickInfo = new Uint32Array(4), occupancy = [0, 0], distancePlus1 = 0, age = 0,
  flow = new Uint32Array(128), aeration = new Uint32Array(128), deco = new Uint32Array(64) }) {
  for (const v of [epoch, sourceRevision, fieldTick, readyBits, ...occupancy, distancePlus1, age]) check(integer(v), 'aux metadata must be u32');
  check(brickInfo instanceof Uint32Array && brickInfo.length === 4 && flow instanceof Uint32Array && flow.length === 128 && aeration instanceof Uint32Array && aeration.length === 128 && deco instanceof Uint32Array && deco.length === 64, 'aux source lengths/types');
  const out = new Uint32Array(AUX_RECORDS * 4);
  out.set([readyBits, epoch, sourceRevision, fieldTick]); out.set(brickInfo, 4);
  out.set([...occupancy, distancePlus1, age], 8);
  for (let s = 0; s < 64; s++) {
    out.set([flow[s * 2], flow[s * 2 + 1], aeration[s * 2], aeration[s * 2 + 1]], 16 + s * 8);
    out[20 + s * 8] = deco[s];
  }
  return out;
}
// Preserve existing RGBA16 scene colour EXACTLY, including HDR/NaNs, and f32
// depth bits. Coverage/flags are independent: uncovered is not depth==0.
export function packMeshWords(halfWords, depthBits, coverageFlags) {
  check(halfWords.length === 4 && [...halfWords].every(v => integer(v, 0, 65535)) && integer(depthBits) && integer(coverageFlags), 'invalid packed mesh words');
  return new Uint32Array([(halfWords[0] | (halfWords[1] << 16)) >>> 0, (halfWords[2] | (halfWords[3] << 16)) >>> 0, depthBits, coverageFlags]);
}
export const unpackMeshWords = (v) => ({ halfWords: new Uint16Array([v[0] & 65535, v[0] >>> 16, v[1] & 65535, v[1] >>> 16]), depthBits: v[2], coverageFlags: v[3] });
export const worldCubicWeights = (t) => [(1-t)**3/6, (3*t**3-6*t*t+4)/6, (-3*t**3+3*t*t+3*t+1)/6, t**3/6];
// Reference cell-centred filtering; clamp only to genuine WORLD edges. The
// callback is responsible for missing-page feedback; never clamp to a tile.
export function worldInterpolate(fetch, position, size, cubic = false, spacing = 1) {
  const q = position.map((v, i) => Math.max(0, Math.min(size[i] / spacing - 1, v / spacing - 0.5)));
  const base = q.map(Math.floor), frac = q.map((v, i) => v - base[i]);
  const weights = frac.map(t => cubic ? worldCubicWeights(t) : [1-t, t]);
  const n = cubic ? 4 : 2, offset = cubic ? -1 : 0;
  let out;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const c = [x, y, z].map((v, i) => Math.max(0, Math.min(size[i] / spacing - 1, base[i] + v + offset)));
    const v = fetch(c), w = weights[0][x] * weights[1][y] * weights[2][z];
    if (Array.isArray(v) || ArrayBuffer.isView(v)) { out ??= Array(v.length).fill(0); v.forEach((a, i) => { out[i] += a * w; }); }
    else { out = (out ?? 0) + v * w; }
  }
  return out;
}
export function requestMissing(bits, index) { bits[index >>> 5] |= 1 << (index & 31); }
export function requestedBricks(bits, count) {
  const out = [];
  for (let i = 0; i < count; i++) if ((bits[i >>> 5] >>> (i & 31)) & 1) out.push(i);
  return out;
}

const entry = (binding, body, visibility = 6) => ({ binding, visibility, ...body });
const sampled = (type = 'float', dim = '2d-array') => ({ texture: { sampleType: type, viewDimension: dim } });
const storageTex = (format, dim = '2d-array') => ({ storageTexture: { access: 'write-only', format, viewDimension: dim } });
export function assertWorldLayout(groups, limits = {}) {
  const lim = limitsOf(limits);
  check(groups.length <= Math.min(4, lim.maxBindGroups), 'world bind group limit');
  for (const stage of [1, 2, 4]) {
    const es = groups.flat().filter(e => e.visibility & stage);
    for (const [key, field, cap] of [['buffer', 'maxStorageBuffersPerShaderStage', 8], ['texture', 'maxSampledTexturesPerShaderStage', 16], ['storageTexture', 'maxStorageTexturesPerShaderStage', 4]]) {
      const n = es.filter(e => key === 'buffer' ? e.buffer?.type?.includes('storage') : e[key]).length;
      check(n <= Math.min(cap, lim[field]), `world ${key} stage limit`);
    }
    for (const e of es) if (e.buffer?.minBindingSize && e.buffer.type?.includes('storage')) check(e.buffer.minBindingSize <= Math.min(128 * 1024 ** 2, lim.maxStorageBufferBindingSize), 'world storage binding limit');
  }
  return groups;
}
// Explicit separate ABI, NEVER appended to VOLUME_LAYOUTS. 16 sampled textures
// exactly: 2 state + 3 field + aux + 4 GI + glow + 2 optical sun + noise +
// imported source appearance + ONE packed external opaque mesh.
export function worldReaderLayouts(limits = {}) {
  return assertWorldLayout([
    [entry(0, { buffer: { type: 'uniform', minBindingSize: 112 } }), entry(1, { buffer: { type: 'read-only-storage' } })],
    [sampled('uint'), sampled('uint'), sampled(), sampled(), sampled(), sampled('uint')].map((v, i) => entry(i, v)),
    [sampled(), sampled(), sampled(), sampled(), sampled(), sampled('unfilterable-float', '2d-array'), sampled('unfilterable-float', '2d-array'), sampled('float', '3d'), sampled('uint', '3d'), sampled('uint', '2d')].map((v, i) => entry(i, v)),
    [entry(0, { buffer: { type: 'storage' } })],
  ], limits);
}
const freezeRecords = records => frozen(Object.fromEntries(Object.entries(records).map(([k, v]) => [k, frozen(v)])));
export const PAGE_CHANNELS = freezeRecords({ stateA: ['rgba32uint', 'cells', 16], stateB: ['rgba32uint', 'cells', 16],
  field0: ['rgba16float', 'cells', 8], field1: ['rgba16float', 'cells', 8], field2: ['rgba16float', 'cells', 8],
  aux: ['rgba32uint', 'aux', 16], gi0: ['rgba16float', 'probes', 8], gi1: ['rgba16float', 'probes', 8], gi2: ['rgba16float', 'probes', 8], gi3: ['rgba16float', 'probes', 8], glow: ['rgba16float', 'probes', 8] });
export const WRITER_CHANNELS = freezeRecords({ raw: ['stateA', 'stateB', 'aux'], fields: ['field0', 'field1', 'field2'], gi: ['gi0', 'gi1', 'gi2', 'gi3'], glow: ['glow'] });
export function worldWriterLayouts(kind, limits = {}) {
  if (kind === 'mesh') return assertWorldLayout([[entry(0, sampled('unfilterable-float', '2d'), 4), entry(1, sampled('depth', '2d'), 4), entry(2, storageTex('rgba32uint', '2d'), 4)]], limits);
  if (kind === 'shadow') return assertWorldLayout([[entry(0, storageTex('r32float'), 4), entry(1, storageTex('r32float'), 4)]], limits);
  const names = WRITER_CHANNELS[kind]; check(names, 'unknown world writer');
  return assertWorldLayout([
    [entry(0, { buffer: { type: 'uniform', minBindingSize: 64 } }, 4), ...names.map((n, i) => entry(i + 1, { buffer: { type: 'read-only-storage', minBindingSize: (n === 'aux' ? AUX_RECORDS : PAGE_CHANNELS[n][1] === 'cells' ? 64 : 1) * 16 } }, 4))],
    names.map((n, i) => entry(i, storageTex(PAGE_CHANNELS[n][0]), 4)),
  ], limits);
}
function createResources(device, layout) {
  const textures = {}, views = {};
  try {
    for (const [name, [format, shape]] of Object.entries(PAGE_CHANNELS)) {
      const g = layout[shape];
      textures[name] = device.createTexture({ label: `world ${name}`, size: [g.width, g.height, g.layers], dimension: '2d', format, usage: 15 });
      views[name] = textures[name].createView({ dimension: '2d-array' });
    }
  } catch (e) { Object.values(textures).forEach(t => t.destroy()); throw e; }
  return { layout, textures, views: frozen(views), refs: 1 };
}
function packetAddress(name, pid, layout, record = 0) {
  return name === 'aux' ? auxTexel(pid, record, layout) : PAGE_CHANNELS[name][1] === 'cells' ? pageTexel(pid, 0, layout) : probeTexel(pid, layout);
}
function copyPage(encoder, from, to, pid) {
  for (const name of Object.keys(PAGE_CHANNELS)) {
    const count = name === 'aux' ? AUX_RECORDS : 1;
    for (let r = 0; r < count; r++) encoder.copyTextureToTexture(
      { texture: from.textures[name], origin: packetAddress(name, pid, from.layout, r) },
      { texture: to.textures[name], origin: packetAddress(name, pid, to.layout, r) },
      PAGE_CHANNELS[name][1] === 'cells' ? [8, 8, 1] : [1, 1, 1]);
  }
}
function paramWords(book, layout, epoch, generation) {
  const words = new Uint32Array(28);
  words.set([...book.worldSize, epoch], 0); words.set([...book.bricks, generation], 4);
  words.set([layout.cells.x, layout.cells.y, layout.capacity, WORLD_ATLAS_ABI], 8);
  words.set([layout.aux.width, layout.aux.height, layout.aux.layers, AUX_RECORDS], 12);
  words.set([layout.probes.width, layout.probes.height, layout.probes.layers, 0], 16);
  return words;
}
/**
 * gpu is a GPUDevice or {device}. retire(fn) must run fn only after submitted
 * readers/copies finish; defaults to queue.onSubmittedWorkDone. Caller releases
 * snapshot pins AFTER encoding/submitting their last use. Providers may use
 * update typed packets, or writerBindings + recordPageWrite (submits encoder).
 * External bindings (sun/noise/appearance/mesh) stay caller-owned.
 */
export class WorldRenderAtlas {
  constructor(gpu, { worldSize, retire, onChange = () => {}, initialCapacity = 64, feedbackExtraWords = 0 } = {}) {
    this.device = gpu.device ?? gpu; this.queue = this.device.queue;
    this.limits = limitsOf(this.device.limits);
    worldReaderLayouts(this.limits); for (const k of [...Object.keys(WRITER_CHANNELS), 'mesh', 'shadow']) worldWriterLayouts(k, this.limits);
    this.bookLayout = worldBookLayout(worldSize, this.limits);
    check(integer(feedbackExtraWords), 'feedbackExtraWords must be u32');
    this.feedbackExtraWords = feedbackExtraWords;
    this.feedbackBytes = this.bookLayout.requestBytes + 4 * feedbackExtraWords;
    check(this.feedbackBytes <= Math.min(this.limits.maxStorageBufferBindingSize, this.limits.maxBufferSize, 128 * 1024 ** 2), 'world feedback exceeds binding limit');
    this.retire = retire ?? (fn => { this.queue.onSubmittedWorkDone().then(fn, fn); });
    this.onChange = onChange; this.epoch = 1; this.generation = 0;
    this.required = new Set(); this.pages = new Map(); this.pending = new Map(); this.free = []; this.nextID = 0; this.dead = false;
    this.resources = createResources(this.device, worldAtlasLayout(initialCapacity, this.limits));
    this.entries = new Uint32Array(this.bookLayout.count);
    try { this._commit(this.entries); } catch (e) { this._releaseResources(this.resources); throw e; }
  }
  _alive() { if (this.dead) throw new Error('world atlas disposed'); }
  _releaseResources(r) { if (--r.refs === 0) this.retire(() => Object.values(r.textures).forEach(t => t.destroy())); }
  _buffer(label, size, usage, data) {
    const b = this.device.createBuffer({ label, size, usage });
    try { if (data) this.queue.writeBuffer(b, 0, data); }
    catch (e) { this.retire(() => b.destroy()); throw e; }
    return b;
  }
  _commit(entries, r = this.resources, epoch = this.epoch) {
    check(this.generation < U32_MAX, 'world generation overflow');
    const previous = this.current, generation = this.generation + 1;
    let book, params;
    try {
      book = this._buffer('world immutable book', entries.byteLength, BU.STORAGE | BU.COPY_DST | BU.COPY_SRC, entries);
      params = this._buffer('world immutable params', 112, BU.UNIFORM | BU.COPY_DST, paramWords(this.bookLayout, r.layout, epoch, generation));
    } catch (e) { this.retire(() => { book?.destroy(); params?.destroy(); }); throw e; }
    const ids = new Set(); for (const v of entries) if (v) ids.add(v - 1);
    for (const id of ids) this.pages.get(id).pins++;
    r.refs++;
    this.current = { book, params, r, ids, refs: 1, epoch, generation };
    this.entries = entries; this.generation = generation; this.epoch = epoch;
    if (previous) this._releaseSnapshot(previous);
  }
  _releaseSnapshot(s) {
    if (--s.refs) return;
    this.retire(() => {
      s.book.destroy(); s.params.destroy(); this._releaseResources(s.r);
      for (const id of s.ids) { const p = this.pages.get(id); if (p) { p.pins--; this._collect(p); } }
    });
  }
  _collect(p) {
    if (p.pins || p.public || p.pending || p.retiring) return;
    p.retiring = true;
    this.retire(() => { if (this.pages.get(p.id) === p) { this.pages.delete(p.id); if (!this.dead) this.free.push(p.id); } });
  }
  require(bricks) {
    this._alive(); const wanted = new Set(bricks.map(b => worldBrickIndex(this.bookLayout, b)));
    this.required = wanted;
    return [...wanted].filter(i => this.entries[i] === 0);
  }
  allocate(brick, { sourceRevision, fieldTick = 0, readyBits = READY.ALL } = {}) {
    this._alive(); const index = worldBrickIndex(this.bookLayout, brick);
    check(integer(sourceRevision) && integer(fieldTick) && integer(readyBits, 1, READY.ALL), 'invalid page version/readiness');
    check(!this.pending.has(index), 'brick already has pending replacement');
    const old = this.entries[index] ? this.pages.get(this.entries[index] - 1) : null;
    check(!old || sourceRevision >= old.sourceRevision, 'source revision regression');
    check(!old || (readyBits & old.readyBits) === old.readyBits, 'replacement cannot drop ready channels');
    check(!old || sourceRevision !== old.sourceRevision || fieldTick >= old.fieldTick, 'field tick regression');
    if (!this.free.length && this.nextID >= this.resources.layout.capacity) this.grow(this.resources.layout.capacity * 2);
    const id = this.free.length ? this.free.pop() : this.nextID++;
    const p = { id, index, brick: frozen([...brick]), epoch: this.epoch, sourceRevision, fieldTick, readyBits, written: new Set(), pins: 0, pending: true, public: false, resources: this.resources };
    p.resources.refs++; this.pages.set(id, p); this.pending.set(index, p);
    // Opaque job identity: no mutable internal page state escapes.
    const job = frozen({ physicalPageID: id, brick: p.brick, epoch: p.epoch, sourceRevision, fieldTick, readyBits });
    p.job = job; return job;
  }
  _job(job) {
    this._alive(); const p = this.pages.get(job?.physicalPageID);
    if (!p || p.job !== job || !p.pending || p.epoch !== this.epoch) throw new Error('stale world page job');
    return p;
  }
  _needed(p) {
    const names = [];
    if (p.readyBits & READY.RAW) names.push('stateA', 'stateB');
    if (p.readyBits & READY.FIELD) names.push('field0', 'field1', 'field2');
    if (p.readyBits & READY.LIGHT) names.push('gi0', 'gi1', 'gi2', 'gi3', 'glow');
    // Publication metadata is mandatory even for a raw-only page.
    names.push('aux'); return names;
  }
  update(job, data) {
    const p = this._job(job);
    // Validate the entire upload before touching any texture.
    for (const [name, bytes] of Object.entries(data)) {
      check(PAGE_CHANNELS[name], 'unknown atlas channel');
      const [format, shape, stride] = PAGE_CHANNELS[name], count = name === 'aux' ? AUX_RECORDS : shape === 'cells' ? 64 : 1;
      check((format === 'rgba32uint' ? bytes instanceof Uint32Array : bytes instanceof Uint16Array) && bytes.byteLength === count * stride, 'page upload must contain exact raw format/length');
      if (name === 'aux') check(bytes[0] === p.readyBits && bytes[1] === p.epoch && bytes[2] === p.sourceRevision && bytes[3] === p.fieldTick, 'page metadata mismatch');
    }
    for (const [name, bytes] of Object.entries(data)) {
      const [, shape, stride] = PAGE_CHANNELS[name];
      if (name === 'aux') {
        for (let r = 0; r < AUX_RECORDS; r++) this.queue.writeTexture({ texture: p.resources.textures[name], origin: auxTexel(p.id, r, p.resources.layout) }, bytes.subarray(r * 4, r * 4 + 4), {}, [1, 1, 1]);
      } else this.queue.writeTexture({ texture: p.resources.textures[name], origin: packetAddress(name, p.id, p.resources.layout) }, bytes, { bytesPerRow: shape === 'cells' ? stride * 8 : stride }, shape === 'cells' ? [8, 8, 1] : [1, 1, 1]);
      p.written.add(name);
    }
    return job;
  }
  writerBindings(job, kind) {
    const p = this._job(job), names = WRITER_CHANNELS[kind]; check(names, 'unknown page writer');
    const l = p.resources.layout, words = new Uint32Array(16);
    words.set([p.id, l.cells.x, l.cells.y, 0]); words.set([l.aux.width, l.aux.height, 0, 0], 4);
    words.set([l.probes.width, l.probes.height, 0, 0], 8);
    return frozen({ params: words, outputs: frozen(names.map((n, binding) => frozen({ binding, resource: p.resources.views[n] }))) });
  }
  // Provider records writer commands into a fresh encoder. This method owns
  // submission/order. Success marks complete channels only, never publishes.
  // Raw writer inputs MUST contain the exact job metadata (verified on CPU).
  recordPageWrite(job, kind, { auxMetadata, record }) {
    const p = this._job(job), names = WRITER_CHANNELS[kind]; check(names && typeof record === 'function', 'invalid page writer');
    if (kind === 'raw') check(auxMetadata?.length === 4 && auxMetadata.every((v, i) => v === [p.readyBits, p.epoch, p.sourceRevision, p.fieldTick][i]), 'writer metadata mismatch');
    const encoder = this.device.createCommandEncoder({ label: 'world provider page' });
    record(encoder, this.writerBindings(job, kind));
    this.queue.submit([encoder.finish()]); names.forEach(n => p.written.add(n));
    return job;
  }
  publish(jobs) {
    this._alive(); const ps = (Array.isArray(jobs) ? jobs : [jobs]).map(j => this._job(j));
    check(new Set(ps).size === ps.length, 'duplicate publication job');
    for (const p of ps) check(this._needed(p).every(n => p.written.has(n)), 'cannot publish partial page');
    // Pending work may target a pre-growth resource set. Copy only after its
    // writes were submitted, preserving ID and ALL field/probe histories.
    const moved = ps.filter(p => p.resources !== this.resources);
    if (moved.length) {
      const encoder = this.device.createCommandEncoder({ label: 'world pending repack' });
      moved.forEach(p => copyPage(encoder, p.resources, this.resources, p.id));
      this.queue.submit([encoder.finish()]);
    }
    const entries = this.entries.slice(), oldPages = [];
    for (const p of ps) {
      if (entries[p.index]) oldPages.push(this.pages.get(entries[p.index] - 1));
      entries[p.index] = p.id + 1;
    }
    this._commit(entries);
    for (const p of oldPages) { p.public = false; this._collect(p); }
    for (const p of ps) {
      p.public = true; p.pending = false; this.pending.delete(p.index); this._releaseResources(p.resources);
    }
    this.onChange({ epoch: this.epoch, generation: this.generation });
    return this.generation;
  }
  remove(bricks) {
    this._alive(); const indices = bricks.map(b => worldBrickIndex(this.bookLayout, b));
    for (const i of indices) check(!this.required.has(i) && !this.pending.has(i), 'cannot remove requested/pending brick');
    const entries = this.entries.slice(), oldPages = [];
    for (const i of indices) { if (entries[i]) oldPages.push(this.pages.get(entries[i] - 1)); entries[i] = 0; }
    this._commit(entries);
    for (const p of oldPages) { p.public = false; this._collect(p); }
    this.onChange({ epoch: this.epoch, generation: this.generation });
  }
  _cancelPage(p) { p.pending = false; this.pending.delete(p.index); this._releaseResources(p.resources); this._collect(p); }
  cancel(job) { this._cancelPage(this._job(job)); }
  grow(capacity = this.resources.layout.capacity * 2) {
    this._alive(); check(integer(capacity, this.resources.layout.capacity + 1), 'grow must increase capacity');
    const next = createResources(this.device, worldAtlasLayout(capacity, this.limits)), old = this.resources;
    try {
      const encoder = this.device.createCommandEncoder({ label: 'world atlas growth' });
      for (const p of this.pages.values()) if (p.public) copyPage(encoder, old, next, p.id);
      this.queue.submit([encoder.finish()]);
      this._commit(this.entries, next);
    } catch (e) { this._releaseResources(next); throw e; }
    this.resources = next; this._releaseResources(old);
    this.onChange({ epoch: this.epoch, generation: this.generation }); return next.layout;
  }
  snapshot() {
    this._alive(); const s = this.current; s.refs++; let released = false;
    return frozen({ epoch: s.epoch, generation: s.generation, layout: s.r.layout, book: s.book, params: s.params, views: s.r.views,
      // Capture binding identities, not mutable atlas state.
      bindings: (external, feedback) => {
        if (released) throw new Error('snapshot released');
        check(feedback?.size >= this.feedbackBytes && feedback.size <= Math.min(this.limits.maxStorageBufferBindingSize, 128 * 1024 ** 2), 'feedback binding size');
        const names = ['gi0', 'gi1', 'gi2', 'gi3', 'glow'];
        return [
          [{ binding: 0, resource: { buffer: s.params } }, { binding: 1, resource: { buffer: s.book } }],
          ['stateA', 'stateB', 'field0', 'field1', 'field2', 'aux'].map((n, binding) => ({ binding, resource: s.r.views[n] })),
          [...names.map(n => s.r.views[n]), ...['sunDepth', 'sunOptical', 'mediaNoise', 'sourceAppearance', 'packedMesh'].map(n => { check(external?.[n], `missing external ${n}`); return external[n]; })].map((resource, binding) => ({ binding, resource })),
          [{ binding: 0, resource: { buffer: feedback, size: this.feedbackBytes } }],
        ];
      }, release: () => { if (!released) { released = true; this._releaseSnapshot(s); } } });
  }
  lookup(brick, readyBits = READY.ALL) {
    this._alive(); const index = worldBrickIndex(this.bookLayout, brick), entry = this.entries[index];
    if (!entry) return { known: false, incomplete: true, request: index };
    const p = this.pages.get(entry - 1);
    return (p.readyBits & readyBits) === readyBits ? { known: true, incomplete: false, physicalPageID: p.id, epoch: p.epoch, sourceRevision: p.sourceRevision, fieldTick: p.fieldTick } : { known: false, incomplete: true, request: index };
  }
  reset() {
    this._alive(); check(this.epoch < U32_MAX, 'world epoch overflow');
    this._commit(new Uint32Array(this.bookLayout.count), this.resources, this.epoch + 1);
    for (const p of [...this.pending.values()]) this._cancelPage(p);
    this.required.clear();
    for (const p of this.pages.values()) { p.public = false; this._collect(p); }
    this.onChange({ epoch: this.epoch, generation: this.generation });
  }
  dispose() {
    if (this.dead) return;
    for (const p of [...this.pending.values()]) this.cancel(p.job);
    this.dead = true; for (const p of this.pages.values()) p.public = false;
    this._releaseSnapshot(this.current); this._releaseResources(this.resources);
    for (const p of this.pages.values()) this._collect(p);
  }
}
