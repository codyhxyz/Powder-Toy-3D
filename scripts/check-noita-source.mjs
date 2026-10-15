// Source route integration + actual packed-occupancy body walk. CPU only.
// node scripts/check-noita-source.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { DESCENT_LEVELS, levelByScene, nextLevel, inBox } from '../src/world/scenes/descent/levels.js';
import { WORLD_SCENES, sceneByKey } from '../src/world/scenes/index.js';
import { mapByKey, mapsFor } from '../src/maps.js';
import { E, ELEMENTS, K } from '../src/elements.js';
import { importedCell } from '../src/world/import/voxelize.js';
import { createImportedMapScene, validateImportedMapManifest } from '../src/world/scenes/importedMap.js';
import { createDescentRunner, runSnapshot } from '../src/pov/descent/switch.js';

const hash = (b) => createHash('sha256').update(b).digest('hex');
const keys = ['noitaHolyMountain', 'noitaCoal', 'noitaSnow', 'noitaHiisi', 'noitaJungle', 'noitaVault', 'noitaTemple', 'noitaKolmi'];
assert.deepEqual(DESCENT_LEVELS.map(l => l.key), keys);
assert.deepEqual(mapByKey('descent').scenes, keys);
assert.equal(mapByKey('descent').scene, keys[0]);
assert.ok(mapsFor('noita').includes(mapByKey('descent')));
assert.equal(nextLevel('unknown'), null);
assert.equal(nextLevel(keys.at(-1)), null);
const solid = ELEMENTS.map(e => e.kind === K.SOLID);
let total = 0, totalPacked = 0;

for (const [i, lv] of DESCENT_LEVELS.entries()) {
  const m = JSON.parse(readFileSync(new URL(`../public/local-maps/${lv.key}.json`, import.meta.url)));
  const zipped = readFileSync(new URL(`../public/local-maps/${m.dataFile}`, import.meta.url));
  const raw = gunzipSync(zipped);
  const words = new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  assert.equal(hash(raw), m.geometrySha256);
  assert.equal(hash(zipped), m.packedSha256);
  const scene = createImportedMapScene(m, words, { key: lv.key });
  assert.deepEqual(scene.start(), [lv.spawn[0], lv.spawn[2]]);
  assert.deepEqual(m.descent, lv);
  assert.equal(sceneByKey(lv.key).key, lv.key);
  assert.equal(WORLD_SCENES.filter(s => s.key === lv.key).length, 1);
  assert.equal(sceneByKey(lv.key).descentLevel, i);
  assert.equal(levelByScene(lv.key), lv);
  assert.deepEqual(m.size, [512, 256, 512]);
  if (i < 7) assert.ok(m.provenance.sources.some(s => s.path === 'data/biome_impl/temple/altar.png'));
  assert.ok(m.provenance.sources.every(s => /^[a-f0-9]{64}$/.test(s.sha256) && s.bytes > 0));
  const paths = new Set(m.provenance.sources.map(s => s.path));
  for (const p of m.provenance.placements) {
    assert.ok(paths.has(p.path));
    assert.ok(p.compiledSize.every(n => n > 0));
    assert.ok(p.palette.every(c => E[c.element] != null && c.pixels > 0));
    assert.ok(p.palette.filter(c => c.material == null).every(c => c.element === 'EMPTY' && c.loss));
  }
  if (i > 0 && i < 7) {
    assert.equal(lv.role, 'biome');
    assert.equal(lv.chests.length, 3);
    assert.equal(lv.potions.length, 6);
    assert.equal(lv.loot.length, 36);
    assert.equal(new Set(m.provenance.placements.map(p => p.path)).size, 5);
    assert.ok(m.provenance.placements.some(p => p.quarterTurn === 1));
    assert.ok(m.provenance.placements.some(p => p.quarterTurn === 3));
    assert.ok(m.provenance.connectors.some(e => e.label.includes('cross-link')));
  } else {
    assert.equal(lv.role, i === 0 ? 'sanctuary' : 'arena');
    assert.equal(lv.loot.length + lv.chests.length + lv.potions.length, 0);
  }

  // Unpack independently into a dense CPU collision fixture (never sent to GPU).
  const nx = 512, ny = 256, plane = nx*ny;
  const grid = new Uint8Array(nx*ny*512);
  let cells = 0, min = [512,256,512], max = [0,0,0];
  for (let bz = 0; bz < 64; bz++) for (let by = 0; by < 32; by++) for (let bx = 0; bx < 64; bx++) {
    const at = words[bx+64*(by+32*bz)];
    if (!at) continue;
    for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const j = x+8*(y+8*z), id = (words[at+(j>>2)] >>> ((j&3)*8))&255;
      if (!id) continue;
      const p = [bx*8+x, by*8+y, bz*8+z];
      grid[p[0]+nx*p[1]+plane*p[2]] = id; cells++;
      for (let k=0;k<3;k++) { min[k]=Math.min(min[k],p[k]); max[k]=Math.max(max[k],p[k]); }
    }
  }
  assert.equal(cells, m.stats.cells);
  if (i !== 0) assert.ok(max[0]-min[0] > 250 && max[2]-min[2] > 150 && max[1]-min[1] > 140, 'genuine 3D extent');
  let rng = 1234567;
  for (let j=0;j<2000;j++) {
    rng = (Math.imul(rng,1664525)+1013904223)>>>0;
    const x=rng%512,y=(rng>>>9)%256,z=(rng>>>17)%512;
    assert.equal(importedCell(m,words,x,y,z),grid[x+nx*y+plane*z]);
  }
  const idx = (x,y,z) => x+nx*y+plane*z;
  const air = (x,y,z) => {
    if (x<1 || x>=511 || z<1 || z>=511 || y<1 || y>=250) return false;
    for(let dz=-1;dz<=1;dz++) for(let dx=-1;dx<=1;dx++) for(let dy=0;dy<6;dy++)
      if(grid[idx(x+dx,y+dy,z+dz)]) return false;
    return true;
  };
  const support = (x,y,z) => {
    for(let dz=-1;dz<=1;dz++) for(let dx=-1;dx<=1;dx++)
      if(solid[grid[idx(x+dx,y-1,z+dz)]]) return true;
    return false;
  };
  const cache = new Map();
  const stand = (x,y,z) => {
    const id=idx(x,y,z);
    if (!cache.has(id)) cache.set(id, air(x,y,z)&&support(x,y,z));
    return cache.get(id);
  };
  const sites = [lv.spawn, m.route.goal, ...lv.loot.map(s=>[s.x,s.y,s.z]), ...lv.chests.map(s=>[s.x,s.y,s.z]),
    ...lv.potions.map(s=>[s.x,s.y,s.z]), ...(lv.temple.shop??[]), ...(lv.temple.altars??[]), ...(lv.temple.refresher?[lv.temple.refresher]:[])];
  for (const p of sites) assert.ok(stand(...p), `${lv.key}: six-cell body/support at ${p}`);
  if (lv.temple.pool) {
    const [x0,y0,z0,x1,y1,z1] = lv.temple.pool;
    for (let z=z0;z<z1;z++) for (let x=x0;x<x1;x++) {
      assert.equal(grid[idx(x,y1-1,z)], E.WATER, `${lv.key}: healing water`);
      assert.equal(grid[idx(x,y1,z)], E.EMPTY, `${lv.key}: pool has an open surface`);
    }
  }
  assert.ok(inBox(lv.temple.exit, m.route.goal));
  const wanted = new Set(sites.map(p=>idx(...p))), visited = new Set();
  const queue = [lv.spawn]; visited.add(idx(...lv.spawn));
  for (let head=0;head<queue.length && wanted.size;head++) {
    const [x,y,z]=queue[head]; wanted.delete(idx(x,y,z));
    for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const xx=x+dx,zz=z+dz;
      // 1-cell steps, <=8-cell safe drops. Sweep the whole body, not an air point.
      for (let yy=y+1;yy>=y-8;yy--) {
        if(!stand(xx,yy,zz)) continue;
        let swept=air(x,Math.max(y,yy),z);
        for(let sy=yy;sy<=y && swept;sy++) swept=air(xx,sy,zz);
        if(!swept) continue;
        const id=idx(xx,yy,zz);
        if(!visited.has(id)) { visited.add(id);queue.push([xx,yy,zz]); }
        break;
      }
    }
  }
  assert.equal(wanted.size, 0, `${lv.key}: unreachable body sites ${[...wanted].map(id=>[id%512,Math.floor(id/512)%256,Math.floor(id/plane)]).slice(0,8)}`);
  if (i===7) {
    assert.ok(paths.has('data/biome_impl/spliced/boss_arena.png'));
    assert.ok(!paths.has('data/biome/laboratory.xml'));
    assert.ok(!lv.temple.shop && !lv.temple.box && !lv.temple.altars);
    assert.match(lv.completion.subtitle,/combat is not implemented/);
  }
  total+=cells;totalPacked+=zipped.length;
  console.log(`ok ${lv.key}: ${cells} cells, ${zipped.length} gzip bytes, ${queue.length} body-walk nodes, all ${sites.length} sites reachable`);
}

// Mission imports retain their old default thermal code; generic/descent starts work.
const base = sceneByKey(keys[0]).importManifest;
const noMission = {...base, spawn:undefined, descent:{spawn:[20,20,20]}};
assert.doesNotThrow(()=>validateImportedMapManifest(noMission));
assert.deepEqual(createImportedMapScene(noMission).start(),[20,20]);
const mission = {...base, spawn:undefined, descent:undefined, airT:undefined, mission:{spawn:[20,20,20]}};
assert.ok(createImportedMapScene(mission).glsl().includes('f32(id), SPAWNT(id),'));
assert.ok(createImportedMapScene({...base, airT:-12}).glsl().includes('-12.0'));
assert.match(createImportedMapScene({...base, airT:-12}).glsl(), /all\(w >= vec3i\(180, 8, 240\)\)/, 'sanctuary and sunken pool stay warm');
assert.throws(()=>validateImportedMapManifest({...base,spawn:[-1,0,0]}));

// Every source-scene seam preserves the same run objects, including final honest completion.
let current=keys[0], load=0, finished=false;
const overlays=[], player={health:0.42,shield:0.2}, wands={wands:[{id:'kept'}],bag:['spark'],potions:[]};
const snapshot=()=>runSnapshot({player,gold:123,wands});
const before=snapshot();
const runner=createDescentRunner({levels:DESCENT_LEVELS,emit:()=>{},snapshot,
  loadScene:async k=>{current=k;load++;},enterAt:async()=>{},loadId:()=>load,
  overlay:{show:(...a)=>overlays.push(a)},wait:async()=>{},finish:()=>{finished=true;}});
for (const lv of DESCENT_LEVELS) {
  assert.equal(current,lv.key);
  const b=lv.temple.exit,feet={x:(b[0]+b[3])/2,y:b[1],z:(b[2]+b[5])/2};
  await runner.frame({key:current,feet,live:true,load});
  assert.deepEqual(snapshot(),before);
}
assert.ok(finished);
assert.match(overlays.at(-1)[1],/combat is not implemented/);
console.log(`all 8 source route scenes passed; ${total} cells; ${totalPacked} gzip bytes; run preserved across 7 transitions`);
