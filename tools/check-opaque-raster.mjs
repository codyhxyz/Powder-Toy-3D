// CPU only: extraction lifecycle and generated-shader safety contract.
// --naga additionally validates all emitted modules with the local Naga CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createBlocks } from '../src/gfx/blocks.js';
import { opaqueWGSL, OPAQUE_LAYOUTS, opaquePipeline } from '../src/shaders/opaqueRaster.js';
import { volumeFrag, REALISTIC_LEVELS, VolumeParams } from '../src/shaders/render.js';
import { meshWGSL } from '../src/shaders/blocks.js';

const g = { nx: 32, ny: 32, nz: 32, slots: 32768, nbricks: 512 };
const calls = [], destroyed = [];
const gpu = {
  _frameUniforms: { layout: {}, group: {} },
  device: { limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 }, createSampler() { throw Error('Plain sampler'); } },
  layout: (name) => ({ name }), bindGroup: () => ({}),
  createTexture() { throw Error('Plain shadow texture'); },
  createBuffer: (desc) => ({ ...desc, destroy() { destroyed.push(desc.label); } }),
  kernel: ({ name }) => ({ name, state: 'ready', ready: Promise.resolve(), dispatch: () => calls.push(name) }),
  renderPipeline() { throw Error('Plain pipeline'); },
  readback: { ring: () => ({ buffer: {}, next: () => 0, read: () => Promise.resolve(new ArrayBuffer(16)), close: () => calls.push('close') }) },
  frame: {}, flush: () => {},
};
const sim = { g, id: 1, version: 1, cur: 0, origin: { x: 0, y: 0, z: 0 }, header: () => ({}) };
const faces = createBlocks(gpu, sim, { facesOnly: true });
await faces.ready;
assert.equal(faces.isReady, true);
assert.equal(faces.update(), true);
assert.equal(faces.update(), false, 'still frame does not remesh');
sim.version++;
assert.equal(faces.update(), true, 'edits remesh');
sim.cur = 1;
assert.equal(faces.update(), true, 'state copy remeshes');
sim.origin.x++;
assert.equal(faces.update(), true, 'window movement remeshes');
assert.equal(faces.drawOpaque({}), false, 'faces-only never draws Plain shading');
assert.equal(faces.drawTranslucent({}), false);
assert.equal(calls.filter((x) => x === 'blocks.mesh').length, 4);
assert.equal(calls.filter((x) => x === 'blocks.finish').length, 4);
assert(faces.faces && faces.args);
faces.dispose();
assert.equal(destroyed.length, 3);
assert(calls.includes('close'));

const modules = { mesh: meshWGSL(g), reference: volumeFrag(g), curved: volumeFrag(g, { curved: true }) };
for (const level of ['off', 'base', 'balanced', 'full']) modules[`raster-${level}`] = opaqueWGSL(g, REALISTIC_LEVELS[level]());
const shader = modules['raster-off'];
const fs = shader.slice(shader.lastIndexOf('@fragment fn fs('));
for (const code of ['BRICK_SURF | BRICK_MEDIA', 'occCellId(mask, bid, cell)', 'id == E_CRYSTAL', 'id != E_EMPTY', 'RCLASS(id) != R_OPAQUE', 'P.marchNear', 'crispHit(cell', 'crispSurf(cell', 'decoSurf(&s)', 'shadeSurf(s, rd)', 'o.depth = volumeDepth(hp)']) assert(fs.includes(code), code);
assert.equal((fs.match(/fetchA\(/g) ?? []).length, 1, 'gate uses compact occupancy, full state only at accepted hit');
assert(!fs.includes('farHazePremul'), 'world stays on the original path');
assert(modules.reference.includes('hitK = HIT_CRISP'), 'absent/overflow faces retain ray fallback');
assert(modules.reference.includes('if (th > tCut) { cut = true; break; }'), 'reference mesh contact comparison is unchanged');
assert(modules.curved.includes('var tCut = MESH_CUT_NONE'));
assert(modules.mesh.includes('args[1] = min(o, P.capO)'), 'overflow remains bounded');
assert.equal(OPAQUE_LAYOUTS()[0].at(-1).visibility, 1, 'face storage is vertex-only');
assert.equal(opaquePipeline().depthStencil.depthWriteEnabled, true);
assert(VolumeParams.size <= 256);
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert(app.includes('!win && !blocks && !warpNow()?.k'), 'world and curved opt out');
assert(app.indexOf("'realistic opaque faces'") < app.indexOf('if (drew && !blocks) cut.capture'), 'raster depth precedes mesh cut copy');
if (process.argv.includes('--naga')) {
  const dir = mkdtempSync(join(tmpdir(), 'opaque-raster-'));
  try {
    for (const [name, code] of Object.entries(modules)) {
      const path = join(dir, `${name}.wgsl`);
      writeFileSync(path, code);
      execFileSync('naga', [path], { stdio: 'pipe' });
      console.log(`Naga: ${name} passed`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log('opaque raster: CPU lifecycle and shader contract passed (no GPU launched)');
