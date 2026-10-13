// The rolling log's presentation layer, CPU only (no browser, no GPU, no
// simulation): node tools/check-presentation.mjs
//
// The JS mapping and its ray algebra (gfx/presentationMath.js: the twin the
// app's picking and planes use), the mesh subdivision's edge bound, the
// gamemodes' resolution (maps.js), and the WebGPU port's equivalents of
// main's GLSL: the TSL vertex bend that replaces installPresentation's
// onBeforeCompile (chained onto a material's own vertex stage, idempotent,
// restored), the presentation's lifecycle (install's and prepare's installs,
// the meshes whose program changed, overlays, opt-outs and the guard's parked
// meshes left alone, neutral, select/dispose restoring), and, statically,
// that the WGSL passes carry the bend: the volume's curved variants walk the
// displayed rays (shaders/gfx/presentation.js), its flat ones don't, the far
// view's curved variant marches the parabola, the pick and the motion pass's
// reprojection (three's TAAU's velocity) take it, and no GLSL is left in the presentation's modules.
// tools/presentation-check.mjs runs the GPU side.
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { IDENTITY, ROLLING_LOG, effectParameters, warp, warpTangent, inverseRay, rayPoint, roots, planeRoots, boxSpans, nextExit, chordLimit, rayCell, rayEntryAxis, arcLength, presentationWGSL, presentationGLSL } from '../src/gfx/presentationMath.js';
import { createPresentation, installPresentation } from '../src/gfx/presentation.js';
import { MESH_EDGE_CELLS, subdividePresentation } from '../src/gfx/presentationGeometry.js';
import { presentationNearWGSL, presentationNearGLSL } from '../src/shaders/gfx/presentation.js';
import { volumeFrag, pickFrag, VOLUME_VIEWS, warmChecks } from '../src/shaders/render.js';
import { farFrag, farDetailDepthFrag, farLayout, WORLD_SIZE } from '../src/shaders/far.js';
import { motionWGSL, WGSL_CHECK as postChecks } from '../src/gfx/post.js';
import { gridLayout } from '../src/sim.js';
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

// ---- the TSL bend (installPresentation): chained onto the material's own vertex stage ----
// the nodes a node reaches (its inputs, theirs, …)
const reach = (node) => {
  const seen = new Set(), stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    for (const c of n.getChildren?.() ?? []) stack.push(c);
  }
  return seen;
};
let wakes=0;
const p=createPresentation(()=>wakes++);
const mat=new THREE.MeshBasicNodeMaterial(), own=vec4(1,2,3,1);
mat.vertexNode=own;   // a material's own vertex stage (a billboard's, a bird's)
mat.customProgramCacheKey=()=>'custom-key';
const undo=installPresentation(mat,p.uniforms), key=mat.customProgramCacheKey();
assert.notEqual(mat.vertexNode,own);
assert.equal(installPresentation(mat,p.uniforms),undo);   // idempotent
assert.equal(mat.customProgramCacheKey(),key);
assert(key.includes('custom-key') && key.includes('presentation'));
const graph=reach(mat.vertexNode);
assert(graph.has(own), 'the bend reads the material\'s own clip position');
for (const u of Object.values(p.uniforms)) assert(graph.has(u), 'the bend reads the presentation\'s uniforms');
undo(); assert.equal(mat.vertexNode,own); assert.equal(mat.customProgramCacheKey(),'custom-key');
const plain=new THREE.MeshBasicNodeMaterial();   // no vertex stage of its own: three's modelViewProjection is bent
installPresentation(plain,p.uniforms)(); assert.equal(plain.vertexNode,null);

// ---- the presentation's lifecycle ----
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
// opted out (the GLSL's volume and far meshes), an overlay's (the viewmodel), another layer's: never bent
const optOut=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicNodeMaterial()); optOut.userData.presentation=false;
const overlay=new THREE.Group(); overlay.userData.presentationOverlay=true;
const held=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicNodeMaterial()); overlay.add(held);
const hidden=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicNodeMaterial()); hidden.layers.set(5);
// a mesh parked on the guard's layer (gfx/meshLight.js guardMeshes: its pipelines building) waits until it is back
const parkedMesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicNodeMaterial()); parkedMesh.layers.set(31);
const sharer=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),mat);   // (mat, shared: both change)
scene.add(mesh,optOut,overlay,hidden,parkedMesh,sharer); p.install(scene,camera);
assert.equal(mesh.frustumCulled,false); assert.notEqual(mat.vertexNode,own);
for (const o of [optOut,held,hidden,parkedMesh]) { assert.equal(o.material.vertexNode,null); assert.equal(o.frustumCulled,true); }
// the meshes whose program changed, once each: src/wire/mesh.js compiles them before they draw (F8)
assert.deepEqual(new Set(p.takeChanged()),new Set([mesh,sharer])); assert.deepEqual(p.takeChanged(),[]);
p.prepare(scene,camera); assert.deepEqual(p.takeChanged(),[]);
// back from the guard's layer: the next frame's install (src/wire/mesh.js, before the guard) bends and reports it
const frame=() => { p.update(camera,new THREE.Matrix4()); p.install(scene,camera); return p.takeChanged(); };
parkedMesh.layers.set(0); assert.deepEqual(frame(),[parkedMesh]);
// in full once a frame: prepare's install (just before three draws) only meets what the frame's
// didn't (a mesh added since), bends it and doesn't report it (it draws now, whatever three has built)
const late=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicNodeMaterial()); scene.add(late);
p.prepare(scene,camera); assert(late.material.vertexNode); assert.equal(late.frustumCulled,false); assert.deepEqual(p.takeChanged(),[]);
assert.deepEqual(frame(),[]);   // (its program since: unchanged)
// a mesh whose geometry install subdivides (another vertex layout) is reported, its material bent long before
const grows=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),mat); scene.add(grows);
assert.deepEqual(frame(),[grows]); assert.deepEqual(frame(),[]);
const plane=grows.geometry=new THREE.PlaneGeometry(400,400);
assert.deepEqual(frame(),[grows]); assert.notEqual(grows.geometry,plane);
// parked by the guard a while (src/wire/mesh.js parks what it compiles too), it keeps its record: back
// with the program it had, it isn't reported again (else it would be parked again, frame after frame)
const owned=grows.geometry;
grows.layers.set(31); assert.deepEqual(frame(),[]); assert.equal(grows.frustumCulled,false); assert.equal(grows.geometry,owned);
grows.layers.set(0); assert.deepEqual(frame(),[]);
sharer.removeFromParent(); parkedMesh.removeFromParent(); late.removeFromParent(); grows.removeFromParent(); p.prepare(scene,camera);
assert.equal(grows.geometry,plane);   // (restored when it left)
// the uniforms' clip ↔ world pair inverts, through the scene → world transform
const m4=new THREE.Matrix4().multiplyMatrices(p.uniforms.uWarpWorldToClip.value,p.uniforms.uWarpClipToWorld.value);
m4.elements.forEach((v,i) => assert(Math.abs(v-(i%5===0?1:0))<1e-6));
const revision=p.revision;
assert.throws(()=>p.neutral(()=>{assert.equal(p.uniforms.uWarpK.value,0); assert(!p.active); throw new Error('restore');}));
assert(p.active); assert(p.uniforms.uWarpK.value>0);
p.select(null); assert(p.revision>revision); assert.equal(mesh.frustumCulled,true);
assert.equal(mat.vertexNode,own); assert.equal(p.uniforms.uWarpK.value,0);
assert.deepEqual(p.takeChanged(),[mesh]);   // (restored: flat again, another program)
p.select('rollingLog'); p.prepare(scene,camera); mesh.removeFromParent(); assert.equal(mesh.frustumCulled,true);
p.dispose(); assert(!p.active); assert.equal(mat.vertexNode,own);

// ---- the motion pass's reprojection through the bend (gfx/post.js presentationReproject,
// the velocity three's TAAU reads, and the matrices createPost builds for it): a flat point displayed this frame comes back to
// where the last frame displayed it, the camera and the bend's anchor both moved ----
{
  const q=createPresentation(), T=new THREE.Matrix4().makeScale(1/0.1,1/0.1,1/0.1).setPosition(300,0,200);
  q.select('rollingLog');
  const vp=(cam) => new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse);
  const camA=new THREE.PerspectiveCamera(50,1.6,0.05,200); camA.position.set(3,2,4); camA.lookAt(0,0,0); camA.updateMatrixWorld();
  q.update(camA,T);
  const prevWarp=q.parameters, prevWorldToClip=new THREE.Matrix4().multiplyMatrices(vp(camA),q.worldToScene);   // (post: after a frame)
  const camB=camA.clone(); camB.position.set(2.2,2.1,4.6); camB.lookAt(0.3,0,0); camB.updateMatrixWorld();
  q.update(camB,T);
  const cur=q.parameters, invVP=vp(camB).invert(), temporalToWorld=new THREE.Matrix4().multiplyMatrices(q.sceneToWorld,invVP);
  const clipOf=(m,w) => new THREE.Vector4(...w,1).applyMatrix4(m);
  let worst=0;
  for (let i=0;i<64;i++) {
    const P=[300+((i*37)%64)-32,(i*13)%24,200+((i*29)%64)-32];   // world cells around the camera's ground
    const c=clipOf(new THREE.Matrix4().multiplyMatrices(vp(camB),q.worldToScene),warp(P,cur));
    const ndc=new THREE.Vector4(c.x/c.w,c.y/c.w,c.z/c.w,1);                     // this frame's pixel and depth
    const d=ndc.clone().applyMatrix4(temporalToWorld), shown=[d.x/d.w,d.y/d.w,d.z/d.w];
    const back=clipOf(prevWorldToClip,warp(warp(shown,cur,true),prevWarp));   // unwarp now, warp as last frame did
    const want=clipOf(prevWorldToClip,warp(P,prevWarp));
    worst=Math.max(worst,Math.abs(back.x/back.w-want.x/want.w),Math.abs(back.y/back.w-want.y/want.w));
  }
  assert(worst<1e-6, `the motion pass's reprojection through the bend: ${worst}`);
  assert(Math.abs(prevWarp.anchor[0]-cur.anchor[0])>1, 'the case moves the bend\'s anchor');
  // the sky (depth 1) goes by the cameras: bent, post packs the two halves only, and
  // their product is the camera-only reprojection while the scene → world transform holds
  const halves=new THREE.Matrix4().multiplyMatrices(prevWorldToClip,temporalToWorld), cameras=new THREE.Matrix4().multiplyMatrices(vp(camA),invVP);
  let sky=0;
  for (const [x,y] of [[-1,-1],[1,1],[0.3,-0.7],[-0.9,0.2],[0,0]]) {
    const a=new THREE.Vector4(x,y,1,1).applyMatrix4(halves), b=new THREE.Vector4(x,y,1,1).applyMatrix4(cameras);
    sky=Math.max(sky,Math.abs(a.x/a.w-b.x/b.w),Math.abs(a.y/a.w-b.y/b.w));
  }
  assert(sky<1e-9, `motion: the sky's reprojection, bent, is the cameras': ${sky}`);
}
// MotionParams fits one 256-byte slot of the param ring (docs/webgpu.md B4; tools/budgets/post.mjs's upload)
assert(postChecks.find((x) => x.name==='motion').params.size<=256, `MotionParams: ${postChecks.find((x) => x.name==='motion').params.size} bytes`);

const large=new THREE.Mesh(new THREE.PlaneGeometry(128,128));
const split=subdividePresentation(large,MESH_EDGE_CELLS);
assert(split); const a=split.attributes.position;
for (let i=0;i<a.count;i+=3) for (const [j,k] of [[0,1],[1,2],[2,0]])
  assert(new THREE.Vector3().fromBufferAttribute(a,i+j).distanceTo(new THREE.Vector3().fromBufferAttribute(a,i+k))<=MESH_EDGE_CELLS+1e-6);
split.dispose(); large.geometry.dispose(); large.material.dispose(); mat.dispose();

// ---- the WGSL side, statically (the GPU runs it: tools/presentation-check.mjs) ----
const fns = (code) => new Set([...code.matchAll(/\bfn\s+([A-Za-z_]\w*)/g)].map((m) => m[1]));
// every function the GLSL had, under its name (docs/webgpu.md W2)
const twin=fns(presentationWGSL);
for (const f of ['warpPointWith','warpPoint','unwarpPoint','warpVector','warpRay','warpAt','warpSlope','warpRoots','warpPlane','warpSpans',
  'warpInside','warpResume','warpExit','warpChordLimit','warpArcPrimitive','warpArc','warpCell','warpCellAfter','warpEntryAxis'])
  assert(twin.has(f), `presentationWGSL: ${f}`);
assert.equal(presentationGLSL,presentationWGSL);
const near=fns(presentationNearGLSL);
for (const f of ['warpWalk','warpRestart','warpLocate','warpSegment','warpAdvance','warpSkip','warpFloor','warpGridPoint']) assert(near.has(f), `presentationNearWGSL: ${f}`);
assert(!fns(presentationNearWGSL({ skip: false })).has('warpSkip'), 'the pick\'s walk has no brick skipping');
// no GLSL left: the presentation's modules and the passes that bend
const GLSL = /\buniform\s+(float|vec[234]|mat4|bool|int)\b|#define|gl_(FragColor|Position|FragDepth|FragCoord)|\bivec[234]\(|\bvec[234]\(|onBeforeCompile|texelFetch\(/;
const g=gridLayout(64,64,64), Lw=farLayout(WORLD_SIZE);
const modules = {
  presentationWGSL, presentationNearGLSL, pick: pickFrag(g), motion: motionWGSL(), farDetailDepth: farDetailDepthFrag(g),
  ...Object.fromEntries(VOLUME_VIEWS.flatMap((v) => [[`volume.${v}`, volumeFrag(g, { view: v })], [`volume.${v}.curved`, volumeFrag(g, { view: v, curved: true })]])),
};
for (const [name, code] of Object.entries(modules)) assert(!GLSL.test(code.replace(/\/\/[^\n]*/g, '')), `${name}: GLSL left`);
// the curved variants walk the displayed ray (and only they)
for (const v of VOLUME_VIEWS) {
  const flat=modules[`volume.${v}`], curved=modules[`volume.${v}.curved`];
  assert(!/warpWalk|warpUse/.test(flat), `volume.${v}: the flat variant carries none of the bend`);
  for (const call of ['warpUse(P.warpK','warpWalk(','warpSegment(&walk','warpAdvance(&walk','warpFloor(walk','meshInv * vec4f(ndc'])
    assert(curved.includes(call), `volume.${v}.curved: ${call}`);
}
const realisticCurved=modules['volume.realistic.curved'];
for (const call of ['warpSkip(&walk, bc, true)','warpRestart(&walk, ro, rd)','warpGridPoint(hitPos)','MESH_CUT_NONE']) assert(realisticCurved.includes(call), `volume.realistic.curved: ${call}`);
assert(!/meshCutDepth\(h\.depth\)/.test(realisticCurved), 'curved: no mesh cut (its straight-ray distance isn\'t the chord march\'s)');
assert(/meshCutDepth\(h\.depth\)/.test(modules['volume.realistic']), 'flat: the mesh cut');
assert(modules.pick.includes('fn pickCurved') && modules.pick.includes('warpUse(P.ro[i].w'), 'pick: the displayed ray for a curved pick');
// the menu's warm-up (src/preload.js) for a gamemode that bends the view: its curved variants, the ones it draws
for (const v of ['realistic','heat']) {
  const vols=(curved) => warmChecks(v,{},{curved}).filter((x) => x.kind==='render');
  assert(vols(true).length && vols(true).every((x) => x.curved && /warpWalk/.test(x.code(g))), `warmChecks ${v}, curved: the curved variants`);
  assert(vols(false).every((x) => !x.curved && !/warpWalk/.test(x.code(g))), `warmChecks ${v}: the flat ones`);
}
assert(modules.motion.includes('fn presentationReproject') && modules.motion.includes('warpPointWith(flatWorld, P.prevK'), 'motion pass: reprojection through the bend');
const farCurved=farFrag(g,Lw,false,{curved:true}), farFlat=farFrag(g,Lw), farMesh=farFrag(g,Lw,true);
for (const call of ['gFarRay = warpRay(ro, rd)','warpSpans(gFarRay','farPlaneHit(gFarRay','warpResume(t, gFarWorld)','warpArc(transmitted','warpPoint(p)']) assert(farCurved.includes(call), `far view curved: ${call}`);
assert(!farFlat.includes('gFarRay'), 'far view: the flat variant has no parabola');
assert(farMesh.includes('warpPoint(pos)') && modules.farDetailDepth.includes('warpPoint(pos)'), 'the detail meshes bend in their vertex stage, and their depth prepass with them');
assert(modules.farDetailDepth.includes('v.position.z'), 'the depth prepass writes the rasterized depth');
console.log('presentation: mapping, inverse, roots, turn/reentry, tangency, chord bound, TSL vertex bend (chained, idempotent, restored), lifecycle (opt-outs, overlays, layers, the guard\'s parked meshes, changed programs, neutral), mode resolution, motion reprojection algebra, mesh edge bound, WGSL twins (curved variants only, pick, motion pass, far view and meshes, no GLSL) OK');
