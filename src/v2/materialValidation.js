// Pure validation of the authoritative four-word Material ABI. Never repair
// malformed words: banks, phase progress, fuel/spark and motion must round-trip.
import { validateFall } from './fall.js';
import { ELEMENTS, K } from '../elements.js';
import { validatePhaseCore } from './phase.js';
import { MAX_FILL, isLiquid } from './layout.js';
export function validateMaterialCore(core) {
  if (!core || core.length !== 4) throw new Error('Invalid native material words');
  for (let i = 0; i < 4; i++) if (!Number.isInteger(core[i]) || core[i] < 0 || core[i] > 0xffffffff) throw new Error('Invalid native material word');
  validatePhaseCore(core); // ID, temperature/latent-phase tag, lava source
  const id = core[0] & 255;
  if (isLiquid(id)) {
    if ((core[1] & 0xffffff) > MAX_FILL) throw new Error('Native fill exceeds compression limit');
    for (const half of [core[2] & 65535, core[2] >>> 16, core[3] & 65535]) {
      if ((half & 0x7c00) === 0x7c00) throw new Error('Invalid native liquid flux');
    }
  } else if (ELEMENTS[id].kind === K.POWDER) {
    validateFall(core);
  }
  // Life/fuel is an unsigned16 integer, not a half float: all65536 payloads
  // are representable (including compressed fuel and SING's different scale).
  // Do not impose a default element lifetime as an artificial upper bound.
  return core;
}
