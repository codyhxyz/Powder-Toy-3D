import { PHASE_ROWS } from '../v2/phase.js';
import { lifeScale } from '../v2/layout.js';
import { ELEMENTS } from '../elements.js';
// Shared presentation/legacy projection of the authoritative v2 payload.
// Whole-cell liquid dithering intentionally matches the old bridge. This is
// NOT a lossless save representation: fill, flux and fall state stay in v2.
// compactA's parts, shared with the draw's readers below (compactDrawWGSL) so both decode alike.
const T_OF = 'f32(compactTq(c)) * 0.25 - 273.25';
const SEED_OF = (p) => `f32(seed3(${p}, 0u, 991u) >> 16u) * (SEED_MAX / 65536.0)`;
const DITHER_OF = (p) => `(seed3(${p}, 0u, 4243u) >> 16u)`;
const LIQUID_A = 'vec4f(f32(id), T, select(f32(c.w >> 16u) / COMPACT_LIFE_SCALE[u32(id)], 0.0, COMPACT_CONDUCTS[u32(id)]), select(f32((c.y >> 24u) & COMPACT_CTYPE_MASK[u32(id)]), f32((c.w >> 16u) & 4095u), COMPACT_CONDUCTS[u32(id)]) + seed)';
const MATTER_A = `vec4f(f32(id), T, f32(c.y & 65535u) / COMPACT_LIFE_SCALE[u32(id)],
    select(f32((c.y >> 16u) & 255u), f32(c.w & 4095u), COMPACT_CONDUCTS[u32(id)]) + f32(c.w >> 16u) * (SEED_MAX / 65536.0))`;
// A liquid's fill at or past this is a whole cell (it beats every 16-bit dither threshold).
const FILL_WHOLE = 65536;
export const compactDecodeWGSL = /* wgsl */ `
const COMPACT_HOT_T = array<u32, ${PHASE_ROWS.length}>(${PHASE_ROWS.map(r => `${r.hotQ}u`).join(',')});
const COMPACT_COLD_T = array<u32, ${PHASE_ROWS.length}>(${PHASE_ROWS.map(r => `${r.coldQ}u`).join(',')});
fn compactTq(c: vec4u) -> u32 { let raw = (c.x >> 8u) & 65535u; if (raw <= 41093u) { return raw; }
  return select(COMPACT_COLD_T[c.x & 255u], COMPACT_HOT_T[c.x & 255u], raw < 53315u); }
const COMPACT_CONDUCTS = array<bool, ${ELEMENTS.length}>(${ELEMENTS.map(e => String(e.elec > 0)).join(',')});
const COMPACT_LIFE_SCALE = array<f32, ${ELEMENTS.length}>(${ELEMENTS.map(e => `${lifeScale(e.id)}.0`).join(',')});
const COMPACT_CTYPE_MASK = array<u32, ${ELEMENTS.length}>(${ELEMENTS.map(e => `${e.burnRate > 0 ? 127 : 255}u`).join(',')});
fn compactA(p: vec3i, c: vec4u) -> vec4f {
  let id = i32(c.x & 255u);
  let k = KIND(id);
  let T = ${T_OF};
  let seed = ${SEED_OF('p')};
  if (k == K_LIQUID) {
    if ((c.y & 0xffffffu) > ${DITHER_OF('p')}) {
      return ${LIQUID_A};
    }
    return vec4f(0.0, T, 0.0, seed);
  }
  if (k == K_EMPTY) { return vec4f(0.0, T, 0.0, seed); }
  return ${MATTER_A};
}
// Physics probes must see even one quantum of liquid, independent of visual dither.
fn compactProbeCore(c: vec4u) -> vec4u {
  var core = c;
  if (KIND(i32(c.x & 255u)) == K_LIQUID && (c.y & 0xffffffu) != 0u) {
    core.y = (c.y & 0xff000000u) | max(65536u, c.y & 0xffffffu);
  }
  return core;
}
fn compactProbeA(p: vec3i, c: vec4u) -> vec4f {
  return compactA(p, compactProbeCore(c));
}
`;

// The Box draw's readers of V2's cells (shaders/render.js volumeFrag, formats 2 and 3), in place of
// fetchA in the volume's module, where most of a frame's cell reads are (cold compile and frame
// time: one copy of compactA inlined at every call site, a seed hash in every empty read):
//   volumeT(p)  fetchA(p).y: the temperature alone.
//   volumeA(p)  fetchA(p), except that an empty cell's (or a dithered-out liquid's) seed fraction
//               reads 0. The volume reads a cell's .w only floored (0 either way: SEED_MAX < 1) or
//               behind a test that the cell holds matter (tools/volume-id-cpu-check.mjs executes
//               both decoders), so no pixel changes. Its hashes run only for a liquid, the dither's
//               only for a partial one (a whole cell beats every threshold).
// A liquid's hashes take fetchAs's coordinate, cellOf(slotOf(p)), as volumeId does. physical
// (format 3): the probes' core (compactProbeCore: one quantum of liquid is liquid).
export const compactDrawWGSL = (physical = false) => /* wgsl */ `
fn volumeT(p: vec3i) -> f32 {
  let c = A[slotOf(p)];
  return ${T_OF};
}
fn volumeA(p: vec3i) -> vec4f {
  let s = slotOf(p);
  let c = ${physical ? 'compactProbeCore(A[s])' : 'A[s]'};
  let id = i32(c.x & 255u);
  let k = KIND(id);
  let T = ${T_OF};
  if (k == K_EMPTY) { return vec4f(0.0, T, 0.0, 0.0); }
  if (k == K_LIQUID) {
    let q = cellOf(s);
    if ((c.y & 0xffffffu) < ${FILL_WHOLE}u && (c.y & 0xffffffu) <= ${DITHER_OF('q')}) { return vec4f(0.0, T, 0.0, 0.0); }
    let seed = ${SEED_OF('q')};
    return ${LIQUID_A};
  }
  return ${MATTER_A};
}
`;
