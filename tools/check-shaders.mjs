// CPU-only shader check: assembles every GLSL program the app builds (for
// each grid size) and runs it through glslangValidator as GLSL ES 3.00.
// Catches syntax/type errors without a browser or GPU (not driver quirks).
// usage: node tools/check-shaders.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gridLayout } from '../src/sim.js';
import * as render from '../src/shaders/render.js';
import * as passes from '../src/shaders/passes.js';
import * as fields from '../src/shaders/fields.js';
import * as activity from '../src/shaders/activity.js';
import * as move from '../src/shaders/move.js';
import * as react from '../src/shaders/react.js';
import { quadVert } from '../src/shaders/common.js';
import * as probe from '../src/shaders/probe.js';
import * as stamp from '../src/shaders/stamp.js';
import * as gi from '../src/shaders/gi.js';
import * as transfer from '../src/shaders/transfer.js';

// three.js prefixes: ShaderMaterial (GLSL1-style source upgraded to 300 es)
// and RawShaderMaterial with glslVersion GLSL3.
const shaderMatFrag = `#version 300 es
precision highp float;
precision highp int;
#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define texture2D texture
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
`;
const shaderMatVert = `#version 300 es
precision highp float;
uniform mat4 modelMatrix, modelViewMatrix, projectionMatrix, viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
in vec3 position;
`;
const raw = '#version 300 es\n';

const dir = mkdtempSync(join(tmpdir(), 'glsl-'));
let failures = 0;
function check(name, src, stage) {
  const f = join(dir, `${name}.${stage}`);
  writeFileSync(f, src);
  try {
    execFileSync('glslangValidator', [f], { stdio: 'pipe' });
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n${String(e.stdout).split('\n').filter((l) => /ERROR/.test(l)).slice(0, 12).join('\n')}`);
  }
}

const grids = { '128': [128, 128, 128], wide: [160, 96, 160], '64': [64, 64, 64] };
for (const [label, dims] of Object.entries(grids)) {
  const g = gridLayout(...dims);
  const opt = (fn, ...a) => (typeof fn === 'function' ? fn(g, ...a) : fn);
  check(`volume-${label}`, shaderMatFrag + opt(render.volumeFrag), 'frag');
  check(`pick-${label}`, raw + opt(render.pickFrag), 'frag');
  check(`shadow-${label}`, raw + opt(render.shadowFrag), 'frag');
  for (const [k, v] of Object.entries(passes)) if (typeof v === 'function') check(`${k}-${label}`, raw + v(g), 'frag');
  for (const axis of [0, 1, 2]) check(`brickDist${axis}-${label}`, raw + passes.brickDistFrag(g, axis), 'frag');
  check(`inert-${label}`, raw + activity.inertFrag(g), 'frag');
  check(`quiet-${label}`, raw + activity.quietFrag(g), 'frag');
  check(`fieldEma-${label}`, raw + fields.fieldEmaFrag(g), 'frag');
  check(`fieldBlur-${label}`, raw + fields.fieldBlurFrag(g, false), 'frag');
  check(`fieldFinal-${label}`, raw + fields.fieldBlurFrag(g, true), 'frag');
  for (let stage = 0; stage < fields.BOOST_STAGES; stage++) check(`fieldBoost${stage}-${label}`, raw + fields.fieldBoostFrag(g, stage), 'frag');
  for (const [k, v] of Object.entries({ ...move, ...react, ...probe, ...stamp, ...gi, ...transfer })) if (typeof v === 'function') check(`${k}-${label}`, raw + v(g), 'frag');
}
check('volumeVert', shaderMatVert + render.volumeVert, 'vert');
check('quadVert', raw + quadVert, 'vert');
console.log(failures ? `${failures} shader(s) failed` : 'all shaders OK');
process.exit(failures ? 1 : 0);
