// CPU-only production codec, transport/wire lifecycle, avatar and body checks.
// node --experimental-vm-modules tools/world-coop-cpu-check.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import * as THREE from 'three';
import * as codec from '../src/net/codec.js';
import * as protocol from '../src/net/protocol.js';
import { atlasDims } from '../src/shaders/common.js';
import { createPlayer } from '../src/pov/player.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { PROBE, PROBE_CELLS } from '../src/shaders/povBody.js';
import { E } from '../src/elements.js';

const tick = () => new Promise((r) => setImmediate(r));
// The net's frames go through the codec's CompressionStream/DecompressionStream (zlib off the main thread),
// which finish when they finish: a slower runner's long after any fixed count of timer turns. So every
// encode and decode the net starts is tracked (load() hands the net these wrappers of the real codec), and
// settle() returns once none is in flight and a macrotask turn has run every promise chain after them.
// SLOW_CODEC_MS holds each one back as a slow runner's would, past the 20 x 1 ms the timer-count wait gave
// them, so a wait on anything but the work itself fails here as it did on CI.
const SLOW_CODEC_MS = 100;
const codecWork = new Set();
const slowed = (fn) => (...args) => {
  const work = fn(...args).then((out) => new Promise((r) => setTimeout(() => r(out), SLOW_CODEC_MS)));
  codecWork.add(work);
  work.then(() => codecWork.delete(work), () => codecWork.delete(work));
  return work;
};
const settle = async () => { for (;;) { await tick(); if (!codecWork.size) return; await Promise.allSettled(codecWork); } };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const metadata = (origin = [0, 0, 0], id = 'session:world:1') => ({ v: 1, id, mode: 'world', scene: 'island', seed: 1,
  origin, size: [1024, 64, 1024], focus: [origin[0] + 32, 4, origin[2] + 32], away: false });
let now = 10000;
globalThis.GPUBufferUsage = { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 };
function simulation(dims = [64, 64, 64], { delayPack = null, delayUnpack = null, delayRead = null } = {}) {
  const g = { nx: dims[0], ny: dims[1], nz: dims[2], slots: dims.reduce((a, b) => a * b, 1), ...atlasDims({ nx: dims[0], ny: dims[1], nz: dims[2] }) };
  const sim = { id: 1, g, origin: new THREE.Vector3(), L: {}, header: () => [], readHeader() { return this.header(); }, bytes: new Uint8Array(g.width * g.height * 4),
    writes: 0, paints: [], frame: 0, gravity: 0.025, disposed: false, noteWrite() { this.writes++; }, stillFlow() {}, paint(s) { this.paints.push(s); }, touchCentres: (lo, hi) => ({ lo, hi }) };
  const gpu = sim.gpu = {
    layout: () => ({}), createBuffer: ({ size }) => ({ size, data: new Uint8Array(size), destroy() {} }),
    bindGroup: (_, entries) => entries[0].resource.buffer,
    kernel({ name }) {
      const wait = name === 'pack' ? delayPack : delayUnpack;
      const k = { state: wait ? 'building' : 'ready', ready: wait?.promise ?? Promise.resolve(),
        dispatch(_, __, { bind }) { if (name === 'pack' || name === 'packNative') bind[2].data.set(sim.bytes); else sim.bytes.set(bind[2].data); } };
      k.ready.then(() => { k.state = 'ready'; }); return k;
    },
    write: (buffer, _, bytes) => buffer.data.set(bytes),
    readback: { buffer: async (buffer, at = 0, n = buffer.size - at, { into } = {}) => { const captured = buffer.data.slice(at, at + n); await delayRead?.promise;
      if (!into) return captured.buffer; new Uint8Array(into).set(captured); return into; } },
  };
  return sim;
}

// Dispatch metadata must not come from request time, nor from readback time.
{
  const compile = deferred(), read = deferred(), sim = simulation(undefined, { delayPack: compile, delayRead: read });
  const packer = codec.createPacker(); let origin = [0, 0, 0];
  const pending = packer.pack(sim, () => metadata(origin.slice()));
  origin = [16, 0, 0]; sim.bytes[0] = 7; compile.resolve(); await settle();
  origin = [32, 0, 0]; sim.bytes[0] = 9; read.resolve();
  const capture = await pending;
  assert.deepEqual(capture.meta.origin, [16, 0, 0]); assert.equal(capture.bytes[0], 7); capture.release();
  const frame = await codec.encodeFrame(codec.FRAME_KEY, 1, capture.dims, capture.bytes, capture.meta);
  const decoded = await codec.decodeFrame(frame);
  assert.deepEqual(decoded.meta, capture.meta); assert.equal(decoded.body[0], 7);
  const legacy = await codec.decodeFrame(await codec.encodeFrame(codec.FRAME_KEY, 1, capture.dims, capture.bytes));
  assert.equal(legacy.meta, null);
  await assert.rejects(codec.decodeFrame(new ArrayBuffer(4)));
  const bad = frame.slice(0); new Uint32Array(bad)[7] = 10;
  await assert.rejects(codec.decodeFrame(bad), /body length/);
  const badDims = frame.slice(0); new Uint32Array(badDims)[3] = 0xffffffff;
  await assert.rejects(codec.decodeFrame(badDims), /dimensions/);
  assert.equal(protocol.validMetadata({ ...metadata(), origin: [Infinity, 0, 0] }), false);
}
// No delayed upload may leak bytes or origin into a disconnected/rebuilt sim.
{
  const compile = deferred(), sim = simulation(undefined, { delayUnpack: compile }), unpack = codec.createUnpacker();
  let valid = true, commits = 0;
  const p = unpack.unpack(sim, sim.bytes.slice().fill(3), { valid: () => valid, commit: () => commits++ });
  valid = false; compile.resolve(); assert.equal(await p, false); assert.equal(sim.writes, 0); assert.equal(commits, 0);
  valid = true;
  await unpack.unpack(sim, sim.bytes.slice().fill(4), { valid: () => valid, commit: () => { assert.equal(sim.bytes[0], 0); commits++; } });
  assert.equal(sim.bytes[0], 4); assert.equal(sim.writes, 1);
}
console.log('ok codec: dispatch-time metadata, bounded envelope, legacy box decode, atomic epoch-guarded unpack');

// Tiny DOM/WebSocket adapters, not a parallel implementation of multiplayer.
const nodes = [];
class Node {
  constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.events = {}; this.style = { setProperty() {} }; this.classes = new Set();
    this.classList = { add: (...v) => v.forEach((x) => this.classes.add(x)), remove: (...v) => v.forEach((x) => this.classes.delete(x)), toggle() {} }; nodes.push(this); }
  addEventListener(n, fn) { this.events[n] = fn; }
  setAttribute(n, v) { this[n] = v; }
  append(...v) { this.children.push(...v); }
  replaceChildren(...v) { this.children = v; }
  contains() { return false; }
  remove() {}
}
const sockets = [];
class Socket {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
  message(data) { this.onmessage?.({ data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data }); }
}
const document = { body: new Node('body'), hidden: false, createElement: (tag) => new Node(tag), createTextNode: (text) => text, addEventListener() {}, querySelector: () => new Node('toolbar') };
const location = { href: 'https://test/', search: '', pathname: '/', hostname: 'test' };
const context = vm.createContext({ console, document, location, history: { replaceState() {} }, WebSocket: Socket,
  navigator: { clipboard: { writeText: async () => {} } }, crypto: { randomUUID: () => 'abcdef0012345678' },
  performance: { now: () => now }, addEventListener() {}, URL, URLSearchParams, setTimeout, clearTimeout, Uint8Array, Uint32Array, ArrayBuffer,
  CompressionStream, DecompressionStream, Blob, Response, TextEncoder, TextDecoder });
const mocked = {
  '/src/pov/figureReal.js': { createBody: () => ({ root: new THREE.Object3D(), compile: async () => {}, bind() {}, setVisible() {}, update() {}, dispose() {} }) },
  '/src/net/cursors.js': { createRemoteCursors: () => ({ set() {}, remove() {}, clear() {}, update() {} }) },
  '/src/net/chat.js': { MAX_CHAT_CHARS: 256, createChat: () => ({ clear() {}, say() {}, notice() {}, open() {} }) },
  '/src/account.js': { sessionToken: () => null },
};
const modules = new Map();
async function load(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  let mod;
  const mock = Object.entries(mocked).find(([path]) => url.pathname.endsWith(path))?.[1];
  if (mock || url.pathname.endsWith('.css')) {
    const exports = mock ?? {};
    mod = new vm.SyntheticModule(Object.keys(exports), function () { for (const [k, v] of Object.entries(exports)) this.setExport(k, v); }, { context });
  } else if (['/src/net/multiplayer.js', '/src/wire/mp.js', '/src/net/players.js', '/src/ui/dom.js'].some((p) => url.pathname.endsWith(p))) {
    mod = new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href,
      initializeImportMeta(meta) { meta.env = { VITE_RELAY_URL: 'ws://test' }; } });
  } else {
    let exports = await import(url.href);
    if (url.pathname.endsWith('/src/net/codec.js')) exports = { ...exports, encodeFrame: slowed(exports.encodeFrame), decodeFrame: slowed(exports.decodeFrame) };
    mod = new vm.SyntheticModule(Object.keys(exports), function () { for (const [k, v] of Object.entries(exports)) this.setExport(k, v); }, { context });
  }
  modules.set(url.href, mod);
  if (mod instanceof vm.SourceTextModule) await mod.link((name) => load(name === 'three' ? new URL('../node_modules/three/build/three.module.js', import.meta.url) : new URL(name, url)));
  else await mod.link(() => {});
  await mod.evaluate(); return mod;
}
const netModule = await load(new URL('../src/net/multiplayer.js', import.meta.url));
const createMultiplayer = netModule.namespace.createMultiplayer;
const cursor = { visible: false };
function client(role, options = {}) {
  let sim = options.sim ?? simulation(), meta = metadata();
  const commits = [], toasts = [], bodies = new Map(); let clears = 0, catches = 0;
  location.search = role === 'guest' ? '?join=abcdef00' : '';
  const firstNode = nodes.length;
  const net = createMultiplayer({ getSim: () => sim, getVolume: () => null, hud: { toast: (s) => toasts.push(s) },
    inWorld: () => meta.mode === 'world', getMetadata: () => meta,
    setGrid(dims, m) { if (!m || m.id !== meta.id || !dims.every((n, i) => n === [sim.g.nx, sim.g.ny, sim.g.nz][i])) {
      sim.disposed = true; sim = simulation(dims); sim.id++; }
      if (m) meta = m; return true; },
    commitFrame(m) { commits.push(m); if (m) sim.origin.fromArray(m.origin); },
    catchUp() { catches++; },
    avatars: { set: (id, p) => bodies.set(id, p), remove: (id) => bodies.delete(id), clear() { bodies.clear(); clears++; }, update() {} },
    ...options,
  });
  const ready = async () => {
    if (role === 'host') await nodes.slice(firstNode).find((n) => n.className === 'icon-btn net-btn').events.click();
    const ws = sockets.at(-1);
    ws.message({ t: 'welcome', id: role, n: role === 'host' ? 0 : 1, role, peers: [{ id: role === 'host' ? 'guest' : 'host', n: role === 'host' ? 1 : 0, role: role === 'host' ? 'guest' : 'host' }] });
    return ws;
  };
  return { net, ready, commits, bodies, toasts, get sim() { return sim; }, get meta() { return meta; }, set meta(m) { meta = m; },
    get catches() { return catches; }, get clears() { return clears; },
    update() { now += 110; net.update(0.11, cursor); },
  };
}
const host = client('host'), hws = await host.ready();
const guest = client('guest'), gws = await guest.ready();
assert.equal(guest.net.terrainReady, false); assert.equal(guest.net.replica, true);
assert.ok(gws.sent.some((s) => typeof s === 'string' && JSON.parse(s).t === 'key'));
async function hostFrame() { host.update(); await settle(); const frames = hws.sent.filter((x) => x instanceof ArrayBuffer); return frames.at(-1); }
async function deliver(buf) { gws.message(buf); await settle(); guest.update(); await settle(); }
await deliver(await hostFrame());
assert.equal(guest.net.terrainReady, true); assert.equal(guest.net.stale, false);
const first = await codec.decodeFrame(hws.sent.filter((x) => x instanceof ArrayBuffer).at(-1));
assert.equal(first.kind, codec.FRAME_KEY);
// Identical cells with a shifted origin must send a key, not disappear.
host.meta = metadata([16, 0, 0]);
const shift = await hostFrame(); assert.equal((await codec.decodeFrame(shift)).kind, codec.FRAME_KEY);
await deliver(shift); assert.equal(guest.sim.origin.x, 16);
assert.equal(guest.net.metadata.origin[0], 16);
// Stale queued edits cannot paint after the host shifts between receipt and update.
const stroke = { t: 'paint', from: 'guest', context: protocol.stamp(host.meta), c: [32, 4, 32], r: 2, shape: 0, tool: E.SAND, rate: 1 };
hws.message(stroke); host.meta = metadata([32, 0, 0]); host.update(); assert.equal(host.sim.paints.length, 0);
hws.message({ ...stroke, context: protocol.stamp(host.meta) }); host.update(); assert.equal(host.sim.paints.length, 1);
hws.message({ ...stroke, context: protocol.stamp(host.meta), e: [1e20, 0, 0] }); host.update(); assert.equal(host.sim.paints.length, 1);
// Dropped delta asks for a key; next key recovers.
const bytes = host.sim.bytes.slice(), dims = [64, 64, 64];
await deliver(await codec.encodeFrame(codec.FRAME_DELTA, 999, dims, bytes, host.meta));
assert.equal(guest.net.metadata.origin[0], 16);
await deliver(await codec.encodeFrame(codec.FRAME_KEY, 1000, dims, bytes, host.meta));
assert.equal(guest.net.metadata.origin[0], 32);
// Validated poses: host relays the sender identity, rejects NaN/outside/old sequences.
const pose = { t: 'pose', from: 'guest', map: host.meta.id, seq: 1, active: true, p: [64, 4, 32], vel: [1, 0, 0], yaw: 0, pitch: 0, warp: 0 };
hws.message(pose); assert.equal(host.bodies.size, 1);
hws.message({ ...pose, seq: 2, p: [9999, 4, 32] });
assert.ok(hws.sent.some((s) => typeof s === 'string' && JSON.parse(s).t === 'catchup'));
hws.message({ ...pose, seq: 3, yaw: Infinity }); assert.equal(host.bodies.get('guest').seq, 1);
gws.message({ t: 'catchup', from: 'host', peer: 'guest', map: host.meta.id }); assert.equal(guest.catches, 1);
gws.message({ ...pose, from: 'host', peer: 'host' }); assert.equal(guest.bodies.size, 1);
gws.message({ t: 'leave', id: 'host' }); assert.equal(guest.bodies.size, 0); assert.equal(guest.net.frozen, true);
assert.match(guest.toasts.at(-1), /choose a map/); guest.net.resumeSolo(); assert.equal(guest.net.replica, false);
// Async decode racing a disconnect/rejoin may not install a map or cells.
const late = client('guest'), lws = await late.ready();
lws.message(await codec.encodeFrame(codec.FRAME_KEY, 1, dims, bytes, metadata([0, 0, 16], 'late-map')));
lws.onclose({ reason: 'test disconnect' }); await settle(); late.update(); await settle();
assert.equal(late.commits.length, 0); assert.equal(late.sim.writes, 0);
// A new map, and a World->box change, must replace old stream identity.
const maps = client('guest'), mws = await maps.ready();
async function mapFrame(m, n) { mws.message(await codec.encodeFrame(codec.FRAME_KEY, n, dims, bytes, m)); await settle(); maps.update(); await settle(); }
await mapFrame(metadata(), 1); await mapFrame(metadata([0, 0, 0], 'new-map'), 2);
assert.equal(maps.net.metadata.id, 'new-map');
await mapFrame({ ...metadata([0, 0, 0], 'box-map'), mode: 'box', size: dims }, 3);
assert.equal(maps.net.metadata.mode, 'box');
mws.message({ t: 'away', from: 'host', away: true }); assert.equal(maps.net.stale, true);
mws.message({ t: 'away', from: 'host', away: false }); now += 3000; assert.equal(maps.net.stale, true);
console.log('ok production multiplayer: join-before-frame, shift metadata, stale edits, delta recovery, validated poses, map/box lifecycle, disconnect decode epoch, host away/stale');

// A V2 host (its box's owner presents it): native frames, the version handshake, guests' held strokes.
{
  const owner = { isReady: true, disposed: false, aux: { size: 64, data: new Uint8Array(64), destroy() {} }, dynamics: null };
  const v2sim = simulation(); v2sim.compact = v2sim.compactOwner = owner;
  v2sim.bytes.fill(5);
  const nhost = client('host', { sim: v2sim, getMetadata: () => null }), nhws = await nhost.ready();   // (a box: no heartbeat metadata)
  const ng = client('guest'), ngws = await ng.ready();
  const told = ngws.sent.filter((x) => typeof x === 'string').map((x) => JSON.parse(x));
  assert.ok(told.findIndex((m) => m.t === 'hello') >= 0 && told.findIndex((m) => m.t === 'hello') < told.findIndex((m) => m.t === 'key'), 'a guest says its build before it asks for terrain');
  assert.equal(told.find((m) => m.t === 'hello').v, protocol.NET_VERSION);
  nhws.message({ t: 'hello', from: 'guest', v: protocol.NET_VERSION }); nhws.message({ t: 'key', from: 'guest' });
  nhost.update(); await settle();
  const stream = () => nhws.sent.filter((x) => x instanceof ArrayBuffer);
  const nf = stream().at(-1), d = await codec.decodeFrame(nf);
  assert.equal(d.kind, codec.FRAME_NATIVE_KEY, 'a V2 host streams native frames'); assert.equal(d.native.records.length, 0);
  // a guest of this build without a native owner (V1, or still building) reads a native frame's texels
  ngws.message(nf); await settle(); ng.update(); await settle();
  assert.equal(ng.net.terrainReady, true); assert.equal(ng.sim.bytes[7], 5);
  const framesBefore = stream().length;
  nhost.update(); await settle();
  assert.equal(stream().length, framesBefore, 'a frame that changes nothing (cells or section) is not sent');
  // A build from before native frames (no hello) is sent the outdated frame, once; this build ignores it.
  nhws.message({ t: 'join', id: 'old', n: 2, role: 'guest' });
  nhws.message({ t: 'key', from: 'old' }); nhws.message({ t: 'key', from: 'old' });
  const isOutdated = (f) => new Uint32Array(f, 0, 2)[1] === codec.OUTDATED_SEQ;
  // (codec.outdatedFrame's deflate isn't one of the tracked net encodes: wait for the frame itself)
  for (let i = 0; i < 200 && !stream().some(isOutdated); i++) await new Promise((r) => setTimeout(r, 5));
  await settle();
  const outdated = stream().filter(isOutdated);
  assert.equal(outdated.length, 1, 'one outdated frame per old guest');
  const commits = ng.commits.length; ngws.message(outdated[0]); await settle(); ng.update(); await settle();
  assert.equal(ng.commits.length, commits, 'this build ignores another guest\'s outdated frame');
  assert.equal(ng.net.role, 'guest');
  // The old build itself (the base commit's net modules, run as they shipped) meets this host: it fails a native
  // frame (its key loop) and the outdated frame then ends its session with a reason, instead of looping.
  // the last main build before the version handshake (tagged v1-oracle): fixed, so the check holds on main itself,
  // where a merge-base with origin/main is this build (the deploy checks out full history: deploy.yml fetch-depth 0)
  const base = '19a98c9e';
  const old = (f) => execFileSync('/usr/bin/git', ['show', `${base}:src/net/${f}`], { cwd: new URL('..', import.meta.url).pathname }).toString();
  const netDir = new URL('../src/net/', import.meta.url), oldModules = new Map();
  async function loadOld(name, from) {
    const file = name.startsWith('./') && ['codec.js', 'protocol.js', 'edits.js', 'multiplayer.js'].includes(name.slice(2)) ? name.slice(2) : null;
    if (!file) return load(new URL(name, from));
    if (oldModules.has(file)) return oldModules.get(file);
    const mod = new vm.SourceTextModule(old(file), { context, identifier: `old:${file}`, initializeImportMeta(meta) { meta.env = { VITE_RELAY_URL: 'ws://test' }; } });
    oldModules.set(file, mod);
    await mod.link((n) => loadOld(n, netDir)); return mod;
  }
  const oldNet = await loadOld('./multiplayer.js', netDir); await oldNet.evaluate();
  const oldToasts = []; let oldSim = simulation();
  location.search = '?join=abcdef00';
  const oldGuest = oldNet.namespace.createMultiplayer({ getSim: () => oldSim, getVolume: () => null, hud: { toast: (t) => oldToasts.push(t) },
    // the shipped app's setGrid: a box no map has (app.js SIZES) is refused
    setGrid: (dims) => [64, 96, 128].includes(dims[0]) && dims.every((n) => n === dims[0]) || (dims[0] === 160 && dims[1] === 96), getMetadata: () => null });
  const ows = sockets.at(-1);
  ows.message({ t: 'welcome', id: 'old', n: 2, role: 'guest', peers: [{ id: 'host', n: 0, role: 'host' }] });
  assert.ok(!ows.sent.some((x) => typeof x === 'string' && JSON.parse(x).t === 'hello'), 'the old build sends no hello');
  const keysBefore = ows.sent.filter((x) => typeof x === 'string' && JSON.parse(x).t === 'key').length;
  now += 2000; ows.message(nf);
  for (let i = 0; i < 200 && ows.sent.filter((x) => typeof x === 'string' && JSON.parse(x).t === 'key').length === keysBefore; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(oldGuest.role, 'guest', 'a native frame alone leaves the old build asking for keyframes (the loop this ends)');
  assert.ok(ows.sent.filter((x) => typeof x === 'string' && JSON.parse(x).t === 'key').length > keysBefore);
  ows.message(outdated[0]);
  // (the old build's own decode, untracked here: wait for its outcome, bounded)
  for (let i = 0; i < 200 && oldGuest.role !== 'solo'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(oldGuest.role, 'solo', 'the outdated frame ends the old build\'s session');
  assert.match(oldToasts.at(-1), /this version/, `the old build says why: ${oldToasts.at(-1)}`);
  // A newer host's stream (a kind or a version this build doesn't know) ends this build's session: update, not a loop.
  const nn = client('guest'), nnws = await nn.ready();
  const future = nf.slice(0); new Uint32Array(future, 0, 1)[0] = codec.FRAME_NATIVE_DELTA + 1;
  nnws.message(future); await settle();
  assert.equal(nn.net.role, 'solo'); assert.equal(nn.toasts.at(-1).startsWith(protocol.UPDATE_GAME), true);
  const nv = client('guest'), nvws = await nv.ready();
  nvws.message({ t: 'version', from: 'host', peer: 'guest', need: protocol.NET_VERSION + 1 });
  assert.equal(nv.net.role, 'solo'); assert.ok(nv.toasts.at(-1).startsWith(protocol.UPDATE_GAME));
  // C10: a stroke the host's engine can't take yet (a native kernel still building) waits and paints later.
  let building = 2; v2sim.paint = function (st) { if (building-- > 0) return false; this.paints.push(st); return true; };
  const sand = { t: 'paint', from: 'guest', context: null, c: [32, 4, 32], r: 2, shape: 0, tool: E.SAND, rate: 1 };
  nhws.message(sand); nhost.update(); nhost.update();
  assert.equal(v2sim.paints.length, 0, 'held while the kernel builds');
  nhost.update(); assert.equal(v2sim.paints.length, 1, 'the guest\'s dab paints once it can');
}
console.log('ok V2 host: native frames, V1-guest texels, unchanged-frame skip, hello before key, outdated frame (ignored here; ends the shipped old build), newer host -> update, held guest strokes');

// Remote presentation uses the real createBody interface, with a CPU render double.
const { createRemotePlayers } = (await load(new URL('../src/net/players.js', import.meta.url))).namespace;
const rendered = [], bodies = [], scene = new THREE.Scene(), vol = new THREE.Object3D(), avatarSim = simulation();
const avatars = createRemotePlayers({ scene, getSim: () => avatarSim, getVolume: () => vol,
  makeBody: ({ choice }) => (bodies.push(choice()), { root: new THREE.Object3D(), compile: async () => {}, bind() {}, setVisible(v) { this.root.visible = v; },
    update(dt, s) { rendered.push({ x: s.feet.x, yaw: s.yaw }); }, dispose() {} }) });
const a = { ...pose, yaw: Math.PI - 0.1, p: [30, 4, 30] }, b = { ...pose, seq: 2, yaw: -Math.PI + 0.1, p: [40, 4, 30] };
avatars.set('a', a); avatars.update(0.1); avatars.set('a', b); avatars.update(0.05);
assert.ok(Math.abs(rendered.at(-1).yaw - Math.PI) < 0.01); assert.equal(rendered.at(-1).x, 35);
avatars.set('a', { ...b, seq: 3, warp: 1, p: [90, 4, 30] }); avatars.update(0.01); assert.equal(rendered.at(-1).x, 90);
assert.deepEqual(bodies, ['real'], 'other players show as the male wizard');
avatars.clear(); assert.equal(scene.children.length, 0);
console.log('ok avatars: male wizard, shortest-angle interpolation, warp snap, lifecycle cleanup');

// Real guest body, with probes of received terrain and all edit sinks counted.
{
  const sim = simulation([64, 64, 64]); let writes = 0;
  sim.paint = () => writes++;
  setPovGpu(sim, { ready: true, edit: () => { writes++; }, transfer: () => { writes++; return null; },
    probe(name, { boxLo: b }) {
      const data = new Float32Array(PROBE_CELLS * 4);
      for (let y = 0; y < PROBE.Y; y++) for (let z = 0; z < PROBE.Z; z++) for (let x = 0; x < PROBE.X; x++) {
        const i = ((y * PROBE.Z + z) * PROBE.X + x) * 4, cx = b[0] + x, cy = b[1] + y;
        data[i] = cy < 4 || cx >= 42 ? E.STONE : E.EMPTY; data[i + 1] = 6000;
      }
      return Promise.resolve(data.buffer);
    } });
  const body = createPlayer({ getSim: () => sim, renderer: {}, quiet: true, readOnly: () => true });
  body.spawn(new THREE.Vector3(32, 4, 32));
  for (let i = 0; i < 100; i++) { body.update(0.02, { move: { x: 1, z: 0 } }); await tick(); }
  assert.ok(body.pos.x > 32 && body.pos.x <= 41.21, `collision x=${body.pos.x}`);
  assert.equal(body.clearance(), true);
  const y = body.pos.y;
  for (let i = 0; i < 12; i++) { body.update(0.02, { jump: true }); await tick(); }
  assert.ok(body.pos.y > y, 'guest jumps');
  for (let i = 0; i < 120; i++) { body.update(0.02, { jump: true }); await tick(); }
  assert.ok(body.jetFuel < 1, 'guest jets');
  body.perks.add('FREEZE_FIELD'); body.perks.add('RAIN_CLOUD'); body.perks.add('REVENGE_EXPLOSION');
  body.hurt(100, 'test', { lethal: true }); body.kick(new THREE.Vector3(1, 0, 0));
  for (let i = 0; i < 10; i++) { body.update(0.02); await tick(); }
  assert.equal(body.dead, false); assert.equal(writes, 0);
  body.teleport(new THREE.Vector3(34, 4, 32)); assert.equal(body.clearance(), null);
  body.update(0); await tick(); assert.equal(body.clearance(), true);
  body.dispose();
}
console.log('ok real guest body: received-terrain collision, jump/jet, safe catchup probe, zero coupling/fields/kick/hazard writes');
console.log('World co-op CPU checks passed (no browser/GPU).');
