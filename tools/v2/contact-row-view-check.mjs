// CPU-only scalar row-view regression. No browser, device or GPU execution.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { E } from '../../src/elements.js';
import * as C from '../../src/v2/contact.js';
import { CONTACT_ROW_SCHEMA, contactTableLayout } from '../../src/v2/contactTable.js';
import { contactWGSL, lowerContactRowReads } from '../../src/shaders/v2/contact.js';
import { contactKernelWGSL } from '../../src/shaders/v2/contact-kernel.js';
import { v2Table } from '../../src/shaders/v2.js';
import { contactPrelude, contactEntry } from './contact-prelude.mjs';

const hash = source => createHash('sha256').update(source).digest('hex');
const layout = contactTableLayout(C.CONTACT_ROWS.length, C.CONTACT_REACTIONS.length);
const memory = v2Table(), words = new Uint32Array(memory.buffer), signed = new Int32Array(memory.buffer);
const helperBlock = contactWGSL.match(/\/\/ BEGIN scalar contact row views\n[^]*?\/\/ END scalar contact row views\n/)[0];
const abi = contactWGSL.match(/struct CTRow \{[^}]*\}/)[0] + '\n' + contactWGSL.match(/fn ctRow\(id:i32\)->CTRow \{[^]*?\n\}/)[0];
assert.equal(C.CONTACT_ROWS.length, 91);
assert.equal(CONTACT_ROW_SCHEMA.length, 37);
assert.equal((contactWGSL.match(/\bctRow\(/g) || []).length, 1, 'only the preserved ABI declaration materializes a full row');
assert.equal((contactWGSL.match(/(?:let|var) ctRowBase_\w+\s*=\s*ctRowBase\(/g) || []).length, 12);
const distinctUses = contactWGSL.split(/\bfn /).reduce((n, fn) => n + new Set([...fn.matchAll(/ctRow_(\w+)\(ctRowBase_(\w+)\)/g)].map(m => `${m[2]}.${m[1]}`)).size, 0);
assert.equal(distinctUses, 43, '12 local views require only 43 distinct scalar fields');

// Undo ONLY the allowed read lowering, then compare every byte to the approved
// pre-change emitted source. This catches unrelated gates, reloads, RNG/order,
// arithmetic, CTRx or ABI edits without retaining a second full kernel fixture.
const restored = contactWGSL.replace('\n' + helperBlock, '')
  .replace(/ctRow_(\w+)\(ctRowBase\((ctNuclearId\(\w+\)|\w+(?:\.\w+)?)\)\)/g, 'ctRow($2).$1')
  .replace(/ctRow_(\w+)\(ctRowBase_(\w+)\)/g, '$2.$1')
  .replace(/ctRowBase_(\w+)(\s*=\s*)ctRowBase\(/g, '$1$2ctRow(');
assert.equal(hash(restored), 'b669f40b7239a8762873913e8340c9f3c060cea3e7e079d9f857d5ca3d090fd0', 'all old generated source bytes unchanged except row reads');
assert.equal(hash(contactKernelWGSL), 'abfd4f7a54ec391855d0591d6cebcf06dc30c20414b964fb76734d121acbb55e', 'generated artifact unchanged');
console.log('Source equivalence: preserved full-row ABI, 12 local snapshots / 43 distinct fields; only row-read lowering');

// Parse the exact emitted safe-base/mask expression and execute that small
// integer body. Each getter must have one branch-free, mask-before-bitcast load.
const baseSource = helperBlock.match(/fn ctRowBase\(id:i32\)->vec2u \{\n let valid=id>=0 && id<(\d+);\n let safeID=select\(0u,u32\(id\),valid\);\n return vec2u\((\d+)u\+safeID\*(\d+)u,select\(0u,0xffffffffu,valid\)\);\n\}/);
assert(baseSource, 'signed validity must select a safe ID before base arithmetic');
const [, count, offset, stride] = baseSource.map(Number);
assert.deepEqual([count, offset, stride], [91, layout.rowOffset / 4, layout.rowStride / 4]);
const baseBody = baseSource[0].slice(baseSource[0].indexOf('{') + 1, -1)
  .replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1');
const base = new Function('select', 'u32', 'vec2u', `return function(id) {${baseBody}}`)(
  (a, b, c) => c ? b : a, x => x >>> 0, (x, y) => ({ x, y }));
let reads = 0;
const getters = new Map();
for (const [field, type] of CONTACT_ROW_SCHEMA) {
  const declaration = helperBlock.match(new RegExp(`fn ctRow_${field}\\(base:vec2u\\)->(i32|f32) \\{\\n return bitcast<(i32|f32)>\\(EV\\[base\\.x\\+(\\d+)u\\]\\.([xyzw]) & base\\.y\\);\\n\\}`));
  assert(declaration, `${field}: only a branch-free raw masked load`);
  assert.equal(declaration[1], type); assert.equal(declaration[2], type);
  assert(!/\b(?:if|switch)\b/.test(declaration[0]));
  assert.equal((declaration[0].match(/\breturn\b/g) || []).length, 1);
  const i = CONTACT_ROW_SCHEMA.findIndex(([key]) => key === field);
  assert.equal(Number(declaration[3]), Math.floor(i / 4));
  assert.equal(declaration[4], 'xyzw'[i % 4]);
  getters.set(field, (rowBase, data = words) => {
    const at = (rowBase.x + Number(declaration[3])) * 4 + 'xyzw'.indexOf(declaration[4]);
    assert(Number.isInteger(at) && at >= layout.rowOffset && at < layout.rxOffset,
      `${field}: every load must address a real contact row, even for invalid IDs`);
    assert(at < data.length, `${field}: EV index in bounds`);
    reads++;
    return (data[at] & rowBase.y) >>> 0;
  });
}
assert.equal((helperBlock.match(/fn ctRow_/g) || []).length, 37);
const float = new Float32Array(1), floatBits = new Uint32Array(float.buffer);
for (const [id, row] of C.CONTACT_ROWS.entries()) {
  for (const [i, [field, type]] of CONTACT_ROW_SCHEMA.entries()) {
    const at = layout.rowOffset + id * layout.rowStride + i;
    const bits = getters.get(field)(base(id));
    assert.equal(bits, words[at], `${id}.${field}: exact raw EV word`);
    if (type === 'i32') {
      assert.equal(bits | 0, row[field]); assert.equal(bits | 0, signed[at]);
    } else {
      float[0] = row[field]; assert.equal(bits, floatBits[0], `${id}.${field}: original f32 bits`);
      floatBits[0] = bits; assert.equal(float[0], Math.fround(row[field]));
    }
  }
}
const beforeInvalid = reads;
const invalidIDs = [-2147483648, -123456789, -1, 91, 92, 2147483647];
for (const id of invalidIDs) {
  assert.deepEqual(base(id), { x: offset, y: 0 }, 'invalid IDs select the safe AIR row and zero mask');
  for (const [field, type] of CONTACT_ROW_SCHEMA) {
    const bits = getters.get(field)(base(id));
    assert.equal(bits, 0, `${id}.${field}: exact default zero word`);
    floatBits[0] = bits;
    assert(Object.is(type === 'i32' ? bits | 0 : float[0], 0), 'typed default is positive zero');
  }
}
assert.equal(reads - beforeInvalid, invalidIDs.length * 37, 'invalid IDs perform only safe masked reads');
// Synthetic raw EV words ensure no integer->float->integer roundtrip sneaks in,
// including int extremes, negative zero and NaN payload bits on f32 channels.
const synthetic = new Uint32Array(words);
for (const bits of [0, 0x80000000, 0x7fffffff, 0xffffffff, 0x7fc12345, 0xffc54321, 0x3eaaaaab]) {
  for (let id = 0; id < count; id++) for (let i = 0; i < 37; i++) synthetic[layout.rowOffset + id * layout.rowStride + i] = bits;
  for (let id = 0; id < count; id++) for (const getter of getters.values()) assert.equal(getter(base(id), synthetic), bits);
  for (const id of invalidIDs) for (const getter of getters.values()) assert.equal(getter(base(id), synthetic), 0,
    'invalid raw words, including NaNs/-0, are masked to zero before bitcast');
}
for (let id = 0; id < count; id++) assert.deepEqual(base(id), { x: offset + id * stride, y: 0xffffffff });
console.log('EV getters: 37 branch-free masked loads; all 91 x 37 fields, signed invalid/extreme IDs, safe indices, raw i32/f32 and synthetic NaN/-0 bits exact');

// Real phase conversion changes c.id. A delayed query would read STEAM's gas
// kind, whereas the row captured before ctPhase must still describe WATER.
const q = T => Math.round((T + 273.25) * 4);
const water = C.ctNew(E.WATER, q(100), 65536), row = C.ctRow(water.id);
const threshold = BigInt(C.ctCapacity(water)) * BigInt(row.hotQ) + C.ctOffset(water) + BigInt(row.hotL) * BigInt(C.ctAmount(water));
const input = C.ctSetEnergy(water, threshold), snapshot = base(input.id);
const product = C.ctPhase(input, 1, 0);
assert.equal(product.id, E.STEAM);
assert.equal(getters.get('kind')(snapshot), C.ctRow(E.WATER).kind);
assert.notEqual(getters.get('kind')(snapshot), getters.get('kind')(base(product.id)), 'phase-change counterexample to re-querying c.id');
const stepStart = contactWGSL.indexOf('fn ctStepAtmosphere(');
const step = contactWGSL.slice(stepStart, contactWGSL.indexOf('\nfn ', stepStart + 1));
assert(step.indexOf('var ctRowBase_r = ctRowBase(c.id);') < step.indexOf('c = ctElectric('));
assert(step.indexOf('var ctRowBase_r = ctRowBase(c.id);') < step.indexOf('c = ctPhase('));
assert(step.includes('ctRow_kind(ctRowBase_r)'));
assert(!/ctRow_(?:kind|burn|igniteQ)\(ctRowBase\(c.id\)\)/.test(step), 'local row reads never re-query a changed ID');
console.log('Snapshot: original row base precedes ctElectric/ctPhase; actual WATER->STEAM counterexample rejects delayed ID queries');

// Actual tick-48 block history: the upper SMOKE dies during self then the WOOD
// plume recreates SMOKE. Final pack must compare to the ORIGINAL core, retaining
// opaque word2. Intermediate pack/reload would destroy 0x12340000.
const cells = Array.from({ length: 8 }, () => C.ctNew(E.EMPTY, q(500), 65536));
cells[0] = C.ctNew(E.WOOD, q(500), 65536); cells[0].burning = 1; cells[0].life = 2048;
cells[2] = C.ctNew(E.SMOKE, q(500), 65536); cells[2].life = 6;
const cores = cells.map(c => C.packContact(c).core); cores[2][2] = 0x12340000;
const original = new Uint32Array(cores[2]);
const dead = C.ctStep(C.unpackContact(original), [cells[0], cells[3], cells[6]], 0);
assert.equal(dead.id, E.EMPTY);
const seed = (Math.imul(48, 2654435761) ^ 2) | 0;
const plume = C.ctPlume(cells[0], dead, seed, 1);
assert.equal(plume.b.id, E.SMOKE);
assert.equal(C.packContact(plume.b, original).core[2], 0x12340000);
assert.equal(C.packContact(plume.b, C.packContact(dead, original).core).core[2], 0, 'staged packing is observably wrong');
const out = C.contactReference(cores, new Int32Array(8), 48);
assert.equal(out.cores[2][0] & 255, E.SMOKE); assert.equal(out.cores[2][2], 0x12340000);
console.log('Tick 48: actual SMOKE->EMPTY->SMOKE retains opaque 0x12340000; intermediate pack/reload counterexample differs');

// Fail-closed restricted shapes and scope checks, not a general compiler.
const lower = body => lowerContactRowReads(abi + '\nfn probe(c:CTCell)->i32 {' + body + '}');
assert(lower('let row=ctRow(c.id);return row.kind;').includes('let ctRowBase_row=ctRowBase(c.id);return ctRow_kind(ctRowBase_row);'));
assert(lower('return ctRow(ctNuclearId(c)).emitter;').includes('ctRow_emitter(ctRowBase(ctNuclearId(c)))'));
for (const body of [
  'let row=ctRow(c.id);return row;',
  'return ctRow(c.id);',
  'let row=ctRow(c.id);return row.unknown;',
  'let row=ctRow(c.id);{let row=ctRow(c.id);}return row.kind;',
  'let row=ctRow(c.id);{let row=3;}return row.kind;',
  'let ctRowBase_row=0u;let row=ctRow(c.id);return row.kind;',
  '{let row=ctRow(c.id);}return row.kind;',
  'let row=ctRow(c.id);row=ctRow(c.id);return row.kind;',
  'let row=ctRow(c.id);row.kind=2;return row.kind;',
  'let row=ctRow(c.id);row.kind+=2;return row.kind;',
  'let row=ctRow(c.id);row.kind++;return row.kind;',
  'let row=ctRow(c.id);++row.kind;return row.kind;',
  'let row=ctRow(c.id);return &row.kind;',
  'ctRow(c.id).kind=2;return 0;',
  'for(let row=ctRow(c.id);true;){return row.kind;}',
  'let row=ctRow(c.id);{var<function> row:i32;}return row.kind;',
  'return ctRow(c.id+1).kind;',
  'var row:CTRow;return 0;',
]) assert.throws(() => lower(body), /contact row view:/, body);
assert.throws(() => lowerContactRowReads(abi + '\nfn probe(row:i32,c:CTCell)->i32{let row=ctRow(c.id);return row.kind;}'), /shadowed row/);
console.log('Restricted lowering: escapes, unknown fields/ID shapes, mutation, shadows, base collisions and out-of-scope uses rejected');

const dir = mkdtempSync(join(tmpdir(), 'contact-row-view-'));
try {
  const path = join(dir, 'contact.wgsl'); writeFileSync(path, contactPrelude + contactWGSL + contactEntry);
  const naga = spawnSync('naga', [path], { encoding: 'utf8' });
  if (naga.error) throw naga.error;
  assert.equal(naga.status, 0, naga.stderr);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('Scalar contact WGSL: CPU Naga valid; no GPU launched');
