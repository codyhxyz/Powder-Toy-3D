import { E } from './elements.js';
import { pcg } from './rng.js';

// PLANT does not consume ctype physically; only explicitly tagged tree leaves
// get this geometry, never ordinary ground plants.
export const FOLIAGE_CTYPE = E.PLANT;
export const isFoliageCell = (id, ctype) => id === E.PLANT && Math.floor(ctype) === FOLIAGE_CTYPE;

export function foliageHash([x, y, z]) {
  return pcg((x >>> 0) ^ pcg((y >>> 0) ^ pcg(z >>> 0)));
}

export function foliageFrame(cell) {
  const hash = foliageHash(cell);
  return {
    yaw: (hash & 65535) / 65536 * (2 * Math.PI),
    tilt: ((hash >>> 16) / 65536 - 0.5) * 1.4,
  };
}

// Minecraft cutout/crossed-plant inspiration: a few solid silhouettes instead
// of a voxel cube, but no texture/alpha dependency. Three blades share a twig
// root and fan in one plane, rather than independently rotated confetti.
// Both templates are centred at the origin; every point is within radius 0.48.
// Five geometric points per folded diamond; duplicate triangle vertices for
// crisp, unit face normals. Render double-sided, as with crossed plants.
function template(blades) {
  const positions = [], normals = [], indices = [];
  for (const [tipX, tipZ, width] of blades) {
    const base = [0, -0.025, -0.36], tip = [tipX, -0.025, tipZ];
    const dx = tipX, dz = tipZ - base[2], length = Math.hypot(dx, dz);
    const cx = tipX / 2, cz = (tipZ + base[2]) / 2;
    const wx = dz / length * width, wz = -dx / length * width;
    const ring = [base, [cx - wx, -0.025, cz - wz], tip, [cx + wx, -0.025, cz + wz]];
    const ridge = [cx, 0.025, cz];
    for (let edge = 0; edge < 4; edge++) {
      const a = ring[edge], b = ring[(edge + 1) % 4], c = ridge;
      const u = b.map((v, i) => v - a[i]), v = c.map((p, i) => p - a[i]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const magnitude = Math.hypot(...n);
      for (const point of [a, b, c]) {
        indices.push(positions.length / 3);
        positions.push(...point);
        normals.push(...n.map(value => value / magnitude));
      }
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices) };
}

export const LEAF_FINE = template([[-0.32, 0.18, 0.10], [0, 0.36, 0.105], [0.32, 0.18, 0.10]]);
export const LEAF_COARSE = template([[0, 0.36, 0.32]]);
