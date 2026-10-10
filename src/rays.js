// Fast particles (docs/particles.md): photons and neutrons, kept in a list
// beside the grid and flown straight through it. This module is data only:
// the constants, the per-element nuclear and optical tables, their GLSL, and
// a CPU twin of the neutron rules (tools/rays-check.mjs runs it). The GPU
// layer is src/raysLayer.js, its passes src/shaders/rays.js.
import { ELEMENTS, E, R, itemByKey } from './elements.js';
import { BRICK } from './shaders/common.js';
import { activityPeriod } from './shaders/activity.js';

// Particle kinds (the list's kind channel; 0 = a free slot).
export const RAY_KIND = { NONE: 0, PHOTON: 1, NEUTRON: 2 };

// Avogadro's number, and barns to cm² (for Σ = N·σ).
const AVOGADRO = 6.02214e23;
const BARN_CM2 = 1e-24;

export const RAYS = {
  // ---- the list ----
  // Slots per side of the list texture: N = RAY_TEX² particles at most. The
  // hard limit of a runaway (docs/particles.md): a full list spawns no more.
  RAY_TEX: 256,
  // Extra children one slot can ask for in a step (fission: ν − 1 ≤ 2). Each
  // is a fixed slot bijection the spawn pass checks (shaders/rays.js).
  RAY_CHILDREN: 2,
  // Fastest a particle may fly, cells/step: one brick in the steps an
  // activity map lives, so the bricks a particle may touch before the next map
  // are within the one-brick halo the quiet map keeps awake around it.
  RAY_V_MAX: BRICK / activityPeriod(BRICK),
  // Sub-steps of a particle's flight per step, each at most one cell long, so
  // it can't jump a cell (RAY_V_MAX / RAY_SUBSTEPS ≤ 1).
  RAY_SUBSTEPS: 2,

  // ---- photons (TPT PHOT: 3 px/frame, 680 frames) ----
  PHOTON_V: 2,           // cells/step (capped at RAY_V_MAX)
  PHOTON_LIFE: 512,      // steps before it fades: crosses a 128-cell box 8 times
  // Heat a white packet leaves where it is absorbed, in heat-capacity units
  // (elements.js cap · °C): TPT's photon is 922 °C and averages its temperature
  // with what it hits, so a 20 °C plank goes to ~470 °C. Ours warms wood
  // (cap 0.3) by 300 °C, its ignition point, metal (0.85) by 106 °C.
  PHOTON_HEAT: 90,
  // A photon whose brightest channel has dropped below this share is spent
  // (its last energy is left as heat).
  PHOTON_E_MIN: 0.02,

  // ---- neutrons (TPT NEUT: 1-2 px/frame, 480-959 frames) ----
  NEUT_V: 2,             // cells/step at NEUT_E_FAST (capped at RAY_V_MAX)
  // Slowest a neutron flies, cells/step. A thermal neutron (0.025 eV) is
  // ~10^4 times slower than a fission one; at its real speed it would sit
  // still, so its time runs faster (TPT's neutrons all fly at 1-2 px/frame).
  NEUT_V_THERMAL: 0.25,
  NEUT_LIFE: 1024,       // steps at most (a cap: free neutrons decay in ~15 min)
  NEUT_E_FAST: 2.0,      // MeV: a fission neutron's mean energy (Watt spectrum, U-235/Pu-239)
  NEUT_E_THERMAL: 2.53e-8,   // MeV: 0.0253 eV, thermal at 20 °C (cross-section tables' reference)
  // A cell is this many cm of matter to a neutron (a stated liberty,
  // docs/particles.md): at the real 30 cm, one cell of plutonium is ~50
  // critical masses. Cross-sections keep their real ratios.
  NEUT_CM_PER_CELL: 1.0,
  // Heat per fission packet, heat-capacity units: plutonium (cap 0.62) warms
  // ~240 °C, so a few fissions melt a cell (640 °C). A packet stands for many
  // fissions; 200 MeV each is what makes this large.
  FISSION_HEAT: 150,
  // Air pressure per fission packet (gunpowder's blast is 60): the prompt
  // energy that throws a runaway lump apart.
  FISSION_P: 20,
  // Heat of a capture packet: its ~6.5 MeV of gamma rays against ~200 MeV of
  // fission (ENDF/B-VII.1 capture Q-values for U-238 and Pu-239).
  CAPTURE_HEAT: 150 * 6.5 / 200,

  // ---- painting particles ----
  RAY_PAINT_PER_CELL: 0.05,   // particles per brush cell per frame (× the brush rate)
  RAY_PAINT_MAX: 512,         // at most this many a frame
};

// Microscopic cross-sections (barns), the nuclear table. Each row is one
// element as a material: density (g/cm³), molar mass (g/mol of the formula
// unit), cross-sections per formula unit, fast (one group, ~1-2 MeV) and
// thermal (0.0253 eV), ν (neutrons per fission), the share of scatters off
// hydrogen (they lose a uniform share of their energy) and the mass number of
// the rest (they lose up to 1 − α, α = ((A − 1)/(A + 1))²). Sources:
//   Pu-239 and U-238 fast: Lamarsh & Baratta, Introduction to Nuclear
//   Engineering (3rd ed.), Table 6.1, one-group fast constants (σf, σγ, σtr, ν).
//   Thermal values: ENDF/B-VII.1 at 2200 m/s (Pu-239 σf 747.4, σγ 270.3,
//   σs 7.8, ν 2.88; U-235 σf 585, σγ 98.8, ν 2.43; U-238 σγ 2.68, σs 9.3);
//   natural uranium is 0.72% U-235.
//   Water: H σs ~2.9 b at 2 MeV, O ~1.6 b; thermal Σs 3.45 cm⁻¹ for bound H₂O
//   (103 b a molecule) and σa 2 × 0.332 b (Lamarsh Table II.3).
// Elements not in the table are transparent to neutrons (docs/particles.md).
const NAT_U235 = 0.0072;   // natural uranium's U-235 atom share
const WATER_XS = { M: 18.015, sF: 7.4, aF: 0, fF: 0, sT: 103, aT: 0.664, fT: 0, nuF: 0, nuT: 0, h: 0.8, A: 16 };
export const NUCLEAR = {
  WATER: { rho: 1.0, ...WATER_XS },
  ICE: { rho: 0.917, ...WATER_XS },
  SNOW: { rho: 0.3, ...WATER_XS },   // a settled snowpack, 0.1-0.5 g/cm³
  URANIUM: {
    rho: 19.1, M: 238.03, sF: 6.9 - 0.095 - 0.16, aF: 0.16, fF: 0.095, nuF: 2.6,
    sT: 9.3, aT: NAT_U235 * 98.8 + (1 - NAT_U235) * 2.68, fT: NAT_U235 * 585, nuT: 2.43, h: 0, A: 238,
  },
  PLUTONIUM: {
    rho: 19.8, M: 239.05, sF: 6.8 - 1.85 - 0.26, aF: 0.26, fF: 1.85, nuF: 2.98,
    sT: 7.8, aT: 270.3, fT: 747.4, nuT: 2.88, h: 0, A: 239,
  },
};

// Spontaneous fission neutrons per cell per step (packets), by element. Real
// weapons-grade plutonium gives ~60 n/s/g (its 6% Pu-240); natural uranium
// 0.014 n/s/g, 4,400× less, which rounds to nothing here.
export const EMITTERS = { PLUTONIUM: 2e-5 };

// Macroscopic cross-sections per cell (Σ = N·σ, per cm, × NEUT_CM_PER_CELL)
// of an element, fast and thermal: [sF, aF, fF, sT, aT, fT].
export function sigmas(key) {
  const n = NUCLEAR[key];
  if (!n) return [0, 0, 0, 0, 0, 0];
  const N = n.rho * AVOGADRO / n.M * BARN_CM2 * RAYS.NEUT_CM_PER_CELL;
  return [n.sF, n.aF, n.fF, n.sT, n.aT, n.fT].map((s) => s * N);
}

// Photon reflectance of an element (elements.js reflect: metals), and whether
// it lets light through (render classes that aren't opaque: the renderer's
// sigma then attenuates it).
export const reflectOf = (e) => e.reflect ?? 0;
export const isClear = (e) => e.render !== R.OPAQUE;

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const arr = (name, fn) => `const float ${name}[NE] = float[NE](${ELEMENTS.map((e) => f(+fn(e).toPrecision(6))).join(', ')});`;
export function raysGLSL() {
  const sig = ELEMENTS.map((e) => sigmas(e.key));
  const nu = (k) => (e) => NUCLEAR[e.key]?.[k] ?? 0;
  return [
    ...Object.entries(RAYS).map(([k, v]) => `#define ${k} ${f(v)}`),
    ...Object.entries(RAY_KIND).map(([k, v]) => `#define RAY_${k} ${v}`),
    ...['SF', 'AF', 'FF', 'ST', 'AT', 'FT'].map((s, i) => arr(`NSIG_${s}`, (e) => sig[e.id][i])),
    arr('NU_F', nu('nuF')),
    arr('NU_T', nu('nuT')),
    arr('N_HSHARE', nu('h')),
    arr('N_MASS', (e) => NUCLEAR[e.key]?.A ?? 1),
    arr('SF_RATE', (e) => EMITTERS[e.key] ?? 0),
    arr('REFLECT', reflectOf),
  ].join('\n');
}

// ---- CPU twin of the neutron rules (shaders/rays.js advance) ----
// Share of the way from thermal to fast in ln E: 0 thermal, 1 fast.
export function fastShare(E) {
  const { NEUT_E_THERMAL: Et, NEUT_E_FAST: Ef } = RAYS;
  return Math.min(1, Math.max(0, Math.log(E / Et) / Math.log(Ef / Et)));
}
// Σ per cell of element key at energy E (MeV): [scatter, capture, fission, ν].
// Scattering interpolates in ln E; capture and fission follow 1/v below the
// fast plateau.
export function crossSections(key, E) {
  const [sF, aF, fF, sT, aT, fT] = sigmas(key);
  const w = fastShare(E), v = Math.sqrt(RAYS.NEUT_E_THERMAL / E);
  const n = NUCLEAR[key];
  return [sT + (sF - sT) * w, Math.max(aF, aT * v), Math.max(fF, fT * v), n ? n.nuT + (n.nuF - n.nuT) * w : 0];
}
// A neutron's speed at energy E, cells/step.
export function neutronSpeed(E) {
  return Math.min(RAYS.RAY_V_MAX, Math.max(RAYS.NEUT_V_THERMAL, RAYS.NEUT_V * Math.sqrt(E / RAYS.NEUT_E_FAST)));
}
// Energy after scattering off element key (u: a uniform random number, h: another).
export function scatterEnergy(key, E, u, h) {
  const n = NUCLEAR[key];
  if (!n) return E;
  if (h < n.h) return Math.max(RAYS.NEUT_E_THERMAL, E * u);
  const a = ((n.A - 1) / (n.A + 1)) ** 2;
  return Math.max(RAYS.NEUT_E_THERMAL, E * (a + (1 - a) * u));
}

// The brush tools that paint particles (their TOOLS rows in elements.js), by
// key, and the particle kind a tool id paints (0: not a particle tool).
export const RAY_TOOLS = { PHOTON: RAY_KIND.PHOTON, NEUTRON: RAY_KIND.NEUTRON };
const RAY_TOOL_KINDS = new Map(Object.entries(RAY_TOOLS).map(([k, kind]) => [itemByKey(k).id, kind]));
export const rayKindOfTool = (id) => RAY_TOOL_KINDS.get(id) ?? RAY_KIND.NONE;
// Elements whose presence means particles may appear (they emit on their own).
export const emitterIds = () => Object.keys(EMITTERS).map((k) => E[k]);
