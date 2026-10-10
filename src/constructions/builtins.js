// Built-in constructions, written against the construction runtime (runtime.js)
// exactly as a model or a coding agent would write one. Each generator gets the
// API as its first argument and the chosen variant as its second. These files
// double as worked examples in the AI system prompt and in docs/constructions.md.
//
// Conventions: y is up, the base sits on y = 0, the front (doors, tunnels) faces
// +z, sizes scale with T (1 at the default brush size), and all variety comes
// from rnd so the same seed always builds the same thing.

const TAU = Math.PI * 2;
// Built stonework (slabs, chimneys, brick, basins) is WALL: it renders as crisp
// voxels, whereas ROCK is drawn as smoothed natural terrain.
const MASONRY = 'WALL';
const odd = (x) => Math.round(x) | 1;

// ---------------------------------------------------------------- houses

export function house({ put, box, footing, rnd, T }, variant) {
  const W = odd(17 * T * rnd.range(0.92, 1.08));
  const D = odd(W * rnd.range(0.62, 0.74));
  const hw = (W - 1) / 2, hd = (D - 1) / 2;
  const H = Math.max(4, Math.round(W * 0.4)); // wall height above the slab
  const green = variant === 'greenhouse', cabin = variant === 'cabin';
  const wall = variant === 'brick' ? MASONRY : green ? 'GLASS' : 'WOOD';
  const roof = green ? 'GLASS' : 'WOOD';
  const dw = odd(1.6 * T); // door width
  footing();

  // stone slab, one cell wider than the walls (it grows a plinth on uneven ground)
  box(-hw - 1, 0, -hd - 1, hw + 1, 0, hd + 1, MASONRY);
  walls();
  if (cabin) logEnds();
  gableRoof();
  openings();
  if (green) { if (hd >= 3) beds(); } else chimney();

  // walls around an empty room; a greenhouse is glass on a steel frame over a low stone wall
  function walls() {
    const edge = (x, z) => Math.abs(x) === hw || Math.abs(z) === hd;
    const post = (x, z) => (Math.abs(x) === hw && Math.abs(z) === hd) ||
      (Math.abs(z) === hd && x % 4 === 0) || (Math.abs(x) === hw && z % 4 === 0);
    const frame = (x, y, z) => (y <= 2 ? MASONRY : y === H || post(x, z) ? 'METAL' : 'GLASS');
    for (let y = 1; y <= H; y++)
      for (let z = -hd; z <= hd; z++)
        for (let x = -hw; x <= hw; x++) put(x, y, z, !edge(x, z) ? 'AIR' : green ? frame(x, y, z) : wall);
  }

  // log ends cross at the corners, alternating course by course
  function logEnds() {
    for (let y = 1; y <= H; y++)
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          if (y % 2) put(sx * (hw + 1), y, sz * hd, 'WOOD');
          else put(sx * hw, y, sz * (hd + 1), 'WOOD');
        }
  }

  // gable roof with its ridge along x and one cell of overhang. The slope is two
  // cells thick so each step overlaps the next and nothing leaks diagonally.
  function gableRoof() {
    const gable = green ? 'GLASS' : wall;
    const slope = (x, zr) => (green && (x % 4 === 0 || zr <= 1) ? 'METAL' : roof);
    for (let i = 0; hd + 1 - i >= 0; i++) {
      const zr = hd + 1 - i, y = H + 1 + i;
      for (let z = -zr; z <= zr; z++)
        for (let x = -hw - 1; x <= hw + 1; x++) {
          if (Math.abs(z) >= zr - 1) put(x, y, z, slope(x, zr));
          else if (Math.abs(x) === hw) put(x, y, z, gable);
          else if (Math.abs(x) < hw) put(x, y, z, 'AIR');
        }
    }
  }

  // u runs along a wall; faces are front (+z, the door), back, left and right
  function cut(face, u0, u1, y0, y1, el) {
    for (let y = y0; y <= y1; y++)
      for (let u = u0; u <= u1; u++) {
        if (face === 'front') put(u, y, hd, el);
        else if (face === 'back') put(u, y, -hd, el);
        else put(face === 'left' ? -hw : hw, y, u, el);
      }
  }

  // the door, and glass windows on every side but the chimney's
  function openings() {
    const dh = Math.min(H - 1, Math.max(3, Math.round(H * 0.72)));
    cut('front', -(dw - 1) / 2, (dw - 1) / 2, 1, dh, 'AIR');
    if (green) return;
    const ww = Math.max(1, Math.round((cabin ? 1.4 : 2) * T));
    const wy0 = Math.max(2, Math.round(H * (cabin ? 0.42 : 0.32))), wy1 = Math.max(wy0 + 1, Math.round(H * 0.72));
    const win = (face, c) => cut(face, c - Math.floor(ww / 2), c - Math.floor(ww / 2) + ww - 1, wy0, wy1, 'GLASS');
    const off = Math.round(hw * 0.55);
    if (off - ww / 2 > (dw - 1) / 2 + 1) { win('front', -off); win('front', off); }
    win('back', -off); win('back', off);
    if (hd >= 3) win('left', 0);
  }

  // stone chimney on the right gable with an open fireplace and a log in the hearth
  function chimney() {
    const cz = -Math.round(hd * 0.35);
    const top = H + 1 + (hd + 1 - Math.max(0, Math.abs(cz) - 1)) + 2;
    for (let y = 1; y <= top; y++)
      for (let z = cz - 1; z <= cz + 1; z++)
        for (let x = hw - 1; x <= hw + 1; x++) {
          const flue = x === hw && z === cz;
          put(x, y, z, flue ? (y === 1 ? 'WOOD' : 'AIR') : MASONRY);
        }
    box(hw - 1, 1, cz, hw - 1, 2, cz, 'AIR'); // fireplace mouth
  }

  // greenhouse beds: water troughs along both long walls, seeded with plants
  function beds() {
    for (const s of [-1, 1])
      for (let x = -hw + 1; x <= hw - 1; x++) {
        if (s > 0 && Math.abs(x) <= (dw + 1) / 2) { put(x, 1, s * (hd - 1), MASONRY); continue; } // doorstep
        put(x, 1, s * (hd - 1), 'WATER');
        put(x, 1, s * (hd - 2), MASONRY);
        if ((x + hw) % 3 === 1) put(x, 2, s * (hd - 1), 'PLANT');
      }
  }
}

// ---------------------------------------------------------------- trees

export const TREES = {
  oak({ ball, disc, rod, vec, footing, rnd, T }) {
    const H = Math.round(rnd.range(21, 26) * T);
    const th = Math.round(H * rnd.range(0.36, 0.44));
    const tr = Math.max(0.5, 1.1 * T);
    footing(10);
    rod(vec(0, 0, 0), vec(0, th, 0), tr + 0.4, 'WOOD');
    disc(0, 0, 0, tr + 1.6, 'WOOD'); // root flare
    const crowns = [vec(0, th + H * 0.3, 0)];
    const n = rnd.int(3, 5), a0 = rnd() * TAU;
    for (let i = 0; i < n; i++) {
      const az = a0 + (i / n) * TAU + rnd.range(-0.3, 0.3), el = rnd.range(0.5, 1.0);
      const a = vec(0, th - rnd.int(0, 2), 0);
      const dir = vec(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      const b = a.clone().addScaledVector(dir, H * rnd.range(0.26, 0.36));
      rod(a, b, Math.max(0.5, tr * 0.6), 'WOOD');
      crowns.push(b);
    }
    for (const c of crowns)
      ball(c.x, c.y, c.z, H * rnd.range(0.2, 0.26), 'PLANT', { sy: 0.75, rough: 0.35, holes: 0.04, soft: true });
  },

  pine({ disc, rod, vec, footing, rnd, T }) {
    const H = Math.round(rnd.range(26, 32) * T);
    footing(10);
    rod(vec(0, 0, 0), vec(0, H - 2, 0), T > 1.5 ? 1 : 0.5, 'WOOD');
    const y0 = Math.round(H * rnd.range(0.14, 0.22));
    const R = H * rnd.range(0.22, 0.27);
    const tiers = Math.max(3, Math.round(rnd.range(4, 5.5) * Math.sqrt(T)));
    for (let y = y0; y <= H; y++) {
      const u = (y - y0) / (H - y0);
      const phase = (u * tiers) % 1; // each tier flares at its bottom
      const r = R * Math.pow(1 - u, 0.9) * (1 - 0.5 * phase) + 0.6;
      disc(0, y, 0, r, 'PLANT', { rough: 0.9, holes: 0.03, soft: true });
    }
  },

  birch({ ball, rod, vec, clamp, footing, rnd, T }) {
    const H = Math.round(rnd.range(28, 34) * T);
    const tr = T > 1.6 ? 1 : 0.5;
    footing(10);
    // a slender, slightly wandering trunk
    const pts = [vec(0, 0, 0)];
    for (let y = 5; y < H - 2; y += 5) {
      const p = pts[pts.length - 1];
      pts.push(vec(clamp(p.x + rnd.range(-0.8, 0.8), -2, 2), y,
        clamp(p.z + rnd.range(-0.8, 0.8), -2, 2)));
    }
    const tip = pts[pts.length - 1];
    pts.push(vec(tip.x, H - 2, tip.z));
    for (let i = 1; i < pts.length; i++) rod(pts[i - 1], pts[i], tr, 'WOOD');
    const trunkAt = (y) => pts[Math.min(pts.length - 1, Math.round(y / 5))];
    // small, airy leaf clusters on short twigs
    const k = rnd.int(7, 10);
    for (let i = 0; i < k; i++) {
      const y = H * rnd.range(0.4, 0.9), az = rnd() * TAU, d = rnd.range(1, Math.max(1.5, H * 0.1));
      const base = trunkAt(y);
      const c = vec(base.x + Math.cos(az) * d, y, base.z + Math.sin(az) * d);
      rod(vec(base.x, y - 1, base.z), c, 0.5, 'WOOD');
      ball(c.x, c.y, c.z, H * rnd.range(0.07, 0.1), 'PLANT', { sy: 1.5, rough: 0.4, holes: 0.18, soft: true });
    }
    const top = pts[pts.length - 1];
    ball(top.x, H - 1, top.z, H * 0.08, 'PLANT', { sy: 1.6, rough: 0.4, holes: 0.12, soft: true });
  },

  palm({ ball, rod, vec, footing, rnd, T }) {
    const H = Math.round(rnd.range(20, 25) * T);
    const az = rnd() * TAU, lean = H * rnd.range(0.18, 0.32);
    const tr = T > 1.2 ? 1 : 0.5;
    footing(10);
    const at = (y) => { const k = (y / H) ** 2 * lean; return vec(Math.cos(az) * k, y, Math.sin(az) * k); };
    for (let y = 0; y < H; y += 2) rod(at(y), at(Math.min(H, y + 2)), tr, 'WOOD');
    const top = at(H);
    // fronds rise a little, then droop; leaflets fan out sideways
    const n = rnd.int(7, 9), a0 = rnd() * TAU;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * TAU + rnd.range(-0.2, 0.2);
      const L = H * rnd.range(0.36, 0.46);
      const dir = vec(Math.cos(a), 0, Math.sin(a)), side = vec(-dir.z, 0, dir.x);
      let prev = top;
      for (let s = 1; s <= L; s++) {
        const p = top.clone().addScaledVector(dir, s);
        p.y += 0.7 * s - (1.25 * s * s) / L;
        rod(prev, p, 0.5, 'PLANT', { soft: true });
        const lw = Math.round(2.8 * T * (1 - s / L));
        if (lw > 0)
          for (const sg of [-1, 1])
            rod(p, p.clone().addScaledVector(side, sg * lw).add(vec(0, -0.6 * lw, 0)), 0.5, 'PLANT', { soft: true });
        prev = p;
      }
    }
    for (let i = rnd.int(2, 4); i > 0; i--) {
      const a = rnd() * TAU;
      ball(top.x + Math.cos(a) * 1.3, top.y - 1.5, top.z + Math.sin(a) * 1.3, 0.9, 'WOOD', { soft: true });
    }
  },

  willow({ ball, disc, rod, vec, footing, rnd, T }) {
    const H = Math.round(rnd.range(19, 23) * T);
    const tr = Math.max(0.5, 1.3 * T);
    const th = Math.round(H * 0.42);
    footing(10);
    rod(vec(0, 0, 0), vec(0, th, 0), tr + 0.4, 'WOOD');
    disc(0, 0, 0, tr + 1.4, 'WOOD');
    const R = H * rnd.range(0.48, 0.56); // a wide, low dome
    const cy = H - R * 0.45;
    const n = rnd.int(4, 6), a0 = rnd() * TAU;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * TAU;
      rod(vec(0, th - 1, 0), vec(Math.cos(a) * R * 0.55, cy + rnd.range(-1, 2), Math.sin(a) * R * 0.55),
        Math.max(0.5, tr * 0.55), 'WOOD');
    }
    ball(0, cy, 0, R, 'PLANT', { sy: 0.45, rough: 0.3, holes: 0.08, soft: true });
    // curtains of strands hanging from the underside, longest at the rim
    const strands = Math.round(R * R * 0.9);
    for (let i = 0; i < strands; i++) {
      const a = rnd() * TAU, d = R * Math.sqrt(rnd.range(0.2, 1)) * 0.98;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const y0 = cy - R * 0.45 * Math.sqrt(Math.max(0, 1 - (d / R) ** 2));
      const len = Math.max(0, rnd.range(0.35, 0.85) * (y0 - 2) * (0.4 + 0.6 * d / R));
      rod(vec(x, y0, z), vec(x + rnd.range(-0.6, 0.6), Math.max(2, y0 - len), z + rnd.range(-0.6, 0.6)), 0.5,
        'PLANT', { soft: true });
    }
  },

  dead({ disc, rod, vec, bend, footing, rnd, T }) {
    const H = Math.round(rnd.range(17, 22) * T);
    footing(10);
    const grow = (a, dir, len, r, depth) => {
      const b = a.clone().addScaledVector(dir, len);
      rod(a, b, r, 'WOOD');
      if (depth === 0) return;
      for (let i = rnd.int(2, 3); i > 0; i--) {
        const d = bend(dir, rnd.range(0.35, 0.8)).add(vec(0, 0.25, 0)).normalize();
        grow(b, d, len * rnd.range(0.55, 0.75), Math.max(0.5, r * 0.62), depth - 1);
      }
    };
    disc(0, 0, 0, 1.2 * T + 1.2, 'WOOD');
    grow(vec(0, 0, 0), vec(rnd.range(-0.1, 0.1), 1, rnd.range(-0.1, 0.1)).normalize(), H * 0.42, Math.max(0.5, T), 3);
  },
};

// ---------------------------------------------------------------- the rest

export function campfire({ put, ball, rod, vec, rnd, T }, variant) {
  const lit = variant === 'lit';
  const R = Math.max(3, Math.round(4 * T));
  for (let z = -R - 1; z <= R + 1; z++)
    for (let x = -R - 1; x <= R + 1; x++) {
      const d = Math.hypot(x, z);
      if (Math.abs(d - R) < 0.6) put(x, 0, z, 'STONE');
      else if (lit && d < R - 0.4) put(x, 0, z, 'ASH');
    }
  // logs leaning together; a lit fire starts above wood's 300 °C ignition point
  const n = rnd.int(4, 5), a0 = rnd() * TAU, top = Math.round(R * 1.4);
  const o = { temp: lit ? 450 : undefined };
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU;
    const foot = vec(Math.cos(a) * (R - 1), 0, Math.sin(a) * (R - 1));
    rod(foot, foot.clone().lerp(vec(0, top, 0), 0.85), T > 1.6 ? 1 : 0.5, 'WOOD', o);
  }
  if (lit) ball(0, 1, 0, Math.max(1, R * 0.35), 'FIRE', { soft: true });
}

// Ice is the only static frozen solid, and it renders clear like glass, so the
// dome is a thick ice shell with snow lying on the gentle upper part (snow on
// the steep sides would just slide off: it's a powder).
export function igloo({ put, get, footing, rnd, T }) {
  const R = Math.max(5, Math.round(7.5 * T)), th = Math.max(2, Math.round(2.2 * T));
  const ri = R - th, drift = Math.max(2, Math.round(3 * T));
  footing(8);
  dome();
  tunnel();

  // an ice shell over an empty room, with snow on top and drifted against the base
  function dome() {
    const span = R + drift + 1;
    for (let y = 0; y <= R + 2; y++)
      for (let z = -span; z <= span; z++)
        for (let x = -span; x <= span; x++) {
          const d = Math.hypot(x, y, z);
          if (d <= R + 0.3) put(x, y, z, d > ri ? 'ICE' : 'AIR');
          else if (settles(x, y, z, d)) put(x, y, z, 'SNOW');
        }
  }

  // snow is a powder: it lies only where something holds it up
  function settles(x, y, z, d) {
    const below = y === 0 ? 'GROUND' : get(x, y - 1, z);
    if (below !== 'GROUND' && below !== 'ICE' && below !== 'SNOW') return false;
    if (d <= R + 1.3 && y > 0.78 * d && rnd() > 0.12) return true; // the gentle upper part of the dome
    // a drift banked against the wall, no steeper than snow's angle of repose
    return y < drift - (Math.hypot(x, z) - R) && rnd() > 0.08;
  }

  // entrance tunnel toward the front
  function tunnel() {
    const tr = Math.max(3, Math.round(R * 0.45));
    for (let z = 0; z <= R + Math.round(R * 0.45); z++)
      for (let y = 0; y <= tr + 1; y++)
        for (let x = -tr - 1; x <= tr + 1; x++) {
          const e = Math.hypot(x, y);
          if (e > tr + 0.3) continue;
          if (e <= tr - 1.5) put(x, y, z, 'AIR');
          else if (Math.hypot(x, y, z) >= ri - 0.5) put(x, y, z, 'ICE');
        }
  }
}

export function barrel({ put, T }, variant) {
  const keg = variant === 'keg';
  const R0 = Math.max(2, Math.round(3.6 * T)), H = Math.round(R0 * (keg ? 2.4 : 2.8));
  const shell = keg ? 'WOOD' : 'METAL', fill = keg ? 'GUNPOWDER' : 'OIL';
  // steel hoops on the keg, rolling rims on the drum (flush with the shell)
  const hoops = keg ? [1, Math.round(H * 0.3), Math.round(H * 0.7), H - 2] : [Math.round(H / 3), Math.round((2 * H) / 3)];
  const B = Math.ceil(R0 * 1.15) + 1;
  for (let y = 0; y < H; y++) {
    const R = keg ? R0 * (1 + 0.14 * Math.sin((Math.PI * (y + 0.5)) / H)) : R0; // kegs bulge
    const band = hoops.includes(y) ? 'METAL' : shell;
    for (let z = -B; z <= B; z++)
      for (let x = -B; x <= B; x++) {
        const d = Math.hypot(x, z);
        if (d > R + 0.35) continue;
        // a shell band 1.5 cells wide is face-connected, so nothing seeps out diagonally
        if (y === 0 || y === H - 1) put(x, y, z, shell);
        else put(x, y, z, d > R - 1.15 ? band : fill);
      }
  }
}

export function aquarium({ put, ball, footing, rnd, T }) {
  const W = odd(17 * T), D = odd(W * 0.6), H = Math.max(5, Math.round(W * 0.62));
  const hw = (W - 1) / 2, hd = (D - 1) / 2;
  const p1 = rnd() * TAU, p2 = rnd() * TAU;
  footing(12);
  for (let y = 0; y < H; y++)
    for (let z = -hd; z <= hd; z++)
      for (let x = -hw; x <= hw; x++) {
        const sand = 1 + Math.round(0.8 + 0.7 * Math.sin(x * 0.45 + p1) + 0.5 * Math.sin(z * 0.6 + p2));
        if (y === 0 || Math.abs(x) === hw || Math.abs(z) === hd) put(x, y, z, 'GLASS');
        else if (y <= sand) put(x, y, z, 'SAND');
        else if (y <= H - 2) put(x, y, z, 'WATER');
      }
  for (let i = rnd.int(2, 4); i > 0; i--)
    ball(rnd.range(-hw + 2, hw - 2), 2.5, rnd.range(-hd + 2, hd - 2), rnd.range(0.8, 1.6), 'STONE');
}

export function fountain({ put, box, disc, rod, vec, footing, T }) {
  const R = Math.max(3, Math.round(6.5 * T));
  footing(12);
  for (let z = -R - 1; z <= R + 1; z++)
    for (let x = -R - 1; x <= R + 1; x++) {
      const d = Math.hypot(x, z);
      if (d > R + 0.3) continue;
      put(x, 0, z, MASONRY);
      if (d > R - 1.2) box(x, 1, z, x, 2, z, MASONRY);
      else put(x, 1, z, 'WATER');
    }
  const ph = Math.max(3, Math.round(R * 1.2)), br = Math.max(2, Math.round(R * 0.38));
  rod(vec(0, 1, 0), vec(0, ph, 0), Math.max(1, T), MASONRY);
  disc(0, ph + 1, 0, br + 0.3, MASONRY);
  for (let z = -br - 1; z <= br + 1; z++)
    for (let x = -br - 1; x <= br + 1; x++) {
      const d = Math.hypot(x, z);
      if (d > br - 1.2 && d <= br + 0.3) put(x, ph + 2, z, MASONRY);
    }
  put(0, ph + 2, 0, 'CLONE', { ctype: 'WATER' }); // the spout
}

// ---------------------------------------------------------------- shrine

// A shrine: Noita's Holy Mountain altar, a stone pavilion over three plinths.
// Its size is fixed, not scaled by T: it is built for the first-person body
// (5.5 cells tall), which never changes size. The app floats a perk orb over
// each plinth (src/perkOrbs.js) at SHRINE_ALTARS: take one and the others vanish.
export const SHRINE_ALTARS = [[-4, 2, 0], [0, 2, 0], [4, 2, 0]];   // each orb's foot: the top of its plinth
export function shrine({ box, footing }) {
  const HW = 8, HD = 5;      // half the floor's width (x) and depth (z)
  const H = 8;               // pillar height above the floor: headroom for the body and a hop
  const P = 2;               // pillars are P × P
  footing();
  box(-HW, 0, -HD, HW, 0, HD, MASONRY);          // the floor (it grows a plinth on uneven ground)
  box(-HW, 1, -HD, HW, H, HD, 'AIR');            // nothing grows or stands inside
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) box(sx * (HW - 1), 1, sz * (HD - 1), sx * (HW - P), H, sz * (HD - P), MASONRY);
  // a stepped roof, with a steel ridge
  box(-HW, H + 1, -HD, HW, H + 1, HD, MASONRY);
  box(-HW + 2, H + 2, -HD + 2, HW - 2, H + 2, HD - 2, MASONRY);
  box(-HW + 4, H + 3, 0, HW - 4, H + 3, 0, 'METAL');
  // the plinths: stone with a steel top where the orb floats
  for (const [x, y, z] of SHRINE_ALTARS) {
    box(x - 1, 1, z - 1, x + 1, y - 1, z + 1, MASONRY);
    box(x, y - 1, z, x, y - 1, z, 'METAL');
  }
}

export const BUILTINS = {
  HOUSE: house,
  TREE: (api, variant) => TREES[variant](api),
  CAMPFIRE: campfire,
  IGLOO: igloo,
  BARREL: barrel,
  AQUARIUM: aquarium,
  FOUNTAIN: fountain,
  SHRINE: shrine,
};
