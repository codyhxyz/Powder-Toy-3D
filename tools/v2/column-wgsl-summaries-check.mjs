// CPU-only: column-run water (tools/v2/column-wgsl-cases.mjs, tools/v2/column-wgsl-check.mjs's header), one
// slow case in its own process: brick summaries change nothing (the scan over them equals a scan of every cell).
import { register } from './column-wgsl-cases.mjs';
register('summaries');
