// The sun writer's full optical walk (shaders/render.js shadowFrag); its rays always start above the box.
export const shadowOpticsWGSL = () => /* wgsl */ `
// Texel encoding, decoded by sunMapShadow (gfx/lighting.js, which defines
// SHADOW_TINT_ID_SCALE): w = tint element id * SHADOW_TINT_ID_SCALE + optical
// depth (capped below it).
const SHADOW_TAU_MAX: f32 = SHADOW_TINT_ID_SCALE - 1.0;
const SHADOW_NO_HIT: f32 = 1e5;        // depth stored where nothing is hit: past any receiver
const SHADOW_MEDIA_MIN_K: f32 = 1e-4;  // gas with less transport extinction (1/cell) casts nothing
const SHADOW_PANE_COS_MIN: f32 = 0.05; // a pane's path is cut at this cosine (edge-on: a long sliver, not infinite)
// The texel's ray (ro, rd) through the box: (opaque depth, translucent start,
// translucent end, tint id · scale + optical depth).
fn shadowTexel(ro: vec3f, rd: vec3f) -> vec4f {
  var oC = vec4f(SHADOW_NO_HIT, SHADOW_NO_HIT, SHADOW_NO_HIT, 0.0);
  let bh = boxHit(ro, rd);
  let t = max(bh.x, 0.0);
  if (bh.y <= t) { return oC; }
  var istp: vec3i;
  var tDelta: vec3f;
  var cell: vec3i;
  var tMax: vec3f;
  ddaStart(ro, rd, t, &istp, &tDelta, &cell, &tMax);
  var tEnter = t;
  var lastB = vec3i(-1);
  var flags = 0u;
  var bid = 0u;           // the brick's number and occupancy mask (shaders/occupancy.js)
  var occM = vec2u(0u);
  var tid = 0;
  var lid = E_WATER;
  var tau = 0.0;
  var hit = false;
  var phiA = surfSample(ro + rd * tEnter);
  var phiStale = false;
  var gPrev = E_EMPTY;   // the glass the last cell held (its shape kept through a block, gfx/glass.js glassShape) ...
  var gS = GlassShape(0, -1, -1, 0.0, -1, -1, 0.0);   // ... and that shape
  if (max(phiA.y, max(phiA.z, phiA.w)) >= SURF_ISO) { oC.x = tEnter; hit = true; }
  for (var i = 0; i < MAX_STEPS; i++) {
    if (hit || outside(cell)) { break; }
    let bc = cell / BS;
    if (any(bc != lastB)) {
      lastB = bc;
      bid = brickId(bc);
      flags = brickInfoOf(bid);
      gThin = brickThin(flags);
      if (flags != 0u) { occM = occMaskOf(bid); }
    }
    if (flags == 0u) { skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter); phiStale = true; gPrev = E_EMPTY; continue; }
    let ax = argmin3(tMax);
    let tExit = tMax[ax];
    let id = occCellId(occM, bid, cell);   // eid(fetchA(cell)), from the brick's occupancy: nothing read for an empty cell
    if (id == E_CRYSTAL) {
      // Tint only the actual prism chord, not its cell or the air around it.
      var th = tEnter;
      var nh = vec3f(0.0);
      if (crystalHit(cell, ro, rd, tEnter, tExit, &th, &nh)) {
        var exitN: vec3f;
        let end = min(tExit, th + shardExit(gCrys, ro + rd * th, rd, &exitN));
        if (tid == 0 || RCLASS(tid) == R_GAS) { if (tid == 0) { oC.y = th; } tid = id; }
        tau += meanSigma(id) * max(end - th, 0.0);
        oC.z = end;
      }
      phiStale = true;
    } else if (isCrisp(id)) {
      if (RCLASS(id) != R_GLASS) { oC.x = tEnter; hit = true; break; }
      // Glass casts the shadow of the shape the view draws: a pane only its
      // sheet's few mm where the ray crosses it (almost none), a block its
      // whole path, with its own tint (glassSigma: window glass's iron green).
      if (id != gPrev || gS.n > 0) { gS = glassShape(cell, id, glassNeighbours(cell, id)); }
      var len = tExit - tEnter;
      if (gS.n > 0) {
        len = 0.0;
        if (sheetHit(ro, rd, tEnter, cell, gS.a0, gS.r0, gS.s0) < tExit) { len += PANE_CELLS / max(abs(rd[gS.a0]), SHADOW_PANE_COS_MIN); }
        if (sheetHit(ro, rd, tEnter, cell, gS.a1, gS.r1, gS.s1) < tExit) { len += PANE_CELLS / max(abs(rd[gS.a1]), SHADOW_PANE_COS_MIN); }
      }
      if (len > 0.0) {
        if (tid == 0 || RCLASS(tid) == R_GAS) { if (tid == 0) { oC.y = tEnter; } tid = id; }
        tau += meanSigma(id) * len;
        oC.z = tExit;
      }
      phiStale = true;
    } else if (brickSurf(flags) || brickMedia(flags)) {
      if (phiStale) { phiA = surfSample(ro + rd * tEnter); }
      let phiB = surfSample(ro + rd * tExit);
      var tM = tExit;
      var phiM = phiB;
      if (SURFCH(id) >= 0 || (gThin && id == E_EMPTY)) { tM = tClosest(cell, ro, rd, tEnter, tExit); phiM = surfSample(ro + rd * tM); }   // (as the view's)
      var tOp = NO_HIT;
      for (var c = 1; c < 4; c++) {
        tOp = min(tOp, surfCross(ro, rd, c, true, tEnter, tM, tExit, phiA[c], phiM[c], phiB[c]));
      }
      let tEnd = min(tOp, tExit);
      // path length inside liquid: trapezoid over the three samples
      let inL = step(vec3f(SURF_ISO), vec3f(phiA.x, phiM.x, phiB.x));
      let lenL = 0.5 * ((inL.x + inL.y) * (tM - tEnter) + (inL.y + inL.z) * (tExit - tM));
      if (lenL > 0.0) {
        if (SURFCH(id) == CH_LIQUID) { lid = id; }
        if (tid == 0 || RCLASS(tid) == R_GAS) { if (tid == 0) { oC.y = tEnter; } tid = lid; }
        tau += meanSigma(lid) * lenL * (tEnd - tEnter) / max(tExit - tEnter, 1e-6);
        oC.z = tEnd;
      }
      if (brickMedia(flags)) {
        // smoke and steam (gfx/media.js), with transport extinction: light
        // scattered forward still gets through, so gas casts soft shadows
        let m = mediaField(ro + rd * (0.5 * (tEnter + tEnd)));
        let dm = max(m.xy - MEDIA_FLOOR, vec2f(0.0)) * (1.0 / (1.0 - MEDIA_FLOOR));
        let k = dot(MD_EXT.xy * (1.0 - MD_ALBEDO.xy * MD_G.xy), dm);
        if (k > SHADOW_MEDIA_MIN_K) {
          if (tid == 0) { oC.y = tEnter; tid = select(E_STEAM, E_SMOKE, m.x > m.y); }
          tau += k * (tEnd - tEnter);
          oC.z = tEnd;
        }
      }
      if (tOp < NO_HIT) { oC.x = tOp; hit = true; break; }
      phiA = phiB;
      phiStale = false;
    } else {
      phiStale = true;
    }
    gPrev = select(E_EMPTY, id, isCrisp(id) && RCLASS(id) == R_GLASS);
    tEnter = tExit;
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  if (!hit && rd.y < 0.0) { oC.x = ro.y / -rd.y; }   // floor
  oC.w = f32(tid) * SHADOW_TINT_ID_SCALE + min(tau, SHADOW_TAU_MAX);
  return oC;
}
`;
