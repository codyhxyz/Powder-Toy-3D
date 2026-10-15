import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { E } from '../src/elements.js';
import { createTerrainScene } from '../src/world/scenes/descent/terrainScenes.js';
import { createFold } from '../src/world/scenes/descent/terrainFold.js';
import { prepareTerrainWords, validateTerrainManifest, PALETTE_WORDS } from '../src/world/scenes/descent/terrainRaster.js';

const foldConfig = {sourceMinX:-4608,sourceWidth:9216,cellScale:1,angleStart:-Math.PI/2,angleSpan:Math.PI*1.5,thickness:48,shellThickness:2,margin:32};
const bytes = new Uint8Array(9216*320), words = new Uint32Array(bytes.buffer);
for (let y=0;y<320;y++) for (let x=0;x<9216;x++) bytes[x+9216*y] = (x%31===0 && y%7===0) ? 1 : 0;
bytes[0]=255;
const hash = () => createHash('sha256').update(bytes).digest('hex');
const region = {key:'fixture',label:'Snowy Depths',sourceTop:992,sourceHeight:320,core:[1024,1280],sectionIndex:0,file:'fixture.binpack',sha256:hash(),spawnSource:[-677,1200,0]};
const route = {version:1,encoding:'noita-folded-raster-u8-v1',fold:foldConfig,palette:[{name:'air',element:E.EMPTY},{name:'rock_static',element:E.ROCK}],regions:[region],sections:[],startScene:'fixture',startSource:region.spawnSource,nativePortals:[]};
validateTerrainManifest(route);
assert.throws(()=>validateTerrainManifest({...route,palette:[...route.palette,{name:'unknown'}]}),/Unmapped/);
let fetches=0;
const scene=createTerrainScene(route,region,{fetchWords:async()=>{fetches++;return words;}});
await Promise.all([scene.prepare(),scene.prepare()]);
await scene.prepare();
assert.equal(fetches,1);
assert.equal(scene.airT,-12);
const packed=scene.data().words;
assert.equal(packed[1],E.ROCK);
assert.deepEqual(packed.slice(PALETTE_WORDS),words);
const fold=createFold(foldConfig);
for (let k=0;k<1000;k++) {
  const source=[-4500+(k*137)%9000,1000+(k*17)%300,(k%40)-20];
  const world=fold.forward(source,992,320).map(Math.floor);
  const query=scene.querySource(world.map(v=>v+.5));
  assert.equal(scene.cell(...world),query.element);
  if (query.kind!=='source') continue;
  const [sx,sy]=query.source.map(Math.floor), native=bytes[sx+4608+9216*(sy-992)];
  assert.equal(query.nativeIndex,native);
  assert.equal(query.element,route.palette[native].element);
  const index=sx+4608+9216*(sy-992);
  // Exact packed-word/byte operations used by terrainId in WGSL.
  const shaderNative=(packed[256+(index>>>2)]>>>((index&3)*8))&255;
  assert.equal(packed[shaderNative],query.element);
}
const cap=fold.forward([-677,1200,25],992,320);
assert.equal(scene.querySource(cap).element,E.WALL);
assert.equal(scene.querySource(fold.forward([-677,1200,80],992,320)).element,E.EMPTY);
assert.equal(scene.querySource(fold.forward([-4607.5,992.5,0],992,320)).element,E.WALL);
scene.setArrival([100,100,200]); assert.deepEqual(scene.start(),[100,200]);
scene.setArrival(null); assert.deepEqual(scene.start(),[scene.toWorld(region.spawnSource)[0],scene.toWorld(region.spawnSource)[2]]);
assert.equal(hash(),region.sha256,'runtime does not mutate raster');
await assert.rejects(prepareTerrainWords(route,{...region,sha256:'0'.repeat(64)},words),/checksum/);
const altered = new Uint32Array(words); altered[0]=254;
await assert.rejects(prepareTerrainWords(route,{...region,sha256:createHash('sha256').update(new Uint8Array(altered.buffer)).digest('hex')},altered),/Unknown native/);
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
console.log('Terrain raster: 1000 packed sampler parity fixtures, immutable native bytes, OUTSIDE/caps, cold baseline, lazy cache, hashes, unknown palette rejection and arrival centering passed');
