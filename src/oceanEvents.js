import { createNativeWeatherKernel } from './v2/nativeWeather.js';
import { fold } from './gpu/kernels.js';
import { OCEAN_EVENT as C, OceanColumnsParams, OCEAN_COLUMNS_LAYOUT, oceanColumnsWGSL, oceanEventsEdit } from './shaders/oceanEvents.js';
export { OCEAN_EVENT } from './shaders/oceanEvents.js';

const clamp = n => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
const smooth = x => { const t = clamp(x); return t * t * (3 - 2 * t); };
export const surgeEnvelope = age => Number.isFinite(age) && age >= 0 && age < C.duration
  ? smooth(age / C.rise) * (1 - smooth((age - C.hold) / (C.duration - C.hold))) : 0;
const originOf = sim => sim.origin.toArray();
const valid = c => !!c?.sim && !c.sim.disposed && c.oceanEligible !== false && c.world?.loaded !== false
  && Number.isFinite(c.seaLevel) && c.seaLevel - c.sim.origin.y >= 2
  && c.seaLevel - c.sim.origin.y < c.sim.g.ny && typeof c.groundHeight === 'function';
const bed = (c, x, z) => { const h = c.groundHeight(x, z); return Number.isFinite(h) ? h : Infinity; };
const identityOf = c => [c?.sim, c?.world, c?.world?.epoch, c?.mapId ?? c?.world?.scene?.key, c?.seaLevel];
const equal = (a, b) => a?.length === b?.length && a.every((v, i) => v === b[i]);

// Generator candidates only: the live column mask below is authoritative.
// This is local to the active window, not a claim of simulating unloaded sea.
export function oceanSourceCandidates(context) {
  if (!valid(context)) return [];
  const { sim, seaLevel: sea } = context, { nx, ny, nz } = sim.g, o = originOf(sim);
  if (sea - o[1] + C.height >= ny - 1) return [];
  const target = context.target ?? [o[0] + nx / 2, o[2] + nz / 2];
  if (!Array.isArray(target) || target.length !== 2 || !target.every(Number.isFinite)) return [];
  const candidates = [];
  for (let side = 0; side < 4; side++) {
    const axis = side < 2 ? 0 : 1, positive = side % 2 === 0;
    const span = axis === 0 ? nz : nx, length = axis === 0 ? nx : nz;
    const direction = axis === 0 ? [positive ? 1 : -1, 0] : [0, positive ? 1 : -1];
    for (let across = C.halfWidth + 1; across < span - C.halfWidth; across += 8) {
      const start = [o[0] + (axis === 0 ? (positive ? 0.5 : nx - 0.5) : across + 0.5),
        o[2] + (axis === 1 ? (positive ? 0.5 : nz - 0.5) : across + 0.5)];
      if (bed(context, ...start) >= sea - 2) continue;
      for (let d = 4; d < length - 2; d += 4) {
        const shore = start.map((v, k) => v + direction[k] * d);
        if (bed(context, ...shore) < sea - 1) continue;
        if (d < 12) break;
        const source = start.map((v, k) => v + direction[k] * Math.max(5, d - 16));
        const transverse = [-direction[1], direction[0]];
        if ([-7, 0, 7].some(s => bed(context, source[0] + transverse[0] * s, source[1] + transverse[1] * s) >= sea - 2)) break;
        candidates.push({ source, direction, shore, distance: Math.hypot(shore[0] - target[0], shore[1] - target[1]) });
        break;
      }
    }
  }
  return candidates.sort((a, b) => a.distance - b.distance);
}

// Open ocean outside each window edge, conservatively checked against the
// generator at 1/8/16 cells. Unknown terrain is closed, never decorative water.
export function oceanOpenEdges(context) {
  const { nx, nz } = context.sim.g, o = originOf(context.sim), stride = Math.max(nx, nz);
  const data = new Uint32Array(stride * 4);
  for (let side = 0; side < 4; side++) {
    const axis = side < 2 ? 0 : 1, positive = side % 2 === 0, count = axis === 0 ? nz : nx;
    for (let i = 0; i < count; i++) {
      data[side * stride + i] = [1, 8, 16].every(distance => {
        const x = o[0] + (axis === 0 ? (positive ? -distance : nx - 1 + distance) : i + 0.5);
        const z = o[2] + (axis === 1 ? (positive ? -distance : nz - 1 + distance) : i + 0.5);
        return bed(context, x, z) < context.seaLevel - 2;
      }) ? 1 : 0;
    }
  }
  return data;
}

// Only step writes material, once per advancing physics frame, never from a
// presentation callback. ctx: {sim,world?,mapId?,seaLevel,groundHeight(x,z),
// target?:[x,z],oceanEligible?,paused?,isGuest?}; state: {ocean,wind?:[x,z]}.
// Unknown generator terrain must return NaN. trigger is async and only arms a
// source; cancel/reset invalidate its readback too. Clear chop with ocean=0.
export function createOceanEvents() {
  let resources = null, map = null, event = null, request = null, generation = 0;
  let lastFrame = null, nextSource = 0, nextChop = 0, disposed = false;
  function release() {
    if (!resources) return;
    const { sim, columns, edges } = resources;
    sim._retire(columns); sim._retire(edges);
    resources = null;
  }
  function reset() {
    generation++; request = null; event = null; map = null;
    lastFrame = null; nextSource = nextChop = 0;
    if (resources) resources.edgeKey = null;
  }
  function sameMap(context) {
    const key = identityOf(context);
    if (!equal(map, key)) { reset(); map = key; }
  }
  function ensure(sim) {
    if (resources?.sim === sim && resources.g === sim.g) return resources;
    release();
    const gpu = sim.gpu, g = sim.g;
    const layout = gpu.layout('OCEAN_COLUMNS', OCEAN_COLUMNS_LAYOUT);
    const probe = gpu.kernel({ name: 'oceanColumns', code: oceanColumnsWGSL(g),
      layouts: [sim.L.TABLES, sim.L.STATE_RO, layout], params: OceanColumnsParams });
    const force = sim.compactOwner ? createNativeWeatherKernel(sim, 'oceanForce', oceanEventsEdit) : sim.editKernel('oceanForce', oceanEventsEdit);
    // GPUBufferUsage bits, so importing and CPU-mocking need no browser globals.
    const columns = gpu.createBuffer({ label: 'ocean columns', size: g.nx * g.nz * 8, usage: 0x80 | 0x04 });
    const edges = gpu.createBuffer({ label: 'ocean open edges', size: Math.max(g.nx, g.nz) * 16, usage: 0x80 | 0x08 });
    const group = gpu.bindGroup(layout, [
      { binding: 0, resource: { buffer: edges } }, { binding: 1, resource: { buffer: columns } },
    ], 'ocean columns');
    const r = { sim, g, probe, force, columns, edges, group, edgeKey: null, ready: false };
    // Readiness callbacks never dispatch a material writer.
    r.whenReady = Promise.all([probe.ready, force.ready]).then(() => { r.ready = true; });
    r.whenReady.catch(() => {}); // GPU service reports compilation failure; trigger still rejects it.
    resources = r;
    return r;
  }
  function updateColumns(context, r) {
    const sim = context.sim, key = [...originOf(sim), context.seaLevel, context.groundHeight];
    const read = sim.compact ? sim.bindPhysicalRO : sim.bindRO;
    if (!read) return false;
    if (!equal(r.edgeKey, key)) {
      sim.gpu.write(r.edges, 0, oceanOpenEdges(context));
      r.edgeKey = key;
    }
    r.probe.dispatch(sim.gpu.frame, fold(Math.ceil(sim.g.nx * sim.g.nz / 64)), {
      bind: [sim.tables, read, r.group], header: sim.readHeader({ physical: true }), params: { sea: context.seaLevel },
    });
    return true;
  }
  const api = {
    get active() { return !!event; },
    get pending() { return !!request; },
    get status() { return !event ? 'idle' : event.age < C.rise ? 'building' : event.age < C.hold ? 'surging' : 'receding'; },
    get source() { return event ? { position: [...event.source], direction: [...event.direction], age: event.age } : null; },
    async trigger(context) {
      if (disposed || !valid(context) || context.isGuest || context.world?.pending) return false;
      sameMap(context);
      if (event || request) return false;
      const candidates = oceanSourceCandidates(context).slice(0, 16);
      if (!candidates.length) return false;
      const sim = context.sim, world = context.world, identity = identityOf(context), o = originOf(sim);
      const token = ++generation, frame = sim.frame * C.stepsPerSecond / (context.stepHz ?? C.stepsPerSecond);
      request = token;
      const current = () => !disposed && request === token && generation === token && valid(context)
        && !context.isGuest && !world?.pending && equal(identity, identityOf(context))
        && equal(map, identity) && equal(o, originOf(sim)) && sim.frame * C.stepsPerSecond / (context.stepHz ?? C.stepsPerSecond) >= frame;
      try {
        const r = ensure(sim);
        await r.whenReady;
        if (!current()) return false;
        if (!updateColumns(context, r)) return false;
        const bytes = await sim.gpu.readback.buffer(r.columns, 0, r.columns.size);
        if (!current()) return false;
        const data = new Float32Array(bytes);
        for (const candidate of candidates) {
          const x = Math.floor(candidate.source[0] - o[0]), z = Math.floor(candidate.source[1] - o[2]);
          const i = (x + sim.g.nx * z) * 2;
          if (!(data[i] >= 0.5) || !(Math.abs(data[i + 1] - context.seaLevel) <= 3)) continue;
          const now = sim.frame * C.stepsPerSecond / (context.stepHz ?? C.stepsPerSecond);
          event = { ...candidate, started: now, age: 0 };
          lastFrame = now; nextSource = now + 1;
          return true;
        }
        return false;
      } finally { if (request === token) request = null; }
    },
    step(state, context) {
      if (disposed) return false;
      sameMap(context);
      if (!valid(context)) { reset(); return false; }
      if (context.isGuest || context.paused || context.world?.pending) return false;
      const { sim, seaLevel: sea } = context, frame = sim.frame * C.stepsPerSecond / (context.stepHz ?? C.stepsPerSecond);
      if (!Number.isSafeInteger(frame) || frame < 0) return false;
      if (lastFrame !== null && frame <= lastFrame) {
        if (frame < lastFrame) { reset(); map = identityOf(context); lastFrame = frame; }
        return false;
      }
      lastFrame = frame;
      if (event) {
        event.age = (frame - event.started) / C.stepsPerSecond;
        if (event.age >= C.duration) event = null;
      }
      const o = originOf(sim), { nx, ny, nz } = sim.g;
      const extent = event?.direction.map(d => Math.abs(d) * C.halfDepth + (1 - Math.abs(d)) * C.halfWidth);
      const inWindow = event && event.source[0] + extent[0] >= o[0] && event.source[0] - extent[0] < o[0] + nx
        && event.source[1] + extent[1] >= o[2] && event.source[1] - extent[1] < o[2] + nz;
      const surge = inWindow && frame >= nextSource ? surgeEnvelope(event.age) : 0;
      const chop = frame >= nextChop ? clamp(state?.ocean) : 0;
      if (!surge && !chop) return false;
      const r = ensure(sim);
      if (!r.ready) return false;
      let wind = state?.wind ?? context.wind ?? [0.8, 0.6];
      const length = Math.hypot(wind[0], wind[1]);
      wind = Number.isFinite(length) && length > 1e-8 ? [wind[0] / length, wind[1] / length] : [0.8, 0.6];
      const lo = [0, Math.max(0, Math.floor(sea - o[1] - 6)), 0];
      const hi = [nx - 1, Math.min(ny - 1, Math.ceil(sea - o[1] + (surge ? C.height : 4))), nz - 1];
      if (!chop && event) {
        lo[0] = Math.max(0, Math.floor(event.source[0] - extent[0] - o[0]));
        hi[0] = Math.min(nx - 1, Math.floor(event.source[0] + extent[0] - o[0]));
        lo[2] = Math.max(0, Math.floor(event.source[1] - extent[1] - o[2]));
        hi[2] = Math.min(nz - 1, Math.floor(event.source[1] + extent[1] - o[2]));
      }
      if (lo.some((v, i) => v > hi[i])) return false;
      if (!updateColumns(context, r)) return false; // ordered before edit; authoritative live mask each forcing tick
      const values = {
        sea, time: frame / C.stepsPerSecond, chop, surge, wind,
        source: event?.source ?? [0, 0], direction: event?.direction ?? [1, 0],
      };
      if (sim.compactOwner) r.force.run({ lo, hi }, values, r.columns);
      else sim.edit(r.force, { lo, hi }, values, { bind: [{ buffer: r.columns }], scrub: !!surge });
      // Keep the original phase when 60Hz ticks straddle a 240Hz-authored
      // pulse boundary (30 old ticks = 7.5 native ticks). Skip missed pulses
      // rather than drifting the source rate or performing unbounded catch-up.
      if (surge) nextSource = context.stepHz === 60 ? nextSource + (Math.floor((frame - nextSource) / C.sourceEvery) + 1) * C.sourceEvery : frame + C.sourceEvery;
      if (chop) nextChop = context.stepHz === 60 ? nextChop + (Math.floor((frame - nextChop) / C.chopEvery) + 1) * C.chopEvery : frame + C.chopEvery;
      return true;
    },
    // Stop sources, never erase already-created WATER or cancel its momentum.
    cancel() { const was = !!event || !!request; generation++; event = null; request = null; return was; },
    reset,
    dispose() { if (disposed) return; reset(); release(); disposed = true; },
  };
  return api;
}
