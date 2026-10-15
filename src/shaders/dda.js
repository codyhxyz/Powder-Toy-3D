// The voxel DDA (Amanatides & Woo), one copy for every walk through the
// grid: the views' marches, the shadow and reflection rays, the pick, the POV
// trace and strike, the laser's reach, the wands' trace and the sign probe.
// Binding-free: it needs only the prelude's NX, NY, NZ and BS (shaders/common.js),
// so an edit kernel pastes it as it is; shaders/gfx/core.js's ddaGLSL
// includes it for the kernels that walk with the core's helpers.
//
// A walk's state is the ray (ro, rd), the step per axis (istp: ±1), the t one
// cell takes along each axis (tDelta), the current cell and the t at which the
// ray crosses each axis's next cell boundary (tMax). The default Box variant
// requires nonzero rd (safeDir), except with caller-supplied tDelta/tMax
// (shaders/wands.js); the world variant handles inactive axes itself.
// The helpers are single-exit with no early
// return, so they inline cheaply (cold shader compile: commit 5551bd7).
// World rays keep their physical direction, including signed zero. Only the
// division/crossing leaves differ; Box/POV retain their exact legacy emission.
export const ddaWalk = ({ physicalDirection = false } = {}) => /* wgsl */ `
// A ray entering the box starts its DDA in the cell this far (cells) past the
// entry point, so the cell it starts in is the one inside.
const DDA_START_NUDGE: f32 = 1e-4;
// The smallest |component| a ray direction keeps (the DDA divides by it).
const DDA_DIR_MIN: f32 = 1e-6;

// ${physicalDirection ? 'World physical direction, unchanged; division safety belongs to the crossings.' : 'rd with every component at least DDA_DIR_MIN away from 0.'}
fn safeDir(rd: vec3f) -> vec3f { return ${physicalDirection ? 'rd' : 'select(rd, vec3f(DDA_DIR_MIN), abs(rd) < vec3f(DDA_DIR_MIN))'}; }${physicalDirection ? `
// Inactive axes must never win a crossing, even on an exact plane. Select a
// nonzero denominator BEFORE dividing: select after 0/0 is not NaN-safe.
fn ddaCrossing(delta: vec3f, rd: vec3f) -> vec3f {
  let moving = rd != vec3f(0.0);
  return select(vec3f(1e30), delta / select(vec3f(1.0), rd, moving), moving);
}` : ''}
// The axis of v's smallest component (ties: x, then y).
fn argmin3(v: vec3f) -> i32 { return select(select(2, 1, v.y <= v.z), 0, v.x <= v.y && v.x <= v.z); }
// Where ray (ro, rd) crosses each axis's next cell boundary out of cell c (t).
fn ddaNext(ro: vec3f, rd: vec3f, c: vec3i) -> vec3f { return ${physicalDirection ? 'ddaCrossing(vec3f(c) + step(vec3f(0.0), rd) - ro, rd)' : '(vec3f(c) + step(vec3f(0.0), rd) - ro) / rd'}; }

// Start a walk along ray (ro, rd) in cell c.
fn ddaInit(ro: vec3f, rd: vec3f, c: vec3i, istp: ptr<function, vec3i>, tDelta: ptr<function, vec3f>, tMax: ptr<function, vec3f>) {
  *istp = vec3i(sign(rd));
  *tDelta = abs(${physicalDirection ? 'ddaCrossing(vec3f(1.0), rd)' : '1.0 / rd'});
  *tMax = ddaNext(ro, rd, c);
}
// Start a walk where ray (ro, rd) enters the box (t0, from boxHit, or 0 when
// it starts inside): in the cell DDA_START_NUDGE past it, held in the grid.
fn ddaStart(ro: vec3f, rd: vec3f, t0: f32, istp: ptr<function, vec3i>, tDelta: ptr<function, vec3f>,
            cell: ptr<function, vec3i>, tMax: ptr<function, vec3f>) {
  *cell = clamp(vec3i(floor(ro + rd * (t0 + DDA_START_NUDGE))), vec3i(0), vec3i(NX, NY, NZ) - 1);
  ddaInit(ro, rd, *cell, istp, tDelta, tMax);
}
// Step into the next cell, across the axis whose boundary is nearest; returns
// that axis. The cell is entered at the old tMax[axis], the smallest of tMax
// (callers that track it read it first).
fn ddaStep(istp: vec3i, tDelta: vec3f, cell: ptr<function, vec3i>, tMax: ptr<function, vec3f>) -> i32 {
  let ax = argmin3(*tMax);
  (*cell)[ax] += istp[ax];
  (*tMax)[ax] += tDelta[ax];
  return ax;
}
// Jump the walk out of the box [bmin, bmax] (grid units, cell-aligned) the ray
// is in: *cell becomes the cell past the face it leaves through, *tMax that
// cell's boundaries and *tEnter the t it leaves at, as one step would; returns
// the axis crossed.
fn ddaJumpBox(bmin: vec3f, bmax: vec3f, ro: vec3f, rd: vec3f, istp: vec3i,
              cell: ptr<function, vec3i>, tMax: ptr<function, vec3f>, tEnter: ptr<function, f32>) -> i32 {
  let tb = ${physicalDirection ? 'ddaCrossing(mix(bmin, bmax, step(vec3f(0.0), rd)) - ro, rd)' : '(mix(bmin, bmax, step(vec3f(0.0), rd)) - ro) / rd'};
  let ax = argmin3(tb);
  let tx = tb[ax];
  ${physicalDirection ? `// Reconstruction may round a tiny component onto EITHER side of an
  // integer plane. Resolve ownership with boundary times, not a direction
  // epsilon or positional nudge; then keep non-exit axes in the jumped box.
  var c = vec3i(floor(ro + rd * tx));
  for (var k = 0; k < 3; k++) {
    if (k == ax || rd[k] == 0.0) { continue; }
    let a = (f32(c[k]) - ro[k]) / rd[k];
    let b = (f32(c[k] + 1) - ro[k]) / rd[k];
    if (rd[k] > 0.0) {
      if (a > tx) { c[k] -= 1; } else if (b <= tx) { c[k] += 1; }
    } else {
      if (b > tx) { c[k] += 1; } else if (a <= tx) { c[k] -= 1; }
    }
  }
  c = clamp(c, vec3i(bmin), vec3i(bmax) - 1);` : 'var c = vec3i(floor(ro + rd * tx));'}
  c[ax] = select(i32(bmin[ax]) - 1, i32(bmax[ax]), istp[ax] > 0);
  *cell = c;
  *tMax = ddaNext(ro, rd, c);
  *tEnter = tx;
  return ax;
}
// Jump the walk to the exit of brick bc, which it treats as empty (the
// prelude's BS cells a side). Same contract as ddaJumpBox.
fn skipBrick(bc: vec3i, ro: vec3f, rd: vec3f, istp: vec3i,
             cell: ptr<function, vec3i>, tMax: ptr<function, vec3f>, tEnter: ptr<function, f32>) -> i32 {
  let bmin = vec3f(bc * BS);
  return ddaJumpBox(bmin, bmin + f32(BS), ro, rd, istp, cell, tMax, tEnter);
}
`;
export const ddaWalkWGSL = ddaWalk();
