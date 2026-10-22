import { STATE_OPTS, LAYOUT, prelude, readFormatWGSL, WORLD_RUNTIME_GRID, worldRuntimeGrid } from './common.js';
import { compactDrawWGSL } from './compact.js';
import { nativeMotionWGSL } from './v2/viewRead.js';
import { RENDER_LAYOUT } from './bindings.js';
import { ELEMENTS } from '../elements.js';
import { COLORMAPS, VIEWS, xrayDensity, isMaterialView, materialStyleForView } from '../views.js';
import { materialsGLSL } from '../gfx/materials.js';
import { lib, libLayouts } from './gfx/lib.js';
import { ddaGLSL } from './gfx/core.js';
import { surfaceGLSL } from './gfx/surface.js';
import { liquidGLSL } from './gfx/liquid.js';
import { liquidDetailGLSL, LIQ_DETAIL, WORLD_NATIVE } from './gfx/liquidDetail.js';
import { mediaGLSL } from './gfx/media.js';
import { grainsGLSL, GRAINS_ANY } from './gfx/grains.js';
import { volumeHazeGLSL, farCastersGLSL, farLayout, WORLD_SIZE } from './farShared.js';
import { MESH_CUT_FIELDS, MESH_DEPTH_ENTRY, meshCutGLSL } from '../gfx/meshCut.js';
import { decoViewGLSL, decoViewWGSL, decoSurfGLSL, DECO_PLANE_ENTRY } from './gfx/deco.js';
import { presentationNearWGSL } from './gfx/presentation.js';
import { uniformStruct } from '../gpu/params.js';
import { STAGE } from '../gpu/kernels.js';
import { DETAIL, COST, detailDefaults, SOFTWARE_UNDRAWABLE, drawableDetail } from '../gfx/detail.js';
import { gateVariants } from '../gfx/detailGate.js';
import { glf } from '../glsl.js';
import { shadowTilesWGSL, SHADOW_TILE } from './passes.js';
import { shadowOpticsWGSL } from './gfx/shadowOptics.js';
import { worldMeshCutWGSL } from './gfx/worldMesh.js';
import { worldAccessWGSL } from './worldAccess.js';
import { worldVolumeLayouts, worldQueryWGSL } from './worldRenderBackend.js';
import { renderBackend } from './gfx/worldCore.js';
import { worldPlainWGSL, worldPlainPickWGSL } from './worldPlain.js';
import { BLOCK_PLAIN_ABSORB, BLOCK_PLAIN_ADD } from './blockPlainShared.js';

// Hybrid raymarcher. Rays walk the voxel grid with an Amanatides–Woo DDA
// (4×4×4 bricks skip empty space). What they hit depends on the element's look
// (gfx/materials.js):
// - crisp elements (wall, metal, glass, clone) are voxels;
// - liquids, lava, powders and organics are smooth surfaces: the 0.5
//   isosurface of blurred occupancy fields (shaders/fields.js), found by
//   root-finding inside each cell segment. Cells too isolated to form a
//   surface are drawn as droplets / grains;
// - liquids refract (real bent rays), absorb (Beer–Lambert) and reflect;
// - smoke, steam and fire are density volumes.
// Views 1-4 (heat, pressure, flow, X-ray) are false-colour data views with
// their own marches (below); view 0 is the realistic render. The plain view
// (5) stays with gfx/blocks.js in BOX; WORLD evaluates the same voxel-face
// look along global raw rays (worldPlain.js), without a local face pool.
//
// WGSL (docs/webgpu.md F2; the names are the GLSL version's, W2). Each view is
// a module of its own, a vertex and a fragment entry (volumeFrag(g, { view,
// detail })), holding only that view's code: the realistic tracer's registers
// and compile time aren't paid by the others. The close-up detail is a JS
// template switch as its #ifdefs were (gfx/detail.js defines objects). The
// material views' haze (farShared.js volumeHazeGLSL) is on every map, a box's
// and a world's alike.
//
// The pass (docs/webgpu.md F1, Sync log S1): the window box drawn as back faces
// (cullMode 'front': one fragment per covered pixel, the camera inside the box
// too) into the scene target after three's opaque meshes, depth test
// less-equal, frag_depth written (the first hit: TAA's only motion signal),
// premultiplied colour blended over, nothing written where nothing was hit.
// The realistic march stops at the opaque meshes' depth (gfx/meshCut.js) and
// writes the nearer of its hit and the mesh, so water in front of a body
// tints it; the data views keep the depth test against the meshes, as before.
//
// Bindings: the render library's (shaders/gfx/lib.js) with group 0 extended by
// the meshes' depth (VOLUME_LAYOUTS):
//   group 0  tables, FrameUniforms (FU), the meshes' depth (copied: meshCut),
//            the decoration plane (gfx/deco.js)
//   group 1  A and B (read)
//   group 2  L.LIGHTING (fields, light, GI, shadow map, noise, bricks, flow, aeration)
//   group 3  the header (the window's origin, the current copy) and VolumeParams (P)
// Derivatives are taken once, at the top of the fragment entry in uniform
// control flow (surfView: the pixel's footprint and the ray's screen
// derivatives); every texture read is textureSampleLevel or textureLoad, and
// the floor lines take their width from the ray's derivatives (floorFwidth),
// so nothing else needs uniform control flow.

// ---- data views: WGSL generated from the colormaps in src/views.js ----

const srgbOf = (hex) => [0, 2, 4].map((o) => parseInt(hex.slice(1 + o, 3 + o), 16) / 255);
const vec3 = (v) => `vec3f(${v.map(glf).join(', ')})`;

// For a colormap {knots, log}: <name>Pos(x) maps a value to its legend
// position (0..1), <name>Srgb(p) maps a position to its colour (interpolated
// in sRGB like the CSS legend), <name>Color(x) gives linear RGB. The knots'
// colours are picked by a switch, not a runtime-indexed const array (docs/webgpu.md C6).
export function colormapWGSL(name, cm) {
  const k = cm.knots, n = k.length;
  let pos = `fn ${name}Pos(x: f32) -> f32 {\n  if (x <= ${glf(k[0][0])}) { return 0.0; }\n`;
  for (let i = 1; i < n; i++) {
    const a = k[i - 1][0], b = k[i][0];
    const f = cm.log && a * b > 0
      ? `log(x * ${glf(1 / a)}) * ${glf(1 / Math.log(b / a))}`
      : `(x - ${glf(a)}) * ${glf(1 / (b - a))}`;
    pos += `  if (x <= ${glf(b)}) { return (${glf(i - 1)} + ${f}) * ${glf(1 / (n - 1))}; }\n`;
  }
  pos += '  return 1.0;\n}\n';
  const col = (i) => vec3(srgbOf(k[i][1]));
  const cases = [...Array(n - 1).keys()].map((j) => `    case ${j}: { a = ${col(j)}; b = ${col(j + 1)}; }`).join('\n');
  return `${pos}fn ${name}Srgb(p: f32) -> vec3f {
  let f = clamp(p, 0.0, 1.0) * ${glf(n - 1)};
  let j = min(i32(f), ${n - 2});
  var a: vec3f;
  var b: vec3f;
  switch (j) {
${cases}
    default: { a = ${col(n - 2)}; b = ${col(n - 1)}; }
  }
  return mix(a, b, f - f32(j));
}
fn ${name}Color(x: f32) -> vec3f { return toLinear(${name}Srgb(${name}Pos(x))); }
`;
}

// X-ray attenuation per cell from density, compressed (ρ^XRAY_DENSITY_POW)
// so light and heavy materials both read. A switch over the elements (equal
// values share a case), not a runtime-indexed const array (docs/webgpu.md C6).
const XRAY_MU_PER_DENSITY = 0.035;   // attenuation per cell at density 1
const XRAY_DENSITY_POW = 0.6;
const XRAY_MU_DECIMALS = 5;          // rounding of the generated table
const xrayMu = () => {
  const byValue = new Map();
  for (const e of ELEMENTS) {
    const v = glf(+(XRAY_MU_PER_DENSITY * Math.pow(xrayDensity(e), XRAY_DENSITY_POW)).toFixed(XRAY_MU_DECIMALS));
    if (!byValue.has(v)) byValue.set(v, []);
    byValue.get(v).push(`E_${e.key}`);
  }
  const cases = [...byValue].map(([v, ids]) => `    case ${ids.join(', ')}: { return ${v}; }`).join('\n');
  return `fn XRAY_MU(id: i32) -> f32 {\n  switch (id) {\n${cases}\n    default: { return 0.0; }\n  }\n}`;
};

// DDA steps the realistic march gets beyond MAX_STEPS: each refraction
// restarts the ray, so its path can be longer than one crossing of the box.
const BEND_EXTRA_STEPS = 128;

// BOX volume modules. WORLD additionally accepts the explicit 'plain' variant.
export const VOLUME_VIEWS = VIEWS.map((v) => v.key).filter((k) => k !== 'plain');
const DATA_VIEWS = ['heat', 'pressure', 'flow', 'xray'];

// The decoration layer (TPT's deco colour, src/deco.js) in the view: every
// view pastes shaders/gfx/deco.js, its lookups (decoAt, decoLinear, decoTint
// and their constants) and its hooks (decoSurf,
// absorbDeco: the realistic tracer calls them), reading the plane at group 0
// binding 3. VolumeParams.deco switches the lookups off (Ctrl+B, or nothing
// decorated: decoAt reads no paint, so decoTint keeps the albedo), so drawing
// it or not builds nothing.
export const DECO_VIEW = true;

// The volume's own values (group 3 binding 1): the meshes' cut (gfx/meshCut.js),
// the first-person eye clip, Whitewater's current aeration copy, whether the
// decoration is drawn, and the rolling log's parameters (curved variants).
export const VolumeParams = uniformStruct('VolumeParams', {
  ...MESH_CUT_FIELDS,
  marchNear: 'f32',   // cells: nothing nearer the camera is drawn (first person's eye clip, pov/index.js EYE_CLIP)
  aerCopy: 'u32',     // the aeration copy the view reads (0 or 1: gfx/liquidDetail.js gAerCopy)
  deco: 'u32',        // the decoration is drawn (src/deco.js decoShown): decoAt reads the plane
  // the rolling log's parameters (gfx/presentation.js parameters: k, anchor, dir), read by the curved variant
  warpK: 'f32',
  warpAnchor: 'vec2f',
  warpDir: 'vec2f',
});

// What every view's module defines beside the material library: the
// tracer's events, soft blobs and the filmic curve the materials call back
// (gfx/surface.js shows their stand-ins), its constants, and its params.
const tracerWGSL = (backend = 'box') => /* wgsl */ `
${VolumeParams.wgsl}
@group(3) @binding(${backend === 'world' ? 0 : 1}) var<uniform> P: VolumeParams;

// A ray stops once its transmittance is below this: nothing behind can show.
const RAY_MIN_TRANS: f32 = 0.01;

// smooth-surface events along a cell segment (gfx/grains.js adds EV_GRAIN)
const EV_NONE: i32 = 0;
const EV_OPAQUE: i32 = 1;
const EV_ENTER: i32 = 2;
const EV_EXIT: i32 = 3;

// A gas cell as a soft ball: density from the ray's closest approach to the
// cell centre (cells), BLOB_PEAK within BLOB_R_IN, fading to 0 at BLOB_R_OUT.
const BLOB_R_IN: f32 = 0.1;
const BLOB_R_OUT: f32 = 0.95;
const BLOB_PEAK: f32 = 1.8;
fn softBlob(cell: vec3i, ro: vec3f, rd: vec3f, t0: f32, t1: f32) -> f32 {
  let cc = vec3f(cell) + 0.5;
  let tm = clamp(dot(cc - ro, rd), t0, t1);
  return smoothstep(BLOB_R_OUT, BLOB_R_IN, length(ro + rd * tm - cc)) * BLOB_PEAK;
}


// What a view's trace drew: premultiplied colour, frag_depth, and whether
// anything was hit (else the entry discards).
struct VolumeHit {
  color: vec4f,
  depth: f32,
  hit: bool,
}
// The clip depth of grid point p through the jittered camera, WebGPU's [0, 1] (docs/webgpu.md F4).
fn volumeDepth(p: vec3f) -> f32 {
  let clip = FU.viewProj * FU.model * vec4f(p, 1.0);
  if (clip.w <= 0.0) { return 0.0; }
  return clipDepth(clip);
}
${backend === 'world' ? worldMeshCutWGSL : meshCutGLSL}`;

// =====================================================================
// Data views: heat (1), pressure (2), flow (3), X-ray (4).
// False-colour renderings with soft "clay" lighting (sun direction, sky fill,
// corner AO) and no shadows. Colours stay in linear RGB and are written
// without the filmic curve, so a fully lit surface shows exactly its legend
// colour. They share the DDA from march() below.
// =====================================================================

// DDA shared by the data views: a function `name(ro, rd, t0, ax0) -> DataMarch`.
// `body` runs for every voxel the ray visits inside a brick holding matter,
// with cell, a (state A), id, n (entry face normal), hp (entry point), seg,
// tEnter, tExit, occ (the brick's info word), prevId and airOn (the brick's
// air has something this view draws) in scope, and col, trans, tHit to
// update; it may `break` (after setting trans/tHit). Bricks holding only air
// are integrated in one go by `hooks.airBrick` (chord tB0..tB1 through brick
// bc) instead of voxel by voxel, which is what keeps big clouds cheap. `air`
// = the brick's air bits this view draws (AIR_HOT, AIR_PRESSURE, AIR_FLOW;
// shaders/bindings.js). hooks.decl: declarations; hooks.onBrick: runs on
// entering each brick; hooks.flush: composites anything deferred that the ray
// has now passed. `floor`: the floor's colour at hp.
const march = (name, air, body, floor, hooks = {}, curved = false) => {
  const { decl = '', onBrick = '', airBrick = '', flush = '' } = hooks;
  // Curved (the rolling log: shaders/gfx/presentation.js), the walk takes the
  // displayed ray's parabola a chord at a time, each chord a straight ray of
  // its own (ro shifted back so ro + rd t is on it at the displayed ray's t):
  // the body and hooks run as they do flat, and tEnter, tHit are the displayed
  // ray's t, so the caller's depth is unchanged.
  return /* wgsl */ `
fn ${name}(ro0: vec3f, rd0: vec3f, t0: f32, ax0: i32) -> DataMarch {
  var ro = ro0;
  var rd = rd0;
  var col = vec3f(0.0);
  var trans = 1.0;
  var tHit = -1.0;
  var ax = ax0;
  var istp: vec3i;
  var tDelta: vec3f;
  var cell: vec3i;
  var tMax: vec3f;
  ddaStart(ro, rd, t0, &istp, &tDelta, &cell, &tMax);
  var tEnter = t0;
  var prevId = E_EMPTY;
  var lastB = vec3i(-1);
  var occ = 0u;
  var live = false;
  var airOn = false;${curved ? `
  var walk = warpWalk(ro, rd, t0);` : ''}
${decl}
  for (var i = 0; i < ${curved ? '2 * MAX_STEPS' : 'MAX_STEPS'}; i++) {${curved ? `
    var fp: vec3f;
    var ft: f32;
    if (warpFloor(walk, &fp, &ft)) { break; }
    var chord: f32;
    var exitAxis: i32;
    if (!warpSegment(&walk, &cell, &ro, &rd, &chord, &exitAxis)) { break; }
    tEnter = walk.t;
    ro -= rd * tEnter;
    ax = walk.axis;
    istp = vec3i(sign(rd));
    tMax = vec3f(WARP_INF);
    tMax[exitAxis] = tEnter + chord;` : ''}
    if (outside(cell)) { break; }
    let bc = cell / BS;
    if (${curved ? 'true' : 'any(bc != lastB)'}) {   // (curved: every chord, the brick's hooks read its ray)
      lastB = bc;
      occ = brickOcc(bc);
      airOn = (brickAir(occ) & ${air}) != 0u;
      live = brickMatter(occ) || airOn;
${onBrick}
    }
    if (!live) { ${curved ? 'warpSkip(&walk, bc, false);' : 'ax = skipBrick(bc, ro, rd, istp, &cell, &tMax, &tEnter);'} prevId = E_EMPTY; continue; }
    if (!brickMatter(occ)) {
      // only air: integrate the whole chord through the brick, then jump past it
${flush}
      let tB0 = tEnter;
      ${curved ? `tEnter = min(tMax.x, min(tMax.y, tMax.z));
      warpAdvance(&walk);` : 'ax = skipBrick(bc, ro, rd, istp, &cell, &tMax, &tEnter);'}
      let tB1 = tEnter;
${airBrick}
      prevId = E_EMPTY;
      if (tHit < 0.0 && trans < DATA_DEPTH_TRANS) { tHit = tB0; }
      if (trans < RAY_MIN_TRANS) { break; }
      continue;
    }
    let tExit = min(tMax.x, min(tMax.y, tMax.z));
    let seg = tExit - tEnter;
    let a = fetchA(cell);
    let id = eid(a);
    var n = vec3f(0.0);
    n[ax] = -f32(istp[ax]);
    let hp = ro + rd * tEnter;
${flush}
${body}
    if (tHit < 0.0 && trans < DATA_DEPTH_TRANS) { tHit = tEnter; }
    if (trans < RAY_MIN_TRANS) { break; }
    prevId = id;${curved ? `
    warpAdvance(&walk);
    if (warpCell(walk.ray, walk.t).y < 0) { break; }` : `
    tEnter = tExit;
    ax = ddaStep(istp, tDelta, &cell, &tMax);`}
  }
${flush}${curved ? `
  var floorP: vec3f;
  var floorT: f32;
  let onFloor = warpFloor(walk, &floorP, &floorT);` : ''}
  if (trans >= RAY_MIN_TRANS && ${curved ? 'onFloor' : 'cell.y < 0 && rd.y < 0.0'}) {
    let tf = ${curved ? 'floorT' : '-ro.y / rd.y'};
    let hp = ${curved ? 'floorP' : 'ro + rd * tf'};
    col += trans * (${floor});
    if (tHit < 0.0) { tHit = tf; }
    trans = 0.0;
  }
  return DataMarch(col, trans, tHit);
}
`;
};

// An opaque surface ends the ray.
const solidHit = (c) => `
      col += trans * (${c});
      trans = 0.0;
      if (tHit < 0.0) { tHit = tEnter; }
      break;`;

// What every data view shares: the march's result, colour helpers, clay
// lighting, the floor and the gas constants.
const DATA_COMMON = /* wgsl */ `
struct DataMarch {
  col: vec3f,     // premultiplied colour
  trans: f32,     // transmittance left
  tHit: f32,      // where the ray became mostly opaque (-1: never)
}
var<private> gPix: f32 = 0.0;   // angular size of a pixel (radians), for anti-aliasing thin strokes

// Depth goes where the ray's transmittance first drops below this.
const DATA_DEPTH_TRANS: f32 = 0.5;
const DATA_MIN_ALPHA: f32 = 0.002;   // pixels covered less than this are left empty
// Colour maps are interpolated in sRGB, approximated here by a pure power.
const DATA_GAMMA: f32 = 2.2;
fn toLinear(c: vec3f) -> vec3f { return pow(c, vec3f(DATA_GAMMA)); }
fn toSrgb(c: vec3f) -> vec3f { return pow(c, vec3f(1.0 / DATA_GAMMA)); }
fn luma(c: vec3f) -> f32 { return dot(c, LUMA_709); }   // Rec. 709 weights (shaders/common.js)

${colormapWGSL('heat', COLORMAPS.heat)}
${colormapWGSL('pressure', COLORMAPS.pressure)}
${colormapWGSL('flowDir', COLORMAPS.flowDir)}
${colormapWGSL('flowSpeed', COLORMAPS.flowSpeed)}

// Clay lighting: ambient, plus sun by n·l, plus sky by how much the face
// looks up, darkened by corner AO down to CLAY_AO_MIN.
const CLAY_AMBIENT: f32 = 0.45;
const CLAY_SUN: f32 = 0.41;
const CLAY_SKY: f32 = 0.21;
const CLAY_AO_MIN: f32 = 0.6;
const CLAY_AO_GAIN: f32 = 0.4;   // 1 - CLAY_AO_MIN
fn clay(cell: vec3i, hp: vec3f, n: vec3f) -> f32 {
  let ndl = max(dot(n, FU.sun), 0.0);
  let ao = faceAO(cell, vec3i(n), hp);
  return (CLAY_AMBIENT + CLAY_SUN * ndl + CLAY_SKY * (0.5 + 0.5 * n.y)) * (CLAY_AO_MIN + CLAY_AO_GAIN * ao);
}

// The floor: colour lo with grid lines of colour hi, darkened by corner AO.
// The lines' width from the ray's screen derivatives (gfx/surface.js floorFwidth).
const DATA_FLOOR_GRID: f32 = 8.0;     // grid line spacing, cells
const DATA_FLOOR_AO_MIN: f32 = 0.5;   // floor brightness where fully occluded
fn dataFloor(hp: vec3f, rd: vec3f, lo: vec3f, hi: vec3f) -> vec3f {
  let q = worldPos(hp).xz / DATA_FLOOR_GRID;
  let gq = abs(fract(q - 0.5) - 0.5) / max(floorFwidth(hp, rd) / DATA_FLOOR_GRID, vec2f(1e-4));
  let line = 1.0 - min(min(gq.x, gq.y), 1.0);
  let ao = faceAO(vec3i(i32(floor(hp.x)), -1, i32(floor(hp.z))), vec3i(0, 1, 0), hp);
  return mix(lo, hi, line) * (DATA_FLOOR_AO_MIN + (1.0 - DATA_FLOOR_AO_MIN) * ao);
}

// Neutral stand-in for a material: its own lightness, no hue.
const NEUTRAL_BASE: f32 = 0.05;   // grey of a black material ...
const NEUTRAL_GAIN: f32 = 0.2;    // ... plus this times sqrt(luma)
fn neutral(id: i32) -> vec3f { return vec3f(NEUTRAL_BASE + NEUTRAL_GAIN * sqrt(luma(COLOR(id)))); }

// Gas in the heat and flow views: blob density times a base plus a share for
// how much of the brick is gas (brickGas), so a cloud's core reads denser.
const GAS_VIEW_DENS: f32 = 0.4;
const GAS_VIEW_DENS_LOCAL: f32 = 2.0;
// a smoke cell's density fades with its life
fn gasLife(id: i32, a: vec4f) -> f32 { return select(1.0, clamp(a.z, 0.0, 1.0), id == E_SMOKE); }
`;

const HEAT = (curved) => /* wgsl */ `
// ---- heat ----
// Air glows faintly where it is warmer or colder than the room: from
// HEAT_AIR_MIN_DT off ambient, reaching full strength HEAT_AIR_OCTAVES
// doublings of that further out.
const HEAT_AIR_MIN_DT: f32 = 3.0;    // °C
const HEAT_AIR_OCTAVES: f32 = 8.0;
const HEAT_AIR_EMIT: f32 = 0.045;    // emission per cell at full strength
const HEAT_AIR_ABSORB: f32 = 0.5;    // absorption per unit of emission
fn heatAir(T: f32, ds: f32, col: ptr<function, vec3f>, trans: ptr<function, f32>) {
  let d = abs(T - AMBIENT);
  if (d <= HEAT_AIR_MIN_DT) { return; }
  let s = clamp(log2(d * (1.0 / HEAT_AIR_MIN_DT)) * (1.0 / HEAT_AIR_OCTAVES), 0.0, 1.0);   // 3 °C -> 0, 770 °C -> 1
  let e = HEAT_AIR_EMIT * s * s * ds;
  *col += *trans * heatColor(T) * e;
  *trans *= exp(-HEAT_AIR_ABSORB * e);
}
const HEAT_FIRE_K: f32 = 0.6;       // extinction per cell per unit blob density: fire ...
const HEAT_GAS_K: f32 = 0.3;        // ... and the other gases
const HEAT_GLASS_K: f32 = 0.5;      // extinction per cell of glass
const HEAT_GLASS_GAIN: f32 = 0.85;  // brightness of its colour
const HEAT_CLAY: f32 = 0.7;         // share of solids' colour that is clay-lit (the rest unlit)
const HEAT_FLOOR_LO: f32 = 0.3;     // floor: ambient's colour times this ...
const HEAT_FLOOR_HI: f32 = 0.6;     // ... and this on the grid lines
const HEAT_AIR_SAMPLES: i32 = 7;    // most samples along an air-only brick (one per cell)
${march('marchHeat', 'AIR_HOT', /* wgsl */ `
    if (id != E_EMPTY) {
      let T = a.y;
      if (KIND(id) == K_GAS) {
        // steam, smoke and flames: soft blobs coloured by their temperature
        let local = brickGas(occ);
        let dens = softBlob(cell, ro, rd, tEnter, tExit) * (GAS_VIEW_DENS + GAS_VIEW_DENS_LOCAL * local) * gasLife(id, a);
        let al = 1.0 - exp(-select(HEAT_GAS_K, HEAT_FIRE_K, id == E_FIRE) * seg * dens);
        col += trans * al * heatColor(T);
        trans *= 1.0 - al;
      } else if (id == E_GLASS) {
        // glass is opaque to a real thermal camera, but here a container
        // shouldn't hide what's inside: a thin pane showing its temperature
        let al = 1.0 - exp(-HEAT_GLASS_K * seg);
        col += trans * al * heatColor(T) * HEAT_GLASS_GAIN;
        trans *= 1.0 - al;
      } else {${solidHit('heatColor(T) * mix(1.0, clay(cell, hp, n), HEAT_CLAY)')}
      }
    } else {
      heatAir(a.y, seg, &col, &trans);
    }`, 'dataFloor(hp, rd, heatColor(AMBIENT) * HEAT_FLOOR_LO, heatColor(AMBIENT) * HEAT_FLOOR_HI)', {
  airBrick: /* wgsl */ `
      let ns = clamp(i32(ceil(tB1 - tB0)), 1, HEAT_AIR_SAMPLES);
      let ds = (tB1 - tB0) / f32(ns);
      for (var j = 0; j < HEAT_AIR_SAMPLES; j++) {
        if (j >= ns) { break; }
        let p = ro + rd * (tB0 + (f32(j) + 0.5) * ds);
        heatAir(fetchA(clamp(vec3i(floor(p)), vec3i(0), GRID - 1)).y, ds, &col, &trans);
      }`,
}, curved)}`;

const PRESSURE = (curved) => /* wgsl */ `
// ---- pressure ----
// Pressure is a smooth field, so the cloud samples it trilinearly at the
// middle of the ray's path through each voxel: shock fronts read as smooth
// surfaces instead of voxel staircases.
fn pressureAt(p: vec3f) -> f32 {
  let q = p - 0.5;
  let i0 = vec3i(floor(q));
  let f = q - vec3f(i0);
  var s = 0.0;
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1u) & 1, (k >> 2u) & 1);
    let w = mix(1.0 - f, f, vec3f(o));
    s += fetchB(clamp(i0 + o, vec3i(0), GRID - 1)).w * w.x * w.y * w.z;
  }
  return s;
}

// The pressure field as a cloud, denser the stronger it is. Strength s is the
// legend's distance from ambient (its middle), 0..1.
const PRESSURE_CLOUD_MIN: f32 = 0.15;   // s below which air stays clear
const PRESSURE_CLOUD_K: f32 = 0.3;      // extinction per cell at s = 1
fn pressureCloud(Pr: f32, ds: f32, col: ptr<function, vec3f>, trans: ptr<function, f32>) {
  let s = abs(pressurePos(Pr) - 0.5) * 2.0;   // 0 ambient, .25 at |P|=0.1, .5 at 1, 1 at 100
  if (s <= PRESSURE_CLOUD_MIN) { return; }
  let al = 1.0 - exp(-PRESSURE_CLOUD_K * s * s * sqrt(s) * ds);
  *col += *trans * al * pressureColor(Pr);
  *trans *= 1.0 - al;
}
const PRESSURE_GAS_K: f32 = 0.06;        // gas wisps: extinction per cell per unit blob density
const PRESSURE_GAS_GREY: vec3f = vec3f(0.12);
const PRESSURE_GLASS_K: f32 = 0.18;      // extinction per cell: glass ...
const PRESSURE_LIQUID_K: f32 = 0.06;     // ... liquids and ice
const PRESSURE_CLEAR_GAIN: f32 = 0.8;    // brightness of their grey
const PRESSURE_PAINT_LO: f32 = 0.2;      // strength where pressure paint starts to show ...
const PRESSURE_PAINT_HI: f32 = 0.6;      // ... and has taken over
const PRESSURE_FLOOR_LO: vec3f = vec3f(0.012);
const PRESSURE_FLOOR_HI: vec3f = vec3f(0.03);
const PRESSURE_AIR_RATE: f32 = 0.8;      // cloud samples per cell along an air-only brick ...
const PRESSURE_AIR_SAMPLES: i32 = 6;     // ... and at most this many
${march('marchPressure', 'AIR_PRESSURE', /* wgsl */ `
    let k = KIND(id);
    if (airOn && k != K_SOLID) { pressureCloud(pressureAt(ro + rd * (tEnter + 0.5 * seg)), seg, &col, &trans); }
    if (id != E_EMPTY) {
      if (k == K_GAS) {
        // smoke/steam/fire stay visible as faint grey wisps
        let al = 1.0 - exp(-PRESSURE_GAS_K * seg * softBlob(cell, ro, rd, tEnter, tExit));
        col += trans * al * PRESSURE_GAS_GREY;
        trans *= 1.0 - al;
      } else if (RCLASS(id) == R_LIQUID || RCLASS(id) == R_GLASS) {
        // liquids, glass and ice: translucent grey, so pressure inside shows
        // (a thin pane seen edge-on is longer along the ray, so it outlines itself)
        let al = 1.0 - exp(-select(PRESSURE_LIQUID_K, PRESSURE_GLASS_K, id == E_GLASS) * seg);
        col += trans * al * neutral(id) * PRESSURE_CLEAR_GAIN;
        trans *= 1.0 - al;
      } else {
        // pressure-sensitive paint: the face takes the colour of the
        // pressure pushing on it from the cell in front
        let fc = cell + vec3i(n);
        var Pf = 0.0;
        if (!outside(fc)) { Pf = fetchB(fc).w; }
        var Pc = 0.0;
        if (k != K_SOLID) { Pc = fetchB(cell).w; }
        let Pm = select(Pc, Pf, abs(Pf) > abs(Pc));
        let sm = abs(pressurePos(Pm) - 0.5) * 2.0;
        let pc = mix(neutral(id), pressureColor(Pm), smoothstep(PRESSURE_PAINT_LO, PRESSURE_PAINT_HI, sm));${solidHit('pc * clay(cell, hp, n)')}
      }
    }`, 'dataFloor(hp, rd, PRESSURE_FLOOR_LO, PRESSURE_FLOOR_HI)', {
  airBrick: /* wgsl */ `
      let ns = clamp(i32(ceil((tB1 - tB0) * PRESSURE_AIR_RATE)), 1, PRESSURE_AIR_SAMPLES);
      let ds = (tB1 - tB0) / f32(ns);
      for (var j = 0; j < PRESSURE_AIR_SAMPLES; j++) {
        if (j >= ns) { break; }
        pressureCloud(pressureAt(ro + rd * (tB0 + (f32(j) + 0.5) * ds)), ds, &col, &trans);
      }`,
}, curved)}`;

const FLOW = (curved, backend = 'box') => /* wgsl */ `
// ---- flow ----
// Can particle a displace b moving down (0), up (1) or sideways (2)? Mirrors
// canMove() in common.js.
fn canDisplace(a: i32, b: i32, dir: i32) -> bool {
  if (KIND(a) == K_SOLID || KIND(b) == K_SOLID || a == b) { return false; }
  if (isGasLike(a) && isGasLike(b)) { return true; }
  if (!isFluid(a) && !isFluid(b)) { return false; }
  let da = DENS(a);
  let db = DENS(b);
  if (dir == 0) { return da > db; }
  if (dir == 1) { return da != db; }
  return db < da;
}
// The part of a particle's velocity that actually moves it: components
// pointing into something the particle can't displace (a wall, the same
// material, a denser grain), like a flowing liquid's push against the side
// of its basin, are dropped. A liquid's free surface also churns sideways at
// random as the automaton levels it, so sideways motion only counts for
// liquid that isn't resting on more of itself (a film spreading, a stream
// crossing ground).
const FLOW_MIN_VEL: f32 = 0.01;   // velocity components below this (cells/step) don't move it
fn mobileVel(c: vec3i, id: i32, v0: vec3f) -> vec3f {
  var v = v0;
  if (KIND(id) == K_LIQUID && c.y > 0 && eid(fetchA(c - vec3i(0, 1, 0))) == id) { v = vec3f(0.0, v.y, 0.0); }
  var r = vec3f(0.0);
  for (var k = 0; k < 3; k++) {
    if (abs(v[k]) < FLOW_MIN_VEL) { continue; }
    var q = c;
    q[k] += select(-1, 1, v[k] > 0.0);
    var nb = E_WALL;
    if (!outside(q)) { nb = eid(fetchA(q)); }
    var dir = 2;
    if (k == 1) { dir = select(1, 0, v.y < 0.0); }
    if (canDisplace(id, nb, dir)) { r[k] = v[k]; }
  }
  return r;
}
// Colour for a velocity: hue from its direction (falling blue, sideways
// green, rising amber), mixed in from 'still' by w = speed position.
fn flowTint(still: vec3f, v: vec3f, w: f32) -> vec3f {
  let hue = flowDirSrgb(flowDirPos(v.y / max(length(v), 1e-6)));
  return toLinear(mix(toSrgb(still), hue, w));
}

// Moving air is drawn as one stroke per brick (4³ cells): through a jittered
// point near the brick's centre, along the air's velocity there, longer when
// faster and brighter toward its head, so together they read as a 3D field
// of arrows. Returns the stroke's coverage of this ray (0..1), the velocity
// *v sampled for the brick (zero where there is matter) and where along the
// ray the stroke is (*gt).
const FLOW_MIN_SPEED: f32 = 0.06;        // air slower than this (cells/step) draws nothing ...
const FLOW_FULL_SPEED: f32 = 0.2;        // ... and is fully faded in by this
const FLOW_STROKE_LEN: f32 = 0.5;        // stroke half-length (cells) at the slowest ...
const FLOW_STROKE_LEN_GAIN: f32 = 0.9;   // ... plus this at the top of the speed legend
const FLOW_STROKE_RADIUS: f32 = 0.09;    // stroke radius, cells ...
const FLOW_STROKE_RADIUS_PX: f32 = 0.8;  // ... widened to at least this many pixels (and fainter for it)
const FLOW_STROKE_EDGE_OUT: f32 = 1.6;   // coverage fades from 0 at this many radii ...
const FLOW_STROKE_EDGE_IN: f32 = 0.4;    // ... to full at this many
const FLOW_STROKE_TAIL: f32 = 0.2;       // brightness at the tail ...
const FLOW_STROKE_HEAD_GAIN: f32 = 0.8;  // ... plus this at the head
fn brickStroke(bc: vec3i, ro: vec3f, rd: vec3f, ta: f32, tb: f32, check: bool, v: ptr<function, vec3f>, gt: ptr<function, f32>) -> f32 {
  let wb = bc + H.origin / BS;   // the jitter is the world brick's
  let hs = pcg(u32(wb.x) | (u32(wb.y) << 10u) | (u32(wb.z) << 20u));
  let cc = vec3f(bc * BS) + 0.5 * f32(BS) + (vec3f(vec3u(hs, hs >> 8u, hs >> 16u) & vec3u(255u)) * (1.0 / 255.0) - 0.5);
  let c = vec3i(floor(cc));
  *v = vec3f(0.0);
  *gt = ta;
  if (check && eid(fetchA(c)) != E_EMPTY) { return 0.0; }
  *v = fetchB(c).xyz;
  let sp = length(*v);
  if (sp < FLOW_MIN_SPEED) { return 0.0; }
  let w = flowSpeedPos(sp);
  let h = FLOW_STROKE_LEN + FLOW_STROKE_LEN_GAIN * w;   // half-length, cells
  let d = *v / sp;
  let w0 = ro - cc;
  let b = dot(rd, d);
  let dr = dot(rd, w0);
  let dw = dot(d, w0);
  let sl = clamp((dw - b * dr) / max(1.0 - b * b, 1e-4), -h, h);
  *gt = clamp(dot(cc + d * sl - ro, rd), ta, tb);
  let dist = length(ro + rd * (*gt) - cc - d * sl);
  let r = max(FLOW_STROKE_RADIUS, *gt * gPix * FLOW_STROKE_RADIUS_PX);
  return smoothstep(r * FLOW_STROKE_EDGE_OUT, r * FLOW_STROKE_EDGE_IN, dist) * min(1.0, FLOW_STROKE_RADIUS / r)
       * (FLOW_STROKE_TAIL + FLOW_STROKE_HEAD_GAIN * (sl / h * 0.5 + 0.5))
       * smoothstep(FLOW_MIN_SPEED, FLOW_FULL_SPEED, sp);
}
const FLOW_STROKE_ALPHA: f32 = 0.8;      // a stroke's opacity at full coverage
const FLOW_HAZE_K: f32 = 0.006;          // haze of moving air: emission per cell at full speed
const FLOW_ABSORB: f32 = 0.6;            // haze and strokes absorb this per unit of emission
const FLOW_GAS_K: f32 = 0.25;            // gas: extinction per cell per unit blob density
const FLOW_GAS_STILL: vec3f = vec3f(0.03);   // colour of still gas
const FLOW_GLASS_K: f32 = 0.18;          // extinction per cell of glass
const FLOW_GLASS_GREY: vec3f = vec3f(0.05);
const FLOW_STILL_SAT: f32 = 0.35;        // still matter keeps this much of its colour's saturation ...
const FLOW_STILL_GAIN: f32 = 0.35;       // ... at this brightness
const FLOW_FLOOR_LO: vec3f = vec3f(0.01);
const FLOW_FLOOR_HI: vec3f = vec3f(0.028);
${march('marchFlow', 'AIR_FLOW', /* wgsl */ `
    if (id == E_EMPTY) {
      // moving air: faint haze from the brick's sampled velocity
      if (hazeW > 0.0) {
        let al = hazeW * FLOW_HAZE_K * seg;
        col += trans * al * hazeCol;
        trans *= 1.0 - FLOW_ABSORB * al;
      }
    } else if (KIND(id) == K_GAS) {
      let v = fetchB(cell).xyz;
      let local = brickGas(occ);
      let dens = softBlob(cell, ro, rd, tEnter, tExit) * (GAS_VIEW_DENS + GAS_VIEW_DENS_LOCAL * local) * gasLife(id, a);
      let al = 1.0 - exp(-FLOW_GAS_K * seg * dens);
      col += trans * al * flowTint(FLOW_GAS_STILL, v, flowSpeedPos(length(v)));
      trans *= 1.0 - al;
    } else if (id == E_GLASS) {
      let al = 1.0 - exp(-FLOW_GLASS_K * seg);
      col += trans * al * FLOW_GLASS_GREY;
      trans *= 1.0 - al;
    } else {
      let v = mobileVel(cell, id, fetchB(cell).xyz);
      let w = flowSpeedPos(length(v));
      let still = mix(vec3f(luma(COLOR(id))), COLOR(id), FLOW_STILL_SAT) * FLOW_STILL_GAIN;${solidHit('flowTint(still, v, w) * clay(cell, hp, n)')}
    }`, 'dataFloor(hp, rd, FLOW_FLOOR_LO, FLOW_FLOOR_HI)', {
  decl: /* wgsl */ `
  var hazeW = 0.0;
  var gT = 0.0;
  var gAl = 0.0;
  var hazeCol = vec3f(0.0);`,
  onBrick: /* wgsl */ `
      hazeW = 0.0;
      if (brickMatter(occ) && airOn) {
        // brick with matter: its stroke is composited once the ray gets
        // past it, and dropped if a surface hides it first
        let bmin = vec3f(bc * BS);
        let tb = ${backend === 'world' ? 'ddaCrossing(mix(bmin, bmin + f32(BS), step(vec3f(0.0), rd)) - ro, rd)' : '(mix(bmin, bmin + f32(BS), step(vec3f(0.0), rd)) - ro) / rd'};
        var v: vec3f;
        gAl = FLOW_STROKE_ALPHA * brickStroke(bc, ro, rd, tEnter, min(tb.x, min(tb.y, tb.z)), true, &v, &gT);
        let sp = length(v);
        hazeW = flowSpeedPos(sp) * smoothstep(FLOW_MIN_SPEED, FLOW_FULL_SPEED, sp);
        hazeCol = flowTint(vec3f(0.0), v, 1.0);
      }`,
  flush: /* wgsl */ `
    if (gAl > 0.0 && tEnter >= gT) {
      col += trans * gAl * hazeCol;
      trans *= 1.0 - FLOW_ABSORB * gAl;
      gAl = 0.0;
    }`,
  airBrick: /* wgsl */ `
      var v: vec3f;
      var gt: f32;
      let cov = brickStroke(bc, ro, rd, tB0, tB1, false, &v, &gt);
      let sp = length(v);
      if (sp > FLOW_MIN_SPEED) {
        let al = flowSpeedPos(sp) * smoothstep(FLOW_MIN_SPEED, FLOW_FULL_SPEED, sp) * FLOW_HAZE_K * (tB1 - tB0) + FLOW_STROKE_ALPHA * cov;
        col += trans * al * flowTint(vec3f(0.0), v, 1.0);
        trans *= 1.0 - FLOW_ABSORB * al;
      }`,
}, curved)}`;

const XRAY = (curved) => /* wgsl */ `
// ---- X-ray ----
${xrayMu()}
// Element colour lifted toward a common lightness so dark materials still show.
const XRAY_LIGHTNESS: f32 = 0.4;     // the common lightness ...
const XRAY_LIFT: f32 = 0.6;          // ... and how far toward it
fn xrayColor(id: i32) -> vec3f {
  let c = COLOR(id);
  let L = luma(c);
  return c * (mix(L, XRAY_LIGHTNESS, XRAY_LIFT) / max(L, 1e-3));
}
const XRAY_DEPTH_CUE: f32 = 0.004;   // brightness 1 / (1 + this × cells of depth)
const XRAY_SHEET_INNER: f32 = 0.2;   // boundary sheet strength between two materials ...
const XRAY_SHEET_FACING: f32 = 0.5;  // ... times this when face-on (1 edge-on) ...
const XRAY_SHEET_OUTER: f32 = 0.05;  // ... and at an outer surface
const XRAY_SHEET_MU: f32 = 16.0;     // sheets scale with the material's XRAY_MU times this ...
const XRAY_SHEET_MIN: f32 = 0.2;     // ... clamped to [this, 1]
const XRAY_SHEET_GAIN: f32 = 1.6;    // sheet brightness
const XRAY_SHEET_ABSORB: f32 = 0.5;  // sheet absorption per unit strength
const XRAY_EMIT_GAIN: f32 = 1.15;    // emission relative to absorption
const XRAY_FLOOR_LO: vec3f = vec3f(0.006);
const XRAY_FLOOR_HI: vec3f = vec3f(0.022);
const XRAY_SOFT_CLIP: f32 = 1.25;    // exposure k of the final soft clip 1 - exp(-k c)
${march('marchXray', '0u', /* wgsl */ `
    // nearer things a little brighter, so depth reads without lighting
    let cue = 1.0 / (1.0 + XRAY_DEPTH_CUE * (tEnter - t0));
    if (id != prevId) {
      // A boundary shows as a thin sheet. Borders between two materials (the
      // structure inside piles and containers) are emphasised; outer surfaces
      // stay faint, since a thin shell seen edge-on already outlines itself
      // (and a grazing ray crosses a voxel wall's faces many times).
      let inner = id != E_EMPTY && prevId != E_EMPTY;
      let m = select(prevId, id, id != E_EMPTY);
      var sheet = XRAY_SHEET_OUTER;
      if (inner) { sheet = XRAY_SHEET_INNER * (XRAY_SHEET_FACING + (1.0 - XRAY_SHEET_FACING) * (1.0 - abs(dot(n, rd)))); }
      sheet *= clamp(XRAY_MU(m) * XRAY_SHEET_MU, XRAY_SHEET_MIN, 1.0);
      col += trans * sheet * xrayColor(m) * XRAY_SHEET_GAIN * cue;
      trans *= 1.0 - XRAY_SHEET_ABSORB * sheet;
    }
    if (id != E_EMPTY) {
      // emission a little above absorption, so overlaps add up like a radiograph
      let al = 1.0 - exp(-XRAY_MU(id) * seg);
      col += trans * al * xrayColor(id) * XRAY_EMIT_GAIN * cue;
      trans *= 1.0 - al;
    }`, 'dataFloor(hp, rd, XRAY_FLOOR_LO, XRAY_FLOOR_HI)', {}, curved)}`;

const DATA_MARCH = { heat: 'marchHeat', pressure: 'marchPressure', flow: 'marchFlow', xray: 'marchXray' };
const DATA_CODE = { heat: HEAT, pressure: PRESSURE, flow: FLOW, xray: XRAY };

// A data view's trace: its march, then the colour unpremultiplied and
// written linear (post's raw mode only encodes it to sRGB, so a fully lit
// surface still shows exactly its legend colour), at the depth where the ray
// became mostly opaque, else where it leaves the box.
const dataView = (view) => /* wgsl */ `
fn traceView(ro: vec3f, rd: vec3f, t0: f32, bh: vec3f) -> VolumeHit {
  let m = ${DATA_MARCH[view]}(ro, rd, t0, i32(bh.z));
  var o: VolumeHit;
  let alpha = 1.0 - m.trans;
  o.hit = alpha >= DATA_MIN_ALPHA;
  if (!o.hit) { return o; }
  var c = m.col / alpha;${view === 'xray' ? `
  c = 1.0 - exp(-XRAY_SOFT_CLIP * c);   // X-ray: soft clip, overlaps add up` : ''}
  o.color = vec4f(clamp(c, vec3f(0.0), vec3f(1.0)) * alpha, alpha);
  var td = bh.y;
  if (m.tHit >= 0.0) { td = m.tHit; }
  o.depth = volumeDepth(ro + rd * td);
  return o;
}`;

// =====================================================================
// The realistic view (0).
// =====================================================================

// Box and World in this view (CLAUDE.md "Same features in every world";
// parity audit 2026-10-20). Every branch below is the same picture, by
// different code:
// - interior: skips surface tests that cannot find a crossing (the brick and
//   its 26 neighbours are certified inside liquid: docs/v2/liquid-interior-
//   optimization.md), so it changes the cost, never the picture. Both brick
//   kernels write the bit (passes.js brickFrag; World's: worldCellAdapter.js).
//   World leaves out the neighbour test (core.js liquidInterior, a 27-trip
//   loop) to keep its cold-built volume small, and marches those cells in full.
// - LIQ_WINDOW_FADE, the edge fade after shadeSurf and the submerged tail
//   after the march: the Box window's edge, with the far field drawing what
//   lies past it (FU.far). World's volume is the whole world, with real cells
//   where that edge was. Nothing sets FU.far now (world maps draw with the
//   WORLD renderer, and the far field was retired in dc480f4f), so neither
//   renderer runs them.
// - format: World reads its own atlas, filled from the legacy A/B projection
//   (V2's exportLegacy), never V2's packed state, except V2's foam and air:
//   while V2 runs, World's live copies carry its foam (v2/nativeAeration.js,
//   liquidDetail.js WORLD_NATIVE), so the molten-foam layer after shadeSurf
//   draws it as the Box does, and its air (B: the Pressure and Flow views,
//   world/renderSource.js, the V2 air export).
const realistic = (detail, curved = false, backend = 'box', fixedReadFormat) => {
  const format = backend === 'world' ? '0u' : readFormatWGSL(fixedReadFormat);
  const grains = GRAINS_ANY(detail);
  const liq = LIQ_DETAIL(detail, backend);
  // World's atlas while V2 runs the box carries V2's foam (liquidDetail.js WORLD_NATIVE): the molten
  // liquids' native foam below is then compiled in as Box's format-2/3 programs compile it.
  // Certified liquid interiors (passes.js brickFrag): only the Box's brick kernel writes the certificate.
  const interior = !curved && backend !== 'world';
  // Intentional (V2 design, docs/v2.md §4.3): under V2 molten liquids (lava) carry foam as
  // every liquid row does, so the format-2/3 branch below layers it; V1 has no foam on them.
  return /* wgsl */ `
// Inside a liquid, sunlight fades with depth: the sun's visibility is read
// where the ray got in (shadow map) and then attenuated by the liquid between
// that height and the point, along the sun's slant (sun elevation floored at
// this sine, so a low sun doesn't black out everything).
const LIQ_SUN_Y_MIN: f32 = 0.2;
// Where liquids of different kinds share a brick (ice in water, acid mixing
// in), which one a segment is in is read at a per-pixel random offset of up to
// half this many cells, so their boundary is dithered across a cell, which
// TAA blends, instead of showing voxel steps inside the smooth surface.
const LIQ_ID_DITHER: f32 = 1.0;
// Leaving liquid, an opaque surface this close (cells) past the exit wins:
// sand under the water line is at both, and must not show a sliver of air.
const OPAQUE_TIE: f32 = 0.05;
// Glass reflects less from inside liquid than from air (the index contrast is
// smaller); share of its Fresnel reflectance kept there.
const GLASS_IN_LIQUID_F: f32 = 0.3;
// A pane reflects the scene, not just the sky: seen from inside a glass room
// the sky's reflection lies over the sky behind the pane and the pane vanishes;
// the room's floor and contents reflected in it are what show it is there.
// The first this many panes along the eye ray trace their reflection
// (reflectDefer, gfx/liquid.js); panes past them reflect the sky.
const GLASS_TRACED_PANES: i32 = 2;
const MAX_BENDS: i32 = 6;
${backend === 'world' ? '' : `// Fade unresolved underwater scenery over two bricks at the simulation edge.
// The window bounds data availability, not the extent of the water.
const LIQ_WINDOW_FADE: f32 = 2.0 * f32(BS);`}
const BEND_EXTRA_STEPS: i32 = ${BEND_EXTRA_STEPS};

// The opaque hit that ends the ray is recorded and shaded once, after the
// march: a GPU compiler inlines every call, so each call site of the surface
// code (materials, lighting) is another copy of it to compile, and the march
// has several ways to end on a surface.
const HIT_NONE: i32 = 0;
const HIT_CRISP: i32 = 1;    // a crisp voxel (hitCell, hitId, hitA; normal hitN)
const HIT_SMOOTH: i32 = 2;   // a smooth surface of channel hitCh (normal hitN; zero: the field's)
const HIT_GRAIN: i32 = 3;    // grain geometry (gfx/grains.js: gHitA, gHitK)

// Overlapping liquid must not hide an opaque field that already contains the ray.
fn surfInsideOpaque(phi: vec4f) -> i32 {
  var ch = -1;
  var best = SURF_ISO;
  for (var c = 1; c < 4; c++) {
    if (phi[c] >= best) { best = phi[c]; ch = c; }
  }
  return ch;
}

fn traceView(ro0: vec3f, rd0: vec3f, t0: f32, bh: vec3f) -> VolumeHit {
  var ro = ro0;
  let jit = stbn1(gFragCoord, f32(FU.frame), 0.0);   // the media march's start: stratified per 3x3 window, R1 over frames (noise.js)
  var mNext = jit * MEDIA_STEP;   // next media sample along the ray (gfx/media.js)
  var mOp = 0.0;                  // opacity of the media so far
  var rd = safeDir(rd0);${curved ? `
  // the rolling log (shaders/gfx/presentation.js): the displayed ray's parabola, walked a chord at a time
  var walk = warpWalk(ro, rd, P.marchNear);` : ''}

  // ray (ro, rd) and its DDA state; refraction restarts both
  var istp: vec3i;
  var tDelta: vec3f;
  var cell: vec3i;
  var tMax: vec3f;
  ddaStart(ro, rd, t0, &istp, &tDelta, &cell, &tMax);
  var tEnter = t0;
  var ax = i32(bh.z);

  var col = vec3f(0.0);
  var trans = vec3f(1.0);
  var anyHit = false;
  var hitPos = vec3f(0.0);
  var liq = E_EMPTY;          // smooth liquid the ray is inside (E_EMPTY = air)
  var prevCrisp = E_EMPTY;    // crisp transparent cell the ray just came through
  var panes = 0;              // glass runs entered so far
  var paneEnv = vec3f(0.0);   // what the current pane's front face reflects ...
  var paneAx = -1;            // ... and the axis of that face
  var paneRefl = false;       // ... and whether that is the pixel's traced reflection (reflectDefer)
  var mediumLight = vec3f(1.0);
  // sun visibility inside liquid: read at a reference point (where the ray
  // got in), then faded with depth below it
  var lightRef = vec3f(1.0);
  var lightY = 0.0;
  let liqDither = (stbn3(gFragCoord, f32(FU.frame)) - 0.5) * LIQ_ID_DITHER;   // spatiotemporal, not white: no speckle on mixed liquids (noise.js)
  var bends = 0;
  // Mark terminal surfaces explicitly. On Metal, a post-loop hitK test
  // dropped opaque shading in some lanes, losing both colour and opacity.
  // Use the same boolean for traversal and shading (check-opaque-surface.mjs).
  var stop = false;
  // the nearest opaque mesh (gfx/meshCut.js), counted along the ray's path:
  // tCut is in the current ray's t, which restarts at every bend.
  var tCut = meshCutT(rd);${curved ? `
  // Depth measures the displayed ray; convert it to the curved path's length.
  // Keep the remaining budget across chords, brick skips and optical restarts.
  var meshBudget = MESH_CUT_NONE;
  if (tCut < MESH_CUT_NONE) { meshBudget = warpArc(walk.ray, 0.0, max(tCut, 0.0)); }` : ''}
  var cut = false;
  // A liquid surface the ray refracts at (liquidInterface), handled at the top
  // of the march's next step: the box wall the ray enters liquid through and
  // every bend share its one call site (a GPU compiler inlines each call).
  var ifPend = false;
  var ifEntry = false;   // (the box wall: its restart keeps the march's brick and axis)
  var ifP = vec3f(0.0);
  var ifN = vec3f(0.0);
  var ifG = vec3f(0.0);
  var ifEnter = false;
  var ifLid = E_EMPTY;
  var ifMirror = false;
  var ifT = 0.0;${grains ? `
  var altRefl = false;   // the hand-off band's stored path (gAltCol) came after a traced reflection` : ''}

  var lastB = vec3i(-1);
  var flags = 0u;
  var bid = 0u;              // the brick's number (brickId(lastB)) ...
  var occM = vec2u(0u);      // ... and its occupancy mask (shaders/occupancy.js), loaded with flags
  var phiA = surfSample(${curved ? 'warpAt(walk.ray, walk.t)' : 'ro + rd * tEnter'});   // fields at the current segment start
  var phiStale = false;${interior ? `
  var interiorLiquid = false;   // final fields prove this brick has no surface crossing` : ''}
  // the hit that ends the ray (HIT_*), shaded after the march
  var hitK = HIT_NONE;
  var hitCh = -1;
  var hitId = E_EMPTY;
  var hitP = vec3f(0.0);
  var hitN = vec3f(0.0);
  var hitCell = vec3i(0);
  var hitA = vec4f(0.0);

  // Nothing is drawn past the cut: the march below stops there, and every
  // surface, pane face, grain and relief hit is tested against it, so the
  // nearer-depth rule (meshCutDepth) never lets something behind a mesh paint
  // over it. (The GL build had the depth test of its plain hit depth for that.)

${curved ? '' : `  // Entering the box inside a smooth material: the box wall cuts it open
  // (unless a mesh stands in front of the wall).
  if (tEnter < tCut) {
    let opaque = surfInsideOpaque(phiA);
    let ch = select(select(-1, CH_LIQUID, phiA.x >= SURF_ISO), opaque, opaque >= 0);
    if (ch >= 0) {
      var n0 = vec3f(0.0);
      n0[ax] = -f32(istp[ax]);
      let hp = ro + rd * tEnter;
      anyHit = true;
      hitPos = hp;
      if (ch != CH_LIQUID) {
        // started inside it, not at the box wall (the camera in a pile, or its near clip): the cut faces the eye
        hitK = HIT_SMOOTH; stop = true; hitP = hp; hitN = select(n0, -rd, t0 > bh.x); hitCh = ch;
      } else {
        let lid = liquidIdAt(hp - n0 * IFACE_PROBE, E_WATER);
        // An immersed camera/near clip is not an air-water interface.
        if (t0 > bh.x) {
          liq = liquidIdAt(hp, lid);
          gSkyIn = skyInAt(probeAt(hp));
        } else {
          // refracted in at the march's first step (liquidInterface(hp, n0, n0, true, lid, false, ...))
          ifPend = true; ifEntry = true; ifP = hp; ifN = n0; ifG = n0; ifEnter = true; ifLid = lid; ifMirror = false; ifT = tEnter;
        }
        lightRef = vec3f(1.0);
        if (FU.shadows != 0u) { lightRef = sunShadowAt(select(hp - n0 * IFACE_PROBE, hp, t0 > bh.x)); }   // inside: the map carries the liquid above
        lightY = hp.y;
      }
    }
  }
`}
  // (one trip more than the march's steps: a surface met on the last step still refracts)
  for (var i = 0; i <= ${curved ? '2 * MAX_STEPS' : 'MAX_STEPS'} + BEND_EXTRA_STEPS; i++) {
    if (ifPend) {
      ifPend = false;
      // the scene shows in the reflection only off the first surface the eye ray meets (ifMirror)
      let inside = liquidInterface(ifP, ifN, ifG, ifEnter, ifLid, ifMirror, &ro, &rd, &col, &trans, &mediumLight);
      tCut -= ifT;
      rd = safeDir(rd); cell = vec3i(floor(ro)); ddaInit(ro, rd, cell, &istp, &tDelta, &tMax);
      tEnter = 0.0;
      phiA = surfSample(ro);${curved ? '' : `
      if (ifEntry) {
        if (inside) { liq = ifLid; }
      } else {`}
        liq = select(E_EMPTY, ifLid, inside);
        if (ifEnter) { lightRef = mediumLight; lightY = ifP.y; }
        lastB = vec3i(-1); ax = 1;
        gThin = brickThin(brickInfo(clamp(cell, vec3i(0), GRID - 1) / BS));
        phiStale = false;${curved ? `
        meshBudget = tCut;
        warpRestart(&walk, ro, rd);` : ''}
        // restarted inside something opaque (sand under the water line)
        let oc = surfInsideOpaque(phiA);
        if (oc > 0) {
          hitK = HIT_SMOOTH; stop = true; hitP = ro; hitN = vec3f(0.0); hitCh = oc;
          break;
        }${curved ? '' : `
      }`}
    }
    if (i == ${curved ? '2 * MAX_STEPS' : 'MAX_STEPS'} + BEND_EXTRA_STEPS) { break; }${curved ? `
    // the next chord, as a ray of its own from its start (t restarts there, as at a bend)
    var fp: vec3f;
    var ft: f32;
    if (warpFloor(walk, &fp, &ft)) { break; }
    var chord = 0.0;
    var exitAxis = 0;
    if (!warpSegment(&walk, &cell, &ro, &rd, &chord, &exitAxis)) { break; }
    if (meshBudget < MESH_CUT_NONE) { tCut = max(0.0, meshBudget - warpArc(walk.ray, 0.0, walk.t)); }
    tEnter = 0.0;
    ax = walk.axis;
    istp = vec3i(sign(rd));
    tMax = vec3f(WARP_INF);
    tMax[exitAxis] = chord;
    phiA = surfSample(ro);
    phiStale = true;` : ''}
    if (stop || outside(cell)) { break; }
    if (tEnter >= tCut) { cut = true; break; }
    let bc = cell / BS;
    if (any(bc != lastB)) {
      lastB = bc;
      bid = brickId(bc);
      flags = brickInfoOf(bid);
      gThin = brickThin(flags);
      if (flags != 0u) { occM = occMaskOf(bid); }${interior ? `
      interiorLiquid = false;
      if (liq != E_EMPTY && (flags & BRICK_LIQUID_INTERIOR) != 0u) {
        interiorLiquid = liquidInterior(bc);
      }` : ''}
    }
    if (flags == 0u) {
      ${curved ? 'warpSkip(&walk, bc, true);' : 'ax = skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter);'}
      prevCrisp = E_EMPTY;
      phiStale = true;
      continue;
    }
    let tExit = min(tMax.x, min(tMax.y, tMax.z));
    // The cell's element from the brick's occupancy (shaders/occupancy.js),
    // what eid(fetchA(cell)) reads: an empty cell reads nothing, any other
    // one byte. State A itself is read only where its values are used (the
    // crisp hit, a pane, a grain, a liquid's own cell): an empty cell's are
    // never, so its march reads no state at all.
    let id = occCellId(occM, bid, cell);${curved ? '' : `
    // An empty cell of a brick that holds crisp matter only (no smooth
    // surface or media reaching it), out of liquid and before the mesh cut,
    // draws nothing: the body below would only note that it passed it (and,
    // with grains, look for the gravel's pebbles in it, gPebInside). Pass it
    // here as the body would, with the same DDA arithmetic and the same loop
    // count, so every hit is the one the full march finds, at the same t.
    if (id == E_EMPTY && (flags & (BRICK_SURF | BRICK_MEDIA)) == 0u && liq == E_EMPTY && tExit < tCut${grains ? ' && !gPebInside' : ''}) {
      prevCrisp = E_EMPTY;
      phiStale = true;
      phiA = vec4f(0.0);   // (the body's phiB: no smooth surface here)
      if (max(trans.x, max(trans.y, trans.z)) < RAY_MIN_TRANS) { break; }
      ax = argmin3(tMax);
      tEnter = tExit;
      cell[ax] += istp[ax];
      tMax[ax] += tDelta[ax];
      continue;
    }`}

    if (isCrisp(id)) {
      // ---- crisp voxel ----
      var nFace = vec3f(0.0);
      nFace[ax] = -f32(istp[ax]);
      if (id == E_CRYSTAL) {
        var th = tEnter;
        var nh = nFace;
        if (crystalHit(cell, ro, rd, tEnter, tExit, &th, &nh)) {
          if (th > tCut) { cut = true; break; }
          let hp = ro + rd * th;
          if (!anyHit) { anyHit = true; hitPos = hp; }
          let path = crystalInterface(gCrys, hp, nh, rd, gCrysKind == CRYS_CUT, liq, bends < MAX_BENDS,
                                      max(tCut - th, 0.0), fetchA(cell).y, &col, &trans);
          if (path.clipped != 0u) { cut = true; break; }
          if (max(trans.x, max(trans.y, trans.z)) < RAY_MIN_TRANS) { break; }
          bends += 2;
          tCut -= th + path.distance;
          ro = path.p;
          rd = safeDir(path.d);
          cell = vec3i(floor(ro));
          ddaInit(ro, rd, cell, &istp, &tDelta, &tMax);
          tEnter = 0.0; lastB = vec3i(-1); ax = 1;
          prevCrisp = E_EMPTY;
          mNext = jit * MEDIA_STEP;
          phiStale = true;${curved ? `
          warpRestart(&walk, ro, rd);` : ''}
          continue;
        }
        phiStale = true;
      } else if (RCLASS(id) != R_GLASS) {
        // the voxel's shape may be smaller than the cell (bevels): it can miss
        var th = tEnter;
        var nh = nFace;
        if (crispHit(cell, id, ro, rd, tEnter, tExit, &th, &nh)) {
          if (th > tCut) { cut = true; break; }   // (a bevelled voxel's face behind the mesh)
          let hp = ro + rd * th;
          if (!anyHit) { anyHit = true; hitPos = hp; }
          hitK = HIT_CRISP; stop = true; hitP = hp; hitN = nh; hitCell = cell; hitId = id; hitA = fetchA(cell);
          break;
        }
        phiStale = true;
      } else {
        let hp = ro + rd * tEnter;
        if (!anyHit) { anyHit = true; hitPos = hp; }
        let original = sourceMaterial(id, worldPos(hp), nFace);
        if (original.kind != 0u) {
          if (id != prevCrisp) {
            let alpha = select(1.0, original.alpha, (original.flags & 1u) != 0u);
            sourceBlend(sourceShade(worldPos(hp), original.normal, rd, original.albedo,
              original.roughness, original.metallic, original.f0, original.kind, original.flags) + original.emission,
              alpha, original.flags, &col, &trans);
          }
        } else {
        if (id != prevCrisp) {
          // glass interface (flat faces: no bending)
          let F = fresnelSchlick(abs(dot(nFace, rd)), IOR(id)) * select(GLASS_IN_LIQUID_F, 1.0, liq == E_EMPTY);
          mediumLight = vec3f(1.0);
          if (FU.shadows != 0u) { mediumLight = sunShadowAt(hp + nFace * IFACE_PROBE); }
          let gi = surfProbe(hp, nFace);
          gSkyIn = skyInAt(gi);
          let r = reflect(rd, nFace);
          paneEnv = envReflectGI(gi, nFace, -rd, ROUGH(id), mediumLight);
          paneRefl = panes < GLASS_TRACED_PANES && reflectDefer(hp + nFace * REFL_START, r, paneEnv);
          paneAx = ax;
          panes++;
          col += trans * F * paneEnv;
          if (paneRefl) { gReflK += trans * F; }
          trans *= 1.0 - F;
        }
        absorbDeco(id, cell, hp, min(tExit, tCut) - tEnter, mediumLight, fetchA(cell).y, &col, &trans);   // (stained glass: gfx/deco.js)
        // Leaving the pane, its far face reflects as much again (into air; less
        // into liquid; none against something opaque, which it touches, the
        // floor included, nor behind a mesh). A face parallel to the front one
        // reflects the same view.
        let xa = argmin3(tMax);
        var nc = cell;
        nc[xa] += istp[xa];
        var nid = E_EMPTY;
        if (!outside(nc)) { nid = eid(fetchA(nc)); }
        if (tExit < tCut && nc.y >= 0 && RCLASS(nid) != R_GLASS && RCLASS(nid) != R_OPAQUE) {
          var nX = vec3f(0.0);
          nX[xa] = f32(istp[xa]);
          let hx = ro + rd * tExit;
          let F = fresnelSchlick(abs(dot(nX, rd)), IOR(id)) * select(1.0, GLASS_IN_LIQUID_F, SURFCH(nid) == CH_LIQUID);
          let r = reflect(rd, nX);
          var env = paneEnv;
          if (xa != paneAx) { env = envSky(surfProbe(hx, -nX), r); }   // (inside the pane: no sun highlight, as liquid.js's exit)
          else if (paneRefl) { gReflK += trans * F; }   // (the front face's traced reflection again)
          col += trans * F * env;
          trans *= 1.0 - F;
        }
        }
        prevCrisp = id;
        phiStale = true;
      }
    } else {
      prevCrisp = E_EMPTY;
      // ---- smooth surfaces crossing this segment ----
      var ev = EV_NONE;
      var evCh = -1;
      var tEv = tExit;
      var evN = vec3f(0.0);   // forced normal (else from the field)
      var phiB = vec4f(0.0);${backend !== 'world' ? `
      // In certified liquid, keep every DDA segment, absorption, mixed ID,
      // paint, mesh cut and grain test. Only omit impossible surface events.
      // The else marks phi stale so leaving the certificate resamples the
      // actual entry value; never propagate a synthetic field to a boundary.` : ''}
      if (brickSurf(flags)${interior ? ' && !(liq != E_EMPTY && interiorLiquid)' : ''}) {
        if (phiStale) { phiA = surfSample(ro + rd * tEnter); }
        // A missed entry has no later entering crossing. Recover it in every
        // segment, including rays in liquid, not just after a brick/glass skip.
        let ic = surfInsideOpaque(phiA);
        if (ic >= 0) {
          ev = EV_OPAQUE; evCh = ic; tEv = tEnter; evN[ax] = -f32(istp[ax]);
        } else if (liq == E_EMPTY && phiA.x >= SURF_ISO) {
          liq = liquidIdAt(ro + rd * (tEnter + IFACE_PROBE), E_WATER);
          let p0 = ro + rd * tEnter;
          lightRef = vec3f(1.0);
          if (FU.shadows != 0u) { lightRef = sunShadowAt(p0); }   // inside: the map carries the liquid above
          lightY = p0.y;
          gSkyIn = skyInAt(probeAt(p0));
        }
        phiB = surfSample(ro + rd * tExit);
        // smooth matter in this cell may be a lone droplet or grain, or (air
        // in a brick with thin liquid) a pour drawn through the wake between
        // its parcels (shaders/fields.js jetWGSL)
        var tM = tExit;
        var phiM = phiB;
        if (SURFCH(id) >= 0 || (gThin && id == E_EMPTY)) {
          tM = tClosest(cell, ro, rd, tEnter, tExit);
          phiM = surfSample(ro + rd * tM);
        }
        if (ev == EV_NONE) {
          // the first surface crossed, channel by channel (one surfCross call
          // site: the root finding is inlined wherever it is called). In
          // liquid, its surface is crossed going out (channel CH_LIQUID = 0).
          // A crossing right at the segment's end (t == tExit) is this
          // segment's: where a field is 1 in the matter and 0 in the air, it
          // is exactly SURF_ISO on the cell face the segment ends on, and the
          // next segment starts inside, where no crossing is ever found. The
          // ray then went on through the rock and out of the window, and the
          // far field showed through: sunlit lines along cave floors' seams.
          let inLiq = liq != E_EMPTY;
          for (var c = 0; c < 4; c++) {
            let t = surfCross(ro, rd, c, !(inLiq && c == CH_LIQUID), tEnter, tM, tExit, phiA[c], phiM[c], phiB[c]);
            if (!inLiq) {
              if (t <= tEv) { tEv = t; evCh = c; ev = select(EV_OPAQUE, EV_ENTER, c == CH_LIQUID); }
            } else if (c == CH_LIQUID) {
              if (t <= tEv) {
                tEv = t; evCh = CH_LIQUID; ev = EV_EXIT;
              } else if (max(phiA.x, max(phiM.x, phiB.x)) < SURF_ISO) {
                liq = E_EMPTY;   // lost the surface (grazing ray): quietly back in air
              }
            } else if (t <= tEv + OPAQUE_TIE) { tEv = min(t, tEv); evCh = c; ev = EV_OPAQUE; }
          }
        }
        phiStale = false;
      } else {
        phiStale = true;
      }

      if (tCut < tEv) { tEv = tCut; ev = EV_NONE; cut = true; }${grains ? `
      // grains (gfx/grains.js), not past the cut either: geometry in front of it may still end the segment
      // (grainEvent reads the cell's state only for a grain element's cell: its cand)
      var ga = vec4f(0.0);
      if (grainElement(id)) { ga = fetchA(cell); }
      let altOpen = gAltW < 0.0;
      grainEvent(cell, id, ga, ro, rd, tEnter, min(tExit, tCut), col, trans, &ev, evCh, &tEv, &anyHit, &hitPos);
      if (altOpen && gAltW >= 0.0) { altRefl = gReflPend; }   // (the stored path's colour owes it too: reflectResolve)
      cut = ev == EV_NONE && tEv >= tCut;` : ''}

      // ---- what lies along [tEnter, tEv] ----
      if (liq != E_EMPTY) {
        let pm = ro + rd * (0.5 * (tEnter + tEv));
        var lj = id;
        if (brickMixed(flags)) {
          let cj = clamp(vec3i(floor(pm + liqDither)), vec3i(0), GRID - 1);
          if (any(cj != cell)) { lj = eid(fetchA(cj)); }
        }
        if (SURFCH(lj) == CH_LIQUID) { liq = lj; }
        else if (SURFCH(id) == CH_LIQUID) { liq = id; }
        mediumLight = lightRef * exp(-SIGMA(liq) * max(lightY - pm.y, 0.0) / max(FU.sun.y, LIQ_SUN_Y_MIN));
        let own = SURFCH(id) == CH_LIQUID;
        // (painted liquid: gfx/deco.js; drops and pours show their colour: gfx/liquid.js thinBodySeg)
        var tOwn = AMBIENT;   // (the cell's temperature where it is the liquid's own)
        if (own) { tOwn = fetchA(cell).y; }
        absorbDeco(liq, select(vec3i(-1), cell, own), ro + rd * tEnter, thinBodySeg(pm, tEv - tEnter), mediumLight, tOwn, &col, &trans);
      } else if (brickMedia(flags)) {
        let al = mediaSegment(ro, rd, tEnter, tEv, &mNext, &col, &trans);
        // until something is hit, hitPos tracks the first gas, and the gas
        // that has become mostly opaque counts as a hit
        if (!anyHit && al > 0.0 && mOp == 0.0) { hitPos = ro + rd * tEnter; }
        mOp = 1.0 - (1.0 - mOp) * (1.0 - al);
        if (!anyHit && mOp > MEDIA_DEPTH_ALPHA) { anyHit = true; }
      }

      // ---- the event ----
      if (cut) { break; }
      if (ev != EV_NONE) {
        let hp = ro + rd * tEv;
        if (!anyHit) { anyHit = true; hitPos = hp; }${grains ? `
        if (ev == EV_GRAIN) { hitK = HIT_GRAIN; stop = true; hitP = hp; break; }` : ''}
        if (ev == EV_OPAQUE) {
          hitK = HIT_SMOOTH; stop = true; hitP = hp; hitN = evN; hitCh = evCh;
          break;
        } else {
          // liquid surface: refract in or out
          let geometric = surfNormal(hp, CH_LIQUID, select(rd, -rd, ev == EV_ENTER));
          var n = liquidRipple(hp, geometric);
          var lid = liq;
          if (ev == EV_ENTER) { lid = liquidIdAt(hp - geometric * IFACE_PROBE, E_WATER); }${liq ? `
          n = liquidDetail(hp, n, lid, &col, &trans);   // close-up detail (gfx/liquidDetail.js)` : ''}
          if (bends < MAX_BENDS) {
            bends++;
            // refract here, at the top of the next step (the loop's head: ifPend), and restart there
            ifPend = true; ifEntry = false; ifP = hp; ifN = n; ifG = geometric; ifEnter = ev == EV_ENTER; ifLid = lid; ifMirror = bends == 1; ifT = tEv;
            continue;
          }
          // out of bends: switch medium, keep straight
          liq = select(E_EMPTY, lid, ev == EV_ENTER);
          if (ev == EV_ENTER) {
            lightRef = vec3f(1.0);
            if (FU.shadows != 0u) { lightRef = sunShadowAt(hp + n * IFACE_PROBE); }
            lightY = hp.y;
            gSkyIn = skyInAt(surfProbe(hp, n));
          }
          // Keep the remainder of this cell: an opaque crossing may follow
          // the liquid interface even when the optical bend budget is spent.
          let resume = min(tEv + IFACE_NUDGE, min(tExit, tCut));
          if (resume < tExit) {${curved ? `
            mNext -= resume;
            walk.t = mix(walk.t, walk.end, resume / tExit);
            walk.boundary = false;
            walk.axis = warpEntryAxis(walk.ray, walk.t);` : `
            tEnter = resume;
            phiA = surfSample(ro + rd * tEnter);
            phiStale = false;`}
            continue;
          }
        }
      }
      phiA = phiB;
    }

    if (max(trans.x, max(trans.y, trans.z)) < RAY_MIN_TRANS) { break; }${curved ? `
    mNext -= tExit;
    warpAdvance(&walk);
    if (walk.boundary) { cell = warpCellAfter(walk.ray, walk.t, walk.axis); } else { cell = warpCell(walk.ray, walk.t); }
    if (cell.y < 0) { break; }   // opaque physical floor; do not draw the second span through it` : `
    tEnter = tExit;
    ax = ddaStep(istp, tDelta, &cell, &tMax);`}
  }

  // ---- the pixel's traced reflection, marched once for whichever surface asked (gfx/liquid.js reflectDefer) ----
  let owed = reflectResolve();
  col += owed;${grains ? `
  if (altRefl) { gAltCol += owed; }` : ''}

  // ---- shading, one call site for every kind of hit ----
  // Pass 0 shades the hit that ended the ray, then the floor if the ray got
  // there. With grains, pass 1 shades the hand-off band's path not taken and
  // blends it in (gfx/grains.js).
  let passes = ${grains ? 'select(2, 1, gAltW < 0.0)' : '1'};
  var shadeRd = rd;
  for (var sp = 0; sp < passes; sp++) {${grains ? `
    if (sp == 1) {
      hitK = select(HIT_SMOOTH, HIT_GRAIN, gAltGeom); stop = true; hitP = gAltP; hitN = vec3f(0.0); hitCh = CH_GRANULAR;
      gHitA = gAltA; gHitK = gAltK; shadeRd = gAltRd;
    }` : ''}
    // the floor of the box, if the ray got there (the first pass): shaded
    // through the hit's one shadeHit call (gfx/surface.js; it meets one or the other)
    var floorLit = false;
    var floorHp = vec3f(0.0);
    var floorFw = vec2f(0.0);
    if (sp == 0 && !stop) {${curved ? `
      var floorP: vec3f;
      var floorT: f32;
      let onFloor = warpFloor(walk, &floorP, &floorT)
        && (meshBudget >= MESH_CUT_NONE || warpArc(walk.ray, 0.0, floorT) < meshBudget);` : ''}
      if (!cut && max(trans.x, max(trans.y, trans.z)) >= RAY_MIN_TRANS && ${curved ? 'onFloor' : 'cell.y < 0 && rd.y < 0.0'}) {
        let tf = ${curved ? 'floorT' : '-ro.y / rd.y'};
        floorHp = ${curved ? 'floorP' : 'ro + rd * tf'};${curved ? `
        rd = normalize(warpSlope(walk.ray, tf));` : ''}
        if (!anyHit) { anyHit = true; hitPos = floorHp; }
        floorLit = true;
        floorFw = floorFwidth(floorHp, rd);
      }
    }
    var c = vec3f(0.0);
    if (stop || floorLit) {
      var s = floorHit();
      if (stop) {
        // every kind of hit's material through one matOf call (gfx/surface.js MatPlan):
        // a crisp voxel's, a smooth surface's blend of its cells${grains ? `, and a clod, shaded as the
        // crisp grain it is (gfx/grains.js grainCrisp). A local flag, not a hitK write: the kind
        // stays loop-invariant here (tools/check-opaque-surface.mjs)
        let clod = hitK == HIT_GRAIN && grainCrisp(gHitK, gHitA, hitP, &hitCell, &hitId, &hitA, &hitN);` : ''}
        var pl: MatPlan;
        if (hitK == HIT_CRISP${grains ? ' || clod' : ''}) { s = crispPlan(hitCell, hitId, hitA, hitP, hitN, &pl); }${grains ? `
        else if (hitK == HIT_GRAIN) { s = grainSurf(gHitA, gHitK, hitP, shadeRd); }` : ''}
        else {
          var ns = hitN;
          if (dot(hitN, hitN) == 0.0) { ns = surfNormal(hitP, hitCh, -shadeRd); }
          s = gatherPlan(hitP, ns, hitCh, &pl);
        }
        if (pl.count > 0) { applyMat(&s, planMat(pl)); }${grains ? `
        if (clod) { clodFinish(&s); }` : ''}
        decoSurf(&s);   // TPT's deco colour (gfx/deco.js)
      }
      c = shadeHit(s, shadeRd, floorLit, floorHp, floorFw);${backend === 'world' && !detail[WORLD_NATIVE] ? '' : `
      // Native molten liquids share compact foam, not water's refraction or
      // detail eligibility. Layer only reflected light; retain heat emission.
      if (stop && ${backend === 'world' ? 'true' : `(${format} == 2u || ${format} == 3u)`} && hitK == HIT_SMOOTH && s.ch == CH_MOLTEN && KIND(s.id) == K_LIQUID) {
        var foamCol = vec3f(0.0);
        var foamTrans = vec3f(1.0);
        var foamN = s.n;
        liquidFoam(s.p, &foamN, s.id, &foamCol, &foamTrans);
        c = foamCol + foamTrans * (c - s.emit) + s.emit;
      }`}${grains ? `
      gGrainSun = 1.0;   // (grainSurf set it for this shadeHit; the floor's is 1 already)` : ''}
    }
    if (sp == 0) {
      if (stop) {
        ${backend === 'world' ? '' : `if (FU.far != 0u && liq != E_EMPTY) {
          // Match the continuation below instead of drawing a hard seam where
          // a refracted ray just misses the last available bed/obstacle cell.
          let edge = min(min(hitP.x, f32(NX) - hitP.x), min(hitP.z, f32(NZ) - hitP.z));
          c = mix(interiorScatter(liq, hitP, mediumLight, AMBIENT), c, smoothstep(0.0, LIQ_WINDOW_FADE, edge));
        }`}
        col += trans * c; trans = vec3f(0.0);
      }
      if (floorLit) { col += trans * c; trans = vec3f(0.0); }
    }${grains ? ` else {
      let w = select(1.0 - gAltW, gAltW, gAltGeom);   // weight of the stored path
      col = mix(col, gAltCol + gAltTrans * c, w);
      trans *= 1.0 - w;
    }` : ''}
  }
  ${backend === 'world' ? '' : `// A bent ray still submerged when it leaves the window must not reveal
  // the original camera ray's sky via alpha blending (pale, blob-shaped holes).
  // shortcut: homogeneous liquid beyond the local trace; replace with far-field
  // transmission when that can fit the view's texture-unit budget.
  // A finite mesh ends that tail too; never scatter an infinite column over it.
  if (!cut && tCut >= MESH_CUT_NONE && FU.far != 0u && liq != E_EMPTY && outside(cell) && cell.y >= 0 && cell.y < NY) {
    let p = clamp(ro + rd * tEnter, vec3f(0.5), vec3f(GRID) - 0.5);
    col += trans * interiorScatter(liq, p, mediumLight, AMBIENT);
    trans = vec3f(0.0);
  }`}
  // only thin gas: keep it (and its glow), at its depth
  if (!anyHit && (mOp > MEDIA_KEEP_ALPHA || dot(col, vec3f(1.0)) > MEDIA_KEEP_RADIANCE)) { anyHit = true; }
  var o: VolumeHit;
  o.hit = anyHit;
  if (!anyHit) { return o; }
  let alpha = 1.0 - dot(trans, vec3f(1.0 / 3.0));
  // linear HDR radiance, premultiplied; tone mapping happens in post (src/gfx/post.js)
  var rgb = col * select(0.0, 1.0, alpha > 0.0);
  let shown = ${curved ? 'warpGridPoint(hitPos)' : 'hitPos'};   // (curved: where the hit is displayed)
  // The air between the eye and the hit: far hills fade toward the sky's
  // colour, as real air does (farShared.js volumeHaze: FAR_HAZE, 12 km of
  // visibility). The same on every map, Box and World, V1 and V2: a small
  // map's ~40 m fade it by about 1 %, a big map's far side (300-900 m) by a
  // tenth to a quarter. (No haze in the data views or Plain: volumeFrag.)
  rgb = volumeHaze(rgb, alpha, FU.cam, shown);
  o.color = vec4f(rgb, alpha);
  o.depth = volumeDepth(shown);
  return o;
}`;
};

/**
 * The box's vertex entry `vs`: the 14-vertex triangle strip of the cube
 * [0, GRID] in grid cells (each corner's bits from vertex_index, CCW outward),
 * through FU.viewProj · FU.model (the jittered camera, the volume's place in
 * the scene). The grid point travels to the fragment, where the ray is built.
 * Curved (the rolling log), the box's corners would draw where the box isn't
 * any more: the draw is VOLUME_SCREEN_VERTICES, a full-screen triangle wound
 * as the box's back faces, and the grid point is the pixel's on the far plane
 * (P.meshInv: clip → grid, the same jittered matrices). The ray is the
 * displayed one either way: straight from the eye through the pixel.
 */
const volumeVertOf = (curved = false) => /* wgsl */ `
struct VolumeVarying {
  @builtin(position) position: vec4f,
  @location(0) grid: vec3f,   // the box surface point (curved: the far plane's), grid cells
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> VolumeVarying {
  var o: VolumeVarying;${curved ? `
  // (-1, -1), (-1, 3), (3, -1): clockwise in clip space, as the box's back faces are
  let ndc = vec2f(select(-1.0, 3.0, i == 2u), select(-1.0, 3.0, i == 1u));
  o.position = vec4f(ndc, 0.0, 1.0);
  let p = P.meshInv * vec4f(ndc, 1.0, 1.0);
  o.grid = p.xyz / p.w;` : `
  let b = 1u << i;
  let corner = vec3f(select(0.0, 1.0, (0x287au & b) != 0u), select(0.0, 1.0, (0x02afu & b) != 0u), select(0.0, 1.0, (0x31e3u & b) != 0u));
  o.grid = corner * vec3f(GRID);
  o.position = FU.viewProj * FU.model * vec4f(o.grid, 1.0);`}
  return o;
}`;
export const volumeVert = volumeVertOf(false);
/** Vertices of the box's strip (draw count). */
export const VOLUME_VERTICES = 14;
/** Vertices of the curved view's full-screen triangle (draw count). */
export const VOLUME_SCREEN_VERTICES = 3;

// The fragment entry `fs`: the pixel's ray, its footprint (derivatives, at
// the top in uniform control flow), the box, the view's trace; nothing is
// written where it hit nothing. cut: the view stops at the meshes (the
// realistic march), so its
// depth is the nearer of its hit and the mesh's. Curved, the ray's spans in
// the box are its parabola's (warpWalk); its mesh cut uses arc length.
const volumeEntry = (view, cut, curved = false, backend = 'box', plain = false) => /* wgsl */ `
struct VolumeFrag {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}
${plain ? 'fn worldPlainFragment(v: VolumeVarying, phase: u32)' : '@fragment fn fs(v: VolumeVarying)'} -> VolumeFrag {
  gFragCoord = v.position.xy;
  gAerCopy = P.aerCopy;${curved ? `
  warpUse(P.warpK, P.warpAnchor, P.warpDir);` : ''}
  let ro = FU.cam;
  let rd = safeDir(normalize(v.grid - FU.cam));
  surfView(FU.cam, rd);   // pixel footprint for material LOD and the floor lines (needs uniform control flow)
  gCubicEye = gEye;       // and for reading fields cubic up close (gfx/core.js cubicClose)
  gCubicPixAng = gPixAng;${view === 'flow' ? `
  gPix = length(abs(gRdDx) + abs(gRdDy)) * FU.pixScale;   // fwidth(rd), from surfView's derivatives` : ''}
  var o: VolumeFrag;${curved ? `
  let walk = warpWalk(ro, rd, P.marchNear);
  let bh = vec3f(walk.spans.xy, f32(walk.axis));
  let t0 = max(bh.x, P.marchNear);
  if (bh.y <= t0 || t0 >= WARP_INF) { discard; return o; }` : `
  let bh = boxHit(ro, rd);
  let t0 = max(bh.x, P.marchNear);
  if (bh.y <= t0) { discard; return o; }`}
  ${backend === 'world' ? `worldBeginQuery();${cut ? ' worldSunValidate();' : ''}` : ''}let h = traceView(ro, rd, t0, bh${plain ? ', phase' : ''});
  ${backend === 'world' ? 'worldEndQuery(); if (worldQueryIncomplete()) { discard; return o; }\n  ' : ''}if (!h.hit) { discard; return o; }
  o.color = h.color;
  o.depth = ${cut ? 'meshCutDepth(h.depth)' : 'h.depth'};
  return o;
}${plain ? `
@fragment fn fsOpaque(v: VolumeVarying) -> VolumeFrag { return worldPlainFragment(v,0u); }
@fragment fn fsAbsorb(v: VolumeVarying) -> VolumeFrag { return worldPlainFragment(v,1u); }
@fragment fn fsScatter(v: VolumeVarying) -> VolumeFrag { return worldPlainFragment(v,2u); }` : ''}`;

// ID-only probes need neither temperature tables nor life/colour decoding.
// Use the same raw cell and canonical dither coordinate as fetchAs (a whole
// liquid cell beats every threshold: no hash); debug readers retain their
// original access-count instrumentation. With them the volume's other reads
// of V2's cells (shaders/compact.js compactDrawWGSL: volumeA, volumeT) and
// its B (volumeB: V1's B, a cell's own motion and its brick's air, as
// shaders/v2/viewRead.js builds it from the read group's air).
const volumeIdWGSL = format => /* wgsl */ `
fn volumeId(p: vec3i) -> i32 {
  let c = fetchNativeCore(p);
  let id = i32(c.x & 255u);
  if (id == E_EMPTY) { return E_EMPTY; }   // (air, most probes: no table lookup)
  let k = KIND(id);
  if (k == K_EMPTY) { return E_EMPTY; }
  if (k == K_LIQUID && ${format === 3 ? '(c.y & 0xffffffu) == 0u' : '(c.y & 0xffffffu) < 65536u && (c.y & 0xffffffu) <= (seed3(cellOf(slotOf(p)), 0u, 4243u) >> 16u)'}) { return E_EMPTY; }
  return id;
}
${compactDrawWGSL(format === 3)}${nativeMotionWGSL}
fn volumeB(p: vec3i) -> vec4f {
  return nativeMotionB(fetchNativeCore(p), nativeAirB(slotOf(p)));
}
`;
// The call ARGS of each `name(` in code (not its definition): [start, end] of
// `name(ARGS)`, balanced parentheses.
function calls(code, name) {
  const out = [], re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let m; (m = re.exec(code));) {
    if (/\bfn\s+$/.test(code.slice(Math.max(0, m.index - 4), m.index))) continue;
    let depth = 1, i = m.index + m[0].length;
    for (; depth && i < code.length; i++) { if (code[i] === '(') depth++; else if (code[i] === ')') depth--; }
    out.push([m.index, i]);
  }
  return out;
}
// The Box volume's reads of V2's cells through its own readers (volumeIdWGSL):
// eid(fetchA(x)) → volumeId(x), fetchA(x).y → volumeT(x), fetchA → volumeA, fetchB → volumeB.
function nativeVolumeReads(code) {
  let out = code;
  for (const [name, rewrite] of [
    ['eid', (call) => /^eid\(fetchA\((.*)\)\)$/s.exec(call) && calls(call, 'fetchA')[0]?.[1] === call.length - 1 ? `volumeId(${call.slice(11, -2)})` : null],
    ['fetchA', (call, after) => (/^\.y(?![\w])/.test(after) ? { text: `volumeT(${call.slice(7, -1)})`, skip: 2 } : `volumeA(${call.slice(7)}`)],
    ['fetchB', (call) => `volumeB(${call.slice(7)}`],
  ]) {
    let next = '', at = 0;
    for (const [a, b] of calls(out, name)) {
      if (a < at) continue;   // (inside a call already rewritten)
      const r = rewrite(out.slice(a, b), out.slice(b));
      if (r === null) continue;
      const { text, skip = 0 } = typeof r === 'string' ? { text: r } : r;
      next += out.slice(at, a) + text;
      at = b + skip;
    }
    out = next + out.slice(at);
  }
  return out;
}
/**
 * The volume's WGSL module for grid g: a vertex entry `vs` and a fragment
 * entry `fs` drawing `view` (a key of src/views.js VIEWS: 'realistic',
 * 'heat', 'pressure', 'flow', 'xray'; WORLD also 'plain'). detail: the close-up detail's
 * defines (gfx/detail.js detailDefines), which only the realistic view reads.
 * curved: the rolling log's variant (docs/webgpu.md F2: a block this size and
 * its globals are a template switch, so the flat views carry none of it);
 * its draw is VOLUME_SCREEN_VERTICES.
 * @param {{ nx: number, ny: number, nz: number, maxSteps?: number }} g
 * @param {{ view?: string, detail?: object, curved?: boolean, debug?: boolean, fixedReadFormat?: 0 | 2 | 3 }} [opts]
 * @returns {string}
 */
export const volumeFrag = (grid, { view = 'realistic', detail = {}, curved = false, debug = false, backend = 'box', fixedReadFormat } = {}) => {
  renderBackend(backend);
  readFormatWGSL(fixedReadFormat);
  // The World's module reads its world's size at run time, so every world shares it
  // (shaders/common.js WORLD_RUNTIME_GRID): only its source artwork's switch is the grid's.
  const g = backend === 'world' ? { ...WORLD_RUNTIME_GRID, sourceAppearance: grid.sourceAppearance === true, sourceGrid: grid.sourceGrid } : grid;
  const plain = backend === 'world' && view === 'plain';
  if (!plain && !VOLUME_VIEWS.includes(view)) throw new Error(`volumeFrag: no view ${view} (${VOLUME_VIEWS.join(', ')})`);
  const lit = isMaterialView(view), d = lit ? detail : {};
  const nativeIds = !debug && (fixedReadFormat === 2 || fixedReadFormat === 3);
  const parts = [
    `// volume: ${view}${lit ? `, detail ${Object.keys(d).sort().join(' ') || 'off'}` : ''}${curved ? ', curved' : ''}`,
    lib(plain ? { ...g, sourceAppearance: false } : g, { variant: 'LIGHTING', far: lit, aeration: true, debug, detail: d, backend, fixedReadFormat }),
    ...(nativeIds ? [volumeIdWGSL(fixedReadFormat)] : []),
    tracerWGSL(backend),
    curved ? presentationNearWGSL() : '',
    surfaceGLSL(d, { sourceAppearance: lit && g.sourceAppearance === true }),
    backend === 'world' ? decoViewWGSL({ backend }) : decoViewGLSL,
    liquidGLSL,
    decoSurfGLSL,
    liquidDetailGLSL(d, { backend, fixedReadFormat }),
    mediaGLSL(d),
    grainsGLSL(d),
  ];
  if (backend === 'world') parts.push(shadowOpticsWGSL({ backend }));
  // Intentional (no sky in these views, 2026-10-20): the haze is the sky's light
  // on the air, and the data views and Plain draw no sky (app.js drawSky: the
  // material views only; behind the rest is the page's painted gradient,
  // gfx/post.js), so they keep no haze, on every map alike. The data views'
  // colours are readings, not light.
  if (plain) parts.push(worldPlainWGSL({ curved }));
  else if (lit) parts.push(volumeHazeGLSL, realistic(d, curved, backend, fixedReadFormat));
  else parts.push(DATA_COMMON, DATA_CODE[view](curved, backend), dataView(view));
  parts.push(volumeVertOf(curved), volumeEntry(view, lit || plain, curved, backend, plain));
  // Keep the heavier artwork out of Realistic's active shader path/registers.
  const joined = parts.join('\n').replaceAll('FU.materialStyle', `${materialStyleForView(view) ?? 0}.0`);
  const code = backend === 'world' ? worldRuntimeGrid(joined) : joined;
  return nativeIds ? nativeVolumeReads(code) : code;
};

// ---- the pipeline (docs/webgpu.md F1, F2) ----

// The volume's bind group layouts, groups 0-3: the render library's, group 0
// with the meshes' depth and the decoration plane.
export const VOLUME_LAYOUTS = ({ backend = 'box' } = {}) => {
  renderBackend(backend);
  if (backend === 'world') return worldVolumeLayouts({ paramsSize: VolumeParams.size });
  const [, state, lighting, params] = libLayouts('LIGHTING');
  return [[...RENDER_LAYOUT.FRAME, MESH_DEPTH_ENTRY, DECO_PLANE_ENTRY], state, lighting, params];
};
// premultiplied colour over what is there
const OVER = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
/** The scene target's formats (gfx/post.js: rgba16float colour, depth32float). */
export const SCENE_FORMATS = { color: 'rgba16float', depth: 'depth32float' };
/**
 * The volume's render pipeline description (gpu.renderPipeline and
 * WGSL_CHECK take the same): back faces of the box's strip, depth test
 * less-equal with frag_depth written, premultiplied blend over.
 */
export const volumePipeline = () => ({
  vertex: { entry: 'vs' },
  fragment: { entry: 'fs', targets: [{ format: SCENE_FORMATS.color, blend: OVER }] },
  primitive: { topology: 'triangle-strip', cullMode: 'front' },
  depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'less-equal' },
});

/** WORLD Plain must be recorded in this order against the native scene target.
 * Mesh HDR/depth/coverage must be packed before all three phases, not between
 * them. The same immutable WORLD publication/params must survive every phase.
 */
export const WORLD_PLAIN_PHASES = Object.freeze(['opaque', 'absorb', 'scatter']);
export const worldPlainPipelines = ({ curved = false } = {}) => Object.fromEntries(
  WORLD_PLAIN_PHASES.map((phase, i) => [phase, {
    vertex: { entry: 'vs' },
    fragment: { entry: ['fsOpaque', 'fsAbsorb', 'fsScatter'][i], targets: [{
      format: SCENE_FORMATS.color,
      ...(i ? { blend: i === 1 ? BLOCK_PLAIN_ABSORB : BLOCK_PLAIN_ADD } : {}),
    }] },
    primitive: { topology: curved ? 'triangle-list' : 'triangle-strip', cullMode: 'front' },
    depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled: i === 0, depthCompare: 'less-equal' },
  }]),
);

// =====================================================================
// Picking: march the queued rays (the hover ray, each pickRay) and report the
// first non-gas voxel each hits (WORLD Plain: the first visible raw face),
// as the two texels the GLSL wrote: (cell xyz,
// face) and (id, T, P, life). One thread per ray (docs/webgpu.md F5), each
// writing its 8 floats to its own slot of the pick result ring (B7). A ray
// asked for on screen while the rolling log bends the view (ro.w = its k, not
// 0) walks the displayed ray's parabola instead (the GLSL's uPresentationPick):
// what the pointer shows is what it picks.
// =====================================================================

/** Rays one pick dispatch takes. */
export const PICK_BATCH = 8;
/** Bytes a ray's result takes in the ring: two vec4f. */
export const PICK_RESULT_BYTES = 32;
export const PickParams = uniformStruct('PickParams', {
  ro: `array<vec4f, ${PICK_BATCH}>`,     // ray origins, grid cells; w: the rolling log's k (0: a flat ray)
  rd: `array<vec4f, ${PICK_BATCH}>`,     // directions (normalised here); w: skip liquids
  warp: `array<vec4f, ${PICK_BATCH}>`,   // the rolling log's anchor (xy) and direction (zw), world cells
  slot: `array<vec4u, ${PICK_BATCH / 4}>`,   // each ray's ring slot, four to a vec4u
  n: 'u32',                              // rays queued
});
export const PICK_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];

export const pickFrag = (g, { backend = 'box', view } = {}) => {
  if (backend === 'world' && view === 'plain') return worldPlainPickWGSL(g, { params: PickParams, batch: PICK_BATCH });
  return /* wgsl */ `${renderBackend(backend) && ''}
${prelude(g, backend === 'world' ? { state: false, backend } : STATE_OPTS.STATE_RO)}
${backend === 'world' ? worldAccessWGSL({ backend }) + worldQueryWGSL + `fn fetchA(c: vec3i) -> vec4f { return worldFetchA(c); }\nfn fetchB(c: vec3i) -> vec4f { return worldFetchB(c); }` : ''}${materialsGLSL()}
${ddaGLSL(g, { backend })}
${presentationNearWGSL({ skip: false })}
${PickParams.wgsl}
@group(${backend === 'world' ? 3 : 2}) @binding(${backend === 'world' ? 6 : 0}) var<storage, read_write> picks: array<vec4f>;   // the ring: two per slot
@group(3) @binding(${backend === 'world' ? 0 : 1}) var<uniform> P: PickParams;
// Face codes are axis * 2 + (1 if the ray steps +axis); the face's normal is
// minus that step. The floor is hit stepping down y.
const PICK_FACE_FLOOR: i32 = 2;
struct Pick {
  at: vec4f,     // (cell xyz, face); w = -1: a miss
  what: vec4f,   // (id, T, P, life)
}
fn pickStops(id: i32, skipLiquids: bool) -> bool {
  return !isGasLike(id) && (!skipLiquids || KIND(id) != K_LIQUID);
}
fn pickRay(ro: vec3f, rd0: vec3f, skipLiquids: bool) -> Pick {
  let rd = safeDir(normalize(rd0));
  let miss = Pick(vec4f(0.0, 0.0, 0.0, -1.0), vec4f(0.0, 0.0, 0.0, -1.0));
  let bh = boxHit(ro, rd);
  let t0 = max(bh.x, 0.0);
  if (bh.y <= t0) { return miss; }
  var istp: vec3i;
  var tDelta: vec3f;
  var cell: vec3i;
  var tMax: vec3f;
  ddaStart(ro, rd, t0, &istp, &tDelta, &cell, &tMax);
  var ax = i32(bh.z);
  // Exact cell traversal: one ray is cheap, and it must not depend on the
  // presentation's brick map (a preview or a one-off pick can precede its rebuild).
  for (var i = 0; i < MAX_STEPS; i++) {
    if (outside(cell)) { break; }
    let a = fetchA(cell);
    let id = eid(a);
    if (pickStops(id, skipLiquids)) {
      let face = ax * 2 + select(0, 1, istp[ax] > 0);   // normal = -step
      return Pick(vec4f(vec3f(cell), f32(face)), vec4f(f32(id), a.y, fetchB(cell).w, a.z));
    }
    ax = ddaStep(istp, tDelta, &cell, &tMax);
  }
  if (cell.y < 0 && rd.y < 0.0) {
    // floor hit
    return Pick(vec4f(f32(cell.x), -1.0, f32(cell.z), f32(PICK_FACE_FLOOR)), vec4f(-1.0, AMBIENT, 0.0, 0.0));
  }
  return miss;
}
// The displayed ray's parabola (shaders/gfx/presentation.js), cell by cell:
// exact exits, no brick skipping, the first non-gas voxel, or the floor.
fn pickCurved(ro: vec3f, rd: vec3f, skipLiquids: bool) -> Pick {
  var walk = warpWalk(ro, normalize(rd), 0.0);
  for (var i = 0; i < 2 * MAX_STEPS; i++) {
    var cell: vec3i;
    if (!warpLocate(&walk, &cell)) { break; }
    let a = fetchA(cell);
    let id = eid(a);
    if (pickStops(id, skipLiquids)) {
      let axis = warpEntryAxis(walk.ray, walk.t);
      let face = 2 * axis + select(0, 1, warpSlope(walk.ray, walk.t)[axis] > 0.0);
      return Pick(vec4f(vec3f(cell), f32(face)), vec4f(f32(id), a.y, fetchB(cell).w, a.z));
    }
    let ex = warpExit(walk.ray, vec3f(cell), vec3f(cell + 1), walk.t);
    if (ex.x <= walk.t) { break; }
    walk.t = ex.x;
    walk.axis = i32(ex.y);
    walk.boundary = true;
    let p = warpAt(walk.ray, walk.t);
    if (p.y <= WARP_EPS && warpSlope(walk.ray, walk.t).y < 0.0) {
      return Pick(vec4f(floor(p.x), -1.0, floor(p.z), f32(PICK_FACE_FLOOR)), vec4f(-1.0, AMBIENT, 0.0, 0.0));
    }
  }
  return Pick(vec4f(0.0, 0.0, 0.0, -1.0), vec4f(0.0, 0.0, 0.0, -1.0));
}
// a batch is at most PICK_BATCH rays: one small workgroup, a thread each
@compute @workgroup_size(${PICK_BATCH}) fn main(@builtin(local_invocation_index) i: u32) {
  if (i >= P.n) { return; }
  ${backend === 'world' ? 'worldBeginQuery();' : ''}var r: Pick;
  if (P.ro[i].w != 0.0) {
    warpUse(P.ro[i].w, P.warp[i].xy, P.warp[i].zw);
    r = pickCurved(P.ro[i].xyz, P.rd[i].xyz, P.rd[i].w != 0.0);
  } else { r = pickRay(P.ro[i].xyz, P.rd[i].xyz, P.rd[i].w != 0.0); }
  ${backend === 'world' ? 'worldEndQuery(); if (worldQueryIncomplete()) { r = Pick(vec4f(0.0,0.0,0.0,-2.0),vec4f(0.0)); }\n  ' : ''}let s = P.slot[i / 4u][i % 4u] * 2u;
  picks[s] = r.at;
  picks[s + 1u] = r.what;
}
`;
};
export const PICK_LAYOUTS = ({ backend = 'box' } = {}) => {
  renderBackend(backend);
  return backend === 'world' ? worldVolumeLayouts({ pick: true, paramsSize: PickParams.size }) : [LAYOUT.TABLES, LAYOUT.STATE_RO, PICK_LAYOUT];
};

// =====================================================================
// Shadow map: one ray per texel, marching from the sun toward the box.
// Opaque = crisp voxels and the smooth opaque surfaces (same root finding as
// the camera rays, so shadows line up with what is drawn). Liquids, glass and
// media add optical depth. A world's far field casts too (farCasterDepth,
// shaders/farShared.js), switched by FrameUniforms.far: compiled into the
// box's kernel as well, so box and world share it. The texel goes to both
// textures in one dispatch (docs/webgpu.md E, F5): the rgba32float map and
// its .x as r32float, which the soft shadows' 16 taps read.
// =====================================================================

export const SHADOW_WORKGROUP = SHADOW_TILE;   // 8×8 threads, a texel each: a tile of src/derived.js shadowTiles' list
/** The map's size for a grid: texels per side. */
export const shadowRes = (g) => Math.min(1024, 4 * Math.max(g.nx, g.ny, g.nz));

/**
 * The shadow kernel for grid g. world: the size of the world the grid is a
 * window of (sim.world), whose far layout the far casters read; a box takes
 * WORLD_SIZE's (its far branch is off, FrameUniforms.far).
 * @param {{ nx: number, ny: number, nz: number }} g
 * @param {{ world?: number[] }} [opts]
 */
export const shadowFrag = (g, { world = WORLD_SIZE } = {}) => /* wgsl */ `
${lib(g, { variant: 'LIGHTING_SHADOW', far: true, aeration: false })}
${farCastersGLSL(farLayout(world))}
${shadowOpticsWGSL().slice(1)}${shadowTilesWGSL(g)}
// A workgroup per tile of the list src/derived.js shadowTiles made (the tiles
// whose rays crossed a change, or all of them), a thread per texel.
@compute @workgroup_size(${SHADOW_WORKGROUP}, ${SHADOW_WORKGROUP}) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  var corner: vec2u;
  if (!shadowTileAt(wg.x + wg.y * nwg.x, &corner)) { return; }
  let id = corner + lid.xy;
  let res = u32(max(FU.shadowRes, 1));
  if (id.x >= res || id.y >= res) { return; }
  gFragCoord = vec2f(id.xy) + 0.5;   // the texel's centre (what gl_FragCoord was)
  var c: vec3f;
  var R: f32;
  var u: vec3f;
  var v: vec3f;
  sunBasis(&c, &R, &u, &v);
  let st = gFragCoord / f32(res) * 2.0 - 1.0;   // texel (i, j) ↔ sunMapShadow's (i + 0.5) / res
  let ro = c + FU.sun * R + (u * st.x + v * st.y) * R;
  let oC = shadowTexel(ro, safeDir(-FU.sun));
  textureStore(tShadow, id.xy, oC);
  textureStore(tShadowX, id.xy, vec4f(oC.x, 0.0, 0.0, 0.0));
}
`;
export const SHADOW_LAYOUTS = () => libLayouts('LIGHTING_SHADOW');
/** The shadow kernel's dispatch for a map of res² texels. */
export const shadowDispatch = (res) => [Math.ceil(res / SHADOW_WORKGROUP), Math.ceil(res / SHADOW_WORKGROUP), 1];

// The render library itself, under its GLSL-era name here (pov/figure.js's
// import; shaders/gfx/lib.js is where it lives now).
export { lib };

// ---- check-wgsl (docs/webgpu.md I1) and the menu's warm-up (B5) ----
// The realistic view at the settings' detail levels: none, the default
// settings' two variants (gfx/detailGate.js: base, which the view draws
// first, and near, which is the cost-tier defaults, Balanced), every switch;
// and alone, each feature a software adapter can't draw (gfx/detail.js
// SOFTWARE_UNDRAWABLE). Each detail combination of the materials alone is
// validated by tools/material-lod-check.mjs; these are the whole tracer.
const levelDefines = (keep) => Object.fromEntries(DETAIL.filter(keep).map((f) => [f.define, 1]));
export const REALISTIC_LEVELS = {
  off: () => ({}),
  base: () => gateVariants(detailDefaults()).base,
  balanced: () => levelDefines((f) => COST[f.cost].on),
  full: () => levelDefines(() => true),
  ...Object.fromEntries(DETAIL.filter((f) => SOFTWARE_UNDRAWABLE.includes(f.define)).map((f) => [f.key, () => ({ [f.define]: 1 })])),
};

// The gpu.layout names each pipeline's groups are made under (gfx/volume.js
// uses them), so a warm-up that makes its layouts under the same names builds
// the very pipelines the game then finds in the cache.
export const LAYOUT_NAMES = {
  volume: ['VOLUME_FRAME', 'STATE_RO', 'LIGHTING'],
  shadow: ['FRAME', 'STATE_RO', 'LIGHTING_SHADOW'],
  pick: ['TABLES', 'STATE_RO', 'PICK'],
};
// The views that read the sun's shadow map (src/views.js `shadows`; the data
// views light by clay, no shadows): the app renders the map only for them.
const SHADOWED_VIEWS = VIEWS.filter((v) => v.shadows).map((v) => v.key);
/** Whether a view (a VOLUME_VIEWS key) reads the shadow map: gfx/volume.js builds its kernel at once then. */
export const viewShadows = (view) => SHADOWED_VIEWS.includes(view);
const keyOf = (d) => Object.keys(d).filter((k) => d[k]).sort().join(',');
// the grids the curved variants are checked at: the tests' and the world window's (the gamemode's map is a world)
const CURVED_GRIDS = ['64', '128'];
// The realistic variants the view draws for these detail settings: the gate's
// base (drawn first) and near (prefetched), as gfx/volume.js builds them
// (fallback: a software adapter, which leaves SOFTWARE_UNDRAWABLE out).
const gateDetails = (settings, fallback) => {
  const { base, near } = gateVariants(settings);
  return { base: drawableDetail(base, fallback), near: drawableDetail(near, fallback) };
};
// A volume entry; view and detail say what it draws, and warm({ view,
// settings, fallback }) whether the session's view and detail settings use it
// (the warm-up's selector: below). A curved one (the rolling log's variant)
// builds when a gamemode selects the effect, never on the menu.
const volumeCheck = (name, view, detail = {}, warm = (s) => s.view === view, curved = false) => ({
  name,
  view,
  detail,
  curved,
  warm: curved ? () => false : warm,
  ...(curved ? { grids: CURVED_GRIDS } : {}),
  kind: 'render',
  code: (g) => volumeFrag(g, { view, detail, curved }),
  layouts: () => VOLUME_LAYOUTS(),
  layoutNames: LAYOUT_NAMES.volume,
  params: VolumeParams,
  ...volumePipeline(),
});
// a realistic level's entry is used when it is the settings' base or near variant
const materialWarm = (shader, detail) => ({ view, settings, fallback = false }) => {
  if (view !== shader || !settings) return false;
  const { base, near } = gateDetails(settings, fallback);
  return keyOf(detail) === keyOf(base) || keyOf(detail) === keyOf(near);
};
const SHADOW_CHECK = {
  name: 'shadow', kind: 'compute', code: (g) => shadowFrag(g), layouts: () => SHADOW_LAYOUTS(), layoutNames: LAYOUT_NAMES.shadow,
  workgroupSize: [SHADOW_WORKGROUP, SHADOW_WORKGROUP, 1], dispatch: (g) => shadowDispatch(shadowRes(g)),
  warm: ({ view }) => SHADOWED_VIEWS.includes(view),
};
const PICK_CHECK = {
  name: 'pick', kind: 'compute', code: (g) => pickFrag(g), layouts: () => PICK_LAYOUTS(), layoutNames: LAYOUT_NAMES.pick, params: PickParams,
  workgroupSize: [PICK_BATCH, 1, 1], dispatch: () => [1, 1, 1], warm: () => true,
};
/**
 * tools/check-wgsl.mjs, and the menu's warm-up (src/preload.js, docs/webgpu.md
 * B5). Every entry carries warm({ view, settings, fallback }): whether a
 * session in that view (a VOLUME_VIEWS key) with those detail settings
 * (detail_* switches) uses it. Building every entry would cost the menu about
 * 40 s of SwiftShader pipeline time for nothing; warmChecks() below is the
 * warm-up's list, including detail settings no entry here matches.
 */
export const WGSL_CHECK = () => [
  ...VOLUME_VIEWS.filter((v) => !isMaterialView(v)).flatMap((v) => [
    volumeCheck(`volume.${v}`, v),
    volumeCheck(`volume.${v}.curved`, v, {}, undefined, true),
  ]),
  ...VOLUME_VIEWS.filter(isMaterialView).flatMap((view) => Object.entries(REALISTIC_LEVELS).flatMap(([k, d]) => [
    volumeCheck(`volume.${view}.${k}`, view, d(), materialWarm(view, d())),
    volumeCheck(`volume.${view}.${k}.curved`, view, d(), undefined, true),
  ])),
  SHADOW_CHECK,
  PICK_CHECK,
];

/**
 * What the warm-up builds for a session (docs/webgpu.md B5): the view's module
 * (for the realistic view the detail gate's base variant), the near variant
 * marked idle (the gate prefetches it), the shadow kernel if the view reads
 * it, the pick kernel. Entries are WGSL_CHECK-shaped (code(g), layouts,
 * layoutNames, the pipeline description), so the warm-up builds them as
 * check-wgsl does; their sources are the ones gfx/volume.js then builds.
 * @param {string} view a VOLUME_VIEWS key
 * @param {object} settings the app's settings (detail_* switches)
 * @param {{ fallback?: boolean, curved?: boolean }} [opts] fallback: the device
 *   is a software adapter; curved: the session's gamemode bends the view (its
 *   effect, maps.js GAMEMODES: the rolling log), so its modules are the curved
 *   variants, the only ones it draws
 * @returns {object[]}
 */
export function warmChecks(view, settings, { fallback = false, curved = false, fixedReadFormat } = {}) {
  readFormatWGSL(fixedReadFormat);
  const out = [];
  const tag = curved ? '.curved' : '';
  if (isMaterialView(view)) {
    const { base, near } = gateDetails(settings, fallback);
    out.push(volumeCheck(`volume.${view}(${keyOf(base) || 'off'})${tag}`, view, base, undefined, curved));
    if (keyOf(near) !== keyOf(base)) out.push({ ...volumeCheck(`volume.${view}(${keyOf(near)})${tag}`, view, near, undefined, curved), idle: true });
  } else if (VOLUME_VIEWS.includes(view)) out.push(volumeCheck(`volume.${view}${tag}`, view, {}, undefined, curved));   // (plain: the blocks renderer's)
  if (SHADOWED_VIEWS.includes(view)) out.push(SHADOW_CHECK);
  out.push(PICK_CHECK);
  return out.map(e => e.name.startsWith('volume.') && fixedReadFormat !== undefined
    ? { ...e, name: `${e.name}.format${fixedReadFormat}`, code: g => volumeFrag(g, { view, detail: e.detail, curved, fixedReadFormat }) } : e);
}

// check-wgsl (b)'s exceptions on SwiftShader (W23), each with why. These are
// validated by (a); the container's tests draw every other volume entry.
const UNDRAWABLE = 'builds in 9-13 s, but SwiftShader\'s GPU process crashes (SIGSEGV) compiling it at its first draw (gfx/detail.js SOFTWARE_UNDRAWABLE): validated by (a), drawn on a real GPU';
// (the curved twins weren't measured: listed with their flat modules, which carry the same detail and a bigger march)
const UNDRAWABLE_CURVED = 'the rolling log\'s twin of a module SwiftShader can\'t draw (the same SOFTWARE_UNDRAWABLE detail, gfx/detail.js), listed by analogy and not measured: validated by (a), drawn on a real GPU';
export const WGSL_MAC_ONLY = Object.fromEntries(VOLUME_VIEWS.filter(isMaterialView).flatMap((view) => Object.entries(REALISTIC_LEVELS)
  .filter(([, d]) => Object.keys(d()).some((k) => SOFTWARE_UNDRAWABLE.includes(k)))
  .flatMap(([k]) => [[`volume.${view}.${k}`, UNDRAWABLE], [`volume.${view}.${k}.curved`, UNDRAWABLE_CURVED]])));
