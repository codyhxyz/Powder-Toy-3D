import * as THREE from 'three/webgpu';
import { Fn, uniform, float, abs, dot, clamp, mix, pow, select, normalView, positionViewDirection, agxToneMapping, sRGBTransferOETF } from 'three/tsl';

// Something lit from within, bright where it faces the eye (the held wand's
// gem and its halo, tools/index.js): the gem (opaque: { rim, white,
// whiteSharp }) or its additive halo ({ soft, opacity }). Its colour (HDR) is
// material.userData.color.
//
// A TSL node material (docs/webgpu.md F8) of the GLSL's arithmetic. The gem
// is linear radiance in the hands' target, which post tone maps. The halo is
// on the hands' glow layer, which holds display values (post adds it over the
// finished frame), so it tone maps itself as WebGL's renderer did there:
// GLOW_TONE, set each frame from post's settings (setGlowTone).
export function glowMaterial({ rim = 0, white = 0, whiteSharp = 1, soft = 1, opacity = 1 }) {
  const halo = opacity < 1;
  const color = uniform(new THREE.Color('#efcf79'));
  const mat = new THREE.MeshBasicNodeMaterial(halo ? { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } : {});
  mat.lights = false;
  mat.fog = false;
  const face = clamp(abs(dot(normalView, positionViewDirection)), 0, 1);
  const rgb = color.mul(mix(float(rim), float(1), pow(face, soft))).add(pow(face, whiteSharp).mul(white)).mul(opacity);
  mat.colorNode = halo ? glowTone(rgb) : rgb;
  mat.userData.color = color;
  mat.name = halo ? 'wand halo' : 'wand gem';
  return mat;
}

// The glow layer's tone map: AgX at post's exposure, then sRGB, or sRGB alone
// in the raw views (the torch's flame on that layer does the same, flame.js).
export const GLOW_TONE = { exposure: uniform(1), raw: uniform(0) };
// (rgb is made a variable first: three builds a node shared by both sides of a
// select in the first side only, so the other would read its view normal unset)
const glowTone = (rgb) => Fn(() => {
  const c = rgb.toVar();
  return sRGBTransferOETF(select(GLOW_TONE.raw.greaterThan(0.5), clamp(c, 0, 1), agxToneMapping(c, GLOW_TONE.exposure)));
})();

/**
 * The glow layer's tone map from post's settings (its exposure, a raw view).
 * @param {{ settings: { exposure?: number, raw?: boolean } } | null | undefined} post
 */
export function setGlowTone(post) {
  GLOW_TONE.exposure.value = 2 ** (post?.settings.exposure ?? 0);
  GLOW_TONE.raw.value = post?.settings.raw ? 1 : 0;
}
