// CPU interpretation of production factory leaves + independent geometry.
// This is NOT GPU numerical/visual parity evidence. Naga checks every fixture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { ddaGLSL } from '../src/shaders/gfx/core.js';
import { volumeFrag, pickFrag } from '../src/shaders/render.js';
import { WORLD_SUN_PITCH, worldSunProjection } from '../src/world/worldSun.js';

// Same lexical-scope adapter as check-crystal-transmission.mjs: 1.6.0 void
// calls otherwise overwrite same-named caller variables (not WGSL semantics).
class ShaderExec extends WgslExec {
  _call(node, context) {
    const fn = context.getFunction(node.name);
    if (!fn) return super._call(node, context);
    const values = node.args.map(arg => this.evalExpression(arg, context));
    const scope = context.clone(); scope.currentFunctionName = node.name;
    fn.node.args.forEach((arg, i) => scope.createVariable(arg.name, values[i], arg));
    this._execStatements(fn.node.body, scope);
  }
}
function validate(code, label) {
  const n = spawnSync('naga', ['--stdin-file-path', `${label}.wgsl`], { input: code, encoding: 'utf8' });
  assert.equal(n.status, 0, `${label}: ${n.error ?? ''}\n${n.stdout}\n${n.stderr}`);
}
function body(code, name) {
  const start = code.indexOf(`fn ${name}(`); assert.ok(start >= 0, name);
  let end = code.indexOf('{', start), depth = 1;
  while (depth && ++end < code.length) { if (code[end] === '{') depth++; else if (code[end] === '}') depth--; }
  assert.equal(depth, 0); return code.slice(start, end + 1);
}
const near = (a,b,eps=3e-4) => assert.ok(Math.abs(a-b) <= eps, `${a} != ${b}`);
const size = [3072,384,1024], g = {nx:size[0],ny:size[1],nz:size[2]};
const factory = ddaGLSL(g, {backend:'world'});
const header = `const NX: i32=3072; const NY: i32=384; const NZ: i32=1024; const BS: i32=4;
const E_EMPTY: i32=0; fn SURFCH(id:i32)->i32{return -1;} fn MEDIACH(id:i32)->i32{return -1;}`;
// Independent half-open slab reference; no replacement direction/epsilon.
function slab(ro, rd, lo, hi) {
  if(rd.every(v=>v===0)) return null;
  let tn=-Infinity, tf=Infinity;
  for(let k=0;k<3;k++) {
    if(rd[k]===0) { if(ro[k]<lo[k] || ro[k]>=hi[k]) return null; }
    else { const a=(lo[k]-ro[k])/rd[k], b=(hi[k]-ro[k])/rd[k]; tn=Math.max(tn,Math.min(a,b));tf=Math.min(tf,Math.max(a,b)); }
  }
  return tf>Math.max(tn,0) ? [Math.max(tn,0),tf] : null;
}

test('actual WORLD factory keeps direction for primary, pick, reflection and tangent optics; Box stays legacy',()=>{
  const volume=volumeFrag(g,{backend:'world'}), pick=pickFrag(g,{backend:'world'});
  for(const code of [volume,pick]) for(const name of ['safeDir','ddaCrossing','ddaNext','ddaInit','ddaStart','ddaStep','ddaJumpBox','skipBrick','boxHit']) assert.equal(body(code,name),body(factory,name));
  assert.match(body(volume,'reflectHit'),/let rd = safeDir\(rd0\)/);
  assert.match(body(volume,'worldSunExact'),/let sunward = safeDir\(FU.sun\)/);
  assert.match(body(volume,'worldSunExact'),/shadowTexel\(ro,-sunward\)/);
  assert.match(body(volume,'fs'),/safeDir\(normalize\(v.grid - FU.cam\)\)/);
  assert.match(volumeFrag(g,{backend:'world',view:'flow'}),/let tb = ddaCrossing\(/);
  assert.match(body(ddaGLSL(g),'safeDir'),/DDA_DIR_MIN/);
});

test('executed WORLD DDA/slabs: long crisp voxels, all cardinal axes, signed zero, tiny signs and 4/32/128 jumps',()=>{
  const cases=[];
  const add=(ro,rd,target,mode=0)=>cases.push({ro:ro.map(Math.fround),rd:rd.map(Math.fround),target,mode});
  for(const mode of [0,4,32,128]) {
    add([.5,64.5,3.999],[1,0,0],[1536,64,3],mode); // verified P1 counterexample
    add([.5,64.5,4.00001],[1,-0,-1e-8],[1536,64,3],mode);
    add([.5,64.5,3.99999],[1,0,1e-8],[1536,64,4],mode);
    add([.5,64.00001,3.5],[1,-1e-8,-0],[1536,63,3],mode);
    // Resolve both sides immediately around the tiny-component plane crossing,
    // not only distant targets after a rounded-coordinate restart recovers.
    for(const x of [1000,1001,1002]) for(const z of [3,4]) {
      add([.5,64.5,3.99999],[1,0,1e-8],[x,64,z],mode);
      add([.5,64.5,4.00001],[1,0,-1e-8],[x,64,z],mode);
    }
    for(let axis=0;axis<3;axis++) for(const sign of [-1,1]) {
      const ro=[64.5,64.5,64.5], rd=[0,-0,0], target=[64,64,64];
      ro[axis]=sign>0?.5:size[axis]-.5;rd[axis]=sign;target[axis]=sign>0?size[axis]-1:0;
      add(ro,rd,target,mode);
    }
    // Cell/brick/page crossings on both sides of each boundary.
    for(const x of [3,4,31,32,127,128,1535,1536,3071]) add([.5,64.5,3.999],[1,0,-0],[x,64,3],mode);
    add([-1,-1,-1],[1,1,1],[128,128,128],mode);
    add([3073,385,1025],[-1,-1,-1],[2943,255,895],mode);
    add([0,0,0],[1,0,-0],[128,0,0],mode);
    add([3072,384,1024],[-1,-1,-1],[3071,383,1023],mode);
    add([3072,64.5,3.5],[-1,0,-0],[1536,64,3],mode);
    add([.5,64.5,1024],[1,0,-1e-8],[1536,64,1023],mode);
    // Maximum parallel faces are outside; minimum parallel faces are inside.
    for(let axis=0;axis<3;axis++) {
      const other=(axis+1)%3, rd=[0,-0,0], ro=[.5,.5,.5], target=[0,0,0]; rd[other]=1;target[other]=32;
      ro[axis]=size[axis]; add(ro,rd,target,mode);
      ro[axis]=0;add(ro,rd,target,mode);
      ro[axis]=-1;add(ro,rd,target,mode);
      ro[axis]=size[axis];rd[axis]=1e-8;add(ro,rd,target,mode);
    }
    for(let axis=0;axis<3;axis++) for(const high of [false,true]) for(const inward of [false,true]) {
      const ro=[64.5,64.5,64.5],rd=[0,-0,0],target=[64,64,64];
      ro[axis]=high?size[axis]:0;rd[axis]=(high?-1:1)*(inward?1:-1);target[axis]=high?size[axis]-32:31;
      add(ro,rd,target,mode);
    }
    add([.5,64.5,3.5],[0,-0,0],[0,64,3],mode);
    add([-1,64.5,3.999],[-1,0,0],[1536,64,3],mode);
    add([0,64.5,3.999],[-1,0,0],[1536,64,3],mode);
  }
  const code=`${header}\n${factory}
@group(0) @binding(0) var<storage,read> input:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u) {
  let at=id.x*3u;let out=id.x*6u;let origin=input[at].xyz;let direction=safeDir(input[at+1u].xyz);
  let voxel=vec3i(input[at+2u].xyz);let jump=i32(input[at+2u].w);
  let bh=boxHit(origin,direction); output[out]=vec4f(-1.0);output[out+1u]=vec4f(direction,0.0);output[out+2u]=vec4f(bh,0.0);
  if (bh.y<=max(bh.x,0.0)) {return;}
  var cell:vec3i;var istp:vec3i;var delta:vec3f;var next:vec3f;
  var enter=max(bh.x,0.0);ddaStart(origin,direction,enter,&istp,&delta,&cell,&next);
  for(var i=0;i<MAX_STEPS;i++) {
    if(outside(cell)){break;}
    if(min(next.x,min(next.y,next.z))+0.002<enter) {output[out]=vec4f(-2.0);break;}
    output[out+3u]=vec4f(next,enter);output[out+4u]=vec4f(delta,f32(i));output[out+5u]=vec4f(vec3f(istp),0.0);
    if(all(cell==voxel)) {output[out]=vec4f(vec3f(cell),enter);break;}
    // Power-of-two fixture regions: bitwise form avoids wgsl_reflect's
    // non-truncating vector integer division (not actual WGSL semantics).
    let region=cell & vec3i(-jump);
    if(jump>0 && any(region != (voxel & vec3i(-jump)))) {
      var axis:i32;
      if(jump==BS) {axis=skipBrick(cell >> vec3u(2u),origin,direction,istp,&cell,&next,&enter);}
      else {let lo=vec3f(region);axis=ddaJumpBox(lo,lo+f32(jump),origin,direction,istp,&cell,&next,&enter);}
    } else {enter=min(next.x,min(next.y,next.z));let axis=ddaStep(istp,delta,&cell,&next);}
  }
}`;
  validate(code,'world-physical-dda');
  const input=new Float32Array(cases.flatMap(c=>[...c.ro,0,...c.rd,0,...c.target,c.mode]));
  const output=new Float32Array(cases.length*24);
  new ShaderExec(new WgslParser().parse(code)).dispatchWorkgroups('main',cases.length,{0:{0:input,1:output}});
  cases.forEach((c,i)=>{
    const values=Array.from(output.subarray(i*24,i*24+24));
    assert.ok(values.every(Number.isFinite),`NaN/Inf case ${i}: ${JSON.stringify(c)}`);
    const world=slab(c.ro,c.rd,[0,0,0],size), hit=world&&slab(c.ro,c.rd,c.target,c.target.map(v=>v+1));
    assert.deepEqual(values.slice(0,3),hit?c.target:[-1,-1,-1],`case ${i}: ${JSON.stringify(c)} output=${values}`);
    if(hit) near(values[3],hit[0],.002);
    for(let k=0;k<3;k++) {
      assert.ok(Object.is(values[4+k],c.rd[k]),`direction/sign changed ${i}/${k}`);
      if(world && c.rd[k]===0) {assert.equal(values[12+k],Math.fround(1e30));assert.equal(values[16+k],Math.fround(1e30));assert.equal(values[20+k],0);}
    }
  });
  console.log(`CPU production DDA: ${cases.length} full-world cases, independent half-open slab oracle; no NaNs`);
});

test('tangent-sun physical lines retain published light projection across full world distance',()=>{
  const dots=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
  for(const direction of [[1,0,0],[0,1,0],[0,0,1],[1,0,-1e-8],[1,-1e-8,0]]) {
    const p=worldSunProjection(size,direction), s=p.basis.sun, ro=[.5,64.5,3.999];
    const end=ro.map((v,i)=>v+s[i]*3072);
    for(const axis of [p.basis.u,p.basis.v]) near(dots(ro,axis),dots(end,axis),1e-10);
    near(dots(end,s)-dots(ro,s),3072,1e-9);
  }
});

// Extract only production functions/constants for a controlled SunBook fixture.
// Geometry is an analytic grazing plane plus a real parallel partial blocker;
// actual quantized texel centres determine both blocker comparisons and filter.
test('executed world PCSS recentres partial grazing blockers: both signs, axes, rotations, clear planes',()=>{
  const production=volumeFrag(g,{backend:'world'});
  const constants=['SUN_TAN_RADIUS','PCSS_TAPS','PCSS_HARD_TEXELS','PCSS_BIAS','SHADOW_NORMAL_OFFSET','SHADOW_TINT_ID_SCALE','PI_L'].map(n=>{
    const line=production.match(new RegExp(`const ${n}:[^;]+;`));assert.ok(line,n);return line[0];
  }).join('\n');
  const vogel=production.match(/var<private> VOGEL:[^;]+;/)[0];
  const taps=Array.from(vogel.matchAll(/vec2f\(([-\d.]+), ([-\d.]+)\)/g),m=>[+m[1],+m[2]]);
  assert.equal(taps.length,8);
  const radius=Number(production.match(/const SUN_TAN_RADIUS: f32 = ([\d.]+)/)[1]);
  const cases=[];
  for(const slope of [[20,0],[-20,0],[0,20],[0,-20],[12,-16],[-12,16]]) for(const rot of [0,.7,2.1]) for(const blocked of [true,false]) cases.push({slope,rot,blocked});
  const code=`${constants}\n${vogel}
struct FixtureSun {worldToLight:mat4x4f,depth:vec4f}
struct FixtureFrame {sun:vec3f,caustics:u32,frame:f32}
var<private> WS:FixtureSun;var<private> FU:FixtureFrame;var<private> gFragCoord:vec2f;
var<private> fixture:vec4f;var<private> recordBase:u32;var<private> count:u32;
@group(0) @binding(0) var<storage,read> input:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
fn worldSunProject(p:vec3f)->vec3f{return vec3f(256.2,256.2,1000.0);}
${body(production,'worldSunReceiverDepth')}
fn fixtureDepth(pixel:vec2i)->f32 {
  let q=worldSunProject(vec3f(0.0));
  let offset=(vec2f(pixel)+0.5-q.xy)*WS.depth.z;
  let d=q.z+dot(offset,fixture.xy);
  // Positive slope-coordinate half of the plane, including the review's +U case.
  let blocked=fixture.w>0.0 && dot(offset,fixture.xy)>0.0;
  return d-select(0.0,100.0,blocked);
}
fn worldSunDepthTap(pixel:vec2i)->f32 {
  let d=fixtureDepth(pixel);output[recordBase+2u+count]=vec4f(vec2f(pixel),d,0.0);count++;
  return d;
}
fn worldSunTap(pixel:vec2i)->vec4f {return vec4f(fixtureDepth(pixel),0.0,0.0,0.0);}
fn shadowTexelAtt(sm:vec4f,d:f32)->vec3f{return vec3f(0.8,0.6,0.4);}
fn underPool(sm:vec4f,d:f32,tid:i32)->bool{return false;}
fn causticGain(p:vec3f,d:f32)->f32{return 1.0;}
fn worldSunExact(p:vec3f,n:vec3f)->vec3f{return vec3f(-99.0);}
fn ign(p:vec2f,frame:f32)->f32{return fixture.z/(2.0*PI_L);}
${body(production,'wk0')}
${body(production,'sunMapShadow')}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u) {
  fixture=input[id.x];recordBase=id.x*18u;count=0u;
  let pitch=${WORLD_SUN_PITCH};let inv=1.0/pitch;
  WS=FixtureSun(mat4x4f(vec4f(inv,0,0,0),vec4f(0,inv,0,0),vec4f(0,0,-1,0),vec4f(0,0,4000,1)),vec4f(0,0,pitch,inv));
  FU=FixtureFrame(vec3f(0,0,1),0u,0.0);gFragCoord=vec2f(0.0);
  let att=sunMapShadow(vec3f(0.0),normalize(vec3f(fixture.xy,1.0)));
  output[recordBase]=vec4f(att,f32(count));
}`;
  validate(code,'world-pcss-plane');
  const input=new Float32Array(cases.flatMap(c=>[...c.slope,c.rot,c.blocked?1:0]));
  const output=new Float32Array(cases.length*18*4);
  new ShaderExec(new WgslParser().parse(code)).dispatchWorkgroups('main',cases.length,{0:{0:input,1:output}});
  let reviewAverage;
  cases.forEach((c,i)=>{
    const at=i*72, actual=Array.from(output.subarray(at,at+4));
    assert.ok(actual.every(Number.isFinite));
    if(!c.blocked) {assert.equal(actual[3],0,'unoccluded plane takes clear hard path');[.8,.6,.4].forEach((v,k)=>near(actual[k],v));return;}
    assert.equal(actual[3],16,`real blockers must reach the soft filter ${JSON.stringify(c)}`);
    const q=[Math.fround(256.2),Math.fround(256.2),1000];
    const pitch=Math.fround(WORLD_SUN_PITCH), samples=[];
    // Use the ACTUAL search texels fetched by production, not intended offsets.
    for(let k=0;k<8;k++) {
      const tap=Array.from(output.subarray(at+(k+2)*4,at+(k+3)*4));
      const offset=[(tap[0]+.5-q[0])*pitch,(tap[1]+.5-q[1])*pitch];
      const plane=q[2]+offset[0]*c.slope[0]+offset[1]*c.slope[1];
      const separation=plane-tap[2];
      if(separation>.35) {samples.push(tap[2]);near(separation,100,.003);}
    }
    assert.ok(samples.length>0 && samples.length<8,'partial real blocker');
    if(i===0) {reviewAverage=samples.reduce((a,b)=>a+b,0)/samples.length;near(reviewAverage,1046.202459624,.003);assert.ok(radius*(q[2]-reviewAverage)<0);}
    const pen=radius*100;near(pen,2.1);assert.ok(pen>WORLD_SUN_PITCH);
    let lit=0;
    for(let k=0;k<8;k++) {
      const [x,y]=taps[k],co=Math.cos(c.rot),si=Math.sin(c.rot);
      const pixel=[Math.floor(q[0]+(co*x-si*y)*pen/WORLD_SUN_PITCH),Math.floor(q[1]+(si*x+co*y)*pen/WORLD_SUN_PITCH)];
      const tap=Array.from(output.subarray(at+(k+10)*4,at+(k+11)*4));
      assert.deepEqual(tap.slice(0,2),pixel,`recentered penumbra texel ${i}/${k}`);
      const offset=pixel.map((v,k)=>(v+.5-q[k])*pitch);
      if(offset[0]*c.slope[0]+offset[1]*c.slope[1]<=0)lit++;
    }
    const factor=Math.min(2*lit/8,1);[.8,.6,.4].forEach((v,k)=>near(actual[k],v*factor));
  });
  console.log(`CPU production PCSS: ${cases.length} quantized-plane cases; review blocker average ${reviewAverage}, corrected penumbra 2.1`);
});
