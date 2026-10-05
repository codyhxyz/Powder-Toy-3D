import * as THREE from 'three';
import { quadVert } from './shaders/common.js';
import { stampFrag, MAX_FOOT } from './shaders/stamp.js';
import { ELEMENTS, E, K, BUILDS, isBuild } from './elements.js';
import { h } from './ui/dom.js';
import './constructions.css';

// Constructions: whole structures (houses, trees, ...) placed with one click.
//
// Unlike TPT's stamps these are generators, not saved snapshots: each one is
// built procedurally from a seed, a size (the brush size) and a variant, so no
// two trees come out the same. They are made of ordinary elements and behave
// like them: a cottage's wooden walls burn while its stone chimney carries the
// fireplace smoke away, an igloo melts, a powder keg goes off.
//
// A ghost of the exact model follows the cursor and turns its front (+z) to
// face the camera. Clicking uploads the model as a small 3D texture and one GPU
// pass (shaders/stamp.js) writes it into the grid, growing footings under its
// base where the ground falls away.

const STORE = 'powder-toy-3d:builds';
const TAU = Math.PI * 2;
// Built stonework (slabs, chimneys, brick, basins) is WALL: it renders as crisp
// voxels, whereas ROCK is drawn as smoothed natural terrain.
const MASONRY = E.WALL;
const odd = (x) => Math.round(x) | 1;
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const scaleFor = (size) => 0.45 + size * 0.11; // brush size 5 (the default) → 1

// mulberry32
function makeRng(seed) {
  let s = seed >>> 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.int = (lo, hi) => lo + Math.floor((hi - lo + 1) * r());
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  return r;
}
const newSeed = () => (Math.random() * 4294967296) >>> 0;

// ---------------------------------------------------------------- model

// A construction being assembled: sparse cells around its base point (0, 0, 0),
// nothing below y = 0. Shapes take options { temp, ctype, soft }; soft cells
// never replace cells already placed (leaves around branches, fire between logs).
class Model {
  constructor(rnd) {
    this.cells = new Map();
    this.rnd = rnd;
    this.foot = 0; // how deep solid base cells may grow a footing
  }

  static key(x, y, z) { return ((x + 1024) * 2048 + y) * 2048 + (z + 1024); }

  put(x, y, z, id, o) {
    x = Math.round(x); y = Math.round(y); z = Math.round(z);
    if (y < 0) return;
    const k = Model.key(x, y, z);
    if (o?.soft && this.cells.has(k)) return;
    this.cells.set(k, { x, y, z, id, temp: o?.temp ?? ELEMENTS[id].temp, ctype: o?.ctype ?? 0 });
  }

  // inclusive bounds
  box(x0, y0, z0, x1, y1, z1, id, o) {
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) this.put(x, y, z, id, o);
  }

  // Horizontal disc; `rough` frays the edge by up to ±rough/2 cells.
  disc(cx, y, cz, r, id, o = {}) {
    const R = Math.ceil(r + 1), rough = o.rough ?? 0, holes = o.holes ?? 0;
    for (let z = Math.floor(cz - R); z <= Math.ceil(cz + R); z++)
      for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
        const d = Math.hypot(x - cx, z - cz);
        if (d > r + rough * (this.rnd() - 0.5)) continue;
        if (holes && this.rnd() < holes) continue;
        this.put(x, y, z, id, o);
      }
  }

  // Ellipsoid of radius r, squashed vertically by sy, with a frayed edge and gaps.
  ball(cx, cy, cz, r, id, o = {}) {
    const sy = o.sy ?? 1, rough = o.rough ?? 0, holes = o.holes ?? 0;
    const R = Math.ceil(r + 1), Ry = Math.ceil(r * sy + 1);
    for (let y = Math.floor(cy - Ry); y <= Math.ceil(cy + Ry); y++)
      for (let z = Math.floor(cz - R); z <= Math.ceil(cz + R); z++)
        for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
          const d = Math.hypot(x - cx, (y - cy) / sy, z - cz) / r;
          if (d > 1 + rough * (this.rnd() - 0.5)) continue;
          if (holes && this.rnd() < holes) continue;
          this.put(x, y, z, id, o);
        }
  }

  // Thick segment from a to b (Vector3s). r = 0.5 draws a single-cell line,
  // kept face-connected so thin trunks and branches don't touch only at corners.
  rod(a, b, r, id, o) {
    const n = Math.max(1, Math.ceil(a.distanceTo(b) * 2));
    const R = Math.ceil(r), r2 = r * r;
    let lx, ly, lz;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = Math.round(a.x + (b.x - a.x) * t);
      const py = Math.round(a.y + (b.y - a.y) * t);
      const pz = Math.round(a.z + (b.z - a.z) * t);
      if (i > 0 && r2 < 1) {
        if (px !== lx && (py !== ly || pz !== lz)) this.put(px, ly, lz, id, o);
        if (pz !== lz && py !== ly) this.put(px, py, lz, id, o);
      }
      lx = px; ly = py; lz = pz;
      for (let dy = -R; dy <= R; dy++)
        for (let dz = -R; dz <= R; dz++)
          for (let dx = -R; dx <= R; dx++)
            if (dx * dx + dy * dy + dz * dz <= r2) this.put(px + dx, py + dy, pz + dz, id, o);
    }
  }
}

// Turn a direction by `ang` radians toward a random perpendicular.
function bend(dir, ang, rnd) {
  const perp = v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(dir);
  if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
  perp.normalize();
  return dir.clone().multiplyScalar(Math.cos(ang)).addScaledVector(perp, Math.sin(ang)).normalize();
}

// ---------------------------------------------------------------- houses

function house(m, rnd, t, variant) {
  const W = odd(17 * t * rnd.range(0.92, 1.08));
  const D = odd(W * rnd.range(0.62, 0.74));
  const hw = (W - 1) / 2, hd = (D - 1) / 2;
  const H = Math.max(4, Math.round(W * 0.4)); // wall height above the slab
  const green = variant === 'greenhouse', cabin = variant === 'cabin';
  const wall = variant === 'brick' ? MASONRY : green ? E.GLASS : E.WOOD;
  const roof = green ? E.GLASS : E.WOOD;
  m.foot = MAX_FOOT;

  // stone slab, one cell wider than the walls (it grows a plinth on uneven ground)
  m.box(-hw - 1, 0, -hd - 1, hw + 1, 0, hd + 1, MASONRY);

  // walls around an empty room
  const post = (x, z) => (Math.abs(x) === hw && Math.abs(z) === hd) ||
    (Math.abs(z) === hd && x % 4 === 0) || (Math.abs(x) === hw && z % 4 === 0);
  for (let y = 1; y <= H; y++)
    for (let z = -hd; z <= hd; z++)
      for (let x = -hw; x <= hw; x++) {
        if (Math.abs(x) !== hw && Math.abs(z) !== hd) { m.put(x, y, z, E.EMPTY); continue; }
        // a greenhouse is glass on a steel frame over a low stone wall
        m.put(x, y, z, !green ? wall : y <= 2 ? MASONRY : y === H || post(x, z) ? E.METAL : E.GLASS);
      }
  if (cabin) {
    // log ends cross at the corners, alternating course by course
    for (let y = 1; y <= H; y++)
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          if (y % 2) m.put(sx * (hw + 1), y, sz * hd, E.WOOD);
          else m.put(sx * hw, y, sz * (hd + 1), E.WOOD);
        }
  }

  // gable roof with its ridge along x and one cell of overhang. The slope is two
  // cells thick so each step overlaps the next and nothing leaks diagonally.
  const gable = green ? E.GLASS : wall;
  for (let i = 0; hd + 1 - i >= 0; i++) {
    const zr = hd + 1 - i, y = H + 1 + i;
    for (let z = -zr; z <= zr; z++)
      for (let x = -hw - 1; x <= hw + 1; x++) {
        if (Math.abs(z) >= zr - 1) m.put(x, y, z, green && (x % 4 === 0 || zr <= 1) ? E.METAL : roof);
        else if (Math.abs(x) === hw) m.put(x, y, z, gable);
        else if (Math.abs(x) < hw) m.put(x, y, z, E.EMPTY);
      }
  }

  // openings: u runs along the wall, faces are front (+z, the door), back, left, right
  const cut = (face, u0, u1, y0, y1, id) => {
    for (let y = y0; y <= y1; y++)
      for (let u = u0; u <= u1; u++) {
        if (face === 'front') m.put(u, y, hd, id);
        else if (face === 'back') m.put(u, y, -hd, id);
        else m.put(face === 'left' ? -hw : hw, y, u, id);
      }
  };
  const dw = odd(1.6 * t), dh = Math.min(H - 1, Math.max(3, Math.round(H * 0.72)));
  cut('front', -(dw - 1) / 2, (dw - 1) / 2, 1, dh, E.EMPTY);
  if (!green) {
    const ww = Math.max(1, Math.round((cabin ? 1.4 : 2) * t));
    const wy0 = Math.max(2, Math.round(H * (cabin ? 0.42 : 0.32))), wy1 = Math.max(wy0 + 1, Math.round(H * 0.72));
    const win = (face, c) => cut(face, c - Math.floor(ww / 2), c - Math.floor(ww / 2) + ww - 1, wy0, wy1, E.GLASS);
    const off = Math.round(hw * 0.55);
    if (off - ww / 2 > (dw - 1) / 2 + 1) { win('front', -off); win('front', off); }
    win('back', -off); win('back', off);
    if (hd >= 3) win('left', 0);
  }

  // stone chimney on the right gable with an open fireplace and a log in the hearth
  if (!green) {
    const cz = -Math.round(hd * 0.35);
    const top = H + 1 + (hd + 1 - Math.max(0, Math.abs(cz) - 1)) + 2;
    for (let y = 1; y <= top; y++)
      for (let z = cz - 1; z <= cz + 1; z++)
        for (let x = hw - 1; x <= hw + 1; x++) {
          const flue = x === hw && z === cz;
          m.put(x, y, z, flue ? (y === 1 ? E.WOOD : E.EMPTY) : MASONRY);
        }
    m.box(hw - 1, 1, cz, hw - 1, 2, cz, E.EMPTY); // fireplace mouth
  }

  // greenhouse beds: water troughs along both long walls, seeded with plants
  if (green && hd >= 3) {
    for (const s of [-1, 1])
      for (let x = -hw + 1; x <= hw - 1; x++) {
        if (s > 0 && Math.abs(x) <= (dw + 1) / 2) { m.put(x, 1, s * (hd - 1), MASONRY); continue; } // doorstep
        m.put(x, 1, s * (hd - 1), E.WATER);
        m.put(x, 1, s * (hd - 2), MASONRY);
        if ((x + hw) % 3 === 1) m.put(x, 2, s * (hd - 1), E.PLANT);
      }
  }
}

// ---------------------------------------------------------------- trees

const TREES = {
  oak(m, rnd, t) {
    const H = Math.round(rnd.range(21, 26) * t);
    const th = Math.round(H * rnd.range(0.36, 0.44));
    const tr = Math.max(0.5, 1.1 * t);
    m.foot = 10;
    m.rod(v3(0, 0, 0), v3(0, th, 0), tr + 0.4, E.WOOD);
    m.disc(0, 0, 0, tr + 1.6, E.WOOD); // root flare
    const crowns = [v3(0, th + H * 0.3, 0)];
    const n = rnd.int(3, 5), a0 = rnd() * TAU;
    for (let i = 0; i < n; i++) {
      const az = a0 + (i / n) * TAU + rnd.range(-0.3, 0.3), el = rnd.range(0.5, 1.0);
      const a = v3(0, th - rnd.int(0, 2), 0);
      const dir = v3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      const b = a.clone().addScaledVector(dir, H * rnd.range(0.26, 0.36));
      m.rod(a, b, Math.max(0.5, tr * 0.6), E.WOOD);
      crowns.push(b);
    }
    for (const c of crowns)
      m.ball(c.x, c.y, c.z, H * rnd.range(0.2, 0.26), E.PLANT, { sy: 0.75, rough: 0.35, holes: 0.04, soft: true });
  },

  pine(m, rnd, t) {
    const H = Math.round(rnd.range(26, 32) * t);
    m.foot = 10;
    m.rod(v3(0, 0, 0), v3(0, H - 2, 0), t > 1.5 ? 1 : 0.5, E.WOOD);
    const y0 = Math.round(H * rnd.range(0.14, 0.22));
    const R = H * rnd.range(0.22, 0.27);
    const tiers = Math.max(3, Math.round(rnd.range(4, 5.5) * Math.sqrt(t)));
    for (let y = y0; y <= H; y++) {
      const u = (y - y0) / (H - y0);
      const phase = (u * tiers) % 1; // each tier flares at its bottom
      const r = R * Math.pow(1 - u, 0.9) * (1 - 0.5 * phase) + 0.6;
      m.disc(0, y, 0, r, E.PLANT, { rough: 0.9, holes: 0.03, soft: true });
    }
  },

  birch(m, rnd, t) {
    const H = Math.round(rnd.range(28, 34) * t);
    const tr = t > 1.6 ? 1 : 0.5;
    m.foot = 10;
    // a slender, slightly wandering trunk
    const pts = [v3(0, 0, 0)];
    for (let y = 5; y < H - 2; y += 5) {
      const p = pts[pts.length - 1];
      pts.push(v3(THREE.MathUtils.clamp(p.x + rnd.range(-0.8, 0.8), -2, 2), y,
        THREE.MathUtils.clamp(p.z + rnd.range(-0.8, 0.8), -2, 2)));
    }
    const tip = pts[pts.length - 1];
    pts.push(v3(tip.x, H - 2, tip.z));
    for (let i = 1; i < pts.length; i++) m.rod(pts[i - 1], pts[i], tr, E.WOOD);
    const trunkAt = (y) => pts[Math.min(pts.length - 1, Math.round(y / 5))];
    // small, airy leaf clusters on short twigs
    const k = rnd.int(7, 10);
    for (let i = 0; i < k; i++) {
      const y = H * rnd.range(0.4, 0.9), az = rnd() * TAU, d = rnd.range(1, Math.max(1.5, H * 0.1));
      const base = trunkAt(y);
      const c = v3(base.x + Math.cos(az) * d, y, base.z + Math.sin(az) * d);
      m.rod(v3(base.x, y - 1, base.z), c, 0.5, E.WOOD);
      m.ball(c.x, c.y, c.z, H * rnd.range(0.07, 0.1), E.PLANT, { sy: 1.5, rough: 0.4, holes: 0.18, soft: true });
    }
    const top = pts[pts.length - 1];
    m.ball(top.x, H - 1, top.z, H * 0.08, E.PLANT, { sy: 1.6, rough: 0.4, holes: 0.12, soft: true });
  },

  palm(m, rnd, t) {
    const H = Math.round(rnd.range(20, 25) * t);
    const az = rnd() * TAU, lean = H * rnd.range(0.18, 0.32);
    const tr = t > 1.2 ? 1 : 0.5;
    m.foot = 10;
    const at = (y) => { const k = (y / H) ** 2 * lean; return v3(Math.cos(az) * k, y, Math.sin(az) * k); };
    for (let y = 0; y < H; y += 2) m.rod(at(y), at(Math.min(H, y + 2)), tr, E.WOOD);
    const top = at(H);
    // fronds rise a little, then droop; leaflets fan out sideways
    const n = rnd.int(7, 9), a0 = rnd() * TAU;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * TAU + rnd.range(-0.2, 0.2);
      const L = H * rnd.range(0.36, 0.46);
      const dir = v3(Math.cos(a), 0, Math.sin(a)), side = v3(-dir.z, 0, dir.x);
      let prev = top;
      for (let s = 1; s <= L; s++) {
        const p = top.clone().addScaledVector(dir, s);
        p.y += 0.7 * s - (1.25 * s * s) / L;
        m.rod(prev, p, 0.5, E.PLANT, { soft: true });
        const lw = Math.round(2.8 * t * (1 - s / L));
        if (lw > 0)
          for (const sg of [-1, 1])
            m.rod(p, p.clone().addScaledVector(side, sg * lw).add(v3(0, -0.6 * lw, 0)), 0.5, E.PLANT, { soft: true });
        prev = p;
      }
    }
    for (let i = rnd.int(2, 4); i > 0; i--) {
      const a = rnd() * TAU;
      m.ball(top.x + Math.cos(a) * 1.3, top.y - 1.5, top.z + Math.sin(a) * 1.3, 0.9, E.WOOD, { soft: true });
    }
  },

  willow(m, rnd, t) {
    const H = Math.round(rnd.range(19, 23) * t);
    const tr = Math.max(0.5, 1.3 * t);
    const th = Math.round(H * 0.42);
    m.foot = 10;
    m.rod(v3(0, 0, 0), v3(0, th, 0), tr + 0.4, E.WOOD);
    m.disc(0, 0, 0, tr + 1.4, E.WOOD);
    const R = H * rnd.range(0.48, 0.56); // a wide, low dome
    const cy = H - R * 0.45;
    const n = rnd.int(4, 6), a0 = rnd() * TAU;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * TAU;
      m.rod(v3(0, th - 1, 0), v3(Math.cos(a) * R * 0.55, cy + rnd.range(-1, 2), Math.sin(a) * R * 0.55),
        Math.max(0.5, tr * 0.55), E.WOOD);
    }
    m.ball(0, cy, 0, R, E.PLANT, { sy: 0.45, rough: 0.3, holes: 0.08, soft: true });
    // curtains of strands hanging from the underside, longest at the rim
    const strands = Math.round(R * R * 0.9);
    for (let i = 0; i < strands; i++) {
      const a = rnd() * TAU, d = R * Math.sqrt(rnd.range(0.2, 1)) * 0.98;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const y0 = cy - R * 0.45 * Math.sqrt(Math.max(0, 1 - (d / R) ** 2));
      const len = Math.max(0, rnd.range(0.35, 0.85) * (y0 - 2) * (0.4 + 0.6 * d / R));
      m.rod(v3(x, y0, z), v3(x + rnd.range(-0.6, 0.6), Math.max(2, y0 - len), z + rnd.range(-0.6, 0.6)), 0.5,
        E.PLANT, { soft: true });
    }
  },

  dead(m, rnd, t) {
    const H = Math.round(rnd.range(17, 22) * t);
    m.foot = 10;
    const grow = (a, dir, len, r, depth) => {
      const b = a.clone().addScaledVector(dir, len);
      m.rod(a, b, r, E.WOOD);
      if (depth === 0) return;
      for (let i = rnd.int(2, 3); i > 0; i--) {
        const d = bend(dir, rnd.range(0.35, 0.8), rnd).add(v3(0, 0.25, 0)).normalize();
        grow(b, d, len * rnd.range(0.55, 0.75), Math.max(0.5, r * 0.62), depth - 1);
      }
    };
    m.disc(0, 0, 0, 1.2 * t + 1.2, E.WOOD);
    grow(v3(0, 0, 0), v3(rnd.range(-0.1, 0.1), 1, rnd.range(-0.1, 0.1)).normalize(), H * 0.42, Math.max(0.5, t), 3);
  },
};

// ---------------------------------------------------------------- the rest

function campfire(m, rnd, t, variant) {
  const lit = variant === 'lit';
  const R = Math.max(3, Math.round(4 * t));
  for (let z = -R - 1; z <= R + 1; z++)
    for (let x = -R - 1; x <= R + 1; x++) {
      const d = Math.hypot(x, z);
      if (Math.abs(d - R) < 0.6) m.put(x, 0, z, E.STONE);
      else if (lit && d < R - 0.4) m.put(x, 0, z, E.ASH);
    }
  // logs leaning together; a lit fire starts above wood's 300 °C ignition point
  const n = rnd.int(4, 5), a0 = rnd() * TAU, top = Math.round(R * 1.4);
  const o = { temp: lit ? 450 : undefined };
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU;
    const foot = v3(Math.cos(a) * (R - 1), 0, Math.sin(a) * (R - 1));
    m.rod(foot, foot.clone().lerp(v3(0, top, 0), 0.85), t > 1.6 ? 1 : 0.5, E.WOOD, o);
  }
  if (lit) m.ball(0, 1, 0, Math.max(1, R * 0.35), E.FIRE, { soft: true });
}

// Ice is the only static frozen solid, and it renders clear like glass, so the
// dome is a thick ice shell with snow lying on the gentle upper part (snow on
// the steep sides would just slide off: it's a powder).
function igloo(m, rnd, t) {
  const R = Math.max(5, Math.round(7.5 * t)), th = Math.max(2, Math.round(2.2 * t));
  const ri = R - th, drift = Math.max(2, Math.round(3 * t));
  m.foot = 8;
  for (let y = 0; y <= R + 2; y++)
    for (let z = -R - drift - 1; z <= R + drift + 1; z++)
      for (let x = -R - drift - 1; x <= R + drift + 1; x++) {
        const d = Math.hypot(x, y, z), dh = Math.hypot(x, z);
        if (d <= R + 0.3) m.put(x, y, z, d > ri ? E.ICE : E.EMPTY);
        else if (d <= R + 1.3 && y > 0.78 * d && rnd() > 0.12) m.put(x, y, z, E.SNOW);
        // a drift banked against the wall, no steeper than snow's angle of repose
        else if (y < drift - (dh - R) && rnd() > 0.08) m.put(x, y, z, E.SNOW);
      }
  // entrance tunnel toward the front
  const tr = Math.max(3, Math.round(R * 0.45));
  for (let z = 0; z <= R + Math.round(R * 0.45); z++)
    for (let y = 0; y <= tr + 1; y++)
      for (let x = -tr - 1; x <= tr + 1; x++) {
        const e = Math.hypot(x, y);
        if (e > tr + 0.3) continue;
        if (e <= tr - 1.5) m.put(x, y, z, E.EMPTY);
        else if (Math.hypot(x, y, z) >= ri - 0.5) m.put(x, y, z, E.ICE);
      }
}

function barrel(m, rnd, t, variant) {
  const keg = variant === 'keg';
  const R0 = Math.max(2, Math.round(3.6 * t)), H = Math.round(R0 * (keg ? 2.4 : 2.8));
  const shell = keg ? E.WOOD : E.METAL, fill = keg ? E.GUNPOWDER : E.OIL;
  // steel hoops on the keg, rolling rims on the drum (flush with the shell)
  const hoops = keg ? [1, Math.round(H * 0.3), Math.round(H * 0.7), H - 2] : [Math.round(H / 3), Math.round((2 * H) / 3)];
  const B = Math.ceil(R0 * 1.15) + 1;
  for (let y = 0; y < H; y++) {
    const R = keg ? R0 * (1 + 0.14 * Math.sin((Math.PI * (y + 0.5)) / H)) : R0; // kegs bulge
    const band = hoops.includes(y) ? E.METAL : shell;
    for (let z = -B; z <= B; z++)
      for (let x = -B; x <= B; x++) {
        const d = Math.hypot(x, z);
        if (d > R + 0.35) continue;
        // a shell band 1.5 cells wide is face-connected, so nothing seeps out diagonally
        if (y === 0 || y === H - 1) m.put(x, y, z, shell);
        else m.put(x, y, z, d > R - 1.15 ? band : fill);
      }
  }
}

function aquarium(m, rnd, t) {
  const W = odd(17 * t), D = odd(W * 0.6), H = Math.max(5, Math.round(W * 0.62));
  const hw = (W - 1) / 2, hd = (D - 1) / 2;
  const p1 = rnd() * TAU, p2 = rnd() * TAU;
  m.foot = 12;
  for (let y = 0; y < H; y++)
    for (let z = -hd; z <= hd; z++)
      for (let x = -hw; x <= hw; x++) {
        const sand = 1 + Math.round(0.8 + 0.7 * Math.sin(x * 0.45 + p1) + 0.5 * Math.sin(z * 0.6 + p2));
        if (y === 0 || Math.abs(x) === hw || Math.abs(z) === hd) m.put(x, y, z, E.GLASS);
        else if (y <= sand) m.put(x, y, z, E.SAND);
        else if (y <= H - 2) m.put(x, y, z, E.WATER);
      }
  for (let i = rnd.int(2, 4); i > 0; i--)
    m.ball(rnd.range(-hw + 2, hw - 2), 2.5, rnd.range(-hd + 2, hd - 2), rnd.range(0.8, 1.6), E.STONE);
}

function fountain(m, rnd, t) {
  const R = Math.max(3, Math.round(6.5 * t));
  m.foot = 12;
  for (let z = -R - 1; z <= R + 1; z++)
    for (let x = -R - 1; x <= R + 1; x++) {
      const d = Math.hypot(x, z);
      if (d > R + 0.3) continue;
      m.put(x, 0, z, MASONRY);
      if (d > R - 1.2) m.box(x, 1, z, x, 2, z, MASONRY);
      else m.put(x, 1, z, E.WATER);
    }
  const ph = Math.max(3, Math.round(R * 1.2)), br = Math.max(2, Math.round(R * 0.38));
  m.rod(v3(0, 1, 0), v3(0, ph, 0), Math.max(1, t), MASONRY);
  m.disc(0, ph + 1, 0, br + 0.3, MASONRY);
  for (let z = -br - 1; z <= br + 1; z++)
    for (let x = -br - 1; x <= br + 1; x++) {
      const d = Math.hypot(x, z);
      if (d > br - 1.2 && d <= br + 0.3) m.put(x, ph + 2, z, MASONRY);
    }
  m.put(0, ph + 2, 0, E.CLONE, { ctype: E.WATER }); // the spout
}

const GENERATORS = {
  HOUSE: house,
  TREE: (m, rnd, t, variant) => TREES[variant](m, rnd, t),
  CAMPFIRE: campfire,
  IGLOO: igloo,
  BARREL: barrel,
  AQUARIUM: aquarium,
  FOUNTAIN: fountain,
};

function generate(build, variant, seed, size) {
  const rnd = makeRng(seed);
  const m = new Model(rnd);
  GENERATORS[build.key](m, rnd, scaleFor(size), variant);
  return m;
}

// ---------------------------------------------------------------- bake

const TURN = [(x, z) => [x, z], (x, z) => [z, -x], (x, z) => [-x, -z], (x, z) => [-z, x]];

// Rotate a model by quarter turns about y (the front, +z, ends up facing
// +z, +x, -z or -x) and pack it into the stamp texture layout.
function bake(model, quarter) {
  const turn = TURN[quarter];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const list = [];
  for (const c of model.cells.values()) {
    const [x, z] = turn(c.x, c.z);
    const p = [x, c.y, z];
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
    list.push([p, c]);
  }
  if (!list.length) return null;
  const w = max[0] - min[0] + 1, h = max[1] - min[1] + 1, d = max[2] - min[2] + 1;
  const data = new Float32Array(w * h * d * 4);
  const ids = new Int16Array(w * h * d).fill(-1);
  const at = (x, y, z) => (z * h + y) * w + x;
  for (const [p, c] of list) {
    const x = p[0] - min[0], y = p[1] - min[1], z = p[2] - min[2];
    const i = at(x, y, z);
    ids[i] = c.id;
    data.set([c.id + 1, c.temp, c.ctype, model.foot && c.y === 0 && ELEMENTS[c.id].kind === K.SOLID ? 1 : 0], i * 4);
  }
  // ghost: every non-air cell that isn't buried inside the model
  const ghost = [];
  const solid = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < w && y < h && z < d && ids[at(x, y, z)] > 0;
  for (let z = 0; z < d; z++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const id = ids[at(x, y, z)];
        if (id <= 0) continue;
        if (solid(x - 1, y, z) && solid(x + 1, y, z) && solid(x, y - 1, z) && solid(x, y + 1, z) &&
          solid(x, y, z - 1) && solid(x, y, z + 1)) continue;
        ghost.push(x, y, z, id);
      }
  return { w, h, d, data, ghost, foot: model.foot, base: v3(-min[0], -min[1], -min[2]) };
}

// ---------------------------------------------------------------- ghost

const ghostVert = /* glsl */ `
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  vColor = instanceColor;
  vNormal = normal; // instances are only translated, so these are grid-space normals
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const ghostFrag = /* glsl */ `
uniform float uAlpha;
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  float lit = 0.55 + 0.45 * max(dot(vNormal, normalize(vec3(0.45, 0.8, 0.35))), 0.0);
  gl_FragColor = vec4(vColor * lit * uAlpha, uAlpha);
}`;

function hexRGB(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---------------------------------------------------------------- UI

const ICON_SHUFFLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3.5c3 0 4 10 7 10H20M4 17h3.5c1.3 0 2.2-1.8 3-4M20 7h-5.5c-1.3 0-2.2 1.8-3 4"/><path d="M17 4l3 3-3 3M17 14l3 3-3 3"/></svg>';
const ICON_DICE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1"/><circle cx="15" cy="15" r="1.1"/><circle cx="15" cy="9" r="1.1"/><circle cx="9" cy="15" r="1.1"/></svg>';

// ---------------------------------------------------------------- module

export class Constructions {
  constructor({ scene, camera, settings, getSim, getVolume, getScale }) {
    this.camera = camera;
    this.settings = settings;
    this.getSim = getSim;
    this.getVolume = getVolume;
    this.getScale = getScale;

    this.choice = {}; // build key -> variant key or 'shuffle'
    try { Object.assign(this.choice, JSON.parse(localStorage.getItem(STORE) || '{}').choice); } catch { /* storage unavailable */ }
    this.seed = newSeed();
    this.model = null; this.modelKey = '';
    this.baked = null; this.bakeKey = '';
    this.origin = new THREE.Vector3();
    this.valid = false;
    this.mat = null; this.gridKey = '';

    // ghost: a depth-only pass, then a translucent colour pass that only keeps
    // the frontmost faces, so it reads as one solid object rather than a jumble
    this.group = new THREE.Group();
    this.group.visible = false;
    this.geo = new THREE.BoxGeometry(1, 1, 1);
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true });
    this.colorMat = new THREE.ShaderMaterial({
      vertexShader: ghostVert, fragmentShader: ghostFrag,
      uniforms: { uAlpha: { value: 0.6 } },
      transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.meshes = [];
    this.capacity = 0;
    this.outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xf4f6fa, transparent: true, opacity: 0.28, depthTest: false }));
    this.outline.renderOrder = 11;
    this.group.add(this.outline);
    scene.add(this.group);

    // after placing, hide the ghost until the pointer moves (it would sit on the new roof)
    this.pointer = [0, 0];
    this.hold = null;
    this._onMove = (e) => {
      this.pointer = [e.clientX, e.clientY];
      if (this.hold && Math.hypot(e.clientX - this.hold[0], e.clientY - this.hold[1]) > 6) this.hold = null;
    };
    addEventListener('pointermove', this._onMove);

    this.bar = this._createBar();
    this._tmp = new THREE.Vector3();
  }

  get ready() { return this.valid; }

  // Call every frame. `active`: a construction is selected and the pointer is over the scene.
  update({ hover, active }) {
    const id = this.settings.tool;
    const build = isBuild(id) ? BUILDS.find((b) => b.id === id) : null;
    this._syncBar(build);
    this.valid = false;
    this.group.visible = false;
    if (!build || !active || !hover.valid || this.hold) return;

    // turn the front toward the camera, snapped to the grid axes
    const f = this.camera.getWorldDirection(this._tmp);
    const quarter = Math.abs(f.x) > Math.abs(f.z) ? (f.x > 0 ? 3 : 1) : (f.z > 0 ? 2 : 0);
    const variant = this.variantFor(build);
    const mk = `${build.key}|${variant}|${this.seed}|${this.settings.radius}`;
    if (mk !== this.modelKey) {
      this.model = generate(build, variant, this.seed, this.settings.radius);
      this.modelKey = mk;
      this.bakeKey = '';
    }
    const bk = `${mk}|${quarter}`;
    if (bk !== this.bakeKey) {
      this.baked = bake(this.model, quarter);
      this.bakeKey = bk;
      if (this.baked) this._setGhost(this.baked);
    }
    const s = this.baked;
    if (!s) return;

    // sit the base on the hovered face (or hang it under / beside it)
    const g = this.getSim().g;
    const axis = Math.floor(hover.face / 2), dir = hover.face % 2 === 0 ? 1 : -1;
    const a = this._tmp.copy(hover.cell).setComponent(axis, hover.cell.getComponent(axis) + dir);
    const o = this.origin.copy(a).sub(s.base);
    if (axis === 0) o.x = dir > 0 ? a.x : a.x - s.w + 1;
    if (axis === 2) o.z = dir > 0 ? a.z : a.z - s.d + 1;
    if (axis === 1 && dir < 0) o.y = a.y - s.h + 1;
    // keep it inside the box when it fits
    if (s.w <= g.nx) o.x = THREE.MathUtils.clamp(o.x, 0, g.nx - s.w);
    if (s.d <= g.nz) o.z = THREE.MathUtils.clamp(o.z, 0, g.nz - s.d);
    o.y = Math.max(0, o.y);

    const scale = this.getScale();
    this.group.scale.setScalar(scale);
    this.group.position.copy(o).multiplyScalar(scale).add(this.getVolume().position);
    this.group.visible = true;
    this.valid = true;
  }

  // Stamp the previewed construction into the grid. The caller snapshots for undo first.
  place() {
    if (!this.valid) return false;
    const sim = this.getSim(), g = sim.g;
    const gk = `${g.nx}x${g.ny}x${g.nz}`;
    if (gk !== this.gridKey) {
      this.mat?.dispose();
      this.mat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: quadVert,
        fragmentShader: stampFrag(g),
        uniforms: {
          tA: { value: null }, tB: { value: null }, tStamp: { value: null },
          uOrigin: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector3() },
          uFoot: { value: 0 }, uSeed: { value: 0 },
        },
        depthTest: false,
        depthWrite: false,
      });
      this.gridKey = gk;
    }
    const s = this.baked;
    const tex = new THREE.Data3DTexture(s.data, s.w, s.h, s.d);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.FloatType;
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    const u = this.mat.uniforms;
    u.tStamp.value = tex;
    u.uOrigin.value.copy(this.origin);
    u.uSize.value.set(s.w, s.h, s.d);
    u.uFoot.value = Math.min(s.foot, MAX_FOOT);
    u.uSeed.value = newSeed();
    sim.pass(this.mat);
    tex.dispose();

    this.reroll();
    this.hold = [...this.pointer];
    this.valid = false;
    this.group.visible = false;
    return true;
  }

  // New seed (and, when shuffling, maybe a new variant) for the next placement.
  reroll() { this.seed = newSeed(); }

  variantFor(build) {
    if (!build.variants) return undefined;
    const c = this.choice[build.key] ?? (build.shuffle ? 'shuffle' : build.variants[0][0]);
    if (c !== 'shuffle') return build.variants.some(([k]) => k === c) ? c : build.variants[0][0];
    return makeRng(this.seed ^ 0x9e3779b9).pick(build.variants)[0];
  }

  setVariant(build, key) {
    this.choice[build.key] = key;
    try { localStorage.setItem(STORE, JSON.stringify({ choice: this.choice })); } catch { /* ignore */ }
    this.reroll();
    this.barFor = null; // resync chips
  }

  _setGhost(s) {
    const n = s.ghost.length / 4;
    if (n > this.capacity) {
      for (const m of this.meshes) { this.group.remove(m); m.dispose(); }
      this.capacity = Math.max(n, Math.ceil(this.capacity * 1.5), 1024);
      const depth = new THREE.InstancedMesh(this.geo, this.depthMat, this.capacity);
      const color = new THREE.InstancedMesh(this.geo, this.colorMat, this.capacity);
      color.instanceMatrix = depth.instanceMatrix;
      depth.instanceColor = color.instanceColor =
        new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
      depth.renderOrder = 9;
      color.renderOrder = 10;
      for (const m of [depth, color]) {
        m.frustumCulled = false;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(m);
      }
      this.meshes = [depth, color];
    }
    const [depth, color] = this.meshes;
    const mat = depth.instanceMatrix.array, col = depth.instanceColor.array;
    const rgb = ELEMENTS.map((e) => hexRGB(e.color));
    for (let i = 0; i < n; i++) {
      const x = s.ghost[i * 4], y = s.ghost[i * 4 + 1], z = s.ghost[i * 4 + 2], id = s.ghost[i * 4 + 3];
      mat.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x + 0.5, y + 0.5, z + 0.5, 1], i * 16);
      const c = rgb[id], k = 0.92 + 0.16 * (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & 255) / 255;
      col[i * 3] = c[0] * k; col[i * 3 + 1] = c[1] * k; col[i * 3 + 2] = c[2] * k;
    }
    depth.count = color.count = n;
    depth.instanceMatrix.clearUpdateRanges();
    depth.instanceMatrix.addUpdateRange(0, n * 16);
    depth.instanceMatrix.needsUpdate = true;
    depth.instanceColor.clearUpdateRanges();
    depth.instanceColor.addUpdateRange(0, n * 3);
    depth.instanceColor.needsUpdate = true;
    this.outline.scale.set(s.w, s.h, s.d);
    this.outline.position.set(s.w / 2, s.h / 2, s.d / 2);
  }

  _createBar() {
    const el = h('div.build-bar.panel', { role: 'toolbar', 'aria-label': 'Construction options' });
    document.body.append(el);
    return el;
  }

  _syncBar(build) {
    const el = this.bar;
    el.classList.toggle('show', !!build);
    if (build) {
      // sit just above the dock (or its collapsed tab)
      const dock = document.querySelector('.dock:not(.collapsed)') ?? document.querySelector('.dock-tab');
      const top = dock ? dock.getBoundingClientRect().top : innerHeight - 14;
      el.style.bottom = `${Math.round(innerHeight - top + 8)}px`;
    }
    const sel = build ? `${build.key}|${this.choice[build.key] ?? ''}` : null;
    if (sel === this.barFor) return;
    this.barFor = sel;
    if (!build) return;
    const current = build.variants ? (this.choice[build.key] ?? (build.shuffle ? 'shuffle' : build.variants[0][0])) : null;
    const chip = (key, label, icon) => h(`button.chip${current === key ? '.on' : ''}`, {
      type: 'button', 'aria-pressed': String(current === key),
      html: `${icon ?? ''}<span>${label}</span>`,
      on: { click: () => this.setVariant(build, key) },
    });
    el.replaceChildren(...[
      build.variants && h('div.chips', {},
        chip('shuffle', 'Shuffle', ICON_SHUFFLE),
        build.variants.map(([k, label]) => chip(k, label))),
      h('button.chip.roll', {
        type: 'button', title: 'Roll a different one', html: `${ICON_DICE}<span>New seed</span>`,
        on: { click: () => this.reroll() },
      }),
    ].filter(Boolean));
  }

  dispose() {
    removeEventListener('pointermove', this._onMove);
    for (const m of this.meshes) m.dispose();
    this.group.removeFromParent();
    this.geo.dispose();
    this.depthMat.dispose();
    this.colorMat.dispose();
    this.outline.geometry.dispose();
    this.outline.material.dispose();
    this.mat?.dispose();
    this.bar.remove();
  }
}
