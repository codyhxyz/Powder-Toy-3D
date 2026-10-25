// LOCAL ONLY (perf/march-spill investigation, never committed): stub variants of the march stage's WGSL.
// VITE_MARCH_VARIANT=a+b+c picks them; each is a list of [from, to] text replacements that must all apply.
const V = {
  // crystals: no prism hit (the crystal branch, gCrys/Shard writes and crystalInterface go dead)
  crys: [['if (crystalHit(cell, ro, rd, tEnter, tExit, &th, &nh)) {', 'if (false) {'],
    ['if (id == E_CRYSTAL) { return crystalHit(cell, ro, rd, tEnter, tExit, t, n); }', 'if (id == E_CRYSTAL) { return true; }']],
  // the loop-head liquid interface (refraction call + its pending carries stay, the call goes)
  iface: [['let inside = liquidInterface(ifP, ifN, ifG, ifEnter, ifLid, ifMirror, &ro, &rd, &col, &trans, &mediumLight);', 'let inside = ifEnter; ro = ifP;']],
  // gas/cloud media along a segment
  media: [['let al = mediaSegment(ro, rd, tEnter, tEv, &mNext, &col, &trans);', 'let al = 0.0;']],
  // glass and source-material panes: treat as a crisp hit
  glass: [['} else if (RCLASS(id) != R_GLASS) {\n        // the voxel', '} else if (true) {\n        // the voxel']],
  // the liquid surface's normal, ripple and close-up detail at an event
  liqn: [['if (!film) { geometric = surfNormal(hp, CH_LIQUID, select(rd, -rd, ev == EV_ENTER)); }', ''],
    ['var n = liquidRipple(hp, geometric);', 'var n = geometric;'],
    ['n = liquidDetail(hp, n, lid, &col, &trans);   // close-up', 'n = n;   // close-up']],
  // the sun's shadow map lookups inside the march (lightRef, mediumLight): lit
  shadow: [['fn sunShadowAt(p: vec3f) -> vec3f {', 'fn sunShadowAt(p: vec3f) -> vec3f {\n  return vec3f(1.0);']],
  // liquid absorption / deco along a segment
  absorb: [['absorbDeco(liq, select(vec3i(-1), cell, own), ro + rd * tEnter, thinBodySeg(pm, tEv - tEnter), mediumLight, tOwn, &col, &trans);', '']],
  // dynamic vector indexing in the DDA (exact: select masks in place of [ax])
  dyn: [['  (*cell)[ax] += istp[ax];\n  (*tMax)[ax] += tDelta[ax];', '  let m = vec3<bool>(ax == 0, ax == 1, ax == 2);\n  *cell = select(*cell, *cell + istp, m);\n  *tMax = select(*tMax, *tMax + tDelta, m);'],
    ['      cell[ax] += istp[ax];\n      tMax[ax] += tDelta[ax];', '      let m = vec3<bool>(ax == 0, ax == 1, ax == 2);\n      cell = select(cell, cell + istp, m);\n      tMax = select(tMax, tMax + tDelta, m);'],
    ['fn traceView(', 'fn axM(a: i32) -> vec3<bool> { return vec3<bool>(a == 0, a == 1, a == 2); }\nfn traceView('],
    ['n0[ax] = -f32(istp[ax]);', 'n0 = select(vec3f(0.0), -vec3f(istp), axM(ax));'],
    ['nFace[ax] = -f32(istp[ax]);', 'nFace = select(vec3f(0.0), -vec3f(istp), axM(ax));'],
    ['nc[xa] += istp[xa];', 'nc = select(nc, nc + istp, axM(xa));'],
    ['nX[xa] = f32(istp[xa]);', 'nX = select(vec3f(0.0), vec3f(istp), axM(xa));'],
    ['evN[ax] = -f32(istp[ax]);', 'evN = select(evN, -vec3f(istp), axM(ax));']],
};
export function marchVariant(code, spec) {
  for (const name of spec.split('+').filter(Boolean)) {
    const pairs = V[name];
    if (!pairs) throw new Error(`march variant: no ${name}`);
    for (const [a, b] of pairs) {
      if (!code.includes(a)) throw new Error(`march variant ${name}: pattern missing: ${a.slice(0, 80)}`);
      code = code.split(a).join(b);
    }
  }
  return code;
}
