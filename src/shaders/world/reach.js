// A big map's full detail (docs/seamless-world.md, "work parity"): live's region, the physics window's box
// (sim.origin + [0, g.n) in world cells, centred on the focus). The world march draws a pixel's ray only
// inside it, and the far view (shaders/far.js farFrag, world/far.js) outside it, live's own distance march
// over live's own far summary; both write depth, so the nearer hit wins where they meet. Both passes take the
// ray's span through the box from windowSpan, so they cut it with the same arithmetic.
// Intentional (small maps): a world the size of its box has no far view; its march draws all of it, as
// live's box did (MarchParams.boxed 0).

// Needs nothing but WGSL builtins.
export const reachWGSL = /* wgsl */ `
// ---- the window's span (shaders/world/reach.js): world march inside it, far view outside it ----
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
