// CPU check: no fragment program the app builds uses more texture units than
// every GPU has. A program over the limit fails to link and the whole view
// goes black ("FRAGMENT shader texture image units count exceeds
// MAX_TEXTURE_IMAGE_UNITS(16)", 2026-10-11: the view hit 17 with whitewater
// on). glslangValidator doesn't count units (tools/check-shaders.mjs passes
// such a program), so this counts them as ANGLE does (tools/sampler-count.mjs)
// for every variant: the view and the shadow map in every combination of the
// close-up detail switches (gfx/detail.js), everything else as built. No GPU,
// no glslang: the deploy runs it (.github/workflows/deploy.yml).
//
//   node tools/check-sampler-budget.mjs
import { gridLayout } from '../src/sim.js';
import * as render from '../src/shaders/render.js';
import * as passes from '../src/shaders/passes.js';
import * as fields from '../src/shaders/fields.js';
import * as activity from '../src/shaders/activity.js';
import * as move from '../src/shaders/move.js';
import * as react from '../src/shaders/react.js';
import * as probe from '../src/shaders/probe.js';
import * as stamp from '../src/shaders/stamp.js';
import * as gi from '../src/shaders/gi.js';
import * as povBody from '../src/shaders/povBody.js';
import * as transfer from '../src/shaders/transfer.js';
import * as povTools from '../src/shaders/povTools.js';
import * as lightning from '../src/shaders/lightning.js';
import * as povTrace from '../src/shaders/povTrace.js';
import * as povKick from '../src/shaders/povKick.js';
import * as povBore from '../src/shaders/povBore.js';
import * as wands from '../src/shaders/wands.js';
import * as generate from '../src/shaders/generate.js';
import * as windowPasses from '../src/shaders/window.js';
import * as far from '../src/shaders/far.js';
import { aerationFrag } from '../src/shaders/gfx/liquidDetail.js';
import { islandGLSL, islandColumnFrag } from '../src/world/scenes/island.js';
import { figureFrag } from '../src/pov/figure.js';
import { probeFrag as birdProbeFrag } from '../src/birds/probe.js';
import { birdFrag } from '../src/birds/render.js';
import { DETAIL } from '../src/gfx/detail.js';
import { samplerUnits } from './sampler-count.mjs';

// MAX_TEXTURE_IMAGE_UNITS: the WebGL 2 minimum (OpenGL ES 3.0 table 6.33),
// and what ANGLE's Metal backend reports on every Mac.
const MAX_TEXTURE_IMAGE_UNITS = 16;

let failures = 0;
let worst = { count: 0 };
function check(name, src, defines = {}) {
  const r = samplerUnits(src, defines);
  if (r.count > worst.count) worst = { ...r, name, defines };
  if (r.count <= MAX_TEXTURE_IMAGE_UNITS) return;
  failures++;
  const d = Object.keys(defines);
  console.log(`FAIL ${name}${d.length ? ` [${d.join(' ')}]` : ''}: ${r.count} texture units > ${MAX_TEXTURE_IMAGE_UNITS}: ${r.samplers.join(' ')}`);
}

// every subset of the detail switches, as three.js material defines
const detailCombos = Array.from({ length: 1 << DETAIL.length }, (_, mask) =>
  Object.fromEntries(DETAIL.filter((_, i) => (mask >> i) & 1).map((f) => [f.define, 1])));

// as app.js builds them: a box and a world's window share one program (check-shaders.mjs)
const L = far.farLayout(far.WORLD_SIZE);
const g = gridLayout(128, 128, 128);
const gw = { ...g, windowed: true };
const volume = render.volumeFrag(g, far.farHazeGLSL);
const shadow = render.shadowFrag(g, far.farCastersGLSL(L));
for (const d of detailCombos) {
  check('volume', volume, d);
  check('shadow', shadow, d);
}

check('pick', render.pickFrag(g));
check('giGather', gi.giGatherFrag(g, far.farGIGLSL(L)));
check('povFigure', figureFrag(g));
check('povFigureMapped', figureFrag(g), { FIG_MAP: 1, FIG_NORMAL_MAP: 1 });
check('birdProbe', birdProbeFrag(g));
check('bird', birdFrag);
check('aeration', aerationFrag(g));
for (const axis of [0, 1, 2]) check(`brickDist${axis}`, passes.brickDistFrag(g, axis));
for (const [k, v] of Object.entries(activity)) if (/Frag$/.test(k) && typeof v === 'function') check(k, v(g));
check('fieldEma', fields.fieldEmaFrag(g));
check('fieldBlur', fields.fieldBlurFrag(g, false));
check('fieldFinal', fields.fieldBlurFrag(g, true));
for (let stage = 0; stage < fields.BOOST_STAGES; stage++) check(`fieldBoost${stage}`, fields.fieldBoostFrag(g, stage));
check('fieldCopy', fields.fieldCopyFrag(g));
for (const [k, v] of Object.entries({ ...passes, ...move, ...react, ...probe, ...stamp, ...gi, ...povBody, ...transfer, ...windowPasses, ...lightning, ...wands })) {
  if (typeof v === 'function' && /Frag$/.test(k) && k !== 'giGatherFrag') check(k, v(g));
}
for (const k of ['axeFrag', 'pickaxeFrag', 'knifeFrag', 'wormFrag', 'wormGiantFrag', 'physgunComFrag', 'physgunFrag', 'blastFrag', 'flamerFrag', 'torchFireFrag', 'bodyFireFrag', 'rocketFrag']) check(k, povTools[k](g));
for (const k of ['traceFrag', 'strikeFrag']) check(k, povTrace[k](g));
for (const k of ['kickFrag', 'hookCellFrag']) check(k, povKick[k](g));
for (const k of ['burrowProbeFrag', 'burrowFrag', 'laserReachFrag', 'laserFrag']) check(k, povBore[k](g));
for (const k of ['sceneFillFrag', 'sceneDiffFrag']) check(`${k}-island`, generate[k](g, islandGLSL()));
// the far field (world mode)
check('farView', far.farFrag(gw, L));
check('farMesh', far.farFrag(gw, L, true));
check('detailCells', far.farSceneCellsFrag(gw, L, islandGLSL(), far.farSceneLayout(L, 40), true));
check('farSceneCells-island', far.farSceneCellsFrag(gw, L, islandGLSL()));
check('farScene-trees', far.farSceneFrag(gw, L, true));
for (const k of ['farTreeBandFrag', 'farWinFrag']) check(k, far[k](gw, L));
check('islandColumns', islandColumnFrag());
for (const k of ['farBoostFrag', 'farMip1Frag', 'farMip2Frag', 'farTopFrag', 'farShadowFrag']) check(k, far[k](L));

const d = Object.keys(worst.defines);
console.log(`most texture units: ${worst.name}${d.length ? ` [${d.join(' ')}]` : ''} ${worst.count}/${MAX_TEXTURE_IMAGE_UNITS} (${worst.samplers.join(' ')})`);
console.log(failures ? `${failures} program variant(s) over the texture unit budget` : 'all programs within the texture unit budget');
process.exit(failures ? 1 : 0);
