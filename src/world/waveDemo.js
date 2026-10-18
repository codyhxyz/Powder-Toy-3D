import { E, ELEMENTS } from '../elements.js';
import { createNativeWeatherKernel } from '../v2/nativeWeather.js';

// The original waves-in-sim demo, unchanged at its 128³ window size.
// This is a one-shot initial condition, not a sustained ocean solver.
export const WAVE_DEMOS = {
  shore: { direction: [0.646, 0.763], center: 124, amplitude: 8, width: 10 },
  ocean: { direction: [0.15, 0.989], center: 60, amplitude: 16, width: 13 },
};

export const waveDemoEdit = {
  reads: 'neighbours',
  params: {
    direction: 'vec2f', center: 'f32', amplitude: 'f32', width: 'f32',
    sea: 'i32', waterTemp: 'f32', waterLife: 'f32',
  },
  update: /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  // Read the original waterline before any column changes.
  if (eid(fetchA(vec3i(p.x, P.sea - 1, p.z))) != E_WATER) { return; }
  let was = eid(a);
  if (was != E_EMPTY && was != E_WATER) { return; }
  let along = dot(vec2f(p.xz), P.direction);
  let edge = f32(min(min(p.x, NX - 1 - p.x), min(p.z, NZ - 1 - p.z)));
  let fade = smoothstep(0.0, 12.0, edge);
  let crestX = (along - P.center) / P.width;
  let troughX = (along - P.center - P.width * 1.9) / (P.width * 1.45);
  let crest = exp(-crestX * crestX);
  let trough = exp(-troughX * troughX);
  let top = f32(P.sea) + fade * P.amplitude * (crest - 0.4 * trough);
  let id = select(E_EMPTY, E_WATER, f32(p.y) + 0.5 < top);
  if (id != was) {
    let temp = select(AMBIENT, P.waterTemp, id == E_WATER);
    *oA = vec4f(f32(id), temp, select(0.0, P.waterLife, id == E_WATER), a.w);
  }
  *oB = vec4f(0.0);
  if (id == E_WATER) {
    let kick = crest * fade * exp(min(0.0, f32(p.y - P.sea) / 10.0));
    *oB = vec4f(-P.direction.x * 0.9 * kick,
      0.2 * kick * tanh((along - P.center) / P.width),
      -P.direction.y * 0.9 * kick, 0.0);
  }
}
`,
};

const kernels = new WeakMap();

export async function seedWaveDemo(win, kind) {
  const preset = Object.hasOwn(WAVE_DEMOS, kind) && WAVE_DEMOS[kind];
  if (!preset || !win?.loaded || win.pending || !(win.P.sea > 0)) return false;
  const sim = win.sim, epoch = win.epoch, origin = sim.origin.clone();
  const sea = Math.floor(win.P.sea);
  if (sea < 2 || sea >= sim.g.ny) return false;
  // V2: the same rule on the native cells (v2/nativeWeather.js): new water at V1's temperature and
  // life, the crest's push as the water's own face flux, the cleared air at rest. V1's edit would
  // reach V2 through the import with its velocity dropped: a level sea toasting "Wave created".
  const native = !!sim.compact;
  let entry = kernels.get(sim);
  if (!entry || entry.native !== native || (native && entry.owner !== sim.compactOwner)) {
    const owner = sim.compactOwner;
    entry = { native, owner, kernel: native ? createNativeWeatherKernel(sim, 'waveDemo', waveDemoEdit) : sim.editKernel('waveDemo', waveDemoEdit) };
    kernels.set(sim, entry);
  }
  const { kernel } = entry;
  await kernel.ready;
  // Compilation may finish after a map switch or a window move.
  if (!win.loaded || win.pending || epoch !== win.epoch || !origin.equals(sim.origin)) return false;
  if (native && sim.compact !== entry.owner) return false;
  const box = { lo: [0, 2, 0], hi: [sim.g.nx - 1, Math.min(sim.g.ny - 1, sea + preset.amplitude + 1), sim.g.nz - 1] };
  const values = { ...preset, sea, waterTemp: ELEMENTS[E.WATER].temp, waterLife: ELEMENTS[E.WATER].life };
  sim.snapshot(kind === 'shore' ? 'Shore wave' : 'Offshore wave');
  if (native) return kernel.run(box, values);
  sim.edit(kernel, box, values, { scrub: true });
  return true;
}
