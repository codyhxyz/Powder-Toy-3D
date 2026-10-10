// Lint for docs/scaling.md D5: the simulation state is reached only through the
// accessors in src/shaders/common.js (fetchA/fetchB/fetchF to read, writeState
// to write) and, on the CPU, through Simulation's readState/readCell/cellTexel in
// src/sim.js, so its texel layout and format can change in those two files.
// Fails on any direct access elsewhere, e.g. in code merged from main:
//   - GLSL sampling a state texture: texelFetch(tA, ...), texture(tB, ...),
//     texelFetch(tF, ...) (the activity flags), ...
//   - GLSL declaring the state samplers (the prelude owns them)
//   - GLSL declaring a pass's own state outputs (use stateOutGLSL / writeState)
//   - JS reading a state target back (sim.targets[...]) outside src/sim.js
// usage: node tools/check-state-access.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '../..');
const SELF = 'tools/check-state-access.mjs';

const SAMPLE = 'texelFetch|texelFetchOffset|texture|textureLod|textureLodOffset|textureOffset|textureGrad|textureGradOffset|textureProj|textureProjLod|textureSize';
const RULES = [
  { where: ['src'], except: ['src/shaders/common.js'], what: 'samples a state texture (use fetchA/fetchB/fetchF)',
    re: new RegExp(`\\b(?:${SAMPLE})\\s*\\(\\s*t[ABF]\\s*[,)]`) },
  { where: ['src'], except: ['src/shaders/common.js'], what: 'declares a state sampler (the prelude has tA/tB/tF)',
    re: /\buniform\s+(?:(?:high|medium|low)p\s+)?[iu]?sampler2D\s+t[ABF]\s*;/ },
  { where: ['src'], except: ['src/shaders/common.js'], what: 'declares state outputs (use stateOutGLSL and writeState)',
    re: /\bout\s+(?:(?:high|medium|low)p\s+)?(?:[iu]?vec4|uint)\s+(?:o[ABF]|outState[AB]|outFlags)\s*;|\boutState[AB]\b|\boutFlags\b/ },
  // (the patchwork scene bakes the island in a stand-in grid of its own, not a Simulation, and reads that back)
  { where: ['src', 'tools', 'scripts'], except: ['src/sim.js', 'src/world/scenes/patchworkIsland.js'], what: 'reads a state target back (use sim.readState/readCell)',
    re: /readRenderTargetPixels(?:Async)?\s*\(\s*[\w.()]*targets\s*\[/ },
];

const files = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(m?js)$/.test(n) ? [p] : [];
});

let failures = 0;
for (const rule of RULES) {
  for (const f of rule.where.flatMap((d) => files(join(root, d)))) {
    const rel = relative(root, f);
    if (rel === SELF || rule.except.includes(rel)) continue;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (!rule.re.test(line)) return;
      failures++;
      console.log(`${rel}:${i + 1}: ${rule.what}\n    ${line.trim()}`);
    });
  }
}
console.log(failures ? `${failures} direct state access(es)` : 'state access OK: only through the accessors');
process.exit(failures ? 1 : 0);
