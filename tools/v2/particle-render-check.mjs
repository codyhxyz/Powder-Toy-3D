import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, PerspectiveCamera, Vector3, WebGPUCoordinateSystem } from 'three';
import { NativeParticles, nativeParticleView, validateNativeParticleSource } from '../../src/gfx/nativeParticles.js';
import { PARTICLE_BYTES, PARTICLE_WORDS, NativeParticleParams, nativeParticleWGSL, nativeParticlePipeline, nativeParticleArgsWGSL } from '../../src/shaders/v2/particleRender.js';
import { E } from '../../src/elements.js';
import { PHASE_HOT_BASE, PHASE_COLD_BASE, phaseTemperatureQ, PHASE_ROWS } from '../../src/v2/phase.js';

const near = (a,b,eps=1e-8) => assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
const camera = () => { const c=new PerspectiveCamera(55,16/9,0.1,1000); c.coordinateSystem=WebGPUCoordinateSystem; c.position.set(0,0,10); c.updateProjectionMatrix(); c.updateMatrixWorld(); return c; };
const buffer = size => ({size,words:new Uint32Array(size/4),destroyed:0,destroy(){this.destroyed++;}});
function source() {
  const s={isIdle:false,disposed:false,particles:buffer(65536*48),control:buffer(16),isReady:true,
    attachDrawAdapter(a){this.drawAdapter=a;},get ready(){return Promise.resolve(this);},
    get renderState(){return {version:1,particleBytes:48,capacity:65536,position:'world cells',velocity:'m/s',particleIdOffset:12,
      coreOffsets:[28,32,36,40],bankOffset:44,liveCountOffset:0,particles:this.particles,control:this.control,ready:this.isReady&&!this.disposed};}};
  return s;
}
function gpu() {
  globalThis.GPUBufferUsage ??= {STORAGE:128,INDIRECT:256};
  const g={frame:{},_frameUniforms:{layout:{},group:{}},calls:[],buffers:[],pipes:[],flushes:0,
    layout:(_n,l)=>l,bindGroup:(l,entries)=>({l,entries}),createBuffer(d){const b=buffer(d.size);this.buffers.push(b);return b;},flush(){this.flushes++;},
    renderPipeline(d){const p={state:'ready',ready:Promise.resolve(),desc:d,draw(_rp,o){g.calls.push({kind:'draw',name:d.name,options:o,instances:o.indirect.buffer.words[1]});}};this.pipes.push(p);return p;},
    kernel(d){const p={state:'ready',ready:Promise.resolve(),desc:d,dispatch(frame,n,o){g.calls.push({kind:'count',frame,n,options:o});
      const [control,args]=o.bind[0].entries.map(e=>e.resource.buffer); args.words.set([6,control.words[0]>0?o.params.capacity:0,0,0]);}};this.pipes.push(p);return p;}};
  return g;
}
const setup = () => {const g=gpu(),s=source(),a=new NativeParticles(g,s);a.updateView(camera(),720,new Matrix4(),[0,0,0]);return {g,s,a};};

test('exact48B mixed-bit record offsets and particle-only payloads',()=>{
  assert.equal(PARTICLE_BYTES,48);assert.equal(PARTICLE_WORDS,12);
  const bytes=new ArrayBuffer(96),d=new DataView(bytes),w=new Uint32Array(bytes);
  [100.5,-12.25,37].forEach((v,i)=>d.setFloat32(i*4,v,true));d.setUint32(12,0xf1234567,true);
  [3,-4,5].forEach((v,i)=>d.setFloat32(16+i*4,v,true));d.setUint32(28,E.WATER|(1173<<8),true);
  d.setUint32(32,32768,true);d.setUint32(36,0x87654321,true);d.setUint32(40,0xfedcba98,true);d.setInt32(44,-711,true);
  assert.equal(w[3],0xf1234567);assert.equal(w[7]&255,E.WATER);assert.equal(w[8]&0xffffff,32768);assert.equal(d.getInt32(44,true),-711);
  assert.equal(w[12],0); // second record, not a 64B legacy stride
  d.setUint32(28,254|(512<<8),true);[0.25,0.5,1].forEach((v,i)=>d.setFloat32(32+i*4,v,true));
  assert.deepEqual([32,36,40].map(i=>d.getFloat32(i,true)),[0.25,0.5,1]);
  d.setUint32(28,255,true);d.setFloat32(36,2,true);assert.equal(d.getFloat32(36,true),2);
  assert.match(nativeParticleWGSL(),/struct Particle \{ positionId: vec4u, velocityCore: vec4u, payloadBank: vec4u \}/);
  assert.match(nativeParticleWGSL(true),/bitcast<vec3f>\(p.payloadBank.xyz\)/);
});

test('origin shifts cancel model translation, with no particle mutation',()=>{
  const c=camera(),position=new Vector3(103,5,-12),saved=position.clone();
  const project=(origin,matrix)=>position.clone().sub(new Vector3(...origin)).applyMatrix4(matrix).project(c);
  const old=new Matrix4().makeScale(0.3,0.3,0.3),shift=[96,0,-16];
  const moved=old.clone().multiply(new Matrix4().makeTranslation(...shift));
  const a=project([0,0,0],old),b=project(shift,moved);near(a.distanceTo(b),0);
  const view=nativeParticleView(c,720,moved,shift);
  const local=position.clone().sub(new Vector3(...view.origin));
  near(local.clone().applyMatrix4(moved).applyMatrix4(new Matrix4().fromArray(view.inverseModel)).distanceTo(local),0);
  assert.deepEqual(position,saved);assert.deepEqual(view.origin,shift);
  assert.match(nativeParticleWGSL(),/bitcast<vec3f>\(p.positionId.xyz\) - P.origin/);
});

test('equal-volume liquid amount, phase tags never become huge heat',()=>{
  for(const amount of [1/65536,0.125,0.5,1,1.33]) {
    const r=Math.cbrt(amount*3/(4*Math.PI));near(4*Math.PI*r**3/3,amount);
  }
  near(phaseTemperatureQ(E.WATER,1173)*0.25-273.25,20);
  near(phaseTemperatureQ(E.WATER,PHASE_HOT_BASE+123)*0.25-273.25,100);
  near(phaseTemperatureQ(E.WATER,PHASE_COLD_BASE+123)*0.25-273.25,0);
  near(PHASE_ROWS[E.ICE].hotQ*0.25-273.25,0);
  const wgsl=nativeParticleWGSL();assert.match(wgsl,/PHASE_TQ\[id\]/);assert.match(wgsl,/amount \* \(3.0 \/ \(4.0 \* 3.141592653589793\)\)/);
});

test('sphere surface depth moves continuously, occludes by hit not billboard center',()=>{
  const c=camera(),depth=z=>new Vector3(0,0,z).project(c).z;
  const surface=(center,r)=>{const b=center-10;const d=b*b-(center-10)**2+r*r;return center+Math.sqrt(d);};
  const depths=[-2,-1,0,1,2].map(z=>depth(surface(z,0.62)));
  for(let i=1;i<depths.length;i++)assert.ok(depths[i]<depths[i-1]);
  assert.ok(depth(surface(0,0.62))<depth(0.3)); // front passes a mesh that center would fail
  assert.ok(depth(surface(0,0.62))>depth(0.8)); // mesh in front still wins
  assert.match(nativeParticleWGSL(),/@builtin\(frag_depth\)/);
  assert.match(nativeParticleWGSL(),/if \(hitClip.z < 0.0\)/);
  assert.equal(nativeParticlePipeline().depthStencil.depthWriteEnabled,true);
  assert.equal(nativeParticlePipeline(true).depthStencil.depthWriteEnabled,false);
});

const hash = input=>{let x=input>>>0;x^=x>>>16;x=Math.imul(x,0x7feb352d);x^=x>>>15;x=Math.imul(x,0x846ca68b);return (x^(x>>>16))>>>0;};
const sample=(id,x,y,s=0)=>(hash(id^hash(x)^hash((y+0x9e3779b9)>>>0)^hash(s))>>>8)/16777216;
test('independent stochastic layers match premultiplied expectation, stable TAA-off',()=>{
  let sum=0,both=0;const n=256*256,alphaA=0.3,alphaB=0.6,front=0.8,back=0.4,bg=0.1;
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){
    const a=sample(719,x,y)<alphaA,b=sample(720,x,y)<alphaB;
    sum+=a?front:b?back:bg;both+=a&&b;
    assert.equal(sample(719,x,y),sample(719,x,y,0));
  }
  near(sum/n,alphaA*front+(1-alphaA)*(alphaB*back+(1-alphaB)*bg),0.005);
  near(both/n,alphaA*alphaB,0.005);
  assert.notEqual(sample(719,1,2),sample(720,1,2));assert.notEqual(sample(719,1,2,0),sample(719,1,2,1));
  assert.match(nativeParticleWGSL(),/o.stableId \^ coverageHash\(pixel.x\)/);
  assert.match(nativeParticleWGSL(),/coverageHash\(P.sample\)/);
  assert.equal(nativeParticlePipeline().fragment.targets[0].blend,undefined);
  assert.deepEqual(nativeParticlePipeline(true).fragment.targets[0].blend.alpha,{srcFactor:'zero',dstFactor:'one'});
});

test('zero GPU count produces zero instances, without CPU readback; idle records nothing',async()=>{
  const {g,s,a}=setup();await a.ready;
  assert.equal(a.prepareDraw(),true);assert.equal(a.draw({frame:g.frame},{width:1280,height:720}),true);
  assert.deepEqual(g.calls.filter(c=>c.kind==='draw').map(c=>c.instances),[0,0]);
  assert.match(nativeParticleArgsWGSL(),/select\(0u, P.capacity, control\[0\] > 0u\)/);
  s.control.words[0]=1;g.calls=[];a.prepareDraw();a.draw({frame:g.frame},{width:1280,height:720});
  assert.deepEqual(g.calls.filter(c=>c.kind==='draw').map(c=>c.instances),[65536,65536]);
  s.isIdle=true;g.calls=[];assert.equal(a.prepareDraw(),false);assert.equal(a.draw({frame:g.frame},{width:1,height:1}),false);assert.equal(g.calls.length,0);
  a.dispose();
});

test('draw readiness requires real source AND pipelines; no stale frame/old buffer draws',async()=>{
  const {g,s,a}=setup();assert.equal(a.isReady,true);s.isReady=false;assert.equal(a.isReady,false);
  await assert.rejects(a.ready,/not ready/);s.isReady=true;g.pipes[0].state='building';assert.equal(a.isReady,false);
  g.pipes[0].state='ready';await a.ready;
  assert.equal(a.draw({frame:g.frame},{width:1,height:1}),false);a.prepareDraw();
  assert.equal(a.draw({frame:{}},{width:1,height:1}),false);
  const old=s.particles;s.particles=buffer(65536*48);assert.equal(a.draw({frame:g.frame},{width:1,height:1}),false);
  a.prepareDraw();assert.equal(a.draw({frame:g.frame},{width:1,height:1}),true);assert.equal(a.boundParticles,s.particles);assert.equal(old.destroyed,0);
  a.updateView(camera(),720,new Matrix4(),[4,0,0]);assert.equal(a.draw({frame:g.frame},{width:1,height:1}),false);a.dispose();
});

test('detach/dispose owns only16B args, never physics or shared uniforms, and is idempotent',()=>{
  const {g,s,a}=setup();assert.equal(s.drawAdapter,a);const second=source();
  a.attachSource(second);assert.equal(s.drawAdapter,null);assert.equal(second.drawAdapter,a);
  a.prepareDraw();a.dispose();a.dispose();assert.equal(second.drawAdapter,null);assert.equal(a.isReady,false);
  assert.equal(g.buffers.length,1);assert.equal(g.buffers[0].size,16);assert.equal(g.buffers[0].destroyed,1);assert.equal(g.flushes,1);
  for(const s0 of [s,second]){assert.equal(s0.particles.destroyed,0);assert.equal(s0.control.destroyed,0);}
  assert.throws(()=>a.attachSource(s),/disposed/);
});

test('ABI/viewport guards and params fit one256B ring slot',()=>{
  const s=source();validateNativeParticleSource(s.renderState);
  for(const change of [{particleBytes:64},{position:'grid cells'},{bankOffset:40},{capacity:65537},{liveCountOffset:4}])
    assert.throws(()=>validateNativeParticleSource({...s.renderState,...change}),/ABI/);
  assert.throws(()=>validateNativeParticleSource({...s.renderState,particles:buffer(48)}),/too small/);
  assert.throws(()=>nativeParticleView(camera(),0,null),/height/);
  assert.throws(()=>nativeParticleView(camera(),1,new Matrix4().makeScale(0,0,0)),/matrix/);
  assert.throws(()=>nativeParticleView(camera(),1,null,[NaN,0,0]),/coordinates/);
  assert.throws(()=>nativeParticleView(camera(),1,null,[0,0,0],-1),/sample/);
  assert.ok(NativeParticleParams.size<=256);
});
