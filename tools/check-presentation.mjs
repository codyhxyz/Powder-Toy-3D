// CPU-only; no browser or simulation mutation. node tools/check-presentation.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { IDENTITY, ROLLING_LOG, effectParameters, warp, warpTangent, inverseRay, rayPoint, roots, planeRoots, boxSpans, nextExit, chordLimit, rayCell, rayEntryAxis, arcLength } from '../src/gfx/presentationMath.js';
import { createPresentation, installPresentation } from '../src/gfx/presentation.js';
import { MESH_EDGE_CELLS, subdividePresentation } from '../src/gfx/presentationGeometry.js';
import { mapByKey, mapsFor, resolveMode, modeByKey } from '../src/maps.js';
const close = (a,b,eps=1e-8) => {
  assert.equal(a.length,b.length);
  a.forEach((x,i) => assert(Math.abs(x-b[i]) <= eps, `${a} != ${b}`));
};
const e = effectParameters(ROLLING_LOG.k,[510,310],[3,4]);
close(e.dir,[0.6,0.8]);
assert.throws(() => effectParameters(NaN));
assert.throws(() => effectParameters(-1));
close(effectParameters(1,[0,0],[0,0]).dir,[0,1]);
for (let j=0; j<200; j++) {
  const p = [j*7-350,j/3,j*3-160], d = new THREE.Vector3(Math.sin(j+1),Math.cos(j+3),0.4).normalize().toArray();
  close(warp(warp(p,e),e,true),p);
  const q = inverseRay(p,d,e);
  for (const t of [0,0.01,1,50,600]) {
    close(warp(rayPoint(q,t),e),p.map((v,i) => v+d[i]*t));
    const h=1e-3, chord=rayPoint(q,t+h).map((v,i) => (v-rayPoint(q,t-h)[i])/(2*h));
    close(warpTangent(rayPoint(q,t),chord,e),d,1e-6);
  }
  const limit=chordLimit(q), a=7, b=a+limit;
  const mid=rayPoint(q,(a+b)/2), c=rayPoint(q,a).map((v,i) => (v+rayPoint(q,b)[i])/2);
  assert(Math.hypot(...mid.map((v,i) => v-c[i])) <= ROLLING_LOG.chordError+1e-8);
}
assert.deepEqual(warp([1,2,3],IDENTITY),[1,2,3]);
assert.deepEqual(inverseRay([1,2,3],[0,1,0]),{C:[1,2,3],B:[0,1,0],A:[0,0,0]});
assert.deepEqual(roots(0,0,1),[]);
assert.deepEqual(roots(0,2,-4),[2]);
assert.deepEqual(roots(1,-4,4),[2]);
close(roots(1,1e8,1),[-1e8,-1e-8]);
const turn = {C:[0,4,0.5],B:[1,-4,0],A:[0,1,0]};
assert.deepEqual(boxSpans(turn,[0,1,0],[4,4,1]),[[0,1],[3,4]]);
assert.deepEqual(boxSpans(turn,[0,0,0],[4,4,1]),[[0,4]]); // tangent does NOT split
assert.deepEqual(planeRoots(turn,1,0),[2]);
close([nextExit(turn,[0,1,0],[4,4,1],0).t],[1]);
close([nextExit(turn,[0,0,0],[4,4,1],0).t],[4]);
const horizontal = inverseRay([0,0.5,0.5],[1,0,0]);
assert.deepEqual(boxSpans(horizontal,[0,0,0],[1,1,1]),[[0,1]]);
assert.deepEqual(boxSpans(inverseRay([1,0.5,0.5],[1,0,0]),[0,0,0],[1,1,1]),[]);
assert.deepEqual(boxSpans(inverseRay([1,0.5,0.5],[-1,0,0]),[0,0,0],[1,1,1]),[[0,1]]);
assert.deepEqual(boxSpans(inverseRay([0,2,0],[1,0,0]),[0,0,0],[1,1,1]),[]);
const diagonal=inverseRay([0,0,0],new THREE.Vector3(1,1,1).normalize().toArray());
close([nextExit(diagonal,[0,0,0],[1,1,1],0).t],[Math.sqrt(3)]);
const perpendicular=inverseRay([0,1,0],[1,0,0],effectParameters(1,[0,0],[0,1]));
assert.equal(perpendicular.A[1],0); // directional tangency, explicit linear roots
assert.equal(chordLimit(perpendicular),Infinity);

// Regressions from the independent float32 traversal review.
const grazing={C:[0.5,1e-8,0.5],B:[0,-8e-6,Math.sqrt(1-64e-12)],A:[0,(1-64e-12)/2048,0]};
close([nextExit(grazing,[0,0,0],[1,1,1],0).t],[0.001363467],1e-9);
assert.equal(boxSpans(grazing,[0,0,0],[1,1,1]).length,2);
const boundary=inverseRay([0.5,Math.fround(0.999995),0.5],[0,1,0]);
assert.deepEqual(rayCell(boundary,0),[0,0,0]);
assert.deepEqual(rayCell(boundary,planeRoots(boundary,1,1)[0]),[0,1,0]);
assert.equal(rayEntryAxis(inverseRay([0,-1,0.5],[0,1,0]),1),1);
const almostStraight={C:[0,0,0],B:[Math.fround(Math.sqrt(0.5)),Math.fround(Math.sqrt(0.5)),1e-5],A:[0,Math.fround((1/2048)*1e-10),0]};
close([Math.fround(arcLength(almostStraight,0,1))],[1],2e-7);
// reliefHit's existing 1.5-cell shell may extend past a chord. Its horizontal
// extrapolation error k*extension*(sqrt(2)+extension) stays below 1/256 cell.
assert(ROLLING_LOG.k*1.5*(Math.sqrt(2)+1.5)<1/256);

// Dense independent membership oracle catches lost reentry and boundary roots.
for (let j=0;j<100;j++) {
  const r={C:[-1,j/40-1,0.5],B:[0.5,-j/50,0],A:[0,0.1,0]};
  const spans=boxSpans(r,[0,0,0],[3,1,1],0,20);
  for (let t=0.003;t<20;t+=0.027) {
    const p=rayPoint(r,t), inside=p.every((v,i) => v>=[0,0,0][i] && v<=[3,1,1][i]);
    assert.equal(spans.some(([a,b]) => t>=a && t<=b),inside);
  }
}

let calls=0, wakes=0;
const mat=new THREE.MeshBasicMaterial();
const original=function(shader) { calls++; shader.vertexShader += '\n// chained customization'; };
mat.onBeforeCompile=original;
mat.customProgramCacheKey=()=>'custom-key';
const p=createPresentation(()=>wakes++);
const undo=installPresentation(mat,p.uniforms), key=mat.customProgramCacheKey();
assert.equal(installPresentation(mat,p.uniforms),undo);
assert.equal(mat.customProgramCacheKey(),key);
assert(key.includes('custom-key'));
const shader={vertexShader:'void main() { gl_Position=vec4(1.0); }',uniforms:{}};
mat.onBeforeCompile(shader);
assert.equal(calls,1);
assert.equal((shader.vertexShader.match(/void main\(/g)||[]).length,1);
assert(shader.vertexShader.includes('presentationOriginalMain();'));
assert(shader.vertexShader.includes('// chained customization'));
assert.equal(shader.uniforms.uWarpK,p.uniforms.uWarpK);
undo(); assert.equal(mat.onBeforeCompile,original); assert.equal(mat.customProgramCacheKey(),'custom-key');

const cove=mapByKey('willowCove');
assert.equal(resolveMode(cove,'animalCrossing').effect,'rollingLog');
assert(!modeByKey('animalCrossing').team);
assert.deepEqual(mapsFor('animalCrossing'),[cove]);
for (const [map,mode] of [[mapByKey('lab'),'animalCrossing'],[cove,'slayer'],[cove,'bogus'],[null,'animalCrossing']])
  assert.equal(resolveMode(map,mode).key,'sandbox');
p.select(resolveMode(cove,'animalCrossing').effect);
assert(p.active); assert.equal(wakes,1);
p.select('rollingLog'); assert.equal(wakes,1);
const camera=new THREE.PerspectiveCamera(); camera.position.set(1,3,4); camera.lookAt(1,0,4);
p.update(camera,new THREE.Matrix4());
assert(p.parameters.dir.every(Number.isFinite));
close(warp(camera.position.toArray(),p.parameters),camera.position.toArray());
const scene=new THREE.Scene(), mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),mat);
scene.add(mesh); p.prepare(scene,camera); assert.equal(mesh.frustumCulled,false);
const revision=p.revision;
assert.throws(()=>p.neutral(()=>{assert.equal(p.uniforms.uWarpK.value,0); throw new Error('restore');}));
assert(p.active); assert(p.uniforms.uWarpK.value>0);
p.select(null); assert(p.revision>revision); assert.equal(mesh.frustumCulled,true);
assert.equal(mat.onBeforeCompile,original); assert.equal(p.uniforms.uWarpK.value,0);
p.select('rollingLog'); p.prepare(scene,camera); mesh.removeFromParent(); assert.equal(mesh.frustumCulled,true);
p.dispose(); assert(!p.active);

const large=new THREE.Mesh(new THREE.PlaneGeometry(128,128));
const split=subdividePresentation(large,MESH_EDGE_CELLS);
assert(split); const a=split.attributes.position;
for (let i=0;i<a.count;i+=3) for (const [j,k] of [[0,1],[1,2],[2,0]])
  assert(new THREE.Vector3().fromBufferAttribute(a,i+j).distanceTo(new THREE.Vector3().fromBufferAttribute(a,i+k))<=MESH_EDGE_CELLS+1e-6);
split.dispose(); large.geometry.dispose(); large.material.dispose(); mesh.geometry.dispose(); mat.dispose();
console.log('presentation: mapping, inverse, roots, turn/reentry, tangency, chord bound, material chaining, lifecycle, mode resolution and mesh edge bound OK');
