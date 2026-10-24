// CPU only (no GPU, no browser): V2's flying packets take the Box sun's shadow and GI and cast its shadow, as V1's
// flying cells (grid cells the shadow kernel traces and the volume lights) do (R4; shaders/v2/packetShadow.js,
// gfx/packetShadow.js, shaders/v2/particleRender.js particleLightWGSL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, PerspectiveCamera, WebGPUCoordinateSystem } from 'three';
import { gridLayout } from '../../src/sim.js';
import { shadowFrag, shadowRes } from '../../src/shaders/render.js';
import { RENDER_LAYOUT } from '../../src/shaders/bindings.js';
import { packetShadowFrag, packetShadowSplatWGSL, packetShadowWords, PACKET_SHADOW_EMPTY, PACKET_RETRACE_WORDS } from '../../src/shaders/v2/packetShadow.js';
import { nativeParticleWGSL, NATIVE_PARTICLE_LIGHT_LAYOUT, NATIVE_PARTICLE_WORLD_LIGHT_LAYOUT, PARTICLE_SHADOW_LIFT, particleWorldLightWGSL, NativeParticleParams, ParticleWorldLight } from '../../src/shaders/v2/particleRender.js';
import { SHADOW_LIFT, meshLightWGSL } from '../../src/gfx/meshLight.js';
import { frameBindings } from '../../src/shaders/bindings.js';
import { worldMeshSunWGSL, worldMeshAmbientWGSL } from '../../src/shaders/worldMeshLight.js';
import { LIGHT_RECORDS } from '../../src/world/renderAtlas.js';
import { WORLD_SUN_PITCH } from '../../src/world/worldSun.js';
import { GI_OFFSET_CELLS } from '../../src/shaders/gfx/lighting.js';
import { WgslParser, WgslExec, VectorData, ScalarData } from 'wgsl_reflect/wgsl_reflect.module.js';
import { NativeParticles, boxParticleLight } from '../../src/gfx/nativeParticles.js';
import raysWire from '../../src/wire/rays.js';
import { packetShadowKey } from '../../src/gfx/packetShadow.js';
import { readFileSync } from 'node:fs';
import { SHADOW_TILES_MAX } from '../../src/shaders/passes.js';
import { assertNaga } from './wgsl-grouping.mjs';

const g = gridLayout(64, 64, 64), res = shadowRes(g);

test('V2\'s shadow kernel is V1\'s trace, the packets folded in; V1\'s own text is untouched', () => {
  const v1 = shadowFrag(g), v2 = packetShadowFrag(g, res);
  assert.doesNotMatch(v1, /packetShadow/, 'V1 boxes trace without the packets');
  // the same module up to the texel's store: the trace is V1's, a packet folded into its result
  const cut = v1.indexOf('  let oC = shadowTexel(ro, safeDir(-FU.sun));');
  assert.ok(cut > 0); assert.equal(v2.slice(0, cut), v1.slice(0, cut));
  assert.match(v2, /let oC = packetShadowFold\(id\.xy, res, shadowTexel\(ro, safeDir\(-FU\.sun\)\)\);\n  textureStore\(tShadow, id\.xy, oC\);/);
  // a packet nearer the sun than the texel's first opaque surface is it; the word cleared, the tile traced again
  assert.match(v2, /o\.x = min\(o\.x, bitcast<f32>\(front\)\)/);
  assert.match(v2, /atomicExchange\(&packetShadow\[id\.y \* res \+ id\.x\], PS_EMPTY\)/);
  assert.match(v2, /atomicOr\(&packetShadow\[PS_RETRACE \+ \(tile >> 5u\)\]/);
  // its layout: V1's shadow variant and the packet buffer
  const layout = RENDER_LAYOUT.LIGHTING_SHADOW_PACKETS, base = RENDER_LAYOUT.LIGHTING_SHADOW;
  assert.deepEqual(layout.filter(e => e.binding !== 20), base);
  assert.equal(layout.find(e => e.binding === 20).buffer.type, 'storage');
  assert.equal(packetShadowWords(res), res * res + PACKET_RETRACE_WORDS); assert.equal(PACKET_RETRACE_WORDS * 32, SHADOW_TILES_MAX);
  assertNaga(v2, 'shadowPackets'); assertNaga(packetShadowSplatWGSL(g, res), 'packetShadowSplat');
});

// The splat's and the fold's geometry (shaders/v2/packetShadow.js: lighting.js sunBasis, shadowProject), on the CPU:
// a SAND packet 18 cells over a floor shadows the floor where the sun's ray through it lands, not a cell beside it.
function shadowGeometry(sun, packet, radius = Math.cbrt(3 / (4 * Math.PI))) {
  const n = [g.nx, g.ny, g.nz], c = n.map(x => x / 2), R = 0.5 * Math.hypot(...n) + 1;
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(...a); return a.map(x => x / l); }, dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const u = norm(cross([0, 1, 0], sun)), v = cross(sun, u), T = 2 * R / res;
  const project = p => { const q = p.map((x, i) => x - c[i]); const st = [dot(q, u), dot(q, v)].map(x => x / R * 0.5 + 0.5); return { f: st.map(x => x * res - 0.5), d: R - dot(q, sun) }; };
  // the splat: each texel whose ray meets the sphere, its front depth (atomicMin)
  const map = new Map(), q = project(packet), rt = radius / T;
  for (let y = Math.floor(q.f[1] - rt); y <= Math.ceil(q.f[1] + rt); y++) for (let x = Math.floor(q.f[0] - rt); x <= Math.ceil(q.f[0] + rt); x++) {
    const ray = [(x + 0.5) / res * 2 - 1, (y + 0.5) / res * 2 - 1].map(k => k * R);
    const at = [dot(packet.map((k, i) => k - c[i]), u), dot(packet.map((k, i) => k - c[i]), v)];
    const h2 = radius * radius - ((ray[0] - at[0]) ** 2 + (ray[1] - at[1]) ** 2);
    if (h2 > 0) map.set(`${x},${y}`, Math.max(q.d - Math.sqrt(h2), 0));
  }
  // the fold, then sunMapShadow's hard test at a floor point (a texel with no packet: the floor is first)
  return p => { const r = project(p), x = Math.round(r.f[0]), y = Math.round(r.f[1]); const front = map.get(`${x},${y}`) ?? Infinity; return r.d < front + 0.8 ? 1 : 0; };
}
test('a packet\'s splat shadows the floor along the sun\'s ray through it, as its cell would be traced', () => {
  for (const sun of [[0.3, 0.8, 0.52], [-0.5, 0.7, 0.2], [0, 1, 0.001]]) {
    const s = sun.map(x => x / Math.hypot(...sun)), packet = [30.5, 20.5, 28.5];
    const lit = shadowGeometry(s, packet), t = (packet[1] - 2) / s[1], under = [packet[0] - s[0] * t, 2, packet[2] - s[2] * t];
    assert.equal(lit(under), 0, `the floor under it along ${sun}`);
    assert.equal(lit([under[0] + 2, 2, under[2]]), 1, 'a floor point beside its shadow');
    assert.equal(lit([packet[0], 25, packet[2]]), 1, 'a point between it and the sun');
  }
});

const camera = () => { const c = new PerspectiveCamera(55, 16 / 9, 0.1, 1000); c.coordinateSystem = WebGPUCoordinateSystem; c.position.set(0, 0, 10); c.updateProjectionMatrix(); c.updateMatrixWorld(); return c; };
const buffer = size => ({ size, words: new Uint32Array(size / 4), destroy() {} });
test('the matter draw lights its sphere with the Box volume\'s map and GI where bound, the open sky\'s where not', () => {
  const wgsl = nativeParticleWGSL(false);
  // lighting.js hitLight: the sun through the map (and the clouds), the GI probe GI_OFFSET out along the normal
  assert.match(wgsl, /let light = FU\.sunCol \* FU\.sunExt \* max\(dot\(normal,sun\),0\.0\) \* particleSun\(hit, gridNormal\);/);
  assert.match(wgsl, /if \(P\.light != 0u\) \{ ambient = particleGI\(hit, gridNormal\); \}/);
  assert.match(wgsl, /let cloud = cloudShadow\(hp \+ P\.origin\);/);
  assert.doesNotMatch(nativeParticleWGSL(true), /particleSun|particleGI/, 'rays glow, unlit, as V1\'s sprites');
  assertNaga(wgsl, 'nativeParticleMatter');
  // the draw: group 2 of the matter pipe holds the volume's map, bands and noise, P.light 1; none: stand-ins, 0
  const calls = [], g = { frame: {}, _frameUniforms: { layout: {}, group: {} }, layout: (_n, l) => l, bindGroup: (l, entries) => ({ l, entries }),
    createBuffer: d => buffer(d.size), flush() {}, createTexture: d => ({ ...d, createView: () => ({ texture: d.label }) }),
    device: { createSampler: d => ({ sampler: d?.label }) }, _volumeSamplers: { clamp: { s: 'clamp' }, repeat: { s: 'repeat' } },
    renderPipeline(d) { return { state: 'ready', ready: Promise.resolve(), draw(_rp, o) { calls.push({ name: d.name, o }); } }; },
    kernel() { return { state: 'ready', ready: Promise.resolve(), dispatch() {} }; } };
  globalThis.GPUBufferUsage ??= { STORAGE: 128, INDIRECT: 256 };
  const s = { isIdle: false, particles: buffer(65536 * 48), control: buffer(16), attachDrawAdapter() {}, get ready() { return Promise.resolve(); },
    get renderState() { return { version: 1, particleBytes: 48, capacity: 65536, position: 'world cells', particleIdOffset: 12, coreOffsets: [28, 32, 36, 40], bankOffset: 44, liveCountOffset: 0, particles: this.particles, control: this.control, ready: true }; } };
  const a = new NativeParticles(g, s); a.updateView(camera(), 720, new Matrix4(), [0, 0, 0]); a.prepareDraw(g.frame);
  const view = name => ({ createView: () => ({ view: name }) });
  const volume = { shadowTextures: { map: view('map') }, mediaNoiseView: { view: 'noise' } }, derived = { views: { gi: ['g0', 'g1', 'g2', 'g3'].map(n => ({ view: n })) } };
  const light = boxParticleLight(volume, derived, g);
  assert.ok(light); assert.equal(boxParticleLight({}, derived, g), null, 'World\'s volume: none');
  a.draw({ frame: g.frame }, { width: 640, height: 360 }, light);
  const matter = calls.find(c => c.name === 'nativeParticleMatter');
  assert.equal(matter.o.params.light, 1);
  const entries = Object.fromEntries(matter.o.bind[2].entries.map(e => [e.binding, e.resource]));
  assert.deepEqual(entries[1], { view: 'map' }); assert.deepEqual([2, 3, 4, 5].map(b => entries[b].view), ['g0', 'g1', 'g2', 'g3']);
  assert.deepEqual(entries[6], { view: 'noise' }); assert.equal(entries[7].s, 'clamp'); assert.equal(entries[8].s, 'repeat');
  assert.equal(matter.o.bind[2].l, NATIVE_PARTICLE_LIGHT_LAYOUT);
  calls.length = 0; a.prepareDraw(g.frame); a.draw({ frame: g.frame }, { width: 640, height: 360 }, null);
  assert.equal(calls.find(c => c.name === 'nativeParticleMatter').o.params.light, 0, 'no light bound: the open sky');
  assert.equal(PACKET_SHADOW_EMPTY, 0xffffffff);
  // the wire hands the draw the GPU volume's light (app.vol), not the three Object3D (app.volume: its matrix only),
  // which left every packet in the open sky's light (the first GPU check: 168 in the plate's shadow, 170 in the sun)
  const got = [];
  const app = { post: { sceneTarget: { width: 640, height: 360 } }, sim: { compact: {}, gpu: g }, worldMode: null,
    nativeParticles: { isReady: true, draw: (_rp, _t, l) => got.push(l) }, volume: { matrixWorld: new Matrix4() }, vol: volume, derived };
  raysWire.scene(app, { frame: g.frame });
  assert.equal(got[0]?.map, volume.shadowTextures.map, 'the Box draw lights its packets with the volume\'s map');
  raysWire.scene({ ...app, worldMode: {} }, { frame: g.frame });
  assert.equal(got[1]?.map, volume.shadowTextures.map, 'a big map\'s window lights them the same way');
});

test('World lights its packets with its atlas and paged sun, as its figures (not the open sky)', async () => {
  const wgsl = nativeParticleWGSL(false, true);
  assertNaga(wgsl, 'nativeParticleMatterWorld');
  assert.equal(PARTICLE_SHADOW_LIFT, SHADOW_LIFT, 'the figures\' lift toward the sun');
  // wmlSun's taps and wmlAmbient's probes (shaders/worldMeshLight.js), in world cells
  assert.match(wgsl, /let p = hp \+ P\.origin \+ FU\.sun \* PARTICLE_SHADOW_LIFT;/);
  assert.match(wgsl, /wmlSunTap\(i0 \+ o, particleWorldSun, PW\.world/);
  assert.match(wgsl, /wmlProbe\(particleGI0, at, PARTICLE_GI_READY, particleWorldAux/);
  assert.doesNotMatch(nativeParticleWGSL(false), /wmlSunTap/, 'the Box pipe reads the Box volume\'s');
  const calls = [], g = { frame: {}, _frameUniforms: { layout: {}, group: {} }, layout: (_n, l) => l, bindGroup: (l, entries) => ({ l, entries }),
    createBuffer: d => buffer(d.size), flush() {}, createTexture: d => ({ ...d, createView: () => ({ texture: d.label }) }),
    device: { createSampler: d => ({ sampler: d?.label }) }, writes: [], write(b, o, d) { this.writes.push({ b, o, d }); },
    renderPipeline(d) { return { state: 'ready', ready: Promise.resolve(), draw(_rp, o) { calls.push({ name: d.name, o }); } }; },
    kernel() { return { state: 'ready', ready: Promise.resolve(), dispatch() {} }; } };
  globalThis.GPUBufferUsage ??= { STORAGE: 128, INDIRECT: 256 }; globalThis.GPUBufferUsage.UNIFORM ??= 64; globalThis.GPUBufferUsage.COPY_DST ??= 8;
  const s = { isIdle: false, particles: buffer(65536 * 48), control: buffer(16), attachDrawAdapter() {}, get ready() { return Promise.resolve(); },
    get renderState() { return { version: 1, particleBytes: 48, capacity: 65536, position: 'world cells', particleIdOffset: 12, coreOffsets: [28, 32, 36, 40], bankOffset: 44, liveCountOffset: 0, particles: this.particles, control: this.control, ready: true }; } };
  const a = new NativeParticles(g, s); a.updateView(camera(), 720, new Matrix4(), [0, 0, 0]);
  await a.worldReady();
  a.prepareDraw(g.frame);
  const tex = name => ({ texture: { createView: d => ({ view: name, ...d }) } });
  const light = { world: true, aux: tex('aux'), gi: ['g0', 'g1', 'g2', 'g3'].map(tex), sun: tex('sun'), noise: tex('noise'),
    book: buffer(16), sunBook: buffer(16), requests: buffer(16), params: { world: [9, 9, 9, 1], projection: Array(16).fill(1) } };
  a.draw({ frame: g.frame }, { width: 640, height: 360 }, light);
  const matter = calls.find(c => c.name === 'nativeParticleMatterWorld');
  assert.ok(matter, 'World draws its packets with its own pipe');
  assert.ok(!calls.some(c => c.name === 'nativeParticleMatter'), 'not the open sky\'s');
  assert.equal(matter.o.params.light, 1);
  assert.ok(NativeParticleParams.size <= 256, 'P still fits one ring slot: World\'s values are their own uniform');
  assert.equal(matter.o.bind[2].l, NATIVE_PARTICLE_WORLD_LIGHT_LAYOUT);
  const e = Object.fromEntries(matter.o.bind[2].entries.map(x => [x.binding, x.resource]));
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(b => e[b].view), ['aux', 'g0', 'g1', 'g2', 'g3', 'sun']);
  assert.equal(e[6].dimension, '2d-array'); assert.equal(e[7].view, 'noise');
  assert.equal(e[9].buffer, light.book); assert.equal(e[10].buffer, light.sunBook); assert.equal(e[11].buffer, light.requests);
  // binding 12: the values, packed once for a set (the next frame's same values: the same buffer and group)
  assert.equal(e[12].buffer.size, ParticleWorldLight.size);
  const w = g.writes.find((x) => x.b === e[12].buffer), u32 = new Uint32Array(w.d.buffer, w.d.byteOffset, 4);
  assert.deepEqual(Array.from(u32), [9, 9, 9, 1], 'its book\'s bricks and epoch');
  a.prepareDraw(g.frame); a.draw({ frame: g.frame }, { width: 640, height: 360 }, { ...light, params: { ...light.params } });
  assert.equal(calls.filter(c => c.name === 'nativeParticleMatterWorld').at(-1).o.bind[2], matter.o.bind[2], 'equal values, equal sources: the group kept');
});

// The CPU WGSL interpreter tools/world-mesh-light-cpu-check.mjs runs World's readers with (its adapters, copied)
class Exec extends WgslExec {
  _callBuiltinFunction(node,context){
    // 1.6.0 types vector select from its boolean condition, truncating weights.
    if(node.name==='select'){const [a,b,c]=node.args.map(x=>this.evalExpression(x,context));if(a.data?.length>1)return new VectorData(new a.data.constructor(Array.from(a.data,(v,i)=>(c.data[i]??c.value)?b.data[i]:v)),a.typeInfo);return new ScalarData((c.value??c.data[0])?b.value:a.value,a.typeInfo);}
    return super._callBuiltinFunction(node,context);
  }
  _makeCwiseData(values,type){if(type.name.startsWith('vec')&&['u32','i32'].includes(type.format?.name))return new VectorData(type.format.name==='u32'?new Uint32Array(values):new Int32Array(values),type);return super._makeCwiseData(values,type);}
  _call(node,context){const fn=context.getFunction(node.name);if(!fn)return super._call(node,context);const values=node.args.map(a=>this.evalExpression(a,context)),scope=context.clone();scope.currentFunctionName=node.name;fn.node.args.forEach((a,i)=>scope.createVariable(a.name,values[i],a));this._execStatements(fn.node.body,scope);}
  _callConstructorVec(node,context){const type=this.getTypeInfo(node.type),format=type.format?.name;if(!['u32','i32'].includes(format))return super._callConstructorVec(node,context);const n=Number(type.name.at(-1));let v=[];if(node.isVector)v=Array.from(node.vectorValue);else for(const a of node.args??[]){const q=this.evalExpression(a,context);v.push(...(q.data?.length>1?Array.from(q.data):[q.value]));}if(!v.length)v=Array(n).fill(0);if(v.length===1)v=Array(n).fill(v[0]);return new VectorData(format==='u32'?new Uint32Array(v.slice(0,n)):new Int32Array(v.slice(0,n)),type).getSubData(this,node.postfix,context);}
}
const texBinding = (data, size, format = 'rgba32float', dimension = '2d') => ({ texture: [data.buffer], descriptor: { size, format, dimension } });
test('executed: World\'s packet light is its figures\' on the same pages (a packet in a shadow dark, one in the sun lit, GI equal)', () => {
  // world-mesh-light-cpu-check's atlas: 18 x 2 x 2 bricks, every probe resident, its bands a ramp
  const dims = [18, 2, 2], count = dims.reduce((a, b) => a * b), auxW = 128, base = 132, auxH = Math.ceil((base + count * LIGHT_RECORDS) / auxW), probeW = 16, probeH = Math.ceil(count / probeW);
  const book = new Uint32Array(count), aux = new Uint32Array(auxW * auxH * 4), band = new Float32Array(probeW * probeH * 4);
  for (let i = 0; i < count; i++) {
    const id = count - 1 - i; book[i] = id + 1; aux.set([48, 1, 1, 1], (base + id * LIGHT_RECORDS) * 4); aux.set([i + 1, i + 1, 0, 0], (base + id * LIGHT_RECORDS + 1) * 4); aux.set([0, 0, 2, 7], (base + id * LIGHT_RECORDS + 3) * 4);
    const x = i % dims[0], y = Math.floor(i / dims[0]) % 2, z = Math.floor(i / (dims[0] * 2)); band.set([x + 2 * y + 3 * z, 2 * x - y, .5 * z, 1], i * 4);
  }
  const plane = Math.ceil(count / 32), status = plane * 6;
  // the sun's pages (an identity projection: texel x, y, depth z), two tiles resident; around one packet an occluder
  // at depth 0 (a plate between it and the sun), around the other nothing
  const optical = new Float32Array(2048 * 2048 * 4), sunBook = new Uint32Array(16);
  sunBook.set([0, 1, 1, 1, 0, 0, 1, 0]); sunBook.set([1, 1, 1, 1, 0, 0, 1, 0], 8);
  const origin = [90, 0, 0], pIn = [20.5, 5.5, 3], pOut = [40.5, 5.5, 3];   // world cells (the window's plus its origin)
  for (const p of [pIn, pOut]) for (let dx = -1; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++)
    optical.set(p === pIn ? [0, 0, 0, 0] : [1e5, 1e5, 1e5, 0], (Math.floor(p[0]) + dx + 2048 * (Math.floor(p[1]) + dy)) * 4);
  const run = (light) => {
    const src = `${frameBindings().match(/struct FrameUniforms \{[\s\S]*?\n\}/)[0]}
${NativeParticleParams.wgsl}
var<private> FU: FrameUniforms;
var<private> P: NativeParticleParams;
${particleWorldLightWGSL()}
${meshLightWGSL}
${worldMeshSunWGSL}
${worldMeshAmbientWGSL}
@group(0) @binding(0) var<storage, read> pts: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> outv: array<vec4f>;
@group(0) @binding(2) var sig: texture_2d<f32>;
@group(0) @binding(3) var wand: texture_2d<f32>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  FU.shadows = 1u; FU.view = 0; FU.sun = vec3f(0.0, 0.0, 1.0); FU.clouds = 0u; FU.caveAmbient = vec3f(0.1, 0.2, 0.3);
  P.light = ${light}u; P.origin = vec3f(${origin.join(',')});
  let w = pts[id.x].xyz; let n = normalize(vec3f(0.3, 0.4, 0.8)); let q = vec3f(4.0 + f32(id.x) * 20.0, 3.0, 3.0);
  // the packet's draw (window cells) and the figures' readers (world cells: the lift toward the sun, GI_OFFSET out)
  outv[id.x * 4u] = vec4f(particleSun(w - P.origin, n), 0.0);
  outv[id.x * 4u + 1u] = vec4f(wmlSun(w + FU.sun * ${PARTICLE_SHADOW_LIFT.toFixed(1)}, particleWorldSun, sig, tMediaNoise, linearRepeat, PW.world, PW.feedback, PW.projection,
    PW.depth, PW.tiles, PW.physical, PW.version, vec4f(FU.sun, 1.0), vec4f(1.0), vec4f(0.0), vec4f(FU.caveAmbient, 0.0), vec4f(0.0)), 0.0);
  outv[id.x * 4u + 2u] = vec4f(particleGI(q - P.origin, n), 0.0);
  outv[id.x * 4u + 3u] = vec4f(wmlAmbient(q, q + n * ${GI_OFFSET_CELLS.toFixed(1)}, n, particleGI0, particleGI1, particleGI2, particleGI3, particleGI0, particleWorldAux,
    PW.world, PW.light, PW.geometry, PW.feedback, wand, 0.0, vec4f(1.0, 1.0, 1.0, 0.0), vec4f(FU.caveAmbient, 0.0)), 0.0);
}`;
    const out = new Float32Array(2 * 4 * 4), requests = new Uint32Array(status + 6), tex = (d, w, h) => texBinding(d, [w, h, 1]);
    // the values as the draw packs them (gfx/nativeParticles.js worldParams)
    const values = new Uint8Array(ParticleWorldLight.pack({ world: [18, 2, 2, 1], light: [132, count, count, 7], geometry: [auxW, auxH, probeW, probeH],
      feedback: [plane, status, status + 1, 2], projection: new Matrix4().elements, depth: [0, 0, WORLD_SUN_PITCH, 2.4], tiles: [0, 0, 2, 1],
      physical: [256, 8, 64, 1], version: [1, 1, 1, status + 1] }));
    new Exec(new WgslParser().parse(src)).dispatchWorkgroups('main', 2, {
      0: { 0: new Float32Array([...pIn, 0, ...pOut, 0]), 1: out, 2: tex(new Float32Array(64 * 4), 64, 1), 3: tex(new Float32Array(16 * 4), 8, 2) },
      2: { 1: texBinding(aux, [auxW, auxH, 1], 'rgba32uint'), 2: tex(band, probeW, probeH), 3: tex(band, probeW, probeH), 4: tex(band, probeW, probeH), 5: tex(band, probeW, probeH),
        6: tex(optical, 2048, 2048), 7: texBinding(new Float32Array([.8, .8, .8, .8]), [1, 1, 1], 'rgba32float', '3d'), 8: { sampler: {} }, 9: book, 10: sunBook, 11: requests, 12: values } });
    const v = (k) => Array.from(out.subarray(k * 4, k * 4 + 3)).map((x) => +x.toFixed(4));
    return { inSun: v(0), inFig: v(1), inGI: v(2), inFigGI: v(3), outSun: v(4), outFig: v(5), outGI: v(6), outFigGI: v(7), requests };
  };
  const r = run(1);
  assert.deepEqual(r.inSun, [0, 0, 0], 'the packet under the occluder: no sun');
  assert.deepEqual(r.outSun, [1, 1, 1], 'the packet beside it: the whole sun');
  assert.deepEqual([r.inSun, r.outSun], [r.inFig, r.outFig], 'the figures\' reader (wmlSun) on the same pages, the same');
  assert.deepEqual([r.inGI, r.outGI], [r.inFigGI, r.outFigGI], 'GI: the figures\' wmlAmbient (no glow), the same');
  assert.ok(r.outGI[0] > r.inGI[0] && r.inGI[0] > 0.1, `the GI follows the probes (${r.inGI}, ${r.outGI})`);
  assert.ok(r.requests.every((x) => x === 0), 'every page resident: no requests');
  // before: World drew its packets with the Box pipe and no light bound (P.light 0): the open sky, shadow or not
  assert.deepEqual(run(0).inSun, [1, 1, 1], 'P.light 0: the open sky\'s');
  // a page not loaded yet: requested, as the figures' misses are (the frame then waits for it)
  sunBook[6] = 0; book[0] = 0;
  const miss = run(1);
  assert.equal(miss.requests[status], 1, 'a missing sun tile or probe marks the frame incomplete');
  assert.ok(miss.requests[status + 1] & 1, 'and requests the sun tile');
});

test('the derived passes run again each tick packets fly (V1\'s flying cells move the grid version; packets do not)', () => {
  const owner = { tick: 7 }, dynamics = { owner, isIdle: false, stats: { particles: 3 }, disposed: false,
    renderState: { ready: true, particles: {}, capacity: 65536 } };
  const sim = { compact: {}, compactOwner: { dynamics } };
  const a = packetShadowKey(sim, 'ready'); owner.tick++;
  assert.notEqual(packetShadowKey(sim, 'ready'), a, 'a tick of flight moves the key');
  dynamics.isIdle = true; const landed = packetShadowKey(sim, 'ready'); owner.tick++;
  assert.equal(packetShadowKey(sim, 'ready'), landed, 'landed: still (one more pass took the last shadow away)');
  assert.notEqual(packetShadowKey(sim, 'building'), packetShadowKey(sim, 'ready'), 'the kernel turning ready runs it');
  assert.equal(packetShadowKey({ compact: null }, 'none'), '', 'V1: nothing');
  const app = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /runDerived = present && pacer\.derived\(\n\s+`[^`]*\|\$\{vol\.packetShadowKey\}`\);/, 'the box\'s derived key holds it');
});
