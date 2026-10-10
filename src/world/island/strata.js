import { definesGLSL, jsConstants } from '../scenes/themedShared.js';
import { CELL_M } from '../../scale.js';
import { E } from '../../elements.js';

// The island's bedrock: sedimentary strata over a crystalline basement, as a
// pure function of the world cell (islandRock), written once in the shared
// GLSL subset (scenes/themedShared.js): the GPU runs it, the CPU its JS twin.
//
// The sequence is the Carboniferous of the Yorkshire Dales and the Pennines
// (British Geological Survey, Waters et al. 2009, "A lithostratigraphical
// framework for the Carboniferous successions of Great Britain (onshore)",
// BGS Research Report RR/09/01), bottom up:
//   - BASEMENT: folded Lower Palaeozoic slate and greywacke (here ROCK), its
//     top planed off by erosion: the Great Unconformity, as seen under the
//     Great Scar Limestone at Thornton Force, Ingleton;
//   - LIMESTONE: the Great Scar Limestone, a shallow tropical shelf's, in
//     LIME_BEDS massive beds;
//   - the Coal Measures: cyclothems (Wanless & Weller 1932, "Correlation and
//     extent of Pennsylvanian cyclothems", GSA Bulletin 43), each a SANDSTONE
//     bed (a river channel's and delta's sand) topped by a COAL seam (the
//     swamp that grew on it before the sea came back). The shale and
//     seatearth of a real cycle are folded into the sandstone: there is no
//     shale element.
// Real thicknesses don't fit the island, whose relief is about 25 m (the
// limestone alone is ~200 m thick in the Dales, a cyclothem 10-30 m): the
// units and cycles are thinned to fit, keeping their order and proportions,
// while the coal seams keep real thicknesses (0.3-0.6 m: thin seams were
// already thin). Thicknesses are in metres here and turn into cells below.
//
// Structure. The beds dip DIP_DEG (the Dales' Carboniferous dips a few
// degrees off the Askrigg Block) toward a seeded direction, are warped by
// open folds (FOLD_*: noise) and roughened a little (ROUGH_*: bedding planes
// aren't flat), so each unit outcrops as a winding band across the island:
// basement and limestone in the up-dip cliffs, sandstone and coal on the
// down-dip side and the high ground. Coal seams swell, thin and pinch out
// along their length (PINCH_*), as real seams do where river channels cut
// them out. A cell's stratigraphic height s (stHeight) is its height above
// the datum (sea level at the island's centre) with the dip and folds taken
// out: the units are bands of s.
//
// The landforms read the same beds (stBench): the mesas' terraces are the
// sandstone beds' tops, where the coal over them weathered back (landforms.js).

const cells = (m) => m / CELL_M;
const DEG = Math.PI / 180;

// The rock elements. SANDSTONE, LIMESTONE and COAL come with the new rock
// elements; until they land, each is a named placeholder for ROCK: the strata
// compute and preview the same, the game just shows them all as rock.
export const STRATA_ELEMENTS = {
  BASEMENT: E.ROCK,
  LIMESTONE: E.LIMESTONE ?? E.ROCK,
  SANDSTONE: E.SANDSTONE ?? E.ROCK,
  COAL: E.COAL ?? E.ROCK,
};
// stUnit's units, in the order they were laid down
export const STRATA_UNITS = ['BASEMENT', 'LIMESTONE', 'SANDSTONE', 'COAL'];

const S = {
  ints: {
    LIME_BEDS: 3,               // the limestone's massive beds (each forms a bench where it is terraced)
    CYCLES: 9,                  // cyclothems over the limestone (enough to reach past the highest ground, dip and folds included)
    ...Object.fromEntries(STRATA_UNITS.map((u, i) => [`UNIT_${u}`, i])),
    ...Object.fromEntries(Object.entries(STRATA_ELEMENTS).map(([u, id]) => [`E_${u}`, id])),
  },
  floats: {
    BASEMENT_TOP: cells(-1.5),  // the unconformity, metres above the datum: just under the sea at the island's centre
    LIMESTONE: cells(7.5),      // the limestone's thickness
    CYCLE_MIN: cells(2.4),      // a cyclothem's thickness (sandstone and its coal seam), seeded per cycle
    CYCLE_MAX: cells(3.6),
    COAL: cells(0.45),          // a coal seam's mean thickness...
    PINCH_AMP: 1.3,             // ...swelling and thinning by up to this share of it (noise), pinching out below zero...
    PINCH_WAVE: cells(25),      // ...over this length along the seam
    SEAM_SHIFT: 37.0,           // lattice units between successive seams' pinch noise (so each seam pinches in its own places)
    DIP: Math.tan(2.5 * DEG),   // the regional dip, cells per cell (2.5°)
    FOLD_AMP: cells(2.4),       // open folds: the beds rise and fall this much...
    FOLD_WAVE: cells(120),      // ...over this wavelength
    ROUGH_AMP: cells(0.15),     // bedding planes' roughness...
    ROUGH_WAVE: cells(3),       // ...over this wavelength
  },
  salts: {
    DIP: 0x5710,                // the dip's direction
    FOLD: 0x5720,
    ROUGH: 0x5730,
    CYCLE: 0x5740,              // cycle thicknesses
    PINCH: 0x5750,
  },
};
export const STRATA_PREFIX = 'ST';
export const strataDefinesGLSL = () => definesGLSL(STRATA_PREFIX, S);
export const strataConstants = () => jsConstants(STRATA_PREFIX, S);
export const STRATA = { ...S.ints, ...S.floats };

// Needs the noise (noise.js NOISE_SRC) and, as uniforms (or, in the JS twin,
// constants): uIslandSea (sea level, cells) and uIslandCx, uIslandCz (the
// island's centre, world cells), around which the beds dip.
export const STRATA_SRC = /* glsl */ `
// How far the beds are raised at column (x, z), cells: the regional dip
// toward the seeded direction, the folds and the bedding planes' roughness.
float stRaise(float x, float z) {
  float a = thUnit(thHash2(0, 0, ST_SALT_DIP)) * LFN_TAU;
  float fold = lfNoise2(thFdiv(x, ST_FOLD_WAVE), thFdiv(z, ST_FOLD_WAVE), ST_SALT_FOLD);
  float rough = lfNoise2(thFdiv(x, ST_ROUGH_WAVE), thFdiv(z, ST_ROUGH_WAVE), ST_SALT_ROUGH);
  return ST_DIP * ((x - uIslandCx) * cos(a) + (z - uIslandCz) * sin(a)) + ST_FOLD_AMP * fold + ST_ROUGH_AMP * rough;
}
// The stratigraphic height of world height y at column (x, z): cells above
// the datum once the dip and folds are taken out.
float stHeight(float x, float y, float z) { return y - uIslandSea - stRaise(x, z); }
float stLimeTop() { return ST_BASEMENT_TOP + ST_LIMESTONE; }
// cyclothem k's thickness
float stCycle(int k) { return mix(ST_CYCLE_MIN, ST_CYCLE_MAX, thUnit(thHash2(k, 0, ST_SALT_CYCLE))); }
// the coal seam's thickness on top of cyclothem k at column (x, z) (0: pinched out)
float stCoal(int k, float x, float z) {
  float shift = float(k) * ST_SEAM_SHIFT;
  float n = lfNoise2(thFdiv(x, ST_PINCH_WAVE) + shift, thFdiv(z, ST_PINCH_WAVE), ST_SALT_PINCH);
  return max(ST_COAL * (1.0 + ST_PINCH_AMP * n), 0.0);
}

// The unit (ST_UNIT_*) at stratigraphic height s of column (x, z).
int stUnitAt(float x, float z, float s) {
  if (s < ST_BASEMENT_TOP) return ST_UNIT_BASEMENT;
  float top = stLimeTop();
  if (s < top) return ST_UNIT_LIMESTONE;
  for (int k = 0; k < ST_CYCLES; k++) {
    top += stCycle(k);
    if (s < top) return s >= top - stCoal(k, x, z) ? ST_UNIT_COAL : ST_UNIT_SANDSTONE;
  }
  return ST_UNIT_SANDSTONE;
}
int stUnit(float x, float y, float z) { return stUnitAt(x, z, stHeight(x, y, z)); }
int stElement(int unit) {
  if (unit == ST_UNIT_LIMESTONE) return ST_E_LIMESTONE;
  if (unit == ST_UNIT_SANDSTONE) return ST_E_SANDSTONE;
  if (unit == ST_UNIT_COAL) return ST_E_COAL;
  return ST_E_BASEMENT;
}

// The benches the beds make where the land is terraced: the stratigraphic
// heights of the resistant beds' tops (the unconformity, the limestone's
// bedding planes, each sandstone's top under its mean coal seam), the nearest
// one at or below s (above: false) or above it (above: true). Past the last
// cycle they go on a CYCLE_MAX apart.
float stBench(float s, bool above) {
  float c = ST_BASEMENT_TOP;
  float prev = c - ST_CYCLE_MAX;
  if (c > s) return above ? c : prev;
  for (int i = 1; i <= ST_LIME_BEDS; i++) {
    prev = c;
    c = ST_BASEMENT_TOP + ST_LIMESTONE * thFdiv(float(i), float(ST_LIME_BEDS));
    if (c > s) return above ? c : prev;
  }
  float top = c;
  for (int k = 0; k < ST_CYCLES; k++) {
    top += stCycle(k);
    prev = c;
    c = top - ST_COAL;
    if (c > s) return above ? c : prev;
  }
  return above ? c + ST_CYCLE_MAX : c;
}

// The bedrock element of rock cell (x, y, z) (the foundation's hook; ground:
// its column's ground height, unused: the beds don't follow the surface).
int islandRock(int x, int y, int z, float ground) {
  return stElement(stUnit(float(x) + 0.5, float(y) + 0.5, float(z) + 0.5));
}
`;
