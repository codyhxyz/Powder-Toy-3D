// World render ABI v2. Render-only; never allocates a Simulation.
// Public snapshots are immutable. Providers upload COMPLETE replacement pages;
// publication is a queue-ordered transaction, not an incremental readiness mask.
import { validateWorldLightingRestore } from './worldLightingRestore.js';
export const WORLD_ATLAS_ABI = 2;
export const READY = Object.freeze({ RAW: 1, FIELD: 2, AUX: 4, GI_SOURCE: 8, GI: 16, GLOW: 32, CELL: 7, LIGHT: 56, ALL: 63 });
export const LIGHT_RECORDS = 5;
export const CHANNELS = Object.freeze([1, 2, 4, 8, 16, 32]);
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
  const bytes = count * 4, planeWords = Math.ceil(count / 32), requestBytes = planeWords * 6 * 4;
  for (const size of [bytes, requestBytes]) check(size <= Math.min(limits.maxStorageBufferBindingSize, 128 * 1024 ** 2, limits.maxBufferSize), 'world book exceeds default/device binding limit');
  return frozen({ worldSize: frozen([...worldSize]), bricks: frozen(bricks), count, bytes, planeWords, requestBytes, statusWord: requestBytes / 4, sunWord: requestBytes / 4 + 1 });
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
// Zero logical capacity is legal: WebGPU still needs a minimal bound texture.
export function worldAtlasLayout(capacity = 64, deviceLimits = {}, lightCapacity = 0, probeCapacity = 0) {
  const limits = limitsOf(deviceLimits);
  check(integer(capacity) && integer(lightCapacity) && integer(probeCapacity), 'invalid pool capacities');
  const descriptorBase = capacity * AUX_RECORDS;
  const auxCount = descriptorBase + lightCapacity * LIGHT_RECORDS;
  check(auxCount <= U32_MAX, 'physical pool/aux address overflow');
  return frozen({ capacity, lightCapacity, probeCapacity, descriptorBase,
    cells: geometry(Math.max(1, capacity), limits.maxTextureDimension2D, limits.maxTextureArrayLayers, 8),
    aux: geometry(Math.max(1, auxCount), limits.maxTextureDimension2D, limits.maxTextureArrayLayers),
    probes: geometry(Math.max(1, probeCapacity), limits.maxTextureDimension2D, limits.maxTextureArrayLayers),
  });
}
// Clamp doubling to a sufficient *legal* capacity (including combined aux region).
export function worldPoolMax(kind, layout, deviceLimits = {}) {
  const lim = limitsOf(deviceLimits), texels = lim.maxTextureDimension2D ** 2 * lim.maxTextureArrayLayers;
  const auxMax = Math.min(U32_MAX, texels);
  if (kind === 'cell') return Math.min(Math.floor(lim.maxTextureDimension2D / 8) ** 2 * lim.maxTextureArrayLayers, Math.floor((auxMax - layout.lightCapacity * LIGHT_RECORDS) / AUX_RECORDS));
  if (kind === 'light') return Math.floor((auxMax - layout.capacity * AUX_RECORDS) / LIGHT_RECORDS);
  check(kind === 'probe', 'invalid pool'); return Math.min(U32_MAX, texels);
}
export function worldPoolGrowth(kind, layout, deviceLimits = {}, needed) {
  const current = layout[kind === 'cell' ? 'capacity' : kind + 'Capacity'];
  needed ??= current + 1;
  const max = worldPoolMax(kind, layout, deviceLimits);
  check(integer(needed, current + 1, max), 'pool exhausted legal address capacity');
  return Math.min(max, Math.max(needed, Math.max(1, current * 2)));
}
export function lightTexel(id, record, layout) {
  check(integer(id, 0, layout.lightCapacity - 1) && integer(record, 0, LIGHT_RECORDS - 1), 'light descriptor address outside capacity');
  return linearTexel(layout.descriptorBase + id * LIGHT_RECORDS + record, layout.aux);
}
export function worldAllocationBytes(layout) {
  const shapes = { cells: 0, aux: 0, probes: 0 };
  for (const [, [format, shape, stride]] of Object.entries(PAGE_CHANNELS)) {
    const g = layout[shape]; shapes[shape] += g.width * g.height * g.layers * stride;
  }
  return frozen({ ...shapes, total: shapes.cells + shapes.aux + shapes.probes });
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
  check(integer(pid, 0, layout.probeCapacity - 1), 'probe address outside capacity');
  return linearTexel(pid, layout.probes);
}
// Aux packet (132 vec4u): [readyBits,epoch,sourceRevision,fieldTick],
// [BrickInfo.emit.xyz float32 BITS, BrickInfo.info], [occLo,occHi,distancePlus1,age],
// [reserved x4], then 64 * { [flow.xy, aeration.xy], [decoRGBA8, reserved x3] }.
// flow/aeration are original vec2u pack2x16float words; deco is CELL PAINT,
// never the particle pool. A known zero BrickInfo/occupancy is not UNKNOWN.
export function packWorldAux({ epoch, sourceRevision, fieldTick = 0, readyBits = READY.CELL,
  brickInfo = new Uint32Array(4), occupancy = [0, 0], distancePlus1 = 0, age = 0,
  flow = new Uint32Array(128), aeration = new Uint32Array(128), deco = new Uint32Array(64) }) {
  for (const v of [epoch, sourceRevision, fieldTick, readyBits, ...occupancy, distancePlus1, age]) check(integer(v), 'aux metadata must be u32');
  check(integer(readyBits, 1, READY.CELL), 'cell aux readiness');
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

// A plane is aligned to a u32, including worlds whose brick count is not /32.
export function requestChannels(bits, book, index, channels) {
  check(integer(index, 0, book.count - 1) && integer(channels, 1, READY.ALL), 'invalid typed request');
  check(bits instanceof Uint32Array && bits.length >= book.statusWord, 'typed feedback size');
  CHANNELS.forEach((bit, plane) => { if (channels & bit) requestMissing(bits.subarray(plane * book.planeWords), index); });
}
export function requestedChannels(bits, book) {
  check(bits instanceof Uint32Array && bits.length >= book.statusWord, 'typed feedback size');
  const merged = new Map();
  CHANNELS.forEach((bit, plane) => {
    for (const index of requestedBricks(bits.subarray(plane * book.planeWords), book.count)) merged.set(index, (merged.get(index) ?? 0) | bit);
  });
  return [...merged].sort((a, b) => a[0] - b[0]).map(([index, channels]) => frozen({ index, brick: frozen([index % book.bricks[0], Math.floor(index / book.bricks[0]) % book.bricks[1], Math.floor(index / (book.bricks[0] * book.bricks[1]))]), channels }));
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
    [entry(0, { buffer: { type: 'uniform', minBindingSize: 112 } }), entry(1, { buffer: { type: 'read-only-storage' } }), entry(2, { buffer: { type: 'read-only-storage' } })],
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
  const names = kind === 'source' ? ['aux'] : WRITER_CHANNELS[kind]; check(names, 'unknown world writer');
  return assertWorldLayout([
    [entry(0, { buffer: { type: 'uniform', minBindingSize: 64 } }, 4), ...names.map((n, i) => entry(i + 1, { buffer: { type: 'read-only-storage', minBindingSize: (kind === 'source' ? 1 : n === 'aux' ? AUX_RECORDS : PAGE_CHANNELS[n][1] === 'cells' ? 64 : 1) * 16 } }, 4))],
    names.map((n, i) => entry(i, storageTex(PAGE_CHANNELS[n][0]), 4)),
  ], limits);
}
// Resource sets share unchanged textures, but never mutate any retained view.
function createResources(device, layout, previous) {
  const textures = {}, views = {}, owners = {};
  try {
    for (const [name, [format, shape]] of Object.entries(PAGE_CHANNELS)) {
      const g = layout[shape], old = previous?.owners[name];
      if (old && ['width', 'height', 'layers'].every(k => previous.layout[shape][k] === g[k])) {
        owners[name] = old; old.refs++;
      } else {
        const texture = device.createTexture({ label: `world ${name}`, size: [g.width, g.height, g.layers], dimension: '2d', format, usage: 15 });
        owners[name] = { texture, refs: 1 };
        owners[name].view = texture.createView({ dimension: '2d-array' });
      }
      textures[name] = owners[name].texture; views[name] = owners[name].view;
    }
  } catch (e) { for (const o of Object.values(owners)) if (--o.refs === 0) o.texture.destroy(); throw e; }
  return { layout, textures, views: frozen(views), owners, refs: 1 };
}
function packetAddress(name, pid, layout, record = 0) {
  return name === 'aux' ? auxTexel(pid, record, layout) : PAGE_CHANNELS[name][1] === 'cells' ? pageTexel(pid, 0, layout) : probeTexel(pid, layout);
}
function copyAuxPacket(encoder, from, to, pid, light = false) {
  const address = light ? lightTexel : auxTexel, count = light ? LIGHT_RECORDS : AUX_RECORDS;
  for (let record = 0; record < count;) {
    const source = address(pid, record, from.layout), destination = address(pid, record, to.layout);
    // Split at BOTH physical row boundaries, including differing geometries.
    const width = Math.min(count - record, from.layout.aux.width - source[0], to.layout.aux.width - destination[0]);
    encoder.copyTextureToTexture({ texture: from.textures.aux, origin: source },
      { texture: to.textures.aux, origin: destination }, [width, 1, 1]);
    record += width;
  }
}
function copyJob(encoder, from, to, p) {
  if (p.kind === 'cell') {
    for (const name of ['stateA', 'stateB', 'field0', 'field1', 'field2', 'aux']) {
      if (from.textures[name] === to.textures[name]) continue;
      if (name === 'aux') copyAuxPacket(encoder, from, to, p.id);
      else encoder.copyTextureToTexture(
        { texture: from.textures[name], origin: packetAddress(name, p.id, from.layout) },
        { texture: to.textures[name], origin: packetAddress(name, p.id, to.layout) }, [8, 8, 1]);
    }
  } else {
    // Even identical aux geometry needs a new texture when descriptorBase moves.
    if (from.textures.aux !== to.textures.aux) copyAuxPacket(encoder, from, to, p.id, true);
    if (p.probeID !== null) for (const name of ['gi0', 'gi1', 'gi2', 'gi3', 'glow']) {
      if (from.textures[name] === to.textures[name]) continue;
      encoder.copyTextureToTexture({ texture: from.textures[name], origin: probeTexel(p.probeID, from.layout) },
        { texture: to.textures[name], origin: probeTexel(p.probeID, to.layout) }, [1, 1, 1]);
    }
  }
}
function paramWords(book, layout, epoch, generation, dependencyVersion) {
  const words = new Uint32Array(28);
  words.set([...book.worldSize, epoch], 0); words.set([...book.bricks, generation], 4);
  words.set([layout.cells.x, layout.cells.y, layout.capacity, WORLD_ATLAS_ABI], 8);
  words.set([layout.aux.width, layout.aux.height, layout.aux.layers, AUX_RECORDS], 12);
  words.set([layout.probes.width, layout.probes.height, layout.probes.layers, layout.probeCapacity], 16);
  words.set([layout.descriptorBase, layout.lightCapacity, LIGHT_RECORDS, dependencyVersion], 20);
  words.set([book.planeWords, book.statusWord, book.sunWord, 0], 24);
  return words;
}
const pool = () => ({ pages: new Map(), pending: new Map(), free: [], nextID: 0 });
const dependency = d => {
  const v = d ?? { id: 0, version: 0 };
  check(integer(v.id) && integer(v.version) && (v.id !== 0 || v.version === 0), 'invalid dependency version');
  return frozen({ id: v.id, version: v.version });
};
function manifest(value = {}) {
  const version = value.version ?? 0, sets = (value.sets ?? []).map(dependency);
  check(integer(version) && new Set(sets.map(d => d.id)).size === sets.length, 'invalid dependency manifest');
  return frozen({ version, sets: frozen(sets) });
}
function sunManifest(s = null) {
  if (s === null) return null;
  for (const key of ['epoch', 'basisRevision', 'publishRevision', 'dependencySetID', 'dependencyVersion']) check(integer(s[key]), 'invalid sun manifest');
  check(s.book && s.sun0 && s.sun1, 'sun manifest resource views required');
  const params = {};
  for (const [k, length] of [['worldToLight',16],['depth',4],['tiles',4],['physical',4],['version',4]]) {
    const v = Array.from(s.params?.[k]?.elements ?? s.params?.[k] ?? []);
    check(v.length === length && v.every(Number.isFinite), 'complete sun manifest params required');
    params[k] = frozen(v);
  }
  check(params.version[0] === s.epoch && params.version[1] === s.basisRevision && params.version[2] === s.publishRevision, 'sun manifest params/version mismatch');
  params.version.forEach(v => check(integer(v), 'sun params version must be u32'));
  params.tiles.forEach(v => check(integer(v, -0x80000000, 0x7fffffff), 'sun tiles must be i32'));
  params.physical.forEach(v => check(integer(v), 'sun physical must be u32'));
  return frozen({ ...Object.fromEntries(['epoch', 'basisRevision', 'publishRevision', 'dependencySetID', 'dependencyVersion', 'book', 'sun0', 'sun1'].map(k => [k, s[k]])), params: frozen(params) });
}
/** ABI v2: independent cell, descriptor and probe namespaces. No history is
 * initialized by allocation/arrival. Writers supply exact packed source/half
 * words; phase4 owns source/gather barriers, world history and cold replay.
 * retire(fn) must wait for GPU-safe completion; release pins after final use.
 */
export class WorldRenderAtlas {
  constructor(gpu, { worldSize, retire, onChange = () => {}, initialCapacity = 64, initialLightCapacity = 0, initialProbeCapacity = 0, feedbackExtraWords = 0 } = {}) {
    this.device = gpu.device ?? gpu; this.queue = this.device.queue;
    this.limits = limitsOf(this.device.limits);
    worldReaderLayouts(this.limits); for (const k of [...Object.keys(WRITER_CHANNELS), 'source', 'mesh', 'shadow']) worldWriterLayouts(k, this.limits);
    this.bookLayout = worldBookLayout(worldSize, this.limits);
    check(integer(feedbackExtraWords), 'feedbackExtraWords must be u32');
    this.feedbackExtraWords = feedbackExtraWords; // optional suffix AFTER mandatory status
    this.feedbackBytes = this.bookLayout.requestBytes + 4 + 4 * feedbackExtraWords;
    check(this.feedbackBytes <= Math.min(this.limits.maxStorageBufferBindingSize, this.limits.maxBufferSize, 128 * 1024 ** 2), 'world feedback exceeds binding limit');
    this.retire = retire ?? (fn => { this.queue.onSubmittedWorkDone().then(fn, fn); });
    this.onChange = onChange; this.epoch = 1; this.generation = 0; this.required = new Set(); this.dead = false; this.recording = false;
    this.snapshotStates = new WeakMap();
    this.cell = pool(); this.light = pool(); this.probe = pool();
    // Compatibility for cell-provider inspection; no light pages in this map.
    this.pages = this.cell.pages; this.pending = this.cell.pending;
    this.resources = createResources(this.device, worldAtlasLayout(initialCapacity, this.limits, initialLightCapacity, initialProbeCapacity));
    this.entries = new Uint32Array(this.bookLayout.count); this.lightEntries = new Uint32Array(this.bookLayout.count);
    try { this._commit(this.entries, this.lightEntries); } catch (e) { this._releaseResources(this.resources); throw e; }
  }
  _alive() { if (this.dead) throw new Error('world atlas disposed'); check(!this.recording, 'non-reentrant synchronous atlas writer'); }
  _releaseResources(r) {
    if (--r.refs === 0) this.retire(() => { for (const o of Object.values(r.owners)) if (--o.refs === 0) o.texture.destroy(); });
  }
  _buffer(label, size, usage, data) {
    const b = this.device.createBuffer({ label, size, usage });
    try { if (data) this.queue.writeBuffer(b, 0, data); }
    catch (e) { this.retire(() => b.destroy()); throw e; }
    return b;
  }
  _commit(entries, lightEntries, r = this.resources, epoch = this.epoch, dependencies = this.current?.dependencies ?? manifest(), sun = this.current?.sunManifest ?? null) {
    check(this.generation < U32_MAX, 'world generation overflow');
    const previous=this.current,generation=this.generation+1;
    this.current=this._snapshotState(entries,lightEntries,r,epoch,dependencies,sun,generation);
    this.entries=entries;this.lightEntries=lightEntries;this.generation=generation;this.epoch=epoch;
    if(previous)this._releaseSnapshot(previous);
  }
  _snapshotState(entries,lightEntries,r,epoch,dependencies,sun,generation) {
    let book, lightBook, params;
    try {
      book = this._buffer('world immutable book', entries.byteLength, BU.STORAGE | BU.COPY_DST | BU.COPY_SRC, entries);
      lightBook = this._buffer('world immutable light book', lightEntries.byteLength, BU.STORAGE | BU.COPY_DST | BU.COPY_SRC, lightEntries);
      params = this._buffer('world immutable params', 112, BU.UNIFORM | BU.COPY_DST, paramWords(this.bookLayout, r.layout, epoch, generation, dependencies.version));
    } catch (e) { this.retire(() => { book?.destroy(); lightBook?.destroy(); params?.destroy(); }); throw e; }
    const pins = [];
    for (const [kind, values] of [['cell', entries], ['light', lightEntries]]) for (const id of new Set(values.filter(v => v).map(v => v - 1))) {
      const p = this[kind].pages.get(id); p.pins++; pins.push(p);
      if (p.kind === 'light' && p.probeID !== null) this.probe.pages.get(p.probeID).pins++;
    }
    r.refs++;
    return { book, lightBook, params, r, pins, refs: 1, epoch, generation, dependencies, sunManifest: sun };
  }
  _releaseSnapshot(s) {
    if (--s.refs) return;
    this.retire(() => {
      s.book.destroy(); s.lightBook.destroy(); s.params.destroy(); this._releaseResources(s.r);
      for (const p of s.pins) {
        p.pins--;
        if (p.kind === 'light' && p.probeID !== null) this.probe.pages.get(p.probeID).pins--;
        this._collect(p);
      }
    });
  }
  _collect(p) {
    if (p.pins || p.public || p.pending || p.retiring) return;
    p.retiring = true;
    this.retire(() => {
      const pool = this[p.kind];
      if (pool.pages.get(p.id) !== p) return;
      pool.pages.delete(p.id); if (!this.dead) pool.free.push(p.id);
      if (p.kind === 'light' && p.probeID !== null) {
        const probe = this.probe.pages.get(p.probeID); check(probe.pins === 0, 'pinned probe retirement');
        this.probe.pages.delete(p.probeID); if (!this.dead) this.probe.free.push(p.probeID);
      }
    });
  }
  require(requirements) {
    this._alive(); const wanted = new Set(), missing = [];
    for (const r of requirements) {
      const brick = Array.isArray(r) ? r : r.brick, channels = Array.isArray(r) ? READY.CELL : r.channels;
      check(integer(channels, 1, READY.ALL), 'invalid requested channels');
      const i = worldBrickIndex(this.bookLayout, brick); wanted.add(i);
      const miss = this.lookup(brick, channels);
      if (miss.incomplete) missing.push(Array.isArray(r) ? i : frozen({ brick: frozen([...brick]), index: i, channels: miss.missingChannels }));
    }
    this.required = wanted; return missing;
  }
  _take(kind) {
    const p = this[kind], key = kind === 'cell' ? 'capacity' : kind + 'Capacity';
    if (!p.free.length && p.nextID >= this.resources.layout[key]) this.growPool(kind, worldPoolGrowth(kind, this.resources.layout, this.limits));
    return p.free.length ? p.free.pop() : p.nextID++;
  }
  allocate(brick, { sourceRevision, fieldTick = 0, readyBits = READY.CELL } = {}) {
    this._alive(); check(integer(sourceRevision) && integer(fieldTick) && integer(readyBits, 1, READY.CELL), 'invalid cell version/readiness');
    return this._allocate('cell', brick, { sourceRevision, fieldTick, readyBits });
  }
  allocateLight(brick, { sourceRevision, sourceTick = 0, giTick = 0, glowTick = 0, readyBits = READY.LIGHT, dependencies = {}, publication = null } = {}) {
    this._alive();
    check([sourceRevision, sourceTick, giTick, glowTick].every(v => integer(v)) && integer(readyBits, 1, READY.LIGHT) && !(readyBits & READY.CELL), 'invalid light version/readiness');
    const deps = frozen(Object.fromEntries(['source', 'gi', 'glow'].map(k => [k, dependency(dependencies[k])])));
    return this._allocate('light', brick, { sourceRevision, sourceTick, giTick, glowTick, readyBits, dependencies: deps, publication });
  }
  _allocate(kind, brick, version) {
    const index = worldBrickIndex(this.bookLayout, brick), pool = this[kind], entries = kind === 'cell' ? this.entries : this.lightEntries;
    check(!pool.pending.has(index), 'brick already has pending replacement');
    const old = entries[index] ? pool.pages.get(entries[index] - 1) : null;
    check(!old || version.sourceRevision >= old.sourceRevision, 'source revision regression');
    check(!old || (version.readyBits & old.readyBits) === old.readyBits, 'replacement cannot drop ready channels');
    for (const tick of kind === 'cell' ? ['fieldTick'] : ['sourceTick', 'giTick', 'glowTick']) check(!old || (kind === 'cell' && version.sourceRevision !== old.sourceRevision) || version[tick] >= old[tick], 'channel tick regression');
    const id = this._take(kind); let probeID = null;
    try { if (kind === 'light' && version.readyBits & (READY.GI | READY.GLOW)) probeID = this._take('probe'); }
    catch (e) { pool.free.push(id); throw e; }
    if (probeID !== null) this.probe.pages.set(probeID, { id: probeID, pins: 0 });
    const p = { kind, id, index, brick: frozen([...brick]), epoch: this.epoch, ...version, probeID, written: new Set(), pins: 0, pending: true, public: false, resources: this.resources };
    p.resources.refs++; pool.pages.set(id, p); pool.pending.set(index, p);
    p.job = frozen({ kind, ...(kind === 'cell' ? { physicalPageID: id } : { lightDescriptorID: id, probePID: probeID }), brick: p.brick, epoch: p.epoch, ...version });
    return p.job;
  }
  _job(job, kind = job?.kind) {
    this._alive(); const p = this[kind]?.pages.get(kind === 'cell' ? job?.physicalPageID : job?.lightDescriptorID);
    if (!p || p.job !== job || !p.pending || p.epoch !== this.epoch) throw new Error('stale world page job');
    return p;
  }
  _needed(p) {
    const names = [];
    if (p.readyBits & READY.RAW) names.push('stateA', 'stateB');
    if (p.readyBits & READY.FIELD) names.push('field0', 'field1', 'field2');
    if (p.readyBits & READY.GI_SOURCE) names.push('source');
    if (p.readyBits & READY.GI) names.push('gi0', 'gi1', 'gi2', 'gi3');
    if (p.readyBits & READY.GLOW) names.push('glow');
    if (p.kind === 'cell') names.push('aux');
    return names;
  }
  update(job, data) {
    const p = this._job(job), allowed = new Set(this._needed(p));
    for (const [name, bytes] of Object.entries(data)) {
      check(allowed.has(name), 'channel does not belong to job/readiness');
      const format = name === 'source' ? 'rgba32uint' : PAGE_CHANNELS[name][0];
      const count = name === 'aux' ? AUX_RECORDS : PAGE_CHANNELS[name]?.[1] === 'cells' ? 64 : 1, stride = format === 'rgba32uint' ? 16 : 8;
      check((format === 'rgba32uint' ? bytes instanceof Uint32Array : bytes instanceof Uint16Array) && bytes.byteLength === count * stride, 'page upload must contain exact raw format/length');
      if (name === 'aux') check(bytes[0] === p.readyBits && bytes[1] === p.epoch && bytes[2] === p.sourceRevision && bytes[3] === p.fieldTick, 'page metadata mismatch');
    }
    for (const [name, bytes] of Object.entries(data)) {
      const channel=name==='source'?'source':name.startsWith('gi')?'gi':null;
      if(channel&&p.provenance?.[channel]){const next={...p.provenance};delete next[channel];p.provenance=frozen(next);delete p.restoreDeclarations[channel];}
      const l = p.resources.layout;
      if (name === 'source') this.queue.writeTexture({ texture: p.resources.textures.aux, origin: lightTexel(p.id, 4, l) }, bytes, {}, [1, 1, 1]);
      else if (name === 'aux') for (let r = 0; r < AUX_RECORDS; r++) this.queue.writeTexture({ texture: p.resources.textures.aux, origin: auxTexel(p.id, r, l) }, bytes.subarray(r * 4, r * 4 + 4), {}, [1, 1, 1]);
      else {
        const [, shape, stride] = PAGE_CHANNELS[name];
        this.queue.writeTexture({ texture: p.resources.textures[name], origin: packetAddress(name, p.kind === 'cell' ? p.id : p.probeID, l) }, bytes, { bytesPerRow: shape === 'cells' ? stride * 8 : stride }, shape === 'cells' ? [8, 8, 1] : [1, 1, 1]);
      }
      p.written.add(name);
    }
    return job;
  }
  updateLight(job, data) { this._job(job, 'light'); return this.update(job, data); }
  recordLightWrite(job, kind, options) {
    const p=this._job(job,'light'),lease=options.restoreDeclaration;
    if(lease)validateWorldLightingRestore(lease,{job,kind});
    const result=this.recordPageWrite(job,kind,options);
    if(lease){p.restoreDeclarations??={};p.restoreDeclarations[kind]=lease;p.provenance=frozen({...p.provenance,[kind]:lease.provenance});}
    else if(p.provenance?.[kind]){const next={...p.provenance};delete next[kind];p.provenance=frozen(next);delete p.restoreDeclarations[kind];}
    return result;
  }
  writerBindings(job, kind) {
    const p = this._job(job), names = kind === 'source' ? ['source'] : WRITER_CHANNELS[kind];
    check(names && names.every(n => this._needed(p).includes(n)), 'writer does not belong to job/readiness');
    const l = p.resources.layout, words = new Uint32Array(16);
    words.set([p.kind === 'cell' ? p.id : p.probeID ?? 0, l.cells.x, l.cells.y, 0]);
    words.set([l.aux.width, l.aux.height, 0, 0], 4); words.set([l.probes.width, l.probes.height, 0, 0], 8);
    if (kind === 'source') words[12] = l.descriptorBase + p.id * LIGHT_RECORDS + 4;
    return frozen({ params: words, outputs: frozen(names.map((n, binding) => frozen({ binding, resource: p.resources.views[n === 'source' ? 'aux' : n] }))) });
  }
  recordPageWrite(job, kind, { auxMetadata, record }) {
    this.recordPageWrites([{ job, kind, auxMetadata, record }]); return job;
  }
  recordPageWrites(writes) {
    this._alive(); check(Array.isArray(writes), 'page writes must be an array');
    if (!writes.length) return [];
    const encoder = this.device.createCommandEncoder({ label: 'world provider pages' }), staged = [];
    for (const { job, kind, auxMetadata, record } of writes) {
      const p = this._job(job), bindings = this.writerBindings(job, kind);
      check(typeof record === 'function' && record.constructor.name !== 'AsyncFunction', 'writer must be synchronous');
      if (kind === 'raw') check(auxMetadata?.length === 4 && auxMetadata.every((v, i) => v === [p.readyBits, p.epoch, p.sourceRevision, p.fieldTick][i]), 'writer metadata mismatch');
      this.recording = true;
      try {
        // Native texel copies are scoped to this unpublished page only.
        const destinations = kind === 'fields' ? WRITER_CHANNELS.fields.map(name => ({ texture: p.resources.textures[name], origin: pageTexel(p.id, 0, p.resources.layout) }))
          : kind === 'source' ? [{ texture: p.resources.textures.aux, origin: lightTexel(p.id, 4, p.resources.layout) }]
          : kind === 'gi' || kind === 'glow' ? WRITER_CHANNELS[kind].map(name => ({ texture: p.resources.textures[name], origin: probeTexel(p.probeID, p.resources.layout) })) : null;
        const scoped = destinations ? frozen({ ...bindings, destinations: frozen(destinations.map(d => frozen({ ...d, origin: frozen(d.origin) }))) }) : bindings;
        const result = record(encoder, scoped); check(!result?.then, 'writer must be synchronous');
      }
      finally { this.recording = false; }
      staged.push({ job, p, kind });
    }
    for (const { job } of staged) this._job(job);
    this.queue.submit([encoder.finish()]);
    for (const { p, kind } of staged) (kind === 'source' ? ['source'] : WRITER_CHANNELS[kind]).forEach(n => p.written.add(n));
    return staged.map(({ job }) => job);
  }
  _writeDescriptor(p) {
    const d = p.dependencies;
    const records = [[p.readyBits, p.epoch, p.sourceRevision, p.sourceTick], [p.readyBits & READY.GI ? p.probeID + 1 : 0, p.readyBits & READY.GLOW ? p.probeID + 1 : 0, p.giTick, p.glowTick],
      [d.source.id, d.source.version, d.gi.id, d.gi.version], [d.glow.id, d.glow.version, WORLD_ATLAS_ABI, this.generation + 1]];
    records.forEach((v, r) => this.queue.writeTexture({ texture: p.resources.textures.aux, origin: lightTexel(p.id, r, p.resources.layout) }, new Uint32Array(v), {}, [1, 1, 1]));
  }
  publish(input) {
    this._alive();
    const explicit = input && !Array.isArray(input) && !input.kind;
    if (explicit) {
      check((input.cellJobs ?? []).every(j => j?.kind === 'cell') && (input.lightJobs ?? []).every(j => j?.kind === 'light'), 'publication job kind mismatch');
    }
    const jobs = explicit ? [...(input.cellJobs ?? []), ...(input.lightJobs ?? [])] : Array.isArray(input) ? input : [input];
    const ps = jobs.map(j => this._job(j)); check(new Set(ps).size === ps.length, 'duplicate publication job');
    check(ps.every(p=>!p.producerOnly&&p.publication?.sourcePhaseToken==null&&
      p.restoreDeclarations?.source?.publication.sourcePhaseToken==null&&p.restoreDeclarations?.gi?.publication.sourcePhaseToken==null),
      'private SOURCE/previous-GI closure cannot be presented');
    const dependencies = explicit && input.dependencyToken ? manifest(input.dependencyToken) : this.current.dependencies;
    const sun = explicit && Object.hasOwn(input, 'sunManifest') ? sunManifest(input.sunManifest) : this.current.sunManifest;
    check(dependencies.version >= this.current.dependencies.version, 'dependency manifest regression');
    check(dependencies.version !== this.current.dependencies.version || JSON.stringify(dependencies.sets) === JSON.stringify(this.current.dependencies.sets), 'changed dependencies require new manifest version');
    check(!sun || (sun.epoch === this.epoch && sun.params.version[3] === this.bookLayout.sunWord), 'sun epoch/request offset mismatch');
    const oldSun = this.current.sunManifest;
    check(!sun || !oldSun || sun.basisRevision > oldSun.basisRevision || (sun.basisRevision === oldSun.basisRevision && sun.publishRevision >= oldSun.publishRevision), 'sun publication regression');
    if (sun && oldSun && sun.basisRevision === oldSun.basisRevision && sun.publishRevision === oldSun.publishRevision) check(
      ['book','sun0','sun1','dependencySetID','dependencyVersion'].every(k => sun[k] === oldSun[k]) && JSON.stringify(sun.params) === JSON.stringify(oldSun.params), 'changed sun publication requires new version');
    const invalidations = explicit ? input.invalidations ?? [] : [];
    const cleared = invalidations.map(({ brick, channels }) => {
      check([READY.CELL, READY.LIGHT, READY.ALL].includes(channels), 'invalidation must clear complete pool domains');
      return { index: worldBrickIndex(this.bookLayout, brick), channels };
    });
    const nextCell = this.entries.slice(), nextLight = this.lightEntries.slice(), oldPages = [];
    // Required demand remains required. Clear/install in ONE immutable commit;
    // replacements below win, and older snapshots retain their original pins.
    for (const { index, channels } of cleared) for (const [kind, entries, mask] of [['cell', nextCell, READY.CELL], ['light', nextLight, READY.LIGHT]]) {
      if (!(channels & mask)) continue;
      if (entries[index]) oldPages.push(this[kind].pages.get(entries[index] - 1));
      entries[index] = 0;
    }
    for (const p of ps) {
      check(this._needed(p).every(n => p.written.has(n)), 'cannot publish partial page');
      for(const [kind,lease]of Object.entries(p.restoreDeclarations??{}))validateWorldLightingRestore(lease,{job:p.job,kind});
      const entries = p.kind === 'cell' ? nextCell : nextLight;
      if (entries[p.index]) oldPages.push(this[p.kind].pages.get(entries[p.index] - 1));
      entries[p.index] = p.id + 1;
    }
    for (let i = 0; i < nextLight.length; i++) if (nextLight[i] && nextCell[i]) {
      check(this.light.pages.get(nextLight[i] - 1).sourceRevision === this.cell.pages.get(nextCell[i] - 1).sourceRevision, 'incompatible cell/light source revision');
    }
    // Revalidate retained descriptors too: a new manifest cannot silently mix old dependencies.
    for (const v of nextLight) if (v) {
      const p = this.light.pages.get(v - 1);
      for (const [channel, bit] of [['source', READY.GI_SOURCE], ['gi', READY.GI], ['glow', READY.GLOW]]) if (p.readyBits & bit) {
        const d = p.dependencies[channel];
        const retained=p.provenance?.[channel];
        if(retained)check(retained.publication===p.publication&&retained.publication.epoch===p.epoch&&retained.publication.sourceRevision===p.sourceRevision,'incompatible retained publication');
        else check(!d.id || dependencies.sets.some(x => x.id === d.id && x.version === d.version), 'incompatible channel dependency version');
      }
    }
    if (sun?.dependencySetID) check(dependencies.sets.some(d => d.id === sun.dependencySetID && d.version === sun.dependencyVersion), 'incompatible sun dependency version');
    for (const p of ps) if (p.kind === 'light') this._writeDescriptor(p);
    const moved = ps.filter(p => p.resources !== this.resources);
    if (moved.length) {
      const encoder = this.device.createCommandEncoder({ label: 'world pending repack' });
      moved.forEach(p => copyJob(encoder, p.resources, this.resources, p)); this.queue.submit([encoder.finish()]);
    }
    this._commit(nextCell, nextLight, this.resources, this.epoch, dependencies, sun);
    for (const p of oldPages) { p.public = false; this._collect(p); }
    for (const p of ps) { p.public = true; p.pending = false; this[p.kind].pending.delete(p.index); this._releaseResources(p.resources); }
    this.onChange({ epoch: this.epoch, generation: this.generation }); return this.generation;
  }
  remove(bricks, channels = READY.ALL) {
    this._alive(); const indices = bricks.map(b => worldBrickIndex(this.bookLayout, b));
    for (const i of indices) check(!this.required.has(i) && !this.cell.pending.has(i) && !this.light.pending.has(i), 'cannot remove requested/pending brick');
    const cells = this.entries.slice(), lights = this.lightEntries.slice(), oldPages = [];
    for (const [kind, entries, mask] of [['cell', cells, READY.CELL], ['light', lights, READY.LIGHT]]) if (channels & mask) for (const i of indices) {
      if (entries[i]) oldPages.push(this[kind].pages.get(entries[i] - 1)); entries[i] = 0;
    }
    this._commit(cells, lights);
    for (const p of oldPages) { p.public = false; this._collect(p); }
    this.onChange({ epoch: this.epoch, generation: this.generation });
  }
  _cancelPage(p) { p.pending = false; this[p.kind].pending.delete(p.index); this._releaseResources(p.resources); this._collect(p); }
  cancel(job) { this._cancelPage(this._job(job)); }
  grow(capacity = worldPoolGrowth('cell', this.resources.layout, this.limits)) { return this.growPool('cell', capacity); }
  growPool(kind, capacity = worldPoolGrowth(kind, this.resources.layout, this.limits)) {
    this._alive(); const old = this.resources, l = old.layout, key = kind === 'cell' ? 'capacity' : kind + 'Capacity';
    check(['cell', 'light', 'probe'].includes(kind) && integer(capacity, l[key] + 1, worldPoolMax(kind, l, this.limits)), 'grow must increase capacity within legal address limit');
    const sizes = { capacity: l.capacity, lightCapacity: l.lightCapacity, probeCapacity: l.probeCapacity, [key]: capacity };
    // Descriptor base movement must COW aux even when rounded dimensions stay the same.
    const share = kind === 'cell' ? { ...old, owners: { ...old.owners, aux: null } } : old;
    const next = createResources(this.device, worldAtlasLayout(sizes.capacity, this.limits, sizes.lightCapacity, sizes.probeCapacity), share);
    try {
      const encoder = this.device.createCommandEncoder({ label: 'world atlas growth' });
      // Pinned retired descriptors are still addressed by producer-only mixed
      // readers. Every growth preserves their numeric pool prefix too.
      for (const pool of [this.cell, this.light]) for (const p of pool.pages.values()) if (p.public || p.pins) copyJob(encoder, old, next, p);
      this.queue.submit([encoder.finish()]); this._commit(this.entries, this.lightEntries, next);
    } catch (e) { this._releaseResources(next); throw e; }
    this.resources = next; this._releaseResources(old);
    this.onChange({ epoch: this.epoch, generation: this.generation }); return next.layout;
  }
  snapshot() { this._alive(); return this._snapshot(this.current); }
  _snapshot(s) {
    s.refs++; let released = false;
    const handle = frozen({ abi: WORLD_ATLAS_ABI, producerOnly:!!s.producerOnly, epoch: s.epoch, generation: s.generation, layout: s.r.layout, book: s.book, lightBook: s.lightBook, params: s.params, views: s.r.views,
      dependencies: s.dependencies, sunManifest: s.sunManifest,
      lightingProvenance: brick => {
        if(released)throw new Error('snapshot released');
        check(s.epoch===this.epoch,'stale world snapshot epoch');
        return s.pins.find(p=>p.kind==='light'&&p.index===worldBrickIndex(this.bookLayout,brick))?.provenance??null;
      },
      retain: () => {
        if (released) throw new Error('snapshot released');
        check(s.epoch === this.epoch, 'stale world snapshot epoch');
        return this._snapshot(s);
      },
      // Borrow only under this exact snapshot's existing pin. Never reconstruct
      // native resources from the latest Atlas after an asynchronous boundary.
      textures: () => {
        if (released) throw new Error('snapshot released');
        check(s.epoch === this.epoch, 'stale world snapshot epoch');
        return frozen({ ...s.r.textures });
      },
      bindings: (external, feedback) => {
        if (released) throw new Error('snapshot released');
        check(!s.producerOnly,'private LIGHT closure is producer-only');
        check(s.epoch === this.epoch, 'stale world snapshot epoch');
        check(feedback?.size >= this.feedbackBytes && feedback.size <= Math.min(this.limits.maxStorageBufferBindingSize, 128 * 1024 ** 2), 'feedback binding size');
        return [
          [{ binding: 0, resource: { buffer: s.params } }, { binding: 1, resource: { buffer: s.book } }, { binding: 2, resource: { buffer: s.lightBook } }],
          ['stateA', 'stateB', 'field0', 'field1', 'field2', 'aux'].map((n, binding) => ({ binding, resource: s.r.views[n] })),
          [...['gi0', 'gi1', 'gi2', 'gi3', 'glow'].map(n => s.r.views[n]), ...['sunDepth', 'sunOptical', 'mediaNoise', 'sourceAppearance', 'packedMesh'].map(n => { check(external?.[n], `missing external ${n}`); return external[n]; })].map((resource, binding) => ({ binding, resource })),
          [{ binding: 0, resource: { buffer: feedback, size: this.feedbackBytes } }],
        ];
      }, release: () => { if (!released) { released = true; this._releaseSnapshot(s); } } });
    this.snapshotStates.set(handle, { s, live: () => !released });
    return handle;
  }
  // A private all-SOURCE/previous-GI closure. It never changes current books,
  // readiness, generation, or demand; only producerBindings may consume it.
  prepareProducerSnapshot({lightJobs,dependencyToken,sourcePhaseToken}) {
    this._alive();check(sourcePhaseToken!=null,'private SOURCE phase identity required');
    check(this.generation<U32_MAX,'world generation overflow');
    const lights=new Uint32Array(this.bookLayout.count),seen=new Set(),sourceCovered=new Set(),probeCovered=new Set(),target=lightJobs[0]?.publication;
    for(const job of lightJobs){
      const p=this._job(job,'light');check(!seen.has(p.index),'duplicate private light job');seen.add(p.index);
      check(p.publication===target,'private closure target identity mismatch');
      check(!(p.readyBits&READY.GLOW)&&this._needed(p).every(n=>p.written.has(n)),'private channels must be completely written SOURCE/GI');
      const declaration=p.restoreDeclarations?.source??p.restoreDeclarations?.gi;
      check(declaration?.publication===target&&declaration.publication.sourcePhaseToken===sourcePhaseToken,'authenticated private SOURCE phase required');
      for(const [kind,lease]of Object.entries(p.restoreDeclarations??{}))validateWorldLightingRestore(lease,{job,kind});
      for(const [kind,channel]of [['source',READY.GI_SOURCE],['gi',READY.GI]])if(p.readyBits&channel)check(p.restoreDeclarations?.[kind]?.publication===target,'private channel target mismatch');
      check(p.resources===this.resources,'private closure must use current pool prefix');
      if(p.readyBits&READY.GI_SOURCE)sourceCovered.add(p.index);
      if(p.readyBits&READY.GI)probeCovered.add(p.index);
      this._writeDescriptor(p);lights[p.index]=p.id+1;
    }
    const required=target?.sourceIndices,probes=target?.probeIndices;
    check(required?.every(i=>sourceCovered.has(i)),'private closure omits selected SOURCE records');
    check(probes?.every(i=>probeCovered.has(i)),'private closure omits requested previous GI records');
    // This is a private reader generation, not a public commit. Descriptors
    // use the same N+1 stamp; public books/counter remain at N.
    const s=this._snapshotState(this.entries.slice(),lights,this.resources,this.epoch,dependencyToken?manifest(dependencyToken):this.current.dependencies,this.current.sunManifest,this.generation+1);
    s.producerOnly=true;
    for(const job of lightJobs)this._job(job,'light').producerOnly=true;
    const out=this._snapshot(s);this._releaseSnapshot(s);return out;
  }
  // Producer-only: current CELL plus an exact pinned previous LIGHT book.
  // Default render snapshots and their coherent bindings are unchanged.
  producerBindings(cellSnapshot, previousSnapshot, external, feedback) {
    this._alive();
    const a = this.snapshotStates.get(cellSnapshot), b = this.snapshotStates.get(previousSnapshot);
    check(a?.live() && b?.live(), 'owned live producer snapshots required');
    check(a.s.epoch === this.epoch && b.s.epoch === this.epoch &&
      (b.s.producerOnly ? a.s.generation===this.generation&&b.s.generation===this.generation+1 : a.s.generation>=b.s.generation), 'producer snapshot epoch/generation mismatch');
    check(a.s.r === this.resources, 'producer CELL snapshot must use current pool prefix');
    if(b.s.producerOnly)check(b.s.r===this.resources,'private LIGHT pool changed; rebuild closure');
    for (const p of b.s.pins) if (p.kind === 'light') check(p.pins > 0 && this.light.pages.get(p.id) === p, 'previous LIGHT pool lifetime mismatch');
    const groups = cellSnapshot.bindings(external, feedback);
    if(b.s.producerOnly)groups[0][0]={binding:0,resource:{buffer:b.s.params}};
    groups[0][2] = { binding: 2, resource: { buffer: b.s.lightBook } };
    return groups;
  }
  lookup(brick, readyBits = READY.CELL) {
    this._alive(); check(integer(readyBits, 1, READY.ALL), 'invalid requested channels');
    const index = worldBrickIndex(this.bookLayout, brick), c = this.entries[index], l = this.lightEntries[index];
    const cell = c ? this.cell.pages.get(c - 1) : null, light = l ? this.light.pages.get(l - 1) : null;
    const missingChannels = readyBits & ~((cell?.readyBits ?? 0) | (light?.readyBits ?? 0));
    return missingChannels ? { known: false, incomplete: true, request: index, missingChannels } : { known: true, incomplete: false, physicalPageID: cell?.id, lightDescriptorID: light?.id, probePID: light?.probeID, epoch: this.epoch, sourceRevision: cell?.sourceRevision ?? light?.sourceRevision, fieldTick: cell?.fieldTick };
  }
  reset() {
    this._alive(); check(this.epoch < U32_MAX, 'world epoch overflow');
    this._commit(new Uint32Array(this.bookLayout.count), new Uint32Array(this.bookLayout.count), this.resources, this.epoch + 1, manifest(), null);
    for (const pool of [this.cell, this.light]) {
      for (const p of [...pool.pending.values()]) this._cancelPage(p);
      for (const p of pool.pages.values()) { p.public = false; this._collect(p); }
    }
    this.required.clear(); this.onChange({ epoch: this.epoch, generation: this.generation });
  }
  dispose() {
    if (this.dead) return; this._alive();
    for (const pool of [this.cell, this.light]) for (const p of [...pool.pending.values()]) this._cancelPage(p);
    this.dead = true;
    this._releaseSnapshot(this.current); this._releaseResources(this.resources);
    for (const pool of [this.cell, this.light]) for (const p of pool.pages.values()) { p.public = false; this._collect(p); }
  }
}
