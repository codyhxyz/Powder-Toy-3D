// CPU-only integration against compiler output; never edits source/assets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createTerrainScene } from '../src/world/scenes/descent/terrainScenes.js';
import { createFold } from '../src/world/scenes/descent/terrainFold.js';
import { E, ELEMENTS, K } from '../src/elements.js';
import { BODY_HEIGHT, BODY_WIDTH } from '../src/pov/constants.js';
import { bandHandoff, nativePortalHandoff } from '../src/pov/descent/terrainHandoff.js';
import { terrainLayout } from '../src/world/scenes/descent/terrainRaster.js';
const root=resolve(process.argv[2] ?? 'public/local-maps/noita-terrain');
const route=JSON.parse(readFileSync(resolve(root,'route.json'),'utf8'));
const fold=createFold(route.fold), L=terrainLayout(route), W=route.fold.sourceWidth;
const raster=async region=>new Uint8Array(await new Response(
  new Blob([readFileSync(resolve(root,region.file))]).stream().pipeThrough(new DecompressionStream('gzip'))
).arrayBuffer());
const levels=route.regions.map(r=>({key:r.key,sourceRegion:r,fold:route.fold,nativePortals:route.nativePortals}));
const start=route.regions.find(r=>r.key===route.startScene);
assert(start);
const wordsFrom=bytes=>{
  const words=new Uint32Array(bytes.length/4), view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let i=0;i<words.length;i++) words[i]=view.getUint32(i*4,true);
  return words;
};
const scene=createTerrainScene(route,start,{fetchWords:async()=>wordsFrom(await raster(start))});
await scene.prepare();
function bodyClear(scene,source,label) {
  const world=scene.toWorld(source), failures=[];
  for(let x=Math.floor(world[0]-BODY_WIDTH/2);x<Math.ceil(world[0]+BODY_WIDTH/2);x++)
  for(let y=Math.floor(world[1]);y<Math.ceil(world[1]+BODY_HEIGHT);y++)
  for(let z=Math.floor(world[2]-BODY_WIDTH/2);z<Math.ceil(world[2]+BODY_WIDTH/2);z++) {
    const kind=ELEMENTS[scene.cell(x,y,z)].kind;
    if(kind===K.SOLID || kind===K.POWDER) failures.push({world:[x,y,z],query:scene.querySource([x+.5,y+.5,z+.5])});
  }
  assert.deepEqual(failures,[],`${label}: full player body must be clear; never repair terrain to pass`);
  return world;
}
const world=bodyClear(scene,route.startSource,'native first arrival');
let supported=false;
for(let x=Math.floor(world[0]-BODY_WIDTH/2);x<Math.ceil(world[0]+BODY_WIDTH/2);x++)
for(let z=Math.floor(world[2]-BODY_WIDTH/2);z<Math.ceil(world[2]+BODY_WIDTH/2);z++) {
  const kind=ELEMENTS[scene.cell(x,Math.floor(world[1]-.01),z)].kind;
  supported ||= kind===K.SOLID || kind===K.POWDER;
}
// Native teleport arrival is intentionally airborne; never add support.
const arrivalSupported=supported;
let seams=0, previous=null, previousBytes=null;
const targets=new Set(route.nativePortals.filter(p=>p.enabled).map(p=>route.regions.find(r=>r.core[0]<=p.target[1] && p.target[1]<r.core[1])?.key));
const targetScenes=new Map();
for (const region of route.regions) {
  const bytes=await raster(region);
  assert.equal(bytes.length,L.bytes,`${region.key}: native, depth and backdrop planes`);
  assert.equal(createHash('sha256').update(bytes.subarray(0,L.pixels)).digest('hex'),region.sha256,`native raster hash ${region.key}`);
  assert.equal(createHash('sha256').update(bytes.subarray(L.pixels,L.bytes)).digest('hex'),region.fieldsSha256,`inflation hash ${region.key}`);
  for(const n of bytes.subarray(0,L.pixels)) if(n!==255 && n>=route.palette.length) assert.fail(`Unknown native palette index ${region.key}: ${n}`);
  if(region.spawnSupported || targets.has(region.key)) {
    const s=createTerrainScene(route,region,{fetchWords:async()=>wordsFrom(bytes)});
    await s.prepare();
    if(region.spawnSupported) bodyClear(s,region.spawnSource,`${region.key} debug start`);
    if(targets.has(region.key)) targetScenes.set(region.key,s);
  }
  if(previous && previous.core[1]===region.core[0]) {
    // Native, depth and backdrop planes all agree across the 64 shared context rows: no band seams.
    assert.deepEqual(previousBytes.subarray(256*W,320*W),bytes.subarray(0,64*W));
    assert.deepEqual(previousBytes.subarray(L.depthAt+256*W,L.depthAt+320*W),bytes.subarray(L.depthAt,L.depthAt+64*W));
    const rowBlocks=L.blockWidth, shared=64/L.block;
    assert.deepEqual(previousBytes.subarray(L.backdropAt+(40-shared)*rowBlocks,L.bytes),bytes.subarray(L.backdropAt,L.backdropAt+shared*rowBlocks));
    const source=[route.startSource[0],region.core[0]+.125,3.25];
    const a=levels.find(l=>l.key===previous.key), b=levels.find(l=>l.key===region.key);
    assert.equal(bandHandoff(levels,a,source).next,b);
    const worldA=fold.forward(source,previous.sourceTop,320), worldB=fold.forward(source,region.sourceTop,320);
    assert.equal(worldA[0],worldB[0]); assert.equal(worldA[2],worldB[2]);
    assert.deepEqual(fold.inverse(worldB,region.sourceTop,320).map(v=>Math.round(v*1e6)/1e6),source);
    assert.equal(bandHandoff(levels,b,[source[0],region.core[0]-.125,source[2]]).next,a);
    seams++;
  }
  previous=region;previousBytes=bytes;
}
let portals=0;
for(const p of route.nativePortals.filter(p=>p.enabled)) {
  const current=levels.find(l=>p.source[1]>=l.sourceRegion.core[0] && p.source[1]<l.sourceRegion.core[1]);
  assert(current,`portal ${p.id} needs an entry region`);
  const go=nativePortalHandoff(levels,current,[...p.source,2.5]);
  assert(go,`portal ${p.id} needs a destination region`);
  bodyClear(targetScenes.get(go.next.key),go.source,`native portal ${p.id} arrival`);
  assert.deepEqual(go.source,[...p.target,0]); portals++;
}
console.log(`Actual source: full-body start clear at ${route.startSource} (supported=${arrivalSupported}; native airborne arrival preserved); ${seams} byte-identical context seams, bidirectional same-XZ handoffs; ${portals} native portal endpoints passed; start element ${E.EMPTY}`);
