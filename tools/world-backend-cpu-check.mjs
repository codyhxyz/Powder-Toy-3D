import { shadowOpticsWGSL } from '../src/shaders/gfx/shadowOptics.js';
// CPU/static/fake-device + actual Naga, NOT GPU numerical/visual evidence.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {WGSL_CHECK as boxChecks,volumeFrag,pickFrag,PickParams,VOLUME_LAYOUTS,PICK_LAYOUTS,REALISTIC_LEVELS,SHADOW_LAYOUTS} from '../src/shaders/render.js';
import {WGSL_CHECK as worldChecks} from '../src/shaders/worldRender.js';
import {lib} from '../src/shaders/gfx/lib.js';
import {tableLayout} from '../src/shaders/common.js';
import {checkPipeline} from './check-sampler-budget.mjs';
import {WorldRenderAtlas,worldBookLayout,worldCellAddress,worldBrickIndex,worldLocalSlot} from '../src/world/renderAtlas.js';
import {createWorldVolume,worldFrameValues,decodeWorldFeedback} from '../src/gfx/worldVolume.js';
import {createWorldAppearance} from '../src/gfx/worldAppearance.js';
import {WorldSunParams,WORLD_SUN_PITCH,worldSunProjection,worldSunTile,worldSunSlot,worldSunFeedbackWords,worldSunResolve} from '../src/world/worldSun.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
test('136 pre-edit Box hashes, explicit Box defaults and layouts remain identical',()=>{
  const hashes=JSON.parse(readFileSync(new URL('./fixtures/world-backend-box-hashes.json',import.meta.url)));
  for(const sourceAppearance of [false,true])for(const size of [32,128]){
    const g={nx:size,ny:size,nz:size,sourceAppearance,sourceGrid:[384,16,128]};
    for(const c of boxChecks())assert.equal(hash(c.code(g)),hashes[`${size}/${sourceAppearance}/${c.name}`],c.name);
    for(const view of ['realistic','cozy','heat','pressure','flow','xray'])for(const curved of [false,true])assert.equal(volumeFrag(g,{view,curved}),volumeFrag(g,{view,curved,backend:'box'}));
    assert.equal(pickFrag(g),pickFrag(g,{backend:'box'}));assert.equal(lib(g),lib(g,{backend:'box'}));
  }
  const layouts=JSON.parse(readFileSync(new URL('./fixtures/world-backend-box-layouts.json',import.meta.url)));
  assert.deepEqual(VOLUME_LAYOUTS(),layouts.volume);assert.deepEqual(PICK_LAYOUTS(),layouts.pick);assert.deepEqual(SHADOW_LAYOUTS(),layouts.shadow);
  assert.deepEqual(VOLUME_LAYOUTS(),VOLUME_LAYOUTS({backend:'box'}));assert.deepEqual(PICK_LAYOUTS(),PICK_LAYOUTS({backend:'box'}));
  assert.throws(()=>volumeFrag({nx:32,ny:32,nz:32},{backend:'reduced'}));
});
test('132 actual world view/detail/curved/source/height/pick layouts and Naga modules',()=>{
  const naga=spawnSync('naga',['--version'],{encoding:'utf8'}); assert.equal(naga.status,0,'install the CPU naga CLI for this gate');
  const dir=mkdtempSync('/tmp/tpt-world-backend-naga-');let n=0;
  try{for(const c of worldChecks()){
    const code=c.code(),groups=c.layouts();
    assert.deepEqual(checkPipeline({code,groups,kind:c.kind}).problems,[],c.name);
    assert.equal(groups.flat().filter(e=>e.texture).length,16);
    assert.equal(groups.flat().filter(e=>e.buffer?.type.includes('storage')).length,c.kind==='compute'?6:5);
    assert.equal(groups[0].find(e=>e.binding===5).buffer.type,'read-only-storage');
    assert.match(code,/fn worldPos\(p: vec3f\) -> vec3f \{ return p; \}/);
    assert.match(code,/fn brickId\(b: vec3i\).*b.x \+ BX \* \(b.y \+ BY \* b.z\)/);
    assert.doesNotMatch(code,/farCasterDepth|farBeyond|farShadeMaterial|LIQ_WINDOW_FADE|homogeneous liquid beyond/);
    const path=`${dir}/${c.name}.wgsl`;writeFileSync(path,code);
    const result=spawnSync('naga',[path,`${dir}/out.spv`],{encoding:'utf8'});
    assert.equal(result.status,0,`${c.name}\n${result.stdout}\n${result.stderr}`);n++;
  }}finally{rmSync(dir,{recursive:true,force:true});}
  assert.equal(n,132);console.log(`Naga: ${n} actual world modules passed`);
});
test('one continuous full tracer, intrinsic budgets, exact optics and sticky secondary misses',()=>{
  const g={nx:3072,ny:384,nz:1024,maxSteps:128,sourceAppearance:true,sourceGrid:[128,0,128]};
  const code=volumeFrag(g,{backend:'world',detail:REALISTIC_LEVELS.full()});
  assert.match(code,/MAX_STEPS: i32 = 4488/);assert.match(code,/return worldFlow\(c\)/);assert.match(code,/let f = worldAeration\(c\)/);
  assert.match(code,/return worldFieldCubic\(t, p\)/);assert.match(code,/unpack4x8unorm\(worldDeco\(c\)\)/);
  for(const name of ['gatherSurf','crispSurf','grainSurf','decoSurf','shadeSurf','liquidInterface','reflectTrace','shadowTexel','worldSunExact','giIrradiance'])assert.ok(new RegExp(`fn ${name}\\(`).test(code),name);
  assert.equal((code.match(/worldBeginQuery\(\);/g)||[]).length,1);
  assert.equal((code.match(/worldIncomplete = false/g)||[]).length,1);
  assert.match(code,/worldEndQuery\(\); if \(worldQueryIncomplete\(\)\)/);
  assert.match(code,/gThin = thin; gCrysOn = on;/);
  assert.match(code,/tau \+= meanSigma\(id\) \* \(tExit - tEnter\)/);
  assert.match(code,/let k = dot\(MD_EXT.xy/);assert.match(code,/dot\(\(vec2f\(pixel\)\+0.5-q.xy\)/);
  assert.doesNotMatch(code,/let ns = max\(dot\(n, FU.sun\)/);
  assert.match(code,/textureLoad\(worldSourceAppearance/);assert.doesNotMatch(code,/var tFarGrid/);
  // Same production arithmetic, not merely matching entry-point names.
  const box=volumeFrag(g,{detail:REALISTIC_LEVELS.full()});
  const body=(text,name)=>{
    text=text.replace(/\/\/[^\n]*/g,''); const begin=text.indexOf(`fn ${name}(`);assert.ok(begin>=0,name);
    let end=text.indexOf('{',begin),depth=1;const start=end;
    while(depth&&++end<text.length){if(text[end]==='{')depth++;else if(text[end]==='}')depth--;}
    assert.equal(depth,0,name);return text.slice(start,end+1);
  };
  for(const name of ['gatherSurf','crispSurf','grainSurf','decoSurf','shadeSurf','liquidInterface','reflectTrace','reflectHit','mediaSegment','surfRoot','surfCross','faceAO','fieldAO','ggxSpecA','envBRDF','envReflectGI','glintSpec','shadowTexelAtt','underPool','causticGain','sourceShade'])assert.equal(body(code,name),body(box,name),name);
  const native=volumeFrag({...g,sourceAppearance:false},{backend:'world'});assert.doesNotMatch(native,/fn sourcePair/);
  assert.match(pickFrag(g,{backend:'world'}),/r = Pick\(vec4f\(0.0,0.0,0.0,-2.0\)/);
});
test('virtual brick key/inverse and occupancy bit/raw slot are not mixed at 4/32/128 edges',()=>{
  const book=worldBookLayout([3072,384,1024]);
  const inverse=id=>[id%book.bricks[0],Math.floor(id/book.bricks[0])%book.bricks[1],Math.floor(id/(book.bricks[0]*book.bricks[1]))];
  for(const edge of [4,32,128,1536,1552])for(const delta of [-.001,0,.001]){
    const c=[Math.floor(edge+delta),127,511],a=worldCellAddress(book,c);
    assert.deepEqual(inverse(a.index),a.brick);assert.equal(worldBrickIndex(book,a.brick),a.index);
  }
  let differs=0;for(let z=0;z<4;z++)for(let y=0;y<4;y++)for(let x=0;x<4;x++)if(worldLocalSlot([x,y,z])!==x+4*y+16*z)differs++;
  assert.ok(differs>0);
  // Independent CPU DDA/address reference (does not execute the WGSL).
  // Long world ray crosses 4/32/128 boundaries and terminates at the WORLD
  // face, including ties at brick corners, with no page-relative restart.
  const size=book.worldSize,ro=[.5,.5,.5],rd=[1,.1,.3],cell=ro.map(Math.floor),step=rd.map(Math.sign);
  const delta=rd.map(v=>Math.abs(1/v)),next=cell.map((v,i)=>(v+1-ro[i])/rd[i]);
  const pages=new Set();let steps=0,last=-1;
  while(cell.every((v,i)=>v>=0&&v<size[i])){
    const a=worldCellAddress(book,cell);assert.deepEqual(inverse(a.index),a.brick);pages.add(a.index);
    let axis=next[0]<=next[1]&&next[0]<=next[2]?0:next[1]<=next[2]?1:2;
    assert.ok(next[axis]>=last);last=next[axis];cell[axis]+=step[axis];next[axis]+=delta[axis];steps++;
    assert.ok(steps<=size.reduce((a,b)=>a+b,8));
  }
  assert.equal(cell[0],3072);assert.ok(steps>3072);assert.ok(pages.size>128);
});
test('SunParams offsets, fixed pitch, pole-safe matrices and signed cross-tile texel centres',()=>{
  assert.equal(WorldSunParams.size,128);
  for(const [name,offset] of Object.entries({worldToLight:0,depth:64,tiles:80,physical:96,version:112}))assert.equal(WorldSunParams.offsetOf(name),offset);
  for(const ny of [128,384])for(const sun of [[1,.01,0],[1,0,0],[0,1,0],[0,-1,0]]){
    const p=worldSunProjection([3072,ny,1024],sun);assert.equal(p.depth[2],WORLD_SUN_PITCH);assert.ok(p.worldToLight.every(Number.isFinite));
    const {u,v,sun:s}=p.basis; const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
    assert.ok(Math.abs(dot(u,v))<1e-12&&Math.abs(dot(u,s))<1e-12);
    assert.equal(worldSunFeedbackWords(p.tiles),Math.ceil(p.tiles[2]*p.tiles[3]/32));
  }
  for(const pixel of [[-257,-1],[-256,0],[-1,255],[0,256],[255,255],[256,256]]){
    const a=worldSunTile(pixel,[-2,-2,5,5],1);assert.ok(a.index>=0);assert.ok(a.local.every(n=>n>=0&&n<256));
    assert.deepEqual(pixel,a.tile.map((n,i)=>n*256+a.local[i]));
    assert.equal(worldSunSlot(63,a.local)[2],0);assert.equal(worldSunSlot(64,a.local)[2],1);
  }
  const params={...worldSunProjection([3072,128,1024],[1,.01,0]),physical:[256,8,64,1],version:[4,8,12,100]};
  const sunBook=new Uint32Array(params.tiles[2]*params.tiles[3]*8),pixel=[0,0];
  const address=worldSunTile(pixel,params.tiles,1),at=address.index*8;
  sunBook.set([0,4,8,12,9,17,1,0],at);
  assert.equal(worldSunResolve(pixel,params,sunBook,4).incomplete,false);
  for(const [word,value] of [[1,3],[2,7],[3,11],[6,0],[0,64]]){
    const saved=sunBook[at+word];sunBook[at+word]=value;assert.equal(worldSunResolve(pixel,params,sunBook,4).incomplete,true);sunBook[at+word]=saved;
  }
  assert.equal(worldSunResolve(pixel,params,sunBook,5).incomplete,true);
  // Receiver-plane comparison at actual quantized centres: no slope bias
  // self-shadow on a low sun plane; a real thin blocker still occludes.
  const ns=.01,slope=[0,Math.sqrt(1-ns*ns)/ns],q=[255.8,255.9,500];
  for(const pixel of [[255,255],[256,255],[255,256],[256,256]]){
    const d=q[2]+((pixel[0]+.5-q[0])*slope[0]+(pixel[1]+.5-q[1])*slope[1])*WORLD_SUN_PITCH;
    assert.ok(d<d+.002);assert.ok(!(d<d-.05+.002));
  }
});
function fakeGPU(){
  const buffers=[],textures=[],calls=[];
  const device={limits:{},queue:{writeBuffer(b,off,raw){const a=raw instanceof ArrayBuffer?new Uint8Array(raw):new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength);b.data.set(a,off);},writeTexture(...args){calls.push(['texture',...args]);},submit(){},onSubmittedWorkDone:()=>Promise.resolve()},
    createBuffer(d){const b={...d,data:new Uint8Array(d.size),destroy(){this.dead=true;}};buffers.push(b);return b;},
    createTexture(d){const t={...d,createView:()=>({texture:t}),destroy(){this.dead=true;}};textures.push(t);return t;},
    createBindGroupLayout:d=>d,createPipelineLayout:d=>d,createSampler:d=>d,
    createShaderModule(d){return d;},
    async createRenderPipelineAsync(d){assert.ok(d.vertex.module===d.fragment.module);assert.equal(d.vertex.entryPoint,'vs');assert.equal(d.fragment.entryPoint,'fs');assert.deepEqual(checkPipeline({code:d.vertex.module.code,groups:d.layout.bindGroupLayouts.map(l=>l.entries),kind:'render'}).problems,[]);calls.push(['pipeline',d]);return d;},
    async createComputePipelineAsync(d){assert.deepEqual(checkPipeline({code:d.compute.module.code,groups:d.layout.bindGroupLayouts.map(l=>l.entries),kind:'compute'}).problems,[]);return d;},
    createBindGroup(d){assert.deepEqual(d.entries.map(e=>e.binding).sort((a,b)=>a-b),d.layout.entries.map(e=>e.binding).sort((a,b)=>a-b));for(const e of d.entries){const b=d.layout.entries.find(x=>x.binding===e.binding);if(b.buffer)assert.ok(e.resource.buffer.size>=(b.buffer.minBindingSize??0));}return d;},
  };return {device,buffers,textures,calls};
}
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
test('actual world assembly, immutable frame conversion, view/pick resources and feedback lifetime',async()=>{
  const gpu=fakeGPU(),g={nx:128,ny:128,nz:128,sourceAppearance:true},sun=worldSunProjection([128,128,128],[1,.01,0]);
  const compilePick=gpu.device.createComputePipelineAsync;
  let finishPick;
  gpu.device.createComputePipelineAsync=async d=>{
    await new Promise(resolve=>{finishPick=resolve;});
    return compilePick(d);
  };
  const extra=worldSunFeedbackWords(sun.tiles);
  const atlas=new WorldRenderAtlas(gpu,{worldSize:[128,128,128],initialCapacity:1,feedbackExtraWords:extra,retire:fn=>fn()});
  const appearance=createWorldAppearance(gpu,{words:new Uint32Array([0x80000000,0x7fc12345,0xffffffff,0x12345678]),width:2,depth:1});
  const uploaded=gpu.calls.find(c=>c[0]==='texture')[2];assert.deepEqual(Array.from(uploaded),[0,32768,9029,32705,65535,65535,22136,4660]);
  const lighting={params:{...sun,physical:[256,8,64,1],version:[1,1,1,atlas.bookLayout.requestBytes/4+1]},book:gpu.device.createBuffer({size:sun.tiles[2]*sun.tiles[3]*32}),sun0:{rgba32float:true},sun1:{r32float:true}};
  atlas.publish({sunManifest:{epoch:1,basisRevision:1,publishRevision:1,dependencySetID:0,dependencyVersion:0,book:lighting.book,sun0:lighting.sun0,sun1:lighting.sun1,params:lighting.params}});
  const manifestSnapshot=atlas.snapshot();
  assert.ok(Object.isFrozen(manifestSnapshot.sunManifest.params.depth));
  assert.notEqual(manifestSnapshot.sunManifest.params.depth,lighting.params.depth);
  assert.equal(manifestSnapshot.sunManifest.book,lighting.book);manifestSnapshot.release();
  const volume=createWorldVolume(gpu,{g,atlas,tables:gpu.device.createBuffer({size:tableLayout().Tables.size}),lighting,appearance});
  const original={cam:[200,20,30],viewProj:I,model:I,lampPos:[[1,2,3,4]],wandLightPosition:[[5,6,7,8]],digMin:[1,2,3,.5],digMax:[2,3,4,1],beacon:[100,100,100,10]};
  const before=JSON.stringify(original);const converted=worldFrameValues(original,[1536,0,512]);assert.deepEqual(converted.lampPos[0],[1537,2,515,4]);assert.deepEqual(converted.wandLightPosition[0],[1541,6,519,8]);assert.deepEqual(converted.cam,original.cam);assert.deepEqual(converted.beacon,original.beacon);assert.equal(JSON.stringify(original),before);
  const candidate=volume.prepare({frameUniforms:original,physicsOrigin:[1536,0,512],params:{meshInv:I,meshRes:[1,1],meshCut:0,marchNear:0,aerCopy:0,deco:1,warpK:0,warpAnchor:[0,0],warpDir:[0,1]},external:{mediaNoise:{},packedMesh:{}}});
  const log=[];const pass={setPipeline:p=>log.push('pipe'),setBindGroup:(i,g)=>log.push(i),draw:n=>log.push(n)};
  const realistic=volume.pipelineState('realistic');assert.equal(realistic.state,'pending');
  assert.equal(candidate.recordDraw(pass),false);assert.deepEqual(log,[]);
  await candidate.draw(pass);assert.deepEqual(log,['pipe',0,1,2,3,14]);
  assert.equal(realistic.state,'ready');assert.ok(realistic.pipeline);
  log.length=0;assert.equal(candidate.recordDraw(pass),true);assert.deepEqual(log,['pipe',0,1,2,3,14]);
  await candidate.draw(pass,{view:'heat',curved:true});assert.equal(log.at(-1),3);
  const drawOptions={view:'realistic',detail:{},curved:false},drawing=candidate.draw(pass,drawOptions);
  drawOptions.view='heat';drawOptions.curved=true;drawOptions.detail.media=true;
  await drawing;assert.equal(log.at(-1),14,'draw uses the privately captured view/detail/curvature after await');
  const encoder={beginComputePass(){return {...pass,dispatchWorkgroups:n=>log.push(['dispatch',n]),end:()=>log.push('end')};}};
  const pickParams={ro:[[1,2,3,0]],rd:[[1,0,0,0]],warp:[[0,0,0,1]],slot:[[0,0,0,0]],n:1};
  const pickOutput=gpu.device.createBuffer({size:32}),beforePendingPick=[...log];
  assert.equal(candidate.recordPickReady(encoder,{params:pickParams,output:pickOutput}),false);assert.deepEqual(log,beforePendingPick);
  const picking=candidate.recordPick(encoder,{params:pickParams,output:pickOutput});
  pickParams.ro[0][0]=123;pickParams.slot[0][0]=99;pickParams.n=8;
  finishPick();await picking;await volume.ready;
  assert.equal(log.at(-1),'end');
  const recordedPick=new DataView(gpu.buffers.find(b=>b.label==='world pick params').data.buffer);
  assert.equal(recordedPick.getFloat32(PickParams.offsets.ro,true),1);
  assert.equal(recordedPick.getUint32(PickParams.offsets.slot,true),0);
  assert.equal(recordedPick.getUint32(PickParams.offsets.n,true),1);
  const syncParams={ro:[[2,3,4,0]],rd:[[1,0,0,0]],warp:[[0,0,0,1]],slot:[[0,0,0,0]],n:1};
  assert.equal(candidate.recordPickReady({direct:()=>encoder},{params:syncParams,output:pickOutput}),true);assert.equal(log.at(-1),'end');
  gpu.device.createRenderPipelineAsync=async()=>{throw new Error('compile failure fixture');};
  const failed=volume.pipelineState('pressure');await assert.rejects(failed.ready,/compile failure/);assert.equal(failed.state,'failed');
  const beforeFailedDraw=[...log];assert.equal(candidate.recordDraw(pass,{view:'pressure'}),false);assert.deepEqual(log,beforeFailedDraw);
  const words=new Uint32Array(atlas.feedbackBytes/4);assert.equal(candidate.decodeFeedback(words).incomplete,false);
  words[0]=1;words[atlas.bookLayout.requestBytes/4]=1;words[atlas.bookLayout.requestBytes/4+1]=2;
  words[3*atlas.bookLayout.planeWords]=4;words[5*atlas.bookLayout.planeWords]=8;
  const missing=candidate.decodeFeedback(words);assert.deepEqual(missing.geometry,[0]);assert.deepEqual(missing.sun,[1]);assert.equal(missing.incomplete,true);
  assert.deepEqual(missing.requirements,[{index:0,brick:[0,0,0],channels:1},{index:2,brick:[2,0,0],channels:8},{index:3,brick:[3,0,0],channels:32}]);
  assert.throws(()=>decodeWorldFeedback(words.subarray(0,1),atlas.bookLayout,1));
  const badLighting={...lighting,params:{...lighting.params,depth:[...lighting.params.depth]}};
  badLighting.params.depth[0]++;
  assert.throws(()=>volume.prepare({frameUniforms:original,physicsOrigin:[0,0,0],lighting:badLighting}),/pinned sun manifest/);
  assert.throws(()=>volume.prepare({snapshot:{abi:1,epoch:1,release(){}},lighting}),/stale atlas ABI/);
  candidate.release();assert.equal(candidate.feedback.dead,true);await assert.rejects(()=>candidate.draw(pass));
  assert.throws(()=>volume.prepare({frameUniforms:original,physicsOrigin:[0,0,0],lighting:{}}),/publication/);
  const stale=volume.prepare({frameUniforms:original,physicsOrigin:[0,0,0],params:{meshInv:I,meshRes:[1,1]},external:{mediaNoise:{},packedMesh:{}}});
  atlas.reset();await assert.rejects(()=>stale.draw(pass),/stale world candidate epoch/);stale.release();
  const supplied=atlas.snapshot(),finalBook=supplied.book;
  volume.dispose();
  assert.throws(()=>volume.prepare(),/disposed/); // no default snapshot acquired
  assert.throws(()=>volume.prepare({snapshot:supplied}),/disposed/); // transferred pin released
  appearance.dispose();atlas.dispose();assert.equal(finalBook.dead,true);
});

test('native world point reader full shared library with independent LIGHT/source leafs fits 16 textures / six storage buffers',()=>{
  const dir=mkdtempSync('/tmp/tpt-world-point-naga-');
  try {
    for(const h of [128,384])for(const sourceAppearance of [false,true]) {
      const g={nx:3072,ny:h,nz:1024,sourceAppearance,sourceGrid:[128,0,128]};
      // Same native common layout as the pick output slot. This is a checked
      // reader assembly, not application figure/hand/point integration.
      const groups=PICK_LAYOUTS({backend:'world'});
      const code=lib(g,{backend:'world'})+shadowOpticsWGSL({backend:'world'})+`
@group(3) @binding(6) var<storage,read_write> pointOut: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  worldBeginQuery(); worldSunValidate();
  let p=FU.cam; let pr=probeAt(p); let src=worldGISource(vec3i(p)/4);
  let v=giIrradiance(pr,vec3f(0.0,1.0,0.0))+worldLight(p)+sunShadowAt(p)*0.0;
  worldEndQuery();
  pointOut[0]=vec4f(v,select(1.0,-1.0,worldQueryIncomplete()));
}`;
      assert.deepEqual(checkPipeline({code,groups,kind:'compute'}).problems,[]);
      assert.equal(groups.flat().filter(e=>e.texture).length,16);
      assert.equal(groups.flat().filter(e=>e.buffer?.type.includes('storage')).length,6);
      const path=`${dir}/point-${h}-${sourceAppearance}.wgsl`;writeFileSync(path,code);
      const result=spawnSync('naga',[path],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
