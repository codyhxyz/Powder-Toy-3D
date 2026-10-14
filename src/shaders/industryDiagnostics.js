import { prelude, STATE_OPTS, LAYOUT } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { MACHINE_GUARD_FIELDS, machineGuardWGSL } from './industry.js';

export const INDUSTRY_DIAGNOSTICS = Object.freeze({
  MAX_BASE_CELLS: 64,
  MAX_SAMPLES: 128,
  MAX_REGIONS: 8,
  RESULT_VECS: 1 + 8,
});

export const IndustryDiagnosticsParams = uniformStruct('IndustryDiagnosticsParams', {
  ...MACHINE_GUARD_FIELDS,
  baseMaterial: 'i32', baseCount: 'u32', sampleCount: 'u32', guardEnabled: 'u32', slot: 'u32',
  baseCells: `array<vec4i, ${INDUSTRY_DIAGNOSTICS.MAX_BASE_CELLS}>`,
  samples: `array<vec4i, ${INDUSTRY_DIAGNOSTICS.MAX_SAMPLES}>`, // xyz + region index
  rules: `array<vec4i, ${INDUSTRY_DIAGNOSTICS.MAX_REGIONS}>`, // kind mask, two ids, excluded id
  limits: `array<vec4f, ${INDUSTRY_DIAGNOSTICS.MAX_REGIONS}>`, // id temperatures, wildcard temperature, flags
  corner: 'vec3i', forward: 'vec3i', right: 'vec3i',
});

export const INDUSTRY_DIAGNOSTICS_LAYOUT = [{ binding: 0, buffer: { type: 'storage' } }];

// This read-only probe is bounded to one inspected machine: at most 64 base
// cells, 128 explicitly listed region cells, and local support/occlusion reads.
// It returns counts and temperature summaries, never cell contents or a grid scan.
export const industryDiagnosticsWGSL = g => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${IndustryDiagnosticsParams.wgsl}
@group(3) @binding(1) var<uniform> P: IndustryDiagnosticsParams;
${machineGuardWGSL}
@group(2) @binding(0) var<storage, read_write> result: array<vec4f>;
const MAX_BASE_CELLS: u32 = ${INDUSTRY_DIAGNOSTICS.MAX_BASE_CELLS}u;
const MAX_SAMPLES: u32 = ${INDUSTRY_DIAGNOSTICS.MAX_SAMPLES}u;
const MAX_REGIONS: u32 = ${INDUSTRY_DIAGNOSTICS.MAX_REGIONS}u;
const RESULT_VECS: u32 = ${INDUSTRY_DIAGNOSTICS.RESULT_VECS}u;
const RULE_SUPPORT: u32 = 1u;
const RULE_BREAKABLE_CLEAR: u32 = 2u;
const RULE_TEMP_EXCLUSIVE: u32 = 4u;
const RULE_POSITIVE_LIFE: u32 = 8u;
const RULE_TEMP_EXEMPT_IDS: u32 = 16u;

fn eligible(id: i32, a: vec4f, p: vec3i, rule: vec4i, limits: vec4f) -> bool {
  if (id == E_EMPTY) { return false; }
  if (rule.x != 0 && (u32(rule.x) & (1u << u32(KIND(id)))) == 0u) { return false; }
  let flags = u32(limits.w);
  var idMatches = rule.y < 0;
  var maxT = limits.z;
  if ((flags & RULE_TEMP_EXEMPT_IDS) != 0u) {
    idMatches = true;
    if (rule.y >= 0 && id == rule.y) { maxT = limits.x; }
    if (rule.z >= 0 && id == rule.z) { maxT = limits.y; }
  } else {
    if (rule.y >= 0 && id == rule.y) { idMatches = true; maxT = limits.x; }
    if (rule.z >= 0 && id == rule.z) { idMatches = true; maxT = limits.y; }
  }
  if (!idMatches || id == rule.w) { return false; }
  if ((flags & RULE_POSITIVE_LIFE) != 0u && !(a.z > 0.0)) { return false; }
  if (((flags & RULE_TEMP_EXCLUSIVE) != 0u && a.y >= maxT) || ((flags & RULE_TEMP_EXCLUSIVE) == 0u && a.y > maxT)) { return false; }
  if ((flags & RULE_SUPPORT) != 0u) {
    let under = p - vec3i(0, 1, 0);
    if (!inGrid(under) || KIND(eid(fetchA(under))) != K_SOLID) { return false; }
  }
  if ((flags & RULE_BREAKABLE_CLEAR) != 0u) {
    if (KIND(id) != K_SOLID || BREAKINTO(id) < 0) { return false; }
    let rel = p - P.corner;
    let x = i32(dot(vec3f(rel), vec3f(P.right)));
    let z = i32(dot(vec3f(rel), vec3f(P.forward)));
    for (var k = 4; k < z; k++) {
      let q = P.corner + P.right * x + vec3i(0, rel.y, 0) + P.forward * k;
      if (!inGrid(q) || KIND(eid(fetchA(q))) == K_SOLID) { return false; }
    }
  }
  return true;
}

@compute @workgroup_size(1)
fn main() {
  let at = P.slot * RESULT_VECS;
  var matched = 0u;
  for (var i = 0u; i < MAX_BASE_CELLS; i++) {
    if (i >= P.baseCount) { break; }
    let p = P.baseCells[i].xyz;
    if (inGrid(p) && eid(fetchA(p)) == P.baseMaterial) { matched++; }
  }
  var control = 1u;
  if (P.guardEnabled != 0u && P.guardPowered != 0u) {
    control = u32(machineEnabled(P.guardBase, P.guardMaterial, P.guardPort, P.guardPowered));
  }
  result[at] = vec4f(f32(matched), f32(P.baseCount), f32(control), f32(P.guardEnabled * P.guardPowered));

  var counts: array<vec4f, ${INDUSTRY_DIAGNOSTICS.MAX_REGIONS}>;
  for (var r = 0u; r < MAX_REGIONS; r++) { counts[r] = vec4f(0.0, 0.0, 0.0, -3.402823e38); }
  for (var i = 0u; i < MAX_SAMPLES; i++) {
    if (i >= P.sampleCount) { break; }
    let sample = P.samples[i];
    let p = sample.xyz;
    let r = u32(sample.w);
    if (r >= MAX_REGIONS || !inGrid(p)) { continue; }
    let a = fetchA(p);
    let id = eid(a);
    if (id == E_EMPTY) { continue; }
    counts[r].x += 1.0;
    counts[r].z += a.y;
    counts[r].w = max(counts[r].w, a.y);
    if (eligible(id, a, p, P.rules[r], P.limits[r])) { counts[r].y += 1.0; }
  }
  for (var r = 0u; r < MAX_REGIONS; r++) { result[at + 1u + r] = counts[r]; }
}
`;

export const WGSL_CHECK = [{
  name: 'industryDiagnostics', kind: 'compute', code: industryDiagnosticsWGSL,
  params: IndustryDiagnosticsParams, workgroupSize: [1, 1, 1],
  layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, INDUSTRY_DIAGNOSTICS_LAYOUT], dispatch: () => [1, 1, 1],
}];
