// Display modes ("views") of the raymarcher.
//
// This file is the single source of truth for each view's name, hotkey,
// description and colour legend. The colormaps below are baked into the GLSL
// by src/shaders/render.js, so the legend the UI draws always matches what the
// shader shows.
//
// Colormap format: knots [[value, '#rrggbb'], ...]. Knots sit evenly spaced
// along the legend bar, so the value axis is piecewise (roughly logarithmic).
// Between two knots the value maps linearly, or logarithmically when the map
// has `log: true` and both knots have the same sign. Colours are interpolated
// in sRGB, exactly like a CSS linear-gradient, so `legend.css` is exact.

export const COLORMAPS = {
  // Temperature in °C. Room temperature is a neutral grey; colder runs through
  // blue to icy white, hotter through violet, red, orange and yellow to white.
  heat: {
    log: false,
    knots: [
      [-40, '#d4f1ff'], [0, '#2f66d6'], [20, '#4a4d57'], [50, '#74407c'], [100, '#b83a6b'],
      [300, '#ea5a32'], [800, '#ffad2e'], [1500, '#ffe36b'], [2500, '#fffbf0'],
    ],
  },
  // Air pressure (relative to ambient). Diverging: pink/magenta is above
  // ambient, teal below. Log scale on each side.
  pressure: {
    log: true,
    knots: [
      [-100, '#d2fff6'], [-10, '#3fe0cc'], [-1, '#1c9a9c'], [-0.1, '#2b5a63'], [0, '#3c3f47'],
      [0.1, '#5e4063'], [1, '#b0388a'], [10, '#ff5c9a'], [100, '#ffd6e6'],
    ],
  },
  // Flow direction: hue follows the vertical component of the motion.
  flowDir: {
    log: false,
    knots: [[-1, '#4d8dff'], [0, '#3fcf86'], [1, '#ffa83a']],
  },
  // Flow speed in cells per step -> brightness (dim when still, full colour
  // when fast). The shader only uses the positions; the colours are what the
  // UI shows for the "brightness" legend.
  flowSpeed: {
    log: true,
    knots: [[0.04, '#3c3f47'], [0.1, '#6d717a'], [0.3, '#aeb2b9'], [1, '#f4f5f7']],
  },
};

// X-ray: approximate real densities in g/cm³ (bulk density for powders).
// Attenuation per cell scales with density, so metal is nearly solid, water is
// see-through and gases are faint, much like a real radiograph.
export const XRAY_DENSITY = {
  EMPTY: 0, WALL: 2.4, SAND: 1.6, STONE: 2.6, SNOW: 0.3, GUNPOWDER: 1.0, ASH: 0.5,
  WATER: 1.0, OIL: 0.9, ACID: 1.2, LAVA: 2.6, STEAM: 0.02, SMOKE: 0.03, FIRE: 0.01,
  WOOD: 0.6, PLANT: 0.5, METAL: 7.8, GLASS: 2.5, ICE: 0.92, CLONE: 2.0,
};
// Fallback for elements added later without an entry above.
export const xrayDensity = (e) => XRAY_DENSITY[e.key] ?? (e.kind === 1 ? 2.0 : e.dens / 10);

// ---------- legend helpers ----------

const pos = (cm, i) => i / (cm.knots.length - 1);
const stopsOf = (cm) => cm.knots.map(([, c], i) => [+pos(cm, i).toFixed(4), c]);
const labelsAt = (cm, pairs) =>
  pairs.map(([value, text]) => [text, +pos(cm, cm.knots.findIndex(([v]) => v === value)).toFixed(4)]);

/** CSS gradient for a legend ({stops}); `dir` defaults to left-to-right. */
export const legendCSS = (legend, dir = '90deg') =>
  `linear-gradient(${dir}, ${legend.stops.map(([p, c]) => `${c} ${(p * 100).toFixed(2)}%`).join(', ')})`;

/** Legend position (0..1) of a value on a colormap, matching the shader. */
export function colormapPos(cm, x) {
  const k = cm.knots, n = k.length;
  if (x <= k[0][0]) return 0;
  for (let i = 1; i < n; i++) {
    const a = k[i - 1][0], b = k[i][0];
    if (x <= b) {
      const f = cm.log && a * b > 0 ? Math.log(x / a) / Math.log(b / a) : (x - a) / (b - a);
      return (i - 1 + f) / (n - 1);
    }
  }
  return 1;
}

/** sRGB hex colour a colormap assigns to a value (e.g. for a hover swatch). */
export function colormapColor(cm, x) {
  const f = colormapPos(cm, x) * (cm.knots.length - 1);
  const j = Math.min(Math.floor(f), cm.knots.length - 2);
  const t = f - j;
  const rgb = (h) => [0, 2, 4].map((o) => parseInt(h.slice(1 + o, 3 + o), 16));
  const a = rgb(cm.knots[j][1]), b = rgb(cm.knots[j + 1][1]);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function legend(cm, title, labels) {
  const l = { title, stops: stopsOf(cm), labels: labelsAt(cm, labels) };
  l.css = legendCSS(l);
  return l;
}

// X-ray legend: opacity grows with density (ordinal, lightest to densest).
const xrayLegend = {
  title: 'Density',
  stops: [[0, '#15171c'], [0.25, '#2e3139'], [0.5, '#5a5f69'], [0.75, '#9ea3ad'], [1, '#f2f4f7']],
  labels: [['Gas', 0], ['Wood', 0.25], ['Water', 0.5], ['Stone', 0.75], ['Metal', 1]],
};
xrayLegend.css = legendCSS(xrayLegend);

// ---------- the views ----------
// `legend` is null or { title, stops: [[pos 0..1, '#hex'], ...], labels: [[text, pos], ...], css }.
// Labels are always evenly spaced (so a flex row with space-between lines up
// with the bar). Flow also has `legend2`: brightness = speed.
export const VIEWS = [
  {
    id: 0, key: 'realistic', hotkey: '1', name: 'Realistic',
    desc: 'Lit and shaded the way it would look, with shadows, see-through water and glowing hot things.',
    legend: null,
  },
  {
    id: 1, key: 'heat', hotkey: '2', name: 'Heat',
    desc: 'Colors show temperature, from blue below freezing through grey at room temperature to red, yellow and white-hot, and warm air glows faintly.',
    legend: legend(COLORMAPS.heat, 'Temperature (°C)',
      [[-40, '−40'], [20, '20'], [100, '100'], [800, '800'], [2500, '2500']]),
  },
  {
    id: 2, key: 'pressure', hotkey: '3', name: 'Pressure',
    desc: 'Air pressure shows as a cloud, pink where it is higher than normal and teal where it is lower, and surfaces light up where a blast hits them.',
    legend: legend(COLORMAPS.pressure, 'Air pressure',
      [[-100, '−100'], [-1, '−1'], [0, '0'], [1, '+1'], [100, '+100']]),
  },
  {
    id: 3, key: 'flow', hotkey: '4', name: 'Flow',
    desc: 'Moving things light up, brighter the faster they go: blue when falling, green when sliding sideways and amber when rising, with moving air as faint streaks.',
    legend: legend(COLORMAPS.flowDir, 'Direction', [[-1, 'Falling'], [0, 'Sideways'], [1, 'Rising']]),
    legend2: legend(COLORMAPS.flowSpeed, 'Speed (cells/step)', [[0.04, 'Still'], [0.1, '0.1'], [0.3, '0.3'], [1, '1']]),
  },
  {
    id: 4, key: 'xray', hotkey: '5', name: 'X-ray',
    desc: 'Everything turns see-through in its own color, denser materials more solid, so you can look inside piles and containers.',
    legend: xrayLegend,
  },
];
