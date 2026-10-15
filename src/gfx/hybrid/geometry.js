import { frameUniformsOf } from '../uniforms.js';
import { fold } from '../../gpu/kernels.js';
import { gridDims, LAYOUT } from '../../shaders/common.js';
import {
  geometryCapacity, GeometryParams, ShadowParams, RESULT_BYTES,
  MESH_LAYOUT, COMPACT_LAYOUT, FACES_LAYOUT, meshWGSL, compactWGSL,
  drawWGSL, shadowWGSL, geometryPipelines,
} from '../../shaders/hybrid/geometry.js';

const STORAGE = 0x80, INDIRECT = 0x100;
// Exact ID comparisons run only when sim's version/copy/origin changes. The
// GPU rebuilds neighbouring faces only after a topology change, then compacts.
export function createHybridGeometry(gpu, sim, { world = false, facesPerBrick = 384, shader = {}, onRead = null } = {}) {
  const g = gridDims(sim.g), cap = geometryCapacity(g, gpu.device.limits, facesPerBrick);
  if (cap.reason) throw new RangeError(`hybrid geometry: ${cap.reason}`);
  if ((shader.layout ?? []).some(e => e.binding < 1)) throw new RangeError('geometry shading bindings start at 1');
  const fu = frameUniformsOf(gpu), label = s => `sim${sim.id} hybrid geometry ${s}`;
  const layout = (name, entries) => gpu.layout(label(name), entries);
  const tables = gpu.layout('TABLES', LAYOUT.TABLES), state = gpu.layout('STATE_RO', LAYOUT.STATE_RO);
  const meshLayout = layout('mesh', MESH_LAYOUT), compactLayout = layout('compact', COMPACT_LAYOUT);
  const drawLayout = layout(`draw ${JSON.stringify(shader.layout ?? [])}`, [...FACES_LAYOUT, ...(shader.layout ?? [])]);
  const shadowLayout = layout('shadow', FACES_LAYOUT);
  const buffer = (name, size, usage = STORAGE) => gpu.createBuffer({ label: label(name), size, usage });
  const previous = buffer('previous IDs', g.slots * 4), bricks = buffer('brick metadata', g.nbricks * 16);
  const faces = buffer('persistent faces', cap.faceBytes), compact = buffer('draw faces', cap.faceBytes);
  const args = buffer('draw arguments', 16, STORAGE | INDIRECT | 0x04), control = buffer('control', 20);
  const ring = gpu.readback.ring(label('status'), RESULT_BYTES, 16);
  const entries = buffers => buffers.map((b, binding) => ({ binding, resource: { buffer: b } }));
  const meshGroup = gpu.bindGroup(meshLayout, entries([previous, bricks, faces]), label('mesh'));
  const compactGroup = gpu.bindGroup(compactLayout, entries([bricks, faces, compact, args, control, ring.buffer]), label('compact'));
  const shadowGroup = gpu.bindGroup(shadowLayout, entries([compact]), label('shadow'));
  const code = meshWGSL(g), compactCode = compactWGSL(g);
  const meshKernel = entry => gpu.kernel({ name: label(entry), code, entry, layouts: [tables, state, meshLayout],
    params: GeometryParams, workgroupSize: [64, 1, 1] });
  const compactKernel = entry => gpu.kernel({ name: label(entry), code: compactCode, entry, layouts: [tables, undefined, compactLayout],
    params: GeometryParams, workgroupSize: [entry === 'compact' ? 64 : 1, 1, 1] });
  const compare = meshKernel('compare'), mesh = meshKernel('mesh');
  const prepare = compactKernel('prepare'), gather = compactKernel('compact'), finish = compactKernel('finish');
  const pipeline = geometryPipelines();
  const opaque = gpu.renderPipeline({ name: label('opaque'), code: drawWGSL(g, shader),
    layouts: [fu.layout, state, drawLayout], ...pipeline.opaque });
  const shadow = gpu.renderPipeline({ name: label('shadow'), code: shadowWGSL(g),
    layouts: [tables, undefined, shadowLayout], params: ShadowParams, ...pipeline.shadow });
  const all = [compare, mesh, prepare, gather, finish, opaque, shadow];
  let disposed = false, key = null, origin = null, serial = 0, frame = {}, drawGroup = null, extra = [];
  const stats = { builds: 0, rebuiltBricks: 0, overflow: false, unsupported: false,
    fallbackRequired: true, bytes: g.slots * 4 + g.nbricks * 16 + cap.faceBytes * 2 + 36 };
  const blocked = f => !!(f.sourceAppearance || f.decoration || f.warp?.k);
  const api = {
    ready: Promise.all(all.map(p => p.ready)).then(() => api),
    get isReady() { return !disposed && !gpu.failure && all.every(p => p.state === 'ready'); },
    get revision() { return key ?? 'unbuilt'; },
    stats,
    resources: { faces: compact, args, layout: drawLayout, get bind() { return drawGroup; } },
    update(next = {}) {
      frame = next;
      if (!api.isReady || blocked(frame)) { stats.fallbackRequired = true; return false; }
      const added = typeof shader.entries === 'function' ? shader.entries(frame) : shader.entries ?? [];
      if (!drawGroup || added.length !== extra.length || added.some((e, i) => e.binding !== extra[i].binding || e.resource !== extra[i].resource)) {
        extra = added;
        drawGroup = gpu.bindGroup(drawLayout, [...entries([compact]), ...added], label('draw'));
      }
      const o = sim.origin, nextOrigin = `${o.x},${o.y},${o.z}`;
      const nextKey = `${sim.version}|${sim.cur}|${nextOrigin}|${frame.revision ?? ''}`;
      if (key === nextKey && !frame.force) {
        stats.fallbackRequired = stats.overflow || stats.unsupported;
        return false;
      }
      const force = !key || frame.force || origin !== nextOrigin;
      key = nextKey; origin = nextOrigin;
      const token = ++serial, header = sim.header(), slot = ring.next();
      const params = { capacity: cap.capacity, force: force ? 1 : 0, world: world ? 1 : 0, slot };
      const dispatch = fold(g.nbricks), f = gpu.frame;
      const meshArgs = { bind: [sim.tables, sim.bindRO, meshGroup], header, params };
      compare.dispatch(f, dispatch, meshArgs);
      mesh.dispatch(f, dispatch, meshArgs);
      const compactArgs = { bind: [sim.tables, undefined, compactGroup], header, params };
      prepare.dispatch(f, [1, 1, 1], compactArgs);
      gather.dispatch(f, dispatch, compactArgs);
      finish.dispatch(f, [1, 1, 1], compactArgs);
      stats.builds++;
      // GPU finish suppresses invalid geometry in this same frame. The volume
      // behind it remains the fallback, even before this diagnostic read lands.
      stats.fallbackRequired = false;
      ring.read(slot).then(bytes => {
        if (disposed || token !== serial) return;
        const [rebuilt, overflow, unsupported] = new Uint32Array(bytes);
        Object.assign(stats, { rebuiltBricks: rebuilt, overflow: !!overflow, unsupported: !!unsupported,
          fallbackRequired: !!(overflow || unsupported) });
        onRead?.();
      }, () => {
        if (disposed || token !== serial) return;
        stats.fallbackRequired = true;
        onRead?.();
      });
      return true;
    },
    drawOpaque(rp) {
      if (!api.isReady || !key || !drawGroup || blocked(frame) || stats.fallbackRequired) return false;
      opaque.draw(rp, { bind: [fu.group, sim.bindRO, drawGroup], header: sim.header(), indirect: { buffer: args } });
      return true;
    },
    drawShadow(rp, { matrix } = {}) {
      if (!matrix || !api.isReady || !key || blocked(frame) || stats.fallbackRequired) return false;
      shadow.draw(rp, { bind: [sim.tables, undefined, shadowGroup], header: sim.header(),
        params: { matrix }, indirect: { buffer: args } });
      return true;
    },
    invalidate() { key = null; serial++; stats.fallbackRequired = true; },
    dispose() {
      if (disposed) return;
      disposed = true; serial++;
      gpu.flush('hybrid geometry dispose'); ring.close();
      for (const b of [previous, bricks, faces, compact, args, control]) b.destroy();
      drawGroup = null;
    },
  };
  return api;
}
