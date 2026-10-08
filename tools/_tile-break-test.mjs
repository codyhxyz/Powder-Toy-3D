import { World } from '../src/ui/tiles/engine.js';
import { E } from '../src/elements.js';
const run = (target, thick = 1, gap = 4) => {
  const w = new World(48, 32); w.gravity = 0.025;
  for (let x = 30; x < 30 + thick; x++) for (let y = 4; y < 28; y++) w.put(x, y, E[target]);
  w.put(30 - 1 - gap, 16, E.SCRAP); w.vx[w.idx(30 - 1 - gap, 16)] = 1;
  const count = () => { const c = {}; for (const id of w.id) c[id] = (c[id] ?? 0) + 1; return c; };
  const c0 = count();
  let Tmax = -1e9;
  for (let s = 0; s < 40; s++) { w.step(); for (let i = 0; i < w.id.length; i++) if (w.id[i] !== E.EMPTY) Tmax = Math.max(Tmax, w.T[i]); }
  const c1 = count();
  const n = (c) => Object.entries(c).filter(([k]) => +k !== E.EMPTY).reduce((s, [, v]) => s + v, 0);
  return { target, before: c0[E[target]], after: c1[E[target]] ?? 0, debris: Object.entries(c1).filter(([k]) => ![E.EMPTY, E[target], E.SCRAP].includes(+k)).map(([k, v]) => `${k}:${v}`).join(' '), Tmax: Tmax.toFixed(1), conserved: n(c0) === n(c1) };
};
for (const t of ['GLASS', 'METAL', 'ROCK', 'WOOD', 'WALL']) console.log(JSON.stringify(run(t)));
// blast: a lit 3×3 gunpowder pile next to glass and metal
const w = new World(48, 32); w.gravity = 0.025;
for (let x = 20; x < 23; x++) for (let y = 0; y < 3; y++) w.put(x, y, E.GUNPOWDER);
w.put(19, 0, E.FIRE);
for (let y = 0; y < 10; y++) { w.put(25, y, E.GLASS); w.put(17, y, E.METAL); }
for (let s = 0; s < 60; s++) w.step();
let g = 0, m = 0; for (let y = 0; y < 10; y++) { g += w.id[w.idx(25, y)] === E.GLASS; m += w.id[w.idx(17, y)] === E.METAL; }
console.log(`blast: glass left ${g}/10, metal left ${m}/10`);
