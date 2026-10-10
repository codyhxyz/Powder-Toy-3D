// Built-in constructions, written against the construction runtime (runtime.js)
// exactly as a model or a coding agent would write one. Each generator gets the
// API as its first argument and the chosen variant as its second. These files
// double as worked examples in the AI system prompt and in docs/constructions.md.
//
// Conventions: y is up, the base sits on y = 0, the front (doors, tunnels) faces
// +z, sizes scale with T (1 at the default brush size), and all variety comes
// from rnd so the same seed always builds the same thing.

import { HUMAN, MASONRY, TAU, odd } from './shared.js';
import { STRUCTURES } from './structures.js';

// ---------------------------------------------------------------- houses

// A house's sizes in cells at T = 1, on top of the human scale (shared.js).
const HOUSE = {
  W: 17, W_JITTER: 0.08,          // width along the ridge (5.1 m), give or take this share
  DEPTH: [0.68, 0.8],             // depth, share of the width
  WINDOW_W: 3, CABIN_WINDOW_W: 2, // window widths (a log cabin's are smaller)
  WINDOW_OFF: 0.55,               // windows sit this share of the half-width from the middle
  FIRE_H: 3,                      // the fireplace's mouth: 0.9 m tall, as wide as the chimney's inside
  CHIMNEY_Z: 0.35,                // the chimney sits this share of the half-depth toward the back
  CHIMNEY_TOP: 2,                 // ...and rises this far above the roof
  BED: [7, 3], BED_HEAD: 2,       // a bed: 2.1 × 0.9 m, its headboard 0.6 m above the frame
  TABLE: [4, 3], TABLE_H: 3,      // a table: 1.2 × 0.9 m, its top 0.9 m up
  PLANT_EVERY: 3,                 // greenhouse beds: a plant over every third trough cell
};

export function house({ put, box, footing, rnd, T }, variant) {
  const W = odd(HOUSE.W * T * rnd.range(1 - HOUSE.W_JITTER, 1 + HOUSE.W_JITTER));
  const D = odd(W * rnd.range(...HOUSE.DEPTH));
  const hw = (W - 1) / 2, hd = (D - 1) / 2;
  const H = Math.max(4, Math.round(HUMAN.ROOM_H * T)); // wall height above the slab
  const green = variant === 'greenhouse', cabin = variant === 'cabin';
  const wall = variant === 'brick' ? MASONRY : green ? 'GLASS' : 'WOOD';
  const roof = green ? 'GLASS' : 'WOOD';
  const dw = odd(HUMAN.DOOR_W * T), dh = Math.min(H - 1, Math.max(3, Math.round(HUMAN.DOOR_H * T)));
  const cz = -Math.round(hd * HOUSE.CHIMNEY_Z);
  footing();

  // stone slab, one cell wider than the walls (it grows a plinth on uneven ground)
  box(-hw - 1, 0, -hd - 1, hw + 1, 0, hd + 1, MASONRY);
  walls();
  if (cabin) logEnds();
  gableRoof();
  openings();
  if (green) { if (hd >= 3) beds(); } else { chimney(); furnish(); }

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

  // the door, and glass windows at eye height on every side but the chimney's
  function openings() {
    cut('front', -(dw - 1) / 2, (dw - 1) / 2, 1, dh, 'AIR');
    if (green) return;
    const ww = Math.max(1, Math.round((cabin ? HOUSE.CABIN_WINDOW_W : HOUSE.WINDOW_W) * T));
    const wy0 = 1 + Math.round(HUMAN.SILL_H * T), wy1 = Math.min(H - 1, wy0 + Math.round(HUMAN.WINDOW_H * T) - 1);
    const win = (face, c) => cut(face, c - Math.floor(ww / 2), c - Math.floor(ww / 2) + ww - 1, wy0, wy1, 'GLASS');
    const off = Math.round(hw * HOUSE.WINDOW_OFF);
    if (off - ww / 2 > (dw - 1) / 2 + 1) { win('front', -off); win('front', off); }
    win('back', -off); win('back', off);
    if (hd >= 3) win('left', 0);
  }

  // stone chimney on the right gable: an open fireplace, a log in the hearth
  // and a one-cell flue in the wall's plane
  function chimney() {
    const top = H + 1 + (hd + 1 - Math.max(0, Math.abs(cz) - 1)) + HOUSE.CHIMNEY_TOP;
    for (let y = 1; y <= top; y++)
      for (let z = cz - 1; z <= cz + 1; z++)
        for (let x = hw - 1; x <= hw + 1; x++) {
          const flue = x === hw && z === cz;
          put(x, y, z, flue ? (y === 1 ? 'WOOD' : 'AIR') : MASONRY);
        }
    box(hw - 1, 1, cz - 1, hw - 1, Math.round(HOUSE.FIRE_H * T), cz + 1, 'AIR'); // fireplace mouth
  }

  // a bed in the back-left corner under its window, a table by the front-left
  // one, and the right side left clear from the door to the hearth
  function furnish() {
    const [bl, bw] = HOUSE.BED.map((n) => Math.round(n * T)), [tl, tw] = HOUSE.TABLE.map((n) => Math.round(n * T));
    const x0 = -hw + 1, bz = -hd + 1, th = 1 + Math.round(HOUSE.TABLE_H * T) - 1;
    if (bl > hw || bw + tw + 2 > 2 * hd - 1) return; // too small a room to furnish
    box(x0, 1, bz, x0 + bl - 1, 1, bz + bw - 1, 'WOOD');                // frame
    box(x0, 2, bz, x0, 1 + Math.round(HOUSE.BED_HEAD * T), bz + bw - 1, 'WOOD'); // headboard
    box(x0 + 1, 2, bz, x0 + bl - 1, 2, bz + bw - 1, 'PLANT');           // a straw tick under a green quilt
    const tz = hd - 1 - tw;                                             // a step clear of the front wall
    box(x0 + 1, th, tz, x0 + tl, th, tz + tw - 1, 'WOOD');
    for (const [lx, lz] of [[x0 + 1, tz], [x0 + tl, tz], [x0 + 1, tz + tw - 1], [x0 + tl, tz + tw - 1]])
      box(lx, 1, lz, lx, th - 1, lz, 'WOOD');
  }

  // greenhouse beds: water troughs along both long walls, seeded with plants
  function beds() {
    for (const s of [-1, 1])
      for (let x = -hw + 1; x <= hw - 1; x++) {
        if (s > 0 && Math.abs(x) <= (dw + 1) / 2) { put(x, 1, s * (hd - 1), MASONRY); continue; } // doorstep
        put(x, 1, s * (hd - 1), 'WATER');
        put(x, 1, s * (hd - 2), MASONRY);
        if ((x + hw) % HOUSE.PLANT_EVERY === 1) put(x, 2, s * (hd - 1), 'PLANT');
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

// A camp fire ring 1.8 m across, as wide as one you'd sit around, and a
// teepee of logs knee to waist high.
const CAMPFIRE = {
  R: 3,              // the stone ring's radius, cells at T = 1
  LOGS: [4, 5],      // logs in the teepee
  TOP: 1.3,          // the teepee's apex, share of the ring's radius...
  LEAN: 0.85,        // ...which each log reaches this share of the way to
  FIRE_R: 0.35,      // a lit fire's ball, share of the ring's radius
  IGNITE_T: 450,     // a lit fire's logs start above wood's 300 °C ignition point
};

export function campfire({ put, ball, rod, vec, rnd, T }, variant) {
  const lit = variant === 'lit';
  const R = Math.max(2, Math.round(CAMPFIRE.R * T));
  for (let z = -R - 1; z <= R + 1; z++)
    for (let x = -R - 1; x <= R + 1; x++) {
      const d = Math.hypot(x, z);
      if (Math.abs(d - R) < 0.6) put(x, 0, z, 'STONE');
      else if (lit && d < R - 0.4) put(x, 0, z, 'ASH');
    }
  // logs leaning together; a lit fire starts above its ignition point
  const n = rnd.int(...CAMPFIRE.LOGS), a0 = rnd() * TAU, top = Math.round(R * CAMPFIRE.TOP);
  const o = { temp: lit ? CAMPFIRE.IGNITE_T : undefined };
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU;
    const foot = vec(Math.cos(a) * (R - 1), 0, Math.sin(a) * (R - 1));
    rod(foot, foot.clone().lerp(vec(0, top, 0), CAMPFIRE.LEAN), T > 1.6 ? 1 : 0.5, 'WOOD', o);
  }
  if (lit) ball(0, 1, 0, Math.max(1, R * CAMPFIRE.FIRE_R), 'FIRE', { soft: true });
}

// Ice is the only static frozen solid, and it renders clear like glass, so the
// dome is a thick ice shell with snow lying on the gentle upper part (snow on
// the steep sides would just slide off: it's a powder). The dome is a big
// igloo, 2.4 m high inside, and the entrance an arch you walk through: the
// first-person body can't crouch through a real igloo's crawl tunnel.
const IGLOO = {
  R: 10,             // outer radius, cells at T = 1 (3 m)
  SHELL: 2,          // ice thickness
  DRIFT: 3,          // snow banked against the wall, cells high
  CAP: 0.78,         // snow lies where y > CAP · d (the gentle upper part of the dome)...
  CAP_REACH: 1.3,    // ...out to this many cells past the ice
  CAP_GAPS: 0.12,    // share of cells left bare on the cap, and in the drift
  DRIFT_GAPS: 0.08,
  ARCH_W: 2,         // the entrance arch's inside: half-width and height above the floor
  ARCH_LEN: 0.45,    // ...and how far it reaches past the dome, share of R
};

export function igloo({ put, get, footing, rnd, T }) {
  const R = Math.max(5, Math.round(IGLOO.R * T)), th = Math.max(2, Math.round(IGLOO.SHELL * T));
  const ri = R - th, drift = Math.max(2, Math.round(IGLOO.DRIFT * T));
  const aw = Math.max(1, Math.round(IGLOO.ARCH_W * T)), ah = Math.max(3, Math.round(HUMAN.DOOR_H * T));
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
    if (d <= R + IGLOO.CAP_REACH && y > IGLOO.CAP * d && rnd() > IGLOO.CAP_GAPS) return true;
    // a drift banked against the wall, no steeper than snow's angle of repose
    return y < drift - (Math.hypot(x, z) - R) && rnd() > IGLOO.DRIFT_GAPS;
  }

  // the entrance toward the front: an elliptical arch of ice, walked through upright
  function tunnel() {
    const ow = aw + th, oh = ah + th;
    for (let z = 0; z <= R + Math.round(R * IGLOO.ARCH_LEN); z++)
      for (let y = 0; y <= oh; y++)
        for (let x = -ow; x <= ow; x++) {
          const inner = (x / (aw + 0.5)) ** 2 + (y / (ah + 0.5)) ** 2, outer = (x / (ow + 0.5)) ** 2 + (y / (oh + 0.5)) ** 2;
          if (outer > 1) continue;
          if (inner <= 1) put(x, y, z, 'AIR');
          else if (Math.hypot(x, y, z) >= ri - 0.5) put(x, y, z, 'ICE');
        }
  }
}

// An oil drum or a powder keg as small as a sealed one can be at 0.3 m cells:
// 1.5 m across (a liquid-tight round shell is 1.5 cells thick, so anything
// narrower is all shell) and about as tall as the body. Real drums are 2 × 3
// cells, too small to hold anything here.
const BARREL = {
  R: 2.5,            // radius, cells at T = 1 (no rounding: 2.5 gives a 5-cell drum with a 5-cell core)
  R_MIN: 2,
  KEG_H: 2.4,        // height, shares of the radius
  DRUM_H: 2.8,
  BULGE: 0.14,       // a keg's bulge at mid-height, share of its radius
  SHELL: 1.15,       // shell band inside the radius: with the 0.35 outside it, 1.5 cells, face-connected
  KEG_HOOPS: [0.3, 0.7], // steel hoops on a keg (besides one by each end), shares of its height
  DRUM_RIMS: [1 / 3, 2 / 3], // rolling rims on a drum
};

export function barrel({ put, T }, variant) {
  const keg = variant === 'keg';
  const R0 = Math.max(BARREL.R_MIN, BARREL.R * T), H = Math.round(R0 * (keg ? BARREL.KEG_H : BARREL.DRUM_H));
  const shell = keg ? 'WOOD' : 'METAL', fill = keg ? 'GUNPOWDER' : 'OIL';
  // steel hoops on the keg, rolling rims on the drum (flush with the shell)
  const hoops = keg ? [1, ...BARREL.KEG_HOOPS.map((f) => Math.round(H * f)), H - 2] : BARREL.DRUM_RIMS.map((f) => Math.round(H * f));
  const B = Math.ceil(R0 * (1 + BARREL.BULGE)) + 1;
  for (let y = 0; y < H; y++) {
    const R = keg ? R0 * (1 + BARREL.BULGE * Math.sin((Math.PI * (y + 0.5)) / H)) : R0; // kegs bulge
    const band = hoops.includes(y) ? 'METAL' : shell;
    for (let z = -B; z <= B; z++)
      for (let x = -B; x <= B; x++) {
        const d = Math.hypot(x, z);
        if (d > R + 0.35) continue;
        // a shell band 1.5 cells wide is face-connected, so nothing seeps out diagonally
        if (y === 0 || y === H - 1) put(x, y, z, shell);
        else put(x, y, z, d > R - BARREL.SHELL ? band : fill);
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

export const BUILTINS = {
  HOUSE: house,
  TREE: (api, variant) => TREES[variant](api),
  CAMPFIRE: campfire,
  IGLOO: igloo,
  BARREL: barrel,
  AQUARIUM: aquarium,
  FOUNTAIN: fountain,
  ...STRUCTURES,   // the World's structures (structures.js)
};
