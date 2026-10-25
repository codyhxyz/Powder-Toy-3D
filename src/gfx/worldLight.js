// The world's light (docs/seamless-world.md, "L — lighting"): the shadow cascades, the probe
// cascades and the glow clips of shaders/world/light.js, their resources, and each frame's fixed
// budget of updates (src/gfx/worldLightBook.js decides which). A camera move updates only what came
// into range, a physics move nothing; a world change (the world copy's changed boxes) re-traces
// the shadow tiles, probe chunks and glow chunks it reaches, under the same budget.
//
//   const light = new WorldLight(gpu, worldCopy, fields, { copyWGSL, fieldsWGSL, fieldsBindings });
//   light.update(frame, cameraWorldCell, sunDir, changes, { frameGroup });   // once a frame
//   light.bindEntries()   // group 2 entries 8-12, 14, 15, 20 of the march (LIGHT_BINDINGS)
//
// copyWGSL: W's worldCopyWGSL (shaders/world/copy.js); fieldsWGSL / fieldsBindings: F's
// worldFieldsWGSL() and FIELDS_BINDINGS (shaders/world/fields.js), its resources from
// fields.bindEntries(). Without F the writers read smooth surfaces and media by their cells.
// frameGroup: the frame's group 0 (RENDER_LAYOUT.FRAME: the element tables and FrameUniforms).
import { prelude } from '../shaders/common.js';
import { frameBindings, RENDER_LAYOUT } from '../shaders/bindings.js';
import { glslMod } from '../gpu/wgsl.js';
import { materialsGLSL } from './materials.js';
import { noiseGLSL } from '../shaders/gfx/noise.js';
import { SHADOW, PROBE, GLOW, TAGS, SHADOW_TEXELS, LC_BUF_VEC4S, LightUniforms, LIGHT_BINDINGS, clipTexSize } from '../shaders/world/light.js';
import {
  LW, MAX_JOBS, JOB_FIRST, ShadowJobs, ClipJobs, WRITER_LAYOUT, GLOW_SCRATCH,
  shadowTraceFrag, probeUpdateFrag, probePublishFrag, glowSeedFrag, glowBlurFrag, glowFinalFrag,
  shadowTraceDispatch, probeUpdateDispatch, probePublishDispatch, glowSeedDispatch, glowBlurDispatch, glowFinalDispatch,
} from '../shaders/world/lightWriters.js';
import { ShadowCascades, probeLevels, glowLevels, clipJobs, lightUniformValues, shadowJobValues } from './worldLightBook.js';

const ASSEMBLY_GRID = { nx: 16, ny: 8, nz: 8 };   // the prelude's grid constants: nothing here reads them
const v3 = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);

/** The writers' WGSL head: the tables, FrameUniforms, materials, noise, W's readers and F's. */
export function lightAssembly({ copyWGSL, fieldsWGSL = '' }) {
  return [prelude(ASSEMBLY_GRID, { state: false }), frameBindings(), glslMod, materialsGLSL(), noiseGLSL,
    copyWGSL, fieldsWGSL, 'var<private> gFragCoord: vec2f;'].join('\n');
}

/** The resources' bytes (the report's memory line). */
export function worldLightBytes() {
  const tex = (s) => s[0] * s[1] * s[2] * 8;
  return {
    shadowAndTags: LC_BUF_VEC4S * 16,   // binding 15: the cascades' texels, then the tags
    probeHistory: PROBE.LEVELS * PROBE.N ** 3 * 32,
    probeBands: 4 * tex(clipTexSize(PROBE.LEVELS, PROBE.N)),
    glow: tex(clipTexSize(GLOW.LEVELS, GLOW.N)),
    glowScratch: GLOW.JOBS_PER_FRAME * GLOW_SCRATCH * 16,
  };
}

export class WorldLight {
  /**
   * @param {object} gpu
   * @param {{ size: number[] | { x: number, y: number, z: number }, layout: GPUBindGroupLayout, bindGroup: GPUBindGroup,
   *   changesSince?: (rev: number) => { lo: number[], hi: number[] }[], revision?: number }} worldCopy
   * @param {{ bindEntries: () => { binding: number, resource: any }[] } | null} fields
   * @param {{ copyWGSL: string, fieldsWGSL?: string, fieldsBindings?: any[], mediaNoise?: GPUTextureView, frameGroup?: GPUBindGroup }} opts
   *   mediaNoise: the clouds' detail noise (gfx/mediaNoise.js, the march's binding 16) for the probes' sun
   */
  constructor(gpu, worldCopy, fields, { copyWGSL, fieldsWGSL = null, fieldsBindings = null, mediaNoise = null, frameGroup = null } = {}) {
    if (!copyWGSL) throw new Error('WorldLight: needs the world copy\'s WGSL (opts.copyWGSL)');
    Object.assign(this, { gpu, worldCopy, fields, mediaNoise, frameGroup });
    this.size = v3(worldCopy.size).map(Number);
    this.useFields = !!(fieldsWGSL && fieldsBindings && fields);
    this.fieldsBindings = this.useFields ? fieldsBindings : [];
    this.shadow = new ShadowCascades(this.size);
    this.probes = probeLevels();
    this.glow = glowLevels();
    this.rev = worldCopy.revision ?? 0;
    this._makeResources();
    // F's readers only where F's bindings are (the shadow and probe writers); the glow reads cells
    this._makeKernels(lightAssembly({ copyWGSL, fieldsWGSL: this.useFields ? fieldsWGSL : '' }), lightAssembly({ copyWGSL }));
  }

  _makeResources() {
    const { gpu } = this, U = GPUBufferUsage, T = GPUTextureUsage;
    const buf = (label, size, usage = U.STORAGE | U.COPY_DST) => gpu.createBuffer({ label, size, usage });
    const b = worldLightBytes();
    this.buf = {
      lc: buf('light cascades + tags', b.shadowAndTags),
      hist: buf('light probe history', b.probeHistory),
      scratch: buf('light glow scratch', b.glowScratch),
    };
    const tex = (label, size) => gpu.createTexture({ label, size, dimension: '3d', format: 'rgba16float',
      usage: T.TEXTURE_BINDING | T.STORAGE_BINDING | T.COPY_DST });
    this.bands = [0, 1, 2, 3].map((k) => tex(`light probe band ${k}`, clipTexSize(PROBE.LEVELS, PROBE.N)));
    this.glowTex = tex('light glow', clipTexSize(GLOW.LEVELS, GLOW.N));
    this.bandViews = this.bands.map((t) => t.createView({ dimension: '3d' }));
    this.glowView = this.glowTex.createView({ dimension: '3d' });
    this.lc = gpu.uniforms(LightUniforms, 'light LC');
    this.shadowJobs = gpu.uniforms(ShadowJobs, 'light shadow jobs');
    this.probeJobs = gpu.uniforms(ClipJobs, 'light probe jobs');
    this.glowJobs = gpu.uniforms(ClipJobs, 'light glow jobs');
    this.clamp = gpu._worldLinearClamp ??= gpu.device.createSampler({ label: 'linearClamp', magFilter: 'linear', minFilter: 'linear' });
    this.repeat = gpu._worldLightRepeat ??= gpu.device.createSampler({ label: 'light repeat', magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
    if (!this.mediaNoise) {   // no clouds' noise handed in: a flat one (the deck's shadow is then uniform)
      this.noiseDummy = tex('light noise (none)', [1, 1, 1]);
      this.mediaNoise = this.noiseDummy.createView({ dimension: '3d' });
    }
    // the tags start invalid (zero), so nothing reads a texel before it is traced
    gpu.write(this.buf.lc, SHADOW_TEXELS * 16, new Uint32Array(LC_BUF_VEC4S * 4 - SHADOW_TEXELS * 4), { ordered: false });
  }

  _makeKernels(head, headCells) {
    const { gpu } = this;
    const fieldEntries = this.fieldsBindings.map(([binding, , , body]) => ({ binding, ...body, visibility: GPUShaderStage.COMPUTE }));
    const frameLayout = gpu.layout('FRAME', RENDER_LAYOUT.FRAME);
    const layout = (name, entries, withFields) => gpu.layout(`WORLD_LIGHT_${name}${withFields ? '_F' : ''}`, [...(withFields ? fieldEntries : []), ...entries]);
    const F = this.useFields;
    this.layouts = {
      shadow: layout('SHADOW', WRITER_LAYOUT.shadow, F),
      probeUpdate: layout('PROBE', WRITER_LAYOUT.probeUpdate, F),
      probePublish: layout('PUBLISH', WRITER_LAYOUT.probePublish, false),
      glowWork: layout('GLOW', WRITER_LAYOUT.glowWork, false),
      glowFinal: layout('GLOW_FINAL', WRITER_LAYOUT.glowFinal, false),
    };
    const E = gpu.L.EMPTY, copy = this.worldCopy.layout;
    const k = (name, code, layouts, workgroupSize) => gpu.kernel({ name, code, layouts, workgroupSize, build: 'later' });
    this.kernels = {
      shadow: k('worldLightShadow', `${head}\n${shadowTraceFrag({ fields: F })}`, [frameLayout, copy, this.layouts.shadow], [SHADOW.TILE, SHADOW.TILE, 1]),
      probeUpdate: k('worldLightProbe', `${head}\n${probeUpdateFrag({ fields: F })}`, [frameLayout, copy, this.layouts.probeUpdate], [PROBE.RAYS, 1, 1]),
      probePublish: k('worldLightPublish', probePublishFrag(), [E, E, this.layouts.probePublish], [PROBE.CHUNK ** 3, 1, 1]),
      glowSeed: k('worldLightGlowSeed', `${headCells}\n${glowSeedFrag()}`, [frameLayout, copy, this.layouts.glowWork], [64, 1, 1]),
      glowBlurX: k('worldLightGlowX', glowBlurFrag(0), [E, E, this.layouts.glowWork], [64, 1, 1]),
      glowBlurY: k('worldLightGlowY', glowBlurFrag(1), [E, E, this.layouts.glowWork], [64, 1, 1]),
      glowFinal: k('worldLightGlowZ', glowFinalFrag(), [E, E, this.layouts.glowFinal], [64, 1, 1]),
    };
    const ent = (binding, resource) => ({ binding, resource: resource instanceof GPUBuffer ? { buffer: resource } : resource });
    const fieldRes = () => (F ? this.fields.bindEntries().filter((e) => this.fieldsBindings.some(([n]) => n === e.binding)) : []);
    this._groups = () => ({
      shadow: gpu.bindGroup(this.layouts.shadow, [...fieldRes(), ent(14, this.lc.buffer), ent(LW.B, this.buf.lc),
        ent(LW.JOBS, this.shadowJobs.buffer)], 'world light shadow'),
      probeUpdate: gpu.bindGroup(this.layouts.probeUpdate, [...fieldRes(), ...this.bindEntries(), ent(16, this.mediaNoise), ent(17, this.clamp), ent(LW.REPEAT, this.repeat),
        ent(LW.A, this.buf.hist), ent(LW.JOBS, this.probeJobs.buffer)], 'world light probes'),
      probePublish: gpu.bindGroup(this.layouts.probePublish, [ent(LW.A, this.buf.hist), ent(LW.B, this.buf.lc), ent(LW.JOBS, this.probeJobs.buffer),
        ...this.bandViews.map((v, i) => ent(LW.TEX + i, v))], 'world light publish'),
      glowWork: gpu.bindGroup(this.layouts.glowWork, [ent(LW.A, this.buf.scratch), ent(LW.JOBS, this.glowJobs.buffer)], 'world light glow'),
      glowFinal: gpu.bindGroup(this.layouts.glowFinal, [ent(LW.A, this.buf.scratch), ent(LW.B, this.buf.lc), ent(LW.JOBS, this.glowJobs.buffer),
        ent(LW.TEX, this.glowView)], 'world light glow final'),
    });
    this.groups = null;   // made on the first update (F's resources may be made after us)
  }

  /** Group 2 entries of the march (LIGHT_BINDINGS: 8-12 textures, 14 LC, 15 the cascades and the tags). */
  bindEntries() {
    return [
      ...this.bandViews.map((v, i) => ({ binding: 8 + i, resource: v })),
      { binding: 12, resource: this.glowView },
      { binding: 14, resource: { buffer: this.lc.buffer } },
      { binding: 15, resource: { buffer: this.buf.lc } },
    ];
  }

  /**
   * A frame's light: the bookkeeping, the uniform and the frame's fixed budget of dispatches.
   * @param {object} frame gpu.frame
   * @param {number[] | { x: number, y: number, z: number }} camera world cells
   * @param {number[] | { x: number, y: number, z: number }} sun unit, toward the sun
   * @param {{ lo: number[], hi: number[] }[]} [changes] world-cell boxes changed since last frame
   *   (default: the world copy's changesSince)
   * @param {{ frameGroup?: GPUBindGroup, rotation?: number[] }} [opts]
   */
  update(frame, camera, sun, changes, { frameGroup = this.frameGroup } = {}) {
    if (!frameGroup) return;   // nothing to light with yet (the frame's tables)
    // its kernels build in the background ('later'): until all are built the frame's jobs wait (their
    // bookkeeping too, so no tile or chunk is marked traced that wasn't). A dispatch before a pipeline was
    // ready threw on a cold load (lead, 2026-10-24).
    if (!this.kernelsReady) {
      if (!Object.values(this.kernels).every((k) => k.state === 'ready')) return;
      this.kernelsReady = true;
    }
    const cam = v3(camera), s = v3(sun);
    if (!changes) {
      changes = this.worldCopy.changesSince?.(this.rev) ?? [];
      this.rev = this.worldCopy.revision ?? this.rev;
    }
    this.groups ??= this._groups();
    // bookkeeping: centre every window, mark what the changes reach, pick the frame's jobs
    this.shadow.update(cam, s, changes);
    for (const L of this.probes) { L.centre(cam); for (const { lo, hi } of changes) L.touch(lo, hi, 1); }
    for (const L of this.glow) { L.centre(cam); for (const { lo, hi } of changes) L.touch(lo, hi, GLOW.REACH); }
    const sJobs = this.shadow.jobs(Math.min(SHADOW.TILES_PER_FRAME, MAX_JOBS));
    const pJobs = clipJobs(this.probes, { newMax: PROBE.NEW_CHUNKS_MAX, rotate: PROBE.ROTATE_CHUNKS });
    const gJobs = clipJobs(this.glow, { newMax: GLOW.JOBS_PER_FRAME, rotate: 0 });
    this.lc.write(lightUniformValues(this.size, this.shadow, this.probes, this.glow));
    this.stats = { shadowTiles: sJobs.length, probeChunks: pJobs.length, glowChunks: gJobs.length };
    const bindW = (g) => [frameGroup, this.worldCopy.bindGroup, g];
    if (sJobs.length) {
      this.shadowJobs.write(shadowJobValues(this.shadow, sJobs));
      this.kernels.shadow.dispatch(frame, shadowTraceDispatch(sJobs.length), { bind: bindW(this.groups.shadow) });
    }
    if (pJobs.length) {
      this.probeJobs.write({ count: pJobs.length, blend: PROBE.BLEND, rot: randomRotation(),
        jobs: pJobs.map((j) => [...j.c, j.level | (j.first ? JOB_FIRST : 0)]) });
      this.kernels.probeUpdate.dispatch(frame, probeUpdateDispatch(pJobs.length), { bind: bindW(this.groups.probeUpdate) });
      this.kernels.probePublish.dispatch(frame, probePublishDispatch(pJobs.length), { bind: [this.gpu.emptyGroup, this.gpu.emptyGroup, this.groups.probePublish] });
    }
    if (gJobs.length) {
      this.glowJobs.write({ count: gJobs.length, blend: 1, jobs: gJobs.map((j) => [...j.c, j.level]) });
      const E = this.gpu.emptyGroup;
      this.kernels.glowSeed.dispatch(frame, glowSeedDispatch(gJobs.length), { bind: bindW(this.groups.glowWork) });
      this.kernels.glowBlurX.dispatch(frame, glowBlurDispatch(0, gJobs.length), { bind: [E, E, this.groups.glowWork] });
      this.kernels.glowBlurY.dispatch(frame, glowBlurDispatch(1, gJobs.length), { bind: [E, E, this.groups.glowWork] });
      this.kernels.glowFinal.dispatch(frame, glowFinalDispatch(gJobs.length), { bind: [E, E, this.groups.glowFinal] });
    }
  }

  /** Resolves when every writer kernel is built (the first frame waits for it: gfx/worldView.js). */
  get ready() { return (this._ready ??= Promise.all(Object.values(this.kernels).map((k) => k.ready))); }

  get bytes() { return Object.values(worldLightBytes()).reduce((a, b) => a + b, 0); }

  dispose() {
    for (const b of Object.values(this.buf)) b.destroy();
    for (const t of [...this.bands, this.glowTex, ...(this.noiseDummy ? [this.noiseDummy] : [])]) t.destroy();
    for (const u of [this.lc, this.shadowJobs, this.probeJobs, this.glowJobs]) u.buffer.destroy();
  }
}

/** A uniformly random rotation (Shoemake's quaternion), column-major, for the probes' rays this frame. */
export function randomRotation(rand = Math.random) {
  const u1 = rand(), u2 = rand() * 2 * Math.PI, u3 = rand() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  const [x, y, z, w] = [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ];
}
export { LIGHT_BINDINGS };
