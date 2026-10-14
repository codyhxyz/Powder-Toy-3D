import { blackbodyChroma } from './incandescence.js';

// Hand lamps: point lights the first-person body carries or throws (the torch,
// the lantern), lit in the world shader with traced shadows
// (shaders/gfx/lighting.js lampLight). src/pov/lamps.js keeps the lit ones and
// writes them into gfxUniforms (gfx/uniforms.js).
export const LAMP_MAX = 8;     // lamps lit at once (the shader loops over this many at most): the hand's and the nearest wall torches
// A fixed lamp (a wall torch's, world/torchLights.js) is a solid cell: its shadow
// ray stops this far short of the cell's centre, out of the cell (√3/2 is its corner).
export const LAMP_FIXED_PAD = 0.9;   // cells
export const LAMP_UNIT = 3;    // cells (about 1 m) at which a lamp's colour is the irradiance it gives
// A lamp's light has the size of what shines: a tube light (Karis 2013), its radius and
// upright length in cells (pov/lamps.js `radius`, `length`). The flame's or the lantern
// glass's are measured off their models (pov/tools/lamp.js lightBody); a wall torch's
// is its head, one cell (world/torchLights.js).

// A wick or torch flame's colour temperature: a candle flame's, 1,850 K (a sooty diffusion
// flame, as a torch's and a kerosene wick's are; https://en.wikipedia.org/wiki/Color_temperature,
// "Candle flame, sunset/sunrise: 1,850 K").
export const FLAME_KELVIN = 1850;
// Its colour: linear sRGB of unit luminance (Rec. 709), by Planck's law through the CIE 1931
// colour matching functions (gfx/incandescence.js), as Unreal's light Temperature does.
export const FLAME_COLOR = blackbodyChroma(FLAME_KELVIN);
