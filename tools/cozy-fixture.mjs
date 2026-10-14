// Lightweight fixture for the production artwork. Geometry/light are inputs,
// not a second implementation of the textures or a gameplay screenshot.
import { E, ELEMENTS } from '../src/elements.js';
import { LOOK, SURFS } from '../src/gfx/materials.js';
import { CELL_M } from '../src/scale.js';
import { surfaceGLSL } from '../src/shaders/gfx/surface.js';
import { cozySurfaceWGSL, cozyWaterWGSL } from '../src/shaders/gfx/cozy.js';
import { noiseGLSL } from '../src/shaders/gfx/noise.js';
import { glslMod } from '../src/gpu/wgsl.js';

const surface = surfaceGLSL({});
const definition = (name) => {
  const start = surface.indexOf(`fn ${name}(`);
  if (start < 0) throw new Error(`Missing production function ${name}`);
  let end = surface.indexOf('{', start), depth = 1;
  while (depth && ++end < surface.length) {
    if (surface[end] === '{') depth++;
    if (surface[end] === '}') depth--;
  }
  if (depth) throw new Error(`Unclosed production function ${name}`);
  return surface.slice(start, end + 1);
};
const scalar = n => Number(n).toFixed(8);
const table = (name, type, values) => `
const FIX_${name} = array<${type}, ${values.length}>(${values.join(',')});
fn ${name}(id: i32) -> ${type} { return FIX_${name}[clamp(id, 0, ${values.length - 1})]; }`;

export const cozyFixture = `
${Object.entries(E).map(([name, id]) => `const E_${name}: i32 = ${id};`).join('\n')}
${SURFS.map((name, id) => `const SURF_${name}: i32 = ${id};`).join('\n')}
const R_OPAQUE: i32 = 1;
const CELL_M: f32 = ${scalar(CELL_M)};
${table('RCLASS', 'i32', ELEMENTS.map(e => e.render))}
${table('SURF', 'i32', LOOK.map(l => l.surf))}
${table('ALBEDO', 'vec3f', LOOK.map(l => `vec3f(${l.alb.map(scalar).join(',')})`))}
${[['ROUGH', 'rough'], ['METAL', 'metal'], ['IOR', 'ior'], ['SSS', 'sss'], ['GLINT', 'glint']]
  .map(([name, key]) => table(name, 'f32', LOOK.map(l => scalar(l[key])))).join('\n')}
${surface.match(/struct Mat \{[\s\S]*?\n\}/)[0]}
${surface.match(/const WOOD_TOP_EDGE:[^\n]+/)[0]}
${definition('matBase')}
${definition('woodEndGrain')}
// Stub only the emission inputs; CPU checks prove both hooks reach the output.
var<private> fixtureHeat: vec3f;
var<private> fixtureSpark: vec3f;
fn cellEmission(id: i32, T: f32, ctype: f32) -> vec3f { return fixtureHeat; }
fn sparkEmit(id: i32, ctype: f32) -> vec3f { return fixtureSpark; }
struct FixtureFrame { time: f32 }
var<private> FU: FixtureFrame;
${glslMod}
${noiseGLSL}
${cozySurfaceWGSL}
${cozyWaterWGSL}
`;

export const SWATCHES = [
  ['Wood', E.WOOD, [0, 0, 1]],
  ['End grain', E.WOOD, [0, 1, 0]],
  ['Grass', E.PLANT, [0, 1, 0]],
  ['Leaves', E.PLANT, [0, 0, 1]],
  ['Rock', E.ROCK, [0, 0, 1]],
  ['Sand', E.SAND, [0, 1, 0]],
  ['Brick', E.BRICK, [0, 0, 1]],
  ['Water', E.WATER, [0, 1, 0]],
];

export function swatchCode(size = 144) {
  return `${cozyFixture}
@group(0) @binding(0) var<storage, read_write> pixels: array<vec4f>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let width = ${size * SWATCHES.length}u;
  if (gid.x >= width || gid.y >= ${size}u) { return; }
  let tile = gid.x / ${size}u;
  let uv = (vec2f(f32(gid.x % ${size}u), f32(gid.y)) + 0.5) / ${size}.0;
  let metres = vec2f(uv.x, 1.0 - uv.y) * 3.0 + vec2f(0.31, 0.17);
  let fp = 3.0 / ${size}.0 / CELL_M;
  FU.time = 4.0;
  var colour: vec3f;
  switch tile {
${SWATCHES.map(([, id, n], i) => {
  const p = n[1] ? 'vec3f(metres.x, 0.0, metres.y)' : 'vec3f(metres.x, metres.y, 0.0)';
  return i === SWATCHES.length - 1
    ? `case ${i}u: {
      let paint = cozyWaterPaint(${p} / CELL_M, fp, clamp(1.0 - uv.x * 2.5, 0.0, 1.0));
      let bed = mix(vec3f(0.14, 0.35, 0.31), vec3f(0.015, 0.1, 0.23), uv.x);
      colour = paint.rgb * paint.a + bed * (1.0 - paint.a);
    }`
    : `case ${i}u: { colour = cozyMat(${id}, ${p} / CELL_M, vec3f(${n.join(',')}), 20.0, 0.0, fp).alb * 2.0; }`;
}).join('\n')}
    default: { colour = vec3f(0.0); }
  }
  pixels[gid.y * width + gid.x] = vec4f(colour, 1.0);
}`;
}
