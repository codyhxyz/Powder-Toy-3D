import { prelude, STATE_OPTS, LAYOUT, STAGE } from '../common.js';
import { frameBindings, lightingBindings, RENDER_LAYOUT } from '../bindings.js';
import { materialsGLSL } from '../../gfx/materials.js';
import { glslMod, fullscreenVert } from '../../gpu/wgsl.js';
import { coreGLSL, ddaGLSL } from './core.js';
import { noiseGLSL } from './noise.js';
import { lightingGLSL } from './lighting.js';
import { crystalGLSL } from './crystal.js';
import { sourceAppearanceWGSL, sourceAppearanceFallbackWGSL } from './sourceAppearance.js';
import { SOURCE_APPEARANCE_ENABLED } from '../../gfx/sourceAppearance.js';
import { cloudsGLSL } from './clouds.js';
import { farLayout, farLayoutGLSL, farSkyGLSL, farHazeFor, farCastersGLSL, farGIGLSL, WORLD_SIZE } from '../farShared.js';

// The render library (docs/webgpu.md F2, F6): the WGSL every render kernel
// starts with, assembled in the order the GLSL's lib(g) was (shaders/render.js):
// the prelude (grid consts, element tables, header, state read-only:
// STATE_OPTS.STATE_RO), FrameUniforms (FU) and the lighting group
// (shaders/bindings.js), glslMod, the materials' consts and emission
// (gfx/materials.js), then core, noise, lighting (with the clouds' deck) and
// crystal (shaders/gfx/*.js). The volume, the shadow kernel, GI source and
// gather, the sign probe and the far view each paste lib(g, …) first and bind
// libLayouts(variant):
//   group 0  RENDER_LAYOUT.FRAME   the tables (TB) and FrameUniforms (FU)
//   group 1  LAYOUT.STATE_RO       A and B, read through fetchA/fetchB
//   group 2  the L.LIGHTING variant (RENDER_LAYOUT[variant])
//   group 3  LAYOUT.PARAMS         the header (H.origin, H.src) and the kernel's params
//
// Each L.LIGHTING writer variant takes out the functions that read what that
// pipeline writes (a texture is never sampled and storage-written in one
// dispatch, F6):
//   LIGHTING         everything (the volume, the sign probe, the far view)
//   LIGHTING_SHADOW  no shadow-map readers (sunMapShadow, sunShadow and their
//                    *At twins, nearField): the shadow kernel writes the map
//   LIGHTING_GI      no GI-band readers (probeTex, probeAt, surfProbe,
//                    nearField) and no cellFlow (the layout drops flow and
//                    aeration): GI gather writes the bands
//   LIGHTING_GISRC   everything, beside giSrc (GI source's output)
// The two GI variants also build the library with the GI passes' uniforms
// (giUniforms, lighting.js): what their GLSL left unset (uCaustics, uTime,
// uFrame) is a literal 0, not the shared FrameUniforms field, so the probes'
// sun lookups see no caustics and nothing in them moves with time or frame
// (docs/webgpu.md E).
export const LIB_VARIANTS = {
  LIGHTING: { shadowMap: true, probes: true, flow: true, giUniforms: false },
  LIGHTING_SHADOW: { shadowMap: false, probes: true, flow: true, giUniforms: false },
  LIGHTING_GI: { shadowMap: true, probes: false, flow: false, giUniforms: true },
  LIGHTING_GISRC: { shadowMap: true, probes: true, flow: true, giUniforms: true },
};

/**
 * The render library's WGSL for grid g (a gridLayout: nx, ny, nz, maxSteps).
 * Source artwork is compiled only with explicit g.sourceAppearance === true;
 * ordinary grids and shader checks never include the source-data readers.
 *   variant   which L.LIGHTING layout the pipeline binds (LIB_VARIANTS)
 *   far       declare the far textures (11-13): needed by farCastersGLSL and
 *             farGIGLSL (shaders/farShared.js); the layout has them either way
 *   aeration  declare the aeration buffer (19), for the volume's foam
 *   debug     the prelude's accessors test inGrid (?gpudebug=1)
 *   detail    the close-up detail's defines (gfx/detail.js: { DETAIL_CUBIC_CLOSE: 1, … });
 *             core reads DETAIL_CUBIC_CLOSE (the volume's; other passes leave it out)
 * @param {{ nx: number, ny: number, nz: number, maxSteps?: number }} g
 * @param {{ variant?: string, far?: boolean, aeration?: boolean, debug?: boolean, detail?: object, fixedReadFormat?: 0 | 2 | 3 }} [opts]
 */
export function lib(g, { variant = 'LIGHTING', far = true, aeration = true, debug = false, detail = {}, fixedReadFormat } = {}) {
  const v = LIB_VARIANTS[variant];
  if (!v) throw new Error(`lib: no variant ${variant} (${Object.keys(LIB_VARIANTS).join(', ')})`);
  return [
    prelude(g, { ...STATE_OPTS.STATE_RO, debug, fixedReadFormat }),
    frameBindings(),
    lightingBindings({ far, aeration, variant }),
    glslMod,
    materialsGLSL(),
    coreGLSL(g, { flow: v.flow, detail }),
    noiseGLSL,
    SOURCE_APPEARANCE_ENABLED && g.sourceAppearance === true && far ? sourceAppearanceWGSL(far, g.sourceGrid) : sourceAppearanceFallbackWGSL,
    lightingGLSL({ ...v, far }),
    crystalGLSL,
  ].join('\n');
}

/**
 * The bind group layout entries of a pipeline built on lib(g, { variant }),
 * groups 0-3, for gpu.layout(name, entries).
 * @param {string} [variant]
 */
export const libLayouts = (variant = 'LIGHTING') => [RENDER_LAYOUT.FRAME, LAYOUT.STATE_RO, RENDER_LAYOUT[variant], LAYOUT.PARAMS];

// ---------------------------------------------------------------- the probes
// Kernels that call every function the library exports, so check-wgsl and
// tools/lib-check.mjs build them (Tint validates a whole module, but a
// pipeline compiles only what its entry point reaches). Each module's calls,
// in a scope holding p (a grid point), d (a unit direction), n (a unit
// normal), s (a scalar), ci (a cell), ni (an axis normal), with gFragCoord
// set, accumulating into acc (so nothing is dead). Inputs come from a buffer
// (compute) or the pixel and FrameUniforms (fragment), so nothing folds.
const PROBE_CALLS = {
  dda: () => `
  acc.x += select(0.0, 1.0, outside(ci) || isCrisp(i32(s)));
  acc += vec4f(worldPos(p) + safeDir(d) + boxHit(p, d), f32(argmin3(d)) + tClosest(ci, p, d, 0.0, 4.0));
  acc.y += f32(eid(fetchA(ci))) * DDA_START_NUDGE + f32(MAX_STEPS) + f32(GRID.x);`,
  noise: () => `
  acc += vec4f(hash33(p), hash13(p));
  acc.x += vnoise(p) + fbm3(p) + ign(gFragCoord, s);`,
  core: ({ flow }) => `${flow ? `
  acc += vec4f(cellFlow(ci), 0.0);` : ''}
  gThin = c.w > 0.5;
  gCubicEye = n * s;
  gCubicPixAng = abs(c.w) * 0.01;
  acc.x += select(0.0, 1.0, outside(ci) || isCrisp(i32(s)));
  let qb = ci / BS;
  let qf = brickInfo(qb);
  acc += vec4f(worldPos(p), f32(brickOcc(qb) + qf));
  acc.y += select(0.0, 1.0, brickHas(qf, 1u) || brickMedia(qf) || brickSurf(qf) || brickOpaque(qf) || brickThin(qf) || brickMixed(qf));
  acc += vec4f(safeDir(d) + boxHit(p, d), f32(argmin3(d)));
  var qCell = ci;
  var qMax = p;
  var qEnter = s;
  acc.z += f32(skipBrick(qb, p, d, vec3i(sign(d)), &qCell, &qMax, &qEnter) + skipEmpty(qb, p, d, vec3i(sign(d)), &qCell, &qMax, &qEnter));
  acc += vec4f(qMax + vec3f(qCell), qEnter);
  acc += fieldTex(tFT, p) + surfField(p) + mediaField(p) + fieldCubic(tFM, p) + surfSample(p);
  acc.w += cubicClose(p) + cubicShare(p, CH_GRANULAR) + surfChannel(p, CH_LIQUID) + surfChannel(p, CH_ORGANIC);
  acc.w += surfRoot(p, d, 1, 0.0, 1.0, -0.5, 0.5);
  acc.w += surfCross(p, d, CH_LIQUID, s > 0.0, 0.0, 0.5, 1.0, 0.2, 0.6, 0.4) + tClosest(ci, p, d, 0.0, 4.0);
  acc += vec4f(surfNormal(p, CH_LIQUID, n) + surfNormal(p, CH_GRANULAR, d), meshCutAt(fract(s), mat4x4f(c, b, a, c), b.zw + 1.0, d));`,
  lighting: ({ shadowMap, probes }) => `
  acc.x += airMass(d.y);
  acc += vec4f(skyRadiance(d) + skyColor(d) + skyAmbient(n), rippleH(p.xz, s));
  acc.y += select(0.0, 1.0, underPool(vec4f(p, s), s, 3)) + causticGain(p, s);
  var qc: vec3f;
  var qR: f32;
  var qu: vec3f;
  var qv: vec3f;
  sunBasis(&qc, &qR, &qu, &qv);
  acc += vec4f(qc + qu + qv, qR);
  acc.z += smoothOpaque(p) + sunRayClear(p, s) + wk0(ci.xy, p.xy);${shadowMap ? `
  acc += vec4f(sunMapShadow(p, n) + sunMapShadowAt(p) + sunShadow(p, n) + sunShadowAt(p), 0.0);` : ''}${probes ? `
  let qg = surfProbe(p, n);
  acc += probeTex(tGI0, p) + qg.c0 + probeAt(p).cx;
  acc.w += giAirSkyVis(p);` : ''}
  let qp = Probe(vec4f(p, s), vec4f(d, s), vec4f(n, s), vec4f(s));
  acc += vec4f(giIrradiance(qp, n) + giRadiance(qp, d, s), giSkyVis(qp, n));
  acc += vec4f(wandLight(p) + sampleLight(p), 0.0);
  acc.x += select(0.0, 1.0, occluder(ci)) + faceAO(ci, ni, p) + solidity(p) + fieldAO(p, n);
  var qhc: vec3i;
  var qhn: vec3f;
  acc.y += select(0.0, 1.0, nearSmoothIn(p, s > 0.0)) + traceNear(p, d, 6.0, s > 0.0, 1.0, &qhc, &qhn);
  acc += vec4f(qhn + vec3f(qhc), 0.0) + vec4f(pixRand(1), 0.0, 0.0);${shadowMap && probes ? `
  var qvis: f32;
  acc += vec4f(nearField(p, n, n, d, &qvis), qvis);` : ''}
  acc.z += select(0.0, 1.0, glowWorthIt(p, d)) + glowLightScale(p, n, n);
  acc += vec4f(lampLight(p, n, n), 0.0);`,
  crystal: () => `
  var qOpen: bool;
  acc.x += f32(crysRun(ci, ni, &qOpen)) + select(0.0, 1.0, qOpen);
  let qs = crysShard(ci);
  var qm: vec3f;
  var qDist: f32;
  crysPlane(qs, 1, &qm, &qDist);
  acc += vec4f(qm, qDist);
  var qtN = s;
  var qn = n;
  var qKind: i32;
  acc.y += select(0.0, 1.0, shardHit(qs, p, d, &qtN, s + 1.0, &qn, &qKind)) + f32(qKind) + qtN;
  acc.y += shardExit(qs, p, d, &qm);
  acc += vec4f(qm, 0.0);
  var qt = 0.0;
  var qcn = n;
  acc.z += select(0.0, 1.0, crystalHit(ci, p, d, s, s + 1.0, &qt, &qcn)) + qt + f32(gCrysKind) + gCrys.r;`,
  clouds: () => `
  acc.x += cloudDensity(p, s) + cloudShadow(p) + hgPhase(d.y, s);
  acc += cloudLayer(p, d);`,
  farShared: ({ casters = true, gi = true, probes = true } = {}) => `
  let qft = farUnpack(vec4u(vec3u(ci), u32(ni.y)));
  acc += vec4f(farPackTexel(qft)) + vec4f(f32(qft.s + qft.l + qft.glow + qft.id + qft.liquid), select(0.0, 1.0, qft.open), 0.0, 0.0);
  acc += vec4f(farAir(d) + farHaze(p, d, s, n.y), farSkyOpen(p * 8.0));${probes ? `
  acc += vec4f(farHazePremul(p, s, p, n), farAirLit(p, n * s));` : ''}${casters ? `
  acc.x += select(0.0, 1.0, farUnder(p)) + farCasterDepth(p, d, 0.0, s);` : ''}${gi ? `
  var qOpenSky = 1.0;
  acc += vec4f(farGround(p, s) + farSea(d) + farPlain() + farBeyond(p, p, d, &qOpenSky), qOpenSky);
  acc += vec4f(farBeyondOpen(p * 8.0, d, &qOpenSky), qOpenSky);` : ''}`,
};

// What each probe holds: the library's modules it calls, its variant, its
// stage and its far parts.
const ALL = ['noise', 'core', 'lighting', 'crystal', 'clouds', 'farShared'];
const PROBES = {
  // core.js's binding-free part on the prelude and the materials alone (no
  // FrameUniforms, no lighting group): what a state-only DDA can paste
  'lib.dda': { modules: ['dda'], bare: true },
  'lib.noise': { modules: ['noise'] },
  'lib.core': { modules: ['core'] },
  'lib.lighting': { modules: ['lighting'] },
  'lib.crystal': { modules: ['crystal'] },
  'lib.clouds': { modules: ['clouds'] },
  farShared: { modules: ['farShared'] },
  // the writer variants with everything they keep, and the far part each uses
  'lib.shadow': { modules: ALL, variant: 'LIGHTING_SHADOW', casters: true, gi: false },
  'lib.gi': { modules: ALL, variant: 'LIGHTING_GI', casters: false, gi: true },
  'lib.gisrc': { modules: ['core', 'lighting'], variant: 'LIGHTING_GISRC' },
  // the volume's stage: the library in a fragment shader, with the close-up
  // detail core reads (DETAIL_CUBIC_CLOSE)
  'lib.fragment': { modules: ALL, stage: 'fragment', detail: { DETAIL_CUBIC_CLOSE: 1 } },
};
// which probes each module's WGSL_CHECK lists
const CHECKS = {
  noise: ['lib.noise'], core: ['lib.dda', 'lib.core'], lighting: ['lib.lighting'], crystal: ['lib.crystal'], clouds: ['lib.clouds'],
  farShared: ['farShared'], lib: ['lib.shadow', 'lib.gi', 'lib.gisrc', 'lib.fragment'],
};
export const LIB_PROBES = Object.keys(PROBES);

// The probe's own output: group 3 binding 2, beside the header and params
// (the GISRC variant has no room for it, 8 storage buffers; it writes giSrc).
const PROBE_OUT = { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } };
// A bare probe's head: the prelude (tables, state read-only, header), the
// materials' table accessors and core.js's DDA helpers; groups 0 and 1 are
// LAYOUT.TABLES and LAYOUT.STATE_RO, group 2 is empty.
const bareHead = (g) => [prelude(g, STATE_OPTS.STATE_RO), materialsGLSL(), ddaGLSL(g)].join('\n');

/**
 * A probe's WGSL for grid g (LIB_PROBES names it).
 * @param {object} g
 * @param {string} name
 */
export function libProbe(g, name) {
  const pr = PROBES[name];
  if (!pr) throw new Error(`libProbe: no probe ${name} (${LIB_PROBES.join(', ')})`);
  const { modules, variant = 'LIGHTING', stage = 'compute', casters = true, gi = true, bare = false, detail = {} } = pr;
  const v = LIB_VARIANTS[variant];
  const L = farLayout(WORLD_SIZE);
  const far = modules.includes('farShared');
  const haze = far || modules.includes('clouds');
  const body = modules.map((m) => PROBE_CALLS[m]({ ...v, casters, gi })).join('\n');
  const prologue = `
  let p = a.xyz;
  let s = a.w;
  let d = normalize(b.xyz + vec3f(0.1, 0.2, 0.3));
  let n = normalize(c.xyz + vec3f(0.0, 1.0, 0.0));
  let ci = vec3i(floor(p));
  let ni = vec3i(0, select(1, -1, c.w < 0.0), 0);
  var acc = vec4f(0.0);`;
  const gisrc = variant === 'LIGHTING_GISRC';
  const entry = stage === 'fragment' ? `
${fullscreenVert('vs')}
@fragment fn fs(frag: FullScreen) -> @location(0) vec4f {
  gFragCoord = frag.position.xy;
  let a = vec4f(FU.cam, FU.time);
  let b = vec4f(frag.position.xy, frag.uv);
  let c = vec4f(FU.sun, FU.lightGain);${prologue}${body}
  return acc;
}` : `
${gisrc ? '' : '@group(3) @binding(2) var<storage, read_write> probeIO: array<vec4f>;'}
@compute @workgroup_size(1) fn main() {
  let a = ${gisrc ? 'bitcast<vec4f>(giSrc[0])' : 'probeIO[0]'};
  let b = ${gisrc ? 'bitcast<vec4f>(giSrc[1])' : 'probeIO[1]'};
  let c = ${gisrc ? 'bitcast<vec4f>(giSrc[2])' : 'probeIO[2]'};
  ${bare ? '' : 'gFragCoord = b.xy;'}${prologue}${body}
  ${gisrc ? 'giSrc[3] = bitcast<vec4u>(acc);' : 'probeIO[3] = acc;'}
}`;
  return [
    `// probe ${name}: calls ${modules.join(', ')} (${bare ? 'no lighting group' : variant}, ${stage})`,
    bare ? bareHead(g) : lib(g, { variant, far: true, detail }),
    // the haze's air reads the probes (giAirSkyVis), which GI gather writes
    haze ? farHazeFor(v.probes ? 'giAirSkyVis' : null) : '',
    modules.includes('clouds') ? cloudsGLSL : '',
    far ? farLayoutGLSL(L) + farSkyGLSL : '',
    far && casters ? farCastersGLSL(L, { layout: false }) : '',
    far && gi ? farGIGLSL(L, { layout: false, sky: false }) : '',
    entry,
  ].join('\n');
}

/**
 * A probe's bind group layout entries (groups 0-3).
 * @param {string} name
 */
export function libProbeLayouts(name) {
  const { variant = 'LIGHTING', stage = 'compute', bare = false } = PROBES[name];
  const groups = bare ? [LAYOUT.TABLES, LAYOUT.STATE_RO, LAYOUT.EMPTY, LAYOUT.PARAMS] : libLayouts(variant);
  if (stage === 'compute' && variant !== 'LIGHTING_GISRC') groups[3] = [...LAYOUT.PARAMS, PROBE_OUT];
  return groups;
}

/**
 * A probe as a check-wgsl entry (src/gpu/checks.js). warm: false marks it as
 * a test kernel no game path builds: preload's warm-on-menu set (B5), which
 * comes from the WGSL_CHECK lists, leaves it out (about 14 s of SwiftShader
 * pipeline time for the library's ten).
 */
function probeCheck(name) {
  const { stage = 'compute' } = PROBES[name];
  return {
    name,
    warm: false,
    kind: stage === 'fragment' ? 'render' : 'compute',
    code: (g) => libProbe(g, name),
    layouts: () => libProbeLayouts(name),
    ...(stage === 'fragment' ? { vertex: { entry: 'vs' }, fragment: { entry: 'fs', targets: [{ format: 'rgba16float' }] } } : {}),
  };
}

/**
 * The WGSL_CHECK entries of one of the library's modules ('noise', 'core',
 * 'lighting', 'crystal', 'clouds', 'farShared', 'lib'): its probes.
 * @param {string} module
 */
export const libChecks = (module) => CHECKS[module].map(probeCheck);

/** tools/check-wgsl.mjs: the writer variants' probes and the library in a fragment shader */
export const WGSL_CHECK = () => libChecks('lib');
