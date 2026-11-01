// Grass blades (src/shaders/gfx/blades.js), CPU only: a pixel's mean of many blades must equal
// the photo's mean, so the fade into the photo at ~3.5 m is invisible.
//
// 1. The photo's mean the blades take (BLADE_MEAN_ALB) is the meadow photo's mean as matOf draws it,
//    and lies within a few hundredths of PLANT's albedo, the colour the far view and GI draw.
// 2. Walking the real lattice (the shader's walk, ported: same sites, blades, hits, normals) from
//    many points, the mean light a ray meets (albedo share x the sun's cosine x Beer-Lambert) matches
//    swardMean, the expectation the shader divides by, for rays from steep to grazing.
// 3. So the normalised sward's mean is BLADE.NEAR_SHADE of the photo's, at every angle.
//
// usage: node tools/grass-blades-cpu-check.mjs
import { BLADE, BLADE_MEAN_ALB, BLADE_THATCH_SHARE, swardMean, bladeCosShare } from '../src/shaders/gfx/blades.js';
import { LOOK } from '../src/gfx/materials.js';
import { E } from '../src/elements.js';

const RAYS = 20000;
const TOL = 0.06;          // relative: the walk against the expectation
// ... or absolute, as a share of flat ground's sunlight: under ~2 % of it is below a step the eye sees
// (Weber fraction ~1-2 %); looking toward the sun the blades seen are their shaded sides, so their
// mean is small and its relative error large
const SUN_ABS_TOL = 0.02;
const ALB_TOL = 0.03;      // absolute, linear albedo: the photo's mean against PLANT's
const b = BLADE;
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

// 1
const alb = LOOK[E.PLANT].alb;
const dAlb = Math.max(...alb.map((v, k) => Math.abs(v - BLADE_MEAN_ALB[k])));
check(dAlb < ALB_TOL, `photo mean ${BLADE_MEAN_ALB.map((v) => v.toFixed(3))} vs PLANT ${alb.map((v) => v.toFixed(3))} (max diff ${dAlb.toFixed(3)})`);

// 2: the walk (flat ground, ng = up), seeded per site like the shader's hash (any good hash will do here)
const pcg = (v) => { let s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0; const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0; return ((w >>> 22) ^ w) >>> 0; };
const STEPS = 24;
const v3 = { sub: (a, c) => a.map((x, i) => x - c[i]), dot: (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2], scale: (a, k) => a.map((x) => x * k), add: (a, c) => a.map((x, i) => x + c[i]) };
const norm = (a) => v3.scale(a, 1 / Math.hypot(...a));
const cross = (a, c) => [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]];
function walk(px, pz, rd) {
  const Q = b.Q, dd = -rd[1];
  const tGround = b.H / dd;
  const lw = [px / Q, pz / Q], base = lw.map(Math.floor), x0 = [lw[0] - base[0], lw[1] - base[1]];
  const dl = [rd[0] / Q, rd[2] / Q];
  const stp = dl.map((d) => (d >= 0 ? 1 : -1)), inv = dl.map((d) => 1 / Math.max(Math.abs(d), 1e-6));
  const tMax = [0, 1].map((k) => (dl[k] >= 0 ? 1 - x0[k] : x0[k]) * inv[k]);
  const cl = [0, 0];
  const rootM = b.R / Q, tipM = b.R * b.TIP_R / Q;
  let tA = 0, tHit = tGround, hitN = [0, 1, 0], found = false;
  for (let i = 0; i < STEPS; i++) {
    const tB = Math.min(tMax[0], tMax[1], tGround);
    let h = pcg(Math.imul(base[0] + cl[0], 0x2545f491) ^ pcg(base[1] + cl[1]));
    const u01 = () => { h = pcg(h); return h / 4294967296; };
    for (let k = 0; k < b.N; k++) {
      const rx = [rootM + (1 - 2 * rootM) * u01(), rootM + (1 - 2 * rootM) * u01()];
      const tx = [tipM + (1 - 2 * tipM) * u01(), tipM + (1 - 2 * tipM) * u01()];
      const hgt = b.H * (b.H_MIN + (1 - b.H_MIN) * u01());
      u01(); const face = u01() * 2 * Math.PI; u01();
      const R = [(cl[0] + rx[0] - x0[0]) * Q, -b.H, (cl[1] + rx[1] - x0[1]) * Q];
      const T = [(cl[0] + tx[0] - x0[0]) * Q, -b.H + hgt, (cl[1] + tx[1] - x0[1]) * Q];
      const Ev = v3.sub(T, R);
      const bb = v3.dot(rd, Ev), c = v3.dot(Ev, Ev), d = -v3.dot(rd, R), e = -v3.dot(Ev, R);
      let u = Math.min(Math.max((e - bb * d) / Math.max(c - bb * bb, 1e-12), 0), 1);
      const t = Math.min(Math.max(bb * u - d, tA), tB);
      u = Math.min(Math.max((bb * t + e) / c, 0), 1);
      const off = v3.sub(v3.scale(rd, t), v3.add(R, v3.scale(Ev, u)));
      const r = b.R * (1 + (b.TIP_R - 1) * u);
      const d2 = v3.dot(off, off);
      if (d2 < r * r) {
        const sk = Math.sqrt(r * r - d2), th = Math.max(t - sk, tA);
        if (th < tHit) {
          tHit = th; found = true;
          const ax = norm(Ev), v = v3.scale(rd, -1);
          const vp = norm(v3.sub(v, v3.scale(ax, v3.dot(v, ax))));
          const nRound = norm(v3.add(off, v3.scale(vp, sk)));
          let nFlat = norm(cross(ax, [Math.cos(face), 0, Math.sin(face)]));
          if (v3.dot(nFlat, v) < 0) nFlat = v3.scale(nFlat, -1);
          const nb = norm(v3.add(v3.scale(nRound, 1 - b.FLAT), v3.scale(nFlat, b.FLAT)));
          hitN = norm(v3.add(v3.scale(nb, 1 - b.GROUND_N), v3.scale([0, 1, 0], b.GROUND_N)));
        }
      }
    }
    if (found || tB >= tGround) break;
    tA = tB;
    if (tMax[0] < tMax[1]) { tMax[0] += inv[0]; cl[0] += stp[0]; } else { tMax[1] += inv[1]; cl[1] += stp[1]; }
  }
  return { z: Math.min(dd * tHit / b.H, 1), n: found ? hitN : [0, 1, 0], blade: found };
}

// Sun from the side the god view and first person face most: 50 degrees up, across the view.
const SUN = norm([0.6, Math.sin(50 * Math.PI / 180), 0.3]);
let seed = 12345;
const rnd = () => { seed = pcg(seed); return seed / 4294967296; };
for (const [deg, az] of [70, 50, 35, 25, 15].flatMap((d) => [[d, 0.4], [d, 0.4 + Math.PI], [d, 2.0]])) {   // the ray's angle below the horizon; toward, away from and across the sun
  const a = deg * Math.PI / 180;
  const rd = [Math.cos(a) * Math.cos(az), -Math.sin(a), Math.cos(a) * Math.sin(az)];
  const kSun = b.K_SUN / Math.max(SUN[1], b.SUN_Y_MIN);
  let sun = 0, sky = 0, blades = 0;
  for (let i = 0; i < RAYS; i++) {
    const w = walk(rnd() * 37.1, rnd() * 41.3, rd);
    const share = w.blade ? 1 : BLADE_THATCH_SHARE;
    sun += share * Math.max(v3.dot(w.n, SUN), 0) / SUN[1] * Math.exp(-kSun * w.z);
    sky += share * (1 + w.n[1]) / 2 * Math.exp(-b.K_SKY * w.z);
    blades += w.blade;
  }
  sun /= RAYS; sky /= RAYS;
  const hs = Math.cos(a), vh = [-rd[0] / hs, -rd[2] / hs];
  const [mSun, mSky] = swardMean(Math.sin(a), hs, SUN[1], bladeCosShare(vh, SUN));
  const es = sun / mSun - 1, ek = sky / mSky - 1;
  check((Math.abs(es) < TOL || Math.abs(sun - mSun) < SUN_ABS_TOL) && Math.abs(ek) < TOL,
    `${deg} deg down, azimuth ${az.toFixed(1)}: blade hits ${(100 * blades / RAYS).toFixed(0)}%; walk sun ${sun.toFixed(3)} vs expected ${mSun.toFixed(3)} (${(100 * es).toFixed(1)}%), sky ${sky.toFixed(3)} vs ${mSky.toFixed(3)} (${(100 * ek).toFixed(1)}%)`);
}
console.log(fails ? `${fails} failure(s)` : 'grass blades: the sward\'s mean matches the photo\'s');
process.exit(fails ? 1 : 0);
