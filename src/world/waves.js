// TPT-style waves: move real water into a crest, then let the existing
// cellular physics carry it. Heights and momentum come from the wave demo.
export const WAVE_PERIOD = 720; // simulation steps, not rendered frames
const WIDTH = 16, REACH = 24;
const waveHeight = level => level === 'gentle' ? 8 : level === 'large' ? 16 : 0;

// Pick open ocean near the window's centre, preferring a shore-facing source.
// The GPU checks the actual cells, so edits and structures always win.
export function waveSource(win) {
  const { sim, scene, P } = win, { nx, nz } = sim.g, o = sim.origin;
  if (!(P.sea > 0) || !scene.ground || Math.min(nx, nz) < 64) return null;
  const ground = (x, z) => scene.ground(x + o.x, z + o.z, P);
  let best = null;
  for (const x of [REACH, nx >> 1, nx - REACH]) {
    for (const z of [REACH, nz >> 1, nz - REACH]) {
      // scene.ground includes water: an ocean column reports its sea level,
      // not its seabed. Actual water and available depth are checked below.
      if (ground(x, z) > P.sea) continue;
      const dx = ground(x + 2 * REACH, z) - ground(x - 2 * REACH, z);
      const dz = ground(x, z + 2 * REACH) - ground(x, z - 2 * REACH);
      const axis = Math.abs(dx) > Math.abs(dz) ? 0 : 2;
      const slope = axis === 0 ? dx : dz;
      const direction = slope === 0 ? 1 : Math.sign(slope);
      const score = Math.abs(slope) - Math.hypot(x - nx / 2, z - nz / 2) / REACH;
      if (!best || score > best.score) best = { center: [x, z], axis, direction, score };
    }
  }
  return best;
}

export const waveEdit = {
  reads: 'neighbours',
  params: { center: 'vec2i', sea: 'i32', axis: 'u32', direction: 'f32', height: 'f32' },
  update: /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let axis = P.axis;
  let side = 2u - axis;
  let center = vec3i(P.center.x, P.sea, P.center.y);
  let along = f32(p[axis] - center[axis]) + 0.5;
  let across = abs(f32(p[side] - center[side]) + 0.5);
  let fade = 1.0 - smoothstep(16.0, 24.0, across);
  let crest = exp(-pow((abs(along) - 8.0) / 5.0, 2.0));
  let height = P.height * crest * fade;
  if (abs(along) >= 16.0 || abs(f32(p.y - P.sea) + 0.5) >= height) { return; }
  let raised = along * P.direction > 0.0;
  if (raised != (p.y >= P.sea)) { return; }
  // A one-to-one reflection pairs a trough cell with a crest cell.
  // Both invocations read the same pre-edit state before either is written.
  var q = p;
  q[axis] = 2 * center[axis] - 1 - p[axis];
  q.y = 2 * P.sea - 1 - p.y;
  if (!inGrid(q)) { return; }
  let other = fetchA(q);
  let water = select(a, other, raised);
  let air = select(other, a, raised);
  if (eid(water) != E_WATER || eid(air) != E_EMPTY) { return; }
  // Require an undisturbed waterline on both sides before raising it.
  let src = select(p, q, raised);
  let dst = select(q, p, raised);
  if (eid(fetchA(vec3i(src.x, P.sea - 1, src.z))) != E_WATER ||
      eid(fetchA(vec3i(dst.x, P.sea - 1, dst.z))) != E_WATER ||
      eid(fetchA(vec3i(src.x, P.sea, src.z))) != E_EMPTY ||
      eid(fetchA(vec3i(dst.x, P.sea, dst.z))) != E_EMPTY) { return; }
  *oA = other;
  *oB = vec4f(0.0);
  if (raised) {
    var velocity = vec4f(0.0, 0.2 * crest * fade, 0.0, 0.0);
    velocity[axis] = P.direction * 0.9 * crest * fade;
    *oB = velocity;
  }
}
`,
};

export class OceanWaves {
  constructor(win) {
    this.win = win;
    this.epoch = -1;
    this.lastFrame = -WAVE_PERIOD;
    this.pulses = 0;
    this.kernel = null;
    this.ready = null;
  }

  prepare() {
    if (!this.kernel) {
      this.kernel = this.win.sim.editKernel('oceanWave', waveEdit);
      this.ready = this.kernel.ready;
    }
    return this.ready;
  }

  enabled(level) { return waveHeight(level) > 0 && this.win.P.sea > 0; }

  step(level) {
    const w = this.win, s = w.sim, height = waveHeight(level);
    if (!height || !w.loaded || w.pending || !(w.P.sea > 0)) return false;
    if (this.epoch !== w.epoch || s.frame < this.lastFrame) {
      this.epoch = w.epoch;
      this.lastFrame = -WAVE_PERIOD;
    }
    if (s.frame - this.lastFrame < WAVE_PERIOD) return false;
    const source = waveSource(w);
    if (!source) { this.lastFrame = s.frame; return false; }
    this.prepare();
    if (this.kernel.main.state !== 'ready' || this.kernel.apply.state !== 'ready') return false;
    const { center, axis, direction } = source, sea = Math.floor(w.P.sea);
    const radius = axis === 0 ? [WIDTH, REACH] : [REACH, WIDTH];
    s.edit(this.kernel, {
      lo: [center[0] - radius[0], sea - height, center[1] - radius[1]],
      hi: [center[0] + radius[0] - 1, sea + height - 1, center[1] + radius[1] - 1],
    }, { center, sea, axis, direction, height }, { scrub: true });
    this.lastFrame = s.frame;
    this.pulses++;
    return true;
  }
}
