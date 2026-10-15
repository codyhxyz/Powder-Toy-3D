// Independent numerical CPU fixtures + real factory/Naga/native recording.
// These references DO NOT execute WGSL or prove CPU == GPU.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {WGSL_CHECK,worldSunWriterLayouts,worldSunWriter} from '../src/shaders/worldSunWriter.js';
import {createWorldSunLighting,worldSunBoundsTiles} from '../src/gfx/worldSunLighting.js';
import {worldSunProjection,worldSunResolve,WORLD_SUN_PITCH} from '../src/world/worldSun.js';
import {checkPipeline} from './check-sampler-budget.mjs';
import {ELEMENTS,E} from '../src/elements.js';
import {MEDIA,MEDIA_FLOOR} from '../src/gfx/materials.js';
const dot=(a,b)=>a.reduce((s,n,i)=>s+n*b[i],0),add=(a,b,k=1)=>a.map((n,i)=>n+k*b[i]);
const near=(a,b,e=1e-8)=>assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);
const mean=a=>a.reduce((s,n)=>s+n,0)/3;
function rayBox(ro,rd,min,max) {
  let lo=-1e30,hi=1e30;
  for(let i=0;i<3;i++) {
    if(rd[i]===0){if(ro[i]<min[i]||ro[i]>max[i])return null;continue;}
    const a=(min[i]-ro[i])/rd[i],b=(max[i]-ro[i])/rd[i];lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));
  }
  return hi>Math.max(0,lo)?[Math.max(0,lo),hi]:null;
}
// Analytic chords of exact test solids (liquid/media may overlap). Color selection and
// accumulation follow the original optical RECORD contract, not a new renderer.
function optical(chords,{floor=1e5,opaque=1e5}={}) {
  let start=1e5,end=1e5,id=0,tau=0,kind=null;
  opaque=Math.min(opaque,...chords.filter(c=>c.kind==='opaque').map(c=>c.start));
  for(const c of [...chords].sort((a,b)=>a.start-b.start)) {
    if(c.start>=opaque)continue;const stop=Math.min(c.end,opaque);
    if(c.kind==='opaque'){opaque=Math.min(opaque,c.start);continue;}
    const k=c.kind==='gas'?c.transport:mean(c.sigma);
    if(c.kind==='gas'&&k<=1e-4)continue;
    if(id===0||kind==='gas'&&c.kind!=='gas') {if(id===0)start=c.start;id=c.id;kind=c.kind;}
    tau+=k*(stop-c.start);end=Math.max(end===1e5?0:end,stop);
  }
  const sun0=new Float32Array([Math.min(opaque,floor),start,end,id*256+Math.min(tau,255)]);
  return {sun0,sun1:new Float32Array([sun0[0]]),id,tau};
}
function attenuation(sm,d,sigma) {
  const id=Math.trunc(sm[3]/256),tau=sm[3]-id*256,frac=Math.max(0,Math.min(1,(d-sm[1])/Math.max(sm[2]-sm[1],1e-3)));
  return sigma.map(s=>Math.exp(-s/Math.max(mean(sigma),1e-4)*tau*frac));
}
test('actual full optical factory: six sampled / three storage / two images / four groups, Naga heights/source variants',()=>{
  assert.equal(spawnSync('naga',['--version']).status,0,'CPU Naga CLI required');
  const dir=mkdtempSync('/tmp/tpt-world-sun-naga-');let n=0;
  try {for(const c of WGSL_CHECK()) {
    const code=c.code(),groups=c.layouts();
    assert.deepEqual(checkPipeline({code,groups,kind:'compute'}).problems,[],c.name);
    assert.equal(groups.flat().filter(e=>e.texture).length,6);
    assert.equal(groups.flat().filter(e=>e.buffer?.type.includes('storage')).length,3);
    assert.equal(groups.flat().filter(e=>e.storageTexture).length,2);assert.equal(groups.length,4);
    assert.doesNotMatch(code,/var (worldSunOptical|worldSunDepth|worldGI|worldPackedMesh|worldSourceAppearance)|fn (farCasterDepth|farBeyond|warpAt|sunMapShadow)\(/);
    assert.match(code,/MAX_STEPS: i32 = (4232|4488)/);
    const path=`${dir}/${c.name}.wgsl`;writeFileSync(path,code);
    const r=spawnSync('naga',[path,`${dir}/out.spv`],{encoding:'utf8'});assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);n++;
  }}finally{rmSync(dir,{recursive:true,force:true});}
  console.log(`Naga: ${n} actual full optical world sun modules passed (uniform sun covers low/horizontal/poles)`);
  assert.equal(worldSunWriter({nx:128,ny:128,nz:128,curved:true}),worldSunWriter({nx:128,ny:128,nz:128,curved:false}));
});
test('physical depth-zero light plane, signed texels, exact-zero axes and thin blockers including all world exits',()=>{
  for(const sun of [[1,.01,0],[1,0,0],[0,1,0],[0,-1,0],[0,0,1],[1,1e-12,0],[-1,.01,0]]) {
    const p=worldSunProjection([3072,384,1024],sun),{u,v,sun:s}=p.basis;
    for(const point of [[1664,200,512],[0,0,0],[3072,384,1024],[800,30,10]]) {
      const xy=[dot(u,point)/WORLD_SUN_PITCH,dot(v,point)/WORLD_SUN_PITCH];
      const ro=add(add(u.map(n=>n*(Math.floor(xy[0])+.5)*WORLD_SUN_PITCH),v,(Math.floor(xy[1])+.5)*WORLD_SUN_PITCH),s,p.depth[0]);
      near(p.depth[0]-dot(ro,s),0,1e-9);
      const d=100.25,hit=add(ro,s,-d);near(p.depth[0]-dot(hit,s),d,1e-9);
      const projected=[0,1,2].map(row=>p.worldToLight[row]*hit[0]+p.worldToLight[4+row]*hit[1]+p.worldToLight[8+row]*hit[2]+p.worldToLight[12+row]);
      near(projected[2],d,1e-9);
    }
  }
  assert.deepEqual(rayBox([0,4,4],[0,-1,0],[0,0,0],[8,8,8]),[0,4]);
  assert.equal(rayBox([-1,4,4],[0,-1,0],[0,0,0],[8,8,8]),null);
  assert.equal(rayBox([4,9,4],[0,1,0],[0,0,0],[8,8,8]),null);
  const chord=rayBox([4,9,4],[0,-1,0],[3,4.99,3],[5,5,5]);near(chord[1]-chord[0],.01);
  const record=optical([{start:chord[0],end:chord[1],kind:'opaque'}]);near(record.sun0[0],4);
  assert.equal(record.sun1[0],record.sun0[0]);
  assert.deepEqual(Array.from(optical([]).sun0),[1e5,1e5,1e5,0]);
  assert.deepEqual(Array.from(optical([],{floor:9}).sun0),[9,1e5,1e5,0]);
});
test('quantized receiver-plane fixtures agree with physical writer depths, including thin true blockers',()=>{
  for(const direction of [[1,.01,0],[0,1,0],[0,-1,0],[1,0,0],[0,0,1]]) {
    const p=worldSunProjection([3072,384,1024],direction),{u,v,sun}=p.basis,hp=[1664,150,512];
    for(const n of [[0,1,0],[1,1,1],[.01,1,.02]]) {
      const ns=dot(n,sun);if(Math.abs(ns)<1e-5)continue;
      const q=[dot(u,hp)/WORLD_SUN_PITCH,dot(v,hp)/WORLD_SUN_PITCH,p.depth[0]-dot(sun,hp)];
      for(const offset of [[0,0],[1,-1],[-3,2]]) {
        const pixel=q.slice(0,2).map((x,i)=>Math.floor(x)+offset[i]);
        const ro=add(add(u.map(x=>x*(pixel[0]+.5)*WORLD_SUN_PITCH),v,(pixel[1]+.5)*WORLD_SUN_PITCH),sun,p.depth[0]);
        const writerDepth=(dot(n,ro)-dot(n,hp))/ns;
        const readerDepth=q[2]+((pixel[0]+.5-q[0])*dot(n,u)+(pixel[1]+.5-q[1])*dot(n,v))*WORLD_SUN_PITCH/ns;
        near(writerDepth,readerDepth,1e-7);assert.ok(readerDepth<writerDepth+.002);assert.ok(!(readerDepth<writerDepth-.01+.002));
      }
    }
  }
});
test('actual original material coefficients: stacked/tinted glass, overlapping liquid/media, gas replacement and quantized IDs',()=>{
  const sigma=key=>ELEMENTS[E[key]].sigma;
  const transport=m=>MEDIA.slice(0,2).reduce((sum,gas,i)=>sum+gas.ext*(1-gas.albedo*gas.g)*Math.max(0,m[i]-MEDIA_FLOOR)/(1-MEDIA_FLOOR),0);
  const dm=[.8,.4],k=transport(dm);assert.ok(k>0);
  const liquid=optical([
    {start:1,end:3,kind:'gas',id:E.SMOKE,transport:k},
    {start:2,end:9,kind:'liquid',id:E.WATER,sigma:sigma('WATER')},
    {start:3,end:8,kind:'gas',id:E.STEAM,transport:k},
    {start:9,end:10,kind:'opaque'},
  ]);
  assert.equal(liquid.id,E.WATER);near(liquid.tau,k*7+mean(sigma('WATER'))*7);near(liquid.sun0[1],1);
  const glass=optical([{start:2,end:8,kind:'glass',id:E.GLASS,sigma:sigma('GLASS')},{start:10,end:12,kind:'glass',id:E.CRYSTAL,sigma:sigma('CRYSTAL')}]);
  assert.equal(glass.id,E.GLASS);near(glass.tau,6*mean(sigma('GLASS'))+2*mean(sigma('CRYSTAL')));
  const color=attenuation(glass.sun0,20,sigma('GLASS'));assert.ok(color[0]<color[1]&&color[0]<color[2]);assert.equal(glass.sun1[0],glass.sun0[0]);
  near(glass.sun0[3]-E.GLASS*256,glass.tau,1/256+.00001);
  assert.equal(transport([MEDIA_FLOOR,MEDIA_FLOOR]),0);
});
test('offscreen roof full-world shadow and glass multiray/overlap/liquid/media/caustic/crystal optical references',()=>{
  const receiver=[100,2,50],sun=[1/Math.sqrt(2),1/Math.sqrt(2),0],ro=add(receiver,sun,800),rd=sun.map(n=>-n);
  // Roof hundreds of cells outside the receiver camera box, still on this ray.
  const chord=rayBox(ro,rd,[490,392,49],[510,412,51]);assert.ok(chord);
  const roof=optical([{kind:'opaque',start:chord[0],end:chord[1]}]);assert.ok(roof.sun0[0]<800);
  const sigma=[.05,.2,.8];
  for(const x of [-.8,-.2,0,.3,.9]) {
    const ray=[x,10,0],dir=[0,-1,0],chords=[];
    for(const [min,max,id] of [[[-1,6,-1],[1,8,1],200],[[-.5,2,-1],[.5,4,1],201]]) {
      const c=rayBox(ray,dir,min,max);if(c)chords.push({start:c[0],end:c[1],id,kind:'glass',sigma});
    }
    const r=optical(chords);near(r.tau,mean(sigma)*(Math.abs(x)<=.5?4:2));assert.equal(Math.trunc(r.sun0[3]/256),200);
    const a=attenuation(r.sun0,20,sigma);assert.ok(a[0]>a[1]&&a[1]>a[2]);assert.equal(r.sun1[0],r.sun0[0]);
    near(r.sun0[3]-200*256,r.tau,1/256+.00001);
  }
  const mixture=optical([
    {start:1,end:2,kind:'gas',id:4,transport:.2},
    {start:2,end:4,kind:'glass',id:240,sigma},
    {start:4,end:9,kind:'liquid',id:2,sigma:[.02,.03,.04]},
    {start:9,end:10,kind:'opaque'},
    {start:11,end:12,kind:'glass',id:241,sigma},
  ]);assert.equal(mixture.id,240);near(mixture.tau,.2+2*mean(sigma)+5*.03);near(mixture.sun0[0],9);near(mixture.sun0[1],1);near(mixture.sun0[2],9);
  const gas=optical([{start:2,end:12,kind:'gas',id:4,transport:.18}]);near(gas.tau,1.8);
  assert.deepEqual(Array.from(optical([{start:2,end:12,kind:'gas',id:4,transport:1e-5}]).sun0),[1e5,1e5,1e5,0]);
  // Thin liquid film: trapezoid samples are the shared writer convention.
  const filmLength=.5*((0+1)*.1+(1+0)*.1);near(filmLength,.1);
  const pool=optical([{start:2,end:10,kind:'liquid',id:2,sigma:[.03,.03,.03]}]);
  const len=(pool.sun0[3]-2*256)/.03;assert.ok(len>=.7*(9-pool.sun0[1]));
  const caustic=(lap,D)=>Math.max(.3,Math.min(4,1/Math.max(1+D*.25*lap,1e-3)));
  assert.ok(caustic(-.2,4)>1&&caustic(.2,4)<1);
  // Analytic hexagonal prism chord, rather than a whole occupied crystal cell.
  const radius=.2,hexChord=2*radius/Math.cos(Math.PI/6),crystal=optical([{start:3,end:3+hexChord,kind:'crystal',id:250,sigma}]);
  near(crystal.tau,mean(sigma)*hexChord);assert.ok(crystal.tau<mean(sigma));
  const saturated=optical([{start:1,end:1001,kind:'glass',id:255,sigma:[10,10,10]}]);assert.equal(saturated.sun0[3],255*256+255);assert.equal(Math.trunc(saturated.sun0[3]/256),255);
});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture({g={nx:3072,ny:384,nz:1024}}={}) {
  const buffers=[],textures=[],events=[],tickets=[],uses=[];let current=1,epoch=1,pins=0,missing=false;
  const device={limits:{maxTextureArrayLayers:256,maxTextureDimension2D:8192},queue:{
    writeBuffer(b,off,raw){b.bytes.set(new Uint8Array(raw.buffer??raw,raw.byteOffset??0,raw.byteLength),off);},
    submit(){throw new Error('producer must NOT submit');},onSubmittedWorkDone(){events.push('queue-done-request');return tickets.at(-1).done.promise;}},
    createBuffer(d){const b={...d,bytes:new Uint8Array(d.size),destroy(){this.dead=true;events.push(`destroy ${d.label}`);}};buffers.push(b);return b;},
    createTexture(d){const t={...d,createView:()=>({texture:t}),destroy(){this.dead=true;}};textures.push(t);return t;},
    createBindGroupLayout:d=>d,createPipelineLayout:d=>d,createShaderModule:d=>d,
    createComputePipelineAsync:async d=>{assert.deepEqual(checkPipeline({code:d.compute.module.code,groups:d.layout.bindGroupLayouts.map(l=>l.entries),kind:'compute'}).problems,[]);return d;},
    createBindGroup(d){assert.deepEqual(d.entries.map(e=>e.binding).sort(),d.layout.entries.map(e=>e.binding).sort());for(const e of d.entries){const desc=d.layout.entries.find(x=>x.binding===e.binding);if(desc.buffer)assert.ok(e.resource.buffer.size>=desc.buffer.minBindingSize);if(desc.texture)assert.equal(e.resource.sampleType,desc.texture.sampleType);if(desc.storageTexture)assert.equal(e.resource.texture.format,desc.storageTexture.format);}return d;},
  };
  const sourceFieldSnapshotProvider={async acquire(){pins++;const revision=current;let live=true;return {worldSize:[g.nx,g.ny,g.nz],epoch,source:{contentToken:`content${revision}`,sourceRevision:revision},field:{publishedToken:`field${revision}`,complete:true,sourceRevision:revision,logicalFieldTick:revision},dependencySetID:7,dependencyVersion:revision,revision,release(){assert.ok(live);live=false;pins--;}};},isCurrent:s=>s.revision===current};
  const readerBindingProvider=()=>worldSunWriterLayouts().slice(0,2).map(entries=>entries.map(e=>({binding:e.binding,resource:e.buffer?{buffer:device.createBuffer({label:'borrowed',size:e.buffer.minBindingSize,usage:0})}:{sampleType:e.texture.sampleType}})));
  const feedbackProvider={layout({tileCount,sunTileCount}){const requestWordOffset=23,jobStatusWordOffset=23+Math.ceil(sunTileCount/32);return {wordCount:jobStatusWordOffset+tileCount,requestWordOffset,jobStatusWordOffset,decode:words=>({incomplete:words[17]!==0,raw:[...words.slice(0,6)],field:[...words.slice(6,12)]})};},reserve(){const submitted=deferred(),done=deferred(),read=deferred();const ticket={submitted,done,read};tickets.push(ticket);return {submitted:submitted.promise,record(frame,b){events.push('readback-after-dispatch');ticket.buffer=b;ticket.words=new Uint32Array(b.size/4);for(const u of uses.splice(0)){const view=new DataView(u.bytes.buffer);ticket.words[view.getUint32(20,true)]=missing?3:1;}return read.promise;}};}};
  let groups=[];
  const pass={setPipeline(){events.push('pipeline');},setBindGroup(i,g){groups[i]=g;},dispatchWorkgroups(x,y,z){assert.deepEqual([x,y,z],[32,32,1]);uses.push(groups[2].entries.find(e=>e.binding===0).resource.buffer);events.push('dispatch');}};
  const frame={_command(){events.push('command');},compute:()=>pass,_commandDone(){events.push('command-done');},direct(){return {copyTextureToTexture(src,dst,size){assert.notEqual(src.texture,dst.texture);assert.deepEqual(size,[256,256,1]);events.push('copy-texture');}};}};
  const gpu={device,frame};const lighting=createWorldSunLighting(gpu,{g,sourceFieldSnapshotProvider,readerBindingProvider,feedbackProvider});
  const options={direction:[0,1,0],basisRevision:1,configVersion:1,sceneToken:'scene',receiverBounds:[{min:[100,0,100],max:[101,1,101]}]};
  async function complete(c){const p=c.record(frame),t=tickets.at(-1);t.submitted.resolve();await Promise.resolve();t.done.resolve();t.read.resolve(t.words);return p;}
  return {lighting,options,buffers,textures,events,tickets,frame,device,sourceFieldSnapshotProvider,feedbackProvider,complete,get pins(){return pins;},edit(){current++;},resetEpoch(){epoch++;current++;},missing(v){missing=v;}};
}
test('actual native writer ordering, explicit feedback ABI, source pin through submission AND completion, immutable publication',async()=>{
  const f=fixture(),c=await f.lighting.prepare(f.options);assert.equal(c.status,'prepared');assert.equal(f.pins,1);
  const result=c.record(f.frame),t=f.tickets.at(-1);assert.equal(f.pins,1);assert.equal(f.events.at(-1),'readback-after-dispatch');assert.ok(!f.events.includes('queue-done-request'));
  t.read.resolve(t.words);await Promise.resolve();assert.equal(f.pins,1);t.submitted.resolve();await Promise.resolve();assert.equal(f.pins,1);t.done.resolve();assert.equal((await result).status,'published');assert.equal(f.pins,0);
  const s=f.lighting.snapshot(),b=s.bindings();assert.equal(b.params.version[3],23);assert.equal(b.params.physical[3],1);assert.equal(b.sun0.texture.format,'rgba32float');assert.equal(b.sun1.texture.format,'r32float');
  const words=new Uint32Array(b.book.bytes.buffer);for(const tile of c.tiles){assert.deepEqual([...words.slice(tile*8+1,tile*8+7)],[1,1,1,7,1,1]);}
  const p=worldSunProjection([3072,384,1024],[0,1,0]),tile=c.tiles[0],pixel=[(p.tiles[0]+tile%p.tiles[2])*256,(p.tiles[1]+Math.floor(tile/p.tiles[2]))*256];assert.equal(worldSunResolve(pixel,b.params,words,1).incomplete,false);
  const cached=await f.lighting.prepare(f.options);assert.equal(cached.status,'cached');cached.snapshot.release();
  f.lighting.reset();assert.ok(!b.sun0.texture.dead);s.release();assert.equal(b.sun0.texture.dead,true);assert.throws(()=>s.bindings(),/released/);f.lighting.dispose();
});
test('Sun textures accessor borrows actual native textures under the existing snapshot pin and rejects after release',async()=>{
  const f=fixture();await f.complete(await f.lighting.prepare(f.options));
  const first=f.lighting.snapshot(),second=f.lighting.snapshot(),native=first.textures(),views=first.bindings();
  assert(Object.isFrozen(native));assert.equal(native.sun0,views.sun0.texture);assert.equal(native.sun1,views.sun1.texture);
  assert.equal(native.release,undefined);f.lighting.reset();assert.ok(!native.sun0.dead);
  first.release();assert.throws(()=>first.textures(),/released/);assert.ok(!native.sun0.dead);assert.equal(second.textures().sun0,native.sun0);
  second.release();assert.equal(native.sun0.dead,true);assert.equal(native.sun1.dead,true);f.lighting.dispose();
});
test('missing/failed/stale candidate never publishes; retry and reset preserve queued pins',async()=>{
  const f=fixture();await f.complete(await f.lighting.prepare(f.options));const previous=f.lighting.snapshot(),token=previous.token;
  f.edit();f.missing(true);const bad=await f.lighting.prepare(f.options);const missing=await f.complete(bad);assert.equal(missing.status,'incomplete');assert.deepEqual(missing.failedTiles,[...bad.tiles]);const unchanged=f.lighting.snapshot();assert.equal(unchanged.token,token);unchanged.release();
  f.missing(false);const stale=await f.lighting.prepare(f.options),p=stale.record(f.frame),t=f.tickets.at(-1);f.edit();t.submitted.resolve();t.done.resolve();t.read.resolve(t.words);assert.equal((await p).status,'stale');assert.equal(f.pins,0);
  const queued=await f.lighting.prepare(f.options),q=queued.record(f.frame),qt=f.tickets.at(-1);f.lighting.reset();assert.equal(f.pins,1);qt.submitted.resolve();qt.done.resolve();qt.read.resolve(qt.words);assert.equal((await q).status,'stale');assert.equal(f.pins,0);
  const retry=await f.lighting.prepare(f.options);assert.equal((await f.complete(retry)).status,'published');previous.release();f.lighting.dispose();
});
test('cross-candidate camera/basis invalidation, full caster projection dirty reuse, layer growth and texture retirement',async()=>{
  const f=fixture();await f.complete(await f.lighting.prepare(f.options));const old=f.lighting.snapshot(),oldTexture=old.bindings().sun0.texture;
  f.edit();const changed=await f.lighting.prepare({...f.options,changedWorldBounds:[{min:[2500,100,800],max:[2501,101,801]}],changeBaseToken:old.token});assert.equal((await f.complete(changed)).status,'published');assert.ok(f.events.includes('copy-texture'));
  assert.equal(oldTexture.dead,undefined);old.release();assert.equal(oldTexture.dead,true);
  const a=await f.lighting.prepare({...f.options,basisRevision:2}),p=a.record(f.frame),t=f.tickets.at(-1);
  const b=await f.lighting.prepare({...f.options,basisRevision:3,receiverBounds:[{min:[200,0,200],max:[201,1,201]}]});
  t.submitted.resolve();t.done.resolve();t.read.resolve(t.words);assert.equal((await p).status,'stale');b.cancel();
  const grown=await f.lighting.prepare({...f.options,receiverBounds:[{min:[0,0,0],max:[3072,384,1024]}]});assert.ok(grown.params.physical[3]>1);assert.equal(grown.params.depth[2],WORLD_SUN_PITCH);assert.equal((await f.complete(grown)).status,'published');
  assert.ok(f.buffers.every(b=>b.size<=128*1024**2));f.lighting.dispose();
});
test('source epoch changes reject late completion, and COW copy references survive runtime reset until GPU completion',async()=>{
  const f=fixture();await f.complete(await f.lighting.prepare(f.options));
  const h=f.lighting.snapshot(),token=h.token,tex=h.bindings().sun0.texture;h.release();
  f.edit();const c=await f.lighting.prepare({...f.options,changedWorldBounds:[],changeBaseToken:token}),p=c.record(f.frame),t=f.tickets.at(-1);
  assert.ok(f.events.includes('copy-texture'));f.lighting.reset();assert.ok(!tex.dead);assert.equal(f.pins,1);
  t.submitted.resolve();await Promise.resolve();assert.ok(!tex.dead);t.done.resolve();t.read.resolve(t.words);assert.equal((await p).status,'stale');assert.equal(tex.dead,true);
  const e=await f.lighting.prepare(f.options),ep=e.record(f.frame),et=f.tickets.at(-1);f.resetEpoch();et.submitted.resolve();et.done.resolve();et.read.resolve(et.words);assert.equal((await ep).status,'stale');
  const retry=await f.lighting.prepare(f.options);assert.equal(retry.params.version[0],2);assert.equal((await f.complete(retry)).status,'published');f.lighting.dispose();
});
test('dirty tile meaning is immutable before asynchronous source acquisition',async()=>{
  for(const mutate of [bounds=>{bounds.length=0;},bounds=>{
    bounds[0].min.fill(2500);bounds[0].max.fill(2501);
  }]) {
    const f=fixture();await f.complete(await f.lighting.prepare(f.options));
    const old=f.lighting.snapshot();f.edit();f.events.length=0;
    const bounds=[{min:[0,0,0],max:[3072,384,1024]}];
    const preparing=f.lighting.prepare({...f.options,changedWorldBounds:bounds,changeBaseToken:old.token});
    mutate(bounds);
    const c=await preparing;assert.equal((await f.complete(c)).status,'published');
    assert.equal(f.events.filter(e=>e==='dispatch').length,c.tiles.length);
    assert.ok(c.tiles.length>0);assert.equal(f.events.filter(e=>e==='copy-texture').length,0);
    old.release();f.lighting.dispose();
  }
});
test('zero/unrun status, decoder misses, readback errors and discarded submissions fail closed with retry and balanced pins',async()=>{
  const f=fixture();
  for(const mode of ['unrun','decoder-missing','readback-failed','discarded']) {
    const c=await f.lighting.prepare(f.options),p=c.record(f.frame),t=f.tickets.at(-1);
    if(mode==='unrun')t.words.fill(0);
    if(mode==='decoder-missing')t.words[17]=1;
    if(mode==='readback-failed')t.read.reject(new Error('readback fixture failure'));else t.read.resolve(t.words);
    if(mode==='discarded'){
      t.submitted.reject(new Error('encoder discarded'));
      await Promise.resolve();await Promise.resolve();assert.equal(f.pins,1);t.done.resolve();
    }else {t.submitted.resolve();t.done.resolve();}
    const r=await p;assert.equal(r.status,mode==='unrun'||mode==='decoder-missing'?'incomplete':'failed');assert.equal(r.retry,true);assert.equal(f.lighting.snapshot(),null);assert.equal(f.pins,0);
  }
  const unused=await f.lighting.prepare(f.options);f.edit();assert.equal((await unused.record(f.frame)).status,'stale');assert.equal(f.pins,0);
  f.device.limits.maxTextureArrayLayers=1;
  await assert.rejects(()=>f.lighting.prepare({...f.options,receiverBounds:[{min:[0,0,0],max:[3072,384,1024]}]}),/never lower/);assert.equal(f.pins,0);
  const acquire=f.sourceFieldSnapshotProvider.acquire;
  f.sourceFieldSnapshotProvider.acquire=async()=>({...await acquire(),field:{complete:false}});
  await assert.rejects(()=>f.lighting.prepare(f.options),/complete consistent/);assert.equal(f.pins,0);f.lighting.dispose();
});
test('sun cache provenance includes dependency-only changes',async()=>{
  const f=fixture();await f.complete(await f.lighting.prepare(f.options));
  const acquire=f.sourceFieldSnapshotProvider.acquire;
  f.sourceFieldSnapshotProvider.acquire=async()=>({...await acquire(),dependencyVersion:99});
  const c=await f.lighting.prepare(f.options);assert.equal(c.status,'prepared');c.cancel();f.lighting.dispose();
});
test('discarded final sun encoder retains earlier prefix resources until queue completion',async()=>{
  const f=fixture(),c=await f.lighting.prepare(f.options),done=c.record(f.frame),t=f.tickets.at(-1);
  let settled=false;done.then(()=>{settled=true;});
  t.submitted.reject(new Error('final encoder discarded')); // readback never resolves
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  assert.ok(f.events.includes('queue-done-request'));assert.equal(f.pins,1);assert.equal(settled,false);
  assert.ok(f.textures.every(t=>!t.dead));t.done.resolve();
  assert.equal((await done).status,'failed');assert.equal(f.pins,0);assert.ok(f.textures.every(t=>t.dead));
  f.lighting.dispose();
});
test('partial encode failure closes readback boundary and retains inputs until final submit/completion',async()=>{
  const f=fixture(),c=await f.lighting.prepare(f.options);
  f.frame.compute=()=>{throw new Error('encode failure fixture');};
  const p=c.record(f.frame),t=f.tickets.at(-1);assert.equal(f.events.at(-1),'readback-after-dispatch');assert.equal(f.pins,1);
  t.submitted.resolve();await Promise.resolve();assert.equal(f.pins,1);t.done.resolve();t.read.resolve(t.words);
  assert.equal((await p).status,'failed');assert.equal(f.pins,0);f.lighting.dispose();
});
test('source/field changed bounds project via physical basis regardless of camera/origin, and no private submits/encoders',()=>{
  const p=worldSunProjection([3072,384,1024],[1,.01,0]);
  const roof={min:[1500,200,500],max:[1501,201,501]},receiver={min:[500,190,500],max:[501,191,501]};
  assert.ok(worldSunBoundsTiles(p,[roof]).some(i=>worldSunBoundsTiles(p,[receiver]).includes(i)));
  const source=readFileSync(new URL('../src/gfx/worldSunLighting.js',import.meta.url),'utf8');assert.doesNotMatch(source,/createCommandEncoder|queue\.submit\(/);
});
