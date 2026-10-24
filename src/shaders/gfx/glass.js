// Crisp glass as the realistic tracer draws it (render.js traceView): what a
// run of glass cells is, the faces' imperfections, and soda-lime glass's own
// colour. Pasted after liquidGLSL and decoSurfGLSL (fresnelSchlick,
// interiorLight, cheapBend, decoAt, SCATALB, mNoiseD).
//
// Nobody makes glass as a perfect 30 cm cube, so a cell of it is drawn as what
// it most likely stands for:
//   - a wall one cell thick is a window: a pane PANE_M thick through the
//     middle of the cell, its two faces reflecting, light crossing it nearly
//     straight, a bright line where it ends. Minecraft's glass panes are the
//     touchstone (a thin sheet down the block's middle, joined to its
//     neighbours), and Teardown's windows (thin, sharp reflections, an edge);
//   - two or more cells thick is a solid block that bends light at its faces
//     (Snell in and out, render.js) and goes green through long paths, as a
//     thick slab of window glass does (GLASS_ALPHA_PER_CM);
//   - every face has a faint large-scale waviness, as float and old glass
//     have, and smudges that roughen its sheen.
import { VNOISE_GRAD_VAR } from './liquid.js';
import { glf } from '../../glsl.js';

// Window glass is 3-6 mm; 4 mm is the commonest single glazing.
export const PANE_M = 0.004;
// Soda-lime float glass's absorption from its iron (Fe2O3 ~0.1 wt%), natural
// log per cm, RGB. Fe2+ absorbs a broad band centred near 1050 nm whose tail
// reaches into the red; Fe3+ absorbs near 380 nm, its tail into the blue; so
// the transmission peaks in the green (~530 nm), which is why a glass edge
// looks green. Clear float glass loses a few percent of its light per cm of
// path beyond the faces' Fresnel loss (float-glass data sheets: light
// transmittance falls from ~90% at 4 mm to ~81-83% at 19-25 mm); split here by
// the iron bands' shape (Rubin 1985, "Optical properties of soda lime silica
// glasses", Solar Energy Materials 12), at the low end of that range: 2% of
// the green per cm, 5% of the red, 3% of the blue. A 4 mm pane lets ~99% of
// the green through; a 30 cm path (a cell) 55% green, 22% red: clearly green
// edges; a 1.8 m lump is dark bottle green, as such a lump of window glass is.
export const GLASS_ALPHA_PER_CM = [0.05, 0.02, 0.03];
const CM_PER_M = 100;
// The faces' waviness: float glass's roller wave and old glass's ripple,
// GLASS_WAVE_M across, slope GLASS_WAVE_SLOPE (radians, rms). Tempered float
// is ~0.001 (its reflections still wobble on a facade); old cylinder glass
// 0.01-0.02. In between, so what is seen through a pane moves a little.
export const GLASS_WAVE_M = 0.7;
export const GLASS_WAVE_SLOPE = 0.006;
// Smudges (fingerprints, dried rain): patches GLASS_SMUDGE_M across covering
// GLASS_SMUDGE_COVER of the face, GGX roughness GLASS_SMUDGE_ROUGH there, and
// the grease film's diffuse scatter GLASS_SMUDGE_HAZE of the light crossing.
// Procedural for now: glassSmudge is where a CC0 smudge scan would plug in
// (the texture plumbing of gfx/surface.js).
const GLASS_SMUDGE_M = 0.08;
const GLASS_SMUDGE_COVER = 0.18;
const GLASS_SMUDGE_SOFT = 0.15;    // the patches' soft edge, in noise units
const GLASS_SMUDGE_ROUGH = 0.05;
const GLASS_SMUDGE_HAZE = 0.006;
// A pane's edge: a polished arris PANE_EDGE_M wide where the pane ends, which
// shows the light the pane carries along inside it (total internal reflection
// guides it to the edge), through PANE_EDGE_PATH cells of glass: green.
const PANE_EDGE_M = 0.012;
const PANE_EDGE_PATH = 1.0;
const PANE_EDGE_COVER = 0.85;   // share of what lies behind the edge strip it hides
const PANE_EDGE_GAIN = 2.5;     // the guided light's gain over the light falling on the pane (both faces collect it)
// The pane's two wavy faces aren't parallel: a thin wedge deviates light by
// (n - 1) times its angle. Share of the waviness that is wedge.
const PANE_WEDGE_SHARE = 1.0;
// A face this close to edge-on keeps its flat normal (the waviness must not
// turn it away from the eye), and the pane's path is cut at this cosine.
const GLASS_COS_MIN = 0.05;

export const glassWGSL = /* wgsl */ `
const PANE_CELLS: f32 = ${glf(PANE_M)} / CELL_M;
const GLASS_SODA_SIGMA: vec3f = vec3f(${GLASS_ALPHA_PER_CM.map(glf).join(', ')}) * (CELL_M * ${glf(CM_PER_M)});
const GLASS_WAVE_SCALE: f32 = CELL_M / ${glf(GLASS_WAVE_M)};   // noise lattice units per cell
const GLASS_WAVE_GAIN: f32 = ${glf(GLASS_WAVE_SLOPE / Math.sqrt(VNOISE_GRAD_VAR))};   // slope per unit gradient of value noise (rms ${GLASS_WAVE_SLOPE})
const GLASS_SMUDGE_SCALE: f32 = CELL_M / ${glf(GLASS_SMUDGE_M)};
const GLASS_SMUDGE_COVER: f32 = ${glf(GLASS_SMUDGE_COVER)};
const GLASS_SMUDGE_SOFT: f32 = ${glf(GLASS_SMUDGE_SOFT)};
const GLASS_SMUDGE_ROUGH: f32 = ${glf(GLASS_SMUDGE_ROUGH)};
const GLASS_SMUDGE_HAZE: f32 = ${glf(GLASS_SMUDGE_HAZE)};
const PANE_EDGE_CELLS: f32 = ${glf(PANE_EDGE_M)} / CELL_M;
const PANE_EDGE_PATH: f32 = ${glf(PANE_EDGE_PATH)};
const PANE_EDGE_COVER: f32 = ${glf(PANE_EDGE_COVER)};
const PANE_EDGE_GAIN: f32 = ${glf(PANE_EDGE_GAIN)};
const PANE_WEDGE_SHARE: f32 = ${glf(PANE_WEDGE_SHARE)};
const GLASS_COS_MIN: f32 = ${glf(GLASS_COS_MIN)};
// the smudge's offset in the noise lattice, away from the waviness's
const GLASS_SMUDGE_SALT: vec3f = vec3f(17.3, 41.9, 5.7);

// Glass's body extinction per cell: soda-lime's iron for E_GLASS, the element's own for the rest.
fn glassSigma(id: i32) -> vec3f { return select(SIGMA(id), max(SIGMA(id), GLASS_SODA_SIGMA), id == E_GLASS); }

// Which face neighbours of cell c are the same glass: bit 2a for -a, 2a + 1 for +a.
fn glassNeighbours(c: vec3i, id: i32) -> u32 {
  var m = 0u;
  for (var a = 0; a < 3; a++) {
    for (var s = 0; s < 2; s++) {
      var nc = c;
      nc[a] += select(-1, 1, s == 1);
      if (!outside(nc) && eid(fetchA(nc)) == id) { m |= 1u << u32(2 * a + s); }
    }
  }
  return m;
}
// The shape a cell of glass is drawn as, from its same-glass neighbours m
// (glassNeighbours): n sheets through the cell's middle (0: a block). Sheet
// k faces along axis ak; with rk >= 0 it is half a sheet, on the side sk of
// the cell's middle along axis rk.
//   - a pane: one axis has no glass on either side; the sheet faces along it;
//   - an L corner (two panes meeting, as a tank's corner): along two axes one
//     neighbour each and none between them diagonally: two half sheets, each
//     the end of the pane that goes on through that neighbour, as Minecraft's
//     panes join at a corner;
//   - anything else (a lone cell, a rod, a row, a slab two thick) is a block.
struct GlassShape { n: i32, a0: i32, r0: i32, s0: f32, a1: i32, r1: i32, s1: f32 }
fn glassShape(c: vec3i, id: i32, m: u32) -> GlassShape {
  var g = GlassShape(0, -1, -1, 0.0, -1, -1, 0.0);
  var thin = 0;
  for (var a = 0; a < 3; a++) {
    if (((m >> u32(2 * a)) & 3u) == 0u) { g.a0 = a; thin++; }
  }
  if (thin == 1) { g.n = 1; return g; }
  if (thin != 0) { return GlassShape(0, -1, -1, 0.0, -1, -1, 0.0); }
  for (var b = 0; b < 3; b++) {
    let cAx = (b + 1) % 3;
    let mb = (m >> u32(2 * b)) & 3u;
    let mc = (m >> u32(2 * cAx)) & 3u;
    if ((mb == 1u || mb == 2u) && (mc == 1u || mc == 2u)) {
      let sb = select(-1, 1, mb == 2u);
      let sc = select(-1, 1, mc == 2u);
      var d = c;
      d[b] += sb;
      d[cAx] += sc;
      if (outside(d) || eid(fetchA(d)) != id) {
        // the pane going on along b faces along cAx, and the one going on along cAx faces along b
        return GlassShape(2, cAx, b, f32(sb), b, cAx, f32(sc));
      }
    }
  }
  return g;
}
// Where the ray (ro, rd) meets sheet (axis a, half rs along r; r < 0: whole) of cell c, from tMin on: t, else NO_HIT.
fn sheetHit(ro: vec3f, rd: vec3f, tMin: f32, c: vec3i, a: i32, r: i32, rs: f32) -> f32 {
  if (a < 0) { return NO_HIT; }
  let t = (f32(c[a]) + 0.5 - ro[a]) / rd[a];
  if (!(t >= tMin)) { return NO_HIT; }
  if (r >= 0 && (ro[r] + rd[r] * t - f32(c[r]) - 0.5) * rs < 0.0) { return NO_HIT; }
  return t;
}
// How far point q of cell c's sheet (axis a, half along r) is from the sheet's nearest free edge, cells (1: none).
fn paneEdgeDist(q: vec3f, c: vec3i, a: i32, r: i32, m: u32) -> f32 {
  var d = 1.0;
  for (var k = 1; k < 3; k++) {
    let b = (a + k) % 3;
    if (b == r) { continue; }   // (a half sheet's cut edge joins the other half)
    let u = q[b] - f32(c[b]);
    if (((m >> u32(2 * b)) & 1u) == 0u) { d = min(d, u); }
    if (((m >> u32(2 * b + 1)) & 1u) == 0u) { d = min(d, 1.0 - u); }
  }
  return max(d, 0.0);
}

// The smudge at grid point p: 0 clean .. 1 smudged (see GLASS_SMUDGE_M).
fn glassSmudge(p: vec3f) -> f32 {
  let v = mNoiseD(worldPos(p) * GLASS_SMUDGE_SCALE + GLASS_SMUDGE_SALT).x;
  return smoothstep(1.0 - GLASS_SMUDGE_COVER - GLASS_SMUDGE_SOFT, 1.0 - GLASS_SMUDGE_COVER + GLASS_SMUDGE_SOFT, v);
}
// A glass face at p with flat normal n (toward the eye side of rd): its wavy
// normal, kept facing rd and reflecting off the face's outer side.
fn glassWave(p: vec3f, n: vec3f, rd: vec3f) -> vec3f {
  let g = mNoiseD(worldPos(p) * GLASS_WAVE_SCALE).yzw;
  let w = normalize(n + (g - n * dot(g, n)) * GLASS_WAVE_GAIN);
  let ok = dot(rd, w) < -GLASS_COS_MIN && dot(reflect(rd, w), n) > 0.0;
  return select(n, w, ok);
}
// The smudge's roughness on a face of element id.
fn glassRough(id: i32, smudge: f32) -> f32 { return mix(ROUGH(id), max(ROUGH(id), GLASS_SMUDGE_ROUGH), smudge); }
// The smudge's grease film on the light crossing a face at p.
fn glassHaze(p: vec3f, smudge: f32, sunVis: vec3f, col: ptr<function, vec3f>, trans: ptr<function, vec3f>) {
  let h = smudge * GLASS_SMUDGE_HAZE;
  *col += *trans * h * interiorLight(p, sunVis);
  *trans *= 1.0 - h;
}

// The ray into or out of glass across normal n (toward rd's origin side, wavy),
// flat normal nf: refracted (eta = n_from / n_to), or with Light bending off
// cheapBend (the way in only; out, the ray goes on). Falls back to the flat
// normal where the wavy one would send it back. Zero: total internal reflection.
fn glassBend(rd: vec3f, n: vec3f, nf: vec3f, eta: f32, entering: bool) -> vec3f {
  if (FU.bending == 0u) { return select(rd, cheapBend(rd, n), entering); }
  var rt = refract(rd, n, eta);
  if (dot(rt, rt) > 1e-6 && dot(rt, nf) >= 0.0) { rt = refract(rd, nf, eta); }
  return rt;
}
// A pane's deviation of rd (wavy normal w, flat nf): the thin wedge's (n - 1)·angle.
fn paneDeviate(rd: vec3f, w: vec3f, nf: vec3f, ior: f32) -> vec3f {
  return normalize(rd - (w - nf) * ((ior - 1.0) * PANE_WEDGE_SHARE));
}

// Absorption and scatter through seg cells of glass id in cell c (body
// extinction sigma), its paint (stained glass, gfx/deco.js) over segPaint:
// absorbDeco with the body's own extinction (the iron absorbs, it doesn't
// scatter) and the paint's path apart, so a pane keeps a cell's paint.
fn absorbGlass(id: i32, c: vec3i, p: vec3f, seg: f32, segPaint: f32, sunVis: vec3f, T: f32,
               col: ptr<function, vec3f>, trans: ptr<function, vec3f>) {
  let d = decoAt(c);
  let sigma = glassSigma(id);
  let att = exp(-mix(sigma * seg, vec3f(DECO_SIGMA) * segPaint, d.a));
  let alb = mix(SCATALB(id) * SIGMA(id) / max(sigma, vec3f(1e-6)), decoLinear(d.rgb), d.a);
  *col += *trans * (1.0 - att) * (alb * interiorLight(p, sunVis) + emission(id, T));
  *trans *= att;
}
// The bright line where a pane ends (dist: paneEdgeDist), seen at footprint fp.
fn paneEdge(id: i32, q: vec3f, dist: f32, fp: f32, sunVis: vec3f, col: ptr<function, vec3f>, trans: ptr<function, vec3f>) {
  let w = max(PANE_EDGE_CELLS, fp);
  let e = (1.0 - smoothstep(0.0, w, dist)) * PANE_EDGE_COVER * (PANE_EDGE_CELLS / w);
  if (e <= 0.0) { return; }
  let guided = interiorLight(q, sunVis) * PANE_EDGE_GAIN * exp(-glassSigma(id) * PANE_EDGE_PATH);
  *col += *trans * e * guided;
  *trans *= 1.0 - e;
}
`;
