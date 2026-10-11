import * as THREE from 'three';
import { E } from '../../elements.js';
import { compileKit, MAT, MAT_NAMES, MAT_COUNT, WANG_OUT, WANG_NO_TEMP } from './kit.js';
import { generateTiling, bakeAtlas, atlasLayout, packPlacement, makeSampler } from './tiling.js';
import { wangGLSL } from './glsl.js';

// bakeWang({ kit, seed, size, origin, entry, exit }): a world's Wang tiling,
// ready to sample on the GPU and the CPU.
//   kit     a kit module's default export (kits/mines.js)
//   seed    the world seed (an integer)
//   size    the tiled region in cells [x, y, z]; it holds floor(size / unit)
//           units (U across, H a layer), its top layer the entry's
//   origin  the region's low corner in world cells (default [0, 0, 0])
//   entry   optional [i, k]: the unit of the top layer the main path starts
//           under (its ceiling shaft opens out of the region's top); default
//           a fifth in from the low-x side, centred in z
//   exit    optional [i, k]: the unit of the bottom layer the main path
//           leaves by (its floor shaft opens out of the region's bottom);
//           default a fifth in from the high-x side
// Returns:
//   glsl            wangGLSL(kit): include it in the scene's glsl(g)
//   uniforms()      { tWangAtlas, tWangPlace, uWangOrigin, uWangUnits } (three.js
//                   textures made on first call; add them to the scene's uniforms(P))
//   wangCellJS(w)   the CPU twin of GLSL wangCell: the material code at world
//                   cell w [x, y, z] (or x, y, z)
//   elementJS(code) the element id a code is (the palette's)
//   tempJS(code)    the °C the kit lays it down at (its temps), else WANG_NO_TEMP
//   entry, exit     world cells: the centre of the entry shaft's mouth at the
//                   region's top, the exit shaft's at its bottom
//   mainPath        the main path's bricks, entry to exit, as world boxes
//                   [x0, y0, z0, x1, y1, z1]
//   sites           [{ kind, tile, x, y, z }]: the placed tiles' sites, world cells
//   torches         [[x, y, z], ...]: every wall torch's head (MAT.TORCH) the tiling
//                   left standing, world cells (world/torchLights.js lights them)
//   tiling          the generator's result (bricks, placement) for tools
//   dispose()       frees the textures
// A scene bakes in its prepare(renderer, P) (scenes/index.js); the bake is CPU
// work (rasterizing the kit's tiles and the tiling: tens of milliseconds) and
// pure in (kit, seed, size, entry, exit), so its twin and its textures agree.
export function bakeWang({ kit: rawKit, seed, size, origin = [0, 0, 0], entry, exit }) {
  const kit = compileKit(rawKit), G = kit.geom;
  const units = [Math.floor(size[0] / G.U), Math.floor(size[1] / G.H), Math.floor(size[2] / G.U)];
  const tiling = generateTiling({ kit, seed: seed >>> 0, units, entry, exit });
  const atlas = bakeAtlas(kit);
  const placement = packPlacement(tiling);
  const sample = makeSampler({ kit, units, atlas, placement });
  const wangCellJS = (x, y, z) => (Array.isArray(x) ? sample(x[0] - origin[0], x[1] - origin[1], x[2] - origin[2]) : sample(x - origin[0], y - origin[1], z - origin[2]));
  const palette = MAT_NAMES.slice(0, MAT_COUNT).map((n) => E[kit.palette[n]]);
  const elementJS = (code) => (code >= 0 && code < MAT_COUNT ? palette[code] : E.ROCK);
  const tempJS = (code) => kit.temps?.[MAT_NAMES[code]] ?? WANG_NO_TEMP;
  // a brick's world box, and a canonical point of a placed tile in world cells
  const brickBox = (b) => {
    const [i, k] = [b.ai, b.ak], w = b.longZ ? [1, 2] : [2, 1];
    return [origin[0] + i * G.U, origin[1] + b.l * G.H, origin[2] + k * G.U,
      origin[0] + (i + w[0]) * G.U, origin[1] + (b.l + 1) * G.H, origin[2] + (k + w[1]) * G.U];
  };
  const toWorld = (b, xf, [cx, cy, cz]) => {
    const a = xf & 1 ? 2 * G.U - 1 - cx : cx, bb = xf & 2 ? G.U - 1 - cz : cz;
    const [lx, lz] = xf & 4 ? [bb, a] : [a, bb];
    return [origin[0] + b.ai * G.U + lx, origin[1] + b.l * G.H + cy, origin[2] + b.ak * G.U + lz];
  };
  const shaftMouth = (e, y) => [origin[0] + e.unit[0] * G.U + G.U / 2, y, origin[2] + e.unit[1] * G.U + G.U / 2];
  const sites = [];
  for (const b of tiling.bricks) {
    const pl = tiling.place[b.id], t = kit.tiles[pl.tile];
    for (const s of t.sites) {
      const [x, y, z] = toWorld(b, pl.xf, s.at);
      sites.push({ kind: s.kind, tile: t.name, x, y, z });
    }
  }
  // the torches: each tile's heads (from the atlas), placed, and kept where the
  // sampler didn't cut them away (a port or a shaft through the tile)
  const lay = atlasLayout(kit), [AX, AY] = lay.dims;
  const tileTorches = kit.tiles.map((t, ti) => {
    const [, y0, z0] = lay.origin(ti), out = [];
    for (let z = 0; z < G.U; z++) for (let y = 0; y < G.H; y++) for (let x = 0; x < 2 * G.U; x++)
      if (atlas.data[x + AX * (y0 + y + AY * (z0 + z))] === MAT.TORCH) out.push([x, y, z]);
    return out;
  });
  const torches = [];
  for (const b of tiling.bricks) {
    const pl = tiling.place[b.id];
    for (const c of tileTorches[pl.tile]) {
      const w = toWorld(b, pl.xf, c);
      if (wangCellJS(w) === MAT.TORCH) torches.push(w);
    }
  }
  let tex = null;
  const textures = () => {
    if (tex) return tex;
    const at = new THREE.Data3DTexture(atlas.data, ...atlas.dims);
    at.format = THREE.RedIntegerFormat; at.type = THREE.UnsignedByteType; at.internalFormat = 'R8UI';
    const pl = new THREE.Data3DTexture(placement, units[0], units[2], units[1]);
    pl.format = THREE.RGBAIntegerFormat; pl.type = THREE.UnsignedByteType; pl.internalFormat = 'RGBA8UI';
    for (const t of [at, pl]) { t.unpackAlignment = 1; t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; }
    return (tex = { at, pl });
  };
  return {
    kit, units, origin, glsl: wangGLSL(kit), tiling, atlas, placement, sites, torches,
    uniforms: () => {
      const t = textures();
      return {
        tWangAtlas: { value: t.at }, tWangPlace: { value: t.pl },
        uWangOrigin: { value: new THREE.Vector3(...origin) }, uWangUnits: { value: new THREE.Vector3(...units) },
      };
    },
    wangCellJS, elementJS, tempJS,
    entry: shaftMouth(tiling.entryEdge, origin[1] + units[1] * G.H),
    exit: shaftMouth(tiling.exitEdge, origin[1]),
    mainPath: tiling.mainPath.map((id) => brickBox(tiling.bricks[id])),
    brickBox,
    OUT: WANG_OUT,
    dispose() { if (tex) { tex.at.dispose(); tex.pl.dispose(); tex = null; } },
  };
}
