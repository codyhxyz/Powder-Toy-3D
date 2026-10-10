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
import { allDetailDefines } from '../src/gfx/detail.js';
import * as probe from '../src/shaders/probe.js';
import * as stamp from '../src/shaders/stamp.js';
import * as gi from '../src/shaders/gi.js';
import * as povBody from '../src/shaders/povBody.js';
import * as transfer from '../src/shaders/transfer.js';
import * as povTools from '../src/shaders/povTools.js';
import * as povTrace from '../src/shaders/povTrace.js';
import * as povKick from '../src/shaders/povKick.js';
import * as generate from '../src/shaders/generate.js';
import { island, islandGLSL, islandColumnFrag } from '../src/world/scenes/island.js';
import * as windowPasses from '../src/shaders/window.js';
import { regionVert } from '../src/gfx/regions.js';
import * as far from '../src/shaders/far.js';
import { figureFrag, figureSkinnedVert } from '../src/pov/figure.js';
import { ShaderChunk } from 'three';

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

// The view, shadow and GI gather as the app and the simulation build them for
// every grid: with a world's far-field parts in, off (shaders/far.js WORLD_SIZE).
const L = far.farLayout(far.WORLD_SIZE);
const appVolume = (g) => render.volumeFrag(g, far.farHazeGLSL);
const appShadow = (g) => render.shadowFrag(g, far.farCastersGLSL(L));
const appGather = (g) => gi.giGatherFrag(g, far.farGIGLSL(L));
const grids = { '128': [128, 128, 128], wide: [160, 96, 160], '64': [64, 64, 64] };
for (const [label, dims] of Object.entries(grids)) {
  const g = gridLayout(...dims);
  check(`volume-${label}`, shaderMatFrag + appVolume(g), 'frag');
  check(`pick-${label}`, raw + render.pickFrag(g), 'frag');
  check(`shadow-${label}`, raw + appShadow(g), 'frag');
  check(`giGather-far-${label}`, raw + appGather(g), 'frag');
  check(`povFigure-${label}`, shaderMatFrag + figureFrag(g), 'frag');
  // the same with every close-up detail feature compiled in (gfx/detail.js)
  const defs = Object.entries(allDetailDefines()).map(([k, v]) => `#define ${k} ${v}\n`).join('');
  if (defs) {
    check(`volume-detail-${label}`, shaderMatFrag + defs + appVolume(g), 'frag');
    check(`shadow-detail-${label}`, raw + defs + appShadow(g), 'frag');
  }
  for (const [k, v] of Object.entries(passes)) if (typeof v === 'function') check(`${k}-${label}`, raw + v(g), 'frag');
  for (const axis of [0, 1, 2]) check(`brickDist${axis}-${label}`, raw + passes.brickDistFrag(g, axis), 'frag');
  check(`inert-${label}`, raw + activity.inertFrag(g), 'frag');
  check(`inertRows-${label}`, raw + activity.inertRowsFrag(g), 'frag');
  check(`inertJoin-${label}`, raw + activity.inertJoinFrag(g), 'frag');
  check(`inertRef-${label}`, raw + activity.inertRefFrag(g), 'frag');
  check(`quiet-${label}`, raw + activity.quietFrag(g), 'frag');
  check(`superMap-${label}`, raw + activity.superMapFrag(g), 'frag');
  check(`superRows-${label}`, raw + activity.superRowsFrag(g), 'frag');
  check(`superShare-${label}`, raw + activity.superShareFrag(g), 'frag');
  for (const ch of Object.values(activity.SUPER_MAP)) {
    for (const block of [false, true]) check(`stepRegionVert${ch}${block ? 'block' : ''}-${label}`, raw + regionVert(activity.stepRegionsGLSL(g, ch, block)), 'vert');
  }
  check(`fieldEma-${label}`, raw + fields.fieldEmaFrag(g), 'frag');
  check(`fieldBlur-${label}`, raw + fields.fieldBlurFrag(g, false), 'frag');
  check(`fieldFinal-${label}`, raw + fields.fieldBlurFrag(g, true), 'frag');
  for (let stage = 0; stage < fields.BOOST_STAGES; stage++) check(`fieldBoost${stage}-${label}`, raw + fields.fieldBoostFrag(g, stage), 'frag');
  check(`fieldCopy-${label}`, raw + fields.fieldCopyFrag(g), 'frag');
  for (const set of Object.values(fields.DIRTY)) check(`fieldRegionVert${set}-${label}`, raw + regionVert(fields.fieldRegionsGLSL(g, set)), 'vert');
  for (const [k, v] of Object.entries({ ...move, ...react, ...probe, ...stamp, ...gi, ...povBody, ...transfer, ...windowPasses })) if (typeof v === 'function') check(`${k}-${label}`, raw + v(g), 'frag');
  for (const k of ['axeFrag', 'pickaxeFrag', 'physgunComFrag', 'physgunFrag', 'blastFrag', 'flamerFrag', 'torchFireFrag', 'rocketFrag']) check(`${k}-${label}`, raw + povTools[k](g), 'frag');
  for (const k of ['traceFrag', 'strikeFrag']) check(`${k}-${label}`, raw + povTrace[k](g), 'frag');
  for (const k of ['kickFrag', 'hookCellFrag']) check(`${k}-${label}`, raw + povKick[k](g), 'frag');
  // the window's fill and diff through a world scene's sceneCell: the island's (every scene's: tools/check-scenes.mjs)
  for (const k of ['sceneFillFrag', 'sceneDiffFrag']) check(`${k}-island-${label}`, raw + generate[k](g, islandGLSL()), 'frag');
}
// the far field (world mode: ?size=world, a 1024×128×1024 world through a 128³ window)
{
  const g = { ...gridLayout(128, 128, 128), windowed: true };
  // a world's window compiles the box's programs, so a switch compiles nothing big (app.js build)
  const box = gridLayout(128, 128, 128);
  for (const [name, fn] of Object.entries({ volume: appVolume, shadow: appShadow, gather: appGather, pick: render.pickFrag })) {
    if (fn(g) !== fn(box)) { failures++; console.log(`FAIL ${name}: a world's window compiles a different program from a box's`); }
  }
  check('farView', shaderMatFrag + far.farFrag(g, L), 'frag');
  check('farViewVert', shaderMatVert + far.farVert, 'vert');
  check('farRegionVert', raw + far.farRegionVert(L), 'vert');
  for (const k of ['farTreeBandFrag', 'farWinFrag']) check(k, raw + far[k](g, L), 'frag');
  // a scene's far build (the island's: it has trees; every scene's: tools/check-scenes.mjs)
  check('farSceneCells-island', raw + far.farSceneCellsFrag(g, L, islandGLSL()), 'frag');
  check('farScene-trees', raw + far.farSceneFrag(g, L, true), 'frag');
  for (const k of ['farTreeCandFrag', 'farTreeThinFrag']) check(`${k}-island`, raw + far[k](g, L, islandGLSL(), island.trees.glsl), 'frag');
  check('islandColumns', raw + islandColumnFrag(), 'frag');
  for (const k of ['farBoostFrag', 'farMip1Frag', 'farMip2Frag', 'farTopFrag', 'farShadowFrag']) check(k, raw + far[k](L), 'frag');
}
check('volumeVert', shaderMatVert + render.volumeVert, 'vert');
check('quadVert', raw + quadVert, 'vert');
// the realistic body's skinned vertex shader, as three builds it for a SkinnedMesh
const includes = (src) => src.replace(/^[ \t]*#include +<(\w+)>/gm, (_, k) => includes(ShaderChunk[k]));
check('figureSkinnedVert', `${shaderMatVert}#define USE_SKINNING\nin vec3 normal;\nin vec4 skinIndex;\nin vec4 skinWeight;\n${includes(figureSkinnedVert)}`, 'vert');
console.log(failures ? `${failures} shader(s) failed` : 'all shaders OK');
process.exit(failures ? 1 : 0);
