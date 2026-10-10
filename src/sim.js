import * as THREE from 'three';
import { quadVert, BRICK, SEED_MAX, TILE, SUPER, SUPER_TEX, SUPER_CELLS, BLOCK_TILE, stateUniforms } from './shaders/common.js';
import {
  inertFrag, inertRowsFrag, inertJoinFrag, quietFrag, activityPeriod, superMapFrag, superRowsFrag, superShareFrag, stepRegionsGLSL,
  SUPER_MAP, SUPER_SETTLE_STEPS, STEP_FULL_SHARE,
} from './shaders/activity.js';
import { moveBlockFrag, moveFlowFrag, moveGatherFrag, SLOTS } from './shaders/move.js';
import { reactFrag } from './shaders/react.js';
import {
  paintFrag, copyFrag, brickFrag, blurFrag, brickDistFrag,
  awakeFrag, ageFrag, dirtyFrag, fieldRegionMapFrag, regionShareFrag,
} from './shaders/passes.js';
import {
  fieldEmaFrag, fieldCopyFrag, fieldBlurFrag, fieldBoostFrag, fieldRegions, fieldRegionsGLSL, BOOST_STAGES, BLUR_TAPS, DIRTY,
} from './shaders/fields.js';
import { giSourceFrag, giGatherFrag } from './shaders/gi.js';
import { farGIGLSL, farLayout, WORLD_SIZE } from './shaders/far.js';
import { shiftFrag, giShiftFrag, flowShiftFrag, undoShiftFrag } from './shaders/window.js';
import { CHANNELS, MEDIA, gauss5, bulkPeak, bulkPeakCubic, CUBIC_LATTICE } from './gfx/materials.js';
import { gfxUniforms } from './gfx/uniforms.js';
import { RegionQuads, regionMaterial } from './gfx/regions.js';

// cells/step² downward (the app's gravity setting overrides it)
const GRAVITY_DEFAULT = 0.025;
// blur passes over the glow volume: x, y, z, twice
const LIGHT_BLUR_PASSES = 6;

// Steps an activity map stays valid (shaders/activity.js).
const ACTIVITY_PERIOD = activityPeriod(BRICK);

// The state atlas may be at most this many times wider than tall (atlasColumns).
const ATLAS_ASPECT_MAX = 4;

// A box of bricks (or supertiles) none is in (no write touched any): lo > hi.
const TOUCH_NONE_LO = 2 ** 30, TOUCH_NONE_HI = -1;
// Cells per supertile along x, y, z (shaders/common.js SUPER_CELLS), indexed like a cell's [x, y, z].
const SUPER_SIDE = [SUPER_CELLS.x, SUPER_CELLS.y, SUPER_CELLS.z];
// Cells added around a box of cell centres in the box a write declares
// (touchCentres(): the brush, the first-person body and physgun): the centres
// sit half a cell off the grid, so this covers them with room.
const TOUCH_MARGIN = 1;

// Supertiles per state-atlas row: the smallest divisor of their count from its
// square root up, so the atlas is near square and every texel holds a cell
// (all the app's grid sizes). If that would make it more than ATLAS_ASPECT_MAX
// times wider than tall, a square atlas whose last row is partly empty.
function atlasColumns(count) {
  const root = Math.ceil(Math.sqrt(count));
  let w = root;
  while (count % w) w++;
  return w * w <= ATLAS_ASPECT_MAX * count ? w : root;
}

export function gridLayout(nx, ny, nz) {
  if (nx % SUPER_CELLS.x || ny % SUPER_CELLS.y || nz % SUPER_CELLS.z) {
    throw new Error(`grid ${nx}×${ny}×${nz}: sides must be multiples of ${SUPER_CELLS.x}×${SUPER_CELLS.y}×${SUPER_CELLS.z} (a supertile)`);
  }
  // state atlas (brick-major, shaders/common.js): supertiles row-major
  const stx = nx / SUPER_CELLS.x, sty = ny / SUPER_CELLS.y, stz = nz / SUPER_CELLS.z;
  const stw = atlasColumns(stx * sty * stz);
  const sth = Math.ceil((stx * sty * stz) / stw);
  // render-field atlas: Y-slices, ftx per row
  const ftx = Math.ceil(Math.sqrt((ny * nz) / nx));
  const fty = Math.ceil(ny / ftx);
  const bx = nx / BRICK, by = ny / BRICK, bz = nz / BRICK;
  const btx = Math.ceil(Math.sqrt((by * bz) / bx));
  const bty = Math.ceil(by / btx);
  // Margolus blocks (2×2×2, partition offset 0 or 1): the block atlas
  // (shaders/common.js BLOCK_TILE), the state's supertile grid at one tile per
  // brick, then rows for the low-margin blocks of offset 1 (N/2 + 1 per axis
  // then, N/2 at offset 0).
  const mwidth = stw * SUPER.x * BLOCK_TILE.x, mmainh = sth * SUPER.z * SUPER.y * BLOCK_TILE.y;
  const margin = (nx / 2 + 1) * (ny / 2 + 1) * (nz / 2 + 1) - (nx / 2) * (ny / 2) * (nz / 2);
  return {
    nx, ny, nz, stx, sty, stz, stw, ftx, btx, bty,
    width: stw * SUPER_TEX, height: sth * SUPER_TEX,
    fwidth: ftx * nx, fheight: fty * nz,
    bwidth: btx * bx, bheight: bty * bz,
    mwidth, mmainh, mheight: mmainh + Math.ceil(margin / mwidth),
    maxSteps: nx + ny + nz + 8,
  };
}

// JS mirror of atlas() and cellFromFrag() (shaders/common.js), for CPU code
// that builds or reads the state: the index of cell (x, y, z)'s texel in a
// width × height state texture (× 4 for its RGBA floats), and back ([x, y, z],
// or null for a texel past the last supertile, which holds no cell).
export function cellTexel(g, x, y, z) {
  const bx = Math.floor(x / BRICK), by = Math.floor(y / BRICK), bz = Math.floor(z / BRICK);   // brick
  const sx = Math.floor(bx / SUPER.x), sy = Math.floor(by / SUPER.y), sz = Math.floor(bz / SUPER.z);   // supertile
  const i = sx + g.stx * (sz + g.stz * sy);   // supertile number
  const ly = y - by * BRICK;
  const u = (i % g.stw) * SUPER_TEX + (bx - sx * SUPER.x) * TILE + (x - bx * BRICK) + BRICK * (ly & 1);
  const v = Math.floor(i / g.stw) * SUPER_TEX + (bz - sz * SUPER.z + SUPER.z * (by - sy * SUPER.y)) * TILE
    + (z - bz * BRICK) + BRICK * (ly >> 1);
  return v * g.width + u;
}
export function texelCell(g, t) {
  const u = t % g.width, v = Math.floor(t / g.width);
  const su = Math.floor(u / SUPER_TEX), sv = Math.floor(v / SUPER_TEX);   // supertile slot
  const i = su + g.stw * sv;
  if (i >= g.stx * g.sty * g.stz) return null;
  const sx = i % g.stx, sz = Math.floor(i / g.stx) % g.stz, sy = Math.floor(i / (g.stx * g.stz));
  const tu = u - su * SUPER_TEX, tv = v - sv * SUPER_TEX;   // texel in the supertile
  const ku = Math.floor(tu / TILE), kv = Math.floor(tv / TILE);   // brick tile
  const lu = tu - ku * TILE, lv = tv - kv * TILE;           // texel in the tile
  return [
    (sx * SUPER.x + ku) * BRICK + (lu % BRICK),
    (sy * SUPER.y + Math.floor(kv / SUPER.z)) * BRICK + (Math.floor(lu / BRICK) | (Math.floor(lv / BRICK) << 1)),
    (sz * SUPER.z + (kv % SUPER.z)) * BRICK + (lv % BRICK),
  ];
}

// JS mirror of brickAtlas() (shaders/common.js): the index of brick (bx, by,
// bz)'s texel in the brick-resolution targets (bwidth × bheight).
export function brickTexel(g, bx, by, bz) {
  const BX = g.nx / BRICK, BZ = g.nz / BRICK;
  return (Math.floor(by / g.btx) * BZ + bz) * g.bwidth + (by % g.btx) * BX + bx;
}

function makeTarget(w, h, count = 2) {
  return new THREE.WebGLRenderTarget(w, h, {
    count,
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

// A copy of the state: A and B (RGBA32F), and the activity flags (R8UI, one
// byte per cell: shaders/common.js FLAG).
const STATE_FLAGS = 2;   // attachment index of the flags
function makeStateTarget(w, h) {
  const t = makeTarget(w, h, STATE_FLAGS + 1);
  t.textures[STATE_FLAGS].format = THREE.RedIntegerFormat;
  t.textures[STATE_FLAGS].type = THREE.UnsignedByteType;
  return t;
}

export function makeFieldTarget(w, h, count, type, filter) {
  return new THREE.WebGLRenderTarget(w, h, {
    count, type, format: THREE.RGBAFormat, minFilter: filter, magFilter: filter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}

export function rawMat(frag, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: quadVert,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

// Uniforms of the GI passes (shaders/gi.js); the probe textures are rebound per frame.
const giUniforms = () => ({
  tA: { value: null }, tBrick: { value: null }, tShadow: { value: null }, uShadowRes: { value: 1 },
  uShadows: { value: true }, uSun: { value: new THREE.Vector3(0, 1, 0) },
  // sky values (computed per frame by updateGfxUniforms)
  uSunExt: gfxUniforms.uSunExt, uSunCol: gfxUniforms.uSunCol, uSkyUp: gfxUniforms.uSkyUp, uGround: gfxUniforms.uGround,
  uKeyLight: gfxUniforms.uKeyLight,
});
const giProbeUniforms = () => Object.fromEntries([0, 1, 2, 3].map((i) => [`tGI${i}`, { value: null }]));

// Share of each step's displacements blended into the flow field (the rest is
// history): grains move a cell on some steps and not others, so the field
// averages their speed over about 1 / FLOW_BLEND steps.
const FLOW_BLEND = 0.05;

// Share of each update's new GI probes blended into the probe volume (the rest
// is history): smooths cells popping between bricks over a few frames. Each
// probe is updated every other frame.
export const GI_BLEND = 0.4;

const fieldBlurUniforms = () => ({
  t0: { value: null }, t1: { value: null }, t2: { value: null }, uAxis: { value: 0 },
  uW: { value: [...Array(BLUR_TAPS)].map(() => new THREE.Vector4()) },
});

let nextSimId = 0;

// Every simulation's uOrigin uniform (run): a pass kept across grids, made for
// an older simulation of the same size (a tool's), takes the current one's.
const simOrigins = new WeakSet();

// GPU simulation driver: owns the state ping-pong targets and runs passes.
export class Simulation {
  // windowed: the grid is a window of a larger world (docs/scaling.md D11; app.js World)
  constructor(renderer, nx, ny, nz, { windowed = false } = {}) {
    this.renderer = renderer;
    this.id = nextSimId++;   // tells a rebuilt simulation from the old one
    this.g = gridLayout(nx, ny, nz);
    this.g.windowed = windowed;   // a window of a larger world (for the app: every shader compiles the same either way)
    const g = this.g;
    this.frame = 0;
    this.paints = 0;   // brush strokes applied (the paint pass's random stream)
    this.gravity = GRAVITY_DEFAULT;
    // bumped by every write to the state (steps, painting, loads, undo, network
    // updates), so callers can tell when the world changed
    this.version = 0;

    this.targets = [makeStateTarget(g.width, g.height), makeStateTarget(g.width, g.height)];
    this.cur = 0;
    // The block pass's results: slot i of every block in layer i of one array
    // texture (shaders/move.js slotGLSL). three.js gives a multi-target its own
    // textures, so the block pass draws into this.blocks, whose colour
    // attachments are pointed at the slot layers (attachSlots).
    this.slots = new THREE.WebGLArrayRenderTarget(g.mwidth, g.mheight, SLOTS, {
      type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.blocks = makeTarget(g.mwidth, g.mheight, SLOTS);
    this.attachSlots();
    this.brick = makeTarget(g.bwidth, g.bheight, 1);
    this.light = [makeTarget(g.bwidth, g.bheight, 1), makeTarget(g.bwidth, g.bheight, 1)];
    // render fields (see shaders/fields.js): the EMA (kept from frame to frame)
    // and two scratch targets for the blur and boost in RGBA8, the blurred
    // fields in half floats, the boosted final fields (and the thin-feature
    // mask) in filterable half floats
    const U8 = THREE.UnsignedByteType, NEAR = THREE.NearestFilter, HALF = THREE.HalfFloatType;
    // (all in the field atlas: Y-slices, fwidth × fheight)
    this.fieldEma = makeFieldTarget(g.fwidth, g.fheight, 3, U8, NEAR);
    this.fieldTmp = [makeFieldTarget(g.fwidth, g.fheight, 3, U8, NEAR), makeFieldTarget(g.fwidth, g.fheight, 3, U8, NEAR)];
    this.fieldsBlurred = makeFieldTarget(g.fwidth, g.fheight, 2, HALF, NEAR);
    this.fields = makeFieldTarget(g.fwidth, g.fheight, 3, HALF, THREE.LinearFilter);
    // how fast matter has been moving through each cell (shaders/move.js moveFlowFrag);
    // read with atlas(), so it shares the state's texel layout and size
    this.flowV = makeFieldTarget(g.width, g.height, 1, HALF, NEAR);
    this.fieldReset = true;
    this.smoothing = 1;
    // GI (shaders/gi.js): per-brick light sources and blockers, and the probe
    // volume (L1 spherical harmonics, filterable for trilinear lookups)
    this.giSrc = makeFieldTarget(g.bwidth, g.bheight, 3, HALF, NEAR);
    this.giProbes = makeFieldTarget(g.bwidth, g.bheight, 4, HALF, THREE.LinearFilter);
    this.giReset = true;
    // activity map (shaders/activity.js): inert bricks, then the quiet ones the
    // step passes skip. Rebuilt every ACTIVITY_PERIOD steps and after any
    // write that isn't a step (painting, loads), which may wake a brick.
    // empty-space distance per brick (shaders/passes.js brickDistFrag), and its scratch
    this.brickDist = [makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR), makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR)];
    // (built in passes: per-brick decisions from the activity flags, the
    // re-tests of the bricks they leave open, row by row, then the join)
    this.actClass = makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR);
    this.actRows = makeFieldTarget(g.bwidth * BRICK, g.bheight * BRICK, 1, U8, NEAR);
    this.actInert = makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR);
    this.actQuiet = makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR);
    this.actAge = ACTIVITY_PERIOD;
    this.actDirty = true;
    this.actFresh = false;   // the next step is the first since a map was built (its dirty marks start over)
    this.actSteps = 0;       // steps that used the current map
    this.stepping = false;
    this.skipQuiet = true;   // false: step every brick (A/B testing)
    // Sleeping supertiles (docs/scaling.md D8, shaders/activity.js SUPER_MAP):
    // with each activity map, which supertiles each step pass draws (ping-pong:
    // a map reads the last one), and the share of them on per channel. The step
    // passes draw a quad per supertile (stepQuads), or one full-screen quad.
    const supers = g.stx * g.sty * g.stz;
    this.superMap = [0, 1].map(() => makeFieldTarget(g.stw, g.height / SUPER_TEX, 1, U8, NEAR));
    this.superCur = 0;
    this.superRows = makeFieldTarget(g.height / SUPER_TEX, 1, 1, THREE.FloatType, NEAR);   // (counts per row of the map)
    this.superShare = makeFieldTarget(1, 1, 1, THREE.FloatType, NEAR);
    this.stepQuads = new RegionQuads(supers + 1);   // (the last region: the block atlas's low margin)
    this.skipSleeping = true;   // false: draw every supertile (A/B testing)
    // Writes that aren't steps since the last map: their supertiles are drawn
    // by the next map's steps (noteWrite). All of them, or a box (inclusive).
    this.forceAll = true;
    this.forceLo = [TOUCH_NONE_LO, TOUCH_NONE_LO, TOUCH_NONE_LO];
    this.forceHi = [TOUCH_NONE_HI, TOUCH_NONE_HI, TOUCH_NONE_HI];
    this.wroteSinceStep = false;   // a write that isn't a step came after the last step
    // Incremental derived passes (docs/scaling.md D9, shaders/passes.js
    // dirtyFrag): the bricks the state may have changed in since the last
    // updateBricks (every quiet map a step used, as 1 - quiet: the first
    // overwrites, the rest blend with MAX; writes that aren't steps add
    // changedAll or a touched box), each
    // brick's age in frames since it last changed (ping-pong), the dirty sets
    // derived from that, and per region of the field atlas, with their shares.
    const fr = fieldRegions(g);
    this.actChanged = makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR);
    this.brickAge = [makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR), makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR)];
    this.ageCur = 0;
    this.dirty = makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR);
    this.regionMap = makeFieldTarget(fr.mapWidth, fr.mapHeight, 1, U8, NEAR);
    this.regionShare = makeFieldTarget(1, 1, 1, THREE.FloatType, NEAR);
    this.fieldQuads = new RegionQuads(fr.count);
    this.changedAll = true;
    this.touchLo = [TOUCH_NONE_LO, TOUCH_NONE_LO, TOUCH_NONE_LO];   // bricks, inclusive
    this.touchHi = [TOUCH_NONE_HI, TOUCH_NONE_HI, TOUCH_NONE_HI];
    this.touchNext = null;   // the box the next write that isn't a step declared (touch())
    this.actCarry = null;    // actAge at the last updateBricks while that quiet map is current
    this.actNoted = false;   // actChanged holds a quiet map noted since the last updateBricks
    this.lastSmoothing = null;
    this.incremental = true;   // false: rebuild every brick every frame (A/B testing)

    // The grid is a window of the world (docs/scaling.md D11): origin is the
    // world cell of grid cell (0, 0, 0), the prelude's uOrigin in every pass
    // (run). A grid that is its whole world stays at 0; shift() moves it.
    this.origin = new THREE.Vector3();
    this.originUniform = { value: this.origin };
    simOrigins.add(this.originUniform);
    // grid cells the window moved since the render fields last updated (their history follows)
    this.fieldShift = new THREE.Vector3();
    // false: a shift starts the render fields and GI over instead of moving their history (A/B)
    this.shiftKeepsHistory = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const state = stateUniforms;
    // the block pass's results, as passes that read them per cell take them (shaders/move.js slotGLSL)
    const slots = () => ({ uParity: { value: 0 }, tSlots: { value: null } });
    // field passes draw over the regions of their dirty set (gfx/regions.js)
    const regionU = { tRegion: { value: this.regionMap.texture }, tShare: { value: this.regionShare.texture } };
    const fieldMat = (frag, uniforms, set) => regionMaterial(this.fieldQuads, frag, fieldRegionsGLSL(g, set), { ...uniforms, ...regionU });
    // step passes draw over the supertiles on in channel ch of the supertile map
    // (over the block atlas: block); tSuper follows the map's ping-pong
    this.superU = {
      tSuper: { value: this.superMap[this.superCur].texture }, tSuperShare: { value: this.superShare.texture },
      uFullShare: { value: STEP_FULL_SHARE },   // (a tool may move it: A/B and measuring the crossover)
    };
    const stepMat = (frag, uniforms, ch, block = false) => regionMaterial(this.stepQuads, frag, stepRegionsGLSL(g, ch, block), { ...uniforms, ...this.superU });
    this.mats = {
      moveBlock: stepMat(moveBlockFrag(g), {
        ...state(), uParity: { value: 0 }, uFrame: { value: 0 }, uGravity: { value: this.gravity }, tQuiet: { value: null },
      }, SUPER_MAP.BLOCKS, true),
      moveGather: stepMat(moveGatherFrag(g), { ...state(), ...slots(), tQuiet: { value: null }, uFresh: { value: false } }, SUPER_MAP.DRAWN),
      react: stepMat(reactFrag(g), { ...state(), uFrame: { value: 0 }, uGravity: { value: this.gravity }, tQuiet: { value: null } }, SUPER_MAP.DRAWN),
      inert: rawMat(inertFrag(g), { tF: { value: null } }),
      inertRows: rawMat(inertRowsFrag(g), { tA: { value: null }, tF: { value: null }, tClass: { value: null } }),
      inertJoin: rawMat(inertJoinFrag(g), { tClass: { value: null }, tRows: { value: null } }),
      quiet: rawMat(quietFrag(g), { tInert: { value: null }, uEnabled: { value: true } }),
      superMap: rawMat(superMapFrag(g), {
        tQuiet: { value: this.actQuiet.texture }, tPrev: { value: null }, uPrevSettled: { value: false },
        uForceAll: { value: true }, uForceLo: { value: new THREE.Vector3() }, uForceHi: { value: new THREE.Vector3() },
      }),
      superRows: rawMat(superRowsFrag(g), { tSuper: { value: null } }),
      superShare: rawMat(superShareFrag(g), { tRows: { value: this.superRows.texture } }),
      paint: rawMat(paintFrag(g), {
        ...state(), uFrame: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uRadius: { value: 4 },
        uShape: { value: 0 }, uTool: { value: 2 }, uRate: { value: 1 }, uReplace: { value: false },
      }),
      copy: rawMat(copyFrag(g), state()),
      moveFlow: stepMat(moveFlowFrag(g), { ...slots(), tQuiet: { value: null } }, SUPER_MAP.STEPS),
      brick: rawMat(brickFrag(g), {
        tA: { value: null }, tB: { value: null }, tFS: { value: null }, tFM: { value: null }, tFT: { value: null },
        tDirty: { value: this.dirty.texture },
      }),
      fieldEma: fieldMat(fieldEmaFrag(g), {
        tA: { value: null }, tP0: { value: null }, tP1: { value: null },
        uEmaS: { value: new THREE.Vector4() }, uEmaM: { value: new THREE.Vector4() }, uShift: { value: new THREE.Vector3() },
      }, DIRTY.EMA),
      fieldCopy: fieldMat(fieldCopyFrag(), { t0: { value: null }, t1: { value: null }, t2: { value: null } }, DIRTY.EMA),
      fieldBlur: fieldMat(fieldBlurFrag(g, false), fieldBlurUniforms(), DIRTY.WORK),
      fieldFinal: fieldMat(fieldBlurFrag(g, true), fieldBlurUniforms(), DIRTY.WORK),
      fieldBoost: [...Array(BOOST_STAGES).keys()].map((stage) => fieldMat(fieldBoostFrag(g, stage), {
        tA: { value: null }, t0: { value: null }, t1: { value: null }, tPhi: { value: null }, tMed: { value: null },
        uS: { value: new THREE.Vector4(...CHANNELS.map((c) => (c.cubic ? CUBIC_LATTICE[1] : 1))) },
        uBulk: { value: new THREE.Vector4() }, tDirty: { value: this.dirty.texture },
      }, stage === BOOST_STAGES - 1 ? DIRTY.FIELDS : DIRTY.WORK)),
      awake: rawMat(awakeFrag(), { tQuiet: { value: this.actQuiet.texture } }),
      age: rawMat(ageFrag(g), {
        tAge: { value: null }, tChanged: { value: this.actChanged.texture }, uSteps: { value: false }, uAll: { value: true },
        uTouchLo: { value: new THREE.Vector3() }, uTouchHi: { value: new THREE.Vector3() },
      }),
      dirty: rawMat(dirtyFrag(g), { tAge: { value: null } }),
      regionMap: rawMat(fieldRegionMapFrag(g), { tDirty: { value: this.dirty.texture } }),
      regionShare: rawMat(regionShareFrag(g), { tRegion: { value: this.regionMap.texture } }),
      blur: rawMat(blurFrag(g), { tSrc: { value: null }, uAxis: { value: 0 } }),
      brickDist: [0, 1, 2].map((axis) => rawMat(brickDistFrag(g, axis), { tSrc: { value: null } })),
      giSource: rawMat(giSourceFrag(g), { ...giUniforms(), ...giProbeUniforms() }),
      // the far field's part is in for a box too, off (shaders/far.js WORLD_SIZE; world/far.js attach turns it on)
      giGather: rawMat(giGatherFrag(g, farGIGLSL(farLayout(WORLD_SIZE))), {
        ...giUniforms(), tGIRad: { value: null }, tGICov: { value: null }, tGIDir: { value: null },
        uParity: { value: -1 },
        uFar: { value: false }, tFar: { value: null }, tFarTop: { value: null }, tFarShadow: { value: null }, uSea: { value: 0 },
      }),
    };
    // the flow pass blends into the flow field: new * FLOW_BLEND + old * (1 - FLOW_BLEND)
    Object.assign(this.mats.moveFlow, {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor, blendAlpha: FLOW_BLEND,
    });
    // the gather blends into the probe volume: new * GI_BLEND + old * (1 - GI_BLEND)
    Object.assign(this.mats.giGather, {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor,
    });
    // awake bricks accumulate into the changed map: max(old, new) (noteAwake)
    this.mats.awake.blendEquation = THREE.MaxEquation;
    // pass names (the profiler's labels): the key, plus the stage for staged passes (fieldBoost0…)
    for (const [key, m] of Object.entries(this.mats)) {
      if (Array.isArray(m)) m.forEach((stage, i) => { stage.name = `${key}${i}`; });
      else m.name = key;
    }
    // profiling hook (gfx/profiler.js): onPass(name, target) after every pass
    this.onPass = null;
    this.clear();
  }

  // Point the block pass's colour attachments (this.blocks) at the layers of
  // this.slots, and shrink the block target's own textures, which nothing
  // draws into or reads.
  attachSlots() {
    const r = this.renderer, gl = r.getContext(), keep = r.getRenderTarget();
    r.initRenderTarget(this.slots);
    r.initRenderTarget(this.blocks);
    const layers = r.properties.get(this.slots.texture).__webglTexture;
    r.state.bindFramebuffer(gl.FRAMEBUFFER, r.properties.get(this.blocks).__webglFramebuffer);
    for (let i = 0; i < SLOTS; i++) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, layers, 0, i);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('block pass: slot layers not attachable');
    for (const t of this.blocks.textures) {
      r.state.bindTexture(gl.TEXTURE_2D, r.properties.get(t).__webglTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
    }
    r.state.unbindTexture();
    r.setRenderTarget(keep);
  }

  get stateA() { return this.targets[this.cur].textures[0]; }
  get stateB() { return this.targets[this.cur].textures[1]; }
  get stateF() { return this.targets[this.cur].textures[STATE_FLAGS]; }
  // A target shaped like the state (its attachments and formats), for code
  // that draws a state pass somewhere else (e.g. once, to build its pipeline).
  makeStateTarget(w, h) { return makeStateTarget(w, h); }

  // Index of cell (x, y, z)'s texel in the state arrays, and back (cellTexel, texelCell).
  cellTexel(x, y, z) { return cellTexel(this.g, x, y, z); }
  texelCell(i) { return texelCell(this.g, i); }

  // The current state read back, as float RGBA per atlas texel in the
  // fetchA/fetchB layout (what load() takes): [A, B]. For CPU checks and
  // tools; cellTexel finds a cell in it.
  readState() {
    const { width, height } = this.g;
    const t = this.targets[this.cur];
    const a = new Float32Array(width * height * 4), b = new Float32Array(width * height * 4);
    this.renderer.readRenderTargetPixels(t, 0, 0, width, height, a, undefined, 0);
    this.renderer.readRenderTargetPixels(t, 0, 0, width, height, b, undefined, 1);
    return [a, b];
  }

  // One cell of the current state, read back: [a, b] in the fetchA/fetchB
  // layout (two RGBA float arrays). Synchronous; for tests and tools.
  readCell(x, y, z) {
    const i = this.cellTexel(x, y, z), w = this.g.width;
    const t = this.targets[this.cur];
    const a = new Float32Array(4), b = new Float32Array(4);
    this.renderer.readRenderTargetPixels(t, i % w, Math.floor(i / w), 1, 1, a, undefined, 0);
    this.renderer.readRenderTargetPixels(t, i % w, Math.floor(i / w), 1, 1, b, undefined, 1);
    return [a, b];
  }

  // Block until the GPU has done everything queued so far, by reading one
  // texel of the current state back (wall-clock timing of GPU work).
  gpuSync() {
    this.syncTexel ??= new Float32Array(4);
    this.renderer.readRenderTargetPixels(this.targets[this.cur], 0, 0, 1, 1, this.syncTexel, undefined, 0);
  }

  // A pass into target: one full-screen quad, or quads (gfx/regions.js
  // RegionQuads) over the regions its material picks. Every pass sees the
  // window's origin (shaders/common.js uOrigin), unless it brings its own; a
  // pass kept across grids takes the current simulation's (simOrigins).
  run(mat, target, quads = null) {
    const o = mat.uniforms.uOrigin;
    if (!o || simOrigins.has(o)) mat.uniforms.uOrigin = this.originUniform;
    const mesh = quads ? quads.mesh : this.quad;
    mesh.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(quads ? quads.scene : this.scene, this.camera);
    this.onPass?.(mat.name, target);
    const touched = this.touchNext;   // (for this pass only)
    this.touchNext = null;
    if (target === this.targets[0] || target === this.targets[1]) {
      this.version++;
      if (!this.stepping) {
        this.actDirty = true;
        this.noteWrite(touched);
      }
    }
  }

  // The next pass, a write to the state that isn't a step (run outside
  // step()), changes only cells in [lo, hi] (inclusive; [x, y, z] arrays), so
  // the derived passes rebuild only the bricks there, and only the supertiles
  // there are woken for the next activity map's steps (noteWrite). Without it
  // such a write rebuilds every brick and wakes every supertile. The pass must
  // copy every cell outside the box through unchanged, flags and all (as
  // shaders/common.js copyThroughMain does): sleeping supertiles count on both
  // state copies holding the same there.
  touch(lo, hi) {
    this.touchNext = { lo, hi };
  }

  // touch() for a pass that changes only cells whose centres lie in the box
  // [lo, hi] (grid cells, any reals; [x, y, z] arrays).
  touchCentres(lo, hi) {
    this.touch(lo.map((x) => Math.floor(x) - TOUCH_MARGIN), hi.map((x) => Math.floor(x) + TOUCH_MARGIN));
  }

  // A write that isn't a step: the box it declared changed, or every brick.
  // The derived passes rebuild those bricks (D9), and the next activity map's
  // steps draw those supertiles even where they sleep (D8): the write may have
  // left the two state copies different there, or flags the steps settle
  // (shaders/activity.js SUPER_MAP).
  noteWrite(t) {
    this.wroteSinceStep = true;
    if (!t) {
      this.changedAll = true;
      this.forceAll = true;
      return;
    }
    for (let k = 0; k < 3; k++) {
      this.touchLo[k] = Math.min(this.touchLo[k], Math.floor(t.lo[k] / BRICK));
      this.touchHi[k] = Math.max(this.touchHi[k], Math.floor(t.hi[k] / BRICK));
      this.forceLo[k] = Math.min(this.forceLo[k], Math.floor(t.lo[k] / SUPER_SIDE[k]));
      this.forceHi[k] = Math.max(this.forceHi[k], Math.floor(t.hi[k] / SUPER_SIDE[k]));
    }
  }

  // The bricks the current quiet map doesn't skip may change: note them in the
  // changed map, over what it holds unless it was consumed since.
  noteAwake() {
    this.mats.awake.blending = this.actNoted ? THREE.CustomBlending : THREE.NoBlending;
    this.run(this.mats.awake, this.actChanged);
    this.actNoted = true;
  }

  // Rebuild the activity map from the current state's activity flags (shaders/activity.js).
  updateActivity() {
    // the outgoing map, if steps used it since the last updateBricks noted it
    if (this.actCarry !== null && this.actAge > this.actCarry) this.noteAwake();
    this.actCarry = null;
    const { inert, inertRows, inertJoin, quiet } = this.mats;
    inert.uniforms.tF.value = this.stateF;
    this.run(inert, this.actClass);
    inertRows.uniforms.tA.value = this.stateA;
    inertRows.uniforms.tF.value = this.stateF;
    inertRows.uniforms.tClass.value = this.actClass.texture;
    this.run(inertRows, this.actRows);
    inertJoin.uniforms.tClass.value = this.actClass.texture;
    inertJoin.uniforms.tRows.value = this.actRows.texture;
    this.run(inertJoin, this.actInert);
    quiet.uniforms.tInert.value = this.actInert.texture;
    quiet.uniforms.uEnabled.value = this.skipQuiet;
    this.run(quiet, this.actQuiet);
    this.actAge = 0;
    this.actDirty = false;
    this.actFresh = true;
    this.noteAwake();   // the step about to run uses it
    // the supertiles its steps draw: from this map, the last one and the
    // writes since (shaders/activity.js SUPER_MAP), and their shares
    const { superMap, superRows, superShare } = this.mats, u = superMap.uniforms;
    u.tPrev.value = this.superMap[this.superCur].texture;
    u.uPrevSettled.value = this.actSteps >= SUPER_SETTLE_STEPS || (this.actSteps > 0 && this.wroteSinceStep);
    u.uForceAll.value = this.forceAll;
    u.uForceLo.value.fromArray(this.forceLo);
    u.uForceHi.value.fromArray(this.forceHi);
    this.superCur = 1 - this.superCur;
    this.run(superMap, this.superMap[this.superCur]);
    this.superU.tSuper.value = superRows.uniforms.tSuper.value = this.superMap[this.superCur].texture;
    this.run(superRows, this.superRows);
    this.run(superShare, this.superShare);
    this.forceAll = false;
    this.forceLo.fill(TOUCH_NONE_LO);
    this.forceHi.fill(TOUCH_NONE_HI);
    this.actSteps = 0;
  }

  // Ping-pong pass over the state. The pass writes every cell, flags and all
  // (shaders/common.js stateOutGLSL), so it needs stateUniforms(); with quads
  // (a step's passes), every cell of the supertiles they draw (run).
  pass(mat, quads = null) {
    if (!mat.uniforms.tF) throw new Error(`pass ${mat.name || '(unnamed)'}: a state writer needs stateUniforms() (tF)`);
    mat.uniforms.tA.value = this.stateA;
    mat.uniforms.tB.value = this.stateB;
    mat.uniforms.tF.value = this.stateF;
    this.run(mat, this.targets[1 - this.cur], quads);
    this.cur = 1 - this.cur;
  }

  step() {
    this.frame++;
    if (this.actDirty || this.actAge >= ACTIVITY_PERIOD) this.updateActivity();
    this.actAge++;
    this.actSteps++;
    this.wroteSinceStep = false;
    this.stepping = true;
    const { moveBlock, moveFlow, moveGather, react } = this.mats;
    const parity = this.frame & 1;
    // each pass draws only the supertiles the map's steps can change (the
    // supertile map), or one full-screen quad
    const quads = this.stepQuads;
    quads.fullOnly = !this.skipSleeping;
    // movement: solve each 2×2×2 block once (moveBlock), then every cell
    // gathers its result (moveGather) and the flow field takes its move
    for (const m of [moveBlock, moveGather, moveFlow, react]) m.uniforms.tQuiet.value = this.actQuiet.texture;
    moveBlock.uniforms.uParity.value = parity;
    moveBlock.uniforms.uFrame.value = this.frame;
    moveBlock.uniforms.uGravity.value = this.gravity;
    moveBlock.uniforms.tA.value = this.stateA;
    moveBlock.uniforms.tB.value = this.stateB;
    this.run(moveBlock, this.blocks, quads);
    for (const m of [moveGather, moveFlow]) {
      m.uniforms.uParity.value = parity;
      m.uniforms.tSlots.value = this.slots.texture;
    }
    moveGather.uniforms.uFresh.value = this.actFresh;
    this.actFresh = false;
    this.pass(moveGather, quads);
    this.run(moveFlow, this.flowV, quads);
    react.uniforms.uFrame.value = this.frame;
    react.uniforms.uGravity.value = this.gravity;
    this.pass(react, quads);
    this.stepping = false;
  }

  paint({ center, radius, shape, tool, rate, replace }) {
    const u = this.mats.paint.uniforms;
    // Its own random stream: this.frame counts steps only. The move pass
    // alternates its block partition by the step count's parity, so a paint
    // bumping it would lock the partition when one step runs per paint (Speed
    // 1 while painting: poured matter could never leave its 2×2×2 block); the
    // POV body and the media drift clock also read it as steps taken.
    this.paints++;
    u.uFrame.value = this.paints;
    u.uCenter.value.copy(center);
    u.uRadius.value = radius;
    u.uShape.value = shape;
    u.uTool.value = tool;
    u.uRate.value = rate;
    u.uReplace.value = replace;
    // it changes cells within radius of its centre (either shape)
    const c = [center.x, center.y, center.z];
    this.touchCentres(c.map((x) => x - radius), c.map((x) => x + radius));
    this.pass(this.mats.paint);
  }

  get flowTexture() { return this.flowV.texture; }
  get fieldSurf() { return this.fields.textures[0]; }
  get fieldMedia() { return this.fields.textures[1]; }
  get fieldThin() { return this.fields.textures[2]; }

  // Rebuild the renderer's continuous fields (shaders/fields.js), over the
  // regions of the dirty sets (updateDirty): the rest of every target keeps
  // what it holds, which is what these passes would write there again.
  updateFields() {
    const { fieldEma, fieldCopy, fieldBlur, fieldFinal } = this.mats;
    const [tmpA, tmpB] = this.fieldTmp;
    const quads = this.fieldQuads;
    const reset = this.fieldReset;
    this.fieldReset = false;
    const u = fieldEma.uniforms;
    u.tA.value = this.stateA;
    u.tP0.value = this.fieldEma.textures[0];
    u.tP1.value = this.fieldEma.textures[1];
    u.uEmaS.value.set(...CHANNELS.map((c) => (reset ? 1 : c.ema)));
    u.uEmaM.value.set(...MEDIA.map((m) => (reset ? 1 : m.ema)));
    u.uShift.value.copy(this.fieldShift);   // the window moved (D11): the history follows its cells
    this.fieldShift.set(0, 0, 0);
    // into scratch, then copied back over the same regions
    this.run(fieldEma, tmpA, quads);
    tmpA.textures.forEach((t, i) => { fieldCopy.uniforms[`t${i}`].value = t; });
    this.run(fieldCopy, this.fieldEma, quads);
    // per-channel kernels, tap-major
    const k = CHANNELS.map((c) => gauss5(Math.max(c.sigma * this.smoothing, 0.05)));
    const setW = (mat) => mat.uniforms.uW.value.forEach((v, i) => v.set(k[0][i], k[1][i], k[2][i], k[3][i]));
    // x: EMA -> A, y: A -> B, z: B -> blurred
    const passes = [[fieldBlur, this.fieldEma, tmpA], [fieldBlur, tmpA, tmpB], [fieldFinal, tmpB, this.fieldsBlurred]];
    passes.forEach(([mat, src, dst], axis) => {
      setW(mat);
      mat.uniforms.uAxis.value = axis;
      mat.uniforms.t0.value = src.textures[0];
      mat.uniforms.t1.value = src.textures[1];
      mat.uniforms.t2.value = src.textures[2];
      this.run(mat, dst, quads);
    });
    // thin-feature boost: smooth x, y, z then peak x, y, z, ping-ponging
    // between A and B; stage 0 reads the blurred fields and the state, the
    // last writes the final fields
    const boost = this.mats.fieldBoost;
    const last = BOOST_STAGES - 1;
    const dst = (s) => (s === last ? this.fields : s % 2 ? tmpB : tmpA);
    const lu = boost[last].uniforms;
    lu.tPhi.value = this.fieldsBlurred.textures[0];
    lu.tMed.value = this.fieldsBlurred.textures[1];
    lu.uBulk.value.set(...k.map((w, i) => (CHANNELS[i].cubic ? bulkPeakCubic(w) : bulkPeak(w))));
    boost.forEach((mat, s) => {
      mat.uniforms.t0.value = s ? dst(s - 1).textures[0] : this.fieldsBlurred.textures[0];
      if (s) mat.uniforms.t1.value = dst(s - 1).textures[1];
      else mat.uniforms.tA.value = this.stateA;
      this.run(mat, dst(s), quads);
    });
  }

  // Which bricks the derived passes rebuild this frame: ages from what changed
  // since the last call, then the dirty sets, their regions of the field atlas
  // and the regions' shares (shaders/passes.js dirtyFrag).
  updateDirty() {
    // the quiet map still current at the last call, if steps used it since
    if (this.actCarry !== null && this.actAge > this.actCarry) this.noteAwake();
    this.actCarry = this.actAge;
    // a new kernel or a reset changes the fields everywhere
    if (this.smoothing !== this.lastSmoothing || this.fieldReset) this.changedAll = true;
    this.lastSmoothing = this.smoothing;
    const { age, dirty, regionMap, regionShare } = this.mats;
    const prev = this.brickAge[this.ageCur], next = this.brickAge[1 - this.ageCur];
    this.ageCur = 1 - this.ageCur;
    const u = age.uniforms;
    u.tAge.value = prev.texture;
    u.uSteps.value = this.actNoted;
    u.uAll.value = this.changedAll || !this.incremental;
    u.uTouchLo.value.fromArray(this.touchLo);
    u.uTouchHi.value.fromArray(this.touchHi);
    this.run(age, next);
    this.changedAll = false;
    this.actNoted = false;
    this.touchLo.fill(TOUCH_NONE_LO);
    this.touchHi.fill(TOUCH_NONE_HI);
    dirty.uniforms.tAge.value = next.texture;
    this.run(dirty, this.dirty);
    this.run(regionMap, this.regionMap);
    this.run(regionShare, this.regionShare);
    this.fieldQuads.fullOnly = !this.incremental;
  }

  // Rebuild the render fields, the empty-space bricks and the blurred light
  // volume: the fields and bricks only where they may have changed.
  updateBricks() {
    this.updateDirty();
    this.updateFields();
    this.mats.brick.uniforms.tA.value = this.stateA;
    this.mats.brick.uniforms.tB.value = this.stateB;
    this.mats.brick.uniforms.tFS.value = this.fieldSurf;
    this.mats.brick.uniforms.tFM.value = this.fieldMedia;
    this.mats.brick.uniforms.tFT.value = this.fieldThin;
    this.run(this.mats.brick, this.brick);
    // empty-space distance: x from the brick map, then y, then z (ends in brickDist[0])
    const [dx, dy, dz] = this.mats.brickDist;
    dx.uniforms.tSrc.value = this.brick.texture;
    this.run(dx, this.brickDist[0]);
    dy.uniforms.tSrc.value = this.brickDist[0].texture;
    this.run(dy, this.brickDist[1]);
    dz.uniforms.tSrc.value = this.brickDist[1].texture;
    this.run(dz, this.brickDist[0]);
    const blur = this.mats.blur;
    let src = this.brick.texture;
    for (let i = 0; i < LIGHT_BLUR_PASSES; i++) {
      blur.uniforms.tSrc.value = src;
      blur.uniforms.uAxis.value = i % 3;
      const dst = this.light[i & 1];
      this.run(blur, dst);
      src = dst.texture;
    }
    this.lightTexture = src;
  }

  get giTextures() { return this.giProbes.textures; }
  get brickDistTexture() { return this.brickDist[0].texture; }

  // Rebuild the GI probe volume (realistic view; after the shadow map, which it
  // reads for sunlight). sun: unit vector toward the sun.
  updateGI(sun, shadowMap, shadowRes, shadows) {
    const { giSource, giGather } = this.mats;
    for (const m of [giSource, giGather]) {
      const u = m.uniforms;
      u.tA.value = this.stateA;
      u.tBrick.value = this.brick.texture;
      u.tShadow.value = shadowMap;
      u.uShadowRes.value = shadowRes;
      u.uShadows.value = shadows;
      u.uSun.value.copy(sun);
    }
    this.giProbes.textures.forEach((t, i) => { giSource.uniforms[`tGI${i}`].value = t; });
    this.run(giSource, this.giSrc);
    const u = giGather.uniforms;
    [u.tGIRad.value, u.tGICov.value, u.tGIDir.value] = this.giSrc.textures;
    // after a reset trace every probe and replace; else half of them, blended in
    this.giFrame = (this.giFrame ?? 0) + 1;
    u.uParity.value = this.giReset ? -1 : this.giFrame & 1;
    giGather.blendAlpha = this.giReset ? 1 : GI_BLEND;
    this.giReset = false;
    this.run(giGather, this.giProbes);
  }

  // Move the window over the world (docs/scaling.md D11) by (dx, 0, dz) world
  // cells, whole supertiles: cell p takes the state of p + (dx, 0, dz), so the
  // content moves the other way and stays put in the world. Cells shifted in
  // from outside are still air until the caller fills them (world/window.js:
  // the generator, then stored edits). One pass: the other state copy is left
  // stale until syncCopies(), so the caller fills first and syncs once. The
  // render fields' history, the GI probes and the flow field move with the
  // cells, the brick maps rebuild with the next updateBricks and the activity
  // map is redone (run). Undo snapshots keep the window where they were taken
  // (undo maps them across).
  shift(dx, dz) {
    if (dx % SUPER_CELLS.x || dz % SUPER_CELLS.z) {
      throw new Error(`shift ${dx}, ${dz}: must be whole supertiles (${SUPER_CELLS.x} × ${SUPER_CELLS.z} cells)`);
    }
    // (made on the first shift: only a window of a larger world moves)
    const g = this.g;
    this.mats.shift ??= Object.assign(rawMat(shiftFrag(g), { ...stateUniforms(), uShift: { value: new THREE.Vector3() } }), { name: 'shift' });
    this.mats.giShift ??= Object.assign(rawMat(giShiftFrag(g), { ...giProbeUniforms(), uShift: { value: new THREE.Vector3() } }), { name: 'giShift' });
    this.mats.flowShift ??= Object.assign(rawMat(flowShiftFrag(g), { tFlowSrc: { value: null }, uShift: { value: new THREE.Vector3() } }), { name: 'flowShift' });
    const m = this.mats.shift;
    m.uniforms.uShift.value.set(dx, 0, dz);
    this.pass(m);
    this.origin.x += dx;
    this.origin.z += dz;
    if (!this.shiftKeepsHistory) {
      this.fieldReset = this.giReset = true;
      this.stillFlow();
    } else {
      // the flow field is laid out like the state (shaders/move.js moveFlowFrag): it moves with the cells
      const fs = this.mats.flowShift;
      this.flowVTmp ??= makeFieldTarget(g.width, g.height, 1, THREE.HalfFloatType, THREE.NearestFilter);
      fs.uniforms.uShift.value.set(dx, 0, dz);
      fs.uniforms.tFlowSrc.value = this.flowV.texture;
      this.run(fs, this.flowVTmp);
      [this.flowV, this.flowVTmp] = [this.flowVTmp, this.flowV];
      this.fieldShift.x += dx;
      this.fieldShift.z += dz;
      if (!this.giReset) {
        const gs = this.mats.giShift;
        this.giProbesTmp ??= makeFieldTarget(g.bwidth, g.bheight, 4, THREE.HalfFloatType, THREE.LinearFilter);
        gs.uniforms.uShift.value.set(dx / BRICK, 0, dz / BRICK);
        this.giProbes.textures.forEach((t, i) => { gs.uniforms[`tGI${i}`].value = t; });
        this.run(gs, this.giProbesTmp);
        [this.giProbes, this.giProbesTmp] = [this.giProbesTmp, this.giProbes];
      }
    }
  }

  // Forget the undo snapshots (they hold a window that has moved or been replaced).
  dropHistory() {
    this.history?.forEach((t) => t.dispose());
    this.history = [];
  }

  // Copy the current state into the other copy, so both hold it (after passes
  // that leave it stale: a shift and its fill). Like every write that isn't a
  // step, it has the next map's steps draw every supertile (noteWrite; the copy
  // pass leaves fresh flags in the other copy: docs/scaling.md D8).
  syncCopies() {
    const u = this.mats.copy.uniforms;
    u.tA.value = this.stateA;
    u.tB.value = this.stateB;
    this.run(this.mats.copy, this.targets[1 - this.cur]);
  }

  // Upload CPU-built state (Float32Array RGBA per atlas texel).
  load(dataA, dataB) {
    const { width, height } = this.g;
    const texA = new THREE.DataTexture(dataA, width, height, THREE.RGBAFormat, THREE.FloatType);
    const texB = new THREE.DataTexture(dataB, width, height, THREE.RGBAFormat, THREE.FloatType);
    texA.needsUpdate = texB.needsUpdate = true;
    const u = this.mats.copy.uniforms;
    u.tA.value = texA;
    u.tB.value = texB;
    this.run(this.mats.copy, this.targets[this.cur]);
    this.fieldReset = true;
    this.giReset = true;
    this.stillFlow();
    texA.dispose();
    texB.dispose();
  }

  clear() {
    this.load(...this.blankState());
  }

  // ---- undo history: full GPU copies of the state, newest last ----
  // Each snapshot is two RGBA32F atlases (~70 MB at 128³), so keep only a few.
  // Each remembers the window's origin it was taken at (t.origin): after the
  // window moves (docs/scaling.md D11) it still holds the cells where they were.
  snapshot(limit = 3) {
    this.history ??= [];
    const t = this.history.length >= limit ? this.history.shift() : makeTarget(this.g.width, this.g.height);
    const u = this.mats.copy.uniforms;
    u.tA.value = this.stateA;
    u.tB.value = this.stateB;
    this.run(this.mats.copy, t);
    t.origin = this.origin.clone();
    this.history.push(t);
  }

  get canUndo() { return (this.history?.length ?? 0) > 0; }

  // Grid cells [dx, dz] the window moved since the newest snapshot was taken, or null without one.
  get undoShift() {
    const t = this.history?.at(-1);
    return t ? [this.origin.x - t.origin.x, this.origin.z - t.origin.z] : null;
  }

  // Bring the newest snapshot back. Taken before the window moved, it brings
  // back the cells the old and the new window share, and the rest keep what
  // they hold now (the cells that left the window are stored edits, out of
  // its reach). If the two don't overlap at all it does nothing and keeps the
  // snapshot for when the window comes back: returns false then, and when
  // there is none.
  undo() {
    const t = this.history?.at(-1);
    if (!t) return false;
    const [dx, dz] = this.undoShift;
    if (Math.abs(dx) >= this.g.nx || Math.abs(dz) >= this.g.nz) return false;
    this.history.pop();
    let mat = this.mats.copy;
    if (dx || dz) {
      // (made on the first undo after a move: only a window of a larger world moves)
      this.mats.undoShift ??= Object.assign(rawMat(undoShiftFrag(this.g), {
        tA: { value: null }, tB: { value: null }, uShift: { value: new THREE.Vector3() },
      }), { name: 'undoShift' });
      mat = this.mats.undoShift;
      mat.uniforms.uShift.value.set(dx, 0, dz);
    }
    mat.uniforms.tA.value = t.textures[0];
    mat.uniforms.tB.value = t.textures[1];
    this.run(mat, this.targets[this.cur]);
    this.stillFlow();
    t.dispose();
    return true;
  }

  // The state was replaced: nothing is moving until the next step says so.
  stillFlow() {
    this.renderer.setRenderTarget(this.flowV);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
  }

  blankState() {
    const g = this.g;
    const a = new Float32Array(g.width * g.height * 4);
    const b = new Float32Array(g.width * g.height * 4);
    for (let i = 0; i < g.width * g.height; i++) a[i * 4 + 1] = 20;
    // One seed per texel of the Y-slice field atlas, in its row order, padding
    // included: the state atlas's order before it went brick-major, so a
    // seeded Math.random (tools/regress.mjs) still gives each cell its seed.
    for (let fy = 0; fy < g.fheight; fy++) {
      const row = Math.floor(fy / g.nz), z = fy - row * g.nz;
      for (let col = 0; col < g.ftx; col++) {
        const y = row * g.ftx + col;
        for (let x = 0; x < g.nx; x++) {
          const seed = Math.random() * SEED_MAX;
          if (y < g.ny) a[cellTexel(g, x, y, z) * 4 + 3] = seed;
        }
      }
    }
    return [a, b];
  }

  // Debug: read the full state back and summarise it per element.
  census() {
    const { nx, ny, nz } = this.g;
    const [a] = this.readState();
    const out = {};
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          const i = this.cellTexel(x, y, z) * 4;
          const id = Math.round(a[i]);
          const o = (out[id] ??= { n: 0, T: 0, minY: 1e9, maxY: -1, Tmax: -1e9 });
          o.n++; o.T += a[i + 1]; o.minY = Math.min(o.minY, y); o.maxY = Math.max(o.maxY, y); o.Tmax = Math.max(o.Tmax, a[i + 1]);
        }
    for (const k in out) out[k].T = +(out[k].T / out[k].n).toFixed(1);
    return out;
  }

  // Every pass's material (the profiler's and the app's program bookkeeping).
  materials() { return Object.values(this.mats).flat(); }   // (fieldBoost, brickDist are arrays)

  // retire: an array to put the materials in instead of disposing of them (the
  // app disposes of them once the next grid's have claimed their programs, so
  // the programs both use carry over: app.js build).
  dispose(retire = null) {
    this.targets.forEach((t) => t.dispose());
    this.brick.dispose();
    this.blocks.dispose();
    this.slots.dispose();
    this.light.forEach((t) => t.dispose());
    this.fieldEma.dispose();
    this.fieldTmp.forEach((t) => t.dispose());
    this.fieldsBlurred.dispose();
    this.fields.dispose();
    this.flowV.dispose();
    this.flowVTmp?.dispose();
    this.brickDist.forEach((t) => t.dispose());
    this.actClass.dispose();
    this.actRows.dispose();
    this.actInert.dispose();
    this.actQuiet.dispose();
    this.superMap.forEach((t) => t.dispose());
    this.superRows.dispose();
    this.superShare.dispose();
    this.stepQuads.dispose();
    this.actChanged.dispose();
    this.brickAge.forEach((t) => t.dispose());
    this.dirty.dispose();
    this.regionMap.dispose();
    this.regionShare.dispose();
    this.fieldQuads.dispose();
    this.giSrc.dispose();
    this.giProbes.dispose();
    this.giProbesTmp?.dispose();
    this.history?.forEach((t) => t.dispose());
    if (retire) retire.push(...this.materials());
    else this.materials().forEach((m) => m.dispose());
    this.quad.geometry.dispose();
  }
}
