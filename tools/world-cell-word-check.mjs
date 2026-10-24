// CPU check of the world copy's cell word (src/shaders/world/cellWord.js): the JS codec round-trips,
// the temperature code is monotonic and within its stated steps, and the WGSL decoders validate (naga).
import { wcWord, wcUnword, wcTempCode, wcTempOf, cellWordWGSL, WC_MIXED } from '../src/shaders/world/cellWord.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const fail = (m) => { bad++; console.error('FAIL', m); };
for (let c = 0; c < 256; c++) if (wcTempCode(wcTempOf(c)) !== c) fail(`temperature code ${c} doesn't round-trip`);
for (let c = 1; c < 256; c++) if (!(wcTempOf(c) > wcTempOf(c - 1))) fail(`temperature code ${c} not monotonic`);
for (let t = -60; t < 99; t += 0.37) if (Math.abs(wcTempOf(wcTempCode(t)) - t) > 0.5 + 1e-9) fail(`T ${t} off by more than 0.5 °C`);
for (let t = 100; t < 6000; t *= 1.013) if (Math.abs(wcTempOf(wcTempCode(t)) / t - 1) > 0.023) fail(`T ${t} off by more than 2.3 %`);
for (const [id, ct, t, aux] of [[0, 0, 20, 0], [255, 255, 6000, 1], [7, 33, 1200, 0.5], [12, 4, -60, 1 / 127]]) {
  const w = wcWord(id, ct, t, aux), u = wcUnword(w);
  if (w & WC_MIXED) fail(`word ${w} sets the MIXED bit`);
  if (u.id !== id || u.ctype !== ct || Math.abs(u.aux - aux) > 0.5 / 127) fail(`word ${[id, ct, t, aux]} → ${JSON.stringify(u)}`);
}
const dir = mkdtempSync(join(tmpdir(), 'wcword-'));
const file = join(dir, 'm.wgsl');
writeFileSync(file, `${cellWordWGSL}\n@compute @workgroup_size(1) fn main() { let w = wcWord(3, 4u, 20.0, 0.5); _ = wcTemp(w) + wcAux(w) + f32(wcId(w)) + f32(wcCtype(w) + wcLocal(vec3i(1))); }`);
try { execFileSync('naga', [file], { stdio: 'pipe' }); } catch (e) { fail(`naga: ${e.stderr}`); }
console.log(bad ? `world-cell-word-check: ${bad} failures` : 'world-cell-word-check: ok');
process.exit(bad ? 1 : 0);
