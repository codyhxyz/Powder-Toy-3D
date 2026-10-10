// CPU checks of the world scenes (src/world/scenes): every scene's GLSL
// compiles (glslangValidator, GLSL ES 3.00) in a pass that calls sceneCell, its
// uniforms are declared, and its params, start and ground make sense for the
// world size. No GPU: fine on battery.
//
//   node tools/check-scenes.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gridLayout } from '../src/sim.js';
import { prelude } from '../src/shaders/common.js';
import { WORLD_SIZE } from '../src/shaders/far.js';
import { WORLD_SCENES } from '../src/world/scenes/index.js';

const WIN = [128, 128, 128];          // the world's window (app.js WORLDS)
const SEED = 1;                       // a world seed
const GROUND_SAMPLES = 64;            // columns per scene that ground() is tried at

const dir = mkdtempSync(join(tmpdir(), 'scenes-'));
const g = { ...gridLayout(...WIN), windowed: true };
let failures = 0;
const fail = (scene, msg) => { failures++; console.log(`FAIL ${scene.key}: ${msg}`); };

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
  for (const name of Object.keys(scene.uniforms(P))) {
    if (!new RegExp(`uniform\\s+\\w+\\s+${name}\\b`).test(glsl)) fail(scene, `uniform ${name} isn't declared in its GLSL`);
  }
  const src = `#version 300 es\n${prelude(g)}\n${glsl}\nout vec4 oC;\nvoid main() {\n  vec4 A, B;\n  sceneCell(ivec3(gl_FragCoord.x, gl_FragCoord.y, int(gl_FragCoord.x) ^ int(gl_FragCoord.y)), A, B);\n  oC = A + B;\n}\n`;
  const f = join(dir, `${scene.key}.frag`);
  writeFileSync(f, src);
  try {
    execFileSync('glslangValidator', [f], { stdio: 'pipe' });
  } catch (e) {
    fail(scene, `GLSL\n${String(e.stdout).split('\n').filter((l) => /ERROR/.test(l)).slice(0, 12).join('\n')}`);
  }
}
console.log(failures ? `${failures} failure(s)` : `all ${WORLD_SCENES.length} scenes OK`);
process.exit(failures ? 1 : 0);
