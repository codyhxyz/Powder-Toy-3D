// 2D CPU twin experiments on liquid behaviour (src/ui/tiles/engine.js).
import { World } from '../../src/ui/tiles/engine.js';
import { E, K, ELEMENTS } from '../../src/elements.js';
import { SIM_GRAVITY } from '../../src/physics.js';

// deterministic Math.random
let s = 12345;
Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const mk = (nx, ny) => { const w = new World(nx, ny); w.gravity = SIM_GRAVITY; return w; };
const at = (w, x, y) => w.id[w.idx(x, y)];
const count = (w, id) => { let n = 0; for (let i = 0; i < w.id.length; i++) if (w.id[i] === id) n++; return n; };
const moving = (w, id) => { let n = 0; for (let i = 0; i < w.id.length; i++) if (w.id[i] === id && (w.vx[i] !== 0 || w.vy[i] !== 0)) n++; return n; };
const show = (w, y0 = 0, y1 = w.ny, map = { [E.EMPTY]: '.', [E.WATER]: '~', [E.WALL]: '#', [E.OIL]: 'o', [E.SAND]: 's' }) => {
  const rows = [];
  for (let y = y1 - 1; y >= y0; y--) { let r = ''; for (let x = 0; x < w.nx; x++) r += map[at(w, x, y)] ?? '?'; rows.push(r); }
  return rows.join('\n');
};
const out = {};

// E1: U-tube. Walls make a U: two arms 4 wide, joined at the bottom by a 4-tall channel.
{
  const w = mk(40, 40);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
    const inLeft = x >= 8 && x < 12 && y >= 2, inRight = x >= 28 && x < 32 && y >= 2, inBase = x >= 8 && x < 32 && y >= 2 && y < 6;
    if (!(inLeft || inRight || inBase)) w.put(x, y, E.WALL);
  }
  // fill: base channel full, left arm up to y=30
  for (let y = 2; y < 30; y++) for (let x = 8; x < 12; x++) w.put(x, y, E.WATER);
  for (let y = 2; y < 6; y++) for (let x = 12; x < 32; x++) w.put(x, y, E.WATER);
  const lv = (x0) => { let top = -1; for (let y = 0; y < 40; y++) for (let x = x0; x < x0 + 4; x++) if (at(w, x, y) === E.WATER) top = Math.max(top, y); return top; };
  const hist = [];
  for (let i = 1; i <= 6000; i++) { w.step(); if (i % 1000 === 0) hist.push({ step: i, left: lv(8), right: lv(28), moving: moving(w, E.WATER) }); }
  out.utube = { n: count(w, E.WATER), hist, pic: show(w, 0, 34) };
}

// E2: puddle on a flat wide floor: a 6x6 block dropped from 4 cells up
{
  const w = mk(64, 24);
  for (let x = 0; x < 64; x++) w.put(x, 0, E.WALL);
  for (let y = 5; y < 11; y++) for (let x = 29; x < 35; x++) w.put(x, y, E.WATER);
  const ext = () => { let lo = 99, hi = -1, maxy = 0; for (let y = 1; y < 24; y++) for (let x = 0; x < 64; x++) if (at(w, x, y) === E.WATER) { lo = Math.min(lo, x); hi = Math.max(hi, x); maxy = Math.max(maxy, y); } return { lo, hi, maxy }; };
  const hist = [];
  let restSince = -1;
  for (let i = 1; i <= 8000; i++) {
    w.step();
    const m = moving(w, E.WATER);
    if (m === 0 && restSince < 0) restSince = i; if (m) restSince = -1;
    if ([50, 100, 200, 400, 1000, 2000, 4000, 8000].includes(i)) hist.push({ step: i, ...ext(), moving: m, n: count(w, E.WATER) });
  }
  out.puddle = { hist, restSince, pic: show(w, 0, 4) };
}

// E3: levelling in a closed basin 40 wide: a 10x14 column released at the left
{
  const w = mk(42, 30);
  for (let y = 0; y < 30; y++) { w.put(0, y, E.WALL); w.put(41, y, E.WALL); }
  for (let x = 0; x < 42; x++) w.put(x, 0, E.WALL);
  for (let y = 1; y < 15; y++) for (let x = 1; x < 11; x++) w.put(x, y, E.WATER);
  const tops = () => { const t = []; for (let x = 1; x < 41; x++) { let top = 0; for (let y = 1; y < 30; y++) if (at(w, x, y) === E.WATER) top = y; t.push(top); } return t; };
  const hist = []; let restAt = -1;
  for (let i = 1; i <= 6000; i++) {
    w.step();
    const m = moving(w, E.WATER);
    if (m === 0 && restAt < 0) restAt = i; if (m) restAt = -1;
    if ([25, 50, 100, 200, 400, 800, 1600, 3200, 6000].includes(i)) { const t = tops(); hist.push({ step: i, min: Math.min(...t), max: Math.max(...t), moving: m }); }
  }
  out.level = { hist, restAt, pic: show(w, 0, 8) };
}

// E4: tank with a side hole: stream structure. Tank x 2..12, hole at x=12, y=20
{
  const w = mk(64, 48);
  for (let x = 0; x < 64; x++) w.put(x, 0, E.WALL);
  for (let y = 18; y < 46; y++) { w.put(1, y, E.WALL); w.put(12, y, E.WALL); }
  for (let x = 1; x <= 12; x++) w.put(x, 18, E.WALL);
  for (let y = 19; y < 45; y++) for (let x = 2; x < 12; x++) w.put(x, y, E.WATER);
  w.erase(w.idx(12, 19)); // hole at the bottom of the right wall
  const frames = [];
  for (let i = 1; i <= 400; i++) {
    w.step();
    if (i === 120 || i === 200 || i === 300) frames.push(`step ${i}\n` + show(w, 1, 30, { [E.EMPTY]: '.', [E.WATER]: '~', [E.WALL]: '#' }));
  }
  // stream continuity: along the falling stream (cells outside the tank above y=1), fraction of air gaps
  out.jet = { frames };
}

// E5: oil under water in a narrow box: time to invert
{
  const w = mk(12, 24);
  for (let y = 0; y < 24; y++) { w.put(0, y, E.WALL); w.put(11, y, E.WALL); }
  for (let x = 0; x < 12; x++) w.put(x, 0, E.WALL);
  for (let y = 1; y < 6; y++) for (let x = 1; x < 11; x++) w.put(x, y, E.OIL);
  for (let y = 6; y < 11; y++) for (let x = 1; x < 11; x++) w.put(x, y, E.WATER);
  const done = () => { for (let y = 1; y < 6; y++) for (let x = 1; x < 11; x++) if (at(w, x, y) !== E.WATER) return false; return true; };
  let t = -1; for (let i = 1; i <= 6000 && t < 0; i++) { w.step(); if (done()) t = i; }
  out.layer = { stepsToInvert: t, pic: show(w, 0, 12) };
}

// E6: viscous heaps: a 6x8 block of each on a wide floor; after N steps, height and width
for (const key of ['WATER', 'OIL', 'MUD', 'LAVA', 'SLIME', 'TOXIC']) {
  const w = mk(64, 20);
  for (let x = 0; x < 64; x++) w.put(x, 0, E.WALL);
  for (let y = 1; y < 9; y++) for (let x = 29; x < 35; x++) w.put(x, y, E[key], { T: 20 });
  const ext = () => { let lo = 99, hi = -1, maxy = 0; for (let y = 1; y < 20; y++) for (let x = 0; x < 64; x++) if (at(w, x, y) === E[key]) { lo = Math.min(lo, x); hi = Math.max(hi, x); maxy = Math.max(maxy, y); } return { lo, hi, maxy }; };
  const hist = [];
  for (let i = 1; i <= 3000; i++) { w.step(); if ([100, 300, 1000, 3000].includes(i)) hist.push({ step: i, ...ext(), moving: moving(w, E[key]), n: count(w, E[key]) }); }
  (out.visc ??= {})[key] = hist;
}

// E7: a lone droplet on a wide floor: how far does it wander, does it rest
{
  const w = mk(64, 8);
  for (let x = 0; x < 64; x++) w.put(x, 0, E.WALL);
  w.put(32, 1, E.WATER);
  const xs = [];
  for (let i = 1; i <= 4000; i++) { w.step(); if (i % 500 === 0) { let px = -1; for (let x = 0; x < 64; x++) if (at(w, x, 1) === E.WATER) px = x; xs.push(px); } }
  out.droplet = { xs, moving: moving(w, E.WATER) };
}

// E8: falling column splash: a 2x12 column dropped from y=30 onto a floor
{
  const w = mk(80, 48);
  for (let x = 0; x < 80; x++) w.put(x, 0, E.WALL);
  for (let y = 30; y < 42; y++) for (let x = 39; x < 41; x++) w.put(x, y, E.WATER);
  const hist = [];
  for (let i = 1; i <= 600; i++) { w.step(); if ([40, 60, 80, 120, 200, 600].includes(i)) { let lo = 99, hi = -1, air = 0; for (let y = 1; y < 48; y++) for (let x = 0; x < 80; x++) if (at(w, x, y) === E.WATER) { lo = Math.min(lo, x); hi = Math.max(hi, x); if (y > 2) air++; } hist.push({ step: i, lo, hi, airborne: air }); } }
  out.splash = hist;
}

// E9: falling stream structure: a source row at the top feeding water every step (bucket-like), count water vs air in the stream column
{
  const w = mk(16, 64);
  for (let x = 0; x < 16; x++) w.put(x, 0, E.WALL);
  const gaps = [];
  for (let i = 1; i <= 300; i++) {
    for (let x = 7; x < 9; x++) if (at(w, x, 62) === E.EMPTY) { w.put(x, 62, E.WATER); w.vy[w.idx(x, 62)] = -0.3; }
    w.step();
    if (i === 150 || i === 300) {
      let wat = 0, tot = 0; for (let y = 20; y < 60; y++) for (let x = 6; x < 10; x++) { tot++; if (at(w, x, y) === E.WATER) wat++; }
      gaps.push({ step: i, fillOfStreamBox: +(wat / (40 * 2)).toFixed(2), pic: show(w, 40, 63) });
    }
  }
  out.stream = gaps;
}

console.log(JSON.stringify(out, null, 1));
