// CPU only: shader reflection, cached vertex packing, field ABI and recording contracts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync,spawnSync } from 'node:child_process';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { DataUtils } from 'three';
import { Derived } from '../src/derived.js';
import { FieldDeriver } from '../src/gfx/fieldDeriver.js';
import { gridDims } from '../src/shaders/common.js';
import { uniformStruct } from '../src/gpu/params.js';
import { EmaParams, BoostParams, fieldEmaFrag, fieldBoostFrag, particleAgeFrag } from '../src/shaders/fields.js';
import { SMOOTH_CASES, SMOOTH_EDGES, SMOOTH_TETS, SMOOTH_EXTRACT_LAYOUT, SMOOTH_PREFIX_LAYOUT, SMOOTH_DRAW_LAYOUT, SMOOTH_STATE_LAYOUT, smoothExtractWGSL, smoothDrawWGSL } from '../src/shaders/hybrid/smooth.js';
import { createHybridSmooth } from '../src/gfx/hybrid/smooth.js';

export const g = gridDims({ nx: 32, ny: 32, nz: 32 });
const semantic=spawnSync('naga',['--version'],{encoding:'utf8'}).status===0;
export function reflect(code) {
  if (semantic) execFileSync('naga',['--stdin-file-path','hybrid-smooth.wgsl'],{input:code,encoding:'utf8'});
  const r = new WgslReflect(code);
  for (const stage of ['compute', 'vertex', 'fragment']) for (const fn of r.entry[stage]) {
    const storage = fn.resources.filter(v => r.storage.includes(v));
    assert(storage.length <= 8, `${fn.name}: ${storage.length} storage buffers`);
  }
  return r;
}
export function fixture(split = false) {
  const log = [], buffers = [], rings = [], reads = [], pipelines = [];
  const gpu = {
    device: { limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 128 * 1024 * 1024 } },
    _frameUniforms: { layout: {}, group: {}, last: {} }, frame: {}, emptyGroup: {},
    layout: (_n, entries) => entries, bindGroup: (_l, entries) => entries,
    createBuffer(d) { const b = { ...d, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(b); return b; },
    readback: { ring() { const r = { buffer: {}, next: () => 0, read: () => new Promise((resolve, reject) => reads.push({ resolve, reject })), close() { this.closed = true; } }; rings.push(r); return r; } },
    kernel(d) { return { state: 'ready', ready: Promise.resolve(), dispatch(_f, _n, p) { log.push({ name: d.name, ...p }); } }; },
    renderPipeline(d) { pipelines.push(d); return { state: 'ready', ready: Promise.resolve(), draw(_rp, p) { log.push({ name: d.name, ...p }); } }; },
    flush() {},
  };
  const derived = { particleSplit: split, world: null, dlist: {}, fieldSurf: {}, fieldThin: {}, views: { fieldSurf: {}, fieldThin: {} } };
  const sim = { id: 1, g, state:{A:{},B:{}}, derived, fieldSurf: derived.fieldSurf, fieldThin: derived.fieldThin, L: { TABLES: [], STATE_RO: [] }, origin: { x: 0, y: 0, z: 0 }, version: 0, cur: 0, header: () => ({}), readHeader: () => ({ format: 0 }) };
  return { gpu, sim, log, buffers, rings, reads, pipelines };
}

for (const [now, old, values] of [
  [EmaParams, uniformStruct('OldEma', { emaS: 'vec4f', emaM: 'vec4f', reset: 'u32', aer: 'u32' }), { emaS: [1, .2, .3, .4], emaM: [.5, .6, .7, .8], reset: 1, aer: 1 }],
  [BoostParams, uniformStruct('OldBoost', { s: 'vec4f', axis: 'u32', aer: 'u32' }), { s: [1, 2, 3, 4], axis: 2, aer: 1 }],
]) {
  assert.equal(now.size, old.size);
  assert.deepEqual(new Uint8Array(now.pack(values)), new Uint8Array(old.pack(values)), 'default encoded ABI identical including old padding');
  const words = new Uint32Array(now.pack({ ...values, particleSplit: 1, world: 1 }));
  assert.deepEqual([...words.slice(-2)], [1, 1]);
}
const d = Object.assign(Object.create(Derived.prototype), { particleSplit: false, sim: {} });
assert.equal(d.setParticleSplit(false), false);
assert.equal(d.setParticleSplit(true), true);
assert(d.sim.fieldReset && d.sim.changedAll);
d.sim.fieldReset = d.sim.changedAll = false;
assert.equal(d.setParticleSplit(true), false);
assert(!d.sim.fieldReset && !d.sim.changedAll);
assert.equal(d.setParticleSplit(false), true);
assert(d.sim.fieldReset && d.sim.changedAll);
// Exercise real dispatch parameter plumbing without allocating GPU resources.
const calls = [];
Object.assign(d, {
  g, gpu: { emptyGroup: {} }, world: [32, 32, 32], frameNo: 0,
  kernels: Object.fromEntries(['fieldEma', 'fieldBlur', 'fieldFinal', 'fieldBoost0', 'fieldBoost', 'fieldPeak', 'age', 'dirty', 'dirtyArgs', 'particleAges'].map(n => [n, n])),
  groups: { blur: [{}, {}, {}], boost: [{}, {}, {}], book: {}, particleAges: {}, particleBook: {} },
  _over: x => x, _jet: () => 1, _carry() {},
  _dispatch(kernel, size, opts) { calls.push({ kernel, size, ...opts }); },
});
Object.assign(d.sim, { smoothing: 1, header: () => ({}), readHeader: () => ({}), actNoted: true });
d.fields = new FieldDeriver(d.gpu, {
  g, resources: { dlist: {} }, layouts: {}, groups: d.groups, tables: d.sim.tables,
  kernels: Object.fromEntries(['fieldEma', 'fieldBlur', 'fieldFinal', 'fieldBoost0', 'fieldBoost', 'fieldPeak']
    .map(name => [name, { dispatch(_frame, size, opts) { d._dispatch(name, size, opts); } }])),
});
d.fields.aer = 1;
for (const split of [false, true]) {
  d.setParticleSplit(split); calls.length = 0;
  d.updateDirty();
  assert.equal(calls.some(c => c.kernel === 'particleAges'), split);
  assert.equal(calls.find(c => c.kernel === 'dirty').bind[2], split ? d.groups.particleBook : d.groups.book);
  if (split) assert(calls.findIndex(c => c.kernel === 'particleAges') < calls.findIndex(c => c.kernel === 'dirty'));
  calls.length = 0; d.updateFields();
  for (const c of calls.filter(c => ['fieldEma', 'fieldBoost0', 'fieldBoost'].includes(c.kernel))) {
    assert.equal(c.params.particleSplit, Number(split)); assert.equal(c.params.world, 1); assert.equal(c.params.aer, 1);
  }
  assert.equal(d.sim.fieldReset, false);
}
const ema = fieldEmaFrag(g), boost = fieldBoostFrag(g, 0), extract = smoothExtractWGSL(g);
assert(ema.indexOf('if (particleOwned) { sv[ch] = 0.0; }') > ema.indexOf('sv = mix('));
assert.match(ema, /ch >= 0 && !particleOwned/);
assert.match(boost, /hybridParticleOwns\(q, P.world != 0u\)/);
assert.match(boost, /jetAt\(q\) && !\(P.particleSplit != 0u && hybridParticleOwns/);
assert.match(ema, /jetAt\(p\) && !particleOwned/);
assert.match(extract, /source == SLOTS\) \{ continue;/);
assert(!extract.includes('textureLoad(thin'));
assert.match(extract, /SURFCH\(eid\(s\)\) == ch && d < best && !/);
assert.match(extract, /args\[0\] = select\(0u,required,bad == 0u\)/);
assert.match(extract, /let required = total\*3u/);
for (const code of [ema, boost, fieldBoostFrag(g, 1), particleAgeFrag(g), extract, smoothDrawWGSL(g)]) reflect(code);
for (const [code, layouts] of [[extract, [SMOOTH_EXTRACT_LAYOUT, SMOOTH_PREFIX_LAYOUT]], [smoothDrawWGSL(g), [SMOOTH_DRAW_LAYOUT]]]) {
  const r = reflect(code);
  for (const entry of [...r.entry.compute, ...r.entry.vertex, ...r.entry.fragment]) {
    const layout = entry.name === 'finish' ? layouts[1] : layouts[0];
    for (const v of entry.resources.filter(v => v.group === 2)) assert(layout.some(e => e.binding === v.binding), `${entry.name} binding ${v.binding}`);
    // Explicit pipeline layouts reserve both A/B and the tables buffer too.
    assert(layout.filter(e => e.buffer).length + 3 <= 8);
  }
}
for (let mask = 0; mask < 16; mask++) {
  assert(SMOOTH_CASES[mask].length <= 2);
  for (const tri of SMOOTH_CASES[mask]) for (const e of tri) {
    const [a, b] = SMOOTH_EDGES[e];
    assert.notEqual((mask >> a) & 1, (mask >> b) & 1);
  }
  assert.equal(SMOOTH_CASES[mask].length, SMOOTH_CASES[15 - mask].length);
}
// Adjacent cubes have exactly the same face triangulation after translation.
const corner = i => [i & 1, (i >> 1) & 1, i >> 2];
for (let axis = 0; axis < 3; axis++) {
  const face = side => SMOOTH_TETS.flatMap(t => {
    const v = t.map(corner).filter(p => p[axis] === side);
    return v.length === 3 ? [v.map(p => p.filter((_, i) => i !== axis).join(',')).sort().join('|')] : [];
  }).sort();
  assert.deepEqual(face(0), face(1));
}
const f = fixture(); let wakes = 0;
const renderer = createHybridSmooth(f.gpu, f.sim, { onRead: () => wakes++ });
assert.equal(renderer.resources.maxVertices, 2 ** 21);
assert(renderer.capabilities.particleSplit);
assert.equal(renderer.update({ revision: 1, particleSplit: true }), false);
f.sim.derived.particleSplit = true;
assert(renderer.update({ revision: 1, particleSplit: true }));
assert(renderer.stats.pending);
assert(!renderer.stats.fallbackRequired);
assert(renderer.draw({}));
assert(renderer.drawShadow({}, { matrix: Array(16).fill(0) }));
for(const p of f.pipelines) assert.deepEqual(p.layouts[1],SMOOTH_STATE_LAYOUT,'camera and shadow vertex state visibility');
for(const draw of f.log.filter(c=>/smooth\.(draw|shadow)$/.test(c.name))){
  assert.deepEqual(draw.bind[1].map(e=>e.resource.buffer),[f.sim.state.A,f.sim.state.B],'use the matching vertex-visible bind group');
}
assert.deepEqual(f.log.slice(0, 4).map(x => x.name), ['hybrid.smooth.extract', 'hybrid.smooth.finish', 'hybrid.smooth.build', 'hybrid.smooth.draw']);
assert.equal(f.log[0].params.particleSplit, 1);
for (let revision = 2; revision < 5; revision++) { assert(renderer.update({ revision })); assert(renderer.draw({})); }
f.reads.at(-1).resolve(new Uint32Array([1, 2000, 1000, 1]).buffer);
await Promise.resolve();
assert.equal(wakes, 1);
assert.equal(renderer.stats.requiredVertices, 1000);
assert.equal(renderer.stats.count, 2000);
assert.equal(renderer.stats.fallbackReason, 'capacity-overflow');
assert(!renderer.draw({}));
assert(renderer.update({ revision: 5 })); assert(renderer.draw({}));
renderer.dispose(); renderer.dispose();
assert(f.buffers.every(b => b.destroyed)); assert(f.rings.every(r => r.closed));
const source = readFileSync(new URL('../src/derived.js', import.meta.url), 'utf8');
assert.match(source, /particleSplit \? this.groups.particleBook : book/);
assert.match(source, /this.fields.recordSpatial\([^\n]*particleSplit, world/);
const fieldSource = readFileSync(new URL('../src/gfx/fieldDeriver.js', import.meta.url), 'utf8');
assert.match(fieldSource, /params: \{ s, axis, aer: this.aer, particleSplit, world \}/);
// Packing mirror: five IEEE halfs and one untouched 32-bit physical state slot.
const unit = n => { const l = Math.hypot(...n); return n.map(x => x/l); };
const sign = x => x < 0 ? -1 : 1;
function oct(n) {
  const d = n.reduce((a,x) => a+Math.abs(x),0), p = n.map(x => x/d);
  return p[2] < 0 ? [(1-Math.abs(p[1]))*sign(p[0]),(1-Math.abs(p[0]))*sign(p[1])] : p.slice(0,2);
}
function unoct([x,y]) {
  const z = 1-Math.abs(x)-Math.abs(y);
  return unit(z < 0 ? [(1-Math.abs(y))*sign(x),(1-Math.abs(x))*sign(y),z] : [x,y,z]);
}
const half = DataUtils.toHalfFloat, unhalf = DataUtils.fromHalfFloat;
const pack2 = (x,y) => (half(x) | (half(y)<<16)) >>> 0;
for (const n of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
  const decoded = unoct(oct(n).map(x => unhalf(half(x))));
  assert(n.every((x,i) => Math.abs(x-decoded[i]) < 1e-7));
}
assert.equal(unhalf(half(3.5)),3.5); // preserve half-texel support beyond nominal [-2,3]
let maxPositionError = 0, minNormalDot = 1;
for (let i=0; i<4096; i++) {
  const p = [Math.sin(i)*2.5+.5, Math.cos(i)*2.5+.5, (i/4095)*5-2];
  const n = unit([Math.sin(i*.71),Math.cos(i*.23),Math.sin(i*.37)]), o = oct(n);
  const slot = (0xf1230000+i) >>> 0;
  const rec = new Uint32Array([pack2(p[0],p[1]),pack2(p[2],o[0]),pack2(o[1],0),slot]);
  assert.equal(rec.byteLength,16); assert.equal(rec[3],slot);
  const q = [unhalf(rec[0]&65535),unhalf(rec[0]>>>16),unhalf(rec[1]&65535)];
  maxPositionError = Math.max(maxPositionError,...p.map((x,j) => Math.abs(x-q[j])));
  const decoded = unoct([unhalf(rec[1]>>>16),unhalf(rec[2]&65535)]);
  minNormalDot = Math.min(minNormalDot,n.reduce((d,x,j) => d+x*decoded[j],0));
}
assert(maxPositionError < .002); assert(minNormalDot > .99999);
// Prefix/copy mirror: empty chunks, relocation, unchanged skips, whole overflow,
// and recovery after overflow (the shader forces a full rebuild on status!=0).
let active=0, offsets=[0,0,0], counts=[0,0,0], arenas=[[],[]], failed=false;
function generation(next, capacity) {
  const changed = next.map(x => x !== null || failed);
  counts = next.map((x,i) => x?.length ?? counts[i]);
  const old = offsets; let total=0;
  offsets = counts.map(n => { const at=total; total+=n; return at; });
  const args = total > capacity ? [0,0,0,0] : [total,1,0,0];
  failed = total > capacity;
  let writes=0;
  if (!failed && changed.some(Boolean)) {
    const dest=1-active;
    for (let b=0;b<counts.length;b++) for(let j=0;j<counts[b];j++) {
      arenas[dest][offsets[b]+j] = changed[b] ? next[b][j] : arenas[active][old[b]+j]; writes++;
    }
    active=dest;
  }
  return {args,writes,data:arenas[active].slice(0,total)};
}
assert.deepEqual(generation([[1,2,3],[],[7,8,9]],12).data,[1,2,3,7,8,9]);
assert.deepEqual(generation([[4,5,6,10,11,12],null,null],12).data,[4,5,6,10,11,12,7,8,9]);
const parity=active;
assert.equal(generation([null,null,null],12).writes,0); assert.equal(active,parity);
assert.deepEqual(generation([null,[1,2,3,4,5,6],null],12).args,[0,0,0,0]);
assert.equal(active,parity);
assert.deepEqual(generation([[1,2,3],[],[4,5,6]],12).data,[1,2,3,4,5,6]);
const drawCode=smoothDrawWGSL(g);
for (const banned of ['fn smoothSource','fn smoothNormal','textureLoad(surf','while (lo','TRI_EDGES']) assert(!drawCode.includes(banned));
assert(drawCode.indexOf('let footprint =') < drawCode.indexOf('discard;'));
assert.match(drawCode,/v.stateA, footprint/);
assert.match(extract,/status\[3\] == 0u/);
assert.match(extract,/args\[1\] = select\(0u,1u,bad == 0u\)/);
assert.match(extract,/chunkMeta\[4u\*b\+1u\] = chunkMeta\[4u\*b\+2u\]/);
const extra = [{binding:4,visibility:2,buffer:{type:'uniform'}}];
const sf=fixture(), sr=createHybridSmooth(sf.gpu,sf.sim,{shader:{layout:extra,bind:[{binding:4,resource:{buffer:{}}}]}});
sr.update({revision:1}); sr.draw({}); sr.drawShadow({},{matrix:Array(16).fill(0)});
assert.equal(sf.log.at(-2).bind[2].length,4);
assert.deepEqual(sf.log.at(-1).bind[2].map(e=>e.binding),[1,2,3]);
assert.deepEqual(sf.pipelines.find(p=>p.name.endsWith('shadow')).layouts[2],SMOOTH_DRAW_LAYOUT);
const before=sf.log.length; assert(!sr.update({revision:1})); assert.equal(sf.log.length,before);
sr.update({revision:2,previousRevision:1,incremental:true}); assert.equal(sf.log.at(-3).params.full,0);
sr.update({revision:3,previousRevision:0,incremental:true}); assert.equal(sf.log.at(-3).params.full,1);
assert(sf.log.filter(x=>x.name.endsWith('draw')||x.name.endsWith('shadow')).every(x=>x.indirect.buffer===sr.resources.args));
sr.dispose();
sf.reads.at(-1).resolve(new Uint32Array([0,1,3,1]).buffer); await Promise.resolve();
assert.equal(sr.stats.fallbackReason,'disposed');
// A box V2 takes over after the Test view was made: its format-2 draw is built then (isReady holds
// the hybrid off until it is), and its vertex state is V2's own cells, not the legacy copies.
const nf=fixture(), nr=createHybridSmooth(nf.gpu,nf.sim);
assert(!nf.pipelines.some(p=>/format2/.test(p.name)),'a V1 box builds no V2 draw');
assert(nr.update({revision:1}) && nr.draw({}));
assert.equal(nf.log.at(-1).name,'hybrid.smooth.draw'); assert.equal(nf.log.at(-1).bind[1][0].resource.buffer,nf.sim.state.A);
Object.assign(nf.sim,{compact:{isReady:true,cells:{label:'v2 cells'}},readHeader:()=>({format:2})});
assert(nr.isReady && nf.pipelines.some(p=>p.name==='hybrid.smooth.draw.format2') && nf.pipelines.some(p=>p.name==='hybrid.smooth.shadow.format2'));
assert(nr.update({revision:2}) && nr.draw({}) && nr.drawShadow({},{matrix:Array(16).fill(0)}));
for (const c of nf.log.slice(-2)) {
  assert.match(c.name,/format2$/); assert.equal(c.header.format,2);
  assert.equal(c.bind[1][0].resource.buffer,nf.sim.compact.cells,'V2 surfaces read V2 cells');
}
assert.equal(nf.log.filter(c=>/extract|build/.test(c.name)).at(-1).header.format,2,'extraction reads V2 cells as format 2');
nr.dispose();
const limited=fixture(); limited.gpu.device.limits.maxStorageBufferBindingSize=65536;
const lr=createHybridSmooth(limited.gpu,limited.sim); assert.equal(lr.resources.maxVertices,4096); lr.dispose();
console.log(`PASS smooth packing: 4096 records, max position error ${maxPositionError.toFixed(7)}, min normal dot ${minNormalDot.toFixed(7)}, exact u32 slots`);
console.log('PASS smooth CPU: field ABI/default-zero, reset, split/history/jet guards, reflection/layout <=8 storage, tetra cases/seams, source selection, prefix relocation/copy/no-change, overflow zero draw/recovery, base-only shadow, footprint-before-discard, same-frame draw, revision continuity, diagnostics wake, device limit, disposal, V2 takeover (format-2 draw on V2 cells)');
