import test from 'node:test';
import assert from 'node:assert/strict';
import { DOOR_DEFAULTS, IDENTITY_TRANSFORM as I, doorPose, transformDoorPoint, transformDoorVector, doorSweptBounds, sweptDoorBounds, doorProgressAtTime, doorBrickKeys } from '../src/world/import/doorMotion.js';
import { parseGodot3Scene, transformPoint } from '../src/world/import/godot3.js';
import { analyzeCrueltyDoors, doorMotionInCells, crueltyInteractions } from '../src/world/import/crueltyInteractions.js';
import { voxelizeMeshes, sourceToCells, importedCell } from '../src/world/import/voxelize.js';
const close = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const near = (a, b) => a.forEach((v, k) => close(v, b[k]));
function fixture(script = 'Door.gd', { parent = I, root = I, child = I, bounds = { min: [-2,-1,-0.25], max: [2,1,0.25] }, props = '' } = {}) {
  const scene = parseGodot3Scene(`[gd_scene format=2]
[ext_resource path="res://Scripts/${script}" type="Script" id=1]
[node name="Root" type="Spatial"]
transform = Transform( ${parent} )
[node name="Door" type="KinematicBody" parent="."]
transform = Transform( ${root} )
script = ExtResource( 1 )
${props}
[node name="Mesh" type="MeshInstance" parent="Door"]
transform = Transform( ${child} )
`);
  const n = scene.nodes.get('Door/Mesh');
  const points = [[-2,-1,0], [2,-1,0], [2,1,0], [-2,1,0]].map(p => transformPoint(n.worldTransform, p));
  const meshes = [{ nodePath: n.path, rawLocalBounds: bounds, surfaces: [{ nodePath: n.path, positions: new Float64Array(points.flat()), indices: new Uint32Array([0,1,2,0,2,3]), materialPath: 'door', uvs: new Float64Array([0,0,1,0,1,1,0,1]) }] }];
  return { scene, meshes, points };
}

test('negative swing, exact midpoint/endpoints, clamp and timer-from-activation', () => {
  const m = { kind: 'swing', pivot: [3,4,5], axis: [0,1,0], angleRadians: -Math.PI/2, durationSeconds: Math.PI/4, autoCloseSeconds: null };
  near(transformDoorPoint(doorPose(m, 0), [5,4,5]), [5,4,5]);
  near(transformDoorPoint(doorPose(m, 0.5), [5,4,5]), [3+Math.sqrt(2),4,5+Math.sqrt(2)]);
  near(transformDoorPoint(doorPose(m, 1), [5,4,5]), [3,4,7]);
  near(doorPose(m, 2), doorPose(m, 1));
  close(doorProgressAtTime(m, Math.PI/8), 0.5);
  const slide = { kind: 'sliding', durationSeconds: 2, autoCloseSeconds: 5 };
  close(doorProgressAtTime(slide, 4), 1); close(doorProgressAtTime(slide, 5), 1);
  close(doorProgressAtTime(slide, 6), 0.5); close(doorProgressAtTime(slide, 7), 0);
  close(doorProgressAtTime({ ...slide, kind: 'vertical' }, 20, { switchUse: true }), 1);
  close(doorProgressAtTime({ ...slide, durationSeconds: 10 }, 6), 0.4);
  assert.equal(DOOR_DEFAULTS.rotation_speed, 2);
});

test('literal source rebase uses raw local AABB, child basis and global root subtraction', () => {
  // parent X rotation, root Y rotation, child Y rotation; source q=(-2,0,0).
  const parent = [1,0,0, 0,0,1, 0,-1,0, 10,20,30];
  const root = [0,0,-1, 0,1,0, 1,0,0, 4,5,6];
  const child = [0,0,-1, 0,1,0, 1,0,0, 7,8,9];
  const { scene, meshes, points } = fixture('Door.gd', { parent, root, child });
  const a = analyzeCrueltyDoors(scene, meshes), d = a.doors.get('Door'), m = d.motion;
  assert.equal(d.supported, true); near(m.sourceRebase, [-2,0,0]);
  const rootWorld = scene.nodes.get('Door').worldTransform;
  near(m.pivot, rootWorld.slice(9).map((v,k) => v - m.sourceRebase[k]));
  near(m.axis, [0,0,1]);
  const expectedShift = transformDoorVector(rootWorld, transformDoorVector(child, [-2,0,0])).map((v,k) => v - [-2,0,0][k]);
  near(m.closedSourceOffset, expectedShift);
  near(Array.from(meshes[0].surfaces[0].positions.slice(0,3)), points[0].map((v,k) => v + expectedShift[k]));
  const cell = doorMotionInCells(d, { cellMeters: 0.5, origin: [-10,-20,-30] });
  near(cell.pivot, sourceToCells({ cellMeters: 0.5, origin: [-10,-20,-30] }, m.pivot));
  close(cell.durationSeconds, Math.PI/4);
});

test('slide parent axes, square diagonal, vertical downward and explicit speed overrides', () => {
  const parent = [0,0,-1, 0,1,0, 1,0,0, 4,5,6];
  for (const [script, bounds, expected, duration] of [
    ['Elevator_Door.gd', { min:[-2,-1,-0.25], max:[2,1,0.25] }, [0,0,4.1], 2.05],
    ['Elevator_Door.gd', { min:[-1,-1,-1], max:[1,1,1] }, [-2.1,0,2.1], 1.05],
    ['Elevator_Door.gd', { min:[-0.25,-1,-2], max:[0.25,1,2] }, [-4.1,0,0], 2.05],
    ['down_door.gd', { min:[-2,-1,-0.25], max:[2,1,0.25] }, [0,-2.1,0], 1.05],
  ]) {
    const { scene, meshes } = fixture(script, { parent, bounds });
    const d = analyzeCrueltyDoors(scene, meshes).doors.get('Door');
    near(d.motion.translation, expected); close(d.motion.durationSeconds, duration);
    const m = doorMotionInCells(d, { cellMeters: 0.5, origin: [0,0,0] });
    near(m.translation, expected.map(v => v*2)); close(m.speed, 4);
    assert.equal(d.motion.autoCloseSeconds, 5);
  }
  const f = fixture('Door.gd', { props:'rotation_speed = 4' });
  close(analyzeCrueltyDoors(f.scene, f.meshes).doors.get('Door').motion.durationSeconds, Math.PI/8);
  for (const value of ['0', '-1', 'false', 'Vector3( 1, 2, 3 )']) {
    const bad = fixture('Door.gd', { props: `rotation_speed = ${value}` });
    const d = analyzeCrueltyDoors(bad.scene, bad.meshes).doors.get('Door');
    assert.equal(d.supported, false); assert.match(d.diagnostics.join(), /finite positive/);
  }
});

test('non-rigid or Euler pitch/roll transforms diagnosed without modifying geometry', () => {
  for (const root of [[2,0,0,0,1,0,0,0,1,0,0,0], [1,0,0,0,0,1,0,-1,0,0,0,0]]) {
    const f = fixture('Door.gd', { root }), before = [...f.meshes[0].surfaces[0].positions];
    const d = analyzeCrueltyDoors(f.scene, f.meshes).doors.get('Door');
    assert.equal(d.supported, false); assert.ok(d.diagnostics.length); assert.deepEqual([...f.meshes[0].surfaces[0].positions], before);
  }
});

test('analytic sweep covers every intermediate pose including extrema absent at endpoints', () => {
  const axis = [1,2,3].map(v => v/Math.sqrt(14));
  const points = [[2,5,-3], [-4,7,2], [6,-8,1]];
  const m = { kind:'swing', pivot:[1,2,3], axis, angleRadians:-Math.PI/2 };
  const b = doorSweptBounds(m, points);
  for (let i=0;i<=1000;i++) for (const p of points) {
    const q = transformDoorPoint(doorPose(m,i/1000),p);
    q.forEach((v,k) => assert.ok(v >= b.min[k]-1e-10 && v <= b.max[k]+1e-10));
  }
  const interior = doorSweptBounds({ ...m, pivot:[0,0,0], axis:[0,1,0] }, [[1,0,1]]);
  close(interior.max[2], Math.sqrt(2));
});

test('AABB range sweep covers corner arcs in opening/closing without full-cycle inflation', () => {
  const m = { kind:'swing', pivot:[0,0,0], axis:[0,1,0], angleRadians:-Math.PI/2 };
  const bounds = { min:[1,-1,1], max:[2,1,2] }, from = 0.3, to = 0.6;
  const sweep = sweptDoorBounds(m,bounds,from,to), reverse = sweptDoorBounds(m,bounds,to,from);
  assert.deepEqual(sweep,reverse);
  for(let i=0;i<=100;i++) for(let corner=0;corner<8;corner++) {
    const p = [0,1,2].map(k=>(corner & (1<<k) ? bounds.max : bounds.min)[k]);
    const q = transformDoorPoint(doorPose(m,from+(to-from)*i/100),p);
    q.forEach((v,k)=>assert.ok(v>=sweep.min[k]-1e-10 && v<=sweep.max[k]+1e-10));
  }
  const whole = sweptDoorBounds(m,bounds);
  assert.ok(sweep.max[0]<whole.max[0]);
  const sliding = {kind:'sliding',translation:[-10,-2,4]};
  const b = sweptDoorBounds(sliding,bounds,0.25,0.5);
  near(b.min,[-4,-2,2]); near(b.max,[-0.5,0.5,4]);
});

test('swept storage reserves empty bricks, extends world and preserves every occupied source cell', () => {
  const f = fixture('Elevator_Door.gd');
  const analysis = analyzeCrueltyDoors(f.scene, f.meshes, { cellMeters: 1 });
  const options = { cellMeters:1, padding:2, ownerForMesh:analysis.ownerForMesh };
  const plain = voxelizeMeshes(f.meshes, { door:2 }, options);
  const map = voxelizeMeshes(f.meshes, { door:2 }, { ...options, reserveBounds: analysis.sweptBounds });
  assert.equal(map.stats.cells, plain.stats.cells); assert.ok(map.stats.reservedBricks > 0);
  const occupied = m => {
    const list=[];
    for(let z=0;z<m.size[2];z++) for(let y=0;y<m.size[1];y++) for(let x=0;x<m.size[0];x++) {
      const id = importedCell(m,m.words,x,y,z);
      if(id) list.push([x+m.origin[0],y+m.origin[1],z+m.origin[2],id].join(','));
    }
    return list.sort();
  };
  assert.deepEqual(occupied(map), occupied(plain));
  const d = doorMotionInCells(analysis.doors.get('Door'),map);
  assert.ok(d.sweptBounds.min.every(v=>v>=0)); assert.ok(d.sweptBounds.max.every((v,k)=>v<map.size[k]));
  for(const key of doorBrickKeys(d.sweptBounds,map.brickDims)) assert.ok(map.words[key]);
  const modern = crueltyInteractions(f.scene,f.meshes,map,map.ownedCells,analysis).doors[0];
  assert.ok(modern.motion); assert.equal(modern.supported,true); assert.deepEqual(modern.appearanceTriangleIndices,[]);
  const legacy = crueltyInteractions(f.scene,f.meshes,plain,plain.ownedCells).doors[0];
  assert.equal(legacy.motion,undefined); assert.equal(legacy.supported,true); assert.ok(legacy.cells.length);
});
