// CPU-only: column-run water (tools/v2/column-wgsl-cases.mjs, tools/v2/column-wgsl-check.mjs's header), one
// slow case in its own process: the bench single-liquid gates at unchanged thresholds.
import { register } from './column-wgsl-cases.mjs';
register('bench');
