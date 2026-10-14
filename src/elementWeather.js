import { createNativeWeatherKernel } from './v2/nativeWeather.js';
import { fold } from './gpu/kernels.js';
import { E } from './elements.js';
import {
  weatherRoofFrag, weatherUpdateWGSL, weatherDeclsWGSL, WeatherParams,
  WEATHER_ROOF_LAYOUT, WEATHER_SOURCE_LAYOUT,
} from './shaders/elementWeather.js';

// TPT's material sources, four bounded pulses per simulation second (240 Hz).
// Bands fit the active simulation height; no kilometre-high fake atmosphere.
export const ELEMENT_WEATHER = Object.freeze({ cadence: 60, cloudDepth: 12, cloudMargin: 4, fogDepth: 9 });
const unit = v => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;

// Pure policy. Only an explicitly permitted host simulation step can emit.
export function elementWeatherPolicy(state, context = {}) {
  const { sim, world, advancing = false, host = false } = context;
  if (!state || !advancing || !host || !sim || sim.disposed || sim.gpu?.failure || sim.gpu?.lost || context.enabled === false || world?.loaded === false) return null;
  if (!world && context.enabled !== true) return null;
  const sea = context.seaLevel ?? world?.P?.sea;
  const origin = [sim.origin.x, sim.origin.y, sim.origin.z];
  if (!Number.isFinite(sea) || !origin.every(Number.isFinite) || !Number.isSafeInteger(sim.frame) || sim.frame < 0) return null;
  const cloudOn = context.cloudEnabled !== false && ['overcast', 'rain', 'storm'].includes(state.preset);
  const cloud = cloudOn ? unit(state.cloud) : 0;
  const rain = ['rain', 'storm'].includes(state.preset) ? unit(state.rain) : 0;
  const storm = state.preset === 'storm' ? unit(state.storm) : 0;
  const fog = context.fogEnabled === false ? 0 : unit(state.fog);
  if (cloud + fog <= 0) return null;
  const ceiling = origin[1] + sim.g.ny - ELEMENT_WEATHER.cloudMargin;
  const bottom = Math.max(origin[1] + 2, sea + 14, ceiling - ELEMENT_WEATHER.cloudDepth);
  const fogBottom = Math.max(origin[1] + 1, sea + 1);
  const fogTop = Math.min(origin[1] + sim.g.ny - 1, sea + 1 + ELEMENT_WEATHER.fogDepth);
  const boxes = [];
  const band = (on, low, high) => {
    if (!on || low >= high) return false;
    // Inclusive indices whose centres lie in [low, high), not padded bounds.
    const lo = Math.max(0, Math.ceil(low - origin[1] - 0.5));
    const hi = Math.min(sim.g.ny - 1, Math.ceil(high - origin[1] - 0.5) - 1);
    if (lo > hi) return false;
    boxes.push({ lo: [0, lo, 0], hi: [sim.g.nx - 1, hi, sim.g.nz - 1] });
    return true;
  };
  const high = band(cloud > 0, bottom, ceiling);
  const low = band(fog > 0, fogBottom, fogTop);
  if (!high && !low) return null;
  const wind = state.wind;
  const length = Array.isArray(wind) && wind.length === 2 && wind.every(Number.isFinite) ? Math.hypot(...wind) : 0;
  return {
    source: [high ? cloud : 0, high ? rain : 0, high ? storm : 0, low ? fog : 0],
    bands: [bottom, ceiling, fogBottom, fogTop],
    wind: length > 0 ? wind.map(v => v / length) : [0.8, 0.6],
    time: Number.isFinite(state.time) ? Math.max(0, state.time) : 0,
    boxes,
  };
}

/**
 * Call BEFORE sim.step(), including manual test stepping:
 *   sources.step(state, { sim, world, advancing: true, host: !mp.isGuest, fogEnabled });
 * The first permitted call lazily prepares kernels; await sources.ready in a
 * fixture, then call step again. Readiness callbacks NEVER write simulation.
 * Clear/reset stop sources; clearFog explicitly erases the low cloud layer.
 * Box fixtures may explicitly opt in with enabled:true and seaLevel.
 */
export function createElementWeather() {
  let current = null, resources = null, worldKey = null, epoch = null;
  let nextFrame = 0, lastFrame = -1, disposed = false, pulses = 0;
  function release() {
    // Reuse the sim's buffer retirement: an open encoder can still reference
    // this roof. Retirement only frees our buffer, never modifies state.
    if (resources) {
      current._retire(resources.roof);
      resources.source.groups?.clear();
    }
    resources = null;
  }
  function ensure(sim) {
    if (current === sim) return;
    release(); current = sim;
    const { gpu, g } = sim;
    const layout = gpu.layout('WEATHER_ROOF', WEATHER_ROOF_LAYOUT);
    const roof = gpu.createBuffer({ label: 'element weather roofs', size: g.nx * g.nz * 4, usage: GPUBufferUsage.STORAGE });
    const group = gpu.bindGroup(layout, [{ binding: 0, resource: { buffer: roof } }], 'element weather roofs');
    const scan = gpu.kernel({ name: 'weatherRoof', code: weatherRoofFrag(g),
      layouts: [sim.L.TABLES, sim.L.STATE_RO, layout], workgroupSize: [64, 1, 1] });
    const makeSource = sim.compactOwner ? (name, spec) => createNativeWeatherKernel(sim, name, spec) : (name, spec) => sim.editKernel(name, spec);
    const source = makeSource('elementWeather', {
      nativePrecipitation: true, update: weatherUpdateWGSL, params: WeatherParams, reads: 'neighbours',
      decls: weatherDeclsWGSL, layout: WEATHER_SOURCE_LAYOUT,
    });
    resources = { roof, group, scan, source, ready: Promise.all([scan.ready, source.ready]) };
    resources.ready.catch(() => {}); // pipeline failures already go through gpu.fail
    nextFrame = 0; lastFrame = -1;
  }
  const api = {
    get pulses() { return pulses; },
    get ready() { return resources?.ready ?? Promise.resolve(); },
    clearFog({ sim, world, host = false } = {}) {
      if (disposed || !host || !world?.loaded || !sim || sim.disposed || sim.gpu?.failure || sim.gpu?.lost) return false;
      const sea = world.P?.sea;
      if (!Number.isFinite(sea) || !Number.isFinite(sim.origin.y)) return false;
      const { nx, ny, nz } = sim.g;
      const cloudBottom = Math.max(sim.origin.y + 2, sea + 14,
        sim.origin.y + ny - ELEMENT_WEATHER.cloudMargin - ELEMENT_WEATHER.cloudDepth);
      const top = Math.min(ny, cloudBottom - sim.origin.y);
      const radius = Math.max(nx, ny, nz);
      // Fog drifts out of its source band. Erase low CLOUD, not sky clouds or rain.
      sim.paint({
        center: { x: nx / 2, y: top - radius, z: nz / 2 }, radius,
        shape: 1, tool: E.EMPTY, rate: 1, replace: false, filter: E.CLOUD, erase: true,
      });
      return true;
    },
    step(state, context = {}) {
      if (disposed) return false;
      const policy = elementWeatherPolicy(state, context);
      if (!policy) return false;
      const { sim, world } = context;
      const cadence = Math.max(1, Math.round(ELEMENT_WEATHER.cadence * (context.stepHz ?? 240) / 240));
      ensure(sim);
      if (worldKey !== world || epoch !== world?.epoch || sim.frame < lastFrame) {
        worldKey = world; epoch = world?.epoch; nextFrame = 0; lastFrame = -1;
      }
      if (sim.frame === lastFrame || sim.frame < nextFrame) return false;
      const { scan, source, group, roof } = resources;
      if (scan.state !== 'ready' || source.main.state !== 'ready' || source.apply.state !== 'ready') return false;
      const read = sim.compact ? sim.bindPhysicalRO : sim.bindRO;
      if (!read) return false;
      scan.dispatch(sim.gpu.frame, fold(Math.ceil(sim.g.nx * sim.g.nz / 64)), {
        bind: [sim.tables, read, group], header: sim.readHeader({ physical: true }),
      });
      sim.onPass?.(scan.name, { kind: 'compute', gpuMs: null });
      const { boxes, ...values } = policy;
      values.pulse = Math.floor(sim.frame / cadence) >>> 0;
      // Separate thin bands bound the shared scratch and avoid dispatching the
      // empty column between sea fog and high clouds. V1 uses two edit phases;
      // native commits properties/air and allocates only new snow sources.
      for (const box of boxes) {
        if (sim.compactOwner) source.run(box, values, roof);
        else sim.edit(source, box, values, { bind: [{ buffer: roof }] });
      }
      pulses++; lastFrame = sim.frame; nextFrame = sim.frame + cadence;
      return true;
    },
    reset() {
      release(); current = worldKey = null; epoch = null; nextFrame = 0; lastFrame = -1;
    },
    dispose() { api.reset(); disposed = true; },
  };
  return api;
}
