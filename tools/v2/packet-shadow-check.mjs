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
import { nativeParticleWGSL, NATIVE_PARTICLE_LIGHT_LAYOUT, NATIVE_PARTICLE_WORLD_LIGHT_LAYOUT, PARTICLE_SHADOW_LIFT } from '../../src/shaders/v2/particleRender.js';
import { SHADOW_LIFT } from '../../src/gfx/meshLight.js';
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
  const worldLight = { world: true };
  raysWire.scene({ ...app, worldMode: {} }, { frame: g.frame }, worldLight);
  assert.equal(got[1], worldLight, 'World: the frame\'s own light (app.drawWorldAfter\'s)');
});

test('World lights its packets with its atlas and paged sun, as its figures (not the open sky)', async () => {
  const wgsl = nativeParticleWGSL(false, true);
  assertNaga(wgsl, 'nativeParticleMatterWorld');
  assert.equal(PARTICLE_SHADOW_LIFT, SHADOW_LIFT, 'the figures\' lift toward the sun');
  // wmlSun's taps and wmlAmbient's probes (shaders/worldMeshLight.js), in world cells
  assert.match(wgsl, /let p = hp \+ P\.origin \+ FU\.sun \* PARTICLE_SHADOW_LIFT;/);
  assert.match(wgsl, /wmlSunTap\(i0 \+ o, particleWorldSun, P\.wWorld/);
  assert.match(wgsl, /wmlProbe\(particleGI0, at, PARTICLE_GI_READY, particleWorldAux/);
  assert.doesNotMatch(nativeParticleWGSL(false), /wmlSunTap/, 'the Box pipe reads the Box volume\'s');
  const calls = [], g = { frame: {}, _frameUniforms: { layout: {}, group: {} }, layout: (_n, l) => l, bindGroup: (l, entries) => ({ l, entries }),
    createBuffer: d => buffer(d.size), flush() {}, createTexture: d => ({ ...d, createView: () => ({ texture: d.label }) }),
    device: { createSampler: d => ({ sampler: d?.label }) },
    renderPipeline(d) { return { state: 'ready', ready: Promise.resolve(), draw(_rp, o) { calls.push({ name: d.name, o }); } }; },
    kernel() { return { state: 'ready', ready: Promise.resolve(), dispatch() {} }; } };
  globalThis.GPUBufferUsage ??= { STORAGE: 128, INDIRECT: 256 };
  const s = { isIdle: false, particles: buffer(65536 * 48), control: buffer(16), attachDrawAdapter() {}, get ready() { return Promise.resolve(); },
    get renderState() { return { version: 1, particleBytes: 48, capacity: 65536, position: 'world cells', particleIdOffset: 12, coreOffsets: [28, 32, 36, 40], bankOffset: 44, liveCountOffset: 0, particles: this.particles, control: this.control, ready: true }; } };
  const a = new NativeParticles(g, s); a.updateView(camera(), 720, new Matrix4(), [0, 0, 0]);
  await a.worldReady();
  a.prepareDraw(g.frame);
  const tex = name => ({ texture: { createView: d => ({ view: name, ...d }) } });
  const light = { world: true, aux: tex('aux'), gi: ['g0', 'g1', 'g2', 'g3'].map(tex), sun: tex('sun'), noise: tex('noise'),
    book: buffer(16), sunBook: buffer(16), requests: buffer(16), params: { wWorld: [9, 9, 9, 1], wProjection: Array(16).fill(1) } };
  a.draw({ frame: g.frame }, { width: 640, height: 360 }, light);
  const matter = calls.find(c => c.name === 'nativeParticleMatterWorld');
  assert.ok(matter, 'World draws its packets with its own pipe');
  assert.ok(!calls.some(c => c.name === 'nativeParticleMatter'), 'not the open sky\'s');
  assert.equal(matter.o.params.light, 1); assert.deepEqual(matter.o.params.wWorld, [9, 9, 9, 1]);
  assert.equal(matter.o.bind[2].l, NATIVE_PARTICLE_WORLD_LIGHT_LAYOUT);
  const e = Object.fromEntries(matter.o.bind[2].entries.map(x => [x.binding, x.resource]));
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(b => e[b].view), ['aux', 'g0', 'g1', 'g2', 'g3', 'sun']);
  assert.equal(e[6].dimension, '2d-array'); assert.equal(e[7].view, 'noise');
  assert.equal(e[9].buffer, light.book); assert.equal(e[10].buffer, light.sunBook); assert.equal(e[11].buffer, light.requests);
  // the World frame hands its mesh context's light to the after wires, and waits for the pipe before its frames
  const frame = readFileSync(new URL('../../src/wire/worldRenderFrame.js', import.meta.url), 'utf8');
  assert.match(frame, /app\.drawWorldAfter\(rp,context\.particleLight\)/);
  assert.match(frame, /app\.nativeParticles\?\.worldReady\(\)\]\);/);
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
