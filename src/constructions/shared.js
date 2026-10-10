import { BODY_HEIGHT, BODY_WIDTH } from '../pov/constants.js';

// What the built-in constructions share (builtins.js, structures.js): the
// human scale they are built to, and building conventions.

export const TAU = Math.PI * 2;
// Built stonework (slabs, chimneys, brick, basins) is WALL: it renders as crisp
// voxels, whereas ROCK is drawn as smoothed natural terrain.
export const MASONRY = 'WALL';
export const odd = (x) => Math.round(x) | 1;

// Human scale, in cells at T = 1. A cell is 0.3 m (src/scale.js) and the
// first-person body is 5.5 cells tall and 1.6 wide; it steps up ledges of one
// cell and can't crouch or climb (pov/constants.js, pov/player.js). So at the
// default size, which is also the size World places constructions at, a door
// is 7 cells tall and 3 wide, a room 8 tall, and a stair rises a cell a step
// under 7 cells of headroom. Scale them with T like every other size: below
// T = 1 a build is a model you look at, not one you walk into.
const CLEARANCE = 1;   // cells between the body and a lintel, or either jamb
export const HUMAN = {
  DOOR_H: Math.ceil(BODY_HEIGHT) + CLEARANCE,   // 7 cells, 2.1 m
  DOOR_W: Math.ceil(BODY_WIDTH) + CLEARANCE,    // 3 cells, 0.9 m
  ROOM_H: 8,           // 2.4 m from the floor to the wall plate
  SILL_H: 3,           // 0.9 m: windows start this far above the floor...
  WINDOW_H: 4,         // ...and are 1.2 m tall, so they frame the eye (5 cells up)
  HEADROOM: Math.ceil(BODY_HEIGHT) + CLEARANCE, // clear cells above a stair tread or a walkway
  STEP: 1,             // a stair's rise per step: the body steps up ledges of 1.1 cells
  RAIL_H: 3,           // 0.9 m: a parapet or a railing's height
};
