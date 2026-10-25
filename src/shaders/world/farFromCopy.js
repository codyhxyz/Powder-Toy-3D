// The far summary from the world copy (docs/seamless-world.md, "work parity"): the far grid's texel of each
// world brick (shaders/far.js, "The far grid": opaque and liquid shares of the FAR.CUBE³ cube centred on it,
// its dominant opaque element and appearance, its glow, its dominant liquid, whether it holds open opaque
// cells), counted from the world copy's cells (wcCell) exactly as the scene's and the window's summaries
// count theirs (far.js farSceneFrag, and the window's farWinFrag this replaces): the same FarCount, farCell
// and farPack (far.js FAR_COUNT_GLSL), below the world rock, above it air, past its sides the edge columns
// repeated (as farSceneCellsFrag clamps them). A cell is what wcA reads it as: a K_EMPTY kind is air, and a
// liquid at partial fill is there or not by wcA's dither (compact.js volumeA's), so the far ground matches
// the near march's. Trees and structures are cells of the world copy, so no tree placement runs here.
//
// The cube (8³ cells) spans parts of the 3³ bricks around its own. A neighbour whose table entry is one
// uniform word adds its overlap with the cube in one step (Minecraft keeps a uniform chunk section as one
// palette entry; the world copy's sparse bricks are that, Laine & Karras 2010 at one level); only mixed
// bricks (and partial liquids, dithered per cell) are read cell by cell. The brick's own 64 cells vote
// cell by cell, top down per column, in farSceneFrag's order, so the sums are the same floats.
//
// world/far.js runs it over a region of world bricks (a build chunk, a changed box): group 1 the world
// copy (WORLD_COPY_LAYOUT), group 2 the grid (written). tools/far-from-copy-cpu-check.mjs holds its JS
// twin (farCopyTexel below) against the per-cell formula and runs naga on it.
import { prelude, BRICK, LAYOUT } from '../common.js';
import { farLayout, farLayoutGLSL, FAR, FAR_FORMATS, FAR_COUNT_GLSL, farRegionMain, RegionParams, regionDispatch, WORLD_SIZE } from '../far.js';
import { worldCopyWGSL, WORLD_COPY_LAYOUT } from './copy.js';
import { WC_MIXED, WC_AUX_MAX, WC_BRICK } from './cellWord.js';
import { STAGE } from '../../gpu/kernels.js';
import { ELEMENTS, K, R, E } from '../../elements.js';
import { INCAND } from '../../gfx/incandescence.js';
import { appearanceOf, materialWord, materialId, materialAppearance } from '../../appearance.js';
import { packFarTexel } from '../farShared.js';

if (WC_BRICK !== BRICK) throw new Error('farFromCopy: the world copy\'s brick is not the far grid\'s');
const LO = (FAR.CUBE - BRICK) / 2;   // cells the cube reaches past its brick on each side (FAR_CUBE_LO)
if (LO > BRICK) throw new Error('farFromCopy: a cube reaching past the bricks next to its own');

// Group 2: the far grid, written.
export const FAR_COPY_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, storageTexture: { access: 'write-only', format: FAR_FORMATS.grid, viewDimension: '3d' } }];

export const farCopyFrag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${farLayoutGLSL(L)}
${worldCopyWGSL()}
${FAR_COUNT_GLSL}
@group(2) @binding(0) var farOut: texture_storage_3d<rgba16uint, write>;
const FC_FULL_Q: u32 = 65536u;   // (copy.js WC_FULL_Q: a whole cell's fill, the dither's scale)
// a liquid at partial fill: wcA dithers it cell by cell
fn fcDithered(w: u32) -> bool { return KIND(wcId(w)) == K_LIQUID && ((w >> 24u) & 127u) < WC_AUX_WHOLE; }
// cell c's element as wcA reads word w there: a K_EMPTY kind, and a partial liquid dithered out, are air
fn fcId(w: u32, c: vec3i) -> i32 {
  let id = wcId(w);
  if (id == E_EMPTY || KIND(id) == K_EMPTY) { return E_EMPTY; }
  if (fcDithered(w) && ((w >> 24u) & 127u) * FC_FULL_Q / WC_AUX_WHOLE <= (seedWorld(c, 0u, 4243u) >> 16u)) { return E_EMPTY; }
  return id;
}
// world cell c as the summary reads it: below the world rock, above it air, past its sides the edge column
fn fcCol(c: vec3i) -> vec3i { return vec3i(clamp(c.x, 0, WORLD_X - 1), c.y, clamp(c.z, 0, WORLD_Z - 1)); }
fn fcWord(c: vec3i) -> u32 {
  if (c.y < 0) { return u32(E_ROCK); }
  if (c.y >= WORLD_Y) { return u32(E_EMPTY); }
  return wcCell(c);
}
// brick n's table entry (n's x and z held to the world: past its sides the edge columns, whose brick it is)
fn fcEntry(n: vec3i) -> u32 {
  if (n.y < 0) { return u32(E_ROCK); }
  if (n.y >= WBY) { return u32(E_EMPTY); }
  return wcTable[wcBrickIndex(vec3i(clamp(n.x, 0, WBX - 1), n.y, clamp(n.z, 0, WBZ - 1)))];
}
fn fcShare(c: ptr<function, FarCount>, id: i32, n: f32) {
  if (farOpaque(id)) { (*c).s += n; }
  else if (farLiquid(id)) { (*c).l += n; }
}
${farRegionMain(/* wgsl */ `
  var c: FarCount;
  let o = b * BS;
  // the shares: the cube's overlap with each of the 3³ bricks around b
  for (var nz = -1; nz <= 1; nz++) {
    for (var ny = -1; ny <= 1; ny++) {
      for (var nx = -1; nx <= 1; nx++) {
        let n = vec3i(nx, ny, nz);
        // cells [lo, hi) of the cube in brick b + n, from o: -LO..0, 0..BS, BS..BS + LO along each axis
        let lo = select(select(vec3i(BS), vec3i(-FAR_CUBE_LO), n < vec3i(0)), vec3i(0), n == vec3i(0));
        let hi = select(select(vec3i(BS + FAR_CUBE_LO), vec3i(0), n < vec3i(0)), vec3i(BS), n == vec3i(0));
        let e = fcEntry(b + n);
        if ((e & WC_MIXED) == 0u && !fcDithered(e)) {
          let d = hi - lo;
          fcShare(&c, fcId(e, vec3i(0)), f32(d.x * d.y * d.z));
          continue;
        }
        for (var z = lo.z; z < hi.z; z++) {
          for (var y = lo.y; y < hi.y; y++) {
            for (var x = lo.x; x < hi.x; x++) {
              let q = fcCol(o + vec3i(x, y, z));
              fcShare(&c, fcId(fcWord(q), q), 1.0);
            }
          }
        }
      }
    }
  }
  // the votes: the brick's own cells, top down per column, each with the cell over it (air over air: none)
  let own = wcTable[wcBrickIndex(b)];
  if ((own & WC_MIXED) != 0u || fcId(own, vec3i(0)) != E_EMPTY || fcDithered(own)) {
    for (var dz = 0; dz < BS; dz++) {
      for (var dx = 0; dx < BS; dx++) {
        let top = o + vec3i(dx, BS, dz);
        var above = fcId(fcWord(top), top);
        for (var dy = BS - 1; dy >= 0; dy--) {
          let q = o + vec3i(dx, dy, dz);
          let w = wcCell(q);
          let id = fcId(w, q);
          farCell(&c, materialWord(id, appearanceOf(id, f32(wcCtype(w)))), above, wcTemp(w));
          above = id;
        }
      }
    }
  }
  textureStore(farOut, b, farPack(&c));`)}
`;

// ---------------------------------------------------------------- JS twin
// For tools/far-from-copy-cpu-check.mjs: the same summary over a CPU world copy, and the per-cell formula it
// must equal (far.js farSceneFrag, the window's farWinFrag before it, read through the same cell decoder). copy: { size: [x, y, z]
// cells, table: Uint32Array (a word a brick, x + BX (y + BY z)), pool: Uint32Array (64 words a slot) };
// tempOf(word) °C (cellWord.js wcUnword's t); dither(c) the 16-bit dither value at world cell c (wcA's
// seedWorld(c, 0, 4243) >> 16).
const kindOf = (id) => ELEMENTS[id]?.kind ?? K.EMPTY;
const isGasLike = (id) => kindOf(id) === K.GAS || id === E.EMPTY;
const farOpaque = (id) => !isGasLike(id) && ELEMENTS[id]?.render !== R.LIQUID;
const farLiquid = (id) => ELEMENTS[id]?.render === R.LIQUID;
const ROLE = [E.WOOD, E.PLANT, E.MOSS, E.PLANKS].filter((id) => id !== undefined);   // far.js farRoleSlot's (PLANKS once origin/main's is in)
const AP_BARK = 10;   // (appearance.js Appearance.BARK: farVote's last role)
const dithered = (w) => kindOf(w & 255) === K.LIQUID && ((w >>> 24) & 127) < WC_AUX_MAX;
function cellIdOf(w, c, dither) {
  const id = w & 255;
  if (id === E.EMPTY || kindOf(id) === K.EMPTY) return E.EMPTY;
  if (dithered(w) && Math.floor((((w >>> 24) & 127) * 65536) / WC_AUX_MAX) <= dither(c)) return E.EMPTY;
  return id;
}
const cellOf = (copy, [x, y, z]) => {
  const [X, Y] = copy.size, BX = X / BRICK, BY = Y / BRICK;
  const e = copy.table[(x >> 2) + BX * ((y >> 2) + BY * (z >> 2))];
  if (!(e & WC_MIXED)) return e;
  return copy.pool[(e & ~WC_MIXED) * 64 + (x & 3) + 4 * ((y & 3) + 4 * (z & 3))];
};
const colOf = (copy, [x, y, z]) => [Math.min(Math.max(x, 0), copy.size[0] - 1), y, Math.min(Math.max(z, 0), copy.size[2] - 1)];
const wordAt = (copy, c) => (c[1] < 0 ? E.ROCK : c[1] >= copy.size[1] ? E.EMPTY : cellOf(copy, c));
const entryAt = (copy, [x, y, z]) => {
  const [BX, BY, BZ] = copy.size.map((n) => n / BRICK);
  if (y < 0) return E.ROCK;
  if (y >= BY) return E.EMPTY;
  return copy.table[Math.min(Math.max(x, 0), BX - 1) + BX * (y + BY * Math.min(Math.max(z, 0), BZ - 1))];
};
const f32 = Math.fround;
function newCount() { return { w: new Map(), roles: new Map(), open: 0, heat: 0, flames: 0, flameHeat: 0, s: 0, l: 0 }; }
function vote(c, id, appearance, weight) {
  c.w.set(id, f32((c.w.get(id) ?? 0) + weight));
  const slot = ROLE.indexOf(id);
  if (slot >= 0 && appearance >= 0 && appearance <= AP_BARK) { const k = `${id}:${appearance}`; c.roles.set(k, f32((c.roles.get(k) ?? 0) + weight)); }
}
function countCell(c, word, above, T) {
  const id = materialId(word);
  if (farOpaque(id)) {
    const open = !farOpaque(above);
    vote(c, id, materialAppearance(word), open ? FAR.SURFACE_W : 1);
    if (open) { c.open = f32(c.open + 1); c.heat = f32(c.heat + f32(Math.max(f32(T - INCAND.T0), 0))); }
  } else if (farLiquid(id)) c.w.set(id, f32((c.w.get(id) ?? 0) + 1));
  else if (ELEMENTS[id]?.render === R.FIRE) { c.flames = f32(c.flames + 1); c.flameHeat = f32(c.flameHeat + f32(Math.max(f32(T - INCAND.T0), 0))); }
}
const level = (x) => Math.floor(Math.min(Math.max(x, 0), 1) * FAR.LEVELS + 0.5);
function pack(c) {
  const n = FAR.CUBE ** 3, NE = ELEMENTS.length, w = (id) => c.w.get(id) ?? 0;
  let best = E.EMPTY, liquid = E.EMPTY;
  for (let i = 1; i < NE; i++) {
    if (farOpaque(i)) { if (w(i) > w(best)) best = i; } else if (farLiquid(i) && w(i) > w(liquid)) liquid = i;
  }
  let appearance = 0;
  if (ROLE.includes(best)) {
    const r = (a) => c.roles.get(`${best}:${a}`) ?? 0;
    for (let a = 1; a <= AP_BARK; a++) if (r(a) > r(appearance)) appearance = a;
  }
  const glow = level(Math.max(c.open > 0 ? f32(f32(c.heat / c.open) / FAR.GLOW_SPAN) : 0, c.flames > 0 ? f32(f32(c.flameHeat / c.flames) / FAR.GLOW_SPAN) : 0));
  return packFarTexel({ s: level(f32(c.s / n)), l: level(f32(c.l / n)), id: best, appearance, glow, liquid, open: c.open > 0 });
}
// the cell at c as both read it: [id, material word, °C]
function readCell(copy, c, tempOf, dither) {
  const q = colOf(copy, c), w = wordAt(copy, q), id = cellIdOf(w, q, dither);
  return [id, materialWord(id, appearanceOf(id, (w >>> 8) & 255)), tempOf(w)];
}

/** The per-cell formula (far.js farSceneFrag; the window's farWinFrag was the same): world brick b's texel [r, g, b, a], every cube cell read. */
export function farCellTexel(copy, b, { tempOf, dither }) {
  const c = newCount(), o = b.map((v) => v * BRICK);
  for (let dz = -LO; dz < BRICK + LO; dz++) for (let dx = -LO; dx < BRICK + LO; dx++) {
    let above = E.EMPTY;
    const own = dx >= 0 && dz >= 0 && dx < BRICK && dz < BRICK;
    for (let dy = BRICK + LO - 1; dy >= -LO; dy--) {
      const [id, word, T] = readCell(copy, [o[0] + dx, o[1] + dy, o[2] + dz], tempOf, dither);
      if (farOpaque(id)) c.s++; else if (farLiquid(id)) c.l++;
      if (own && dy >= 0 && dy < BRICK) countCell(c, word, above, T);
      above = id;
    }
  }
  return pack(c);
}

/** farCopyFrag's twin: world brick b's texel, uniform neighbours in one step, as the kernel counts. */
export function farCopyTexel(copy, b, { tempOf, dither }) {
  const c = newCount(), o = b.map((v) => v * BRICK);
  const share = (id, n) => { if (farOpaque(id)) c.s += n; else if (farLiquid(id)) c.l += n; };
  for (let nz = -1; nz <= 1; nz++) for (let ny = -1; ny <= 1; ny++) for (let nx = -1; nx <= 1; nx++) {
    const n = [nx, ny, nz];
    const lo = n.map((v) => (v === 0 ? 0 : v < 0 ? -LO : BRICK)), hi = n.map((v) => (v === 0 ? BRICK : v < 0 ? 0 : BRICK + LO));
    const e = entryAt(copy, b.map((v, i) => v + n[i]));
    if (!(e & WC_MIXED) && !dithered(e)) { share(cellIdOf(e, [0, 0, 0], dither), (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])); continue; }
    for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) {
      const q = colOf(copy, [o[0] + x, o[1] + y, o[2] + z]);
      share(cellIdOf(wordAt(copy, q), q, dither), 1);
    }
  }
  const own = entryAt(copy, b);
  if ((own & WC_MIXED) || cellIdOf(own, [0, 0, 0], dither) !== E.EMPTY || dithered(own)) {
    for (let dz = 0; dz < BRICK; dz++) for (let dx = 0; dx < BRICK; dx++) {
      let [above] = readCell(copy, [o[0] + dx, o[1] + BRICK, o[2] + dz], tempOf, dither);
      for (let dy = BRICK - 1; dy >= 0; dy--) {
        const [id, word, T] = readCell(copy, [o[0] + dx, o[1] + dy, o[2] + dz], tempOf, dither);
        countCell(c, word, above, T);
        above = id;
      }
    }
  }
  return pack(c);
}

// ---------------------------------------------------------------- check-wgsl
const Lw = farLayout(WORLD_SIZE);
export const WGSL_CHECK = () => [{
  name: 'farCopy', kind: 'compute', grids: ['128'], warm: false, code: (g) => farCopyFrag(g, Lw),
  layouts: () => [LAYOUT.TABLES, WORLD_COPY_LAYOUT, FAR_COPY_LAYOUT], params: RegionParams, dispatch: () => regionDispatch([16, Lw.bricks.n[1], 16]),
}];
