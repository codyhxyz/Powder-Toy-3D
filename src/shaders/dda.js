// The voxel DDA (Amanatides & Woo), one copy for every walk through the
// grid: the views' marches, the shadow and reflection rays, the pick, the POV
// trace and strike, the laser's reach, the wands' trace and the sign probe.
// Binding-free: it needs only the prelude's NX, NY, NZ and BS (shaders/common.js),
// so an edit kernel pastes it as it is; shaders/gfx/core.js's ddaGLSL
// includes it for the kernels that walk with the core's helpers.
//
// A walk's state is the ray (ro, rd), the step per axis (istp: ±1), the t one
// cell takes along each axis (tDelta), the current cell and the t at which the
// ray crosses each axis's next cell boundary (tMax). It requires nonzero rd
// (safeDir), except with caller-supplied tDelta/tMax (shaders/wands.js).
// The helpers are single-exit with no early
// return, so they inline cheaply (cold shader compile: commit 5551bd7).
export const ddaWalk = () => /* wgsl */ `
// A ray entering the box starts its DDA in the cell this far (cells) past the
// entry point, so the cell it starts in is the one inside.
const DDA_START_NUDGE: f32 = 1e-4;
// The smallest |component| a ray direction keeps (the DDA divides by it).
const DDA_DIR_MIN: f32 = 1e-6;

// rd with every component at least DDA_DIR_MIN away from 0.
fn safeDir(rd: vec3f) -> vec3f { return select(rd, vec3f(DDA_DIR_MIN), abs(rd) < vec3f(DDA_DIR_MIN)); }
// The axis of v's smallest component (ties: x, then y).
fn argmin3(v: vec3f) -> i32 { return select(select(2, 1, v.y <= v.z), 0, v.x <= v.y && v.x <= v.z); }
// Where ray (ro, rd) crosses each axis's next cell boundary out of cell c (t).
fn ddaNext(ro: vec3f, rd: vec3f, c: vec3i) -> vec3f { return (vec3f(c) + step(vec3f(0.0), rd) - ro) / rd; }

// Start a walk along ray (ro, rd) in cell c.
fn ddaInit(ro: vec3f, rd: vec3f, c: vec3i, istp: ptr<function, vec3i>, tDelta: ptr<function, vec3f>, tMax: ptr<function, vec3f>) {
  *istp = vec3i(sign(rd));
  *tDelta = abs(1.0 / rd);
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
  let tb = (mix(bmin, bmax, step(vec3f(0.0), rd)) - ro) / rd;
  let ax = argmin3(tb);
  let tx = tb[ax];
  var c = vec3i(floor(ro + rd * tx));
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
