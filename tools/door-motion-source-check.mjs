// Optional recovered-source CPU dry conversion. No public writes or runtime.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGodot3Scene, embeddedMeshes } from '../src/world/import/godot3.js';
import { doorAncestor, analyzeCrueltyDoors, doorMotionInCells } from '../src/world/import/crueltyInteractions.js';
import { crueltyExcludeNode } from '../src/world/import/crueltyMission.js';
import { CRUELTY_MATERIALS } from '../src/world/import/crueltyMaterials.js';
import { voxelizeMeshes } from '../src/world/import/voxelize.js';
import { doorBrickKeys, doorPose, transformDoorPoint } from '../src/world/import/doorMotion.js';
import { AppearanceResources } from './appearance-resources.mjs';
import { AppearanceConversion } from './appearance-conversion.mjs';
import { APPEARANCE_HEADER as H } from '../src/world/import/appearanceFormat.js';
const root = process.env.CRUELTY_SOURCE_ROOT;
if (!root) throw new Error('Set CRUELTY_SOURCE_ROOT (and GDRE_BIN for binary resources)');
for (const level of [1, 2, 3, 4, 6]) {
  const text = readFileSync(join(root, 'Levels', `Level${level}.tscn`), 'utf8');
  const scene = parseGodot3Scene(text);
  const meshes = embeddedMeshes(scene, { excludeNode: (n, s) => crueltyExcludeNode(n,s) || !doorAncestor({ nodePath:n.path },s) });
  const analysis = analyzeCrueltyDoors(scene,meshes);
  const resources = new AppearanceResources(root);
  const appearance = new AppearanceConversion(resources,resources.context(scene,`res://Levels/Level${level}.tscn`,text),meshes,CRUELTY_MATERIALS,analysis);
  const map = voxelizeMeshes(meshes,CRUELTY_MATERIALS,{cellMeters:0.3,ownerForMesh:analysis.ownerForMesh,reserveBounds:analysis.sweptBounds,onTriangle:appearance.onTriangle});
  const payload = appearance.pack(map,{excludeNode:crueltyExcludeNode});
  const diagnostics = [];
  let supported = 0, triangleMappings = 0;
  for (const d of analysis.doors.values()) {
    if (!d.supported) { diagnostics.push({sourcePath:d.sourcePath,diagnostics:d.diagnostics}); continue; }
    supported++;
    const m = doorMotionInCells(d,map), indices = appearance.appearanceTriangleIndices[d.sourcePath] ?? [];
    assert.ok(indices.length,`Missing appearance mapping: ${d.sourcePath}`);
    triangleMappings += indices.length;
    for (const key of doorBrickKeys(m.sweptBounds,map.brickDims)) {
      assert.ok(map.words[key]);
      const at = payload.words[payload.words[H.directoryAt]+key];
      assert.ok(at);
      const list = new Set(payload.words.subarray(at+1,at+1+payload.words[at]));
      for (const i of indices) assert.ok(list.has(i));
    }
    const owned = map.ownedCells[d.sourcePath];
    for (let i=0;i<owned.length;i+=2) {
      const index = owned[i], [sx,sy] = map.size;
      const center = [index%sx+0.5,Math.floor(index/sx)%sy+0.5,Math.floor(index/(sx*sy))+0.5];
      for (const f of [0,0.25,0.5,0.75,1]) {
        const p = transformDoorPoint(doorPose(m,f),center);
        p.forEach((v,k)=>assert.ok(v>=m.sweptBounds.min[k] && v<=m.sweptBounds.max[k]));
      }
    }
  }
  console.log(JSON.stringify({level,supported,triangleMappings,maxBrickTriangles:payload.metadata.maxBrickTriangles,reservedBricks:map.stats.reservedBricks,diagnostics}));
}
