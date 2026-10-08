// The world's length scale: how big one grid cell is. One number for every
// system that talks in real units (the POV body, the renderer's material
// detail, optics), so they agree on how big things are.
//
// 0.30 m, because:
// - a 1.7 m person is 5.5 cells tall, enough cells for the body to collide
//   with and handle the world, while a 128³ grid stays a 38 m site
//   (the volcano is 14 m tall, the lab tank 15 m across) rather than a room;
// - water's extinction per cell (elements.js sigma: 0.052, 0.014, 0.01) is
//   then within 2× of real pure water in red and green (0.10, 0.017 per
//   0.3 m; Pope & Fry), so the tank deepens to the right blue-green without
//   the several-fold exaggeration it needs at smaller cells.
// What doesn't follow it: time. The sim's gravity (0.025 cells/step² at
// 240 steps/s ≈ 1440 cells/s²) is real gravity only for ~7 mm cells, so at
// this scale the world runs ~6.6× faster than real time (sqrt of the ratio),
// and heat spreads far faster still, as in The Powder Toy. Renderer detail
// is sized in metres through CELL_M; animation rates are not.
export const CELL_M = 0.3;   // metres per cell
