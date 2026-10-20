// Noita-inspired surface artwork (the Noita view), built like Cozy (gfx/cozy.js):
// shader code, not images. One Noita pixel is one cell (src/scale.js), the
// scale Descent folds Noita's world at, so every pattern snaps to the cell grid
// in world space on every face, the way Noita's material textures tile its
// world. Colours and their shares are measured from Noita's own material
// textures (data/materials_gfx/*.png, read locally); the layouts are rules.
// Several Noita materials can share one element (rock_hard and rock_static are
// both ROCK): src/appearance.js VARIANT_* labels in unused ctype tell them apart
// (tools/noita-terrain-looks.json says which native material gets which).
import { E } from '../../elements.js';
import { Appearance as AP } from '../../appearance.js';

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linear = (hex) => [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
const f = (x) => x.toFixed(6);
const v3 = (c) => `vec3f(${c.map(f).join(', ')})`;

// Each look: its texture's colours with their measured shares (percent of the
// texture's pixels), darkest-to-lightest roles as the pattern below uses them.
export const NOITA_LOOKS = {
  // rock.png and its palette swaps: 91 % base, 9 % specks (1 px, and 2×2)
  rock:       { file: 'rock.png', colours: [['#27282d', 91], ['#3e4555', 9]] },
  rockHard:   { file: 'rock_hard.png', colours: [['#37221d', 91], ['#623b32', 9]] },
  rockBorder: { file: 'rock_hard_border.png', colours: [['#251511', 91], ['#40231c', 9]] },
  snowrock:   { file: 'snowrock.png', colours: [['#3e5772', 91], ['#4a73a4', 9]] },
  earth:      { file: 'earth.png', colours: [['#464128', 91], ['#5f5731', 9]] },
  // fine per-pixel noise
  rockGrey:   { file: 'rock_grey.png', colours: [['#474747', 34], ['#4a4a4a', 33], ['#4e4e4e', 33]] },
  coalStatic: { file: 'coal_static.png', colours: [['#323232', 30], ['#363636', 40], ['#3a3a3a', 30]] },
  coal:       { file: 'coal.png', colours: [['#212121', 42], ['#262626', 22], ['#2a2a2a', 15], ['#323232', 21]] },
  soil:       { file: 'soil.png', colours: [['#232018', 42], ['#272618', 22], ['#36311e', 21], ['#27282d', 15]] },
  sand:       { file: 'sand.png', colours: [['#b79f56', 25], ['#bba86b', 25], ['#beac75', 25], ['#bfb083', 25]] },
  // mottled greens with light specks
  vault:      { file: 'vaultrock.png', colours: [['#324538', 47], ['#314837', 23], ['#334239', 21], ['#486a52', 4], ['#4d7758', 3], ['#45604d', 2]] },
  // dashes along a row
  soilDead:   { file: 'soil_dead.png', colours: [['#7f7841', 55], ['#77713d', 45]] },
  snow:       { file: 'snow.png', colours: [['#a6c2d8', 85], ['#81b0d2', 15]] },
  // cracked jungle earth and lush moss scales
  rainforest: { file: 'earth_rainforest.png', colours: [['#44452f', 12], ['#515224', 55], ['#6b6a2f', 33]] },
  lush:       { file: 'soil_lush.png', colours: [['#628132', 39], ['#709030', 46], ['#7b9e3a', 6], ['#83a739', 9]] },
  // masonry, timber, steel, gold
  temple:     { file: 'templebrick.png', colours: [['#403a29', 29], ['#514a31', 54], ['#59533b', 15], ['#605739', 2]] },
  templeDark: { file: 'templebrick_alt.png', colours: [['#473e37', 37], ['#5b5047', 48], ['#6b5d52', 13], ['#362f2a', 2]] },
  brick:      { file: 'brick.png', colours: [['#90a19a', 28], ['#77524f', 22], ['#ab5e4f', 22], ['#b37575', 22], ['#758582', 6]] },
  planks:     { file: 'wood.png', colours: [['#322b18', 29], ['#3f351f', 28], ['#473c23', 28], ['#564832', 15]] },
  grain:      { file: 'wood_vertical.png', colours: [['#302818', 7], ['#382f1c', 30], ['#3f341e', 31], ['#463a22', 32]] },
  steel:      { file: 'steelpanel.png', colours: [['#5d5043', 6], ['#695b4b', 19], ['#6e5f4e', 67], ['#84744e', 6], ['#605345', 2]] },
  steelMoss:  { file: 'steel_rusted.png', colours: [['#5b6242', 10], ['#5e6343', 30], ['#636648', 20], ['#666849', 40]] },
  gold:       { file: 'gold.png', colours: [['#ab5e4f', 17], ['#c38d37', 38], ['#d2a96c', 28], ['#f0f09c', 11], ['#ffffff', 6]] },
};
const LOOK_KEYS = Object.keys(NOITA_LOOKS);
export const NOITA_LOOK_INDEX = Object.fromEntries(LOOK_KEYS.map((k, i) => [k, i]));

// Which look an element (and source variant) takes. Elements not listed keep
// the Realistic look in the Noita view. Metals conduct, so they have no variant.
// ICE is drawn as clear glass (render class 3), not through matOf, so Noita's
// ice and snow_static (both ICE in tools/noita-terrain-materials.json) keep it.
export const NOITA_ELEMENT_LOOKS = [
  ['ROCK', 'NONE', 'rock'], ['ROCK', 'VARIANT_1', 'rockHard'], ['ROCK', 'VARIANT_2', 'rockGrey'],
  ['STONE', 'NONE', 'rock'],   // rock dug loose (ROCK breakInto STONE) and pebbles stay Noita rock
  ['WALL', 'NONE', 'rockBorder'],
  ['NOITA_SNOWROCK', 'NONE', 'snowrock'], ['NOITA_VAULT', 'NONE', 'vault'],
  ['NOITA_TEMPLE', 'NONE', 'temple'], ['NOITA_TEMPLE', 'VARIANT_1', 'templeDark'],
  ['NOITA_LUSH', 'NONE', 'lush'],
  ['SANDSTONE', 'NONE', 'earth'], ['SANDSTONE', 'VARIANT_1', 'rainforest'],
  ['SANDSTONE', 'VARIANT_2', 'soilDead'], ['SANDSTONE', 'VARIANT_3', 'soil'],
  ['SNOW', 'NONE', 'snow'],
  ['WOOD', 'NONE', 'planks'], ['WOOD', 'PLANK_X', 'planks'], ['WOOD', 'PLANK_Z', 'planks'],
  ['WOOD', 'PLANK_Y', 'grain'], ['WOOD', 'LOG_X', 'grain'], ['WOOD', 'LOG_Y', 'grain'],
  ['WOOD', 'LOG_Z', 'grain'], ['WOOD', 'BARK', 'grain'],
  ['COAL', 'NONE', 'coalStatic'], ['BROKENCOAL', 'NONE', 'coal'],
  ['METAL', 'NONE', 'steel'], ['SAND', 'NONE', 'sand'],
  ['GOLD', 'NONE', 'gold'], ['NUGGETS', 'NONE', 'gold'], ['BRICK', 'NONE', 'brick'],
];

// The mean of a look's colours (linear, by share): what a face far smaller than
// a pixel averages to, so distant terrain does not shimmer.
export const noitaMean = (key) => {
  const cs = NOITA_LOOKS[key].colours, total = cs.reduce((s, [, w]) => s + w, 0);
  return [0, 1, 2].map((k) => cs.reduce((s, [hex, w]) => s + linear(hex)[k] * w, 0) / total);
};
const constName = (key, i) => `NL_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_${i}`;
const colourConsts = LOOK_KEYS.flatMap((key) => NOITA_LOOKS[key].colours.map(([hex], i) =>
  `const ${constName(key, i)}: vec3f = ${v3(linear(hex))};   // ${hex}`)).join('\n');
const C = (key, i) => constName(key, i);

// A look's pattern, as a WGSL call on the face pixel uv (rows run down, like
// Noita's images). Shares come from the measured colours above.
const share = (key, i) => NOITA_LOOKS[key].colours[i][1] / 100;
const cum = (key, n) => NOITA_LOOKS[key].colours.slice(0, n).reduce((s, [, w]) => s + w, 0) / 100;
const speckle = (key, salt) => `noitaSpeckle(uv, ${C(key, 0)}, ${C(key, 1)}, ${f(salt)})`;
const noise3 = (key, salt) => `noitaNoise3(uv, ${C(key, 0)}, ${C(key, 1)}, ${C(key, 2)}, ${f(cum(key, 1))}, ${f(cum(key, 2))}, ${f(salt)})`;
const noise4 = (key, salt) => `noitaNoise4(uv, ${C(key, 0)}, ${C(key, 1)}, ${C(key, 2)}, ${C(key, 3)}, ${f(cum(key, 1))}, ${f(cum(key, 2))}, ${f(cum(key, 3))}, ${f(salt)})`;
const PATTERNS = {
  rock: speckle('rock', 1), rockHard: speckle('rockHard', 2), rockBorder: speckle('rockBorder', 3),
  snowrock: speckle('snowrock', 4), earth: speckle('earth', 5),
  rockGrey: noise3('rockGrey', 6), coalStatic: noise3('coalStatic', 7),
  coal: noise4('coal', 8), soil: noise4('soil', 9), sand: noise4('sand', 10),
  vault: `noitaVault(uv)`,
  soilDead: `noitaDashes(uv, ${C('soilDead', 0)}, ${C('soilDead', 1)}, NOITA_SOIL_DASH, ${f(share('soilDead', 1))}, 0.0, 11.0)`,
  snow: `noitaDashes(uv, ${C('snow', 0)}, ${C('snow', 1)}, NOITA_SNOW_DASH, ${f(share('snow', 1))}, NOITA_SNOW_SLANT, 12.0)`,
  rainforest: `noitaCracks(uv)`,
  lush: `noitaScales(uv)`,
  temple: `noitaTemple(uv, ${C('temple', 0)}, ${C('temple', 1)}, ${C('temple', 2)}, ${C('temple', 3)})`,
  templeDark: `noitaTemple(uv, ${C('templeDark', 0)}, ${C('templeDark', 1)}, ${C('templeDark', 2)}, ${C('templeDark', 3)})`,
  brick: `noitaBrick(uv)`,
  planks: `noitaPlanks(uv)`,
  grain: `noitaGrain(uv)`,
  steel: `noitaSteel(uv)`,
  steelMoss: `noitaSteel(uv)`,
  gold: `noitaGold(uv)`,
};
if (LOOK_KEYS.some((k) => !PATTERNS[k])) throw new Error('Every Noita look needs a pattern');

const lookSelect = NOITA_ELEMENT_LOOKS.map(([el, ap, look]) =>
  `  if (id == E_${el} && a == AP_${ap}) { return ${NOITA_LOOK_INDEX[look]}; }`).join('\n');
const anyAppearance = [...new Set(NOITA_ELEMENT_LOOKS.filter(([, ap]) => ap === 'NONE').map(([el]) => el))]
  .map((el) => `  if (id == E_${el}) { return ${NOITA_LOOK_INDEX[NOITA_ELEMENT_LOOKS.find(([e, ap]) => e === el && ap === 'NONE')[2]]}; }`).join('\n');
for (const [el, ap] of NOITA_ELEMENT_LOOKS) if (E[el] === undefined || AP[ap] === undefined) throw new Error(`Unknown Noita look key ${el}/${ap}`);

export const noitaSurfaceWGSL = /* wgsl */ `
// ---- Noita view (gfx/noita.js): one Noita pixel per cell face ----
${colourConsts}
const NOITA_SPECK_SINGLE: f32 = 0.033;   // rock.png: 71 single-pixel specks in 2160 pixels
const NOITA_SPECK_BLOCK: f32 = 0.05;     // ... and 27 2×2 squares in its 540 2×2 blocks
const NOITA_SOIL_DASH: f32 = 5.0;        // soil_dead.png: runs ~5 px along a row
const NOITA_SNOW_DASH: f32 = 7.0;        // snow.png: streaks ~7 px long ...
const NOITA_SNOW_SLANT: f32 = 0.5;       // ... drifting one pixel sideways per two rows
const NOITA_CRACK_CELL: f32 = 6.0;       // earth_rainforest.png: crazing ~6 px across ...
const NOITA_CRACK_WIDTH: f32 = 1.2;      // ... with pixel-wide cracks
const NOITA_SCALE_W: f32 = 8.0;          // soil_lush.png: scales 8 px wide, 6 px tall
const NOITA_SCALE_H: f32 = 6.0;
const NOITA_TEMPLE_BAND: f32 = 12.0;     // templebrick.png: two courses per 12 px, split at 5..7
const NOITA_TEMPLE_W_MIN: f32 = 5.0;     // stones 5..10 px long
const NOITA_TEMPLE_W_SPAN: f32 = 6.0;
const NOITA_TEMPLE_LIGHT: f32 = 0.14;    // share of whole light stones
const NOITA_TEMPLE_HOLE: f32 = 0.06;     // share of stones with a 2×2 socket
const NOITA_PLANK_H: f32 = 4.0;          // wood.png: 3 px boards, 1 px seams
const NOITA_PLANK_MIN: f32 = 12.0;       // boards 12..24 px long
const NOITA_PLANK_SPAN: f32 = 13.0;
const NOITA_GRAIN_W: f32 = 13.0;         // wood_vertical.png: a dark split every 13 px
const NOITA_PANEL_W: f32 = 16.0;         // steelpanel.png: panels 16×12, rivets 2 px in
const NOITA_PANEL_H: f32 = 12.0;
const NOITA_RIVET: f32 = 2.0;
const NOITA_MOSS_SIZE: f32 = 9.0;        // steel_rusted.png: moss patches ~9 px across
const NOITA_MOSS_COVER: f32 = 0.52;      // noise level above which a panel is mossy
const NOITA_GOLD_PERIOD: f32 = 6.0;      // gold.png: diagonal bands, 6 px a cycle
const NOITA_FACE_INSET: f32 = 0.5;       // reads the cell behind the face
const NOITA_FADE_NEAR: f32 = 0.5;        // footprint (cells/pixel) where pixels start to blur ...
const NOITA_FADE_FAR: f32 = 1.5;         // ... and where only the mean colour is left
const NOITA_RIM: f32 = 1.12;             // Noita's lit top edges, on whole up-facing faces
const NOITA_UNDER: f32 = 0.88;           // and its darker undersides
const NOITA_RIM_N: f32 = 0.7;            // |n.y| that counts as a top or underside
const NOITA_ROUGH: f32 = 0.9;            // Noita has no gloss: matte dielectric pixels
const NOITA_F0: f32 = 0.04;
const NOITA_LOOKS: i32 = ${LOOK_KEYS.length};

fn noitaHash(uv: vec2f, salt: f32) -> f32 { return hash13(vec3f(uv, salt)); }
fn noitaOdd(x: f32) -> bool { return x - 2.0 * floor(x * 0.5) > 0.5; }
fn noitaSpeckle(uv: vec2f, base: vec3f, speck: vec3f, salt: f32) -> vec3f {
  let lone = noitaHash(uv, salt) < NOITA_SPECK_SINGLE;
  let square = noitaHash(floor(uv * 0.5), salt + 0.5) < NOITA_SPECK_BLOCK;
  return select(base, speck, lone || square);
}
fn noitaNoise3(uv: vec2f, a: vec3f, b: vec3f, c: vec3f, ta: f32, tb: f32, salt: f32) -> vec3f {
  let h = noitaHash(uv, salt);
  return select(select(c, b, h < tb), a, h < ta);
}
fn noitaNoise4(uv: vec2f, a: vec3f, b: vec3f, c: vec3f, d: vec3f, ta: f32, tb: f32, tc: f32, salt: f32) -> vec3f {
  let h = noitaHash(uv, salt);
  return select(select(select(d, c, h < tc), b, h < tb), a, h < ta);
}
fn noitaVault(uv: vec2f) -> vec3f {
  if (noitaHash(uv, 13.0) < NOITA_SPECK_SINGLE * 3.0) {
    return noitaNoise3(uv, ${C('vault', 3)}, ${C('vault', 4)}, ${C('vault', 5)}, 0.45, 0.78, 13.5);
  }
  return noitaNoise3(uv, ${C('vault', 0)}, ${C('vault', 1)}, ${C('vault', 2)}, 0.52, 0.77, 14.0);
}
fn noitaDashes(uv: vec2f, base: vec3f, dash: vec3f, run: f32, share: f32, slant: f32, salt: f32) -> vec3f {
  let x = uv.x + floor(uv.y * slant);
  return select(base, dash, noitaHash(vec2f(floor(x / run), uv.y), salt) < share);
}
fn noitaCracks(uv: vec2f) -> vec3f {
  let cell = floor(uv / NOITA_CRACK_CELL);
  var first = 1e9;
  var second = 1e9;
  var owner = vec2f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = cell + vec2f(f32(i), f32(j));
      let site = (c + hash33(vec3f(c, 16.0)).xy) * NOITA_CRACK_CELL;
      let d = length(uv + vec2f(0.5) - site);
      if (d < first) { second = first; first = d; owner = c; }
      else { second = min(second, d); }
    }
  }
  if (second - first < NOITA_CRACK_WIDTH) { return ${C('rainforest', 0)}; }
  let light = noitaHash(owner, 16.5) > ${f(1 - share('rainforest', 2))};
  return select(${C('rainforest', 1)}, ${C('rainforest', 2)}, light);
}
fn noitaScales(uv: vec2f) -> vec3f {
  let row = floor(uv.y / NOITA_SCALE_H);
  let x = uv.x + select(0.0, NOITA_SCALE_W * 0.5, noitaOdd(row));
  let scale = floor(x / NOITA_SCALE_W);
  let lx = x - scale * NOITA_SCALE_W;
  let ly = uv.y - row * NOITA_SCALE_H;
  let cx = abs(lx - (NOITA_SCALE_W - 1.0) * 0.5);
  // a U-shaped rim: lowest in the middle of the scale, rising to its sides
  let rim = max(NOITA_SCALE_H - 2.0 - floor(cx * cx / 3.0), 0.0);
  if (ly == rim) { return select(${C('lush', 3)}, ${C('lush', 2)}, noitaHash(uv, 17.0) < 0.4); }
  return select(${C('lush', 1)}, ${C('lush', 0)}, noitaHash(vec2f(scale, row), 17.5) < ${f(share('lush', 0) / (share('lush', 0) + share('lush', 1)))});
}
fn noitaTemple(uv: vec2f, dark: vec3f, body: vec3f, light: vec3f, rare: vec3f) -> vec3f {
  let band = floor(uv.y / NOITA_TEMPLE_BAND);
  let ly = uv.y - band * NOITA_TEMPLE_BAND;
  let split = 5.0 + floor(noitaHash(vec2f(band, 3.0), 18.0) * 3.0);
  let lower = ly >= split;
  let row = band * 2.0 + select(0.0, 1.0, lower);
  let ry = ly - select(0.0, split, lower);                 // 0: the course's mortar line
  let width = NOITA_TEMPLE_W_MIN + floor(noitaHash(vec2f(row, 5.0), 18.5) * NOITA_TEMPLE_W_SPAN);
  let x = uv.x + floor(noitaHash(vec2f(row, 9.0), 19.0) * width);
  let stone = floor(x / width);
  let rx = x - stone * width;                              // 0: the mortar line on its left
  if (rx == 0.0 || ry == 0.0) { return dark; }
  let h = noitaHash(vec2f(stone, row), 19.5);
  if (h < NOITA_TEMPLE_HOLE && rx >= 2.0 && rx <= 3.0 && ry >= 2.0 && ry <= 3.0) { return dark; }
  if (rx == 1.0 || ry == 1.0 || h > 1.0 - NOITA_TEMPLE_LIGHT) { return light; }
  return select(body, rare, noitaHash(uv, 20.0) < ${f(share('temple', 3))});
}
fn noitaBrick(uv: vec2f) -> vec3f {
  // brick.png: 8×8, courses of 3 px + 1 px mortar, half-bond
  let row = floor(uv.y / 4.0);
  let x = uv.x + select(0.0, 4.0, noitaOdd(row));
  let rx = x - floor(x / 8.0) * 8.0;
  let ry = uv.y - row * 4.0;
  if (ry == 3.0 && rx == 7.0) { return ${C('brick', 4)}; }   // mortar crossings sit darker
  if (ry == 3.0 || rx == 7.0) { return ${C('brick', 0)}; }
  if (ry == 0.0) { return ${C('brick', 3)}; }
  if (ry == 2.0 || rx == 6.0) { return ${C('brick', 1)}; }
  return ${C('brick', 2)};
}
fn noitaPlanks(uv: vec2f) -> vec3f {
  let plank = floor(uv.y / NOITA_PLANK_H);
  if (uv.y - plank * NOITA_PLANK_H == 0.0) { return ${C('planks', 0)}; }
  let len = NOITA_PLANK_MIN + floor(noitaHash(vec2f(plank, 1.0), 21.0) * NOITA_PLANK_SPAN);
  let x = uv.x + floor(noitaHash(vec2f(plank, 2.0), 21.5) * len);
  let board = floor(x / len);
  if (x - board * len == 0.0) { return ${C('planks', 0)}; }
  if (noitaHash(vec2f(board, plank), 22.0) < ${f(share('planks', 3))}) { return ${C('planks', 3)}; }
  return select(${C('planks', 1)}, ${C('planks', 2)}, noitaHash(vec2f(floor(x / 3.0), uv.y), 22.5 + board) < 0.5);
}
fn noitaGrain(uv: vec2f) -> vec3f {
  if (uv.x - floor(uv.x / NOITA_GRAIN_W) * NOITA_GRAIN_W == 0.0) { return ${C('grain', 0)}; }
  return noitaNoise3(vec2f(uv.x, floor(uv.y / 6.0)), ${C('grain', 1)}, ${C('grain', 2)}, ${C('grain', 3)}, 0.33, 0.66, 23.0);
}
fn noitaSteel(uv: vec2f) -> vec3f {
  let row = floor(uv.y / NOITA_PANEL_H);
  let x = uv.x + select(0.0, NOITA_PANEL_W * 0.5, noitaOdd(row));
  let col = floor(x / NOITA_PANEL_W);
  let rx = x - col * NOITA_PANEL_W;
  let ry = uv.y - row * NOITA_PANEL_H;
  if (rx == 0.0 || ry == 0.0) { return ${C('steel', 3)}; }
  if (rx == NOITA_PANEL_W - 1.0 || ry == NOITA_PANEL_H - 1.0) { return ${C('steel', 0)}; }
  let ex = min(rx, NOITA_PANEL_W - 1.0 - rx);
  let ey = min(ry, NOITA_PANEL_H - 1.0 - ry);
  if (ex == NOITA_RIVET && ey == NOITA_RIVET) { return ${C('steel', 3)}; }
  // Hiisi steel is often mossy (steelmoss_static): patches across the panels
  if (vnoise(vec3f(uv / NOITA_MOSS_SIZE, 24.0)) > NOITA_MOSS_COVER) {
    return ${noise4('steelMoss', 24.5)};
  }
  return noitaNoise3(uv, ${C('steel', 1)}, ${C('steel', 4)}, ${C('steel', 2)}, ${f(share('steel', 1) / 0.88)}, ${f((share('steel', 1) + share('steel', 4)) / 0.88)}, 25.0);
}
fn noitaGold(uv: vec2f) -> vec3f {
  let s = uv.x + uv.y - floor((uv.x + uv.y) / NOITA_GOLD_PERIOD) * NOITA_GOLD_PERIOD;
  if (s < 2.0) { return ${C('gold', 1)}; }
  if (s < 3.0) { return ${C('gold', 2)}; }
  if (s < 4.0) { return ${C('gold', 0)}; }
  if (s < 5.0) { return select(${C('gold', 3)}, ${C('gold', 4)}, noitaHash(uv, 26.0) < 0.35); }
  return ${C('gold', 2)};
}

// The look of element id with appearance a; -1: no Noita look (Realistic).
fn noitaLook(id: i32, a: i32) -> i32 {
${lookSelect}
${anyAppearance}
  return -1;
}
fn noitaSupported(id: i32, ctype: f32) -> bool {
  return RCLASS(id) == R_OPAQUE && noitaLook(id, appearanceOf(id, ctype)) >= 0;
}
fn noitaTexel(look: i32, uv: vec2f) -> vec3f {
  switch look {
${LOOK_KEYS.map((key, i) => `    case ${i}: { return ${PATTERNS[key]}; }`).join('\n')}
    default: { return vec3f(1.0, 0.0, 1.0); }
  }
}
fn noitaMean(look: i32) -> vec3f {
  switch look {
${LOOK_KEYS.map((key, i) => `    case ${i}: { return ${v3(noitaMean(key))}; }`).join('\n')}
    default: { return vec3f(1.0, 0.0, 1.0); }
  }
}
// The cell a surface point belongs to, read in the plane of its face: x/y on
// faces along z, z/y on faces along x, x/z on tops and bottoms. Rows run down.
fn noitaFaceUV(p: vec3f, n: vec3f) -> vec2f {
  let an = abs(n);
  if (an.x >= an.y && an.x >= an.z) {
    let c = floor(p - vec3f(sign(n.x) * NOITA_FACE_INSET, 0.0, 0.0));
    return vec2f(c.z, -c.y);
  }
  if (an.y >= an.z) {
    let c = floor(p - vec3f(0.0, sign(n.y) * NOITA_FACE_INSET, 0.0));
    return vec2f(c.x, c.z);
  }
  let c = floor(p - vec3f(0.0, 0.0, sign(n.z) * NOITA_FACE_INSET));
  return vec2f(c.x, -c.y);
}
fn noitaMat(id: i32, p: vec3f, n: vec3f, T: f32, ctype: f32, fp: f32) -> Mat {
  var m = matBase(id);
  let look = noitaLook(id, appearanceOf(id, ctype));
  let fade = 1.0 - smoothstep(NOITA_FADE_NEAR, NOITA_FADE_FAR, fp);
  var alb = mix(noitaMean(look), noitaTexel(look, noitaFaceUV(p, n)), fade);
  alb *= select(select(1.0, NOITA_UNDER, n.y < -NOITA_RIM_N), NOITA_RIM, n.y > NOITA_RIM_N);
  m.alb = alb;
  m.g = vec3f(0.0);
  m.metal = 0.0; m.f0 = NOITA_F0; m.rough = NOITA_ROUGH;
  m.glint = 0.0; m.sss = 0.0; m.aniso = 0.0; m.trans = 0.0;
  // Painted albedo must not change the thermal skin/oxide emission model.
  m.emit = cellEmission(id, T, ctype) + sparkEmit(id, ctype);
  return m;
}
`;
