// Protocol contract: these quantized packets are render projections, NOT
// authoritative native snapshots. Guests never simulate them. Native hosts
// pack directly from compact readers; edits return to the host as intents.
import { prelude, STATE_OPTS, LAYOUT, STAGE, BRICK, TILE, SUPER, SUPER_TEX, atlasDims } from '../shaders/common.js';
import { fold } from '../gpu/kernels.js';
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

// Host side: pack the current state on the GPU and read it back without
// stalling. (Its argument, the WebGL build's renderer, is unused: each
// simulation brings its own gpu.)
export function createPacker() {
  let g = null, gpu = null, kernel = null, layout = null, free = [], generation = 0;
  function reset(sim) {
    free.forEach((s) => s.buffer.destroy());
    g = sim.g;
    gpu = sim.gpu;
    generation++;
    layout = gpu.layout('PACK', PACK_LAYOUT);
    kernel = gpu.kernel({ name: 'pack', code: packFrag(g), layouts: [sim.L.TABLES, sim.L.STATE_RO, layout] });
    const bytes = g.width * g.height * TEXEL_BYTES;
    free = Array.from({ length: PACK_SLOTS }, () => {
      const buffer = gpu.createBuffer({ label: 'pack', size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      return { buffer, group: gpu.bindGroup(layout, [{ binding: 0, resource: { buffer } }], 'pack'), bytes: new Uint8Array(bytes) };
    });
  }
  // records the pack of sim's current copy into a slot and its readback
  function capture(sim, slot, metadata) {
    const gen = generation, dims = [g.nx, g.ny, g.nz];
    const meta = metadata?.(); // at dispatch, including first-pack compilation delay
    const release = (back) => {
      if (back) slot.bytes = back;
      if (gen === generation) free.push(slot); else slot.buffer.destroy();
    };
    kernel.dispatch(gpu.frame, fold(Math.ceil(g.slots / 64)), { bind: [sim.tables, sim.bindRO, slot.group], header: sim.readHeader() });
    return gpu.readback.buffer(slot.buffer, 0, slot.buffer.size, { into: slot.bytes.buffer })
      .then(() => ({ bytes: slot.bytes, dims, meta, release }), (err) => { release(); throw err; });
  }
  return {
    // Starts a capture of the sim's current state; resolves to { bytes, dims, release }
    // (call release() once done with bytes). Returns null while all slots are busy.
    // bytes may be transferred to a worker: pass what comes back to release(back)
    // and the slot reads into it next time. The copy is recorded at this call
    // (docs/webgpu.md B7); only the first capture on a grid, while its kernel
    // builds, is taken once it is built.
    pack(sim, metadata) {
      if (!sameGrid(g, sim.g) || gpu !== sim.gpu) reset(sim);
      const slot = free.pop();
      if (!slot) return null;
      if (kernel.state === 'ready') return capture(sim, slot, metadata);
      const gen = generation;
      return kernel.ready.then(() => {
        if (gen !== generation || sim.disposed) { slot.buffer.destroy(); throw new Error('codec: the grid changed while the pack kernel built'); }
        return capture(sim, slot, metadata);
      });
    },
  };
}

// Guest side: upload packed bytes and expand them into the sim's state (its
// current copy, fresh flags, a whole-grid write: sim.noteWrite). Returns a
// promise of the write being recorded: at once, or, while the kernel for a
// new grid builds, once it is (later unpacks wait behind it, in order).
export function createUnpacker() {
  let g = null, gpu = null, kernel = null, buffer = null, group = null, pending = Promise.resolve();
  const write = (sim) => {
    sim.compact?.suspend(); // render-only guest ownership; never simulate projected packets
    kernel.dispatch(gpu.frame, fold(Math.ceil(g.slots / 64)), { bind: [sim.tables, sim.bindRW, group], header: sim.header() });
    sim.noteWrite();
    sim.stillFlow();   // no velocity is sent, so a guest's grains are textured in place
  };
  return {
    unpack(sim, bytes, { valid = () => true, commit = () => {} } = {}) {
      if (!sameGrid(g, sim.g) || gpu !== sim.gpu) {
        buffer?.destroy();
        g = sim.g;
        gpu = sim.gpu;
        const layout = gpu.layout('UNPACK', UNPACK_LAYOUT);
        kernel = gpu.kernel({ name: 'unpack', code: unpackFrag(g), layouts: [sim.L.TABLES, sim.L.STATE_RW, layout] });
        buffer = gpu.createBuffer({ label: 'unpack', size: g.width * g.height * TEXEL_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        group = gpu.bindGroup(layout, [{ binding: 0, resource: { buffer } }], 'unpack');
      }
      const k = kernel, b = buffer;
      const apply = () => {
        if (k !== kernel || sim.disposed || gpu.failure || !valid()) return false;
        gpu.write(b, 0, bytes.subarray(0, b.size));
        commit(); // origin and cells share the same GPU recording
        write(sim);
        return true;
      };
      pending = pending.then(() => k.ready).then(apply);
      return pending;
    },
  };
}

// ---- frames: [kind, seq, nx, ny, nz] as uint32, then the deflated body ----
export const FRAME_KEY = 1;   // body is the packed state
export const FRAME_DELTA = 2; // body is packed XOR the previous frame
const HEADER_WORDS = 5;
const HEADER_BYTES = HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT;
const COMPRESSION = 'deflate-raw';
const MAGIC = 0x54505457;

const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

export async function encodeFrame(kind, seq, dims, body, meta = null) {
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
  if (![FRAME_KEY, FRAME_DELTA].includes(kind) || dims.some((n) => !n || n % 16 || n > 512) || dims.reduce((a, b) => a * b, 1) > 16 * 1024 * 1024) throw new Error('codec: dimensions/kind');
  if (meta && (dims.some((n, i) => n > meta.size[i] || meta.origin[i] < 0 || meta.origin[i] + n > meta.size[i])
    || (meta.mode === 'world' && dims[1] !== meta.size[1])
    || (meta.mode === 'box' && (meta.origin.some((n) => n !== 0) || dims.some((n, i) => n !== meta.size[i]))))) throw new Error('codec: window outside world');
  const at = atlasDims({ nx: dims[0], ny: dims[1], nz: dims[2] });
  const expected = at.width * at.height * TEXEL_BYTES;
  if (length !== undefined && length !== expected) throw new Error('codec: body length');
  const reader = new Blob([new Uint8Array(buf, offset)]).stream().pipeThrough(new DecompressionStream(COMPRESSION)).getReader();
  const body = new Uint8Array(expected); let used = 0;
  try { for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    if (used + value.length > expected) throw new Error('codec: oversized body');
    body.set(value, used); used += value.length;
  } } finally { await reader.cancel(); }
  if (used !== expected) throw new Error('codec: short body');
  return { kind, seq, dims, body, meta };
}

// out = a XOR b (word-wise); returns whether anything differs.
export function xorInto(out, a, b) {
  const words = (u8) => new Uint32Array(u8.buffer, u8.byteOffset, u8.length / Uint32Array.BYTES_PER_ELEMENT);
  const o = words(out), x = words(a), y = words(b);
  let diff = 0;
  for (let i = 0; i < o.length; i++) diff |= (o[i] = x[i] ^ y[i]);
  return diff !== 0;
}
