// Exposure may outlive radiance/TAA settling. Never let it keep refreshing
// pacing's view countdown; only reuse after all image/pick dependencies hold.
export function canPostFrame({ renderOnly, runView, runDerived, settled, viewChanged,
  worldChanged, meshesMoved, pointerDirty, painting, povActive, busy }) {
  return !renderOnly && !runView && !runDerived && settled && !viewChanged
    && !worldChanged && !meshesMoved && !pointerDirty && !painting && !povActive && !busy;
}
