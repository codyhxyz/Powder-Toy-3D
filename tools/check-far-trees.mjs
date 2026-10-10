// CPU check that the far field's tree shapes (shaders/far.js treeFill) follow
// the tree constructions (constructions/builtins.js TREES): runs each kind of
// tree with an API that records its shapes, and compares them with a JS
// mirror of the shader's arithmetic (which mulberry32 draw gives what):
//   - every kind's height H (draw 0);
//   - an oak's trunk height and every crown's centre (draws after the root
//     flare's disc, one per cell of its square);
//   - a pine's tiers: each disc's radius at each height;
//   - a palm's top (lean and azimuth).
// Fails if builtins.js changes how these are drawn without shaders/far.js.
// usage: node tools/check-far-trees.mjs
import { Model, createApi, makeRng } from '../src/constructions/runtime.js';
import { TREES } from '../src/constructions/builtins.js';
import { TREE_SHAPE as S, TREE_VARIANTS } from '../src/shaders/far.js';
import { TREE } from '../src/world/generator.js';
import { scaleFor } from '../src/constructions/runtime.js';

const SEEDS = 200;          // construction seeds per kind and size
const EPS = 1e-4;           // cells: positions agree to float slop
const DEAD_UPRIGHT = 0.99;  // a dead tree's trunk: its rise over its length at least this (tilt ±0.1 per unit up)
const TAU = Math.PI * 2;

// mulberry32 draw i (from 0) of seed s, as the shader computes it (float32 of the 32-bit value)
const mbDraw = (s, i) => {
  let t = (s + Math.imul(i + 1, 0x6d2b79f5)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
  return Math.fround((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const mbRange = (s, i, lo, hi) => lo + (hi - lo) * mbDraw(s, i);
const mbInt = (s, i, lo, hi) => lo + Math.floor((hi - lo + 1) * mbDraw(s, i));
const H_RANGE = { oak: S.OAK_H, birch: S.BIRCH_H, pine: S.PINE_H, palm: S.PALM_H, dead: S.DEAD_H };

// run a tree, recording its shapes
function record(variant, size, seed) {
  const model = new Model(makeRng(seed));
  const api = createApi(model, { size });
  const log = { ball: [], disc: [], rod: [] };
  const wrap = (k) => { const f = api[k]; api[k] = (...a) => { log[k].push(a); return f(...a); }; };
  ['ball', 'disc', 'rod'].forEach(wrap);
  TREES[variant](api, variant);
  return log;
}

let failures = 0, checked = 0;
const fail = (msg) => { if (failures++ < 20) console.log('FAIL', msg); };
for (const variant of TREE_VARIANTS) {
  for (let size = TREE.SIZE_MIN; size <= TREE.SIZE_MAX; size++) {
    const T = scaleFor(size);
    for (let k = 0; k < SEEDS; k++) {
      const seed = (Math.imul(k + 1, 2654435761) ^ (size << 20)) >>> 0;
      const log = record(variant, size, seed);
      const H = Math.round(mbRange(seed, 0, ...H_RANGE[variant]) * T);
      checked++;
      if (variant === 'oak') {
        const th = Math.round(H * mbRange(seed, 1, S.OAK_TRUNK[0], S.OAK_TRUNK[1]));
        const trunk = log.rod[0];
        if (Math.abs(trunk[1].y - th) > EPS) fail(`oak ${size}/${seed}: trunk top ${trunk[1].y} != ${th}`);
        const tr = Math.max(0.5, S.OAK_TR * T);
        const R = Math.ceil(tr + S.OAK_FLARE + 1);
        const i0 = 2 + (2 * R + 1) * (2 * R + 1);
        const n = mbInt(seed, i0, S.OAK_BRANCHES[0], S.OAK_BRANCHES[1]);
        const a0 = mbDraw(seed, i0 + 1) * TAU;
        const crowns = [[0, th + S.OAK_CROWN_Y * H, 0]];
        for (let i = 0; i < n; i++) {
          const j = i0 + 2 + 4 * i;
          const az = a0 + (i / n) * TAU + mbRange(seed, j, -S.OAK_AZ_JITTER, S.OAK_AZ_JITTER);
          const el = mbRange(seed, j + 1, S.OAK_EL[0], S.OAK_EL[1]);
          const y = th - mbInt(seed, j + 2, S.OAK_DROP[0], S.OAK_DROP[1]);
          const len = H * mbRange(seed, j + 3, S.OAK_LEN[0], S.OAK_LEN[1]);
          crowns.push([Math.cos(az) * Math.cos(el) * len, y + Math.sin(el) * len, Math.sin(az) * Math.cos(el) * len]);
        }
        if (log.ball.length !== crowns.length) { fail(`oak ${size}/${seed}: ${log.ball.length} crowns, expected ${crowns.length}`); continue; }
        log.ball.forEach(([x, y, z, r], i) => {
          const c = crowns[i];
          // float32 draws: a few ULPs of the trig products
          if (Math.hypot(x - c[0], y - c[1], z - c[2]) > 1e-3) fail(`oak ${size}/${seed}: crown ${i} at ${[x, y, z]} != ${c}`);
          if (r < S.OAK_CROWN_R * H * 0.85 || r > S.OAK_CROWN_R * H * 1.15) fail(`oak ${size}/${seed}: crown ${i} radius ${r} far from ${S.OAK_CROWN_R * H}`);
        });
      } else if (variant === 'pine') {
        const y0 = Math.round(H * mbRange(seed, 1, S.PINE_Y0[0], S.PINE_Y0[1]));
        const Rp = H * mbRange(seed, 2, S.PINE_R[0], S.PINE_R[1]);
        const tiers = Math.max(S.PINE_TIERS_MIN, Math.round(mbRange(seed, 3, S.PINE_TIERS[0], S.PINE_TIERS[1]) * Math.sqrt(T)));
        const discs = log.disc;
        if (discs.length !== H - y0 + 1) { fail(`pine ${size}/${seed}: ${discs.length} tiers, expected ${H - y0 + 1}`); continue; }
        discs.forEach(([, y, , r]) => {
          const u = (y - y0) / (H - y0);
          const want = Rp * Math.pow(1 - u, S.PINE_TAPER) * (1 - S.PINE_FLARE * ((u * tiers) % 1)) + S.PINE_TIP;
          if (Math.abs(r - want) > 1e-3) fail(`pine ${size}/${seed}: tier at ${y} radius ${r} != ${want}`);
        });
      } else if (variant === 'palm') {
        const az = mbDraw(seed, 1) * TAU, lean = H * mbRange(seed, 2, S.PALM_LEAN[0], S.PALM_LEAN[1]);
        const top = log.rod.filter(([, , , el]) => el === 'WOOD').at(-1)[1];   // the last trunk segment's end
        const want = [Math.cos(az) * lean, H, Math.sin(az) * lean];
        if (Math.hypot(top.x - want[0], top.y - want[1], top.z - want[2]) > 1e-3) fail(`palm ${size}/${seed}: top ${[top.x, top.y, top.z]} != ${want}`);
      } else if (variant === 'birch') {
        // the height only: the trunk's top
        const top = Math.max(...log.rod.filter(([, , , el]) => el === 'WOOD').map(([a, b]) => Math.max(a.y, b.y)));
        if (Math.abs(top - (H - 2)) > EPS) fail(`birch ${size}/${seed}: trunk top ${top} != ${H - 2}`);
      } else {
        // dead: the trunk (its first rod) is DEAD_TRUNK of H long, nearly upright (its tilt is drawn: within DEAD_TILT)
        const [a, b] = log.rod[0];
        const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        if (Math.abs(len - S.DEAD_TRUNK * H) > EPS || b.y < DEAD_UPRIGHT * len) fail(`dead ${size}/${seed}: trunk ${[b.x, b.y, b.z]} not ${S.DEAD_TRUNK * H} up`);
      }
    }
  }
}
console.log(failures ? `${failures} mismatches in ${checked} trees` : `tree shapes follow the constructions (${checked} trees)`);
process.exit(failures ? 1 : 0);
