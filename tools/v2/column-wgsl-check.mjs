// CPU-only witness for column-run water (src/shaders/v2/columns.js): the emitted col* bodies executed on
// production-format cells (tools/v2/column-wgsl.mjs). Pins (1) the executable subset (no bit operations, no
// integer division outside the f32 functions) and the constants the WGSL embeds, (2) exact custody of mass,
// signed energy and fuel through every pack, fall and transfer, with several liquids, lava subtypes and
// temperatures, (3) rest: a settled world is an exact fixed point that certifies idle, woken or not,
// (4) migration: unpacked columns (a partial cell under full ones, water mid-air, open water compressed by
// the substep model) settle with exact totals, and (5) the bench's single-liquid gates at their unchanged
// thresholds. No GPU, browser or World variant of the application.
// This part: the executable subset, custody, falls, loop and open edges, migration, rest and the driver's
// record. The slow cases run as their own checks: column-wgsl-summaries-check (brick summaries),
// column-wgsl-layers-check (oil on water), column-wgsl-bench-check (the bench's gates).
import { register } from './column-wgsl-cases.mjs';
register('core');
