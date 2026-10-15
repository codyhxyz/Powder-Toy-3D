// Opt-in isolated matter renderer; NOT independent simulation particles.
// Integration contract:
// 1. Smooth must exclude hybridParticleOwns cells before field blur/EMA,
//    including historical tails. Derived.setParticleSplit(true) before updateBricks
//    enables the split; caller ownershipReady assertions are not trusted.
// 2. Write shared FrameUniforms once before recording readers. update({size,
//    revision, sourceStyle}) precedes the scene pass. size=[renderWidth,height].
//    No update/draw submission or synchronous readback occurs here.
// 3. If stats.fallbackRequired, retain the ENTIRE legacy scene for this
//    revision (not just the missing cells). draw/drawShadow return false.
//    All generations record in the same frame; async counts only report errors.
//    overflow suppresses the whole indirect draw, never a partial append.
// 4. draw(rp) targets linear premultiplied rgba16float + depth32float.
//    drawShadow(rp,{matrix}) targets depth32float, matrix=grid->light clip.
// 5. Recreate on grid/device replacement. invalidate() on external resources
//    not tracked by sim.version; revisions key undo/load/edit/window shifts.
//    No work is recorded on unchanged update calls.
//
// Optional composition: shader={wgsl,layout,bind,handlesAppearance:false}.
// wgsl defines hybridParticleShade(id,seed,p,n,temp)->vec3f (linear radiance).
// Adapt hybridMaterial(id:i32, seed:f32[0,1), p:vec3f,n:vec3f,temp:Celsius)
// plus shared lighting here; optional layout/bind occupy group 2. bind may
// be a function(frame)->GPUBindGroup. No standard material struct is imposed.
// handlesAppearance is a caller guarantee that both source art and decoration
// are handled by that adapter; otherwise these scenes explicitly fall back.
// Public resources expose {instances,args,layout,bind,capacity,stride} for
// alternate materials/shadow owners. Instance ABI is in shaders/hybrid/particles.
import { frameUniformsOf } from '../uniforms.js';
import { fold } from '../../gpu/kernels.js';
import {
  PARTICLE_BYTES, PARTICLE_MESH_LAYOUT, PARTICLE_DRAW_LAYOUT,
  ParticleMeshParams, ParticleDrawParams, particleCapacity,
  particleMeshWGSL, particleDrawWGSL, particleShadowWGSL,
} from '../../shaders/hybrid/particles.js';
export { PARTICLE_OWNERSHIP, particleOwns, particleOwnershipWGSL } from '../../shaders/hybrid/particles.js';

const STORAGE = 0x80, INDIRECT = 0x100;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** createHybridParticles(gpu,sim,{world=false,capacity=allCells,
 * shader}) -> {ready,isReady,stats,revision,resources,
 * update,draw,drawShadow,invalidate,dispose}. Optics owns ALL liquids,
 * molten matter and glass, including isolated droplets. Organic/granular
 * ownership is the exact 26-neighbour same-channel predicate exported above.
 * Current source state has no subcell position; cell+.5 is its real location.
 */
export function createHybridParticles(gpu, sim, {
  world = false, capacity: requested = sim.g.slots, shader = {},
} = {}) {
  if (shader.wgsl !== undefined && typeof shader.wgsl !== 'string') throw new TypeError('shader.wgsl must be WGSL');
  if (shader.handlesAppearance && !shader.wgsl) throw new TypeError('Appearance support requires a shader adapter');
  if (Boolean(shader.layout) !== Boolean(shader.bind)) throw new TypeError('shader.layout and shader.bind must be supplied together');
  const g = sim.g, fu = frameUniformsOf(gpu);
  const capacity = particleCapacity(g.slots, Math.min(gpu.device.limits.maxStorageBufferBindingSize,
    gpu.device.limits.maxBufferSize ?? Infinity), requested);
  const derived = sim.derived;
  const label = (s) => `sim${sim.id} hybrid particles ${s}`;
  const meshLayout = gpu.layout('HYBRID_PARTICLE_MESH', PARTICLE_MESH_LAYOUT);
  const drawLayout = gpu.layout('HYBRID_PARTICLE_DRAW', PARTICLE_DRAW_LAYOUT);
  const instances = gpu.createBuffer({ label: label('instances'), size: capacity * PARTICLE_BYTES, usage: STORAGE });
  const count = gpu.createBuffer({ label: label('count'), size: 4, usage: STORAGE });
  const args = gpu.createBuffer({ label: label('indirect'), size: 16, usage: STORAGE | INDIRECT });
  const ring = gpu.readback.ring(label('counts'), 16, 16);
  const meshGroup = gpu.bindGroup(meshLayout, [instances, count, args, ring.buffer].map((buffer, binding) => ({ binding, resource: { buffer } })), label('mesh'));
  const drawGroup = gpu.bindGroup(drawLayout, [{ binding: 0, resource: { buffer: instances } }], label('draw'));
  const code = particleMeshWGSL(g);
  const meshDesc = { code, layouts: [sim.L.TABLES, sim.L.STATE_RO, meshLayout], params: ParticleMeshParams };
  const mesh = gpu.kernel({ name: 'hybrid.particles.compact', ...meshDesc, workgroupSize: [64, 1, 1] });
  const finish = gpu.kernel({ name: 'hybrid.particles.finish', ...meshDesc, entry: 'finish', workgroupSize: [1, 1, 1] });
  const depthStencil = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' };
  const primitive = { topology: 'triangle-list', cullMode: 'none' };
  const drawPipe = gpu.renderPipeline({ name: 'hybrid.particles.draw', code: particleDrawWGSL(g, { shadeWGSL: shader.wgsl }),
    layouts: [fu.layout, drawLayout, shader.layout], params: ParticleDrawParams,
    fragment: { targets: [{ format: 'rgba16float' }] }, depthStencil, primitive });
  const shadowPipe = gpu.renderPipeline({ name: 'hybrid.particles.shadow', code: particleShadowWGSL(),
    layouts: [undefined, drawLayout], params: ParticleDrawParams, fragment: null, depthStencil, primitive });
  const pipes = [mesh, finish, drawPipe, shadowPipe];
  let disposed = false, key = null, generation = 0, frameState = {};
  let viewport = [1, 1];
  const stats = { builds: 0, count: 0, capacity, overflow: false, pending: false,
    fallbackRequired: true, fallbackReason: 'ownership-not-split', readbackError: null };
  function fallback(reason) { stats.fallbackRequired = !!reason; stats.fallbackReason = reason; }
  function blocked(frame) {
    if (gpu.failure || sim.disposed || sim.g !== g) return 'grid-or-device-unavailable';
    if (!derived?.particleSplit || sim.derived !== derived || !!derived.world !== !!world) return 'ownership-not-split';
    if (!shader.handlesAppearance && (frame.sourceStyle || fu.last?.sourceStyle || sim.deco?.active)) return 'source-or-decoration-unsupported';
    return '';
  }
  const api = {
    ready: Promise.all(pipes.map((p) => p.ready)).then(() => api),
    get isReady() { return !disposed && !gpu.failure && pipes.every((p) => p.state === 'ready'); },
    get revision() { return `${generation}|${key}|${stats.fallbackReason}`; },
    capabilities: Object.freeze({ particleSplit: true, channels: [2, 3], liquids: false }),
    stats,
    resources: { instances, args, layout: drawLayout, bind: drawGroup, capacity, stride: PARTICLE_BYTES },
    /** size: positive integer render pixels. sourceStyle must be supplied for
     * source-art scenes. Actual Derived mode (and matching world halo) is required. */
    update(frame = {}) {
      if (!api.isReady) return false;
      frameState = frame;
      if (frame.size) {
        if (!Array.isArray(frame.size) || frame.size.length !== 2 || !frame.size.every((v) => Number.isInteger(v) && v > 0)) throw new RangeError('size must be [width,height] in render pixels');
        viewport = [...frame.size];
      }
      const reason = blocked(frame);
      if (reason) { fallback(reason); return false; }
      const o = sim.origin;
      const nextKey = `${sim.version}|${sim.cur}|${o.x},${o.y},${o.z}|${frame.revision ?? ''}`;
      if (key === nextKey && !frame.force) {
        fallback(stats.readbackError ? 'count-readback-failed' : stats.overflow ? 'capacity-overflow' : '');
        return false;
      }
      key = nextKey;
      const token = ++generation;
      stats.pending = true;
      stats.overflow = false;
      stats.readbackError = null;
      fallback('');
      const bind = [sim.tables, sim.bindRO, meshGroup], header = sim.header();
      const params = { capacity, slot: 0, world: world ? 1 : 0 };
      mesh.dispatch(gpu.frame, fold(g.nbricks), { bind, header, params });
      const slot = ring.next();
      finish.dispatch(gpu.frame, [1, 1, 1], { bind, header, params: { ...params, slot } });
      stats.builds++;
      ring.read(slot).then((bytes) => {
        if (disposed || token !== generation) return;
        const [n, overflow] = new Uint32Array(bytes);
        stats.count = n;
        stats.pending = false;
        stats.overflow = !!overflow;
        fallback(blocked(frameState) || (overflow ? 'capacity-overflow' : ''));
      }, (error) => {
        if (disposed || token !== generation) return;
        stats.pending = false;
        stats.readbackError = String(error);
        fallback('count-readback-failed');
      });
      return true;
    },
    /** Draw only when update has a safe, disjoint generation. Return false
     * tells the parent to route legacy instead. No render pass is opened. */
    draw(rp) {
      if (!canDraw()) return false;
      const extra = typeof shader.bind === 'function' ? shader.bind(frameState) : shader.bind;
      drawPipe.draw(rp, { bind: [fu.group, drawGroup, extra], params: { matrix: IDENTITY, viewport }, indirect: { buffer: args } });
      return true;
    },
    drawShadow(rp, { matrix } = {}) {
      if (!matrix || !canDraw()) return false;
      shadowPipe.draw(rp, { bind: [undefined, drawGroup], params: { matrix, viewport }, indirect: { buffer: args } });
      return true;
    },
    invalidate() { key = null; generation++; stats.pending = false; fallback('invalidated'); },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      stats.pending = false;
      fallback('disposed');
      gpu.flush('hybrid particles dispose');
      ring.close();
      for (const buffer of [instances, count, args]) buffer.destroy();
    },
  };
  function canDraw() {
    if (!api.isReady || !key) return false;
    const reason = blocked(frameState);
    if (reason) fallback(reason);
    return !stats.fallbackRequired;
  }
  return api;
}
