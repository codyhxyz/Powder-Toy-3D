// The scanned material textures (gfx/textureSet.js; Poly Haven, CC0:
// public/textures/CREDITS.md) on the GPU: one rgba8unorm 2d array, two layers
// per texture, with its whole mip chain:
//   layer 2i      albedo, rgb, sRGB-encoded (the view decodes after filtering:
//                 one array holds both kinds of layer, so it can't be an -srgb format)
//   layer 2i + 1  normal x and y (OpenGL convention), roughness
// bound at L.LIGHTING's MAT_TEX_BINDING with a repeating trilinear sampler
// (shaders/bindings.js), read by shaders/gfx/surface.js matTextured.
//
// Nothing waits for it: until the images are in, the binding holds a one-layer
// dummy, which the view reads as "not loaded" (surface.js matTexReady: fewer
// layers than one texture's) and draws the procedural looks as before. The
// images download at low fetch priority once the first view is made, decode off
// the main thread (createImageBitmap) and go into a new texture, which then
// replaces the dummy: `version` moves, and the bind groups that hold the view
// (gfx/volume.js lightingGroup) are made again. One per device.
//
//   const mt = materialTextures(gpu);   // starts the load (once)
//   bind { binding: MAT_TEX_BINDING, resource: mt.view }, { binding: MAT_TEX_SAMPLER_BINDING, resource: mt.sampler }
//   mt.version                          // 0 until loaded, then 1
//   await mt.ready                      // true once loaded, false if it failed (the procedural looks stay)
import { TEXTURE_SET } from './textureSet.js';
import { TEX_LAYERS } from './materials.js';

const FORMAT = 'rgba8unorm';
const USAGE = { COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };   // (GPUTextureUsage's bits)
// each texture's images, in its layer order
const IMAGES = ['albedo.webp', 'surface.webp'];
const BASE = (() => { try { return import.meta.env?.BASE_URL ?? '/'; } catch { return '/'; } })();
// The mips are the full image resized (each from the full image, not the level
// above, so blur doesn't build up), by the browser's best filter.
const MIP_QUALITY = 'high';
// The image as stored: no colour management (the normals and roughness are
// data; the albedo is decoded in the shader) and no premultiplying.
const DECODE = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };

const mipCount = (n) => Math.floor(Math.log2(n)) + 1;

async function bitmapOf(url, signal) {
  const res = await fetch(url, { priority: 'low', signal });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return createImageBitmap(await res.blob(), DECODE);
}

// Every image's mip chain into a new array texture; resolves with it.
async function load(gpu) {
  const urls = TEXTURE_SET.flatMap((t) => IMAGES.map((f) => `${BASE}textures/${t.id}/${f}`));
  if (urls.length !== TEXTURE_SET.length * TEX_LAYERS) throw new Error('materialTextures: images per texture differ from TEX_LAYERS');
  const bitmaps = await Promise.all(urls.map((u) => bitmapOf(u)));
  const size = bitmaps[0].width;
  for (const [i, b] of bitmaps.entries()) {
    if (b.width !== size || b.height !== size) throw new Error(`materialTextures: ${urls[i]} is ${b.width}×${b.height}, not ${size}² as the first`);
  }
  const mips = mipCount(size);
  const texture = gpu.createTexture({
    label: 'material textures', size: [size, size, bitmaps.length], format: FORMAT, mipLevelCount: mips,
    usage: USAGE.TEXTURE_BINDING | USAGE.COPY_DST | USAGE.RENDER_ATTACHMENT,
  });
  const queue = gpu.device.queue;
  await Promise.all(bitmaps.map(async (full, layer) => {
    for (let level = 0; level < mips; level++) {
      const s = Math.max(1, size >> level);
      const src = level === 0 ? full : await createImageBitmap(full, { ...DECODE, resizeWidth: s, resizeHeight: s, resizeQuality: MIP_QUALITY });
      queue.copyExternalImageToTexture({ source: src }, { texture, mipLevel: level, origin: [0, 0, layer] }, [s, s]);
      if (src !== full) src.close();
    }
    full.close();
  }));
  return texture;
}

/**
 * The device's material textures (made, and their load started, on first call).
 * @param {object} gpu
 * @returns {{ readonly view: GPUTextureView, sampler: GPUSampler, readonly version: number, ready: Promise<boolean> }}
 */
export function materialTextures(gpu) {
  if (gpu._materialTextures) return gpu._materialTextures;
  const dummy = gpu.createTexture({ label: 'material textures (loading)', size: [1, 1, 1], format: FORMAT, usage: USAGE.TEXTURE_BINDING });
  let view = dummy.createView({ dimension: '2d-array' });
  let version = 0;
  const sampler = gpu.device.createSampler({
    label: 'material textures', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'repeat',
  });
  const mt = {
    get view() { return view; },
    sampler,
    get version() { return version; },
    ready: load(gpu).then((texture) => {
      view = texture.createView({ label: texture.label, dimension: '2d-array' });
      version++;
      return true;
    }, (e) => {
      console.warn(`material textures: not loaded, the procedural looks stay (${e.message})`);
      return false;
    }),
  };
  return (gpu._materialTextures = mt);
}
