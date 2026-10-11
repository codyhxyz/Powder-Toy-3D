// CPU checks of the 3D herringbone Wang tiling (src/world/wang): no GPU, fine on battery.
//   - determinism: the same (kit, seed, size) bakes the same bytes; another seed doesn't
//   - every placed edge matches: both bricks on an edge give it the same colour,
//     and each brick's tile accepts the colours it was given
//   - the CPU twin (wangCellJS, through the atlas) equals a direct evaluation of
//     the placed tiles (rasterized afresh, transformed independently)
//   - walkable: a flood fill of a body (BODY_W × BODY_H, steps a cell, jumps
//     JUMP cells, falls any height, swims) from the entry shaft reaches every
//     brick, and falls out through the exit shaft (the main path)
//   - the GLSL compiles (glslangValidator, GLSL ES 3.00) after the prelude
//   - optional previews: PNG slices to a directory (not the repo)
//
//   node scripts/check-wang.mjs [--seeds N] [--kit NAME] [--preview DIR]
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { gridLayout } from '../src/sim.js';
import { prelude } from '../src/shaders/common.js';
import { bakeWang, minesKit, coalKit, snowKit, MAT, WANG_OUT } from '../src/world/wang/index.js';
import { MAT_NAMES, rasterTile, passable, isLiquid, PORTS, SIDE_PORTS, COL } from '../src/world/wang/kit.js';
import { cutPorts } from '../src/world/wang/tiling.js';
import { walkFlood, BODY_W, BODY_H, JUMP } from '../src/world/wang/walk.js';

// every kit is checked; --kit NAME checks just that one
const ALL_KITS = [minesKit, coalKit, snowKit];
const ONLY = process.argv.includes('--kit') ? process.argv[process.argv.indexOf('--kit') + 1] : null;
const KITS = ALL_KITS.filter((k) => !ONLY || k.name === ONLY);
const SIZE = [384, 120, 240];       // a region of 16 × 5 × 10 units (cells)
const SEEDS = Number(process.argv[process.argv.indexOf('--seeds') + 1]) || 4;
const PREVIEW = process.argv.includes('--preview') ? process.argv[process.argv.indexOf('--preview') + 1] : null;
const FRONTIER_SHOWN = 6;          // broken edges a failed walk lists
const TWIN_SAMPLES = 200000;        // cells the twin is compared at
const WIN = [128, 128, 128];        // the prelude's grid (a world window)

let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };

function check(kit, seed) {
  const tag = `${kit.name} seed ${seed}`;
  const t0 = performance.now();
  const W = bakeWang({ kit, seed, size: SIZE });
  const bakeMs = performance.now() - t0;
  const G = W.kit.geom, T = W.tiling;
  // determinism
  const W2 = bakeWang({ kit, seed, size: SIZE });
  if (Buffer.compare(Buffer.from(W.placement), Buffer.from(W2.placement)) || Buffer.compare(Buffer.from(W.atlas.data), Buffer.from(W2.atlas.data))) fail(`${tag}: two bakes differ`);
  const W3 = bakeWang({ kit, seed: seed + 1, size: SIZE });
  if (!Buffer.compare(Buffer.from(W.placement), Buffer.from(W3.placement))) fail(`${tag}: seed ${seed + 1} bakes the same placement`);

  // edges match
  const seen = new Map();
  let edges = 0;
  for (const b of T.bricks) {
    const pl = T.place[b.id], t = W.kit.tiles[pl.tile];
    const map = portMap(T, b, pl.xf);
    map.forEach((e, p) => {
      const c = pl.cols[p];
      if (!t.accepts[p].includes(c)) fail(`${tag}: brick ${b.id} (${t.name}) port ${PORTS[p]} has colour ${c} it doesn't accept`);
      const kind = p < SIDE_PORTS ? 's' : 'v';
      const k = `${kind}${e.key}`;
      if (seen.has(k)) {
        edges++;
        if (seen.get(k) !== c) fail(`${tag}: edge ${e.key}: ${seen.get(k)} on one side, ${c} on the other`);
      } else if (e.nb >= 0) seen.set(k, c);
      else if (c && e !== T.entryEdge && e !== T.exitEdge && e.key !== T.entryEdge.key && e.key !== T.exitEdge.key) fail(`${tag}: brick ${b.id} opens onto rock (${e.key})`);
    });
  }

  // the twin against a direct evaluation
  const tileCells = new Map();
  const direct = (x, y, z) => {
    const i = Math.floor(x / G.U), l = Math.floor(y / G.H), k = Math.floor(z / G.U);
    const id = T.brickOfUnit(i, l, k);
    if (id < 0) return MAT.ROCK;
    const b = T.bricks[id], pl = T.place[id];
    if (!tileCells.has(pl.tile)) tileCells.set(pl.tile, rasterTile(W.kit.tiles[pl.tile], pl.tile, G));
    const lx = x - b.ai * G.U, lz = z - b.ak * G.U, ly = y - l * G.H;
    // world -> canonical: undo transpose, then the mirrors
    let [a, c] = pl.xf & 4 ? [lz, lx] : [lx, lz];
    if (pl.xf & 1) a = 2 * G.U - 1 - a;
    if (pl.xf & 2) c = G.U - 1 - c;
    const code = tileCells.get(pl.tile)[a + 2 * G.U * (ly + G.H * c)];
    let ports = 0;
    for (let p = 0; p < SIDE_PORTS; p++) ports |= pl.cols[p] << (2 * p);
    for (let p = SIDE_PORTS; p < PORTS.length; p++) ports |= (pl.cols[p] ? 1 : 0) << (2 * SIDE_PORTS + p - SIDE_PORTS);
    return cutPorts(G, code, ports, a, ly, c, x, y, z);
  };
  const [RX, RY, RZ] = [W.units[0] * G.U, W.units[1] * G.H, W.units[2] * G.U];
  let s = 12345;
  const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s % n; };
  for (let n = 0; n < TWIN_SAMPLES; n++) {
    const x = rnd(RX), y = rnd(RY), z = rnd(RZ);
    const a = W.wangCellJS(x, y, z), b = direct(x, y, z);
    if (a !== b) { fail(`${tag}: twin ${a} != direct ${b} at ${x},${y},${z}`); break; }
  }
  if (W.wangCellJS(-1, 0, 0) !== WANG_OUT || W.wangCellJS(0, RY, 0) !== WANG_OUT) fail(`${tag}: outside isn't WANG_OUT`);

  // the region's cells
  const N = RX * RY * RZ, cells = new Uint8Array(N);
  const at = (x, y, z) => x + RX * (y + RY * z);
  for (let z = 0; z < RZ; z++) for (let y = 0; y < RY; y++) for (let x = 0; x < RX; x++) cells[at(x, y, z)] = W.wangCellJS(x, y, z);
  // walkability: from the entry shaft's mouth, falling in
  const [ex, , ez] = W.entry;
  const flood = walkFlood(cells, [RX, RY, RZ], [[ex - 1, RY - 1, ez - 1]]);
  const exitDx = W.exit[0] - W.origin[0], exitDz = W.exit[2] - W.origin[2];
  const exited = flood.fellOut.some(([x, z]) => Math.abs(x - exitDx) <= G.SHAFT_W && Math.abs(z - exitDz) <= G.SHAFT_W);
  const leaks = flood.fellOut.filter(([x, z]) => !(Math.abs(x - exitDx) <= G.SHAFT_W && Math.abs(z - exitDz) <= G.SHAFT_W)).length;
  if (leaks) fail(`${tag}: the body falls out of the region's bottom away from the exit (${leaks} places)`);
  const seenS = flood.seen, q = flood.list, qt = q.length;
  if (!qt) fail(`${tag}: the entry shaft doesn't land anywhere`);
  const reached = new Uint8Array(T.bricks.length);
  for (let i = 0; i < qt; i++) {
    const c = q[i], x = c % RX, y = Math.floor(c / RX) % RY, z = Math.floor(c / (RX * RY));
    const id = T.brickOfUnit(Math.floor(x / G.U), Math.floor(y / G.H), Math.floor(z / G.U));
    if (id >= 0) reached[id] = 1;
  }
  const missed = T.bricks.filter((b) => !reached[b.id]);
  if (missed.length) {
    // the frontier: open edges from a reached brick to an unreached one (where the walk breaks)
    let shown = 0;
    for (const b of T.bricks) if (reached[b.id]) for (const [p, e] of portMap(T, b, T.place[b.id].xf).entries()) {
      if (e.nb < 0 || reached[e.nb] || !T.place[b.id].cols[p] || e.dy > 0 || shown++ >= FRONTIER_SHOWN) continue;
      console.log(`  frontier: ${W.kit.tiles[T.place[b.id].tile].name} ${PORTS[p]}(${T.place[b.id].cols[p]}) -> ${W.kit.tiles[T.place[e.nb].tile].name} (edge ${e.key})`);
    }
    const byTile = {};
    for (const b of missed) { const n = W.kit.tiles[T.place[b.id].tile].name; byTile[n] = (byTile[n] ?? 0) + 1; }
    fail(`${tag}: ${missed.length} of ${T.bricks.length} bricks unreachable walking from the entry: ${JSON.stringify(byTile)}`);
  }
  if (!exited) fail(`${tag}: no way down and out through the exit`);
  const pathMissed = T.mainPath.filter((id) => !reached[id]).length;
  if (pathMissed && process.env.WANG_DEBUG) console.log("  path:", T.mainPath.map((id) => `${id}@${T.bricks[id].l}${reached[id] ? "+" : "-"}:${W.kit.tiles[T.place[id].tile].name}`).join(" "));
  if (pathMissed) fail(`${tag}: ${pathMissed} main-path bricks unreachable`);
  const air = cells.reduce((n, c) => n + (c === MAT.AIR), 0);
  console.log(`${tag}: bake ${bakeMs.toFixed(0)} ms, ${T.bricks.length} bricks, ${edges} matched edges, main path ${T.mainPath.length} bricks, ` +
    `${(100 * air / N).toFixed(1)}% air, reached ${T.bricks.length - missed.length}/${T.bricks.length}, exit ${exited ? 'yes' : 'NO'}, sites ${W.sites.length}`);
  if (PREVIEW) preview(W, cells, seenS, [RX, RY, RZ], `${kit.name}-${seed}`);
  return W;
}

// canonical port -> the brick's edge (as tiling.js maps them)
function portMap(T, b, xf) {
  // the edge objects, ordered by the brick's own orientation; remap by geometry
  const res = [];
  const G = T.kit.geom;
  const centre = (e) => e.key;
  for (let p = 0; p < PORTS.length; p++) {
    const name = PORTS[p];
    const j = name === 'W' ? 0 : name === 'E' ? 1 : Number(name[1]);
    let dcx = 0, dcz = 0, dy = 0;
    if (name === 'W') dcx = -1; else if (name === 'E') dcx = 1; else if (name[0] === 'N') dcz = -1; else if (name[0] === 'S') dcz = 1; else dy = name[0] === 'U' ? 1 : -1;
    const aUnit = xf & 1 ? 1 - j : j, da = xf & 1 ? -dcx : dcx, db = xf & 2 ? -dcz : dcz;
    const [ou, d] = xf & 4 ? [[0, aUnit], [db, da]] : [[aUnit, 0], [da, db]];
    const i = b.ai + ou[0], k = b.ak + ou[1];
    let key;
    if (dy > 0) key = `v${b.l},${i},${k}`;
    else if (dy < 0) key = `v${b.l - 1},${i},${k}`;
    else if (d[0]) key = `x${b.l},${d[0] > 0 ? i : i - 1},${k}`;
    else key = `z${b.l},${i},${d[1] > 0 ? k : k - 1}`;
    res.push(b.edges.find((e) => centre(e) === key));
  }
  void G;
  return res;
}

// ---- GLSL
function compileGLSL(kit) {
  const W = bakeWang({ kit, seed: 1, size: SIZE });
  const g = { ...gridLayout(...WIN), windowed: true };
  const src = `#version 300 es\n${prelude(g)}\n${W.glsl}\nout vec4 oC;\nvoid main() {\n  int c = wangCell(ivec3(gl_FragCoord.xyx));\n  oC = vec4(float(wangElement(c)));\n}\n`;
  const dir = mkdtempSync(join(tmpdir(), 'wang-'));
  const f = join(dir, 'wang.frag');
  writeFileSync(f, src);
  try { execFileSync('glslangValidator', [f], { stdio: 'pipe' }); } catch (e) {
    fail(`${kit.name}: GLSL\n${String(e.stdout).split('\n').filter((l) => /ERROR/.test(l)).slice(0, 12).join('\n')}`);
  }
  // its uniforms are the ones uniforms() binds
  for (const name of Object.keys(W.uniforms())) if (!new RegExp(`uniform\\s+\\w+\\s+${name}\\b`).test(W.glsl)) fail(`${kit.name}: uniform ${name} isn't declared`);
}

// ---- previews: PNG slices
const COLOURS = {
  [MAT.AIR]: [18, 14, 20], [MAT.ROCK]: [92, 84, 74], [MAT.SOFT]: [130, 112, 86], [MAT.BEAM]: [170, 110, 50], [MAT.RAIL]: [190, 190, 200],
  [MAT.RUBBLE]: [120, 120, 112], [MAT.WATER]: [40, 110, 170], [MAT.OIL]: [60, 40, 30], [MAT.GOLD]: [240, 200, 40], [MAT.CRYSTAL]: [200, 120, 255],
  [MAT.COAL]: [30, 30, 30], [MAT.MOSS]: [70, 130, 50], [MAT.GRAVEL]: [140, 140, 140], [MAT.METAL]: [160, 165, 175],
  [MAT.SAND]: [236, 242, 255], [MAT.ICE]: [140, 200, 235], [MAT.TORCH]: [255, 150, 60],
  [MAT.TOXIC]: [120, 170, 40], [MAT.BLOOD]: [150, 20, 25], [MAT.ACID]: [170, 255, 60], [MAT.LAVA]: [255, 110, 20],
  [MAT.SLIME]: [90, 200, 120], [MAT.MUD]: [90, 70, 45], [MAT.WHISKEY]: [200, 140, 60], [MAT.TELEPORTATIUM]: [120, 200, 255],
  [MAT.LEVITATIUM]: [200, 230, 255], [MAT.BERSERKIUM]: [255, 120, 160], [MAT.HEALTHIUM]: [140, 255, 200], [MAT.POLYMORPHINE]: [230, 120, 255],
  [MAT.GUNPOWDER]: [60, 60, 70], [MAT.TNT]: [220, 40, 40], [MAT.FUNGUS]: [200, 170, 120], [MAT.MEAT]: [200, 90, 90],
  [MAT.NUGGETS]: [255, 220, 90], [MAT.CLAY]: [180, 120, 90], [MAT.PLANT]: [60, 170, 60], [MAT.WOOD]: [150, 95, 45], [MAT.GLASS]: [200, 230, 230],
};
// a kit's palette can make a code another element: preview it as that element
const ELEMENT_COLOURS = { TOXIC: [120, 170, 40], BROKENCOAL: [50, 46, 44], STONE: [125, 125, 120] };
const paletteColours = (kit) => Object.fromEntries(Object.entries(COLOURS).map(([c, rgb]) => [c, ELEMENT_COLOURS[kit.palette[MAT_NAMES[c]]] ?? rgb]));
function png(path, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const PREVIEW_SCALE = 2;
function preview(W, cells, reachedS, [RX, RY, RZ], name) {
  mkdirSync(PREVIEW, { recursive: true });
  const COLOURS = paletteColours(W.kit);
  const G = W.kit.geom, at = (x, y, z) => x + RX * (y + RY * z);
  const S = PREVIEW_SCALE;
  // top-down slices, one per layer at walking height (and at the gallery storey), stacked
  const heights = [];
  for (let l = W.units[1] - 1; l >= 0; l--) heights.push(l * G.H + G.FLOOR + 3, l * G.H + G.HIGH_FLOOR + 3);
  const GAP = 4, w = RX * S, h = heights.length * (RZ * S + GAP);
  const rgb = Buffer.alloc(w * h * 3);
  heights.forEach((y, row) => {
    for (let z = 0; z < RZ; z++) for (let x = 0; x < RX; x++) {
      const c = cells[at(x, y, z)];
      let col = COLOURS[c] ?? [255, 0, 255];
      // reached floors below light up a little
      if (c === MAT.AIR) {
        let lit = false;
        for (let d = 0; d < 6 && !lit; d++) lit = y - d >= 0 && reachedS[at(x, y - d, z)];
        if (lit) col = [36, 30, 44];
      }
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) rgb.set(col, 3 * ((row * (RZ * S + GAP) + z * S + sy) * w + x * S + sx));
    }
  });
  png(join(PREVIEW, `${name}-plan.png`), w, h, rgb);
  // side views: an x-ray along z (air depth: brighter where more is open behind) and slices at z
  const side = (fn, file) => {
    const b = Buffer.alloc(RX * S * RY * S * 3);
    for (let y = 0; y < RY; y++) for (let x = 0; x < RX; x++) {
      const col = fn(x, y);
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) b.set(col, 3 * (((RY - 1 - y) * S + sy) * RX * S + x * S + sx));
    }
    png(join(PREVIEW, file), RX * S, RY * S, b);
  };
  side((x, y) => {
    let air = 0, first = -1;
    for (let z = 0; z < RZ; z++) {
      const c = cells[at(x, y, z)];
      if (passable(c)) air++;
      else if (first < 0 && c !== MAT.ROCK) first = c;
    }
    const f = air / RZ, base = COLOURS[MAT.ROCK];
    return base.map((v, i) => Math.round(v * (1 - f) * 0.7 + [230, 210, 160][i] * f * 1.8 > 255 ? 255 : v * (1 - f) * 0.7 + [230, 210, 160][i] * f * 1.8));
  }, `${name}-xray.png`);
  for (const zf of [0.35, 0.5]) {
    const z = Math.floor(RZ * zf);
    side((x, y) => COLOURS[cells[at(x, y, z)]] ?? [255, 0, 255], `${name}-slice-z${z}.png`);
  }
  // the brick layout, ASCII: a letter a tile, upper case where the main path runs
  const lines = [];
  const T = W.tiling, onPath = new Set(T.mainPath);
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let l = W.units[1] - 1; l >= 0; l--) {
    lines.push(`layer ${l}`);
    for (let k = 0; k < W.units[2]; k++) {
      let s = '';
      for (let i = 0; i < W.units[0]; i++) {
        const id = T.brickOfUnit(i, l, k);
        if (id < 0) { s += ' ##'; continue; }
        const ch = letters[T.place[id].tile];
        s += ` ${onPath.has(id) ? ch : ch.toLowerCase()}${T.bricks[id].longZ ? '|' : '='}`;
      }
      lines.push(s);
    }
  }
  lines.push('', ...W.kit.tiles.map((t, i) => `${letters[i]} ${t.name}`));
  writeFileSync(join(PREVIEW, `${name}-bricks.txt`), lines.join('\n') + '\n');
}

// ---- each tile alone: for every pair of ports it accepts open (each colour), with only those two
// and every floor shaft it accepts open, the body walks from one to the other (a D port is reached by falling out through it; a U
// port is only a start: you fall in). This is the tile's promise (kit.js) that the tiling's
// connectivity rests on, and the author's quickest feedback.
function checkTiles(rawKit) {
  const W = bakeWang({ kit: rawKit, seed: 1, size: [rawKit.geom?.U * 4 || 96, 24, 96] });
  const kit = W.kit, G = kit.geom, X = 2 * G.U, Y = G.H, Z = G.U;
  let bad = 0;
  kit.tiles.forEach((t, ti) => {
    const cells = rasterTile(t, ti, G);
    const opens = [];
    t.accepts.forEach((cols, p) => cols.forEach((c) => { if (c) opens.push([p, c]); }));
    for (const [pa, ca] of opens) for (const [pb, cb] of opens) {
      if (pa === pb || PORTS[pa][0] === 'D' || PORTS[pb][0] === 'U') continue;
      let ports = 0;
      const set = (p, c) => { ports |= p < SIDE_PORTS ? c << (2 * p) : 1 << (2 * SIDE_PORTS + p - SIDE_PORTS); };
      set(pa, ca); set(pb, cb);
      // every floor shaft it accepts open too: a hole is the one port that can cut a path
      // (but the one under a shaft it's entered by: the tiling never opens a straight drop through)
      t.accepts.forEach((cols, p) => { if (PORTS[p][0] === 'D' && cols.includes(COL.SHAFT) && PORTS[pa] !== `U${PORTS[p][1]}`) set(p, COL.SHAFT); });
      const grid = new Uint8Array(X * Y * Z);
      for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
        grid[x + X * (y + Y * z)] = cutPorts(G, cells[x + X * (y + Y * z)], ports, x, y, z, x, y, z);
      }
      // as authored and mirrored (the tiling places it either way: a 2-wide body sits on the
      // cells differently, so a one-cell ledge can pass one way round and fail the other)
      for (let mir = 0; mir < MIRRORS; mir++) {
        const mx = mir & 1, mz = mir & 2;
        const mg = mir ? new Uint8Array(X * Y * Z) : grid;
        if (mir) for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
          mg[(mx ? X - 1 - x : x) + X * (y + Y * (mz ? Z - 1 - z : z))] = grid[x + X * (y + Y * z)];
        }
        const qa = mirrorPort(pa, mx, mz), qb = mirrorPort(pb, mx, mz);
        const st = mouth(G, qa, ca);
        const f = walkFlood(mg, [X, Y, Z], [st]);
        const res = [...f.list].some((i) => inMouth(G, qb, cb, i % X, Math.floor(i / X) % Y, Math.floor(i / (X * Y)))) ||
          f.fellOut.some(([x, z]) => inMouth(G, qb, cb, x, -1, z));
        if (!res) {
          bad++; failures++;
          console.log(`FAIL tile ${t.name}${mir ? ` (mirrored ${['', 'x', 'z', 'x and z'][mir]})` : ''}: ${PORTS[pa]}(${ca}) -> ${PORTS[pb]}(${cb}) not walkable`);
          break;
        }
      }
    }
  });
  if (!bad) console.log(`${kit.name}: all ${kit.tiles.length} tiles connect every pair of ports they accept`);
}
// a port's name in a tile mirrored in x (W and E, units 0 and 1 swap) and/or z (N and S swap)
const MIRRORS = 4;
function mirrorPort(p, mx, mz) {
  let n = PORTS[p];
  if (mx) n = n === 'W' ? 'E' : n === 'E' ? 'W' : n[0] + (n[1] === '0' ? '1' : '0');
  if (mz && (n[0] === 'N' || n[0] === 'S')) n = (n[0] === 'N' ? 'S' : 'N') + n[1];
  return PORTS.indexOf(n);
}
// a start in port p's mouth (canonical cell), standing (a U port: high in its shaft, to fall)
function mouth(G, p, c) {
  const U = G.U, name = PORTS[p], yb = c === COL.HIGH ? G.HIGH_FLOOR : G.FLOOR;
  if (name === 'W') return [1, yb, U / 2 - 1];
  if (name === 'E') return [2 * U - 3, yb, U / 2 - 1];
  const xc = (name.endsWith('1') ? U : 0) + U / 2 - 1;
  if (name[0] === 'N') return [xc, yb, 1];
  if (name[0] === 'S') return [xc, yb, U - 3];
  return [xc, G.H - 7, U / 2 - 1];   // U: in the ceiling's shaft, falling
}
function inMouth(G, p, c, x, y, z) {
  const U = G.U, name = PORTS[p], yb = c === COL.HIGH ? G.HIGH_FLOOR : G.FLOOR;
  const near = (v, lo, hi) => v >= lo && v < hi;
  if (name === 'W') return x < G.BORDER && Math.abs(y - yb) <= 1;
  if (name === 'E') return x >= 2 * U - G.BORDER - 2 && Math.abs(y - yb) <= 1;
  const xc = (name.endsWith('1') ? U : 0) + U / 2;
  if (name[0] === 'N') return z < G.BORDER && near(x, xc - G.DOOR_W / 2, xc + G.DOOR_W / 2) && Math.abs(y - yb) <= 1;
  if (name[0] === 'S') return z >= U - G.BORDER - 2 && near(x, xc - G.DOOR_W / 2, xc + G.DOOR_W / 2) && Math.abs(y - yb) <= 1;
  return y === -1 && near(x, xc - G.SHAFT_W / 2 - 1, xc + G.SHAFT_W / 2) ;   // D: fell out through the floor
}
for (const kit of KITS) {
  checkTiles(kit);
  compileGLSL(kit);
  for (let s = 1; s <= SEEDS; s++) check(kit, s * 7919);
}
console.log(failures ? `${failures} failure(s)` : 'wang OK');
process.exit(failures ? 1 : 0);
