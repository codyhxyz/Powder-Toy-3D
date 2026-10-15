// CPU-only table-memory/accessor regression. No browser, device or GPU.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONTACT_ROWS, CONTACT_REACTIONS } from '../../src/v2/contact.js';
import { CONTACT_ROW_SCHEMA, CONTACT_RX_SCHEMA, contactTableLayout, appendContactTable, CONTACT_ROW_UNIFORM } from '../../src/v2/contactTable.js';
import { contactWGSL, contactUniformWGSL } from '../../src/shaders/v2/contact.js';
import { v2Table, v2Rows, v2BlockWGSL, V2_CONTACT_LAYOUT, nativeDynamicsHead } from '../../src/shaders/v2.js';
import { gridLayout } from '../../src/sim.js';

const block=contactWGSL.slice(contactWGSL.indexOf('fn contactBlock('));
assert(block.includes('let count=min(8u,arrayLength(&events));'));
assert.equal((block.match(/for\(var i=0u;i<count;i\+\+\)/g)||[]).length,6);
assert.equal((block.match(/axis<u32\(ctNeighborCount\(\)\)/g)||[]).length,3);
assert.equal((contactWGSL.match(/k < ctNeighborCount\(\);/g)||[]).length,3);
for(const dims of [[16,8,8],[32,32,32],[32,16,24],[128,128,128]]) {
  const g=gridLayout(...dims);
  assert.equal(Math.min(8,g.slots),8,'every native block still processes all eight cells');
  assert.equal(Math.min(3,g.slots),3,'every native cell still visits all three neighbors');
}
assert.equal(CONTACT_ROWS.length,91);
assert.equal(CONTACT_REACTIONS.length,14);
const layout=contactTableLayout(CONTACT_ROWS.length,CONTACT_REACTIONS.length);
// Independent prefix and stride expectations: all original EV offsets persist.
const prefix=new Float32Array(CONTACT_ROWS.length*8);
v2Rows().forEach((r,i)=>prefix.set([r.cls,r.drop,r.vt,r.dens,r.yieldHead,r.damp,r.fade,0],i*8));
const memory=v2Table(), bits=new Uint32Array(memory.buffer), signed=new Int32Array(memory.buffer);
assert.equal(layout.rowOffset,prefix.length);
assert.equal(layout.rowStride,40);
assert.equal(layout.rxOffset,prefix.length+91*40);
assert.equal(layout.rxStride,12);
assert.equal(memory.length,prefix.length+91*40+14*12);
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
const rowIntegers=new Set('kind capacity offset spawnQ spawnLife hotQ hotOut hotL hotGas hotOf coldQ coldOut coldL coldOf meltQ meltInto igniteQ flashQ burn heat flameQ ash blast blastAir acid edible fizz bed rots singFood conductor wire'.split(' '));
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
assert.equal((entry.match(/i\s*<\s*blockCount/g)||[]).length,5);
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

// Parse and execute the ACTUAL emitted accessors independently of the emitter.
// Keep raw words alongside typed values: JS NaN conversions cannot stand in for
// the shader's payload-preserving bitcast, including negative zero.
const window = CONTACT_ROW_UNIFORM;
assert.equal(memory.byteLength,18144);
assert.equal(window.offset,2816); assert.equal(window.size,14656);
assert.equal(window.struct.align,16); assert.equal(window.struct.size,14656);
assert.deepEqual(window.struct.fields.map(f=>[f.name,f.type,f.offset,f.size]),[['words','array<vec4u, 916>',0,14656]]);
assert.equal(window.rowBase,6); assert.equal(window.rowStride,10);
assert.equal(window.offset+window.size,layout.rxOffset*4);
const uniformWords=new Uint32Array(memory.buffer,window.offset,window.size/4);
assert.deepEqual(uniformWords.slice(24),bits.slice(layout.rowOffset,layout.rxOffset),'exact existing row/window bytes');
function parseAccessor(source,resource) {
  const match=source.match(/fn ctRow\(id:i32\)->CTRow \{\n if\(id<0 \|\| id>=(\d+)\)\{return CTRow\(([^]*?)\);\}\n let base=(\d+)u\+u32\(id\)\*(\d+)u;\n return CTRow\(([^]*?)\);\n\}/);
  assert(match,'actual signed accessor shape');
  const [,count,zero,base,stride,expression]=match;
  const struct=source.match(/struct CTRow \{ ([^}]+) \}/)[1].split(',').map(s=>s.split(':'));
  const loads=expression.split(',').map(s=>{
    const m=s.match(/^bitcast<(i32|f32)>\(([^[]+)\[base\+(\d+)u\]\.([xyzw])\)$/);
    assert(m,s); assert.equal(m[2],resource); return {type:m[1],word:4*Number(m[3])+'xyzw'.indexOf(m[4])};
  });
  assert.deepEqual(struct,CONTACT_ROW_SCHEMA);
  assert.equal(loads.length,struct.length);
  const zeros=zero.split(',');
  loads.forEach((load,i)=>{assert.equal(load.type,struct[i][1]);assert.equal(zeros[i],load.type==='i32'?'0':'0.0');});
  return {text:match[0],read(id,words) {
    return loads.map(load=>{
      const raw=id<0||id>=Number(count)?0:words[4*(Number(base)+id*Number(stride))+load.word];
      const view=new DataView(new Uint32Array([raw]).buffer);
      return {raw,value:load.type==='i32'?view.getInt32(0,true):view.getFloat32(0,true),type:load.type};
    });
  }};
}
const storageAccessor=parseAccessor(contactWGSL,'EV'),uniformAccessor=parseAccessor(contactUniformWGSL,'CTU.words');
const prefixUniform=window.struct.wgsl+'@group(1) @binding(0) var<uniform> CTU: ContactRowUniform;\n';
assert.equal(contactUniformWGSL.slice(prefixUniform.length).replace(uniformAccessor.text,storageAccessor.text),contactWGSL,'every non-accessor rule/snapshot byte identical');
const ids=[-2147483648,-1,...Array.from({length:256},(_,id)=>id),2147483647];
function compareAccessors(words) {
  const view=words.subarray(window.offset/4,(window.offset+window.size)/4);
  for(const id of ids) {
    const storage=storageAccessor.read(id,words),uniform=uniformAccessor.read(id,view);
    assert.deepEqual(uniform,storage,`actual accessor execution id ${id}`);
    storage.forEach((field,i)=>{
      const expected=id>=0&&id<91?words[layout.rowOffset+id*40+i]:0;
      assert.equal(field.raw,expected,`raw field ${id}.${CONTACT_ROW_SCHEMA[i][0]}`);
      if(id<0||id>=91)assert(Object.is(field.value,0),'typed ZERO, never EMPTY metadata');
    });
  }
}
compareAccessors(bits);
for(const value of [-2147483648,-123456789,-1,0,2147483647]) {
  const rows=CONTACT_ROWS.map(row=>({...row,...Object.fromEntries(CONTACT_ROW_SCHEMA.map(([key,type])=>[key,type==='i32'?value:-0]))}));
  const words=new Uint32Array(appendContactTable(prefix,rows,CONTACT_REACTIONS).buffer);
  compareAccessors(words);
  for(let id=0;id<91;id++) CONTACT_ROW_SCHEMA.forEach(([,type],i)=>assert.equal(words[layout.rowOffset+id*40+i],type==='i32'?value>>>0:0x80000000));
}
// Adversarial raw payloads are read, not repacked through JS floats. Padding
// stays uninterpreted and present in the same buffer window.
for(const pattern of [0x80000000,0x7fc12345,0xff812345,0xffffffff,0x12345678]) {
  const words=bits.slice();
  words.fill(pattern,layout.rowOffset,layout.rxOffset); compareAccessors(words);
  const view=words.subarray(window.offset/4,(window.offset+window.size)/4);
  for(let id=0;id<91;id++)assert.deepEqual(view.slice(24+id*40,24+(id+1)*40),words.slice(layout.rowOffset+id*40,layout.rowOffset+(id+1)*40));
}
console.log('Actual storage/uniform accessors: all fields, IDs0..255, signed extremes, negative zero/raw payloads/padding; non-accessor bytes identical');

// Dynamic lookup fixture and actual full foundation/contact, compiled by CPU Naga.
const dir=mkdtempSync(join(tmpdir(),'contact-table-'));
try {
  for(const [name,source] of [
    ['tables',`@group(2) @binding(2) var<storage,read> EV:array<vec4u>;\n${declarations.join('\n')}\n@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid:vec3u) {let row=ctRow(i32(gid.x));let rx=ctRx(i32(gid.y));}`],
    ['foundation-contact',foundation],
  ]) {
    const file=join(dir,`${name}.wgsl`);writeFileSync(file,source);
    const naga=spawnSync('naga',[file],{encoding:'utf8'});
    if(naga.error) throw naga.error;
    assert.equal(naga.status,0,naga.stderr);
    console.log(`${name}: CPU Naga valid; no GPU`);
  }
} finally {rmSync(dir,{recursive:true,force:true});}
