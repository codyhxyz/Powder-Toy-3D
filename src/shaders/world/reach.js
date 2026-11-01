// The ray's span through physics' window's box (sim.origin + [0, g.n) in world cells). The far view
// (shaders/far.js farFrag, world/far.js) marches outside it on the frames the box volume draws the window in
// a material view (the rolling log's bent frames: app.js farPass). The world march never reads it: it draws
// the whole world on every map (shaders/world/march.js), so a big map has no cut at the window.

// Needs nothing but WGSL builtins.
export const reachWGSL = /* wgsl */ `
// ---- the window's span (shaders/world/reach.js): the box volume inside it, the far view outside it ----
// The ray ro + rd t through the box [lo, hi): (tNear, tFar, the axis it enters across); tNear > tFar: a miss.
fn windowSpan(ro: vec3f, rd: vec3f, lo: vec3f, hi: vec3f) -> vec3f {
  let t0 = (lo - ro) / rd;
  let t1 = (hi - ro) / rd;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  var axis = 2.0;
  if (tn.x >= tn.y && tn.x >= tn.z) { axis = 0.0; } else if (tn.y >= tn.z) { axis = 1.0; }
  return vec3f(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z), axis);
}
`;
