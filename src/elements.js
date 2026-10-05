// Element definitions. This table is the single source of truth: it drives the
// UI palette and is baked into every shader as GLSL const arrays.
//
// Units
//   dens   relative density (air = 1, water = 10). Only ordering + ratios matter.
//   cond   thermal conductance per face (pairwise flux uses min(cond_a, cond_b))
//   cap    volumetric heat capacity (water = 1). Stability needs 6*cond/cap < 1.
//   temp   spawn temperature, °C
//   grav   gravity multiplier (negative = buoyant, rises)
//   drag   per-step velocity damping
//   friction extra damping of horizontal velocity (grains resting on each other)
//   jitter per-step random velocity (brownian motion for gases)
//   flow   horizontal flow speed liquids pick up when they hit something
//   slide  probability a supported powder grain topples diagonally per step
//   melt   temperature above which it becomes LAVA (remembering what it was)
//   ignite temperature above which it burns (if it touches air)
//   rad    radiative cooling rate toward ambient

export const K = { EMPTY: 0, SOLID: 1, POWDER: 2, LIQUID: 3, GAS: 4 };
export const R = { NONE: 0, OPAQUE: 1, LIQUID: 2, GLASS: 3, GAS: 4, FIRE: 5 };

const defs = [
  { key: 'EMPTY', abbr: 'AIR', name: 'Air', kind: K.EMPTY, render: R.NONE, color: '#000000',
    dens: 1, cond: 0.0005, cap: 0.02, drag: 0.1, jitter: 0.02, desc: 'Air. Carries heat and pressure; hot air rises.' },
  { key: 'WALL', abbr: 'WALL', name: 'Wall', kind: K.SOLID, render: R.OPAQUE, color: '#59606e', var: 0.05,
    cond: 0.001, cap: 1.0, desc: 'Indestructible and insulating. Build containers and barriers with it.' },

  { key: 'SAND', abbr: 'SAND', name: 'Sand', kind: K.POWDER, render: R.OPAQUE, color: '#dcbc74', var: 0.22,
    dens: 16, cond: 0.01, cap: 0.35, drag: 0.04, slide: 0.9, melt: 1700, spawn: 0.3,
    desc: 'Grains that pile into slopes and sink in water. Melts into glass above 1700 °C.' },
  { key: 'STONE', abbr: 'STNE', name: 'Stone', kind: K.POWDER, render: R.OPAQUE, color: '#868a92', var: 0.18,
    dens: 26, cond: 0.03, cap: 0.5, drag: 0.04, slide: 0.55, melt: 1200, spawn: 0.3,
    desc: 'Heavy rubble that sinks through anything lighter. Melts into lava at 1200 °C.' },
  { key: 'SNOW', abbr: 'SNOW', name: 'Snow', kind: K.POWDER, render: R.OPAQUE, color: '#eef4ff', var: 0.06,
    dens: 9, cond: 0.005, cap: 0.2, drag: 0.08, slide: 0.35, temp: -10, spawn: 0.3,
    desc: 'Light powder that floats on water. Melts at 0 °C, soaking up heat as it goes.' },
  { key: 'GUNPOWDER', abbr: 'GUNP', name: 'Gunpowder', kind: K.POWDER, render: R.OPAQUE, color: '#3d3d47', var: 0.35,
    dens: 15, cond: 0.01, cap: 0.35, drag: 0.04, slide: 0.8, ignite: 200, spawn: 0.3,
    desc: 'Explodes when it touches fire or gets hotter than 200 °C.' },
  { key: 'ASH', abbr: 'ASH', name: 'Ash', kind: K.POWDER, render: R.OPAQUE, color: '#9b968d', var: 0.2,
    dens: 4, cond: 0.003, cap: 0.2, drag: 0.1, slide: 0.5, spawn: 0.3,
    desc: 'Fluffy leftovers from burnt wood. Light enough to float on water.' },

  { key: 'WATER', abbr: 'WATR', name: 'Water', kind: K.LIQUID, render: R.LIQUID, color: '#2a78d4',
    dens: 10, cond: 0.03, cap: 1.0, drag: 0.01, flow: 0.9, spawn: 0.35,
    sigma: [0.30, 0.075, 0.035], desc: 'Flows and levels out. Freezes at 0 °C and boils at 100 °C, with real latent heat.' },
  { key: 'OIL', abbr: 'OIL', name: 'Oil', kind: K.LIQUID, render: R.LIQUID, color: '#5a3c12',
    dens: 8, cond: 0.008, cap: 0.45, drag: 0.03, flow: 0.55, ignite: 220, burnRate: 0.008,
    burnHeat: 5, flameT: 1000, life: 1, spawn: 0.35,
    sigma: [0.35, 0.55, 0.9], desc: 'Lighter than water, so it floats on top. Catches fire at 220 °C.' },
  { key: 'ACID', abbr: 'ACID', name: 'Acid', kind: K.LIQUID, render: R.LIQUID, color: '#86f23c',
    dens: 11, cond: 0.03, cap: 1.0, drag: 0.015, flow: 0.8, life: 1, spawn: 0.35,
    sigma: [0.45, 0.04, 0.55], desc: 'Eats through most things except glass and walls, using itself up as it goes.' },
  { key: 'LAVA', abbr: 'LAVA', name: 'Lava', kind: K.LIQUID, render: R.OPAQUE, color: '#ff5a1a', var: 0.1,
    dens: 25, cond: 0.03, cap: 0.6, drag: 0.2, flow: 0.3, temp: 1600, spawn: 0.35,
    desc: 'Molten rock at 1600 °C. Cools back into whatever melted to make it.' },

  { key: 'STEAM', abbr: 'WTRV', name: 'Steam', kind: K.GAS, render: R.GAS, color: '#e6edf5',
    dens: 0.6, cond: 0.02, cap: 0.5, grav: -0.6, drag: 0.05, jitter: 0.15, temp: 110, rad: 0.03,
    spawn: 0.3, sigma: [0.16, 0.16, 0.16], desc: 'Water vapour. Rises and spreads, then condenses into water below 100 °C.' },
  { key: 'SMOKE', abbr: 'SMKE', name: 'Smoke', kind: K.GAS, render: R.GAS, color: '#38383d',
    dens: 0.85, cond: 0.0005, cap: 0.02, grav: -0.25, drag: 0.05, jitter: 0.12, life: 1, rad: 0.01,
    spawn: 0.3, sigma: [0.3, 0.3, 0.3], desc: 'Drifts upward and slowly fades away.' },
  { key: 'FIRE', abbr: 'FIRE', name: 'Fire', kind: K.GAS, render: R.FIRE, color: '#ff8a2a',
    dens: 0.5, cond: 0.04, cap: 0.3, grav: -1.4, drag: 0.08, jitter: 0.25, temp: 1000, life: 1,
    rad: 0.01, spawn: 0.3, desc: 'Hot, short-lived and rising. Ignites anything flammable it heats up.' },

  { key: 'WOOD', abbr: 'WOOD', name: 'Wood', kind: K.SOLID, render: R.OPAQUE, color: '#7a4a26', var: 0.12,
    cond: 0.008, cap: 0.3, ignite: 300, burnRate: 0.0018, burnHeat: 3, flameT: 900, life: 1,
    desc: 'Burns slowly above 300 °C and leaves ash behind.' },
  { key: 'PLANT', abbr: 'PLNT', name: 'Plant', kind: K.SOLID, render: R.OPAQUE, color: '#3da236', var: 0.25,
    cond: 0.008, cap: 0.5, ignite: 250, burnRate: 0.004, burnHeat: 2, flameT: 800, life: 1,
    desc: 'Grows into neighbouring water. Burns easily.' },
  { key: 'METAL', abbr: 'METL', name: 'Metal', kind: K.SOLID, render: R.OPAQUE, color: '#a9afba', var: 0.04,
    cond: 0.1, cap: 0.85, melt: 1500, desc: 'Conducts heat fast and glows when hot. Melts at 1500 °C.' },
  { key: 'GLASS', abbr: 'GLAS', name: 'Glass', kind: K.SOLID, render: R.GLASS, color: '#d2ecf2',
    cond: 0.015, cap: 0.5, melt: 1400, sigma: [0.05, 0.025, 0.03], desc: 'Clear and acid-proof. Melts at 1400 °C.' },
  { key: 'ICE', abbr: 'ICE', name: 'Ice', kind: K.SOLID, render: R.GLASS, color: '#a9d8f2',
    cond: 0.04, cap: 0.5, temp: -20, sigma: [0.12, 0.05, 0.025], desc: 'Frozen water. Melts at 0 °C and chills whatever it touches.' },
  { key: 'CLONE', abbr: 'CLNE', name: 'Clone', kind: K.SOLID, render: R.OPAQUE, color: '#d9b81e', var: 0.05,
    cond: 0.001, cap: 1.0, desc: 'Copies the first element that touches it, forever.' },
];

export const ELEMENTS = defs.map((d, id) => ({
  id, var: 0, dens: 1000, grav: 0, drag: 0, friction: d.kind === K.POWDER ? 0.25 : 0, jitter: 0, flow: 0, slide: 0, melt: 0, ignite: 0,
  burnRate: 0, burnHeat: 0, flameT: 0, temp: 20, life: 0, rad: 0, spawn: 1, sigma: [0, 0, 0], desc: '',
  ...d,
  grav: d.grav ?? (d.kind === K.POWDER || d.kind === K.LIQUID ? 1 : 0),
}));

export const E = Object.fromEntries(ELEMENTS.map((e) => [e.key, e.id]));

// Brush tools that are not elements (negative ids in the paint shader).
// SIGN is handled by the app (it pins a text label), not by the paint shader.
export const TOOLS = [
  { id: -1, key: 'ERASE', abbr: 'ERAS', name: 'Erase', color: '#e5536a', desc: 'Removes everything inside the brush.' },
  { id: -2, key: 'HEAT', abbr: 'HEAT', name: 'Heat', color: '#ff7a2f', desc: 'Warms everything inside the brush.' },
  { id: -3, key: 'COOL', abbr: 'COOL', name: 'Cool', color: '#52b6ff', desc: 'Chills everything inside the brush.' },
  { id: -4, key: 'BLAST', abbr: 'PRES', name: 'Pressure', color: '#b994ff', desc: 'Adds air pressure that pushes things outward.' },
  { id: -5, key: 'SIGN', abbr: 'SIGN', name: 'Sign', color: '#efe7d2',
    desc: 'Click a surface to pin a label. {t}, {p} and {e} show live temperature, pressure and element.' },
];

// How the palette is laid out in the UI. Within each group, elements are
// ordered so related materials sit together and the colours run smoothly.
export const PALETTE = [
  { name: 'Powders', items: ['SAND', 'STONE', 'GUNPOWDER', 'ASH', 'SNOW'] },
  { name: 'Liquids', items: ['WATER', 'ACID', 'OIL', 'LAVA'] },
  { name: 'Gases', items: ['STEAM', 'SMOKE', 'FIRE'] },
  { name: 'Solids', items: ['WALL', 'METAL', 'GLASS', 'ICE', 'WOOD', 'PLANT', 'CLONE'] },
  { name: 'Tools', items: ['HEAT', 'COOL', 'ERASE', 'BLAST', 'SIGN'] },
];

export const toolById = (id) => (id < 0 ? TOOLS.find((t) => t.id === id) : ELEMENTS[id]);
export const itemByKey = (key) => (key in E ? ELEMENTS[E[key]] : TOOLS.find((t) => t.key === key));

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hexToLinear = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255));
};

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const floatArr = (name, key) =>
  `const float ${name}[NE] = float[NE](${ELEMENTS.map((e) => f(e[key])).join(', ')});`;
const intArr = (name, key) =>
  `const int ${name}[NE] = int[NE](${ELEMENTS.map((e) => e[key]).join(', ')});`;
const vec3Arr = (name, fn) =>
  `const vec3 ${name}[NE] = vec3[NE](${ELEMENTS.map((e) => `vec3(${fn(e).map(f).join(', ')})`).join(', ')});`;

// Melting product: sand turns into glass when it re-solidifies.
const meltInto = (e) => (e.key === 'SAND' ? E.GLASS : e.id);

export function elementsGLSL() {
  return [
    `#define NE ${ELEMENTS.length}`,
    ...Object.entries(K).map(([k, v]) => `#define K_${k} ${v}`),
    ...Object.entries(R).map(([k, v]) => `#define R_${k} ${v}`),
    ...ELEMENTS.map((e) => `#define E_${e.key} ${e.id}`),
    ...TOOLS.map((t) => `#define T_${t.key} ${t.id}`),
    intArr('KIND', 'kind'),
    intArr('RCLASS', 'render'),
    floatArr('DENS', 'dens'),
    floatArr('COND', 'cond'),
    floatArr('CAP', 'cap'),
    floatArr('GRAV', 'grav'),
    floatArr('DRAG', 'drag'),
    floatArr('FRICTION', 'friction'),
    floatArr('JITTER', 'jitter'),
    floatArr('FLOW', 'flow'),
    floatArr('SLIDE', 'slide'),
    floatArr('MELT', 'melt'),
    floatArr('IGNITE', 'ignite'),
    floatArr('BURNRATE', 'burnRate'),
    floatArr('BURNHEAT', 'burnHeat'),
    floatArr('FLAMET', 'flameT'),
    floatArr('SPAWNT', 'temp'),
    floatArr('SPAWNLIFE', 'life'),
    floatArr('SPAWNDENS', 'spawn'),
    floatArr('RAD', 'rad'),
    floatArr('COLORVAR', 'var'),
    `const int MELTINTO[NE] = int[NE](${ELEMENTS.map(meltInto).join(', ')});`,
    vec3Arr('COLOR', (e) => hexToLinear(e.color).map((v) => +v.toFixed(4))),
    vec3Arr('SIGMA', (e) => e.sigma),
  ].join('\n');
}
