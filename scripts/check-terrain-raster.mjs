import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { E } from '../src/elements.js';
import { Appearance, materialWord } from '../src/appearance.js';
import { createTerrainScene } from '../src/world/scenes/descent/terrainScenes.js';
import { createFold } from '../src/world/scenes/descent/terrainFold.js';
import { prepareTerrainWords, validateTerrainManifest, terrainLayout, PALETTE_WORDS } from '../src/world/scenes/descent/terrainRaster.js';

const inflation = {maxHalfDepth:64,backdropMargin:4,backdropBlock:8,backdropWindow:9};
const foldConfig = {sourceMinX:-4608,sourceWidth:9216,cellScale:1,angleStart:-Math.PI/2,angleSpan:Math.PI*1.5,thickness:2*(64+4),shellThickness:2,margin:32};
const layoutOf = () => terrainLayout({fold:foldConfig,inflation});
const L = layoutOf();
// v2 payload: native plane, inflation depth plane (half cells, 0 = closed), backdrop blocks.
const bytes = new Uint8Array(L.words*4), words = new Uint32Array(bytes.buffer);
for (let y=0;y<320;y++) for (let x=0;x<9216;x++) {
  const i = x+9216*y, rock = x%31===0 && y%7===0;
  bytes[i] = rock ? 1 : 0;
  bytes[L.depthAt+i] = rock ? 0 : 1+((x*7+y*3)%128);
}
for (let b=0;b<L.blocks;b++) bytes[L.backdropAt+b] = 1+(b%2);
bytes[0]=255; bytes[L.depthAt]=0;
const hash = (a) => createHash('sha256').update(a).digest('hex');
const region = {key:'fixture',label:'Snowy Depths',sourceTop:992,sourceHeight:320,core:[1024,1280],sectionIndex:0,file:'fixture.binpack',
  sha256:hash(bytes.subarray(0,L.pixels)),fieldsSha256:hash(bytes.subarray(L.pixels,L.bytes)),spawnSource:[-677,1200,0]};
const route = {version:2,encoding:'noita-folded-raster-u8-v2',fold:foldConfig,inflation,
  palette:[{name:'air',element:E.EMPTY},{name:'rock_static',element:E.ROCK},{name:'templebrick_static',element:E.NOITA_TEMPLE,appearance:Appearance.VARIANT_1}],
  regions:[region],sections:[],startScene:'fixture',startSource:region.spawnSource,nativePortals:[]};
validateTerrainManifest(route);
assert.throws(()=>validateTerrainManifest({...route,palette:[...route.palette,{name:'unknown'}]}),/Unmapped/);
assert.throws(()=>validateTerrainManifest({...route,palette:[...route.palette,{name:'rock_static',element:E.ROCK}]}),/Unmapped/);
assert.throws(()=>validateTerrainManifest({...route,palette:[...route.palette,{name:'not_air',element:E.EMPTY}]}),/Unmapped/);
assert.throws(()=>validateTerrainManifest({...route,version:1,encoding:'noita-folded-raster-u8-v1'}),/Unsupported/);
assert.throws(()=>validateTerrainManifest({...route,palette:[...route.palette,{name:'water',element:E.WATER,appearance:Appearance.VARIANT_1}]}),/not valid/,'a label its element cannot carry');
assert.throws(()=>validateTerrainManifest({...route,fold:{...foldConfig,thickness:48}}),/thickness/,'the slab must hold the deepest envelope');
let fetches=0;
const scene=createTerrainScene(route,region,{fetchWords:async()=>{fetches++;return words;}});
await Promise.all([scene.prepare(),scene.prepare()]);
await scene.prepare();
assert.equal(fetches,1);
assert.equal(scene.airT,-12);
const packed=scene.data().words;
assert.equal(packed[1],E.ROCK);
assert.equal(packed[2],materialWord(E.NOITA_TEMPLE,Appearance.VARIANT_1),'a palette word carries its appearance label');
assert.deepEqual(packed.slice(PALETTE_WORDS),words);
const fold=createFold(foldConfig);
// Exact packed-word/byte operations used by terrainId in WGSL.
const shaderByte=(offset)=>(packed[PALETTE_WORDS+(offset>>>2)]>>>((offset&3)*8))&255;
const layers={solid:0,open:0,backdrop:0};
for (let k=0;k<1000;k++) {
  const source=[-4500+(k*137)%9000,1000+(k*17)%300,((k*37)%150)-75+.25];
  const world=fold.forward(source,992,320).map(Math.floor);
  const query=scene.querySource(world.map(v=>v+.5));
  assert.equal(scene.cell(...world),query.element);
  if (query.kind!=='source') { assert.ok(Math.abs(source[2])>=foldConfig.thickness/2-1,'only past the slab is cap/outside'); continue; }
  const [sx,sy]=query.source.map(Math.floor), depth=query.source[2], x=sx+4608, y=sy-992, index=x+9216*y;
  const native=bytes[index], open=bytes[L.depthAt+index];
  assert.equal(query.nativeIndex,native);
  const expected=open===0||2*Math.abs(depth)<open ? native : bytes[L.backdropAt+Math.floor(x/8)+1152*Math.floor(y/8)];
  assert.equal(query.materialIndex,expected);
  assert.equal(query.element,route.palette[expected].element);
  layers[query.layer]++;
  const shaderOpen=shaderByte(L.depthAt+index);
  const shaderMaterial=shaderOpen===0||2*Math.abs(depth)<shaderOpen ? shaderByte(index) : shaderByte(L.backdropAt+(x>>>3)+L.blockWidth*(y>>>3));
  assert.equal(packed[shaderMaterial],materialWord(query.element,query.appearance));
}
assert.ok(layers.solid>0 && layers.open>100 && layers.backdrop>100,`all three layers sampled: ${JSON.stringify(layers)}`);
// Depth 0 is the native raster, everywhere: an open pixel's envelope is at least half a cell.
for (let k=0;k<2000;k++) {
  const sx=-4600+(k*53)%9200, sy=992+(k*29)%320;
  const q=scene.querySource(fold.forward([sx+.5,sy+.5,0],992,320));
  if (q.kind==='source') assert.equal(q.materialIndex,q.nativeIndex);
}
assert.equal(scene.querySource(fold.forward([-677,1200,67.5],992,320)).kind,'source');
assert.equal(scene.querySource(fold.forward([-677,1200,69],992,320)).element,E.WALL);
assert.equal(scene.querySource(fold.forward([-677,1200,80],992,320)).element,E.EMPTY);
assert.equal(scene.querySource(fold.forward([-4607.5,992.5,0],992,320)).element,E.WALL);
scene.setArrival([100,100,200]); assert.deepEqual(scene.start(),[100,200]);
scene.setArrival(null); assert.deepEqual(scene.start(),[scene.toWorld(region.spawnSource)[0],scene.toWorld(region.spawnSource)[2]]);
assert.equal(hash(bytes.subarray(0,L.pixels)),region.sha256,'runtime does not mutate raster');
await assert.rejects(prepareTerrainWords(route,{...region,sha256:'0'.repeat(64)},words),/checksum/);
await assert.rejects(prepareTerrainWords(route,{...region,fieldsSha256:'0'.repeat(64)},words),/inflation checksum/);
await assert.rejects(prepareTerrainWords(route,region,words.subarray(1)),/Truncated/);
const rehash=(b)=>({...region,sha256:hash(b.subarray(0,L.pixels)),fieldsSha256:hash(b.subarray(L.pixels,L.bytes))});
const tamper=async(offset,value,pattern)=>{
  const b=bytes.slice(); b[offset]=value;
  await assert.rejects(prepareTerrainWords(route,rehash(b),new Uint32Array(b.buffer)),pattern);
};
await tamper(1,254,/Unknown native/);
await tamper(L.depthAt+1,0,/Invalid inflation depth/);          // an open pixel must be open at depth 0
await tamper(L.depthAt+31,5,/Invalid inflation depth/);         // a closed pixel never inflates
await tamper(L.depthAt+2,129,/Invalid inflation depth/);        // deeper than the slab holds
await tamper(L.backdropAt,0,/Invalid backdrop/);                // backdrop is solid rock, never air
const second=createTerrainScene(route,{...region,key:'second',sourceTop:1248,core:[1280,1536]},{fetchWords:async()=>words});
assert.equal(scene.glsl(),second.glsl(),'all bands use identical shader source');
if (process.argv.includes('--naga')) {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { gridLayout } = await import('../src/sim.js');
  const { sceneFillFrag, sceneDiffFrag } = await import('../src/shaders/generate.js');
  const dir = mkdtempSync(join(tmpdir(),'terrain-naga-'));
  try {
    const g = gridLayout(128,320,128);
    for (const [name,code] of [['fill',sceneFillFrag(g,scene.glsl())],['diff',sceneDiffFrag(g,scene.glsl())]]) {
      const file=join(dir,`${name}.wgsl`); writeFileSync(file,code);
      execFileSync('naga',[file,join(dir,`${name}.spv`)],{stdio:'inherit'});
    }
    console.log('Naga CPU: full 128x320x128 scene fill/diff shaders validated');
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
console.log(`Terrain raster v2: 1000 packed sampler parity fixtures (${layers.solid} solid, ${layers.open} open, ${layers.backdrop} backdrop), depth-0 identity, immutable native bytes, OUTSIDE/caps, lazy cache, both hashes, depth/backdrop/palette rejection and arrival centering passed`);
