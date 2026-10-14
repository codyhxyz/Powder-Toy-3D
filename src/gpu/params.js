// Per-dispatch values (docs/webgpu.md B4, W9) and the structs that carry them.
//
// uniformStruct() is the only place both sides of a struct are written: one
// field list gives the WGSL text and the JS packer, with WGSL's own layout
// rules (vec3 aligns to 16, `bool` travels as u32, a uniform array's stride is
// a multiple of 16), so the two can't drift. Never hand-write a uniform
// struct twice.
//
// Group 3 of every pipeline of ours is the params group: binding 0 the header
// (Header below: the window origin and which state copies a dispatch reads and
// writes), binding 1 the kernel's own params, both dynamic-offset uniforms in
// one ParamRing. The ring hands out 256-byte slots, packs them in JS and
// uploads the used range with one writeBuffer just before each flush, so every
// command reads the values it was recorded with, however many share an
// encoder. It never grows: the frame flushes before it runs out (frame.js).

/** Bytes per ring slot: the default minUniformBufferOffsetAlignment. */
export const PARAM_SLOT = 256;
/** Dispatches and draws a frame records before it flushes (B3). */
export const FLUSH_DISPATCHES = 2048;
/** The ring: a header and a params slot for every command of a full frame (1 MiB). */
export const RING_BYTES = FLUSH_DISPATCHES * 2 * PARAM_SLOT;

const roundUp = (a, n) => Math.ceil(n / a) * a;

// scalar and vector element types: [WGSL name, bytes, DataView setter]
const SCALARS = {
  f32: ['f32', 'setFloat32'], i32: ['i32', 'setInt32'], u32: ['u32', 'setUint32'],
  bool: ['u32', 'setUint32'],   // bool isn't host-shareable (H1.15): u32 in the buffer
  'atomic<u32>': ['atomic<u32>', 'setUint32'], 'atomic<i32>': ['atomic<i32>', 'setInt32'],
};
const SUFFIX = { f: 'f32', i: 'i32', u: 'u32' };

// A type's layout: { wgsl, align, size, write(view, offset, value) }.
function layoutOf(type, space, where) {
  if (typeof type === 'object' && !Array.isArray(type) && type?.isStruct) {
    const align = space === 'uniform' ? roundUp(16, type.align) : type.align;
    return { wgsl: type.name, align, size: type.size, natural: type.align, write: (v, o, x) => type.pack(x ?? {}, v, o) };
  }
  if (Array.isArray(type)) return arrayLayout(type[0], type[1], space, where);
  let t = String(type).replace(/\s+/g, '');
  const arr = /^array<(.+),(\d+)>$/.exec(t);
  if (arr) return arrayLayout(arr[1], Number(arr[2]), space, where);
  t = t.replace(/^(vec[234]|mat[234]x[234])<(f32|i32|u32)>$/, (_, v, s) => v + s[0]);
  if (SCALARS[t]) {
    const [wgsl, set] = SCALARS[t];
    const bool = t === 'bool';
    return { wgsl, align: 4, size: 4, natural: 4, write: (v, o, x) => v[set](o, bool ? (x ? 1 : 0) : (x ?? 0), true) };
  }
  const vec = /^vec([234])([fiu])$/.exec(t);
  if (vec) {
    const n = Number(vec[1]), [, set] = SCALARS[SUFFIX[vec[2]]];
    const align = n === 2 ? 8 : 16;
    return {
      wgsl: t, align, size: 4 * n, natural: align,
      write: (v, o, x) => { for (let i = 0; i < n; i++) v[set](o + 4 * i, component(x, i, where), true); },
    };
  }
  const mat = /^mat([234])x([234])f$/.exec(t);
  if (mat) {
    const cols = Number(mat[1]), rows = Number(mat[2]);
    const colAlign = rows === 2 ? 8 : 16, stride = roundUp(colAlign, 4 * rows);
    return {
      wgsl: t, align: colAlign, size: cols * stride, natural: colAlign,
      write: (v, o, x) => {
        const e = x?.elements ?? x ?? [];
        if (e.length !== cols * rows) throw new Error(`${where}: ${t} wants ${cols * rows} numbers (column-major), got ${e.length}`);
        for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) v.setFloat32(o + c * stride + 4 * r, e[c * rows + r], true);
      },
    };
  }
  throw new Error(`${where}: unsupported type ${type}`);
}

// WGSL lays an array out by its element's natural alignment in every address
// space (stride = roundUp(AlignOf(E), SizeOf(E))); the uniform rules only check
// it, and no attribute on the array can change the stride. So a uniform array
// whose natural stride isn't a multiple of 16 is refused here, as Tint would.
function arrayLayout(elem, n, space, where) {
  const e = layoutOf(elem, space, where);
  const stride = roundUp(e.natural, e.size);
  if (space === 'uniform' && stride % 16) {
    const fix = typeof elem === 'object' && elem?.isStruct ? `pad ${e.wgsl} to a multiple of 16 bytes` : 'use vec4 elements';
    throw new Error(`${where}: array<${e.wgsl}, ${n}> has a ${stride}-byte stride; a uniform array needs a multiple of 16: ${fix} (H1.15)`);
  }
  const align = space === 'uniform' ? roundUp(16, e.natural) : e.natural;
  return {
    wgsl: `array<${e.wgsl}, ${n}>`, align, size: n * stride, natural: e.natural,
    write: (v, o, x) => { for (let i = 0; i < n; i++) if (x?.[i] !== undefined) e.write(v, o + i * stride, x[i]); },
  };
}

// a vector's i-th component from an array, a typed array, {x, y, z, w} (three's vectors) or {r, g, b, a} (Color)
function component(x, i, where) {
  if (x == null) return 0;
  if (typeof x === 'number') throw new Error(`${where}: a vector field got the number ${x}`);
  const c = x[i] ?? x['xyzw'[i]] ?? x['rgba'[i]];
  return c === true ? 1 : c === false ? 0 : (c ?? 0);
}

/**
 * A WGSL struct and its JS packer from one field list.
 *
 *     const PaintParams = uniformStruct('PaintParams', { center: 'vec3f', radius: 'f32', replace: 'bool' });
 *     PaintParams.wgsl      // "struct PaintParams {\n  center: vec3f,\n  radius: f32,\n  replace: u32,\n}\n"
 *     PaintParams.pack({ center: [1, 2, 3], radius: 4 })   // ArrayBuffer of PaintParams.size bytes
 *
 * Types: f32, i32, u32, bool (stored as u32: read it as `P.replace != 0u`),
 * vec2/3/4 with f, i or u, matCxRf (column-major numbers or a three matrix),
 * 'array<T, N>' or [T, N] (T may be a struct), another struct, and in storage
 * also atomic<u32>/atomic<i32>. Vectors take arrays or {x, y, z, w}. Fields
 * left out pack as zero; a name the struct doesn't have throws.
 * @param {string} name the WGSL struct name
 * @param {Record<string, string | object | [any, number]>} fields in declaration order
 * @param {{ space?: 'uniform' | 'storage' }} [opts] the address-space layout rules to apply
 * @returns {{ isStruct: true, name: string, space: string, size: number, align: number,
 *   fields: { name: string, type: string, offset: number, size: number }[], offsets: Record<string, number>,
 *   wgsl: string, deps: object[], pack: (values: object, target?: DataView | ArrayBuffer, offset?: number) => ArrayBuffer }}
 */
export function uniformStruct(name, fields, { space = 'uniform' } = {}) {
  if (space !== 'uniform' && space !== 'storage') throw new Error(`uniformStruct ${name}: space must be 'uniform' or 'storage'`);
  let end = 0, align = 4;
  const list = [], deps = [], lines = [];
  for (const [field, type] of Object.entries(fields)) {
    const where = `${name}.${field}`;
    const l = layoutOf(type, space, where);
    // uniform: a struct member is followed by at least roundUp(16, its size) bytes
    const size = space === 'uniform' && typeof type === 'object' && type?.isStruct ? roundUp(16, l.size) : l.size;
    const offset = roundUp(l.align, end);
    end = offset + size;
    align = Math.max(align, l.align);
    if (typeof type === 'object' && type?.isStruct) deps.push(type);
    if (Array.isArray(type) && type[0]?.isStruct) deps.push(type[0]);
    // WGSL places members by their natural alignment and only checks the uniform rules: spell out the difference
    const attrs = (l.align > l.natural ? `@align(${l.align}) ` : '') + (size > l.size ? `@size(${size}) ` : '');
    lines.push(`  ${attrs}${field}: ${l.wgsl},`);
    list.push({ name: field, type: l.wgsl, offset, size, write: l.write });
  }
  const size = roundUp(align, Math.max(end, 4));
  const offsets = Object.fromEntries(list.map((f) => [f.name, f.offset]));
  const byName = new Map(list.map((f) => [f.name, f]));
  const struct = {
    isStruct: true, name, space, size, align, deps,
    fields: list.map(({ write, ...f }) => f),
    offsets,
    wgsl: `struct ${name} {\n${lines.join('\n')}\n}\n`,
    pack(values = {}, target, offset = 0) {
      const view = target instanceof DataView ? target : new DataView(target ?? new ArrayBuffer(size));
      for (const key in values) {
        const f = byName.get(key);
        if (!f) throw new Error(`${name} has no field "${key}"`);
        f.write(view, offset + f.offset, values[key]);
      }
      return view.buffer;
    },
  };
  return struct;
}

/**
 * The header every dispatch and draw of ours gets at group 3, binding 0: the
 * world window's origin (D11's uOrigin) and which halves of the state buffers
 * it reads (`src`) and writes (`dst`). Kernels that don't touch the state get
 * gpu.nullHeader.
 */
export const Header = uniformStruct('Header', { origin: 'vec3i', src: 'u32', dst: 'u32', format: 'u32' });

/**
 * WGSL for the header binding, for modules that don't take it from the prelude.
 * @returns {string}
 */
export const headerWGSL = () => `${Header.wgsl}@group(3) @binding(0) var<uniform> H: Header;\n`;

/**
 * The fixed-size dynamic-offset uniform ring behind group 3 (B4). One per
 * device; frame.js allocates from it per command and uploads it per flush.
 */
export class ParamRing {
  /**
   * @param {GPUDevice} device
   * @param {{ bytes?: number, label?: string }} [opts]
   */
  constructor(device, { bytes = RING_BYTES, label = 'params ring' } = {}) {
    this.bytes = bytes;
    this.buffer = device.createBuffer({ label, size: bytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.data = new ArrayBuffer(bytes);
    this.view = new DataView(this.data);
    this.u8 = new Uint8Array(this.data);
    this.used = 0;
    this._header = new Uint32Array(Header.size / 4);
    this._headerScratch = new ArrayBuffer(Header.size);
    this._headerAt = -1;
    this._zeroAt = -1;
  }

  /** Bytes still free before the next upload. */
  get free() { return this.bytes - this.used; }

  /** Ring bytes a struct of `size` bytes takes: whole slots. */
  static slots(size) { return roundUp(PARAM_SLOT, Math.max(size, 16)); }

  /**
   * A zeroed run of whole slots for `size` bytes; its offset, or -1 when full.
   * @param {number} size
   */
  alloc(size) {
    const n = ParamRing.slots(size);
    if (this.used + n > this.bytes) return -1;
    const at = this.used;
    this.u8.fill(0, at, at + n);
    this.used += n;
    return at;
  }

  /**
   * Packs `values` with `struct` into a new slot; returns its offset (-1 when full).
   * No struct: one shared zero slot per upload.
   * @param {object | null} struct a uniformStruct
   * @param {object} [values]
   */
  push(struct, values) {
    if (!struct) {
      if (this._zeroAt < 0) this._zeroAt = this.alloc(PARAM_SLOT);
      return this._zeroAt;
    }
    const at = this.alloc(struct.size);
    if (at >= 0 && values) struct.pack(values, this.view, at);
    return at;
  }

  /**
   * The header's slot: the previous one again when the values are equal
   * (every step of a frame shares sim.header()), else a new slot.
   * @param {{ origin?: number[], src?: number, dst?: number }} values
   */
  header(values) {
    const scratch = this._headerScratch;
    new Uint8Array(scratch).fill(0);
    Header.pack(values, scratch);
    const words = new Uint32Array(scratch);
    if (this._headerAt >= 0 && words.every((w, i) => w === this._header[i])) return this._headerAt;
    const at = this.alloc(Header.size);
    if (at < 0) return at;
    this.u8.set(new Uint8Array(scratch), at);
    this._header.set(words);
    this._headerAt = at;
    return at;
  }

  /**
   * Uploads the used range (one writeBuffer, queued before the flush's
   * submit) and starts over. Returns the bytes uploaded.
   * @param {GPUQueue} queue
   */
  upload(queue) {
    const n = this.used;
    if (n) queue.writeBuffer(this.buffer, 0, this.data, 0, n);
    this.used = 0;
    this._headerAt = -1;
    this._zeroAt = -1;
    return n;
  }
}

/**
 * A uniform buffer several commands of one encoder read, such as
 * FrameUniforms (F6). write() flushes first when the open frame has already
 * recorded a command that reads it (through a bind group made with
 * gpu.bindGroup), so every command sees the value current when it was
 * recorded (B3). Made by gpu.uniforms(struct, label).
 */
export class SharedUniforms {
  /**
   * @param {object} gpu the gpu from createGpu
   * @param {object} struct a uniformStruct
   * @param {string} [label]
   */
  constructor(gpu, struct, label = struct.name) {
    this.gpu = gpu;
    this.struct = struct;
    this.label = label;
    this.buffer = gpu.createBuffer({ label, size: roundUp(16, struct.size), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.data = new ArrayBuffer(this.buffer.size);
    this.values = {};
  }

  /**
   * Packs and uploads `values` (fields left out keep their last value).
   * @param {object} values
   */
  write(values) {
    Object.assign(this.values, values);
    const frame = this.gpu._frame;
    if (frame?.readsUniforms(this) && this.gpu.flush(`${this.label} write`)) this.gpu.stats.writeFlushes++;
    new Uint8Array(this.data).fill(0);
    this.struct.pack(this.values, this.data);
    this.gpu.queue.writeBuffer(this.buffer, 0, this.data);
    this.gpu.stats.bytesUploaded += this.data.byteLength;
  }
}
