// CPU only: how many of mCell's 27 cells (src/shaders/gfx/surface.js) get hashed, per pixel and per
// 32-lane SIMD group, in the production visit order and in a per-pixel mirrored order (each axis's
// nearer neighbour first), against the floor of a per-pixel sorted search. JS doubles and a port of
// hash33 (gfx/noise.js): counts only, not an exactness proof. node research/shade-material/mcell-search-sim.mjs
const fr = (x) => x - Math.floor(x);
function hash33(p) {
  let q = [fr(p[0] * 0.1031), fr(p[1] * 0.1030), fr(p[2] * 0.0973)];
  const d = q[0] * (q[1] + 33.33) + q[1] * (q[0] + 33.33) + q[2] * (q[2] + 33.33);
  q = q.map((v) => v + d);
  return [fr((q[0] + q[1]) * q[2]), fr((q[0] + q[0]) * q[1]), fr((q[1] + q[0]) * q[0])];
}
const ORDER = [[0,0,0],[0,0,-1],[0,-1,0],[-1,0,0],[1,0,0],[0,1,0],[0,0,1],[0,-1,-1],[-1,0,-1],[1,0,-1],[0,1,-1],[-1,-1,0],[1,-1,0],[-1,1,0],[1,1,0],[0,-1,1],[-1,0,1],[1,0,1],[0,1,1],[-1,-1,-1],[1,-1,-1],[-1,1,-1],[1,1,-1],[-1,-1,1],[1,-1,1],[-1,1,1],[1,1,1]];
const CELLS = []; for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) CELLS.push([x, y, z]);
const rank = (o) => { let far = 0, near = 0; for (const v of o) { if (v < 0) far++; else if (v > 0) near++; } return far * 10 + near; };
const MIRRORED = CELLS.slice().sort((a, b) => rank(a) - rank(b));   // in a frame where +1 is the nearer neighbour
const gap2 = (o, f) => o.reduce((s, ok, a) => { const lo = ok - f[a]; const g = Math.max(lo, -(lo + 1), 0); return s + g * g; }, 0);
function search(p, mode) {
  const i = p.map(Math.floor), f = p.map((v, k) => v - i[k]);
  let list = ORDER;
  if (mode === 'mirrored') list = MIRRORED.map((t) => t.map((v, k) => (f[k] >= 0.5 ? v : -v)));
  if (mode === 'sorted') list = CELLS.slice().sort((a, b) => gap2(a, f) - gap2(b, f));
  let d1 = 1e9, d2 = 1e9; const hashed = [];
  list.forEach((o, k) => {
    if (gap2(o, f) >= d2) return;
    hashed.push(k);
    const h = hash33(i.map((c, a) => c + o[a]));
    const d = o.reduce((s, ok, a) => s + (ok + h[a] - f[a]) ** 2, 0);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  });
  return hashed;
}
let seed = 3; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const TILES = 2000;
for (const px of [1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32]) {   // lattice units a pixel covers
  const r = { orig: [0, 0], mirrored: [0, 0], sorted: [0, 0] };
  for (let t = 0; t < TILES; t++) {
    const o = [rnd() * 500, rnd() * 500, rnd() * 500];
    const u = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], v = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const nu = Math.hypot(...u), nv = Math.hypot(...v);
    for (const mode of Object.keys(r)) {
      const union = new Set();
      for (let x = 0; x < 8; x++) for (let y = 0; y < 4; y++) {   // one 8x4 SIMD group on a random plane
        const h = search(o.map((c, k) => c + (x * u[k] / nu + y * v[k] / nv) * px), mode);
        r[mode][0] += h.length; h.forEach((k) => union.add(k));
      }
      r[mode][1] += union.size;
    }
  }
  console.log(`pixel ${px} lattice: ` + Object.entries(r).map(([m, [l, un]]) => `${m} ${(l / TILES / 32).toFixed(2)}/px, SIMD union ${(un / TILES).toFixed(1)}`).join(' | '));
}
