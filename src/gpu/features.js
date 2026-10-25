// Optional WGSL features (docs/webgpu.md W3, K3): `shader-f16` and `subgroups`,
// used when the device has them, with the core path kept as the fallback.
//
//   import { shaderFeatures, halfWGSL, subgroupsWGSL, appendWGSL } from '../gpu/features.js';
//   const f = shaderFeatures();          // { f16, subgroups }: what this page's device enabled
//   `${halfWGSL(f)}                      // hf/hv2/hv3/hv4: f16 types, or f32 ones on a core device
//    ${subgroupsWGSL(f)}                 // the subgroups directives, or nothing
//    ...
//    ${appendWGSL({ when: 'awake', counter: 'act2[V2_COUNT]', put: (i) => `atomicStore(&act2[V2_LIST + ${i}], b)` }, f)}`
//
// createGpu requests the features the adapter has and records them here
// before anything generates WGSL, so a generator reads shaderFeatures() as it
// reads the grid. With no device (Node tools) it is CORE, the plain path,
// unless a tool sets it (setShaderFeatures) to generate the other variant.
// The features change the module text, so the pipeline cache keys them for
// free. A snippet's directives (`enable f16;`) may land anywhere in a module:
// PipelineCache.module hoists them (hoistDirectives), as a tool must before
// it hands a module to a compiler.
//
// The software adapter tests use (SwiftShader) has subgroups but not
// shader-f16 (docs/webgpu.md "test container"). `?gpufeatures=core` (or a
// comma list such as `?gpufeatures=subgroups`) requests only those, so both
// paths can be compared on one machine.

/** Our names → WebGPU feature names. */
export const SHADER_FEATURE_NAMES = Object.freeze({ f16: 'shader-f16', subgroups: 'subgroups' });
/** The core path: no optional feature. */
export const CORE_FEATURES = Object.freeze({ f16: false, subgroups: false });

let current = CORE_FEATURES;

/** What generators may use: the device's features (createGpu), CORE_FEATURES without one. */
export function shaderFeatures() { return current; }

/**
 * Sets what generators use (createGpu does; a Node tool may, to generate a variant).
 * @param {Partial<typeof CORE_FEATURES>} f
 * @returns {Readonly<typeof CORE_FEATURES>}
 */
export function setShaderFeatures(f = {}) {
  current = Object.freeze({ f16: Boolean(f.f16), subgroups: Boolean(f.subgroups) });
  return current;
}

/**
 * The WebGPU features to request from an adapter: those it has, limited by
 * `allow` (our names; `?gpufeatures=`): 'core' or '' none, a comma list those, null all.
 * @param {{ features: { has(name: string): boolean } }} adapter
 * @param {string | null} [allow]
 * @returns {string[]}
 */
export function wantedShaderFeatures(adapter, allow = null) {
  const keep = allow === null ? null : new Set(allow.split(',').map((s) => s.trim()).filter((s) => s && s !== 'core'));
  return Object.entries(SHADER_FEATURE_NAMES)
    .filter(([ours, name]) => (!keep || keep.has(ours)) && adapter.features?.has?.(name))
    .map(([, name]) => name);
}

/**
 * What a device enabled, in our names.
 * @param {{ features?: { has(name: string): boolean } }} device
 */
export function featuresOf(device) {
  const has = (name) => Boolean(device?.features?.has?.(name));
  return { f16: has(SHADER_FEATURE_NAMES.f16), subgroups: has(SHADER_FEATURE_NAMES.subgroups) };
}

// A global directive alone on its line: enable/requires lists, or diagnostic(severity, rule).
const DIRECTIVE = /^[ \t]*(?:(?:enable|requires)[ \t]+[\w \t,]+|diagnostic[ \t]*\([\w \t,.]+\))[ \t]*;[ \t]*$/gm;

/**
 * The module with its global directives first (WGSL requires them before any
 * declaration), each once, in first-seen order. A module without any is returned unchanged.
 * @param {string} code
 * @returns {string}
 */
export function hoistDirectives(code) {
  if (!/\b(?:enable|requires|diagnostic)\b/.test(code)) return code;
  const found = code.match(DIRECTIVE);
  if (!found) return code;
  const lines = [...new Set(found.map((d) => d.trim().replace(/\s+/g, ' ')))];
  return `${lines.join('\n')}\n${code.replace(DIRECTIVE, '')}`;
}

/**
 * Module-scope WGSL: `hf`, `hv2`, `hv3`, `hv4` as f16 types (with `enable f16;`)
 * when the device has shader-f16, else as f32 ones. For registers and math:
 * buffer and uniform layouts keep explicit types, since f16 changes their sizes.
 * Write literals without a suffix (`hf(0.5)`, `x * 2.0`), so both variants parse.
 * Include it once per module.
 * @param {typeof CORE_FEATURES} [f]
 * @returns {string}
 */
export function halfWGSL(f = current) {
  const [s, v] = f.f16 ? ['f16', 'h'] : ['f32', 'f'];
  return `${f.f16 ? 'enable f16;\n' : ''}alias hf = ${s};\nalias hv2 = vec2${v};\nalias hv3 = vec3${v};\nalias hv4 = vec4${v};\n`;
}

/**
 * Module-scope WGSL a module using subgroup builtins needs: `enable subgroups;`
 * and the uniformity diagnostic off (our subgroup code runs after a kernel's
 * early return of its padding threads: its operations are over the active
 * invocations, never a fixed subgroup size). Empty on a core device.
 * @param {typeof CORE_FEATURES} [f]
 * @returns {string}
 */
export function subgroupsWGSL(f = current) {
  return f.subgroups ? 'enable subgroups;\ndiagnostic(off, subgroup_uniformity);\n' : '';
}

/**
 * WGSL statements that append to a list when `when` holds: `put(i)` writes
 * the entry at index i, allocated from the atomic `counter` (an lvalue such as
 * `act2[V2_COUNT + CNT_AWAKE]`). The core path is the plain one, exactly
 * `if (when) { put(atomicAdd(&counter, 1u)); }`. With subgroups the
 * invocations that append share one atomicAdd per subgroup: each takes its
 * rank among them (subgroupExclusiveAdd), the lowest adds their count, and
 * subgroupMax hands its base to the rest (the others hold 0). No subgroup size
 * is assumed. The set of entries is the same; their order in the list is not,
 * so only order-free lists may use it (docs/webgpu.md W21). `counter` and the
 * list `put` writes must be the same for every invocation of the subgroup,
 * and every invocation still running must reach these statements (call them
 * outside the branch that decides `when`). Its locals are scoped in a block.
 * @param {{ when: string, counter: string, put: (index: string) => string }} append
 * @param {typeof CORE_FEATURES} [f]
 * @returns {string}
 */
export function appendWGSL({ when, counter, put }, f = current) {
  if (!f.subgroups) return `if (${when}) { ${put(`atomicAdd(&${counter}, 1u)`)}; }`;
  return `{
    let sgWant = ${when}; let sgOne = select(0u, 1u, sgWant);
    let sgRank = subgroupExclusiveAdd(sgOne); let sgCount = subgroupAdd(sgOne);
    var sgBase = 0u; if (sgWant && sgRank == 0u) { sgBase = atomicAdd(&${counter}, sgCount); }
    sgBase = subgroupMax(sgBase);
    if (sgWant) { ${put('sgBase + sgRank')}; }
  }`;
}
