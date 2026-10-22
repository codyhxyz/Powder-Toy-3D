// CPU-only: column-run water (tools/v2/column-wgsl-cases.mjs, tools/v2/column-wgsl-check.mjs's header), one
// slow case in its own process: oil on water: two layers spread and rest flat, exact, without churn.
import { register } from './column-wgsl-cases.mjs';
register('layers');
