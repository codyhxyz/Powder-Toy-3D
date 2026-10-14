// CPU-only table-generation regression. No browser, device or GPU.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONTACT_ROWS, CONTACT_REACTIONS } from '../../src/v2/contact.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { gridLayout } from '../../src/sim.js';

const block=contactWGSL.slice(contactWGSL.indexOf('fn contactBlock('));
assert(block.includes('let count=min(8u,arrayLength(&events));'));
assert.equal((block.match(/for\(var i=0u;i<count;i\+\+\)/g)||[]).length,6);
for(const dims of [[16,8,8],[32,32,32],[32,16,24],[128,128,128]]) {
  const g=gridLayout(...dims);
  assert.equal(Math.min(8,g.slots),8,'every native block still processes all eight cells');
}

// Independent ABI expectation: fields not listed here are f32, including cost
// and emitter. Field order must remain the canonical content constructor order.
const rowIntegers = new Set('kind capacity offset spawnQ spawnLife hotQ hotOut hotL hotGas hotOf coldQ coldOut coldL coldOf meltQ meltInto igniteQ flashQ burn heat flameQ ash blast blastAir acid edible fizz bed rots singFood conductor wire'.split(' '));
const declarations = [];
for (const [name, struct, rows, isInteger] of [
  ['ctRow', 'CTRow', CONTACT_ROWS, key => rowIntegers.has(key)],
  ['ctRx', 'CTRx', CONTACT_REACTIONS, key => key !== 'chance'],
]) {
  const fields = Object.keys(rows[0]);
  const schema = `struct ${struct} { ${fields.map(key => `${key}:${isInteger(key) ? 'i32' : 'f32'}`).join(',')} }`;
  assert.ok(contactWGSL.includes(schema), `${name}: exact ordered typed ABI`);
  const array = contactWGSL.match(new RegExp(`const ${name}Table:array<${struct},(\\d+)> = array<${struct},(\\d+)>\\(\\n([^]*?)\\n\\);`));
  assert.ok(array, `${name}: module-scope constant fixed-size array`);
  assert.equal(Number(array[1]), rows.length);
  assert.equal(array[1], array[2]);
  const constructors = array[3].split(',\n');
  assert.equal(constructors.length, rows.length, `${name}: no dropped or duplicate rows`);
  const parsed = constructors.map((constructor, index) => {
    const tokens = constructor.match(new RegExp(`^${struct}\\(([^()]*)\\)$`))[1].split(',');
    assert.equal(tokens.length, fields.length);
    for (const [i, key] of fields.entries()) {
      const value = rows[index][key];
      // Exact old switch literal spelling, not merely an approximate float.
      const literal = isInteger(key) || !Number.isInteger(value) ? `${value}` : `${value}.0`;
      assert.equal(tokens[i], literal, `${name}[${index}].${key}: exact constructor value`);
      if (isInteger(key)) {
        assert.ok(Number.isInteger(value) && value >= -2147483648 && value <= 2147483647);
        assert.equal(Number(tokens[i]), value);
      } else {
        assert.equal(Math.fround(Number(tokens[i])), Math.fround(value), `${name}[${index}].${key}: f32 value`);
      }
    }
    return tokens.map(Number);
  });
  const zeros = fields.map(key => isInteger(key) ? '0' : '0.0');
  const accessor = `fn ${name}(id:i32)->${struct} {\n if(id<0 || id>=${rows.length}){return ${struct}(${zeros.join(',')});}\n return ${name}Table[id];\n}`;
  assert.ok(contactWGSL.includes(accessor), `${name}: unchanged signed ABI, bounds before indexing, exact all-zero default`);
  assert.ok(!contactWGSL.includes(`fn ${name}(id:i32)->${struct} { switch`));
  // Model the asserted accessor, including both signed extremes and boundaries.
  const read = id => id < 0 || id >= rows.length ? zeros.map(Number) : parsed[id];
  for (const id of [-2147483648, -1, rows.length, rows.length + 1, 2147483647]) {
    assert.deepEqual(read(id), fields.map(() => 0), `${name}(${id}): all-zero default`);
  }
  for (let id = 0; id < rows.length; id++) assert.deepEqual(read(id), fields.map(key => rows[id][key]));
  declarations.push(schema, array[0], accessor);
  console.log(`${name}: ${rows.length} exact typed constructors; signed bounds/default and ABI preserved`);
}
assert.equal((contactWGSL.match(/var<storage/g) || []).length, 0, 'no new storage bindings');

// Force non-constant indices in a minimal Naga fixture as well as the integrated
// audits elsewhere. This validates const-array indexing, not GPU execution.
const dir = mkdtempSync(join(tmpdir(), 'contact-table-'));
try {
  const file = join(dir, 'tables.wgsl');
  writeFileSync(file, declarations.join('\n') + `
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid:vec3u) {
 let row=ctRow(i32(gid.x));let rx=ctRx(i32(gid.y));
}
`);
  const naga = spawnSync('naga', [file], { encoding: 'utf8' });
  if (naga.error) throw naga.error;
  assert.equal(naga.status, 0, naga.stderr);
  console.log('Dynamic const-array indexing: CPU Naga valid; no GPU');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
