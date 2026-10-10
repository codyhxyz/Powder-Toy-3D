// CPU checks of what the themed world scenes (src/world/scenes/labWorld.js,
// volcanoWorld.js) generate, from their JS twins, over whole 128³ windows (the
// start window and a few others): which cells would move or react the moment
// the window loads. Some is on purpose (the lab's hanging blocks fall and its
// oil puddles spread, as the box lab's do); the rest must be zero. No GPU:
// fine on battery.
//
//   node tools/scene-themed-check.mjs
import { ELEMENTS, E, K } from '../src/elements.js';
import { WORLD_SIZE } from '../src/shaders/far.js';
import { labWorld, labTwin } from '../src/world/scenes/labWorld.js';
import { volcanoWorld, volcanoTwin, VOL, VOL_KINDS } from '../src/world/scenes/volcanoWorld.js';

const SEED = 20261008;         // the default world seed (world/generator.js WORLD_SEED)
const WIN = 128;               // the window's edge, cells
const OTHERS = [[0, 0], [448, 832], [896, 384]];   // window corners checked besides the start window's...
const SITE_WINDOWS = 4;        // ...and windows on this many dormant volcanoes (and an islet)

// What lava sets off on contact (boils, melts, burns or explodes).
const LAVA_REACTS = new Set([E.WATER, E.ICE, E.SNOW, E.PLANT, E.WOOD, E.OIL, E.GUNPOWDER, E.SAWDUST]);

// frozen(y): is rock at height y frozen through (snow and ice on it don't melt from below)? (lab: no frozen rock)
function scan(name, column, x0, z0, frozen = () => true) {
  const N = WIN + 2;   // a cell of margin all round
  const ids = new Uint8Array(N * N * N);
  const at = (i, y, k) => ids[(k * N + i) * N + y];
  for (let k = 0; k < N; k++)
    for (let i = 0; i < N; i++) {
      const cell = column(x0 + i - 1, z0 + k - 1);
      for (let y = 0; y < N; y++) ids[(k * N + i) * N + y] = y === 0 ? E.WALL : cell(y - 1);   // (the grid's floor below y = 0)
    }
  const count = {};
  const add = (what, id) => { const key = `${what} ${ELEMENTS[id].key}`; count[key] = (count[key] ?? 0) + 1; };
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let k = 1; k <= WIN; k++)
    for (let i = 1; i <= WIN; i++)
      for (let y = 1; y < N - 1; y++) {
        const id = at(i, y, k);
        if (id === E.EMPTY) continue;
        const kind = ELEMENTS[id].kind, below = at(i, y - 1, k);
        const open = (b) => b === E.EMPTY || (kind === K.POWDER && ELEMENTS[b].kind === K.LIQUID && ELEMENTS[b].dens < ELEMENTS[id].dens);
        if (kind === K.LIQUID) {
          if (below === E.EMPTY || SIDES.some(([a, b]) => at(i + a, y, k + b) === E.EMPTY)) add('flows', id);
        } else if (kind === K.POWDER) {
          if (open(below)) add('falls', id);
          else if (SIDES.some(([a, b]) => open(at(i + a, y, k + b)) && open(at(i + a, y - 1, k + b)))) add('topples', id);
        }
        const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([a, b, c]) => at(i + a, y + b, k + c));
        if (id === E.PLANT && nb.includes(E.WATER)) add('grows into water', id);
        if (id === E.LAVA && nb.some((n) => LAVA_REACTS.has(n))) add('touches what it sets off', id);
        if (id === E.CLONE && nb.includes(E.EMPTY)) add('can pour', id);
        if ((id === E.SNOW || id === E.ICE) && below === E.ROCK && !frozen(y - 2)) add('lies on warm rock', id);
      }
  const parts = Object.entries(count).sort().map(([k, v]) => `${k} ${v}`);
  console.log(`${name} @ ${x0},${z0}: ${parts.join(', ') || 'nothing moves'}`);
  return count;
}

let failures = 0;
const corner = (s) => s.map((v) => Math.min(Math.max(0, Math.round(v - WIN / 2)), WORLD_SIZE[0] - WIN));

{
  const P = labWorld.params({ size: WORLD_SIZE, seed: SEED });
  const T = labTwin(P);
  const column = (x, z) => (y) => T.labCell(x, y, z);
  for (const [x0, z0] of [corner(labWorld.start(P, [WIN, WIN])), ...OTHERS]) {
    const c = scan('lab', column, x0, z0);
    // hanging blocks fall and oil puddles spread (on purpose); a tank's liquid never leaks, nothing reacts at once
    for (const k of Object.keys(c)) {
      const ok = /^falls (SAND|STONE|SNOW|GUNPOWDER)$|^topples (SAND|STONE|SNOW|GUNPOWDER)$|^flows OIL$/.test(k);
      if (!ok) { failures++; console.log(`  FAIL lab: ${k}`); }
    }
  }
}
{
  const P = volcanoWorld.params({ size: WORLD_SIZE, seed: SEED });
  const T = volcanoTwin(P);
  const column = (x, z) => { const col = T.volColumn(x, z); return (y) => T.volCellIn(x, y, z, col); };
  // and windows on the first few dormant volcanoes and islets
  const kinds = Object.fromEntries(VOL_KINDS.map((k, i) => [k, i]));
  const sites = [];
  for (let sz = 0; sz < WORLD_SIZE[2] / VOL.CELL; sz++)
    for (let sx = 0; sx < WORLD_SIZE[0] / VOL.CELL; sx++) {
      const h = T.volSite(sx, sz), k = T.volSiteKind(h);
      if (k === kinds.DORMANT || k === kinds.ISLET) sites.push([k, corner([T.volCentre(h, VOL.K_X, sx), T.volCentre(h, VOL.K_Z, sz)])]);
    }
  const pick = [...sites.filter(([k]) => k === kinds.DORMANT).slice(0, SITE_WINDOWS), ...sites.filter(([k]) => k === kinds.ISLET).slice(0, 1)];
  for (const [x0, z0] of [corner(volcanoWorld.start(P, [WIN, WIN])), ...OTHERS, ...pick.map(([, c]) => c)]) {
    const c = scan('volcano', column, x0, z0, (y) => T.volFrost(y) >= 1);
    // only the lava sources pour; nothing falls, topples, leaks or reacts at once
    for (const k of Object.keys(c)) if (k !== 'can pour CLONE') { failures++; console.log(`  FAIL volcano: ${k}`); }
  }
}
console.log(failures ? `${failures} failure(s)` : 'themed scenes OK');
process.exit(failures ? 1 : 0);
