// CPU checks of the fast-particle layer (docs/particles.md, src/rays.js):
//   1. its limits hold for every grid size (speeds, sub-steps, children, the
//      stripe's emission probability);
//   2. the nuclear table: Σ per cell, k∞ and η of the fissile materials;
//   3. a Monte Carlo of the neutron rules (a CPU twin of shaders/rays.js
//      advance): k_eff of a bare plutonium ball against its radius, and with
//      a water jacket, so the critical size and the moderator's effect are
//      measured, not assumed;
//   4. the photon rules' numbers (water's attenuation, metal's reflection, a
//      photon lighting wood);
//   5. every particle pass, and react and quiet with their particle inputs,
//      through glslangValidator as GLSL ES 3.00 for each grid size.
// usage: node tools/rays-check.mjs [--quick]
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ELEMENTS, E } from '../src/elements.js';

// shaders/far.js refuses more than 32 elements until branch `farids` lands;
// nothing here uses the far field, so stand it in when it would refuse.
const FAR_ID_CAP = 32;
if (ELEMENTS.length > FAR_ID_CAP) {
  console.log(`(far.js caps element ids at ${FAR_ID_CAP} until branch farids lands: stubbed here, ${ELEMENTS.length} elements)`);
  registerHooks({
    load(url, ctx, next) {
      if (!url.endsWith('/src/shaders/far.js')) return next(url, ctx);
      return { format: 'module', shortCircuit: true, source: 'export const WORLD_SIZE = [1024, 128, 1024]; export const farLayout = () => ({}); export const farGIGLSL = () => "";' };
    },
  });
}
const { gridLayout } = await import('../src/sim.js');
const { RAYS, NUCLEAR, EMITTERS, sigmas, crossSections, neutronSpeed, scatterEnergy, reflectOf } = await import('../src/rays.js');
const rays = await import('../src/shaders/rays.js');
const { reactFrag } = await import('../src/shaders/react.js');
const { quietFrag } = await import('../src/shaders/activity.js');
const { quadVert } = await import('../src/shaders/common.js');

const quick = process.argv.includes('--quick');
let failures = 0;
const ok = (cond, what) => { if (!cond) { failures++; console.log(`FAIL ${what}`); } else console.log(`ok   ${what}`); };

// ---- 1. limits ----
const N = RAYS.RAY_TEX ** 2;
const GRIDS = { '128': [128, 128, 128], wide: [160, 96, 160], '64': [64, 64, 64], '96': [96, 96, 96] };
ok(RAYS.PHOTON_V <= RAYS.RAY_V_MAX && RAYS.NEUT_V <= RAYS.RAY_V_MAX, `speeds within RAY_V_MAX (${RAYS.RAY_V_MAX} cells/step)`);
ok(RAYS.RAY_V_MAX / RAYS.RAY_SUBSTEPS <= 1, 'a sub-step is at most one cell');
for (const key of Object.keys(NUCLEAR)) {
  const n = NUCLEAR[key];
  if (n.fF || n.fT) ok(Math.max(n.nuF, n.nuT) <= 1 + RAYS.RAY_CHILDREN, `${key}: ν ≤ 1 + RAY_CHILDREN`);
}
for (const [label, dims] of Object.entries(GRIDS)) {
  const g = gridLayout(...dims), cycle = Math.ceil((g.width * g.height) / N);
  const p = Math.max(...Object.values(EMITTERS)) * cycle;
  ok(p <= 1, `${label}: stripe sweeps the atlas in ${cycle} steps, emission probability ${p.toExponential(2)} ≤ 1`);
}

// ---- 2. nuclear table ----
console.log('\nΣ per cell (fast | thermal: scatter, capture, fission):');
for (const key of Object.keys(NUCLEAR)) {
  const s = sigmas(key).map((x) => x.toPrecision(3));
  console.log(`  ${key.padEnd(10)} ${s.slice(0, 3).join(' ')} | ${s.slice(3).join(' ')}`);
}
const kinf = (key, E) => { const [, a, f, nu] = crossSections(key, E); return nu * f / (a + f); };
const kPuFast = kinf('PLUTONIUM', RAYS.NEUT_E_FAST), etaPuTh = kinf('PLUTONIUM', RAYS.NEUT_E_THERMAL);
const etaUTh = kinf('URANIUM', RAYS.NEUT_E_THERMAL);
console.log(`  Pu-239 k∞ fast ${kPuFast.toFixed(2)} (Lamarsh one-group: 2.61), η thermal ${etaPuTh.toFixed(2)} (real 2.1)`);
console.log(`  natural U η thermal ${etaUTh.toFixed(2)} (real 1.33), fast ${kinf('URANIUM', RAYS.NEUT_E_FAST).toFixed(2)}`);
ok(kPuFast > 2.4 && kPuFast < 2.8, 'Pu fast k∞ ≈ 2.6');
ok(etaUTh > 1.2 && etaUTh < 1.45, 'natural U thermal η ≈ 1.3');
const lamPu = 1 / sigmas('PLUTONIUM').slice(0, 3).reduce((a, b) => a + b);
console.log(`  Pu fast mean free path ${lamPu.toFixed(2)} cells; one-group diffusion: critical radius ≈ 1.9 λ = ${(1.9 * lamPu).toFixed(1)} cells`);

// ---- 3. Monte Carlo twin of the neutron rules ----
// mulberry32: a seeded stream, so the check is repeatable
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randDir(r) {
  const z = 2 * r() - 1, ph = 2 * Math.PI * r(), s = Math.sqrt(Math.max(0, 1 - z * z));
  return [s * Math.cos(ph), s * Math.sin(ph), z];
}
// A ball of plutonium (radius R cells, cells whose centres are within it) in a
// jacket of water (thickness W), in a box with W + 2 cells of air around.
function ball(R, W) {
  const side = Math.ceil(2 * (R + W)) + 4, c = side / 2;
  const at = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= side || y >= side || z >= side) return undefined;
    const d = Math.hypot(x + 0.5 - c, y + 0.5 - c, z + 0.5 - c);
    return d <= R ? 'PLUTONIUM' : d <= R + W ? 'WATER' : null;
  };
  const src = (r) => { for (;;) { const p = [0, 1, 2].map(() => c + (2 * r() - 1) * R); if (Math.hypot(...p.map((x) => x - c)) <= R) return p; } };
  return { at, src };
}
// One neutron's flight, as shaders/rays.js advance: returns its fission sites
// (each with the neutrons it starts).
function fly(world, pos, r, sites) {
  let E = RAYS.NEUT_E_FAST, v = randDir(r).map((x) => x * neutronSpeed(E));
  for (let life = RAYS.NEUT_LIFE - 1; life > 0; life--) {
    for (let s = 0; s < RAYS.RAY_SUBSTEPS; s++) {
      const np = pos.map((x, i) => x + v[i] / RAYS.RAY_SUBSTEPS);
      const key = world.at(...np.map(Math.floor));
      if (key === undefined) return;   // out of the box
      pos = np;
      if (!key || !NUCLEAR[key]) continue;
      const len = Math.hypot(...v) / RAYS.RAY_SUBSTEPS;
      const [ss, sa, sf, nu] = crossSections(key, E), st = ss + sa + sf;
      if (r() >= 1 - Math.exp(-st * len)) continue;
      const u = r() * st;
      if (u < sf) { sites.push([pos, Math.floor(nu) + (r() < nu % 1 ? 1 : 0)]); return; }
      if (u < sf + sa) return;
      E = scatterEnergy(key, E, r(), r());
      v = randDir(r).map((x) => x * neutronSpeed(E));
      break;
    }
  }
}
// k_eff by generations: sources spread through the ball, then each
// generation's fission sites are the next's sources.
function keff(R, W, n, gens, seed) {
  const r = rng(seed), world = ball(R, W);
  let src = Array.from({ length: n }, () => world.src(r)), k = 0;
  for (let gen = 0; gen < gens; gen++) {
    const sites = [];
    for (const p of src) fly(world, p, r, sites);
    const born = sites.reduce((a, [, m]) => a + m, 0);
    k = born / src.length;
    if (!born) break;
    const pool = sites.flatMap(([p, m]) => Array(m).fill(p));
    src = Array.from({ length: n }, () => pool[Math.floor(r() * pool.length)]);
  }
  return k;
}
const MC_N = quick ? 800 : 3000, MC_GENS = 4;
console.log(`\nk_eff, Monte Carlo of the neutron rules (${MC_N} neutrons, ${MC_GENS} generations):`);
const radii = quick ? [3, 5, 7] : [2, 3, 4, 5, 6, 7, 8];
const bare = radii.map((R) => keff(R, 0, MC_N, MC_GENS, 1000 + R));
const wet = radii.map((R) => keff(R, 6, MC_N, MC_GENS, 2000 + R));
radii.forEach((R, i) => console.log(`  R ${String(R).padStart(2)} cells  bare ${bare[i].toFixed(2)}   in 6 cells of water ${wet[i].toFixed(2)}`));
const crit = (ks) => { const i = ks.findIndex((k) => k >= 1); return i < 0 ? Infinity : radii[i]; };
console.log(`  critical radius: bare ~${crit(bare)} cells, water-jacketed ~${crit(wet)} cells`);
ok(bare[0] < 1 && bare.at(-1) > 1, 'a small bare ball is subcritical and a big one supercritical');
ok(crit(wet) <= crit(bare), 'water around a ball makes it critical at the same or a smaller radius');
// water slows neutrons: the mean number of collisions to thermal (real: ~18-19 in H; ln(2 MeV / 0.025 eV) / ξ, ξ = 1 for H)
{
  const r = rng(7);
  let n = 0;
  const tries = 2000;
  for (let t = 0; t < tries; t++) {
    let E = RAYS.NEUT_E_FAST;
    while (E > RAYS.NEUT_E_THERMAL * 1.0001) { E = scatterEnergy('WATER', E, r(), r()); n++; }
  }
  const m = n / tries;
  console.log(`  collisions in water to thermal: ${m.toFixed(1)} (hydrogen alone: 18.2; oxygen's share slows it)`);
  ok(m > 15 && m < 30, 'water thermalizes a fission neutron in ~20 collisions');
}

// ---- 4. photons ----
const water = ELEMENTS[E.WATER], wood = ELEMENTS[E.WOOD], metal = ELEMENTS[E.METAL];
const through = water.sigma.map((s) => Math.exp(-s * 10));
console.log(`\nA white photon through 10 cells of water keeps rgb ${through.map((x) => x.toFixed(2)).join(' ')} (blue-green)`);
ok(through[2] > through[0], 'water passes blue over red');
ok(reflectOf(metal) > 0 && reflectOf(metal) < 1 && reflectOf(wood) === 0, 'metal reflects part, wood none');
const dTwood = RAYS.PHOTON_HEAT / wood.cap;
ok(dTwood + 20 >= wood.ignite, `one white photon warms wood ${dTwood.toFixed(0)} °C: lights it (${wood.ignite} °C)`);

// ---- 5. shaders ----
const shaderMatFrag = `#version 300 es
precision highp float;
precision highp int;
#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
`;
const shaderMatVert = `#version 300 es
precision highp float;
precision highp int;
uniform mat4 modelMatrix, modelViewMatrix, projectionMatrix, viewMatrix;
in vec3 position;
`;
const raw = '#version 300 es\n';
const dir = mkdtempSync(join(tmpdir(), 'rays-glsl-'));
function check(name, src, stage) {
  const f = join(dir, `${name}.${stage}`);
  writeFileSync(f, src);
  try {
    execFileSync('glslangValidator', [f], { stdio: 'pipe' });
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n${String(e.stdout).split('\n').filter((l) => /ERROR/.test(l)).slice(0, 12).join('\n')}`);
  }
}
let n = 0;
for (const [label, dims] of Object.entries(GRIDS)) {
  const g = gridLayout(...dims);
  for (const k of ['raysAdvanceFrag', 'raysSpawnFrag', 'raysPaintFrag', 'raysRowsFrag', 'raysTotalFrag']) { check(`${k}-${label}`, raw + rays[k](g), 'frag'); n++; }
  for (const k of ['raysDepositVert', 'raysBrickVert']) { check(`${k}-${label}`, raw + rays[k](g), 'vert'); n++; }
  check(`react-${label}`, raw + reactFrag(g), 'frag');
  check(`quiet-${label}`, raw + quietFrag(g), 'frag');
  n += 2;
}
check('raysDepositFrag', raw + rays.raysDepositFrag, 'frag');
check('raysBrickFrag', raw + rays.raysBrickFrag, 'frag');
check('raysDrawVert', shaderMatVert + rays.raysDrawVert, 'vert');
check('raysDrawFrag', shaderMatFrag + rays.raysDrawFrag, 'frag');
check('quadVert', raw + quadVert, 'vert');
n += 5;
console.log(`\n${n} programs through glslangValidator`);

console.log(failures ? `\n${failures} failed` : '\nall rays checks pass');
process.exit(failures ? 1 : 0);
