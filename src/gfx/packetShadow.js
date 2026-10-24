// V2's flying matter casts the sun's shadow in the Box (shaders/v2/packetShadow.js): the packet shadow
// buffer, the splat over the dynamics' pool, and the V2 shadow kernel, which stands in for V1's while V2's
// particles are the box's. gfx/volume.js recordShadow runs them; V1 boxes never build any of it.
import { packetShadowFrag, packetShadowSplatWGSL, packetShadowWords, PACKET_SHADOW_EMPTY, PacketShadowParams, PACKET_SPLAT_LAYOUT } from '../shaders/v2/packetShadow.js';
import { SHADOW_WORKGROUP } from '../shaders/render.js';
import { fold } from '../gpu/kernels.js';

/** The dynamics' particle source of the box's V2 owner, once its records can be read (else null). */
export function packetShadowSource(sim) {
  const d = sim.compact ? sim.compactOwner?.dynamics : null;
  const s = d && !d.disposed ? (d.renderState ?? null) : null;
  return s?.ready === true && s.particles && Number.isInteger(s.capacity) ? { dynamics: d, state: s } : null;
}

/**
 * The derived passes' key part for the packets (gfx/volume.js packetShadowKey): the packet kernel's state, and the
 * owner's tick while any matter may be in flight (the dynamics awake with live particles), '-' once it has landed.
 */
export function packetShadowKey(sim, state) {
  const source = packetShadowSource(sim);
  if (!source) return '';
  const d = source.dynamics, flying = d.isIdle !== true && (d.stats?.particles ?? 1) > 0;
  return `${state}:${flying ? d.owner?.tick ?? 0 : '-'}`;
}

export function createPacketShadow(gpu, { g, res, layouts, derived }) {
  const words = packetShadowWords(res);
  const buffer = gpu.createBuffer({ label: 'packet shadow', size: words * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  // every texel empty, no tile to trace again
  const init = new Uint32Array(words); init.fill(PACKET_SHADOW_EMPTY, 0, res * res);
  gpu.queue.writeBuffer(buffer, 0, init);
  const splatLayout = gpu.layout('PACKET_SPLAT', PACKET_SPLAT_LAYOUT);
  const kernel = gpu.kernel({ name: 'shadowPackets', code: packetShadowFrag(g, res), layouts: layouts.shadow,
    workgroupSize: [SHADOW_WORKGROUP, SHADOW_WORKGROUP, 1], build: 'idle' });
  const splat = gpu.kernel({ name: 'packetShadowSplat', code: packetShadowSplatWGSL(g, res), layouts: [layouts.frame, splatLayout],
    params: PacketShadowParams, workgroupSize: [64, 1, 1], build: 'idle' });
  const groups = new Map();
  return {
    buffer, kernel,
    /** Both kernels are built (the V1 kernel traces meanwhile, packets casting nothing). */
    get ready() { return kernel.state === 'ready' && splat.state === 'ready'; },
    build() { kernel.build(); splat.build(); },
    /** Records the splat: before the map's tiles are listed (derived.shadowTiles). */
    record(frame, fuGroup, source, origin) {
      const s = source.state;
      let group = groups.get(s.particles);
      if (!group) groups.set(s.particles, group = gpu.bindGroup(splatLayout, [
        { binding: 0, resource: { buffer: s.particles } }, { binding: 1, resource: { buffer } },
        { binding: 2, resource: { buffer: derived.brickDist } }], 'packet shadow splat'));
      // (nothing flying: last frame's tiles alone, a few workgroups)
      const capacity = source.dynamics.isIdle === true ? 0 : s.capacity;
      const threads = Math.max(capacity, 512);
      splat.dispatch(frame, fold(Math.ceil(threads / 64)), { bind: [fuGroup, group],
        params: { origin, capacity, grid: [g.nx, g.ny, g.nz, 0], res } });
    },
    dispose() { buffer.destroy(); groups.clear(); },
  };
}
