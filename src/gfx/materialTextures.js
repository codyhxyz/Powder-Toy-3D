// The scanned material textures (gfx/textureSet.js; Poly Haven, CC0:
// public/textures/CREDITS.md) on the GPU: one rgba8unorm 2d array, two layers
// per texture, with its whole mip chain:
//   layer 2k      albedo, rgb, sRGB-encoded (the view decodes after filtering:
//                 one array holds both kinds of layer, so it can't be an -srgb format);
//                 a: metal mask (1 where the look's metalness holds: opaque photos are all 1)
//   layer 2k + 1  normal x and y (OpenGL convention), roughness
// bound at L.LIGHTING's MAT_TEX_BINDING with a repeating anisotropic sampler
// (shaders/bindings.js), read by shaders/gfx/surface.js matTextured.
//
// Only what is wanted downloads: a map's photos once the census sees their
// elements in it (gfx/materialCensus.js), an element placed later once it
// shows up. A wanted photo downloads at low fetch priority and decodes off the
// main thread (createImageBitmap). Each batch that arrives goes into a new,
// larger array: the photos already there are copied across on the GPU (no
// second download or decode), the new ones uploaded after them, and the new
// array replaces the old, whose bind groups are made again (`version` moves:
// gfx/volume.js lightingGroup). Each photo's layer is then written into the
// tables (gfx/materials.js setTexLayer; the element tables' texMap.x on the
// GPU), which until then hold NO_TEX: the view draws an element's procedural
// look until its photo is in. Nothing waits for any of it. One per device.
//
//   const mt = materialTextures(gpu);   // makes the (empty) array; loads nothing yet
//   mt.wantElements([E.SAND, …])        // asks for those elements' photos (again is free)
//   bind { binding: MAT_TEX_BINDING, resource: mt.view }, { binding: MAT_TEX_SAMPLER_BINDING, resource: mt.sampler }
//   mt.version                          // moves with each new array
//   await mt.idle()                     // resolves once nothing is loading
//   mt.resident                         // the asset indices in the array
import { TEXTURE_SET } from './textureSet.js';
import { TEX_LAYERS, NO_TEX, texAssetOf, setTexLayer } from './materials.js';
import { tableLayout } from '../shaders/common.js';

const FORMAT = 'rgba8unorm';
const USAGE = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };   // (GPUTextureUsage's bits)
// each texture's images, in its layer order
const IMAGES = ['albedo.webp', 'surface.webp'];
const BASE = (() => { try { return import.meta.env?.BASE_URL ?? '/'; } catch { return '/'; } })();
// The mips are the full image resized (each from the full image, not the level
// above, so blur doesn't build up), by the browser's best filter.
const MIP_QUALITY = 'high';
// The image as stored: no colour management (the normals and roughness are
// data; the albedo is decoded in the shader) and no premultiplying.
const DECODE = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
// The sampler's anisotropic filtering: up to this many taps along a pixel's
// footprint where it lies stretched across a surface seen at an angle (the
// ground ahead, a wall alongside), each tap at the mip of its narrow axis.
// The read's gradients are that footprint, worked out analytically after the
// march (shaders/gfx/surface.js texFoot, floorFoot). 16 is the most WebGPU
// (and every GPU since 2004's) offers, and what games set as "16x AF"; it
// covers a surface to ~86° from face-on, past which the GPU coarsens the mip.
// WebGPU takes it only with linear min, mag and mipmap filters.
export const MAT_TEX_ANISO = 16;
// An array a new one replaced is destroyed this long after (frames recorded
// before the swap may still bind it until they are submitted).
const RETIRE_MS = 5000;

const mipCount = (n) => Math.floor(Math.log2(n)) + 1;

async function bitmapOf(url) {
  const res = await fetch(url, { priority: 'low' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return createImageBitmap(await res.blob(), DECODE);
}

// An asset's images, decoded (resolves with [albedo, surface] bitmaps).
const imagesOf = (asset) => Promise.all(IMAGES.map((f) => bitmapOf(`${BASE}textures/${TEXTURE_SET[asset].id}/${f}`)));

// The element tables' texMap.x of element id, as a byte offset into the
// tables' buffer (shaders/common.js tablesBuffer).
let texMapAt = null;
function texMapOffset(id) {
  if (!texMapAt) {
    const { Tables, Material } = tableLayout();
    const mat = Tables.offsetOf('mat'), field = Material.offsetOf('texMap');
    texMapAt = (i) => mat + i * Material.size + field;
  }
  return texMapAt(id);
}

/**
 * The device's material textures (made on first call; loads what is wanted).
 * @param {object} gpu
 * @returns {{ readonly view: GPUTextureView, sampler: GPUSampler, readonly version: number,
 *   want(assets: number[]): void, wantElements(ids: number[]): void, idle(): Promise<void>, readonly resident: number[] }}
 */
export function materialTextures(gpu) {
  if (gpu._materialTextures) return gpu._materialTextures;
  const device = gpu.device;
  let texture = gpu.createTexture({ label: 'material textures (none)', size: [1, 1, 1], format: FORMAT, usage: USAGE.TEXTURE_BINDING });
  let view = texture.createView({ dimension: '2d-array' });
  let size = 0;              // the photos' edge, texels (all alike: the first sets it)
  let version = 0;
  const resident = [];       // asset indices, in layer order (asset resident[k] is layers 2k, 2k + 1)
  const wanted = new Set();  // asked for, not yet loading
  const pending = new Set(); // loading now
  const failed = new Set();  // didn't load: asked for again only on a reload
  let loading = null;        // the batch in flight (a promise)
  const sampler = device.createSampler({
    label: 'material textures', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: MAT_TEX_ANISO,
  });

  // The element tables on this device (the simulation's, and the render's own
  // copy where there is one: gfx/uniforms.js), patched where a photo's layer moved.
  function patchTables(ids, layer) {
    const word = new Float32Array([layer]);
    for (const buffer of [gpu._simTables?.buffer, gpu._renderTables]) {
      if (!buffer) continue;
      for (const id of ids) device.queue.writeBuffer(buffer, texMapOffset(id), word, 0, 1);
    }
  }

  // A batch of decoded assets into a new array after the resident ones.
  function place(batch) {
    const s = size || batch[0].images[0].width;
    for (const { asset, images } of batch) {
      for (const b of images) if (b.width !== s || b.height !== s) throw new Error(`materialTextures: ${TEXTURE_SET[asset].id} is ${b.width}×${b.height}, not ${s}²`);
    }
    size = s;
    const mips = mipCount(s);
    const oldLayers = resident.length * TEX_LAYERS;
    const layers = oldLayers + batch.length * TEX_LAYERS;
    const next = gpu.createTexture({
      label: `material textures (${layers / TEX_LAYERS})`, size: [s, s, layers], format: FORMAT, mipLevelCount: mips,
      usage: USAGE.TEXTURE_BINDING | USAGE.COPY_DST | USAGE.COPY_SRC | USAGE.RENDER_ATTACHMENT,
    });
    if (oldLayers) {
      const enc = device.createCommandEncoder({ label: 'material textures: grow' });
      for (let level = 0; level < mips; level++) {
        const m = Math.max(1, s >> level);
        enc.copyTextureToTexture({ texture, mipLevel: level }, { texture: next, mipLevel: level }, [m, m, oldLayers]);
      }
      device.queue.submit([enc.finish()]);
    }
    return { next, mips, oldLayers };
  }

  async function upload(next, mips, layer, full) {
    for (let level = 0; level < mips; level++) {
      const m = Math.max(1, size >> level);
      const src = level === 0 ? full : await createImageBitmap(full, { ...DECODE, resizeWidth: m, resizeHeight: m, resizeQuality: MIP_QUALITY });
      device.queue.copyExternalImageToTexture({ source: src }, { texture: next, mipLevel: level, origin: [0, 0, layer] }, [m, m]);
      if (src !== full) src.close();
    }
    full.close();
  }

  async function loadBatch(assets) {
    const got = await Promise.all(assets.map((asset) => imagesOf(asset).then((images) => ({ asset, images }), (e) => {
      console.warn(`material textures: ${TEXTURE_SET[asset].id} not loaded, its procedural look stays (${e.message})`);
      failed.add(asset);
      return null;
    })));
    // a photo of another size than the array's is left out alone (its look stays procedural), not the batch
    const s = size || got.find(Boolean)?.images[0].width;
    const batch = got.filter((g) => {
      if (!g) return false;
      if (g.images.every((b) => b.width === s && b.height === s)) return true;
      console.warn(`material textures: ${TEXTURE_SET[g.asset].id} is ${g.images[0].width}×${g.images[0].height}, not ${s}²: its procedural look stays`);
      failed.add(g.asset);
      g.images.forEach((b) => b.close());
      return false;
    });
    if (!batch.length) return;
    // the mips are resized before the swap, so the new array is whole when it replaces the old
    const { next, mips, oldLayers } = place(batch);
    await Promise.all(batch.flatMap(({ images }, k) => images.map((full, j) => upload(next, mips, oldLayers + k * TEX_LAYERS + j, full))));
    const old = texture;
    texture = next;
    view = next.createView({ label: next.label, dimension: '2d-array' });
    version++;
    batch.forEach(({ asset }, k) => {
      const layer = oldLayers + k * TEX_LAYERS;
      resident.push(asset);
      patchTables(setTexLayer(asset, layer), layer);
    });
    setTimeout(() => old.destroy(), RETIRE_MS);
  }

  // Starts a batch of everything wanted, if none is in flight (another follows while more is wanted).
  function pump() {
    if (loading || !wanted.size) return;
    const assets = [...wanted];
    wanted.clear();
    for (const a of assets) pending.add(a);
    loading = loadBatch(assets).catch((e) => {
      for (const a of assets) if (!resident.includes(a)) failed.add(a);
      console.warn(`material textures: not loaded, the procedural looks stay (${e.message})`);
    }).finally(() => { pending.clear(); loading = null; pump(); });
  }

  const mt = {
    get view() { return view; },
    sampler,
    get version() { return version; },
    get resident() { return [...resident]; },
    /** Asks for these assets (gfx/textureSet.js indices); those resident, loading or failed are skipped. */
    want(assets) {
      for (const a of assets) {
        if (a === NO_TEX || resident.includes(a) || pending.has(a) || failed.has(a)) continue;
        wanted.add(a);
      }
      pump();
    },
    /** Asks for the photos these elements draw from (LOOKS tex). */
    wantElements(ids) { mt.want(ids.map(texAssetOf)); },
    /** Resolves once nothing is loading or wanted. */
    async idle() { while (loading) await loading; },
  };
  return (gpu._materialTextures = mt);
}
