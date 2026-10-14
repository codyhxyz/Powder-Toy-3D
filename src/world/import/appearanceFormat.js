// Browser-safe conversion/renderer ABI. All offsets are absolute u32 WORD
// offsets, never bytes. Float slots are IEEE754 f32 bitcasts. Files are LE.
export const APPEARANCE_VERSION = 1;
export const APPEARANCE_HEADER_WORDS = 64;
export const APPEARANCE_TRIANGLE_WORDS = 24;
export const APPEARANCE_MATERIAL_WORDS = 32;
export const APPEARANCE_LIGHT_WORDS = 16;
export const APPEARANCE_ENVIRONMENT_WORDS = 32;
export const APPEARANCE_HEADER = Object.freeze({
  version: 0, totalWords: 1, brickDims: 2, directoryAt: 5, trianglesAt: 6,
  materialsAt: 7, materialCount: 8, triangleCount: 9, lightsAt: 10,
  lightCount: 11, environmentAt: 12, maxBrickTriangles: 13,
});
export const APPEARANCE_FLAGS = Object.freeze({
  transparent: 1, unshaded: 2, repeat: 4, filter: 8, mipmaps: 16,
  doubleSided: 32, alphaScissor: 64, vertexColor: 128, srgb: 256,
  animated: 512, blendShift: 16, diffuseShift: 20, specularShift: 24,
});
// Material word 19. These are source shader identities, NOT approximations.
// Word20=snapRes, word21=paletteswap, other parameters retained in manifest.
export const APPEARANCE_MODES = Object.freeze({
  spatial: 0, unshaded: 1, water: 2, flesh: 3, swampWater: 4,
  scroll: 5, realPSX: 6, realPSXWobble: 7, psx: 8,
});
export const APPEARANCE_ENVIRONMENT = Object.freeze({
  ambient: 0, ambientEnergy: 3, fog: 4, fogEnabled: 7,
  fogBegin: 8, fogEnd: 9, fogCurve: 10, fogTransmit: 11,
  panoramaAt: 12, panoramaWidth: 13, panoramaHeight: 14, backgroundMode: 15,
  orientation: 16, rotationSpeed: 25, rotationAxis: 26, skyContribution: 27,
  backgroundEnergy: 28, fogTransmitCurve: 29, fogSunAmount: 30, fogDepthEnabled: 31,
});
// Triangle: p0.xyz/material; UV-U affine; UV-V affine; unit normal/planeD
// (dot(normal,p0), NOT its negative); barycentric-u affine; barycentric-v
// affine. Inside iff u>=0,v>=0,u+v<=1 after projecting onto the plane.
// Directory: one word per geometry brick, 0 or pointer to [count, indices...].
// Indices are zero based; lists include only SAT-accepted occupied triangles.
// Material: textureAt,width,height,flags; albedo RGBA; emission RGB/energy;
// roughness,metallic,specular,physicalElement; frames,fps,frameStride,mode;
// mode params20=snapRes,21=paletteswap. PBR maps22..25=roughness
// offset/width/height/channel,26..29=metallic offset/width/height/channel.
// Channel Godot enum:0R,1G,2B,3A,4grayscale. 30..31 reserved.
// textureAt=0 means no texture, not white art.
// Pixels: RGBA8, R in least significant byte, no resampling. Frames contiguous.
// Lights: position.xyz/type; color.rgb/energy; direction.xyz/range;
// attenuation,spotAngle,spotAttenuation,shadow. Type: 0 omni,1 directional,2 spot.
