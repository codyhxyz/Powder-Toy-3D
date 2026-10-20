// CPU-only table-memory/accessor regression. No browser, device or GPU.
import assert from 'node:assert/strict';
import { CONTACT_ROWS, CONTACT_REACTIONS } from '../../src/v2/contact.js';
import { CONTACT_ROW_SCHEMA, CONTACT_RX_SCHEMA, contactTableLayout, appendContactTable } from '../../src/v2/contactTable.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { v2Table, v2Rows, v2BlockWGSL, V2_CONTACT_LAYOUT, nativeDynamicsHead } from '../../src/shaders/v2.js';
import { gridLayout } from '../../src/sim.js';
import { ELEMENTS } from '../../src/elements.js';
import { assertNaga } from './wgsl-grouping.mjs';

const block=contactWGSL.slice(contactWGSL.indexOf('fn contactBlock('));
assert(block.includes('let count=min(8u,arrayLength(&events));'));
assert.equal((block.match(/for\(var i=0u;i<count;i\+\+\)/g)||[]).length,5);
assert.equal((block.match(/axis<u32\(ctNeighborCount\(\)\)/g)||[]).length,2);
// (the atmosphere step's and the cloud's: electricity reads six faces in the electric pass)
assert.equal((contactWGSL.match(/k < ctNeighborCount\(\);/g)||[]).length,2);
for(const dims of [[16,8,8],[32,32,32],[32,16,24],[128,128,128]]) {
  const g=gridLayout(...dims);
  assert.equal(Math.min(8,g.slots),8,'every native block still processes all eight cells');
  assert.equal(Math.min(3,g.slots),3,'every native cell still visits all three neighbors');
}
assert.equal(CONTACT_ROWS.length,ELEMENTS.length,'every material has a contact row');
assert.equal(CONTACT_REACTIONS.length,14);
const layout=contactTableLayout(CONTACT_ROWS.length,CONTACT_REACTIONS.length);
// Independent prefix and stride expectations: all original EV offsets persist.
const prefix=new Float32Array(CONTACT_ROWS.length*8);
v2Rows().forEach((r,i)=>prefix.set([r.cls,r.drop,r.vt,r.dens,r.yieldHead,r.damp,r.fade,0],i*8));
const memory=v2Table(), bits=new Uint32Array(memory.buffer), signed=new Int32Array(memory.buffer);
assert.equal(layout.rowOffset,prefix.length);
assert.equal(layout.rowStride,44);   // + blastInto, blastOf, blastQ, blastPuff (V1 blast into matter)
assert.equal(layout.rxOffset,prefix.length+ELEMENTS.length*44);
assert.equal(layout.rxStride,12);
assert.equal(memory.length,prefix.length+ELEMENTS.length*44+14*12);
assert.deepEqual(bits.slice(0,prefix.length),new Uint32Array(prefix.buffer),'EV prefix raw bits unchanged');
assert.deepEqual(bits,new Uint32Array(appendContactTable(prefix,CONTACT_ROWS,CONTACT_REACTIONS).buffer));
assert.throws(()=>appendContactTable(prefix.subarray(1),CONTACT_ROWS,CONTACT_REACTIONS),/prefix length/);
// Int32 extremes and -1 must remain raw words, never float NaN roundtrips.
for(const value of [-2147483648,-123456789,-1,0,2147483647]) {
  const rows=CONTACT_ROWS.map(row=>({...row,offset:value,hotOut:value}));
  const words=new Uint32Array(appendContactTable(prefix,rows,CONTACT_REACTIONS).buffer);
  for(let id=0;id<rows.length;id++) {
    assert.equal(words[layout.rowOffset+id*layout.rowStride+2],value>>>0);
    assert.equal(words[layout.rowOffset+id*layout.rowStride+8],value>>>0);
  }
}

// Independent ABI expectation: cost/emitter are f32, not integer channels.
const rowIntegers=new Set('kind capacity offset spawnQ spawnLife hotQ hotOut hotL hotGas hotOf coldQ coldOut coldL coldOf meltQ meltInto igniteQ flashQ burn heat flameQ ash blast blastAir acid edible fizz bed rots singFood conductor wire blastInto blastOf blastQ blastPuff coldGas'.split(' '));
const scalar=new Float32Array(1), scalarBits=new Uint32Array(scalar.buffer);
const declarations=[];
for(const [name,struct,rows,schema,offset,stride,isInteger] of [
  ['ctRow','CTRow',CONTACT_ROWS,CONTACT_ROW_SCHEMA,layout.rowOffset,layout.rowStride,key=>rowIntegers.has(key)],
  ['ctRx','CTRx',CONTACT_REACTIONS,CONTACT_RX_SCHEMA,layout.rxOffset,layout.rxStride,key=>key!=='chance'],
]) {
  const fields=Object.keys(rows[0]);
  assert.deepEqual(schema,fields.map(key=>[key,isInteger(key)?'i32':'f32']),'canonical field order/types');
  const declaration=`struct ${struct} { ${fields.map(key=>`${key}:${isInteger(key)?'i32':'f32'}`).join(',')} }`;
  assert.ok(contactWGSL.includes(declaration),`${name}: exact ordered typed ABI`);
  const zeros=fields.map(key=>isInteger(key)?'0':'0.0');
  // Assert every accessor channel and bitcast independently of the generator.
  const loads=fields.map((key,i)=>{
    const load=`EV[base+${Math.floor(i/4)}u].${'xyzw'[i%4]}`;
    return `bitcast<${isInteger(key)?'i32':'f32'}>(${load})`;
  });
  const accessor=`fn ${name}(id:i32)->${struct} {\n if(id<0 || id>=${rows.length}){return ${struct}(${zeros.join(',')});}\n let base=${offset/4}u+u32(id)*${stride/4}u;\n return ${struct}(${loads.join(',')});\n}`;
  assert.ok(contactWGSL.includes(accessor),`${name}: signed guard before EV indexing; exact zero default/channel ABI`);
  assert.ok(!contactWGSL.includes(`${name}Table`),'no constant struct arrays');
  assert.ok(!contactWGSL.includes(`fn ${name}(id:i32)->${struct} { switch`),'no switch struct copies');
  // Model the asserted accessor over the actual packed bytes.
  const read=id=>id<0||id>=rows.length?fields.map(()=>0):fields.map((key,i)=>isInteger(key)?signed[offset+id*stride+i]:memory[offset+id*stride+i]);
  for(const id of [-2147483648,-1,rows.length,rows.length+1,2147483647]) {
    assert.deepEqual(read(id),fields.map(()=>0),`${name}(${id}): all-zero signed invalid default`);
  }
  for(const [id,row] of rows.entries()) {
    assert.deepEqual(Object.keys(row),fields);
    for(const [i,key] of fields.entries()) {
      const value=row[key],at=offset+id*stride+i;
      if(isInteger(key)) {
        assert.ok(Number.isInteger(value)&&value>=-2147483648&&value<=2147483647);
        assert.equal(bits[at],value>>>0,`${name}[${id}].${key}: raw i32 bits`);
        assert.equal(signed[at],value);
      } else {
        scalar[0]=value;
        assert.equal(bits[at],scalarBits[0],`${name}[${id}].${key}: exact f32 bits`);
        assert.equal(memory[at],Math.fround(value));
      }
    }
    for(let i=fields.length;i<stride;i++) assert.equal(bits[offset+id*stride+i],0,'vec4 padding');
    assert.deepEqual(read(id),fields.map(key=>isInteger(key)?row[key]:Math.fround(row[key])));
  }
  declarations.push(declaration,accessor);
  console.log(`${name}: ${rows.length} rows raw-bit/f32 exact; EV channel ABI, signed bounds/default and padding valid`);
}
assert.equal((contactWGSL.match(/var<storage/g)||[]).length,0,'no new storage bindings');
assert.deepEqual(V2_CONTACT_LAYOUT.map(b=>[b.binding,b.buffer.type]),[
  [0,'storage'],[1,'storage'],[2,'read-only-storage'],[4,'storage'],[5,'storage'],[6,'storage'],
],'contact reuses liquid scratch binding 5 for frozen outside atmosphere');
const foundation=v2BlockWGSL(gridLayout(32,32,32),contactWGSL);
const entry=foundation.slice(foundation.indexOf('@compute @workgroup_size(64)'));
assert(entry.includes('let blockCount=min(8u,arrayLength(&events));'));
assert(entry.includes('let columnCount=blockCount/2u;'));
// (+2: the decoration's read-all-then-write loops, v2BlockWGSL's P.deco carry)
assert.equal((entry.match(/i\s*<\s*blockCount/g)||[]).length,7);
assert.equal((entry.match(/m\s*<\s*blockCount/g)||[]).length,1);
assert.equal((entry.match(/c2?\s*<\s*columnCount/g)||[]).length,3);
assert(!/for[^{]*<\s*[48]u/.test(entry),'no fixed wrapper bounds expand thermal calls');
assert.equal((foundation.match(/var<storage,/g)||[]).length,7,'actual foundation+contact storage binding count');
assert.equal((foundation.match(/@group\(2\) @binding\(2\)/g)||[]).length,1,'EV binding reused exactly once');
assert.ok(foundation.includes('var<storage, read> EV: array<vec4u>;'),'raw-u32 EV prevents integer NaN canonicalization');
assert.ok(foundation.includes('fn e0(id: u32) -> vec4f { return bitcast<vec4f>(EV[2u * id]); }'));
assert.ok(foundation.includes('fn e1(id: u32) -> vec4f { return bitcast<vec4f>(EV[2u * id + 1u]); }'));
const dynamics=nativeDynamicsHead(gridLayout(32,32,32));
const baked=dynamics.match(/const EV = array<vec4u, (\d+)>\(([^]*?)\);/);
assert.ok(baked,'dynamics uses raw-u32 EV too');
assert.equal(Number(baked[1]),CONTACT_ROWS.length*2,'no contact tail baked into dynamics');
const bakedWords=[...baked[2].matchAll(/\b(\d+)u/g)].map(m=>Number(m[1]));
assert.deepEqual(bakedWords,Array.from(new Uint32Array(prefix.buffer)),'dynamics prefix bytes unchanged');

// Dynamic lookup fixture and actual full foundation/contact, compiled by CPU Naga.
for(const [name,source] of [
  ['tables',`@group(2) @binding(2) var<storage,read> EV:array<vec4u>;\n${declarations.join('\n')}\n@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid:vec3u) {let row=ctRow(i32(gid.x));let rx=ctRx(i32(gid.y));}`],
  ['foundation-contact',foundation],
]) {
  assertNaga(source,name);
  console.log(`${name}: CPU Naga valid; no GPU`);
}
