// CPU check of the far ground map (src/shaders/far.js FAR_GROUND, shaders/world/farFromCopy.js farGroundFrag):
// naga on every far module the ground map touches (its level-0 kernel, its mips' and skip levels' kernel, the
// occupancy kernels that share its buffer, and the far view in its four variants) for every big map's layout;
// and the layout's words for each map (its memory). No GPU, no browser.
// usage: node tools/far-ground-cpu-check.mjs [--mem]
import { WGSL_CHECK as COPY_CHECK } from '../src/shaders/world/farFromCopy.js';
import { FAR_GROUND, farLayout, farColumnsFrag, farMip1Frag, farMip2Frag, farFrag, groundLayout, farBufferWords, occupancyWords } from '../src/shaders/far.js';
import { farGroundFrag } from '../src/shaders/world/farFromCopy.js';
import { gridLayout } from '../src/sim.js';
import { nagaExec } from './naga.mjs';

let bad = 0;
const fail = (msg) => { bad++; console.error(`FAIL ${msg}`); };
// every big map's world size (src/maps.js dims; Descent's fold: memory/descent-map.md, 2560 × 320 × 2560)
const WORLDS = { island: [1024, 128, 1024], tinkerCreek: [3072, 128, 1024], giantVolcano: [1024, 384, 1024], descent: [2560, 320, 2560] };
const g = gridLayout(128, 128, 128);
for (const [name, size] of Object.entries(WORLDS)) {
  const L = farLayout(size), G = groundLayout(L);
  const mb = (w) => (w * 4 / 2 ** 20).toFixed(1);
  console.log(`${name} ${size.join('×')}: occupancy ${mb(occupancyWords(L))} MiB, + ground map ${mb(G.words - occupancyWords(L))} MiB (level 0 ${mb(L.size[0] * L.size[2])})`);
  if (farBufferWords(L) * 4 > 128 * 2 ** 20) fail(`${name}: the occupancy buffer passes a 128 MiB binding`);
  const mods = [
    ['farGround', farGroundFrag(g, L)], ['farColumns', farColumnsFrag(g, L)], ['farMip1', farMip1Frag(g, L)], ['farMip2', farMip2Frag(g, L)],
    ...(name === 'island' ? [false, true].flatMap((curved) => [false, true].map((mixed) => [`far view${curved ? ' curved' : ''}${mixed ? ' mixed' : ''}`, farFrag(g, L, { curved, mixed })])) : []),
  ];
  for (const [m, code] of mods) {
    try { nagaExec(code, `${name}-${m}.wgsl`); console.log(`  naga ${m}: ok`); } catch (e) { fail(String(e.message).slice(0, 2500)); }
  }
}
for (const c of COPY_CHECK()) { try { nagaExec(c.code(g), `${c.name}.wgsl`); } catch (e) { fail(String(e.message).slice(0, 1500)); } }

// ---------------------------------------------------------------- the walk and the skip, against brute force
// JS twins of farGroundHit and farColumnSkip (shaders/far.js) on a random world of columns [B, H): the walk's
// hit must be the first box the ray meets in its window (none it starts inside), and no skip may jump past a
// point where the ray is below the top of the brick column under it.
{
  const F = FAR_GROUND, BS = 4, NX = 96, NZ = 96, WBX = NX / BS, WBZ = NZ / BS;
  let rng = 20261026;
  const rand = () => { rng = (Math.imul(rng, 1103515245) + 12345) >>> 0; return rng / 2 ** 32; };
  const H = new Float64Array(NX * NZ), B = new Float64Array(NX * NZ);
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    const h = Math.floor(20 + 8 * Math.sin(x / 9) + 6 * Math.cos(z / 7) + 3 * rand());
    const crown = rand() < 0.05;   // a crown: a run in the air
    H[x + NX * z] = crown ? h + 12 : h;
    B[x + NX * z] = crown ? h + 6 : (rand() < 0.3 ? h - 3 : 0);
  }
  const col = (x, z) => { const q = [Math.min(Math.max(x, 0), NX - 1), Math.min(Math.max(z, 0), NZ - 1)]; return q[0] + NX * q[1]; };
  const mip1 = (bx, bz) => { let m = 0; for (let z = 0; z < BS; z++) for (let x = 0; x < BS; x++) m = Math.max(m, H[col(bx * BS + x, bz * BS + z)]); return m; };
  const EPS = 1e-3, FLAT = 1e-5;
  function walk(pc, d) {
    const dy = Math.max(Math.abs(d[1]), FLAT);
    const sA = -Math.min(F.REFINE_UP / dy, F.REFINE_SPAN);
    const inv = [1 / d[0], 1 / d[2]], up = [d[0] >= 0 ? 1 : 0, d[2] >= 0 ? 1 : 0];
    const wa = [-pc[0] * inv[0], -pc[2] * inv[1]], wb = [(NX - pc[0]) * inv[0], (NZ - pc[2]) * inv[1]];
    const sB = Math.min(F.REFINE_DOWN / dy, F.REFINE_SPAN, Math.max(wa[0], wb[0]), Math.max(wa[1], wb[1]));
    let s = Math.max(sA, Math.min(wa[0], wb[0]), Math.min(wa[1], wb[1]));
    for (let i = 0; i < F.REFINE_COLS; i++) {
      if (s >= sB) break;
      const q = [pc[0] + d[0] * (s + EPS), pc[2] + d[2] * (s + EPS)];
      const bc = [Math.floor(q[0] / BS), Math.floor(q[1] / BS)];
      if (bc[0] < 0 || bc[1] < 0 || bc[0] >= WBX || bc[1] >= WBZ) break;
      const sb = Math.min(((bc[0] + up[0]) * BS - pc[0]) * inv[0], ((bc[1] + up[1]) * BS - pc[2]) * inv[1], sB);
      if (Math.min(pc[1] + d[1] * s, pc[1] + d[1] * sb) >= mip1(bc[0], bc[1])) { s = sb; continue; }
      for (let j = 0; j < 2 * BS; j++) {
        if (s >= sb) break;
        const c = [Math.floor(pc[0] + d[0] * (s + EPS)), Math.floor(pc[2] + d[2] * (s + EPS))];
        const se = Math.min((c[0] + up[0] - pc[0]) * inv[0], (c[1] + up[1] - pc[2]) * inv[1], sb);
        const h = H[col(c[0], c[1])], b = B[col(c[0], c[1])];
        const ya = pc[1] + d[1] * s, yb = pc[1] + d[1] * se;
        if (h > 0 && Math.min(ya, yb) < h && Math.max(ya, yb) > b) {
          if (ya >= h) return { s: s + (ya - h) / dy };
          if (ya <= b) return { s: s + (b - ya) / dy };
          if (s <= sA) return null;
          return { s };
        }
        s = se;
      }
      s = sb;
    }
    return null;
  }
  // brute force: the ray's first entry into any box [c, c + 1) × [B, H) × [c, c + 1) in [sA, sB]
  function brute(pc, d) {
    const dy = Math.max(Math.abs(d[1]), FLAT);
    const sA = -Math.min(F.REFINE_UP / dy, F.REFINE_SPAN), sB = Math.min(F.REFINE_DOWN / dy, F.REFINE_SPAN);
    let best = Infinity, inside = false;
    for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
      const h = H[x + NX * z], b = B[x + NX * z];
      if (!(h > 0)) continue;
      const lo = [x, b, z], hi = [x + 1, h, z + 1];
      let tn = -Infinity, tf = Infinity;
      for (let a = 0; a < 3; a++) {
        const t0 = (lo[a] - pc[a]) / d[a], t1 = (hi[a] - pc[a]) / d[a];
        tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
      }
      if (tn > tf || tf < sA || tn > sB) continue;
      if (tn < sA) { inside = true; continue; }
      best = Math.min(best, tn);
    }
    return { best, inside };
  }
  let n = 0, hits = 0, misses = 0;
  for (let k = 0; k < 4000; k++) {
    const az = rand() * 2 * Math.PI, el = -(0.01 + rand() * 1.2);
    const d = [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)];
    const x = 20 + rand() * 56, z = 20 + rand() * 56;
    const pc = [x, H[col(Math.floor(x), Math.floor(z))] + (rand() - 0.5) * 4, z];
    const w = walk(pc, d), b = brute(pc, d);
    n++;
    if (w) {
      hits++;
      if (Math.abs(w.s - b.best) > 1e-6 && !(b.inside && w.s >= b.best - 1e-6)) fail(`walk ${w.s} vs brute ${b.best} (inside ${b.inside}) at ${pc} along ${d}`);
    } else if (b.best < Infinity && !b.inside) {
      // a miss is allowed only past the walk's brick-column budget
      misses++;
    }
    if (bad > 5) break;
  }
  console.log(`walk: ${n} rays, ${hits} hits equal brute force, ${misses} left to the field (column budget)`);
  if (misses > n * 0.02) fail(`walk: ${misses} of ${n} rays ran out of columns`);
  // the skip: tops of brick columns (level 1) and their 4× maxima; a jump never passes a point below a level-1 top
  const lev = [null, []];
  for (let bz = 0; bz < WBZ; bz++) for (let bx = 0; bx < WBX; bx++) lev[1][bx + WBX * bz] = mip1(bx, bz) + BS;
  const dims = [null, [WBX, WBZ]];
  for (let k = 2; k <= 3; k++) {
    const [px, pz] = dims[k - 1], nx = Math.ceil(px / 4), nz = Math.ceil(pz / 4), a = [];
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      let m = 0;
      for (let j = 0; j < 16; j++) { const cx = x * 4 + (j % 4), cz = z * 4 + (j >> 2); if (cx < px && cz < pz) m = Math.max(m, lev[k - 1][cx + px * cz]); }
      a[x + nx * z] = m;
    }
    lev[k] = a; dims[k] = [nx, nz];
  }
  const top = (k, r) => { const [nx, nz] = dims[k]; return lev[k][Math.min(Math.max(r[0], 0), nx - 1) + nx * Math.min(Math.max(r[1], 0), nz - 1)]; };
  function skip(ro, rd, t) {
    const p = ro.map((v, i) => v + rd[i] * t);
    let best = t;
    for (let k = 3; k >= 1; k--) {
      const size = 4 ** k, r = [Math.floor(p[0] / size), Math.floor(p[2] / size)], tp = top(k, r);
      if (p[1] < tp) continue;
      const tx = Math.min(((r[0] + (rd[0] >= 0 ? 1 : 0)) * size - ro[0]) / rd[0], ((r[1] + (rd[2] >= 0 ? 1 : 0)) * size - ro[2]) / rd[2]);
      let tn = tx;
      if (rd[1] < 0) tn = Math.min(tn, (tp - ro[1]) / rd[1]);
      best = Math.max(best, tn);
      if (tn >= tx) break;
    }
    return best;
  }
  let jumps = 0;
  for (let k = 0; k < 2000 && bad < 6; k++) {
    const az = rand() * 2 * Math.PI, el = -(0.02 + rand() * 0.5);
    const rd = [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)];
    const ro = [10 + rand() * 76, 40 + rand() * 30, 10 + rand() * 76];
    const t = rand() * 10, tj = skip(ro, rd, t);
    if (tj > t) jumps++;
    for (let u = t; u < tj; u += 0.05) {
      const q = ro.map((v, i) => v + rd[i] * u), bx = Math.floor(q[0] / BS), bz = Math.floor(q[2] / BS);
      if (bx < 0 || bz < 0 || bx >= WBX || bz >= WBZ) break;
      if (q[1] < lev[1][bx + WBX * bz] - 1e-9) { fail(`skip from ${t} to ${tj} passes ${u}, under its brick column's top`); break; }
    }
  }
  console.log(`skip: ${jumps} of 2000 rays jumped, none past a brick column's top`);
}
if (bad) { console.error(`${bad} failed`); process.exit(1); }
console.log('far ground: ok');
