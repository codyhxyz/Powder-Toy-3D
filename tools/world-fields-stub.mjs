// A stand-in for W's world copy (docs/seamless-world.md, "W"), for the field checks only: the
// functions F's kernels call (wcCell, wcA, wcOccupied, WC) over a dense buffer of cell words.
// Not the world copy's layout: its brick table and pool are W's (src/shaders/world/copy.js).
import { cellWordWGSL } from '../src/shaders/world/cellWord.js';

export const SEED_HASH = 0x9e3779b9;   // the stand-in's seed: a cell's own hash (W uses seedWorld)
export const worldCopyStubWGSL = /* wgsl */ `
${cellWordWGSL}
struct WorldCopyStub { size: vec4i, bricks: vec4i }
@group(1) @binding(0) var<uniform> WC: WorldCopyStub;
@group(1) @binding(1) var<storage, read> wcStub: array<u32>;   // cell words, x + X (y + Y z)
fn wcCell(c: vec3i) -> u32 {
  if (any(c < vec3i(0)) || any(c >= WC.size.xyz)) { return 0u; }
  return wcStub[u32(c.x + WC.size.x * (c.y + WC.size.y * c.z))];
}
fn wcSeed(c: vec3i) -> f32 { return f32(pcg(u32(c.x) * ${SEED_HASH}u + u32(c.y) * 7919u + u32(c.z)) >> 8u) / 16777216.0; }
fn wcA(c: vec3i) -> vec4f {
  let w = wcCell(c);
  return vec4f(f32(wcId(w)), wcTemp(w), wcAux(w), f32(wcCtype(w)) + wcSeed(c));
}
fn wcOccupied(level: u32, c: vec3i) -> bool {
  let n = 4 << (2u * level);
  let lo = (c / n) * n;
  for (var z = 0; z < n; z++) { for (var y = 0; y < n; y++) { for (var x = 0; x < n; x++) {
    if (wcId(wcCell(lo + vec3i(x, y, z))) != 0) { return true; }
  } } }
  return false;
}`;
