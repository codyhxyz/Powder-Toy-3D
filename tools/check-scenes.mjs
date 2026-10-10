// CPU checks of the world scenes (src/world/scenes): every scene's GLSL
// compiles (glslangValidator, GLSL ES 3.00) in a pass that calls sceneCell and
// in the world's own passes that include it (the window's fill and diff,
// shaders/generate.js; the far field's build, shaders/far.js), its uniforms
// are declared, and its params, start and ground make sense for the world
// size. No GPU: fine on battery.
//
//   node tools/check-scenes.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gridLayout } from '../src/sim.js';
import { prelude } from '../src/shaders/common.js';
import { WORLD_SIZE, farLayout, farSceneCellsFrag, farSceneFrag } from '../src/shaders/far.js';
import { sceneFillFrag, sceneDiffFrag } from '../src/shaders/generate.js';
import { WORLD_SCENES } from '../src/world/scenes/index.js';

const WIN = [128, 128, 128];          // the world's window (app.js WORLDS)
const SEED = 1;                       // a world seed
const GROUND_SAMPLES = 64;            // columns per scene that ground() is tried at

const dir = mkdtempSync(join(tmpdir(), 'scenes-'));
const g = { ...gridLayout(...WIN), windowed: true };
const L = farLayout(WORLD_SIZE);
let failures = 0;
const fail = (scene, msg) => { failures++; console.log(`FAIL ${scene.key}: ${msg}`); };
// glslangValidator's errors for a fragment shader, or null
function compile(name, src) {
  const f = join(dir, `${name}.frag`);
  writeFileSync(f, src);
  try {
    execFileSync('glslangValidator', [f], { stdio: 'pipe' });
    return null;
  } catch (e) {
    return String(e.stdout).split('\n').filter((l) => /ERROR/.test(l)).slice(0, 12).join('\n');
  }
}
// the far build's summary pass holds no scene GLSL: once
{
  const err = compile('farScene', `#version 300 es\n${farSceneFrag(g, L)}`);
  if (err) { failures++; console.log(`FAIL farSceneFrag\n${err}`); }
}

for (const scene of WORLD_SCENES) {
  const P = scene.params({ size: WORLD_SIZE, seed: SEED });
  for (const k of ['size', 'seed', 'sea', 'floor']) if (P[k] === undefined) fail(scene, `params() has no ${k}`);
  const [sx, sz] = scene.start(P, [WIN[0], WIN[2]]);
  if (!(sx >= 0 && sz >= 0 && sx <= WORLD_SIZE[0] && sz <= WORLD_SIZE[2])) fail(scene, `start() ${sx}, ${sz} is outside the world`);
  for (let i = 0; i < GROUND_SAMPLES; i++) {
    const x = ((i * 7919) % WORLD_SIZE[0]), z = ((i * 104729) % WORLD_SIZE[2]);
    const y = scene.ground(x, z, P);
    if (!(y >= 0 && y <= WORLD_SIZE[1])) { fail(scene, `ground(${x}, ${z}) = ${y}`); break; }
  }
  if (scene.island) continue;   // the island's GLSL is the generator's (tools/check-shaders.mjs)
  const glsl = scene.glsl(g);
  const uniforms = scene.uniforms(P);
  for (const name of Object.keys(uniforms)) {
    if (!new RegExp(`uniform\\s+\\w+\\s+${name}\\b`).test(glsl)) fail(scene, `uniform ${name} isn't declared in its GLSL`);
  }
  // ...and every uniform its GLSL declares has a value (an unset one reads 0), but the prelude's
  const declared = (src) => [...src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    .matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)/g)].map((m) => m[1]);
  const fromPrelude = new Set(declared(prelude(g)));
  for (const name of declared(glsl)) if (!fromPrelude.has(name) && !(name in uniforms)) fail(scene, `its GLSL declares uniform ${name}, but uniforms(P) gives it no value`);
  const passes = {
    sceneCell: `${prelude(g)}\n${glsl}\nout vec4 oC;\nvoid main() {\n  vec4 A, B;\n  sceneCell(ivec3(gl_FragCoord.x, gl_FragCoord.y, int(gl_FragCoord.x) ^ int(gl_FragCoord.y)), A, B);\n  oC = A + B;\n}\n`,
    sceneFill: sceneFillFrag(g, glsl),
    sceneDiff: sceneDiffFrag(g, glsl),
    farSceneCells: farSceneCellsFrag(g, L, glsl),
  };
  for (const [name, src] of Object.entries(passes)) {
    const err = compile(`${scene.key}-${name}`, `#version 300 es\n${src}`);
    if (err) { fail(scene, `GLSL in ${name}\n${err}`); break; }
  }
}
console.log(failures ? `${failures} failure(s)` : `all ${WORLD_SCENES.length} scenes OK`);
process.exit(failures ? 1 : 0);
