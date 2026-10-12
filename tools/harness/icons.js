// The icon bake's page (docs/webgpu.md F8, U13): draws a hotbar icon
// (pov/models.js iconScene) or a class portrait (pov/classPortraits.js
// portraitScene) through three.js on this page's device, reads it back and
// hands it to tools/bake-icons.mjs as a PNG (base64). The game draws none of
// them: it shows the files the bake writes to public/icons.
//
// An icon is drawn as the WebGL kit drew it: no antialiasing, cleared to
// transparent, sRGB, then OSRS's outline and shadow (outlineSprite). A
// portrait with 4× MSAA. Both render into sRGB targets, so blending and the
// resolve run on linear colour and the texels come back encoded; partly
// covered texels come back premultiplied by their coverage, and are divided
// back out in linear colour, as a PNG holds straight alpha.

import * as THREE from 'three/webgpu';
import { createThreeRenderer, gpuTextureOf, useWebGPUCamera } from '/src/gpu/three.js';
import { ICON_PX, iconScene, outlineSprite } from '/src/pov/models.js';
import { portraitScene, PORTRAIT_W, PORTRAIT_H } from '/src/pov/classPortraits.js';
import { boot, ready, test } from './harness.js';

const h = await boot({ label: 'icons' });
const gpu = h.gpu;
const three = await createThreeRenderer(gpu, document.getElementById('view'));
three.setPixelRatio(1);

const PORTRAIT_SAMPLES = 4;   // the WebGL portraits' antialias

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
// straight alpha from coverage-premultiplied sRGB texels
function unpremultiply(data) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a <= 0 || a >= 1) continue;
    for (let k = 0; k < 3; k++) data[i + k] = Math.round(255 * toSrgb(Math.min(1, toLinear(data[i + k] / 255) / a)));
  }
}

// a scene drawn into a w×h sRGB target: { data (RGBA bytes, rows top down), width, height }
async function draw(scene, camera, w, hgt, samples) {
  useWebGPUCamera(camera);
  const rt = new THREE.RenderTarget(w, hgt, { samples, stencilBuffer: false });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  three.setRenderTarget(rt);
  try {
    await three.compileAsync(scene, camera);
    three.setClearColor(0x000000, 0);
    three.autoClear = true;
    three.render(scene, camera);
  } finally {
    three.autoClear = false;
    three.setRenderTarget(null);
  }
  const bytes = await gpu.readback.texture(gpuTextureOf(three, rt.texture), { size: [w, hgt, 1], format: 'rgba8unorm' });
  rt.dispose();
  const data = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, w * hgt * 4).slice();
  unpremultiply(data);
  return { data, width: w, height: hgt };
}

async function png({ data, width, height }) {
  const c = new OffscreenCanvas(width, height);
  c.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// model `key`'s hotbar icon, as a PNG (base64)
test('icon', async (key) => {
  const { scene, camera, dispose } = iconScene(key);
  try {
    return { png: await png(outlineSprite(await draw(scene, camera, ICON_PX, ICON_PX, 0))), failures: h.failures };
  } finally {
    dispose();
  }
});

// a class's portrait ({ color, pose, model }), as a PNG (base64)
test('portrait', async (entry) => {
  const { scene, camera, dispose } = portraitScene(entry);
  try {
    return { png: await png(await draw(scene, camera, PORTRAIT_W, PORTRAIT_H, PORTRAIT_SAMPLES)), failures: h.failures };
  } finally {
    dispose();
  }
});

ready();
