// Stand-ins for W's, F's and L's exports (docs/seamless-world.md), until theirs land. M's march
// (shaders/world/march.js) and frame wiring (gfx/worldView.js) are written against these exact
// names and signatures; the lead swaps the import in march.js and worldView.js for the real
// modules at integration. Nothing here is meant to ship.
//
// Each stand-in serves today's physics-window resources as if the window were the whole world:
// on a small map the window is the world (its origin is 0), so the march's picture through them
// is the box's picture, which is what M's screenshots compare. On a big map they show the window
// only, at its place in the world.
//
//   W  worldCopyWGSL()            group 1: WC (binding 0), the window's V2 cells, its brick map and
//                                 brickDist (1-3); wcCell, wcA, wcInfo, wcOccupied, WC.size, WC.bricks
//      class WorldCopyStub         constructor(gpu, { size }); build(sim); layout; bindGroup;
//                                 recordWriteback(frame, sim, boxes); changes; changesSince(rev); dispose()
//   F  worldFieldsWGSL({ detail }) the field readers (today's names: surfField surfSample surfChannel
//                                 fieldCubic fieldCubicGrad mediaField fieldTex cubicShare surfNormal
//                                 surfRoot surfCross ...), p in world cells; gFieldLevel, fieldLevelFor
//      FIELDS_BINDINGS            [binding, name, wgslType, layoutBody], group 2 bindings 0-7
//      class WorldFieldsStub       constructor(gpu, worldCopy); update(frame, cameraWorldCell, changes); bindEntries()
//   L  worldLightWGSL()            today's lighting.js names (sunShadow, probeAt, surfProbe, nearField, ...)
//      LIGHT_BINDINGS             group 2 bindings 8-15, 20
//      class WorldLightStub        constructor(gpu, worldCopy, fields); update(frame, camera, sun, changes); bindEntries()
import { coreGLSL } from '../gfx/core.js';
import { lightingGLSL } from '../gfx/lighting.js';
import { compactDecodeWGSL } from '../compact.js';
import { uniformStruct } from '../../gpu/params.js';
import { cellWordWGSL } from './cellWord.js';
import { STAGE } from '../common.js';

const READERS = STAGE.FRAGMENT | STAGE.COMPUTE;
const UNIFORM = { visibility: STAGE.VERTEX | READERS, buffer: { type: 'uniform' } };
const READ = { visibility: READERS, buffer: { type: 'read-only-storage' } };
const float3d = { visibility: READERS, texture: { sampleType: 'float', viewDimension: '3d' } };
const unfilterable2d = { visibility: READERS, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } };
const sampler = { visibility: READERS, sampler: { type: 'filtering' } };

// ---------------------------------------------------------------- W
/** W's uniform (group 1 binding 0): the world's size in cells and in bricks. */
export const WorldCopyUniforms = uniformStruct('WorldCopyUniforms', { size: 'vec3i', bricks: 'vec3i' });

/**
 * W's WGSL: group 1 and its readers. Needs the prelude (slotOf, brickId, NBRICKS, the tables)
 * and shaders/bindings.js brickInfoWGSL before it.
 */
export const worldCopyWGSL = () => /* wgsl */ `
${cellWordWGSL}
${compactDecodeWGSL}
${WorldCopyUniforms.wgsl}
@group(1) @binding(0) var<uniform> WC: WorldCopyUniforms;
@group(1) @binding(1) var<storage, read> wcStubCells: array<vec4u>;      // (stub) the window's V2 cores
@group(1) @binding(2) var<storage, read> wcStubBricks: array<BrickInfo>; // (stub) the window's brick map
@group(1) @binding(3) var<storage, read> wcStubDist: array<u32>;         // (stub) its empty-space distance + 1
fn wcStubIn(c: vec3i) -> bool { return all(c >= vec3i(0)) && all(c < WC.size); }
fn wcA(c: vec3i) -> vec4f {
  if (!wcStubIn(c)) { return vec4f(0.0, airT(), 0.0, 0.0); }
  return compactA(c, wcStubCells[slotOf(c)]);
}
fn wcCell(c: vec3i) -> u32 {
  if (!wcStubIn(c)) { return 0u; }
  let a = wcA(c);
  let id = eid(a);
  if (id == E_EMPTY) { return 0u; }
  return wcWord(id, u32(floor(a.w)) & 255u, a.y, clamp(a.z, 0.0, 1.0));
}
fn wcInfo(b: vec3i) -> u32 {
  if (any(b < vec3i(0)) || any(b >= WC.bricks)) { return 0u; }
  return wcStubBricks[brickId(b)].info;
}
// level 0: the brick holds matter; 1 and 2: the 16³ / 64³ node holds any (the stub proves a node
// empty when the brick map's empty-space distance at its corner brick covers it: conservative)
fn wcOccupied(level: u32, c: vec3i) -> bool {
  let b = c / 4;
  if (level == 0u) { return brickMatter(wcInfo(b)); }
  let n = select(16, 4, level == 1u);   // bricks a node spans: 4 (16³ cells) or 16 (64³)
  let lo = (b / n) * n;
  if (any(lo < vec3i(0)) || any(lo >= WC.bricks)) { return false; }
  let r = i32(wcStubDist[brickId(lo)]) - 1;   // every brick within r of lo is empty
  return r < n;
}
`;

/** The stand-in world copy: the physics window's own buffers, as group 1. */
export class WorldCopyStub {
  /** Group 1's layout entries. */
  static LAYOUT = [{ binding: 0, ...UNIFORM }, { binding: 1, ...READ }, { binding: 2, ...READ }, { binding: 3, ...READ }];
  /** @param {object} gpu @param {{ size: number[] }} opts */
  constructor(gpu, { size }) {
    this.gpu = gpu;
    this.size = size;
    this.layout = gpu.layout('WORLD_COPY', WorldCopyStub.LAYOUT);
    this.uniforms = gpu.uniforms(WorldCopyUniforms, 'world copy (stub)');
    this.revision = 0;
    this._group = null;
    this._key = null;
  }
  /** W builds the whole map here; the stand-in only takes the window's buffers. */
  async build(sim) { this.sim = sim; return this; }
  /** Group 1 for the frame: the window's V2 cells and brick map (rebuilt when they change). */
  get bindGroup() {
    const sim = this.sim, cells = sim.compact?.cells, d = sim.derived;
    const brick = d?.brick, dist = d?.brickDist;
    if (!cells || !brick || !dist) return null;
    if (this._key?.[0] !== cells || this._key[1] !== brick || this._key[2] !== dist) {
      this._key = [cells, brick, dist];
      this._group = this.gpu.bindGroup(this.layout, [
        { binding: 0, resource: { buffer: this.uniforms.buffer } }, { binding: 1, resource: { buffer: cells } },
        { binding: 2, resource: { buffer: brick } }, { binding: 3, resource: { buffer: dist } },
      ], 'world copy (stub)');
    }
    return this._group;
  }
  /** Physics' changed boxes into the copy: the stand-in reads the window directly, so nothing to do. */
  recordWriteback(_frame, sim, _boxes) {
    this.sim = sim;
    const [x, y, z] = [sim.g.nx, sim.g.ny, sim.g.nz];
    this.uniforms.write({ size: [x, y, z], bricks: [x >> 2, y >> 2, z >> 2] });
    this.revision++;
  }
  get changes() { return []; }
  changesSince(_rev) { return []; }
  dispose() {}
}

// ---------------------------------------------------------------- F
/** F's uniform (group 2 binding 7). The stand-in's: where the window's field textures sit, world cells. */
export const FieldsUniforms = uniformStruct('FieldsUniforms', { origin: 'vec3f', size: 'vec3f' });

export const FIELDS_BINDINGS = [
  [0, 'tFS', 'texture_3d<f32>', float3d],
  [1, 'tFM', 'texture_3d<f32>', float3d],
  [2, 'tFT', 'texture_3d<f32>', float3d],
  [6, 'wrapLinear', 'sampler', sampler],
  [7, 'FC', 'FieldsUniforms', UNIFORM],
];

// today's field readers (gfx/core.js, from "continuous fields" up to the mesh cut), read at
// p - FC.origin in a window of FC.size
const FIELDS_FROM = '// ---- continuous fields ----';
const FIELDS_TO = '// ---- the opaque meshes\' cut';
/** F's WGSL: the field readers, p in world cells, and the clip level the march picks. */
export const worldFieldsWGSL = ({ detail = {} } = {}) => {
  const core = coreGLSL({ nx: 4, ny: 4, nz: 4 }, { flow: false, detail });
  const a = core.indexOf(FIELDS_FROM), b = core.indexOf(FIELDS_TO);
  if (a < 0 || b < a) throw new Error('worldFieldsWGSL (stub): gfx/core.js field section not found');
  const body = core.slice(a, b)
    .replaceAll('clamp(p, vec3f(0.5)', 'clamp(p - FC.origin, vec3f(0.5)')
    .replaceAll('vec3f(GRID)', 'FC.size');
  return /* wgsl */ `
${FieldsUniforms.wgsl}
// The clip level the march reads (F: 0 = full cells). The stand-in has one level.
var<private> gFieldLevel: u32 = 0u;
fn fieldLevelFor(footprintCells: f32) -> u32 { return 0u; }
${body}`;
};

/** The stand-in fields: the derived passes' window-sized fields. */
export class WorldFieldsStub {
  constructor(gpu, worldCopy) {
    this.gpu = gpu;
    this.worldCopy = worldCopy;
    this.uniforms = gpu.uniforms(FieldsUniforms, 'fields (stub)');
    this.sampler = gpu._worldWrapLinear ??= gpu.device.createSampler({ label: 'wrapLinear', magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
  }
  update(_frame, _cameraWorldCell, _changes) {
    const sim = this.worldCopy.sim;
    const o = sim.origin;
    this.uniforms.write({ origin: [o?.x ?? 0, o?.y ?? 0, o?.z ?? 0], size: [sim.g.nx, sim.g.ny, sim.g.nz] });
  }
  bindEntries() {
    const d = this.worldCopy.sim.derived.lightingEntries();
    const at = (n) => d.find((e) => e.binding === n)?.resource;
    return [
      { binding: 0, resource: at(0) }, { binding: 1, resource: at(1) }, { binding: 2, resource: at(2) },
      { binding: 6, resource: this.sampler }, { binding: 7, resource: { buffer: this.uniforms.buffer } },
    ];
  }
}

// ---------------------------------------------------------------- L
/** L's uniform (group 2 binding 14). The stand-in's carries nothing it reads. */
export const LightUniforms = uniformStruct('LightUniforms', { origin: 'vec3f' });

// (the stand-in puts today's seven lighting textures at 8-13 and 15; L's real list has at most six
// textures at 8-13 and storage buffers at 15 and 20)
export const LIGHT_BINDINGS = [
  [8, 'tLight', 'texture_3d<f32>', float3d],
  [9, 'tGI0', 'texture_3d<f32>', float3d],
  [10, 'tGI1', 'texture_3d<f32>', float3d],
  [11, 'tGI2', 'texture_3d<f32>', float3d],
  [12, 'tGI3', 'texture_3d<f32>', float3d],
  [13, 'tShadow', 'texture_2d<f32>', unfilterable2d],
  [14, 'LC', 'LightUniforms', UNIFORM],
  [15, 'tShadowX', 'texture_2d<f32>', unfilterable2d],
];
/** L's WGSL: today's lighting library (gfx/lighting.js), names unchanged. */
export const worldLightWGSL = () => `${LightUniforms.wgsl}\n${lightingGLSL({ shadowMap: true, probes: true, giUniforms: false, far: false })}`;

/** The stand-in lighting: the derived passes' window-sized light, GI and the volume's shadow map. */
export class WorldLightStub {
  constructor(gpu, worldCopy, fields, { shadowTextures } = {}) {
    this.gpu = gpu;
    this.worldCopy = worldCopy;
    this.fields = fields;
    this.shadowTextures = shadowTextures;
    this.uniforms = gpu.uniforms(LightUniforms, 'light (stub)');
    this.views = new WeakMap();
  }
  update(_frame, _camera, _sun, _changes) {}
  _view(t) {
    if (!(t instanceof GPUTexture)) return t;
    let v = this.views.get(t);
    if (!v) this.views.set(t, v = t.createView({ label: t.label }));
    return v;
  }
  bindEntries() {
    const d = this.worldCopy.sim.derived.lightingEntries();
    const at = (n) => d.find((e) => e.binding === n)?.resource;
    return [
      { binding: 8, resource: at(3) }, { binding: 9, resource: at(4) }, { binding: 10, resource: at(5) },
      { binding: 11, resource: at(6) }, { binding: 12, resource: at(7) },
      { binding: 13, resource: this._view(this.shadowTextures.map) }, { binding: 14, resource: { buffer: this.uniforms.buffer } },
      { binding: 15, resource: this._view(this.shadowTextures.x) },
    ];
  }
}

