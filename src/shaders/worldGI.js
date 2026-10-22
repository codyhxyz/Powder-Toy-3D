// Shared original GI arithmetic against world leafs; no application switch.
import { GiParams, giSourceFrag, giGatherFrag, giGroundLightWGSL } from './gi.js';
import { worldVolumeLayouts } from './worldRenderBackend.js';
import { assertWorldLayout } from '../world/renderAtlas.js';
import { shadowOpticsWGSL } from './gfx/shadowOptics.js';

// WorldGIParams (binding 7): counts and config, the light bounce's near ring
// and the ground twin's shape (world/worldGIRing.js).
export const WORLD_GI_PARAMS_BYTES = 64;
// The ground twin rides in the jobs buffer (binding 8) after the jobs, a
// column's top (cells) to a 16-bit half of a word: the gather already binds
// the stage's 8 storage buffers (renderAtlas.js assertWorldLayout).
export const WORLD_GI_GROUND_BITS = 16;
export const WORLD_GI_GROUND_PER_WORD = 32 / WORLD_GI_GROUND_BITS;
/** The ground twin's column tops (worldCoarseCasters heights), packed as the gather reads them. */
export function worldGIGroundWords(heights) {
  const max = 2 ** WORLD_GI_GROUND_BITS - 1, words = new Uint32Array(Math.ceil(heights.length / WORLD_GI_GROUND_PER_WORD / 4) * 4);
  for (let i = 0; i < heights.length; i++) {
    const h = Math.min(max, Math.max(0, Math.floor(heights[i])));
    words[Math.floor(i / WORLD_GI_GROUND_PER_WORD)] |= h << (WORLD_GI_GROUND_BITS * (i % WORLD_GI_GROUND_PER_WORD));
  }
  return words;
}

export function worldGILayouts({ gather = false, limits } = {}) {
  const groups = worldVolumeLayouts({ limits }).map(g => g.map(e => ({ ...e })));
  const uniform = (binding, size) => ({ binding, visibility: 4, buffer: { type: 'uniform', minBindingSize: size } });
  const storage = (binding, type) => ({ binding, visibility: 4, buffer: { type, minBindingSize: 16 } });
  groups[3].push(uniform(6, GiParams.size), uniform(7, WORLD_GI_PARAMS_BYTES), storage(8, 'read-only-storage'), storage(9, 'storage'));
  if (gather) {
    groups[3].push({ binding: 10, visibility: 4, buffer: { type: 'storage', minBindingSize: 8 } });
  }
  return assertWorldLayout(groups, limits);
}

export const worldGIBirthWGSL = /* wgsl */ `
const WORLD_GI_BIRTH: u32 = 2u;
fn worldGIJobBlend(ordinary: f32, flags: u32) -> f32 {
  return select(ordinary, 1.0, (flags & WORLD_GI_BIRTH) != 0u);
}
`;
function declarations(gather) { return /* wgsl */ `
${shadowOpticsWGSL({ backend: 'world' })}
${GiParams.wgsl}
@group(3) @binding(6) var<uniform> P: GiParams;
struct WorldGIParams { counts: vec4u, config: vec4u, ring: vec4f, ground: vec4u }
// counts: source count, gather count, absolute first job-status word, logical tick.
// config: scene epoch, reserved. Job flags: bit0 background, bit1 ledger-authenticated birth.
// ring: the eye (cells) and the light bounce's near ring radius (cells; < 0:
// no ring, every read near). ground: the ground twin's brick columns x, z,
// and the worldGIJobs entry its packed tops start at (worldGIGroundWords).
// Jobs are source-first, each phase sorted by GLOBAL index.
@group(3) @binding(7) var<uniform> WGI: WorldGIParams;
@group(3) @binding(8) var<storage, read> worldGIJobs: array<vec4u>;
@group(3) @binding(9) var<storage, read_write> worldGISources: array<vec4u>;
${worldGIBirthWGSL}
fn worldGIPreviousProbe(job: u32, bc: vec3i) -> Probe {
  if ((worldGIJobs[job].y & WORLD_GI_BIRTH) != 0u) {
    return Probe(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
  }
  return Probe(worldProbeLoad(tGI0, bc, WORLD_GI), worldProbeLoad(tGI1, bc, WORLD_GI), worldProbeLoad(tGI2, bc, WORLD_GI), worldProbeLoad(tGI3, bc, WORLD_GI));
}
fn worldGIReport(job: u32) {
  atomicOr(&worldRequests[WGI.counts.z + job], select(1u, 3u, worldQueryIncomplete()));
}
${gather ? `@group(3) @binding(10) var<storage, read_write> worldGIHistory: array<vec2u>;
// Private source overlay. Every source dispatch precedes EVERY gather dispatch.
// Nonselected sources come from the immutable published prior source snapshot.
// The overlay's job for book index i, else WGI.counts.x.
fn worldGIStagedJob(index: u32) -> u32 {
  var lo = 0u; var hi = WGI.counts.x;
  loop {
    if (lo >= hi) { break; }
    let mid = lo + (hi - lo) / 2u;
    if (worldGIJobs[mid].x < index) { lo = mid + 1u; } else { hi = mid; }
  }
  return select(WGI.counts.x, lo, lo < WGI.counts.x && worldGIJobs[lo].x == index);
}
// ---- the light bounce's near ring (world/worldGIRing.js) ----
const WORLD_GI_GROUND_BITS: u32 = ${WORLD_GI_GROUND_BITS}u;
const WORLD_GI_GROUND_PER_WORD: u32 = ${WORLD_GI_GROUND_PER_WORD}u;
// worldGIBrickNear: by the brick's centre, so every ray agrees on a brick.
fn worldGIRingNear(b: vec3i) -> bool {
  let d = (vec3f(b) + 0.5) * f32(BS) - WGI.ring.xyz;
  return WGI.ring.w < 0.0 || dot(d, d) <= WGI.ring.w * WGI.ring.w;
}
// The stand-in SOURCE of brick b from the ground twin (worldGIProxyCoverage):
// its rows under the column's top along x and z, its whole face along y,
// giving off the open ground's light that beyond() gives past the world's
// edge, toward the sky when its top face is the ground's surface.
fn worldGIProxy(b: vec3i) -> vec4u {
  let n = max(vec2i(WGI.ground.xy), vec2i(1));   // (no twin: no ring, never read)
  let k = clamp(b.xz, vec2i(0), n - 1);
  let i = u32(k.x) + u32(n.x) * u32(k.y);
  let word = i / WORLD_GI_GROUND_PER_WORD;
  let w = worldGIJobs[WGI.ground.z + word / 4u][word % 4u];
  let top = f32((w >> ((i % WORLD_GI_GROUND_PER_WORD) * WORLD_GI_GROUND_BITS)) & ((1u << WORLD_GI_GROUND_BITS) - 1u));
  let fill = clamp((top - f32(b.y * BS)) / f32(BS), 0.0, 1.0);
  let surface = top <= f32((b.y + 1) * BS);
  return select(giSrcPack(vec3f(0.0), vec3f(0.0), vec3f(0.0)), giSrcPack(${giGroundLightWGSL('1.0')}, vec3f(fill, 1.0, fill), select(vec3f(0.0), vec3f(0.0, 1.0, 0.0), surface)), fill > 0.0);
}
// What a gather reads at brick b: this phase's staged SOURCE; else inside the
// ring the published one, asked for when missing (worldGISource); past the
// ring the one the snapshot already holds, else the ground twin's stand-in,
// asking for nothing and leaving the query complete (as worldProbeHeld).
fn worldGISourceRing(b: vec3i) -> vec4u {
  let index = worldBookIndex(b);
  let job = worldGIStagedJob(index);
  if (job < WGI.counts.x) { return worldGISources[job]; }
  if (worldGIRingNear(b)) { return worldGISource(b); }
  let e = worldLightBook[index]; let id = e & WORLD_BOOK_PAGE;
  let held = id != 0u && id <= WA.light.y && WA.tiles.w == WORLD_ABI
    && (((e >> WORLD_BOOK_READY) << WORLD_BOOK_LIGHT) & WORLD_GI_SOURCE) == WORLD_GI_SOURCE;
  if (held) { return worldLightMeta(id - 1u, 4u); }
  return worldGIProxy(b);
}` : ''}
`; }
export const worldGISource = g => giSourceFrag(g, { backend: 'world', worldWGSL: declarations(false) });
export const worldGIGather = g => giGatherFrag(g, { backend: 'world', worldWGSL: declarations(true) });
export const WGSL_CHECK = () => [128, 384].flatMap(ny => [false, true].flatMap(sourceAppearance => [false, true].map(gather => ({
  name: `worldGI.${gather ? 'gather' : 'source'}.${ny}.${sourceAppearance ? 'imported' : 'native'}`,
  kind: 'compute', grids: false, warm: false,
  code: () => (gather ? worldGIGather : worldGISource)({ nx: 3072, ny, nz: 1024, sourceAppearance, sourceGrid: [384, 16, 128] }),
  layouts: () => worldGILayouts({ gather }), workgroupSize: [64, 1, 1], dispatch: () => [1, 1, 1],
}))));
