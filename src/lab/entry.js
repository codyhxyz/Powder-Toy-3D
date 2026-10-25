// A newer map start can inherit an older in-flight POV promise. The old
// validity guard cancels it; only the current caller retries the entry.
export async function enterAuthoredMap(pov, isCurrent, yaw = 0) {
  for (let attempt = 0; attempt < 2 && isCurrent(); attempt++) {
    if (!pov.active) await pov.enter({ swoop: 0, valid: isCurrent });
    if (!isCurrent()) return false;
    if (pov.active && pov.player) {
      pov.setLook(yaw, 0);
      return true;
    }
  }
  return false;
}
