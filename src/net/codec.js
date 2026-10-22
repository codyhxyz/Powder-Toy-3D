// Protocol contract: these quantized packets are render projections, NOT
// authoritative native snapshots. Guests never simulate them while the session
// lasts. Native hosts pack directly from compact readers; edits return to the
// host as intents. A Physics V2 host's frames (FRAME_NATIVE_*) add, after the
// texels, the exact native cells the texel can't hold and its flying matter
// (nativeSection below); a V2 guest writes both into its own native owner, so
// it draws what the host's cells hold and, once the session ends, plays on
// from them (app.js v2Replica).
import { prelude, STATE_OPTS, LAYOUT, STAGE, BRICK, TILE, SUPER, SUPER_TEX, atlasDims, marksLayout } from '../shaders/common.js';
import { fold } from '../gpu/kernels.js';
import { uniformStruct } from '../gpu/params.js';
import { ELEMENTS } from '../elements.js';
import { validMetadata } from './protocol.js';

// World stream codec. The host packs the state into 4 bytes per cell holding
// only what guests render, and sends a keyframe or an XOR delta against the
// last frame it sent, deflated. Guests unpack it back into the state layout
// the renderer reads. Guests only render, so anything the renderer doesn't use
// is left out:
//   R  element id
//   G  temperature code (see TEMP below); air is always sent as ambient
//   B  life, only for elements whose look depends on it (smoke density, fire)
//   A  ctype (what lava melted from sets where its crust forms; what a clone copies);
//      for a conductor only its spark's phase, which says whether it is live
//      (src/electricity.js; its level can pass a byte)
// Velocity and pressure aren't sent (so a guest's grains are textured in
// place, without flow), and the per-grain colour seed is re-derived from the
// cell position on the guest.
//
// The bytes are in the state atlas's texel order (sim.js cellTexel: what the
// WebGL build's RGBA8 target held, texels past the last supertile 0), so the
// wire format is unchanged and WebGL and WebGPU peers read each other's frames
// (docs/webgpu.md C2). On the GPU (G4) the pack kernel reads the brick-major
// slots and writes each cell's word at its texel; unpack uploads the bytes and
// a kernel writes the current copy with fresh flags, a whole-grid write.

const BYTE_MAX = 255;
export const TEXEL_BYTES = 4; // RGBA8

// Temperature in one byte: linear steps up to LOG_START, then equal ratios up
// to MAX so glowing material (whose brightness rises steeply with temperature)
// changes in small relative steps.
const TEMP = {
  MIN: -100,       // °C; anything colder is sent as MIN (the heat view's scale bottoms out at −40)
  LINEAR_STEP: 4,  // °C per code below LOG_START
  LOG_START: 400,  // °C; just below where incandescence starts
  MAX: 6000,       // °C; the heat tool's cap
};
const TEMP_LINEAR_CODES = (TEMP.LOG_START - TEMP.MIN) / TEMP.LINEAR_STEP;
const TEMP_LOG_CODES = BYTE_MAX - TEMP_LINEAR_CODES;

// The guest's per-cell colour seed: same range the app uses for fresh cells.
const SEED_SPAN = 0.999;

const f = (x) => x.toFixed(4); // a JS number as a WGSL f32 literal

const codecGLSL = /* wgsl */ `
const BYTE_MAX: f32 = ${f(BYTE_MAX)};
const TEMP_MIN: f32 = ${f(TEMP.MIN)};
const TEMP_LINEAR_STEP: f32 = ${f(TEMP.LINEAR_STEP)};
const TEMP_LOG_START: f32 = ${f(TEMP.LOG_START)};
const TEMP_MAX: f32 = ${f(TEMP.MAX)};
const TEMP_LINEAR_CODES: f32 = ${f(TEMP_LINEAR_CODES)};
const TEMP_LOG_CODES: f32 = ${f(TEMP_LOG_CODES)};
const SEED_SPAN: f32 = ${f(SEED_SPAN)};

fn encodeTemp(T: f32) -> f32 {
  var code: f32;
  if (T < TEMP_LOG_START) {
    code = (max(T, TEMP_MIN) - TEMP_MIN) / TEMP_LINEAR_STEP;
  } else {
    code = TEMP_LINEAR_CODES + TEMP_LOG_CODES * log(min(T, TEMP_MAX) / TEMP_LOG_START) / log(TEMP_MAX / TEMP_LOG_START);
  }
  return clamp(round(code), 0.0, BYTE_MAX);
}
fn decodeTemp(code: f32) -> f32 {
  if (code <= TEMP_LINEAR_CODES) { return TEMP_MIN + code * TEMP_LINEAR_STEP; }
  return TEMP_LOG_START * pow(TEMP_MAX / TEMP_LOG_START, (code - TEMP_LINEAR_CODES) / TEMP_LOG_CODES);
}
fn sendsLife(id: i32) -> bool { return id == E_SMOKE || id == E_FIRE; }
`;

// Cell p's texel in the state atlas (sim.js cellTexel; shaders/passes.js
// converts the state to and from it the same way): supertile i's square at
// (i % STW, i / STW), its brick k's tile at (k.x, k.z + SUPER.z·k.y), the
// cell at (x + BRICK·(y & 1), z + BRICK·(y >> 1)) in the tile.
const atlasWGSL = (g) => {
  const at = atlasDims(g);
  return /* wgsl */ `
const STW: i32 = ${at.stw};   // supertiles per atlas row
const ATLAS_W: i32 = ${at.width};
@group(2) @binding(0) var<storage, ${'${ACCESS}'}> packed: array<u32>;   // a texel's RGBA8, R in the low byte
fn atlasIndex(p: vec3i) -> u32 {
  let b = p >> vec3u(2u);
  let st = b / SUPER_B;
  let k = b - st * SUPER_B;
  let i = st.x + STX * (st.z + STZ * st.y);
  let ly = p.y & 3;
  let u = (i % STW) * ${SUPER_TEX} + k.x * ${TILE} + (p.x & 3) + ${BRICK} * (ly & 1);
  let v = (i / STW) * ${SUPER_TEX} + (k.z + ${SUPER.z} * k.y) * ${TILE} + (p.z & 3) + ${BRICK} * (ly >> 1u);
  return u32(v * ATLAS_W + u);
}`;
};
const slotMain = /* wgsl */ `@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li);
  if (s >= SLOTS) { return; }`;

// pack: a thread per slot, its cell's word at its texel (the padding texels
// are never written: the buffer starts zeroed and stays so there)
const packFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${codecGLSL}
${atlasWGSL(g).replace('${ACCESS}', 'read_write')}
${slotMain}
  let a = fetchAs(s);
  let id = eid(a);
  var T = a.y;
  if (id == E_EMPTY) { T = AMBIENT; }
  var life = 0.0;
  if (sendsLife(id)) { life = round(clamp(a.z, 0.0, 1.0) * BYTE_MAX); }
  var ct = floor(a.w);
  if (CONDUCTS(id)) { ct = f32(sparkPhase(floor(a.w))); }
  let q = vec4u(vec4f(f32(id), encodeTemp(T), life, clamp(ct, 0.0, BYTE_MAX)));
  packed[atlasIndex(cellOf(s))] = q.x | (q.y << 8u) | (q.z << 16u) | (q.w << 24u);
}
`;

// unpack: a thread per slot, the current copy (H.dst) from its texel's word,
// with fresh flags (velocity and pressure aren't sent: 0)
const unpackFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RW)}
${codecGLSL}
${atlasWGSL(g).replace('${ACCESS}', 'read')}
${slotMain}
  let p = cellOf(s);
  let w = packed[atlasIndex(p)];
  let q = vec4f(f32(w & 255u), f32((w >> 8u) & 255u), f32((w >> 16u) & 255u), f32(w >> 24u));
  var rs = seed3(p, 0u, SALT_CODEC);
  let a = vec4f(q.x, decodeTemp(q.y), q.z / BYTE_MAX, q.w + rnd(&rs) * SEED_SPAN);
  let b = vec4f(0.0);
  writeStateS(s, a, b, freshFlags(a, b));
}
`;
export { packFrag, unpackFrag };

// ---- Physics V2 on the wire ----
// A V2 guest writes each texel into its owner's native cells (PhysicsV2.cells, banks in aux) as the
// import kernel turns today's state A into a core (shaders/v2.js importA, the leave kernel's copy:
// shaders/v2/leave.js importAWGSL): what the texel carries, exactly as a V1 guest's unpack keeps it.
// The life the texel doesn't carry (only smoke and fire send it) is the element's own, as a fresh
// cell's (v2/layout.js makeMaterial), not V1's 0: V2 burns a solid's or liquid's fuel from it.
// Then the cells the texel can't hold come exact: a V2 host's pack lists every cell whose core
// differs from what its texel imports to (a partial fill, foam, flux, fall, a fraction, a burn, a
// spark, a phase change: needsRecord), with its bank; the guest writes those over (nativeRecordsFrag).
// The temperature byte and colour seed are the texel's, as a V1 guest's.
export const NATIVE_RECORD_WORDS = 6;          // slot, core.xyzw, bank
export const MAX_NATIVE_RECORDS = 1 << 16;     // a frame's exact cells at most (1.5 MB); the rest import from their texels
export const NATIVE_PARTICLE_WORDS = 13;       // pool slot, then the 48-byte record (v2/dynamics.js DYNAMICS_ABI)
const PARTICLE_RECORD_WORDS = 12;              // ...the record's words (DYNAMICS_ABI particleBytes / 4)
const PARTICLE_ID_WORD = 3;                    // ...its stable id (DYNAMICS_ABI particleIdOffset / 4): 0 is a free slot
export const MAX_NATIVE_PARTICLES = 1 << 14;   // flying records a frame sends at most (850 KB)
const POOL_SLOTS_MAX = 1 << 16;                // a pool's slots at most (gfx/nativeParticles.js validateNativeParticleSource)
const PHASE_NORMAL_MAX = 41093;                // the last plain temperature code (v2/phase.js PHASE_NORMAL_MAX)
const POWDER_REST = 0x80000000;                // a resting powder's fall word: -0.0, V2's fall marker (shaders/v2/fall.js setFall)
const ELEMENT_LIFE = ELEMENTS.map((e) => e.life ?? 0);

// The texel as the guest reads it back: today's A of the cell (unpackFrag's), but the element's own
// life where the wire sends none.
const guestTexelWGSL = /* wgsl */ `
const ELEMENT_LIFE = array<f32, ${ELEMENTS.length}>(${ELEMENT_LIFE.map(f).join(',')});
fn guestA(p: vec3i, w: u32) -> vec4f {
  let q = vec4f(f32(w & 255u), f32((w >> 8u) & 255u), f32((w >> 16u) & 255u), f32(w >> 24u));
  var rs = seed3(p, 0u, SALT_CODEC);
  let id = i32(q.x);
  var life = q.z / BYTE_MAX;
  if (!sendsLife(id)) { life = ELEMENT_LIFE[u32(clamp(id, 0, ${ELEMENTS.length - 1}))]; }
  return vec4f(q.x, decodeTemp(q.y), life, q.w + rnd(&rs) * SEED_SPAN);
}`;
const nativeCellsWGSL = /* wgsl */ `
@group(1) @binding(0) var<storage, read_write> cells: array<vec4u>;   // PhysicsV2.cells
@group(1) @binding(1) var<storage, read_write> banks: array<i32>;     // PhysicsV2.aux: the banks first`;

// unpackNative: a thread per slot, its core from its texel (bank 0, the import's)
const unpackNativeFrag = (g, v2) => /* wgsl */ `
${prelude(g)}
${codecGLSL}
${atlasWGSL(g).replace('${ACCESS}', 'read')}
${v2.helpers}
${v2.importA}
${guestTexelWGSL}
${nativeCellsWGSL}
${slotMain}
  let p = cellOf(s);
  cells[s] = importA(guestA(p, packed[atlasIndex(p)]));
  banks[s] = 0;
}
`;
// nativeRecords: a thread per record, the host's exact core and bank over the texel's
const nativeRecordsFrag = (g) => /* wgsl */ `
${prelude(g)}
${nativeCellsWGSL}
@group(2) @binding(0) var<storage, read> records: array<u32>;   // ${NATIVE_RECORD_WORDS} words a record
${NativeRecordParams.wgsl}
@group(3) @binding(1) var<uniform> P: NativeRecordParams;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldThread(wg, nwg, li);
  if (i >= P.count) { return; }
  let o = i * ${NATIVE_RECORD_WORDS}u;
  let s = records[o];
  if (s >= SLOTS) { return; }
  cells[s] = vec4u(records[o + 1u], records[o + 2u], records[o + 3u], records[o + 4u]);
  banks[s] = bitcast<i32>(records[o + 5u]);
}
`;
// packNative: packFrag's texel, then the cell's record when its core isn't what that texel imports to
// (the seed and the temperature code aside, as the guest's are the texel's)
const packNativeFrag = (g, v2) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${codecGLSL}
${atlasWGSL(g).replace('${ACCESS}', 'read_write')}
${v2.helpers}
${v2.importA}
${guestTexelWGSL}
struct NativeRecords { count: atomic<u32>, words: array<u32> }
@group(2) @binding(1) var<storage, read_write> rec: NativeRecords;
@group(2) @binding(2) var<storage, read> banks: array<i32>;   // PhysicsV2.aux: the banks first
fn sentMask(c: vec4u) -> vec4u {
  var m = vec4u(c.x & 0xff0000ffu, c.y, c.z, c.w);
  if (cls(c.x & 255u) != C_LIQUID) { m.w = c.w & 0xffffu; }   // (a liquid's high half is its payload, not a seed)
  if (m.z == ${POWDER_REST}u) { m.z = 0u; }                      // (at rest either way)
  return m;
}
fn needsRecord(c: vec4u, n: vec4u) -> bool {
  return any(sentMask(c) != sentMask(n)) || ((c.x >> 8u) & 65535u) > ${PHASE_NORMAL_MAX}u;
}
${slotMain}
  let a = fetchAs(s);
  let id = eid(a);
  var T = a.y;
  if (id == E_EMPTY) { T = AMBIENT; }
  var life = 0.0;
  if (sendsLife(id)) { life = round(clamp(a.z, 0.0, 1.0) * BYTE_MAX); }
  var ct = floor(a.w);
  if (CONDUCTS(id)) { ct = f32(sparkPhase(floor(a.w))); }
  let q = vec4u(vec4f(f32(id), encodeTemp(T), life, clamp(ct, 0.0, BYTE_MAX)));
  let w = q.x | (q.y << 8u) | (q.z << 16u) | (q.w << 24u);
  let p = cellOf(s);
  packed[atlasIndex(p)] = w;
  let c = fetchNativeCore(p);
  if (needsRecord(c, importA(guestA(p, w)))) {
    let i = atomicAdd(&rec.count, 1u);
    if (i < ${MAX_NATIVE_RECORDS}u) {
      let o = i * ${NATIVE_RECORD_WORDS}u;
      rec.words[o] = s;
      rec.words[o + 1u] = c.x; rec.words[o + 2u] = c.y; rec.words[o + 3u] = c.z; rec.words[o + 4u] = c.w;
      rec.words[o + 5u] = bitcast<u32>(banks[s]);
    }
  }
}
`;
// packParticles: the pool's flying records, listed (a thread a pool slot)
const packParticlesFrag = (capacity) => /* wgsl */ `
struct Flying { count: atomic<u32>, words: array<u32> }
@group(0) @binding(0) var<storage, read> pool: array<u32>;   // ${PARTICLE_RECORD_WORDS} words a record
@group(0) @binding(1) var<storage, read_write> out: Flying;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= ${capacity}u || pool[i * ${PARTICLE_RECORD_WORDS}u + ${PARTICLE_ID_WORD}u] == 0u) { return; }
  let k = atomicAdd(&out.count, 1u);
  if (k >= ${MAX_NATIVE_PARTICLES}u) { return; }
  let o = k * ${NATIVE_PARTICLE_WORDS}u;
  out.words[o] = i;
  for (var j = 0u; j < ${PARTICLE_RECORD_WORDS}u; j++) { out.words[o + 1u + j] = pool[i * ${PARTICLE_RECORD_WORDS}u + j]; }
}
`;
const NativeRecordParams = uniformStruct('NativeRecordParams', { count: 'u32' });
export { packNativeFrag, unpackNativeFrag, nativeRecordsFrag, packParticlesFrag };
// The V2 parts these kernels take from the import kernel, loaded with V2 (the module V2 brings)
let v2Parts = null;
export function nativeCodecParts() {
  return v2Parts ??= Promise.all([import('../shaders/v2/leave.js'), import('../shaders/v2.js'), import('../v2/materialValidation.js')])
    .then(([leave, v2, material]) => ({ helpers: leave.nativeImportHelpersWGSL, importA: (g) => leave.importAWGSL(g),
      LEGACY_STALE: v2.LEGACY_WORD.STALE, validFlying: (rec) => validFlying(rec, material.validateMaterialCore) }));
}
// A flying record a guest takes (v2/dynamics.js validateDynamicState's per-record test, its
// photon and neutron payload bounds aside): a position and velocity, and its material's words.
const RAY_TAGS = [254, 255];   // photon, neutron (docs/v2/native-contract.md particle-only tags)
function validFlying(rec, validateMaterialCore) {
  const fl = new Float32Array(rec.buffer, rec.byteOffset, PARTICLE_RECORD_WORDS);
  if (!rec[PARTICLE_ID_WORD] || ![0, 1, 2, 4, 5, 6].every((k) => Number.isFinite(fl[k]) && Math.abs(fl[k]) <= 1e12)) return false;
  const tag = rec[7] & 255;
  if (RAY_TAGS.includes(tag)) return true;
  if (!tag || tag >= ELEMENTS.length) return false;
  try { validateMaterialCore(rec.subarray(7, 11)); } catch { return false; }
  return true;
}
const NATIVE_CELLS_LAYOUT = [0, 1].map((binding) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }));
const RECORDS_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }];
const PACK_NATIVE_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }, { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }];
const PACK_PARTICLES_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];
const RECORD_HEAD_BYTES = 16;   // the count (an atomic word), padded
const PACK_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];
const UNPACK_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }];
const perSlot = (g) => fold(Math.ceil(g.slots / 64));
/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
export const WGSL_CHECK = [
  { name: 'pack', kind: 'compute', code: packFrag, warm: false, layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, PACK_LAYOUT], dispatch: perSlot },
  { name: 'unpack', kind: 'compute', code: unpackFrag, warm: false, layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, UNPACK_LAYOUT], dispatch: perSlot },
];

// decodeTemp, on the CPU: a packed temperature code (byte G) back to °C (the NPCs' world model reads it)
export function decodeTempCode(code) {
  return code <= TEMP_LINEAR_CODES
    ? TEMP.MIN + code * TEMP.LINEAR_STEP
    : TEMP.LOG_START * (TEMP.MAX / TEMP.LOG_START) ** ((code - TEMP_LINEAR_CODES) / TEMP_LOG_CODES);
}

const sameGrid = (a, b) => a && b && a.nx === b.nx && a.ny === b.ny && a.nz === b.nz;

// Captures in flight at once. A readback resolves only once the GPU has
// caught up with everything queued before it, which is several frames when
// the GPU is the bottleneck, so captures overlap to keep the frame rate up.
const PACK_SLOTS = 3;

// The owner whose native cells a pack or an unpack reads or writes: the box's V2 owner while it
// presents the box (format 2). Suspended (a V1 run of a box that keeps it) or building: none.
const presenting = (sim) => (sim.compact && sim.compact === sim.compactOwner && sim.compact.isReady && !sim.compact.disposed ? sim.compact : null);
const ZERO_HEAD = new Uint32Array(RECORD_HEAD_BYTES / 4);
const words = (bytes, n) => new Uint32Array(bytes, RECORD_HEAD_BYTES, n).slice();

// Host side: pack the current state on the GPU and read it back without
// stalling. (Its argument, the WebGL build's renderer, is unused: each
// simulation brings its own gpu.) A V2 host's capture also lists the native
// records and its pool's flying matter (the frame's native section).
export function createPacker() {
  let g = null, gpu = null, kernel = null, flyKernel = null, layout = null, free = [], generation = 0, owner = null, ready = null;
  function reset(sim) {
    free.forEach((s) => [s.buffer, s.rec, s.fly].forEach((b) => b?.destroy()));
    g = sim.g;
    gpu = sim.gpu;
    owner = presenting(sim);
    generation++;
    const bytes = g.width * g.height * TEXEL_BYTES;
    const storage = (label, size) => gpu.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    if (!owner) {
      layout = gpu.layout('PACK', PACK_LAYOUT);
      kernel = gpu.kernel({ name: 'pack', code: packFrag(g), layouts: [sim.L.TABLES, sim.L.STATE_RO, layout] });
      flyKernel = null;
      ready = kernel.ready;
      free = Array.from({ length: PACK_SLOTS }, () => {
        const buffer = gpu.createBuffer({ label: 'pack', size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        return { buffer, group: gpu.bindGroup(layout, [{ binding: 0, resource: { buffer } }], 'pack'), bytes: new Uint8Array(bytes) };
      });
      return;
    }
    layout = gpu.layout('PACK_NATIVE', PACK_NATIVE_LAYOUT);
    const flyLayout = gpu.layout('PACK_PARTICLES', PACK_PARTICLES_LAYOUT), dyn = owner.dynamics;
    const capacity = dyn?.renderState?.capacity ?? 0;
    kernel = flyKernel = null;
    const gen = generation, s0 = sim;
    ready = nativeCodecParts().then((v2) => {
      if (gen !== generation) return;
      kernel = gpu.kernel({ name: 'packNative', code: packNativeFrag(g, { helpers: v2.helpers, importA: v2.importA(g) }), layouts: [s0.L.TABLES, s0.L.STATE_RO, layout] });
      if (capacity) flyKernel = gpu.kernel({ name: 'packParticles', code: packParticlesFrag(capacity), layouts: [flyLayout] });
      return Promise.all([kernel.ready, flyKernel?.ready]);
    });
    free = Array.from({ length: PACK_SLOTS }, () => {
      const buffer = storage('pack', bytes), rec = storage('pack native records', RECORD_HEAD_BYTES + MAX_NATIVE_RECORDS * NATIVE_RECORD_WORDS * 4);
      const fly = capacity ? storage('pack flying matter', RECORD_HEAD_BYTES + MAX_NATIVE_PARTICLES * NATIVE_PARTICLE_WORDS * 4) : null;
      const b = (binding, buf) => ({ binding, resource: { buffer: buf } });
      return { buffer, rec, fly, bytes: new Uint8Array(bytes),
        group: gpu.bindGroup(layout, [b(0, buffer), b(1, rec), b(2, owner.aux)], 'pack native'),
        flyGroup: fly ? gpu.bindGroup(flyLayout, [b(0, dyn.particles), b(1, fly)], 'pack flying matter') : null };
    });
  }
  // records the pack of sim's current copy into a slot and its readback
  function capture(sim, slot, metadata) {
    const gen = generation, dims = [g.nx, g.ny, g.nz];
    const meta = metadata?.(); // at dispatch, including first-pack compilation delay
    const release = (back) => {
      if (back) slot.bytes = back;
      if (gen === generation) free.push(slot); else [slot.buffer, slot.rec, slot.fly].forEach((b) => b?.destroy());
    };
    if (!owner) {
      kernel.dispatch(gpu.frame, fold(Math.ceil(g.slots / 64)), { bind: [sim.tables, sim.bindRO, slot.group], header: sim.readHeader() });
      return gpu.readback.buffer(slot.buffer, 0, slot.buffer.size, { into: slot.bytes.buffer })
        .then(() => ({ bytes: slot.bytes, dims, meta, release }), (err) => { release(); throw err; });
    }
    gpu.write(slot.rec, 0, ZERO_HEAD);
    kernel.dispatch(gpu.frame, fold(Math.ceil(g.slots / 64)), { bind: [sim.tables, sim.bindRO, slot.group], header: sim.readHeader() });
    // (an idle pool holds nothing in flight: its read is skipped, as its sweeps are)
    const flying = flyKernel && owner.dynamics?.isReady && owner.dynamics.isIdle !== true;
    if (flying) {
      gpu.write(slot.fly, 0, ZERO_HEAD);
      flyKernel.dispatch(gpu.frame, [owner.dynamics.renderState.capacity / 64, 1, 1], { bind: [slot.flyGroup] });
    }
    const reads = [gpu.readback.buffer(slot.buffer, 0, slot.buffer.size, { into: slot.bytes.buffer }),
      gpu.readback.buffer(slot.rec, 0, slot.rec.size), flying ? gpu.readback.buffer(slot.fly, 0, slot.fly.size) : null];
    return Promise.all(reads).then(([, rec, fly]) => {
      const nr = Math.min(new Uint32Array(rec, 0, 1)[0], MAX_NATIVE_RECORDS), np = fly ? Math.min(new Uint32Array(fly, 0, 1)[0], MAX_NATIVE_PARTICLES) : 0;
      return { bytes: slot.bytes, dims, meta, release,
        native: { records: words(rec, nr * NATIVE_RECORD_WORDS), particles: fly ? words(fly, np * NATIVE_PARTICLE_WORDS) : new Uint32Array(0) } };
    }, (err) => { release(); throw err; });
  }
  return {
    /** Whether this host's frames are native (FRAME_NATIVE_*): its box's V2 owner presents it. */
    native: (sim) => !!presenting(sim),
    // Starts a capture of the sim's current state; resolves to { bytes, dims, release, native? }
    // (call release() once done with bytes). Returns null while all slots are busy.
    // bytes may be transferred to a worker: pass what comes back to release(back)
    // and the slot reads into it next time. The copy is recorded at this call
    // (docs/webgpu.md B7); only the first capture on a grid, while its kernel
    // builds, is taken once it is built. native (a V2 host's): { records, particles }
    // (Uint32Arrays: nativeSection's).
    pack(sim, metadata) {
      if (!sameGrid(g, sim.g) || gpu !== sim.gpu || presenting(sim) !== owner) reset(sim);
      const slot = free.pop();
      if (!slot) return null;
      if (kernel?.state === 'ready' && (!flyKernel || flyKernel.state === 'ready')) return capture(sim, slot, metadata);
      const gen = generation;
      return ready.then(() => {
        if (gen !== generation || sim.disposed || presenting(sim) !== owner) { [slot.buffer, slot.rec, slot.fly].forEach((b) => b?.destroy()); throw new Error('codec: the grid changed while the pack kernel built'); }
        return capture(sim, slot, metadata);
      });
    },
  };
}

// Guest side: upload packed bytes and expand them into the sim's state (its
// current copy, fresh flags, a whole-grid write: sim.noteWrite). Returns a
// promise of the write being recorded: at once, or, while the kernel for a
// new grid builds, once it is (later unpacks wait behind it, in order).
// Under V2 (the box's owner presents it: app.js v2Replica) the texels are the
// owner's native cells instead (unpackNativeFrag), the native section's exact
// cells written over them and its flying matter put in the owner's pool, where
// the guest's own particle renderer draws it (wire/rays.js) and, once the
// session ends, the guest's own physics runs it on.
export function createUnpacker() {
  let g = null, gpu = null, kernel = null, buffer = null, group = null, pending = Promise.resolve();
  let nat = null;   // the native path's kernels and buffers, for one owner
  const write = (sim) => {
    sim.compact?.suspend(); // render-only guest ownership; never simulate projected packets
    kernel.dispatch(gpu.frame, fold(Math.ceil(g.slots / 64)), { bind: [sim.tables, sim.bindRW, group], header: sim.header() });
    sim.noteWrite();
    sim.stillFlow();   // no velocity is sent, so a guest's grains are textured in place
  };
  function legacy(sim) {
    if (!sameGrid(g, sim.g) || gpu !== sim.gpu) {
      buffer?.destroy();
      g = sim.g;
      gpu = sim.gpu;
      const layout = gpu.layout('UNPACK', UNPACK_LAYOUT);
      kernel = gpu.kernel({ name: 'unpack', code: unpackFrag(g), layouts: [sim.L.TABLES, sim.L.STATE_RW, layout] });
      buffer = gpu.createBuffer({ label: 'unpack', size: g.width * g.height * TEXEL_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      group = gpu.bindGroup(layout, [{ binding: 0, resource: { buffer } }], 'unpack');
    }
  }
  function native(sim, owner) {
    if (nat?.owner === owner) return nat;
    nat?.dispose();
    const og = owner.g, ogpu = owner.gpu, n = { owner, g: og, gpu: ogpu, unpack: null, records: null };
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    n.texels = ogpu.createBuffer({ label: 'unpack native', size: og.width * og.height * TEXEL_BYTES, usage });
    n.rec = ogpu.createBuffer({ label: 'unpack native records', size: MAX_NATIVE_RECORDS * NATIVE_RECORD_WORDS * 4, usage });
    const b = (binding, buf) => ({ binding, resource: { buffer: buf } });
    const cellsLayout = ogpu.layout('UNPACK_NATIVE_CELLS', NATIVE_CELLS_LAYOUT), readLayout = ogpu.layout('UNPACK_NATIVE_READ', RECORDS_LAYOUT);
    n.cells = ogpu.bindGroup(cellsLayout, [b(0, owner.cells), b(1, owner.aux)], 'unpack native cells');
    n.texGroup = ogpu.bindGroup(readLayout, [b(0, n.texels)], 'unpack native texels');
    n.recGroup = ogpu.bindGroup(readLayout, [b(0, n.rec)], 'unpack native records');
    n.ready = nativeCodecParts().then((v2) => {
      n.v2 = v2;
      n.unpack = ogpu.kernel({ name: 'unpackNative', code: unpackNativeFrag(og, { helpers: v2.helpers, importA: v2.importA(og) }), layouts: [sim.L.TABLES, cellsLayout, readLayout] });
      n.records = ogpu.kernel({ name: 'nativeRecords', code: nativeRecordsFrag(og), layouts: [sim.L.TABLES, cellsLayout, readLayout], params: NativeRecordParams });
      return Promise.all([n.unpack.ready, n.records.ready]);
    });
    n.dispose = () => { n.texels.destroy(); n.rec.destroy(); };
    return nat = n;
  }
  return {
    // native: a V2 host's frame's section ({ records, particles }: decodeFrame), or null
    unpack(sim, bytes, { valid = () => true, commit = () => {}, native: section = null } = {}) {
      const owner = presenting(sim);
      if (owner) {
        const n = native(sim, owner);
        const apply = () => {
          if (nat !== n || sim.disposed || n.gpu.failure || !valid() || presenting(sim) !== owner) return false;
          const source = sim.worldRenderSource;
          if (source?.needsLiveCopy()) source.recordLiveCopy(n.gpu.frame);
          n.gpu.write(n.texels, 0, bytes.subarray(0, n.texels.size));
          commit(); // origin and cells share the same GPU recording
          writeNative(sim, n, section);
          sim.worldRenderSource?.recordLiveCopy(n.gpu.frame);
          return true;
        };
        pending = pending.then(() => n.ready).then(apply);
        return pending;
      }
      legacy(sim);
      const k = kernel, b = buffer;
      const apply = () => {
        if (k !== kernel || sim.disposed || gpu.failure || !valid()) return false;
        const source = sim.worldRenderSource;
        // Preserve the old origin/current copy before the replica moves or
        // overwrites it. A previously claimed native version needs no recopy.
        if (source?.needsLiveCopy()) source.recordLiveCopy(gpu.frame);
        gpu.write(b, 0, bytes.subarray(0, b.size));
        commit(); // origin and cells share the same GPU recording
        write(sim);
        // The claim follows both unpack and the flow/wake reset. Old owned
        // cuts stay immutable; the next cut sees this complete replica input.
        sim.worldRenderSource?.recordLiveCopy(gpu.frame);
        return true;
      };
      pending = pending.then(() => k.ready).then(apply);
      return pending;
    },
  };
}

// The native write of a guest's frame (createUnpacker): the texels' cores, the exact records over them,
// the flying matter into the pool, then the owner told its cells were replaced as a restore tells it
// (PhysicsV2.restore): its transient buffers cleared, every brick awake for the first tick that runs
// them, its legacy projection stale, nothing of V1's to import. The renderer redraws the whole grid.
function writeNative(sim, n, section) {
  const { owner, gpu, g } = n, perSlot = fold(Math.ceil(g.slots / 64));
  n.unpack.dispatch(gpu.frame, perSlot, { bind: [sim.tables, n.cells, n.texGroup], header: sim.header() });
  const records = section?.records, count = records ? Math.min(records.length / NATIVE_RECORD_WORDS, MAX_NATIVE_RECORDS) : 0;
  if (count) {
    gpu.write(n.rec, 0, records.subarray(0, count * NATIVE_RECORD_WORDS));
    n.records.dispatch(gpu.frame, fold(Math.ceil(count / 64)), { bind: [sim.tables, n.cells, n.recGroup], header: sim.header(), params: { count } });
  }
  writeFlying(owner, section?.particles ?? null, n.v2);
  const ones = new Uint32Array(g.nbricks).fill(1), L = owner.layout;
  gpu.frame.clear(owner.liquidScratch);
  gpu.frame.clear(owner.jetMask);
  gpu.frame.clear(owner.events);
  const m = marksLayout(g);
  gpu.frame.clear(sim.marks, m.owned * 4, Math.ceil(g.slots / 32) * 4);
  gpu.write(owner.act, L.busy0 * 4, ones);
  gpu.write(owner.act, L.busy1 * 4, ones);
  gpu.write(owner.act, L.legacy * 4, new Uint32Array(g.nbricks).fill(n.v2.LEGACY_STALE));
  owner.noteAllCells();
  sim.noteWrite({ replaceState: false });   // the renderer's whole-grid redraw (no V1 state to import)
  owner.importFull = owner.importMarked = false;
  owner.seenVersion = sim.version;
  owner.seenWhole = sim.wholeWrites;
  owner.legacyPending = owner.writtenSinceTick = true;
  owner.wake();
  if (sim.flow) gpu.frame.clear(sim.flow);   // nothing is moving on a replica (sim.stillFlow; V2's foam is in the cores)
}

// A frame's flying matter into the replica's pool, each record at its host slot (so a session's end runs
// them on as the host would), with the live count the pool's sweeps and the renderer read
// (NativeDynamics.restoreDynamicState's). A record that isn't valid material is left out.
function writeFlying(owner, list, v2) {
  const d = owner.dynamics;
  if (!d?.isReady || d.disposed) return;
  const count = list ? list.length / NATIVE_PARTICLE_WORDS : 0;
  // (nothing flew last frame either: the pool is already the replica's, and empty; the first frame clears
  // whatever the guest's own physics left in it)
  if (!count && d.replicaFlying === false) { d.isIdle = true; return; }
  const cap = d.renderState.capacity, pool = new Uint32Array(cap * PARTICLE_RECORD_WORDS);
  let live = 0;
  for (let k = 0; k < count; k++) {
    const o = k * NATIVE_PARTICLE_WORDS, slot = list[o], rec = list.subarray(o + 1, o + 1 + PARTICLE_RECORD_WORDS);
    if (slot >= cap || pool[slot * PARTICLE_RECORD_WORDS + PARTICLE_ID_WORD] || !v2.validFlying(rec)) continue;
    pool.set(rec, slot * PARTICLE_RECORD_WORDS);
    live++;
  }
  const gpu = owner.gpu;
  gpu.write(d.particles, 0, pool);
  gpu.write(d.control, 0, new Uint32Array([live]));
  gpu.frame.clear(d.flight);
  d.replicaFlying = live > 0;
  // (wire/rays.js busy: a replica's loop rests while nothing flies; its first tick reads its own)
  d.isIdle = live === 0;
}

// ---- frames: [kind, seq, nx, ny, nz] as uint32, then the deflated body ----
export const FRAME_KEY = 1;   // body is the packed state
export const FRAME_DELTA = 2; // body is packed XOR the previous frame
// A V2 host's: FRAME_KEY's or FRAME_DELTA's body, then its native section (whole each frame: not a delta).
// A build that knows neither fails cleanly (multiplayer.js: the handshake keeps old builds away from them).
export const FRAME_NATIVE_KEY = 3;
export const FRAME_NATIVE_DELTA = 4;
export const KEY_FRAMES = [FRAME_KEY, FRAME_NATIVE_KEY];
export const DELTA_FRAMES = [FRAME_DELTA, FRAME_NATIVE_DELTA];
// The sequence number no stream sends (they count from 1): the frame a host sends a build too old for its
// stream. That build reads a box no map has (setGrid refuses it) and leaves with "this version cannot
// load" instead of asking for keyframes it can't decode forever; builds that know it ignore it.
export const OUTDATED_SEQ = 0;
const OUTDATED_DIMS = [16, 16, 16];   // the smallest grid a frame may carry (decodeFrame); no map's (app.js SIZES)
// The native section: [version, records, particles] as uint32, then the records (NATIVE_RECORD_WORDS
// each), then the flying matter (NATIVE_PARTICLE_WORDS each).
const SECTION_VERSION = 1;
const SECTION_HEAD_WORDS = 3;
const SECTION_MAX_BYTES = (SECTION_HEAD_WORDS + MAX_NATIVE_RECORDS * NATIVE_RECORD_WORDS + MAX_NATIVE_PARTICLES * NATIVE_PARTICLE_WORDS) * 4;
/** A frame from a newer build than this one (multiplayer.js: "update your game"). */
export class NewerFrameError extends Error {
  constructor(what) { super(`codec: ${what} from a newer version`); this.newer = true; }
}
/** The section's bytes for { records, particles } (Uint32Arrays). */
export function nativeSection({ records, particles }) {
  const nr = records.length / NATIVE_RECORD_WORDS, np = particles.length / NATIVE_PARTICLE_WORDS;
  if (!Number.isInteger(nr) || !Number.isInteger(np) || nr > MAX_NATIVE_RECORDS || np > MAX_NATIVE_PARTICLES) throw new Error('codec: native section size');
  const out = new Uint32Array(SECTION_HEAD_WORDS + records.length + particles.length);
  out.set([SECTION_VERSION, nr, np]);
  out.set(records, SECTION_HEAD_WORDS);
  out.set(particles, SECTION_HEAD_WORDS + records.length);
  return new Uint8Array(out.buffer);
}
/** True when two sections hold the same words (a host skips a frame that changed nothing). */
export function sameSection(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length / 4), y = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
function readSection(bytes, slots) {
  if (bytes.length < SECTION_HEAD_WORDS * 4 || bytes.length % 4) throw new Error('codec: native section length');
  const w = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  if (w[0] !== SECTION_VERSION) throw new NewerFrameError(`native section ${w[0]}`);
  const nr = w[1], np = w[2];
  if (nr > MAX_NATIVE_RECORDS || np > MAX_NATIVE_PARTICLES || w.length !== SECTION_HEAD_WORDS + nr * NATIVE_RECORD_WORDS + np * NATIVE_PARTICLE_WORDS) throw new Error('codec: native section size');
  const records = w.slice(SECTION_HEAD_WORDS, SECTION_HEAD_WORDS + nr * NATIVE_RECORD_WORDS);
  const particles = w.slice(SECTION_HEAD_WORDS + nr * NATIVE_RECORD_WORDS);
  for (let i = 0; i < nr; i++) if (records[i * NATIVE_RECORD_WORDS] >= slots) throw new Error('codec: native record outside the grid');
  for (let i = 0; i < np; i++) if (particles[i * NATIVE_PARTICLE_WORDS] >= POOL_SLOTS_MAX) throw new Error('codec: flying matter outside the pool');
  return { records, particles };
}
/** The frame a host sends a build too old for its stream (OUTDATED_SEQ). */
export async function outdatedFrame() {
  const at = atlasDims({ nx: OUTDATED_DIMS[0], ny: OUTDATED_DIMS[1], nz: OUTDATED_DIMS[2] });
  return encodeFrame(FRAME_KEY, OUTDATED_SEQ, OUTDATED_DIMS, new Uint8Array(at.width * at.height * TEXEL_BYTES));
}
const HEADER_WORDS = 5;
const HEADER_BYTES = HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT;
const COMPRESSION = 'deflate-raw';
const MAGIC = 0x54505457;

const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

// section: a native kind's (nativeSection), after the body
export async function encodeFrame(kind, seq, dims, body, meta = null, section = null) {
  if (section) { const joined = new Uint8Array(body.length + section.length); joined.set(body); joined.set(section, body.length); body = joined; }
  const packed = await pipe(body, new CompressionStream(COMPRESSION));
  const json = meta ? new TextEncoder().encode(JSON.stringify(meta)) : null;
  const offset = json ? 32 + json.length : HEADER_BYTES;
  const out = new Uint8Array(offset + packed.length);
  if (json) {
    if (!validMetadata(meta) || json.length > 2048) throw new Error('codec: invalid metadata');
    new Uint32Array(out.buffer, 0, 8).set([MAGIC, kind, seq, ...dims, json.length, body.length]);
    out.set(json, 32);
  } else new Uint32Array(out.buffer, 0, HEADER_WORDS).set([kind, seq, ...dims]);
  out.set(packed, offset);
  return out.buffer;
}

export async function decodeFrame(buf) {
  if (buf.byteLength < HEADER_BYTES) throw new Error('codec: short frame');
  let [kind, seq, ...dims] = new Uint32Array(buf, 0, HEADER_WORDS), meta = null, offset = HEADER_BYTES, length;
  if (kind === MAGIC) {
    if (buf.byteLength < 32) throw new Error('codec: short envelope');
    const h = new Uint32Array(buf, 0, 8);
    kind = h[1]; seq = h[2]; dims = [...h.slice(3, 6)]; length = h[7]; offset = 32 + h[6];
    if (h[6] > 2048 || offset >= buf.byteLength) throw new Error('codec: metadata length');
    meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 32, h[6])));
    if (!validMetadata(meta)) throw new Error('codec: metadata');
  }
  if (kind > FRAME_NATIVE_DELTA && kind < 256) throw new NewerFrameError(`frame kind ${kind}`);
  if (![...KEY_FRAMES, ...DELTA_FRAMES].includes(kind) || dims.some((n) => !n || n % 16 || n > 512) || dims.reduce((a, b) => a * b, 1) > 16 * 1024 * 1024) throw new Error('codec: dimensions/kind');
  const native = kind === FRAME_NATIVE_KEY || kind === FRAME_NATIVE_DELTA;
  if (meta && (dims.some((n, i) => n > meta.size[i] || meta.origin[i] < 0 || meta.origin[i] + n > meta.size[i])
    || (meta.mode === 'world' && dims[1] !== meta.size[1])
    || (meta.mode === 'box' && (meta.origin.some((n) => n !== 0) || dims.some((n, i) => n !== meta.size[i]))))) throw new Error('codec: window outside world');
  const at = atlasDims({ nx: dims[0], ny: dims[1], nz: dims[2] });
  const expected = at.width * at.height * TEXEL_BYTES, most = expected + (native ? SECTION_MAX_BYTES : 0);
  if (length !== undefined && (native ? length < expected + SECTION_HEAD_WORDS * 4 || length > most : length !== expected)) throw new Error('codec: body length');
  const reader = new Blob([new Uint8Array(buf, offset)]).stream().pipeThrough(new DecompressionStream(COMPRESSION)).getReader();
  const whole = new Uint8Array(length ?? most); let used = 0;
  try { for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    if (used + value.length > whole.length) throw new Error('codec: oversized body');
    whole.set(value, used); used += value.length;
  } } finally { await reader.cancel(); }
  if (native ? used < expected + SECTION_HEAD_WORDS * 4 : used !== expected) throw new Error('codec: short body');
  const body = native ? whole.slice(0, expected) : whole;
  const section = native ? readSection(whole.subarray(expected, used), dims.reduce((a, b) => a * b, 1)) : null;
  return { kind, seq, dims, body, meta, native: section };
}

// out = a XOR b (word-wise); returns whether anything differs.
export function xorInto(out, a, b) {
  const words = (u8) => new Uint32Array(u8.buffer, u8.byteOffset, u8.length / Uint32Array.BYTES_PER_ELEMENT);
  const o = words(out), x = words(a), y = words(b);
  let diff = 0;
  for (let i = 0; i < o.length; i++) diff |= (o[i] = x[i] ^ y[i]);
  return diff !== 0;
}
