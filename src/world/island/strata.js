import { CELL_M } from '../../scale.js';
import { E } from '../../elements.js';

// The island's strata (docs/scaling.md D11, "Island hooks"): which rock its
// bedrock is, cell by cell: sedimentary beds over a crystalline basement.
//
// Written once in the shared GLSL subset (scenes/themedShared.js): the GPU runs
// it in the island's sceneCell (scenes/island.js), the CPU its JS twin
// (world/generator.js islandTwin). It runs for every ground cell under the
// column's cover (sand, snow, plant cover): the cells that would be rock. The
// landforms read the same beds in the column bake (STRATA_BEDS_SRC: the mesas'
// terraces are the sandstone beds' tops, world/island/landforms.js).
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
// while the coal seams keep real thicknesses (0.3 m: thin seams were already
// thin, and coal is a few per cent of real Coal Measures). Thicknesses are in
// metres here and turn into cells below.
//
// Structure. The beds dip DIP (the Dales' Carboniferous dips a few degrees off
// the Askrigg Block) toward a seeded direction, are warped by open folds
// (FOLD_*: noise) and roughened a little (ROUGH_*: bedding planes aren't
// flat), so each unit outcrops as a winding band across the island: basement
// and limestone on the up-dip side, sandstone and coal on the down-dip side
// and the high ground. Coal seams swell, thin and pinch out along their length
// (PINCH_*), as real seams do where river channels cut them out. A cell's
// stratigraphic height s (stHeight) is its height above the datum (sea level
// at the island's centre) with the dip and folds taken out: the units are
// bands of s.
//
// In scope: the island's world parameters (uGenSea, uGenCenterX/Z, ...), the
// subset's helpers (thNoised, thStream, thHash2, ...) and the element ids.

const cells = (m) => m / CELL_M;
const DEG = Math.PI / 180;

// Each unit's element (the source's stElement says the same with E_* names).
export const STRATA_ELEMENTS = { BASEMENT: E.ROCK, LIMESTONE: E.LIMESTONE, SANDSTONE: E.SANDSTONE, COAL: E.COAL };
// stUnit's units, in the order they were laid down
export const STRATA_UNITS = ['BASEMENT', 'LIMESTONE', 'SANDSTONE', 'COAL'];

const S = {
  ints: {
    LIME_BEDS: 3,               // the limestone's massive beds (each forms a bench where it is terraced)
    CYCLES: 9,                  // cyclothems over the limestone (enough to reach past the highest ground, dip and folds included)
    ...Object.fromEntries(STRATA_UNITS.map((u, i) => [`UNIT_${u}`, i])),
  },
  floats: {
    BASEMENT_TOP: cells(-1.5),  // the unconformity, metres above the datum: just under the sea at the island's centre
    LIMESTONE: cells(7.5),      // the limestone's thickness
    CYCLE_MIN: cells(2.4),      // a cyclothem's thickness (sandstone and its coal seam), seeded per cycle
    CYCLE_MAX: cells(3.6),
    COAL: cells(0.3),           // a coal seam's mean thickness...
    PINCH_AMP: 1.5,             // ...swelling and thinning by up to this share of it (noise), pinching out below zero...
    PINCH_WAVE: cells(25),      // ...over this length along the seam
    DIP: Math.tan(2.5 * DEG),   // the regional dip, cells per cell (2.5°)
    FOLD_AMP: cells(2.4),       // open folds: the beds rise and fall this much...
    FOLD_WAVE: cells(120),      // ...over this wavelength
    ROUGH_AMP: cells(0.15),     // bedding planes' roughness...
    ROUGH_WAVE: cells(3),       // ...over this wavelength
    TAU: 2 * Math.PI,
  },
  salts: {
    DIP: 0x5710,                // the dip's direction
    FOLD: 0x5720,
    ROUGH: 0x5730,
    CYCLE: 0x5740,              // cycle thicknesses
    PINCH: 0x5750,              // (each seam its own stream, k further on)
  },
};
export const STRATA = { ...S.ints, ...S.floats };

// The beds' geometry: what the landforms' terraces read too.
export const STRATA_BEDS_SRC = /* glsl */ `
// How far the beds are raised at column (x, z), cells: the regional dip
// toward the seeded direction, the folds and the bedding planes' roughness.
float stRaise(float x, float z) {
  float a = thUnit(thHash2(0, 0, STRATA_SALT_DIP)) * STRATA_TAU;
  float fold = thNoised(thFdiv(x, STRATA_FOLD_WAVE), thFdiv(z, STRATA_FOLD_WAVE), thStream(STRATA_SALT_FOLD, 0));
  float rough = thNoised(thFdiv(x, STRATA_ROUGH_WAVE), thFdiv(z, STRATA_ROUGH_WAVE), thStream(STRATA_SALT_ROUGH, 0));
  return STRATA_DIP * ((x - uGenCenterX) * cos(a) + (z - uGenCenterZ) * sin(a)) + STRATA_FOLD_AMP * fold + STRATA_ROUGH_AMP * rough;
}
// The stratigraphic height of world height y at column (x, z): cells above
// the datum once the dip and folds are taken out.
float stHeight(float x, float y, float z) { return y - uGenSea - stRaise(x, z); }
float stLimeTop() { return STRATA_BASEMENT_TOP + STRATA_LIMESTONE; }
// cyclothem k's thickness
float stCycle(int k) { return mix(STRATA_CYCLE_MIN, STRATA_CYCLE_MAX, thUnit(thHash2(k, 0, STRATA_SALT_CYCLE))); }

// The benches the beds make where the land is terraced: the stratigraphic
// heights of the resistant beds' tops (the unconformity, the limestone's
// bedding planes, each sandstone's top under its coal seam where the seam is
// thickest, so a bench is always sandstone), the nearest one at or below s
// (above: false) or above it (above: true). Past the last cycle they go on a
// CYCLE_MAX apart.
float stBench(float s, bool above) {
  float c = STRATA_BASEMENT_TOP;
  float prev = c - STRATA_CYCLE_MAX;
  if (c > s) return above ? c : prev;
  for (int i = 1; i <= STRATA_LIME_BEDS; i++) {
    prev = c;
    c = STRATA_BASEMENT_TOP + STRATA_LIMESTONE * thFdiv(float(i), float(STRATA_LIME_BEDS));
    if (c > s) return above ? c : prev;
  }
  float top = c;
  for (int k = 0; k < STRATA_CYCLES; k++) {
    top += stCycle(k);
    prev = c;
    c = top - STRATA_COAL * (1.0 + STRATA_PINCH_AMP);
    if (c > s) return above ? c : prev;
  }
  return above ? c + STRATA_CYCLE_MAX : c;
}
`;

// The units, cell by cell.
const STRATA_UNITS_SRC = /* glsl */ `
// the coal seam's thickness on top of cyclothem k at column (x, z) (0: pinched out)
float stCoal(int k, float x, float z) {
  float n = thNoised(thFdiv(x, STRATA_PINCH_WAVE), thFdiv(z, STRATA_PINCH_WAVE), thStream(STRATA_SALT_PINCH, k));
  return max(STRATA_COAL * (1.0 + STRATA_PINCH_AMP * n), 0.0);
}
// The unit (STRATA_UNIT_*) at stratigraphic height s of column (x, z).
int stUnitAt(float x, float z, float s) {
  if (s < STRATA_BASEMENT_TOP) return STRATA_UNIT_BASEMENT;
  float top = stLimeTop();
  if (s < top) return STRATA_UNIT_LIMESTONE;
  for (int k = 0; k < STRATA_CYCLES; k++) {
    top += stCycle(k);
    if (s < top) return s >= top - stCoal(k, x, z) ? STRATA_UNIT_COAL : STRATA_UNIT_SANDSTONE;
  }
  return STRATA_UNIT_SANDSTONE;
}
int stUnit(float x, float y, float z) { return stUnitAt(x, z, stHeight(x, y, z)); }
int stElement(int unit) {
  if (unit == STRATA_UNIT_LIMESTONE) return E_LIMESTONE;
  if (unit == STRATA_UNIT_SANDSTONE) return E_SANDSTONE;
  if (unit == STRATA_UNIT_COAL) return E_COAL;
  return E_ROCK;
}

// The bedrock element at world cell (x, y, z) of a column whose terrain height
// is ground (unused: the beds don't follow the surface).
int islandRock(int x, int y, int z, float ground) {
  return stElement(stUnit(float(x) + 0.5, float(y) + 0.5, float(z) + 0.5));
}
`;

export const strata = {
  prefix: 'STRATA',
  tables: S,
  src: `${STRATA_BEDS_SRC}\n${STRATA_UNITS_SRC}`,
};
