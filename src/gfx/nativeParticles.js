import { Matrix4, Vector3 } from 'three';
import { frameUniformsOf } from './uniforms.js';
import {
  PARTICLE_BYTES, NativeParticleParams, NATIVE_PARTICLE_LAYOUT, NATIVE_PARTICLE_ARGS_LAYOUT, NATIVE_PARTICLE_AIR_LAYOUT, NATIVE_PARTICLE_LIGHT_LAYOUT,
  nativeParticleWGSL, nativeParticlePipeline, nativeParticleArgsWGSL,
  ParticlePickParams, PARTICLE_PICK_LAYOUT, PICK_RAYS, particlePickWGSL,
} from '../shaders/v2/particleRender.js';
import { decoView } from '../deco.js';
import { CELL_M } from '../scale.js';

const vector = p => Array.isArray(p) || ArrayBuffer.isView(p) ? Array.from(p) : [p?.x ?? 0,p?.y ?? 0,p?.z ?? 0];

/**
 * The Box volume's light for the matter draw (particleRender.js particleLightWGSL): its sun map, the derived GI
 * probes' four bands, its media noise and samplers, or null where none is bound (World: its own readers).
 * @param {object} volume gfx/volume.js createVolume's (shadowTextures, mediaNoiseView)
 * @param {object} derived src/derived.js's (views.gi)
 */
export function boxParticleLight(volume, derived, gpu) {
  const map = volume?.shadowTextures?.map, gi = derived?.views?.gi, noise = volume?.mediaNoiseView, samplers = gpu?._volumeSamplers;
  if (!map || !noise || !samplers || gi?.length !== 4) return null;
  return { map, gi, noise, clamp: samplers.clamp, repeat: samplers.repeat };
}

/** CPU view data only: physics world coordinates are never rebased or copied.
 * lagSeconds: how far behind its record each particle is drawn (v2/host.js particleLagSeconds). */
export function nativeParticleView(camera, targetHeight, volumeMatrix, origin = [0,0,0], sample = 0, lagSeconds = 0) {
  if (!(targetHeight > 0) || !Number.isFinite(targetHeight)) throw new RangeError('invalid target height');
  const matrix = new Matrix4();
  if (volumeMatrix) matrix.fromArray(volumeMatrix.elements ?? volumeMatrix);
  if (!matrix.elements.every(Number.isFinite) || Math.abs(matrix.determinant()) < 1e-20) throw new Error('invalid volume matrix');
  const e = matrix.elements;
  // Conservative largest singular-value bound, including nonuniform scale/shear.
  const norm1 = Math.max(...[0,4,8].map(i => Math.abs(e[i])+Math.abs(e[i+1])+Math.abs(e[i+2])));
  const normInf = Math.max(...[0,1,2].map(i => Math.abs(e[i])+Math.abs(e[i+4])+Math.abs(e[i+8])));
  camera.updateMatrixWorld?.();
  const eye = camera.matrixWorld ? new Vector3().setFromMatrixPosition(camera.matrixWorld).toArray() : vector(camera.position);
  const o = vector(origin);
  if (o.length !== 3 || !o.every(Number.isFinite) || !eye.every(Number.isFinite)) throw new Error('invalid particle view coordinates');
  if (!Number.isInteger(sample) || sample < 0 || sample > 0xffffffff) throw new RangeError('invalid TAA sample');
  if (!(lagSeconds >= 0) || !Number.isFinite(lagSeconds)) throw new RangeError('invalid particle lag');
  // (velocity m/s × lag cells per m/s: cells; the records' velocity, renderState.velocity)
  return { inverseModel: matrix.invert().elements, origin: o, scale: Math.sqrt(norm1*normInf), eye, sample, lag: lagSeconds / CELL_M };
}

export function validateNativeParticleSource(state) {
  if (!state || state.version !== 1 || state.particleBytes !== PARTICLE_BYTES || state.position !== 'world cells'
    || state.particleIdOffset !== 12 || state.bankOffset !== 44 || state.liveCountOffset !== 0
    || state.coreOffsets?.join(',') !== '28,32,36,40'
    || !Number.isInteger(state.capacity) || state.capacity < 1 || state.capacity > 65536
    || !state.particles || !state.control || (state.deco && !(state.deco.buffer && state.deco.size >= state.capacity * 4))) throw new Error('unsupported native particle render ABI');
  if (state.particles.size < state.capacity*PARTICLE_BYTES || state.control.size < 4) throw new Error('native particle buffer too small');
  return state;
}

/** Direct native48B presentation; source buffers remain exclusively physics-owned.
 * updateView is CPU-only. prepareDraw records ONE tiny GPU count->indirect
 * dispatch before the scene pass; draw never opens/closes the caller's pass.
 */
export class NativeParticles {
  constructor(gpu, source = null) {
    if (source) validateNativeParticleSource(source.renderState ?? source);
    this.gpu = gpu;
    this.source = null;
    this.disposed = false;
    this.view = null;
    this.preparedFrame = null;
    this.fu = frameUniformsOf(gpu);
    this.layout = gpu.layout('NATIVE_PARTICLES_DRAW',NATIVE_PARTICLE_LAYOUT);
    this.argsLayout = gpu.layout('NATIVE_PARTICLES_ARGS',NATIVE_PARTICLE_ARGS_LAYOUT);
    this.airLayout = gpu.layout('NATIVE_PARTICLES_AIR',NATIVE_PARTICLE_AIR_LAYOUT);
    this.lightLayout = gpu.layout('NATIVE_PARTICLES_LIGHT',NATIVE_PARTICLE_LIGHT_LAYOUT);
    this.airGroups = new Map(); this.lightGroups = new Map();
    this.args = gpu.createBuffer({ label: 'native particles draw args', size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT });
    this.pipes = [false,true].map(rays => gpu.renderPipeline({
      name: rays ? 'nativeParticleRays' : 'nativeParticleMatter', code: nativeParticleWGSL(rays),
      layouts: [this.fu.layout,this.layout,rays ? this.airLayout : this.lightLayout], params: NativeParticleParams, ...nativeParticlePipeline(rays),
    }));
    this.countPipe = gpu.kernel({ name: 'nativeParticleArgs', code: nativeParticleArgsWGSL(),
      layouts: [this.argsLayout], params: NativeParticleParams });
    // the pick's particle pass (particleRender.js particlePickWGSL): built in idle time, as the
    // pick is never on the first frame; until it is, picks see the grid only
    this.pickLayout = gpu.layout('NATIVE_PARTICLES_PICK',PARTICLE_PICK_LAYOUT);
    this.pickPipe = gpu.kernel({ name: 'nativeParticlePick', code: particlePickWGSL(), build: 'idle',
      layouts: [this.fu.layout,this.pickLayout,this.airLayout], params: ParticlePickParams, workgroupSize: [64,1,1] });
    this.pickGroups = new Map();
    if (source) this.attachSource(source);
  }
  get state() { return this.source?.renderState ?? this.source; }
  get isReady() {
    return !this.disposed && !this.gpu.failure && this.state?.ready === true
      && [...this.pipes,this.countPipe].every(p => p.state === 'ready');
  }
  get ready() {
    return Promise.all([...this.pipes,this.countPipe].map(p => p.ready).concat(this.source?.ready)).then(() => {
      if (!this.isReady) throw new Error('native particle source/draw path not ready');
      return this;
    });
  }
  attachSource(source) {
    if (this.disposed) throw new Error('native particles disposed');
    if (source) validateNativeParticleSource(source.renderState ?? source);
    if (this.source?.drawAdapter === this) this.source.attachDrawAdapter?.(null);
    this.source = source;
    this.group = this.countGroup = null;
    this.boundParticles = this.boundControl = this.boundDeco = null;
    this.airGroups = new Map(); this.lightGroups = new Map();
    this.preparedFrame = null;
    source?.attachDrawAdapter?.(this);
    return this;
  }
  /**
   * The source's current coarse air (its brick's pressure: the Pressure view, the pick's P)
   * and the grid that numbers its bricks, as params and a group-2 bind group. A source
   * without air binds its records there, never read (grid.w 0: still air).
   */
  air() {
    const src = this.source, g = src?.g, buffer = src?.air?.[src.airIndex ?? 0] ?? null;
    const target = buffer ?? this.state.particles;
    let group = this.airGroups.get(target);
    if (!group) this.airGroups.set(target, group = this.gpu.bindGroup(this.airLayout,[{ binding: 0, resource: { buffer: target } }],'native particle air'));
    const grid = g ? [g.nx, g.ny, g.nz, buffer ? 1 : 0] : [0, 0, 0, 0];
    return { group, target, params: { grid, supers: g ? [g.stx, g.stz, 0, 0] : [0, 0, 0, 0] } };
  }
  /**
   * The matter draw's group 2: the air (air()) and the volume's light (boxParticleLight), or stand-ins never
   * read (P.light 0) without it, per air buffer and light.
   */
  lightGroup(air, light) {
    const target = air.target, key = light ? [light.map, light.noise, ...light.gi] : null;
    const byAir = this.lightGroups.get(target) ?? new Map();
    this.lightGroups.set(target, byAir);
    const k = key ? key[0] : null;
    let entry = byAir.get(k);
    if (entry && (!key || entry.key.every((x, i) => x === key[i]))) return entry.group;
    const gpu = this.gpu, view = (t, d) => (typeof t?.createView === 'function' ? t.createView(d) : t);
    const none = gpu._particleLightNone ??= {
      map: gpu.createTexture({ label: 'particle light map (none)', size: [1, 1], format: 'rgba32float', usage: 4 }),
      vol: gpu.createTexture({ label: 'particle light volume (none)', size: [1, 1, 1], dimension: '3d', format: 'rgba16float', usage: 4 }),
      sampler: gpu.device.createSampler({ label: 'particle light (none)' }),
    };
    const l = light ?? { map: none.map, gi: [none.vol, none.vol, none.vol, none.vol], noise: none.vol, clamp: none.sampler, repeat: none.sampler };
    const group = gpu.bindGroup(this.lightLayout, [
      { binding: 0, resource: { buffer: target } }, { binding: 1, resource: view(l.map, {}) },
      ...l.gi.map((t, i) => ({ binding: 2 + i, resource: view(t, { dimension: '3d' }) })),
      { binding: 6, resource: view(l.noise, { dimension: '3d' }) }, { binding: 7, resource: l.clamp }, { binding: 8, resource: l.repeat },
    ], 'native particle light');
    byAir.set(k, { key: key ?? [], group });
    return group;
  }
  updateView(camera, targetHeight, volumeMatrix = null, origin = [0,0,0], { sample = 0, lagSeconds = 0 } = {}) {
    this.view = nativeParticleView(camera,targetHeight,volumeMatrix,origin,sample,lagSeconds);
    this.preparedFrame = null;
  }
  prepareDraw(frame = this.gpu.frame) {
    this.preparedFrame = null;
    if (!this.isReady || !this.view || this.source.isIdle === true || this.source.active === false) return false;
    const s = validateNativeParticleSource(this.state);
    if (s.particles !== this.boundParticles || s.control !== this.boundControl || (s.deco?.buffer ?? null) !== this.boundDeco) {
      const b = (binding,buffer) => ({ binding, resource: { buffer } });
      // (a source without decoration words binds its records there again, read-only and never read: P.deco 0)
      const deco = s.deco ? { binding: 1, resource: { buffer: s.deco.buffer, offset: s.deco.offset, size: s.deco.size } } : b(1,s.particles);
      this.group = this.gpu.bindGroup(this.layout,[b(0,s.particles),deco],'native particle draw');
      this.countGroup = this.gpu.bindGroup(this.argsLayout,[b(0,s.control),b(1,this.args)],'native particle count');
      this.boundParticles = s.particles; this.boundControl = s.control; this.boundDeco = s.deco?.buffer ?? null;
    }
    // A GPU-zero live count means zero vertex work, even when air/emitter work
    // keeps the dynamics source awake. No async CPU count can race new spawns.
    this.countPipe.dispatch(frame,[1,1,1],{ bind: [this.countGroup], params: { ...this.view, capacity: s.capacity, viewport: [1,1] } });
    this.preparedFrame = frame;
    return true;
  }
  // light: the Box volume's (boxParticleLight), lighting the matter as V1's flying cells are lit; null: the open sky's
  draw(rp, { width, height }, light = null) {
    if (!this.isReady || !this.view || this.preparedFrame !== rp.frame || !this.preparedFrame
      || this.source.isIdle === true || this.source.active === false) return false;
    const s = this.state;
    if (s.particles !== this.boundParticles || s.control !== this.boundControl || (s.deco?.buffer ?? null) !== this.boundDeco) return false;
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new RangeError('invalid particle viewport');
    const air = this.air();
    const options = { bind: [this.fu.group,this.group,air.group], indirect: { buffer: this.args, offset: 0 },
      params: { ...this.view, ...air.params, capacity: s.capacity, viewport: [width,height], deco: s.deco && s.decoActive && decoView.show ? 1 : 0, light: light ? 1 : 0 } };
    const [matter, rays] = this.pipes;
    matter.draw(rp,{ ...options, bind: [this.fu.group,this.group,this.lightGroup(air,light)] });
    rays.draw(rp,options);
    return true; // Recorded, not a claim of a nonzero GPU count.
  }
  /**
   * After the grid's pick (gfx/volume.js recordPicks) wrote each ray's ring slot: the nearest
   * matter particle along each flat ray replaces the slot's hit where it is nearer (render.js
   * pickFrag's result: cell, face, id, T, P, life). Records into the same compute pass.
   * @param {object} frame the open frame (gpu.frame)
   * @param {{ ring: GPUBuffer, ro: number[][], rd: number[][], slot: number[][], n: number, origin: number[] }} rays
   * @returns {boolean} recorded (false: nothing flies, or the pass is building)
   */
  // shift: the rays' frame less the window's cells (World's pick: its origin, the rays and cells being
  // world cells there); transient: a one-pick output buffer (World's), whose group isn't kept
  recordPick(frame, { ring, ro, rd, slot, n, origin, shift = [0, 0, 0], transient = false }) {
    if (!this.isReady || this.pickPipe.state !== 'ready' || this.source.isIdle === true || this.source.active === false || !(n > 0)) return false;
    if (n > PICK_RAYS) throw new RangeError('native particle pick batch too large');
    const s = validateNativeParticleSource(this.state);
    const make = () => this.gpu.bindGroup(this.pickLayout,
      [{ binding: 0, resource: { buffer: s.particles } }, { binding: 1, resource: { buffer: ring } }],'native particle pick');
    let cached = transient ? null : this.pickGroups.get(ring);
    if (!transient && cached?.particles !== s.particles) {
      cached = { particles: s.particles, group: make() };
      this.pickGroups.set(ring, cached);
    }
    const group = cached ? cached.group : make();
    const air = this.air();
    this.pickPipe.dispatch(frame,[n,1,1],{ bind: [this.fu.group,group,air.group],
      params: { ro, rd, slot, n, origin: vector(origin), capacity: s.capacity, shift: vector(shift), lag: this.view?.lag ?? 0, ...air.params } });
    return true;
  }
  dispose() {
    if (this.disposed) return;
    this.attachSource(null);
    this.disposed = true;
    // Submit only our already-recorded references before destroying owned args.
    if (!this.gpu.failure) this.gpu.flush('native particles dispose');
    this.args.destroy();
    this.group = this.countGroup = this.view = null;
    this.pickGroups.clear(); this.airGroups.clear(); this.lightGroups.clear();
  }
}
