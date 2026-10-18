// Keep the last complete material view on this grid while its replacement
// compiles. Far/detail meshes leave the live window to the local volume, so
// drawing a pending variant would expose a hole, not a lower-detail surface.
import { isMaterialView } from '../views.js';

export function createReadyVolumeView() {
  let owner = null, shown = null;
  return {
    select(volume, requested, pipelines) {
      if (volume !== owner) { owner = volume; shown = null; }
      if (pipelines.every((p) => p.state === 'ready')) {
        shown = requested;
        return requested;
      }
      // Only retain material transitions, with the same presentation geometry.
      // Plain/blocks and grid rebuilds keep their existing loading lifetimes.
      if (shown && isMaterialView(shown.view) && isMaterialView(requested.view)
        && shown.curved === requested.curved && shown.format === requested.format) return shown;
      shown = null;
      return requested;
    },
    reset() { owner = shown = null; },
  };
}
