// WGSL structs that JS fills: one field list gives both the WGSL declaration
// and the byte layout JS packs into a buffer, so the two can't drift
// (docs/webgpu.md B4, C6). The element tables (shaders/common.js tablesWGSL),
// the sim header and FrameUniforms (shaders/bindings.js) are built with it.
// No imports: elements.js, materials.js and electricity.js describe their
// table fields with it, and common.js imports all of them.
//
// Layout is WGSL's own ("Memory Layout" in the WGSL spec), for the storage or
// the uniform address space:
//   AlignOf  scalar 4, vec2 8, vec3 and vec4 16, mat4x4f 16; an array its
//            element's; a struct its largest member's. In uniform space arrays
//            and structs round their alignment up to 16.
//   SizeOf   scalar 4, vec2 8, vec3 12, vec4 16, mat4x4f 64; an array N times
//            its stride (the element's size rounded up to its alignment); a
//            struct its last member's end rounded up to its alignment.
// So a vec3 leaves a 4-byte hole that the next scalar fills: field order is
// the packing, and the lists put each vec3 before a scalar.

const VECS = { 2: 8, 3: 16, 4: 16 };
const COMPONENT = { f: 'f32', i: 'i32', u: 'u32' };
const roundUp = (k, n) => Math.ceil(n / k) * k;

// A field: [name, type] or { name, type, count, countWGSL }. type is a scalar
// (f32, i32, u32), a vector (vec2f … vec4u), mat4x4f, 'array<T, N>' or the
// name of a struct made earlier and passed in `structs`. count makes the
// field an array of type (countWGSL: how the WGSL spells N, e.g. 'NE').
function fieldOf(f) {
  if (Array.isArray(f)) return { name: f[0], type: f[1] };
  return f;
}

function typeInfo(type, space, structs) {
  if (type === 'f32' || type === 'i32' || type === 'u32') return { align: 4, size: 4, comps: 1, scalar: type };
  let m = /^vec([234])([fiu])$/.exec(type);
  if (m) return { align: VECS[m[1]], size: 4 * m[1], comps: +m[1], scalar: COMPONENT[m[2]] };
  if (type === 'mat4x4f') return { align: 16, size: 64, comps: 16, scalar: 'f32' };
  m = /^array<\s*(\w+)\s*,\s*(\d+)\s*>$/.exec(type);
  if (m) return arrayInfo(m[1], +m[2], space, structs);
  const s = structs?.[type];
  if (s) {
    if (space === 'uniform' && s.space !== 'uniform') throw new Error(`${type}: a storage struct can't sit in a uniform one`);
    return { align: s.align, size: s.size, struct: s };
  }
  throw new Error(`hostStruct: unknown type ${type}`);
}

function arrayInfo(elemType, count, space, structs) {
  const e = typeInfo(elemType, space, structs);
  const align = space === 'uniform' ? roundUp(16, e.align) : e.align;
  const stride = roundUp(e.align, e.size);
  if (space === 'uniform' && stride % 16) throw new Error(`array<${elemType}>: a uniform array's stride must be a multiple of 16`);
  return { align, size: stride * count, elem: e, elemType, count, stride };
}

/**
 * A host-shareable WGSL struct.
 *   name    the WGSL struct name
 *   fields  [[name, type], …] or { name: type, … } (in order), or field objects
 *   space   'storage' (default) or 'uniform'
 *   structs struct types the fields may name ({ Name: hostStruct(...) })
 * Returns { name, space, wgsl, size, align, fields: [{ name, type, offset, ... }], write(view, base, values) }.
 * write puts values ({ field: number | bool | array | nested values }) into a
 * DataView at byte offset base, little-endian; a bool is the u32 1 or 0.
 */
export function hostStruct(name, fields, { space = 'storage', structs = {} } = {}) {
  const list = Array.isArray(fields) ? fields.map(fieldOf) : Object.entries(fields).map(([n, t]) => ({ name: n, type: t }));
  let offset = 0, align = 0, minNext = 0;
  const out = list.map((f) => {
    const info = f.count != null ? arrayInfo(f.type, f.count, space, structs) : typeInfo(f.type, space, structs);
    const at = roundUp(info.align, Math.max(offset, minNext));
    offset = at + info.size;
    // uniform space: the member after a struct starts at least roundUp(16, its size) past it
    minNext = space === 'uniform' && info.struct ? at + roundUp(16, info.size) : 0;
    align = Math.max(align, info.align);
    const wgslType = f.count != null ? `array<${f.type}, ${f.countWGSL ?? f.count}>` : f.type;
    return { ...f, ...info, offset: at, wgslType };
  });
  if (space === 'uniform') align = roundUp(16, align);
  const size = roundUp(align, Math.max(offset, minNext));
  const wgsl = `struct ${name} {\n${out.map((f) => `  ${f.name}: ${f.wgslType},`).join('\n')}\n}`;
  const s = { name, space, wgsl, size, align, fields: out };
  s.write = (view, base, values) => writeStruct(view, base, s, values);
  s.offsetOf = (field) => {
    const f = out.find((x) => x.name === field);
    if (!f) throw new Error(`${name}: no field ${field}`);
    return f.offset;
  };
  return s;
}

function writeScalar(view, at, scalar, v) {
  const x = typeof v === 'boolean' ? +v : v;
  if (typeof x !== 'number' || Number.isNaN(x) && scalar !== 'f32') throw new Error(`hostStruct: ${v} is not a ${scalar}`);
  if (scalar === 'f32') view.setFloat32(at, x, true);
  else if (scalar === 'i32') view.setInt32(at, x, true);
  else view.setUint32(at, x, true);
}

function writeValue(view, at, info, v) {
  if (info.struct) return writeStruct(view, at, info.struct, v);
  if (info.elem) {
    if (v.length > info.count) throw new Error(`hostStruct: ${v.length} values for an array of ${info.count}`);
    for (let i = 0; i < v.length; i++) writeValue(view, at + i * info.stride, info.elem, v[i]);
    return;
  }
  if (info.comps === 1) return writeScalar(view, at, info.scalar, Array.isArray(v) ? v[0] : v);
  // a vector's components are 4 bytes apart; a matrix's columns 16 (column-major, as three's elements)
  const flat = Array.isArray(v) || ArrayBuffer.isView(v) ? v : v.elements;
  if (!flat || flat.length < info.comps) throw new Error(`hostStruct: want ${info.comps} components, got ${v}`);
  for (let i = 0; i < info.comps; i++) writeScalar(view, at + 4 * i, info.scalar, flat[i]);
}

function writeStruct(view, base, s, values) {
  for (const f of s.fields) {
    const v = values?.[f.name];
    if (v === undefined) continue;   // left as it is (zero in a new buffer)
    writeValue(view, base + f.offset, f, v);
  }
}

// WGSL accessor functions for table fields (docs/webgpu.md C6): the old GLSL
// const array NAME[id] becomes the function NAME(id), reading `path[id].field`.
// A field { name, type, fn, ret }: fn is the accessor's name (none: no
// accessor); ret 'bool' turns the stored u32 into a bool.
export function accessorsWGSL(path, fields, index = 'id') {
  return fields.filter((f) => f.fn).map((f) => (f.ret === 'bool'
    ? `fn ${f.fn}(${index}: i32) -> bool { return ${path}[${index}].${f.name} != 0u; }`
    : `fn ${f.fn}(${index}: i32) -> ${f.type} { return ${path}[${index}].${f.name}; }`)).join('\n');
}

// A JS number as a WGSL float literal: whole numbers get a ".0" so the
// literal is a float (as the GLSL generators printed them), the rest print as
// JS's shortest round trip (String(x)), which an explicitly typed const turns
// into Math.fround(x) (tools/tables-check.mjs reads every one back).
export const wgslFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
