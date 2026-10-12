import { World } from '../../src/ui/tiles/engine.js';
import { E } from '../../src/elements.js';
import { SIM_GRAVITY } from '../../src/physics.js';
let s = 999;
Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const mk = (nx, ny) => { const w = new World(nx, ny); w.gravity = SIM_GRAVITY; return w; };
const at = (w, x, y) => w.id[w.idx(x, y)];
const show = (w, y0, y1, x0 = 0, x1 = w.nx) => { const r = []; for (let y = y1 - 1; y >= y0; y--) { let s = ''; for (let x = x0; x < x1; x++) { const e = at(w, x, y); s += e === E.WATER ? '~' : e === E.WALL ? '#' : e === E.EMPTY ? '.' : '?'; } r.push(s); } return r.join('\n'); };
const out = {};
// P1: tank (x 1..10, y 2..30) draining through a horizontal pipe 1 tall at y=2 from x=11 to x=11+L, open end
for (const L of [2, 10, 30]) {
  const nx = 16 + L + 30, w = mk(nx, 40);
  for (let x = 0; x < nx; x++) w.put(x, 0, E.WALL);
  for (let y = 1; y < 34; y++) { w.put(0, y, E.WALL); w.put(11, y, E.WALL); }
  for (let x = 0; x <= 11 + L; x++) { w.put(x, 1, E.WALL); }
  for (let x = 11; x <= 11 + L; x++) w.put(x, 3, E.WALL);
  for (let y = 2; y < 30; y++) for (let x = 1; x < 11; x++) w.put(x, y, E.WATER);
  for (let x = 11; x <= 11 + L; x++) w.erase(w.idx(x, 2)); // the pipe bore (y=2), from inside the tank wall to its end
  const tank = () => { let n = 0; for (let y = 2; y < 34; y++) for (let x = 1; x < 11; x++) if (at(w, x, y) === E.WATER) n++; return n; };
  const n0 = tank(); const hist = [];
  for (let i = 1; i <= 2000; i++) { w.step(); if ([100, 250, 500, 1000, 2000].includes(i)) { let pipeV = 0, pn = 0; for (let x = 12; x <= 11 + L; x++) { const k = w.idx(x, 2); if (w.id[k] === E.WATER) { pipeV += w.vx[k]; pn++; } } hist.push({ step: i, drained: n0 - tank(), pipeFill: `${pn}/${L}`, pipeVx: pn ? +(pipeV / pn).toFixed(3) : 0 }); } }
  out['pipe' + L] = { hist, pic: show(w, 1, 6, 0, Math.min(nx, 16 + L + 20)) };
}
// P2: gentle landings: a 1-cell-tall sheet 20 wide dropped from 1 cell above the floor; sideways KE after landing
{
  const w = mk(80, 10);
  for (let x = 0; x < 80; x++) w.put(x, 0, E.WALL);
  for (let x = 30; x < 50; x++) { w.put(x, 2, E.WATER); }
  let maxKE = 0, ke0 = 0;
  for (let i = 1; i <= 40; i++) { w.step(); let ke = 0, lo = 99, hi = -1; for (let x = 0; x < 80; x++) for (let y = 1; y < 10; y++) { const k = w.idx(x, y); if (w.id[k] === E.WATER) { ke += w.vx[k] ** 2 + w.vy[k] ** 2; lo = Math.min(lo, x); hi = Math.max(hi, x); } } if (i === 1) ke0 = ke; maxKE = Math.max(maxKE, ke); if (i === 40) out.gentle = { ke0: +ke0.toFixed(3), maxKE: +maxKE.toFixed(3), spreadAt40: [lo, hi] }; }
}
// P3: lava blob at its spawn temperature on a stone floor: does it heap or level?
for (const key of ['LAVA', 'SLIME', 'MUD', 'WATER']) {
  const w = mk(64, 20);
  for (let x = 0; x < 64; x++) w.put(x, 0, E.WALL);
  for (let y = 1; y < 9; y++) for (let x = 29; x < 35; x++) w.put(x, y, E[key]);
  for (let i = 1; i <= 300; i++) w.step();
  let lo = 99, hi = -1, top = 0, n = 0; for (let y = 1; y < 20; y++) for (let x = 0; x < 64; x++) if (w.id[w.idx(x, y)] === E[key]) { n++; lo = Math.min(lo, x); hi = Math.max(hi, x); top = Math.max(top, y); }
  (out.heap ??= {})[key] = { n, width: hi - lo + 1, top, after: 300 };
}
console.log(JSON.stringify(out, null, 1));
