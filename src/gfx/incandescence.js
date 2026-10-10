// Incandescence: the light a hot opaque body gives off, as a table over
// temperature that the shaders interpolate (common.js, incandescence()).
//
// The colour is physical: Planck's law integrated against the CIE 1931 colour
// matching functions (Wyman, Sloan & Shirley 2013 multi-lobe fit), converted to
// linear sRGB. Below ~800 °C a blackbody is redder than sRGB's red primary, so
// it is clipped to the gamut edge.
//
// The brightness is compressed. From the Draper point to molten rock a
// blackbody's luminance climbs about a million-fold (0.1 cd/m² at 600 °C,
// 6000 at 1200 °C, 2·10⁵ at 1600 °C), far more than one exposure can hold next
// to sunlit ground (~3·10⁴ cd/m²): physically, steel at 800 °C is invisible in
// daylight and lava blinding. The eye adapts instead (a blacksmith reads the
// colour scale in a dim forge), so the luminance goes through a power law
// anchored at REF_T. Steel then reads dull red at 600–700 °C, cherry to orange at
// 800–1000 °C, and molten rock outshines anything sunlit.
export const INCAND = {
  REF_T: 1200,     // °C, anchor of the brightness curve
  REF_LUM: 0.3,    // its luminance in scene units (sunlit white ≈ 1.2)
  GAMMA: 0.35,     // exponent on the physical luminance ratio (1 = physical)
  FADE_LO: 450,    // °C: nothing glows below this (the Draper point is 525 °C)…
  FADE_HI: 600,    // …and the glow fades in up to here
  T0: 400,         // °C, first table knot; knots every STEP up to T0 + (N-1)·STEP
  STEP: 100,       // °C
  N: 32,           // knots; hotter than the last one is clamped to it
  LOG_FLOOR: -24,  // log2 luminance stored for "no glow" (6e-8: black in any exposure)
  // °C the open skin of a hot non-metal runs below its bulk. At 1000 °C a surface
  // radiates ~100 kW/m²; through rock (k ≈ 2 W/m·K) that takes ~50 K per mm, so
  // the outer millimetres are hundreds of degrees cooler and the cracks glow first.
  // Metals conduct ~20× better and keep no such skin.
  SKIN_DROP: 200,
};

const LUMA = [0.2126, 0.7152, 0.0722];   // Rec.709 luminance weights (linear sRGB)
const LAMBDA = [360, 830, 1];            // nm: integration range and step
export const KELVIN = 273.15;            // °C to K (GLSL: C_TO_K in shaders/common.js)
// physical constants (SI) and the luminous efficacy of 555 nm light
const H = 6.62607015e-34, C = 2.99792458e8, KB = 1.380649e-23, KM = 683;
const M_PER_NM = 1e-9;                   // metres per nanometre
const GLSL_DIGITS = 6;                   // significant digits of the table as GLSL literals
// CIE XYZ (D65) to linear sRGB
const XYZ_TO_SRGB = [
  [3.2406, -1.5372, -0.4986],
  [-0.9689, 1.8758, 0.0415],
  [0.0557, -0.2040, 1.0570],
];

// piecewise Gaussian lobe of the multi-lobe CMF fit
const lobe = (x, mu, s1, s2) => {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
};
// CIE 1931 2° colour matching functions at wavelength l (nm)
function cmf(l) {
  return [
    1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2),
    0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1),
    1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8),
  ];
}
// spectral radiance, W / (m² sr nm)
function planck(lnm, tK) {
  const l = lnm * M_PER_NM;
  return (2 * H * C * C) / l ** 5 / (Math.exp((H * C) / (l * KB * tK)) - 1) * M_PER_NM;
}
// The colour of light with spectral radiance spd(nm) (W / (m² sr nm)): linear
// sRGB with unit luminance, clipped to the gamut's edge, and luminance in cd/m²
function colourOf(spd) {
  const xyz = [0, 0, 0];
  for (let l = LAMBDA[0]; l <= LAMBDA[1]; l += LAMBDA[2]) {
    const p = spd(l) * LAMBDA[2];
    cmf(l).forEach((v, k) => { xyz[k] += KM * p * v; });
  }
  const rgb = XYZ_TO_SRGB.map((row) => Math.max(0, row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2]));
  const y = rgb.reduce((s, v, k) => s + v * LUMA[k], 0);
  return { chroma: rgb.map((v) => v / y), lum: xyz[1] };
}
// blackbody at tC (°C)
const blackbody = (tC) => colourOf((l) => planck(l, tC + KELVIN));

// Luminescence (gfx/materials.js emit): a mineral's emission band, a Gaussian
// peaking at peak nm, fwhm nm wide, through the same colour matching. Returns
// linear sRGB of luminance lum (scene units, as the incandescence's REF_LUM).
const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);
export function bandGlow(peak, fwhm, lum) {
  const s = fwhm / FWHM_PER_SIGMA;
  return colourOf((l) => Math.exp(-0.5 * ((l - peak) / s) ** 2)).chroma.map((v) => v * lum);
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Table knots: [r, g, b] = colour of unit luminance, a = log2 of the rendered luminance.
export const INCAND_TABLE = (() => {
  const ref = blackbody(INCAND.REF_T).lum;
  return Array.from({ length: INCAND.N }, (_, i) => {
    const t = INCAND.T0 + i * INCAND.STEP;
    const { chroma, lum } = blackbody(t);
    const L = INCAND.REF_LUM * (lum / ref) ** INCAND.GAMMA * smoothstep(INCAND.FADE_LO, INCAND.FADE_HI, t);
    return [...chroma, L > 0 ? Math.max(Math.log2(L), INCAND.LOG_FLOOR) : INCAND.LOG_FLOOR];
  });
})();

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(+x.toPrecision(GLSL_DIGITS)));

export function incandescenceGLSL() {
  return /* glsl */ `
#define INCAND_T0 ${f(INCAND.T0)}
#define INCAND_STEP ${f(INCAND.STEP)}
#define INCAND_N ${INCAND.N}
#define INCAND_SKIN_DROP ${f(INCAND.SKIN_DROP)}
// rgb = blackbody colour of unit luminance, a = log2 rendered luminance (gfx/incandescence.js)
const vec4 INCAND_TAB[INCAND_N] = vec4[INCAND_N](
  ${INCAND_TABLE.map((k) => `vec4(${k.map(f).join(', ')})`).join(',\n  ')});
// Glow of an opaque blackbody at tC (°C), linear radiance in scene units:
// nothing below ~500 °C, dull red, cherry, orange, then yellow-white.
vec3 incandescence(float tC) {
  float x = (tC - INCAND_T0) / INCAND_STEP;
  if (x <= 0.0) return vec3(0.0);
  x = min(x, float(INCAND_N - 1));
  int i = min(int(x), INCAND_N - 2);
  float u = x - float(i);
  vec4 a = INCAND_TAB[i], b = INCAND_TAB[i + 1];
  return mix(a.rgb, b.rgb, u) * exp2(mix(a.a, b.a, u));
}`;
}
