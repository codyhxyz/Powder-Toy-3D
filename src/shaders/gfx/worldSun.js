import { WorldSunParams } from '../../world/worldSun.js';
// Actual independent immutable SunBook publication. No absent-as-clear tiles.
export const worldSunAccessWGSL = /* wgsl */ `
${WorldSunParams.wgsl}
@group(3) @binding(4) var<uniform> WS: WorldSunParams;
@group(3) @binding(5) var<storage, read> SunBook: array<u32>;
fn worldSunValidate() {
  if (WS.version.x != WA.world.w || WS.version.z == 0u || any(WS.tiles.zw <= vec2i(0)) ||
      any(WS.physical.xyz != vec3u(256u,8u,64u)) || WS.physical.w == 0u || abs(WS.depth.z - 0.416531224) > 1e-7 ||
      any(textureDimensions(worldSunOptical,0) != vec2u(2048u)) || any(textureDimensions(worldSunDepth,0) != vec2u(2048u)) ||
      textureNumLayers(worldSunOptical) != WS.physical.w || textureNumLayers(worldSunDepth) != WS.physical.w) { worldIncomplete = true; }
}
fn worldSunProject(p: vec3f) -> vec3f { return (WS.worldToLight * vec4f(p,1.0)).xyz; }
fn worldSunAddress(pixel: vec2i) -> vec3i {
  worldSunValidate();
  let tile = vec2i(floor(vec2f(pixel) / 256.0));
  let b = tile - WS.tiles.xy;
  if (any(b < vec2i(0)) || any(b >= WS.tiles.zw)) { return vec3i(-1); }
  let i = u32(b.x + WS.tiles.z * b.y);
  let at = i * 8u;
  let slot = SunBook[at];
  if (WS.version.x != WA.world.w || SunBook[at+1u] != WS.version.x || SunBook[at+2u] != WS.version.y ||
      SunBook[at+3u] != WS.version.z || (SunBook[at+6u] & 1u) == 0u || slot >= 64u * WS.physical.w) {
    worldIncomplete = true;
    atomicOr(&worldRequests[WS.version.w + (i >> 5u)], 1u << (i & 31u));
    return vec3i(-2);
  }
  let local = pixel - tile * 256;
  return vec3i(i32(slot % 8u)*256+local.x, i32((slot/8u)%8u)*256+local.y, i32(slot/64u));
}
fn worldSunTap(pixel: vec2i) -> vec4f {
  let a = worldSunAddress(pixel);
  if (a.z < 0) { return vec4f(1e5,1e5,1e5,0.0); }
  return textureLoad(worldSunOptical,a.xy,a.z,0);
}
fn worldSunDepthTap(pixel: vec2i) -> f32 {
  let a = worldSunAddress(pixel);
  if (a.z < 0) { return 1e5; }
  return textureLoad(worldSunDepth,a.xy,a.z,0).x;
}
// Quantized texel CENTRE displacement, not the intended Vogel offset.
fn worldSunReceiverDepth(q: vec3f, pixel: vec2i, slope: vec2f) -> f32 {
  return q.z + dot((vec2f(pixel)+0.5-q.xy)*WS.depth.z,slope);
}
fn worldSunExact(p: vec3f, n: vec3f) -> vec3f {
  let thin = gThin; let on = gCrysOn; let cell = gCrysCell; let kind = gCrysKind; let crystal = gCrys;
  let receiver = p + n * SHADOW_NORMAL_OFFSET;
  let sunward = safeDir(FU.sun);
  let distance = max(boxHit(receiver,sunward).y,0.0)+1.0;
  // Same light-to-receiver orientation as the producer: stacked tint payload
  // selection and proportional optical-depth decoding must not reverse.
  let ro = receiver + sunward * distance;
  let sm = shadowTexel(ro,-sunward);
  var att = shadowTexelAtt(sm,distance);
  if (sm.x < distance) { att = vec3f(0.0); }
  gThin = thin; gCrysOn = on; gCrysCell = cell; gCrysKind = kind; gCrys = crystal;
  // NEVER restore worldIncomplete: secondary dependency misses stay latched.
  return att;
}
`;
export function worldSunReaderWGSL({caustics,frame}) { return /* wgsl */ `
fn sunMapShadow(hp: vec3f, n: vec3f) -> vec3f {
  let ns = dot(n,FU.sun);
  // A tangent plane has no finite receiver-plane projection. Trace the same
  // whole-world optical body, including glass/liquid/media, not open sunlight.
  if (abs(ns) < 1e-5) { return worldSunExact(hp,n); }
  let u = vec3f(WS.worldToLight[0].x,WS.worldToLight[1].x,WS.worldToLight[2].x)*WS.depth.z;
  let v = vec3f(WS.worldToLight[0].y,WS.worldToLight[1].y,WS.worldToLight[2].y)*WS.depth.z;
  let slope = vec2f(dot(n,u),dot(n,v))/ns;
  let p = hp+n*SHADOW_NORMAL_OFFSET;
  let q = worldSunProject(p);
  let i0 = vec2i(floor(q.xy-0.5)); let w = fract(q.xy-0.5);
  var acc = vec3f(0.0); var tr = vec3f(0.0); var nLit = 0.0; var cD = 0.0; var cW = 0.0;
  for (var k=0; k<4; k++) {
    let o=vec2i(k&1,k>>1u); let pixel=i0+o;
    let d=worldSunReceiverDepth(q,pixel,slope);
    let sm=worldSunTap(pixel); let lit=select(0.0,1.0,d<sm.x+0.002);
    let att=shadowTexelAtt(sm,d); let tid=i32(sm.w/SHADOW_TINT_ID_SCALE); let wk=wk0(o,w);
    if (tid>0 && underPool(sm,d,tid)) { cD+=(d-sm.y)*wk; cW+=wk; }
    acc+=lit*att*wk; tr+=att*wk; nLit+=lit;
  }
  if (${caustics} && cW>0.0) { let cg=mix(1.0,causticGain(p,cD/cW),cW); acc*=cg; tr*=cg; }
  if (nLit==4.0) { return acc; }
  let rot=2.0*PI_L*ign(gFragCoord,${frame}); let R2=mat2x2f(cos(rot),sin(rot),-sin(rot),cos(rot));
  let rs=SUN_TAN_RADIUS*q.z; var bSum=0.0; var bN=0.0;
  for (var i=0; i<PCSS_TAPS; i++) {
    let o=R2*VOGEL[i]*rs; let pixel=vec2i(floor(q.xy+o*WS.depth.w));
    let d=worldSunReceiverDepth(q,pixel,slope); let sm=worldSunDepthTap(pixel);
    // Compare at the tap's plane depth, but average at the centre receiver.
    if (sm+PCSS_BIAS<d) { bSum+=sm-(d-q.z); bN+=1.0; }
  }
  var pen=0.0; if (bN>0.0) { pen=SUN_TAN_RADIUS*(q.z-bSum/bN); }
  if (pen<PCSS_HARD_TEXELS*WS.depth.z) { return acc; }
  var lit=0.0;
  for (var i=0; i<PCSS_TAPS; i++) {
    let o=R2*VOGEL[i]*pen; let pixel=vec2i(floor(q.xy+o*WS.depth.w));
    let d=worldSunReceiverDepth(q,pixel,slope); let sm=worldSunDepthTap(pixel);
    if (sm+PCSS_BIAS>=d) { lit+=1.0; }
  }
  return tr*min(2.0*lit/f32(PCSS_TAPS),1.0);
}
fn sunMapShadowAt(p: vec3f) -> vec3f {
  let q=worldSunProject(p); let i0=vec2i(floor(q.xy-0.5)); let w=fract(q.xy-0.5); var acc=vec3f(0.0);
  var cD=0.0; var cW=0.0;
  for (var k=0; k<4; k++) {
    let o=vec2i(k&1,k>>1u); let sm=worldSunTap(i0+o); let wk=wk0(o,w);
    acc+=select(0.0,1.0,q.z<sm.x+VOLUME_SHADOW_BIAS)*shadowTexelAtt(sm,q.z)*wk;
    let tid=i32(sm.w/SHADOW_TINT_ID_SCALE);
    if (tid>0 && underPool(sm,q.z,tid)) { cD+=(q.z-sm.y)*wk; cW+=wk; }
  }
  if (${caustics} && cW>0.0) { acc*=mix(1.0,causticGain(p,cD/cW),cW); }
  return acc;
}
`; }
