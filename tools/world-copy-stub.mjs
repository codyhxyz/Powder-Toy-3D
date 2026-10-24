// A synthetic world copy for the physics region's checks until W's lands (docs/seamless-world.md, group 1):
// its WGSL (wcCell over a brick table and a pool of src/shaders/world/cellWord.js words, the contract's
// bindings 0-4) and, in a page, a GPU copy of a whole world whose bricks are each one uniform word.
// tools/world-move-cpu-check.mjs validates the fill against the WGSL; tools/world-move-browser-check.mjs
// times moves filled from the GPU copy.
export const STUB_COPY_WGSL = /* wgsl */ `
struct WorldCopyU { size: vec3i, pad0: i32, bricks: vec3i, pad1: i32 }
@group(1) @binding(0) var<uniform> WC: WorldCopyU;
@group(1) @binding(1) var<storage, read> wcTable: array<u32>;
@group(1) @binding(2) var<storage, read> wcPool: array<u32>;
@group(1) @binding(3) var<storage, read> wcInfoWords: array<u32>;
@group(1) @binding(4) var<storage, read> wcOcc: array<u32>;
fn wcCell(c: vec3i) -> u32 {
  if (any(c < vec3i(0)) || any(c >= WC.size)) { return 0u; }
  let b = c >> vec3u(2u);
  let e = wcTable[u32(b.x + WC.bricks.x * (b.y + WC.bricks.y * b.z))];
  if ((e & WC_MIXED) == 0u) { return e; }
  return wcPool[(e & ~WC_MIXED) * WC_BRICK_CELLS + wcLocal(c & vec3i(3))];
}`;

/**
 * In a page: a world copy of `size` cells on the app's GPU (src/gpu/device.js), brick (x, y, z) holding
 * the uniform word wordAt(x, y, z). Returns { layout, bindGroup } (W's WorldCopy's fields the fill binds).
 */
export function syntheticWorldCopy(gpu, size, wordAt) {
  const bricks = size.map((n) => n / 4), n = bricks[0] * bricks[1] * bricks[2];
  const table = new Uint32Array(n);
  for (let z = 0, i = 0; z < bricks[2]; z++) for (let y = 0; y < bricks[1]; y++) for (let x = 0; x < bricks[0]; x++, i++) table[i] = wordAt(x, y, z);
  const U = new Int32Array([...size, 0, ...bricks, 0]);
  const buf = (label, data, usage) => { const b = gpu.createBuffer({ label, size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST }); gpu.write(b, 0, data); return b; };
  const S = GPUBufferUsage.STORAGE;
  const res = [buf('wc uniform', U, GPUBufferUsage.UNIFORM), buf('wc table', table, S), buf('wc pool', new Uint32Array(64), S), buf('wc info', new Uint32Array(4), S), buf('wc occ', new Uint32Array(4), S)];
  const layout = gpu.layout('synthetic world copy', res.map((_, binding) => ({ binding, buffer: { type: binding ? 'read-only-storage' : 'uniform' } })));
  const bindGroup = gpu.bindGroup(layout, res.map((buffer, binding) => ({ binding, resource: { buffer } })), 'synthetic world copy');
  return { layout, bindGroup, buffers: res, dispose() { for (const b of res) b.destroy(); } };
}
