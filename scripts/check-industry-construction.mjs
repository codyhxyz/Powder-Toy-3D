// CPU-only; no browser or GPU. Run: node scripts/check-industry-construction.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deviceSpec, validateDevices, overlaps, overlapsBody, deviceHeight } from '../src/industry/validation.js';
import { DEVICE_TYPES, QUARRY_STARTERS, baseMaterial, deviceCell, deviceDirection } from '../src/industry/catalog.js';
import { E } from '../src/elements.js';
import { constructionWGSL, WGSL_CHECK } from '../src/industry/construction.js';
import { registerSaveSection, unregisterSaveSection, collectSections, applySections, validateSections } from '../src/saves/sections.js';

const dims = [128,128,128];
const base = { id:'test', type:'belt', x:4, y:8, z:4, rotation:0 };
assert.equal(deviceSpec(base,dims).filter,E.NUGGETS);
assert.equal(deviceSpec(base,dims).powered,false);
assert.equal(validateDevices(QUARRY_STARTERS,dims).length,4);
for (const type of Object.keys(DEVICE_TYPES)) assert.equal(deviceSpec({...base,type},dims).type,type);
for (const bad of [null, {}, {...base,type:'__proto__'}, {...base,type:'fake'}, {...base,x:NaN}, {...base,x:1.5}, {...base,x:-1}, {...base,x:125}, {...base,y:125}, {...base,rotation:4}, {...base,filter:E.WATER}, {...base,powered:1}]) {
  assert.throws(() => deviceSpec(bad,dims));
}
assert.throws(() => validateDevices([{...base,id:'../x'}],dims));
assert.throws(() => validateDevices([base,base],dims));
assert.throws(() => validateDevices([base,{...base,id:'other',x:5}],dims));
assert.throws(() => validateDevices(Array.from({length:129},(_,i) => ({...base,id:`x${i}`})),dims));
const many = Array.from({length:128},(_,i) => ({...base,id:`x${i}`,x:(i%16)*4,z:Math.floor(i/16)*4}));
assert.equal(validateDevices(many,dims).length,128);
assert(!overlaps(base,{...base,x:8}));
assert(overlaps(base,{...base,x:7}));
assert(overlapsBody(base,{x:6,y:9,z:6}));
assert(!overlapsBody(base,{x:30,y:9,z:6}));
assert.equal(deviceHeight({type:'pump'}),7);
assert.throws(() => deviceSpec({...base,type:'pump',y:122},dims));
assert(overlaps({...base,type:'pump'},{...base,y:14}));
assert.equal(baseMaterial('heater'),E.TUNGSTEN);
assert.equal(baseMaterial('belt'),E.INSULATOR);
assert.deepEqual(Object.keys(DEVICE_TYPES).sort(), ['belt','foundation','gate','hearth','heater','lift','miner','pump','separator','ship']);
assert.equal(baseMaterial('hearth'), E.TUNGSTEN);
const gate = deviceSpec({...base, type:'gate'},dims);
assert.equal(gate.gateMode, 'open');
assert.equal(gate.gateClosed, false);
assert.equal(deviceSpec({...base, type:'gate', gateMode:'signal', gateClosed:true},dims).gateClosed, true);
for (const value of [{gateMode:'toggle'}, {gateClosed:1}, {gateMode:null}]) {
  assert.throws(() => deviceSpec({...base, type:'gate', ...value},dims), /gate state/);
}
assert.equal(DEVICE_TYPES.foundation.cost,1);
assert.equal(baseMaterial('foundation'),E.TUNGSTEN);
assert.equal(deviceHeight({type:'foundation'}),1);
assert.equal(deviceSpec({...base,type:'foundation',y:127},dims).y,127);
const foundation = {...base,type:'foundation'};
assert(!overlaps(foundation,{...base,y:9}), 'machines can sit immediately on foundations');
assert.equal(validateDevices([foundation,{...foundation,id:'stacked',y:9}],dims).length,2);
for(let rotation=0; rotation<4; rotation++) {
  const d={...base,rotation}, a=deviceCell(d,1,1,1), b=deviceCell(d,1,1,2);
  assert.deepEqual(b.map((v,i)=>v-a[i]),deviceDirection(d));
}
const code=constructionWGSL({nx:128,ny:128,nz:128});
assert(code.includes('@workgroup_size(1)'));
assert(code.includes('clear && P.mode == 1u'));
assert(code.includes('P.mode == 2u && eid(a) != P.material'));
assert(code.includes('hearthStructureCell(x, y, z)'));
assert(code.includes('rotateLocal(x, z)'));
assert.equal(WGSL_CHECK[0].name,'industryConstruction');
const nagaDir=mkdtempSync(join(tmpdir(),'industry-construction-wgsl-'));
try {
  const shader=join(nagaDir,'industry-construction.wgsl');
  writeFileSync(shader,WGSL_CHECK[0].code({nx:128,ny:128,nz:128}));
  const naga=spawnSync('naga',[shader],{encoding:'utf8'});
  if(naga.error?.code==='ENOENT') throw new Error('Install naga-cli for CPU-only construction WGSL validation; no browser fallback.');
  assert.equal(naga.status,0,`Naga must accept the actual exported construction kernel:\n${naga.stdout}\n${naga.stderr}`);
} finally { rmSync(nagaDir,{recursive:true,force:true}); }

let loaded=0, absent=0, validated=0;
registerSaveSection('test-legacy',{save:()=>({old:true}),load:()=>loaded++,absent:()=>absent++});
registerSaveSection('test-critical',{strict:true,save:()=>({version:1}),load:()=>loaded++,absent:()=>absent++,validate:(d)=>{validated++; if(d && d.version!==1) throw Error('invalid version');}});
try {
  const saved=await collectSections(); assert.equal(saved.length,2);
  await validateSections(new Map(saved.map(s=>[s.key,s.data])),{});
  await applySections(new Map(saved.map(s=>[s.key,s.data])),{});
  assert.equal(loaded,2); assert.equal(validated,1);
  await validateSections(new Map(),{}); // old saves without Industry remain valid
  await applySections(new Map(),{}); assert.equal(absent,2);
  await assert.rejects(validateSections(new Map([['test-critical',{version:99}]]),{}),/invalid version/);
  assert.equal(loaded,2,'preflight must not load any section');
  registerSaveSection('test-critical',{strict:true,save:()=>{throw Error('pending transfer');},load:()=>{throw Error('load failed');}});
  await assert.rejects(collectSections(),/pending transfer/);
  await assert.rejects(applySections(new Map([['test-critical',{}]]),{}),/load failed/);
} finally { unregisterSaveSection('test-legacy'); unregisterSaveSection('test-critical'); }
console.log('Industry construction CPU checks passed: bounds, occupancy, body, rotations, 128 cap, atomic shader structure, strict saves and legacy absence.');
