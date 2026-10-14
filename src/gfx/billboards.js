// Billboards: small analytic particle pools that replace three.quarks
// (docs/webgpu.md F8, misc-three map 7.12: it has no WebGPU path) for the POV
// effects (pov/vfx.js) and the birds' motes (birds/render.js). A pool is one
// instanced draw per (texture, blend, mode), as quarks batched them. A spawn
// writes one record and uploads only it; the vertex stage then evaluates the
// particle's whole life from it: a ballistic path under gravity with linear
// drag, solved exactly, its size over life (a grow factor through quarks's
// Bézier ease) and its alpha over life (a fade). So the CPU does nothing per
// frame and uploads nothing per frame, and a dead particle is just one past its
// life (a degenerate quad).
//
//   const pool = createBillboards({ name, capacity, texture: 'dot' | 'star', blending: 'additive' | 'normal', stretched });
//   scene.add(pool.mesh);                       // after prepareMesh(pool.mesh) (gfx/meshLight.js)
//   pool.burst(n, (p) => p.set(pos, vel, size, rgb, alpha, life, { gravity, drag, grow, fade, stretch, move }), { tag, max });
//   pool.update(dt);                            // the pool's clock: ages every particle
//   pool.count(tag)                             // alive (with that tag)
//
// A record (world units, seconds):
//   p0, v0      where it was born, and its velocity then
//   gravity     its fall (units/s², down), drag its linear drag (1/s): v' = −g ŷ − drag·v
//   size        across at birth; grow: across at the end of its life × this,
//               through quarks's GROW Bézier (1, 1 + 0.6 (k − 1), 1 + 0.9 (k − 1), k)
//   rgb, alpha  its colour (linear HDR) and opacity at birth
//   fade        FADE.OUT: alpha falls linearly to 0; FADE.SHARP: to 0.6 by 40 % of
//               its life, then to 0 (quarks's ColorOverLife gradients)
//   stretch     0: a round billboard turned by `rotation`; else a streak along its
//               velocity, `stretch` seconds of travel long (quarks's stretched
//               billboard, speedFactor × size), its width `size`
//   move        0 keeps it where it was born (a tracer: its velocity only orients it)
//   birth       the pool's clock when it is first drawn: a spawn is aged by the
//               next update before it shows, so it starts that much later
import {
  InstancedBufferGeometry, InstancedBufferAttribute, BufferAttribute, Mesh, MeshBasicNodeMaterial, DataTexture,
  LinearFilter, CustomBlending, AddEquation, SrcAlphaFactor, OneFactor, OneMinusSrcAlphaFactor, DynamicDrawUsage, Vector3,
} from 'three/webgpu';
import {
  attribute, uniform, varying, texture, uv, vec2, vec3, vec4, float, exp, max, min, clamp, mix, select, length, normalize,
  cross, cos, sin, cameraViewMatrix, cameraProjectionMatrix, positionGeometry,
} from 'three/tsl';

export const FADE = { OUT: 0, SHARP: 1 };
const DRAG_EPS = 1e-4;       // 1/s: below this the path is the drag-free parabola
const VEL_EPS = 1e-6;        // a streak's speed below which it has no direction
const MAX_RANGES = 16;       // upload ranges per attribute before they merge into one

// ---- the sprites: a soft dot and the flash's spiky star (vfx.js's), 64 px
const TEX_SIZE = 64;
const DOT_FALLOFF = 2;                  // alpha = (1 − r²)^this
const FLASH_SPIKES = 6;                 // rays in the flash texture
const FLASH_SPIKE_SHARP = 6;            // higher = thinner rays
const FLASH_CORE = 0.35;                // radius share of the flash's round core
const dotAlpha = (r) => (r >= 1 ? 0 : (1 - r * r) ** DOT_FALLOFF);
const flashAlpha = (r, th) => {
  if (r >= 1) return 0;
  const core = dotAlpha(r / FLASH_CORE);
  const ray = Math.abs(Math.cos(th * FLASH_SPIKES / 2)) ** FLASH_SPIKE_SHARP * (1 - r) ** 2;
  return core + ray + dotAlpha(r) * 0.25;
};
function makeTexture(alphaAt, size = TEX_SIZE) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size * 2 - 1, v = (y + 0.5) / size * 2 - 1;
      const a = Math.min(1, Math.max(0, alphaAt(Math.hypot(u, v), Math.atan2(v, u))));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const t = new DataTexture(data, size, size);
  t.magFilter = t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}
const TEXTURES = {};
/** A shared sprite: 'dot' (a soft round dot) or 'star' (the muzzle flash's rays). */
export function sprite(kind, size = TEX_SIZE) {
  const key = `${kind}${size}`;
  TEXTURES[key] ??= makeTexture(kind === 'star' ? flashAlpha : dotAlpha, size);
  return TEXTURES[key];
}

// the record's attributes, four floats each: [p0, birth], [v0, life], [rgb, alpha],
// [size, gravity, drag, stretch], [rotation, grow, fade, move]
const SLOTS = ['iA', 'iB', 'iC', 'iD', 'iE'];

/**
 * A pool of `capacity` billboards drawn by one instanced mesh.
 * @param {{ name: string, capacity: number, texture?: 'dot' | 'star' | object, blending?: 'additive' | 'normal',
 *   stretched?: boolean, textureSize?: number }} o
 */
export function createBillboards({ name, capacity, texture: tex = 'dot', blending = 'additive', stretched = false, textureSize = TEX_SIZE }) {
  const geo = new InstancedBufferGeometry();
  // one quad, x and y −0.5..0.5 (quarks's), two triangles
  geo.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const arrays = {};
  for (const k of SLOTS) {
    const a = new InstancedBufferAttribute(new Float32Array(4 * capacity), 4);
    a.setUsage(DynamicDrawUsage);
    geo.setAttribute(k, a);
    arrays[k] = a;
  }
  geo.instanceCount = capacity;
  // never born: life 0, so every slot starts dead
  const clock = uniform(0);

  // ---- the vertex stage: the particle's state at its age, then the quad
  const A = attribute('iA', 'vec4'), B = attribute('iB', 'vec4'), C = attribute('iC', 'vec4'), D = attribute('iD', 'vec4'), Ex = attribute('iE', 'vec4');
  const age = clock.sub(A.w), life = B.w;
  const t = clamp(age.div(max(life, 1e-6)), 0, 1);
  const living = age.greaterThanEqual(0).and(age.lessThan(life));
  const g = vec3(0, D.y, 0), k = D.z;
  const kk = max(k, DRAG_EPS);
  const e = exp(k.negate().mul(age));
  // v' = −g − k v: v(t) = (v0 + g/k) e^(−kt) − g/k; p(t) = p0 − (g/k) t + (v0 + g/k)(1 − e^(−kt))/k
  const vDrag = B.xyz.add(g.div(kk)).mul(e).sub(g.div(kk));
  const pDrag = A.xyz.sub(g.div(kk).mul(age)).add(B.xyz.add(g.div(kk)).mul(float(1).sub(e)).div(kk));
  const vFree = B.xyz.sub(g.mul(age));
  const pFree = A.xyz.add(B.xyz.mul(age)).sub(g.mul(age.mul(age).mul(0.5)));
  const drag = k.greaterThan(DRAG_EPS);
  const moving = Ex.w.greaterThan(0.5);
  const pos = select(moving, select(drag, pDrag, pFree), A.xyz);
  const vel = select(moving, select(drag, vDrag, vFree), B.xyz);
  // size over life: quarks's GROW Bézier from 1 to grow
  const kg = Ex.y.sub(1), s1 = float(1).sub(t);
  const bez = s1.mul(s1).mul(s1).add(s1.mul(s1).mul(t).mul(3).mul(kg.mul(0.6).add(1)))
    .add(s1.mul(t).mul(t).mul(3).mul(kg.mul(0.9).add(1))).add(t.mul(t).mul(t).mul(Ex.y));
  const size = D.x.mul(bez);
  // alpha over life
  const fadeOut = float(1).sub(t);
  const fadeSharp = select(t.lessThan(0.4), mix(float(1), float(0.6), t.div(0.4)), mix(float(0.6), float(0), t.sub(0.4).div(0.6)));
  // Eager mix: select hoists shared age into only the SHARP branch in r186,
  // leaving OUT particles at age zero and resurrecting them on the next burst.
  const alpha = C.w.mul(mix(fadeOut, fadeSharp, select(Ex.z.greaterThan(0.5), 1, 0)));
  const mv = cameraViewMatrix.mul(vec4(pos, 1)).xyz;
  const quad = positionGeometry.xy;
  let view;
  if (stretched) {
    // quarks's stretched billboard: across the streak by size, back along the velocity (view space)
    const vv = cameraViewMatrix.mul(vec4(vel, 0)).xyz.mul(D.w);
    const across = normalize(cross(mv, vv.add(vec3(0, VEL_EPS, 0))));
    view = mv.add(across.mul(quad.y).mul(size)).sub(vv.mul(quad.x.add(0.5)));
  } else {
    const r = Ex.x, c = cos(r), sn = sin(r);
    const q = quad.mul(size);
    view = mv.add(vec3(c.mul(q.x).sub(sn.mul(q.y)), sn.mul(q.x).add(c.mul(q.y)), 0));
  }
  const clip = select(living, cameraProjectionMatrix.mul(vec4(view, 1)), vec4(2, 2, 2, 1));
  const color = varying(vec4(C.xyz, alpha));

  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.lights = false;
  mat.vertexNode = clip;
  const map = typeof tex === 'string' ? sprite(tex, textureSize) : tex;
  const texel = texture(map, uv());
  mat.colorNode = color.xyz.mul(texel.rgb);
  mat.opacityNode = color.w.mul(texel.a);
  // the WebGL blending quarks had (non-premultiplied): additive src·α + dst for colour and alpha;
  // normal src·α + dst·(1 − α), alpha one / one − α
  mat.blending = CustomBlending;
  mat.blendEquation = AddEquation;
  mat.blendSrc = SrcAlphaFactor;
  mat.blendDst = blending === 'additive' ? OneFactor : OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = blending === 'additive' ? SrcAlphaFactor : OneFactor;
  mat.blendDstAlpha = blending === 'additive' ? OneFactor : OneMinusSrcAlphaFactor;
  mat.name = `billboards ${name}`;

  const mesh = new Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;   // the particles span the scene; one draw either way
  mesh.visible = false;         // nothing alive

  // ---- the CPU side: which slots are alive (their death on the pool's clock) and whose
  let now = 0;      // the pool's clock (s)
  let lastDt = 0;   // the last update's step: a spawn shows after the next one
  const death = new Float64Array(capacity).fill(-Infinity);
  const tags = new Array(capacity).fill(null);
  let cursor = 0;
  let lastDeath = -Infinity;    // when the last one alive dies
  const dirty = [];             // slots written since the last update
  const pending = [];           // slots whose upload ranges three hasn't consumed yet
  const rec = new Float32Array(20);
  const view4 = SLOTS.map((_, i) => rec.subarray(4 * i, 4 * i + 4));
  // what init(p) fills in: p.set(...) or the fields one by one
  const p = {
    pos: new Vector3(), vel: new Vector3(), size: 0, rgb: [1, 1, 1], alpha: 1, life: 1,
    gravity: 0, drag: 0, grow: 1, fade: FADE.OUT, stretch: 0, move: 1, rotation: 0,
    set(pos, vel, size, rgb, alpha, life, { gravity = 0, drag = 0, grow = 1, fade = FADE.OUT, stretch = 0, move = 1, rotation = Math.random() * 2 * Math.PI } = {}) {
      p.pos.copy(pos); p.vel.copy(vel); p.size = size; p.rgb = rgb; p.alpha = alpha; p.life = life;
      Object.assign(p, { gravity, drag, grow, fade, stretch, move, rotation });
      return p;
    },
  };
  const alive = (tag) => {
    let n = 0;
    for (let i = 0; i < capacity; i++) if (death[i] > now && (tag == null || tags[i] === tag)) n++;
    return n;
  };
  function write(i) {
    const birth = now + lastDt;
    view4[0].set([p.pos.x, p.pos.y, p.pos.z, birth]);
    view4[1].set([p.vel.x, p.vel.y, p.vel.z, p.life]);
    view4[2].set([p.rgb[0], p.rgb[1], p.rgb[2], p.alpha]);
    view4[3].set([p.size, p.gravity, p.drag, p.stretch]);
    view4[4].set([p.rotation, p.grow, p.fade, p.move]);
    SLOTS.forEach((k, j) => arrays[k].array.set(view4[j], 4 * i));
    death[i] = birth + p.life;
    lastDeath = Math.max(lastDeath, death[i]);
    dirty.push(i);
  }

  return {
    mesh,
    capacity,
    /**
     * n new particles (rounded; capped so `tag`'s live ones stay within `max`),
     * each set by init(p) with p.set(pos, vel, size, rgb, alpha, life, opts).
     * Returns how many were made.
     * @param {number} n
     * @param {(p: object, i: number) => void} init
     * @param {{ tag?: unknown, max?: number }} [opts]
     */
    burst(n, init, { tag = null, max: cap = capacity } = {}) {
      n = Math.min(Math.round(n), cap - alive(tag), capacity - alive(null));
      let made = 0;
      for (let scanned = 0; made < n && scanned < capacity; scanned++) {
        const i = cursor;
        cursor = (cursor + 1) % capacity;
        if (death[i] > now) continue;
        init(p.set(p.pos.set(0, 0, 0), p.vel.set(0, 0, 0), 0, [1, 1, 1], 1, 1), made);
        if (!(p.life > 0)) continue;
        tags[i] = tag;
        write(i);
        made++;
      }
      if (made) mesh.visible = true;
      return made;
    },
    /** Ages every particle by dt (s) and uploads the records written since the last update. */
    update(dt) {
      now += dt;
      lastDt = dt;
      clock.value = now;
      if (dirty.length) {
        // three uploads an attribute's ranges at the mesh's next draw and only
        // then clears them (WebGPUAttributeUtils updateAttribute). Ranges still
        // there were never uploaded (two updates with no draw between: a tick
        // that doesn't present, preview's 10 Hz, a pool guardMeshes parked), so
        // this update's slots join them instead of replacing them.
        if (arrays[SLOTS[0]].updateRanges.length === 0) pending.length = 0;
        for (const i of dirty) pending.push(i);
        dirty.length = 0;
        pending.sort((a, b) => a - b);
        // contiguous runs of written slots, one upload range each (a slot once)
        const runs = [];
        let n = 0;
        for (const i of pending) {
          if (n && pending[n - 1] === i) continue;
          pending[n++] = i;
          const run = runs[runs.length - 1];
          if (run && run[1] === i - 1) run[1] = i;
          else runs.push([i, i]);
        }
        pending.length = n;
        // many runs (a long wait for a draw): one range over them all
        if (runs.length > MAX_RANGES) runs.splice(0, runs.length, [pending[0], pending[n - 1]]);
        for (const k of SLOTS) {
          arrays[k].clearUpdateRanges();
          for (const [a, b] of runs) arrays[k].addUpdateRange(4 * a, 4 * (b - a + 1));
          arrays[k].needsUpdate = true;
        }
      }
      mesh.visible = lastDeath > now;
    },
    /** Live particles (with `tag`, or all). */
    count(tag = null) { return alive(tag); },
    /** Whether any is still alive. */
    get busy() { return lastDeath > now; },
    /**
     * Drops every particle. The zeroed records go up with the next update, as
     * one range over every slot: an upload with no ranges (all of it) would
     * become a partial one if a spawn's ranges joined it before a draw, and
     * the records in flight would show again with the next burst.
     */
    clear() {
      death.fill(-Infinity);
      tags.fill(null);
      lastDeath = -Infinity;
      for (const k of SLOTS) arrays[k].array.fill(0);
      dirty.length = 0;
      for (let i = 0; i < capacity; i++) dirty.push(i);
      mesh.visible = false;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}
