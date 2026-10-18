// CPU only: the sign probe ({t}, {p}, {e}) reads V2's physical view, whose B is
// the live coarse air; the drawn projection's B is empty under V2, so {p} read 0.
// signs.js imports CSS and three/webgpu, so this checks its source, then the
// read the source selects against the real Simulation.readHeader.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Simulation } from '../../src/sim.js';

const src = readFileSync(new URL('../../src/signs.js', import.meta.url), 'utf8');
const probe = src.slice(src.indexOf('_probe(sim, info)'), src.indexOf('pr.ring.read(slot)'));
assert.match(probe, /const read = sim\.compact \? sim\.bindPhysicalRO : sim\.bindRO;/, 'V2 signs read the physical view');
assert.match(probe, /bind: \[sim\.tables, read, group\], header: sim\.readHeader\(\{ physical: true \}\)/, 'with its header');
assert.match(probe, /if \(!read\) return;/, 'and wait while the native dynamics build');
const header = sim => Simulation.prototype.readHeader.call(sim, { physical: true });
const base = { header: () => ({ src: 0 }) };
assert.equal(header({ ...base, compact: null }).format, 0, 'V1 reads its own state, unchanged');
assert.equal(header({ ...base, compact: { isReady: true, sync() {} } }).format, 3, 'V2: format 3, B = live coarse air (shaders/common.js fetchBs)');
console.log('sign probe: V2 reads the physical view (live pressure); V1 unchanged; no GPU');
