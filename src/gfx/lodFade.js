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

// Geometry hand-off by screen-space error, the rule of terrain and mesh LOD: a
// stand-in (the textured heap for pebbles, the trilinear reading for smooth
// sand and water) is drawn until its error against the up-close geometry,
// projected to the screen, reaches GEOM_ERR_PX_NONE pixels, and the geometry
// is all of it by GEOM_ERR_PX_FULL, one octave on. The switch can't be seen
// below 1 px (Lindstrom et al. 1996, "Real-Time, Continuous Level of Detail
// Rendering of Height Fields", §6; Nanite keeps its cluster error under a
// pixel). At 1 px both features would draw 4× as far out: 17.6 m (pebbles) and
// 49 m (smooth surfaces) at 1080p and 75° vertical FOV, putting the cubic on
// most of the World's sea and beach within reach. 4 px is the cost trade until
// a GPU A/B at 1, 2 and 4 px (tools/detail-bench.mjs) prices that difference.
export const GEOM_ERR_PX_NONE = 4, GEOM_ERR_PX_FULL = 8;
