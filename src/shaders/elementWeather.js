import { prelude, STATE_OPTS, LAYOUT, STAGE, EDIT_FIELDS, EDIT_SCRATCH_BINDING, editKernelWGSL } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';

export const WEATHER_ROOF_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];
export const WEATHER_SOURCE_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }];
export const WeatherParams = uniformStruct('WeatherParams', {
  ...EDIT_FIELDS,
  source: 'vec3f', // cloud, rain, storm
  bands: 'vec2f', // cloud bottom/top, world cells
  wind: 'vec2f', time: 'f32', pulse: 'u32',
});

// One scan per column per pulse, not per emitted cell. Only real simulation
// matter shelters cells: scenery meshes are not physics. Store the top face
// y+1; the source compares its cell centre directly (no second half-cell).
export const weatherRoofFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
@group(2) @binding(0) var<storage, read_write> weatherRoof: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
        @builtin(local_invocation_index) li: u32) {
  let k = foldId(wg, nwg) * 64u + li;
  if (k >= u32(NX * NZ)) { return; }
  let x = i32(k % u32(NX));
  let z = i32(k / u32(NX));
  var top = 0.0;
  for (var y = NY - 1; y >= 0; y--) {
    let id = eid(fetchA(vec3i(x, y, z)));
    if (id != E_EMPTY && KIND(id) != K_GAS) { top = f32(y + 1); break; }
  }
  weatherRoof[k] = top;
}
`;

export const weatherDeclsWGSL = /* wgsl */ `
@group(2) @binding(0) var<storage, read> weatherRoof: array<f32>;
`;
export const weatherUpdateWGSL = /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  // Never replace existing material, including gas, fire or floodwater.
  if (eid(a) != E_EMPTY) { return; }
  let w = vec3f(p + H.origin) + 0.5;
  if (w.y < P.bands.x || w.y >= P.bands.y || P.source.x <= 0.0) { return; }
  let roof = weatherRoof[u32(p.x + NX * p.z)] + f32(H.origin.y);
  if (w.y <= roof) { return; }
  // Dedicated weather stream, distinct from common.js SALT's existing streams.
  var rng = seed3(p, P.pulse, 0x57ea7u);
  // TPT material sources arranged in Minecraft-like weather bands. World
  // anchoring means a moved simulation window doesn't move a cloud bank.
  let q = (w.xz - P.wind * P.time * 6.0) / 22.0;
  let bank = 0.5 + 0.25 * sin(q.x + sin(q.y)) + 0.25 * sin(q.y * 0.73 - q.x * 0.41);
  var id = E_EMPTY;
  var temperature = 12.0;
  var charge = 0.0;
  var velocity = vec3f(P.wind.x, 0.0, P.wind.y) * 0.025;
  if (w.y < P.bands.x + 1.0) {
    // Two-phase edit: this neighbour is actual CLOUD from before the pulse,
    // never another invocation's concurrent write. Normal CLOUD coalesces too.
    if (p.y + 1 < NY && eid(fetchA(p + vec3i(0, 1, 0))) == E_CLOUD && rnd(&rng) < P.source.y * 0.18) {
      id = E_WATER; velocity.y = SPAWN_DROP_V;
    }
  } else if (bank > mix(0.67, 0.2, P.source.x) && rnd(&rng) < 0.16 * P.source.x) {
    id = E_CLOUD;
    if (P.source.z > 0.0) {
      temperature = 0.0;
      velocity.y = 0.025;
      if (rnd(&rng) < 0.035 * P.source.z) { id = E_SNOW; velocity.y = SPAWN_DROP_V; }
      else if (rnd(&rng) < 0.0015 * P.source.z) { charge = CHARGE_BREAKDOWN; }
    }
  }
  if (id == E_EMPTY) { return; }
  *oA = vec4f(f32(id), temperature, SPAWNLIFE(id), charge + rnd(&rng) * SEED_MAX);
  *oB = vec4f(velocity, b.w); // preserve ambient pressure; ordinary physics takes over
}
`;

export const elementWeatherFrag = (g, { debug = false } = {}) => editKernelWGSL(g, {
  update: weatherUpdateWGSL, params: WeatherParams, reads: 'neighbours', decls: weatherDeclsWGSL, debug,
});
const sourceLayouts = () => [LAYOUT.TABLES, LAYOUT.STATE_RW,
  [...WEATHER_SOURCE_LAYOUT, { binding: EDIT_SCRATCH_BINDING, buffer: { type: 'storage' } }]];
// CPU-importable registry; not boot-warmed. The source uses exactly eight
// storage buffers including the shared two-phase scratch (the device limit).
export const WGSL_CHECK = [
  { name: 'weatherRoof', kind: 'compute', code: weatherRoofFrag, warm: false, workgroupSize: [64, 1, 1],
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, WEATHER_ROOF_LAYOUT], dispatch: g => fold(Math.ceil(g.nx * g.nz / 64)) },
  ...['main', 'apply'].map(entry => ({ name: entry === 'main' ? 'elementWeather' : 'elementWeather apply',
    kind: 'compute', code: elementWeatherFrag, entry, params: WeatherParams, warm: false,
    workgroupSize: [4, 4, 4], layouts: sourceLayouts, dispatch: g => fold(g.nbricks) })),
];
