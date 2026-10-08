import * as THREE from 'three';
import { quadVert } from '../../shaders/common.js';
import {
  transferProbeFrag, transferApplyFrag, TRANSFER_SLOTS, TRANSFER_TAKE, TRANSFER_PUT,
} from '../../shaders/transfer.js';
import { ELEMENTS } from '../../elements.js';
import { PHYS } from '../../physics.js';
import { BODY_WIDTH, BODY_HEIGHT } from '../constants.js';

// Exact cell transfer: the shared machinery the hand tools use to take cells out
// of the grid and put them back, conserving matter exactly although readbacks
// are asynchronous and the world keeps moving.
//
// take(): the caller lists candidate cells (nearest first) and a filter. A tiny
// probe pass writes what each qualifying cell holds into a TRANSFER_SLOTS × 1
// target, and a full-grid pass over the same state turns exactly those cells
// into air (shaders/transfer.js: both evaluate the same rule). The probe is read
// back asynchronously, and the promise resolves with the cells taken.
// put(): the same, the other way round. Each target cell must be empty air (a
// gas or anything else stays where it is); the probe tells which items landed.
//
// Between the passes and the readback the matter is "in flight": gone from the
// grid (take) or in the grid and reserved in the load (put). Load tracks both,
// so a load never over-fills and an item is never placed twice.

const MAX_IN_FLIGHT = 4;                 // transfers awaiting readback at once (one probe target each)
const SLOT_COMPONENTS = 4;               // RGBA per slot texel
const SLOT_ROWS = 2;                     // row 0: cells, row 1: items to place
const ANY_ID = -1;                       // slot filter: any element of the allowed kinds

export { TRANSFER_SLOTS };
export const KIND_BIT = (kind) => 1 << kind;

// A cell's contents as carried: [element id, temperature °C, life, ctype + seed].
export const cellOf = (buf, i) => [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3]];

const keyOf = (x, y, z) => `${x},${y},${z}`;

// ---------------------------------------------------------------- candidate cells

// Grid cells within `radius` of `center` (grid coords, cell centres at +0.5),
// nearest first, inside the grid, optionally filtered by keep(x, y, z).
export function cellsNear(center, radius, g, keep = null, max = TRANSFER_SLOTS) {
  const out = [];
  const r = Math.ceil(radius);
  const cx = Math.floor(center.x), cy = Math.floor(center.y), cz = Math.floor(center.z);
  for (let z = cz - r; z <= cz + r; z++)
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) continue;
        const d2 = (x + 0.5 - center.x) ** 2 + (y + 0.5 - center.y) ** 2 + (z + 0.5 - center.z) ** 2;
        if (d2 > radius * radius) continue;
        if (keep && !keep(x, y, z)) continue;
        out.push([x, y, z, d2]);
      }
  out.sort((a, b) => a[3] - b[3]);
  return out.slice(0, max).map(([x, y, z]) => [x, y, z]);
}

// keep() for cellsNear: leaves out the cells the body stands in (feet = player.pos).
export function outsideBody(feet, margin = 0) {
  const hw = BODY_WIDTH / 2 + margin;
  return (x, y, z) => x + 1 <= feet.x - hw || x >= feet.x + hw
    || z + 1 <= feet.z - hw || z >= feet.z + hw
    || y + 1 <= feet.y - margin || y >= feet.y + BODY_HEIGHT + margin;
}

// Distance along dir from eye to where the ray leaves the body's box (0 if the
// eye is outside it): a spout or a dump point past this doesn't fill the body.
export function bodyExit(eye, dir, feet, margin = 0) {
  const hw = BODY_WIDTH / 2 + margin;
  const lo = [feet.x - hw, feet.y - margin, feet.z - hw];
  const hi = [feet.x + hw, feet.y + BODY_HEIGHT + margin, feet.z + hw];
  const o = [eye.x, eye.y, eye.z], d = [dir.x, dir.y, dir.z];
  let tExit = Infinity;
  for (let k = 0; k < 3; k++) {
    if (o[k] < lo[k] || o[k] > hi[k]) return 0;
    if (d[k] > 0) tExit = Math.min(tExit, (hi[k] - o[k]) / d[k]);
    else if (d[k] < 0) tExit = Math.min(tExit, (lo[k] - o[k]) / d[k]);
  }
  return Number.isFinite(tExit) ? tExit : 0;
}

// Sim velocity (cells/step) from a velocity in cells/s, at the current step rate.
export function toStepVelocity(v, ctx, out = new THREE.Vector3()) {
  const stepsPerSecond = ctx.stepsPerFrame > 0 && ctx.dt > 0 ? ctx.stepsPerFrame / ctx.dt : 0;
  if (!stepsPerSecond) return out.set(0, 0, 0);
  out.copy(v).divideScalar(stepsPerSecond);
  if (out.length() > PHYS.V_MAX) out.setLength(PHYS.V_MAX);
  return out;
}

// ---------------------------------------------------------------- loads

// A load: cells carried by a tool, each [id, T, life, ctype + seed], kept as
// they were (no heat exchange while carried). Loads outlive the toolbelt, so
// leaving POV or switching tools never loses matter.
export class Load {
  constructor(capacity) {
    this.capacity = capacity;
    this.cells = [];
    this.reserved = 0;   // room promised to takes in flight
    this.out = 0;        // cells placed by puts in flight (still counted)
    this.version = 0;    // bumped on every change
  }
  get count() { return this.cells.length + this.out; }
  get free() { return Math.max(0, this.capacity - this.count - this.reserved); }
  get busy() { return this.reserved > 0 || this.out > 0; }
  // the element most of the load is (carried cells only), or -1 when empty
  get mainId() {
    const n = new Map();
    for (const c of this.cells) n.set(c[0], (n.get(c[0]) ?? 0) + 1);
    let best = -1, bestN = 0;
    for (const [id, k] of n) if (k > bestN) { best = id; bestN = k; }
    return best;
  }
  get mixed() { return this.cells.some((c) => c[0] !== this.cells[0][0]); }
  status() {
    if (!this.count) return null;
    const id = this.mainId;
    const abbr = id >= 0 ? ELEMENTS[id].abbr : '';
    return `${abbr}${this.mixed ? '+' : ''} ×${this.count}`;
  }
  // per-element totals, for conservation checks: { id: count }
  totals() {
    const t = {};
    for (const c of this.cells) t[c[0]] = (t[c[0]] ?? 0) + 1;
    return t;
  }
}

const loads = new Map();
// The load a tool keeps across toolbelts (POV sessions): one per key.
export function persistentLoad(key, capacity) {
  if (!loads.has(key)) loads.set(key, new Load(capacity));
  return loads.get(key);
}
export const allLoads = () => loads;

// ---------------------------------------------------------------- the transfer engine

function rawMat(frag, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader: frag, uniforms,
    depthTest: false, depthWrite: false,
  });
}

function makeProbeTarget() {
  return new THREE.WebGLRenderTarget(TRANSFER_SLOTS, 1, {
    type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}

export function createTransfer({ renderer, getSim }) {
  const slotData = new Float32Array(TRANSFER_SLOTS * SLOT_ROWS * SLOT_COMPONENTS);
  const slotTex = new THREE.DataTexture(slotData, TRANSFER_SLOTS, SLOT_ROWS, THREE.RGBAFormat, THREE.FloatType);
  const free = [...Array(MAX_IN_FLIGHT)].map(makeProbeTarget);
  let mats = null, matsKey = '';
  let inFlight = 0;

  const uniforms = () => ({
    tA: { value: null }, tB: { value: null }, tSlots: { value: slotTex },
    uCount: { value: 0 }, uLimit: { value: 0 }, uMode: { value: 0 }, uKinds: { value: 0 }, uBreak: { value: false },
  });
  function materials(sim) {
    const { nx, ny, nz } = sim.g;
    const key = `${nx}x${ny}x${nz}`;
    if (key !== matsKey) {
      mats?.probe.dispose(); mats?.apply.dispose();
      mats = {
        probe: rawMat(transferProbeFrag(sim.g), uniforms()),
        apply: rawMat(transferApplyFrag(sim.g), {
          ...uniforms(), uBoxMin: { value: new THREE.Vector3() }, uBoxMax: { value: new THREE.Vector3() },
          uVel: { value: new THREE.Vector3() },
        }),
      };
      matsKey = key;
    }
    return mats;
  }

  // Upload the slots, run both passes, and read the probe back.
  function run({ cells, wants, items, mode, kinds = 0, breakDebris = false, limit, vel }) {
    const sim = getSim();
    const n = Math.min(cells.length, TRANSFER_SLOTS);
    if (!sim || !n || limit <= 0 || !free.length) return null;
    // a cell listed twice would be taken (or filled) twice by the probe but once in the grid
    const seen = new Set();
    let count = 0;
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const [x, y, z] = cells[i];
      const k = keyOf(x, y, z);
      if (seen.has(k)) continue;
      seen.add(k);
      slotData.set([x, y, z, wants?.[i] ?? ANY_ID], count * SLOT_COMPONENTS);
      for (let a = 0; a < 3; a++) { box[a] = Math.min(box[a], cells[i][a]); box[a + 3] = Math.max(box[a + 3], cells[i][a]); }
      count++;
    }
    const row1 = TRANSFER_SLOTS * SLOT_COMPONENTS;
    if (items) for (let r = 0; r < Math.min(items.length, TRANSFER_SLOTS); r++) slotData.set(items[r], row1 + r * SLOT_COMPONENTS);
    slotTex.needsUpdate = true;

    const { probe, apply } = materials(sim);
    for (const m of [probe, apply]) {
      const u = m.uniforms;
      u.uCount.value = count;
      u.uLimit.value = Math.min(limit, TRANSFER_SLOTS);
      u.uMode.value = mode;
      u.uKinds.value = kinds;
      u.uBreak.value = breakDebris;
    }
    apply.uniforms.uBoxMin.value.set(box[0], box[1], box[2]);
    apply.uniforms.uBoxMax.value.set(box[3], box[4], box[5]);
    apply.uniforms.uVel.value.copy(vel ?? new THREE.Vector3());

    // both passes read the same state: the probe first, then the grid pass replaces it
    const target = free.pop();
    probe.uniforms.tA.value = sim.stateA;
    probe.uniforms.tB.value = sim.stateB;
    sim.run(probe, target);
    sim.pass(apply);

    const buf = new Float32Array(count * SLOT_COMPONENTS);
    inFlight++;
    const done = () => { inFlight--; free.push(target); return buf; };
    return renderer.readRenderTargetPixelsAsync(target, 0, 0, count, 1, buf).then(done, () => {
      // the async path failed (context trouble): the probe is still in the target
      renderer.readRenderTargetPixels(target, 0, 0, count, 1, buf);
      return done();
    });
  }

  return {
    get busy() { return free.length === 0; },
    get pending() { return inFlight; },

    // Take up to `load.free` (or `limit`) qualifying cells from `cells` (nearest
    // first) into `load`. kinds: element kinds allowed (K.*). want: one element
    // id only, or -1. breakDebris: solids come out as their debris. Returns a
    // promise of the taken cells, or null when nothing was issued (busy, full).
    take(load, { cells, kinds, want = ANY_ID, breakDebris = false, limit = Infinity }) {
      const n = Math.min(limit, load.free);
      if (n <= 0) return null;
      const mask = kinds.reduce((m, k) => m | KIND_BIT(k), 0);
      const wants = want === ANY_ID ? null : cells.map(() => want);
      const p = run({ cells, wants, mode: TRANSFER_TAKE, kinds: mask, breakDebris, limit: n });
      if (!p) return null;
      load.reserved += n;
      return p.then((buf) => {
        load.reserved -= n;
        const got = [];
        for (let i = 0; i < buf.length / SLOT_COMPONENTS; i++) if (buf[i * SLOT_COMPONENTS] >= 0) got.push(cellOf(buf, i));
        load.cells.push(...got);
        load.version++;
        return got;
      });
    },

    // Place up to `max` cells from `load` (the most recently loaded first) into
    // the empty cells among `cells` (nearest first), moving at `vel` cells/step.
    // Returns a promise of how many landed; the rest go back into the load.
    put(load, { cells, max = Infinity, vel }) {
      const n = Math.min(max, load.cells.length, TRANSFER_SLOTS);
      if (n <= 0) return null;
      const items = load.cells.slice(load.cells.length - n).reverse();
      const p = run({ cells, items, mode: TRANSFER_PUT, limit: n, vel });
      if (!p) return null;
      load.cells.length -= n;
      load.out += n;
      load.version++;
      return p.then((buf) => {
        load.out -= n;
        let landed = 0;
        for (let i = 0; i < buf.length / SLOT_COMPONENTS; i++) if (buf[i * SLOT_COMPONENTS] >= 0) landed++;
        // the first `landed` items went in (ranks 0..landed-1); the rest come back
        load.cells.push(...items.slice(landed).reverse());
        load.version++;
        return landed;
      });
    },

    dispose() {
      free.forEach((t) => t.dispose());
      slotTex.dispose();
      mats?.probe.dispose(); mats?.apply.dispose();
    },
  };
}

// One transfer engine per renderer, shared by every tool (and every toolbelt).
const engines = new WeakMap();
export function sharedTransfer(env) {
  if (!engines.has(env.renderer)) engines.set(env.renderer, createTransfer(env));
  return engines.get(env.renderer);
}

// ---------------------------------------------------------------- tool helpers

// ctx.aim if it hits something (a cell, or the floor: id -1) within `reach`
// cells of the eye, else null.
export function aimInReach(ctx, reach) {
  const a = ctx.aim;
  if (!a?.valid) return null;
  const dist = Number.isFinite(a.dist) ? a.dist
    : Math.hypot(a.cell.x + 0.5 - ctx.eye.x, a.cell.y + 0.5 - ctx.eye.y, a.cell.z + 0.5 - ctx.eye.z);
  return dist <= reach ? a : null;
}

// The outward normal of a pick face (shaders/render.js pickFrag: axis * 2, +1
// when the ray stepped +axis, so even faces face +axis).
export function faceNormal(face, out = new THREE.Vector3()) {
  out.set(0, 0, 0);
  out.setComponent(Math.floor(face / 2), face % 2 === 0 ? 1 : -1);
  return out;
}

// Radius of a ball of n cells.
export const ballRadius = (n) => Math.cbrt((3 * n) / (4 * Math.PI));

// Held items: unlit meshes with a fixed key light baked into vertex colours
// (the scene has no lights; the volume shades itself).
const HELD_LIGHT = new THREE.Vector3(0.4, 0.8, 0.45).normalize();   // toward the key light, view space
const HELD_AMBIENT = 0.45;   // share of the base colour a face turned away from the light keeps
const HELD_DIFFUSE = 0.6;    // share added at full facing
export function heldMesh(geometry, color) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.computeVertexNormals();
  const base = new THREE.Color(color);
  const n = g.attributes.normal, cols = new Float32Array(n.count * 3), v = new THREE.Vector3();
  for (let i = 0; i < n.count; i++) {
    const k = HELD_AMBIENT + HELD_DIFFUSE * Math.max(0, v.fromBufferAttribute(n, i).dot(HELD_LIGHT));
    cols.set([base.r * k, base.g * k, base.b * k], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
  m.frustumCulled = false;
  return m;
}
export function recolor(mesh, color) {
  mesh.material.vertexColors = false;
  mesh.material.color.set(color);
}
