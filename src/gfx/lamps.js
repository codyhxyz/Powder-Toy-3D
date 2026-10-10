// Hand lamps: point lights the first-person body carries or throws (the torch,
// the lantern), lit in the world shader with traced shadows
// (shaders/gfx/lighting.js lampLight). src/pov/lamps.js keeps the lit ones and
// writes them into gfxUniforms (gfx/uniforms.js).
export const LAMP_MAX = 4;     // lamps lit at once (the shader loops over this many at most)
export const LAMP_UNIT = 3;    // cells (about 1 m) at which a lamp's colour is the irradiance it gives
// A flame or a lantern's glass isn't a point: inside about this radius its light stops
// climbing as 1/d², so what's right by it doesn't blow out (Karis 2013's soft falloff).
export const LAMP_SOFT = 3;    // cells
