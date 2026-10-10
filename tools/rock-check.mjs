// Headless GPU check of the rocks (elements.js SANDSTONE, LIMESTONE, COAL,
// BROKENCOAL): one browser, one lab box, every close-up detail feature on.
//   - each rock as a wall between slabs of ROCK, under a low sun, from afar
//     and up close (the shared CRAG texture and its relief)
//   - the pickaxe and the axe swung at each slab: cells broken, into what
//   - acid poured into a pit cut into limestone: limestone eaten, the CO₂ fizz's pressure
//   - a coal block lit at the top: how hot it burns, how much is left
// Prints the numbers as JSON and writes the stills to <outDir>.
// usage: node tools/rock-check.mjs <outDir> [--port 5392] [--walls-only]
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { DETAIL, settingKey } from '../src/gfx/detail.js';

const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5392');
const wallsOnly = args.includes('--walls-only');   // just the walls' stills (a look change)
mkdirSync(out, { recursive: true });

const VIEW = { width: 1280, height: 800 };
const SUN = { az: 60, el: 30 };       // degrees: low, from the walls' front and right, so crags cast shade
const CONVERGE_FRAMES = 40;           // frames per still (TAA, GI)
const SWING_STEPS = 30;               // sim steps after a swing before counting
const DEBRIS_STEPS = 120;             // ...and before the debris still
const ACID_SAMPLE_STEPS = 10;         // sim steps between samples of the pit's pressure
const ACID_SAMPLES = 6;               // ...this many, then the acid's still
const ACID_STEPS = 400;               // sim steps of acid in the pit in all
const FIRE_STEPS = 1200;              // sim steps of the coal fire before its still

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: VIEW });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 1000)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 1000)));
const detailOn = Object.fromEntries(DETAIL.map((f) => [settingKey(f), true]));
await p.addInitScript((s) => localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true, ...s })), detailOn);
await p.goto(`http://localhost:${port}/?preset=empty&size=128`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 60000 });
await p.waitForTimeout(1500);

// The scene, in cells. Slabs along x, their front face at z = WALL_Z1 (facing +z).
const SLABS = ['SANDSTONE', 'ROCK', 'LIMESTONE', 'ROCK', 'COAL'];
const LAYOUT = {
  slabX0: 39, slabW: 10, slabH: 16, wallZ0: 56, wallZ1: 64,
  pit: { x0: 14, x1: 30, z0: 84, z1: 100, h: 10, rim: 3, floor: 4 },   // a limestone block with a pit in it, for acid
  coal: { x0: 90, x1: 104, z0: 86, z1: 100, h: 6, litT: 700 },                    // a coal block, its top layer lit
  pickY: 4, axeY: 11,                   // heights of the swings on each slab
};
const res = await p.evaluate(async ([SLABS, L, SUN]) => {
  const a = window.__app;
  const { E, ELEMENTS } = await import('/src/elements.js');
  a.settings.paused = true;
  a.autoRes.enabled = false;
  a.day.fixed = SUN;
  const sim = a.sim;
  const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  window.__frames = frames;
  // scene units of cell (x, y, z), as tools/far-check.mjs
  window.__scene = (x, y, z) => { const s = a.scale, o = sim.origin, v = a.volume.position; return [v.x + (x - o.x) * s, v.y + y * s, v.z + (z - o.z) * s]; };
  const [A, B] = sim.blankState();
  const set = (x, y, z, id, T = ELEMENTS[id].temp, life = ELEMENTS[id].life) => {
    const i = sim.cellTexel(x, y, z) * 4;
    A[i] = id; A[i + 1] = T; A[i + 2] = life;
  };
  SLABS.forEach((k, s) => {
    const x0 = L.slabX0 + s * L.slabW;
    for (let x = x0; x < x0 + L.slabW; x++) for (let y = 0; y < L.slabH; y++) for (let z = L.wallZ0; z < L.wallZ1; z++) set(x, y, z, E[k]);
  });
  const P = L.pit;
  for (let x = P.x0; x < P.x1; x++) for (let y = 0; y < P.h; y++) for (let z = P.z0; z < P.z1; z++) {
    const inPit = x >= P.x0 + P.rim && x < P.x1 - P.rim && z >= P.z0 + P.rim && z < P.z1 - P.rim && y >= P.floor;
    if (!inPit) set(x, y, z, E.LIMESTONE);
  }
  const C = L.coal;
  for (let x = C.x0; x < C.x1; x++) for (let y = 0; y < C.h; y++) for (let z = C.z0; z < C.z1; z++)
    set(x, y, z, E.COAL, y === C.h - 1 ? C.litT : ELEMENTS[E.COAL].temp);
  sim.load(A, B);

  // census of boxes of cells [x0, x1, y0, y1, z0, z1), from one read of the
  // state: per box, element counts, the hottest cell of each, the highest air pressure
  window.__census = (boxes) => {
    const [SA, SB] = sim.readState();
    return boxes.map(([x0, x1, y0, y1, z0, z1]) => {
      const n = {}, Tmax = {};
      let Pmax = 0;
      for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) {
        const i = sim.cellTexel(x, y, z) * 4, key = ELEMENTS[Math.round(SA[i])].key;
        n[key] = (n[key] ?? 0) + 1;
        Tmax[key] = Math.max(Tmax[key] ?? -Infinity, Math.round(SA[i + 1]));
        Pmax = Math.max(Pmax, SB[i + 3]);
      }
      return { n, Tmax, Pmax: +Pmax.toFixed(3) };
    });
  };
  window.__steps = (k) => { for (let i = 0; i < k; i++) sim.step(); };
  await frames(4);
  return { hard: Object.fromEntries(['ROCK', 'SANDSTONE', 'LIMESTONE', 'COAL'].map((k) => [k, ELEMENTS[E[k]].hard])) };
}, [SLABS, LAYOUT, SUN]);

const look = async (posCells, tgtCells) => {
  await p.evaluate(([pc, tc]) => {
    const a = window.__app;
    a.camera.position.set(...window.__scene(...pc));
    a.controls.target.set(...window.__scene(...tc));
    a.controls.update();
    a.post.reset();
  }, [posCells, tgtCells]);
  await p.evaluate((n) => window.__frames(n), CONVERGE_FRAMES);
};
const shot = (name) => p.screenshot({ path: `${out}/${name}.png` });
const L = LAYOUT, edge = (s) => L.slabX0 + s * L.slabW;
// each slab's lower half (where the pickaxe strikes) and upper half (the axe)
const SPLIT_Y = Math.round((L.pickY + L.axeY) / 2);
const halves = SLABS.flatMap((k, s) => [[edge(s), edge(s) + L.slabW, 0, SPLIT_Y, L.wallZ0, L.wallZ1], [edge(s), edge(s) + L.slabW, SPLIT_Y, L.slabH, L.wallZ0, L.wallZ1]]);
const census = (boxes) => p.evaluate((bx) => window.__census(bx), boxes);
const census1 = async (box) => (await census([box]))[0];

// 1. the walls under the sun
const wallMidX = L.slabX0 + SLABS.length * L.slabW / 2;
await look([wallMidX - 14, 22, L.wallZ1 + 44], [wallMidX, L.slabH / 2, L.wallZ1]); await shot('walls');
await look([edge(1) + 3, 9, L.wallZ1 + 9], [edge(1), 7, L.wallZ1]); await shot('close-sandstone-rock');
await look([edge(3) - 3, 9, L.wallZ1 + 9], [edge(3), 7, L.wallZ1]); await shot('close-limestone-rock');
await look([edge(4) + 3, 9, L.wallZ1 + 9], [edge(4), 7, L.wallZ1]); await shot('close-rock-coal');
if (wallsOnly) { console.log(errs.length ? errs.join('\n') : 'no console errors'); await b.close(); process.exit(0); }

// 2. the pickaxe low and the axe high on each slab, struck from the front
const before = await census(halves);
res.swings = await p.evaluate(async ([SLABS, L, ys]) => {
  const a = window.__app;
  const THREE = a.THREE;
  const { E } = await import('/src/elements.js');
  const tools = { pickaxe: (await import('/src/pov/tools/pickaxe.tool.js')).default, axe: (await import('/src/pov/tools/axe.tool.js')).default };
  const env = {
    renderer: a.renderer, scene: a.scene, getSim: () => a.sim, getVolume: () => a.volume, getScale: () => a.scale,
    hud: { toast() {} }, viewmodel: (() => { const v = new THREE.Group(); a.camera.add(v); a.scene.add(a.camera); return v; })(),
    isActive: () => true,
  };
  const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), applyImpulse() {} };
  const out = {};
  for (const [name, def] of Object.entries(tools)) {
    const tool = def.create(env);
    SLABS.forEach((k, s) => {
      const cell = new THREE.Vector3(L.slabX0 + s * L.slabW + Math.floor(L.slabW / 2), ys[name], L.wallZ1 - 1);
      const eye = new THREE.Vector3(cell.x + 0.5, cell.y + 0.5, L.wallZ1 + 3);
      const ctx = (over) => ({ sim: a.sim, dt: 1 / 60, stepsPerFrame: 4, eye, dir: new THREE.Vector3(0, 0, -1),
        primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0,
        aim: { valid: true, cell, face: 4, id: E[k], dist: 2.5 }, player, ...over });
      tool.update(ctx({ primary: true, primaryPressed: true }));
      for (let f = 0; f < 40; f++) tool.update(ctx({}));   // let the swing finish before the next
    });
    tool.deselect(); tool.dispose();
    out[name] = true;
  }
  return out;
}, [SLABS, LAYOUT, { pickaxe: LAYOUT.pickY, axe: LAYOUT.axeY }]);
await p.evaluate((k) => window.__steps(k), SWING_STEPS);
const after = await census(halves);
// cells of its own rock each slab lost: to the pickaxe (lower half), the axe (upper)
res.broken = SLABS.map((k, s) => ({ slab: k, hard: res.hard[k],
  pickaxe: before[2 * s].n[k] - (after[2 * s].n[k] ?? 0), axe: before[2 * s + 1].n[k] - (after[2 * s + 1].n[k] ?? 0) }));
await p.evaluate((k) => window.__steps(k), DEBRIS_STEPS);
await look([edge(2) - 6, 12, L.wallZ1 + 20], [edge(2), 5, L.wallZ1]); await shot('swings-debris-left');
await look([edge(4) - 2, 12, L.wallZ1 + 20], [edge(4) + 2, 5, L.wallZ1]); await shot('swings-debris-right');

// 3. acid in the limestone pit; 4. the coal fire
const pit = LAYOUT.pit, coal = LAYOUT.coal;
const pitBox = [pit.x0, pit.x1, 0, pit.h + 8, pit.z0, pit.z1];
const coalBox = [coal.x0 - 2, coal.x1 + 2, 0, coal.h + 12, coal.z0 - 2, coal.z1 + 2];
// fill the pit with acid (a cube brush the pit's size: it only fills air)
const pitMidX = (pit.x0 + pit.x1) / 2, pitMidZ = (pit.z0 + pit.z1) / 2;
await p.evaluate(async ([c, r]) => {
  const a = window.__app;
  const { E } = await import('/src/elements.js');
  const BRUSH_CUBE = 1, FILL_RATE = 4;   // passes.js uShape; a rate past 1/spawn fills every cell
  a.sim.paint({ center: new a.THREE.Vector3(...c), radius: r, shape: BRUSH_CUBE, tool: E.ACID, rate: FILL_RATE, replace: false });
}, [[pitMidX, (pit.floor + pit.h) / 2, pitMidZ], (pit.x1 - pit.x0) / 2 - pit.rim]);
[res.pit0, res.coal0] = await census([pitBox, coalBox]);
// the acid's fizz is a puff where a cell dissolves: sample the pit's pressure while it eats
res.pitP = [];
for (let i = 0; i < ACID_SAMPLES; i++) {
  await p.evaluate((k) => window.__steps(k), ACID_SAMPLE_STEPS);
  res.pitP.push((await census1(pitBox)).Pmax);
}
await look([pitMidX + 6, pit.h + 12, pit.z1 + 10], [pitMidX, pit.floor + 2, pitMidZ]); await shot('acid-limestone');
await p.evaluate((k) => window.__steps(k), ACID_STEPS - ACID_SAMPLES * ACID_SAMPLE_STEPS);
res.pit1 = await census1(pitBox);
await p.evaluate((k) => window.__steps(k), FIRE_STEPS - ACID_STEPS);
res.coal1 = await census1(coalBox);
const coalMidX = (coal.x0 + coal.x1) / 2, coalMidZ = (coal.z0 + coal.z1) / 2;
await look([coalMidX - 10, coal.h + 14, coal.z1 + 16], [coalMidX, coal.h / 2, coalMidZ]); await shot('coal-fire');

console.log(JSON.stringify(res, null, 1));
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
