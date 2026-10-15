// CPU-only integration against compiler output; never edits source/assets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createTerrainScene } from '../src/world/scenes/descent/terrainScenes.js';
import { createFold } from '../src/world/scenes/descent/terrainFold.js';
import { E, ELEMENTS, K } from '../src/elements.js';
import { BODY_HEIGHT, BODY_WIDTH } from '../src/pov/constants.js';
import { bandHandoff, nativePortalHandoff } from '../src/pov/descent/terrainHandoff.js';
const root=resolve(process.argv[2] ?? 'public/local-maps/noita-terrain');
const route=JSON.parse(readFileSync(resolve(root,'route.json'),'utf8'));
const fold=createFold(route.fold), raster=(region)=>gunzipSync(readFileSync(resolve(root,region.file)));
const levels=route.regions.map(r=>({key:r.key,sourceRegion:r,fold:route.fold,nativePortals:route.nativePortals}));
const start=route.regions.find(r=>r.key===route.startScene);
assert(start);
const scene=createTerrainScene(route,start,{fetchWords:async()=>{
  const bytes=raster(start), words=new Uint32Array(bytes.length/4), view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let i=0;i<words.length;i++) words[i]=view.getUint32(i*4,true);
  return words;
}});
await scene.prepare();
const world=scene.toWorld(route.startSource), failures=[];
for(let x=Math.floor(world[0]-BODY_WIDTH/2);x<Math.ceil(world[0]+BODY_WIDTH/2);x++)
for(let y=Math.floor(world[1]);y<Math.ceil(world[1]+BODY_HEIGHT);y++)
for(let z=Math.floor(world[2]-BODY_WIDTH/2);z<Math.ceil(world[2]+BODY_WIDTH/2);z++) {
  const element=scene.cell(x,y,z), kind=ELEMENTS[element].kind;
  if(kind===K.SOLID || kind===K.POWDER) failures.push({world:[x,y,z],query:scene.querySource([x+.5,y+.5,z+.5])});
}
assert.deepEqual(failures,[],'full player body must be clear; do not repair terrain to pass');
let supported=false;
for(let x=Math.floor(world[0]-BODY_WIDTH/2);x<Math.ceil(world[0]+BODY_WIDTH/2);x++)
for(let z=Math.floor(world[2]-BODY_WIDTH/2);z<Math.ceil(world[2]+BODY_WIDTH/2);z++) {
  const kind=ELEMENTS[scene.cell(x,Math.floor(world[1]-.01),z)].kind;
  supported ||= kind===K.SOLID || kind===K.POWDER;
}
// Native teleport arrival is intentionally airborne; never add support.
const arrivalSupported=supported;
let seams=0, previous=null, previousBytes=null;
for (const region of route.regions) {
  const bytes=raster(region);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),region.sha256,`native raster hash ${region.key}`);
  for(const n of bytes) if(n!==255 && n>=route.palette.length) assert.fail(`Unknown native palette index ${region.key}: ${n}`);
  if(previous && previous.core[1]===region.core[0]) {
    assert.deepEqual(previousBytes.subarray(256*route.fold.sourceWidth),bytes.subarray(0,64*route.fold.sourceWidth));
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
  assert.deepEqual(go.source,[...p.target,2.5]); portals++;
}
console.log(`Actual source: full-body start clear at ${route.startSource} (supported=${arrivalSupported}; native airborne arrival preserved); ${seams} byte-identical context seams, bidirectional same-XZ handoffs; ${portals} native portal endpoints passed; start element ${E.EMPTY}`);
