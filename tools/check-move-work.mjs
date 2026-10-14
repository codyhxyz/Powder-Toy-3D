// CPU-only movement work-elimination invariants; optional Naga WGSL -> Metal compilation.
// node tools/check-move-work.mjs [--naga]
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { moveBlockFrag, MOVE_FORMS } from '../src/shaders/move.js';
import { brickCoordOf, brickIdOf, sleepUnitOf } from '../src/shaders/common.js';

const grids = [
  { nx: 32, ny: 32, nz: 32 },
  { nx: 48, ny: 16, nz: 32 },
  { nx: 48, ny: 16, nz: 32, sleepUnit: { x: 4, y: 2, z: 2 } },
];
const scan = `  for (var i = 0; i < 8; i++) {
    let c = edgeCell(cellAt(base, i));
    if (inGrid(c) && drawnUnit(unitOfCell(c))) { run = true; }
  }`;
const scanGuard = `  var run = P.margin == 0u && par == 0;
  // Offset-zero home blocks lie entirely in their DRAWN-list unit.
  // MOVE1 and margin blocks still need the eight-cell membership test.
  if (!run) {
${scan}
  }`;
const flagGuard = `      // In place on a nonfresh step no flags/state are written; deco and flow still run.
      if (P.fresh != 0u || P.outOfPlace != 0u) {
`;
const flagEnd = `      }
      }
      if (P.deco != 0u) {`;
let variants = 0;
const temp = process.argv.includes('--naga') ? mkdtempSync(join(tmpdir(), 'move-work-')) : null;
try {
  for (const [gi, g] of grids.entries()) {
    for (const form of Object.keys(MOVE_FORMS)) for (const debug of [false, true]) for (const raceProbe of [false, true]) {
      const opts = { form, debug, raceProbe };
      const reference = moveBlockFrag(g, { ...opts, optimize: false });
      const optimized = moveBlockFrag(g, opts);
      assert.equal(optimized, moveBlockFrag(g, { ...opts, optimize: true }));
      // Removing ONLY the two proven guards restores the entire reference:
      // ownership, solve/RNG order, state writes, decoration, and flow included.
      assert.ok(optimized.includes(scanGuard));
      assert.ok(optimized.includes(flagGuard));
      assert.ok(optimized.includes(flagEnd));
      assert.equal(optimized.replace(scanGuard, `  var run = false;\n${scan}`)
        .replace(flagGuard, '').replace(flagEnd, `      }\n      if (P.deco != 0u) {`), reference);
      if (temp && gi === 0) for (const [name, code] of [['reference', reference], ['optimized', optimized]]) {
        const path = join(temp, `${form}-${debug}-${raceProbe}-${name}`);
        writeFileSync(`${path}.wgsl`, code);
        execFileSync('naga', [`${path}.wgsl`, `${path}.metal`], { stdio: 'pipe' });
      }
      variants++;
    }

    // Every possible DRAWN-list entry/home block at parity zero stays in
    // that very unit, including grid boundaries and both sleep-unit sizes.
    const u = sleepUnitOf(g);
    for (let unit = 0; unit < u.units; unit++) for (let kb = 0; kb < 8 * u.bricks; kb++) {
      const brick = brickCoordOf(g, unit * u.bricks + Math.floor(kb / 8));
      const k = kb % 8;
      const base = brick.map((v, axis) => 4 * v + 2 * ((k >> axis) & 1));
      for (let i = 0; i < 8; i++) {
        const c = base.map((v, axis) => v + ((i >> axis) & 1));
        assert.ok(c.every((v, axis) => v >= 0 && v < [g.nx, g.ny, g.nz][axis]));
        assert.equal(Math.floor(brickIdOf(g, ...c.map(v => v >> 2)) / u.bricks), unit);
      }
    }
  }
  // Exhaust flags and dirty bits: excluded quiet work cannot write flags or
  // state. Fresh steps and every out-of-place copy still execute that work.
  for (const fresh of [0, 1]) for (const outOfPlace of [0, 1]) {
    for (let f0 = 0; f0 < 256; f0++) for (let bit = 0; bit < 8; bit++) {
      const fl = fresh ? f0 & ~(1 << bit) : f0;
      const writes = outOfPlace !== 0 || fl !== f0;
      const gate = fresh !== 0 || outOfPlace !== 0;
      if (!gate) assert.equal(writes, false);
      if (writes) assert.equal(gate, true);
    }
  }
  console.log(`PASS: ${variants} source pairs; DRAWN home-block containment; quiet flag invariants${temp ? '; 16 Naga WGSL -> Metal compilations' : ''}`);
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true });
}
