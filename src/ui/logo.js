// The mark: a tiny isometric pile of voxels (sand, stone, water) with one
// lava grain that drops onto the top when the app loads.

const COS = Math.cos(Math.PI / 6), SIN = 0.5;

// Faces of a unit cube at grid (i, j, k): i to the right, k to the left, j up.
function cube(i, j, k, s, [top, left, right], cls = '') {
  const x = (i - k) * COS * s, y = (i + k) * SIN * s - j * s;
  const p = (pts) => pts.map(([a, b]) => `${(x + a).toFixed(2)},${(y + b).toFixed(2)}`).join(' ');
  const w = COS * s, h = SIN * s;
  return `<g class="${cls}">
    <polygon points="${p([[0, -s], [w, -s + h], [0, -s + 2 * h], [-w, -s + h]])}" fill="${top}"/>
    <polygon points="${p([[-w, -s + h], [0, -s + 2 * h], [0, 2 * h], [-w, h]])}" fill="${left}"/>
    <polygon points="${p([[0, -s + 2 * h], [w, -s + h], [w, h], [0, 2 * h]])}" fill="${right}"/>
  </g>`;
}

const SAND = ['#f0d48e', '#c9a35a', '#a9853f'];
const STONE = ['#a3a8b1', '#7d828c', '#656a73'];
const WATER = ['#6fb2f2', '#2f78cc', '#2462ab'];
const LAVA = ['#ffd27a', '#ff7a2a', '#d9541a'];

export function logoMark(size = 30) {
  const s = 7;
  // back-to-front draw order
  // painter's order: back (small i + k) to front, bottom to top
  const cubes = [
    cube(0, 0, 0, s, SAND),
    cube(0, 1, 0, s, SAND),
    cube(1, 0, 0, s, SAND),
    cube(0, 0, 1, s, STONE),
    cube(1, 1, 0, s, LAVA, 'drop'),
    cube(2, 0, 0, s, WATER),
    cube(1, 0, 1, s, SAND),
    cube(2, 0, 1, s, WATER),
  ].join('');
  return `<svg class="mark" width="${size}" height="${size}" viewBox="-13.5 -15.5 33 34" aria-hidden="true">${cubes}</svg>`;
}
