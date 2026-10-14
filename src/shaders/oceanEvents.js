import { prelude, STATE_OPTS, STAGE, LAYOUT, EDIT_FIELDS, editKernelWGSL } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';

// TPT's source + Wind tools: a finite offshore reservoir, never a moving
// paintwall. Distances are cells, velocities cells/step. The solver carries
// the resulting WATER, momentum and pressure inland; no decorative geometry.
export const OCEAN_EVENT = Object.freeze({
  stepsPerSecond: 240, sourceEvery: 30, chopEvery: 60,
  duration: 18, rise: 4, hold: 10, height: 18, halfDepth: 3, halfWidth: 14,
  speed: 0.32, lift: 0.06, pressure: 0.5, chopSpeed: 0.035,
});
const C = OCEAN_EVENT;
export const OceanColumnsParams = uniformStruct('OceanColumnsParams', { sea: 'f32' });
const ro = binding => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } });
export const OCEAN_COLUMNS_LAYOUT = [
  ro(0), { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
];

// One live result per x/z column: (eligible, world surface height). Paths
// are deliberately conservative straight lines at sea datum: winding marine
// channels may be missed, but enclosed pools cannot become sources. Generator
// validation outside the window is only an edge hint; live WATER is required
// along the entire in-window path. No decorative scenery is consulted.
export const oceanColumnsWGSL = g => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${OceanColumnsParams.wgsl}
@group(3) @binding(1) var<uniform> P: OceanColumnsParams;
@group(2) @binding(0) var<storage, read> edges: array<u32>;
@group(2) @binding(1) var<storage, read_write> columns: array<vec2f>;
fn openPath(start: vec2i, dir: vec2i, edge: i32, along: i32, y: i32) -> bool {
  if (edges[u32(edge * max(NX, NZ) + along)] == 0u) { return false; }
  var c = start;
  for (var i = 0; i < max(NX, NZ); i++) {
    if (any(c < vec2i(0)) || any(c >= vec2i(NX, NZ))) { return true; }
    if (eid(fetchA(vec3i(c.x, y, c.y))) != E_WATER) { return false; }
    c += dir;
  }
  return true;
}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldThread(wg, nwg, li);
  if (i >= u32(NX * NZ)) { return; }
  columns[i] = vec2f(0.0);
  let c = vec2i(i32(i) % NX, i32(i) / NX);
  let datum = i32(floor(P.sea - f32(H.origin.y))) - 2;
  if (datum < 0 || datum >= NY) { return; }
  var top = -1;
  for (var y = NY - 1; y >= 0; y--) {
    let id = eid(fetchA(vec3i(c.x, y, c.y)));
    if (id == E_EMPTY || KIND(id) == K_GAS) { continue; }
    if (id != E_WATER) { return; } // roofs, solids and other liquids shelter the column
    top = y + 1;
    break;
  }
  let worldTop = f32(top + H.origin.y);
  if (top < 0 || worldTop < P.sea - 2.0 || worldTop > P.sea + ${C.height + 4}.0) { return; }
  // Crucial: an elevated sealed tank cannot inherit the ocean beneath its
  // floor. Require continuous WATER from the connected datum to this surface.
  for (var y = datum; y < top; y++) {
    if (eid(fetchA(vec3i(c.x, y, c.y))) != E_WATER) { return; }
  }
  let connected = openPath(c, vec2i(-1, 0), 0, c.y, datum)
    || openPath(c, vec2i(1, 0), 1, c.y, datum)
    || openPath(c, vec2i(0, -1), 2, c.x, datum)
    || openPath(c, vec2i(0, 1), 3, c.x, datum);
  if (connected) { columns[i] = vec2f(1.0, worldTop); }
}
`;

export const oceanEventsEdit = {
  reads: 'own', // neighbours were snapshotted into columns in the preceding dispatch
  layout: [ro(0)],
  params: { sea: 'f32', time: 'f32', chop: 'f32', surge: 'f32', source: 'vec2f', direction: 'vec2f', wind: 'vec2f' },
  decls: '@group(2) @binding(0) var<storage, read> columns: array<vec2f>;',
  update: /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let id = eid(a);
  if (id != E_EMPTY && id != E_WATER) { return; }
  let column = columns[u32(p.x + NX * p.z)];
  if (column.x < 0.5) { return; }
  let w = vec3f(p + H.origin) + vec3f(0.5);
  let delta = w.xz - P.source;
  let along = dot(delta, P.direction);
  let across = dot(delta, vec2f(-P.direction.y, P.direction.x));
  let source = P.surge > 0.0 && abs(along) <= ${C.halfDepth}.0 && abs(across) <= ${C.halfWidth}.0
    && w.y >= P.sea - 2.0 && w.y <= P.sea + ${C.height}.0 * P.surge;
  if (source) {
    if (id == E_EMPTY) {
      var rng = seedWorld(p + H.origin, u32(P.time * 240.0), 0x715u);
      *oA = vec4f(f32(E_WATER), SPAWNT(E_WATER), 0.0, rnd(&rng) * SEED_MAX);
    }
    let velocity = clamp(mix(b.xyz, vec3f(P.direction.x * ${C.speed}, ${C.lift}, P.direction.y * ${C.speed}), P.surge), vec3f(-V_MAX), vec3f(V_MAX));
    *oB = vec4f(velocity, clamp(b.w + ${C.pressure} * P.surge, P_MIN, P_MAX));
  } else if (id == E_WATER && P.chop > 0.0 && abs(column.y - P.sea) <= 3.0 && w.y >= column.y - 3.0) {
    let phase = dot(w.xz, P.wind) * 0.22 - P.time * 2.5;
    let dv = vec3f(P.wind.x * cos(phase) * 0.25, sin(phase), P.wind.y * cos(phase) * 0.25) * ${C.chopSpeed} * P.chop;
    *oB = vec4f(clamp(b.xyz + dv, vec3f(-V_MAX), vec3f(V_MAX)), b.w);
  }
}
`,
};

const ForceParams = uniformStruct('OceanForceParams', { ...EDIT_FIELDS, ...oceanEventsEdit.params });
export const WGSL_CHECK = [
  { name: 'oceanColumns', kind: 'compute', code: oceanColumnsWGSL, params: OceanColumnsParams, warm: false,
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, OCEAN_COLUMNS_LAYOUT], dispatch: g => fold(Math.ceil(g.nx * g.nz / 64)) },
  { name: 'oceanForce', kind: 'compute', warm: false,
    code: g => editKernelWGSL(g, { ...oceanEventsEdit, params: ForceParams }), params: ForceParams,
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, oceanEventsEdit.layout] },
];
