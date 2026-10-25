// Original voxel geography, inspired by City Folk's connected terraces and
// Minecraft's walkable one-cell rises. Coordinates are LOCAL [x,z], not metres.
// The tiny original village and old-save branch remain in willowCove.js.
import { CITY_FOLK_TOWN } from './town.js';

const sites = {
  townHall: { at: [-280, 12], floor: 24, half: [34, 20], entry: [-280, 30] },
  nookShop: { at: [-380, 12], floor: 24, half: [20, 16], entry: [-380, 22] },
  ableShop: { at: [-430, 12], floor: 24, half: [20, 16], entry: [-430, 22] },
  eventSquare: { at: [-326, 12], floor: 24, half: [20, 18], entry: [-326, 24] },
  cafe: { at: [264, -80], floor: 36, half: [20, 16], entry: [250, -80] },
  museum: { at: [300, -80], floor: 36, half: [36, 22], entry: [280, -80] },
  upperWest: { at: [-400, -112], floor: 48, half: [22, 18], entry: [-400, -100] },
  upperEast: { at: [-680, -112], floor: 48, half: [22, 18], entry: [-680, -100] },
  lowerWest: { at: [-400, 80], floor: 24, half: [22, 20], entry: [-400, 92] },
  lowerEast: { at: [-680, 80], floor: 24, half: [22, 20], entry: [-680, 92] },
  vacantUpper: { at: [-500, -112], floor: 48, half: [22, 18], entry: [-500, -98] },
  vacantLower: { at: [-500, 80], floor: 24, half: [22, 20], entry: [-500, 94] },
  gate: { at: [-260, -124], floor: 48, half: [18, 12], entry: [-260, -116] },
  busStop: { at: [-236, -116], floor: 48, half: [18, 12], entry: [-220, -116] },
};

// Pad the actual door approaches as well as shells: their published floors
// are an authored terrace, not an assumption about the curved cliff below.
const approaches = CITY_FOLK_TOWN.landmarks.approaches.map(points => ({
  points, floor: points[0][1] < -96 ? 48 : points[0][0] > 0 ? 36 : 24,
}));
const segment = ([[ax, az], [bx, bz]], half = 5) => `x >= ${Math.min(ax, bx) - half} && x <= ${Math.max(ax, bx) + half} && z >= ${Math.min(az, bz) - half} && z <= ${Math.max(az, bz) + half}`;

// Minecraft-style real basins, not water-coloured decoration. Keep their
// complete rocky rims off shells, approaches and the original village core.
const neighborhoodPonds = [
  { name: 'shops', at: [-464, 8], radius: 7, floor: 24, access: [-464, 36] },
  { name: 'lower-west', at: [-450, 70], radius: 7, floor: 24, access: [-450, 100] },
  { name: 'lower-east', at: [-630, 70], radius: 7, floor: 24, access: [-630, 100] },
  { name: 'original-home-edge', at: [216, 60], radius: 6, floor: 24, access: [216, 36] },
].map(p => ({ ...p, bankRadius: p.radius + 3, water: p.floor - 4, bed: p.floor - 9,
  banks: [[p.at[0] - p.radius - 7, p.at[1]], [p.at[0] + p.radius + 7, p.at[1]],
    [p.at[0], p.at[1] - p.radius - 7], [p.at[0], p.at[1] + p.radius + 7]] }));
const ponds = [
  { at: [-600, -4], radius: 12, bankRadius: 16 },
  { at: [400, 72], radius: 11, bankRadius: 15 },
  ...neighborhoodPonds,
];
const pondMask = (p, bank = false) => {
  const [x, z] = p.at, r = bank ? p.bankRadius : p.radius;
  return `abs(x - (${x})) <= ${r} && abs(z - (${z})) <= ${r} && (x - (${x})) * (x - (${x})) + (z - (${z})) * (z - (${z})) ${bank ? '<=' : '<'} ${r * r}`;
};

const shapeSrc = /* glsl */ `
int cfWave(int a) {
  return thDiv(abs(thMod(a, 256) - 128), 8) - 8;
}
int cfCoveInset(int x) {
  return max(max(0, 20 - thDiv(abs(abs(x) - 360), 4)), max(0, 14 - thDiv(abs(abs(x) - 680), 5)));
}
int cfRadius(int x, int z) {
  return max(thDiv(abs(x), WC_LAND_STRETCH_X), abs(z) + (z > 0 ? cfCoveInset(x) : 0));
}
`;

const src = /* glsl */ `
int cfWoodsZ(int x) { return -80 + thDiv(cfWave(x), 2); }
int cfCliffZ(int x) { return -128 + thDiv(cfWave(x + 64), 2); }
int cfBeachZ(int x) { return 155 - cfCoveInset(x); }
int cfMidEdge(int x) { return -52 + cfWave(x); }
int cfHighEdge(int x) { return -100 + thDiv(cfWave(x + 64), 2); }
int cfRiverX(int z) { return 520 + 2 * cfWave(3 * z); }
int cfForkX(int z) { return cfRiverX(z) + clamp(z - 60, 0, 72); }
bool cfOuter(int x) { return wcExpanded() && abs(x) >= 200; }
bool cfRamp(int x) { return abs(x + 280) <= 12 || abs(x - 240) <= 12 || abs(abs(x) - 760) <= 12; }
bool cfSite(int x, int z) {
${Object.values(sites).map(({ at: [x, z], half: [hx, hz] }) => `  if (abs(x - (${x})) <= ${hx} && abs(z - (${z})) <= ${hz}) return true;`).join('\n')}
  return false;
}
int cfSiteHeight(int x, int z, int h) {
${Object.values(sites).map(({ at: [x, z], floor, half: [hx, hz] }) => `  if (abs(x - (${x})) <= ${hx} && abs(z - (${z})) <= ${hz}) return ${floor};`).join('\n')}
  return h;
}
// BASE terrain only: nature may query this without invoking composed wcCell.
int cfHeight(int x, int z) {
  if (wcExpanded() && x >= -160 && x <= 160 && z >= -440 && z <= -280) return 48;
  if (!cfOuter(x)) return wcBaseHeight(x, z);
  int r = wcRadius(x, z);
  if (r > WC_RADIUS) return WC_FLOOR;
  if (r >= WC_SHORE) return max(WC_FLOOR, WC_BEACH - (r - WC_SHORE));
  if (r >= WC_BEACH_IN) return WC_BEACH;
  int h = WC_LOW;
  if (r < WC_GRASS_IN && z < cfMidEdge(x)) h = WC_MID;
  if (r < WC_GRASS_IN && z < cfHighEdge(x)) h = WC_HIGH;
  // Broad ramps are 25 cells wide; each rise has two cells of tread.
  if (cfRamp(x) && z >= -142 && z <= 112) {
    if (z < -40 && z >= -64) h = WC_LOW + thDiv(-40 - z, 2);
    if (z < -64 && z >= -88) h = WC_MID;
    if (z < -88 && z >= -112) h = WC_MID + thDiv(-88 - z, 2);
    if (z < -112) h = WC_HIGH;
    // Join the gate apron with one-cell rises, not a pad-height jump.
    if (x < -260 && x > -300 && z < -82) h = min(WC_HIGH, WC_MID + thDiv(-82 - z, 2));
    // Keep the entire east ramp tread at café floor beside its north wall;
    // its upper rise begins beyond the annex pad and finishes before cliffs.
    if (abs(x - 240) <= 12 && z < -88) h = min(WC_HIGH, WC_MID + thDiv(max(0, -98 - z), 2));
  }
  if ((abs(abs(x) - 280) <= 12 || abs(abs(x) - 760) <= 12) && z > 112 && z <= 160) h = max(WC_BEACH, WC_LOW - thDiv(z - 112, 2));
  if (abs(x) >= 228 && abs(x) <= 772 && abs(z - cfCliffZ(x)) <= 9 && !cfRamp(x)) h = 48;
  h = cfSiteHeight(x, z, h);
${approaches.map(({ points, floor }) => `  if (${segment(points)}) return ${floor};`).join('\n')}
  // Upper doors open onto a high avenue; connect around, not through houses.
  if (x >= -712 && x <= -302 && abs(z + 94) <= 5) return 48;
  if (abs(x + 308) <= 5 && z >= -117 && z <= -89) return 48;
  if (x >= -313 && x <= -268 && abs(z + 112) <= 5) return 48;
  return h;
}
bool cfNewPath(int x, int z) {
  if (!cfOuter(x)) return false;
${approaches.map(({ points }) => `  if (${segment(points)}) return true;`).join('\n')}
  if (x >= -712 && x <= -302 && abs(z + 94) <= 5) return true;
  if (abs(x + 308) <= 5 && z >= -117 && z <= -89) return true;
  if (x >= -313 && x <= -268 && abs(z + 112) <= 5) return true;
  if (abs(x + 248) <= 6 && z >= -12 && z <= 36) return true;
  if (x >= -280 && x <= -248 && abs(z + 12) <= 6) return true;
  if (z >= 36 && z <= 100 && abs(x - (cfRiverX(z) - 20)) <= 6) return true;
  if (cfRamp(x) && z >= -138 && z <= 112) return true;
  if (abs(x) >= 228 && abs(x) <= 772 && (abs(z - cfWoodsZ(x)) <= 6 || abs(z - cfCliffZ(x)) <= 6)) return true;
  if (abs(x) >= 268 && abs(x) <= 772 && abs(z - 100) <= 6) return true;
  if (abs(abs(x) - 280) <= 12 && z >= 36 && z <= 160) return true;
  if (abs(abs(x) - 760) <= 12 && z >= 100 && z <= 160) return true;
  if (abs(x) >= 268 && abs(x) <= 772 && abs(z - cfBeachZ(x)) <= 6) return true;
  if (x >= -424 && x <= -256 && abs(z - 12) <= 6) return true;
  if (x >= -424 && x <= -256 && z >= 12 && z <= 36 && (abs(x + 280) <= 6 || abs(x + 380) <= 6)) return true;
  if ((abs(x + 400) <= 6 || abs(x + 680) <= 6) && z >= 92 && z <= 100) return true;
  if (abs(x - 680) <= 6 && z >= 36 && z <= 100) return true;
  if (x >= 234 && x <= 346 && abs(z + 80) <= 6) return true;
  if (abs(x - 300) <= 5 && z >= -80 && z <= -52) return true;
  if (x >= -292 && x <= -208 && abs(z + 116) <= 6) return true;
  return false;
}
// ALL protected paths, including the four original cottage approaches.
bool cfPath(int x, int z) {
  if (wcPath(x, z) || cfNewPath(x, z)) return true;
  if (abs(x - WC_PATH_X) <= WC_DOCK_HALF && z >= WC_DOCK_START && z < WC_DOCK_END) return true;
  if (z >= WC_LANE_Z && z <= WC_COTTAGE_Z) {
    if (abs(x - WC_COTTAGE_A) <= WC_PATH_HALF || abs(x - WC_COTTAGE_B) <= WC_PATH_HALF || abs(x - WC_COTTAGE_C) <= WC_PATH_HALF || abs(x - WC_COTTAGE_D) <= WC_PATH_HALF) return true;
  }
  return false;
}
bool cfRiver(int x, int z) {
  if (z < -132 || z > 176) return false;
  if (abs(abs(x) - cfRiverX(z)) < 8) return true;
  return x > 0 && z >= 60 && abs(x - cfForkX(z)) < 8;
}
bool cfPond(int x, int z) {
${ponds.map(p => `  if (${pondMask(p)}) return true;`).join('\n')}
  return false;
}
bool cfBank(int x, int z) {
${ponds.map(p => `  if (${pondMask(p, true)}) return true;`).join('\n')}
  if (z < -136 || z > 180) return false;
  return abs(abs(x) - cfRiverX(z)) <= 12 || (x > 0 && z >= 56 && abs(x - cfForkX(z)) <= 12);
}
int cfWater(int x, int z) {
  if (cfPond(x, z)) return 20;
  int rx = cfRiverX(z);
  if (z < cfHighEdge(rx) + 2) return 44;
  if (z < cfMidEdge(rx) + 2) return 32;
  if (z < 144) return 20;
  return 16;
}
int cfBed(int x, int z) {
  if (cfPond(x, z)) return cfWater(x, z) - 5;
  int rx = cfRiverX(z);
  if (z < cfHighEdge(rx)) return 40;
  if (z < cfMidEdge(rx)) return 28;
  if (z < 142) return 16;
  return 12;
}
bool cfBridge(int x, int z) {
  if (!cfOuter(x) || !cfBank(x, z) || cfPond(x, z)) return false;
  // An authored pad can overhang a channel bank on supported timber;
  // preserve the water below instead of filling the bare river recursively.
  if (cfSite(x, z)) return true;
  if (!cfPath(x, z)) return false;
  return abs(z - WC_LANE_Z) < WC_PATH_HALF || abs(z - WC_RUN_RETURN_Z) < WC_PATH_HALF || abs(z - cfWoodsZ(x)) <= 6 || abs(z - cfCliffZ(x)) <= 6 || (x < 0 && abs(z + 94) <= 5) || abs(z - 100) <= 6 || abs(z - cfBeachZ(x)) <= 6;
}
int cfOuterCellMaterial(int x, int y, int z) {
  int r = wcRadius(x, z), h = cfHeight(x, z);
  if (r > WC_RADIUS) return y < WC_SEA ? E_WATER : E_EMPTY;
  bool water = cfRiver(x, z) || cfPond(x, z);
  bool bank = cfBank(x, z);
  if (cfBridge(x, z) && y >= h - 2 && y < h) return materialWord(E_PLANKS, AP_PLANK_Z);
  if (water) {
    if (y < cfBed(x, z)) return E_ROCK;
    return y < cfWater(x, z) ? E_WATER : E_EMPTY;
  }
  if (y < h - 1) return E_ROCK;
  if (y < h) {
    // Minecraft-style dirt trails use stable brown sandstone, not loose
    // powder. Preserve the original brick sprint/cottage/core surfaces.
    if (cfPath(x, z)) return wcPath(x, z) ? E_BRICK : E_SANDSTONE;
    if (bank || r >= WC_SHORE - 1) return E_ROCK;
    if (r >= WC_BEACH_IN) return E_SAND;
    if (r >= WC_GRASS_IN) return E_ROCK;
    return materialWord(E_PLANT, AP_GRASS);
  }
  return y < WC_SEA ? E_WATER : E_EMPTY;
}
int cfOuterCell(int x, int y, int z) { return materialId(cfOuterCellMaterial(x, y, z)); }
`;

const wave = a => Math.floor(Math.abs(((a % 256) + 256) % 256 - 128) / 8) - 8;
const riverX = z => 520 + 2 * wave(3 * z);
const woodsZ = x => -80 + Math.floor(wave(x) / 2);

const routes = [
  ...[-760, 240, 760].map(x => ({ name: `ramp-${x}`, points: [[x, 36], [x, -134]] })),
  { name: 'ramp--280', points: [[-248, 36], [-248, -12], [-280, -12], [-280, -134]] },
  ...[-760, 760].map(x => ({ name: `lower-loop-${x}`, points: [[x, 36], [x, 100], [Math.sign(x) * 280, 100], [Math.sign(x) * 280, 36]] })),
  ...[-1, 1].flatMap(side => ['woods', 'cliffs'].map(name => ({ name: `${name}-${side}`, curve: name === 'woods' ? 'cfWoodsZ' : 'cfCliffZ', from: side < 0 ? -280 : name === 'woods' ? 340 : 240, to: side * 760 }))),
  { name: 'town-shortcut', points: [[-326, 36], [-326, 12], [-298, 12]] },
  { name: 'shops-entry', points: [[-380, 36], [-380, 22]] },
  ...approaches.map(({ points }, i) => ({ name: `town-approach-${i}`, points })),
  { name: 'upper-avenue-shortcut', points: [[-280, -112], [-308, -112], [-308, -94], [-704, -94]] },
  { name: 'museum-through-shortcut', points: [[240, -80], [300, -80], [300, -52], [340, -52], [340, woodsZ(340)]] },
  { name: 'museum-connector', points: [[340, -80], [340, woodsZ(340)]] },
  { name: 'cafe-connector', points: [[240, -80], [240, woodsZ(240)]] },
  { name: 'riverside', points: Array.from({ length: 65 }, (_, i) => [riverX(i + 36) - 20, i + 36]) },
  { name: 'bus-entry', points: [[-280, -116], [-220, -116]] },
  ...[-680, -400].map(x => ({ name: `lower-door-${x}`, points: [[x, 100], [x, 92]] })),
  { name: 'lower-shortcut-east', points: [[680, 36], [680, 100]] },
  ...[-760, -280, 280, 760].map(x => ({ name: `beach-${x}`, points: [[x, 100], [x, 155]] })),
  ...[-1, 1].map(side => ({ name: `cove-loop-${side}`, curve: 'cfBeachZ', from: side * 280, to: side * 760 })),
];

const cliffZ = x => -128 + Math.floor(wave(x + 64) / 2);
const beachZ = x => 155 - Math.max(0, 20 - Math.floor(Math.abs(Math.abs(x) - 360) / 4), 14 - Math.floor(Math.abs(Math.abs(x) - 680) / 5));
const bridges = [];
for (const side of [-1, 1]) {
  for (const [name, curve, fixed] of [['cliffs', cliffZ], ['upper-avenue', null, -94], ['woods', woodsZ], ['return', null, -28], ['outward', null, 36], ['lower', null, 100], ['beach', beachZ]]) {
    if (side > 0 && name === 'upper-avenue') continue;
    const x = Array.from({ length: 80 }, (_, i) => side * (480 + i)).find(x => Math.abs(Math.abs(x) - riverX(curve ? curve(x) : fixed)) < 1);
    const z = curve ? curve(x) : fixed;
    bridges.push({ at: [x, z], entry: [x - 20, z], floor: name === 'upper-avenue' || z < -100 ? 48 : z < -40 ? 36 : z > 130 ? 18 : 24, half: [12, 6], route: name });
  }
}
bridges.push({ at: [riverX(100) + 40, 100], entry: [riverX(100) + 20, 100], floor: 24, half: [12, 6], route: 'fork' });
const forkBeachX = Array.from({ length: 100 }, (_, i) => 560 + i).find(x => Math.abs(x - riverX(beachZ(x)) - Math.min(beachZ(x) - 60, 72)) < 1);
bridges.push({ at: [forkBeachX, beachZ(forkBeachX)], entry: [forkBeachX - 20, beachZ(forkBeachX)], floor: 18, half: [12, 6], route: 'fork-beach' });
const waterfalls = [];
for (let z = -130; z < 160; z++) {
  const x = riverX(z);
  if (z === -100 + Math.floor(wave(x + 64) / 2) || z === -52 + wave(x) || z === 142) waterfalls.push([x, z]);
}
export const CITY_FOLK_TERRAIN = Object.freeze({
  ints: {}, salts: {}, shapeSrc, src, sites, routes, neighborhoodPonds,
  landmarks: {
    cliffs: [-840, -860, 840],
    dirtPaths: [[-760, 64], [760, 64]],
    meadows: [[-860, 70], [850, 70], [-880, -80], [400, 0]],
    ponds: [[-600, -4], [400, 72]],
    island: [riverX(110) + 25, 110],
    coves: [[-360, 140], [360, 140], [-680, 141], [680, 141]],
    mouths: [[-riverX(156), 156], [riverX(156), 156], [riverX(156) + 72, 156]],
    waterfalls, bridges,
  },
});
