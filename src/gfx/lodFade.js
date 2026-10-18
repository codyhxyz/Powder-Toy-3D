// Material texture LOD (shaders/gfx/surface.js lodFade): detail of spatial
// frequency f is fully drawn up to DETAIL_FADE_LO cycles per pixel and gone at
// DETAIL_FADE_HI. This is what trilinear mipmapping does to a texture (Minecraft's
// Mipmap Levels; any GPU): mip 0 keeps every frequency up to Nyquist, 0.5 cycles
// per pixel, and the blend into mip 1 averages that finest band away by 1 cycle
// per pixel, where a pixel's box filter (TAA's jittered accumulation) would
// average it to its mean anyway. Fading earlier (0.15, then 0.25) washed
// textures out a few metres from the camera: bark was smooth plastic.
// A leaf module: the detail shaders derive their fades from it, and
// gfx/detail.js (which re-exports it) imports their derived sizes back.
export const DETAIL_FADE_LO = 0.5, DETAIL_FADE_HI = 1.0;
